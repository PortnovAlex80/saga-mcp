/**
 * W9-A6 — Delivery package-local recovery policies.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6), §8.10 (RecoveryAction), RecoveryPolicyBinding.
 *
 * This file declares the recovery-policy bindings the Delivery package pins
 * for its verifier (kernel/external/human) nodes, as pure Wave 1 SPI
 * `RecoveryPolicyBinding` data.
 *
 * A `RecoveryPolicyBinding` maps a verifier node's id to an action map. The
 * action map's KEYS are the module's own recovery vocabulary (the
 * `domain.*` / `runtime.*` trigger events the nodes emit); the VALUES are
 * members of the runtime-owned `RecoveryAction` union. The runtime's recovery
 * engine reads these bindings to decide what to do when a delivery verifier
 * node emits a `RecoveryIssue`.
 *
 * The bindings here mirror the transition events in
 * `delivery-process-module.ts` but express them in the new SPI vocabulary:
 * instead of `{ from, to, on }` edges, each binding tells the runtime "for
 * this verifier node, this trigger event maps to this recovery action." The
 * transition graph owns the happy-path routing; this file owns the ACTION MAP
 * the runtime consults when a node emits a repairable or terminal issue.
 *
 * Delivery's recovery surface is narrower than Discovery/Formalization's: its
 * nodes are deterministic kernel / external / human adapters, not LM producers
 * that re-author on feedback. So repairable issues route back to the producing
 * adapter for a re-read (observe-before-retry), and terminal issues settle
 * fail-closed. The key idempotency-driven recovery path is `pause-external`:
 * when a publication or observation provider returns uncertain, the run pauses
 * so the deterministic action key can be observed before any external action
 * is repeated (invariant `delivery.observe-before-retry`).
 *
 * PURE DATA: readonly constants typed by the Wave 1 SPI. No behavior.
 */

import type {
  RecoveryAction,
  RecoveryPolicyBinding,
} from '../../../../domain/spi/recovery-definitions.js';

// ---------------------------------------------------------------------------
// Helper: build an action map keyed by delivery trigger events.
// ---------------------------------------------------------------------------

/**
 * The trigger-event vocabulary delivery verifier nodes emit. These are the
 * `domain.*` / `runtime.*` events the kernel/external/human nodes in
 * `delivery-process-module.ts` / `delivery-installation.ts` produce. The
 * runtime does not interpret these strings — it only looks them up in the
 * action map.
 */
export const DELIVERY_RECOVERY_TRIGGERS = {
  /** Preflight ready — route to approval. */
  ready: 'domain.ready',
  /** Preflight blocked — route to settlement fail-closed. */
  blocked: 'domain.blocked',
  /** Approval granted. */
  approved: 'domain.approved',
  /** Approval not required — proceed to publication. */
  notRequired: 'domain.not-required',
  /** Approval pending — park for a human decision. */
  approvalRequired: 'domain.approval-required',
  /** Approval denied — settle without release effects. */
  denied: 'domain.denied',
  /** Publication/observation completed. */
  runtimeCompleted: 'runtime.completed',
  /** Publication/observation uncertain — observe before retry. */
  actionUncertain: 'domain.action-uncertain',
  /** Missing required preflight check — route back to preflight assembly. */
  preflightCheckMissing: 'domain.preflight-check-missing',
  /** Missing action receipt — route back to publication. */
  receiptMissing: 'domain.receipt-missing',
  /** Observation mismatched the desired state — route back to observation. */
  observationMismatched: 'domain.observation-mismatched',
  /** Candidate drifted after certification — terminal. */
  candidateDrifted: 'domain.candidate-drifted',
  /** Required provider unavailable — settle fail-closed. */
  providerUnavailable: 'domain.provider-unavailable',
  /** Missing operator authorization — settle fail-closed. */
  authorizationMissing: 'domain.authorization-missing',
  /** Settlement decision outcomes (terminal). */
  released: 'domain.released',
  failed: 'domain.failed',
} as const;

// ---------------------------------------------------------------------------
// Per-verifier-node recovery policy bindings.
// ---------------------------------------------------------------------------

/**
 * Preflight kernel recovery. A `preflight-check-missing` event routes back to
 * the preflight assembly step (return-to-producer) so the missing guard check
 * is re-evaluated; a `provider-unavailable` event settles fail-closed (no
 * fallback provider may perform release effects — invariant
 * `delivery.no-default-provider`); a `candidate-drifted` event terminates (the
 * candidate changed after certification and requires fresh Development
 * verification — invariant `delivery.candidate-is-immutable`).
 */
export const DELIVERY_RECOVERY_PREFLIGHT: RecoveryPolicyBinding = {
  nodeId: 'preflight-release',
  actionMap: {
    [DELIVERY_RECOVERY_TRIGGERS.ready]: 'return-to-producer',
    [DELIVERY_RECOVERY_TRIGGERS.preflightCheckMissing]: 'return-to-producer',
    [DELIVERY_RECOVERY_TRIGGERS.providerUnavailable]: 'escalate',
    [DELIVERY_RECOVERY_TRIGGERS.candidateDrifted]: 'terminate',
    [DELIVERY_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Approval (human) recovery. An `approval-required` event parks the run for a
 * human decision (request-human); a `denied` event settles fail-closed; a
 * `failed` event terminates. A `pending` decision never converts to an
 * approval — the run stays paused until the authorized-decision provider
 * resolves.
 */
export const DELIVERY_RECOVERY_APPROVAL: RecoveryPolicyBinding = {
  nodeId: 'approve-release',
  actionMap: {
    [DELIVERY_RECOVERY_TRIGGERS.approved]: 'return-to-producer',
    [DELIVERY_RECOVERY_TRIGGERS.notRequired]: 'return-to-producer',
    [DELIVERY_RECOVERY_TRIGGERS.approvalRequired]: 'request-human',
    [DELIVERY_RECOVERY_TRIGGERS.denied]: 'terminate',
    [DELIVERY_RECOVERY_TRIGGERS.authorizationMissing]: 'escalate',
    [DELIVERY_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Publication (external) recovery. A `receipt-missing` event routes back to the
 * publication adapter (return-to-producer) so the missing receipt is
 * re-collected; an `action-uncertain` event PAUSES the external side
 * (pause-external) so the deterministic action key can be observed before any
 * external action is repeated (invariant `delivery.observe-before-retry`). A
 * `provider-unavailable` event escalates; a `failed` event routes to
 * observation (even a failed publish is observed — the Flow transitions on
 * both `runtime.completed` and `runtime.failed`).
 */
export const DELIVERY_RECOVERY_PUBLICATION: RecoveryPolicyBinding = {
  nodeId: 'publish-deploy',
  actionMap: {
    [DELIVERY_RECOVERY_TRIGGERS.runtimeCompleted]: 'return-to-producer',
    [DELIVERY_RECOVERY_TRIGGERS.receiptMissing]: 'return-to-producer',
    [DELIVERY_RECOVERY_TRIGGERS.actionUncertain]: 'pause-external',
    [DELIVERY_RECOVERY_TRIGGERS.providerUnavailable]: 'escalate',
    [DELIVERY_RECOVERY_TRIGGERS.failed]: 'return-to-producer',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Observation (external) recovery. An `observation-mismatched` event routes
 * back to the observation adapter (return-to-producer) for a re-read of the
 * authoritative target state; an `action-uncertain` event pauses the external
 * side so the deterministic action key is observed before re-acting. A
 * `failed` event escalates (the observation is the input to settlement; a
 * persistent failure must not silently settle as released).
 */
export const DELIVERY_RECOVERY_OBSERVATION: RecoveryPolicyBinding = {
  nodeId: 'observe-release',
  actionMap: {
    [DELIVERY_RECOVERY_TRIGGERS.runtimeCompleted]: 'return-to-producer',
    [DELIVERY_RECOVERY_TRIGGERS.observationMismatched]: 'return-to-producer',
    [DELIVERY_RECOVERY_TRIGGERS.actionUncertain]: 'pause-external',
    [DELIVERY_RECOVERY_TRIGGERS.providerUnavailable]: 'escalate',
    [DELIVERY_RECOVERY_TRIGGERS.failed]: 'escalate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Settlement kernel recovery. The settlement handler is the final kernel node;
 * its only recoverable path is a transient infrastructure failure (retry the
 * current node once). Every domain outcome it emits is terminal — the
 * settlement decision (released / approval-required / blocked / failed) ends
 * the run. A `candidate-drifted` event terminates (the candidate changed
 * between observation and settlement).
 */
export const DELIVERY_RECOVERY_SETTLEMENT: RecoveryPolicyBinding = {
  nodeId: 'settle-delivery',
  actionMap: {
    [DELIVERY_RECOVERY_TRIGGERS.failed]: 'retry-current-node',
    [DELIVERY_RECOVERY_TRIGGERS.released]: 'terminate',
    [DELIVERY_RECOVERY_TRIGGERS.approvalRequired]: 'terminate',
    [DELIVERY_RECOVERY_TRIGGERS.blocked]: 'terminate',
    [DELIVERY_RECOVERY_TRIGGERS.candidateDrifted]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

// ---------------------------------------------------------------------------
// Aggregate — the complete recovery-policy binding set.
// ---------------------------------------------------------------------------

/**
 * Every recovery-policy binding the Delivery package declares, one per
 * verifier (kernel/external/human) node. The manifest (W9-A5) carries these so
 * the runtime's recovery engine can consult them without a module-name switch.
 *
 * Order follows the flow's node order (preflight → approval → publication →
 * observation → settlement) so the binding set reads in flow order.
 */
export const DELIVERY_RECOVERY_POLICY_BINDINGS: readonly RecoveryPolicyBinding[] = Object.freeze([
  DELIVERY_RECOVERY_PREFLIGHT,
  DELIVERY_RECOVERY_APPROVAL,
  DELIVERY_RECOVERY_PUBLICATION,
  DELIVERY_RECOVERY_OBSERVATION,
  DELIVERY_RECOVERY_SETTLEMENT,
]);
