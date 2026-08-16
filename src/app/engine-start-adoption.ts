import type Database from 'better-sqlite3';
import { ConveyorRuntime } from '../application/conveyor-runtime.js';
import { deserializeWorkplaceRef } from '../process-modules/domain/workplace/workplace-ref.js';

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
 * workplace reservation can never produce new work. When the durable
 * worker_done receipt exists, the completion is already semantically proven —
 * the reservation is retained as the contribution-author pointer and the
 * unstarved obligation reconciler finishes the idempotent verifying
 * transition. Without the receipt the reservation is left alone: that case
 * never legitimately reaches verifying (releaseExecution('completed') is the
 * only entry) and must fail loudly instead of being silently rewritten.
 *
 * Operator SOFT-STOP (schema v13): a VOIDED execution (voided_at IS NOT NULL)
 * is terminal-with-audit and is NEVER resurrected or repaired here — its hire
 * was rewound by the operator; a replacement worker owns the next attempt.
 */

export const ENGINE_START_ADOPTION_POLICY_REF = 'factory.engine-start-adoption.v1';

/** Kernel-owned loop states whose transition does not need a live worker. */
const KERNEL_OWNED_LOOP_STATES = "('verifying','effect_pending')";
/** Terminal execution states: the OS process fact is already recorded. */
const TERMINAL_EXECUTION_STATES = "('exited','failed','terminated','lost')";
export interface EngineStartAdoptionResult {
  readonly adopted: number;
  readonly repaired: readonly {
    readonly executionId: string;
    readonly workplaceRef: string;
    readonly loopState: string;
  }[];
  readonly skippedNoReceipt: number;
  readonly spawnFailedRepaired: readonly {
    readonly executionId: string;
    readonly workplaceRef: string;
    readonly loopState: string;
  }[];
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
        AND we.voided_at IS NULL
      ORDER BY we.finished_at`,
  ).all() as { execution_id: string; workplace_ref: string; loop_state: string }[];

  const details: { executionId: string; workplaceRef: string; loopState: string }[] = [];
  const repaired: { executionId: string; workplaceRef: string; loopState: string }[] = [];
  let skippedNoReceipt = 0;

  const adopt = db.transaction((row: { execution_id: string; workplace_ref: string }) => {
    // Without a durable worker_done receipt the completion is NOT proven, so
    // the reservation must not be silently cleared. The conveyor already owns
    // the right transition for exactly this case: a verifying Workplace whose
    // presenter produced no mandatory material goes back to repair
    // (rejectIncompleteCompletion — an operator-recovery transition that also
    // clears the fence). A fresh author/reviewer worker is then hired.
    if (!hasAcceptedWorkerDone(db, row.execution_id)) {
      return false;
    }
    // With an accepted receipt the completion is already semantically proven.
    // The reservation is RETAINED: in verifying it is not a liveness lock but
    // the durable pointer to the contribution's author — the executor reads
    // `activeReservationRef` to locate `readContributionProducts(contributorRef)`
    // and nulling it puts the Workplace in an unrecoverable state
    // ("verifying Workplace has no producer reservation" → lifecycle failed).
    // Nothing to rewrite: the unstarved obligation reconciler re-drives the
    // idempotent kernel verifying transition and the reducer clears the
    // reservation when the gate settles. This branch is a no-op fence so the
    // adoption report still counts the adopted pair.
    return true;
  });

  const repairWithoutReceipt = db.transaction(
    (row: { execution_id: string; workplace_ref: string; loop_state: string }) => {
      const workplace = db.prepare(
        `SELECT next_role FROM factory_workplaces WHERE workplace_ref=?`,
      ).get(row.workplace_ref) as { next_role: 'author' | 'reviewer' } | undefined;
      const task = db.prepare(
        `SELECT id FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1`,
      ).get(row.workplace_ref) as { id: number } | undefined;
      if (!workplace || !task) return false;
      try {
        new ConveyorRuntime(db).rejectIncompleteCompletion({
          workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
          taskId: task.id,
          role: workplace.next_role,
        });
        return true;
      } catch {
        return false;
      }
    },
  );

  for (const row of rows) {
    if (adopt(row)) {
      details.push({
        executionId: row.execution_id,
        workplaceRef: row.workplace_ref,
        loopState: row.loop_state,
      });
    } else if (repairWithoutReceipt(row)) {
      repaired.push({
        executionId: row.execution_id,
        workplaceRef: row.workplace_ref,
        loopState: row.loop_state,
      });
    } else {
      skippedNoReceipt += 1;
    }
  }

  // Spawn-failed reservations: the executor's own failure path labels the
  // execution 'spawn_failed' and then pauses the Workplace for a human, but a
  // concurrent engine crash (observed: the dispatch-time replay-binder abort)
  // can kill the process between those two writes. The residue is a
  // worker-owned `leased`/`running` Workplace whose reservation holder never
  // had a process (pid NULL, started_at NULL): no submission, no receipt, no
  // contribution can exist. Neither the reaper (selects
  // reserved/running/cancel_requested states) nor the no-receipt branch above
  // (kernel-owned states only) can see it.
  //
  // The repair mirrors the semantics the dead engine intended, per state:
  //  - `leased` → pauseForHuman (the reducer's `human-required` edge has no
  //    source-state precondition, so it is the ONLY legal transition out of a
  //    leased desk whose holder provably never started; the standard
  //    resumeFromHuman path then requeues a replacement worker);
  //  - `running` → releaseExecution('crashed'), the conveyor's own
  //    fence-checked running→repair_wait transition.
  // Using releaseExecution('crashed') for BOTH would silently no-op on leased:
  // the `worker-crashed` reducer edge requires `running` and the throw would be
  // swallowed below, re-stranding the workplace on every engine start.
  const spawnFailedRows = db.prepare(
    `SELECT we.execution_id, w.workplace_ref, w.loop_state
       FROM worker_executions we
       JOIN factory_workplaces w
         ON w.active_reservation_ref = we.execution_id
        AND w.loop_state IN ('leased','running')
      WHERE we.state = 'spawn_failed'
        AND we.pid IS NULL
        AND we.started_at IS NULL
      ORDER BY we.reserved_at`,
  ).all() as { execution_id: string; workplace_ref: string; loop_state: string }[];

  const spawnFailedRepaired: {
    executionId: string;
    workplaceRef: string;
    loopState: string;
  }[] = [];
  for (const row of spawnFailedRows) {
    const task = db.prepare(
      `SELECT id FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1`,
    ).get(row.workplace_ref) as { id: number } | undefined;
    if (!task) continue;
    const runtime = new ConveyorRuntime(db);
    try {
      if (row.loop_state === 'leased') {
        runtime.pauseForHuman({
          workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
          taskId: task.id,
          // Fix-1 — the residue repair parks with its cause: the reservation
          // holder provably never started (no pid, no started_at).
          reason: {
            code: 'WORKER_SPAWN_FAILED_RESIDUE',
            message: `Spawn-failed residue repair on engine start: execution `
              + `${row.execution_id} holds a '${row.loop_state}' workplace reservation `
              + `but its process was never created (pid NULL, started_at NULL).`,
            evidenceRefs: [row.execution_id],
          },
        });
      } else {
        runtime.releaseExecution({
          workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
          reservationRef: row.execution_id,
          taskId: task.id,
          outcome: 'crashed',
        });
      }
      spawnFailedRepaired.push({
        executionId: row.execution_id,
        workplaceRef: row.workplace_ref,
        loopState: row.loop_state,
      });
    } catch (err) {
      // Log and skip: a concurrent writer may have moved this workplace, but a
      // silent catch would also hide real repair defects (observed: a seeded
      // illegal kanban/role pair surfaced only as a silent 0-repair count).
      // The next engine start re-evaluates idempotently either way.
      process.stderr.write(
        `[engine-start-adoption] spawn-failed repair skipped execution=${row.execution_id} `
        + `workplace=${row.workplace_ref}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  return {
    adopted: details.length,
    repaired,
    skippedNoReceipt,
    spawnFailedRepaired,
    details,
  };
}
