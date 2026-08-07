import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import type { CheckPlan } from '../../domain/workplace/index.js';
import { sha256Hex } from '../../../shared/canonical-json.js';
import {
  PRODUCT_CONTRACT_CHECK_PROVIDER_DIGEST,
  PRODUCT_CONTRACT_CHECK_PROVIDER_ID,
  PRODUCT_CONTRACT_CHECK_PROVIDER_VERSION,
} from '../../application/standard-check-providers.js';
// CONVEYOR Wave 7: the module identity ref is a CANONICAL contract owned by the
// lifecycle (Rule 3). This module imports it back — inward direction, allowed.
import { DEVELOPMENT_PROCESS_MODULE_REF } from '../../lifecycles/product-delivery-module-contracts.js';
import { DEVELOPMENT_KERNEL_HANDLER_IDS } from '../../../modules/development/domain/development-kernel-ports.js';
import {
  ACCEPTANCE_VERIFICATION_SCHEMA,
  DEVELOPMENT_CASE_SCHEMA,
  DEVELOPMENT_CERTIFICATE_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA,
  DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
  DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
  DEVELOPMENT_TASK_GRAPH_SCHEMA,
  INTEGRATED_CANDIDATE_SCHEMA,
  VERIFIED_INTEGRATION_BUNDLE_SCHEMA,
  DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
} from '../../../modules/development/domain/development-schemas.js';

export { DEVELOPMENT_PROCESS_MODULE_REF };

const PROCESS_PROTOCOL_SKILL = 'saga-process-module-worker-protocol';
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

function productContractPlan(id: string): CheckPlan {
  const entries = [{
    check: {
      providerId: PRODUCT_CONTRACT_CHECK_PROVIDER_ID,
      version: PRODUCT_CONTRACT_CHECK_PROVIDER_VERSION,
      providerDigest: PRODUCT_CONTRACT_CHECK_PROVIDER_DIGEST,
    },
    parameters: {},
    environmentRef: null,
  }];
  const version = '1.0.0';
  const decisionPolicyRef = 'factory.fail-closed-product-contract.v1';
  const decisionPolicyDigest = sha256Hex({ decisionPolicyRef, version });
  const unknownErrorPolicy = 'fail-closed' as const;
  return {
    checkPlanId: id,
    version,
    checkPlanDigest: sha256Hex({
      checkPlanId: id,
      version,
      entries,
      decisionPolicyRef,
      decisionPolicyDigest,
      unknownErrorPolicy,
    }),
    entries,
    decisionPolicyRef,
    decisionPolicyDigest,
    unknownErrorPolicy,
  };
}

const IMPLEMENTATION_AUTHOR_PLAN = productContractPlan('development.implementation.author');
const IMPLEMENTATION_FINAL_PLAN = productContractPlan('development.implementation.final');
const VERIFICATION_FINAL_PLAN = productContractPlan('development.verification.final');

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
 * Development is one module assembled from the universal Production Cell.
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
 * Implementation and verification are Production Cell nodes. Their desks are
 * staffed through the one global dispatcher and accepted through sealed
 * CandidateSets and deterministic gates.
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
    id: 'factory.development.standard',
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
        id: 'implement-work-items',
        label: 'Implement and Review Work Items',
        kind: 'production-cell',
        description:
          'Fan out the validated implementation items through the universal Workplace author, review, gate and repair loop.',
        cellDefinition: {
          id: 'development-implementation',
          inputSelectors: ['resolve-task-graph.items'],
          materialization: {
            sourceBinding: 'resolve-task-graph',
            workKeySelector: 'items',
            completionPolicy: 'all',
            taskProvenance: {
              sourceArtifactIdsSelector: 'acceptanceCriterionIds',
            },
          },
          author: {
            skillRef: 'development-implementation-worker',
            capabilityPreset: 'sandbox-code-author',
          },
          productContracts: [{
            binding: 'implementationResult',
            schemaRef: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA,
            mediaType: 'application/json',
            cardinality: '1',
          }],
          authorGate: {
            gateId: 'development-implementation-author',
            gatePhase: 'author',
            checkPlan: IMPLEMENTATION_AUTHOR_PLAN,
          },
          review: {
            reviewer: {
              skillRef: 'development-implementation-reviewer',
              capabilityPreset: 'sandbox-code-reviewer',
            },
            verdictSchemaRef: DEVELOPMENT_REVIEW_VERDICT_SCHEMA,
            finalGate: {
              gateId: 'development-implementation-final',
              gatePhase: 'final',
              checkPlan: IMPLEMENTATION_FINAL_PLAN,
            },
          },
          recovery: { maxAttempts: 2, onExhausted: 'pause' },
          transitions: {
            accepted: 'verify-acceptance',
            humanRequired: 'complete-blocked',
            failed: 'complete-failed',
          },
        },
      },
      {
        id: 'verify-acceptance',
        label: 'Verify Acceptance Criteria',
        kind: 'production-cell',
        description:
          'Fan out acceptance checks over the exact accepted implementation manifest through the same universal Workplace loop.',
        cellDefinition: {
          id: 'development-verification',
          inputSelectors: [
            'resolve-task-graph.verificationItems',
            'implement-work-items.products',
          ],
          materialization: {
            sourceBinding: 'resolve-task-graph',
            workKeySelector: 'verificationItems',
            completionPolicy: 'all',
            taskProvenance: {
              sourceArtifactIdsSelector: 'acceptanceCriterionIds',
              verificationTargetArtifactIdSelector: 'acceptanceCriterionIds',
            },
          },
          author: {
            skillRef: 'development-verification-worker',
            capabilityPreset: 'sandbox-verifier',
          },
          productContracts: [{
            binding: 'verificationEvidence',
            schemaRef: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
            mediaType: 'application/json',
            cardinality: '1',
          }],
          authorGate: {
            gateId: 'development-verification-final',
            gatePhase: 'final',
            checkPlan: VERIFICATION_FINAL_PLAN,
          },
          recovery: { maxAttempts: 2, onExhausted: 'pause' },
          transitions: {
            accepted: 'settle-development',
            humanRequired: 'complete-blocked',
            failed: 'complete-failed',
          },
        },
      },
      {
        id: 'settle-development',
        label: 'Settle Development',
        kind: 'kernel',
        description:
          'Re-read the validated task graph and accepted Production Cell products, reconstruct the implementation workset, integrated release candidate and acceptance-verification workset, then issue the deterministic development certificate.',
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

      // Resolution authorizes two universal cells. Each pauses while its desks
      // are staffed and completes only when its declared policy is satisfied.
      {
        from: 'resolve-task-graph',
        to: 'implement-work-items',
        on: 'domain.valid',
      },
      {
        from: 'implement-work-items',
        to: 'verify-acceptance',
        on: 'domain.accepted',
      },
      {
        from: 'verify-acceptance',
        to: 'settle-development',
        on: 'domain.accepted',
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
        'Implementation and independent review results reconstructed from accepted, sealed cell products.',
    },
    {
      type: 'integrated-release-candidate',
      schema: { id: INTEGRATED_CANDIDATE_SCHEMA },
      authority: 'kernel',
      description:
        'Frozen repository commits, tree hashes and build digests reconstructed from accepted implementation products.',
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
        id: 'factory.work-intent.development-task-graph.v1',
      },
      taskKind: 'planning.decomposition',
      executionSkill: 'saga-planner',
      reviewSkill: 'saga-planning-reviewer',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-planner',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: [
        ...COMMON_READ_TOOLS,
        'artifact_get',
        'conflict_check',
        'process_node_submit',
        'worker_done',
        'Write', 'Edit', 'Bash',
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
        id: 'factory.work-intent.development-implementation.v1',
      },
      taskKind: 'development.code',
      executionSkill: 'saga-worker',
      reviewSkill: null,
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-worker',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'git_change',
      allowedTools: COMMON_WRITE_TOOLS,
      trackerTemplate: IMPLEMENTATION_TRACKER,
      workspaceTemplates: [IMPLEMENTATION_CHECKLIST],
      callTemplates: [],
      checklists: [IMPLEMENTATION_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA },
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
    {
      id: 'development-implementation-reviewer',
      workIntentKind: 'development.implementation-review',
      workIntentSchema: { id: 'factory.work-intent.development-implementation-review.v1' },
      taskKind: 'development.code.review',
      executionSkill: 'saga-worker',
      reviewSkill: null,
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-worker',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: COMMON_WRITE_TOOLS,
      trackerTemplate: IMPLEMENTATION_TRACKER,
      workspaceTemplates: [IMPLEMENTATION_CHECKLIST],
      callTemplates: [],
      checklists: [IMPLEMENTATION_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_REVIEW_VERDICT_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['review-rejected'], backoff: 'none' },
      recoveryPolicy: {
        resumeFromCheckpoint: true,
        reuseWorkIntent: true,
        reuseAcceptedOutput: true,
        onExhausted: 'pause',
      },
    },
    {
      id: 'development-verification-worker',
      workIntentKind: 'development.verification',
      workIntentSchema: { id: 'factory.work-intent.development-verification.v1' },
      taskKind: 'verification.ac',
      executionSkill: 'saga-worker',
      reviewSkill: null,
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-worker',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: COMMON_WRITE_TOOLS,
      trackerTemplate: IMPLEMENTATION_TRACKER,
      workspaceTemplates: [IMPLEMENTATION_CHECKLIST],
      callTemplates: [],
      checklists: [IMPLEMENTATION_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['evidence-rejected'], backoff: 'none' },
      recoveryPolicy: {
        resumeFromCheckpoint: true,
        reuseWorkIntent: true,
        reuseAcceptedOutput: true,
        onExhausted: 'pause',
      },
    },
  ],
};
