/**
 * FactoryRun reducer - run identity, pinned digests and the final run proof
 * (WP-05; universe aggregate 1/9).
 *
 * Owns exactly the seven universe commands assigned to FactoryRun. The run
 * terminal proof requires its exact evidence closure per the frozen proof
 * registry; run-scope "unreachable" is NOT issuable in-run (frozen decision
 * D7: run-scope refusals stay pre-run TypedRefusalReceipt).
 */

import type { AggregateReducer, CommandGuard } from '../types.js';
import { hasEvidenceKind, hasProofKind, refuse } from './model.js';

const runTerminalGuard: CommandGuard = (input, _head, ctx) => {
  const outcome = input.terminalOutcome;
  if (!outcome) {
    return refuse('MISSING_EVIDENCE', 'factoryRun.recordRunTerminalProof requires a terminalOutcome');
  }
  if (outcome === 'unreachable') {
    // Frozen D7: the unreachable scope set is {cell, workplace, node};
    // run-scope refusals stay pre-run TypedRefusalReceipt.
    return refuse('UNIVERSE_VIOLATION', 'run-scope unreachable is not issuable in-run (D7)');
  }
  if (outcome === 'success') {
    // ContextEnvelopeComplianceEvidence and ForwardReverseReconciliationReceipt are settlement-time predicates committing in THIS transaction (R6/R7).
    const required = ['TerminalProof:lifecycle.success', 'ProductVerificationEvidence', 'EffectReceipt:success', 'CapsuleIngressReceipt', 'TerminalClaimCoverage'];
    for (const kind of required) {
      if (kind.startsWith('TerminalProof:')) {
        if (!hasProofKind(ctx, kind)) {
          return refuse('MISSING_EVIDENCE', `${kind} proof is required before run success may commit`);
        }
      } else if (!hasEvidenceKind(ctx, kind)) {
        return refuse('MISSING_EVIDENCE', `${kind} is required before run success may commit`);
      }
    }
    return { requiredEvidenceKinds: ['ProductVerificationEvidence', 'EffectReceipt:success', 'CapsuleIngressReceipt', 'TerminalClaimCoverage'] };
  }
  if (outcome === 'truthful-failure') {
    if (!hasProofKind(ctx, 'TerminalProof:lifecycle.truthful-failure')) {
      return refuse('MISSING_EVIDENCE', 'TerminalProof:lifecycle.failure is required before run failure may commit');
    }
    if (!hasEvidenceKind(ctx, 'ProductVerificationFailure')) {
      return refuse('MISSING_EVIDENCE', 'ProductVerificationFailure is required before run failure may commit');
    }
    return { requiredEvidenceKinds: ['ProductVerificationFailure'] };
  }
  // cancellation (D3): OperatorStopCommand + TypedWaitDisposition over members
  if (!hasEvidenceKind(ctx, 'OperatorStopCommand')) {
    return refuse('MISSING_EVIDENCE', 'OperatorStopCommand is required before run cancellation may commit');
  }
  if (!hasEvidenceKind(ctx, 'TypedWaitDisposition')) {
    return refuse('MISSING_EVIDENCE', 'TypedWaitDisposition (D3 member dispositions) is required before run cancellation may commit');
  }
  return { requiredEvidenceKinds: ['OperatorStopCommand', 'TypedWaitDisposition'] };
};

export const FactoryRunReducer: AggregateReducer = {
  aggregate: 'FactoryRun',
  ownedCommands: [
    'factoryRun.bootstrap',
    'factoryRun.importCapsule',
    'factoryRun.start',
    'factoryRun.requestStop',
    'factoryRun.resume',
    'factoryRun.observeWatchdog',
    'factoryRun.recordRunTerminalProof',
  ],
  initialStatus: 'bootstrapped',
  statuses: ['bootstrapped', 'capsule-imported', 'started', 'stop-requested', 'resumed', 'terminal'],
  terminalStatuses: ['terminal'],
  transitions: [
    { command: 'factoryRun.bootstrap', fromStatuses: [], toStatus: 'bootstrapped', terminal: false },
    { command: 'factoryRun.importCapsule', fromStatuses: ['bootstrapped'], toStatus: 'capsule-imported', terminal: false },
    {
      command: 'factoryRun.start',
      fromStatuses: ['capsule-imported'],
      toStatus: 'started',
      terminal: false,
    },
    { command: 'factoryRun.requestStop', fromStatuses: ['started', 'resumed'], toStatus: 'stop-requested', terminal: false },
    { command: 'factoryRun.resume', fromStatuses: ['stop-requested'], toStatus: 'resumed', terminal: false },
    { command: 'factoryRun.observeWatchdog', fromStatuses: ['started', 'resumed', 'stop-requested'], toStatus: '*', terminal: false, applies: (input) => input.terminalOutcome === undefined, obligations: ['obligation:watchdogRestart'] },
    { command: 'factoryRun.observeWatchdog', fromStatuses: ['started', 'resumed', 'stop-requested'], toStatus: '*', terminal: false, applies: (input) => input.terminalOutcome === 'truthful-failure', obligations: ['obligation:watchdogBudgetExhausted'] },
    { command: 'factoryRun.recordRunTerminalProof', fromStatuses: ['started', 'resumed', 'stop-requested'], toStatus: 'terminal', terminal: true },
  ],
  guards: {
    'factoryRun.start': (_input, _head, ctx) =>
      hasEvidenceKind(ctx, 'CapsuleIngressReceipt')
        ? { requiredEvidenceKinds: ['CapsuleIngressReceipt'] }
        : refuse('MISSING_EVIDENCE', 'CapsuleIngressReceipt is required before factoryRun.start'),
    'factoryRun.recordRunTerminalProof': runTerminalGuard,
  },
};
