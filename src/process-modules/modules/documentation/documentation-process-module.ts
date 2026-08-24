import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import { buildCheckPlan } from '../../application/standard-check-providers.js';
import {
  REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
  REVIEW_VERDICT_CHECK_PROVIDER_ID,
  REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
} from '../../application/review-verdict-check-provider.js';
import { DOCUMENTATION_PROCESS_MODULE_REF } from '../../lifecycles/product-delivery-module-contracts.js';
import {
  DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_DIGEST,
  DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_ID,
  DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_VERSION,
  DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_DIGEST,
  DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_ID,
  DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_VERSION,
  DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST,
  DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
  DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
} from '../../../modules/documentation/application/documentation-check-providers.js';
import {
  DOCUMENTATION_BUNDLE_SCHEMA,
  DOCUMENTATION_CERTIFICATE_SCHEMA,
  DOCUMENTATION_DOCUMENT_SCHEMA,
  DOCUMENTATION_PLAN_SCHEMA,
  DOCUMENTATION_RELEASE_CASE_SCHEMA,
  DOCUMENTATION_REVIEW_VERDICT_SCHEMA,
} from '../../../modules/documentation/domain/documentation-schemas.js';

export { DOCUMENTATION_PROCESS_MODULE_REF };

const PROCESS_PROTOCOL_SKILL = 'saga-process-module-worker-protocol';
const DOCUMENTATION_RESOURCE_ROOT =
  'src/process-modules/modules/documentation/package/resources';
const DOCUMENTATION_TRACKER =
  `${DOCUMENTATION_RESOURCE_ROOT}/process-module-stage-tracker.md`;
const DOCUMENTATION_CHECKLIST =
  `${DOCUMENTATION_RESOURCE_ROOT}/documentation-writer-checklist.md`;
const DOCUMENTATION_SUBMISSION_CALL =
  `${DOCUMENTATION_RESOURCE_ROOT}/document-submit-call-template.json`;
const REVIEW_CALL_TEMPLATE =
  `${DOCUMENTATION_RESOURCE_ROOT}/review-verdict-call-template.json`;

const COMMON_READ_TOOLS = [
  'task_get', 'task_list', 'artifact_list', 'artifact_get', 'trace_list',
  'repository_list', 'candidate_read', 'product_read', 'Read', 'Glob', 'Grep',
] as const;

const AUTHOR_GATE_PLAN = buildCheckPlan(
  'documentation.document.author.v1',
  [{
    providerId: DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_ID,
    version: DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_VERSION,
    providerDigest: DOCUMENTATION_COMPLETENESS_CHECK_PROVIDER_DIGEST,
    repairTargetRoleOnFailure: 'author',
    repairTargetRoleOnIndeterminate: 'author',
    expectedSubjectSchemaRef: DOCUMENTATION_DOCUMENT_SCHEMA,
    subjectScope: 'cell-product',
  }],
);

const FINAL_GATE_PLAN = buildCheckPlan(
  'documentation.document.final.v1',
  [{
    providerId: REVIEW_VERDICT_CHECK_PROVIDER_ID,
    version: REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
    providerDigest: REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
    parameters: { verdictSchemaRef: DOCUMENTATION_REVIEW_VERDICT_SCHEMA },
    repairTargetRoleOnFailure: 'author',
    repairTargetRoleOnIndeterminate: 'reviewer',
    expectedSubjectSchemaRef: DOCUMENTATION_REVIEW_VERDICT_SCHEMA,
    subjectScope: 'cell-product',
  }],
);

/**
 * Documentation workshop. Consumes one verified Development candidate and
 * produces a rendered PDF documentation bundle (user manual, programmer
 * manual, acceptance report, …). Authors write STRUCTURED documents through
 * the universal Production Cell loop; a deterministic kernel renders PDFs and
 * a deterministic settlement issues the certificate. The module never renders,
 * accepts or routes by itself outside the universal grammar.
 */
export const documentationProcessModule: ProcessModuleDefinition = {
  identity: {
    ...DOCUMENTATION_PROCESS_MODULE_REF,
    kind: 'documentation',
    displayName: 'Documentation Release',
    description:
      'Authors, reviews and renders the PDF documentation set for one exact verified product candidate.',
  },
  inputContract: { id: DOCUMENTATION_RELEASE_CASE_SCHEMA },
  outputContract: { id: DOCUMENTATION_BUNDLE_SCHEMA },
  outcomes: [
    {
      code: 'documented',
      description: 'Every planned document kind is accepted and rendered with a deterministic receipt.',
      terminal: true,
    },
    {
      code: 'blocked',
      description: 'The render engine is unavailable or a human decision is required.',
      terminal: true,
    },
    {
      code: 'failed',
      description: 'Documentation integrity, lineage or rendering validation failed.',
      terminal: true,
    },
  ],
  flow: {
    id: 'factory.documentation.standard',
    version: '1.0.0',
    entryNodeId: 'assemble-documentation-case',
    nodes: [
      {
        id: 'assemble-documentation-case',
        label: 'Assemble Documentation Case',
        kind: 'kernel',
        description:
          'Validate the case, observe the repository at the exact integrated commit and emit one fan-out brief per requested document kind.',
        handler: 'documentation-case-assembler',
        inputSchema: { id: DOCUMENTATION_RELEASE_CASE_SCHEMA },
        outputSchema: { id: DOCUMENTATION_PLAN_SCHEMA },
      },
      {
        id: 'author-documents',
        label: 'Author and Review Documents',
        kind: 'production-cell',
        description:
          'Fan out document kinds through the universal Workplace author/review/gate/repair loop.',
        inputSchema: { id: DOCUMENTATION_PLAN_SCHEMA },
        outputSchema: { id: DOCUMENTATION_DOCUMENT_SCHEMA },
        cellDefinition: {
          id: 'documentation-authoring',
          inputSelectors: ['assemble-documentation-case.documents'],
          materialization: {
            sourceBinding: 'assemble-documentation-case',
            workKeySelector: 'documents',
            completionPolicy: 'all',
          },
          author: {
            skillRef: 'documentation-writer',
            capabilityPreset: 'module-author',
          },
          productContracts: [{
            binding: 'document',
            schemaRef: DOCUMENTATION_DOCUMENT_SCHEMA,
            mediaType: 'application/json',
            cardinality: '1',
            payloadContract: {
              contractId: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_ID,
              version: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_VERSION,
              contractDigest: DOCUMENTATION_DOCUMENT_PAYLOAD_CONTRACT_DIGEST,
            },
          }],
          authorGate: {
            gateId: 'documentation-authoring.author',
            gatePhase: 'author',
            checkPlan: AUTHOR_GATE_PLAN,
          },
          review: {
            reviewer: {
              skillRef: 'documentation-reviewer',
              capabilityPreset: 'module-reviewer',
            },
            verdictSchemaRef: DOCUMENTATION_REVIEW_VERDICT_SCHEMA,
            payloadContract: {
              contractId: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_ID,
              version: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_VERSION,
              contractDigest: DOCUMENTATION_REVIEW_VERDICT_PAYLOAD_CONTRACT_DIGEST,
            },
            finalGate: {
              gateId: 'documentation-authoring.final',
              gatePhase: 'final',
              checkPlan: FINAL_GATE_PLAN,
            },
          },
          recovery: { maxAttempts: 3, onExhausted: 'requeue' },
          transitions: {
            accepted: 'render-documentation-bundle',
            humanRequired: 'complete-blocked',
            failed: 'settle-documentation',
          },
        },
      },
      {
        id: 'render-documentation-bundle',
        label: 'Render Documentation Bundle',
        kind: 'kernel',
        description:
          'Deterministically render every accepted document product to PDF through the injected render provider; a missing engine is an honest typed blocked outcome.',
        handler: 'documentation-renderer',
        inputSchema: { id: DOCUMENTATION_PLAN_SCHEMA },
        outputSchema: { id: DOCUMENTATION_BUNDLE_SCHEMA },
      },
      {
        id: 'settle-documentation',
        label: 'Settle Documentation',
        kind: 'kernel',
        description:
          'Re-read the exact rendered workset and issue the deterministic Documentation certificate and outcome.',
        handler: 'documentation-settlement-policy',
        inputSchema: { id: DOCUMENTATION_PLAN_SCHEMA },
        outputSchema: { id: DOCUMENTATION_CERTIFICATE_SCHEMA },
      },
      ...['documented', 'blocked', 'failed'].map(code => ({
        id: `complete-${code}`,
        label: `Complete: ${code}`,
        kind: 'kernel' as const,
        description: `Emit the local Documentation process outcome '${code}'.`,
        handler: 'process-outcome-emitter',
        emitsOutcome: code,
      })),
    ],
    transitions: [
      { from: 'assemble-documentation-case', to: 'author-documents', on: 'domain.ready' },
      { from: 'assemble-documentation-case', to: 'settle-documentation', on: 'domain.failed' },
      { from: 'author-documents', to: 'render-documentation-bundle', on: 'domain.accepted' },
      // A terminally failed document routes through settlement for an explicit
      // ModuleCompletion and a continuation-acceptable terminal outcome.
      { from: 'author-documents', to: 'settle-documentation', on: 'domain.failed' },
      { from: 'render-documentation-bundle', to: 'settle-documentation', on: 'domain.rendered' },
      { from: 'render-documentation-bundle', to: 'settle-documentation', on: 'domain.blocked' },
      { from: 'render-documentation-bundle', to: 'settle-documentation', on: 'domain.failed' },
      ...['documented', 'blocked', 'failed'].map(code => ({
        from: 'settle-documentation',
        to: `complete-${code}`,
        on: `domain.${code}`,
      })),
    ],
    terminalNodeIds: [
      'complete-documented', 'complete-blocked', 'complete-failed',
    ],
  },
  artifacts: [
    {
      type: 'documentation-release-case',
      schema: { id: DOCUMENTATION_RELEASE_CASE_SCHEMA },
      authority: 'kernel',
      description: 'Immutable Documentation input bound to a verified Development candidate.',
    },
    {
      type: 'documentation-plan',
      schema: { id: DOCUMENTATION_PLAN_SCHEMA },
      authority: 'kernel',
      description: 'Per-kind authoring briefs with exact repository observations.',
    },
    {
      type: 'documentation-document',
      schema: { id: DOCUMENTATION_DOCUMENT_SCHEMA },
      authority: 'worker',
      description: 'Structured document authored and reviewed inside its Production Cell.',
    },
    {
      type: 'documentation-bundle',
      schema: { id: DOCUMENTATION_BUNDLE_SCHEMA },
      authority: 'kernel',
      description: 'Canonical record of rendered PDFs with byte hashes and render receipts.',
    },
    {
      type: 'documentation-certificate',
      schema: { id: DOCUMENTATION_CERTIFICATE_SCHEMA },
      authority: 'kernel',
      description: 'Immutable Documentation settlement decision.',
    },
  ],
  policies: [
    {
      id: 'documentation-settlement',
      version: '1.0.0',
      handler: 'documentation-settlement-policy',
      description: 'Admits documentation only when every planned kind has an accepted product and a render receipt.',
    },
  ],
  invariants: [
    {
      id: 'documentation.exact-candidate',
      description: 'All briefs, documents and renders bind the exact integrated candidate hash.',
      enforcement: 'policy',
    },
    {
      id: 'documentation.repository-reads-pinned',
      description: 'Repository observation reads only the exact integrated commit, never a mutable checkout.',
      enforcement: 'runtime',
    },
    {
      id: 'documentation.render-is-deterministic-kernel',
      description: 'PDF rendering is a deterministic provider capability, never LM authority.',
      enforcement: 'static',
    },
    {
      id: 'documentation.missing-engine-blocks',
      description: 'An unavailable render engine yields an honest blocked outcome, never a degraded release.',
      enforcement: 'runtime',
    },
    {
      id: 'documentation.module-does-not-route',
      description: 'Documentation emits only local outcomes; lifecycle routing is external.',
      enforcement: 'static',
    },
  ],
  executionProfiles: [
    {
      id: 'documentation-writer',
      workIntentKind: 'documentation.author',
      workIntentSchema: { id: 'factory.work-intent.documentation-author.v1' },
      taskKind: 'documentation.author',
      executionSkill: 'saga-documentation-writer',
      reviewSkill: null,
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-documentation-writer',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: [
        ...COMMON_READ_TOOLS,
        'product_submit', 'worker_done',
      ],
      trackerTemplate: DOCUMENTATION_TRACKER,
      workspaceTemplates: [DOCUMENTATION_CHECKLIST, DOCUMENTATION_SUBMISSION_CALL],
      callTemplates: [DOCUMENTATION_SUBMISSION_CALL],
      checklists: [DOCUMENTATION_CHECKLIST],
      outputSchema: { id: DOCUMENTATION_DOCUMENT_SCHEMA },
      retryPolicy: { maxAttempts: 3, retryOn: ['schema-rejected', 'completeness-rejected'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
    {
      id: 'documentation-reviewer',
      workIntentKind: 'documentation.review',
      workIntentSchema: { id: 'factory.work-intent.documentation-review.v1' },
      taskKind: 'documentation.review',
      executionSkill: 'saga-documentation-writer',
      reviewSkill: null,
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-documentation-writer',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: [
        ...COMMON_READ_TOOLS,
        'product_submit', 'worker_done',
      ],
      trackerTemplate: DOCUMENTATION_TRACKER,
      workspaceTemplates: [REVIEW_CALL_TEMPLATE],
      callTemplates: [REVIEW_CALL_TEMPLATE],
      checklists: [DOCUMENTATION_CHECKLIST],
      outputSchema: { id: DOCUMENTATION_REVIEW_VERDICT_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['review-rejected'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
  ],
};
