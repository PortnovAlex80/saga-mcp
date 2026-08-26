/**
 * NodeRun reducer - kernel/production-cell/human/provider node instances
 * (WP-05; universe aggregate 5/9).
 *
 * Frozen D7: node scope is inside the unreachable scope set - a dead
 * predecessor settles here through nodeRun.settleUnreachable. Fan-out
 * (materializeCell) creates explicit obligations; fan-in
 * (recordCellAcceptance) checks the exact predecessor
 * CellFinalAcceptance/EffectReceipt evidence.
 */

import type { AggregateReducer, CommandGuard } from '../types.js';
import { hasEvidenceKind, hasProofKind, refuse } from './model.js';

const recordCellAcceptanceGuard: CommandGuard = (_input, _head, ctx) => {
  if (!hasProofKind(ctx, 'TerminalProof:workplace.success')) {
    return refuse('MISSING_EVIDENCE', 'TerminalProof:workplace.success is required before node success may commit');
  }
  if (!hasEvidenceKind(ctx, 'CellFinalAcceptance') || !hasEvidenceKind(ctx, 'WorkItemDependency')) {
    return refuse('MISSING_EVIDENCE', 'CellFinalAcceptance and WorkItemDependency are required before node success may commit');
  }
  // Every DECLARED effect must have settled successfully: if any effect
  // receipt exists for the cell, at least one success-shaped receipt must
  // exist (effect-less cells have no receipts at all - FWD:F066/F071).
  const receipts = [...ctx.evidence.values()].filter((fact) => fact.kind.startsWith('EffectReceipt:'));
  if (receipts.length > 0) {
    const settled = receipts.some((fact) => fact.kind === 'EffectReceipt:success' || fact.kind === 'EffectReceipt:already-applied');
    if (!settled) {
      return refuse('MISSING_EVIDENCE', 'a declared effect settled without a success-shaped EffectReceipt blocks node success');
    }
  }
  return { requiredEvidenceKinds: ['CellFinalAcceptance', 'WorkItemDependency'] };
};

const failGuard: CommandGuard = (_input, _head, ctx) => {
  if (!hasEvidenceKind(ctx, 'RecoveryIssue') && !hasEvidenceKind(ctx, 'EffectReceipt:policy-terminal')) {
    return refuse('MISSING_EVIDENCE', 'a truthful failure cause (RecoveryIssue or EffectReceipt:policy-terminal) is required before nodeRun.fail may commit');
  }
  return { requiredEvidenceKinds: [] };
};

const settleUnreachableGuard: CommandGuard = (_input, _head, ctx) => {
  // D7: unreachable settles from a terminally failed predecessor plus the
  // settlement work it created - never from empty work.
  const failureExists = ctx.proofs.some((proof) => proof.id.endsWith('.truthful-failure') || proof.id.endsWith('.unreachable'));
  if (!failureExists) {
    return refuse('EMPTY_WORK_IS_NOT_A_PROOF', 'node unreachable requires a terminally failed predecessor proof (D7)');
  }
  if (!hasEvidenceKind(ctx, 'SettlementWorkObligation')) {
    return refuse('MISSING_EVIDENCE', 'SettlementWorkObligation from the dead predecessor is required before node unreachable may commit');
  }
  return { requiredEvidenceKinds: ['SettlementWorkObligation'] };
};

const recordProviderOutcomeGuard: CommandGuard = (input, _head, ctx) => {
  if (!hasEvidenceKind(ctx, 'AcceptedCandidateAuthority')) {
    return refuse('MISSING_EVIDENCE', 'AcceptedCandidateAuthority is the exact effect input (R3) required before recordProviderOutcome');
  }
  if (!input.effectOutcome) {
    return refuse('MISSING_EVIDENCE', 'nodeRun.recordProviderOutcome requires an effectOutcome');
  }
  return { requiredEvidenceKinds: ['AcceptedCandidateAuthority'] };
};

const createGuard: CommandGuard = (_input, _head, ctx) => {
  // A node instance materializes only when the declared module flow has
  // entered a node (the flow cursor is the sole instantiation surface).
  const entered = ctx.heads.some((head) => head.aggregate === 'ProcessRun' && head.status === 'node-entered');
  if (!entered) {
    return refuse('ILLEGAL_TRANSITION', 'a NodeRun may be created only while a ProcessRun is node-entered');
  }
  return { requiredEvidenceKinds: [] };
};

export const NodeRunReducer: AggregateReducer = {
  aggregate: 'NodeRun',
  ownedCommands: [
    'nodeRun.create',
    'nodeRun.materializeCell',
    'nodeRun.recordKernelResult',
    'nodeRun.recordCellAcceptance',
    'nodeRun.recordHumanDecision',
    'nodeRun.recordProviderOutcome',
    'nodeRun.settleUnreachable',
    'nodeRun.fail',
  ],
  initialStatus: 'created',
  statuses: [
    'created',
    'cell-materialized',
    'kernel-result-recorded',
    'human-decision-recorded',
    'provider-outcome-recorded',
    'provider-uncertainty-waited',
    'cell-acceptance-recorded',
    'unreachable-settled',
    'failed',
  ],
  terminalStatuses: ['cell-acceptance-recorded', 'unreachable-settled', 'failed'],
  transitions: [
    { command: 'nodeRun.create', fromStatuses: [], toStatus: 'created', terminal: false },
    { command: 'nodeRun.materializeCell', fromStatuses: ['created'], toStatus: 'cell-materialized', terminal: false },
    { command: 'nodeRun.recordKernelResult', fromStatuses: ['cell-materialized'], toStatus: 'kernel-result-recorded', terminal: false, obligations: [] },
    // D12 node-side rung (2026-08-26 convergence): after the operator's human
    // decision and the provider outcome, the node converges back to the SAME
    // terminal acceptance the kernel-result path uses — the human loop is a
    // DETOUR, never a dead end. The guard still demands
    // TerminalProof:workplace.success + CellFinalAcceptance + settled effects,
    // so only an honestly-dispositioned, fully-settled cell reaches terminal.
    { command: 'nodeRun.recordCellAcceptance', fromStatuses: ['kernel-result-recorded', 'provider-outcome-recorded'], toStatus: 'cell-acceptance-recorded', terminal: true },
    { command: 'nodeRun.recordHumanDecision', fromStatuses: ['kernel-result-recorded'], toStatus: 'human-decision-recorded', terminal: false },
    { command: 'nodeRun.recordProviderOutcome', fromStatuses: ['human-decision-recorded'], toStatus: 'provider-outcome-recorded', terminal: false, applies: (input) => input.effectOutcome !== 'unknown' },
    { command: 'nodeRun.recordProviderOutcome', fromStatuses: ['human-decision-recorded'], toStatus: 'provider-uncertainty-waited', terminal: false, applies: (input) => input.effectOutcome === 'unknown' },
    { command: 'nodeRun.settleUnreachable', fromStatuses: ['created', 'cell-materialized', 'kernel-result-recorded'], toStatus: 'unreachable-settled', terminal: true },
    { command: 'nodeRun.fail', fromStatuses: ['cell-materialized', 'kernel-result-recorded', 'human-decision-recorded', 'provider-outcome-recorded', 'provider-uncertainty-waited'], toStatus: 'failed', terminal: true },
  ],
  guards: {
    'nodeRun.create': createGuard,
    'nodeRun.recordCellAcceptance': recordCellAcceptanceGuard,
    'nodeRun.fail': failGuard,
    'nodeRun.settleUnreachable': settleUnreachableGuard,
    'nodeRun.recordProviderOutcome': recordProviderOutcomeGuard,
  },
};
