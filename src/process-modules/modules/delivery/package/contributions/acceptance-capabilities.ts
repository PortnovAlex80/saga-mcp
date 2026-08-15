/**
 * W9-A6 — Delivery package-local acceptance capabilities.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6), §11.4 (CapabilityRequirement, GuardBinding).
 *
 * This file declares two things the Delivery package needs FROM the runtime,
 * expressed as pure Wave 1 SPI data:
 *
 *   1. `CapabilityRequirement[]` — platform capabilities the package requires
 *      before it can run. These are the versioned platform services (the
 *      managed-production ledger, the delivery-runtime persistence port, the
 *      preflight/settlement policy ports, the output repository, the trusted
 *      guard provider registry) that the delivery kernel handlers and external
 *      / human adapters depend on. The runtime's capability-enforcement layer
 *      refuses to start a delivery run if a required capability is absent.
 *
 *   2. `GuardBinding[]` — the package-level guards (policy references) the
 *      runtime must bind to the delivery flow's scopes. These are the
 *      authority/provenance/fence guards that wrap every delivery MCP call and
 *      every node submission, PLUS the Delivery-specific invariants
 *      (explicit-operator-authorization, approval-binds-exact-input,
 *      no-default-provider, push-is-not-release, candidate-is-immutable,
 *      no-force-or-bypass) that enforce release can never be created by
 *      accident or bypass.
 *
 * "Acceptance" here refers to the delivery module's release-acceptance
 * semantics: the settlement gate that admits a release ONLY when authorized
 * desired-state actions are authoritatively observed at their desired state.
 * The capabilities below are the platform services that gate depends on; the
 * guards below are the policies that enforce it is never bypassed.
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
 * The managed-production ledger capability. Delivery's settlement handler reads
 * the exact preflight/approval/publication/observation writes a fenced
 * execution persisted through this ledger — it never reads mutable live state
 * (a push response alone never establishes release, invariant
 * `delivery.push-is-not-release`). Required (not optional): without it the
 * settlement gate cannot reconstruct the exact durable product graph after a
 * crash.
 */
export const DELIVERY_CAP_MANAGED_PRODUCTION_LEDGER: CapabilityRequirement = {
  ref: 'capability.saga.managed-production-ledger',
  version: '1.0.0',
};

/**
 * The delivery-runtime persistence capability. Delivery's kernel handlers and
 * adapters read the durable release case, preflight/approval/publication/
 * observation snapshots, the settlement input, and the canonical ReleaseRecord
 * through the delivery runtime persistence ports backed by this capability.
 * Required: every kernel/external/human handler depends on it to materialize
 * the exact durable product for one (intent, task, execution).
 */
export const DELIVERY_CAP_RUNTIME_PERSISTENCE: CapabilityRequirement = {
  ref: 'capability.saga.delivery-runtime-persistence',
  version: '1.0.0',
};

/**
 * The preflight-policy capability. The preflight kernel handler assembles the
 * complete trusted release-guard evidence for the exact certified candidate
 * through the injected `DeliveryPreflightPolicyPort` backed by this
 * capability. Required: it is the ONLY path by which preflight evidence is
 * admitted.
 */
export const DELIVERY_CAP_PREFLIGHT_POLICY: CapabilityRequirement = {
  ref: 'capability.saga.delivery-preflight-policy',
  version: '1.0.0',
};

/**
 * The settlement-policy capability. The settlement kernel handler evaluates
 * the canonical settlement input (preflight + approval + publication +
 * observation + current candidate hash) and issues the delivery certificate
 * through the injected `DeliverySettlementPolicyPort` backed by this
 * capability. Required for every terminal outcome (released /
 * approval-required / blocked / failed).
 */
export const DELIVERY_CAP_SETTLEMENT_POLICY: CapabilityRequirement = {
  ref: 'capability.saga.delivery-settlement-policy',
  version: '1.0.0',
};

/**
 * The output-repository capability. The settlement handler persists the
 * canonical ReleaseRecord (on a `released` decision) and the output resolver
 * re-reads the exact row through the `DeliveryOutputRepository` backed by this
 * capability. Required for the `released` outcome — the ReleaseRecord is the
 * module's terminal externally-visible product.
 */
export const DELIVERY_CAP_OUTPUT_REPOSITORY: CapabilityRequirement = {
  ref: 'capability.saga.delivery-output-repository',
  version: '1.0.0',
};

/**
 * The trusted-provider registry capability. Delivery REQUIRES that every
 * guard, decision, publication and observation provider be a registered
 * trusted provider (invariant `delivery.no-default-provider`). The preflight
 * handler and the settlement gate consult this registry to confirm each
 * provider binding is trusted before admitting its evidence. Required.
 */
export const DELIVERY_CAP_TRUSTED_PROVIDER_REGISTRY: CapabilityRequirement = {
  ref: 'capability.saga.trusted-provider-registry',
  version: '1.0.0',
};

/**
 * Optional: the delivery approval-inbox capability. The human approval adapter
 * reads pending and decides approvals through the durable approval inbox
 * (`delivery_approval_requests`). Marked optional so a minimal runtime that
 * supplies its own approval adapter can still run the module.
 */
export const DELIVERY_CAP_APPROVAL_INBOX: CapabilityRequirement = {
  ref: 'capability.saga.delivery-approval-inbox',
  version: '1.0.0',
  optional: true,
};

/**
 * Every platform capability the Delivery package requires. The manifest
 * (W9-A5) spreads this into `ProcessModuleManifest.capabilityRequirements`.
 */
export const DELIVERY_CAPABILITY_REQUIREMENTS: readonly CapabilityRequirement[] = Object.freeze([
  DELIVERY_CAP_MANAGED_PRODUCTION_LEDGER,
  DELIVERY_CAP_RUNTIME_PERSISTENCE,
  DELIVERY_CAP_PREFLIGHT_POLICY,
  DELIVERY_CAP_SETTLEMENT_POLICY,
  DELIVERY_CAP_OUTPUT_REPOSITORY,
  DELIVERY_CAP_TRUSTED_PROVIDER_REGISTRY,
  DELIVERY_CAP_APPROVAL_INBOX,
]);

// ---------------------------------------------------------------------------
// Package-level guard bindings.
// ---------------------------------------------------------------------------

/**
 * Authority-fence guard: every MCP call a delivery kernel/external/human node
 * makes must carry the durable execution fence (process/module/node/intent/
 * task/execution ids). Bound at the `call` scope so the gateway enforces it on
 * every tool invocation.
 */
export const DELIVERY_GUARD_AUTHORITY_FENCE: GuardBinding = {
  ref: 'guard.saga.authority.fence',
  scope: 'call',
};

/**
 * Managed-production provenance guard: every preflight/approval/publication/
 * observation/record write must be recorded in the managed-production ledger
 * against the fenced execution. Bound at the `call` scope.
 */
export const DELIVERY_GUARD_MANAGED_PRODUCTION: GuardBinding = {
  ref: 'guard.saga.managed-production.provenance',
  scope: 'call',
};

/**
 * Node-allowed-tools guard: a delivery node may invoke only the tools its
 * execution profile declares. Bound at the `submit` scope so a submission
 * carrying an out-of-profile tool receipt is rejected.
 */
export const DELIVERY_GUARD_NODE_ALLOWED_TOOLS: GuardBinding = {
  ref: 'guard.saga.node-allowed-tools',
  scope: 'submit',
};

/**
 * Explicit-operator-authorization guard: no externally-visible release action
 * may begin without an explicit operator grant bound to the immutable release
 * policy and the exact candidate (invariant
 * `delivery.explicit-operator-authorization`). Bound at the `call` scope so the
 * publication adapter is gated before any external effect.
 */
export const DELIVERY_GUARD_EXPLICIT_OPERATOR_AUTHORIZATION: GuardBinding = {
  ref: 'guard.saga.explicit-operator-authorization',
  scope: 'call',
};

/**
 * Approval-binds-exact-input guard: human approval binds the candidate hash,
 * preflight hash and release-policy hash and cannot float to a later revision
 * (invariant `delivery.approval-binds-exact-input`). Bound at the `call` scope.
 */
export const DELIVERY_GUARD_APPROVAL_BINDS_EXACT_INPUT: GuardBinding = {
  ref: 'guard.saga.approval-binds-exact-input',
  scope: 'call',
};

/**
 * No-default-provider guard: every guard, decision, publication and
 * observation provider is injected explicitly; no fallback may perform release
 * effects (invariant `delivery.no-default-provider`). Bound at the `call` scope.
 */
export const DELIVERY_GUARD_NO_DEFAULT_PROVIDER: GuardBinding = {
  ref: 'guard.saga.no-default-provider',
  scope: 'call',
};

/**
 * No-force-or-bypass guard: release adapters must not force push, bypass branch
 * protection, bypass registry immutability or bypass deployment policy
 * (invariant `delivery.no-force-or-bypass`). Bound at the `submit` scope so a
 * publication submission carrying a force/bypass directive is rejected before
 * it reaches the external substrate.
 */
export const DELIVERY_GUARD_NO_FORCE_OR_BYPASS: GuardBinding = {
  ref: 'guard.saga.no-force-or-bypass',
  scope: 'submit',
};

/**
 * Push-is-not-release guard: a successful command response alone never
 * establishes release; settlement requires matching authoritative observed
 * state (invariant `delivery.push-is-not-release`). Bound at the `call` scope
 * on settlement so a release decision cannot be admitted on a push response
 * alone.
 */
export const DELIVERY_GUARD_PUSH_IS_NOT_RELEASE: GuardBinding = {
  ref: 'guard.saga.push-is-not-release',
  scope: 'call',
};

/**
 * Candidate-is-immutable guard: any candidate hash change after Development
 * certification blocks Delivery and requires fresh Development verification
 * (invariant `delivery.candidate-is-immutable`). Bound at the `node` scope so
 * the guard spans every call within a node that re-reads the candidate.
 */
export const DELIVERY_GUARD_CANDIDATE_IMMUTABLE: GuardBinding = {
  ref: 'guard.saga.candidate-immutable',
  scope: 'node',
};

/**
 * Module-does-not-route guard: Delivery emits a local outcome and does not
 * decide lifecycle routing (invariant `delivery.module-does-not-route`). Bound
 * at the `submit` scope so a settlement submission carrying a routing directive
 * is rejected.
 */
export const DELIVERY_GUARD_MODULE_DOES_NOT_ROUTE: GuardBinding = {
  ref: 'guard.saga.module-does-not-route',
  scope: 'submit',
};

/**
 * Every package-level guard binding the Delivery package declares. The manifest
 * (W9-A5) spreads this into `ProcessModuleManifest.guards`. Individual tool
 * contributions (see `tool-contributions.ts`) reference these same guard refs
 * at finer-grained scopes; this array declares the package-wide defaults.
 */
export const DELIVERY_GUARD_BINDINGS: readonly GuardBinding[] = Object.freeze([
  DELIVERY_GUARD_AUTHORITY_FENCE,
  DELIVERY_GUARD_MANAGED_PRODUCTION,
  DELIVERY_GUARD_NODE_ALLOWED_TOOLS,
  DELIVERY_GUARD_EXPLICIT_OPERATOR_AUTHORIZATION,
  DELIVERY_GUARD_APPROVAL_BINDS_EXACT_INPUT,
  DELIVERY_GUARD_NO_DEFAULT_PROVIDER,
  DELIVERY_GUARD_NO_FORCE_OR_BYPASS,
  DELIVERY_GUARD_PUSH_IS_NOT_RELEASE,
  DELIVERY_GUARD_CANDIDATE_IMMUTABLE,
  DELIVERY_GUARD_MODULE_DOES_NOT_ROUTE,
]);
