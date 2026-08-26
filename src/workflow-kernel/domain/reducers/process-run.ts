/**
 * ProcessRun reducer - declared module flow cursor and process settlement
 * (WP-05; universe aggregate 4/9).
 *
 * Module flows advance ONLY as kernel obligations (R17): enterNode consumes
 * the advanceProcessFlow obligation edge; settle/settleFailure are the two
 * settlement shapes. Frozen D1 keeps the processRun.settle name.
 */

import type { AggregateReducer, CommandGuard } from '../types.js';
import { hasEvidenceKind, hasProofKind, refuse } from './model.js';

const settleGuard: CommandGuard = (input, _head, ctx) => {
  const outcome = input.terminalOutcome;
  if (!outcome) {
    return refuse('MISSING_EVIDENCE', 'processRun.settle requires a terminalOutcome');
  }
  if (outcome === 'unreachable') {
    return refuse('UNIVERSE_VIOLATION', 'process-scope unreachable is not issuable in-run (D7)');
  }
  if (outcome === 'cancellation') {
    return refuse('UNIVERSE_VIOLATION', 'process cancellation is issued by lifecycleRun.cancel (D3)');
  }
  if (outcome === 'truthful-failure') {
    if (!hasProofKind(ctx, 'TerminalProof:node.truthful-failure')) {
      return refuse('MISSING_EVIDENCE', 'TerminalProof:node.failure is required before process failure may commit');
    }
    return { requiredEvidenceKinds: [] };
  }
  if (!hasProofKind(ctx, 'TerminalProof:node.success')) {
    return refuse('MISSING_EVIDENCE', 'TerminalProof:node.success is required before process success may commit');
  }
  // ProcessOutcomeCertificate commits in THIS transaction (one transaction).
  if (!hasEvidenceKind(ctx, 'ObligationCompletionReceipt')) {
    return refuse('MISSING_EVIDENCE', 'ObligationCompletionReceipt is required before process success may commit');
  }
  return { requiredEvidenceKinds: [] };
};

const settleFailureGuard: CommandGuard = (_input, _head, ctx) => {
  if (!hasProofKind(ctx, 'TerminalProof:node.truthful-failure')) {
    return refuse('MISSING_EVIDENCE', 'TerminalProof:node.failure is required before processRun.settleFailure may commit');
  }
  return { requiredEvidenceKinds: [] };
};

export const ProcessRunReducer: AggregateReducer = {
  aggregate: 'ProcessRun',
  ownedCommands: [
    'processRun.create',
    'processRun.enterNode',
    'processRun.recordNodeTerminal',
    'processRun.settle',
    'processRun.settleFailure',
  ],
  initialStatus: 'created',
  statuses: ['created', 'node-entered', 'node-terminal-recorded', 'terminal', 'settle-failed'],
  terminalStatuses: ['terminal', 'settle-failed'],
  transitions: [
    { command: 'processRun.create', fromStatuses: [], toStatus: 'created', terminal: false },
    { command: 'processRun.enterNode', fromStatuses: ['created', 'node-terminal-recorded'], toStatus: 'node-entered', terminal: false },
    // Concurrency rung (EK-11 finding EK11-CONCURRENCY-DIAMOND-SETTLEMENT, fixed
    // 2026-08-26): the process status channel is ONE lane, but the frozen
    // universe's dependency dimension REQUIRES concurrently-open nodes (fan-out,
    // cap >= 2). Recording the terminal of a second in-flight node after the
    // first terminal landed must be legal — per-node legality lives on the
    // NodeRun instances (their own guards + terminal proofs), not on this
    // channel. The serial flow (enter -> record -> enter) is unchanged.
    { command: 'processRun.recordNodeTerminal', fromStatuses: ['node-entered', 'node-terminal-recorded'], toStatus: 'node-terminal-recorded', terminal: false },
    { command: 'processRun.settle', fromStatuses: ['node-terminal-recorded'], toStatus: 'terminal', terminal: true },
    { command: 'processRun.settleFailure', fromStatuses: ['node-terminal-recorded'], toStatus: 'settle-failed', terminal: true },
  ],
  guards: {
    'processRun.settle': settleGuard,
    'processRun.settleFailure': settleFailureGuard,
  },
};
