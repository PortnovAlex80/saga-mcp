/**
 * ConveyorRuntime — the v4 cutover authority (step 5.2).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-05/06/09/28 +
 * CONVEYOR-V4-MIGRATION-PLAN step 5 («Cutover authority») and §5.3
 * («Two-channel enforcement»).
 *
 * # What this is
 *
 * Before this runtime, `tasks.{status,assigned_to,current_execution_id}` was
 * the orchestration truth and `factory_workplaces` was a best-effort shadow. After
 * this runtime, the LOOP channel (`queued|leased|running|verifying|
 * repair_wait|paused|terminal`) lives authoritatively in `factory_workplaces`,
 * and the KANBAN channel (`tasks.status`) becomes a REVERSE PROJECTION of
 * the workplace's `kanbanPhase` — written by the projector, never by hand.
 *
 * The dispatcher (`worker_next`/`worker_done`/`worker_ask_need`/`merge_*`)
 * is rewired to call these use cases instead of mutating `tasks` owner
 * columns directly (REG-06-AC-02: "human command addresses a Workplace use
 * case and domain event, not an arbitrary UPDATE of the card row").
 *
 * # The two channels after cutover (REG-28)
 *
 *   Kanban (`tasks.status`)   — projection of factory_workplaces.kanbanPhase.
 *                                Written ONLY by WorkplaceProjector.
 *   Loop   (v4 loopState)     — authoritative. CAS-guarded by revision.
 *                                Mutated ONLY by ConveyorRuntime use cases.
 *
 * A crash/lease-expiry/repair changes loop (repair_wait), NEVER Kanban
 * (REG-28-AC-02). The Kanban column is re-derived from the workplace's
 * kanbanPhase on every projector run.
 *
 * # Use cases (PROC-03..05/08/11/13)
 *
 *   reserveWorkplace  (PROC-04) — admit + lease: todo/idle → queued → leased.
 *   releaseExecution  (PROC-05) — worker terminal; loop advances per outcome.
 *   applyGateDecision (PROC-07) — verifying → accepted/repair/human/failed.
 *   requeueForRepair   (PROC-08/09) — repair_wait → queued (new worker).
 *   pauseForHuman      (PROC-13) — * → blocked/paused with resume target.
 *   resumeFromHuman    (PROC-16) — paused → queued (human answered).
 *
 * Each use case is atomic (BEGIN IMMEDIATE), CAS-guarded, and applies the
 * pure-domain reducer to compute the next state — the same reducer the
 * ProductionCellCoordinator uses (REG-13-AC-02).
 */

import type Database from 'better-sqlite3';
import {
  reduceWorkplaceEvent,
  type ProductionCellEvent,
  type WorkplaceRef,
  type WorkplaceState,
} from '../process-modules/domain/workplace/index.js';
import { SqliteWorkplaceRepository } from '../infrastructure/workplace/sqlite-workplace-repository.js';
import {
  deriveWorkplaceRefFromTaskMetadata,
  reverseProjectWorkplaceToTask,
} from '../infrastructure/projections/workplace-projector.js';
import { serializeWorkplaceRef } from '../process-modules/domain/workplace/workplace-ref.js';

/** The outcome of a use case: the workplace state and the resulting task status. */
export interface UseCaseResult {
  readonly applied: boolean;
  readonly workplace: WorkplaceState;
  /** The tasks.status value the projector should now show (reverse projection). */
  readonly taskStatus: string | null;
}

/**
 * The Conveyor Runtime. Construct once per DB. Each method is one atomic,
 * CAS-guarded domain transition on a Workplace, followed by a reverse
 * projection of the new kanbanPhase into tasks.status.
 */
export class ConveyorRuntime {
  private readonly repo: SqliteWorkplaceRepository;

  constructor(private readonly db: Database.Database) {
    this.repo = new SqliteWorkplaceRepository(db);
  }

  /**
   * PROC-03/04 — Admit work and lease a worker.
   *
   *   todo/idle  → in_progress/queued  (work-admitted)
   *   queued     → leased              (worker-leased, sets activeReservationRef)
   *
   * Idempotent on (workplaceRef, reservationRef): a replay with the same
   * reservation is a no-op. The lease is recorded as `active_reservation_ref`
   * on the workplace (REG-09: two dispatchers in a race create one effective
   * reservation).
   *
   * `taskId` is the tasks-table row bound to this workplace; its status is
   * reverse-projected after the transition (REG-06).
   */
  reserveWorkplace(input: {
    workplaceRef: WorkplaceRef;
    reservationRef: string;
    taskId: number;
  }): UseCaseResult {
    return this.atomically(input.workplaceRef, input.taskId, (current) => {
      // Phase 1: admit (todo/idle → in_progress/queued), idempotent.
      let state = current;
      if (state.kanbanPhase === 'todo' && state.loopState === 'idle') {
        state = reduceWorkplaceEvent(state, { kind: 'work-admitted' });
      }
      // Phase 2: lease (queued → leased). If already leased by the SAME
      // reservation, idempotent no-op. If leased by a DIFFERENT reservation,
      // the CAS will fail (the caller must re-read).
      if (state.loopState === 'queued') {
        state = reduceWorkplaceEvent(state, {
          kind: 'worker-leased',
          reservationRef: input.reservationRef,
        });
        state = reduceWorkplaceEvent(state, { kind: 'worker-started' });
      } else if (state.loopState === 'leased' || state.loopState === 'running') {
        // Already leased/running — idempotent if same reservation.
        return null; // signal "no transition needed"
      }
      return {
        event: null as ProductionCellEvent | null,
        directState: state,
        activeReservationRef: input.reservationRef,
      };
    });
  }

  /**
   * PROC-05 — Worker completed its shift. The loop advances based on the
   * terminal outcome of the execution:
   *
   *   completed → verifying (candidate sealed, gate decides next).
   *   crashed/expired → repair_wait (REG-28-AC-02: loop only, Kanban stays).
   *
   * `reservationRef` MUST match the workplace's active_reservation_ref or the
   * call is rejected (REG-09-AC-04: a revoked/expired fence cannot clear or
   * replace a newer fence).
   */
  releaseExecution(input: {
    workplaceRef: WorkplaceRef;
    reservationRef: string;
    taskId: number;
    outcome: 'completed' | 'crashed' | 'expired' | 'cancelled';
  }): UseCaseResult {
    return this.atomically(input.workplaceRef, input.taskId, (_current, ref) => {
      // Fence check: the caller's reservation must match the workplace's
      // active_reservation_ref (REG-09-AC-04). A stale/expired fence cannot
      // mutate the workplace.
      const actors = this.repo.readActiveActors(ref);
      if (!actors || actors.activeReservationRef !== input.reservationRef) {
        throw new Error(
          `FENCE_MISMATCH: workplace's active reservation `
            + `'${actors?.activeReservationRef ?? 'null'}' does not match `
            + `'${input.reservationRef}' (REG-09-AC-04)`,
        );
      }
      let event: ProductionCellEvent;
      let keepReservation: boolean;
      if (input.outcome === 'completed') {
        // running → verifying. The reservation is retained through verifying
        // (the same worker may still be the active actor until the gate runs).
        event = { kind: 'candidate-sealed' };
        keepReservation = true;
      } else if (input.outcome === 'crashed' || input.outcome === 'expired') {
        // running → repair_wait (REG-28-AC-02). The fence is cleared — a
        // replacement worker will lease a new reservation.
        event = { kind: 'worker-crashed' };
        keepReservation = false;
      } else {
        // cancelled — terminal. Fence cleared.
        event = { kind: 'authorized-cancel' };
        keepReservation = false;
      }
      return {
        event,
        directState: null,
        activeReservationRef: keepReservation ? input.reservationRef : null,
      };
    });
  }


  /**
   * PROC-08 — Re-queue for repair after a gate rejection or crash. A new
   * reservation/worker will be hired; the loop returns to queued (REG-28-AC-02:
   * the Kanban phase is NOT rolled back to todo).
   *
   * `repairTargetRole` is the role the new worker must take (author or reviewer).
   */
  requeueForRepair(input: {
    workplaceRef: WorkplaceRef;
    taskId: number;
    role: 'author' | 'reviewer';
  }): UseCaseResult {
    return this.atomically(input.workplaceRef, input.taskId, () => {
      return {
        event: { kind: 'repair-requeued', role: input.role } as ProductionCellEvent,
        directState: null,
        activeReservationRef: null,
      };
    });
  }

  /**
   * PROC-13 — Pause the line for a human decision (human_required gate).
   *   * → blocked/paused. The resume target is the persisted nextRole.
   */
  pauseForHuman(input: { workplaceRef: WorkplaceRef; taskId: number }): UseCaseResult {
    return this.atomically(input.workplaceRef, input.taskId, () => {
      return {
        event: { kind: 'human-required' } as ProductionCellEvent,
        directState: null,
        activeReservationRef: null,
      };
    });
  }

  /**
   * PROC-16 — Resume from a human pause. The human answered; the loop returns
   * to queued with the persisted role.
   */
  resumeFromHuman(input: {
    workplaceRef: WorkplaceRef;
    taskId: number;
    role: 'author' | 'reviewer';
  }): UseCaseResult {
    return this.requeueForRepair(input);
  }

  // -----------------------------------------------------------------------
  // Internal: atomic CAS transition + reverse projection.
  // -----------------------------------------------------------------------

  /**
   * Run one atomic transition. The `plan` callback receives the CURRENT state
   * AND the workplace ref (for fence/actor reads) and returns either:
   *   - `{ event, directState: null }` — apply the reducer event, OR
   *   - `{ event: null, directState }` — a precomputed target state, OR
   *   - `null` — no transition (idempotent), return current as-applied.
   *
   * Then CAS the workplace, and reverse-project the new kanbanPhase into
   * tasks.status (REG-06). The whole step runs in one transaction so the
   * workplace CAS and the tasks projection are consistent.
   */
  private atomically(
    workplaceRef: WorkplaceRef,
    taskId: number,
    plan: (
      current: WorkplaceState,
      ref: WorkplaceRef,
    ) => {
      event: ProductionCellEvent | null;
      directState: WorkplaceState | null;
      activeReservationRef: string | null;
    } | null,
  ): UseCaseResult {
    // better-sqlite3 `db.transaction()` uses SAVEPOINTs that nest fine, BUT
    // the repo's applyTransition opens its own BEGIN IMMEDIATE which cannot
    // nest. So we open ONE BEGIN IMMEDIATE here and call applyTransitionInTx
    // (which assumes the caller's transaction). The reverse projection runs
    // inside the same transaction so v4 CAS + tasks.status commit together.
    const ownsTransaction = !this.db.inTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.repo.read(workplaceRef);
      if (!current) {
        throw new Error(
          `WORKPLACE_NOT_FOUND: '${serializeWorkplaceRef(workplaceRef)}' was not materialized`,
        );
      }
      const planned = plan(current, workplaceRef);
      if (planned === null) {
        // Idempotent — nothing to do.
        const taskStatus = this.reverseProject(taskId, current);
        if (ownsTransaction) this.db.exec('COMMIT');
        return { applied: false, workplace: current, taskStatus };
      }
      const target = planned.directState
        ?? reduceWorkplaceEvent(current, planned.event!);

      const result = this.repo.applyTransitionInTx({
        workplaceRef,
        expectedRevision: current.revision,
        kanbanPhase: target.kanbanPhase,
        loopState: target.loopState,
        nextRole: target.nextRole,
        terminalReason: target.terminalReason,
        activeReservationRef: planned.activeReservationRef,
      });
      if (!result.applied) {
        // CAS miss — a concurrent writer advanced the revision. Surface as
        // not-applied; the caller (dispatcher) re-reads and re-evaluates.
        const taskStatus = this.reverseProject(taskId, result.state);
        if (ownsTransaction) this.db.exec('COMMIT');
        return { applied: false, workplace: result.state, taskStatus };
      }
      // Reverse-project the new kanbanPhase into tasks.status.
      const taskStatus = this.reverseProject(taskId, result.state);
      if (ownsTransaction) this.db.exec('COMMIT');
      return { applied: true, workplace: result.state, taskStatus };
    } catch (err) {
      if (ownsTransaction) {
        try { this.db.exec('ROLLBACK'); } catch { /* tx may not be active */ }
      }
      throw err;
    }
  }

  /**
   * Reverse-project a workplace's kanbanPhase into the tasks.status column.
   * This is the ONE-WAY projection that makes tasks a read model (REG-06).
   */
  private reverseProject(taskId: number, state: WorkplaceState): string | null {
    return reverseProjectWorkplaceToTask(this.db, taskId, state);
  }

  /**
   * Bind a task to its workplace. Called when a task is admitted to the
   * conveyor (at task creation or first claim). Sets tasks.workplace_ref and
   * materializes the factory_workplaces row at todo/idle.
   */
  bindTaskToWorkplace(input: {
    taskId: number;
    epicId: number;
    projectId: number;
    taskKind: string | null;
    metadata: string;
    /** The task's status BEFORE the claim UPDATE (authoritative for the
     *  workplace's initial Kanban phase). When omitted, reads tasks.status. */
    preClaimStatus?: string;
  }): WorkplaceRef | null {
    return this.db.transaction(() => {
      const ref = deriveWorkplaceRefFromTaskMetadata({
        taskId: input.taskId,
        metadata: input.metadata,
        taskKind: input.taskKind,
      });
      if (!ref) return null;
      // Materialize the workplace at todo/idle (idempotent).
      this.repo.materialize({
        processRunId: ref.processRunId,
        moduleRef: ref.moduleRef,
        productionCellId: ref.productionCellId,
        workKey: ref.workKey,
      });
      // If the task is already past todo (e.g. a review task that was created
      // in 'review' status), advance the workplace's Kanban phase to match — a
      // newly-bound task must not regress the workplace. This is a one-time
      // sync at bind; subsequent transitions go through the reducer.
      const status = input.preClaimStatus
        ?? (this.db.prepare('SELECT status FROM tasks WHERE id=?').get(input.taskId) as { status: string } | undefined)?.status;
      if (status) {
        const cur = this.repo.read(ref);
        if (cur && cur.kanbanPhase === 'todo' && cur.loopState === 'idle') {
          const s = status;
          const target = s === 'review' || s === 'review_in_progress'
            ? { kanbanPhase: 'review' as const, nextRole: 'reviewer' as const }
            : s === 'in_progress'
              ? { kanbanPhase: 'in_progress' as const, nextRole: 'author' as const }
              : s === 'done'
                ? { kanbanPhase: 'done' as const, nextRole: 'author' as const }
                : null;
          if (target) {
            this.repo.applyTransitionInTx({
              workplaceRef: ref,
              expectedRevision: cur.revision,
              kanbanPhase: target.kanbanPhase,
              loopState: target.kanbanPhase === 'done' ? 'terminal' : 'queued',
              nextRole: target.nextRole,
              terminalReason: target.kanbanPhase === 'done' ? 'accepted' : null,
            });
          }
        }
      }
      // Bind the task row to the workplace (data column). Store the SERIALIZED
      // form so it matches factory_workplaces.workplace_ref (the PK) for joins.
      this.db.prepare(
        `UPDATE tasks SET workplace_ref=? WHERE id=? AND workplace_ref IS NULL`,
      ).run(serializeWorkplaceRef(ref), input.taskId);
      return ref;
    })();
  }
}

// ---------------------------------------------------------------------------
// Re-export the binding helper for the dispatcher.
// ---------------------------------------------------------------------------

export { deriveWorkplaceRefFromTaskMetadata };
