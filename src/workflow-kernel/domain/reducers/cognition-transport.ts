/**
 * CognitionTransport boundary - the replaceable transport behind the
 * provider-send obligation (WP-05; universe aggregate 9/9).
 *
 * This is NOT an aggregate owner: it holds no mutable state, no revision and
 * no proof. The single boundary command may run only behind an open
 * obligation:providerSend with an admitted PromptAssemblyReceipt, and it
 * produces ProviderSendOutcome evidence. The admission linearization point
 * (immediately before final serialization/network send) is WP-18's owned
 * surface; the pure model only pins that a send never bypasses the admitted
 * receipt + obligation pair.
 */

import type { AggregateReducer, CommandGuard } from '../types.js';
import { hasEvidenceKind, refuse } from './model.js';

const sendGuard: CommandGuard = (_input, _head, ctx) => {
  if (!hasEvidenceKind(ctx, 'PromptAssemblyReceipt:admitted')) {
    return refuse('MISSING_EVIDENCE', 'an admitted PromptAssemblyReceipt is required immediately before any provider send');
  }
  const behindObligation = ctx.openObligations.some((obligation) => obligation.kind === 'obligation:providerSend' && obligation.state === 'open');
  if (!behindObligation) {
    return refuse('ILLEGAL_TRANSITION', 'a provider send runs only behind an open obligation:providerSend');
  }
  return { requiredEvidenceKinds: ['PromptAssemblyReceipt:admitted'] };
};

export const CognitionTransportReducer: AggregateReducer = {
  aggregate: 'CognitionTransport',
  ownedCommands: ['cognition.sendProviderRequest'],
  // Stateless replaceable boundary: the single instance is pre-seeded by the
  // engine and never changes status (not an aggregate owner).
  initialStatus: 'stateless',
  statuses: ['stateless'],
  terminalStatuses: [],
  statelessBoundary: true,
  transitions: [
    { command: 'cognition.sendProviderRequest', fromStatuses: ['stateless'], toStatus: '*', terminal: false, obligations: [] },
  ],
  guards: {
    'cognition.sendProviderRequest': sendGuard,
  },
};
