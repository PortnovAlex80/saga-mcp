/**
 * W9-A6 — Delivery package-local tool contributions.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6 owns Delivery external effects / human approval /
 *       idempotency / ports / receipts / contributions subtrees),
 *       §11.4 (ModuleToolContribution), §8.2 (NodeProtocol allowedTools).
 *
 * This file declares the MCP tool contributions the Delivery package makes to
 * the runtime, expressed as pure `ModuleToolContribution` data (Wave 1 SPI). A
 * contribution is a namespaced, versioned declaration that one named MCP tool
 * is owned by this package: its input/output contract refs, the handler that
 * implements it, the call/checklist/error-hint resource references the runtime
 * surfaces to the executing node, the guards bound to it, and its
 * idempotency/side-effect classification.
 *
 * Delivery differs from Discovery/Formalization in that it has NO LM
 * authoring nodes — its five Flow nodes are kernel / human / external. The
 * tools declared here are therefore the durable MCP calls the Delivery
 * adapters and kernel handlers surface to the runtime when a node emits its
 * products:
 *
 *   - `preflight_release`    — kernel assembles deterministic release-guard evidence
 *   - `approve_release`      — human materializes an authorized decision
 *   - `publish_deploy`       — external applies immutable desired-state actions
 *   - `observe_release`      — external reads authoritative target state
 *   - `settle_delivery`      — kernel validates exact products + immutability
 *   - `record_release`       — kernel persists the canonical ReleaseRecord
 *
 * Each is declared here so the Wave 6 tool-contribution installer can register
 * it without the runtime hardcoding the delivery tool catalog. The
 * declarations reference package-local resource paths (the instruction/checklist
 * /error-hint resources owned by this package, declared in W9-A5's manifest
 * `resourceIndex`) via `ResourceIndexEntry` logical ids — the manifest resolves
 * those to package-relative paths.
 *
 * Idempotency + side-effect classification follows the Delivery invariants:
 *   - `publish_deploy` is `'external'` side effect + `'idempotent'` (the
 *     deterministic cross-run action key makes a replayed action a no-op).
 *   - `observe_release` is `'read'` + `'idempotent'` (authoritative read).
 *   - `record_release` is `'write'` + `'idempotent'` (the output repository
 *     reuses the first run's record for the same candidate/policy).
 *
 * ── Dependency-direction ──────────────────────────────────────────────────
 *
 * This file lives under `src/process-modules/modules/delivery/`, so it is a
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
 * The namespace prefix every delivery tool contribution logical id carries.
 * Keeps contributed tool ids disjoint from other modules' contributions at the
 * registry level.
 */
export const DELIVERY_TOOL_NAMESPACE = 'delivery';

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
 * The Wave 1 SPI resource-index logical ids this package's instructions and
 * checklists are registered under. W9-A5's manifest `resourceIndex` maps these
 * to package-relative paths; this file references them by logical id so the
 * declaration stays path-stable even if the package is relocated. The ids
 * mirror `RESOURCE_IDS` in `delivery-node-protocols.ts` and the manifest
 * `DELIVERY_RESOURCE_INDEX` exactly.
 */
export const DELIVERY_TOOL_RESOURCE_IDS = {
  preflightInstructions: `${DELIVERY_TOOL_NAMESPACE}.instruction.preflight-release`,
  preflightChecklist: `${DELIVERY_TOOL_NAMESPACE}.checklist.preflight-release`,
  approvalInstructions: `${DELIVERY_TOOL_NAMESPACE}.instruction.approve-release`,
  publicationInstructions: `${DELIVERY_TOOL_NAMESPACE}.instruction.publish-deploy`,
  observationInstructions: `${DELIVERY_TOOL_NAMESPACE}.instruction.observe-release`,
  settlementInstructions: `${DELIVERY_TOOL_NAMESPACE}.instruction.settle-delivery`,
  errorHints: `${DELIVERY_TOOL_NAMESPACE}.hint.error-catalog`,
} as const;

// ---------------------------------------------------------------------------
// preflight_release — kernel assembles deterministic release-guard evidence.
// ---------------------------------------------------------------------------

/**
 * The `preflight_release` MCP tool. The preflight kernel handler assembles
 * complete trusted release-guard evidence for the exact certified candidate
 * (every required guard check, each backed by a trusted deterministic-evidence
 * provider) through this tool. Side effect `'write'` (it persists the
 * preflight snapshot); idempotency `'none'` — a second preflight for the same
 * run replaces the snapshot, but the run fence rejects a replayed execution.
 */
export const DELIVERY_PREFLIGHT_RELEASE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DELIVERY_TOOL_NAMESPACE}.preflight_release`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.delivery-release-case.v2', '2.0.0'),
  outputContractRef: contractRef('factory.delivery-preflight.v1', '1.0.0'),
  handlerRef: 'capability.saga.delivery-preflight',
  callTemplateRef: DELIVERY_TOOL_RESOURCE_IDS.preflightInstructions,
  checklistRef: DELIVERY_TOOL_RESOURCE_IDS.preflightChecklist,
  errorHintRef: DELIVERY_TOOL_RESOURCE_IDS.errorHints,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
    { ref: 'guard.saga.candidate-immutable', scope: 'call' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// approve_release — human materializes an authorized decision.
// ---------------------------------------------------------------------------

/**
 * The `approve_release` MCP tool. The human interaction adapter materializes an
 * authorized decision bound to the exact candidate, preflight result and
 * release policy through this tool. A pending decision pauses the run (it is
 * NOT converted into an approval). Side effect `'write'`; idempotency
 * `'none'` — the decision binds the candidate/preflight/policy hashes and
 * cannot float to a later revision (invariant
 * `delivery.approval-binds-exact-input`).
 */
export const DELIVERY_APPROVE_RELEASE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DELIVERY_TOOL_NAMESPACE}.approve_release`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.delivery-preflight.v1', '1.0.0'),
  outputContractRef: contractRef('factory.delivery-approval-decision.v1', '1.0.0'),
  handlerRef: 'capability.saga.delivery-approval',
  callTemplateRef: DELIVERY_TOOL_RESOURCE_IDS.approvalInstructions,
  errorHintRef: DELIVERY_TOOL_RESOURCE_IDS.errorHints,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.explicit-operator-authorization', scope: 'call' },
    { ref: 'guard.saga.approval-binds-exact-input', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// publish_deploy — external applies immutable desired-state actions.
// ---------------------------------------------------------------------------

/**
 * The `publish_deploy` MCP tool. The external publication adapter applies
 * every required release action (source-tag / source-release / package-publish
 * / deployment) through explicit providers using the deterministic cross-run
 * action key. Side effect `'external'` (it mutates externally-visible state);
 * idempotency `'idempotent'` — a replayed action observes the target before
 * acting and reuses the already-applied state (invariant
 * `delivery.observe-before-retry`), so a retry/recovery re-submission is a
 * no-op at the external substrate.
 */
export const DELIVERY_PUBLISH_DEPLOY_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DELIVERY_TOOL_NAMESPACE}.publish_deploy`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.delivery-approval-decision.v1', '1.0.0'),
  outputContractRef: contractRef('factory.delivery-publication.v1', '1.0.0'),
  handlerRef: 'capability.saga.delivery-publish-deploy',
  callTemplateRef: DELIVERY_TOOL_RESOURCE_IDS.publicationInstructions,
  errorHintRef: DELIVERY_TOOL_RESOURCE_IDS.errorHints,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.explicit-operator-authorization', scope: 'call' },
    { ref: 'guard.saga.no-default-provider', scope: 'call' },
    { ref: 'guard.saga.no-force-or-bypass', scope: 'submit' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'idempotent',
  sideEffect: 'external',
};

// ---------------------------------------------------------------------------
// observe_release — external reads authoritative target state.
// ---------------------------------------------------------------------------

/**
 * The `observe_release` MCP tool. The external observation adapter reads
 * authoritative target state for every published destination — including
 * destinations whose publication response was uncertain or failed. Side effect
 * `'read'` (pure authoritative read); idempotency `'idempotent'` (a pure read
 * is safe to retry).
 */
export const DELIVERY_OBSERVE_RELEASE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DELIVERY_TOOL_NAMESPACE}.observe_release`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.delivery-publication.v1', '1.0.0'),
  outputContractRef: contractRef('factory.delivery-observation.v1', '1.0.0'),
  handlerRef: 'capability.saga.delivery-observe-release',
  callTemplateRef: DELIVERY_TOOL_RESOURCE_IDS.observationInstructions,
  errorHintRef: DELIVERY_TOOL_RESOURCE_IDS.errorHints,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.no-default-provider', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'idempotent',
  sideEffect: 'read',
};

// ---------------------------------------------------------------------------
// settle_delivery — kernel validates exact products + immutability.
// ---------------------------------------------------------------------------

/**
 * The `settle_delivery` MCP tool. The settlement kernel handler validates
 * every content-addressed reference matches its durable production, the
 * candidate hash is immutable, and the observation authoritatively matches
 * every desired state. Side effect `'write'` (it issues the delivery
 * certificate); idempotency `'none'` — a second settle for the same execution
 * is rejected by the run fence.
 */
export const DELIVERY_SETTLE_DELIVERY_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DELIVERY_TOOL_NAMESPACE}.settle_delivery`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.delivery-observation.v1', '1.0.0'),
  outputContractRef: contractRef('factory.delivery-certificate.v2', '2.0.0'),
  handlerRef: 'capability.saga.delivery-settlement',
  callTemplateRef: DELIVERY_TOOL_RESOURCE_IDS.settlementInstructions,
  errorHintRef: DELIVERY_TOOL_RESOURCE_IDS.errorHints,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.candidate-immutable', scope: 'call' },
    { ref: 'guard.saga.push-is-not-release', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'none',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// record_release — kernel persists the canonical ReleaseRecord.
// ---------------------------------------------------------------------------

/**
 * The `record_release` MCP tool. On a `released` decision, the settlement
 * handler persists the canonical ReleaseRecord through the output repository.
 * Side effect `'write'`; idempotency `'idempotent'` — the output repository
 * reuses the first run's record for the same candidate + policy and returns
 * `replayed: true`, so a retry/recovery re-submission does not duplicate the
 * record. A `released` outcome without a matching authoritative observation is
 * rejected (invariant `delivery.push-is-not-release`).
 */
export const DELIVERY_RECORD_RELEASE_CONTRIBUTION: ModuleToolContribution = {
  logicalId: `${DELIVERY_TOOL_NAMESPACE}.record_release`,
  version: '1.0.0',
  inputContractRef: contractRef('factory.delivery-settlement-input.v1', '1.0.0'),
  outputContractRef: contractRef('factory.release-record.v1', '1.0.0'),
  handlerRef: 'capability.saga.delivery-output-repository',
  callTemplateRef: DELIVERY_TOOL_RESOURCE_IDS.settlementInstructions,
  errorHintRef: DELIVERY_TOOL_RESOURCE_IDS.errorHints,
  guardBindings: [
    { ref: 'guard.saga.authority.fence', scope: 'call' },
    { ref: 'guard.saga.managed-production.provenance', scope: 'call' },
    { ref: 'guard.saga.push-is-not-release', scope: 'call' },
    { ref: 'guard.saga.node-allowed-tools', scope: 'submit' },
  ],
  idempotency: 'idempotent',
  sideEffect: 'write',
};

// ---------------------------------------------------------------------------
// Aggregate — the complete tool-contribution set the manifest carries.
// ---------------------------------------------------------------------------

/**
 * Every MCP tool contribution the Delivery package declares. The manifest
 * (W9-A5) spreads this into `ProcessModuleManifest.toolContributions`. Order
 * is stable (flow order: preflight → approve → publish-deploy → observe →
 * settle → record) so the canonical-JSON digest of a manifest carrying this
 * set is reproducible.
 */
export const DELIVERY_TOOL_CONTRIBUTIONS: readonly ModuleToolContribution[] = Object.freeze([
  DELIVERY_PREFLIGHT_RELEASE_CONTRIBUTION,
  DELIVERY_APPROVE_RELEASE_CONTRIBUTION,
  DELIVERY_PUBLISH_DEPLOY_CONTRIBUTION,
  DELIVERY_OBSERVE_RELEASE_CONTRIBUTION,
  DELIVERY_SETTLE_DELIVERY_CONTRIBUTION,
  DELIVERY_RECORD_RELEASE_CONTRIBUTION,
]);
