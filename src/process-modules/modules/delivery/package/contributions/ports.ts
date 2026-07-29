/**
 * W9-A6 — Delivery package-local ports contribution subtree.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6 owns the ports contribution subtree), §0.11.7
 *       (module-local ports behind the package surface — mirrors W8-A6 /
 *       W9-A2 ports subtrees).
 *
 * ── What this file owns ───────────────────────────────────────────────────
 *
 * Delivery REQUIRES that every guard, decision, publication, observation and
 * settlement capability be INJECTED — no fallback may perform release effects
 * (invariant `delivery.no-default-provider`). The legacy delivery lane wires
 * these ports through `DeliveryModuleInstallationDependencies`
 * (`delivery-kernel-ports.ts`); this file is the package-local CONTRIBUTION
 * surface that declares those ports as stable, content-addressed references
 * the manifest carries:
 *
 *   1. `ModulePortContribution` — one declaration per port the package
 *      requires. Each declares the port's logical id, the capability ref it
 *      resolves to (mirrors `DELIVERY_CAP_*` in `acceptance-capabilities.ts`),
 *      the owning Flow node, and whether the port is required or optional.
 *
 *   2. `DELIVERY_PORT_CONTRIBUTIONS` — the complete set, one per injected port
 *      Delivery needs (preflight state, approval, publication, observation,
 *      settlement state, output repository, preflight policy, settlement
 *      policy).
 *
 * This file does NOT declare the port INTERFACES — those live in
 * `delivery-kernel-ports.ts` / `delivery-provider-ports.ts` (owned by the
 * legacy delivery lane). It declares the package-local CONTRIBUTION metadata
 * (the port identity + capability binding) the manifest carries, so the
 * composition root (Wave 11) can inject the concrete SQLite-backed adapters
 * by name without the runtime hardcoding the delivery port catalog.
 *
 * PURE DATA: readonly constants. No behavior, no port instances.
 *
 * ── Dependency-direction ──────────────────────────────────────────────────
 *
 * This file lives under `src/process-modules/modules/delivery/`, so it is a
 * MODULE file. It imports nothing outside its own declarations — no
 * persistence, infra, db, sibling-module, or even domain-SPI imports. This
 * keeps the dependency-direction ratchet green.
 */

// ---------------------------------------------------------------------------
// ModulePortContribution.
// ---------------------------------------------------------------------------

/**
 * One module-local port contribution. Declares the port's logical id, the
 * capability ref it resolves to, the owning Flow node, the contract ref of the
 * payload the port produces, and whether the port is required or optional.
 * Pure data — the composition root resolves `capabilityRef` to the concrete
 * port implementation.
 */
export interface ModulePortContribution {
  /** Port logical id (stable, module-namespaced). */
  readonly portId: string;
  /** Port semantic version. */
  readonly version: string;
  /** Capability ref this port resolves to (mirrors DELIVERY_CAP_*). */
  readonly capabilityRef: string;
  /** Owning Flow node id (mirrors DELIVERY_NODE_FLOW_IDS), or null for cross-node ports. */
  readonly owningFlowNodeId: string | null;
  /** Whether the port is required (no fallback) or optional. */
  readonly required: boolean;
  /** Invariant refs that enforce explicit injection (enforcement surface). */
  readonly invariantRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Per-port contributions — one per injected port Delivery needs.
// ---------------------------------------------------------------------------

/**
 * The preflight-state port contribution. The preflight kernel handler builds
 * the complete preflight snapshot (every required guard check, each backed by
 * a trusted deterministic-evidence provider) through this port. Required.
 */
export const DELIVERY_PREFLIGHT_STATE_PORT_CONTRIBUTION: ModulePortContribution =
  Object.freeze({
    portId: 'delivery.preflight-state',
    version: '1.0.0',
    capabilityRef: 'capability.saga.delivery-runtime-persistence',
    owningFlowNodeId: 'preflight-release',
    required: true,
    invariantRefs: Object.freeze(['delivery.no-default-provider']),
  });

/**
 * The approval port contribution. The human interaction adapter materializes
 * an authorized decision through this port. Required.
 */
export const DELIVERY_APPROVAL_PORT_CONTRIBUTION: ModulePortContribution =
  Object.freeze({
    portId: 'delivery.approval',
    version: '1.0.0',
    capabilityRef: 'capability.saga.delivery-runtime-persistence',
    owningFlowNodeId: 'approve-release',
    required: true,
    invariantRefs: Object.freeze([
      'delivery.explicit-operator-authorization',
      'delivery.approval-binds-exact-input',
      'delivery.no-default-provider',
    ]),
  });

/**
 * The publication port contribution. The external publish-deploy adapter
 * applies immutable desired-state actions through this port. Required.
 */
export const DELIVERY_PUBLICATION_PORT_CONTRIBUTION: ModulePortContribution =
  Object.freeze({
    portId: 'delivery.publication',
    version: '1.0.0',
    capabilityRef: 'capability.saga.delivery-runtime-persistence',
    owningFlowNodeId: 'publish-deploy',
    required: true,
    invariantRefs: Object.freeze([
      'delivery.no-default-provider',
      'delivery.no-force-or-bypass',
      'delivery.observe-before-retry',
    ]),
  });

/**
 * The observation port contribution. The external observe-release adapter
 * reads authoritative target state through this port. Required.
 */
export const DELIVERY_OBSERVATION_PORT_CONTRIBUTION: ModulePortContribution =
  Object.freeze({
    portId: 'delivery.observation',
    version: '1.0.0',
    capabilityRef: 'capability.saga.delivery-runtime-persistence',
    owningFlowNodeId: 'observe-release',
    required: true,
    invariantRefs: Object.freeze([
      'delivery.no-default-provider',
      'delivery.observe-before-retry',
    ]),
  });

/**
 * The settlement-state port contribution. The settlement handler reads the
 * exact settlement input (preflight + approval + publication + observation +
 * current candidate hash) through this port. Required.
 */
export const DELIVERY_SETTLEMENT_STATE_PORT_CONTRIBUTION: ModulePortContribution =
  Object.freeze({
    portId: 'delivery.settlement-state',
    version: '1.0.0',
    capabilityRef: 'capability.saga.delivery-runtime-persistence',
    owningFlowNodeId: 'settle-delivery',
    required: true,
    invariantRefs: Object.freeze(['delivery.push-is-not-release']),
  });

/**
 * The output-repository port contribution. The settlement handler persists the
 * canonical ReleaseRecord (on a `released` decision) and the output resolver
 * re-reads the exact row through this port. Required.
 */
export const DELIVERY_OUTPUT_REPOSITORY_PORT_CONTRIBUTION: ModulePortContribution =
  Object.freeze({
    portId: 'delivery.output-repository',
    version: '1.0.0',
    capabilityRef: 'capability.saga.delivery-output-repository',
    owningFlowNodeId: null,
    required: true,
    invariantRefs: Object.freeze(['delivery.push-is-not-release']),
  });

/**
 * The preflight-policy port contribution. The preflight kernel handler
 * evaluates the assembled preflight against the release policy through this
 * port. Required.
 */
export const DELIVERY_PREFLIGHT_POLICY_PORT_CONTRIBUTION: ModulePortContribution =
  Object.freeze({
    portId: 'delivery.preflight-policy',
    version: '1.0.0',
    capabilityRef: 'capability.saga.delivery-preflight-policy',
    owningFlowNodeId: 'preflight-release',
    required: true,
    invariantRefs: Object.freeze(['delivery.no-default-provider']),
  });

/**
 * The settlement-policy port contribution. The settlement handler evaluates
 * the canonical settlement input and issues the delivery certificate through
 * this port. Required.
 */
export const DELIVERY_SETTLEMENT_POLICY_PORT_CONTRIBUTION: ModulePortContribution =
  Object.freeze({
    portId: 'delivery.settlement-policy',
    version: '1.0.0',
    capabilityRef: 'capability.saga.delivery-settlement-policy',
    owningFlowNodeId: 'settle-delivery',
    required: true,
    invariantRefs: Object.freeze(['delivery.push-is-not-release']),
  });

// ---------------------------------------------------------------------------
// Aggregate — the complete port contribution set.
// ---------------------------------------------------------------------------

/**
 * Every module-local port contribution the Delivery package declares, one per
 * injected port. The manifest (W9-A5) carries this so the composition root can
 * inject the concrete adapters by name without hardcoding the delivery port
 * catalog. Order follows the flow's node order (preflight → approval →
 * publication → observation → settlement) with the cross-node output
 * repository last.
 */
export const DELIVERY_PORT_CONTRIBUTIONS: readonly ModulePortContribution[] =
  Object.freeze([
    DELIVERY_PREFLIGHT_STATE_PORT_CONTRIBUTION,
    DELIVERY_APPROVAL_PORT_CONTRIBUTION,
    DELIVERY_PUBLICATION_PORT_CONTRIBUTION,
    DELIVERY_OBSERVATION_PORT_CONTRIBUTION,
    DELIVERY_SETTLEMENT_STATE_PORT_CONTRIBUTION,
    DELIVERY_PREFLIGHT_POLICY_PORT_CONTRIBUTION,
    DELIVERY_SETTLEMENT_POLICY_PORT_CONTRIBUTION,
    DELIVERY_OUTPUT_REPOSITORY_PORT_CONTRIBUTION,
  ]);
