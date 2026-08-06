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
 * coordinator APPLIES it: it persists via CAS, spawns workers, seals
 * CandidateSets, runs gates, records decisions. It is the concrete component
 * that `GenericFlowExecutor` will delegate `production-cell` nodes to (step 2.5
 * wiring).
 *
 * # Lifecycle
 *
 *   1. `materializeCell` — creates the factory_workplaces row at todo/idle.
 *   2. `admitWork` — transitions todo/idle → in_progress/queued (work-admitted).
 *   3. `launchWorker` — creates ExecutionReservation, calls WorkerLauncherPort,
 *      transitions queued → leased → running.
 *   4. `sealCandidateSet` — when worker calls `execution_complete`, seal the
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
 * # Step 2.2 scope
 *
 * EXISTS and tested; nothing on the runtime path delegates to it yet (the
 * GenericFlowExecutor still uses its inline node-walking). Step 2.5 wiring
 * routes `production-cell` FlowNodes to this coordinator.
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
import type { WorkerLauncherPort, LaunchRequest } from '../../application/ports/worker-launcher-port.js';
import type { ProductRepositoryPort } from '../application/product-repository-port.js';

/**
 * Dependencies the coordinator needs.
 *
 * `launcher` and `productRepo` are OPTIONAL: they are only used by
 * {@link ProductionCellCoordinator.launchWorker}. The ADR-029 Slice 1 runtime
 * path (ProductionCellNodeExecutor) does NOT use launchWorker — it launches
 * workers through the proven WorkAssignmentPort + WorkerExecutorFactory path
 * and drives Workplace state via materialize/admit/seal/applyGateDecision. A
 * future slice may migrate launchWorker to the canonical WorkerLauncherPort,
 * at which point these become required again.
 */
export interface ProductionCellCoordinatorDeps {
  readonly db: Database.Database;
  readonly workplaceRepo: SqliteWorkplaceRepository;
  readonly launcher?: WorkerLauncherPort | null;
  readonly productRepo?: ProductRepositoryPort | null;
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
  // Step 3: Launch worker.
  // -----------------------------------------------------------------------

  /**
   * Lease + launch a worker for this workplace.
   *
   * Creates an ExecutionReservation (deterministic ref), calls the
   * WorkerLauncherPort, and applies the worker-leased + worker-started
   * transitions. Returns the PID of the launched process.
   *
   * When the workplace is in `review/queued` with `nextRole=reviewer`, the
   * Kanban phase advances to `review_in_progress` on lease (v4 §Allowed
   * channel combinations).
   */
  launchWorker(
    ref: WorkplaceRef,
    request: Omit<LaunchRequest, 'workplaceRef' | 'reservationRef'>,
  ): { pid: number | null; state: WorkplaceState } {
    if (!this.deps.launcher) {
      throw new Error(
        'ProductionCellCoordinator.launchWorker: no WorkerLauncherPort wired. '
          + 'The ADR-029 Slice 1 runtime path launches workers via '
          + 'WorkAssignmentPort + WorkerExecutorFactory (see '
          + 'ProductionCellNodeExecutor), not through this method. The '
          + 'canonical WorkerLauncherPort is wired in a later slice.',
      );
    }
    // Apply worker-leased transition (queued → leased).
    const leased = this.applyEvent(ref, { kind: 'worker-leased', reservationRef: request.fenceToken });
    if (!leased.applied) {
      throw new Error(
        `ProductionCellCoordinator.launchWorker: CAS miss on worker-leased for ${serializeWorkplaceRef(ref)}`,
      );
    }

    // Launch the process.
    const launchResult = this.deps.launcher.launch({
      ...request,
      workplaceRef: ref,
      reservationRef: request.fenceToken,
    });

    // Apply worker-started transition (leased → running).
    const started = this.applyEvent(ref, { kind: 'worker-started' });
    if (!started.applied) {
      throw new Error(
        `ProductionCellCoordinator.launchWorker: CAS miss on worker-started for ${serializeWorkplaceRef(ref)}`,
      );
    }

    return { pid: launchResult.pid, state: started.state };
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
    return this.applyEvent(ref, { kind: 'candidate-sealed' });
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
  private applyEvent(ref: WorkplaceRef, event: ProductionCellEvent): StepResult {
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

  /** Is this workplace terminal? */
  isTerminal(ref: WorkplaceRef): boolean {
    const state = this.deps.workplaceRepo.read(ref);
    return state?.loopState === 'terminal';
  }
}
