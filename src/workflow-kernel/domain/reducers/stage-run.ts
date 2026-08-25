/**
 * StageRun reducer - one installed process module bound per stage
 * (WP-05; universe aggregate 3/9).
 *
 * stageRun.create is targeted by the enterStage.* obligations;
 * stageRun.activate binds the installed module (one per stage, R10);
 * stageRun.recordLocalOutcome settles the stage scope with an exact
 * proof and routes back to the lifecycle.
 */

import type { AggregateReducer, CommandGuard } from '../types.js';
import { hasProofKind, refuse } from './model.js';

const recordLocalOutcomeGuard: CommandGuard = (input, _head, ctx) => {
  const outcome = input.terminalOutcome;
  if (!outcome) {
    return refuse('MISSING_EVIDENCE', 'stageRun.recordLocalOutcome requires a terminalOutcome');
  }
  if (outcome === 'unreachable') {
    return refuse('UNIVERSE_VIOLATION', 'stage-scope unreachable is not issuable in-run (D7)');
  }
  if (outcome === 'cancellation') {
    return refuse('UNIVERSE_VIOLATION', 'stage cancellation is issued by lifecycleRun.cancel (D3)');
  }
  if (outcome === 'truthful-failure') {
    if (!hasProofKind(ctx, 'TerminalProof:process.truthful-failure')) {
      return refuse('MISSING_EVIDENCE', 'TerminalProof:process.failure is required before stage failure may commit');
    }
    return { requiredEvidenceKinds: [] };
  }
  if (!hasProofKind(ctx, 'TerminalProof:process.success')) {
    return refuse('MISSING_EVIDENCE', 'TerminalProof:process.success is required before stage success may commit');
  }
  if (!hasOpenObligationReceipt(ctx)) {
    return refuse('MISSING_EVIDENCE', 'ObligationCompletionReceipt is required before stage success may commit');
  }
  return { requiredEvidenceKinds: [] };
};

function hasOpenObligationReceipt(ctx: Parameters<CommandGuard>[2]): boolean {
  for (const fact of ctx.evidence.values()) {
    if (fact.kind === 'ObligationCompletionReceipt') return true;
  }
  return false;
}

export const StageRunReducer: AggregateReducer = {
  aggregate: 'StageRun',
  ownedCommands: ['stageRun.create', 'stageRun.activate', 'stageRun.recordLocalOutcome'],
  initialStatus: 'created',
  statuses: ['created', 'activated', 'terminal'],
  terminalStatuses: ['terminal'],
  transitions: [
    { command: 'stageRun.create', fromStatuses: [], toStatus: 'created', terminal: false },
    { command: 'stageRun.activate', fromStatuses: ['created'], toStatus: 'activated', terminal: false },
    { command: 'stageRun.recordLocalOutcome', fromStatuses: ['activated'], toStatus: 'terminal', terminal: true },
  ],
  guards: {
    'stageRun.recordLocalOutcome': recordLocalOutcomeGuard,
  },
};
