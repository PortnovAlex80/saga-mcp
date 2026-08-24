import type Database from 'better-sqlite3';
import { ConveyorRuntime } from '../application/conveyor-runtime.js';
import { deserializeWorkplaceRef } from '../process-modules/domain/workplace/workplace-ref.js';
import { createSqliteProductionCellProjectionPersistence } from '../infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { engineLog } from '../runtime/engine-file-logger.js';

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
 *
 * TASK-SHADOW F2 (audit) — the repair branches bind the conveyor command to
 * the workplace's CURRENT-role task through the PRODUCTION exact-key reader
 * (`createSqliteProductionCellProjectionPersistence().readProjectedRoleTask`)
 * scoped by `factory_workplaces.next_role`: the AUTHOR binding is the stable
 * role task; the REVIEWER binding is the exact CURRENT generation (the
 * accepted-author authority head's subject, derived inside the reader). The
 * retired `SELECT id FROM tasks WHERE workplace_ref=? ORDER BY id DESC
 * LIMIT 1` reads were newest-wins: in a multi-task singleton workplace they
 * bound the repair to the reviewer's row while the author was the repair
 * target — the same shadow class the budget fix removed (SM-14/MM-3).
 *
 * M1 (audit follow-up) — every no-receipt skip is now OBSERVABLE: one
 * engine-log/stderr line per stranded pair carrying workplace/execution/
 * loopState plus a typed cause that separates expected exact-null absence
 * (EXACT_ROLE_TASK_ABSENT) from thrown corruption (duplicate of the exact
 * current generation → EXACT_ROLE_TASK_READ_FAILED) and from a failed
 * conveyor command (REJECT_INCOMPLETE_COMPLETION_FAILED). The repair itself
 * stays fail-closed and idempotent: chronology never picks the binding, and
 * legal multi-generation desks (current + superseded reviewer rounds) keep
 * repairing through the exact current-generation key.
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

  // TASK-SHADOW F2 — the production exact-key role-task reader, scoped by the
  // workplace's CURRENT next_role. Never newest-wins; a broken idempotence
  // fence (duplicate of the exact generation) throws inside the callers' try
  // blocks and the pair is honestly skipped, never silently retargeted.
  const roleTaskReader = createSqliteProductionCellProjectionPersistence(db)
    .readProjectedRoleTask;
  if (!roleTaskReader) {
    // Fail closed: without the exact-key reader this pass must not fall back
    // to any recency-shaped task selection.
    throw new Error(
      'PRODUCTION_CELL_ROLE_TASK_READER_UNAVAILABLE: engine-start adoption '
      + 'requires the exact-key role-task projection read',
    );
  }
  const readExactCurrentRoleTask = (
    workplaceRef: string,
    role: 'author' | 'reviewer',
  ): { taskId: number } | null =>
    roleTaskReader(deserializeWorkplaceRef(workplaceRef), role) ?? null;

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

  // M1 (task-shadow hardening) — the no-receipt branch previously collapsed
  // "no exact binding", "the exact-key reader THREW (duplicate of the exact
  // current generation)" and "the repair command itself threw" into a bare
  // skippedNoReceipt counter with no diagnostic (unlike the spawn-failed
  // branch, which logs). The repair stays fail-closed and idempotent; the
  // skip now carries its typed cause to the engine log + stderr so a stranded
  // pair is diagnosable from the log a human reads:
  //   WORKPLACE_ROW_MISSING               — the workplace vanished mid-pass
  //                                          (concurrent writer); expected rare.
  //   EXACT_ROLE_TASK_ABSENT              — the exact-key reader resolved NO
  //                                          binding for the role. EXPECTED
  //                                          absence (exact null), e.g. rows
  //                                          without the durable $.role
  //                                          binding; fail-closed skip, there
  //                                          is no newest-row fallback.
  //   EXACT_ROLE_TASK_READ_FAILED         — the reader THREW: corruption or a
  //                                          broken idempotence fence (a
  //                                          duplicate of the exact CURRENT
  //                                          generation throws
  //                                          PRODUCTION_CELL_ROLE_TASK_
  //                                          PROJECTION_NOT_UNIQUE). Never
  //                                          resolved by chronology.
  //   REJECT_INCOMPLETE_COMPLETION_FAILED — the conveyor command threw (fence
  //                                          mismatch / concurrent writer /
  //                                          illegal source state).
  type NoReceiptRepairOutcome =
    | { repaired: true }
    | { repaired: false; cause: string; detail: string };

  const repairWithoutReceipt = db.transaction(
    (row: { execution_id: string; workplace_ref: string; loop_state: string }): NoReceiptRepairOutcome => {
      const workplace = db.prepare(
        `SELECT next_role FROM factory_workplaces WHERE workplace_ref=?`,
      ).get(row.workplace_ref) as { next_role: 'author' | 'reviewer' } | undefined;
      if (!workplace) {
        return {
          repaired: false,
          cause: 'WORKPLACE_ROW_MISSING',
          detail: 'the workplace row vanished between selection and repair (concurrent writer?)',
        };
      }
      let task: { taskId: number } | null;
      try {
        // TASK-SHADOW F2 — exact CURRENT-role binding (generation-exact for
        // the reviewer via the authority head, inside the production reader).
        task = readExactCurrentRoleTask(row.workplace_ref, workplace.next_role);
      } catch (err) {
        return {
          repaired: false,
          cause: 'EXACT_ROLE_TASK_READ_FAILED',
          detail: `the exact-key role-task read threw for role=${workplace.next_role}: `
            + `${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (!task) {
        return {
          repaired: false,
          cause: 'EXACT_ROLE_TASK_ABSENT',
          detail: `no exact task binding for role=${workplace.next_role} `
            + '(expected absence — the exact-key reader resolved null; '
            + 'fail-closed skip, chronology must not choose the binding)',
        };
      }
      try {
        new ConveyorRuntime(db).rejectIncompleteCompletion({
          workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
          taskId: task.taskId,
          role: workplace.next_role,
        });
        return { repaired: true };
      } catch (err) {
        return {
          repaired: false,
          cause: 'REJECT_INCOMPLETE_COMPLETION_FAILED',
          detail: `rejectIncompleteCompletion threw for task=${task.taskId} `
            + `role=${workplace.next_role}: `
            + `${err instanceof Error ? err.message : String(err)}`,
        };
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
    } else {
      const attempt = repairWithoutReceipt(row);
      if (attempt.repaired) {
        repaired.push({
          executionId: row.execution_id,
          workplaceRef: row.workplace_ref,
          loopState: row.loop_state,
        });
      } else {
        skippedNoReceipt += 1;
        // Observability only (M1): the DB stays untouched on every skip path —
        // the next engine start re-evaluates the pair idempotently.
        const line = `[engine-start-adoption] no-receipt repair skipped `
          + `execution=${row.execution_id} workplace=${row.workplace_ref} `
          + `loopState=${row.loop_state} cause=${attempt.cause}: ${attempt.detail}`;
        engineLog(line);
        process.stderr.write(`${line}\n`);
      }
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
    const runtime = new ConveyorRuntime(db);
    let taskId: number | null = null;
    try {
      // TASK-SHADOW F2 — spawn-failed residue repair binds to the CURRENT
      // role's EXACT task projection (the production reader, scoped by
      // next_role; generation-exact for the reviewer). Absent binding → skip;
      // a duplicate-of-exact-generation fence throw → logged skip below
      // (fail-closed, never a newest-row retarget).
      const nextRole = db.prepare(
        'SELECT next_role FROM factory_workplaces WHERE workplace_ref=?',
      ).get(row.workplace_ref) as
        | { next_role: 'author' | 'reviewer' }
        | undefined;
      if (!nextRole) continue;
      const task = readExactCurrentRoleTask(row.workplace_ref, nextRole.next_role);
      if (!task) continue;
      taskId = task.taskId;
      if (row.loop_state === 'leased') {
        runtime.pauseForHuman({
          workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
          taskId,
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
          taskId,
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
