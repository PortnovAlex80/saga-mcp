// @ts-check
/**
 * W8-A2 — Product (PRD) node protocol + package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W08-a2.md`.
 *
 * This module owns the `NodeProtocolDefinition` for the formalization Flow's
 * Product (PRD) node — the entry LM node `define-product-contract` in
 * `solution-formalization@1.0.0` (see
 * `src/process-modules/modules/formalization/formalization-process-module.ts`).
 *
 * Wave 8 exit gate (§0.11.11) requires formalization to run through PINNED
 * PACKAGE RESOURCES with no global skill/template lookup and no direct
 * infrastructure dependency. This node package replaces the legacy global
 * references (`tool-templates/formalization/*`, the composed `saga-product`
 * skill) with package-local, content-addressed resources that the runtime
 * resolves under THIS package root.
 *
 * This file is PURE DATA ONLY (plan §3.5):
 *   - The `NodeProtocolDefinition` (`productNodeProtocol`) is canonically
 *     serializable and passes `validateNodeProtocolDefinition` (W1-A4).
 *   - The `resourceIndex` entries point at resources under this package
 *     directory (`skills/`, `templates/`, `schemas/`).
 *   - No functions, no classes, no infra imports — the runtime imports the
 *     validator from `dist/` only inside the companion test.
 *
 * Anti-scope: this lane does NOT touch the central manifest (W8-A1 owns
 * `modules/formalization/package/manifest.ts`) and does NOT register handlers
 * (W8-A6 owns `modules/formalization/package/ports/`). Other lanes submit
 * their node packages alongside; A1 stitches the resource index.
 *
 * Cross-lane contract: W8-A1 imports `productNodeProtocol` and
 * `productNodeResources` from here into the central manifest's resource index
 * and node-protocol registry. The owning flow node id is the stable join key.
 */

/**
 * The owning formalization Flow node this protocol drives.
 *
 * Matches `flow.entryNodeId` and the `define-product-contract` node id in the
 * formalization ProcessModuleDefinition. The execution profile that binds the
 * runtime worker to this node is `formalization-product`.
 *
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition} NodeProtocolDefinition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStep} ProtocolStep
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStepTransition} ProtocolStepTransition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').EvidenceRequirement} EvidenceRequirement
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').RetrySemanticsKind} RetrySemanticsKind
 * @typedef {import('../../../../src/process-modules/domain/spi/resource-index.ts').ResourceIndexEntry} ResourceIndexEntry
 * @typedef {import('../../../../src/process-modules/domain/spi/resource-index.ts').ResourceKind} ResourceKind
 */

/** Owning formalization Flow node id (PRD / product contract definition). */
export const PRODUCT_NODE_ID = 'define-product-contract';

/** Execution profile that binds the worker to this node. */
export const PRODUCT_EXECUTION_PROFILE = 'formalization-product';

/** Output schema the PRD LM node must produce (matches the flow node). */
export const PRODUCT_OUTPUT_SCHEMA = 'saga3.formalization-product-bundle.v1';

/**
 * ContractRef digests for this node's evidence requirements.
 *
 * Wave 8 carries the documented `pending@wave-2` placeholder: the real codec
 * digests are bound by the Wave 2 content-addressed installer at install time.
 * The schemaId + version are stable; only the digest is provisional here.
 */
const PENDING = 'pending@wave-2';

const PRODUCT_BUNDLE_CONTRACT = Object.freeze({
  schemaId: PRODUCT_OUTPUT_SCHEMA,
  version: '1.0.0',
  digest: PENDING,
});

const PRD_ARTIFACT_CONTRACT = Object.freeze({
  schemaId: 'saga3.prd.v1',
  version: '1.0.0',
  digest: PENDING,
});

const FR_ARTIFACT_CONTRACT = Object.freeze({
  schemaId: 'saga3.functional-requirement.v1',
  version: '1.0.0',
  digest: PENDING,
});

const NFR_ARTIFACT_CONTRACT = Object.freeze({
  schemaId: 'saga3.non-functional-requirement.v1',
  version: '1.0.0',
  digest: PENDING,
});

const RULE_ARTIFACT_CONTRACT = Object.freeze({
  schemaId: 'saga3.business-rule.v1',
  version: '1.0.0',
  digest: PENDING,
});

/**
 * Evidence requirements the PRD node must produce before completion.
 *
 * The Product node owns the WHAT-side root: PRD plus the FR/NFR/RULE family.
 * Every owned artifact must be created via a materialized `artifact_create`
 * call (tool-receipt evidence) and read back (artifact-reference evidence).
 * The kernel resolver `resolve-product-contract` re-reads these exact writes;
 * the LM node must not declare acceptance on its own (authority = kernel-gate).
 *
 * @type {readonly EvidenceRequirement[]}
 */
const productNodeCompletionEvidence = Object.freeze([
  {
    category: 'artifact-reference',
    contractRef: PRD_ARTIFACT_CONTRACT,
    required: true,
  },
  {
    category: 'artifact-reference',
    contractRef: FR_ARTIFACT_CONTRACT,
    required: true,
  },
  {
    category: 'artifact-reference',
    contractRef: NFR_ARTIFACT_CONTRACT,
    required: false,
  },
  {
    category: 'artifact-reference',
    contractRef: RULE_ARTIFACT_CONTRACT,
    required: false,
  },
  {
    category: 'tool-receipt',
    contractRef: Object.freeze({
      schemaId: 'saga3.worker-done-receipt.v1',
      version: '1.0.0',
      digest: PENDING,
    }),
    required: true,
  },
]);

/**
 * Package-local resource logical ids declared by this node package. Stable
 * keys the central manifest (W8-A1) surfaces in the module `resourceIndex`.
 */
export const PRODUCT_RESOURCE_IDS = Object.freeze({
  semanticSkill: 'product-semantic-skill',
  protocolSkill: 'product-protocol-skill',
  artifactCallTemplate: 'product-artifact-create-call',
  traceCallTemplate: 'product-trace-add-call',
  doneCallTemplate: 'product-worker-done-call',
  checklist: 'product-node-checklist',
  tracker: 'product-stage-tracker',
  bundleSchema: 'product-bundle-schema',
});

/**
 * Resource index entries for the PRD node. Paths are PACKAGE-RELATIVE (under
 * this `nodes/product/` directory): `skills/...`, `templates/...`,
 * `schemas/...`. The Wave 2 installer resolves every path under the package
 * root and rejects absolute / traversal paths (plan §5.3 / §13.17).
 *
 * `digest` is the documented `pending@wave-2` placeholder; Wave 2 replaces it
 * with the real `sha256Hex` of the resource bytes at install time.
 *
 * @type {readonly ResourceIndexEntry[]}
 */
export const productNodeResources = Object.freeze([
  {
    logicalId: PRODUCT_RESOURCE_IDS.semanticSkill,
    path: 'skills/product-semantic-skill.md',
    kind: 'skill',
    digest: PENDING,
  },
  {
    logicalId: PRODUCT_RESOURCE_IDS.protocolSkill,
    path: 'skills/product-protocol-skill.md',
    kind: 'instruction',
    digest: PENDING,
  },
  {
    logicalId: PRODUCT_RESOURCE_IDS.artifactCallTemplate,
    path: 'templates/product-artifact-create-call.json',
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: PRODUCT_RESOURCE_IDS.traceCallTemplate,
    path: 'templates/product-trace-add-call.json',
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: PRODUCT_RESOURCE_IDS.doneCallTemplate,
    path: 'templates/product-worker-done-call.json',
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: PRODUCT_RESOURCE_IDS.checklist,
    path: 'templates/product-node-checklist.md',
    kind: 'checklist',
    digest: PENDING,
  },
  {
    logicalId: PRODUCT_RESOURCE_IDS.tracker,
    path: 'templates/product-stage-tracker.md',
    kind: 'template',
    digest: PENDING,
  },
  {
    logicalId: PRODUCT_RESOURCE_IDS.bundleSchema,
    path: 'schemas/product-bundle.schema.json',
    kind: 'schema',
    digest: PENDING,
  },
]);

/**
 * Frozen write tools the PRD node is permitted to call (mirrors the
 * `formalization-product` execution profile `allowedTools`). Read tools are
 * the common subset; write tools add the artifact/trace/completion surface.
 */
const COMMON_READ_TOOLS = Object.freeze([
  'task_get',
  'artifact_list',
  'trace_list',
  'note_list',
  'repository_checkout_list',
  'Read',
  'Glob',
  'Grep',
]);

const PRODUCT_WRITE_TOOLS = Object.freeze([
  ...COMMON_READ_TOOLS,
  'artifact_create',
  'artifact_update',
  'trace_add',
  'worker_done',
  'Write',
  'Edit',
  'Bash',
]);

/**
 * The ordered protocol steps INSIDE the `define-product-contract` LM node.
 *
 * The PRD node is the entry of the formalization Flow. It must (1) bind to
 * the accepted discovery certificate and read the assigned task, (2) draft the
 * PRD plus the FR/NFR/RULE family in the repository, (3) register each artifact
 * with provenance via a materialized `artifact_create` call, (4) read back
 * every owned artifact, (5) verify required WHAT-side lineage before handing
 * to the kernel resolver, then (6) call `worker_done` once and exit.
 *
 * Authority is `kernel-gate`: the LM creates candidates in `draft`/`in_review`;
 * `resolve-product-contract` (and review) accept the exact ids/hashes.
 *
 * @type {readonly ProtocolStep[]}
 */
const productSteps = Object.freeze([
  {
    id: 'bind-discovery-certificate',
    instructions:
      'Read the assigned formalization.product task and the accepted discovery decision artifact that authorizes this formalization. Confirm the discovery certificate ref + hash and the formalization epic binding. Record the machine-filled binding in the stage tracker before any write. Do not infer any id, hash or schema version.',
    resources: [
      PRODUCT_RESOURCE_IDS.tracker,
      PRODUCT_RESOURCE_IDS.protocolSkill,
    ],
    allowedTools: COMMON_READ_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'draft-product-contract',
    instructions:
      'Draft the PRD (problem & value, stakeholder registry, scope/non-goals, context, measurable success criteria, open questions) plus the FR, NFR and RULE artifact family in the assigned repository. Derive only from the frozen discovery inputs and explicitly cited sources. Keep implementation detail out of WHAT artifacts. Use the semantic-skill and bundle-schema as the shape authority.',
    resources: [
      PRODUCT_RESOURCE_IDS.semanticSkill,
      PRODUCT_RESOURCE_IDS.bundleSchema,
    ],
    allowedTools: [...COMMON_READ_TOOLS, 'Write', 'Edit', 'Bash'],
    evidenceRequirements: [],
  },
  {
    id: 'register-artifacts',
    instructions:
      'For each owned artifact (PRD, FR, and at least one NFR or RULE as required), materialize the canonical artifact_create call from the template, replace every FILL_ placeholder with machine-read values, set status=draft, and execute it. Attach process/node/work-intent/task/execution provenance. Run the pre-submit checklist before each call. Do not call worker_done in this step.',
    resources: [
      PRODUCT_RESOURCE_IDS.artifactCallTemplate,
      PRODUCT_RESOURCE_IDS.checklist,
    ],
    allowedTools: PRODUCT_WRITE_TOOLS,
    evidenceRequirements: [
      {
        category: 'tool-receipt',
        contractRef: Object.freeze({
          schemaId: 'saga3.artifact-create-receipt.v1',
          version: '1.0.0',
          digest: PENDING,
        }),
        required: true,
      },
    ],
  },
  {
    id: 'read-back-owned-artifacts',
    instructions:
      'Query artifact_list for the owned PRD/FR/NFR/RULE rows created in this execution. Confirm every id and acceptedHash was read back from Saga, not remembered. If any materialized call produced no durable row, record the error and do not proceed to completion. No new artifact is created in this step unless a prior write failed.',
    resources: [PRODUCT_RESOURCE_IDS.checklist],
    allowedTools: COMMON_READ_TOOLS,
    evidenceRequirements: [
      {
        category: 'artifact-reference',
        contractRef: PRD_ARTIFACT_CONTRACT,
        required: true,
      },
    ],
  },
  {
    id: 'verify-what-side-lineage',
    instructions:
      'Before handing to the kernel resolver, confirm the PRD carries its accepted discovery parent (decision/brief) and that FR/NFR/RULE children are positioned to trace back to the PRD. Kernel-gate acceptance happens in resolve-product-contract, not here: do not transition artifacts to accepted. If lineage is incomplete, return to draft-product-contract rather than completing.',
    resources: [
      PRODUCT_RESOURCE_IDS.traceCallTemplate,
      PRODUCT_RESOURCE_IDS.checklist,
    ],
    allowedTools: [...COMMON_READ_TOOLS, 'trace_add'],
    evidenceRequirements: [],
  },
  {
    id: 'complete-product-node',
    instructions:
      'Call worker_done exactly once with a truthful summary naming the created PRD/FR/NFR/RULE artifact ids and any trace refs. Replace every FILL_ placeholder in the worker_done template first; verify the completion assertions pass. After worker_done, the single-use worker exits and claims no other task.',
    resources: [PRODUCT_RESOURCE_IDS.doneCallTemplate],
    allowedTools: PRODUCT_WRITE_TOOLS,
    evidenceRequirements: [
      {
        category: 'tool-receipt',
        contractRef: Object.freeze({
          schemaId: 'saga3.worker-done-receipt.v1',
          version: '1.0.0',
          digest: PENDING,
        }),
        required: true,
      },
    ],
  },
]);

/**
 * Linear transitions through the PRD node. The verify step is the recovery
 * re-entry point: after a `domain.repair-required` /
 * `domain.acceptance-blocked` event the runtime resumes from
 * `verify-what-side-lineage`, which routes back to drafting if lineage is
 * incomplete. Conditions are omitted (unconditional) — the C065 ratchet
 * (W1-A4) only supports `undefined` predicates in Wave 8.
 *
 * @type {readonly ProtocolStepTransition[]}
 */
const productTransitions = Object.freeze([
  { from: 'bind-discovery-certificate', to: 'draft-product-contract', kind: 'linear' },
  { from: 'draft-product-contract', to: 'register-artifacts', kind: 'linear' },
  { from: 'register-artifacts', to: 'read-back-owned-artifacts', kind: 'linear' },
  { from: 'read-back-owned-artifacts', to: 'verify-what-side-lineage', kind: 'linear' },
  { from: 'verify-what-side-lineage', to: 'complete-product-node', kind: 'linear' },
  // Recovery re-entry: verify re-loops into drafting when lineage is incomplete
  // (mirrors the formalization Flow's resolve-product-contract →
  // define-product-contract edge on domain.repair-required).
  { from: 'verify-what-side-lineage', to: 'draft-product-contract', kind: 'repeat' },
]);

/**
 * The NodeProtocolDefinition for the formalization Product (PRD) node.
 *
 * Drives the LM-operated node `define-product-contract`. `retrySemantics`
 * mirrors the `formalization-product` profile `retryPolicy` (maxAttempts: 2,
 * backoff: 'none') — a linear, no-backoff retry implemented by the Runtime.
 *
 * @type {NodeProtocolDefinition}
 */
export const productNodeProtocol = Object.freeze({
  id: 'formalization.product.define-product-contract',
  version: '1.0.0',
  owningFlowNodeId: PRODUCT_NODE_ID,
  entryStep: 'bind-discovery-certificate',
  steps: productSteps,
  transitions: productTransitions,
  nodeCompletionEvidence: productNodeCompletionEvidence,
  recoveryEntrySteps: Object.freeze(['verify-what-side-lineage']),
  retrySemantics: 'runtime-implemented-linear',
});

/**
 * Stable handler-refs the PRD node's downstream kernel resolver uses. Declared
 * here so the central manifest (W8-A1) can surface them; W8-A6 binds the real
 * handler adapters behind these logical ids.
 */
export const productNodeHandlerRefs = Object.freeze([
  {
    logicalId: 'formalization-resolve-product-contract',
    version: '1.0.0',
    digest: PENDING,
  },
]);

export default productNodeProtocol;
