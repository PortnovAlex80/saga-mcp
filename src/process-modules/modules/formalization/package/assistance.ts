/**
 * Package-owned assistance for Formalization LM nodes.
 *
 * Mirrors the Discovery assistance pattern: the module owns the guidance; the
 * runtime hydrates machine-known placeholders and delivers the selected event
 * through the generic Claude hook (structured-context-hook.mjs). No platform
 * component switches on a Formalization node or task name.
 *
 * Every Formalization LM node follows the same conveyor mechanic:
 *   1. Read the tracker (program counter) — first unchecked item is the step.
 *   2. Read recovery-feedback.json / review-feedback.json when present.
 *   3. Do ONLY the current step; update the tracker immediately.
 *   4. Submit via the materialized MCP call template; read it back + checklist.
 *   5. Call worker_done exactly once when the submission is durable.
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

function formalizationAssistance(args: {
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

export const FORMALIZATION_AGENT_ASSISTANCE: readonly AgentAssistanceDefinition[] =
  Object.freeze([
    formalizationAssistance({
      nodeId: 'define-product-contract',
      goal:
        'Create the PRD plus FR, NFR and RULE artifacts from the accepted Discovery certificate, preserving lineage to the brief.',
      completion:
        'The PRD and every derived FR/NFR/RULE artifact are created with correct derived_from traces, the checklist passes, the tracker is current, and worker_done is called exactly once.',
    }),
    formalizationAssistance({
      nodeId: 'model-use-cases',
      goal:
        'Create use cases that cover the accepted functional requirements, preserving UC → FR covers traces.',
      completion:
        'Every UC artifact is created with at least one covers → FR trace, the checklist passes, the tracker is current, and worker_done is called exactly once.',
    }),
    formalizationAssistance({
      nodeId: 'define-acceptance-contract',
      goal:
        'Create acceptance criteria as contract data derived from UC, FR and NFR, with Given/When/Then and properties blocks for algorithmic ACs.',
      completion:
        'Every AC artifact is created with at least one derived_from → UC and one → FR/NFR trace, the checklist passes, the tracker is current, and worker_done is called exactly once.',
    }),
    formalizationAssistance({
      nodeId: 'reconcile-what',
      goal:
        'Repair permitted traceability gaps and expose unresolved WHAT-side contradictions without guessing lineage.',
      completion:
        'Every missing traceability edge is either added via trace_add or escalated via worker_ask_need, the reconciliation report is current, the tracker is current, and worker_done is called exactly once.',
    }),
    formalizationAssistance({
      nodeId: 'define-architecture-contract',
      goal:
        'Create the SRS with module manifest, invariant registry, port registry and test strategy after the AC baseline is frozen.',
      completion:
        'The SRS artifact is created with a derived_from → PRD trace, the Invariant Registry and Port Registry are present, the checklist passes, the tracker is current, and worker_done is called exactly once.',
    }),
  ]);
