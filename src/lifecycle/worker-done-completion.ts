import Database from 'better-sqlite3';
import { releaseExecutionAtomically } from './atomic-release.js';

export type WorkerDoneCompletionStatus = 'review' | 'done' | 'todo' | 'blocked';

export interface AcceptedWorkerDoneCompletion {
  readonly commandId: string;
  readonly taskId: number;
  readonly completedNewStatus: WorkerDoneCompletionStatus;
  readonly acceptedAt: string | null;
}

function openRuntimeDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * Read the durable worker_done receipt for one exact execution.
 *
 * This receipt is the authority that the worker protocol completed. Task status
 * is not suitable for that decision because the Workplace may immediately
 * reverse-project a successfully produced candidate back to
 * in_progress/verifying while the kernel gate runs.
 */
export function readAcceptedWorkerDoneCompletion(
  dbPath: string,
  executionId: string,
): AcceptedWorkerDoneCompletion | null {
  const db = openRuntimeDb(dbPath);
  try {
    const row = db.prepare(
      `SELECT command_id, task_id, reply_json, accepted_at
         FROM command_receipts
        WHERE execution_id=?
          AND command_kind='worker_done'
          AND accepted=1
        ORDER BY accepted_at DESC, rowid DESC
        LIMIT 1`,
    ).get(executionId) as
      | {
          command_id: string;
          task_id: number | null;
          reply_json: string;
          accepted_at: string | null;
        }
      | undefined;
    if (!row || row.task_id === null) return null;

    let reply: unknown;
    try {
      reply = JSON.parse(row.reply_json);
    } catch {
      return null;
    }
    if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
    const completedNewStatus = (reply as Record<string, unknown>).completed_new_status;
    if (
      completedNewStatus !== 'review'
      && completedNewStatus !== 'done'
      && completedNewStatus !== 'todo'
      && completedNewStatus !== 'blocked'
    ) {
      return null;
    }

    return {
      commandId: row.command_id,
      taskId: row.task_id,
      completedNewStatus,
      acceptedAt: row.accepted_at,
    };
  } finally {
    db.close();
  }
}

/**
 * Finalize an OS process that already has an accepted worker_done receipt.
 *
 * The execution row and task fence are closed atomically, but the card status
 * is preserved. This is completion, not recovery: mapping in_progress -> todo
 * here would reopen a candidate that is merely waiting in Workplace.verifying.
 */
export function markAcceptedWorkerDoneProcessExited(
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
      reason: `process exited after accepted worker_done (state=${state}, exitCode=${exitCode ?? 'null'})`,
      preserveTaskStatus: true,
    });
  } finally {
    db.close();
  }
}
