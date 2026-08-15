import type Database from 'better-sqlite3';

/**
 * TB-9 engine-start adoption.
 *
 * `verifying` / `effect_pending` are kernel-owned Workplace states: the
 * transition is re-driven by the ProductionCellNodeExecutor from durable
 * material (sealed contributions + accepted worker_done receipts), never by
 * the OS process. But the workplace keeps the producer's
 * `active_reservation_ref` through verifying ("the same worker may still be
 * the active actor until the gate runs"), and the ONLY code that cleared it
 * after process exit lived inside the engine process that observed the exit.
 * Kill the engine in that window and the reservation outlives every process:
 * new engines loop on "kernel-owned workplace progress pending" forever
 * because nothing adopts the terminal execution (reaper selects only
 * reserved/running/cancel_requested rows).
 *
 * This pass runs once at engine start. Authority stays in the DB: an
 * execution that is TERMINAL in worker_executions and holds a kernel-owned
 * workplace reservation can never produce new work, so the reservation is
 * stale by definition. When the durable worker_done receipt exists, the
 * completion is already semantically proven — clearing the stale reservation
 * restores exactly the post-observation state the dead engine would have
 * written, and the idempotent kernel verifying re-drive finishes the
 * transition. Without the receipt the reservation is left alone: that case
 * never legitimately reaches verifying (releaseExecution('completed') is the
 * only entry) and must fail loudly instead of being silently rewritten.
 */

export const ENGINE_START_ADOPTION_POLICY_REF = 'factory.engine-start-adoption.v1';

/** Kernel-owned loop states whose transition does not need a live worker. */
const KERNEL_OWNED_LOOP_STATES = "('verifying','effect_pending')";
/** Terminal execution states: the OS process fact is already recorded. */
const TERMINAL_EXECUTION_STATES = "('exited','failed','terminated','lost')";

export interface EngineStartAdoptionResult {
  readonly adopted: number;
  readonly skippedNoReceipt: number;
  readonly details: readonly {
    readonly executionId: string;
    readonly workplaceRef: string;
    readonly loopState: string;
  }[];
}

function hasAcceptedWorkerDone(db: Database.Database, executionId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1
       FROM command_receipts
      WHERE execution_id=?
        AND command_kind IN ('worker_done','presentation_close')
        AND accepted=1
      LIMIT 1`,
  ).get(executionId));
}

export function adoptTerminalExecutionsAtEngineStart(
  db: Database.Database,
): EngineStartAdoptionResult {
  const rows = db.prepare(
    `SELECT we.execution_id, w.workplace_ref, w.loop_state
       FROM worker_executions we
       JOIN factory_workplaces w
         ON w.active_reservation_ref = we.execution_id
        AND w.loop_state IN ${KERNEL_OWNED_LOOP_STATES}
      WHERE we.state IN ${TERMINAL_EXECUTION_STATES}
        AND we.stuck_state = 'active'
      ORDER BY we.finished_at`,
  ).all() as { execution_id: string; workplace_ref: string; loop_state: string }[];

  const details: { executionId: string; workplaceRef: string; loopState: string }[] = [];
  let skippedNoReceipt = 0;

  const adopt = db.transaction((row: { execution_id: string; workplace_ref: string }) => {
    if (!hasAcceptedWorkerDone(db, row.execution_id)) return false;
    // Clearing the reservation is the adoption AND the idempotency fence:
    // the JOIN above can never match this pair again. stuck_state keeps its
    // historical value — the column CHECK is a stuck-policy state machine
    // ('active'/'suspected_stuck'/'cancel_requested') and adoption is not a
    // stuck-policy transition.
    db.prepare(
      `UPDATE factory_workplaces
          SET active_reservation_ref=NULL, updated_at=datetime('now')
        WHERE workplace_ref=? AND active_reservation_ref=?`,
    ).run(row.workplace_ref, row.execution_id);
    return true;
  });

  for (const row of rows) {
    if (adopt(row)) {
      details.push({
        executionId: row.execution_id,
        workplaceRef: row.workplace_ref,
        loopState: row.loop_state,
      });
    } else {
      skippedNoReceipt += 1;
    }
  }
  return { adopted: details.length, skippedNoReceipt, details };
}
