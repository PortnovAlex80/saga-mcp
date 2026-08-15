/**
 * Package-owned assistance for Discovery LM nodes.
 *
 * The module owns the guidance. The runtime only hydrates machine-known
 * placeholders and delivers the selected event through the generic Claude
 * hook. No platform component switches on Discovery node or task names.
 */

import type { AgentAssistanceDefinition } from '../../../domain/spi/agent-assistance.js';

const COMMON_BUDGETS = Object.freeze({
  maxTokensPerBlock: 220,
  maxBlocksPerEvent: 7,
  maxRetriesBeforeEscalate: 2,
});

const commonResourceBlocks = Object.freeze([
  {
    kind: 'resource-path' as const,
    content:
      'Tracker/program counter: {TRACKER_PATH}. Materialized call files: {CALL_FILES}. Checklists: {CHECKLISTS}.',
  },
  {
    kind: 'allowed-tools' as const,
    content: '{ALLOWED_TOOLS}',
  },
]);

function discoveryAssistance(args: {
  nodeId: string;
  goal: string;
  completion: string;
}): AgentAssistanceDefinition {
  return {
    nodeId: args.nodeId,
    mode: 'intensive',
    budgets: COMMON_BUDGETS,
    events: [
      {
        event: 'step-enter',
        blocks: [
          { kind: 'goal', content: args.goal },
          {
            kind: 'current-step',
            content:
              'You are in Flow node {NODE_ID}. Read {TRACKER_PATH}; its first unchecked item is the exact inner step.',
          },
          {
            kind: 'next-action',
            content:
              'Work only on that unchecked tracker item. Update the tracker immediately after durable evidence exists.',
          },
          ...commonResourceBlocks,
          { kind: 'completion-criteria', content: args.completion },
        ],
      },
      {
        event: 'post-tool-success',
        blocks: [
          { kind: 'goal', content: args.goal },
          {
            kind: 'current-step',
            content:
              'Remain in Flow node {NODE_ID}. Re-open {TRACKER_PATH}; the first unchecked item is authoritative.',
          },
          {
            kind: 'next-action',
            content:
              'Record the completed action in the tracker, then execute only the next unchecked item. Never skip the final worker_done step.',
          },
          ...commonResourceBlocks,
          { kind: 'completion-criteria', content: args.completion },
        ],
      },
      {
        event: 'post-tool-error',
        blocks: [
          { kind: 'goal', content: args.goal },
          {
            kind: 'current-step',
            content:
              'The last tool failed while executing the first unchecked item in {TRACKER_PATH}. Stay on that item.',
          },
          {
            kind: 'next-action',
            content:
              'Use the MCP error as repair feedback. Correct the existing materialized call file in place, re-read it and its checklist, then retry the same operation.',
          },
          {
            kind: 'retry-instruction',
            content:
              'Do not reconstruct the call from memory, invent identifiers, skip the rejected step, or call worker_done before the domain submission succeeds.',
          },
          ...commonResourceBlocks,
        ],
      },
      {
        event: 'resume',
        blocks: [
          { kind: 'goal', content: args.goal },
          {
            kind: 'current-step',
            content:
              'This is a resumed execution. Read {TRACKER_PATH} and recovery-feedback.json when present; continue at the first unchecked item.',
          },
          {
            kind: 'next-action',
            content:
              'Reuse accepted work and the existing materialized call file. Repair only the rejected fields described by durable feedback.',
          },
          ...commonResourceBlocks,
          { kind: 'completion-criteria', content: args.completion },
        ],
      },
    ],
  };
}

export const DISCOVERY_AGENT_ASSISTANCE: readonly AgentAssistanceDefinition[] =
  Object.freeze([
    discoveryAssistance({
      nodeId: 'produce-proposal',
      goal:
        'Investigate the idea from cited project evidence, write the Discovery document, and submit one schema-valid proposal without deciding the outcome.',
      completion:
        'proposal_submit has returned a durable receipt, every proposal checklist item passes, the tracker is current, and worker_done is called exactly once.',
    }),
    discoveryAssistance({
      nodeId: 'normalize-semantic',
      goal:
        'Repair only the bounded semantic fields requested by the normalization case while preserving the original proposal lineage.',
      completion:
        'normalization_submit has returned a durable receipt for the exact case/hash, the checklist passes, the tracker is current, and worker_done is called exactly once.',
    }),
    discoveryAssistance({
      nodeId: 'assess-readiness',
      goal:
        'Assess the canonical proposal against the supplied readiness schema and allowed sources; advise only and never route the lifecycle.',
      completion:
        'readiness_submit has returned a durable receipt for the exact control intent and proposal hash, the checklist passes, the tracker is current, and worker_done is called exactly once.',
    }),
  ]);
