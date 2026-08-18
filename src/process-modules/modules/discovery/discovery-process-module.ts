import type { ProcessModuleDefinition } from '../../domain/process-module.js';
import { singletonProductionCell } from '../../application/standard-production-cell.js';
import { buildCheckPlan } from '../../application/standard-check-providers.js';
import {
  DISCOVERY_PROPOSAL_SCHEMA,
  DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
  DISCOVERY_INTENT_KIND,
  DISCOVERY_READINESS_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} from '../../../modules/discovery/domain/discovery-domain-contracts.js';
import {
  DISCOVERY_PROPOSAL_CHECK_PROVIDER_DIGEST,
  DISCOVERY_PROPOSAL_CHECK_PROVIDER_ID,
  DISCOVERY_PROPOSAL_CHECK_PROVIDER_VERSION,
  DISCOVERY_READINESS_CHECK_PROVIDER_DIGEST,
  DISCOVERY_READINESS_CHECK_PROVIDER_ID,
  DISCOVERY_READINESS_CHECK_PROVIDER_VERSION,
} from '../../../modules/discovery/application/discovery-check-providers.js';
import { DISCOVERY_PROCESS_MODULE_REF } from '../../lifecycles/product-delivery-module-contracts.js';
export { DISCOVERY_PROCESS_MODULE_REF };

const DISCOVERY_RESOURCE_ROOT =
  'src/process-modules/modules/discovery/package/resources';
const DISCOVERY_PROPOSAL_TRACKER =
  `${DISCOVERY_RESOURCE_ROOT}/proposal-stage-tracker.md`;
const DISCOVERY_READINESS_TRACKER =
  `${DISCOVERY_RESOURCE_ROOT}/readiness-stage-tracker.md`;
const PROCESS_PROTOCOL_SKILL = 'saga-process-module-worker-protocol';

const PROPOSAL_PLAN = buildCheckPlan('discovery.proposal.final', [{
  providerId: DISCOVERY_PROPOSAL_CHECK_PROVIDER_ID,
  version: DISCOVERY_PROPOSAL_CHECK_PROVIDER_VERSION,
  providerDigest: DISCOVERY_PROPOSAL_CHECK_PROVIDER_DIGEST,
}]);
const READINESS_PLAN = buildCheckPlan('discovery.readiness.final', [{
  providerId: DISCOVERY_READINESS_CHECK_PROVIDER_ID,
  version: DISCOVERY_READINESS_CHECK_PROVIDER_VERSION,
  providerDigest: DISCOVERY_READINESS_CHECK_PROVIDER_DIGEST,
}]);

/**
 * Product Discovery on the target factory runtime.
 *
 * There are exactly two cognitive desks: Proposal and Readiness. Each is a
 * normal Production Cell with an immutable product, semantic CheckProvider,
 * GateDecision and bounded repair budget. The old normalization/readiness
 * ControlIntent mini-orchestrators do not exist in this Flow.
 */
export const discoveryProcessModule: ProcessModuleDefinition = {
  identity: {
    ...DISCOVERY_PROCESS_MODULE_REF,
    kind: 'discovery',
    displayName: 'Product Discovery',
    description:
      'Produces a grounded proposal, independently assesses readiness, and settles one authoritative discovery outcome.',
  },
  inputContract: { id: 'factory.discovery-case.v1' },
  outputContract: { id: 'factory.discovery-outcome-certificate.v1' },
  outcomes: [
    { code: 'go', description: 'The subject is sufficiently grounded to continue.', terminal: true },
    { code: 'clarify', description: 'Material information is missing or contradictory.', terminal: true },
    { code: 'reject', description: 'The subject should not continue under current evidence and policy.', terminal: true },
    { code: 'failed', description: 'Discovery infrastructure could not produce an authoritative result.', terminal: true },
  ],
  flow: {
    id: 'factory.discovery.standard',
    version: '2.0.0',
    entryNodeId: 'produce-proposal',
    nodes: [
      {
        id: 'produce-proposal',
        label: 'Produce Discovery Proposal',
        kind: 'production-cell',
        description:
          'Investigate the bounded subject and submit one canonical typed DiscoveryProposal.',
        outputSchema: { id: DISCOVERY_PROPOSAL_SCHEMA },
        cellDefinition: singletonProductionCell({
          id: 'discovery-proposal',
          executionProfileId: 'discovery-proposal-worker',
          outputSchemaRef: DISCOVERY_PROPOSAL_SCHEMA,
          cardinality: '1',
          maxAttempts: 2,
          onExhausted: 'requeue',
          checkPlan: PROPOSAL_PLAN,
          acceptedTransition: 'assess-readiness',
          failedTransition: 'complete-failed',
        }),
      },
      {
        id: 'assess-readiness',
        label: 'Assess Proposal Readiness',
        kind: 'production-cell',
        description:
          'Read the exact accepted Proposal product and submit one source-bound readiness assessment.',
        inputSchema: { id: DISCOVERY_PROPOSAL_SCHEMA },
        outputSchema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA },
        cellDefinition: singletonProductionCell({
          id: 'discovery-readiness',
          executionProfileId: 'discovery-readiness-advisor',
          outputSchemaRef: DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
          cardinality: '1',
          maxAttempts: 2,
          onExhausted: 'requeue',
          checkPlan: READINESS_PLAN,
          acceptedTransition: 'settle',
          failedTransition: 'complete-failed',
        }),
      },
      {
        id: 'settle',
        label: 'Settle Discovery',
        kind: 'kernel',
        description:
          'Read the exact accepted Proposal and Readiness products, apply the pinned deterministic policy, and issue the immutable certificate.',
        handler: 'discovery-settlement-policy',
        inputSchema: { id: 'factory.discovery-settlement-input.v1' },
        outputSchema: { id: 'factory.discovery-outcome-certificate.v1' },
      },
      ...['go', 'clarify', 'reject', 'failed']
        .map(code => ({
          id: `complete-${code}`,
          label: `Complete: ${code}`,
          kind: 'kernel' as const,
          description: `Emit the local Discovery process outcome '${code}'.`,
          handler: 'process-outcome-emitter',
          emitsOutcome: code,
        })),
    ],
    transitions: [
      { from: 'produce-proposal', to: 'assess-readiness', on: 'domain.accepted' },
      { from: 'produce-proposal', to: 'complete-failed', on: 'domain.failed' },
      { from: 'assess-readiness', to: 'settle', on: 'domain.accepted' },
      { from: 'assess-readiness', to: 'complete-failed', on: 'domain.failed' },
      { from: 'settle', to: 'complete-go', on: 'domain.go' },
      { from: 'settle', to: 'complete-clarify', on: 'domain.clarify' },
      { from: 'settle', to: 'complete-reject', on: 'domain.reject' },
      { from: 'settle', to: 'complete-failed', on: 'domain.failed' },
    ],
    terminalNodeIds: [
      'complete-go', 'complete-clarify', 'complete-reject', 'complete-failed',
    ],
  },
  artifacts: [
    { type: 'discovery-case', schema: { id: 'factory.discovery-case.v1' }, authority: 'kernel', description: 'Immutable process input.' },
    { type: 'discovery-proposal', schema: { id: DISCOVERY_PROPOSAL_SCHEMA }, authority: 'worker', description: 'Accepted Proposal Cell product.' },
    { type: 'discovery-readiness-assessment', schema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA }, authority: 'advisor', description: 'Accepted Readiness Cell product.' },
    { type: 'discovery-outcome-certificate', schema: { id: 'factory.discovery-outcome-certificate.v1' }, authority: 'kernel', description: 'Immutable authoritative process result.' },
  ],
  policies: [{
    id: 'discovery-settlement',
    version: '2.0.0',
    handler: 'discovery-settlement-policy',
    description:
      'The sole authority converting exact accepted Proposal and Readiness products into a discovery decision.',
  }],
  invariants: [
    { id: 'discovery.cells-produce', description: 'Cognitive work occurs only inside universal Production Cells.', enforcement: 'runtime' },
    { id: 'discovery.gates-accept', description: 'Only Cell GateDecisions accept Proposal or Readiness products.', enforcement: 'runtime' },
    { id: 'discovery.kernel-settles', description: 'Only deterministic settlement issues the discovery certificate.', enforcement: 'policy' },
    { id: 'discovery.exact-lineage', description: 'Readiness and settlement consume exact immutable ProductRefs, never latest/task heuristics.', enforcement: 'test' },
  ],
  executionProfiles: [
    {
      id: 'discovery-proposal-worker',
      workIntentKind: DISCOVERY_INTENT_KIND,
      workIntentSchema: { id: DISCOVERY_WORK_INTENT_SCHEMA },
      taskKind: 'discovery.work',
      executionSkill: 'saga-discovery-worker',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-discovery-worker',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: [
        'task_get', 'repository_checkout_list', 'artifact_list', 'note_list',
        'product_submit', 'worker_done', 'Write', 'Read', 'Edit', 'Bash', 'Glob', 'Grep',
      ],
      trackerTemplate: DISCOVERY_PROPOSAL_TRACKER,
      workspaceTemplates: [
        `${DISCOVERY_RESOURCE_ROOT}/discovery-doc-template.md`,
        `${DISCOVERY_RESOURCE_ROOT}/proposal-call-template.json`,
      ],
      callTemplates: [`${DISCOVERY_RESOURCE_ROOT}/proposal-call-template.json`],
      checklists: [`${DISCOVERY_RESOURCE_ROOT}/proposal-checklist.md`],
      outputSchema: { id: DISCOVERY_PROPOSAL_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['gate-repair'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
    {
      id: 'discovery-readiness-advisor',
      workIntentKind: DISCOVERY_READINESS_INTENT_KIND,
      workIntentSchema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA },
      taskKind: 'discovery.assess',
      executionSkill: 'saga-discovery-readiness-advisor',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-discovery-readiness-advisor',
      artifactAcceptanceAuthority: 'kernel-gate',
      executionMode: 'tracker_only',
      allowedTools: [
        'task_get', 'product_read', 'product_submit', 'worker_done', 'Read', 'Edit',
      ],
      trackerTemplate: DISCOVERY_READINESS_TRACKER,
      workspaceTemplates: [`${DISCOVERY_RESOURCE_ROOT}/readiness-call-template.json`],
      callTemplates: [`${DISCOVERY_RESOURCE_ROOT}/readiness-call-template.json`],
      checklists: [`${DISCOVERY_RESOURCE_ROOT}/readiness-checklist.md`],
      outputSchema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['gate-repair'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
  ],
};
