/**
 * W9-A4 — Development package-local tool contributions.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.6 (W9-A4 owns Development child execution/provenance/port/
 *       handler/product contribution subtrees), §11.4 (ModuleToolContribution),
 *       §8.2 (NodeProtocol allowedTools).
 *
 * This file declares the MCP tool contributions the Development package makes to
 * the runtime, expressed as pure `ModuleToolContribution` data (Wave 1 SPI). A
 * contribution is a namespaced, versioned declaration that one named MCP tool is
 * owned by this package: its input/output contract refs, the handler that
 * implements it, the call/checklist/error-hint resource references the runtime
 * surfaces to the executing node, the guards bound to it, and its
 * idempotency/side-effect classification.
 *
 * Development is one locally-settled module with two LM-facing nodes:
 *   - planning  (`plan-task-graph`)   — proposes the task graph
 *   - verification (`verify-acceptance-workset`) — records acceptance evidence
 *
 * Between them these nodes drive three durable MCP calls:
 *   - `process_node_submit`   — planner writes the typed task-graph proposal
 *   - `verification_record`   — verifier writes the 4-valued AC evidence
 *   - `worker_done`           — both nodes complete their fenced task
 *
 * The implementation, integration and freeze steps are EXTERNAL adapters
 * (`execute-implementation-workset`, `integrate-release-candidate`,
 * `verify-acceptance-workset`'s external work) — they are not LM-driven MCP
 * calls, so they are not declared as tool contributions here. They surface to
 * the runtime as external adapter ids (owned by W9-A3's protocols + the
 * port/handler adapter in `legacy-engine-adapter.ts`).
 *
 * Each tool declaration references package-local resource paths (the call
 * templates and node checklists owned by this package's `nodes/` subtree,
 * declared by W9-A3) via `ResourceIndexEntry` logical ids — the manifest
 * resolves those to package-relative paths.
 *
 * ── Dependency-direction ──────────────────────────────────────────────────
 *
 * This file lives under `src/process-modules/modules/development/`, so it is a
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
 * The namespace prefix every development tool contribution logical id carries.
 * Keeps contributed tool ids disjoint from other modules' contributions at the
 * registry level.
 */
export const DEVELOPMENT_TOOL_NAMESPACE = 'development';

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
 * checklists are registered under. W9-A3's manifest resourceIndex maps these to
 * package-relative paths; this file references them by logical id so the
 * declaration stays path-stable even if the package is relocated.
 *
 * The planning ids mirror the `PLANNING_RESOURCE_IDS` declared by W9-A3's
 * planning node protocol so a planning tool contribution and its node protocol
 * reference the SAME resource. The verification ids back the live
 * `verification.ac` task pipeline (the `saga-verifier` skill) — they are NOT
 * tied to a node protocol: saga4 cutover (REAL-BUG #11) removed the dead
 * `verificationNodeProtocol` orphan; verification runs through projected kanban
 * tasks, not a NodeProtocolDefinition.
 */
export const DEVELOPMENT_TOOL_RESOURCE_IDS = {
  planningSubmissionCallTemplate: 'planning-task-graph-submit-call',
  planningWorkerDoneCallTemplate: 'planning-worker-done-call',
  planningChecklist: 'planning-node-checklist',
  verificationEvidenceRecordCallTemplate: 'verification-evidence-record-call',
  verificationWorkerDoneCallTemplate: 'verification-worker-done-call',
  verificationChecklist: 'verification-node-checklist',
  // Package-wide checklist surfaced to every development LM node.
  nodeChecklist: `${DEVELOPMENT_TOOL_NAMESPACE}.checklist.node`,
  plannerErrorHint: `${DEVELOPMENT_TOOL_NAMESPACE}.error-hint.planner-submit`,
  verificationErrorHint: `${DEVELOPMENT_TOOL_NAMESPACE}.error-hint.verification-record`,
  plannerWorkerDoneErrorHint: `${DEVELOPMENT_TOOL_NAMESPACE}.error-hint.planner-worker-done`,
  verificationWorkerDoneErrorHint: `${DEVELOPMENT_TOOL_NAMESPACE}.error-hint.verification-worker-done`,
} as const;

// ---------------------------------------------------------------------------
// process_node_submit — planner writes the typed task-graph proposal.
// ---------------------------------------------------------------------------

/**
 * The `process_node_submit` MCP tool, as contributed by the planning node. The
 * planner submits one typed `DevelopmentTaskGraphProposal`; the kernel resolver
 * validates lineage/coverage/DAG constraints and materializes canonical tasks.
 * Idempotency is `'none'` (a second submit for the same execution is rejected
 * by the dispatcher fence); side effect is `'write'` (it mutates durable saga3
 * node-submission state). The handler ref points at the platform capability —
 * development DECLARES the tool, the platform IMPLEMENTS it.
 */
export const DEVELOPMENT_PROCESS_NODE_SUBMIT_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DEVELOPMENT_TOOL_NAMESPACE}.process_node_submit`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.development-task-graph-proposal.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.process-node-submit-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.process-node-submit',
  callTemplateRef: DEVELOPMENT_TOOL_RESOURCE_IDS.planningSubmissionCallTemplate,
  checklistRef: DEVELOPMENT_TOOL_RESOURCE_IDS.planningChecklist,
  errorHintRef: DEVELOPMENT_TOOL_RESOURCE_IDS.plannerErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// verification_record — verifier records the 4-valued AC evidence.
// ---------------------------------------------------------------------------

/**
 * The `verification_record` MCP tool. The independent verifier records one
 * acceptance-verification evidence row per AC, binding both the AC accepted
 * hash and the exact frozen candidate hash, with a CGAD 4-valued verdict
 * (passed/failed/unknown/error). Only `passed` creates a `verified_by` edge;
 * `unknown` and `error` are denials (CGAD P14). Side effect `'write'`,
 * idempotency `'none'` — a second record for the same (task, artifact,
 * execution) is single-shot by the dispatcher fence.
 */
export const DEVELOPMENT_VERIFICATION_RECORD_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DEVELOPMENT_TOOL_NAMESPACE}.verification_record`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.mcp.verification-record.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.verification-record-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.verification-record',
  callTemplateRef: DEVELOPMENT_TOOL_RESOURCE_IDS.verificationEvidenceRecordCallTemplate,
  checklistRef: DEVELOPMENT_TOOL_RESOURCE_IDS.verificationChecklist,
  errorHintRef: DEVELOPMENT_TOOL_RESOURCE_IDS.verificationErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.evidence-pins-candidate', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// worker_done — fenced task completion (the LM node's terminal signal).
// ---------------------------------------------------------------------------

/**
 * The `worker_done` MCP tool, as contributed for the planning node. This is the
 * terminal signal the planner emits to release its task assignment after
 * submitting the task-graph proposal. Side effect `'write'` (it mutates the
 * kanban + records the result comment). Idempotency `'none'` — a second
 * `worker_done` for the same execution is rejected by the dispatcher fence, so
 * the call is single-shot by construction.
 */
export const DEVELOPMENT_PLANNER_WORKER_DONE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DEVELOPMENT_TOOL_NAMESPACE}.planner.worker_done`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.mcp.worker-done.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.worker-done-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.worker-done',
  callTemplateRef: DEVELOPMENT_TOOL_RESOURCE_IDS.planningWorkerDoneCallTemplate,
  checklistRef: DEVELOPMENT_TOOL_RESOURCE_IDS.planningChecklist,
  errorHintRef: DEVELOPMENT_TOOL_RESOURCE_IDS.plannerWorkerDoneErrorHint,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.execution-id.fence', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

/**
 * The `worker_done` MCP tool, as contributed for the verification node. Same
 * shape as the planner's contribution, but pinned to the verification call
 * template + checklist so the runtime surfaces the verifier's completion
 * instructions, not the planner's.
 */
export const DEVELOPMENT_VERIFIER_WORKER_DONE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DEVELOPMENT_TOOL_NAMESPACE}.verifier.worker_done`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.mcp.worker-done.v1', '1.0.0'),
  outputContractRef: contractRef('factory.mcp.worker-done-result.v1', '1.0.0'),
  handlerRef: 'capability.saga.worker-done',
  callTemplateRef: DEVELOPMENT_TOOL_RESOURCE_IDS.verificationWorkerDoneCallTemplate,
  checklistRef: DEVELOPMENT_TOOL_RESOURCE_IDS.verificationChecklist,
  errorHintRef: DEVELOPMENT_TOOL_RESOURCE_IDS.verificationWorkerDoneErrorHint,
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
 * Every MCP tool contribution the Development package declares. The manifest
 * spreads this into `ProcessModuleManifest.toolContributions`. Order is stable
 * (flow order: planner submit → verifier evidence → planner done → verifier
 * done) so the canonical-JSON digest of a manifest carrying this set is
 * reproducible.
 */
export const DEVELOPMENT_TOOL_CONTRIBUTIONS: readonly ModuleToolContribution[] = Object.freeze([
  DEVELOPMENT_PROCESS_NODE_SUBMIT_CONTRIBUTION,
  DEVELOPMENT_VERIFICATION_RECORD_CONTRIBUTION,
  DEVELOPMENT_PLANNER_WORKER_DONE_CONTRIBUTION,
  DEVELOPMENT_VERIFIER_WORKER_DONE_CONTRIBUTION,
]);
