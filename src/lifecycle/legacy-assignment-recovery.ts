import type Database from 'better-sqlite3';
import { logActivity } from '../helpers/activity-logger.js';
import { releaseExecutionAtomically } from './atomic-release.js';

export interface LegacyAssignmentRecoveryCommand {
  taskId: number;
  workerId: string;
  originalStatus: string;
  executionId?: string | null;
  reason?: string;
}

/**
 * Single lifecycle writer for worker-process recovery.
 *
 * Fenced assignments delegate to atomic release. Pre-ADR-009 assignments use
 * the preserved conditional UPDATE, but the mutation remains inside the
 * lifecycle boundary rather than the worker-process adapter.
 */
export function recoverLegacyAssignment(
  db: Database.Database,
  command: LegacyAssignmentRecoveryCommand,
): boolean {
  const task = db.prepare(
    `SELECT id, title, status, assigned_to, tags, current_execution_id
       FROM tasks WHERE id=?`,
  ).get(command.taskId) as {
    id: number;
    title: string;
    status: string;
    assigned_to: string;
    tags: string;
    current_execution_id: string | null;
  } | undefined;

  if (!task || task.assigned_to !== command.workerId) return false;
  let tags: string[] = [];
  try { tags = JSON.parse(task.tags || '[]') as string[]; } catch { tags = []; }
  if (tags.includes('needs-human')) return false;

  if (command.executionId && task.current_execution_id === command.executionId) {
    const outcome = releaseExecutionAtomically(db, {
      executionId: command.executionId,
      terminalState: 'lost',
      reason: `engine recovery: ${command.reason ?? 'process exited before terminal worker_done'}`,
    });
    if (outcome.taskReleased) {
      logActivity(
        db,
        'task',
        command.taskId,
        'status_changed',
        'status',
        task.status,
        outcome.restoredStatus,
        `Engine recovered task '${task.title}' (atomic): ${command.reason ?? ''}`,
      );
    }
    return outcome.taskReleased;
  }

  const restoredStatus =
    command.originalStatus === 'review' && task.status !== 'in_progress'
      ? 'review'
      : 'todo';
  const info = db.prepare(
    `UPDATE tasks
        SET status=?, assigned_to=NULL, current_execution_id=NULL,
            updated_at=datetime('now')
      WHERE id=? AND assigned_to=?
        AND (current_execution_id IS NULL OR current_execution_id=?)`,
  ).run(
    restoredStatus,
    command.taskId,
    command.workerId,
    command.executionId ?? null,
  );
  return info.changes === 1;
}
