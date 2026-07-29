/**
 * W9-A4 — Development package-local acceptance capabilities.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.6 (W9-A4), §11.4 (CapabilityRequirement, GuardBinding).
 *
 * This file declares two things the Development package needs FROM the runtime,
 * expressed as pure Wave 1 SPI data:
 *
 *   1. `CapabilityRequirement[]` — platform capabilities the package requires
 *      before it can run. These are the versioned platform services (the
 *      managed-production ledger, the development-runtime persistence ports,
 *      the settlement-policy repository, the candidate-freezer, the output
 *      repository) that the development kernel handlers and external adapters
 *      depend on. The runtime's capability-enforcement layer refuses to start a
 *      development run if a required capability is absent.
 *
 *   2. `GuardBinding[]` — the package-level guards (policy references) the
 *      runtime must bind to the development flow's scopes. These are the
 *      authority/provenance/fence guards that wrap every development MCP call
 *      and every node submission, plus the evidence-pins-candidate and
 *      candidate-immutability guards that enforce the core development
 *      invariants.
 *
 * "Acceptance" here refers to the development module's acceptance semantics:
 * the kernel gate that materializes the planner's proposal into canonical tasks
 * (only after lineage/coverage/DAG validation) and the settlement gate that
 * admits only a complete workset with trusted evidence bound to the unchanged
 * frozen candidate. The capabilities below are the platform services those
 * gates depend on; the guards below are the policies that enforce they are
 * never bypassed.
 *
 * PURE DATA: readonly constants typed by the Wave 1 SPI. No behavior.
 */

import type {
  CapabilityRequirement,
  GuardBinding,
} from '../../../../domain/spi/tool-contribution.js';

// ---------------------------------------------------------------------------
// Capability requirements.
// ---------------------------------------------------------------------------

/**
 * The managed-production ledger capability. Development's kernel resolver and
 * settlement handler read the exact node-submission / external-action receipts a
 * fenced execution persisted through this ledger — they never read mutable live
 * state. Required (not optional): without it the resolver cannot reconstruct
 * provenance after a crash (the exact-lineage guarantee depends on it).
 */
export const DEVELOPMENT_CAP_MANAGED_PRODUCTION_LEDGER: CapabilityRequirement = {
  ref: 'capability.saga.managed-production-ledger',
  version: '1.0.0',
};

/**
 * The development task-graph persistence capability. The resolver kernel
 * persists the kernel-validated `DevelopmentTaskGraphSnapshot` and atomically
 * materializes its task projections through the `DevelopmentTaskGraphPort`
 * backed by this capability. Required: the resolver has no other path to create
 * canonical tasks (invariant `development.lm-proposes-kernel-authorizes`).
 */
export const DEVELOPMENT_CAP_TASK_GRAPH_PERSISTENCE: CapabilityRequirement = {
  ref: 'capability.saga.development-task-graph-persistence',
  version: '1.0.0',
};

/**
 * The external-workset execution capability. The implementation, integration
 * and verification external adapters drive bounded workers through the
 * `DevelopmentImplementationWorksetPort` /
 * `DevelopmentCandidateIntegrationPort` /
 * `DevelopmentAcceptanceVerificationPort` backed by this capability. Required:
 * development cannot execute or freeze a release candidate without it.
 */
export const DEVELOPMENT_CAP_EXTERNAL_WORKSET_EXECUTION: CapabilityRequirement = {
  ref: 'capability.saga.development-external-workset-execution',
  version: '1.0.0',
};

/**
 * The candidate-freezer capability. The integration adapter freezes exact
 * repository trees and build digests into an immutable
 * `IntegratedReleaseCandidate` through this capability. Required: verification
 * binds to that exact frozen hash (invariant
 * `development.integrate-before-verification`).
 */
export const DEVELOPMENT_CAP_CANDIDATE_FREEZER: CapabilityRequirement = {
  ref: 'capability.saga.development-candidate-freezer',
  version: '1.0.0',
};

/**
 * The development settlement-state capability. The settlement handler re-reads
 * exact durable products by refs/hashes and re-observes the candidate through
 * the `DevelopmentSettlementStatePort` backed by this capability. Required: it
 * is the only input to deterministic settlement (invariant
 * `development.exact-lineage` — no epic-wide "latest" lookup).
 */
export const DEVELOPMENT_CAP_SETTLEMENT_STATE: CapabilityRequirement = {
  ref: 'capability.saga.development-settlement-state',
  version: '1.0.0',
};

/**
 * The output repository capability. The settlement handler persists the
 * immutable `VerifiedIntegrationBundle` (the module's terminal product)
 * through the `DevelopmentOutputRepository` backed by this capability. Required
 * for the `verified` outcome.
 */
export const DEVELOPMENT_CAP_OUTPUT_REPOSITORY: CapabilityRequirement = {
  ref: 'capability.saga.development-output-repository',
  version: '1.0.0',
};

/**
 * Optional: the LM-node execution persistence capability. The development
 * planning + verification adapters project the generic
 * `LmNodeExecutionPersistence` interface over the saga3 runtime; when present,
 * the generic LM executor reuses it instead of constructing its own. Marked
 * optional so a minimal runtime that supplies its own LM persistence adapter
 * can still run the module.
 */
export const DEVELOPMENT_CAP_LM_NODE_EXECUTION_PERSISTENCE: CapabilityRequirement = {
  ref: 'capability.saga.lm-node-execution-persistence',
  version: '1.0.0',
  optional: true,
};

/**
 * Every platform capability the Development package requires. The manifest
 * spreads this into `ProcessModuleManifest.capabilityRequirements`.
 */
export const DEVELOPMENT_CAPABILITY_REQUIREMENTS: readonly CapabilityRequirement[] = Object.freeze([
  DEVELOPMENT_CAP_MANAGED_PRODUCTION_LEDGER,
  DEVELOPMENT_CAP_TASK_GRAPH_PERSISTENCE,
  DEVELOPMENT_CAP_EXTERNAL_WORKSET_EXECUTION,
  DEVELOPMENT_CAP_CANDIDATE_FREEZER,
  DEVELOPMENT_CAP_SETTLEMENT_STATE,
  DEVELOPMENT_CAP_OUTPUT_REPOSITORY,
  DEVELOPMENT_CAP_LM_NODE_EXECUTION_PERSISTENCE,
]);

// ---------------------------------------------------------------------------
// Package-level guard bindings.
// ---------------------------------------------------------------------------

/**
 * Authority-fence guard: every MCP call a development LM node makes must carry
 * the durable execution fence (process/module/node/intent/task/execution ids).
 * Bound at the `call` scope so the gateway enforces it on every tool
 * invocation.
 */
export const DEVELOPMENT_GUARD_AUTHORITY_FENCE: GuardBinding = {
  ref: 'guard.saga.authority.fence',
  scope: 'call',
};

/**
 * Managed-production provenance guard: every process_node_submit /
 * verification_record write must be recorded in the managed-production ledger
 * against the fenced execution. Bound at the `call` scope.
 */
export const DEVELOPMENT_GUARD_MANAGED_PRODUCTION: GuardBinding = {
  ref: 'guard.saga.managed-production.provenance',
  scope: 'call',
};

/**
 * Node-allowed-tools guard: an LM node may invoke only the tools its execution
 * profile declares (the planner may not call verification_record; the verifier
 * may not call process_node_submit). Bound at the `submit` scope so a
 * submission carrying an out-of-profile tool receipt is rejected.
 */
export const DEVELOPMENT_GUARD_NODE_ALLOWED_TOOLS: GuardBinding = {
  ref: 'guard.saga.node-allowed-tools',
  scope: 'submit',
};

/**
 * Execution-id fence guard: `worker_done` must carry the dispatcher-issued
 * execution id; a stale or replayed id is rejected. Bound at the `call` scope.
 */
export const DEVELOPMENT_GUARD_EXECUTION_ID_FENCE: GuardBinding = {
  ref: 'guard.saga.execution-id.fence',
  scope: 'call',
};

/**
 * Evidence-pins-candidate guard: every verification_record must pin BOTH the AC
 * accepted hash AND the exact frozen candidate hash (invariant
 * `development.evidence-pins-candidate`). Bound at the `call` scope so a
 * record carrying a mismatched or absent candidate hash is rejected before it
 * reaches the kernel.
 */
export const DEVELOPMENT_GUARD_EVIDENCE_PINS_CANDIDATE: GuardBinding = {
  ref: 'guard.saga.evidence-pins-candidate',
  scope: 'call',
};

/**
 * Candidate-immutability guard: once the release candidate is frozen, no
 * development node may mutate the repository trees / build digests it seals
 * (invariant `development.no-post-verification-mutation`). Bound at the `node`
 * scope so the guard spans every call within a post-freeze node.
 */
export const DEVELOPMENT_GUARD_CANDIDATE_IMMUTABLE: GuardBinding = {
  ref: 'guard.saga.candidate.immutable',
  scope: 'node',
};

/**
 * Every package-level guard binding the Development package declares. The
 * manifest spreads this into `ProcessModuleManifest.guards`. Individual tool
 * contributions (see `tool-contributions.ts`) reference these same guard refs
 * at finer-grained scopes; this array declares the package-wide defaults.
 */
export const DEVELOPMENT_GUARD_BINDINGS: readonly GuardBinding[] = Object.freeze([
  DEVELOPMENT_GUARD_AUTHORITY_FENCE,
  DEVELOPMENT_GUARD_MANAGED_PRODUCTION,
  DEVELOPMENT_GUARD_NODE_ALLOWED_TOOLS,
  DEVELOPMENT_GUARD_EXECUTION_ID_FENCE,
  DEVELOPMENT_GUARD_EVIDENCE_PINS_CANDIDATE,
  DEVELOPMENT_GUARD_CANDIDATE_IMMUTABLE,
]);
