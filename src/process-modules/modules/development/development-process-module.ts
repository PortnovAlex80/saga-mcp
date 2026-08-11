import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import { singletonProductionCell } from '../../application/standard-production-cell.js';
import { buildCheckPlan } from '../../application/standard-check-providers.js';
import {
  REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
  REVIEW_VERDICT_CHECK_PROVIDER_ID,
  REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
} from '../../application/review-verdict-check-provider.js';
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
import {
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
  DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID,
  DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
  DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
  DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_VERSION,
  DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST,
  DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
  DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
} from '../../../modules/development/application/development-check-providers.js';
import {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../../modules/development/application/candidate-check-contracts.js';

export { DEVELOPMENT_PROCESS_MODULE_REF };

const PROCESS_PROTOCOL_SKILL = 'saga-process-module-worker-protocol';
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
  'task_get', 'task_list', 'artifact_list', 'artifact_get', 'trace_list', 'repository_list',
  'repository_checkout_list', 'candidate_read', 'product_read', 'Read', 'Glob', 'Grep',
] as const;
const COMMON_WRITE_TOOLS = [
  ...COMMON_READ_TOOLS,
  'worker_done',
  'worker_merge_acquire', 'worker_merge_release',
  'verification_record',
  'product_submit',
  'Write', 'Edit', 'Bash',
] as const;

const PLANNER_CHECK_PLAN = buildCheckPlan(
  'development.plan-task-graph.final',
  [{
    providerId: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_TASK_GRAPH_CHECK_PROVIDER_DIGEST,
  }],
);
const IMPLEMENTATION_AUTHOR_PLAN = buildCheckPlan(
  'development.implementation.author.v2',
  [{
    providerId: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_IMPLEMENTATION_SCOPE_CHECK_PROVIDER_DIGEST,
    repairTargetRoleOnFailure: 'author',
    repairTargetRoleOnIndeterminate: 'author',
  }],
);
const IMPLEMENTATION_FINAL_PLAN = buildCheckPlan(
  'development.implementation.final',
  [{
    providerId: REVIEW_VERDICT_CHECK_PROVIDER_ID,
    version: REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
    providerDigest: REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
    parameters: { verdictSchemaRef: DEVELOPMENT_REVIEW_VERDICT_SCHEMA },
    repairTargetRoleOnFailure: 'author',
    repairTargetRoleOnIndeterminate: 'reviewer',
  }],
);
const VERIFICATION_FINAL_PLAN = buildCheckPlan(
  'development.verification.final.v3',
  [{
    providerId: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_ID,
    version: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_VERSION,
    providerDigest: DEVELOPMENT_VERIFICATION_CHECK_PROVIDER_DIGEST,
    repairTargetRoleOnIndeterminate: 'author',
  }, {
    providerId: LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
    version: LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
    providerDigest: LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
    repairTargetRoleOnFailure: 'author',
    repairTargetRoleOnIndeterminate: 'author',
  }],
);

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
    { code: 'verified', description: 'All required implementation and acceptance evidence binds to the unchanged frozen candidate.', terminal: true },
    { code: 'rework-required', description: 'Implementation, review or acceptance evidence found a product defect that requires a new work cycle.', terminal: true },
    { code: 'clarification-required', description: 'The accepted decomposition cannot be converted into a complete, deterministic task graph.', terminal: true },
    { code: 'blocked', description: 'Required work, trusted evidence, integration state or a human decision is unavailable.', terminal: true },
    { code: 'failed', description: 'Development infrastructure or immutable lineage validation failed.', terminal: true },
  ],
  flow: {
    id: 'factory.development.standard',
    version: '2.1.0',
    entryNodeId: 'plan-task-graph',
    nodes: [
      {
        id: 'plan-task-graph',
        label: 'Plan Task Graph',
        kind: 'production-cell',
        description:
          'Produce one typed implementation/integration/verification graph; the cell gate validates exact lineage, coverage and DAG semantics before acceptance.',
        inputSchema: { id: DEVELOPMENT_CASE_SCHEMA },
        outputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
        cellDefinition: singletonProductionCell({
          id: 'development-plan-task-graph',
          executionProfileId: 'development-task-graph-planner',
          outputSchemaRef: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA,
          productSource: 'typed-submission',
          cardinality: '1',
          maxAttempts: 2,
          onExhausted: 'pause',
          checkPlan: PLANNER_CHECK_PLAN,
          acceptedTransition: 'resolve-task-graph',
          failedTransition: 'complete-failed',
          humanRequiredTransition: 'complete-blocked',
        }),
      },
      {
        id: 'resolve-task-graph',
        label: 'Freeze Task Graph',
        kind: 'kernel',
        description:
          'Canonicalize the already gate-accepted task-graph proposal and materialize its projected work idempotently.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph,
        inputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
        outputSchema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA },
      },
      {
        id: 'implement-work-items',
        label: 'Implement and Review Work Items',
        kind: 'production-cell',
        description:
          'Fan out validated implementation items through the universal Workplace author/review/gate/repair loop.',
        cellDefinition: {
          id: 'development-implementation',
          inputSelectors: ['resolve-task-graph.items'],
          materialization: {
            sourceBinding: 'resolve-task-graph',
            workKeySelector: 'items',
            dependencySelector: 'dependsOnKeys',
            completionPolicy: 'all',
            taskProvenance: { sourceArtifactIdsSelector: 'acceptanceCriterionIds' },
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
            productSource: 'typed-submission',
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
            payloadContract: {
              contractId: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
              version: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
              contractDigest: DEVELOPMENT_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST,
            },
            finalGate: {
              gateId: 'development-implementation-final',
              gatePhase: 'final',
              checkPlan: IMPLEMENTATION_FINAL_PLAN,
            },
          },
          recovery: { maxAttempts: 2, onExhausted: 'pause' },
          postAcceptanceEffect: 'git-integration',
          transitions: {
            accepted: 'freeze-integrated-candidate',
            humanRequired: 'complete-blocked',
            failed: 'complete-failed',
          },
        },
      },
      {
        id: 'freeze-integrated-candidate',
        label: 'Freeze Integrated Candidate',
        kind: 'kernel',
        description:
          'Observe the declared integration branches and persist one immutable content-addressed candidate after all accepted implementation results are merged.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.freezeIntegratedCandidate,
        inputSchema: { id: DEVELOPMENT_IMPLEMENTATION_RESULT_SCHEMA },
        outputSchema: { id: INTEGRATED_CANDIDATE_SCHEMA },
      },
      {
        id: 'verify-acceptance',
        label: 'Verify Acceptance Criteria',
        kind: 'production-cell',
        description:
          'Fan out independent acceptance verification over the exact frozen candidate.',
        cellDefinition: {
          id: 'development-verification',
          inputSelectors: [
            'resolve-task-graph.verificationItems',
            'freeze-integrated-candidate.candidate',
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
            productSource: 'typed-submission',
            payloadContract: {
              contractId: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_ID,
              version: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_VERSION,
              contractDigest: DEVELOPMENT_VERIFICATION_PAYLOAD_CONTRACT_DIGEST,
            },
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
          'Re-read exact accepted Cell products and the frozen candidate, then issue the deterministic Development certificate.',
        handler: DEVELOPMENT_KERNEL_HANDLER_IDS.settle,
        inputSchema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA },
        outputSchema: { id: DEVELOPMENT_CERTIFICATE_SCHEMA },
      },
      ...['verified', 'rework-required', 'clarification-required', 'blocked', 'failed']
        .map(code => ({
          id: `complete-${code}`,
          label: `Complete: ${code}`,
          kind: 'kernel' as const,
          description: `Emit the local Development process outcome '${code}'.`,
          handler: 'process-outcome-emitter',
          emitsOutcome: code,
        })),
    ],
    transitions: [
      { from: 'plan-task-graph', to: 'resolve-task-graph', on: 'domain.accepted' },
      { from: 'plan-task-graph', to: 'complete-failed', on: 'domain.failed' },
      { from: 'resolve-task-graph', to: 'implement-work-items', on: 'domain.valid' },
      { from: 'resolve-task-graph', to: 'settle-development', on: 'domain.clarification-required' },
      { from: 'resolve-task-graph', to: 'settle-development', on: 'domain.failed' },
      { from: 'implement-work-items', to: 'freeze-integrated-candidate', on: 'domain.accepted' },
      { from: 'implement-work-items', to: 'complete-failed', on: 'domain.failed' },
      { from: 'freeze-integrated-candidate', to: 'verify-acceptance', on: 'domain.frozen' },
      { from: 'freeze-integrated-candidate', to: 'settle-development', on: 'domain.failed' },
      { from: 'verify-acceptance', to: 'settle-development', on: 'domain.accepted' },
      { from: 'verify-acceptance', to: 'complete-failed', on: 'domain.failed' },
      ...['verified', 'rework-required', 'clarification-required', 'blocked', 'failed']
        .map(code => ({
          from: 'settle-development',
          to: `complete-${code}`,
          on: `domain.${code}`,
        })),
    ],
    terminalNodeIds: [
      'complete-verified', 'complete-rework-required',
      'complete-clarification-required', 'complete-blocked', 'complete-failed',
    ],
  },
  artifacts: [
    { type: 'development-case', schema: { id: DEVELOPMENT_CASE_SCHEMA }, authority: 'kernel', description: 'Immutable Development input.' },
    { type: 'development-task-graph-proposal', schema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA }, authority: 'worker', description: 'Typed planner product inspected inside its Production Cell.' },
    { type: 'development-task-graph', schema: { id: DEVELOPMENT_TASK_GRAPH_SCHEMA }, authority: 'kernel', description: 'Canonical coverage-complete acyclic work graph.' },
    { type: 'development-implementation-workset', schema: { id: DEVELOPMENT_IMPLEMENTATION_WORKSET_SCHEMA }, authority: 'kernel', description: 'Accepted implementation/review products reconstructed from Cell CandidateSets.' },
    { type: 'integrated-release-candidate', schema: { id: INTEGRATED_CANDIDATE_SCHEMA }, authority: 'kernel', description: 'Frozen integrated repository/build target.' },
    { type: 'acceptance-verification-workset', schema: { id: ACCEPTANCE_VERIFICATION_SCHEMA }, authority: 'kernel', description: 'Independent verification evidence bound to the frozen candidate.' },
    { type: 'verified-integration-bundle', schema: { id: VERIFIED_INTEGRATION_BUNDLE_SCHEMA }, authority: 'kernel', description: 'Canonical Development output for Delivery.' },
    { type: 'development-certificate', schema: { id: DEVELOPMENT_CERTIFICATE_SCHEMA }, authority: 'kernel', description: 'Immutable Development settlement decision.' },
  ],
  policies: [
    { id: 'development-task-graph-validation', version: '2.0.0', handler: DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph, description: 'Cell gate validates the proposal; kernel canonicalizes and materializes the accepted graph.' },
    { id: 'development-settlement', version: '1.0.0', handler: DEVELOPMENT_KERNEL_HANDLER_IDS.settle, description: 'Admits only a complete workset with trusted evidence for the unchanged frozen candidate.' },
    { id: 'development-candidate-freeze', version: '1.0.0', handler: DEVELOPMENT_KERNEL_HANDLER_IDS.freezeIntegratedCandidate, description: 'Seals merged repository heads before verification.' },
  ],
  invariants: [
    { id: 'development.planner-cell-gates-graph', description: 'Task-graph semantics are accepted or repaired inside the planner Production Cell before kernel materialization.', enforcement: 'runtime' },
    { id: 'development.review-before-integration', description: 'Only the exact source commit accepted by the implementation Cell may enter integration.', enforcement: 'policy' },
    { id: 'development.integrate-before-verification', description: 'Integration completes and one candidate freezes before verification starts.', enforcement: 'runtime' },
    { id: 'development.evidence-pins-candidate', description: 'Every acceptance record pins the accepted AC hash and frozen candidate hash.', enforcement: 'policy' },
    { id: 'development.no-post-verification-mutation', description: 'Candidate drift invalidates prior evidence.', enforcement: 'policy' },
    { id: 'development.unknown-denies', description: 'Unknown/error verification never authorizes a verified bundle.', enforcement: 'policy' },
    { id: 'development.exact-lineage', description: 'All cells and kernels consume exact immutable refs/hashes.', enforcement: 'test' },
    { id: 'development.module-does-not-route', description: 'Development emits only local outcomes; lifecycle routing is external.', enforcement: 'static' },
  ],
  executionProfiles: [
    {
      id: 'development-task-graph-planner',
      workIntentKind: 'development.plan-task-graph',
      workIntentSchema: { id: 'factory.work-intent.development-task-graph.v1' },
      taskKind: 'planning.decomposition',
      executionSkill: 'saga-planner',
      reviewSkill: 'saga-planning-reviewer',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-planner',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: [
        ...COMMON_READ_TOOLS,
        'conflict_check', 'product_submit', 'worker_done',
        'Write', 'Edit', 'Bash',
      ],
      trackerTemplate: DEVELOPMENT_TRACKER,
      workspaceTemplates: [DEVELOPMENT_SUBMISSION_CALL, DEVELOPMENT_CHECKLIST],
      callTemplates: [DEVELOPMENT_SUBMISSION_CALL],
      checklists: [DEVELOPMENT_CHECKLIST],
      outputSchema: { id: DEVELOPMENT_TASK_GRAPH_PROPOSAL_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['schema-rejected', 'lineage-gap'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
    {
      id: 'development-implementation-worker',
      workIntentKind: 'development.implementation',
      workIntentSchema: { id: 'factory.work-intent.development-implementation.v1' },
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
      retryPolicy: { maxAttempts: 2, retryOn: ['review-rejected', 'merge-conflict'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
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
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
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
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
  ],
};
