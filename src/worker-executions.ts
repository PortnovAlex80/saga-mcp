import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { releaseExecutionAtomically } from './lifecycle/atomic-release.js';
import {
  decideStuckAction,
  FINISH_GRACE_MS,
  REAL_SUPERVISION_CLOCK,
  type SupervisionClock,
} from './lifecycle/stuck-policy.js';

export const ACTIVE_EXECUTION_STATES = ['reserved', 'running', 'cancel_requested'] as const;
const ACTIVE_STATE_SQL = "'reserved','running','cancel_requested'";
// Stuck-policy thresholds (STUCK_SILENCE_MS, STUCK_CANCEL_GRACE_MS,
// CANCEL_GRACE_MS, RESERVED_BOOT_TIMEOUT_MS, FINISH_GRACE_MS) now live in
// src/lifecycle/stuck-policy.ts as the single source of truth. Re-exported
// from there for callers that still reference them by name.

/**
 * Injection seam for OS process operations (CONVEYOR §"Domain ... never calls
 * process.kill itself"). Tests inject a stub so they never spawn/kill real OS
 * processes; production wires the real {@link REAL_PROCESS_PROBE} below. The
 * seam groups liveness probe + birth-token read + verified kill so a single fake
 * can control the whole stuck-policy termination path deterministically.
 */
export interface ProcessProbe {
  isAlive(pid: number | null): boolean;
  readBirthToken(pid: number): string | null;
  killVerified(pid: number, expectedToken: string): boolean;
}

/**
 * Production probe backed by real OS calls (process.kill(0), /proc or CIM birth
 * token, SIGKILL/taskkill). Tests pass a fake instead.
 */
export const REAL_PROCESS_PROBE: ProcessProbe = {
  isAlive: isProcessAlive,
  readBirthToken: (pid: number) => readProcessBirthToken(pid),
  killVerified: (pid: number, expectedToken: string) => terminateVerifiedProcess({
    pid, machine_id: os.hostname(), process_birth_token: expectedToken,
  }),
};

/** Options for {@link reconcileWorkerExecutions} (all optional / backward-compatible). */
export interface ReconcileOptions {
  /** OS process probe; defaults to the real probe. Tests inject a fake. */
  processProbe?: ProcessProbe;
  /** this machine's hostname; defaults to os.hostname(). Tests pin it. */
  hostname?: string;
  /**
   * Narrow LOCAL supervision clock (ADR-022 retired the global ClockPort; this
   * is the reaper-only replacement). Defaults to the real wall-clock. Tests
   * inject a fixed clock for deterministic grace-window arithmetic.
   */
  clock?: SupervisionClock;
}

export interface WorkerExecutionRow {
  execution_id: string;
  run_id: string;
  project_id: number;
  epic_id: number;
  task_id: number;
  worker_id: string;
  machine_id: string;
  state: string;
  phase: string;
  pid: number | null;
  process_birth_token: string | null;
  log_path: string | null;
  reserved_at: string;
  started_at: string | null;
  phase_updated_at: string;
  // CONVEYOR Wave 5 supervision columns (nullable on pre-migration rows).
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  progress_at: string | null;
  suspected_stuck_at: string | null;
  cancel_requested_at: string | null;
  stuck_state: string | null;
  task_status: string | null;
  task_assigned_to: string | null;
  current_execution_id: string | null;
  integration_state: string | null;
}

function openRuntimeDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function assertExecutionFence(
  db: Database.Database,
  task: { id: number; current_execution_id?: string | null },
  executionId: unknown,
): void {
  if (!task.current_execution_id) return;
  if (typeof executionId !== 'string' || executionId !== task.current_execution_id) {
    throw new Error(
      `Task ${task.id} is fenced by execution ${task.current_execution_id}; ` +
      `stale or missing execution_id cannot mutate it`,
    );
  }
  const active = db.prepare(
    `SELECT 1 FROM worker_executions
     WHERE execution_id=? AND task_id=? AND state IN (${ACTIVE_STATE_SQL})`,
  ).get(executionId, task.id);
  if (!active) throw new Error(`Execution ${executionId} is no longer active for task ${task.id}`);
}

export function markExecutionRunning(
  dbPath: string,
  executionId: string,
  pid: number | null,
  processBirthToken: string | null,
  logPath: string,
  startedAt: string,
): void {
  if (pid !== null && !processBirthToken) {
    throw new Error(`cannot fence execution ${executionId}: process birth identity is unavailable`);
  }
  const db = openRuntimeDb(dbPath);
  try {
    const info = db.prepare(
      `UPDATE worker_executions
       SET state='running', pid=?, process_birth_token=?, log_path=?,
           started_at=?, phase_updated_at=datetime('now')
       WHERE execution_id=? AND state='reserved'`,
    ).run(pid, processBirthToken, logPath, startedAt, executionId);
    if (info.changes !== 1) {
      throw new Error(`execution ${executionId} reservation is missing or no longer active`);
    }
    db.prepare(
      `UPDATE tasks SET metadata=json_set(COALESCE(metadata,'{}'),
         '$.worker_pid', ?, '$.worker_started_at', ?)
       WHERE current_execution_id=?`,
    ).run(pid, startedAt, executionId);
  } finally {
    db.close();
  }
}

/**
 * CONVEYOR Wave 5 — progress signal (§363-370). Records that the worker
 * produced observable activity (stdout, tool call, model stream event). This
 * is the PROGRESS heartbeat, distinct from the LIVENESS heartbeat (lease
 * renewal). The stuck-policy measures silence against `progress_at`; WITHOUT
 * progress updates a long-running-but-healthy worker is falsely classified as
 * stuck and eventually terminated.
 *
 * Called from the runner's stdout/close observation hooks (the foreman). It is
 * best-effort and idempotent: a stale execution (no longer active) is a no-op.
 */
export function markExecutionProgress(
  dbPath: string,
  executionId: string,
): void {
  const db = openRuntimeDb(dbPath);
  try {
    db.prepare(
      `UPDATE worker_executions
       SET progress_at=datetime('now')
       WHERE execution_id=? AND state IN ('reserved','running','cancel_requested')`,
    ).run(executionId);
  } finally {
    db.close();
  }
}

export function markExecutionSpawnFailed(
  dbPath: string,
  executionId: string,
  error: string,
): void {
  const db = openRuntimeDb(dbPath);
  try {
    db.prepare(
      `UPDATE worker_executions
       SET state='spawn_failed', finished_at=datetime('now'), last_error=?
       WHERE execution_id=? AND state IN ('reserved','running')`,
    ).run(error, executionId);
  } finally {
    db.close();
  }
}

/**
 * CONVEYOR Wave 8 / MEDIUM 6 — single-writer closure.
 *
 * Previously this function wrote `worker_executions` AND `tasks`
 * (current_execution_id + worker_pid metadata) directly in its own transaction,
 * which was the documented "temporary exception" in the single-writer gate
 * (tests/architecture/tasks-writer-invariant.test.mjs). Wave 2 (FU-D) was
 * supposed to consolidate it; this finally does: the function now DELEGATES to
 * {@link releaseExecutionAtomically}, the same primitive the reaper and the
 * reaper path onto ONE atomic mechanism (blueprint §22:1199).
 *
 * Behavioral equivalence notes:
 *   - `state` ('exited' | 'terminated') maps 1:1 to releaseExecutionAtomically's
 *     `terminalState` (which accepts exactly those values for this caller).
 *   - The old code's `worker_pid` metadata CAS (only strip the pid stamp when
 *     the execution row's pid equals the task metadata's worker_pid) is
 *     subsumed by releaseExecutionAtomically's fence CAS: the metadata is only
 *     touched when `current_execution_id` STILL matches this execution. If the
 *     task was reassigned mid-close, the CAS fails (changes=0) and the new
 *     owner's metadata is left intact — the same protection, expressed via the
 *     fence instead of a pid-equality check.
 *   - exit_code is forwarded to the execution row exactly as before.
 */
export function markExecutionExited(
  dbPath: string,
  executionId: string,
  exitCode: number | null,
  state: 'exited' | 'terminated' = 'exited',
): void {
  const db = openRuntimeDb(dbPath);
  try {
    releaseExecutionAtomically(db, {
      executionId,
      terminalState: state,
      exitCode,
      reason: `process exited (state=${state}, exitCode=${exitCode ?? 'null'})`,
    });
  } finally {
    db.close();
  }
}

export function updateExecutionPhase(
  db: Database.Database,
  taskId: number,
  workerId: string,
  executionId: unknown,
  phase: 'finishing' | 'integrating',
): void {
  if (typeof executionId !== 'string') return;
  db.prepare(
    `UPDATE worker_executions
     SET phase=?, phase_updated_at=datetime('now')
     WHERE execution_id=? AND task_id=? AND worker_id=?
       AND state IN (${ACTIVE_STATE_SQL})`,
  ).run(phase, executionId, taskId, workerId);
}

export function isProcessAlive(pid: number | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readProcessBirthToken(pid: number | null): string | null {
  if (!pid || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      // Resolve the full PowerShell path: Git Bash / restricted environments
      // may not have 'powershell' on the PATH visible to Node spawnSync.
      const powershellPath = process.env.POWERSHELL_PATH
        ?? 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
      const result = spawnSync(
        powershellPath,
        [
          '-NoProfile', '-NonInteractive', '-Command',
          `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; ` +
          `if ($null -ne $p) { $p.CreationDate.ToUniversalTime().ToString('o') }`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      );
      const token = String(result.stdout ?? '').trim();
      return token || null;
    }
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      return tail[19] ? `linux:${tail[19]}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * CONVEYOR Wave 5: verify a stored process birth token still matches the live
 * OS process for this PID. Returns false when the PID is gone OR when the PID
 * is alive but its birth token differs (PID was reused by an unrelated process
 * after the original worker died — scenario 16). The reaper may only terminate
 * a stuck worker when this returns true; a mismatch is left for a human.
 */
export function verifyProcessBirthToken(
  pid: number | null,
  expectedToken: string | null,
): boolean {
  if (!pid || !expectedToken) return false;
  const currentToken = readProcessBirthToken(pid);
  return currentToken !== null && currentToken === expectedToken;
}

export function terminateVerifiedProcess(
  row: Pick<WorkerExecutionRow, 'pid' | 'machine_id' | 'process_birth_token'>,
): boolean {
  if (!row.pid || row.machine_id !== os.hostname() || !row.process_birth_token) return false;
  const currentToken = readProcessBirthToken(row.pid);
  if (!currentToken || currentToken !== row.process_birth_token) return false;
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'taskkill',
        ['/F', '/T', '/PID', String(row.pid)],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      );
      return result.status === 0 || !isProcessAlive(row.pid);
    }
    process.kill(row.pid, 'SIGKILL');
    return true;
  } catch {
    return !isProcessAlive(row.pid);
  }
}

function parseDbTime(value: string | null): number {
  if (!value) return 0;
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

// releaseOwnedTask was removed in Slice 1. Its logic — terminalize the
// execution AND release the task in one atomic transaction with a fence CAS —
// moved to src/lifecycle/atomic-release.ts (releaseExecutionAtomically).
// All previous callers (reconcileWorkerExecutions here, recoverAssignment in
// orchestrate.ts, recoverRunnerAssignment in tracker-view.mjs) now delegate
// to that single function. This eliminates the duplicate recovery SQL the
// audit flagged (blueprint §22:1199) and collapses the close/reconciler race.

export interface ReconcileResult {
  executionId: string;
  taskId: number;
  action: 'kept' | 'lost' | 'terminated' | 'remote_unknown';
  released: boolean;
  reason: string;
}

export function reconcileWorkerExecutions(
  db: Database.Database,
  projectId: number,
  epicId?: number,
  nowMs?: number,
  options?: ReconcileOptions,
): ReconcileResult[] {
  // Uncle Bob Wave 2 / FU-D: this is now a thin MECHANISM. All POLICY (silence
  // thresholds, grace windows, lease-expiry logic, stuck-state transitions,
  // legitimacy predicates) lives in the pure `decideStuckAction` function
  // (src/lifecycle/stuck-policy.ts). This function: (1) SELECT+JOINs rows,
  // (2) precomputes the IO-dependent booleans the policy needs, (3) calls the
  // policy, (4) dispatches on the returned Action to perform the IO. Reason
  // strings ride on the Action as data — they are no longer inline here.
  //
  // The clock: ADR-022 retired the global ClockPort; the reaper takes a NARROW
  // LOCAL SupervisionClock (default real wall-clock; tests inject a fixed one).
  // nowMs defaults to clock.now().getTime() so the grace-window arithmetic is
  // deterministic under test injection. Callers passing nowMs positionally
  const probe = options?.processProbe ?? REAL_PROCESS_PROBE;
  const hostname = options?.hostname ?? os.hostname();
  const clock = options?.clock ?? REAL_SUPERVISION_CLOCK;
  const sweepMs = nowMs ?? clock.now().getTime();
  const nowIso = new Date(sweepMs).toISOString();

  const epicClause = epicId === undefined ? '' : 'AND we.epic_id=?';
  const params = epicId === undefined ? [projectId] : [projectId, epicId];
  const rows = db.prepare(
    `SELECT we.*, t.status AS task_status, t.assigned_to AS task_assigned_to,
            t.current_execution_id, t.integration_state
     FROM worker_executions we
     LEFT JOIN tasks t ON t.id=we.task_id
     WHERE we.project_id=? AND we.state IN (${ACTIVE_STATE_SQL}) ${epicClause}
     ORDER BY we.reserved_at`,
  ).all(...params) as WorkerExecutionRow[];

  const results: ReconcileResult[] = [];
  for (const row of rows) {
    // --- Precompute the IO-dependent booleans the policy needs. ------------
    // isLocal: computed here (not in the policy) so the mechanism can also map
    // a remote KEEP to the `remote_unknown` result action below.
    const isLocal = row.machine_id === hostname;
    // isAlive: reserved rows have no PID → false (never release reserved by
    // !alive — see RESERVED_BOOT_TIMEOUT_MS gate in the policy). Otherwise ask
    // the probe. birthTokenMatches: readBirthToken === stored token (false when
    // either is missing OR when the PID was reused — scenario 16).
    const isAlive = row.state === 'reserved' ? false : probe.isAlive(row.pid);
    const expectedToken = row.process_birth_token;
    const birthTokenMatches = row.pid !== null
      && expectedToken !== null
      && probe.readBirthToken(row.pid) === expectedToken;

    const phaseAge = sweepMs - parseDbTime(row.phase_updated_at);
    const fenceOurs = row.current_execution_id === row.execution_id;
    const ownsActiveTask = fenceOurs
      && row.task_assigned_to === row.worker_id
      && (row.task_status === 'in_progress' || row.task_status === 'review_in_progress');
    const legitimateIntegration = fenceOurs
      && row.phase === 'integrating'
      && row.task_status === 'done'
      && row.integration_state === 'pending';
    const legitimateFinishing = fenceOurs
      && row.phase === 'finishing'
      && phaseAge < FINISH_GRACE_MS;

    // --- Ask the pure policy for the decision. -----------------------------
    const action = decideStuckAction({
      isLocal,
      nowMs: sweepMs,
      reservedAtMs: parseDbTime(row.reserved_at),
      leaseExpiresAtMs: parseDbTime(row.lease_expires_at),
      progressAtMs: parseDbTime(row.progress_at),
      suspectedStuckAtMs: parseDbTime(row.suspected_stuck_at),
      cancelRequestedAtMs: parseDbTime(row.cancel_requested_at),
      phaseUpdatedAtMs: parseDbTime(row.phase_updated_at),
      state: row.state as 'reserved' | 'running' | 'cancel_requested',
      stuckState: (row.stuck_state ?? null) as
        | 'active'
        | 'suspected_stuck'
        | 'cancel_requested'
        | null,
      phase: row.phase,
      isAlive,
      birthTokenMatches,
      ownsActiveTask,
      legitimateIntegration,
      legitimateFinishing,
    });

    // --- Dispatch on the Action. -------------------------------------------
    // isLocal (computed above) lets the mechanism map a remote KEEP to the
    // `remote_unknown` result action: the result enum distinguishes "kept a
    // local row" from "deferred a remote row to its durable lease". The policy's
    // KEEP reason already carries the rationale.
    switch (action.kind) {
      case 'KEEP':
        results.push(keptResult(row, action.reason, isLocal));
        break;
      case 'TERMINATE_BUT_PID_REUSE':
        // KEEP for a human: never kill a reused PID (scenario 16).
        results.push(keptResult(row, action.reason));
        break;
      case 'MARK_SUSPECTED':
        // BYTE-IDENTITY: the procedural code only stamps suspected_stuck_at on
        // the FRESH transition into suspected_stuck (guarded by
        // `stuck_state !== 'suspected_stuck'`). Re-stamping on every sweep would
        // reset the cancel-grace clock and prevent the row from ever reaching
        // cancel_requested. So the UPDATE is conditional on not-already-suspected.
        stampStuckIfNotAlready(db, row.execution_id, 'suspected_stuck', nowIso);
        results.push(keptResult(row, action.reason));
        break;
      case 'REQUEST_CANCEL':
        applyStuckTransition(db, row.execution_id, 'cancel_requested', nowIso, 'cancel_requested_at' as const);
        results.push(keptResult(row, action.reason));
        break;
      case 'TERMINATE': {
        // Verified PID identity (stage 3) OR alive-illegitimate (final path):
        // kill, then release. killVerified may fail (race, partial death) →
        // KEEP and observe. The two kill-failure reasons are distinguished by
        // context (stage-3 vs final-alive) to match the procedural strings.
        const killed = row.pid !== null
          && expectedToken !== null
          && probe.killVerified(row.pid, expectedToken);
        if (!killed) {
          const killFailReason = row.stuck_state === 'cancel_requested'
            ? 'verified process termination failed; observing'
            : 'unsafe to terminate without matching process birth identity';
          results.push(keptResult(row, killFailReason));
          break;
        }
        const outcome = releaseExecutionAtomically(db, {
          executionId: row.execution_id,
          terminalState: 'terminated',
          reason: action.reason,
          lastError: action.reason,
        });
        results.push({
          executionId: row.execution_id, taskId: row.task_id, action: 'terminated',
          released: outcome.taskReleased, reason: action.reason,
        });
        break;
      }
      case 'RELEASE': {
        const outcome = releaseExecutionAtomically(db, {
          executionId: row.execution_id,
          terminalState: action.terminal,
          reason: action.reason,
          lastError: action.reason,
        });
        // Remote-lease-expired, dead-local, and reserved-boot-timeout releases
        // all report action 'lost' in the result enum (the result action tracks
        // the outcome class, not the terminal-state name).
        results.push({
          executionId: row.execution_id, taskId: row.task_id, action: 'lost',
          released: outcome.taskReleased, reason: action.reason,
        });
        break;
      }
      default: {
        // Exhaustiveness guard — the policy is total, but the compiler ensures
        // we never silently drop a new Action kind.
        const _exhaustive: never = action;
        void _exhaustive;
      }
    }
  }

  // Transitional recovery for pre-ADR-009 (unfenced) assignments. Orthogonal
  // to the stuck policy — left as a sibling, NOT folded into decideStuckAction
  // (which reasons only about fenced executions).
  return results;
}

/**
 * Push a `kept` (or `remote_unknown`) result for an execution that was not
 * released. A remote row kept because its lease is still alive reports
 * `remote_unknown` (the result enum distinguishes "kept a local row" from
 * "deferred a remote row to its durable lease"); all other kept rows report
 * `kept`.
 */
function keptResult(row: WorkerExecutionRow, reason: string, isLocal = true): ReconcileResult {
  return {
    executionId: row.execution_id,
    taskId: row.task_id,
    action: isLocal ? 'kept' : 'remote_unknown',
    released: false,
    reason,
  };
}

/**
 * Apply a stuck-state transition into `cancel_requested`: stamp `stuck_state`
 * and `cancel_requested_at` with the sweep's `nowIso` (NOT SQLite
 * datetime('now')) so the kill-grace clock is consistent with the sweep's nowMs
 * and deterministic under a test-injected clock. This fires at most once per
 * execution: after the stamp, stuck_state='cancel_requested' and stage 1's
 * `stuck_state !== 'cancel_requested'` guard excludes the row from this branch
 * on subsequent sweeps (it moves to stage 3). The procedural UPDATE here is
 * unconditional, matching the original code.
 */
function applyStuckTransition(
  db: Database.Database,
  executionId: string,
  stuckState: 'cancel_requested',
  nowIso: string,
  tsColumn: 'cancel_requested_at',
): void {
  db.prepare(
    `UPDATE worker_executions
        SET stuck_state=?, ${tsColumn}=?
      WHERE execution_id=? AND state IN (${ACTIVE_STATE_SQL})`,
  ).run(stuckState, nowIso, executionId);
}

/**
 * Stamp `stuck_state='suspected_stuck'` + `suspected_stuck_at` ONLY when the
 * row is not already suspected_stuck. BYTE-IDENTITY: the procedural code
 * guarded the suspected-stamp with `if (row.stuck_state !== 'suspected_stuck')`
 * so the cancel-grace clock (clocked off suspected_stuck_at) is NOT reset on
 * every sweep. An unconditional stamp here would prevent the row from ever
 * reaching cancel_requested.
 */
function stampStuckIfNotAlready(
  db: Database.Database,
  executionId: string,
  stuckState: 'suspected_stuck',
  nowIso: string,
): void {
  db.prepare(
    `UPDATE worker_executions
        SET stuck_state=?, suspected_stuck_at=?
      WHERE execution_id=? AND state IN (${ACTIVE_STATE_SQL})
        AND (stuck_state IS NULL OR stuck_state!='suspected_stuck')`,
  ).run(stuckState, nowIso, executionId);
}

/**
 * Recover pre-ADR-009 (unfenced) assignments whose worker process died. These
 * rows have NO execution fence — they pre-date worker_executions — so they
 * cannot go through the stuck policy (which reasons about fenced executions).
 * A live PID is observed only; a dead/missing PID is returned to its queue.
 *
 * Sibling to {@link reconcileWorkerExecutions}, intentionally NOT part of the
 * tasks table directly (documented exception in the single-writer invariant).
 */
