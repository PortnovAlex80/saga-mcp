import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import { singletonProductionCell } from '../../application/standard-production-cell.js';
import { buildCheckPlan } from '../../application/standard-check-providers.js';
import {
  FACTORY_REVIEW_VERDICT_SCHEMA,
  REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
  REVIEW_VERDICT_CHECK_PROVIDER_ID,
  REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
} from '../../application/review-verdict-check-provider.js';
import { SRS_CONTRACT_REF } from '../../../modules/formalization/domain/srs-contract.js';
import {
  FORMALIZATION_CHECK_REFS,
} from '../../../modules/formalization/application/formalization-check-providers.js';
import {
  FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID,
} from '../../../modules/formalization/application/formalization-accept-products-effect.js';
import {
  FORMALIZATION_KERNEL_HANDLER_IDS,
} from '../../../modules/formalization/application/formalization-production-cell-installation.js';
import {
  ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
  FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA,
  FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA,
  FORMALIZATION_CASE_SCHEMA,
  FORMALIZATION_PRODUCT_BUNDLE_SCHEMA,
  FORMALIZATION_RECONCILIATION_SCHEMA,
  FORMALIZATION_USE_CASE_BUNDLE_SCHEMA,
  SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
} from '../../../modules/formalization/domain/formalization-schemas.js';
import { FORMALIZATION_PROCESS_MODULE_REF } from '../../lifecycles/product-delivery-module-contracts.js';
export { FORMALIZATION_PROCESS_MODULE_REF };

const ROOT = 'src/process-modules/modules/formalization/package/resources';
const TRACKER = `${ROOT}/process-module-stage-tracker.md`;
const ARTIFACT_CALL = `${ROOT}/artifact-create-call-template.json`;
const TRACE_CALL = `${ROOT}/trace-add-call-template.json`;
const DONE_CALL = `${ROOT}/worker-done-call-template.json`;
const CHECKLIST = `${ROOT}/formalization-node-checklist.md`;
const RECONCILIATION_CALL = `${ROOT}/reconciliation-product-call-template.json`;
const PROCESS_PROTOCOL_SKILL = 'saga-process-module-worker-protocol';

const COMMON_READ_TOOLS = [
  'task_get', 'artifact_list', 'artifact_get', 'trace_list', 'note_list',
  'repository_checkout_list', 'Read', 'Glob', 'Grep',
] as const;
const COMMON_WRITE_TOOLS = [
  ...COMMON_READ_TOOLS,
  'artifact_create', 'artifact_update', 'trace_add', 'trace_delete',
  'worker_done', 'Write', 'Edit', 'Bash',
] as const;
const REVIEW_TOOLS = [
  ...COMMON_READ_TOOLS,
  'candidate_read', 'product_read', 'product_submit', 'worker_done',
] as const;

function authorPlan(
  id: string,
  check: { providerId: string; version: string; providerDigest: string },
) {
  return buildCheckPlan(`${id}.author`, [check]);
}

function reviewPlan(id: string) {
  return buildCheckPlan(`${id}.final`, [{
    providerId: REVIEW_VERDICT_CHECK_PROVIDER_ID,
    version: REVIEW_VERDICT_CHECK_PROVIDER_VERSION,
    providerDigest: REVIEW_VERDICT_CHECK_PROVIDER_DIGEST,
    parameters: { verdictSchemaRef: FACTORY_REVIEW_VERDICT_SCHEMA },
  }]);
}

function reviewedCell(input: {
  id: string;
  authorProfile: string;
  reviewerProfile: string;
  outputSchema: string;
  check: { providerId: string; version: string; providerDigest: string };
  acceptedTransition: string;
  productSource?: 'typed-submission' | 'managed-production';
}) {
  return singletonProductionCell({
    id: input.id,
    executionProfileId: input.authorProfile,
    outputSchemaRef: input.outputSchema,
    productSource: input.productSource ?? 'managed-production',
    cardinality: '1',
    maxAttempts: 2,
    onExhausted: 'pause',
    checkPlan: authorPlan(input.id, input.check),
    postAcceptanceEffect: FORMALIZATION_ACCEPT_PRODUCTS_EFFECT_ID,
    review: {
      executionProfileId: input.reviewerProfile,
      verdictSchemaRef: FACTORY_REVIEW_VERDICT_SCHEMA,
      finalCheckPlan: reviewPlan(input.id),
    },
    acceptedTransition: input.acceptedTransition,
    humanRequiredTransition: 'complete-clarification-required',
    failedTransition: 'complete-failed',
  });
}

/**
 * Solution Formalization on the target factory runtime.
 *
 * Every cognitive desk is a universal Production Cell. Structural/domain
 * validation is a package CheckProvider inside the author gate; independent
 * semantic review is a reviewer desk whose immutable verdict is consumed by
 * the final gate. There are no LM/resolver pairs and no FlowRecovery machine.
 */
export const formalizationProcessModule: ProcessModuleDefinition = {
  identity: {
    ...FORMALIZATION_PROCESS_MODULE_REF,
    kind: 'formalization',
    displayName: 'Solution Formalization',
    description:
      'Converts an accepted discovery subject into a frozen, traceable and implementable solution contract.',
  },
  inputContract: { id: FORMALIZATION_CASE_SCHEMA },
  outputContract: { id: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA },
  outcomes: [
    { code: 'formalized', description: 'A complete frozen solution contract is ready for downstream work.', terminal: true },
    { code: 'clarification-required', description: 'Required product or acceptance information is missing.', terminal: true },
    { code: 'inconsistent', description: 'The contract graph contains unresolved contradictions or traceability gaps.', terminal: true },
    { code: 'infeasible', description: 'The requested solution cannot be implemented under the accepted constraints.', terminal: true },
    { code: 'failed', description: 'Formalization infrastructure could not produce an authoritative result.', terminal: true },
  ],
  flow: {
    id: 'factory.formalization.standard',
    version: '2.0.0',
    entryNodeId: 'define-product-contract',
    nodes: [
      {
        id: 'define-product-contract',
        label: 'Define Product Contract',
        kind: 'production-cell',
        description: 'Produce PRD plus FR/NFR/RULE artifacts and root lineage.',
        outputSchema: { id: FORMALIZATION_PRODUCT_BUNDLE_SCHEMA },
        cellDefinition: reviewedCell({
          id: 'formalization-product-contract',
          authorProfile: 'formalization-product',
          reviewerProfile: 'formalization-requirements-reviewer',
          outputSchema: FORMALIZATION_PRODUCT_BUNDLE_SCHEMA,
          check: FORMALIZATION_CHECK_REFS.product,
          acceptedTransition: 'model-use-cases',
        }),
      },
      {
        id: 'model-use-cases',
        label: 'Model Use Cases',
        kind: 'production-cell',
        description: 'Produce accepted use cases covering the product requirements.',
        outputSchema: { id: FORMALIZATION_USE_CASE_BUNDLE_SCHEMA },
        cellDefinition: reviewedCell({
          id: 'formalization-use-cases',
          authorProfile: 'formalization-use-cases',
          reviewerProfile: 'formalization-requirements-reviewer',
          outputSchema: FORMALIZATION_USE_CASE_BUNDLE_SCHEMA,
          check: FORMALIZATION_CHECK_REFS.useCases,
          acceptedTransition: 'define-acceptance-contract',
        }),
      },
      {
        id: 'define-acceptance-contract',
        label: 'Define Acceptance Contract',
        kind: 'production-cell',
        description: 'Produce acceptance criteria derived from UC/FR/NFR.',
        outputSchema: { id: FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA },
        cellDefinition: reviewedCell({
          id: 'formalization-acceptance-contract',
          authorProfile: 'formalization-acceptance',
          reviewerProfile: 'formalization-requirements-reviewer',
          outputSchema: FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA,
          check: FORMALIZATION_CHECK_REFS.acceptance,
          acceptedTransition: 'reconcile-what',
        }),
      },
      {
        id: 'reconcile-what',
        label: 'Reconcile WHAT Contract',
        kind: 'production-cell',
        description:
          'Repair permitted WHAT traceability gaps and submit an explicit typed reconciliation report, including a no-op report when nothing changed.',
        outputSchema: { id: FORMALIZATION_RECONCILIATION_SCHEMA },
        cellDefinition: reviewedCell({
          id: 'formalization-reconciliation',
          authorProfile: 'formalization-reconciler',
          reviewerProfile: 'formalization-requirements-reviewer',
          outputSchema: FORMALIZATION_RECONCILIATION_SCHEMA,
          check: FORMALIZATION_CHECK_REFS.reconciliation,
          acceptedTransition: 'freeze-acceptance-baseline',
          productSource: 'typed-submission',
        }),
      },
      {
        id: 'freeze-acceptance-baseline',
        label: 'Freeze Acceptance Baseline',
        kind: 'kernel',
        description: 'Freeze exact accepted AC ids/hashes after the reconciliation Cell is accepted.',
        handler: FORMALIZATION_KERNEL_HANDLER_IDS.freezeBaseline,
        inputSchema: { id: FORMALIZATION_RECONCILIATION_SCHEMA },
        outputSchema: { id: ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA },
      },
      {
        id: 'define-architecture-contract',
        label: 'Define Architecture Contract',
        kind: 'production-cell',
        description:
          'Produce the SRS/HOW contract against the frozen AC baseline. The SRS owns decomposition metadata; frozen AC artifacts are never mutated.',
        inputSchema: { id: ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA },
        outputSchema: { id: FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA },
        cellDefinition: reviewedCell({
          id: 'formalization-architecture-contract',
          authorProfile: 'formalization-architect',
          reviewerProfile: 'formalization-architecture-reviewer',
          outputSchema: FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA,
          check: FORMALIZATION_CHECK_REFS.architecture,
          acceptedTransition: 'settle-formalization',
        }),
      },
      {
        id: 'settle-formalization',
        label: 'Settle Formalization',
        kind: 'kernel',
        description:
          'Read accepted canonical artifacts/traces plus the frozen baseline, derive Development bindings from accepted SRS §D2, and issue the Solution Contract certificate.',
        handler: FORMALIZATION_KERNEL_HANDLER_IDS.settle,
        inputSchema: { id: FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA },
        outputSchema: { id: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA },
      },
      ...['formalized', 'clarification-required', 'inconsistent', 'infeasible', 'failed']
        .map(code => ({
          id: `complete-${code}`,
          label: `Complete: ${code}`,
          kind: 'kernel' as const,
          description: `Emit the local Formalization outcome '${code}'.`,
          handler: 'process-outcome-emitter',
          emitsOutcome: code,
        })),
    ],
    transitions: [
      { from: 'define-product-contract', to: 'model-use-cases', on: 'domain.accepted' },
      { from: 'define-product-contract', to: 'complete-failed', on: 'domain.failed' },
      { from: 'model-use-cases', to: 'define-acceptance-contract', on: 'domain.accepted' },
      { from: 'model-use-cases', to: 'complete-failed', on: 'domain.failed' },
      { from: 'define-acceptance-contract', to: 'reconcile-what', on: 'domain.accepted' },
      { from: 'define-acceptance-contract', to: 'complete-failed', on: 'domain.failed' },
      { from: 'reconcile-what', to: 'freeze-acceptance-baseline', on: 'domain.accepted' },
      { from: 'reconcile-what', to: 'complete-failed', on: 'domain.failed' },
      { from: 'freeze-acceptance-baseline', to: 'define-architecture-contract', on: 'domain.frozen' },
      { from: 'freeze-acceptance-baseline', to: 'complete-inconsistent', on: 'domain.drift-detected' },
      { from: 'freeze-acceptance-baseline', to: 'complete-failed', on: 'domain.failed' },
      { from: 'define-architecture-contract', to: 'settle-formalization', on: 'domain.accepted' },
      { from: 'define-architecture-contract', to: 'complete-failed', on: 'domain.failed' },
      { from: 'settle-formalization', to: 'complete-formalized', on: 'domain.formalized' },
      { from: 'settle-formalization', to: 'complete-clarification-required', on: 'domain.clarification-required' },
      { from: 'settle-formalization', to: 'complete-inconsistent', on: 'domain.inconsistent' },
      { from: 'settle-formalization', to: 'complete-infeasible', on: 'domain.infeasible' },
      { from: 'settle-formalization', to: 'complete-failed', on: 'domain.failed' },
    ],
    terminalNodeIds: [
      'complete-formalized', 'complete-clarification-required',
      'complete-inconsistent', 'complete-infeasible', 'complete-failed',
    ],
  },
  artifacts: [
    { type: 'formalization-case', schema: { id: FORMALIZATION_CASE_SCHEMA }, authority: 'kernel', description: 'Immutable handoff from Discovery.' },
    { type: 'formalization-product-bundle', schema: { id: FORMALIZATION_PRODUCT_BUNDLE_SCHEMA }, authority: 'worker', description: 'Accepted product-contract Cell product.' },
    { type: 'formalization-use-case-bundle', schema: { id: FORMALIZATION_USE_CASE_BUNDLE_SCHEMA }, authority: 'worker', description: 'Accepted use-case Cell product.' },
    { type: 'formalization-acceptance-bundle', schema: { id: FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA }, authority: 'worker', description: 'Accepted AC Cell product.' },
    { type: 'formalization-reconciliation-report', schema: { id: FORMALIZATION_RECONCILIATION_SCHEMA }, authority: 'worker', description: 'Accepted explicit reconciliation result.' },
    { type: 'acceptance-baseline-snapshot', schema: { id: ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA }, authority: 'kernel', description: 'Frozen accepted AC ids/hashes.' },
    { type: 'formalization-architecture-bundle', schema: { id: FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA }, authority: 'worker', description: 'Accepted SRS/HOW Cell product.' },
    { type: 'solution-contract-certificate', schema: { id: SOLUTION_CONTRACT_CERTIFICATE_SCHEMA }, authority: 'kernel', description: 'Frozen Solution Contract output.' },
  ],
  policies: [{
    id: 'formalization-settlement',
    version: '2.0.0',
    handler: FORMALIZATION_KERNEL_HANDLER_IDS.settle,
    description: 'Settles the accepted canonical graph after all Cell gates and baseline freeze.',
  }],
  invariants: [
    { id: 'formalization.cells-produce', description: 'All cognitive products are produced and repaired only inside universal Production Cells.', enforcement: 'runtime' },
    { id: 'formalization.gates-accept', description: 'Only durable GateDecisions accept author/reviewer CandidateSets.', enforcement: 'runtime' },
    { id: 'formalization.baseline-before-how', description: 'The AC baseline freezes before the architecture Cell starts.', enforcement: 'runtime' },
    { id: 'formalization.ac-immutable-after-baseline', description: 'Architecture never mutates frozen AC artifacts; ac_kind/criticality are SRS §D2 HOW metadata.', enforcement: 'policy' },
    { id: 'formalization.settlement-single-authority', description: 'Only deterministic settlement issues the Solution Contract certificate.', enforcement: 'policy' },
  ],
  executionProfiles: [
    authorProfile('formalization-product', 'formalization.product', 'formalization.product', 'saga-product', FORMALIZATION_PRODUCT_BUNDLE_SCHEMA),
    authorProfile('formalization-use-cases', 'formalization.use-cases', 'formalization.use-cases', 'saga-analyst', FORMALIZATION_USE_CASE_BUNDLE_SCHEMA),
    authorProfile('formalization-acceptance', 'formalization.acceptance', 'formalization.acceptance', 'saga-analyst', FORMALIZATION_ACCEPTANCE_BUNDLE_SCHEMA),
    {
      ...authorProfile('formalization-reconciler', 'formalization.reconcile', 'formalization.reconcile', 'saga-reconciler', FORMALIZATION_RECONCILIATION_SCHEMA),
      allowedTools: [...COMMON_WRITE_TOOLS, 'product_submit'],
      workspaceTemplates: [ARTIFACT_CALL, TRACE_CALL, DONE_CALL, CHECKLIST, RECONCILIATION_CALL],
      callTemplates: [ARTIFACT_CALL, TRACE_CALL, DONE_CALL, RECONCILIATION_CALL],
    },
    {
      ...authorProfile('formalization-architect', 'formalization.architecture', 'formalization.architecture', 'saga-architect', FORMALIZATION_ARCHITECTURE_BUNDLE_SCHEMA),
      contractRef: SRS_CONTRACT_REF,
    },
    reviewerProfile('formalization-requirements-reviewer', 'formalization.review.requirements', 'saga-requirements-reviewer'),
    reviewerProfile('formalization-architecture-reviewer', 'formalization.review.architecture', 'saga-architecture-reviewer'),
  ],
};

function authorProfile(
  id: string,
  workIntentKind: string,
  taskKind: string,
  executionSkill: string,
  outputSchema: string,
) {
  return {
    id,
    workIntentKind,
    workIntentSchema: { id: `factory.work-intent.${id}.v1` },
    taskKind,
    executionSkill,
    reviewSkill: null,
    protocolSkill: PROCESS_PROTOCOL_SKILL,
    semanticSkill: executionSkill,
    artifactAcceptanceAuthority: 'kernel-gate' as const,
    executionMode: 'tracker_only' as const,
    allowedTools: COMMON_WRITE_TOOLS,
    trackerTemplate: TRACKER,
    workspaceTemplates: [ARTIFACT_CALL, TRACE_CALL, DONE_CALL, CHECKLIST],
    callTemplates: [ARTIFACT_CALL, TRACE_CALL, DONE_CALL],
    checklists: [CHECKLIST],
    outputSchema: { id: outputSchema },
    retryPolicy: { maxAttempts: 2, retryOn: ['gate-repair'], backoff: 'none' as const },
    recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' as const },
  };
}

function reviewerProfile(
  id: string,
  workIntentKind: string,
  executionSkill: string,
) {
  return {
    id,
    workIntentKind,
    workIntentSchema: { id: `factory.work-intent.${id}.v1` },
    taskKind: 'formalization.review',
    executionSkill,
    reviewSkill: null,
    protocolSkill: PROCESS_PROTOCOL_SKILL,
    semanticSkill: executionSkill,
    artifactAcceptanceAuthority: 'kernel-gate' as const,
    executionMode: 'tracker_only' as const,
    allowedTools: REVIEW_TOOLS,
    trackerTemplate: TRACKER,
    workspaceTemplates: [CHECKLIST],
    callTemplates: [],
    checklists: [CHECKLIST],
    outputSchema: { id: FACTORY_REVIEW_VERDICT_SCHEMA },
    retryPolicy: { maxAttempts: 2, retryOn: ['gate-repair'], backoff: 'none' as const },
    recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' as const },
  };
}
