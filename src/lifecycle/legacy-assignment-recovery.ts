/**
 * ════════════════════════════════════════════════════════════════════════════
 * WRITER INVARIANT (Uncle Bob Wave 1B / FU-B).
 * ════════════════════════════════════════════════════════════════════════════
 * This module is ONE of the ONLY legal direct writers of the owner columns
 * `tasks.{status, assigned_to, current_execution_id}`. The single-writer set
 * for those columns is exactly:
 *
 *   - src/lifecycle/work-assignment-core.ts    (the claim path)
 *   - src/lifecycle/atomic-release.ts          (releaseExecutionAtomically)
 *   - src/lifecycle/legacy-assignment-recovery.ts   (this module)
 *
 *   PLUS the documented exception:
 *   - src/worker-executions.ts:202  (markExecutionExited — FU-D will
 *     consolidate this duplicate writer into releaseExecutionAtomically)
 *
 * This module owns the legacy (pre-ADR-009, unfenced) recovery path: a
 * worker process died holding an assignment that has NO execution fence.
 * The conditional UPDATE here (status/assigned_to/current_execution_id with
 * a CAS on the old owner) is the only safe way to release such a row — it
 * MUST run as direct SQL because no command bus (Slice 1.C) exists yet to
 * serialize this, and the fenced branch delegates to
 * `releaseExecutionAtomically` (atomic-release.ts) which itself runs inside
 * BEGIN IMMEDIATE.
 *
 * ALL OTHER `UPDATE tasks` writes in the codebase must touch NON-owner
 * columns only (metadata, tags, risk, integration_state, etc.).
 *
 * Enforcement: tests/architecture/tasks-writer-invariant.test.mjs is a
 * source-level lint gate that fails any NEW file issuing
 * `UPDATE tasks SET status=|assigned_to=|current_execution_id=` outside the
 * allowed set above.
 *
 * FORWARD PATH (when the command bus lands in Slice 1.C): legacy recovery
 * will route through the bus as a single RecoverLegacyAssignment command,
 * and this module's direct SQL collapses into the command's handler. Until
 * then, this module IS the single writer for the legacy-recovery transition.
 * ════════════════════════════════════════════════════════════════════════════
 */

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


export interface Saga3ProjectedTaskRecoveryCommand {
  taskId: number;
  currentStatus: string;
  assignedTo: string | null;
  currentExecutionId: string | null;
}

/**
 * Restore an interrupted Saga 3 projected task to a claimable queue state.
 * The caller owns the surrounding transaction; this module owns the lifecycle
 * mutation so orchestration persistence never writes task status directly.
 */
export function prepareSaga3ProjectedTaskForExecution(
  db: Database.Database,
  command: Saga3ProjectedTaskRecoveryCommand,
): string {
  const restoredStatus = command.currentStatus === 'review_in_progress'
    ? 'review'
    : command.currentStatus === 'in_progress'
      ? 'todo'
      : command.currentStatus;
  if (command.assignedTo || command.currentExecutionId || restoredStatus !== command.currentStatus) {
    db.prepare(
      `UPDATE tasks SET status=?, assigned_to=NULL, current_execution_id=NULL,
                        updated_at=datetime('now') WHERE id=?`,
    ).run(restoredStatus, command.taskId);
  }
  return restoredStatus;
}
