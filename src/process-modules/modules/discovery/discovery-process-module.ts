import type { ProcessModuleDefinition } from '../../domain/process-module.js';
// CONVEYOR Wave 7 — saga3 cross-tree leak elimination: the schema-id constants
// and intent-kind constants are now declared locally in the discovery module
// (discovery-domain-contracts.ts), byte-identical to the saga3 originals. The
// module no longer reaches into src/saga3/domain/**.
import {
  DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
  DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA,
  DISCOVERY_PROPOSAL_SCHEMA,
  DISCOVERY_READINESS_ASSESSMENT_SCHEMA,
  DISCOVERY_DIAGNOSIS_INTENT_KIND,
  DISCOVERY_INTENT_KIND,
  DISCOVERY_NORMALIZATION_INTENT_KIND,
  DISCOVERY_READINESS_INTENT_KIND,
  DISCOVERY_WORK_INTENT_SCHEMA,
} from './discovery-domain-contracts.js';

// CONVEYOR Wave 7: the module identity ref is a CANONICAL contract owned by the
// lifecycle (Rule 3). This module imports it back — inward direction, allowed.
import { DISCOVERY_PROCESS_MODULE_REF } from '../../lifecycles/product-delivery-module-contracts.js';
export { DISCOVERY_PROCESS_MODULE_REF };

// W13-A2: resources were moved out of the legacy global root
// (`tool-templates/discovery/`) into the discovery package resources directory
// (`src/process-modules/modules/discovery/package/resources/`). These are
// repo-root-relative POSIX paths — the workspace materializer resolves them
// under `workspaceRoot` (process.cwd()), matching the delivery/formalization
// package pattern. See the discovery package manifest for the matching
// `resourceIndex` declarations.
const DISCOVERY_RESOURCE_ROOT =
  'src/process-modules/modules/discovery/package/resources';
const DISCOVERY_PROPOSAL_TRACKER = `${DISCOVERY_RESOURCE_ROOT}/proposal-stage-tracker.md`;
const DISCOVERY_NORMALIZATION_TRACKER = `${DISCOVERY_RESOURCE_ROOT}/normalization-stage-tracker.md`;
const DISCOVERY_READINESS_TRACKER = `${DISCOVERY_RESOURCE_ROOT}/readiness-stage-tracker.md`;
const DISCOVERY_DIAGNOSIS_TRACKER = `${DISCOVERY_RESOURCE_ROOT}/diagnosis-stage-tracker.md`;
const PROCESS_PROTOCOL_SKILL = 'saga-process-module-worker-protocol';

export const discoveryProcessModule: ProcessModuleDefinition = {
  identity: {
    ...DISCOVERY_PROCESS_MODULE_REF,
    kind: 'discovery',
    displayName: 'Product Discovery',
    description: 'Turns an idea or problem into an authoritative discovery outcome certificate.',
  },
  inputContract: { id: 'saga3.discovery-case.v1' },
  outputContract: { id: 'saga3.discovery-outcome-certificate.v1' },
  outcomes: [
    { code: 'go', description: 'The subject is sufficiently grounded to continue.', terminal: true },
    { code: 'clarify', description: 'Material information is missing or contradictory.', terminal: true },
    { code: 'reject', description: 'The subject should not continue under the current evidence and policy.', terminal: true },
    { code: 'defer', description: 'The subject is valid but should be reconsidered later.', terminal: true },
    { code: 'inconclusive', description: 'Discovery completed without enough basis for another decision.', terminal: true },
    { code: 'failed', description: 'Discovery infrastructure could not produce an authoritative result.', terminal: true },
  ],
  flow: {
    id: 'saga3.discovery.standard',
    version: '1.0.0',
    entryNodeId: 'produce-proposal',
    nodes: [
      {
        id: 'produce-proposal',
        label: 'Produce Discovery Proposal',
        kind: 'lm',
        description: 'Investigate the bounded context and submit a typed DiscoveryProposal.',
        executionProfile: 'discovery-proposal-worker',
        outputSchema: { id: DISCOVERY_PROPOSAL_SCHEMA },
      },
      {
        id: 'resolve-proposal-submission',
        label: 'Resolve Proposal Submission',
        kind: 'kernel',
        description: 'Materialize the exact raw submission or canonical Proposal persisted by proposal_submit.',
        handler: 'discovery-resolve-proposal-submission',
        outputSchema: { id: DISCOVERY_PROPOSAL_SCHEMA },
      },
      {
        id: 'prepare-normalization',
        label: 'Prepare Normalization Control',
        kind: 'kernel',
        description: 'Create the exact normalization ControlIntent, authority WorkIntent, and projected task.',
        handler: 'discovery-prepare-normalization',
        outputSchema: { id: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA },
      },
      {
        id: 'normalize-semantic',
        label: 'Normalize Semantic Ambiguity',
        kind: 'lm',
        description: 'Transform only ambiguous source fields without inventing evidence.',
        executionProfile: 'discovery-normalizer',
        outputSchema: { id: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA },
      },
      {
        id: 'resolve-normalized-proposal',
        label: 'Resolve Normalized Proposal',
        kind: 'kernel',
        description: 'Materialize the exact canonical Proposal accepted by normalization_submit.',
        handler: 'discovery-resolve-normalized-proposal',
        outputSchema: { id: DISCOVERY_PROPOSAL_SCHEMA },
      },
      {
        // Д5: preparation kernel node. Creates the AssessDiscoveryReadiness
        // ControlIntent + authority WorkIntent + projected advisor task bound
        // to an EXACT immutable Proposal version, and returns machine-filled
        // bindings (controlIntentId, authorityIntentId, taskId, proposalId,
        // proposalHash). The downstream assess-readiness LM node reads these
        // from its input bindings so readiness_get/readiness_submit succeed.
        id: 'prepare-readiness',
        label: 'Prepare Readiness Control',
        kind: 'kernel',
        description: 'Create the readiness ControlIntent + authority WorkIntent + projected task for the canonical proposal.',
        handler: 'discovery-prepare-readiness',
        outputSchema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA },
      },
      {
        id: 'assess-readiness',
        label: 'Assess Readiness',
        kind: 'lm',
        description: 'Produce an advisory, source-bound readiness assessment for the canonical proposal.',
        executionProfile: 'discovery-readiness-advisor',
        outputSchema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA },
      },
      {
        id: 'resolve-readiness',
        label: 'Resolve Readiness Assessment',
        kind: 'kernel',
        description: 'Materialize the exact accepted assessment, or an explicit missing/failed/paused readiness result.',
        handler: 'discovery-resolve-readiness',
        outputSchema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA },
      },
      {
        id: 'settle',
        label: 'Settle Discovery',
        kind: 'kernel',
        description: 'Apply the versioned policy and issue the immutable authoritative certificate.',
        handler: 'discovery-settlement-policy',
        inputSchema: { id: 'saga3.discovery-settlement-input.v1' },
        outputSchema: { id: 'saga3.discovery-outcome-certificate.v1' },
      },
      // Д2: D5 Diagnosis REMOVED from the outcome-critical flow. It is advisory
      // enrichment that runs AFTER ProcessRun completion (separate observer /
      // postCompletionHook), never influencing the authoritative outcome or
      // certificate. The diagnosis-advisor execution profile is still declared
      // below for the future observer; it just has no flow node here.
      ...[
        'go', 'clarify', 'reject', 'defer', 'inconclusive', 'failed',
      ].map(code => ({
        id: `complete-${code}`,
        label: `Complete: ${code}`,
        kind: 'kernel' as const,
        description: `Emit the local Discovery process outcome '${code}'.`,
        handler: 'process-outcome-emitter',
        emitsOutcome: code,
      })),
    ],
    transitions: [
      // Д1: event model separates runtime.* (LM physical status) from domain.*
      // (kernel subject-matter decision). LM nodes emit only runtime.completed /
      // runtime.failed. Kernel nodes emit domain events (accepted / go / ...).
      // '*' is a wildcard default edge.
      //
      // Д2: D5 Diagnosis is REMOVED from the outcome-critical path. D4 Settlement
      // emits its authoritative decision directly into the terminal outcome node;
      // the certificate is issued at settlement time. Diagnosis runs as advisory
      // enrichment AFTER ProcessRun completion (separate observer/hook), never
      // influencing the outcome.
      { from: 'produce-proposal', to: 'resolve-proposal-submission', on: 'runtime.completed' },
      // A physical worker failure may happen after proposal_submit committed.
      // Always let the module resolver inspect the exact durable execution
      // before deciding whether the domain product exists.
      { from: 'produce-proposal', to: 'resolve-proposal-submission', on: 'runtime.failed' },
      { from: 'produce-proposal', to: 'complete-failed', on: 'runtime.paused' },
      { from: 'resolve-proposal-submission', to: 'prepare-readiness', on: 'domain.accepted' },
      { from: 'resolve-proposal-submission', to: 'prepare-normalization', on: 'domain.normalization-required' },
      { from: 'resolve-proposal-submission', to: 'complete-failed', on: 'domain.invalid-json' },
      { from: 'resolve-proposal-submission', to: 'complete-failed', on: 'domain.failed' },
      { from: 'prepare-normalization', to: 'normalize-semantic', on: 'domain.prepared' },
      { from: 'normalize-semantic', to: 'resolve-normalized-proposal', on: 'runtime.completed' },
      { from: 'normalize-semantic', to: 'resolve-normalized-proposal', on: 'runtime.paused' },
      { from: 'normalize-semantic', to: 'resolve-normalized-proposal', on: 'runtime.failed' },
      { from: 'resolve-normalized-proposal', to: 'prepare-readiness', on: 'domain.accepted' },
      { from: 'resolve-normalized-proposal', to: 'complete-failed', on: 'domain.failed' },
      // Д5: prepare-readiness creates the ControlIntent + authority WorkIntent +
      // projected advisor task, then assess-readiness LM node runs against them.
      { from: 'prepare-readiness', to: 'assess-readiness', on: 'domain.prepared' },
      { from: 'prepare-readiness', to: 'complete-failed', on: 'domain.failed' },
      { from: 'assess-readiness', to: 'resolve-readiness', on: 'runtime.completed' },
      { from: 'assess-readiness', to: 'resolve-readiness', on: 'runtime.failed' },
      { from: 'assess-readiness', to: 'resolve-readiness', on: 'runtime.paused' },
      { from: 'resolve-readiness', to: 'settle', on: 'domain.accepted' },
      { from: 'resolve-readiness', to: 'settle', on: 'domain.missing' },
      { from: 'resolve-readiness', to: 'settle', on: 'domain.failed' },
      { from: 'resolve-readiness', to: 'settle', on: 'domain.paused' },
      // D4 settlement → terminal outcome directly (Д2). No diagnosis detour.
      { from: 'settle', to: 'complete-go', on: 'domain.go' },
      { from: 'settle', to: 'complete-clarify', on: 'domain.clarify' },
      { from: 'settle', to: 'complete-reject', on: 'domain.reject' },
      { from: 'settle', to: 'complete-defer', on: 'domain.defer' },
      { from: 'settle', to: 'complete-inconclusive', on: 'domain.inconclusive' },
      { from: 'settle', to: 'complete-failed', on: 'domain.failed' },
    ],
    terminalNodeIds: [
      'complete-go',
      'complete-clarify',
      'complete-reject',
      'complete-defer',
      'complete-inconclusive',
      'complete-failed',
    ],
  },
  artifacts: [
    { type: 'discovery-case', schema: { id: 'saga3.discovery-case.v1' }, authority: 'kernel', description: 'Immutable process input snapshot.' },
    { type: 'discovery-document', schema: { id: 'saga3.discovery-document.v1' }, authority: 'worker', description: 'Human-readable investigation record.' },
    { type: 'discovery-proposal', schema: { id: DISCOVERY_PROPOSAL_SCHEMA }, authority: 'worker', description: 'Typed worker proposal.' },
    { type: 'discovery-normalization-proposal', schema: { id: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA }, authority: 'advisor', description: 'Source-bound semantic transformation proposal.' },
    { type: 'discovery-readiness-assessment', schema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA }, authority: 'advisor', description: 'Advisory readiness classification.' },
    { type: 'discovery-outcome-certificate', schema: { id: 'saga3.discovery-outcome-certificate.v1' }, authority: 'kernel', description: 'Immutable authoritative process result.' },
    { type: 'discovery-diagnosis-report', schema: { id: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA }, authority: 'advisor', description: 'Advisory explanation of the certificate.' },
  ],
  policies: [
    {
      id: 'discovery-settlement',
      version: '1.0.0',
      handler: 'discovery-settlement-policy',
      description: 'The sole authority that converts proposal and readiness evidence into a decision.',
    },
  ],
  invariants: [
    { id: 'discovery.worker-proposes', description: 'LM workers propose but never settle or advance the lifecycle.', enforcement: 'runtime' },
    { id: 'discovery.kernel-authorizes', description: 'Only deterministic kernel policy issues the authoritative certificate.', enforcement: 'policy' },
    { id: 'discovery.machine-fills-binding', description: 'Known ids, hashes, schema versions and authority context are machine-filled.', enforcement: 'runtime' },
    { id: 'discovery.external-tracker', description: 'Every LM execution uses an external tracker as its program counter and recovery frame.', enforcement: 'test' },
    { id: 'discovery.materialized-calls', description: 'Typed MCP submissions are materialized and checklist-verified before invocation.', enforcement: 'test' },
    { id: 'discovery.diagnosis-advisory', description: 'Diagnosis may explain but never alter the certificate or route.', enforcement: 'runtime' },
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
      executionMode: 'tracker_only',
      allowedTools: [
        'task_get', 'repository_checkout_list', 'artifact_list', 'note_list',
        'proposal_submit', 'worker_done', 'Write', 'Read', 'Edit', 'Bash', 'Glob', 'Grep',
      ],
      trackerTemplate: DISCOVERY_PROPOSAL_TRACKER,
      workspaceTemplates: [
        `${DISCOVERY_RESOURCE_ROOT}/discovery-doc-template.md`,
        `${DISCOVERY_RESOURCE_ROOT}/proposal-call-template.json`,
      ],
      callTemplates: [`${DISCOVERY_RESOURCE_ROOT}/proposal-call-template.json`],
      checklists: [`${DISCOVERY_RESOURCE_ROOT}/proposal-checklist.md`],
      outputSchema: { id: DISCOVERY_PROPOSAL_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['schema-rejected', 'tool-error'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'fail' },
    },
    {
      id: 'discovery-normalizer',
      workIntentKind: DISCOVERY_NORMALIZATION_INTENT_KIND,
      workIntentSchema: { id: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA },
      taskKind: 'discovery.normalize',
      executionSkill: 'saga-discovery-normalizer',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-discovery-normalizer',
      executionMode: 'tracker_only',
      allowedTools: ['task_get', 'normalization_get', 'normalization_submit', 'worker_done', 'Read', 'Edit'],
      trackerTemplate: DISCOVERY_NORMALIZATION_TRACKER,
      workspaceTemplates: [`${DISCOVERY_RESOURCE_ROOT}/normalization-call-template.json`],
      callTemplates: [`${DISCOVERY_RESOURCE_ROOT}/normalization-call-template.json`],
      checklists: [`${DISCOVERY_RESOURCE_ROOT}/normalization-checklist.md`],
      outputSchema: { id: DISCOVERY_NORMALIZATION_PROPOSAL_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['schema-rejected'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'fail' },
    },
    {
      id: 'discovery-readiness-advisor',
      workIntentKind: DISCOVERY_READINESS_INTENT_KIND,
      workIntentSchema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA },
      taskKind: 'discovery.assess',
      executionSkill: 'saga-discovery-readiness-advisor',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-discovery-readiness-advisor',
      executionMode: 'tracker_only',
      allowedTools: ['task_get', 'readiness_get', 'readiness_submit', 'worker_done', 'Read', 'Edit'],
      trackerTemplate: DISCOVERY_READINESS_TRACKER,
      workspaceTemplates: [`${DISCOVERY_RESOURCE_ROOT}/readiness-call-template.json`],
      callTemplates: [`${DISCOVERY_RESOURCE_ROOT}/readiness-call-template.json`],
      checklists: [`${DISCOVERY_RESOURCE_ROOT}/readiness-checklist.md`],
      outputSchema: { id: DISCOVERY_READINESS_ASSESSMENT_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['schema-rejected'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
    {
      id: 'discovery-diagnosis-advisor',
      workIntentKind: DISCOVERY_DIAGNOSIS_INTENT_KIND,
      workIntentSchema: { id: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA },
      taskKind: 'discovery.diagnose',
      executionSkill: 'saga-discovery-diagnosis-advisor',
      protocolSkill: PROCESS_PROTOCOL_SKILL,
      semanticSkill: 'saga-discovery-diagnosis-advisor',
      executionMode: 'tracker_only',
      allowedTools: ['task_get', 'diagnosis_get', 'diagnosis_submit', 'worker_done', 'Read', 'Edit'],
      trackerTemplate: DISCOVERY_DIAGNOSIS_TRACKER,
      workspaceTemplates: [`${DISCOVERY_RESOURCE_ROOT}/diagnosis-call-template.json`],
      callTemplates: [`${DISCOVERY_RESOURCE_ROOT}/diagnosis-call-template.json`],
      checklists: [`${DISCOVERY_RESOURCE_ROOT}/diagnosis-checklist.md`],
      outputSchema: { id: DISCOVERY_DIAGNOSIS_REPORT_SCHEMA },
      retryPolicy: { maxAttempts: 2, retryOn: ['schema-rejected'], backoff: 'none' },
      recoveryPolicy: { resumeFromCheckpoint: true, reuseWorkIntent: true, reuseAcceptedOutput: true, onExhausted: 'pause' },
    },
  ],
};
