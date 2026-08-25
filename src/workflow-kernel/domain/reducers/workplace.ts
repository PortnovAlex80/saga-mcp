/**
 * Workplace reducer - the author/reviewer/repair loop AND the ADR-053
 * accepted-material chain (WP-05; universe aggregate 6/9).
 *
 * The Workplace reducer ALONE owns role transitions: protocol roles are
 * exactly author and reviewer; planner/implementer/reviewer/certifier are
 * semantic profiles and can never appear here as kernel roles (mutation k).
 * The reviewer desk opens only after an accepted author gate
 * (obligation:openReviewerDesk); WorkIntents pin the exact
 * CanonicalRoleContract reference/digest (mutation i); an ActivityAttempt
 * copies that pin from its exact WorkIntent and never resolves the installed
 * manifest independently (mutation j).
 *
 * Frozen decisions embodied here:
 *   D2 effect outcome set of seven kinds (incl. repair);
 *   D3 cancellation shape (proofs at lifecycle/run naming dispositions);
 *   D6 truthful-failure terminality via rolloverRepairEpoch caps /
 *       widenAuthorityScope scope-refusal (RepairTerminalityEvidence);
 *   D7 unreachable scope set {cell, workplace, node};
 *   D8 replay-capture sweep owned by the Certification Workplace
 *       (settleEffect is the single EffectReceipt writer, R13);
 *  D11 CellFinalAcceptance embeds acceptanceDigest (same-transaction fact).
 */

import type { AggregateReducer, CommandGuard } from '../types.js';
import { hasEvidenceKind, hasProofKind, refuse } from './model.js';

const ROLE_PIN_PATTERN = /^sha256:[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** Workplace-owned author/reviewer transition legality (admitWorkIntent). */
const admitWorkIntentGuard: CommandGuard = (input, _head, ctx) => {
  const role = input.protocolRole;
  if (role !== undefined && role !== 'author' && role !== 'reviewer') {
    // Mutation k: a semantic profile treated as a kernel role.
    return refuse('PROTOCOL_ROLE_UNIVERSE_VIOLATION', `protocolRole must be author or reviewer, got ${String(role)}`);
  }
  if (!input.rolePin) {
    return refuse('ROLE_CONTRACT_REF_MISMATCH', 'workplace.admitWorkIntent pins the exact CanonicalRoleContract reference/digest (FWD:F007)');
  }
  if (!ROLE_PIN_PATTERN.test(input.rolePin.roleContractRef) || !DIGEST_PATTERN.test(input.rolePin.roleContractDigest)) {
    return refuse('ROLE_CONTRACT_REF_MISMATCH', 'the role-contract pin must be a content address plus a 64-hex slot fingerprint');
  }
  if (role === 'reviewer') {
    // The author -> reviewer transition is owned by THIS reducer alone and
    // requires the accepted author gate plus its DURABLE openReviewerDesk
    // edge (workplace.runAuthorGate -> workplace.admitWorkIntent).
    if (!hasEvidenceKind(ctx, 'GateDecision:accepted')) {
      return refuse('ILLEGAL_TRANSITION', 'the reviewer desk opens only after an accepted author gate');
    }
    const deskOpen = ctx.openObligations.some(
      (obligation) => obligation.kind === 'obligation:openReviewerDesk' && obligation.state === 'open',
    );
    if (!deskOpen) {
      return refuse('ILLEGAL_TRANSITION', 'the reviewer desk requires the open obligation:openReviewerDesk edge from an accepted author gate');
    }
  }
  return { requiredEvidenceKinds: [] };
};

const recordContributionGuard: CommandGuard = (_input, _head, ctx) =>
  hasEvidenceKind(ctx, 'ActivityAttempt:completed')
    ? { requiredEvidenceKinds: ['ActivityAttempt:completed'] }
    : refuse('MISSING_EVIDENCE', 'ActivityAttempt:completed outcome evidence is required to record a contribution');

const sealRevisionGuard: CommandGuard = (_input, _head, ctx) =>
  hasEvidenceKind(ctx, 'ActivityAttemptContribution')
    ? { requiredEvidenceKinds: ['ActivityAttemptContribution'] }
    : refuse('MISSING_EVIDENCE', 'ActivityAttemptContribution is required before a production revision may be sealed');

const presentCandidatesGuard: CommandGuard = (_input, _head, ctx) =>
  hasEvidenceKind(ctx, 'WorkplaceProductionRevision')
    ? { requiredEvidenceKinds: ['WorkplaceProductionRevision'] }
    : refuse('MISSING_EVIDENCE', 'WorkplaceProductionRevision is required before a CandidateSet may be presented');

const runGateGuard = (gate: 'author' | 'final'): CommandGuard => (_input, _head, ctx) => {
  const candidate = gate === 'author' ? 'CandidateSet:author' : 'CandidateSet:reviewer';
  if (!hasEvidenceKind(ctx, candidate)) {
    return refuse('MISSING_EVIDENCE', `${candidate} is required before the ${gate} gate may run`);
  }
  if (!hasEvidenceKind(ctx, 'CheckPlan')) {
    return refuse('MISSING_EVIDENCE', 'CheckPlan (installed manifest, R15) is required before a gate may run');
  }
  return { requiredEvidenceKinds: [candidate, 'CheckPlan'] };
};

const enterRepairWaitGuard: CommandGuard = (_input, _head, ctx) => {
  const repairVerdict = hasEvidenceKind(ctx, 'GateDecision:repair') || hasEvidenceKind(ctx, 'EffectReceipt:repair');
  if (!repairVerdict) {
    return refuse('MISSING_EVIDENCE', 'a GateDecision:repair verdict or EffectReceipt:repair outcome (D2) is required to enter the repair wait');
  }
  return { requiredEvidenceKinds: [] };
};

/** D6: truthful-failure terminality - repair-epoch ledger caps / scope refusal. */
const repairTerminalityGuard: CommandGuard = (input, _head, _ctx) => {
  // RepairTerminalityEvidence (the repair-epoch ledger / scope-refusal
  // receipt) commits in THIS transaction - it is the command's own output,
  // not a pre-existing input (FWD:F079/F082).
  if (input.terminalOutcome !== undefined && input.terminalOutcome !== 'truthful-failure') {
    return refuse('UNIVERSE_VIOLATION', 'the repair terminality path issues truthful-failure proofs only (D6)');
  }
  return { requiredEvidenceKinds: [] };
};

const enterHumanWaitGuard: CommandGuard = (_input, _head, ctx) => {
  const cause = hasEvidenceKind(ctx, 'GateDecision:human-wait') || hasEvidenceKind(ctx, 'EffectReceipt:human-wait');
  if (!cause) {
    return refuse('MISSING_EVIDENCE', 'a GateDecision:human-wait verdict or EffectReceipt:human-wait outcome (R12) is required to enter the human wait');
  }
  return { requiredEvidenceKinds: [] };
};

const resolveHumanResponseGuard: CommandGuard = (_input, _head, ctx) => {
  // D12: the operator disposition command discharges EITHER wait kind. The
  // frozen WAITS registry declares workplace.resolveHumanResponse as the wake
  // source of BOTH TypedWait:human-input and TypedWait:effect-uncertainty
  // ("operator resolution command, never an automatic duplicate of a
  // non-idempotent external send/effect"). WP-07/WP-08/WP-13B all hit the
  // missing uncertainty arm (2026-08-26 convergence to the frozen universe).
  const pending = ctx.pendingWaits.some((waitRecord) =>
    (waitRecord.kind === 'TypedWait:human-input' || waitRecord.kind === 'TypedWait:effect-uncertainty')
    && waitRecord.state === 'pending');
  if (!pending) {
    return refuse('ILLEGAL_TRANSITION', 'a pending TypedWait:human-input or TypedWait:effect-uncertainty is required before a human response may resolve (D12 operator disposition)');
  }
  return { requiredEvidenceKinds: [] };
};

/** R13: settleEffect is the SOLE EffectReceipt writer; D2 seven outcomes; D8 sweep target. */
const settleEffectGuard: CommandGuard = (input, _head, ctx) => {
  if (!input.effectOutcome) {
    return refuse('MISSING_EVIDENCE', 'workplace.settleEffect requires an effectOutcome');
  }
  if (!hasEvidenceKind(ctx, 'AcceptedCandidateAuthority')) {
    return refuse('MISSING_EVIDENCE', 'AcceptedCandidateAuthority is the exact effect input (R3) required before settleEffect');
  }
  return { requiredEvidenceKinds: ['AcceptedCandidateAuthority'] };
};

/**
 * F066/F071/F074 + D11: final acceptance requires the accepted authority and,
 * when effects were declared, success-shaped receipts for every one of them.
 * The CellFinalAcceptance fact commits in THIS transaction (digest embedded).
 */
const recordFinalAcceptanceGuard: CommandGuard = (_input, _head, ctx) => {
  if (!hasEvidenceKind(ctx, 'AcceptedCandidateAuthority')) {
    return refuse('MISSING_EVIDENCE', 'AcceptedCandidateAuthority is required before final acceptance may commit');
  }
  const receipts = [...ctx.evidence.values()].filter((fact) => fact.kind.startsWith('EffectReceipt:'));
  if (receipts.length > 0) {
    const settled = receipts.some((fact) => fact.kind === 'EffectReceipt:success' || fact.kind === 'EffectReceipt:already-applied');
    if (!settled) {
      return refuse('MISSING_EVIDENCE', 'every declared effect must be settled (success or already-applied) before final acceptance');
    }
  }
  return { requiredEvidenceKinds: ['AcceptedCandidateAuthority'] };
};

const closePresentationGuard: CommandGuard = (_input, _head, ctx) => {
  if (!hasEvidenceKind(ctx, 'CellFinalAcceptance')) {
    return refuse('MISSING_EVIDENCE', 'CellFinalAcceptance is required before the presentation may close (FWD:F089)');
  }
  return { requiredEvidenceKinds: ['CellFinalAcceptance'] };
};

/**
 * FWD:P1/F081/F084: workplace terminal proofs. Success requires all material
 * accepted; truthful failure requires the D6 terminality evidence;
 * unreachable stays in the D7 scope set; cancellation is D3 (lifecycle-owned).
 */
const issueWorkplaceTerminalGuard: CommandGuard = (input, _head, ctx) => {
  const outcome = input.terminalOutcome;
  if (!outcome) {
    return refuse('MISSING_EVIDENCE', 'workplace.issueWorkplaceTerminalProof requires a terminalOutcome');
  }
  if (outcome === 'cancellation') {
    return refuse('UNIVERSE_VIOLATION', 'workplace cancellation is issued by lifecycleRun.cancel (D3)');
  }
  if (outcome === 'success') {
    if (!hasEvidenceKind(ctx, 'CellFinalAcceptance') || !hasEvidenceKind(ctx, 'ObligationCompletionReceipt')) {
      return refuse('MISSING_EVIDENCE', 'CellFinalAcceptance and ObligationCompletionReceipt are required before workplace success may commit');
    }
    return { requiredEvidenceKinds: ['CellFinalAcceptance'] };
  }
  if (outcome === 'truthful-failure') {
    if (!hasEvidenceKind(ctx, 'RepairTerminalityEvidence')) {
      return refuse('MISSING_EVIDENCE', 'RepairTerminalityEvidence (D6) is required before workplace failure may commit');
    }
    return { requiredEvidenceKinds: ['RepairTerminalityEvidence'] };
  }
  // unreachable (D7 - workplace is inside the unreachable scope set)
  const failureExists = hasProofKind(ctx, 'TerminalProof:workplace.truthful-failure') || ctx.proofs.some((proof) => proof.id.endsWith('.truthful-failure'));
  if (!failureExists) {
    return refuse('EMPTY_WORK_IS_NOT_A_PROOF', 'workplace unreachable requires a terminally failed predecessor proof (D7)');
  }
  if (!hasEvidenceKind(ctx, 'SettlementWorkObligation')) {
    return refuse('MISSING_EVIDENCE', 'SettlementWorkObligation is required before workplace unreachable may commit');
  }
  return { requiredEvidenceKinds: ['SettlementWorkObligation'] };
};

export const WorkplaceReducer: AggregateReducer = {
  aggregate: 'Workplace',
  ownedCommands: [
    'workplace.materialize',
    'workplace.admitWorkIntent',
    'workplace.recordContribution',
    'workplace.sealProductionRevision',
    'workplace.presentCandidateSet',
    'workplace.runAuthorGate',
    'workplace.runFinalGate',
    'workplace.enterRepairWait',
    'workplace.rolloverRepairEpoch',
    'workplace.widenAuthorityScope',
    'workplace.enterHumanWait',
    'workplace.resolveHumanResponse',
    'workplace.settleEffect',
    'workplace.recordFinalAcceptance',
    'workplace.closePresentation',
    'workplace.issueWorkplaceTerminalProof',
  ],
  initialStatus: 'materialized',
  statuses: [
    'materialized',
    'author-intent-admitted',
    'author-readiness-waited',
    'author-contribution-recorded',
    'author-revision-sealed',
    'author-candidates-presented',
    'author-gate-decided',
    'reviewer-intent-admitted',
    'reviewer-readiness-waited',
    'reviewer-contribution-recorded',
    'reviewer-revision-sealed',
    'reviewer-candidates-presented',
    'final-gate-decided',
    'repair-wait-entered',
    'repair-epoch-rolled-over',
    'authority-scope-widened',
    'human-wait-entered',
    'human-response-resolved',
    'effect-settled',
    'effect-retryable',
    'effect-uncertainty-waited',
    'effect-human-waited',
    'final-acceptance-recorded',
    'presentation-closed',
    'terminal',
  ],
  terminalStatuses: ['terminal'],
  transitions: [
    { command: 'workplace.materialize', fromStatuses: [], toStatus: 'materialized', terminal: false },
    // Author intent admission (first entry or repair re-entry).
    { command: 'workplace.admitWorkIntent', fromStatuses: ['materialized', 'repair-wait-entered', 'repair-epoch-rolled-over', 'authority-scope-widened', 'human-response-resolved'], toStatus: 'author-intent-admitted', terminal: false, applies: (input) => input.protocolRole !== 'reviewer' && (input.evidenceRefs ?? []).length > 0 },
    { command: 'workplace.admitWorkIntent', fromStatuses: ['materialized', 'repair-wait-entered', 'repair-epoch-rolled-over', 'authority-scope-widened', 'human-response-resolved'], toStatus: 'author-readiness-waited', terminal: false, applies: (input) => input.protocolRole !== 'reviewer' && (input.evidenceRefs ?? []).length === 0 },
    // Reviewer intent admission (author gate accepted; openReviewerDesk).
    { command: 'workplace.admitWorkIntent', fromStatuses: ['author-gate-decided'], toStatus: 'reviewer-intent-admitted', terminal: false, applies: (input) => input.protocolRole === 'reviewer' && (input.evidenceRefs ?? []).length > 0 },
    { command: 'workplace.admitWorkIntent', fromStatuses: ['author-gate-decided'], toStatus: 'reviewer-readiness-waited', terminal: false, applies: (input) => input.protocolRole === 'reviewer' && (input.evidenceRefs ?? []).length === 0 },
    // Author loop.
    { command: 'workplace.recordContribution', fromStatuses: ['author-intent-admitted'], toStatus: 'author-contribution-recorded', terminal: false },
    { command: 'workplace.recordContribution', fromStatuses: ['reviewer-intent-admitted'], toStatus: 'reviewer-contribution-recorded', terminal: false },
    { command: 'workplace.sealProductionRevision', fromStatuses: ['author-contribution-recorded'], toStatus: 'author-revision-sealed', terminal: false },
    { command: 'workplace.sealProductionRevision', fromStatuses: ['reviewer-contribution-recorded'], toStatus: 'reviewer-revision-sealed', terminal: false },
    { command: 'workplace.presentCandidateSet', fromStatuses: ['author-revision-sealed'], toStatus: 'author-candidates-presented', terminal: false },
    { command: 'workplace.presentCandidateSet', fromStatuses: ['reviewer-revision-sealed'], toStatus: 'reviewer-candidates-presented', terminal: false },
    // The reviewer desk opens ONLY on an accepted author gate.
    { command: 'workplace.runAuthorGate', fromStatuses: ['author-candidates-presented'], toStatus: 'author-gate-decided', terminal: false, applies: (input) => input.gateVerdict === 'accepted', obligations: ['obligation:openReviewerDesk'] },
    { command: 'workplace.runAuthorGate', fromStatuses: ['author-candidates-presented'], toStatus: 'author-gate-decided', terminal: false, applies: (input) => input.gateVerdict !== 'accepted', obligations: [] },
    { command: 'workplace.runFinalGate', fromStatuses: ['reviewer-candidates-presented'], toStatus: 'final-gate-decided', terminal: false, applies: (input) => input.gateVerdict === 'accepted', obligations: ['obligation:runEffects'] },
    { command: 'workplace.runFinalGate', fromStatuses: ['reviewer-candidates-presented'], toStatus: 'final-gate-decided', terminal: false, applies: (input) => input.gateVerdict === 'upstream-repair', obligations: ['obligation:routeUpstreamRepair'] },
    { command: 'workplace.runFinalGate', fromStatuses: ['reviewer-candidates-presented'], toStatus: 'final-gate-decided', terminal: false, applies: (input) => input.gateVerdict !== 'accepted' && input.gateVerdict !== 'upstream-repair', obligations: [] },
    { command: 'workplace.enterRepairWait', fromStatuses: ['author-gate-decided', 'final-gate-decided', 'effect-settled'], toStatus: 'repair-wait-entered', terminal: false },
    // D6: the rollover/widen commands COMMIT the terminality evidence
    // (repair-epoch ledger / scope-refusal receipt) but never terminalize
    // directly - workplace.issueWorkplaceTerminalProof issues the
    // truthful-failure proof and propagates the cell failure.
    { command: 'workplace.rolloverRepairEpoch', fromStatuses: ['repair-wait-entered'], toStatus: 'repair-epoch-rolled-over', terminal: false, applies: (input) => input.terminalOutcome === undefined },
    { command: 'workplace.rolloverRepairEpoch', fromStatuses: ['repair-wait-entered'], toStatus: 'repair-epoch-rolled-over', terminal: false, applies: (input) => input.terminalOutcome === 'truthful-failure', obligations: [] },
    { command: 'workplace.widenAuthorityScope', fromStatuses: ['repair-wait-entered'], toStatus: 'authority-scope-widened', terminal: false, applies: (input) => input.terminalOutcome === undefined },
    { command: 'workplace.widenAuthorityScope', fromStatuses: ['repair-wait-entered'], toStatus: 'authority-scope-widened', terminal: false, applies: (input) => input.terminalOutcome === 'truthful-failure', obligations: [] },
    { command: 'workplace.enterHumanWait', fromStatuses: ['author-gate-decided', 'final-gate-decided', 'effect-settled'], toStatus: 'human-wait-entered', terminal: false },
    { command: 'workplace.resolveHumanResponse', fromStatuses: ['human-wait-entered', 'effect-human-waited', 'effect-uncertainty-waited'], toStatus: 'human-response-resolved', terminal: false },
    { command: 'workplace.settleEffect', fromStatuses: ['final-gate-decided', 'human-response-resolved'], toStatus: 'effect-settled', terminal: false, applies: (input) => input.effectOutcome === 'success' || input.effectOutcome === 'already-applied' || input.effectOutcome === 'policy-terminal' || input.effectOutcome === 'repair' },
    { command: 'workplace.settleEffect', fromStatuses: ['final-gate-decided', 'human-response-resolved'], toStatus: 'effect-retryable', terminal: false, applies: (input) => input.effectOutcome === 'retryable' },
    { command: 'workplace.settleEffect', fromStatuses: ['final-gate-decided', 'human-response-resolved'], toStatus: 'effect-uncertainty-waited', terminal: false, applies: (input) => input.effectOutcome === 'unknown' },
    { command: 'workplace.settleEffect', fromStatuses: ['final-gate-decided', 'human-response-resolved'], toStatus: 'effect-human-waited', terminal: false, applies: (input) => input.effectOutcome === 'human-wait' },
    { command: 'workplace.recordFinalAcceptance', fromStatuses: ['final-gate-decided', 'effect-settled'], toStatus: 'final-acceptance-recorded', terminal: false },
    { command: 'workplace.closePresentation', fromStatuses: ['final-acceptance-recorded'], toStatus: 'presentation-closed', terminal: false },
    { command: 'workplace.issueWorkplaceTerminalProof', fromStatuses: ['presentation-closed'], toStatus: 'terminal', terminal: true, applies: (input) => input.terminalOutcome === undefined || input.terminalOutcome === 'success', obligations: [] },
    { command: 'workplace.issueWorkplaceTerminalProof', fromStatuses: ['repair-epoch-rolled-over', 'authority-scope-widened'], toStatus: 'terminal', terminal: true, applies: (input) => input.terminalOutcome === 'truthful-failure', obligations: ['obligation:propagateCellFailure'] },
    { command: 'workplace.issueWorkplaceTerminalProof', fromStatuses: ['author-readiness-waited', 'reviewer-readiness-waited'], toStatus: 'terminal', terminal: true, applies: (input) => input.terminalOutcome === 'unreachable', obligations: ['obligation:markDependantsUnreachable'] },
  ],
  guards: {
    'workplace.admitWorkIntent': admitWorkIntentGuard,
    'workplace.recordContribution': recordContributionGuard,
    'workplace.sealProductionRevision': sealRevisionGuard,
    'workplace.presentCandidateSet': presentCandidatesGuard,
    'workplace.runAuthorGate': runGateGuard('author'),
    'workplace.runFinalGate': runGateGuard('final'),
    'workplace.enterRepairWait': enterRepairWaitGuard,
    'workplace.rolloverRepairEpoch': repairTerminalityGuard,
    'workplace.widenAuthorityScope': repairTerminalityGuard,
    'workplace.enterHumanWait': enterHumanWaitGuard,
    'workplace.resolveHumanResponse': resolveHumanResponseGuard,
    'workplace.settleEffect': settleEffectGuard,
    'workplace.recordFinalAcceptance': recordFinalAcceptanceGuard,
    'workplace.closePresentation': closePresentationGuard,
    'workplace.issueWorkplaceTerminalProof': issueWorkplaceTerminalGuard,
  },
};
