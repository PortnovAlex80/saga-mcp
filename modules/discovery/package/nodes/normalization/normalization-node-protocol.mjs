// @ts-check
/**
 * W9-A1 — Normalize-semantic node protocol + package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a1.md`.
 *
 * This module owns the `NodeProtocolDefinition` for the Discovery Flow's
 * normalization LM node `normalize-semantic` in `product-discovery@3.0.0`
 * (see `src/process-modules/modules/discovery/discovery-process-module.ts`).
 *
 * The normalizer is a bounded D2 worker: it transforms ONLY the semantically
 * ambiguous source fields of an immutable raw submission into a canonical
 * normalization proposal, without inventing evidence. The kernel resolver
 * `discovery-resolve-normalized-proposal` re-reads the exact
 * normalization_submit result; the LM never self-declares acceptance
 * (authority = kernel-gate).
 *
 * Wave 9 exit gate (§2) requires Discovery to run through PINNED PACKAGE
 * RESOURCES. This node package pins the normalizer's skill, call template,
 * tracker and checklist behind package-local resources.
 *
 * This file is PURE DATA ONLY (plan §3.5). Anti-scope: this lane does NOT
 * touch the central manifest (W9-A1 owns
 * `src/process-modules/modules/discovery/package/manifest.ts`). The central
 * manifest already declares every resource path referenced here; this node
 * protocol re-pins them locally so the package isolation closure check holds.
 *
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition} NodeProtocolDefinition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStep} ProtocolStep
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStepTransition} ProtocolStepTransition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').EvidenceRequirement} EvidenceRequirement
 * @typedef {import('../../../../src/process-modules/domain/spi/resource-index.ts').ResourceIndexEntry} ResourceIndexEntry
 */

/** Owning Discovery Flow node id (semantic normalization). */
export const NORMALIZATION_NODE_ID = 'normalize-semantic';

/** Execution profile that binds the normalizer worker to this node. */
export const NORMALIZATION_EXECUTION_PROFILE = 'discovery-normalizer';

/** Output schema the normalizer LM node must produce (matches the flow node). */
export const NORMALIZATION_OUTPUT_SCHEMA = 'saga3.discovery-normalization-proposal.v1';

/** Placeholder digest shared by this node's evidence contracts. */
const PENDING = 'pending@wave-2';

/**
 * Module-relative resource paths (relative to the discovery package root).
 *
 * @readonly
 */
export const NORMALIZATION_RESOURCE_PATHS = Object.freeze({
  /** Skill fragment: normalizer semantic-transformation instructions. */
  NORMALIZER_SKILL: 'skills/saga-discovery-normalizer/SKILL.md',
  /** Shared protocol skill pinned by every discovery execution profile. */
  PROTOCOL_SKILL: 'skills/saga-process-module-worker-protocol/SKILL.md',
  /** MCP call template: normalization_submit typed submission. */
  NORMALIZATION_CALL: 'tool-templates/discovery/normalization-call-template.json',
  /** Stage tracker (external program counter + recovery frame). */
  STAGE_TRACKER: 'tool-templates/discovery/normalization-stage-tracker.md',
  /** LM node pre-submit checklist (normalization-scoped). */
  CHECKLIST: 'tool-templates/discovery/normalization-checklist.md',
});

/**
 * Package-local resource logical ids declared by this node package.
 *
 * @readonly
 */
export const NORMALIZATION_RESOURCE_IDS = Object.freeze({
  normalizerSkill: 'discovery.skill.normalizer',
  protocolSkill: 'discovery.skill.process-protocol',
  normalizationCall: 'discovery.template.normalization-call',
  stageTracker: 'discovery.tracker.normalization-stage',
  checklist: 'discovery.checklist.normalization',
});

/**
 * Resource index entries for the normalization node.
 *
 * @type {readonly ResourceIndexEntry[]}
 */
export const NORMALIZATION_NODE_RESOURCES = Object.freeze([
  {
    logicalId: NORMALIZATION_RESOURCE_IDS.normalizerSkill,
    path: NORMALIZATION_RESOURCE_PATHS.NORMALIZER_SKILL,
    kind: 'skill',
    digest: PENDING,
  },
  {
    logicalId: NORMALIZATION_RESOURCE_IDS.protocolSkill,
    path: NORMALIZATION_RESOURCE_PATHS.PROTOCOL_SKILL,
    kind: 'instruction',
    digest: PENDING,
  },
  {
    logicalId: NORMALIZATION_RESOURCE_IDS.normalizationCall,
    path: NORMALIZATION_RESOURCE_PATHS.NORMALIZATION_CALL,
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: NORMALIZATION_RESOURCE_IDS.stageTracker,
    path: NORMALIZATION_RESOURCE_PATHS.STAGE_TRACKER,
    kind: 'template',
    digest: PENDING,
  },
  {
    logicalId: NORMALIZATION_RESOURCE_IDS.checklist,
    path: NORMALIZATION_RESOURCE_PATHS.CHECKLIST,
    kind: 'checklist',
    digest: PENDING,
  },
]);

/**
 * Frozen tools the normalizer uses (mirrors the `discovery-normalizer`
 * execution profile `allowedTools`). The normalizer is tightly scoped: it
 * reads the immutable normalization case via `normalization_get`, transforms
 * only ambiguous fields, and submits via `normalization_submit`.
 */
const NORMALIZATION_TOOLS = Object.freeze([
  'task_get',
  'normalization_get',
  'normalization_submit',
  'worker_done',
  'Read',
  'Edit',
]);

/**
 * The ordered protocol steps INSIDE the `normalize-semantic` LM node.
 *
 * The normalizer must (1) bind to the normalization ControlIntent + authority
 * WorkIntent + exact raw submission, (2) read the immutable normalization case
 * via `normalization_get`, (3) transform only the ambiguous source fields
 * without inventing evidence, (4) materialize + submit the typed
 * normalization proposal, then (5) call `worker_done` once and exit.
 *
 * @type {readonly ProtocolStep[]}
 */
const normalizationSteps = Object.freeze([
  {
    id: 'bind-normalization-control',
    instructions:
      'Read the assigned discovery.normalize task and the normalization ControlIntent + authority WorkIntent projected by the prepare-normalization kernel node. Confirm the exact raw submission lineage (sourceIntentId, sourceTaskId, sourceExecutionId, rawSubmissionId, rawHash, controlIntentId). Record the external stage tracker before any write. Do not infer any id, hash or schema version.',
    resources: [
      NORMALIZATION_RESOURCE_IDS.stageTracker,
      NORMALIZATION_RESOURCE_IDS.protocolSkill,
    ],
    allowedTools: ['task_get', 'Read'],
    evidenceRequirements: [],
  },
  {
    id: 'read-normalization-case',
    instructions:
      'Call normalization_get with the controlIntentId + executionId to load the immutable raw submission and the allowed source-field map. The source_field_map paths MUST resolve in the parsed payload — never invent a field that is not grounded in the raw submission. This is the only authoritative source for the transformation.',
    resources: [NORMALIZATION_RESOURCE_IDS.normalizerSkill],
    allowedTools: ['normalization_get', 'Read'],
    evidenceRequirements: [],
  },
  {
    id: 'transform-ambiguous-fields',
    instructions:
      'Transform ONLY the semantically ambiguous source fields into the canonical normalization payload. Do NOT invent evidence, do NOT add fields outside the source_field_map, do NOT alter the raw hash. Use the normalizer skill as the transformation authority.',
    resources: [
      NORMALIZATION_RESOURCE_IDS.normalizerSkill,
      NORMALIZATION_RESOURCE_IDS.checklist,
    ],
    allowedTools: ['Read', 'Edit'],
    evidenceRequirements: [],
  },
  {
    id: 'submit-normalization',
    instructions:
      'Materialize the canonical normalization_submit call from the template, replace every FILL_ placeholder with machine-read values, and execute it. Echo source_submission_id and source_raw_hash verbatim from normalization_get. Run the pre-submit checklist before the call. Do not call worker_done in this step.',
    resources: [
      NORMALIZATION_RESOURCE_IDS.normalizationCall,
      NORMALIZATION_RESOURCE_IDS.checklist,
    ],
    allowedTools: NORMALIZATION_TOOLS,
    evidenceRequirements: [
      {
        category: 'tool-receipt',
        contractRef: Object.freeze({
          schemaId: 'saga3.tool.normalization-submit.v1',
          version: '1.0.0',
          digest: PENDING,
        }),
        required: true,
      },
    ],
  },
  {
    id: 'complete-normalization-node',
    instructions:
      'Call worker_done exactly once with a truthful summary naming the submitted normalization proposal. After worker_done, the single-use worker exits. The kernel resolver `discovery-resolve-normalized-proposal` re-reads the exact normalization_submit result and routes (accept / fail); this node emits no domain event.',
    resources: [NORMALIZATION_RESOURCE_IDS.stageTracker],
    allowedTools: NORMALIZATION_TOOLS,
    evidenceRequirements: [
      {
        category: 'tool-receipt',
        contractRef: Object.freeze({
          schemaId: 'saga3.tool.worker-done.v1',
          version: '1.0.0',
          digest: PENDING,
        }),
        required: true,
      },
    ],
  },
]);

/**
 * Linear transitions through the normalization node. The submit step is the
 * recovery re-entry point.
 *
 * @type {readonly ProtocolStepTransition[]}
 */
const normalizationTransitions = Object.freeze([
  { from: 'bind-normalization-control', to: 'read-normalization-case', kind: 'linear' },
  { from: 'read-normalization-case', to: 'transform-ambiguous-fields', kind: 'linear' },
  { from: 'transform-ambiguous-fields', to: 'submit-normalization', kind: 'linear' },
  { from: 'submit-normalization', to: 'complete-normalization-node', kind: 'linear' },
]);

/**
 * Evidence requirements the normalization node must produce before completion.
 *
 * @type {readonly EvidenceRequirement[]}
 */
const normalizationNodeCompletionEvidence = Object.freeze([
  {
    category: 'artifact-reference',
    contractRef: Object.freeze({
      schemaId: NORMALIZATION_OUTPUT_SCHEMA,
      version: '1.0.0',
      digest: PENDING,
    }),
    required: true,
  },
  {
    category: 'tool-receipt',
    contractRef: Object.freeze({
      schemaId: 'saga3.tool.normalization-submit.v1',
      version: '1.0.0',
      digest: PENDING,
    }),
    required: true,
  },
  {
    category: 'tool-receipt',
    contractRef: Object.freeze({
      schemaId: 'saga3.tool.worker-done.v1',
      version: '1.0.0',
      digest: PENDING,
    }),
    required: true,
  },
]);

/**
 * The NodeProtocolDefinition for the Discovery normalize-semantic node.
 *
 * `retrySemantics` mirrors the `discovery-normalizer` profile `retryPolicy`
 * (maxAttempts: 2, retryOn: ['schema-rejected'], backoff: 'none').
 *
 * @type {NodeProtocolDefinition}
 */
export const NORMALIZE_SEMANTIC_PROTOCOL = Object.freeze({
  id: 'discovery.normalize-semantic',
  version: '1.0.0',
  owningFlowNodeId: NORMALIZATION_NODE_ID,
  entryStep: 'bind-normalization-control',
  steps: normalizationSteps,
  transitions: normalizationTransitions,
  nodeCompletionEvidence: normalizationNodeCompletionEvidence,
  recoveryEntrySteps: Object.freeze(['submit-normalization']),
  retrySemantics: 'runtime-implemented-linear',
});

export default NORMALIZE_SEMANTIC_PROTOCOL;
