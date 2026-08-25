/**
 * ActivityAttempt reducer - attempt lease/provenance and CAS-fenced context
 * admission counters (WP-05; universe aggregate 7/9).
 *
 * An attempt is NEVER accepted-material authority. Creation copies the exact
 * role-contract pin from its WorkIntent and atomically verifies equality
 * (mutation i: digest A paired with digest B is refused); it never resolves
 * the installed manifest independently (mutation j: there is no manifest
 * input, and any unrecognized input key is refused). The context counters
 * are CAS-fenced: admitProviderRequest advances the ordinal exactly once per
 * admitted request and a duplicate admission at the same revision is a typed
 * stale-revision refusal.
 */

import type { AggregateReducer, CommandGuard } from '../types.js';
import { refuse } from './model.js';

const createGuard: CommandGuard = (input, _head, ctx) => {
  if (!input.workIntentRef) {
    return refuse('MISSING_EVIDENCE', 'activityAttempt.create requires the exact WorkIntent reference');
  }
  const intent = ctx.workIntents.get(input.workIntentRef);
  if (!intent) {
    return refuse('FOREIGN_EVIDENCE_REF', `WorkIntent ${input.workIntentRef} was not admitted by any Workplace transition`);
  }
  if (!input.rolePin) {
    return refuse('ROLE_CONTRACT_REF_MISMATCH', 'the attempt copies the role-contract pin from its exact WorkIntent (FWD:F007)');
  }
  if (input.rolePin.roleContractRef !== intent.roleContract.roleContractRef) {
    return refuse('ROLE_CONTRACT_REF_MISMATCH', 'attempt pin ref differs from the WorkIntent pin ref');
  }
  if (input.rolePin.roleContractDigest !== intent.roleContract.roleContractDigest) {
    // Mutation i: WorkIntent role digest A paired with ActivityAttempt digest B.
    return refuse('ROLE_CONTRACT_DIGEST_MISMATCH', 'attempt pin digest differs from the exact WorkIntent pin digest');
  }
  return { requiredEvidenceKinds: [] };
};

const admitProviderRequestGuard: CommandGuard = (input, _head, _ctx) => {
  // The PromptAssemblyReceipt (admitted or refused) commits in THIS
  // transaction paired with launch admission; the request ordinal is the
  // idempotency dimension (a crash before send redrives the SAME ordinal).
  if (typeof input.expectedRevision !== 'number' || input.expectedRevision < 0) {
    return refuse('STALE_EXPECTED_REVISION', 'admitProviderRequest fences the context revision (expectedContextRevision)');
  }
  return { requiredEvidenceKinds: [] };
};

export const ActivityAttemptReducer: AggregateReducer = {
  aggregate: 'ActivityAttempt',
  ownedCommands: [
    'activityAttempt.create',
    'activityAttempt.admitProviderRequest',
    'activityAttempt.recordProviderRefusal',
    'activityAttempt.recordOutcome',
    'activityAttempt.classifyWorkerLoss',
    'activityAttempt.cancel',
  ],
  initialStatus: 'created',
  statuses: [
    'created',
    'provider-request-admitted',
    'provider-refusal-recorded',
    'outcome-recorded',
    'worker-loss-classified',
    'cancelled',
  ],
  terminalStatuses: ['outcome-recorded', 'provider-refusal-recorded', 'cancelled'],
  transitions: [
    { command: 'activityAttempt.create', fromStatuses: [], toStatus: 'created', terminal: false },
    { command: 'activityAttempt.admitProviderRequest', fromStatuses: ['created'], toStatus: 'provider-request-admitted', terminal: false },
    { command: 'activityAttempt.recordProviderRefusal', fromStatuses: ['provider-request-admitted'], toStatus: 'provider-refusal-recorded', terminal: true },
    { command: 'activityAttempt.recordOutcome', fromStatuses: ['provider-request-admitted'], toStatus: 'outcome-recorded', terminal: true },
    { command: 'activityAttempt.classifyWorkerLoss', fromStatuses: ['provider-request-admitted', 'provider-refusal-recorded'], toStatus: 'worker-loss-classified', terminal: false },
    // D3: activityAttempt.cancel is the attempt-scope member of the
    // cancellation shape (proofs live at lifecycle/run naming dispositions).
    { command: 'activityAttempt.cancel', fromStatuses: ['created', 'provider-request-admitted', 'worker-loss-classified'], toStatus: 'cancelled', terminal: true },
  ],
  guards: {
    'activityAttempt.create': createGuard,
    'activityAttempt.admitProviderRequest': admitProviderRequestGuard,
  },
};
