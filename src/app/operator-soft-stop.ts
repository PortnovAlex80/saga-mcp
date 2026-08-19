/**
 * Operator SOFT-STOP protocol (schema v13).
 *
 * Stopping a worker is NOT `kill -9` and it is NOT an exit-code inference. The
 * worker's MCP tools are served by a stdio server INSIDE the claude process
 * writing the shared SQLite directly — stopping the engine does not close the
 * tool path. The only reliable barrier is a DURABLE STOP FENCE. The protocol:
 *
 *   1. PLAN       — enumerate non-terminal executions on hired workplaces
 *                   (loop leased/running) with persisted PIDs. Fail closed on
 *                   unknown states. Kernel-owned workplaces (verifying /
 *                   effect_pending) are listed but LEFT ALONE (log line only).
 *   2. ENGINE BRAKE — guarded-stop every persisted engine process covering the
 *                   scope. Fail closed if a live engine cannot be verified dead.
 *   3. FENCE+REWIND — one immediate transaction PER workplace: stop row
 *                   (phase='fenced') + execution → audit-only VOID state
 *                   (terminal state + voided_at + stop_fence bump) + workplace
 *                   CAS → queued same-role (Kanban preserved, REG-28-AC-02) +
 *                   obligation lease cleared + task fence cleared + operator
 *                   hold inserted. After commit every mutating tool call from
 *                   that worker fails closed (WORKER_EXECUTION_VOIDED).
 *   4. HOOK+KILL  — best-effort runner stop() hook, then guarded TREE-kill by
 *                   persisted PID with death verification.
 *   5. CHECKPOINT — one FactoryCheckpointService capture (non-fatal, logged).
 *
 * The race closure: an in-flight tool call either commits BEFORE the fence (its
 * effects sit inside the rewound scope and are overwritten by the rewind) or
 * AFTER (refused by the tool fence). Any interleaving is safe.
 *
 * BOOT REAPER: `reapInterruptedWorkerStops` converges crash windows — a stop
 * row not yet killed/reaped whose persisted PID is still alive gets its fence
 * completed and the kill re-driven. Wired into factory-boot-revision.
 *
 * UNPARK: `releaseOperatorHolds` clears released_at so hiring resumes.
 */

import type Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  isProcessAlive,
  terminateVerifiedProcess,
  type WorkerExecutionRow,
} from '../worker-executions.js';
import { withImmediateTransaction } from '../lifecycle/work-assignment-core.js';
import { SqliteWorkplaceRepository } from '../infrastructure/workplace/sqlite-workplace-repository.js';
import type { WorkplaceState } from '../process-modules/domain/workplace/index.js';
import { deserializeWorkplaceRef } from '../process-modules/domain/workplace/workplace-ref.js';

/** Durable protocol phases (factory_worker_stops.phase CHECK). */
export type WorkerStopPhase =
  | 'planned'
  | 'engine_braked'
  | 'fenced'
  | 'detached'
  | 'hook_sent'
  | 'killed'
  | 'reaped'
  | 'checkpointed'
  | 'abandoned';

const ACTIVE_EXECUTION_STATE_SQL = "'reserved','running','cancel_requested'";
const ACTIVE_EXECUTION_STATES: ReadonlySet<string> = new Set(['reserved', 'running', 'cancel_requested']);
const TERMINAL_EXECUTION_STATES: ReadonlySet<string> = new Set([
  'exited', 'spawn_failed', 'lost', 'terminated',
]);
const KNOWN_EXECUTION_STATES = new Set([
  ...ACTIVE_EXECUTION_STATES,
  ...TERMINAL_EXECUTION_STATES,
]);
/** Phases the boot reaper treats as converged — no further kill is owed. */
const REAPER_DONE_PHASES: ReadonlySet<string> = new Set([
  'killed', 'reaped', 'checkpointed', 'abandoned',
]);
const REAPER_DONE_PHASE_SQL = `'${[...REAPER_DONE_PHASES].join("','")}'`;
/** Loop states the soft-stop may rewind to the pre-hire point. */
const HIRABLE_LOOP_STATES: ReadonlySet<string> = new Set(['leased', 'running']);
/** Kernel/reconciler-owned loop states — listed, never touched. */
const KERNEL_OWNED_LOOP_STATES: ReadonlySet<string> = new Set(['verifying', 'effect_pending']);

// ---------------------------------------------------------------------------
// Phase 1 — plan / dry-run.
// ---------------------------------------------------------------------------

export interface PlannedWorkerStop {
  readonly executionId: string;
  readonly taskId: number;
  readonly projectId: number;
  readonly epicId: number;
  readonly workerId: string;
  readonly machineId: string;
  readonly state: string;
  readonly pid: number | null;
  readonly processBirthToken: string | null;
  readonly workplaceRef: string | null;
  readonly workplaceLoopState: string | null;
  readonly workplaceKanbanPhase: string | null;
  /**
   * 'rewind' — a hired (leased/running) workplace the stop will fence back to
   * queued. 'kernel_owned' — verifying/effect_pending: listed for the operator
   * but intentionally left to the kernel (adoption/reconciler own it).
   */
  readonly action: 'rewind' | 'kernel_owned';
}

/**
 * Enumerate the executions an operator soft-stop would recall. Pure read —
 * safe for --dry-run. The select takes every NON-terminal execution that was
 * not already voided; anything selected whose state is not one of the active
 * states fails closed with a typed error (a state the protocol does not
 * understand must stop the operator, never be silently skipped).
 */
export function planWorkerStops(
  db: Database.Database,
  scope: { projectId?: number | null } = {},
): PlannedWorkerStop[] {
  const projectId = scope.projectId ?? null;
  const projectClause = projectId !== null ? 'AND we.project_id=?' : '';
  const rows = db.prepare(
    `SELECT we.*, w.workplace_ref AS wp_ref, w.loop_state AS wp_loop,
            w.kanban_phase AS wp_kanban
       FROM worker_executions we
       LEFT JOIN factory_workplaces w
         ON w.active_reservation_ref = we.execution_id
      WHERE we.state NOT IN ('exited','spawn_failed','lost','terminated')
        AND we.voided_at IS NULL
        ${projectClause}
      ORDER BY we.project_id, we.reserved_at`,
  ).all(...(projectId !== null ? [projectId] : [])) as Array<
    WorkerExecutionRow & {
      wp_ref: string | null;
      wp_loop: string | null;
      wp_kanban: string | null;
    }
  >;

  const planned: PlannedWorkerStop[] = [];
  for (const row of rows) {
    if (!KNOWN_EXECUTION_STATES.has(row.state) || !ACTIVE_EXECUTION_STATES.has(row.state)) {
      throw new Error(
        `WORKER_STOP_PLAN_UNKNOWN_EXECUTION_STATE: execution '${row.execution_id}' `
        + `has state '${row.state}' which the soft-stop protocol does not `
        + 'know; refusing to plan around an unrecognized state',
      );
    }
    const loop = row.wp_loop;
    if (loop !== null && !HIRABLE_LOOP_STATES.has(loop) && !KERNEL_OWNED_LOOP_STATES.has(loop)) {
      // The execution is active but its workplace sits in a non-hire loop
      // (queued/repair_wait/paused/terminal/idle). Nothing to rewind — the
      // hire already returned; the stop still kills the process.
      planned.push(toPlan(row, 'rewind'));
      continue;
    }
    planned.push(toPlan(row, loop !== null && KERNEL_OWNED_LOOP_STATES.has(loop) ? 'kernel_owned' : 'rewind'));
  }
  return planned;
}

function toPlan(
  row: WorkerExecutionRow & { wp_ref: string | null; wp_loop: string | null; wp_kanban: string | null },
  action: PlannedWorkerStop['action'],
): PlannedWorkerStop {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    projectId: row.project_id,
    epicId: row.epic_id,
    workerId: row.worker_id,
    machineId: row.machine_id,
    state: row.state,
    pid: row.pid,
    processBirthToken: row.process_birth_token,
    workplaceRef: row.wp_ref,
    workplaceLoopState: row.wp_loop,
    workplaceKanbanPhase: row.wp_kanban,
    action,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 — engine brake.
// ---------------------------------------------------------------------------

/** OS process operations for the engine brake; injectable for tests. */
export interface EngineBrakeDeps {
  isAlive(pid: number | null): boolean;
  /** Command line of a live PID, or null when unreadable (guard input). */
  readCommandLine(pid: number): string | null;
  /** Force-kill the whole process tree rooted at pid. */
  killTree(pid: number): boolean;
}

function realReadCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const powershellPath = process.env.POWERSHELL_PATH
        ?? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
      const result = spawnSync(
        powershellPath,
        ['-NoProfile', '-NonInteractive', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      return String(result.stdout ?? '').trim() || null;
    }
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

function realKillTree(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'taskkill', ['/F', '/T', '/PID', String(pid)],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
      );
      return result.status === 0 || !isProcessAlive(pid);
    }
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return !isProcessAlive(pid);
  }
}

export const REAL_ENGINE_BRAKE_DEPS: EngineBrakeDeps = {
  isAlive: isProcessAlive,
  readCommandLine: realReadCommandLine,
  killTree: realKillTree,
};

export interface EngineBrakeResult {
  readonly epicId: number;
  readonly enginePid: number | null;
  readonly outcome: 'already_dead' | 'pid_reused_foreign' | 'braked';
}

/**
 * Guarded-stop every persisted engine covering the scope. The engine's PID is
 * NEVER guessed: it is the union of the two DURABLE pid sources —
 * `lifecycle_execution_controls.engine_pid` (written by the panel
 * engine-administration start path) and `factory_launch_requests.engine_pid`
 * (written by the tracker run-starter and scripts/factory.mjs after their
 * detached spawns). Reading only the controls column made the brake a no-op
 * for every engine launched through the factory CLI or the run-starter
 * (E-A6): the operator's stop left the engine alive and re-hiring. A kill is
 * issued only when the live process's command line matches the
 * `orchestrate-cli.js` guard (a reused PID of an unrelated process is never
 * killed). FAILS CLOSED when a verified engine survives the kill.
 */
export function brakeEnginesForProject(
  db: Database.Database,
  scope: { projectId?: number | null },
  deps: EngineBrakeDeps = REAL_ENGINE_BRAKE_DEPS,
): EngineBrakeResult[] {
  const projectId = scope.projectId ?? null;
  const projectClause = projectId !== null ? 'AND e.project_id=?' : '';
  const controlsRows = db.prepare(
    `SELECT c.epic_id, c.engine_state, c.engine_pid
       FROM lifecycle_execution_controls c
       JOIN epics e ON e.id=c.epic_id
      WHERE c.engine_pid IS NOT NULL ${projectClause}`,
  ).all(...(projectId !== null ? [projectId] : [])) as Array<{
    epic_id: number;
    engine_state: string;
    engine_pid: number;
  }>;
  // E-A6: non-terminal launch rows carry the pid for engines spawned by the
  // run-starter and factory.mjs. 'completed'/'failed' are terminal for the
  // launch; 'paused' frees the one-active slot but its engine may still be
  // winding down — an operator stop wants every live engine of the project.
  const launchProjectClause = projectId !== null ? 'AND l.project_id=?' : '';
  const launchRows = db.prepare(
    `SELECT l.epic_id, l.engine_pid
       FROM factory_launch_requests l
      WHERE l.engine_pid IS NOT NULL
        AND l.state IN ('requested','claimed','running','paused')
        ${launchProjectClause}`,
  ).all(...(projectId !== null ? [projectId] : [])) as Array<{
    epic_id: number;
    engine_pid: number;
  }>;

  // Union the pid sources, deduped by pid (the controls entry wins — same
  // engine, same epic, the richer record).
  const scoped = new Map<number, { epicId: number }>();
  for (const row of controlsRows) {
    scoped.set(row.engine_pid, { epicId: row.epic_id });
  }
  for (const row of launchRows) {
    if (!scoped.has(row.engine_pid)) {
      scoped.set(row.engine_pid, { epicId: row.epic_id });
    }
  }

  const results: EngineBrakeResult[] = [];
  for (const [enginePid, { epicId }] of scoped) {
    if (!deps.isAlive(enginePid)) {
      markEngineStopped(db, epicId);
      results.push({ epicId, enginePid, outcome: 'already_dead' });
      continue;
    }
    const commandLine = deps.readCommandLine(enginePid);
    if (commandLine === null || !commandLine.includes('orchestrate-cli.js')) {
      // Live PID that is NOT our engine (PID reuse). Guarded skip: never kill
      // an unrelated process. There is provably no live engine of ours.
      markEngineStopped(db, epicId);
      results.push({ epicId, enginePid, outcome: 'pid_reused_foreign' });
      continue;
    }
    deps.killTree(enginePid);
    if (deps.isAlive(enginePid)) {
      throw new Error(
        `ENGINE_BRAKE_FAILED: persisted engine pid ${enginePid} `
        + `(epic ${epicId}) matched the orchestrate-cli.js command-line `
        + 'guard but survived a force tree-kill; refusing to continue the '
        + 'soft-stop with a live engine',
      );
    }
    markEngineStopped(db, epicId);
    results.push({ epicId, enginePid, outcome: 'braked' });
  }
  return results;
}

function markEngineStopped(db: Database.Database, epicId: number): void {
  // Idempotent upsert: a launch-row-only brake (E-A6) may target an epic with
  // NO controls row yet — the stopped stamp is still durably recorded for the
  // panel status path, and a pre-existing row keeps its operator columns.
  db.prepare(
    `INSERT INTO lifecycle_execution_controls (epic_id, engine_state, stopped_at)
     VALUES (?, 'stopped', datetime('now'))
     ON CONFLICT(epic_id) DO UPDATE SET
       engine_state='stopped', stopped_at=datetime('now'), updated_at=datetime('now')`,
  ).run(epicId);
}

// ---------------------------------------------------------------------------
// Phase 3 — fence + rewind (one immediate transaction per workplace).
// ---------------------------------------------------------------------------

export interface StopRecordInput {
  readonly stopRef: string;
  readonly executionId: string;
  readonly workplaceRef: string | null;
  readonly projectId: number;
  readonly reason: string;
}

/** Insert the durable stop row idempotently and advance its phase. */
function upsertStopRecord(
  db: Database.Database,
  input: StopRecordInput,
  phase: WorkerStopPhase,
): void {
  db.prepare(
    `INSERT INTO factory_worker_stops
       (stop_ref, worker_execution_ref, workplace_ref, project_id, reason, phase)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(worker_execution_ref) DO UPDATE SET
       phase=excluded.phase, updated_at=datetime('now')`,
  ).run(input.stopRef, input.executionId, input.workplaceRef, input.projectId, input.reason, phase);
}

/** Advance a stop row's phase (monotonic guard: never regress). */
export function advanceStopPhase(
  db: Database.Database,
  executionId: string,
  phase: WorkerStopPhase,
): void {
  db.prepare(
    `UPDATE factory_worker_stops
        SET phase=?, updated_at=datetime('now')
      WHERE worker_execution_ref=?`,
  ).run(phase, executionId);
}

export interface FenceRewindResult {
  readonly executionId: string;
  readonly stopRef: string;
  /**
   * 'fenced' — the rewind ran. 'already_void' — idempotent replay.
   * 'already_terminal' — the hire self-resolved during the brake (e.g. a
   * terminal worker_ask_need committed first); nothing to rewind, the stop is
   * recorded as abandoned audit.
   */
  readonly outcome: 'fenced' | 'already_void' | 'already_terminal';
  readonly workplaceRewound: boolean;
  readonly kernelOwnedSkipped: boolean;
  readonly taskReleased: boolean;
  readonly holdRef: string;
}

/**
 * The load-bearing transaction. Atomically: void the execution (audit-only
 * marker + stop-fence bump), CAS the workplace back to the pre-hire point
 * (queued, same role, Kanban phase preserved per REG-28-AC-02), clear the
 * obligation lease covering the workplace, release the task fence, and insert
 * the operator hold. Kernel-owned workplaces (verifying/effect_pending) are
 * left untouched — the execution is still voided and the task released, but
 * the loop state belongs to the kernel.
 */
export function fenceAndRewindHire(
  db: Database.Database,
  input: StopRecordInput & { createdBy: string },
): FenceRewindResult {
  return withImmediateTransaction(db, () => fenceAndRewindInTx(db, input));
}

function fenceAndRewindInTx(
  db: Database.Database,
  input: StopRecordInput & { createdBy: string },
): FenceRewindResult {
  // Durable fence marker first: the stop row exists from this moment even if a
  // later statement in the transaction fails (rollback removes it — but the
  // protocol only observes committed rows).
  upsertStopRecord(db, input, 'fenced');

  const execution = db.prepare(
    `SELECT execution_id, task_id, project_id, state, voided_at, stop_fence
       FROM worker_executions WHERE execution_id=?`,
  ).get(input.executionId) as {
    execution_id: string;
    task_id: number;
    project_id: number;
    state: string;
    voided_at: string | null;
    stop_fence: number;
  } | undefined;
  if (!execution) {
    throw new Error(`WORKER_STOP_EXECUTION_NOT_FOUND: ${input.executionId}`);
  }
  if (execution.voided_at !== null) {
    // Idempotent replay — the fence already committed. Surface the existing
    // hold so the caller keeps a single unpark handle.
    const hold = db.prepare(
      `SELECT hold_ref FROM factory_operator_holds
        WHERE subject_kind='workplace' AND subject_ref=? AND released_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    ).get(input.workplaceRef ?? '') as { hold_ref: string } | undefined;
    return {
      executionId: input.executionId,
      stopRef: input.stopRef,
      outcome: 'already_void',
      workplaceRewound: false,
      kernelOwnedSkipped: false,
      taskReleased: false,
      holdRef: hold?.hold_ref ?? `hold-none:${input.executionId}`,
    };
  }
  if (execution.state !== 'reserved' && execution.state !== 'running'
    && execution.state !== 'cancel_requested') {
    // The hire self-resolved during the brake window (a terminal
    // worker_ask_need or crash exit committed first). Known and benign: record
    // the stop as abandoned audit and let the caller continue with the rest
    // of the scope. Never rewind a hire that already returned on its own.
    advanceStopPhase(db, input.executionId, 'abandoned');
    return {
      executionId: input.executionId,
      stopRef: input.stopRef,
      outcome: 'already_terminal',
      workplaceRewound: false,
      kernelOwnedSkipped: false,
      taskReleased: false,
      holdRef: `hold-none:${input.executionId}`,
    };
  }

  // VOID the execution. Additive representation: a terminal state value plus
  // the audit-only void marker and a stop-fence bump. The conditional WHERE
  // makes the void itself a CAS — only the fence transaction may move an
  // ACTIVE execution into the void.
  const voidInfo = db.prepare(
    `UPDATE worker_executions
        SET state='terminated', voided_at=datetime('now'),
            stop_fence=stop_fence+1, finished_at=datetime('now'), last_error=?
      WHERE execution_id=? AND voided_at IS NULL
        AND state IN (${ACTIVE_EXECUTION_STATE_SQL})`,
  ).run(`operator soft-stop: ${input.reason}`, input.executionId);
  if (voidInfo.changes !== 1) {
    throw new Error(
      `WORKER_STOP_EXECUTION_NOT_ACTIVE: execution '${input.executionId}' is in `
      + `state '${execution.state}' and cannot be fenced; refusing to rewind a `
      + 'hire that already terminated on its own',
    );
  }

  // Rewind the workplace to the pre-hire point. CAS via the repository's own
  // applyTransitionInTx (revision-guarded); retry bounded times inside the
  // same transaction on a CAS miss.
  let workplaceRewound = false;
  let kernelOwnedSkipped = false;
  if (input.workplaceRef !== null) {
    const repo = new SqliteWorkplaceRepository(db);
    for (let attempt = 0; attempt < 5 && !workplaceRewound; attempt += 1) {
      const row = db.prepare(
        'SELECT * FROM factory_workplaces WHERE workplace_ref=?',
      ).get(input.workplaceRef) as {
        kanban_phase: WorkplaceState['kanbanPhase'];
        loop_state: string;
        next_role: WorkplaceState['nextRole'];
        terminal_reason: string | null;
        revision: number;
      } | undefined;
      if (!row) break;
      if (KERNEL_OWNED_LOOP_STATES.has(row.loop_state)) {
        // Sealed material in kernel custody — the reconciler/adoption own the
        // next transition. Deliberately untouched.
        kernelOwnedSkipped = true;
        break;
      }
      if (!HIRABLE_LOOP_STATES.has(row.loop_state)) {
        // Already queued/repair_wait/paused/terminal — nothing to rewind.
        workplaceRewound = true;
        break;
      }
      const applied = repo.applyTransitionInTx({
        workplaceRef: deserializeWorkplaceRef(input.workplaceRef),
        expectedRevision: row.revision,
        kanbanPhase: row.kanban_phase,
        loopState: 'queued',
        nextRole: row.next_role,
        terminalReason: null,
        activeReservationRef: null,
      });
      if (applied.applied) {
        workplaceRewound = true;
        break;
      }
      // CAS miss — re-read and retry inside the same transaction.
    }
    // Clear any transition-obligation lease covering this workplace so the
    // reconciler can re-drive it (the lease holder died with the engine).
    db.prepare(
      `UPDATE factory_transition_obligations
          SET lease_owner=NULL, lease_expires_at=NULL,
              state=CASE WHEN state='in_progress' THEN 'pending' ELSE state END,
              updated_at=datetime('now')
        WHERE subject_ref=? AND lease_owner IS NOT NULL`,
    ).run(input.workplaceRef);
  }

  // Release the task fence: the card returns to its claimable queue status
  // (todo for the author loop, review for the reviewer loop) while the
  // Workplace keeps its Kanban phase (REG-28-AC-02 — same shape as the
  // reaper's clearTaskFence / transitionTaskToInRepair).
  let taskReleased = false;
  if (workplaceRewound && !kernelOwnedSkipped) {
    const task = db.prepare(
      'SELECT id, status FROM tasks WHERE id=?',
    ).get(execution.task_id) as { id: number; status: string } | undefined;
    if (task) {
      const restoredStatus = task.status === 'review_in_progress' ? 'review' : 'todo';
      const info = db.prepare(
        `UPDATE tasks
            SET status=?, assigned_to=NULL, current_execution_id=NULL,
                metadata=json_remove(COALESCE(metadata,'{}'), '$.worker_pid', '$.worker_started_at'),
                updated_at=datetime('now')
          WHERE id=? AND current_execution_id=?`,
      ).run(restoredStatus, task.id, input.executionId);
      taskReleased = info.changes === 1;
    }
  }

  // Operator hold — unpark surface. Blocks re-hire until released.
  const holdRef = `hold-${randomUUID()}`;
  db.prepare(
    `INSERT INTO factory_operator_holds
       (hold_ref, subject_kind, subject_ref, reason, created_by)
     VALUES (?, 'workplace', ?, ?, ?)`,
  ).run(holdRef, input.workplaceRef ?? `execution:${input.executionId}`, input.reason, input.createdBy);

  // Phase marker for the post-CAS part of the transaction (only 'detached'
  // survives the commit — 'fenced' above is the in-transaction marker).
  advanceStopPhase(db, input.executionId, 'detached');

  return {
    executionId: input.executionId,
    stopRef: input.stopRef,
    outcome: 'fenced',
    workplaceRewound,
    kernelOwnedSkipped,
    taskReleased,
    holdRef,
  };
}

// ---------------------------------------------------------------------------
// Phase 4 — runner hook + guarded tree-kill.
// ---------------------------------------------------------------------------

/** Kill mechanics; injectable for tests. Default: persisted-PID verified kill. */
export interface WorkerKillDeps {
  isAlive(pid: number | null): boolean;
  killVerified(row: Pick<WorkerExecutionRow, 'pid' | 'machine_id' | 'process_birth_token'>): boolean;
}

export const REAL_WORKER_KILL_DEPS: WorkerKillDeps = {
  isAlive: isProcessAlive,
  killVerified: terminateVerifiedProcess,
};

export type KillOutcome =
  | { kind: 'killed'; pid: number }
  | { kind: 'already_dead'; pid: number | null }
  | { kind: 'abandoned_remote'; pid: number; machineId: string };

/**
 * Guarded TREE-kill by persisted PID with death verification. Killing an
 * already-dead PID is a guarded no-op. A live PID on a REMOTE machine cannot
 * be verified from here — it is abandoned (typed), never guessed at.
 */
export function killWorkerTree(
  db: Database.Database,
  executionId: string,
  deps: WorkerKillDeps = REAL_WORKER_KILL_DEPS,
  hostname: string = os.hostname(),
): KillOutcome {
  const row = db.prepare(
    `SELECT pid, machine_id, process_birth_token, state, voided_at
       FROM worker_executions WHERE execution_id=?`,
  ).get(executionId) as {
    pid: number | null;
    machine_id: string;
    process_birth_token: string | null;
    state: string;
    voided_at: string | null;
  } | undefined;
  if (!row) {
    throw new Error(`WORKER_STOP_EXECUTION_NOT_FOUND: ${executionId}`);
  }
  if (row.pid === null || !deps.isAlive(row.pid)) {
    return { kind: 'already_dead', pid: row.pid };
  }
  if (row.machine_id !== hostname) {
    return { kind: 'abandoned_remote', pid: row.pid, machineId: row.machine_id };
  }
  if (row.voided_at === null) {
    // The fence transaction has not run for this execution yet. The protocol
    // brakes + fences BEFORE killing; refuse to kill an unfenced live worker
    // (its MCP tools would still be able to write).
    throw new Error(
      `WORKER_STOP_KILL_BEFORE_FENCE: execution '${executionId}' is alive and not voided; `
      + 'run fenceAndRewindHire before the kill phase',
    );
  }
  const killed = row.process_birth_token !== null
    && deps.killVerified({
      pid: row.pid,
      machine_id: row.machine_id,
      process_birth_token: row.process_birth_token,
    });
  if (!killed || deps.isAlive(row.pid)) {
    throw new Error(
      `WORKER_STOP_KILL_UNVERIFIED: execution '${executionId}' pid ${row.pid} `
      + 'could not be verified dead after the guarded tree-kill',
    );
  }
  return { kind: 'killed', pid: row.pid };
}

// ---------------------------------------------------------------------------
// Phases 0/2-5 — the orchestrator.
// ---------------------------------------------------------------------------

export interface SoftStopInput {
  readonly db: Database.Database;
  /** Project scope; null/undefined = all projects. */
  readonly projectId?: number | null;
  readonly reason: string;
  readonly createdBy: string;
  /** Dry-run: plan only, no writes. */
  readonly dryRun?: boolean;
  readonly engineBrakeDeps?: EngineBrakeDeps;
  readonly killDeps?: WorkerKillDeps;
  readonly hostname?: string;
  /**
   * Best-effort runner stop hook (tracker/claude-runner `stop(projectId)`).
   * Non-blocking: a throw is logged, never fatal.
   */
  readonly runnerStopHook?: (projectId: number) => unknown;
  /**
   * Checkpoint capture at the end of the protocol. Non-fatal: a rejection is
   * logged and the stop result is still returned.
   */
  readonly captureCheckpoint?: () => Promise<unknown>;
  readonly log?: (message: string) => void;
}

export interface WorkerStopOutcome {
  readonly executionId: string;
  readonly stopRef: string;
  readonly plannedAction: PlannedWorkerStop['action'];
  readonly fence: FenceRewindResult;
  readonly kill: KillOutcome;
  readonly phase: WorkerStopPhase;
}

export interface SoftStopResult {
  readonly planned: readonly PlannedWorkerStop[];
  readonly dryRun: boolean;
  readonly engineBrakes: readonly EngineBrakeResult[];
  readonly stops: readonly WorkerStopOutcome[];
  readonly checkpoint: { captured: boolean; detail: string };
}

/**
 * Execute the full soft-stop protocol for a scope. Throws on any fail-closed
 * condition (unknown state, unkillable live engine, unverifiable kill) AFTER
 * the phases that already committed have been persisted — the boot reaper
 * finishes interrupted protocols idempotently.
 */
export async function executeWorkerStops(input: SoftStopInput): Promise<SoftStopResult> {
  const log = input.log ?? ((message: string) => process.stdout.write(`[soft-stop] ${message}\n`));
  const planned = planWorkerStops(input.db, { projectId: input.projectId });
  if (input.dryRun === true) {
    for (const item of planned) {
      log(
        `dry-run execution=${item.executionId} task=${item.taskId} `
        + `workplace=${item.workplaceRef ?? 'none'} loop=${item.workplaceLoopState ?? '-'} `
        + `pid=${item.pid ?? 'none'} action=${item.action}`,
      );
    }
    return { planned, dryRun: true, engineBrakes: [], stops: [], checkpoint: { captured: false, detail: 'dry-run' } };
  }

  // Phase 2 — brake every engine covering the scope, before anything durable
  // changes (the engine's dispatch loop would otherwise re-hire mid-stop).
  const engineBrakes = brakeEnginesForProject(
    input.db, { projectId: input.projectId }, input.engineBrakeDeps ?? REAL_ENGINE_BRAKE_DEPS,
  );
  for (const brake of engineBrakes) {
    log(`engine epic=${brake.epicId} pid=${brake.enginePid} outcome=${brake.outcome}`);
  }

  const stops: WorkerStopOutcome[] = [];
  for (const plan of planned) {
    const stopRef = `stop-${randomUUID()}`;
    // Phase 0 — durable plan record.
    upsertStopRecord(
      input.db,
      {
        stopRef,
        executionId: plan.executionId,
        workplaceRef: plan.workplaceRef,
        projectId: plan.projectId,
        reason: input.reason,
      },
      'planned',
    );
    advanceStopPhase(input.db, plan.executionId, 'engine_braked');

    if (plan.action === 'kernel_owned') {
      log(
        `execution=${plan.executionId} workplace=${plan.workplaceRef} is kernel-owned `
        + `(${plan.workplaceLoopState}); left untouched (adoption/reconciler own it)`,
      );
    }

    // Phase 3 — fence + rewind (one immediate transaction).
    const fence = fenceAndRewindHire(input.db, {
      stopRef,
      executionId: plan.executionId,
      workplaceRef: plan.workplaceRef,
      projectId: plan.projectId,
      reason: input.reason,
      createdBy: input.createdBy,
    });

    // Phase 4a — runner stop hook, best-effort and non-blocking.
    let phase: WorkerStopPhase = 'detached';
    if (fence.outcome === 'already_terminal') {
      // The hire self-resolved during the brake; the runner owns its process.
      log(
        `execution=${plan.executionId} already terminal before the fence (hire self-resolved); `
        + 'stop recorded as abandoned audit',
      );
      stops.push({
        executionId: plan.executionId,
        stopRef,
        plannedAction: plan.action,
        fence,
        kill: { kind: 'already_dead', pid: plan.pid },
        phase: 'abandoned',
      });
      continue;
    }
    if (input.runnerStopHook) {
      try {
        input.runnerStopHook(plan.projectId);
        advanceStopPhase(input.db, plan.executionId, 'hook_sent');
        phase = 'hook_sent';
      } catch (hookError) {
        log(
          `runner stop hook failed for execution=${plan.executionId} (non-fatal): `
          + `${hookError instanceof Error ? hookError.message : String(hookError)}`,
        );
      }
    }

    // Phase 4b — guarded tree-kill with death verification.
    let kill: KillOutcome;
    try {
      kill = killWorkerTree(
        input.db, plan.executionId,
        input.killDeps ?? REAL_WORKER_KILL_DEPS,
        input.hostname ?? os.hostname(),
      );
    } catch (killError) {
      advanceStopPhase(input.db, plan.executionId, 'abandoned');
      throw killError;
    }
    if (kill.kind === 'abandoned_remote') {
      advanceStopPhase(input.db, plan.executionId, 'abandoned');
    } else {
      advanceStopPhase(input.db, plan.executionId, 'killed');
      phase = 'killed';
    }
    log(
      `execution=${plan.executionId} fence=${fence.outcome} `
      + `workplaceRewound=${fence.workplaceRewound} kill=${kill.kind}`,
    );
    stops.push({
      executionId: plan.executionId,
      stopRef,
      plannedAction: plan.action,
      fence,
      kill,
      phase,
    });
  }

  // Phase 5 — one checkpoint capture at the end (non-fatal, logged).
  let checkpoint: SoftStopResult['checkpoint'] = { captured: false, detail: 'no capture configured' };
  if (input.captureCheckpoint) {
    try {
      await input.captureCheckpoint();
      for (const stop of stops) {
        advanceStopPhase(input.db, stop.executionId, 'checkpointed');
      }
      checkpoint = { captured: true, detail: 'ok' };
    } catch (checkpointError) {
      checkpoint = {
        captured: false,
        detail: checkpointError instanceof Error ? checkpointError.message : String(checkpointError),
      };
      log(`checkpoint capture failed (non-fatal): ${checkpoint.detail}`);
    }
  }

  return { planned, dryRun: false, engineBrakes, stops, checkpoint };
}

// ---------------------------------------------------------------------------
// Boot reaper — converge crash windows.
// ---------------------------------------------------------------------------

export interface ReapedStop {
  readonly executionId: string;
  readonly outcome: 'killed' | 'already_dead' | 'abandoned_remote' | 'fence_completed';
}

/**
 * Idempotent convergence for interrupted soft-stops: stop rows not yet in a
 * done phase whose execution carries a PID. The fence is re-driven (idempotent
 * — an already-voided execution is a no-op), then the kill is completed. Runs
 * at boot (factory-boot-revision), after the engine brake has already happened
 * for stale engines elsewhere in the revision pass.
 */
export function reapInterruptedWorkerStops(
  db: Database.Database,
  deps: WorkerKillDeps = REAL_WORKER_KILL_DEPS,
  hostname: string = os.hostname(),
): ReapedStop[] {
  const rows = db.prepare(
    `SELECT s.stop_ref, s.worker_execution_ref, s.workplace_ref, s.project_id, s.reason,
            we.pid, we.machine_id
       FROM factory_worker_stops s
       JOIN worker_executions we ON we.execution_id=s.worker_execution_ref
      WHERE s.phase NOT IN (${REAPER_DONE_PHASE_SQL})
      ORDER BY s.created_at`,
  ).all() as Array<{
    stop_ref: string;
    worker_execution_ref: string;
    workplace_ref: string | null;
    project_id: number;
    reason: string;
    pid: number | null;
    machine_id: string;
  }>;

  const reaped: ReapedStop[] = [];
  for (const row of rows) {
    // Complete any interrupted fence first (no-op when already voided).
    const fence = fenceAndRewindHire(db, {
      stopRef: row.stop_ref,
      executionId: row.worker_execution_ref,
      workplaceRef: row.workplace_ref,
      projectId: row.project_id,
      reason: `${row.reason} (boot reaper)`,
      createdBy: 'boot-reaper',
    });
    if (fence.outcome === 'fenced') {
      reaped.push({ executionId: row.worker_execution_ref, outcome: 'fence_completed' });
    }
    if (row.pid === null || !deps.isAlive(row.pid)) {
      advanceStopPhase(db, row.worker_execution_ref, 'reaped');
      reaped.push({ executionId: row.worker_execution_ref, outcome: 'already_dead' });
      continue;
    }
    if (row.machine_id !== hostname) {
      advanceStopPhase(db, row.worker_execution_ref, 'abandoned');
      reaped.push({ executionId: row.worker_execution_ref, outcome: 'abandoned_remote' });
      continue;
    }
    const killed = deps.killVerified({
      pid: row.pid,
      machine_id: row.machine_id,
      process_birth_token: (db.prepare(
        'SELECT process_birth_token FROM worker_executions WHERE execution_id=?',
      ).get(row.worker_execution_ref) as { process_birth_token: string | null }).process_birth_token,
    });
    if (killed && !deps.isAlive(row.pid)) {
      advanceStopPhase(db, row.worker_execution_ref, 'reaped');
      reaped.push({ executionId: row.worker_execution_ref, outcome: 'killed' });
    } else {
      advanceStopPhase(db, row.worker_execution_ref, 'abandoned');
    }
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// Park — place a project-scope operator hold (graceful-drain pause).
// ---------------------------------------------------------------------------

export interface PlaceProjectHoldInput {
  readonly projectId: number;
  readonly reason: string;
  readonly createdBy: string;
}

export interface PlaceProjectHoldResult {
  /** Durable hold identity — the unpark handle. */
  readonly holdRef: string;
  /** false when an unreleased project hold already existed (idempotent replay). */
  readonly placed: boolean;
}

/**
 * GRACEFUL-DRAIN PAUSE (docs/architecture/PAUSE-DESIGN.md). One project-scope
 * hold IS the whole pause: the claim SQL (work-assignment-core) refuses every
 * card of the project while the hold is unreleased, active workers are
 * untouched (holds are consulted only on claim — one launch = one card, so a
 * worker never claims a second card on its own), and the engine drains its
 * active tail then self-parks via the existing 3-streak exit-2 'paused' path.
 * Counterpart writer of releaseOperatorHolds({projectId}).
 *
 * No kill, no rewind, no fence: the queue fence alone lets every in-flight
 * turn finish. Idempotent — a second placement (operator double-click, panel
 * reload) surfaces the SAME hold instead of stacking rows.
 */
export function placeProjectHold(
  db: Database.Database,
  input: PlaceProjectHoldInput,
): PlaceProjectHoldResult {
  return withImmediateTransaction(db, () => {
    const existing = db.prepare(
      `SELECT hold_ref FROM factory_operator_holds
        WHERE subject_kind='project' AND subject_ref=? AND released_at IS NULL`,
    ).get(String(input.projectId)) as { hold_ref: string } | undefined;
    if (existing) {
      return { holdRef: existing.hold_ref, placed: false };
    }
    const holdRef = `hold-${randomUUID()}`;
    db.prepare(
      `INSERT INTO factory_operator_holds
         (hold_ref, subject_kind, subject_ref, reason, created_by)
       VALUES (?, 'project', ?, ?, ?)`,
    ).run(holdRef, String(input.projectId), input.reason, input.createdBy);
    return { holdRef, placed: true };
  });
}

// ---------------------------------------------------------------------------
// Unpark — release operator holds.
// ---------------------------------------------------------------------------

export interface ReleaseHoldsInput {
  /** Release holds for every workplace of this project plus its project holds. */
  readonly projectId?: number;
  /** Release exactly one hold. */
  readonly holdRef?: string;
  /** Release holds for one workplace (accepts the serialized workplace_ref). */
  readonly workplaceRef?: string;
  readonly releasedBy?: string;
}

export interface ReleaseHoldsResult {
  readonly released: number;
  readonly holdRefs: readonly string[];
}

/**
 * UNPARK. Stamps released_at on active holds so hiring resumes. Idempotent:
 * a second call releases nothing. Workplace holds are scoped by the workplace
 * ref; a --project release covers both the project-scope hold and every
 * workplace hold belonging to that project's workplaces.
 */
export function releaseOperatorHolds(
  db: Database.Database,
  input: ReleaseHoldsInput,
): ReleaseHoldsResult {
  return withImmediateTransaction(db, () => {
    let holdRows: Array<{ hold_ref: string }> = [];
    if (input.holdRef !== undefined) {
      holdRows = db.prepare(
        `SELECT hold_ref FROM factory_operator_holds
          WHERE hold_ref=? AND released_at IS NULL`,
      ).all(input.holdRef) as Array<{ hold_ref: string }>;
    } else if (input.workplaceRef !== undefined) {
      holdRows = db.prepare(
        `SELECT hold_ref FROM factory_operator_holds
          WHERE subject_kind='workplace' AND subject_ref=? AND released_at IS NULL`,
      ).all(input.workplaceRef) as Array<{ hold_ref: string }>;
    } else if (input.projectId !== undefined) {
      holdRows = db.prepare(
        `SELECT h.hold_ref
           FROM factory_operator_holds h
          WHERE h.released_at IS NULL
            AND (
              (h.subject_kind='project' AND h.subject_ref=?)
              OR (h.subject_kind='workplace' AND EXISTS (
                    SELECT 1 FROM factory_workplaces w
                     WHERE w.workplace_ref=h.subject_ref
                       AND w.process_run_id IN (
                         SELECT pr.id FROM factory_process_runs pr
                          WHERE pr.project_id=?
                       )))
            )`,
      ).all(String(input.projectId), input.projectId) as Array<{ hold_ref: string }>;
    } else {
      throw new Error('OPERATOR_HOLD_RELEASE_SCOPE_REQUIRED: pass projectId, workplaceRef or holdRef');
    }
    for (const row of holdRows) {
      db.prepare(
        `UPDATE factory_operator_holds
            SET released_at=datetime('now')
          WHERE hold_ref=? AND released_at IS NULL`,
      ).run(row.hold_ref);
    }
    return { released: holdRows.length, holdRefs: holdRows.map(row => row.hold_ref) };
  });
}

export interface UnparkWorkplaceInput {
  readonly projectId?: number;
  readonly workplaceRef?: string;
  readonly actorId: string;
  readonly reason: string;
}

export interface UnparkedWorkplace {
  readonly workplaceRef: string;
  readonly revision: number;
}

/**
 * Operator override for budget-exhaustion parks: perform the reducer's own
 * canonical `repair-requeued` transition (production-cell-reducer —
 * "paused → queued (after a human-required block is resumed)") on every
 * blocked/paused workplace in scope. Kanban phase returns to the role's
 * active phase (REG-28-AC-02: the phase is never rolled back to todo). The
 * CAS on (blocked, paused, revision) makes the operation idempotent: a
 * workplace that already left the park is skipped, not double-applied.
 */
export function unparkWorkplaces(
  db: Database.Database,
  input: UnparkWorkplaceInput,
): { unparked: readonly UnparkedWorkplace[] } {
  if (input.projectId === undefined && input.workplaceRef === undefined) {
    throw new Error('OPERATOR_UNPARK_SCOPE_REQUIRED: pass projectId or workplaceRef');
  }
  return withImmediateTransaction(db, () => {
    const rows = input.workplaceRef !== undefined
      ? db.prepare(
        `SELECT workplace_ref, revision, next_role FROM factory_workplaces
          WHERE workplace_ref=? AND kanban_phase='blocked' AND loop_state='paused'`,
      ).all(input.workplaceRef) as Array<{
        workplace_ref: string; revision: number; next_role: string | null;
      }>
      : db.prepare(
        `SELECT w.workplace_ref, w.revision, w.next_role
           FROM factory_workplaces w
          WHERE w.kanban_phase='blocked' AND w.loop_state='paused'
            AND w.process_run_id IN (
              SELECT pr.id FROM factory_process_runs pr WHERE pr.project_id=?
            )`,
      ).all(input.projectId) as Array<{
        workplace_ref: string; revision: number; next_role: string | null;
      }>;
    const unparked: UnparkedWorkplace[] = [];
    for (const row of rows) {
      const role = row.next_role === 'reviewer' ? 'reviewer' : 'author';
      const targetPhase = role === 'reviewer' ? 'review_in_progress' : 'in_progress';
      const applied = db.prepare(
        `UPDATE factory_workplaces
            SET kanban_phase=?, loop_state='queued', next_role=?,
                revision=revision+1, updated_at=datetime('now')
          WHERE workplace_ref=? AND kanban_phase='blocked' AND loop_state='paused'
            AND revision=?`,
      ).run(targetPhase, role, row.workplace_ref, row.revision);
      if (applied.changes !== 1) continue;
      db.prepare(
        `INSERT INTO activity_log (entity_type, entity_id, action, summary)
         VALUES ('workplace', ?, 'operator-unpark', ?)`,
      ).run(
        input.workplaceRef !== undefined ? input.workplaceRef : String(input.projectId),
        `operator unpark (repair-requeued) by ${input.actorId}: ${row.workplace_ref} paused/blocked→queued ${role} — ${input.reason}`,
      );
      unparked.push({ workplaceRef: row.workplace_ref, revision: row.revision + 1 });
    }
    return { unparked };
  });
}
