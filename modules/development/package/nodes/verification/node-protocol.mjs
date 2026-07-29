// @ts-check
/**
 * W9-A3 — Verification (acceptance-verification workset) node protocol +
 * package-local resources.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W09-a3.md`.
 *
 * This module owns the `NodeProtocolDefinition` for the development Flow's
 * Verification node — the external node `verify-acceptance-workset` in
 * `solution-development@1.0.0` (see
 * `src/process-modules/modules/development/development-process-module.ts`).
 *
 * Verification runs AFTER the candidate is frozen
 * (`integrate-release-candidate` → `verify-acceptance-workset`). Every
 * acceptance record pins BOTH the accepted AC hash AND the exact frozen
 * candidate hash; outcomes `unknown` and `error` are denials that never
 * authorize a verified bundle (invariants
 * `development.evidence-pins-candidate`,
 * `development.no-post-verification-mutation`, `development.unknown-denies`).
 *
 * Wave 9 exit gate (§0.12.12) requires Development to run through PINNED
 * PACKAGE RESOURCES with no global skill/template lookup and no direct
 * infrastructure dependency. This node package replaces the legacy global
 * `saga-verifier` skill references with package-local, content-addressed
 * resources the runtime resolves under THIS package root.
 *
 * This file is PURE DATA ONLY (plan §3.5). Cross-lane contract: the central
 * manifest (this lane) imports `verificationNodeProtocol` and
 * `verificationNodeResources` into the central manifest's resource index and
 * node-protocol registry. W9-A4 owns the contributions subtree
 * (`modules/development/package/contributions/`); it does not edit this file.
 *
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').NodeProtocolDefinition} NodeProtocolDefinition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStep} ProtocolStep
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').ProtocolStepTransition} ProtocolStepTransition
 * @typedef {import('../../../../src/process-modules/domain/spi/node-protocol.ts').EvidenceRequirement} EvidenceRequirement
 * @typedef {import('../../../../src/process-modules/domain/spi/resource-index.ts').ResourceIndexEntry} ResourceIndexEntry
 * @typedef {import('../../../../src/process-modules/domain/spi/resource-index.ts').ResourceKind} ResourceKind
 */

/** Owning development Flow node id (acceptance verification). */
export const VERIFICATION_NODE_ID = 'verify-acceptance-workset';

/**
 * The external adapter that drives the verification workset
 * (DEVELOPMENT_EXTERNAL_ADAPTER_IDS.verifyAcceptanceWorkset). Each verification
 * work item is driven by a fenced `verification.ac` worker using the
 * `saga-verifier` execution skill under the workset's bounded authority.
 */
export const VERIFICATION_ADAPTER_ID = 'development-verify-acceptance-workset';

/** Output schema the verification node must produce (matches the flow node). */
export const VERIFICATION_OUTPUT_SCHEMA =
  'saga3.acceptance-verification-workset.v1';

/**
 * ContractRef digests for this node's evidence requirements.
 *
 * Wave 9 carries the documented `pending@wave-2` placeholder: the real codec
 * digests are bound by the Wave 2 content-addressed installer at install time.
 */
const PENDING = 'pending@wave-2';

const VERIFICATION_WORKSET_CONTRACT = Object.freeze({
  schemaId: VERIFICATION_OUTPUT_SCHEMA,
  version: '1.0.0',
  digest: PENDING,
});

const VERIFICATION_EVIDENCE_CONTRACT = Object.freeze({
  schemaId: 'saga3.candidate-verification-evidence.v1',
  version: '1.0.0',
  digest: PENDING,
});

const WORK_DONE_RECEIPT_CONTRACT = Object.freeze({
  schemaId: 'saga3.worker-done-receipt.v1',
  version: '1.0.0',
  digest: PENDING,
});

/**
 * Evidence requirements the verification node must produce before completion.
 *
 * The verification node executes independent acceptance verification against
 * the EXACT frozen candidate hash. Each accepted AC bound to the candidate
 * produces a `CandidateVerificationEvidence` record carrying the AC accepted
 * hash, the candidate hash, the outcome (passed/failed/unknown/error), the
 * evidence content-addressed reference, and the trusted provider binding.
 * `unknown` and `error` outcomes are denials — they never authorize a verified
 * bundle (invariant `development.unknown-denies`).
 *
 * @type {readonly EvidenceRequirement[]}
 */
const verificationNodeCompletionEvidence = Object.freeze([
  {
    category: 'module-verifier-receipt',
    contractRef: VERIFICATION_EVIDENCE_CONTRACT,
    required: true,
  },
  {
    category: 'external-receipt',
    contractRef: VERIFICATION_WORKSET_CONTRACT,
    required: true,
  },
  {
    category: 'tool-receipt',
    contractRef: WORK_DONE_RECEIPT_CONTRACT,
    required: true,
  },
]);

/**
 * Package-local resource logical ids declared by this node package.
 */
export const VERIFICATION_RESOURCE_IDS = Object.freeze({
  semanticSkill: 'verification-semantic-skill',
  protocolSkill: 'verification-protocol-skill',
  evidenceRecordCallTemplate: 'verification-evidence-record-call',
  doneCallTemplate: 'verification-worker-done-call',
  checklist: 'verification-node-checklist',
  tracker: 'verification-stage-tracker',
  worksetSchema: 'verification-workset-schema',
});

/**
 * Resource index entries for the Verification node. Paths are PACKAGE-RELATIVE
 * (under this `nodes/verification/` directory).
 *
 * @type {readonly ResourceIndexEntry[]}
 */
export const verificationNodeResources = Object.freeze([
  {
    logicalId: VERIFICATION_RESOURCE_IDS.semanticSkill,
    path: 'skills/verification-semantic-skill.md',
    kind: 'skill',
    digest: PENDING,
  },
  {
    logicalId: VERIFICATION_RESOURCE_IDS.protocolSkill,
    path: 'skills/verification-protocol-skill.md',
    kind: 'instruction',
    digest: PENDING,
  },
  {
    logicalId: VERIFICATION_RESOURCE_IDS.evidenceRecordCallTemplate,
    path: 'templates/verification-evidence-record-call.json',
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: VERIFICATION_RESOURCE_IDS.doneCallTemplate,
    path: 'templates/verification-worker-done-call.json',
    kind: 'mcp-call-template',
    digest: PENDING,
  },
  {
    logicalId: VERIFICATION_RESOURCE_IDS.checklist,
    path: 'templates/verification-node-checklist.md',
    kind: 'checklist',
    digest: PENDING,
  },
  {
    logicalId: VERIFICATION_RESOURCE_IDS.tracker,
    path: 'templates/verification-stage-tracker.md',
    kind: 'template',
    digest: PENDING,
  },
  {
    logicalId: VERIFICATION_RESOURCE_IDS.worksetSchema,
    path: 'schemas/verification-workset.schema.json',
    kind: 'schema',
    digest: PENDING,
  },
]);

/**
 * Frozen tools the verification workset is permitted to call. Verification is
 * `read_only_evidence`: it reads the frozen candidate, generates evidence from
 * the frozen AC contract (NOT from the builder's tests), records 4-valued
 * verdicts, and completes. It must NOT mutate source, mutate the candidate,
 * or transition the AC artifact to accepted — the kernel settlement owns the
 * final authorization.
 */
const VERIFICATION_READ_TOOLS = Object.freeze([
  'task_get',
  'artifact_get',
  'artifact_list',
  'trace_list',
  'note_list',
  'repository_checkout_list',
  'observation_list',
  'Read',
  'Glob',
  'Grep',
]);

const VERIFICATION_WRITE_TOOLS = Object.freeze([
  ...VERIFICATION_READ_TOOLS,
  'verification_record',
  'worker_done',
]);

/**
 * The ordered protocol steps INSIDE the `verify-acceptance-workset` node.
 *
 * Verification binds to the exact frozen candidate. It must (1) bind to the
 * frozen candidate hash and the verification plan from the task graph, (2)
 * re-confirm candidate immutability (the observed candidate hash still equals
 * the frozen `candidateHash`), (3) execute independent acceptance verification
 * for each AC pinning both the AC accepted hash and the candidate hash, (4)
 * record 4-valued verdicts via `verification_record`, (5) assemble the
 * complete workset, then (6) call `worker_done` once and exit.
 *
 * Authority is `kernel-gate`: the verifier records evidence with a 4-valued
 * verdict; `settle-development` re-reads exact durable products and issues the
 * certificate. `unknown`/`error` never authorize a verified bundle.
 *
 * @type {readonly ProtocolStep[]}
 */
const verificationSteps = Object.freeze([
  {
    id: 'bind-frozen-candidate',
    instructions:
      'Read the assigned verification work item and the frozen integrated-release-candidate it binds to. Confirm the candidate ref + candidateHash, the accepted AC it verifies (artifactId + acceptedHash), and the trusted provider binding recorded for this verification. Record the machine-filled binding in the stage tracker before any read. Do not infer any id, hash, candidate hash, or provider id.',
    resources: [
      VERIFICATION_RESOURCE_IDS.tracker,
      VERIFICATION_RESOURCE_IDS.protocolSkill,
    ],
    allowedTools: VERIFICATION_READ_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'confirm-candidate-immutability',
    instructions:
      'Re-observe the candidate hash from the frozen integrated-release-candidate and confirm it still equals the recorded candidateHash. Candidate drift invalidates all prior evidence and requires a new verification workset (invariant development.no-post-verification-mutation). If the observed hash differs, record the drift and do not proceed — route to settlement as a failure rather than completing with stale evidence.',
    resources: [VERIFICATION_RESOURCE_IDS.checklist],
    allowedTools: VERIFICATION_READ_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'generate-property-tests',
    instructions:
      'Generate independent L3 property tests from the FROZEN AC contract (the accepted AC acceptedHash), NOT from the builder\'s own tests. The verifier is independent of the implementation author. Pin every generated check to the exact AC accepted hash so a changed AC revision is a different verification target. Use the semantic skill and workset schema as the shape authority.',
    resources: [
      VERIFICATION_RESOURCE_IDS.semanticSkill,
      VERIFICATION_RESOURCE_IDS.worksetSchema,
    ],
    allowedTools: VERIFICATION_READ_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'execute-verification',
    instructions:
      'Execute the generated property tests against the exact frozen candidate (the commit/tree/build digests the candidateHash pins). Collect a 4-valued outcome per AC: passed, failed, unknown, or error. Every record must pin BOTH the accepted AC hash AND the candidate hash (invariant development.evidence-pins-candidate). unknown and error are denials — they never authorize a verified bundle.',
    resources: [
      VERIFICATION_RESOURCE_IDS.semanticSkill,
      VERIFICATION_RESOURCE_IDS.checklist,
    ],
    allowedTools: VERIFICATION_WRITE_TOOLS,
    evidenceRequirements: [],
  },
  {
    id: 'record-verification-evidence',
    instructions:
      'For each AC, materialize the canonical verification_record call from the template, replace every FILL_ placeholder with machine-read values (artifactId, acceptedHash, candidateHash, outcome, evidence ref/hash, trusted provider identity, execution_id), and execute it. The outcome must be one of passed/failed/unknown/error. Do not call worker_done in this step. Read back each recorded row before assembling the workset.',
    resources: [
      VERIFICATION_RESOURCE_IDS.evidenceRecordCallTemplate,
      VERIFICATION_RESOURCE_IDS.checklist,
    ],
    allowedTools: VERIFICATION_WRITE_TOOLS,
    evidenceRequirements: [
      {
        category: 'module-verifier-receipt',
        contractRef: VERIFICATION_EVIDENCE_CONTRACT,
        required: true,
      },
    ],
  },
  {
    id: 'complete-verification-node',
    instructions:
      'Call worker_done exactly once with a truthful summary naming the verified AC ids, the pinned candidate hash, the outcome per AC, and any unknown/error denials. Replace every FILL_ placeholder in the worker_done template first; verify the completion assertions pass. The verifier never transitions the AC artifact to accepted and never mutates the candidate — settlement owns final authorization. After worker_done, the single-use worker exits and claims no other task.',
    resources: [VERIFICATION_RESOURCE_IDS.doneCallTemplate],
    allowedTools: VERIFICATION_WRITE_TOOLS,
    evidenceRequirements: [
      {
        category: 'external-receipt',
        contractRef: VERIFICATION_WORKSET_CONTRACT,
        required: true,
      },
      {
        category: 'tool-receipt',
        contractRef: WORK_DONE_RECEIPT_CONTRACT,
        required: true,
      },
    ],
  },
]);

/**
 * Linear transitions through the Verification node. The confirm-immutability
 * step is the recovery re-entry point: if the candidate drifted, the runtime
 * resumes there to re-observe before re-running verification. Conditions are
 * omitted (unconditional) — the C065 ratchet (W1-A4) only supports `undefined`
 * predicates in Wave 9.
 *
 * @type {readonly ProtocolStepTransition[]}
 */
const verificationTransitions = Object.freeze([
  { from: 'bind-frozen-candidate', to: 'confirm-candidate-immutability', kind: 'linear' },
  { from: 'confirm-candidate-immutability', to: 'generate-property-tests', kind: 'linear' },
  { from: 'generate-property-tests', to: 'execute-verification', kind: 'linear' },
  { from: 'execute-verification', to: 'record-verification-evidence', kind: 'linear' },
  { from: 'record-verification-evidence', to: 'complete-verification-node', kind: 'linear' },
  // Recovery re-entry: re-confirm immutability then re-run when resuming after
  // a pause (candidate drift invalidates evidence and forces a fresh workset).
  { from: 'confirm-candidate-immutability', to: 'generate-property-tests', kind: 'repeat' },
]);

/**
 * The NodeProtocolDefinition for the development Verification node.
 *
 * Drives the external node `verify-acceptance-workset`. `retrySemantics` is
 * `runtime-implemented-linear`: a bounded workset retries failed/denied
 * evidence items linearly within the runtime's workset budget.
 *
 * @type {NodeProtocolDefinition}
 */
export const verificationNodeProtocol = Object.freeze({
  id: 'development.verification.verify-acceptance-workset',
  version: '1.0.0',
  owningFlowNodeId: VERIFICATION_NODE_ID,
  entryStep: 'bind-frozen-candidate',
  steps: verificationSteps,
  transitions: verificationTransitions,
  nodeCompletionEvidence: verificationNodeCompletionEvidence,
  recoveryEntrySteps: Object.freeze(['confirm-candidate-immutability']),
  retrySemantics: 'runtime-implemented-linear',
});

/**
 * Stable handler-refs the Verification node's downstream settlement uses.
 * Declared here so the central manifest (this lane) can surface them; W9-A4
 * binds the real handler adapters behind these logical ids.
 *
 * `development-settlement-policy` is the kernel handler that re-reads exact
 * durable products and issues the development certificate
 * (DEVELOPMENT_KERNEL_HANDLER_IDS.settle).
 */
export const verificationNodeHandlerRefs = Object.freeze([
  {
    logicalId: 'development-settlement-policy',
    version: '1.0.0',
    digest: PENDING,
  },
]);

export default verificationNodeProtocol;
