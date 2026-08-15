import type { Database } from 'better-sqlite3';

export type AcceptedWorkerDoneStatus = 'review' | 'done' | 'todo' | 'blocked';

export interface AcceptedWorkerDoneReceipt {
  readonly commandId: string;
  readonly taskId: number | null;
  readonly completedNewStatus: AcceptedWorkerDoneStatus;
}

/**
 * Read durable completion evidence for one exact managed execution.
 *
 * This is the physical worker-protocol authority. A task/Workplace projection
 * may already have advanced to verifying and therefore cannot be used to infer
 * whether this execution successfully called worker_done.
 */
export function readAcceptedWorkerDoneReceipt(
  db: Database,
  executionId: string | null | undefined,
): AcceptedWorkerDoneReceipt | null {
  if (!executionId) return null;

  let row:
    | { command_id: string; task_id: number | null; reply_json: string }
    | undefined;
  try {
    row = db.prepare(
      `SELECT command_id, task_id, reply_json
         FROM command_receipts
        WHERE execution_id=?
          AND command_kind IN ('worker_done','presentation_close')
          AND accepted=1
        ORDER BY accepted_at DESC, rowid DESC
        LIMIT 1`,
    ).get(executionId) as
      | { command_id: string; task_id: number | null; reply_json: string }
      | undefined;
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) {
      return null;
    }
    throw error;
  }
  if (!row) return null;

  try {
    const reply = JSON.parse(row.reply_json) as {
      completed_new_status?: unknown;
    };
    const status = reply.completed_new_status;
    if (!isAcceptedWorkerDoneStatus(status)) return null;
    return {
      commandId: row.command_id,
      taskId: row.task_id,
      completedNewStatus: status,
    };
  } catch {
    return null;
  }
}

function isAcceptedWorkerDoneStatus(
  value: unknown,
): value is AcceptedWorkerDoneStatus {
  return value === 'review'
    || value === 'done'
    || value === 'todo'
    || value === 'blocked';
}
