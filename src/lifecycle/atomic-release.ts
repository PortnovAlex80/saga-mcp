/**
 * Atomic execution terminalization + task release.
 *
 * This module is one of the only legal direct writers of
 * tasks.{status,assigned_to,current_execution_id}. Every release path uses a
 * fence CAS and commits the execution terminal state together with ownership
 * release.
 */

import type { Database } from 'better-sqlite3';

const ACTIVE_STATE_SQL = "'reserved','running','cancel_requested'";
const ACTIVE_EXECUTION_STATES = new Set(['reserved', 'running', 'cancel_requested']);
const TERMINAL_EXECUTION_STATES = new Set(['exited', 'terminated', 'lost', 'spawn_failed']);
const NEEDS_HUMAN_TAG = 'needs-human';

export interface ReleaseInput {
  readonly executionId: string;
  readonly terminalState: 'exited' | 'terminated' | 'lost' | 'spawn_failed';
  readonly exitCode?: number | null;
  readonly reason: string;
  readonly lastError?: string | null;
  /**
   * Preserve the task's current status while clearing ownership and the fence.
   * When omitted this is derived from an accepted worker_done receipt.
   */
  readonly preserveTaskStatus?: boolean;
}

export interface ReleaseOutcome {
  readonly terminalized: boolean;
  readonly taskReleased: boolean;
  readonly restoredStatus: string | null;
  readonly blockedReason: string;
  readonly taskId: number | null;
  /**
   * The terminal state that actually took effect (or the standing terminal for
   * no-op calls). Receipt-backed reclassification from 'lost'/'terminated' to
   * 'exited' is visible here so callers report the converged outcome instead
   * of the classification they asked for.
   */
  readonly effectiveTerminal: string | null;
}

/** Terminalize an execution and release its task in one transaction. */
export function releaseExecutionAtomically(
  db: Database,
  input: ReleaseInput,
): ReleaseOutcome {
  const exec = db
    .prepare(
      `SELECT execution_id, task_id, state
         FROM worker_executions
        WHERE execution_id = ?`,
    )
    .get(input.executionId) as
    | { execution_id: string; task_id: number; state: string }
    | undefined;

  if (!exec) return noRelease('execution not found', null);

  // Central receipt-first terminal classification (2026-08-17 false-lost
  // defect). 'lost'/'terminated' assert the worker died WITHOUT completing the
  // execution protocol; an accepted worker_done/presentation_close receipt
  // proves semantic completion durable BEFORE the process died. Every release
  // writer (reaper policy, the FIX-1 dead/foreign-PID guard, remote
  // lease-expiry, the verified-kill path, the boot sweep) funnels through this
  // one function, so the invariant is enforced once, here: a receipt-backed
  // release converges on the SAME terminal the close callback writes —
  // 'exited' — and never burns the production cell's physical retry budget
  // (physicalRetryExhausted counts lost/spawn_failed/terminated only). The
  // receipt is re-verified inside THIS call, never trusted from the caller's
  // row snapshot, so a worker_done committed while a sweep was mid-probe is
  // still honored at write time.
  const terminalInput: ReleaseInput =
    (input.terminalState === 'lost' || input.terminalState === 'terminated')
      && hasAcceptedWorkerDoneReceipt(db, input.executionId)
      ? {
        ...input,
        terminalState: 'exited',
        reason: `${input.reason} [receipt-backed: reclassified from ${input.terminalState}]`,
        // A receipt-backed clean exit is not an error; the close-callback
        // 'exited' path stamps no last_error either.
        lastError: null,
      }
      : input;

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

  if (!task) {
    if (ACTIVE_EXECUTION_STATES.has(exec.state)) {
      db.transaction(() => writeExecutionTerminal(db, terminalInput))();
      return {
        terminalized: true,
        taskReleased: false,
        restoredStatus: null,
        blockedReason: 'task no longer exists',
        taskId: exec.task_id,
        effectiveTerminal: terminalInput.terminalState,
      };
    }
    return noRelease(`execution already in terminal state ${exec.state}`, exec.task_id);
  }

  /**
   * Reconciliation case: a physical adapter may have observed/recorded process
   * terminality before the atomic task-fence close ran. If durable worker_done
   * already proves semantic completion and this exact terminal execution still
   * owns the task fence, clear the stranded fence while preserving the current
   * Workplace-derived task status. This is intentionally narrow: abnormal
   * terminal executions without worker_done are NOT allowed to clear ownership
   * through this path.
   */
  if (!ACTIVE_EXECUTION_STATES.has(exec.state)) {
    // A late physical-close observation may arrive after another writer won the
    // release race (e.g. the close callback lands after the sweep already
    // terminalized the row). The standing terminal is authoritative, but the
    // exit code it carries must not be lost: backfill it idempotently.
    backfillExitObservation(db, input);
    if (
      TERMINAL_EXECUTION_STATES.has(exec.state)
      && task.current_execution_id === input.executionId
      && hasAcceptedWorkerDoneReceipt(db, input.executionId)
    ) {
      let taskReleased = false;
      db.transaction(() => {
        taskReleased = clearTaskFence(
          db,
          task.id,
          input.executionId,
          task.status,
          input.reason,
          true,
        );
      })();
      return {
        terminalized: false,
        taskReleased,
        restoredStatus: taskReleased ? task.status : null,
        blockedReason: taskReleased ? '' : 'fence CAS failed while reconciling terminal execution',
        taskId: task.id,
        effectiveTerminal: exec.state,
      };
    }
    return noRelease(`execution already in terminal state ${exec.state}`, exec.task_id);
  }

  if (task.current_execution_id !== input.executionId) {
    db.transaction(() => writeExecutionTerminal(db, terminalInput))();
    return {
      terminalized: true,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: `task fenced by different execution ${task.current_execution_id}`,
      taskId: task.id,
      effectiveTerminal: terminalInput.terminalState,
    };
  }

  if (hasNeedsHumanTag(task.tags)) {
    db.transaction(() => writeExecutionTerminal(db, terminalInput))();
    return {
      terminalized: true,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: 'needs-human tag blocks release (Slice 3 makes ASK terminal)',
      taskId: task.id,
      effectiveTerminal: terminalInput.terminalState,
    };
  }

  // The receipt re-verification above already ran for this call; reuse the
  // same authority for the projection decision.
  const preserveTaskStatus = terminalInput.preserveTaskStatus
    ?? hasAcceptedWorkerDoneReceipt(db, input.executionId);
  const restoredStatus = preserveTaskStatus
    ? task.status
    : physicalRetryExhausted(db, task.id)
      ? 'blocked'
      : computeRestoredStatus(task.status, task.integration_state);

  let taskReleased = false;
  db.transaction(() => {
    writeExecutionTerminal(db, terminalInput);
    taskReleased = clearTaskFence(
      db,
      task.id,
      input.executionId,
      restoredStatus,
      terminalInput.reason,
      preserveTaskStatus,
    );
  })();

  return {
    terminalized: true,
    taskReleased,
    restoredStatus: taskReleased ? restoredStatus : null,
    blockedReason: taskReleased ? '' : 'fence CAS failed (task reassigned mid-release)',
    taskId: task.id,
    effectiveTerminal: terminalInput.terminalState,
  };
}

function clearTaskFence(
  db: Database,
  taskId: number,
  executionId: string,
  restoredStatus: string,
  reason: string,
  preservedProjection: boolean,
): boolean {
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
    .run(restoredStatus, taskId, executionId);

  if (releaseInfo.changes !== 1) return false;
  appendReleaseEvent(
    db,
    taskId,
    executionId,
    restoredStatus,
    reason,
    preservedProjection,
  );
  return true;
}

function physicalRetryExhausted(db: Database, taskId: number): boolean {
  const row = db.prepare(
    `SELECT COALESCE(intent.retry_budget,0) AS retryBudget,
            json_extract(task.metadata,'$.production_cell_id') AS productionCellId,
            (SELECT COUNT(*) FROM worker_executions execution
              WHERE execution.task_id=task.id
                AND execution.state IN ('lost','spawn_failed','terminated')) AS failedAttempts
       FROM tasks task
       LEFT JOIN factory_work_intents intent
         ON intent.id=json_extract(task.metadata,'$.work_intent_id')
      WHERE task.id=?`,
  ).get(taskId) as {
    retryBudget: number;
    failedAttempts: number;
    productionCellId: string | null;
  } | undefined;
  if (!row || !row.productionCellId) return false;
  return row.failedAttempts + 1 > row.retryBudget;
}

function noRelease(blockedReason: string, taskId: number | null): ReleaseOutcome {
  return {
    terminalized: false,
    taskReleased: false,
    restoredStatus: null,
    blockedReason,
    taskId,
    effectiveTerminal: null,
  };
}

/**
 * Backfill a late physical exit observation onto an already-terminal row.
 * The winning writer's terminal stands; only the exit code (and finished_at,
 * if somehow still NULL) is completed. Idempotent: a non-NULL exit_code is
 * never overwritten.
 */
function backfillExitObservation(db: Database, input: ReleaseInput): void {
  if (input.exitCode === undefined || input.exitCode === null) return;
  db.prepare(
    `UPDATE worker_executions
        SET exit_code = ?,
            finished_at = COALESCE(finished_at, datetime('now'))
      WHERE execution_id = ? AND exit_code IS NULL`,
  ).run(input.exitCode, input.executionId);
}

function hasNeedsHumanTag(raw: string | null): boolean {
  try {
    const parsed = JSON.parse(raw ?? '[]');
    return Array.isArray(parsed) && parsed.map(String).includes(NEEDS_HUMAN_TAG);
  } catch {
    return false;
  }
}

/** An accepted worker_done receipt is semantic completion authority. */
function hasAcceptedWorkerDoneReceipt(db: Database, executionId: string): boolean {
  try {
    return Boolean(db.prepare(
      `SELECT 1
         FROM command_receipts
        WHERE execution_id=?
          AND command_kind IN ('worker_done','presentation_close')
          AND accepted=1
        LIMIT 1`,
    ).get(executionId));
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return false;
    throw error;
  }
}

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
  if (input.lastError !== undefined && input.lastError !== null) {
    db.prepare(
      `UPDATE worker_executions
          SET state = ?, finished_at = datetime('now'), exit_code = ?, last_error = ?
        WHERE execution_id = ? AND state IN (${ACTIVE_STATE_SQL})`,
    ).run(
      input.terminalState,
      input.exitCode ?? null,
      input.lastError,
      input.executionId,
    );
    return;
  }

  db.prepare(
    `UPDATE worker_executions
        SET state = ?, finished_at = datetime('now'), exit_code = ?
      WHERE execution_id = ? AND state IN (${ACTIVE_STATE_SQL})`,
  ).run(input.terminalState, input.exitCode ?? null, input.executionId);
}

function appendReleaseEvent(
  db: Database,
  taskId: number,
  executionId: string,
  restoredStatus: string,
  reason: string,
  preservedProjection: boolean,
): void {
  try {
    // Deterministic idempotency key: one release event per
    // (execution, outcome) pair. A wall-clock suffix made the key unique per
    // call, so a retry of the SAME release (reconciliation after a restart, a
    // repeated sweep) inserted a duplicate audit receipt + lifecycle event.
    const releaseHash = hashRelease(executionId, restoredStatus, preservedProjection);
    const commandId = `release:${executionId}:${releaseHash}`;
    const result = {
      acknowledged: true,
      restoredStatus,
      preservedProjection,
    };
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
      releaseHash,
      JSON.stringify(result),
      JSON.stringify(result),
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
        preservedProjection,
      }),
    );
  } catch {
    // Observability must not roll back the authoritative fence transition.
  }
}

function hashRelease(
  executionId: string,
  restoredStatus: string,
  preservedProjection: boolean,
): string {
  let h = 0;
  const value = `${executionId}|${restoredStatus}|${preservedProjection ? 'preserve' : 'recover'}`;
  for (let i = 0; i < value.length; i += 1) {
    h = (h * 31 + value.charCodeAt(i)) | 0;
  }
  return `rel-${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export { ACTIVE_EXECUTION_STATES, TERMINAL_EXECUTION_STATES };
