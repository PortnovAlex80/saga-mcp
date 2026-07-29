// @ts-check
/**
 * W9-A1 — Produce-proposal (DiscoveryProposal) node protocol + package-local
 * resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a1.md`.
 *
 * This module owns the `NodeProtocolDefinition` for the Discovery Flow's
 * entry LM node `produce-proposal` in `product-discovery@3.0.0` (see
 * `src/process-modules/modules/discovery/discovery-process-module.ts`).
 *
 * Wave 9 exit gate (§2) requires Discovery to run through PINNED PACKAGE
 * RESOURCES with no global skill/template lookup and no direct infrastructure
 * dependency. This node package pins the proposal worker's skill fragments,
 * call templates, tracker and checklist behind package-local resources that
 * the runtime resolves under THIS package root.
 *
 * This file is PURE DATA ONLY (plan §3.5):
 *   - The `NodeProtocolDefinition` (`PRODUCE_PROPOSAL_PROTOCOL`) is canonically
 *     serializable and passes `validateNodeProtocolDefinition` (W1-A4).
 *   - The `resourceIndex` entries point at resources under this package
 *     directory (`skills/`, `templates/`).
 *   - No functions, no classes, no infra imports — the runtime imports the
 *     validator from `dist/` only inside the companion test.
 *
 * Anti-scope: this lane does NOT touch the central manifest (W9-A1 owns
 * `src/process-modules/modules/discovery/package/manifest.ts`) and does NOT
 * register handlers (those live in `discovery-installation.ts`). The central
 * manifest already declares every resource path referenced here in
 * `DISCOVERY_RESOURCE_INDEX`; this node protocol re-pins them locally so the
 * closure check (no protocol references an undeclared resource) holds.
 *
 * Cross-lane contract: the owning flow node id is the stable join key. Node
 * ids + execution-profile / handler / schema identifiers match the frozen
 * Discovery Flow in `discovery-process-module.ts` verbatim — the package does
 * not invent new node identities, it pins the already-contractual ones behind
 * package-local resources.
 */

/**
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition} NodeProtocolDefinition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStep} ProtocolStep
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStepTransition} ProtocolStepTransition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').EvidenceRequirement} EvidenceRequirement
 * @typedef {import('../../../../src/process-modules/domain/spi/resource-index.ts').ResourceIndexEntry} ResourceIndexEntry
 */

/** Owning Discovery Flow node id (proposal production). */
export const PROPOSAL_NODE_ID = 'produce-proposal';

/** Execution profile that binds the worker to this node. */
export const PROPOSAL_EXECUTION_PROFILE = 'discovery-proposal-worker';

/** Output schema the proposal LM node must produce (matches the flow node). */
export const PROPOSAL_OUTPUT_SCHEMA = 'saga3.discovery-proposal.v1';

/** Raw submission schema the resolver pins before normalization. */
export const RAW_SUBMISSION_SCHEMA = 'saga3.discovery-raw-submission.v1';

/**
 * ContractRef digests for this node's evidence requirements.
 *
 * Wave 9 carries the documented `pending@wave-2` placeholder: the real codec
 * digests are bound by the Wave 2 content-addressed installer at install time.
 * The schemaId + version are stable; only the digest is provisional here.
 */
const PENDING = 'pending@wave-2';

/**
 * Module-relative resource paths (relative to the discovery package root
 * `modules/discovery/package/`). Used by the resource index below and by the
 * central manifest. Keeping them in one frozen object prevents the protocol
 * steps and the resource index from drifting apart.
 *
 * @readonly
 */
export const PROPOSAL_RESOURCE_PATHS = Object.freeze({
  /** Skill fragment: discovery worker investigation + proposal instructions. */
  WORKER_SKILL: 'skills/saga-discovery-worker/SKILL.md',
  /** Shared protocol skill pinned by every discovery execution profile. */
  PROTOCOL_SKILL: 'skills/saga-process-module-worker-protocol/SKILL.md',
  /** MCP call template: proposal_submit typed submission. */
  PROPOSAL_CALL: 'tool-templates/discovery/proposal-call-template.json',
  /** Workspace template: discovery investigation document. */
  DISCOVERY_DOC: 'tool-templates/discovery/discovery-doc-template.md',
  /** Stage tracker (external program counter + recovery frame). */
  STAGE_TRACKER: 'tool-templates/discovery/proposal-stage-tracker.md',
  /** LM node pre-submit checklist (proposal-scoped). */
  CHECKLIST: 'tool-templates/discovery/proposal-checklist.md',
});

/**
 * Package-local resource logical ids declared by this node package. Stable
 * keys the central manifest surfaces in the module `resourceIndex`.
 *
 * @readonly
 */
export const PROPOSAL_RESOURCE_IDS = Object.freeze({
  workerSkill: 'discovery.skill.proposal-worker',
  protocolSkill: 'discovery.skill.process-protocol',
  proposalCall: 'discovery.template.proposal-call',
  discoveryDoc: 'discovery.template.proposal-doc',
  stageTracker: 'discovery.tracker.proposal-stage',
  checklist: 'discovery.checklist.proposal',
});

/**
 * Resource index entries for the proposal node. Paths are module-RELATIVE
 * POSIX paths rooted at the repository root — the Wave 2 installer resolves
 * each under the package root and rejects absolute / traversal paths. The
 * logicalIds mirror the central manifest entries so the package isolation
 * conformance test sees a single, consistent namespace.
 *
 * `digest` is the documented `pending@wave-2` placeholder; Wave 2 replaces it
 * with the real `sha256Hex` of the resource bytes at install time.
 *
 * @type {readonly ResourceIndexEntry[]}
 */
export const PROPOSAL_NODE_RESOURCES = Object.freeze([
  {
    logicalId: PROPOSAL_RESOURCE_IDS.workerSkill,
    path: PROPOSAL_RESOURCE_PATHS.WORKER_SKILL,
    kind: 'skill',
    digest: PENDING,
  },
  {
    logicalId: PROPOSAL_RESOURCE_IDS.protocolSkill,
    path: PROPOSAL_RESOURCE_PATHS.PROTOCOL_SKILL,
    kind: 'instruction',
    digest: PENDING,
  },
  {
    logicalId: PROPOSAL_RESOURCE_IDS.proposalCall,
    path: PROPOSAL_RESOURCE_PATHS.PROPOSAL_CALL,
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: PROPOSAL_RESOURCE_IDS.discoveryDoc,
    path: PROPOSAL_RESOURCE_PATHS.DISCOVERY_DOC,
    kind: 'template',
    digest: PENDING,
  },
  {
    logicalId: PROPOSAL_RESOURCE_IDS.stageTracker,
    path: PROPOSAL_RESOURCE_PATHS.STAGE_TRACKER,
    kind: 'template',
    digest: PENDING,
  },
  {
    logicalId: PROPOSAL_RESOURCE_IDS.checklist,
    path: PROPOSAL_RESOURCE_PATHS.CHECKLIST,
    kind: 'checklist',
    digest: PENDING,
  },
]);

/**
 * Frozen read tools the proposal node uses (mirrors the
 * `discovery-proposal-worker` execution profile `allowedTools` read subset).
 * Write tools add the proposal_submit + worker_done surface.
 */
const COMMON_READ_TOOLS = Object.freeze([
  'task_get',
  'repository_checkout_list',
  'artifact_list',
  'note_list',
  'Read',
  'Glob',
  'Grep',
]);

const PROPOSAL_WRITE_TOOLS = Object.freeze([
  ...COMMON_READ_TOOLS,
  'proposal_submit',
  'worker_done',
  'Write',
  'Edit',
  'Bash',
]);

/**
 * The ordered protocol steps INSIDE the `produce-proposal` LM node.
 *
 * The proposal node is the entry of the Discovery Flow. It must (1) bind to
 * the discovery case + assigned task and record the external tracker as the
 * program counter, (2) investigate the bounded context and draft the discovery
 * document, (3) materialize the canonical proposal_submit call from the
 * template and submit the typed DiscoveryProposal, (4) run the proposal-scoped
 * pre-submit checklist, then (5) call `worker_done` once and exit.
 *
 * Authority is `kernel-gate`: the LM only submits a proposal (worker
 * authority); the kernel resolver `discovery-resolve-proposal-submission`
 * re-reads the exact durable submission and routes. The LM node never decides
 * the domain outcome.
 *
 * @type {readonly ProtocolStep[]}
 */
const proposalSteps = Object.freeze([
  {
    id: 'bind-discovery-case',
    instructions:
      'Read the assigned discovery.produce task and the discovery case that authorizes this run. Confirm the epic binding and the work-intent. Record the external stage tracker as the program counter before any write — the tracker is the recovery frame for this single-use worker. Do not infer any id, hash or schema version.',
    resources: [
      PROPOSAL_RESOURCE_IDS.stageTracker,
      PROPOSAL_RESOURCE_IDS.protocolSkill,
    ],
    allowedTools: COMMON_READ_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'investigate-context',
    instructions:
      'Investigate the bounded context: read existing artifacts, notes and repository checkouts. Draft the human-readable discovery document from explicitly cited sources only. Use the discovery-worker skill as the shape authority and the discovery-doc template. Keep the investigation grounded in evidence; never invent stakeholders, assumptions or evidence refs.',
    resources: [
      PROPOSAL_RESOURCE_IDS.workerSkill,
      PROPOSAL_RESOURCE_IDS.discoveryDoc,
    ],
    allowedTools: [...COMMON_READ_TOOLS, 'Write', 'Edit', 'Bash'],
    evidenceRequirements: [],
  },
  {
    id: 'submit-proposal',
    instructions:
      'Materialize the canonical proposal_submit call from the template, replace every FILL_ placeholder with machine-read values (problem statement, observed context, stakeholders, assumptions, unknowns, risks, candidate scope, evidence refs, recommended outcome, rationale), and execute it. Attach process/node/work-intent/task/execution provenance. Run the pre-submit checklist before the call. Do not call worker_done in this step.',
    resources: [
      PROPOSAL_RESOURCE_IDS.proposalCall,
      PROPOSAL_RESOURCE_IDS.checklist,
    ],
    allowedTools: PROPOSAL_WRITE_TOOLS,
    evidenceRequirements: [
      {
        category: 'tool-receipt',
        contractRef: Object.freeze({
          schemaId: 'saga3.tool.proposal-submit.v1',
          version: '1.0.0',
          digest: PENDING,
        }),
        required: true,
      },
    ],
  },
  {
    id: 'verify-checklist',
    instructions:
      'Run the proposal-scoped pre-submit checklist before any completion write. Confirm ownership, allowed tools, proposal quality and evidence grounding. No TODO/FILL placeholders may remain. The kernel resolver re-reads the exact durable submission — do not self-declare acceptance.',
    resources: [PROPOSAL_RESOURCE_IDS.checklist],
    allowedTools: COMMON_READ_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'complete-proposal-node',
    instructions:
      'Call worker_done exactly once with a truthful summary naming the submitted proposal and the discovery document. Replace every FILL_ placeholder in the worker_done call first. After worker_done, the single-use worker exits and claims no other task. The kernel resolver owns routing (accept / normalize / fail); this node emits no domain event.',
    resources: [PROPOSAL_RESOURCE_IDS.stageTracker],
    allowedTools: PROPOSAL_WRITE_TOOLS,
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
 * Linear transitions through the proposal node. The verify step is the
 * recovery re-entry point: after a `runtime.failed` the runtime resumes from
 * `verify-checklist`, which routes back to investigation if the proposal is
 * incomplete. Conditions are omitted (unconditional) — the C065 ratchet
 * (W1-A4) only supports `undefined` predicates in Wave 8/9.
 *
 * @type {readonly ProtocolStepTransition[]}
 */
const proposalTransitions = Object.freeze([
  { from: 'bind-discovery-case', to: 'investigate-context', kind: 'linear' },
  { from: 'investigate-context', to: 'submit-proposal', kind: 'linear' },
  { from: 'submit-proposal', to: 'verify-checklist', kind: 'linear' },
  { from: 'verify-checklist', to: 'complete-proposal-node', kind: 'linear' },
  // Recovery re-entry: verify re-loops into investigation when the proposal is
  // incomplete (mirrors the Flow's resolve-proposal-submission routing back to
  // produce-proposal on domain.normalization-required / a missing product).
  { from: 'verify-checklist', to: 'investigate-context', kind: 'repeat' },
]);

/**
 * Evidence requirements the proposal node must produce before completion.
 *
 * The proposal node owns the WHAT-side root of discovery: the typed
 * DiscoveryProposal (worker authority) plus the worker_done receipt. The
 * kernel resolver `discovery-resolve-proposal-submission` re-reads the exact
 * raw submission; the LM must not declare the domain product on its own
 * (authority = kernel-gate).
 *
 * @type {readonly EvidenceRequirement[]}
 */
const proposalNodeCompletionEvidence = Object.freeze([
  {
    category: 'artifact-reference',
    contractRef: Object.freeze({
      schemaId: PROPOSAL_OUTPUT_SCHEMA,
      version: '1.0.0',
      digest: PENDING,
    }),
    required: true,
  },
  {
    category: 'tool-receipt',
    contractRef: Object.freeze({
      schemaId: 'saga3.tool.proposal-submit.v1',
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
 * The NodeProtocolDefinition for the Discovery produce-proposal node.
 *
 * Drives the LM-operated node `produce-proposal`. `retrySemantics` mirrors the
 * `discovery-proposal-worker` profile `retryPolicy` (maxAttempts: 2,
 * backoff: 'none') — a linear, no-backoff retry implemented by the Runtime.
 *
 * @type {NodeProtocolDefinition}
 */
export const PRODUCE_PROPOSAL_PROTOCOL = Object.freeze({
  id: 'discovery.produce-proposal',
  version: '1.0.0',
  owningFlowNodeId: PROPOSAL_NODE_ID,
  entryStep: 'bind-discovery-case',
  steps: proposalSteps,
  transitions: proposalTransitions,
  nodeCompletionEvidence: proposalNodeCompletionEvidence,
  recoveryEntrySteps: Object.freeze(['verify-checklist']),
  retrySemantics: 'runtime-implemented-linear',
});

export default PRODUCE_PROPOSAL_PROTOCOL;
