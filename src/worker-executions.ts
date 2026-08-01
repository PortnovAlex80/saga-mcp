import Database from 'better-sqlite3';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { releaseExecutionAtomically } from './lifecycle/atomic-release.js';

export const ACTIVE_EXECUTION_STATES = ['reserved', 'running', 'cancel_requested'] as const;
const ACTIVE_STATE_SQL = "'reserved','running','cancel_requested'";
const RESERVED_BOOT_TIMEOUT_MS = 60_000;
const FINISH_GRACE_MS = 30_000;
// CONVEYOR Wave 5 stuck policy (CONVEYOR-MENTAL-MODEL §"Safe automatic recovery"):
// an alive-but-silent worker is NOT released solely because progress_at is old.
// The policy advances through states with explicit grace periods, all clocked off
// PROGRESS aging (BUG 2: liveness renewal does NOT reset these clocks):
//   active → (progress silent > STUCK_SILENCE_MS) → suspected_stuck  [stamp suspected_stuck_at]
//   suspected_stuck → (suspected_stuck_at age > STUCK_CANCEL_GRACE_MS) → cancel_requested [stamp cancel_requested_at]
//   cancel_requested → (cancel_requested_at age > CANCEL_GRACE_MS) → terminate (only if PID birth verified)
// This prevents confusing legitimate long model inference with death.
const STUCK_SILENCE_MS = 10 * 60 * 1000;   // 10 min with no progress → suspect
const STUCK_CANCEL_GRACE_MS = 5 * 60 * 1000; // 5 min after suspect → request cancel
const CANCEL_GRACE_MS = 60_000;             // 1 min after cancel → terminate

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

export function markExecutionExited(
  dbPath: string,
  executionId: string,
  exitCode: number | null,
  state: 'exited' | 'terminated' = 'exited',
): void {
  const db = openRuntimeDb(dbPath);
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE worker_executions
         SET state=?, finished_at=datetime('now'), exit_code=?
         WHERE execution_id=? AND state IN (${ACTIVE_STATE_SQL})`,
      ).run(state, exitCode, executionId);
      db.prepare(
        `UPDATE tasks
         SET current_execution_id=NULL,
             metadata=CASE
               WHEN json_extract(metadata,'$.worker_pid') = (
                 SELECT pid FROM worker_executions WHERE execution_id=?
               ) THEN json_remove(metadata,'$.worker_pid','$.worker_started_at')
               ELSE metadata END,
             updated_at=datetime('now')
         WHERE current_execution_id=?`,
      ).run(executionId, executionId);
    })();
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
      const result = spawnSync(
        'powershell',
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
  nowMs = Date.now(),
  options?: ReconcileOptions,
): ReconcileResult[] {
  // BUG 1 + §"Worker is remote": the decision to recover a dead/disappeared
  // foreman comes from the DURABLE LEASE (lease_expires_at), NEVER from a local
  // PID guess. A remote/unverifiable PID must still be released once its lease
  // has expired. We therefore evaluate lease expiry BEFORE the local-vs-remote
  // branch and let lease expiry drive release independent of the local-PID
  // verdict. A remote execution whose lease is still fresh is left alone — its
  // own host's supervisor renews it, or it expires if that host died.
  const probe = options?.processProbe ?? REAL_PROCESS_PROBE;
  const hostname = options?.hostname ?? os.hostname();
  const nowIso = new Date(nowMs).toISOString();
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
    const isLocal = row.machine_id === hostname;
    const leaseExpired = row.lease_expires_at != null
      && nowMs >= parseDbTime(row.lease_expires_at);

    // ----- BUG 1: remote execution released on LEASE expiry, not PID guess. ---
    // "Worker is remote → decide from durable lease heartbeat; never kill or
    //  release from PID guess" + "Foreman died → execution lease is expired and
    //  no trusted supervisor owns it → reaper performs fenced recovery."
    // We CANNOT verify a remote PID (it belongs to another host), so we never
    // kill it and never read its liveness. We DO release it the moment its
    // durable lease has expired — that is the durable signal that the remote
    // foreman/host is gone and no trusted supervisor owns it anymore. A remote
    // execution with a live lease is left untouched (kept/remote_unknown).
    if (!isLocal) {
      if (leaseExpired) {
        const reasonText = 'remote lease expired and no trusted supervisor owns it (foreman/host gone)';
        const outcome = releaseExecutionAtomically(db, {
          executionId: row.execution_id,
          terminalState: 'lost',
          reason: reasonText,
          lastError: reasonText,
        });
        results.push({
          executionId: row.execution_id, taskId: row.task_id, action: 'lost',
          released: outcome.taskReleased,
          reason: reasonText,
        });
        continue;
      }
      results.push({
        executionId: row.execution_id, taskId: row.task_id, action: 'remote_unknown',
        released: false, reason: 'remote execution; lease still alive, decision deferred to durable lease',
      });
      continue;
    }

    // ----- LOCAL execution: combine PID liveness + lease authority. ----------
    // Reserved rows have no PID yet — they may legitimately still be spawning.
    // A reserved row is released ONLY by RESERVED_BOOT_TIMEOUT_MS expiry, never
    // by !alive (probe.isAlive on a null PID is meaningless). The previous code
    // forced alive=false for reserved rows, which made !alive always true and
    // released the card on the FIRST sweep (≈30s) — well before the 60s boot
    // timeout. This defected: a card could be returned to the queue while the
    // supervisor was still mid-spawn. Fix: gate !alive on non-reserved states.
    const alive = row.state === 'reserved' ? false : probe.isAlive(row.pid);
    const reservedExpired = row.state === 'reserved'
      && nowMs - parseDbTime(row.reserved_at) >= RESERVED_BOOT_TIMEOUT_MS;
    // Dead local process, OR lease expired (foreman gone even though the OS
    // process might still be spinning — authority is gone either way). Both
    // release via the same atomic fenced primitive; a stale execution can never
    // clear a newer fence (releaseExecutionAtomically CAS-checks fence).
    // NOTE: !alive is only consulted for non-reserved rows. A reserved row has
    // no PID yet, so its release depends solely on reservedExpired / leaseExpired.
    if ((row.state !== 'reserved' && !alive) || reservedExpired || leaseExpired) {
      const terminal = row.state === 'reserved' ? 'spawn_failed' : 'lost';
      const reasonText = reservedExpired
        ? 'spawn reservation timed out'
        : row.state === 'reserved'
          ? 'lease expired (foreman/supervisor gone) during spawn reservation'
          : !alive
            ? 'OS process is not alive'
            : 'lease expired (foreman/supervisor gone) while local process could not be confirmed alive';
      const outcome = releaseExecutionAtomically(db, {
        executionId: row.execution_id,
        terminalState: terminal,
        reason: reasonText,
        lastError: reasonText,
      });
      results.push({
        executionId: row.execution_id, taskId: row.task_id, action: 'lost',
        released: outcome.taskReleased,
        reason: reasonText,
      });
      continue;
    }

    // ----- BUG 2: stuck clock based on progress_at, NOT heartbeat_at. --------
    // Liveness heartbeat ("supervisor still owns this execution") and progress
    // heartbeat ("worker produced observable activity") are DIFFERENT signals
    // (§363-370). renewLeases advances heartbeat_at on every sweep; that MUST
    // NOT reset the progress-silence clock. So every stuck grace below is
    // measured against progress_at / suspected_stuck_at / cancel_requested_at,
    // never against heartbeat_at.
    if (alive && row.stuck_state !== 'cancel_requested') {
      // Stage 1 — progress silence → suspected_stuck. Stamp suspected_stuck_at
      // the moment we first enter the state (drives the cancel-grace window).
      const progressSilent = row.progress_at != null
        && nowMs - parseDbTime(row.progress_at) >= STUCK_SILENCE_MS;
      if (progressSilent) {
        if (row.stuck_state !== 'suspected_stuck') {
          // Stamp with the provided nowMs (NOT SQLite datetime('now')) so the
          // cancel-grace clock is consistent with the sweep's nowMs and is
          // deterministic under a test-injected clock.
          db.prepare(
            `UPDATE worker_executions
                SET stuck_state='suspected_stuck', suspected_stuck_at=?
              WHERE execution_id=? AND state IN (${ACTIVE_STATE_SQL})`,
          ).run(nowIso, row.execution_id);
          row.stuck_state = 'suspected_stuck';
          row.suspected_stuck_at = nowIso;
        }
        // Stage 2 — suspected_stuck past the cancel grace → cancel_requested.
        // Clock = suspected_stuck_at age. Stamp cancel_requested_at on entry.
        const since = parseDbTime(row.suspected_stuck_at) || parseDbTime(row.progress_at) || 0;
        if (nowMs - since >= STUCK_CANCEL_GRACE_MS) {
          db.prepare(
            `UPDATE worker_executions
                SET stuck_state='cancel_requested', cancel_requested_at=?
              WHERE execution_id=? AND state IN (${ACTIVE_STATE_SQL})`,
          ).run(nowIso, row.execution_id);
          row.stuck_state = 'cancel_requested';
          row.cancel_requested_at = nowIso;
          results.push({
            executionId: row.execution_id, taskId: row.task_id, action: 'kept',
            released: false, reason: 'progress silent past grace — cancellation requested',
          });
          continue;
        }
      }
    }

    // ----- Stage 3: cancel_requested past cancel grace → verified kill. ------
    // BUG 3: the prior cancel_requested→terminated path verified the birth token
    // but then ONLY released the card — it never called the process terminator,
    // so the old Claude/worker OS process kept running and mutating the desk.
    // Termination must happen ONLY after PID birth-token verification (scenario
    // 16) but it MUST happen. We kill the verified process, then atomically
    // release the card. A reused PID with a different birth token is NEVER
    // killed and the execution is left for a human.
    if (alive && row.stuck_state === 'cancel_requested') {
      const since = parseDbTime(row.cancel_requested_at) || nowMs;
      if (nowMs - since >= CANCEL_GRACE_MS) {
        const pid = row.pid;
        const expectedToken = row.process_birth_token;
        const birthMatches = pid != null
          && expectedToken != null
          && probe.readBirthToken(pid) === expectedToken;
        if (!birthMatches) {
          results.push({
            executionId: row.execution_id, taskId: row.task_id, action: 'kept',
            released: false,
            reason: 'cancel grace expired but PID birth token changed — left for human (PID reuse suspected, scenario 16)',
          });
          continue;
        }
        // Verified PID identity — terminate the OS process, then release the card.
        const killed = pid != null && expectedToken != null
          && probe.killVerified(pid, expectedToken);
        if (!killed) {
          results.push({
            executionId: row.execution_id, taskId: row.task_id, action: 'kept',
            released: false, reason: 'verified process termination failed; observing',
          });
          continue;
        }
        const reasonText = 'stuck past cancel grace — terminated after verified PID identity';
        const outcome = releaseExecutionAtomically(db, {
          executionId: row.execution_id,
          terminalState: 'terminated',
          reason: reasonText,
          lastError: reasonText,
        });
        results.push({
          executionId: row.execution_id, taskId: row.task_id, action: 'terminated',
          released: outcome.taskReleased,
          reason: reasonText,
        });
        continue;
      }
    }

    const phaseAge = nowMs - parseDbTime(row.phase_updated_at);
    const ownsActiveTask = row.current_execution_id === row.execution_id
      && row.task_assigned_to === row.worker_id
      && (row.task_status === 'in_progress' || row.task_status === 'review_in_progress');
    const legitimateIntegration = row.current_execution_id === row.execution_id
      && row.phase === 'integrating'
      && row.task_status === 'done'
      && row.integration_state === 'pending';
    const legitimateFinishing = row.current_execution_id === row.execution_id
      && row.phase === 'finishing'
      && phaseAge < FINISH_GRACE_MS;

    if (alive && (ownsActiveTask || legitimateIntegration || legitimateFinishing)) {
      results.push({
        executionId: row.execution_id, taskId: row.task_id, action: 'kept',
        released: false, reason: 'execution still owns an allowed lifecycle phase',
      });
      continue;
    }

    if (alive) {
      const pid = row.pid;
      const expectedToken = row.process_birth_token;
      const killed = pid != null && expectedToken != null
        && probe.killVerified(pid, expectedToken);
      if (!killed) {
        results.push({
          executionId: row.execution_id, taskId: row.task_id, action: 'kept',
          released: false, reason: 'unsafe to terminate without matching process birth identity',
        });
        continue;
      }
      // Slice 1: atomic terminalization + task release.
      const outcome = releaseExecutionAtomically(db, {
        executionId: row.execution_id,
        terminalState: 'terminated',
        reason: 'execution no longer owns an allowed task phase',
        lastError: 'execution no longer owns an allowed task phase',
      });
      results.push({
        executionId: row.execution_id, taskId: row.task_id, action: 'terminated',
        released: outcome.taskReleased,
        reason: 'execution no longer owns an allowed task phase',
      });
    }
  }

  // Transitional recovery for assignments created before ADR-009. These rows
  // have no execution fence, so they may be observed and released when dead,
  // but never killed: PID identity alone is not sufficient for termination.
  const legacyParams = epicId === undefined ? [projectId] : [projectId, epicId];
  const legacyEpicClause = epicId === undefined ? '' : 'AND t.epic_id=?';
  const legacy = db.prepare(
    `SELECT t.id, t.status, t.assigned_to, t.metadata
       FROM tasks t
       JOIN epics e ON e.id=t.epic_id
      WHERE e.project_id=?
        ${legacyEpicClause}
        AND (
          t.status IN ('in_progress','review_in_progress')
          OR (t.status='review' AND t.assigned_to IS NOT NULL AND t.assigned_to!='')
        )
        AND t.current_execution_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM worker_executions we
           WHERE we.task_id=t.id AND we.state IN (${ACTIVE_STATE_SQL})
        )`,
  ).all(...legacyParams) as Array<{
    id: number;
    status: string;
    assigned_to: string | null;
    metadata: string;
  }>;
  for (const task of legacy) {
    let pid: number | null = null;
    try {
      const parsed = JSON.parse(task.metadata || '{}') as { worker_pid?: unknown };
      pid = typeof parsed.worker_pid === 'number' ? parsed.worker_pid : null;
    } catch {
      pid = null;
    }
    if (probe.isAlive(pid)) {
      results.push({
        executionId: `legacy-task-${task.id}`,
        taskId: task.id,
        action: 'kept',
        released: false,
        reason: 'legacy assignment has a live PID; observe only',
      });
      continue;
    }
    const restoredStatus = task.status === 'in_progress'
      ? 'todo'
      : 'review';
    const info = db.prepare(
      `UPDATE tasks
          SET status=?, assigned_to=NULL,
              metadata=json_remove(metadata,'$.worker_pid','$.worker_started_at'),
              updated_at=datetime('now')
        WHERE id=? AND assigned_to IS ? AND current_execution_id IS NULL`,
    ).run(restoredStatus, task.id, task.assigned_to);
    results.push({
      executionId: `legacy-task-${task.id}`,
      taskId: task.id,
      action: 'lost',
      released: info.changes === 1,
      reason: pid ? 'legacy OS process is not alive' : 'legacy assignment has no PID',
    });
  }
  return results;
}
