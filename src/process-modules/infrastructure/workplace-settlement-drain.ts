/**
 * REG-28 kanban-drain-at-terminal (stage23 lifecycle-2 incident, 14:01:42).
 *
 * THE INVARIANT: when a ProcessRun settles terminally (verified / blocked /
 * failed / … — every module outcome is terminal), the Kanban board it leaves
 * behind may contain NO anonymous todo/queued work. A card still reading
 * todo/idle after the run that owned it settled forever is a lie twice over:
 * the board promises pending work while the run that would dispatch it is
 * closed (REG-28-AC-01's closed phase×loop table has no lawful slot for
 * `todo` beside a settled run), and the operator reading the board cannot
 * distinguish "queued" from "orphaned".
 *
 * The counterexample shape (work reaching terminal while a card remains
 * queued) is exactly the lifecycle-2 boundary the stage-23 workshop check
 * rejected; until this drain existed, NOTHING in production reclassified
 * those rows — the replan continuation drains its cycle-1 leftovers
 * (replan-supersede.ts), but the ordinary settlement path had no counterpart.
 *
 * The drain is honest and one-directional, mirroring supersede's shape:
 *   - anonymous live cards (loop_state 'idle'/'queued' — never dispatched,
 *     or dispatched-and-released with no typed wait) are cancelled: task
 *     status 'cancelled' with metadata.$.settled_with_run, workplace
 *     kanban 'cancelled', loop 'terminal',
 *     terminal_reason 'cancelled' — the closed REG-28-AC-05 vocabulary — with the settling outcome recorded in the drained task's metadata.$.settled_with_run, and a CAS revision bump so no
 *     stale lease can ever win a transition against the drained state;
 *   - TYPED waits are sacred (CONVEYOR §23): a workplace parked in
 *     'paused' (human-required, with its park reason), 'repair_wait',
 *     'verifying' or 'effect_pending' is an explicit typed state the
 *     settlement reason must explain — it is NEVER force-cancelled here;
 *   - terminal rows are never touched;
 *   - idempotent: a replay finds only drained/typed rows and drains nothing.
 *
 * Called from the GenericFlowExecutor settlement transaction (the same
 * transaction that writes the terminal outcome), so the board can never be
 * observed half-settled.
 */

import type Database from 'better-sqlite3';

export interface SettlementDrainInput {
  readonly processRunId: number;
  /** The terminal local outcome the run settled with (e.g. 'verified'). */
  readonly outcome: string;
}

export interface SettlementDrainResult {
  readonly drainedWorkplaceRefs: readonly string[];
  readonly drainedTaskIds: readonly number[];
}

/** Loop states that are ANONYMOUS live work on a settled run. */
const ANONYMOUS_LIVE_LOOP_STATES = "('idle','queued')";

const DRAINABLE_TASK_STATUSES = "('todo','in_progress','review','review_in_progress','blocked')";

export function drainAnonymousWorkOnProcessSettlement(
  db: Database.Database,
  input: SettlementDrainInput,
): SettlementDrainResult {
  return db.transaction(() => {
    const rows = db.prepare(
      `SELECT w.workplace_ref AS workplaceRef,
              w.revision AS revision
         FROM factory_workplaces w
        WHERE w.process_run_id = ?
          AND w.loop_state IN ${ANONYMOUS_LIVE_LOOP_STATES}`,
    ).all(input.processRunId) as Array<{
      workplaceRef: string;
      revision: number;
    }>;
    const drainedWorkplaceRefs: string[] = [];
    const drainedTaskIds: number[] = [];
    for (const row of rows) {
      const tasks = db.prepare(
        `SELECT id, metadata FROM tasks
          WHERE workplace_ref = ?
            AND status IN ${DRAINABLE_TASK_STATUSES}`,
      ).all(row.workplaceRef) as Array<{ id: number; metadata: string | null }>;
      for (const task of tasks) {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(task.metadata ?? '{}') as Record<string, unknown>;
        } catch { /* fresh metadata */ }
        db.prepare(
          `UPDATE tasks
              SET status = 'cancelled',
                  metadata = ?
            WHERE id = ? AND status IN ${DRAINABLE_TASK_STATUSES}`,
        ).run(
          JSON.stringify({
            ...metadata,
            settled_with_run: { processRunId: input.processRunId, outcome: input.outcome },
          }),
          task.id,
        );
        drainedTaskIds.push(task.id);
      }
      db.prepare(
        `UPDATE factory_workplaces
            SET kanban_phase = 'cancelled',
                loop_state = 'terminal',
                terminal_reason = 'cancelled',
                revision = revision + 1,
                active_reservation_ref = NULL,
                active_gate_ref = NULL,
                updated_at = datetime('now')
          WHERE workplace_ref = ? AND loop_state IN ${ANONYMOUS_LIVE_LOOP_STATES}`,
      ).run(row.workplaceRef);
      drainedWorkplaceRefs.push(row.workplaceRef);
    }
    return { drainedWorkplaceRefs, drainedTaskIds };
  })();
}
