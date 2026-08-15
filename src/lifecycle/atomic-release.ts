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
      db.transaction(() => writeExecutionTerminal(db, input))();
      return {
        terminalized: true,
        taskReleased: false,
        restoredStatus: null,
        blockedReason: 'task no longer exists',
        taskId: exec.task_id,
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
    if (
      TERMINAL_EXECUTION_STATES.has(exec.state)
      && task.current_execution_id === input.executionId
      && hasAcceptedWorkerDoneReceipt(db, input.executionId)
    ) {
      let taskReleased = false;
      let preserved: string | null = null;
      db.transaction(() => {
        // GB-3: read the preserved status under the same write lock as the
        // fence clear. presentation_close (ADR-072) may complete the task
        // between the outer snapshot and this transaction; clearing with the
        // stale snapshot would resurrect a completed task.
        const fresh = db
          .prepare('SELECT status FROM tasks WHERE id=?')
          .get(task.id) as { status: string } | undefined;
        preserved = fresh?.status ?? task.status;
        taskReleased = clearTaskFence(
          db,
          task.id,
          input.executionId,
          preserved,
          input.reason,
          true,
        );
      })();
      return {
        terminalized: false,
        taskReleased,
        restoredStatus: taskReleased ? preserved : null,
        blockedReason: taskReleased ? '' : 'fence CAS failed while reconciling terminal execution',
        taskId: task.id,
      };
    }
    return noRelease(`execution already in terminal state ${exec.state}`, exec.task_id);
  }

  if (task.current_execution_id !== input.executionId) {
    db.transaction(() => writeExecutionTerminal(db, input))();
    return {
      terminalized: true,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: `task fenced by different execution ${task.current_execution_id}`,
      taskId: task.id,
    };
  }

  if (hasNeedsHumanTag(task.tags)) {
    db.transaction(() => writeExecutionTerminal(db, input))();
    return {
      terminalized: true,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: 'needs-human tag blocks release (Slice 3 makes ASK terminal)',
      taskId: task.id,
    };
  }

  const preserveTaskStatus = input.preserveTaskStatus
    ?? hasAcceptedWorkerDoneReceipt(db, input.executionId);

  let taskReleased = false;
  let releasedStatus: string | null = null;
  db.transaction(() => {
    writeExecutionTerminal(db, input);
    // GB-3: compute the restored status INSIDE the write lock. The outer
    // `task` snapshot can be stale when presentation_close (ADR-072) commits
    // a semantic completion between the outer read and this transaction —
    // clearing with the snapshot would overwrite durable 'done' with the
    // pre-close projection ('review_in_progress') and strand the Workplace.
    const fresh = db
      .prepare('SELECT status, integration_state FROM tasks WHERE id=?')
      .get(task.id) as { status: string; integration_state: string | null } | undefined;
    const effective = preserveTaskStatus
      ? (fresh?.status ?? task.status)
      : physicalRetryExhausted(db, task.id)
        ? 'blocked'
        : computeRestoredStatus(fresh?.status ?? task.status, fresh?.integration_state ?? task.integration_state);
    releasedStatus = effective;
    taskReleased = clearTaskFence(
      db,
      task.id,
      input.executionId,
      effective,
      input.reason,
      preserveTaskStatus,
    );
  })();

  return {
    terminalized: true,
    taskReleased,
    restoredStatus: taskReleased ? releasedStatus : null,
    blockedReason: taskReleased ? '' : 'fence CAS failed (task reassigned mid-release)',
    taskId: task.id,
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
  };
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
    const commandId = `release:${executionId}:${Date.now()}`;
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
      hashRelease(executionId, restoredStatus, preservedProjection),
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
