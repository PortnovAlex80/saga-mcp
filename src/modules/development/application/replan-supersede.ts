/**
 * RE-PLAN CYCLE (docs/architecture/REPLAN-CYCLE-TZ.md §5) — supersede the
 * un-raised cycle-1 tasks at cycle-2 start.
 *
 * The cycle-1 graph is immutable by (process_run_id, module, cell); cycle 2
 * is a NEW process run, so the new graph mint cannot conflict. What MUST NOT
 * happen is the old run's un-raised workplaces waking up beside cycle 2:
 * zero active cycle-1 workers before the continuation starts (the five
 * architects' verdict — REPLAN-CYCLE-TZ.md, graph lifecycle).
 *
 * The drain is honest and one-directional:
 *   - remaining tasks (not yet terminal) get metadata.$.superseded_by =
 *     <cycle2RunId> and the card status 'cancelled';
 *   - their workplace projections are drained: kanban 'cancelled',
 *     loop_state 'terminal', terminal_reason 'cancelled' (revision bumped so
 *     any stale lease can never win a CAS against the drained state);
 *   - ACCEPTED cycle-1 work is never touched — it carries forward as the git
 *     baseline (isAncestor reachability stays provable).
 *
 * Idempotent: a replay finds only drained rows and supersedes nothing.
 */

import type { SqlDatabasePort } from '../../../application/ports/sql-database.js';

export interface SupersedeInput {
  /** The cycle-1 process run whose cell tasks may still be pending. */
  readonly cycle1ProcessRunId: number;
  /** The cycle-2 run that supersedes them (recorded in task metadata). */
  readonly cycle2RunId: number;
}

export interface SupersedeResult {
  readonly supersededTaskIds: readonly number[];
}

const REMAINING_TASK_STATUSES = "('todo','in_progress','review','review_in_progress','blocked')";

export function supersedeRemainingCycleTasks(
  db: SqlDatabasePort,
  input: SupersedeInput,
): SupersedeResult {
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT t.id AS taskId,
              t.status AS status,
              t.metadata AS metadata,
              w.workplace_ref AS workplaceRef,
              w.revision AS revision
         FROM factory_workplaces w
         JOIN tasks t ON t.workplace_ref = w.workplace_ref
        WHERE w.process_run_id = ?
          AND w.loop_state <> 'terminal'
          AND t.status IN ${REMAINING_TASK_STATUSES}`,
    ).all(input.cycle1ProcessRunId) as Array<{
      taskId: number;
      status: string;
      metadata: string;
      workplaceRef: string;
      revision: number;
    }>;
    const supersededTaskIds: number[] = [];
    for (const row of rows) {
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* fresh metadata */ }
      db.prepare(
        `UPDATE tasks
            SET status = 'cancelled',
                metadata = ?
          WHERE id = ? AND status IN ${REMAINING_TASK_STATUSES}`,
      ).run(
        JSON.stringify({ ...metadata, superseded_by: String(input.cycle2RunId) }),
        row.taskId,
      );
      // Drain the projection: terminal/cancelled with a CAS revision bump —
      // a stale lease on the pre-drain revision can never win again.
      db.prepare(
        `UPDATE factory_workplaces
            SET kanban_phase = 'cancelled',
                loop_state = 'terminal',
                terminal_reason = 'cancelled',
                revision = revision + 1,
                active_reservation_ref = NULL,
                active_gate_ref = NULL,
                updated_at = datetime('now')
          WHERE workplace_ref = ? AND loop_state <> 'terminal'`,
      ).run(row.workplaceRef);
      supersededTaskIds.push(row.taskId);
    }
    return { supersededTaskIds };
  })();
}
