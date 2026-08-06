/**
 * Package-owned assistance for Development LM nodes + flow-less worker profiles.
 *
 * Mirrors the Formalization/Discovery assistance pattern. Two definitions:
 *
 *   1. `plan-task-graph` — the planner Flow LM node. Reads the accepted SRS
 *      decomposition and proposes a typed task graph. Standard conveyor mechanic.
 *
 *   2. `profile:development:development-implementation-worker` — the flow-less
 *      implementation worker profile. These tasks are claimed through the shared
 *      worker_next queue (NOT a Flow node). Their workplace is a stable virtual
 *      node keyed by the profile id (see resolveOwningNodeId in the materializer).
 *      Workers implement code, review and merge — the assistance guides them
 *      through the git_change execution mode.
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

function developmentAssistance(args: {
  nodeId: string;
  goal: string;
  completion: string;
  resumeHint?: string;
}): AgentAssistanceDefinition {
  const resumeStep = args.resumeHint
    ?? 'This is a resumed execution. Read {TRACKER_PATH} and recovery-feedback.json when present; continue at the first unchecked item.';
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
              'Use the MCP error as repair feedback. Correct the existing materialized call file or source in place, re-read its checklist, then retry the same operation.',
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
            content: resumeStep,
          },
          {
            kind: 'next-action',
            content:
              'Reuse accepted work and the existing materialized call file or source. Repair only the rejected fields described by durable feedback.',
          },
          ...commonResourceBlocks,
          { kind: 'completion-criteria', content: args.completion },
        ],
      },
    ],
  };
}

export const DEVELOPMENT_AGENT_ASSISTANCE: readonly AgentAssistanceDefinition[] =
  Object.freeze([
    developmentAssistance({
      nodeId: 'plan-task-graph',
      goal:
        'Read the accepted SRS decomposition and propose a typed implementation, integration and verification task graph that covers every acceptance criterion.',
      completion:
        'process_node_submit has returned a durable receipt for the task graph proposal, every planner checklist item passes, the tracker is current, and worker_done is called exactly once.',
    }),
    developmentAssistance({
      nodeId: 'implement-work-items',
      goal:
        'Produce exactly one typed implementation result for the assigned work item, with source and artifact lineage suitable for independent review.',
      completion:
        'process_node_submit has returned a durable implementation product receipt, the tracker is current, and worker_done is called exactly once.',
      resumeHint:
        'This is a resumed execution. Read {TRACKER_PATH} and recovery-feedback.json or review-feedback.json when present; continue at the first unchecked item.',
    }),
    developmentAssistance({
      nodeId: 'verify-acceptance',
      goal:
        'Verify one acceptance criterion against the exact frozen implementation candidate and publish typed deterministic evidence.',
      completion:
        'process_node_submit has returned a durable verification evidence receipt, the tracker is current, and worker_done is called exactly once.',
    }),
  ]);
