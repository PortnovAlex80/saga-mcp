// @ts-check
/**
 * W9-A3 — Planning (task-graph planner) node protocol + package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a3.md`.
 *
 * This module owns the `NodeProtocolDefinition` for the development Flow's
 * Planning node — the entry LM node `plan-task-graph` in
 * `solution-development@1.0.0` (see
 * `src/process-modules/modules/development/development-process-module.ts`).
 *
 * Wave 9 exit gate (§0.12.12) requires Development to run through PINNED
 * PACKAGE RESOURCES with no global skill/template lookup and no direct
 * infrastructure dependency. This node package replaces the legacy global
 * references (`tool-templates/development/*`, the composed `saga-planner`
 * skill) with package-local, content-addressed resources the runtime resolves
 * under THIS package root.
 *
 * This file is PURE DATA ONLY (plan §3.5):
 *   - The `NodeProtocolDefinition` (`planningNodeProtocol`) is canonically
 *     serializable and passes `validateNodeProtocolDefinition` (W1-A4).
 *   - The `planningNodeResources` entries point at resources under this package
 *     directory (`skills/`, `templates/`, `schemas/`).
 *   - No functions, no classes, no infra imports — the runtime imports the
 *     validator from `dist/` only inside the companion test.
 *
 * Cross-lane contract: W9-A1 (the central manifest, owned by THIS lane) imports
 * `planningNodeProtocol` and `planningNodeResources` from here into the central
 * manifest's resource index and node-protocol registry. The owning flow node id
 * is the stable join key. W9-A4 owns the contributions subtree
 * (`modules/development/package/contributions/`); it does not edit this file.
 */

/**
 * The owning development Flow node this protocol drives.
 *
 * Matches `flow.entryNodeId` and the `plan-task-graph` node id in the
 * development ProcessModuleDefinition. The execution profile that binds the
 * runtime worker to this node is `development-task-graph-planner`.
 *
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition} NodeProtocolDefinition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStep} ProtocolStep
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStepTransition} ProtocolStepTransition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').EvidenceRequirement} EvidenceRequirement
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').RetrySemanticsKind} RetrySemanticsKind
 * @typedef {import('../../../../src/process-modules/domain/spi/resource-index.ts').ResourceIndexEntry} ResourceIndexEntry
 * @typedef {import('../../../../src/process-modules/domain/spi/resource-index.ts').ResourceKind} ResourceKind
 */

/** Owning development Flow node id (task-graph planning). */
export const PLANNING_NODE_ID = 'plan-task-graph';

/** Execution profile that binds the worker to this node. */
export const PLANNING_EXECUTION_PROFILE = 'development-task-graph-planner';

/** Output schema the planning LM node must produce (matches the flow node). */
export const PLANNING_OUTPUT_SCHEMA =
  'saga3.development-task-graph-proposal.v1';

/**
 * ContractRef digests for this node's evidence requirements.
 *
 * Wave 9 carries the documented `pending@wave-2` placeholder: the real codec
 * digests are bound by the Wave 2 content-addressed installer at install time.
 * The schemaId + version are stable; only the digest is provisional here.
 */
const PENDING = 'pending@wave-2';

const TASK_GRAPH_PROPOSAL_CONTRACT = Object.freeze({
  schemaId: PLANNING_OUTPUT_SCHEMA,
  version: '1.0.0',
  digest: PENDING,
});

const WORK_DONE_RECEIPT_CONTRACT = Object.freeze({
  schemaId: 'saga3.worker-done-receipt.v1',
  version: '1.0.0',
  digest: PENDING,
});

const NODE_SUBMISSION_RECEIPT_CONTRACT = Object.freeze({
  schemaId: 'saga3.process-node-submit-receipt.v1',
  version: '1.0.0',
  digest: PENDING,
});

/**
 * Evidence requirements the planning node must produce before completion.
 *
 * The Planning node owns the advisory task-graph proposal: a set of
 * implementation work items, one required verification item for every accepted
 * AC, integration targets, and a dependency DAG. The proposal has NO execution
 * authority until the kernel resolver (`resolve-task-graph`) validates lineage,
 * coverage, repository bindings and acyclicity and materializes canonical tasks.
 * The LM node submits once via `process_node_submit` and completes once via
 * `worker_done`; it must never call `task_create` or write dependencies itself
 * (invariant `development.lm-proposes-kernel-authorizes`).
 *
 * @type {readonly EvidenceRequirement[]}
 */
const planningNodeCompletionEvidence = Object.freeze([
  {
    category: 'external-receipt',
    contractRef: NODE_SUBMISSION_RECEIPT_CONTRACT,
    required: true,
  },
  {
    category: 'tool-receipt',
    contractRef: WORK_DONE_RECEIPT_CONTRACT,
    required: true,
  },
]);

/**
 * Package-local resource logical ids declared by this node package. Stable
 * keys the central manifest (this lane) surfaces in the module `resourceIndex`.
 */
export const PLANNING_RESOURCE_IDS = Object.freeze({
  semanticSkill: 'planning-semantic-skill',
  protocolSkill: 'planning-protocol-skill',
  submissionCallTemplate: 'planning-task-graph-submit-call',
  checklist: 'planning-node-checklist',
  tracker: 'planning-stage-tracker',
  doneCallTemplate: 'planning-worker-done-call',
  proposalSchema: 'planning-task-graph-proposal-schema',
});

/**
 * Resource index entries for the Planning node. Paths are PACKAGE-RELATIVE
 * (under this `nodes/planning/` directory): `skills/...`, `templates/...`,
 * `schemas/...`. The Wave 2 installer resolves every path under the package
 * root and rejects absolute / traversal paths (plan §5.3 / §13.17).
 *
 * `digest` is the documented `pending@wave-2` placeholder; Wave 2 replaces it
 * with the real `sha256Hex` of the resource bytes at install time.
 *
 * @type {readonly ResourceIndexEntry[]}
 */
export const planningNodeResources = Object.freeze([
  {
    logicalId: PLANNING_RESOURCE_IDS.semanticSkill,
    path: 'skills/planning-semantic-skill.md',
    kind: 'skill',
    digest: PENDING,
  },
  {
    logicalId: PLANNING_RESOURCE_IDS.protocolSkill,
    path: 'skills/planning-protocol-skill.md',
    kind: 'instruction',
    digest: PENDING,
  },
  {
    logicalId: PLANNING_RESOURCE_IDS.submissionCallTemplate,
    path: 'templates/planning-task-graph-submit-call.json',
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: PLANNING_RESOURCE_IDS.doneCallTemplate,
    path: 'templates/planning-worker-done-call.json',
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: PLANNING_RESOURCE_IDS.checklist,
    path: 'templates/planning-node-checklist.md',
    kind: 'checklist',
    digest: PENDING,
  },
  {
    logicalId: PLANNING_RESOURCE_IDS.tracker,
    path: 'templates/planning-stage-tracker.md',
    kind: 'template',
    digest: PENDING,
  },
  {
    logicalId: PLANNING_RESOURCE_IDS.proposalSchema,
    path: 'schemas/planning-task-graph-proposal.schema.json',
    kind: 'schema',
    digest: PENDING,
  },
]);

/**
 * Frozen read/submit tools the Planning node is permitted to call (mirrors the
 * `development-task-graph-planner` execution profile `allowedTools`). The
 * planner is `tracker_only`: it may read lineage and submit a proposal, but it
 * must NOT call `task_create`, dependency writes, Git mutation, or CI actions.
 * `process_node_submit` is the single authoritative write of this node.
 */
const PLANNING_TOOLS = Object.freeze([
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
]);

/**
 * The ordered protocol steps INSIDE the `plan-task-graph` LM node.
 *
 * The Planning node is the entry of the development Flow. It must (1) bind to
 * the accepted formalization lineage (development case: formalization
 * certificate, SRS, accepted ACs, repository bases) and read the assigned task,
 * (2) read the exact accepted SRS, AC set, repository bindings and policy, (3)
 * propose implementation work covering every implementation-required AC plus one
 * required verification item per accepted AC and integration targets matching
 * the bound repositories, (4) check unique keys, closed dependencies and an
 * acyclic graph against the proposal schema, (5) submit the proposal exactly
 * once via `process_node_submit`, then (6) call `worker_done` once and exit.
 *
 * Authority is `kernel-gate`: the LM only proposes; `resolve-task-graph`
 * validates and materializes canonical tasks (invariant
 * `development.lm-proposes-kernel-authorizes`).
 *
 * @type {readonly ProtocolStep[]}
 */
const planningSteps = Object.freeze([
  {
    id: 'bind-formalization-lineage',
    instructions:
      'Read the assigned planning.decomposition task and the development case that authorizes this Development run. Confirm the formalization certificate ref + hash, the accepted SRS ref + hash, the acceptance-baseline hash, the accepted AC set, the bound repositories (id, integration branch, expected base commit) and the policy snapshot. Record the machine-filled binding in the stage tracker before any read of domain state. Do not infer any id, hash, schema version, repository id, branch or commit.',
    resources: [
      PLANNING_RESOURCE_IDS.tracker,
      PLANNING_RESOURCE_IDS.protocolSkill,
    ],
    allowedTools: PLANNING_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'read-accepted-decomposition',
    instructions:
      'Read the exact accepted SRS decomposition, the full accepted AC set with each AC id + acceptedHash + implementationRequired flag, and the repository bindings the integration targets must match. Confirm every value was read from Saga, not remembered. The planner derives its proposal ONLY from these frozen inputs; it does not widen scope or invent ACs.',
    resources: [PLANNING_RESOURCE_IDS.semanticSkill],
    allowedTools: PLANNING_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'propose-work-items',
    instructions:
      'Propose implementation work items covering every AC marked implementationRequired, one required verification item (taskKind verification.ac, read_only_evidence) for EVERY accepted AC regardless of the implementationRequired flag, and integration targets whose projectRepositoryId / targetBranch / expectedBaseCommit exactly equal the bound repositories. Assign stable non-empty keys, an allowed taskKind and executionSkill per item, and a dependency DAG where implementation items depend only on implementation items and every dependency names another proposed item. Use the semantic skill and proposal schema as the shape authority.',
    resources: [
      PLANNING_RESOURCE_IDS.semanticSkill,
      PLANNING_RESOURCE_IDS.proposalSchema,
    ],
    allowedTools: PLANNING_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'validate-proposal-shape',
    instructions:
      'Check the proposal against the pre-submit checklist and the proposal schema: schema is exactly saga3.development-task-graph-proposal.v1; work-item keys are non-empty and unique across both arrays; implementation items cover every implementationRequired AC; there is exactly one required verification item per accepted AC; every dependency names another proposed item with no cycles; implementation items depend only on implementation items; integration targets exactly match the bound repositories and bases. Do not call process_node_submit in this step.',
    resources: [
      PLANNING_RESOURCE_IDS.checklist,
      PLANNING_RESOURCE_IDS.proposalSchema,
    ],
    allowedTools: PLANNING_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'submit-task-graph-proposal',
    instructions:
      'Materialize the canonical process_node_submit call from the template, replace every FILL_ placeholder with machine-read values (integer ids are integers; a missing repository binding is JSON null, not a string), and execute it exactly once. Record the submission ref and hash in the tracker. The kernel may reject the proposal (schema-rejected / lineage-gap); on rejection do not invent ids or widen tool authority — record the error and let the controller start a fresh fenced execution. Do not call worker_done in this step.',
    resources: [
      PLANNING_RESOURCE_IDS.submissionCallTemplate,
      PLANNING_RESOURCE_IDS.checklist,
    ],
    allowedTools: PLANNING_TOOLS,
    evidenceRequirements: [
      {
        category: 'external-receipt',
        contractRef: NODE_SUBMISSION_RECEIPT_CONTRACT,
        required: true,
      },
    ],
  },
  {
    id: 'complete-planning-node',
    instructions:
      'Call worker_done exactly once with a truthful summary naming the submission ref/hash and the proposed implementation/verification item counts. Replace every FILL_ placeholder in the worker_done template first; verify the completion assertions pass. After worker_done, the single-use worker exits and claims no other task. The planner never creates tracker tasks, writes dependencies, performs Git mutation, or starts the implementation workset — those are owned by the kernel resolver and the external execution adapter.',
    resources: [PLANNING_RESOURCE_IDS.doneCallTemplate],
    allowedTools: PLANNING_TOOLS,
    evidenceRequirements: [
      {
        category: 'tool-receipt',
        contractRef: WORK_DONE_RECEIPT_CONTRACT,
        required: true,
      },
    ],
  },
]);

/**
 * Linear transitions through the Planning node. The validate step is the
 * recovery re-entry point: after a `domain.repair-required` event (the resolver
 * rejected lineage/coverage/DAG) the runtime resumes from
 * `validate-proposal-shape`, which routes back to proposing. Conditions are
 * omitted (unconditional) — the C065 ratchet (W1-A4) only supports `undefined`
 * predicates in Wave 9.
 *
 * @type {readonly ProtocolStepTransition[]}
 */
const planningTransitions = Object.freeze([
  { from: 'bind-formalization-lineage', to: 'read-accepted-decomposition', kind: 'linear' },
  { from: 'read-accepted-decomposition', to: 'propose-work-items', kind: 'linear' },
  { from: 'propose-work-items', to: 'validate-proposal-shape', kind: 'linear' },
  { from: 'validate-proposal-shape', to: 'submit-task-graph-proposal', kind: 'linear' },
  { from: 'submit-task-graph-proposal', to: 'complete-planning-node', kind: 'linear' },
  // Recovery re-entry: validate re-loops into proposing when the proposal shape
  // is incomplete (mirrors the development Flow's resolve-task-graph →
  // plan-task-graph edge on domain.repair-required).
  { from: 'validate-proposal-shape', to: 'propose-work-items', kind: 'repeat' },
]);

/**
 * The NodeProtocolDefinition for the development Planning node.
 *
 * Drives the LM-operated node `plan-task-graph`. `retrySemantics` mirrors the
 * `development-task-graph-planner` profile `retryPolicy` (maxAttempts: 2,
 * retryOn: ['schema-rejected','lineage-gap'], backoff: 'none') — a linear,
 * no-backoff retry implemented by the Runtime.
 *
 * @type {NodeProtocolDefinition}
 */
export const planningNodeProtocol = Object.freeze({
  id: 'development.planning.plan-task-graph',
  version: '1.0.0',
  owningFlowNodeId: PLANNING_NODE_ID,
  entryStep: 'bind-formalization-lineage',
  steps: planningSteps,
  transitions: planningTransitions,
  nodeCompletionEvidence: planningNodeCompletionEvidence,
  recoveryEntrySteps: Object.freeze(['validate-proposal-shape']),
  retrySemantics: 'runtime-implemented-linear',
});

/**
 * Stable handler-refs the Planning node's downstream kernel resolver uses.
 * Declared here so the central manifest (this lane) can surface them; W9-A4
 * binds the real handler adapters behind these logical ids.
 *
 * `development-resolve-task-graph` is the kernel handler that validates and
 * materializes the proposal (DEVELOPMENT_KERNEL_HANDLER_IDS.resolveTaskGraph).
 */
export const planningNodeHandlerRefs = Object.freeze([
  {
    logicalId: 'development-resolve-task-graph',
    version: '1.0.0',
    digest: PENDING,
  },
]);

export default planningNodeProtocol;
