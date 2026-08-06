/**
 * W9-A2 — Discovery package-local tool contributions.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 *       adapter subtrees), §11.4 (ModuleToolContribution), §8.2 (NodeProtocol
 *       allowedTools).
 *
 * This file declares the MCP tool contributions the Discovery package makes to
 * the runtime, expressed as pure `ModuleToolContribution` data (Wave 1 SPI). A
 * contribution is a namespaced, versioned declaration that one named MCP tool
 * is owned by this package: its input/output contract refs, the handler that
 * implements it, the call/checklist/error-hint resource references the runtime
 * surfaces to the executing node, the guards bound to it, and its
 * idempotency/side-effect classification.
 *
 * The discovery flow drives these durable MCP calls from its LM nodes:
 *   - `proposal_submit`     — worker writes the typed DiscoveryProposal
 *   - `normalization_get`   — normalizer reads the immutable raw submission
 *   - `normalization_submit`— normalizer writes the canonical transformation
 *   - `readiness_get`       — advisor reads the immutable proposal
 *   - `readiness_submit`    — advisor writes the advisory assessment
 *   - `diagnosis_get`       — diagnosis advisor reads the immutable certificate
 *   - `diagnosis_submit`    — diagnosis advisor writes the advisory report
 *   - `artifact_create`     — kernel auto-provisions the discovery `brief`
 *   - `worker_done`         — complete the fenced task
 *
 * Each is declared here so the Wave 6 tool-contribution installer can register
 * it without the runtime hardcoding the discovery tool catalog. The
 * declarations reference package-local resource paths (the call templates and
 * the node checklists owned by this package's `nodes/` subtree, declared by
 * W9-A1) via `ResourceIndexEntry` logical ids — the manifest resolves those to
 * package-relative paths.
 *
 * ── Dependency-direction ──────────────────────────────────────────────────
 *
 * This file lives under `src/process-modules/modules/discovery/`, so it is a
 * MODULE file. The dependency-direction ratchet (Rule 1/2) permits a module to
 * import the pure domain SPI (`domain/spi/*`) — Rule 5 forbids the REVERSE
 * (domain importing modules), not modules importing domain. No persistence,
 * infra, db, or sibling-module imports occur here. This keeps the ratchet
 * green.
 *
 * PURE DATA: the exported constants are plain readonly objects typed by the
 * Wave 1 SPI. No behavior, no factories.
 */

import type {
  ModuleToolContribution,
  ToolContractRef,
} from '../../../../domain/spi/tool-contribution.js';

// ---------------------------------------------------------------------------
// Package identity + shared contract-ref minter.
// ---------------------------------------------------------------------------

/**
 * The namespace prefix every discovery tool contribution logical id carries.
 * Keeps contributed tool ids disjoint from other modules' contributions at the
 * registry level.
 */
export const DISCOVERY_TOOL_NAMESPACE = 'discovery';

/**
 * Shared placeholder contract ref. Wave 9 does not yet register concrete JSON
 * schemas with the ContractSchemaRegistry (that wiring lands when the
 * composition root cuts over — Wave 11). Until then the contract refs carry
 * the documented `'pending@wave-2'` digest so the manifest round-trips and the
 * Wave 1 canonical-serialization gate accepts the declarations. The schemaId
 * is still the real saga3 schema identity the tool speaks, so the runtime can
 * validate arguments against it once a codec is registered.
 */
function contractRef(schemaId: string, version: string): ToolContractRef {
  return { schemaId, version, digest: 'pending@wave-2' };
}

/**
 * The Wave 1 SPI resource-index logical ids this package's call templates and
 * checklists are registered under. W9-A1's manifest resourceIndex maps these to
 * package-relative paths; this file references them by logical id so the
 * declaration stays path-stable even if the package is relocated.
 */
export const DISCOVERY_TOOL_RESOURCE_IDS = {
  proposalCallTemplate: `${DISCOVERY_TOOL_NAMESPACE}.call-template.proposal-submit`,
  normalizationGetCallTemplate: `${DISCOVERY_TOOL_NAMESPACE}.call-template.normalization-get`,
  normalizationSubmitCallTemplate: `${DISCOVERY_TOOL_NAMESPACE}.call-template.normalization-submit`,
  readinessGetCallTemplate: `${DISCOVERY_TOOL_NAMESPACE}.call-template.readiness-get`,
  readinessSubmitCallTemplate: `${DISCOVERY_TOOL_NAMESPACE}.call-template.readiness-submit`,
  diagnosisGetCallTemplate: `${DISCOVERY_TOOL_NAMESPACE}.call-template.diagnosis-get`,
  diagnosisSubmitCallTemplate: `${DISCOVERY_TOOL_NAMESPACE}.call-template.diagnosis-submit`,
  briefArtifactCallTemplate: `${DISCOVERY_TOOL_NAMESPACE}.call-template.brief-artifact-create`,
  workerDoneCallTemplate: `${DISCOVERY_TOOL_NAMESPACE}.call-template.worker-done`,
  proposalChecklist: `${DISCOVERY_TOOL_NAMESPACE}.checklist.proposal`,
  normalizationChecklist: `${DISCOVERY_TOOL_NAMESPACE}.checklist.normalization`,
  readinessChecklist: `${DISCOVERY_TOOL_NAMESPACE}.checklist.readiness`,
  diagnosisChecklist: `${DISCOVERY_TOOL_NAMESPACE}.checklist.diagnosis`,
  nodeChecklist: `${DISCOVERY_TOOL_NAMESPACE}.checklist.node`,
  proposalErrorHint: `${DISCOVERY_TOOL_NAMESPACE}.error-hint.proposal-write`,
  normalizationErrorHint: `${DISCOVERY_TOOL_NAMESPACE}.error-hint.normalization-write`,
  readinessErrorHint: `${DISCOVERY_TOOL_NAMESPACE}.error-hint.readiness-write`,
  diagnosisErrorHint: `${DISCOVERY_TOOL_NAMESPACE}.error-hint.diagnosis-write`,
  briefErrorHint: `${DISCOVERY_TOOL_NAMESPACE}.error-hint.brief-write`,
  workerDoneErrorHint: `${DISCOVERY_TOOL_NAMESPACE}.error-hint.worker-done`,
} as const;

// ---------------------------------------------------------------------------
// proposal_submit — worker writes the typed DiscoveryProposal.
// ---------------------------------------------------------------------------

/**
 * The `proposal_submit` MCP tool. The discovery proposal worker stores the raw
 * submission (immutable, content-addressed) and, after deterministic
 * normalization, the canonical Proposal through this tool. Idempotency is
 * `'none'` (a second submit for the same execution is rejected by the
 * dispatcher fence); side effect is `'write'` (mutates durable saga3 state).
 * The handler ref points at the platform capability — discovery DECLARES the
 * tool, the platform IMPLEMENTS it.
 */
export const DISCOVERY_PROPOSAL_SUBMIT_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DISCOVERY_TOOL_NAMESPACE}.proposal_submit`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.discovery-proposal.v1', '1.0.0'),
  outputContractRef: contractRef('factory.discovery-proposal.v1', '1.0.0'),
  handlerRef: 'capability.saga.proposal-submit',
  callTemplateRef: DISCOVERY_TOOL_RESOURCE_IDS.proposalCallTemplate,
  checklistRef: DISCOVERY_TOOL_RESOURCE_IDS.proposalChecklist,
  errorHintRef: DISCOVERY_TOOL_RESOURCE_IDS.proposalErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// normalization_get — normalizer reads the immutable raw submission.
// ---------------------------------------------------------------------------

/**
 * The `normalization_get` MCP tool. The normalizer advisor reads the immutable
 * raw submission, the deterministic normalization diagnostics, and the allowed
 * evidence references through this tool. Idempotency is `'idempotent'` (a pure
 * read is safe to retry); side effect is `'read'`.
 */
export const DISCOVERY_NORMALIZATION_GET_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DISCOVERY_TOOL_NAMESPACE}.normalization_get`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.discovery-normalization-control.v1', '1.0.0'),
  outputContractRef: contractRef('factory.discovery-normalization-proposal.v1', '1.0.0'),
  handlerRef: 'capability.saga.normalization-get',
  callTemplateRef: DISCOVERY_TOOL_RESOURCE_IDS.normalizationGetCallTemplate,
  checklistRef: DISCOVERY_TOOL_RESOURCE_IDS.normalizationChecklist,
  errorHintRef: DISCOVERY_TOOL_RESOURCE_IDS.normalizationErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'idempotent',
  sideEffect: 'read',
};

// ---------------------------------------------------------------------------
// normalization_submit — normalizer writes the canonical transformation.
// ---------------------------------------------------------------------------

/**
 * The `normalization_submit` MCP tool. The normalizer advisor submits a typed
 * transformation proposal for a raw submission. The kernel validates source
 * paths, schema, raw hash, and evidence non-invention before accepting it. Side
 * effect `'write'`, idempotency `'none'` — a second submit for the same control
 * intent + execution is rejected by the fence.
 */
export const DISCOVERY_NORMALIZATION_SUBMIT_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DISCOVERY_TOOL_NAMESPACE}.normalization_submit`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.discovery-normalization-proposal.v1', '1.0.0'),
  outputContractRef: contractRef('factory.discovery-normalization-proposal.v1', '1.0.0'),
  handlerRef: 'capability.saga.normalization-submit',
  callTemplateRef: DISCOVERY_TOOL_RESOURCE_IDS.normalizationSubmitCallTemplate,
  checklistRef: DISCOVERY_TOOL_RESOURCE_IDS.normalizationChecklist,
  errorHintRef: DISCOVERY_TOOL_RESOURCE_IDS.normalizationErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// readiness_get — advisor reads the immutable proposal.
// ---------------------------------------------------------------------------

/**
 * The `readiness_get` MCP tool. The readiness advisor reads the immutable
 * canonical Proposal and the exact source references it may cite. Idempotency
 * `'idempotent'` (pure read); side effect `'read'`.
 */
export const DISCOVERY_READINESS_GET_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DISCOVERY_TOOL_NAMESPACE}.readiness_get`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.discovery-readiness-control.v1', '1.0.0'),
  outputContractRef: contractRef('factory.discovery-readiness-assessment.v1', '1.0.0'),
  handlerRef: 'capability.saga.readiness-get',
  callTemplateRef: DISCOVERY_TOOL_RESOURCE_IDS.readinessGetCallTemplate,
  checklistRef: DISCOVERY_TOOL_RESOURCE_IDS.readinessChecklist,
  errorHintRef: DISCOVERY_TOOL_RESOURCE_IDS.readinessErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'idempotent',
  sideEffect: 'read',
};

// ---------------------------------------------------------------------------
// readiness_submit — advisor writes the advisory assessment.
// ---------------------------------------------------------------------------

/**
 * The `readiness_submit` MCP tool. The readiness advisor submits a typed
 * readiness assessment for the immutable Proposal. The kernel validates it
 * deterministically; this never modifies the product Proposal or the discovery
 * outcome. Side effect `'write'`, idempotency `'none'`.
 */
export const DISCOVERY_READINESS_SUBMIT_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DISCOVERY_TOOL_NAMESPACE}.readiness_submit`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.discovery-readiness-assessment.v1', '1.0.0'),
  outputContractRef: contractRef('factory.discovery-readiness-assessment.v1', '1.0.0'),
  handlerRef: 'capability.saga.readiness-submit',
  callTemplateRef: DISCOVERY_TOOL_RESOURCE_IDS.readinessSubmitCallTemplate,
  checklistRef: DISCOVERY_TOOL_RESOURCE_IDS.readinessChecklist,
  errorHintRef: DISCOVERY_TOOL_RESOURCE_IDS.readinessErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// diagnosis_get — diagnosis advisor reads the immutable certificate.
// ---------------------------------------------------------------------------

/**
 * The `diagnosis_get` MCP tool. The diagnosis advisor reads the immutable
 * DiagnosisCase built for the certificate target and the allowed source
 * references it may cite. Idempotency `'idempotent'` (pure read); side effect
 * `'read'`. The diagnosis advisor runs as a post-completion observer; this
 * read is the only input surface it has.
 */
export const DISCOVERY_DIAGNOSIS_GET_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DISCOVERY_TOOL_NAMESPACE}.diagnosis_get`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.discovery-diagnosis-control.v1', '1.0.0'),
  outputContractRef: contractRef('factory.discovery-diagnosis.v1', '1.0.0'),
  handlerRef: 'capability.saga.diagnosis-get',
  callTemplateRef: DISCOVERY_TOOL_RESOURCE_IDS.diagnosisGetCallTemplate,
  checklistRef: DISCOVERY_TOOL_RESOURCE_IDS.diagnosisChecklist,
  errorHintRef: DISCOVERY_TOOL_RESOURCE_IDS.diagnosisErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'idempotent',
  sideEffect: 'read',
};

// ---------------------------------------------------------------------------
// diagnosis_submit — diagnosis advisor writes the advisory report.
// ---------------------------------------------------------------------------

/**
 * The `diagnosis_submit` MCP tool. The diagnosis advisor submits a typed
 * advisory diagnosis report for the immutable certificate target. The kernel
 * validates it deterministically and accepts or rejects; this NEVER modifies
 * the D4 settlement, certificate, proposal, readiness, or the discovery
 * outcome (the diagnosis is advisory-only, per invariant
 * `discovery.diagnosis-advisory`). Side effect `'write'`, idempotency
 * `'none'`.
 */
export const DISCOVERY_DIAGNOSIS_SUBMIT_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DISCOVERY_TOOL_NAMESPACE}.diagnosis_submit`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.discovery-diagnosis.v1', '1.0.0'),
  outputContractRef: contractRef('factory.discovery-diagnosis.v1', '1.0.0'),
  handlerRef: 'capability.saga.diagnosis-submit',
  callTemplateRef: DISCOVERY_TOOL_RESOURCE_IDS.diagnosisSubmitCallTemplate,
  checklistRef: DISCOVERY_TOOL_RESOURCE_IDS.diagnosisChecklist,
  errorHintRef: DISCOVERY_TOOL_RESOURCE_IDS.diagnosisErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.diagnosis-advisory', scope: 'submit' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// artifact_create — kernel auto-provisions the discovery `brief`.
// ---------------------------------------------------------------------------

/**
 * The `artifact_create` MCP tool, as contributed for the discovery `brief`
 * product. When the proposal resolver accepts a proposal, it ensures a `brief`
 * explicitly; the generic-flow worker does not, so the kernel auto-provisions
 * a synthetic accepted brief from the accepted proposal so downstream
 * Formalization has its PRD → brief `derived_from` lineage). Side effect
 * `'write'`, idempotency `'idempotent'` — the provisioning is `INSERT`-guarded
 * by a `SELECT … WHERE type='brief'` pre-check, so provisioning the same epic
 * twice is a no-op.
 */
export const DISCOVERY_BRIEF_ARTIFACT_CREATE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DISCOVERY_TOOL_NAMESPACE}.artifact_create.brief`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.discovery-brief.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.artifact-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.artifact-create',
  callTemplateRef: DISCOVERY_TOOL_RESOURCE_IDS.briefArtifactCallTemplate,
  checklistRef: DISCOVERY_TOOL_RESOURCE_IDS.nodeChecklist,
  errorHintRef: DISCOVERY_TOOL_RESOURCE_IDS.briefErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'idempotent',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// worker_done — fenced task completion (the LM node's terminal signal).
// ---------------------------------------------------------------------------

/**
 * The `worker_done` MCP tool. This is the terminal signal an LM proposal /
 * normalization / readiness / diagnosis node emits to release its task
 * assignment. Side effect `'write'` (mutates the kanban + records the result
 * comment). Idempotency `'none'` — a second `worker_done` for the same
 * execution is rejected by the dispatcher fence, so the call is single-shot by
 * construction.
 */
export const DISCOVERY_WORKER_DONE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DISCOVERY_TOOL_NAMESPACE}.worker_done`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.mcp.worker-done.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.worker-done-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.worker-done',
  callTemplateRef: DISCOVERY_TOOL_RESOURCE_IDS.workerDoneCallTemplate,
  checklistRef: DISCOVERY_TOOL_RESOURCE_IDS.nodeChecklist,
  errorHintRef: DISCOVERY_TOOL_RESOURCE_IDS.workerDoneErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.execution-id.fence', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// Aggregate — the complete tool-contribution set the manifest carries.
// ---------------------------------------------------------------------------

/**
 * Every MCP tool contribution the Discovery package declares. The manifest
 * (W9-A1) spreads this into `ProcessModuleManifest.toolContributions`. Order
 * is stable (flow order: proposal → normalization → readiness → diagnosis →
 * brief → worker_done) so the canonical-JSON digest of a manifest carrying
 * this set is reproducible.
 */
export const DISCOVERY_TOOL_CONTRIBUTIONS: readonly ModuleToolContribution[] = Object.freeze([
  DISCOVERY_PROPOSAL_SUBMIT_CONTRIBUTION,
  DISCOVERY_NORMALIZATION_GET_CONTRIBUTION,
  DISCOVERY_NORMALIZATION_SUBMIT_CONTRIBUTION,
  DISCOVERY_READINESS_GET_CONTRIBUTION,
  DISCOVERY_READINESS_SUBMIT_CONTRIBUTION,
  DISCOVERY_DIAGNOSIS_GET_CONTRIBUTION,
  DISCOVERY_DIAGNOSIS_SUBMIT_CONTRIBUTION,
  DISCOVERY_BRIEF_ARTIFACT_CREATE_CONTRIBUTION,
  DISCOVERY_WORKER_DONE_CONTRIBUTION,
]);
