/**
 * W8-A7 — Formalization package-local acceptance capabilities.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md.
 * Plan: §11.4 (CapabilityRequirement, GuardBinding).
 *
 * This file declares two things the Formalization package needs FROM the
 * runtime, expressed as pure Wave 1 SPI data:
 *
 *   1. `CapabilityRequirement[]` — platform capabilities the package requires
 *      before it can run. These are the versioned platform services (the
 *      managed-production ledger, the universal Production Cell Gate, the
 *      artifact-graph reader, the baseline freezer) that the formalization
 *      kernel handlers depend on. The runtime's capability-enforcement layer
 *      (Wave 6 `capability-packages.ts`) refuses to start a formalization run
 *      if a required capability is absent.
 *
 *   2. `GuardBinding[]` — the package-level guards (policy references) the
 *      runtime must bind to the formalization flow's scopes. These are the
 *      authority/provenance/fence guards that wrap every formalization MCP
 *      call and every node submission.
 *
 * "Acceptance" here refers to the formalization module's contract-acceptance
 * semantics: the kernel gate that transitions PRD/FR/NFR/RULE/UC/AC/SRS
 * candidates from draft → accepted+clean. The capabilities below are the
 * platform services that gate depends on; the guards below are the policies
 * that enforce it is never bypassed.
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
 * The managed-production ledger capability. Formalization's kernel resolvers
 * read the exact artifact/trace writes a fenced LM execution persisted through
 * this ledger — they never read mutable live state. Required (not optional):
 * without it the resolvers cannot reconstruct provenance after a crash.
 */
export const FORMALIZATION_CAP_MANAGED_PRODUCTION_LEDGER: CapabilityRequirement = {
  ref: 'capability.saga.managed-production-ledger',
  version: '1.0.0',
};

/**
 * Acceptance is owned exclusively by the universal Production Cell Gate.
 */
/**
 * The canonical artifact-graph reader capability. Formalization's resolvers and
 * settlement policy read accepted artifacts, their hashes, and their
 * traceability edges through this read-only port. Required.
 */
export const FORMALIZATION_CAP_ARTIFACT_GRAPH_READER: CapabilityRequirement = {
  ref: 'capability.saga.artifact-graph-reader',
  version: '1.0.0',
};

/**
 * The acceptance-baseline freezer capability. The `freeze-acceptance-baseline`
 * kernel node computes and persists the immutable baseline hash from the
 * accepted AC set through this capability. Required: the architecture node
 * cannot verify baseline immutability without it.
 */
export const FORMALIZATION_CAP_BASELINE_FREEZER: CapabilityRequirement = {
  ref: 'capability.saga.acceptance-baseline-freezer',
  version: '1.0.0',
};

/**
 * The solution-contract repository capability. The settlement handler persists
 * the immutable `FormalizationSolutionContractPayload` through this capability,
 * and the lifecycle output resolver re-reads the exact row. Required for the
 * `formalized` outcome.
 */
export const FORMALIZATION_CAP_SOLUTION_CONTRACT_REPOSITORY: CapabilityRequirement = {
  ref: 'capability.saga.solution-contract-repository',
  version: '1.0.0',
};

/**
 * Optional: a traceability-policy evaluator. The settlement policy reuses the
 * through this capability when present. Marked optional so a minimal runtime
 * that ships only the formalization-native graph checks can still run the
 * module — the policy falls back to its built-in `findContractGap`.
 */
export const FORMALIZATION_CAP_TRACEABILITY_POLICY: CapabilityRequirement = {
  ref: 'capability.saga.traceability-policy',
  version: '1.0.0',
  optional: true,
};

/**
 * Every platform capability the Formalization package requires. The manifest
 * (W8-A1) spreads this into `ProcessModuleManifest.capabilityRequirements`.
 */
export const FORMALIZATION_CAPABILITY_REQUIREMENTS: readonly CapabilityRequirement[] = Object.freeze([
  FORMALIZATION_CAP_MANAGED_PRODUCTION_LEDGER,
  FORMALIZATION_CAP_ARTIFACT_GRAPH_READER,
  FORMALIZATION_CAP_BASELINE_FREEZER,
  FORMALIZATION_CAP_SOLUTION_CONTRACT_REPOSITORY,
  FORMALIZATION_CAP_TRACEABILITY_POLICY,
]);

// ---------------------------------------------------------------------------
// Package-level guard bindings.
// ---------------------------------------------------------------------------

/**
 * Authority-fence guard: every MCP call a formalization LM node makes must
 * carry the durable execution fence (process/module/node/intent/task/
 * execution ids). Bound at the `call` scope so the gateway enforces it on
 * every tool invocation.
 */
export const FORMALIZATION_GUARD_AUTHORITY_FENCE: GuardBinding = {
  ref: 'guard.saga.authority.fence',
  scope: 'call',
};

/**
 * Managed-production provenance guard: every artifact/trace write must be
 * recorded in the managed-production ledger against the fenced execution.
 * Bound at the `call` scope.
 */
export const FORMALIZATION_GUARD_MANAGED_PRODUCTION: GuardBinding = {
  ref: 'guard.saga.managed-production.provenance',
  scope: 'call',
};

/**
 * Node-allowed-tools guard: an LM node may invoke only the tools its execution
 * profile declares (the COMMON_READ/COMMON_WRITE sets). Bound at the `submit`
 * scope so a submission carrying an out-of-profile tool receipt is rejected.
 */
export const FORMALIZATION_GUARD_NODE_ALLOWED_TOOLS: GuardBinding = {
  ref: 'guard.saga.node-allowed-tools',
  scope: 'submit',
};

/**
 * Execution-id fence guard: `worker_done` must carry the dispatcher-issued
 * execution id; a stale or replayed id is rejected. Bound at the `call` scope.
 */
export const FORMALIZATION_GUARD_EXECUTION_ID_FENCE: GuardBinding = {
  ref: 'guard.saga.execution-id.fence',
  scope: 'call',
};

/**
 * Baseline-immutability guard: once the acceptance baseline is frozen, no
 * formalization node may mutate the AC set it seals. Bound at the `node` scope
 * so the guard spans every call within a post-freeze node.
 */
export const FORMALIZATION_GUARD_BASELINE_IMMUTABLE: GuardBinding = {
  ref: 'guard.saga.baseline.immutable',
  scope: 'node',
};

/**
 * Every package-level guard binding the Formalization package declares. The
 * manifest (W8-A1) spreads this into `ProcessModuleManifest.guards`. Individual
 * tool contributions (see `tool-contributions.ts`) reference these same guard
 * refs at finer-grained scopes; this array declares the package-wide defaults.
 */
export const FORMALIZATION_GUARD_BINDINGS: readonly GuardBinding[] = Object.freeze([
  FORMALIZATION_GUARD_AUTHORITY_FENCE,
  FORMALIZATION_GUARD_MANAGED_PRODUCTION,
  FORMALIZATION_GUARD_NODE_ALLOWED_TOOLS,
  FORMALIZATION_GUARD_EXECUTION_ID_FENCE,
  FORMALIZATION_GUARD_BASELINE_IMMUTABLE,
]);
