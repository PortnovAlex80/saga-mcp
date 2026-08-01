import type { ProcessModuleDefinition } from '../../domain/process-module.js';
// CONVEYOR Wave 7: the module identity ref is a CANONICAL contract owned by the
// lifecycle (Rule 3). This module imports it back — inward direction, allowed.
import { DEVELOPMENT_PROCESS_MODULE_REF } from '../../lifecycles/product-delivery-module-contracts.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from './development-kernel-ports.js';
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

export { DEVELOPMENT_PROCESS_MODULE_REF };

const PROCESS_PROTOCOL_SKILL = 'saga-process-module-worker-protocol';
// W13-A2: resources were moved out of the legacy global root
// (`tool-templates/development/`) into the development package resources
// directory. These are repo-root-relative POSIX paths — the workspace
// materializer resolves them under `workspaceRoot` (process.cwd()), matching
// the delivery package pattern.
const DEVELOPMENT_RESOURCE_ROOT =
  'src/process-modules/modules/development/package/resources';
const DEVELOPMENT_TRACKER =
  `${DEVELOPMENT_RESOURCE_ROOT}/process-module-stage-tracker.md`;
const DEVELOPMENT_SUBMISSION_CALL =
  `${DEVELOPMENT_RESOURCE_ROOT}/task-graph-submit-call-template.json`;
const DEVELOPMENT_CHECKLIST =
  `${DEVELOPMENT_RESOURCE_ROOT}/task-graph-planner-checklist.md`;
const IMPLEMENTATION_TRACKER =
  `${DEVELOPMENT_RESOURCE_ROOT}/implementation-task-tracker.md`;
const IMPLEMENTATION_CHECKLIST =
  `${DEVELOPMENT_RESOURCE_ROOT}/implementation-worker-checklist.md`;

const COMMON_READ_TOOLS = [
  'task_get', 'task_list', 'artifact_list', 'trace_list', 'repository_list',
  'repository_checkout_list', 'Read', 'Glob', 'Grep',
] as const;

const COMMON_WRITE_TOOLS = [
  ...COMMON_READ_TOOLS,
  'worker_done',
  'worker_merge_acquire', 'worker_merge_release',
  'verification_record',
  'Write', 'Edit', 'Bash',
] as const;

/**
 * Development is one module, not four independently-settled legacy stages.
 *
 * Mechanical pattern (cloned from Formalization): lm-node proposes, kernel-node
 * resolves/authorizes, then the single settlement kernel-node decides. There
 * are NO external nodes inside this Flow.
 *
 *   plan-task-graph (lm: saga-planner) proposes the task graph.
 *   resolve-task-graph (kernel) validates + persists the canonical graph and
 *     materializes its projected implementation/verification/integration tasks
 *     onto the kanban (declarative persistence — legitimate kernel work, same
 *     tier as Formalization persisting a contract).
 *
 * Implementation, integration and verification are NOT Flow nodes. The
 * projected tasks are ordinary kanban tasks. Workers claim them through the
 * shared worker_next queue (infrastructure), execute code, merge through
 * worker_merge_release and record verification evidence. The module never
 * hires, merges or tests.
 *
 *   settle-development (kernel) re-reads exact durable products via
 *     settlementState, reconstructs the implementation workset / integrated
 *     release candidate / acceptance-verification workset as INNER data of the
 *     DevelopmentSettlementInput, runs the deterministic settlement policy and
 *     issues the development certificate + verified integration bundle.
 *
 * Verification evidence binds to the unchanged frozen candidate. A changed
 * commit/tree/build digest is a different candidate and requires new evidence.
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
          'Read the exact planner submission, validate lineage/coverage/DAG constraints and materialize the canonical task graph and its projected kanban tasks idempotently.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph,
        inputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
        outputSchema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA },
      },
      {
        id: 'settle-development',
        label: 'Settle Development',
        kind: 'kernel',
        description:
          'Re-read exact durable products — the validated task graph, projected tracker tasks and integration state — reconstruct the implementation workset, integrated release candidate and acceptance-verification workset as inner settlement data, then run the deterministic settlement policy and issue the development certificate.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.settle,
        inputSchema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA },
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
      // LM node emits only physical runtime events. Even runtime.failed reaches
      // the resolver because the worker may have committed durable MCP writes
      // (the planner submission) before its process died. The resolver decides
      // whether a domain product exists by reading the exact managed-execution
      // provenance ledger.
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

      // Resolver success → settlement. The settlement kernel re-reads tracker
      // state (projected tasks, integration_state) and decides the outcome.
      // NOTE: there is intentionally NO await-implementation node between
      // resolve and settle. The conveyor (orchestrate-cli main loop /
      // LifecycleOrchestrator) drives the impl tasks through the shared
      // worker_next queue; the ProcessRun does not advance to settle-development
      // until those tasks reach terminal state. The GenericFlowExecutor has no
      // condition-wait primitive, so any "wait" must be owned by the conveyor,
      // not by a Flow node. settle-development assumes the impl workset is
      // already terminal when it runs.
      {
        from: 'resolve-task-graph',
        to: 'settle-development',
        on: 'domain.valid',
      },
      // Semantic repair loop: the planner must revise the proposal.
      {
        from: 'resolve-task-graph',
        to: 'plan-task-graph',
        on: 'domain.repair-required',
      },
      // Unrecoverable resolution outcomes route straight to settlement, which
      // records them deterministically and emits the terminal outcome.
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

      // Settlement emits the five local outcomes.
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
    recovery: [
      {
        id: 'repair-development-task-graph',
        verifyNodeId: 'resolve-task-graph',
        repairNodeId: 'plan-task-graph',
        triggerEvents: ['domain.repair-required'],
        resolvedEvents: ['domain.valid'],
        maxAttempts: 2,
        onExhausted: 'pause',
      },
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
      authority: 'kernel',
      description:
        'Implementation and independent review results, reconstructed at settlement from the exact projected tracker tasks and integration state.',
    },
    {
      type: 'integrated-release-candidate',
      schema: { id: INTEGRATED_CANDIDATE_SCHEMA },
      authority: 'kernel',
      description:
        'Frozen repository commits, tree hashes and build digests, reconstructed at settlement from integration state.',
    },
    {
      type: 'acceptance-verification-workset',
      schema: { id: ACCEPTANCE_VERIFICATION_SCHEMA },
      authority: 'kernel',
      description:
        'Trusted evidence for every accepted AC bound to the exact frozen candidate hash, reconstructed at settlement from recorded verification evidence.',
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
      reviewSkill: 'saga-planning-reviewer',
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
    {
      // Implementation workers are NOT driven by a Flow node. After
      // resolve-task-graph materializes the projected implementation tasks
      // onto the kanban, workers claim them through the shared worker_next
      // queue (infrastructure), execute code, review and merge via
      // worker_merge_release. This profile teaches the dispatcher how to run
      // those tasks: the saga-worker skill, git_change execution mode, and the
      // tools a code-changing task needs. The module Flow itself contains no
      // implementation node.
      id: 'development-implementation-worker',
      workIntentKind: 'development.implementation',
      workIntentSchema: {
        id: 'saga3.work-intent.development-implementation.v1',
      },
      taskKind: 'implementation.feature',
      executionSkill: 'saga-worker',
      reviewSkill: 'saga-worker',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-worker',
      executionMode: 'git_change',
      allowedTools: COMMON_WRITE_TOOLS,
      trackerTemplate: IMPLEMENTATION_TRACKER,
      workspaceTemplates: [IMPLEMENTATION_CHECKLIST],
      callTemplates: [],
      checklists: [IMPLEMENTATION_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA },
      retryPolicy: {
        maxAttempts: 2,
        retryOn: ['review-rejected', 'merge-conflict'],
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
