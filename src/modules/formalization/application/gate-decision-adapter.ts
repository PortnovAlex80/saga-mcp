/**
 * GateDecisionAdapter — bridge ExactCandidateAcceptance → universal GateDecision
 * (Conveyor v4 step 3.A.3).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-18 (Акт ОТК).
 *
 * # Why this adapter exists
 *
 * The existing `ExactCandidateAcceptance` (`application/exact-candidate-
 * acceptance.ts`) is a proto-`GateDecision` specialised for artifact CAS. It
 * already has:
 *   - idempotency key;
 *   - immutable decision with hash;
 *   - review-receipt binding;
 *   - lineage.
 *
 * But it only emits a binary accepted/not-accepted (the CAS either succeeds
 * or throws). v4's `GateDecision` has a CLOSED verdict:
 *   `accepted | repair_required | human_required | failed`.
 *
 * This adapter maps an ExactCandidateAcceptance decision into the universal
 * GateDecision shape, so the formalization kernel can emit decisions through
 * the universal contract that step 2's gate infrastructure reads. The adapter
 * does NOT replace ExactCandidateAcceptance — it WRAPS it, preserving the
 * proven CAS mechanics while exposing the v4 verdict surface.
 *
 * # Mapping
 *
 *   ExactCandidateAcceptance accepted     → GateDecision accepted
 *   ExactCandidateAcceptanceRejected      → GateDecision repair_required
 *                                           (the rejection code carries the
 *                                           reason; repairTargetRole=author)
 *
 * `human_required` and `failed` are NOT produced by ExactCandidateAcceptance
 * today — they come from the recovery policy / exhaustion path. The adapter
 * exposes them as a separate factory for the coordinator to use when the
 * recovery budget is exhausted.
 *
 * # Pure adapter
 *
 * No I/O. The caller passes an ExactCandidateAcceptanceDecision (or a
 * rejection); the adapter builds a GateDecision value object.
 */

import type { GateDecision, GateVerdict, RepairTargetRole } from '../../../process-modules/domain/workplace/index.js';
import type { WorkplaceRef } from '../../../process-modules/domain/workplace/index.js';

/**
 * Build a GateDecision from a successful ExactCandidateAcceptance decision.
 *
 * The ExactCandidateAcceptance succeeded → verdict=accepted. The adapter
 * fills the GateDecision shape with the decision's exact refs (idempotency
 * key → decisionKey, candidate set hash → subjectCandidateSetRef, etc.).
 *
 * `acceptedOutputBindings` is left EMPTY unless `final=true` — author-gate
 * accepted does not bind downstream output (REG-18-AC-02); only final-gate
 * accepted does (REG-18-AC-03).
 */
export function gateDecisionFromAcceptedCandidate(input: {
  workplaceRef: WorkplaceRef;
  gateRef: string;
  gateRunRef: string;
  gatePhase: 'author' | 'final';
  idempotencyKey: string;
  candidateSetHash: string;
  authority: string;
  reasonCode: string;
  decisionDigest: string;
  checkPlanRef: string;
  checkPlanDigest: string;
  decisionPolicyRef: string;
  decisionPolicyDigest: string;
  installationDigest: string;
  checkReceiptRefs: readonly string[];
  final: boolean;
  acceptedOutputBindings?: GateDecision['acceptedOutputBindings'];
}): GateDecision {
  return {
    workplaceRef: input.workplaceRef,
    gateRef: input.gateRef,
    gateRunRef: input.gateRunRef,
    gatePhase: input.gatePhase,
    transitionRef: `transition:${input.idempotencyKey}`,
    subjectCandidateSetRef: `candidate-set:${input.candidateSetHash}`,
    assessmentCandidateSetRefs: [],
    verdict: 'accepted',
    repairTargetRole: null,
    checkPlanRef: input.checkPlanRef,
    checkPlanDigest: input.checkPlanDigest,
    decisionPolicyRef: input.decisionPolicyRef,
    decisionPolicyDigest: input.decisionPolicyDigest,
    checkReceiptRefs: input.checkReceiptRefs,
    installationDigest: input.installationDigest,
    decisionKey: input.idempotencyKey,
    acceptedOutputBindings: input.final ? (input.acceptedOutputBindings ?? []) : [],
    recoveryIssueRef: null,
    decisionDigest: input.decisionDigest,
  };
}

/**
 * Build a GateDecision for `repair_required`.
 *
 * Maps an ExactCandidateAcceptance rejection (or any gate failure) to the
 * repair_required verdict. The `repairTargetRole` is mandatory (REG-18-AC-04).
 * The `recoveryIssueRef` cites the structured RecoveryIssue the repair worker
 * will read.
 */
export function gateDecisionForRepair(input: {
  workplaceRef: WorkplaceRef;
  gateRef: string;
  gateRunRef: string;
  gatePhase: 'author' | 'final';
  idempotencyKey: string;
  candidateSetHash: string;
  repairTargetRole: RepairTargetRole;
  recoveryIssueRef: string;
  checkPlanRef: string;
  checkPlanDigest: string;
  decisionPolicyRef: string;
  decisionPolicyDigest: string;
  installationDigest: string;
  checkReceiptRefs: readonly string[];
  decisionDigest: string;
}): GateDecision {
  return {
    workplaceRef: input.workplaceRef,
    gateRef: input.gateRef,
    gateRunRef: input.gateRunRef,
    gatePhase: input.gatePhase,
    transitionRef: `transition:${input.idempotencyKey}`,
    subjectCandidateSetRef: `candidate-set:${input.candidateSetHash}`,
    assessmentCandidateSetRefs: [],
    verdict: 'repair_required',
    repairTargetRole: input.repairTargetRole,
    checkPlanRef: input.checkPlanRef,
    checkPlanDigest: input.checkPlanDigest,
    decisionPolicyRef: input.decisionPolicyRef,
    decisionPolicyDigest: input.decisionPolicyDigest,
    checkReceiptRefs: input.checkReceiptRefs,
    installationDigest: input.installationDigest,
    decisionKey: input.idempotencyKey,
    acceptedOutputBindings: [],
    recoveryIssueRef: input.recoveryIssueRef,
    decisionDigest: input.decisionDigest,
  };
}

/**
 * Build a GateDecision for `human_required` (stop the line, call a person).
 *
 * REG-22: the workplace enters blocked/paused with a durable resume target.
 */
export function gateDecisionForHuman(input: {
  workplaceRef: WorkplaceRef;
  gateRef: string;
  gateRunRef: string;
  gatePhase: 'author' | 'final';
  idempotencyKey: string;
  candidateSetHash: string;
  checkPlanRef: string;
  checkPlanDigest: string;
  decisionPolicyRef: string;
  decisionPolicyDigest: string;
  installationDigest: string;
  checkReceiptRefs: readonly string[];
  decisionDigest: string;
}): GateDecision {
  return {
    workplaceRef: input.workplaceRef,
    gateRef: input.gateRef,
    gateRunRef: input.gateRunRef,
    gatePhase: input.gatePhase,
    transitionRef: `transition:${input.idempotencyKey}`,
    subjectCandidateSetRef: `candidate-set:${input.candidateSetHash}`,
    assessmentCandidateSetRefs: [],
    verdict: 'human_required',
    repairTargetRole: null,
    checkPlanRef: input.checkPlanRef,
    checkPlanDigest: input.checkPlanDigest,
    decisionPolicyRef: input.decisionPolicyRef,
    decisionPolicyDigest: input.decisionPolicyDigest,
    checkReceiptRefs: input.checkReceiptRefs,
    installationDigest: input.installationDigest,
    decisionKey: input.idempotencyKey,
    acceptedOutputBindings: [],
    recoveryIssueRef: null,
    decisionDigest: input.decisionDigest,
  };
}

/**
 * Build a GateDecision for `failed` (explicit terminal failure — recovery
 * budget exhausted, REG-20-AC-03).
 */
export function gateDecisionForFailure(input: {
  workplaceRef: WorkplaceRef;
  gateRef: string;
  gateRunRef: string;
  gatePhase: 'author' | 'final';
  idempotencyKey: string;
  candidateSetHash: string;
  checkPlanRef: string;
  checkPlanDigest: string;
  decisionPolicyRef: string;
  decisionPolicyDigest: string;
  installationDigest: string;
  checkReceiptRefs: readonly string[];
  decisionDigest: string;
}): GateDecision {
  return {
    workplaceRef: input.workplaceRef,
    gateRef: input.gateRef,
    gateRunRef: input.gateRunRef,
    gatePhase: input.gatePhase,
    transitionRef: `transition:${input.idempotencyKey}`,
    subjectCandidateSetRef: `candidate-set:${input.candidateSetHash}`,
    assessmentCandidateSetRefs: [],
    verdict: 'failed',
    repairTargetRole: null,
    checkPlanRef: input.checkPlanRef,
    checkPlanDigest: input.checkPlanDigest,
    decisionPolicyRef: input.decisionPolicyRef,
    decisionPolicyDigest: input.decisionPolicyDigest,
    checkReceiptRefs: input.checkReceiptRefs,
    installationDigest: input.installationDigest,
    decisionKey: input.idempotencyKey,
    acceptedOutputBindings: [],
    recoveryIssueRef: null,
    decisionDigest: input.decisionDigest,
  };
}

/** Type guard: is this verdict one of the four closed values? */
export function isValidGateVerdict(v: string): v is GateVerdict {
  return v === 'accepted' || v === 'repair_required' || v === 'human_required' || v === 'failed';
}
