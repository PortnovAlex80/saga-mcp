/**
 * LifecycleRun reducer - lifecycle state, routing, terminal claims
 * verification and lifecycle settlement (WP-05; universe aggregate 2/9).
 *
 * Frozen decision D3: cancellation proofs live at the lifecycle and run
 * scopes and NAME member dispositions (plus activityAttempt.cancel and
 * TypedWaitDisposition); this reducer therefore attaches member
 * dispositions to cancellation proofs instead of issuing per-scope
 * cancellation commands. Frozen decision D4: verifyTerminalClaims is a
 * LifecycleRun-owned command (the verifier is not an author/reviewer
 * kernel role).
 */

import type { AggregateReducer, CommandGuard, MemberDisposition } from '../types.js';
import { hasEvidenceKind, hasProofKind, refuse } from './model.js';

const issueTerminalGuard: CommandGuard = (input, _head, ctx) => {
  const outcome = input.terminalOutcome;
  if (!outcome) {
    return refuse('MISSING_EVIDENCE', 'lifecycleRun.issueTerminalProof requires a terminalOutcome');
  }
  if (outcome === 'unreachable') {
    return refuse('UNIVERSE_VIOLATION', 'lifecycle-scope unreachable is not issuable in-run (D7)');
  }
  if (outcome === 'success') {
    const required = ['TerminalProof:stage.success', 'LifecycleRoutingReceipt', 'ExecutableVerifierResult', 'TerminalClaimCoverage', 'TerminalLifecycleClaim', 'ConstructionSurface'];
    for (const kind of required) {
      if (kind.startsWith('TerminalProof:')) {
        if (!hasProofKind(ctx, kind)) {
          return refuse('MISSING_EVIDENCE', `${kind} proof is required before lifecycle success may commit`);
        }
      } else if (!hasEvidenceKind(ctx, kind)) {
        return refuse('MISSING_EVIDENCE', `${kind} is required before lifecycle success may commit`);
      }
    }
    return { requiredEvidenceKinds: ['LifecycleRoutingReceipt', 'ExecutableVerifierResult', 'TerminalClaimCoverage', 'TerminalLifecycleClaim', 'ConstructionSurface'] };
  }
  if (outcome === 'truthful-failure') {
    if (!hasProofKind(ctx, 'TerminalProof:stage.truthful-failure')) {
      return refuse('MISSING_EVIDENCE', 'TerminalProof:stage.failure is required before lifecycle failure may commit');
    }
    return { requiredEvidenceKinds: [] };
  }
  return refuse('UNIVERSE_VIOLATION', 'cancellation is issued by lifecycleRun.cancel (D3), not by issueTerminalProof');
};

/** D3 cancellation: the proof names member dispositions; empty work is not a proof. */
const cancelGuard: CommandGuard = (input, _head, ctx) => {
  if (!hasEvidenceKind(ctx, 'OperatorStopCommand')) {
    return refuse('MISSING_EVIDENCE', 'OperatorStopCommand is required before lifecycle cancellation may commit');
  }
  const members: readonly MemberDisposition[] = [
    { memberRef: `${input.instanceId}#stages`, disposition: 'cancelled' },
    { memberRef: `${input.instanceId}#attempts`, disposition: 'cancelled' },
  ];
  return { requiredEvidenceKinds: ['OperatorStopCommand'], memberDispositions: members };
};

const verifyClaimsGuard: CommandGuard = (_input, _head, ctx) =>
  hasEvidenceKind(ctx, 'TerminalLifecycleClaim') && hasEvidenceKind(ctx, 'ConstructionSurface')
    ? { requiredEvidenceKinds: ['TerminalLifecycleClaim', 'ConstructionSurface'] }
    : refuse('MISSING_EVIDENCE', 'TerminalLifecycleClaim and ConstructionSurface are required before verifyTerminalClaims');

export const LifecycleRunReducer: AggregateReducer = {
  aggregate: 'LifecycleRun',
  ownedCommands: [
    'lifecycleRun.create',
    'lifecycleRun.createContinuation',
    'lifecycleRun.routeOutcome',
    'lifecycleRun.issueTerminalProof',
    'lifecycleRun.cancel',
    'lifecycleRun.verifyTerminalClaims',
  ],
  initialStatus: 'created',
  statuses: [
    'created',
    'continuation-created',
    'outcome-routed',
    'claims-verified',
    'terminal',
  ],
  terminalStatuses: ['terminal'],
  transitions: [
    { command: 'lifecycleRun.create', fromStatuses: [], toStatus: 'created', terminal: false },
    { command: 'lifecycleRun.createContinuation', fromStatuses: [], toStatus: 'continuation-created', terminal: false },
    { command: 'lifecycleRun.routeOutcome', fromStatuses: ['created', 'continuation-created', 'outcome-routed'], toStatus: 'outcome-routed', terminal: false, applies: (input) => input.stageRoute === 'initial-discovery', obligations: ['obligation:enterStage.initial-discovery'] },
    { command: 'lifecycleRun.routeOutcome', fromStatuses: ['created', 'continuation-created', 'outcome-routed'], toStatus: 'outcome-routed', terminal: false, applies: (input) => input.stageRoute === 'solution-formalization', obligations: ['obligation:enterStage.solution-formalization'] },
    { command: 'lifecycleRun.routeOutcome', fromStatuses: ['created', 'continuation-created', 'outcome-routed'], toStatus: 'outcome-routed', terminal: false, applies: (input) => input.stageRoute === 'solution-development', obligations: ['obligation:enterStage.solution-development'] },
    { command: 'lifecycleRun.routeOutcome', fromStatuses: ['created', 'continuation-created', 'outcome-routed'], toStatus: 'outcome-routed', terminal: false, applies: (input) => input.stageRoute === 'delivery-release', obligations: ['obligation:enterStage.delivery-release'] },
    { command: 'lifecycleRun.routeOutcome', fromStatuses: ['created', 'continuation-created', 'outcome-routed'], toStatus: 'outcome-routed', terminal: false, applies: (input) => input.stageRoute === 'verify-terminal-claims', obligations: ['obligation:verifyTerminalClaims'] },
    { command: 'lifecycleRun.verifyTerminalClaims', fromStatuses: ['outcome-routed'], toStatus: 'claims-verified', terminal: false },
    { command: 'lifecycleRun.issueTerminalProof', fromStatuses: ['outcome-routed', 'claims-verified'], toStatus: 'terminal', terminal: true },
    { command: 'lifecycleRun.cancel', fromStatuses: ['created', 'continuation-created', 'outcome-routed', 'claims-verified'], toStatus: 'terminal', terminal: true },
  ],
  guards: {
    'lifecycleRun.issueTerminalProof': issueTerminalGuard,
    'lifecycleRun.cancel': cancelGuard,
    'lifecycleRun.verifyTerminalClaims': verifyClaimsGuard,
  },
};
