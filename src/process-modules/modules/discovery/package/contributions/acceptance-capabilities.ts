/**
 * W9-A2 — Discovery package-local acceptance capabilities.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.4 (W9-A2), §11.4 (CapabilityRequirement, GuardBinding).
 *
 * This file declares two things the Discovery package needs FROM the runtime,
 * expressed as pure Wave 1 SPI data:
 *
 *   1. `CapabilityRequirement[]` — platform capabilities the package requires
 *      before it can run. These are the versioned platform services (the
 *      managed-production ledger, the discovery-runtime persistence port, the
 *      settlement-policy repository, the outcome-certificate issuer) that the
 *      discovery kernel handlers depend on. The runtime's capability-
 *      enforcement layer refuses to start a discovery run if a required
 *      capability is absent.
 *
 *   2. `GuardBinding[]` — the package-level guards (policy references) the
 *      runtime must bind to the discovery flow's scopes. These are the
 *      authority/provenance/fence guards that wrap every discovery MCP call and
 *      every node submission, plus the diagnosis-advisory guard that enforces
 *      the diagnosis never alters the authoritative outcome.
 *
 * "Acceptance" here refers to the discovery module's acceptance semantics: the
 * kernel gate that transitions proposal/normalization/readiness/diagnosis
 * candidates from submitted → accepted_by_kernel. The capabilities below are
 * the platform services that gate depends on; the guards below are the
 * policies that enforce it is never bypassed.
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
 * The managed-production ledger capability. Discovery's kernel resolvers read
 * the exact proposal/normalization/readiness/diagnosis writes a fenced LM
 * execution persisted through this ledger — they never read mutable live
 * state. Required (not optional): without it the resolvers cannot reconstruct
 * provenance after a crash (the whole D1 exact-lineage guarantee depends on
 * it).
 */
export const DISCOVERY_CAP_MANAGED_PRODUCTION_LEDGER: CapabilityRequirement = {
  ref: 'capability.saga.managed-production-ledger',
  version: '1.0.0',
};

/**
 * The discovery-runtime persistence capability. Discovery's kernel handlers
 * read the immutable raw submission, the canonical Proposal, the
 * normalization/readiness/diagnosis rows, and the outcome certificate through
 * the `FactoryDiscoveryRuntimePersistence` port backed by this capability.
 * Required: every resolver handler depends on it to materialize the exact
 * durable product for one (intent, task, execution).
 */
export const DISCOVERY_CAP_RUNTIME_PERSISTENCE: CapabilityRequirement = {
  ref: 'capability.saga.discovery-runtime-persistence',
  version: '1.0.0',
};

/**
 * The settlement-policy repository capability. The settlement handler assembles
 * the canonical snapshot, evaluates the versioned policy, and issues the
 * immutable authoritative discovery outcome certificate through this
 * capability. Required for every terminal outcome (go/clarify/reject/defer/
 * inconclusive/failed).
 */
export const DISCOVERY_CAP_SETTLEMENT_POLICY_REPOSITORY: CapabilityRequirement = {
  ref: 'capability.saga.discovery-settlement-policy-repository',
  version: '1.0.0',
};

/**
 * The outcome-certificate issuer capability. The settlement handler forms the
 * `AuthoritativeSettlementResult` (certificate payload + hash — module content)
 * and the runtime atomically persists it through this capability (Д6/Д7).
 * Required: the certificate is the module's terminal product.
 */
export const DISCOVERY_CAP_OUTCOME_CERTIFICATE_ISSUER: CapabilityRequirement = {
  ref: 'capability.saga.discovery-outcome-certificate-issuer',
  version: '1.0.0',
};

/**
 * Optional: the LM-node execution persistence capability. The
 * the generic LM executor reuses it instead of constructing its own. Marked
 * optional so a minimal runtime that supplies its own LM persistence adapter
 * can still run the module.
 */
export const DISCOVERY_CAP_LM_NODE_EXECUTION_PERSISTENCE: CapabilityRequirement = {
  ref: 'capability.saga.lm-node-execution-persistence',
  version: '1.0.0',
  optional: true,
};

/**
 * Every platform capability the Discovery package requires. The manifest
 * (W9-A1) spreads this into `ProcessModuleManifest.capabilityRequirements`.
 */
export const DISCOVERY_CAPABILITY_REQUIREMENTS: readonly CapabilityRequirement[] = Object.freeze([
  DISCOVERY_CAP_MANAGED_PRODUCTION_LEDGER,
  DISCOVERY_CAP_RUNTIME_PERSISTENCE,
  DISCOVERY_CAP_SETTLEMENT_POLICY_REPOSITORY,
  DISCOVERY_CAP_OUTCOME_CERTIFICATE_ISSUER,
  DISCOVERY_CAP_LM_NODE_EXECUTION_PERSISTENCE,
]);

// ---------------------------------------------------------------------------
// Package-level guard bindings.
// ---------------------------------------------------------------------------

/**
 * Authority-fence guard: every MCP call a discovery LM node makes must carry
 * the durable execution fence (process/module/node/intent/task/execution ids).
 * Bound at the `call` scope so the gateway enforces it on every tool
 * invocation.
 */
export const DISCOVERY_GUARD_AUTHORITY_FENCE: GuardBinding = {
  ref: 'guard.saga.authority.fence',
  scope: 'call',
};

/**
 * Managed-production provenance guard: every proposal/normalization/readiness/
 * diagnosis/brief write must be recorded in the managed-production ledger
 * against the fenced execution. Bound at the `call` scope.
 */
export const DISCOVERY_GUARD_MANAGED_PRODUCTION: GuardBinding = {
  ref: 'guard.saga.managed-production.provenance',
  scope: 'call',
};

/**
 * Node-allowed-tools guard: an LM node may invoke only the tools its execution
 * profile declares (e.g. the normalizer may not call proposal_submit; the
 * readiness advisor may not call worker_done of another node). Bound at the
 * `submit` scope so a submission carrying an out-of-profile tool receipt is
 * rejected.
 */
export const DISCOVERY_GUARD_NODE_ALLOWED_TOOLS: GuardBinding = {
  ref: 'guard.saga.node-allowed-tools',
  scope: 'submit',
};

/**
 * Execution-id fence guard: `worker_done` must carry the dispatcher-issued
 * execution id; a stale or replayed id is rejected. Bound at the `call` scope.
 */
export const DISCOVERY_GUARD_EXECUTION_ID_FENCE: GuardBinding = {
  ref: 'guard.saga.execution-id.fence',
  scope: 'call',
};

/**
 * Diagnosis-advisory guard: the diagnosis advisor may explain but never alter
 * the certificate, proposal, readiness, or the discovery outcome (invariant
 * `discovery.diagnosis-advisory`). Bound at the `submit` scope so a diagnosis
 * submission carrying an override/new-outcome field is rejected before it
 * reaches the kernel.
 */
export const DISCOVERY_GUARD_DIAGNOSIS_ADVISORY: GuardBinding = {
  ref: 'guard.saga.diagnosis-advisory',
  scope: 'submit',
};

/**
 * Every package-level guard binding the Discovery package declares. The
 * manifest (W9-A1) spreads this into `ProcessModuleManifest.guards`.
 * Individual tool contributions (see `tool-contributions.ts`) reference these
 * same guard refs at finer-grained scopes; this array declares the package-
 * wide defaults.
 */
export const DISCOVERY_GUARD_BINDINGS: readonly GuardBinding[] = Object.freeze([
  DISCOVERY_GUARD_AUTHORITY_FENCE,
  DISCOVERY_GUARD_MANAGED_PRODUCTION,
  DISCOVERY_GUARD_NODE_ALLOWED_TOOLS,
  DISCOVERY_GUARD_EXECUTION_ID_FENCE,
  DISCOVERY_GUARD_DIAGNOSIS_ADVISORY,
]);
