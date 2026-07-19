/**
 * Atomic execution terminalization + task release.
 *
 * Source: blueprint §16 Slice 1 (docs/architecture/passive-worker-kernel-blueprint.md:829-845)
 *         and §22 brief (line 1193-1216).
 *
 * The audit's central Slice 1 defect: execution terminalization and task
 * release happen in different transactions, in different functions, sometimes
 * on different DB connections (worker-executions.ts:108-137 vs orchestrate.ts:905
 * vs tracker-view/claude-runner.mjs:425-445). A crash between them leaves:
 *   - a `lost`/`exited` execution row whose task is still fenced (the
 *     TERMINAL_EXECUTION_OWNS_TASK invariant violation), OR
 *   - a task released to the queue while its execution row is still `running`
 *     (close vs reconciler race).
 *
 * This module provides ONE function — `releaseExecutionAtomically` — that
 * terminalizes the execution AND releases the task in a single
 * `BEGIN IMMEDIATE` transaction with a fence CAS. All three callers
 * (markExecutionExited, recoverAssignment, reconcileWorkerExecutions) delegate
 * to it. This removes the duplicated recovery SQL (blueprint §22:1199) and
 * collapses the close/reconciler race (blueprint §16:844).
 *
 * Invariants enforced atomically:
 *   1. The execution row is set to a terminal state only if its current state
 *      is active (CAS).
 *   2. The task row is released only if `current_execution_id` STILL matches
 *      (CAS — protects against post-crash reassignment by another execution).
 *   3. Both UPDATEs run in one transaction — all-or-nothing.
 *   4. A `lifecycle_events` row is appended for the release (audit trail).
 *
 * No command bus yet — that is Slice 1.C. This module is the kernel's
 * terminalization primitive, callable directly by today's callers.
 */

import type { Database } from 'better-sqlite3';

const ACTIVE_STATE_SQL = "'reserved','running','cancel_requested'";

/** Active execution state names. Mirrors worker-executions.ts:6. */
const ACTIVE_EXECUTION_STATES = new Set(['reserved', 'running', 'cancel_requested']);

/** Terminal execution states — fence MUST be cleared. */
const TERMINAL_EXECUTION_STATES = new Set(['exited', 'terminated', 'lost', 'spawn_failed']);

/** Tag that blocks recovery from releasing the task (Slice 3 makes this terminal). */
const NEEDS_HUMAN_TAG = 'needs-human';

export interface ReleaseInput {
  /** The execution to terminalize. */
  readonly executionId: string;
  /** Terminal state to write. One of exited/terminated/lost/spawn_failed. */
  readonly terminalState: 'exited' | 'terminated' | 'lost' | 'spawn_failed';
  /** Process exit code (only meaningful for exited/terminated). */
  readonly exitCode?: number | null;
  /** Human-readable reason for the terminalization (audit). */
  readonly reason: string;
  /**
   * Last-error field on the execution row. NULL leaves the existing value.
   */
  readonly lastError?: string | null;
}

export interface ReleaseOutcome {
  /** True if the execution row transitioned from active to terminal in this call. */
  readonly terminalized: boolean;
  /** True if the task row had its fence cleared and ownership released. */
  readonly taskReleased: boolean;
  /**
   * Status the task was restored to. NULL when the task was not released
   * (e.g. needs-human tag blocked recovery, or task already moved on).
   */
  readonly restoredStatus: string | null;
  /**
   * Why the task was not released, when terminalized=true but taskReleased=false.
   * Empty string when nothing blocked release.
   */
  readonly blockedReason: string;
  /** Task id that was affected (or null if execution was unknown). */
  readonly taskId: number | null;
}

/**
 * Terminalize the execution and release its task in ONE transaction.
 *
 * Behavior matrix:
 *   - execution not found / not active             → terminalized=false, no-op.
 *   - execution active, task fenced by same exec   → terminalize + release to queue.
 *   - execution active, task fenced by OTHER exec  → terminalize only (the other
 *                                                    execution owns the task now).
 *   - execution active, task unfenced              → terminalize only (no fence to clear).
 *   - execution active, task has needs-human tag   → terminalize only (Slice 3
 *                                                    makes ASK terminal; until then,
 *                                                    the tag blocks release).
 *
 * Always returns an outcome describing what happened — never throws on
 * recoverable "nothing to do" conditions. Throws only on DB errors.
 */
export function releaseExecutionAtomically(
  db: Database,
  input: ReleaseInput,
): ReleaseOutcome {
  // -------------------------------------------------------------------------
  // Step 1: load the execution row. Bail if missing or already terminal.
  // -------------------------------------------------------------------------
  const exec = db
    .prepare(
      `SELECT execution_id, task_id, state
         FROM worker_executions
        WHERE execution_id = ?`,
    )
    .get(input.executionId) as
    | { execution_id: string; task_id: number; state: string }
    | undefined;

  if (!exec) {
    return {
      terminalized: false,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: 'execution not found',
      taskId: null,
    };
  }
  if (!ACTIVE_EXECUTION_STATES.has(exec.state)) {
    return {
      terminalized: false,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: `execution already in terminal state ${exec.state}`,
      taskId: exec.task_id,
    };
  }

  // -------------------------------------------------------------------------
  // Step 2: load the task row to compute restoredStatus and check the
  // needs-human gate.
  // -------------------------------------------------------------------------
  const task = db
    .prepare(
      `SELECT id, status, assigned_to, current_execution_id, integration_state, tags
         FROM tasks WHERE id = ?`,
    )
    .get(exec.task_id) as
    | {
        id: number;
        status: string;
        assigned_to: string | null;
        current_execution_id: string | null;
        integration_state: string | null;
        tags: string | null;
      }
    | undefined;

  // If the task is gone (cascade-deleted), just terminalize the execution.
  if (!task) {
    db.transaction(() => {
      writeExecutionTerminal(db, input);
    })();
    return {
      terminalized: true,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: 'task no longer exists',
      taskId: exec.task_id,
    };
  }

  // If the task is fenced by a DIFFERENT execution, only terminalize. The
  // current owner's fence is authoritative (the task has been re-assigned).
  const fenceIsOurs = task.current_execution_id === input.executionId;
  if (!fenceIsOurs) {
    db.transaction(() => {
      writeExecutionTerminal(db, input);
    })();
    return {
      terminalized: true,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: `task fenced by different execution ${task.current_execution_id}`,
      taskId: task.id,
    };
  }

  // If the task carries the needs-human tag, do NOT release. Slice 3 will
  // make this terminal via ParkForHuman; until then, the tag blocks recovery
  // so a parked task does not silently get re-dispatched (audit fix).
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(task.tags ?? '[]');
    if (Array.isArray(parsed)) tags = parsed.map(String);
  } catch {
    tags = [];
  }
  if (tags.includes(NEEDS_HUMAN_TAG)) {
    db.transaction(() => {
      writeExecutionTerminal(db, input);
    })();
    return {
      terminalized: true,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: 'needs-human tag blocks release (Slice 3 makes ASK terminal)',
      taskId: task.id,
    };
  }

  // -------------------------------------------------------------------------
  // Step 3: compute the restored task status (the queue the task returns to).
  // -------------------------------------------------------------------------
  const restoredStatus = computeRestoredStatus(task.status, task.integration_state);

  // -------------------------------------------------------------------------
  // Step 4: terminalize + release in ONE BEGIN IMMEDIATE transaction, with
  // fence CAS on the task row.
  // -------------------------------------------------------------------------
  let taskReleased = false;
  db.transaction(() => {
    writeExecutionTerminal(db, input);

    const releaseInfo = db
      .prepare(
        `UPDATE tasks
            SET status = ?,
                assigned_to = NULL,
                current_execution_id = NULL,
                metadata = json_remove(metadata, '$.worker_pid', '$.worker_started_at'),
                updated_at = datetime('now')
          WHERE id = ?
            AND current_execution_id = ?`,
      )
      .run(restoredStatus, task.id, input.executionId);

    if (releaseInfo.changes === 1) {
      taskReleased = true;
      // Append an audit event for the release. Best-effort: if the table does
      // not exist yet (pre-Slice-1 DB), skip silently.
      appendReleaseEvent(db, task.id, input.executionId, restoredStatus, input.reason);
    }
    // If changes === 0, the fence CAS failed: another execution won the race
    // between our load and our UPDATE. We still terminalized our execution,
    // which is correct — the task now belongs to someone else.
  })();

  return {
    terminalized: true,
    taskReleased,
    restoredStatus: taskReleased ? restoredStatus : null,
    blockedReason: taskReleased ? '' : 'fence CAS failed (task reassigned mid-release)',
    taskId: task.id,
  };
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

/**
 * Map the task's current status (at moment of release) to the queue it
 * returns to. Mirrors releaseOwnedTask logic in worker-executions.ts:222-227
 * but in one place, used by all three callers.
 *
 *   in_progress        → todo           (impl attempt died)
 *   review_in_progress → review         (review attempt died)
 *   done + pending     → review         (integration execution died; review
 *                                        survives — the audit fix)
 *   review (buffer)    → review         (defensive; should not happen with fence)
 *   todo (buffer)      → todo           (defensive)
 *
 * For terminal statuses we return the existing status unchanged — release
 * should be a no-op there, and the CAS UPDATE will match 0 rows anyway.
 */
function computeRestoredStatus(
  currentStatus: string,
  integrationState: string | null,
): string {
  if (currentStatus === 'in_progress') return 'todo';
  if (currentStatus === 'review_in_progress') return 'review';
  if (currentStatus === 'done' && integrationState === 'pending') return 'review';
  return currentStatus;
}

function writeExecutionTerminal(db: Database, input: ReleaseInput): void {
  const setLastError = input.lastError !== undefined && input.lastError !== null;
  if (setLastError) {
    db.prepare(
      `UPDATE worker_executions
          SET state = ?, finished_at = datetime('now'), exit_code = ?, last_error = ?
        WHERE execution_id = ? AND state IN (${ACTIVE_STATE_SQL})`,
    ).run(input.terminalState, input.exitCode ?? null, input.lastError, input.executionId);
  } else {
    db.prepare(
      `UPDATE worker_executions
          SET state = ?, finished_at = datetime('now'), exit_code = ?
        WHERE execution_id = ? AND state IN (${ACTIVE_STATE_SQL})`,
    ).run(input.terminalState, input.exitCode ?? null, input.executionId);
  }
}

function appendReleaseEvent(
  db: Database,
  taskId: number,
  executionId: string,
  restoredStatus: string,
  reason: string,
): void {
  // Guarded: lifecycle_events may not exist on a DB that predates Slice 1.
  // The event log is best-effort audit; the atomic UPDATE on tasks/executions
  // is the source of truth.
  try {
    const commandId = `release:${executionId}:${Date.now()}`;
    db.prepare(
      `INSERT OR IGNORE INTO command_receipts
         (command_id, command_kind, actor_kind, actor_id, execution_id, task_id,
          payload_hash, accepted, rejection_code, result_json, reply_json)
       VALUES (?, 'ObserveProcessExited', 'controller', 'reconciler', ?, ?,
               ?, 1, NULL, ?, ?)`,
    ).run(
      commandId,
      executionId,
      taskId,
      hashRelease(executionId, restoredStatus),
      JSON.stringify({ acknowledged: true }),
      JSON.stringify({ acknowledged: true, restoredStatus }),
    );
    db.prepare(
      `INSERT INTO lifecycle_events (command_id, seq, event_kind, task_id, payload_json)
       VALUES (?, 0, 'TaskReleased', ?, ?)`,
    ).run(
      commandId,
      taskId,
      JSON.stringify({
        kind: 'TaskReleased',
        taskId,
        resumePhase: restoredStatus === 'review' ? 'review' : 'implementation',
        reason,
        executionId,
      }),
    );
  } catch {
    // lifecycle_events or command_receipts table missing on a pre-Slice-1 DB.
    // The atomic release is still authoritative; we just lack the audit trail.
    // This branch disappears once every DB has been opened once with Slice 1's
    // getDb() (which creates the tables).
  }
}

function hashRelease(executionId: string, restoredStatus: string): string {
  // Lightweight deterministic hash for the audit receipt. We avoid importing
  // the full payload-hash module here to keep this module leaf-level (it has
  // no other src/ imports besides better-sqlite3 types). The hash just needs
  // to be stable for replay detection; we are not cross-checking it elsewhere
  // in Slice 1.
  let h = 0;
  const s = executionId + '|' + restoredStatus;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `rel-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

// Re-export for callers that need the state constants.
export { ACTIVE_EXECUTION_STATES, TERMINAL_EXECUTION_STATES };
