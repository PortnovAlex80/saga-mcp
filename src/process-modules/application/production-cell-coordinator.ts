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
import { SqliteAcceptedAuthorityHeadRepository } from '../../infrastructure/workplace/sqlite-accepted-authority-head-repository.js';
import {
  recordWorkplaceParkReason,
  type WorkplaceParkReason,
} from '../../infrastructure/workplace/workplace-park-reasons.js';

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
  /**
   * ADR-053 C1 — the durable current-authority pointer. Written atomically with
   * the author-gate-accept CAS transition (see applyAcceptanceEvent) so the
   * accepted author CandidateSet is an explicit fact, never reconstructed by
   * hash order / recency.
   */
  readonly authorityHeadRepo: SqliteAcceptedAuthorityHeadRepository;
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
      effectRequired?: boolean;
      /**
       * ADR-053 C1 — REQUIRED for an accepted AUTHOR gate: the exact author
       * CandidateSet that was accepted and the GateDecision key that accepted
       * it. These are written to the durable authority-head pointer ATOMICALLY
       * with the CAS transition, so the accepted author authority is an explicit
       * fact (not reconstructed by hash order / recency).
       */
      acceptedCandidateSetRef?: string;
      gateDecisionKey?: string;
      /**
       * ADR-053 C5-02 — the CURRENT workplace task at acceptance: the task whose
       * material is being accepted. Sourced by the caller (the production-cell
       * node executor) from the authoritative worker-execution→task binding
       * (readExecutionReceipt), NOT from submission.task_id (the origin process's
       * task — wrong after carry-forward) and NOT from ORDER BY t.id DESC
       * (recency — wrong in repair cycles). Written to the authority head
       * atomically with the C1 pointer so the head is the carry-forward-safe
       * task authority. Null only when no task can be resolved at the acceptance
       * site (the head records the C1 pointer but leaves task identity unbound).
       */
      acceptedAuthorTaskId?: string | null;
      /**
       * Fix-1 — REQUIRED for a `human_required` verdict: the park is recorded
       * with this reason (append-only `factory_workplace_park_reasons`) and the
       * workplace's `active_recovery_case_ref` points at it. Ignored for other
       * verdicts.
       */
      parkReason?: WorkplaceParkReason;
    },
  ): StepResult {
    let event: ProductionCellEvent;
    switch (decision.verdict) {
      case 'accepted':
        event = decision.isFinal
          ? { kind: 'gate-author-accepted-final', effectRequired: decision.effectRequired }
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
    // ADR-053 C1 — an accepted author gate records the authority head atomically
    // with the transition. The pointer is the single source of truth for "the
    // current accepted author CandidateSet", read by the reviewer subject pin,
    // reviewer projection and crash recovery — never `sets[0]` by hash order.
    // ADR-053 C5-02 — the head ALSO carries the current workplace task identity
    // (acceptedAuthorTaskId), the carry-forward-safe task binding.
    // ADR-081 (K12) — the accepted-with-head transition is NO LONGER a public
    // capability: callers cannot supply accepted material truth. Route through
    // the CommitAcceptedCandidate service (applyVerifiedAcceptance below),
    // which verifies the persisted proof before mutating.
    if (
      decision.verdict === 'accepted'
      && (decision.acceptedCandidateSetRef || decision.gateDecisionKey)
    ) {
      throw new Error(
        'GATE_PROOF_VERIFICATION_REQUIRED: the accepted transition is committed '
        + 'only by CommitAcceptedCandidate (ADR-081) — pass the gate decision '
        + 'key to the service, not accepted truth to the coordinator',
      );
    }
    return decision.gateDecisionKey
      ? this.applyGateEvent(ref, event!, decision.gateDecisionKey, decision.parkReason)
      : this.applyEvent(ref, event!, undefined, decision.parkReason);
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
      effectRequired?: boolean;
      gateDecisionKey?: string;
      /** Fix-1 — reason recorded with a `human_required` park. */
      parkReason?: WorkplaceParkReason;
    },
  ): StepResult {
    let event: ProductionCellEvent;
    switch (decision.verdict) {
      case 'accepted':
        event = {
          kind: 'reviewer-verdict',
          verdict: 'accepted',
          effectRequired: decision.effectRequired,
        };
        break;
      case 'repair_required':
        if (decision.repairTargetRole === 'author') {
          event = { kind: 'reviewer-verdict', verdict: 'defect-proven' };
        } else if (decision.repairTargetRole === 'reviewer') {
          event = { kind: 'reviewer-verdict', verdict: 'invalid-output' };
        } else {
          throw new Error(
            'applyReviewerVerdict: repair_required requires an explicit repairTargetRole',
          );
        }
        break;
      case 'failed':
        // Reviewer produced invalid output → retry the reviewer.
        event = { kind: 'reviewer-verdict', verdict: 'invalid-output' };
        break;
      case 'human_required':
        event = { kind: 'human-required' };
        break;
    }
    const result = decision.gateDecisionKey
      ? this.applyGateEvent(ref, event!, decision.gateDecisionKey, decision.parkReason)
      : this.applyEvent(ref, event!, undefined, decision.parkReason);
    return result;
  }

  presentCarriedForwardCandidate(ref: WorkplaceRef, presenterRef: string): StepResult {
    return this.applyEvent(ref, { kind: 'candidate-carried-forward' }, {
      activeReservationRef: presenterRef,
    });
  }

  completeAcceptanceEffect(ref: WorkplaceRef): StepResult {
    return this.applyEvent(ref, { kind: 'acceptance-effect-succeeded' });
  }

  /** Persist exact repair evidence and the Workplace CAS in one transaction. */
  requireAcceptanceEffectRepair(
    ref: WorkplaceRef,
    recordRepairEvidence?: (transition: {
      expectedWorkplaceRevision: number;
      resultingWorkplaceRevision: number;
    }) => string | null,
  ): StepResult {
    if (!recordRepairEvidence) {
      return this.applyEvent(ref, { kind: 'acceptance-effect-repair-required' });
    }
    const current = this.deps.workplaceRepo.read(ref);
    if (!current) {
      throw new Error(
        `ProductionCellCoordinator: workplace ${serializeWorkplaceRef(ref)} not materialized`,
      );
    }
    const target = reduceWorkplaceEvent(current, {
      kind: 'acceptance-effect-repair-required',
    });
    const serialized = serializeWorkplaceRef(ref);
    const result = this.deps.db.transaction(() => {
      const activeRecoveryCaseRef = recordRepairEvidence({
        expectedWorkplaceRevision: current.revision,
        resultingWorkplaceRevision: current.revision + 1,
      });
      const transitioned = this.deps.workplaceRepo.applyTransitionInTx({
        workplaceRef: ref,
        expectedRevision: current.revision,
        kanbanPhase: target.kanbanPhase,
        loopState: target.loopState,
        nextRole: target.nextRole,
        terminalReason: target.terminalReason,
        activeRecoveryCaseRef,
      }, serialized);
      if (!transitioned.applied) {
        throw new Error('CELL_EFFECT_REPAIR_WORKPLACE_CAS_MISMATCH');
      }
      return transitioned;
    }).immediate();
    return { applied: true, state: result.state, revision: result.revision };
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
    parkReason?: WorkplaceParkReason,
  ): StepResult {
    const current = this.deps.workplaceRepo.read(ref);
    if (!current) {
      throw new Error(
        `ProductionCellCoordinator: workplace ${serializeWorkplaceRef(ref)} not materialized`,
      );
    }
    // Compute the target state via the pure-domain reducer.
    const target = reduceWorkplaceEvent(current, event);
    if (!parkReason) {
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
    // Fix-1 — a park WITH a reason: the append-only reason row and the CAS
    // transition must commit together, so a parked workplace can never exist
    // without its reason (fail-closed).
    const serialized = serializeWorkplaceRef(ref);
    const result = this.deps.db.transaction(() => {
      const parkReasonRef = recordWorkplaceParkReason(this.deps.db, serialized, parkReason);
      return this.deps.workplaceRepo.applyTransitionInTx({
        workplaceRef: ref,
        expectedRevision: current.revision,
        kanbanPhase: target.kanbanPhase,
        loopState: target.loopState,
        nextRole: target.nextRole,
        terminalReason: target.terminalReason,
        ...(actors?.activeReservationRef !== undefined
          ? { activeReservationRef: actors.activeReservationRef }
          : {}),
        activeRecoveryCaseRef: parkReasonRef,
      }, serialized);
    }).immediate();
    return {
      applied: result.applied,
      state: result.state,
      revision: result.revision,
    };
  }

  /**
   * ADR-053 C1 — apply an AUTHOR-gate-accept event AND durably record the
   * accepted-author authority head in ONE IMMEDIATE transaction. The CAS
   * transition (via applyTransitionInTx, which does not open its own BEGIN) and
   * the head UPSERT commit together: the authority pointer is durable IFF the
   * acceptance transition committed. On a CAS miss (`applied:false`) the head is
   * NOT written (a concurrent writer won the race).
   *
   * ADR-053 C5-02 — the head records the CURRENT workplace task identity
   * (`acceptedAuthorTaskId`) alongside the C1 pointer, so the head is the
   * carry-forward-safe task authority (neither submission.task_id nor recency).
   */
  /**
   * ADR-081 (K12) — the ONLY accepted-with-head mutation, reachable solely
   * through the CommitAcceptedCandidate service (which verified the
   * persisted proof). One transaction: accepted CAS transition + authority
   * head + applied-decision head link.
   */
  applyVerifiedAcceptance(
    ref: WorkplaceRef,
    acceptance: { isFinal: boolean; effectRequired: boolean },
    authority: {
      acceptedAuthorCandidateSetRef: string;
      acceptedAuthorGateDecisionKey: string;
      acceptedAuthorTaskId: string | null;
    },
    expectedRevision: number,
  ): StepResult {
    const event: ProductionCellEvent = acceptance.isFinal
      ? { kind: 'gate-author-accepted-final', effectRequired: acceptance.effectRequired }
      : { kind: 'gate-author-accepted-with-review' };
    const current = this.deps.workplaceRepo.read(ref);
    if (!current) {
      throw new Error(
        `ProductionCellCoordinator: workplace ${serializeWorkplaceRef(ref)} not materialized`,
      );
    }
    if (current.revision !== expectedRevision) {
      throw new Error(
        `AUTHORITY_COMMIT_REVISION_STALE: expected ${expectedRevision}, workplace is at ${current.revision}`,
      );
    }
    const target = reduceWorkplaceEvent(current, event);
    const serialized = serializeWorkplaceRef(ref);
    const result = this.deps.db.transaction(() => {
      const r = this.deps.workplaceRepo.applyTransitionInTx(
        {
          workplaceRef: ref,
          expectedRevision: current.revision,
          kanbanPhase: target.kanbanPhase,
          loopState: target.loopState,
          nextRole: target.nextRole,
          terminalReason: target.terminalReason,
        },
        serialized,
      );
      if (r.applied) {
        this.recordAppliedGateDecisionHead(
          serialized,
          authority.acceptedAuthorGateDecisionKey,
          current.revision,
        );
        // K13 (card commit 2) — the head records the BYTE-IDENTICAL accepted
        // identity, loaded from the persisted chain INSIDE this transaction:
        // the decision's frozen check plan + installation digest, the subject
        // CandidateSet's production revision, and its members in ordinal
        // order. The CAS baseline is the revision this commit was fenced on.
        // The chain is resolved from the DECISION alone (its subject is the
        // persisted truth; the claimed ref was already proven equal by the
        // acceptance service — ADR-081).
        const identity = this.readAcceptedIdentity(
          serialized,
          authority.acceptedAuthorGateDecisionKey,
        );
        this.deps.authorityHeadRepo.record({
          workplaceRef: serialized,
          acceptedAuthorCandidateSetRef: authority.acceptedAuthorCandidateSetRef,
          acceptedAuthorGateDecisionKey: authority.acceptedAuthorGateDecisionKey,
          revision: r.revision,
          acceptedAuthorTaskId: authority.acceptedAuthorTaskId,
          checkPlanDigest: identity.checkPlanDigest,
          packageFingerprint: identity.packageFingerprint,
          productionRevisionRef: identity.productionRevisionRef,
          productRefs: identity.productRefs,
          baselineWorkplaceRevision: current.revision,
          now: this.deps.now,
        });
      }
      return r;
    }).immediate();
    return {
      applied: result.applied,
      state: result.state,
      revision: result.revision,
    };
  }

  /**
   * K13 — load the exact accepted-material identity for the head from the
   * persisted chain (GateDecision -> subject CandidateSet -> members). The
   * chain is keyed by the persisted decision; no caller-supplied material
   * truth participates. Fails closed when the chain is incomplete: a head
   * may not be recorded with a fabricated identity dimension.
   */
  private readAcceptedIdentity(
    workplaceRef: string,
    gateDecisionKey: string,
  ): {
    readonly checkPlanDigest: string;
    readonly packageFingerprint: string;
    readonly productionRevisionRef: string;
    readonly productRefs: readonly string[];
  } {
    const chain = this.deps.db.prepare(
      `SELECT gd.check_plan_digest, gd.installation_digest,
              gd.subject_candidate_set_ref, cs.production_revision_ref
         FROM factory_gate_decisions gd
         JOIN factory_candidate_sets cs
           ON cs.candidate_set_ref = gd.subject_candidate_set_ref
          AND cs.workplace_ref = gd.workplace_ref
        WHERE gd.decision_key=? AND gd.workplace_ref=?`,
    ).get(gateDecisionKey, workplaceRef) as {
      check_plan_digest: string;
      installation_digest: string;
      subject_candidate_set_ref: string;
      production_revision_ref: string;
    } | undefined;
    if (!chain || !chain.production_revision_ref) {
      throw new Error(
        `AUTHORITY_COMMIT_IDENTITY_UNRESOLVED: ${gateDecisionKey} does not resolve `
        + `an accepted CandidateSet chain for ${workplaceRef}`,
      );
    }
    const members = this.deps.db.prepare(
      `SELECT product_ref
         FROM factory_candidate_set_members
        WHERE candidate_set_ref=?
        ORDER BY ordinal`,
    ).all(chain.subject_candidate_set_ref) as Array<{ product_ref: string }>;
    if (members.length === 0) {
      throw new Error(
        `AUTHORITY_COMMIT_IDENTITY_UNRESOLVED: ${chain.subject_candidate_set_ref} has no members to bind ProductRefs`,
      );
    }
    return {
      checkPlanDigest: chain.check_plan_digest,
      packageFingerprint: chain.installation_digest,
      productionRevisionRef: chain.production_revision_ref,
      productRefs: members.map(member => member.product_ref),
    };
  }

  private applyGateEvent(
    ref: WorkplaceRef,
    event: ProductionCellEvent,
    gateDecisionKey: string,
    parkReason?: WorkplaceParkReason,
  ): StepResult {
    const current = this.deps.workplaceRepo.read(ref);
    if (!current) {
      throw new Error(
        `ProductionCellCoordinator: workplace ${serializeWorkplaceRef(ref)} not materialized`,
      );
    }
    const target = reduceWorkplaceEvent(current, event);
    const serialized = serializeWorkplaceRef(ref);
    const result = this.deps.db.transaction(() => {
      // Fix-1 — record the park reason INSIDE the same transaction as the
      // head-recorded transition so the decision head, the reason row and the
      // paused state are one atomic fact.
      const parkReasonRef = parkReason
        ? recordWorkplaceParkReason(this.deps.db, serialized, parkReason)
        : null;
      const transitioned = this.deps.workplaceRepo.applyTransitionInTx({
        workplaceRef: ref,
        expectedRevision: current.revision,
        kanbanPhase: target.kanbanPhase,
        loopState: target.loopState,
        nextRole: target.nextRole,
        terminalReason: target.terminalReason,
        ...(parkReasonRef !== null ? { activeRecoveryCaseRef: parkReasonRef } : {}),
      }, serialized);
      if (transitioned.applied) {
        this.recordAppliedGateDecisionHead(serialized, gateDecisionKey, current.revision);
      }
      return transitioned;
    }).immediate();
    return { applied: result.applied, state: result.state, revision: result.revision };
  }

  private recordAppliedGateDecisionHead(
    workplaceRef: string,
    decisionKey: string,
    expectedWorkplaceRevision: number,
  ): void {
    const decision = this.deps.db.prepare(
      `SELECT gd.decision_key,gr.expected_workplace_revision
         FROM factory_gate_decisions gd
         JOIN factory_gate_runs gr ON gr.gate_run_ref=gd.gate_run_ref
        WHERE gd.decision_key=? AND gd.workplace_ref=? AND gr.workplace_ref=?`,
    ).get(decisionKey, workplaceRef, workplaceRef) as {
      decision_key: string;
      expected_workplace_revision: number;
    } | undefined;
    if (!decision || decision.expected_workplace_revision !== expectedWorkplaceRevision) {
      throw new Error(`GATE_DECISION_HEAD_AUTHORITY_MISMATCH: ${decisionKey}`);
    }
    this.deps.db.prepare(
      `INSERT INTO factory_workplace_gate_decision_heads
         (workplace_ref,decision_key,expected_workplace_revision)
       VALUES (?,?,?)
       ON CONFLICT(workplace_ref) DO UPDATE SET
         decision_key=excluded.decision_key,
         expected_workplace_revision=excluded.expected_workplace_revision,
         recorded_at=datetime('now')
       WHERE excluded.expected_workplace_revision
             > factory_workplace_gate_decision_heads.expected_workplace_revision`,
    ).run(workplaceRef, decisionKey, expectedWorkplaceRevision);
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
