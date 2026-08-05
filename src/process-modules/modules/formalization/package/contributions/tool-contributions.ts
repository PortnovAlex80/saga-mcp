/**
 * W8-A7 — Formalization package-local tool contributions.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md.
 * Plan: §11.4 (ModuleToolContribution), §8.2 (NodeProtocol allowedTools).
 *
 * This file declares the MCP tool contributions the Formalization package
 * makes to the runtime, expressed as pure `ModuleToolContribution` data (Wave
 * 1 SPI). A contribution is a namespaced, versioned declaration that one
 * named MCP tool is owned by this package: its input/output contract refs,
 * the handler that implements it, the call/checklist/error-hint resource
 * references the runtime surfaces to the executing node, the guards bound to
 * it, and its idempotency/side-effect classification.
 *
 * The formalization flow drives three durable MCP calls from its LM nodes:
 *   - `artifact_create` / `artifact_update` — write PRD/FR/NFR/RULE/UC/AC/SRS
 *   - `trace_add`                          — write the derived_from/covers edges
 *   - `worker_done`                        — complete the fenced task
 *
 * Each is declared here so the Wave 6 tool-contribution installer can register
 * it without the runtime hardcoding the formalization tool catalog. The
 * declarations reference package-local resource paths (the call templates and
 * the node checklist owned by this package) via `ResourceIndexEntry` logical
 * ids — the manifest (W8-A1) resolves those to package-relative paths.
 *
 * ── Dependency-direction ──────────────────────────────────────────────────
 *
 * This file lives under `src/process-modules/modules/formalization/`, so it is
 * a MODULE file. The dependency-direction ratchet (Rule 1/2) permits a module
 * to import the pure domain SPI (`domain/spi/*`) — Rule 5 forbids the REVERSE
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
 * The namespace prefix every formalization tool contribution logical id
 * carries. Keeps contributed tool ids disjoint from other modules'
 * contributions at the registry level.
 */
export const FORMALIZATION_TOOL_NAMESPACE = 'formalization';

/**
 * Shared placeholder contract ref. Wave 8 does not yet register concrete JSON
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
 * checklist are registered under. W8-A1's manifest resourceIndex maps these to
 * package-relative paths; this file references them by logical id so the
 * declaration stays path-stable even if the package is relocated.
 */
export const FORMALIZATION_TOOL_RESOURCE_IDS = {
  artifactCallTemplate: `${FORMALIZATION_TOOL_NAMESPACE}.call-template.artifact-create`,
  traceCallTemplate: `${FORMALIZATION_TOOL_NAMESPACE}.call-template.trace-add`,
  workerDoneCallTemplate: `${FORMALIZATION_TOOL_NAMESPACE}.call-template.worker-done`,
  nodeChecklist: `${FORMALIZATION_TOOL_NAMESPACE}.checklist.node`,
  artifactErrorHint: `${FORMALIZATION_TOOL_NAMESPACE}.error-hint.artifact-write`,
  traceErrorHint: `${FORMALIZATION_TOOL_NAMESPACE}.error-hint.trace-write`,
  workerDoneErrorHint: `${FORMALIZATION_TOOL_NAMESPACE}.error-hint.worker-done`,
} as const;

// ---------------------------------------------------------------------------
// artifact_create — durable artifact write (PRD/FR/NFR/RULE/UC/AC/SRS).
// ---------------------------------------------------------------------------

/**
 * The `artifact_create` MCP tool, as contributed by the Formalization package.
 * Idempotency is `'none'` (creating the same artifact twice produces two rows);
 * side effect is `'write'` (it mutates durable tracker state). The handler ref
 * points at the platform capability `capability.saga.artifact-create` owned by
 * the Wave 6 capability-packages layer — formalization DECLARES the tool, the
 * platform IMPLEMENTS it.
 */
export const FORMALIZATION_ARTIFACT_CREATE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${FORMALIZATION_TOOL_NAMESPACE}.artifact_create`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.mcp.artifact-create.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.artifact-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.artifact-create',
  callTemplateRef: FORMALIZATION_TOOL_RESOURCE_IDS.artifactCallTemplate,
  checklistRef: FORMALIZATION_TOOL_RESOURCE_IDS.nodeChecklist,
  errorHintRef: FORMALIZATION_TOOL_RESOURCE_IDS.artifactErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// artifact_update — durable artifact version update (status / content hash).
// ---------------------------------------------------------------------------

/**
 * The `artifact_update` MCP tool. Formalization resolvers never mutate
 * artifacts directly (the common kernel gate owns the accepted+clean
 * transition), but LM author/review nodes update draft/in_review rows. Side
 * effect `'write'`, idempotency `'none'`.
 */
export const FORMALIZATION_ARTIFACT_UPDATE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${FORMALIZATION_TOOL_NAMESPACE}.artifact_update`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.mcp.artifact-update.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.artifact-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.artifact-update',
  callTemplateRef: FORMALIZATION_TOOL_RESOURCE_IDS.artifactCallTemplate,
  checklistRef: FORMALIZATION_TOOL_RESOURCE_IDS.nodeChecklist,
  errorHintRef: FORMALIZATION_TOOL_RESOURCE_IDS.artifactErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// trace_add — durable traceability edge (derived_from / covers / enforced_by).
// ---------------------------------------------------------------------------

/**
 * The `trace_add` MCP tool. Side effect `'write'`. Idempotency is
 * `'idempotent'`: adding the same (source, target, link_type) edge a second
 * time is a no-op at the tracker level (the SQL uses `INSERT OR IGNORE`), so a
 * retry/recovery re-submission does not duplicate the edge.
 */
export const FORMALIZATION_TRACE_ADD_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${FORMALIZATION_TOOL_NAMESPACE}.trace_add`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.mcp.trace-add.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.trace-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.trace-add',
  callTemplateRef: FORMALIZATION_TOOL_RESOURCE_IDS.traceCallTemplate,
  checklistRef: FORMALIZATION_TOOL_RESOURCE_IDS.nodeChecklist,
  errorHintRef: FORMALIZATION_TOOL_RESOURCE_IDS.traceErrorHint,
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
 * The `worker_done` MCP tool. This is the terminal signal an LM author/review
 * node emits to release its task assignment. Side effect `'write'` (it mutates
 * the kanban + records the result comment). Idempotency `'none'` — a second
 * `worker_done` for the same execution is rejected by the dispatcher fence, so
 * the call is single-shot by construction.
 */
export const FORMALIZATION_WORKER_DONE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${FORMALIZATION_TOOL_NAMESPACE}.worker_done`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.mcp.worker-done.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.worker-done-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.worker-done',
  callTemplateRef: FORMALIZATION_TOOL_RESOURCE_IDS.workerDoneCallTemplate,
  checklistRef: FORMALIZATION_TOOL_RESOURCE_IDS.nodeChecklist,
  errorHintRef: FORMALIZATION_TOOL_RESOURCE_IDS.workerDoneErrorHint,
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
 * Every MCP tool contribution the Formalization package declares. The manifest
 * (W8-A1) spreads this into `ProcessModuleManifest.toolContributions`. Order
 * is stable (declaration order) so the canonical-JSON digest of a manifest
 * carrying this set is reproducible.
 */
export const FORMALIZATION_TOOL_CONTRIBUTIONS: readonly ModuleToolContribution[] = Object.freeze([
  FORMALIZATION_ARTIFACT_CREATE_CONTRIBUTION,
  FORMALIZATION_ARTIFACT_UPDATE_CONTRIBUTION,
  FORMALIZATION_TRACE_ADD_CONTRIBUTION,
  FORMALIZATION_WORKER_DONE_CONTRIBUTION,
]);
