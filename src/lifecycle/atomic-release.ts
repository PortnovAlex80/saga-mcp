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

/** Active execution state names. Mirrors worker-executions.ts. */
const ACTIVE_EXECUTION_STATES = new Set(['reserved', 'running', 'cancel_requested']);

/** Terminal execution states — fence MUST be cleared. */
const TERMINAL_EXECUTION_STATES = new Set(['exited', 'terminated', 'lost', 'spawn_failed']);

/** Tag that blocks recovery from releasing the task. */
const NEEDS_HUMAN_TAG = 'needs-human';

export interface ReleaseInput {
  /** The execution to terminalize. */
  readonly executionId: string;
  /** Terminal state to write. */
  readonly terminalState: 'exited' | 'terminated' | 'lost' | 'spawn_failed';
  /** Process exit code, when available. */
  readonly exitCode?: number | null;
  /** Human-readable reason for audit. */
  readonly reason: string;
  /** Optional last error to persist on the execution. */
  readonly lastError?: string | null;
  /**
   * Preserve the task's current status while clearing ownership and the fence.
   *
   * This is required after an accepted worker_done receipt. At that point the
   * worker completed its protocol, while the authoritative Workplace may have
   * already reverse-projected the card to in_progress/verifying. Treating the
   * later OS close as crash recovery would incorrectly map in_progress -> todo.
   *
   * Crash/reaper callers leave this false and retain the historical recovery
   * mapping.
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

/**
 * Terminalize an execution and release its task in one transaction.
 */
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

  if (!exec) {
    return noRelease('execution not found', null);
  }
  if (!ACTIVE_EXECUTION_STATES.has(exec.state)) {
    return noRelease(`execution already in terminal state ${exec.state}`, exec.task_id);
  }

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
    db.transaction(() => writeExecutionTerminal(db, input))();
    return {
      terminalized: true,
      taskReleased: false,
      restoredStatus: null,
      blockedReason: 'task no longer exists',
      taskId: exec.task_id,
    };
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

  const restoredStatus = input.preserveTaskStatus
    ? task.status
    : computeRestoredStatus(task.status, task.integration_state);

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
      appendReleaseEvent(
        db,
        task.id,
        input.executionId,
        restoredStatus,
        input.reason,
        input.preserveTaskStatus === true,
      );
    }
  })();

  return {
    terminalized: true,
    taskReleased,
    restoredStatus: taskReleased ? restoredStatus : null,
    blockedReason: taskReleased ? '' : 'fence CAS failed (task reassigned mid-release)',
    taskId: task.id,
  };
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

/** Recovery mapping used only when no accepted worker_done receipt exists. */
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
    // Legacy databases may not yet have lifecycle event tables. The execution
    // and fence transition remains authoritative.
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
