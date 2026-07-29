// @ts-check
/**
 * W9-A1 — Assess-readiness node protocol + package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a1.md`.
 *
 * This module owns the `NodeProtocolDefinition` for the Discovery Flow's
 * readiness-assessment LM node `assess-readiness` in `product-discovery@3.0.0`
 * (see `src/process-modules/modules/discovery/discovery-process-module.ts`).
 *
 * The readiness advisor produces an ADVISORY, source-bound readiness
 * classification for the canonical proposal (shadow authority). It never
 * alters the proposal, the certificate, or the outcome route — the settlement
 * policy is the sole authority. The kernel resolver
 * `discovery-resolve-readiness` re-reads the exact accepted assessment (or a
 * missing/failed/paused result); the LM never self-declares acceptance
 * (authority = kernel-gate).
 *
 * Wave 9 exit gate (§2) requires Discovery to run through PINNED PACKAGE
 * RESOURCES. This node package pins the advisor's skill, call template,
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

/** Owning Discovery Flow node id (readiness assessment). */
export const READINESS_NODE_ID = 'assess-readiness';

/** Execution profile that binds the readiness advisor to this node. */
export const READINESS_EXECUTION_PROFILE = 'discovery-readiness-advisor';

/** Output schema the readiness advisor must produce (matches the flow node). */
export const READINESS_OUTPUT_SCHEMA = 'saga3.discovery-readiness-assessment.v1';

/** Placeholder digest shared by this node's evidence contracts. */
const PENDING = 'pending@wave-2';

/**
 * Module-relative resource paths (relative to the discovery package root).
 *
 * @readonly
 */
export const READINESS_RESOURCE_PATHS = Object.freeze({
  /** Skill fragment: readiness advisor classification instructions. */
  // W13-A2: module-owned resources moved into the discovery package resources dir.
  ADVISOR_SKILL: 'src/process-modules/modules/discovery/package/resources/skills/saga-discovery-readiness-advisor/SKILL.md',
  /** Shared protocol skill pinned by every discovery execution profile. */
  // PLATFORM resource: stays at the repo-root skills/ dir (shared by all modules).
  PROTOCOL_SKILL: 'skills/saga-process-module-worker-protocol/SKILL.md',
  /** MCP call template: readiness_submit typed submission. */
  READINESS_CALL: 'src/process-modules/modules/discovery/package/resources/readiness-call-template.json',
  /** Stage tracker (external program counter + recovery frame). */
  STAGE_TRACKER: 'src/process-modules/modules/discovery/package/resources/readiness-stage-tracker.md',
  /** LM node pre-submit checklist (readiness-scoped). */
  CHECKLIST: 'src/process-modules/modules/discovery/package/resources/readiness-checklist.md',
});

/**
 * Package-local resource logical ids declared by this node package.
 *
 * @readonly
 */
export const READINESS_RESOURCE_IDS = Object.freeze({
  advisorSkill: 'discovery.skill.readiness-advisor',
  protocolSkill: 'discovery.skill.process-protocol',
  readinessCall: 'discovery.template.readiness-call',
  stageTracker: 'discovery.tracker.readiness-stage',
  checklist: 'discovery.checklist.readiness',
});

/**
 * Resource index entries for the readiness node.
 *
 * @type {readonly ResourceIndexEntry[]}
 */
export const READINESS_NODE_RESOURCES = Object.freeze([
  {
    logicalId: READINESS_RESOURCE_IDS.advisorSkill,
    path: READINESS_RESOURCE_PATHS.ADVISOR_SKILL,
    kind: 'skill',
    digest: PENDING,
  },
  {
    logicalId: READINESS_RESOURCE_IDS.protocolSkill,
    path: READINESS_RESOURCE_PATHS.PROTOCOL_SKILL,
    kind: 'instruction',
    digest: PENDING,
  },
  {
    logicalId: READINESS_RESOURCE_IDS.readinessCall,
    path: READINESS_RESOURCE_PATHS.READINESS_CALL,
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: READINESS_RESOURCE_IDS.stageTracker,
    path: READINESS_RESOURCE_PATHS.STAGE_TRACKER,
    kind: 'template',
    digest: PENDING,
  },
  {
    logicalId: READINESS_RESOURCE_IDS.checklist,
    path: READINESS_RESOURCE_PATHS.CHECKLIST,
    kind: 'checklist',
    digest: PENDING,
  },
]);

/**
 * Frozen tools the readiness advisor uses (mirrors the
 * `discovery-readiness-advisor` execution profile `allowedTools`). The advisor
 * reads the immutable readiness case via `readiness_get`, classifies each
 * dimension against the allowed source refs, and submits via
 * `readiness_submit`.
 */
const READINESS_TOOLS = Object.freeze([
  'task_get',
  'readiness_get',
  'readiness_submit',
  'worker_done',
  'Read',
  'Edit',
]);

/**
 * The ordered protocol steps INSIDE the `assess-readiness` LM node.
 *
 * The advisor must (1) bind to the readiness ControlIntent + authority
 * WorkIntent + exact canonical proposal, (2) read the immutable readiness case
 * + allowed source refs via `readiness_get`, (3) classify each readiness
 * dimension using only the allowed source refs, (4) materialize + submit the
 * typed readiness assessment, then (5) call `worker_done` once and exit.
 *
 * @type {readonly ProtocolStep[]}
 */
const readinessSteps = Object.freeze([
  {
    id: 'bind-readiness-control',
    instructions:
      'Read the assigned discovery.assess task and the readiness ControlIntent + authority WorkIntent projected by the prepare-readiness kernel node. Confirm the exact canonical proposal lineage (proposalId, proposalHash, controlIntentId, authorityIntentId). Record the external stage tracker before any write. Do not infer any id, hash or schema version.',
    resources: [
      READINESS_RESOURCE_IDS.stageTracker,
      READINESS_RESOURCE_IDS.protocolSkill,
    ],
    allowedTools: ['task_get', 'Read'],
    evidenceRequirements: [],
  },
  {
    id: 'read-readiness-case',
    instructions:
      'Call readiness_get with the controlIntentId + executionId to load the immutable proposal + the allowed_source_refs. Every source_ref in the eventual assessment MUST come from allowed_source_refs — never cite a source the proposal does not authorize. This is the only authoritative source for the assessment.',
    resources: [READINESS_RESOURCE_IDS.advisorSkill],
    allowedTools: ['readiness_get', 'Read'],
    evidenceRequirements: [],
  },
  {
    id: 'classify-readiness-dimensions',
    instructions:
      'Classify each readiness dimension (problem_clarity, scope_boundedness, stakeholder_coverage, assumption_visibility, unknowns_manageability, risk_visibility, evidence_grounding) using only the allowed source refs. Surface blocking and non-blocking gaps explicitly. The assessment is ADVISORY — never route, never alter the proposal, never propose a certificate decision.',
    resources: [
      READINESS_RESOURCE_IDS.advisorSkill,
      READINESS_RESOURCE_IDS.checklist,
    ],
    allowedTools: ['Read', 'Edit'],
    evidenceRequirements: [],
  },
  {
    id: 'submit-readiness',
    instructions:
      'Materialize the canonical readiness_submit call from the template, replace every FILL_ placeholder with machine-read values, and execute it. Echo proposal_id and proposal_content_hash verbatim from readiness_get. Run the pre-submit checklist before the call. Do not call worker_done in this step.',
    resources: [
      READINESS_RESOURCE_IDS.readinessCall,
      READINESS_RESOURCE_IDS.checklist,
    ],
    allowedTools: READINESS_TOOLS,
    evidenceRequirements: [
      {
        category: 'tool-receipt',
        contractRef: Object.freeze({
          schemaId: 'saga3.tool.readiness-submit.v1',
          version: '1.0.0',
          digest: PENDING,
        }),
        required: true,
      },
    ],
  },
  {
    id: 'complete-readiness-node',
    instructions:
      'Call worker_done exactly once with a truthful summary naming the submitted readiness assessment + its overall_readiness. After worker_done, the single-use worker exits. The kernel resolver `discovery-resolve-readiness` re-reads the exact accepted assessment (or a missing/failed/paused result) and routes to settlement; this node emits no domain event.',
    resources: [READINESS_RESOURCE_IDS.stageTracker],
    allowedTools: READINESS_TOOLS,
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
 * Linear transitions through the readiness node. The submit step is the
 * recovery re-entry point.
 *
 * @type {readonly ProtocolStepTransition[]}
 */
const readinessTransitions = Object.freeze([
  { from: 'bind-readiness-control', to: 'read-readiness-case', kind: 'linear' },
  { from: 'read-readiness-case', to: 'classify-readiness-dimensions', kind: 'linear' },
  { from: 'classify-readiness-dimensions', to: 'submit-readiness', kind: 'linear' },
  { from: 'submit-readiness', to: 'complete-readiness-node', kind: 'linear' },
]);

/**
 * Evidence requirements the readiness node must produce before completion.
 *
 * @type {readonly EvidenceRequirement[]}
 */
const readinessNodeCompletionEvidence = Object.freeze([
  {
    category: 'artifact-reference',
    contractRef: Object.freeze({
      schemaId: READINESS_OUTPUT_SCHEMA,
      version: '1.0.0',
      digest: PENDING,
    }),
    required: true,
  },
  {
    category: 'tool-receipt',
    contractRef: Object.freeze({
      schemaId: 'saga3.tool.readiness-submit.v1',
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
 * The NodeProtocolDefinition for the Discovery assess-readiness node.
 *
 * `retrySemantics` mirrors the `discovery-readiness-advisor` profile
 * `retryPolicy` (maxAttempts: 2, retryOn: ['schema-rejected'], backoff:
 * 'none'). Note the advisor's `onExhausted: 'pause'` recovery policy is a
 * Flow-level concern (the resolver emits domain.paused on exhaustion); the
 * node protocol itself stays linear.
 *
 * @type {NodeProtocolDefinition}
 */
export const ASSESS_READINESS_PROTOCOL = Object.freeze({
  id: 'discovery.assess-readiness',
  version: '1.0.0',
  owningFlowNodeId: READINESS_NODE_ID,
  entryStep: 'bind-readiness-control',
  steps: readinessSteps,
  transitions: readinessTransitions,
  nodeCompletionEvidence: readinessNodeCompletionEvidence,
  recoveryEntrySteps: Object.freeze(['submit-readiness']),
  retrySemantics: 'runtime-implemented-linear',
});

export default ASSESS_READINESS_PROTOCOL;
