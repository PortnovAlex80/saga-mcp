import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import {
  DEVELOPMENT_EXTERNAL_ADAPTER_IDS,
  DEVELOPMENT_KERNEL_HANDLER_IDS,
} from './development-kernel-ports.js';
import {
  ACCEPTANCE_VERIFICATION_SCHEMA,
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
} from './development-schemas.js';

export const DEVELOPMENT_PROCESS_MODULE_REF = {
  name: 'solution-development',
  version: '1.0.0',
} as const;

const PROCESS_PROTOCOL_SKILL = 'saga-process-module-worker-protocol';
const DEVELOPMENT_TRACKER =
  'tool-templates/development/process-module-stage-tracker.md';
const DEVELOPMENT_SUBMISSION_CALL =
  'tool-templates/development/task-graph-submit-call-template.json';
const DEVELOPMENT_CHECKLIST =
  'tool-templates/development/task-graph-planner-checklist.md';

/**
 * Development is one module, not four independently-settled legacy stages.
 * Planning is advisory; the kernel resolves its proposal. Implementation and
 * integration execute before the candidate is frozen. Verification then binds
 * to that exact candidate and no downstream node may mutate it.
 */
export const developmentProcessModule: ProcessModuleDefinition = {
  identity: {
    ...DEVELOPMENT_PROCESS_MODULE_REF,
    kind: 'development',
    displayName: 'Solution Development',
    description:
      'Plans, implements, reviews, integrates, freezes and verifies one exact release candidate.',
  },
  inputContract: { id: DEVELOPMENT_CASE_SCHEMA },
  outputContract: { id: VERIFIED_INTEGRATION_BUNDLE_SCHEMA },
  outcomes: [
    {
      code: 'verified',
      description:
        'All required implementation and acceptance evidence binds to the unchanged frozen candidate.',
      terminal: true,
    },
    {
      code: 'rework-required',
      description:
        'Implementation, review or acceptance evidence found a product defect that requires a new work cycle.',
      terminal: true,
    },
    {
      code: 'clarification-required',
      description:
        'The accepted decomposition cannot be converted into a complete, deterministic task graph.',
      terminal: true,
    },
    {
      code: 'blocked',
      description:
        'Required work, trusted evidence, integration state or a human decision is unavailable.',
      terminal: true,
    },
    {
      code: 'failed',
      description:
        'Development infrastructure or immutable lineage validation failed.',
      terminal: true,
    },
  ],
  flow: {
    id: 'saga3.development.standard',
    version: '1.0.0',
    entryNodeId: 'plan-task-graph',
    nodes: [
      {
        id: 'plan-task-graph',
        label: 'Propose Task Graph',
        kind: 'lm',
        description:
          'Read the accepted SRS decomposition and propose typed implementation, integration and verification work.',
        executionProfile: 'development-task-graph-planner',
        inputSchema: { id: DEVELOPMENT_CASE_SCHEMA },
        outputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
      },
      {
        id: 'resolve-task-graph',
        label: 'Resolve and Validate Task Graph',
        kind: 'kernel',
        description:
          'Read the exact planner submission, validate lineage/coverage/DAG constraints and materialize canonical tasks idempotently.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph,
        inputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
        outputSchema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA },
      },
      {
        id: 'execute-implementation-workset',
        label: 'Execute Implementation Workset',
        kind: 'external',
        description:
          'Drive the bounded implementation and independent review workset using durable work items and execution fences.',
        adapter:
          DEVELOPMENT_EXTERNAL_ADAPTER_IDS.executeImplementationWorkset,
        inputSchema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA },
        outputSchema: { id: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA },
      },
      {
        id: 'integrate-release-candidate',
        label: 'Integrate and Freeze Candidate',
        kind: 'external',
        description:
          'Integrate only reviewed source commits with observable intents/CAS, then freeze exact repository trees and build digests.',
        adapter: DEVELOPMENT_EXTERNAL_ADAPTER_IDS.integrateReleaseCandidate,
        inputSchema: { id: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA },
        outputSchema: { id: INTEGRATED_CANDIDATE_SCHEMA },
      },
      {
        id: 'verify-acceptance-workset',
        label: 'Verify Frozen Candidate',
        kind: 'external',
        description:
          'Execute independent acceptance verification against the exact frozen candidate hash; unknown/error are denials.',
        adapter: DEVELOPMENT_EXTERNAL_ADAPTER_IDS.verifyAcceptanceWorkset,
        inputSchema: { id: INTEGRATED_CANDIDATE_SCHEMA },
        outputSchema: { id: ACCEPTANCE_VERIFICATION_SCHEMA },
      },
      {
        id: 'settle-development',
        label: 'Settle Development',
        kind: 'kernel',
        description:
          'Re-read exact durable products, re-observe candidate immutability, build the verified bundle and issue the development certificate.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.settle,
        inputSchema: { id: ACCEPTANCE_VERIFICATION_SCHEMA },
        outputSchema: { id: DEVELOPMENT_CERTIFICATE_SCHEMA },
      },
      ...[
        'verified',
        'rework-required',
        'clarification-required',
        'blocked',
        'failed',
      ].map(code => ({
        id: `complete-${code}`,
        label: `Complete: ${code}`,
        kind: 'kernel' as const,
        description: `Emit the local Development process outcome '${code}'.`,
        handler: 'process-outcome-emitter',
        emitsOutcome: code,
      })),
    ],
    transitions: [
      {
        from: 'plan-task-graph',
        to: 'resolve-task-graph',
        on: 'runtime.completed',
      },
      {
        from: 'plan-task-graph',
        to: 'resolve-task-graph',
        on: 'runtime.failed',
      },
      {
        from: 'resolve-task-graph',
        to: 'execute-implementation-workset',
        on: 'domain.valid',
      },
      {
        from: 'resolve-task-graph',
        to: 'settle-development',
        on: 'domain.clarification-required',
      },
      {
        from: 'resolve-task-graph',
        to: 'settle-development',
        on: 'domain.failed',
      },
      {
        from: 'execute-implementation-workset',
        to: 'integrate-release-candidate',
        on: 'runtime.completed',
      },
      {
        from: 'execute-implementation-workset',
        to: 'settle-development',
        on: 'runtime.failed',
      },
      {
        from: 'integrate-release-candidate',
        to: 'verify-acceptance-workset',
        on: 'runtime.completed',
      },
      {
        from: 'integrate-release-candidate',
        to: 'settle-development',
        on: 'runtime.failed',
      },
      {
        from: 'verify-acceptance-workset',
        to: 'settle-development',
        on: 'runtime.completed',
      },
      {
        from: 'verify-acceptance-workset',
        to: 'settle-development',
        on: 'runtime.failed',
      },
      ...[
        'verified',
        'rework-required',
        'clarification-required',
        'blocked',
        'failed',
      ].map(code => ({
        from: 'settle-development',
        to: `complete-${code}`,
        on: `domain.${code}`,
      })),
    ],
    terminalNodeIds: [
      'complete-verified',
      'complete-rework-required',
      'complete-clarification-required',
      'complete-blocked',
      'complete-failed',
    ],
  },
  artifacts: [
    {
      type: 'development-case',
      schema: { id: DEVELOPMENT_CASE_SCHEMA },
      authority: 'kernel',
      description:
        'Immutable input bound to the formalization certificate, accepted baseline, SRS and repository bases.',
    },
    {
      type: 'development-task-graph-proposal',
      schema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
      authority: 'worker',
      description:
        'Advisory decomposition proposal; it has no execution authority until kernel resolution.',
    },
    {
      type: 'development-task-graph',
      schema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA },
      authority: 'kernel',
      description:
        'Canonical, coverage-complete, acyclic task and integration graph.',
    },
    {
      type: 'development-implementation-workset',
      schema: { id: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA },
      authority: 'external',
      description:
        'Durable implementation and independent review results keyed to the task graph.',
    },
    {
      type: 'integrated-release-candidate',
      schema: { id: INTEGRATED_CANDIDATE_SCHEMA },
      authority: 'external',
      description:
        'Frozen repository commits, tree hashes and build digests produced before verification.',
    },
    {
      type: 'acceptance-verification-workset',
      schema: { id: ACCEPTANCE_VERIFICATION_SCHEMA },
      authority: 'external',
      description:
        'Trusted evidence for every accepted AC bound to the exact frozen candidate hash.',
    },
    {
      type: 'verified-integration-bundle',
      schema: { id: VERIFIED_INTEGRATION_BUNDLE_SCHEMA },
      authority: 'kernel',
      description:
        'Canonical Development output consumed by Delivery/Release.',
    },
    {
      type: 'development-certificate',
      schema: { id: DEVELOPMENT_CERTIFICATE_SCHEMA },
      authority: 'kernel',
      description:
        'Immutable settlement decision and exact product-lineage hashes.',
    },
  ],
  policies: [
    {
      id: 'development-task-graph-validation',
      version: '1.0.0',
      handler: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph,
      description:
        'Makes planner output executable only after deterministic lineage, coverage, repository and DAG validation.',
    },
    {
      id: 'development-settlement',
      version: '1.0.0',
      handler: DEVELOPMENT_KERNEL_HANDLER_IDS.settle,
      description:
        'Admits only a complete workset with trusted evidence for the unchanged frozen candidate.',
    },
  ],
  invariants: [
    {
      id: 'development.lm-proposes-kernel-authorizes',
      description:
        'The planning LM proposes a graph; only the resolver kernel creates canonical tasks and dependencies.',
      enforcement: 'runtime',
    },
    {
      id: 'development.review-before-integration',
      description:
        'Only the exact source commit approved by independent review may enter an integration intent.',
      enforcement: 'policy',
    },
    {
      id: 'development.integrate-before-verification',
      description:
        'All code-changing integration completes and the candidate freezes before acceptance verification starts.',
      enforcement: 'runtime',
    },
    {
      id: 'development.evidence-pins-candidate',
      description:
        'Every acceptance record pins both the AC accepted hash and the frozen candidate hash.',
      enforcement: 'policy',
    },
    {
      id: 'development.no-post-verification-mutation',
      description:
        'Candidate drift invalidates all prior evidence and requires a new verification workset.',
      enforcement: 'policy',
    },
    {
      id: 'development.unknown-denies',
      description:
        'Verification outcomes unknown and error never authorize a verified bundle.',
      enforcement: 'policy',
    },
    {
      id: 'development.exact-lineage',
      description:
        'Resolvers and settlement use exact refs/hashes from receipts; epic-wide latest lookup is forbidden.',
      enforcement: 'test',
    },
    {
      id: 'development.module-does-not-route',
      description:
        'Development emits a local outcome and never starts Delivery directly.',
      enforcement: 'static',
    },
  ],
  executionProfiles: [
    {
      id: 'development-task-graph-planner',
      workIntentKind: 'development.plan-task-graph',
      workIntentSchema: {
        id: 'saga3.work-intent.development-task-graph.v1',
      },
      taskKind: 'planning.decomposition',
      executionSkill: 'saga-planner',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-planner',
      executionMode: 'tracker_only',
      allowedTools: [
        'task_get',
        'task_list',
        'artifact_get',
        'artifact_list',
        'trace_list',
        'repository_list',
        'repository_checkout_list',
        'conflict_check',
        'process_node_submit',
        'worker_done',
      ],
      trackerTemplate: DEVELOPMENT_TRACKER,
      workspaceTemplates: [
        DEVELOPMENT_SUBMISSION_CALL,
        DEVELOPMENT_CHECKLIST,
      ],
      callTemplates: [DEVELOPMENT_SUBMISSION_CALL],
      checklists: [DEVELOPMENT_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
      retryPolicy: {
        maxAttempts: 2,
        retryOn: ['schema-rejected', 'lineage-gap'],
        backoff: 'none',
      },
      recoveryPolicy: {
        resumeFromCheckpoint: true,
        reuseWorkIntent: true,
        reuseAcceptedOutput: true,
        onExhausted: 'pause',
      },
    },
  ],
};
