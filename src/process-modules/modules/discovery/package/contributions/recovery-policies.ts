/**
 * W9-A2 — Discovery package-local recovery policies.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.4 (W9-A2), §8.10 (RecoveryAction), RecoveryPolicyBinding.
 *
 * This file declares the recovery-policy bindings the Discovery package pins
 * for its verifier (resolver/kernel) nodes, as pure Wave 1 SPI
 * `RecoveryPolicyBinding` data.
 *
 * A `RecoveryPolicyBinding` maps a verifier node's id to an action map. The
 * action map's KEYS are the module's own recovery vocabulary (the
 * `domain.*` trigger events the resolver emits); the VALUES are members of the
 * runtime-owned `RecoveryAction` union. The runtime's recovery engine reads
 * these bindings to decide what to do when a discovery verifier node emits a
 * `RecoveryIssue`.
 *
 * The bindings here mirror the transition events in
 * `discovery-process-module.ts` but express them in the new SPI vocabulary:
 * instead of `{ from, to, on }` edges, each binding tells the runtime "for
 * this verifier node, this trigger event maps to this recovery action." The
 * transition graph owns the happy-path routing; this file owns the ACTION MAP
 * the runtime consults when a node emits a repairable or terminal issue.
 *
 * PURE DATA: readonly constants typed by the Wave 1 SPI. No behavior.
 */

import type {
  RecoveryAction,
  RecoveryPolicyBinding,
} from '../../../../domain/spi/recovery-definitions.js';

// ---------------------------------------------------------------------------
// Helper: build an action map keyed by discovery trigger events.
// ---------------------------------------------------------------------------

/**
 * The trigger-event vocabulary discovery verifier nodes emit. These are the
 * `domain.*` events the resolvers in `discovery-installation.ts` produce when
 * they detect a repairable gap, a normalization requirement, or an
 * unrecoverable failure. The runtime does not interpret these strings — it
 * only looks them up in the action map.
 */
export const DISCOVERY_RECOVERY_TRIGGERS = {
  /** Resolver accepted the product; recovery resolved. */
  accepted: 'domain.accepted',
  /** Normalization required — route to the normalizer LM node. */
  normalizationRequired: 'domain.normalization-required',
  /** Raw submission had invalid JSON — terminal syntax failure. */
  invalidJson: 'domain.invalid-json',
  /** Readiness assessment is missing — settle fail-closed. */
  missing: 'domain.missing',
  /** Readiness assessment was paused — park for external resolution. */
  paused: 'domain.paused',
  /** Preparation succeeded — proceed to the downstream LM node. */
  prepared: 'domain.prepared',
  /** Repairable semantic gap — route back to the producer. */
  repairRequired: 'domain.repair-required',
  /** Missing information — park for human clarification. */
  clarificationRequired: 'domain.clarification-required',
  /** Settlement decision outcomes (terminal). */
  go: 'domain.go',
  clarify: 'domain.clarify',
  reject: 'domain.reject',
  defer: 'domain.defer',
  inconclusive: 'domain.inconclusive',
  /** Infrastructure could not produce an authoritative result. */
  failed: 'domain.failed',
} as const;

// ---------------------------------------------------------------------------
// Per-verifier-node recovery policy bindings.
// ---------------------------------------------------------------------------

/**
 * Proposal-submission resolver recovery. A `normalization-required` event
 * routes to the normalizer LM node (`enter-recovery-node`); an `invalid-json`
 * or `failed` event terminates (the raw submission is unrecoverable). The
 * happy-path `accepted` event is also mapped so the runtime can confirm
 * recovery resolved.
 */
export const DISCOVERY_RECOVERY_PROPOSAL_SUBMISSION: RecoveryPolicyBinding = {
  nodeId: 'resolve-proposal-submission',
  actionMap: {
    [DISCOVERY_RECOVERY_TRIGGERS.accepted]: 'return-to-producer',
    [DISCOVERY_RECOVERY_TRIGGERS.normalizationRequired]: 'enter-recovery-node',
    [DISCOVERY_RECOVERY_TRIGGERS.invalidJson]: 'terminate',
    [DISCOVERY_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Normalized-proposal resolver recovery. A `repair-required` event routes back
 * to the `normalize-semantic` producer node (return-to-producer); a `failed`
 * event terminates (the canonical proposal is missing and cannot be
 * reconstructed).
 */
export const DISCOVERY_RECOVERY_NORMALIZED_PROPOSAL: RecoveryPolicyBinding = {
  nodeId: 'resolve-normalized-proposal',
  actionMap: {
    [DISCOVERY_RECOVERY_TRIGGERS.repairRequired]: 'return-to-producer',
    [DISCOVERY_RECOVERY_TRIGGERS.accepted]: 'return-to-producer',
    [DISCOVERY_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Readiness resolver recovery. A `repair-required` event routes back to the
 * `assess-readiness` advisor; a `missing` event settles fail-closed (the
 * assessment never arrived, so settlement decides `clarify`); a `paused` event
 * pauses the external assessment process.
 */
export const DISCOVERY_RECOVERY_READINESS: RecoveryPolicyBinding = {
  nodeId: 'resolve-readiness',
  actionMap: {
    [DISCOVERY_RECOVERY_TRIGGERS.repairRequired]: 'return-to-producer',
    [DISCOVERY_RECOVERY_TRIGGERS.accepted]: 'return-to-producer',
    [DISCOVERY_RECOVERY_TRIGGERS.missing]: 'escalate',
    [DISCOVERY_RECOVERY_TRIGGERS.paused]: 'pause-external',
    [DISCOVERY_RECOVERY_TRIGGERS.failed]: 'escalate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Settlement recovery. The settlement handler is the final kernel node; its
 * only recoverable path is a transient infrastructure failure (retry the
 * current node once). Every domain outcome it emits is terminal — the
 * settlement decision (go/clarify/reject/defer/inconclusive/failed) ends the
 * run.
 */
export const DISCOVERY_RECOVERY_SETTLEMENT: RecoveryPolicyBinding = {
  nodeId: 'settle',
  actionMap: {
    [DISCOVERY_RECOVERY_TRIGGERS.failed]: 'retry-current-node',
    [DISCOVERY_RECOVERY_TRIGGERS.go]: 'terminate',
    [DISCOVERY_RECOVERY_TRIGGERS.clarify]: 'terminate',
    [DISCOVERY_RECOVERY_TRIGGERS.reject]: 'terminate',
    [DISCOVERY_RECOVERY_TRIGGERS.defer]: 'terminate',
    [DISCOVERY_RECOVERY_TRIGGERS.inconclusive]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Diagnosis advisor recovery. The diagnosis advisor runs as a post-completion
 * observer; its issues NEVER influence the outcome (invariant
 * `discovery.diagnosis-advisory`). A `repair-required` event routes back to
 * the diagnosis advisor for a second attempt; a `clarification-required` event
 * parks for a human; a `failed` event terminates the advisory enrichment
 * without touching the already-issued certificate.
 */
export const DISCOVERY_RECOVERY_DIAGNOSIS: RecoveryPolicyBinding = {
  nodeId: 'diagnosis-advisor',
  actionMap: {
    [DISCOVERY_RECOVERY_TRIGGERS.repairRequired]: 'return-to-producer',
    [DISCOVERY_RECOVERY_TRIGGERS.clarificationRequired]: 'request-human',
    [DISCOVERY_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

// ---------------------------------------------------------------------------
// Aggregate — the complete recovery-policy binding set.
// ---------------------------------------------------------------------------

/**
 * Every recovery-policy binding the Discovery package declares, one per
 * verifier (resolver/kernel) node plus the diagnosis observer. The manifest
 * (W9-A1) carries these so the runtime's recovery engine can consult them
 * without a module-name switch.
 *
 * Order follows the flow's resolver-node order (proposal → normalization →
 * readiness → settlement) with the diagnosis observer last, so the binding
 * set reads in flow order.
 */
export const DISCOVERY_RECOVERY_POLICY_BINDINGS: readonly RecoveryPolicyBinding[] = Object.freeze([
  DISCOVERY_RECOVERY_PROPOSAL_SUBMISSION,
  DISCOVERY_RECOVERY_NORMALIZED_PROPOSAL,
  DISCOVERY_RECOVERY_READINESS,
  DISCOVERY_RECOVERY_SETTLEMENT,
  DISCOVERY_RECOVERY_DIAGNOSIS,
]);
