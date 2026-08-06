/**
 * ProductionCellCoordinator — the runtime component that drives ONE
 * Production Cell through its bounded control loop (Conveyor v4 step 2.2).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-13 (Отдел качества)
 * + Conveyor Mental Model v4 §«The reusable Production Cell».
 *
 * # What this is
 *
 * The coordinator is the INFRASTRUCTURE twin of the pure-domain reducer
 * (`production-cell-reducer.ts`). The reducer computes the next state; the
 * coordinator APPLIES it: it persists state transitions via CAS. Worker
 * reservation and launch belong exclusively to the global dispatcher; gates
 * and immutable product provenance belong to their dedicated repositories.
 *
 * # Lifecycle
 *
 *   1. `materializeCell` — creates the factory_workplaces row at todo/idle.
 *   2. `admitWork` — transitions todo/idle → in_progress/queued (work-admitted).
 *   3. The global dispatcher leases and starts the worker, while the Workplace
 *      projector applies queued → leased → running.
 *   4. `sealCandidateSet` — after the worker has submitted its products,
 *      CandidateSet and transition running → verifying.
 *   5. `applyGateDecision` — record the GateDecision, apply the transition
 *      (verifying → terminal/review/repair_wait per verdict).
 *
 * Each step is CAS-guarded (REG-05-AC-06) and uses the pure-domain reducer
 * to compute the target state, then persists via SqliteWorkplaceRepository.
 *
 * # Injection
 *
 * The coordinator receives its dependencies via constructor (ports + repos).
 * This makes it testable with in-memory fakes and composable in the root.
 *
 */

import type Database from 'better-sqlite3';
import {
  reduceWorkplaceEvent,
  serializeWorkplaceRef,
  type NextRole,
  type ProductionCellEvent,
  type WorkplaceRef,
  type WorkplaceState,
} from '../domain/workplace/index.js';
import { SqliteWorkplaceRepository } from '../../infrastructure/workplace/sqlite-workplace-repository.js';

/**
 * Dependencies the coordinator needs.
 *
 * Launch dependencies are deliberately absent. The coordinator cannot spawn a
 * worker, which makes the single-launch-authority invariant structural rather
 * than conventional.
 */
export interface ProductionCellCoordinatorDeps {
  readonly db: Database.Database;
  readonly workplaceRepo: SqliteWorkplaceRepository;
  /** Clock for timestamps (injectable for tests). */
  readonly now: () => Date;
}

/**
 * Result of a coordinator step. Mirrors the repository's CAS result.
 */
export interface StepResult {
  readonly applied: boolean;
  readonly state: WorkplaceState;
  readonly revision: number;
}

export class ProductionCellCoordinator {
  constructor(private readonly deps: ProductionCellCoordinatorDeps) {}

  // -----------------------------------------------------------------------
  // Step 1: Materialize.
  // -----------------------------------------------------------------------

  /**
   * Materialize a new Workplace at todo/idle. Idempotent on WorkplaceRef
   * (REG-04-AC-03).
   */
  materializeCell(input: {
    processRunId: number;
    moduleRef: string;
    productionCellId: string;
    workKey?: string;
  }): WorkplaceState {
    return this.deps.workplaceRepo.materialize(input);
  }

  // -----------------------------------------------------------------------
  // Step 2: Admit work.
  // -----------------------------------------------------------------------

  /**
   * Admit the workplace into the queue: todo/idle → in_progress/queued.
   * REG-28: the Kanban phase advances from todo to in_progress.
   */
  admitWork(ref: WorkplaceRef): StepResult {
    return this.applyEvent(ref, { kind: 'work-admitted' });
  }

  // -----------------------------------------------------------------------
  // Step 4: Seal CandidateSet.
  // -----------------------------------------------------------------------

  /**
   * Seal the worker's CandidateSet and transition to verifying.
   *
   * The caller (the `execution_complete` handler) passes the ProductRefs the
   * worker produced. The coordinator records them and transitions
   * running → verifying. The actual CandidateSet seal (immutable member set)
   * is done by the CandidateSetRepository — the coordinator triggers it.
   */
  sealCandidateSet(ref: WorkplaceRef): StepResult {
    const actors = this.deps.workplaceRepo.readActiveActors(ref);
    return this.applyEvent(ref, { kind: 'candidate-sealed' }, {
      activeReservationRef: actors?.activeReservationRef ?? null,
    });
  }

  // -----------------------------------------------------------------------
  // Step 5: Apply gate decision.
  // -----------------------------------------------------------------------

  /**
   * Apply a gate decision to the workplace.
   *
   * Maps the GateDecision verdict to a ProductionCellEvent and applies it:
   *   - accepted (final) → gate-author-accepted-final → done/terminal
   *   - accepted (author, with review) → gate-author-accepted-with-review → review/queued
   *   - repair_required → gate-repair-required → repair_wait
   *   - human_required → human-required → blocked/paused
   *   - failed → gate-failed → failed/terminal
   */
  applyGateDecision(
    ref: WorkplaceRef,
    decision: {
      verdict: 'accepted' | 'repair_required' | 'human_required' | 'failed';
      isFinal: boolean;
      repairTargetRole?: NextRole;
    },
  ): StepResult {
    let event: ProductionCellEvent;
    switch (decision.verdict) {
      case 'accepted':
        event = decision.isFinal
          ? { kind: 'gate-author-accepted-final' }
          : { kind: 'gate-author-accepted-with-review' };
        break;
      case 'repair_required':
        if (!decision.repairTargetRole) {
          throw new Error('applyGateDecision: repair_required requires repairTargetRole');
        }
        event = { kind: 'gate-repair-required', repairTargetRole: decision.repairTargetRole };
        break;
      case 'human_required':
        event = { kind: 'human-required' };
        break;
      case 'failed':
        event = { kind: 'gate-failed' };
        break;
    }
    return this.applyEvent(ref, event!);
  }

  /**
   * Apply the FINAL gate's decision after the reviewer phase.
   *
   * This is the review-phase counterpart of {@link applyGateDecision}: when a
   * cell declares a reviewer, the final gate runs over the author set WITH
   * reviewer evidence while the Workplace is in `review_in_progress/verifying`.
   * The reducer distinguishes the two acceptance paths:
   *   - `gate-author-accepted-final` requires `in_progress/verifying` (no
   *     reviewer was declared).
   *   - `reviewer-verdict(accepted)` requires `review_in_progress/verifying`
   *     (the reviewer just finished).
   *
   * Mapping the final-gate verdict to the correct event is the coordinator's
   * job (it owns the reducer vocabulary); the executor only knows the gate
   * verdict, not the loop-state vocabulary.
   *
   * Verdict mapping:
   *   - accepted → reviewer-verdict(accepted) → terminal/accepted.
   *   - repair_required → reviewer-verdict(defect-proven) → repair_wait,
   *     SEMANTIC backward transition to author (REG-28-AC-04). The caller
   *     requeues within its recovery budget.
   *   - human_required → human-required → blocked/paused.
   *   - failed → reviewer-verdict(invalid-output) → repair_wait, reviewer
   *     (the reviewer's output itself was invalid, not a proven author defect).
   */
  applyReviewerVerdict(
    ref: WorkplaceRef,
    decision: {
      verdict: 'accepted' | 'repair_required' | 'human_required' | 'failed';
      repairTargetRole?: NextRole;
    },
  ): StepResult {
    let event: ProductionCellEvent;
    switch (decision.verdict) {
      case 'accepted':
        event = { kind: 'reviewer-verdict', verdict: 'accepted' };
        break;
      case 'repair_required':
        // Proven author defect → return the card to author work.
        event = { kind: 'reviewer-verdict', verdict: 'defect-proven' };
        break;
      case 'failed':
        // Reviewer produced invalid output → retry the reviewer.
        event = { kind: 'reviewer-verdict', verdict: 'invalid-output' };
        break;
      case 'human_required':
        event = { kind: 'human-required' };
        break;
    }
    const result = this.applyEvent(ref, event!);
    void decision;
    return result;
  }

  // -----------------------------------------------------------------------
  // Recovery / re-queue.
  // -----------------------------------------------------------------------

  /**
   * Re-queue a workplace from repair_wait or blocked back to the queue.
   * Used after a repair round or after a human answer.
   */
  requeue(ref: WorkplaceRef, role: NextRole): StepResult {
    return this.applyEvent(ref, { kind: 'repair-requeued', role });
  }

  /**
   * Record a worker crash (running → repair_wait). Kanban UNCHANGED.
   */
  recordWorkerCrash(ref: WorkplaceRef): StepResult {
    return this.applyEvent(ref, { kind: 'worker-crashed' });
  }

  // -----------------------------------------------------------------------
  // Core: apply a reducer event via CAS.
  // -----------------------------------------------------------------------

  /**
   * Apply one ProductionCellEvent: compute the next state via the pure-domain
   * reducer, then persist via CAS on revision (REG-05-AC-06).
   *
   * Throws on NO_TRANSITION (the event does not apply to the current state).
   * Returns `{applied: false}` on a CAS miss (a concurrent writer won the
   * revision race — REG-05-AC-02, E2E-08).
   */
  private applyEvent(
    ref: WorkplaceRef,
    event: ProductionCellEvent,
    actors?: {
      activeReservationRef?: string | null;
      activeGateRef?: string | null;
      activeRecoveryCaseRef?: string | null;
    },
  ): StepResult {
    const current = this.deps.workplaceRepo.read(ref);
    if (!current) {
      throw new Error(
        `ProductionCellCoordinator: workplace ${serializeWorkplaceRef(ref)} not materialized`,
      );
    }
    // Compute the target state via the pure-domain reducer.
    const target = reduceWorkplaceEvent(current, event);
    // Persist via CAS.
    const result = this.deps.workplaceRepo.applyTransition({
      workplaceRef: ref,
      expectedRevision: current.revision,
      kanbanPhase: target.kanbanPhase,
      loopState: target.loopState,
      nextRole: target.nextRole,
      terminalReason: target.terminalReason,
      ...actors,
    });
    return {
      applied: result.applied,
      state: result.state,
      revision: result.revision,
    };
  }

  // -----------------------------------------------------------------------
  // Read helpers (for the coordinator's callers).
  // -----------------------------------------------------------------------

  /** Read the current workplace state. */
  readState(ref: WorkplaceRef): WorkplaceState | null {
    return this.deps.workplaceRepo.read(ref);
  }

  readActiveActors(ref: WorkplaceRef): {
    activeReservationRef: string | null;
    activeGateRef: string | null;
    activeRecoveryCaseRef: string | null;
  } | null {
    return this.deps.workplaceRepo.readActiveActors(ref);
  }

  /** Is this workplace terminal? */
  isTerminal(ref: WorkplaceRef): boolean {
    const state = this.deps.workplaceRepo.read(ref);
    return state?.loopState === 'terminal';
  }
}
