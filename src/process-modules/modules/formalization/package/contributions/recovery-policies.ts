/**
 * W8-A7 — Formalization package-local recovery policies.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md.
 * Plan: §8.10 (RecoveryAction), RecoveryPolicyBinding.
 *
 * This file declares the recovery-policy bindings the Formalization package
 * pins for its verifier (resolver) nodes, as pure Wave 1 SPI
 * `RecoveryPolicyBinding` data.
 *
 * A `RecoveryPolicyBinding` maps a verifier node's id to an action map. The
 * action map's KEYS are the module's own recovery vocabulary (the
 * `domain.*` trigger events and reason codes the resolver emits); the VALUES
 * are members of the runtime-owned `RecoveryAction` union. The runtime's
 * recovery engine (Wave 4 `recovery-engine.ts`) reads these bindings to decide
 * what to do when a formalization verifier node emits a `RecoveryIssue`.
 *
 * The bindings here mirror the `recovery[]` array in
 * `formalization-process-module.ts` (the legacy FlowRecoveryDefinition entries)
 * but express them in the new SPI vocabulary: instead of
 * `{ verifyNodeId, repairNodeId, triggerEvents, maxAttempts, onExhausted }`,
 * each binding tells the runtime "for this verifier node, this trigger event
 * maps to this recovery action." The maxAttempts/onExhausted semantics live in
 * the flow's `recovery[]` declarations (owned by W8-A2..A5 node protocols);
 * this file owns the ACTION MAP the runtime consults.
 *
 * PURE DATA: readonly constants typed by the Wave 1 SPI. No behavior.
 */

import type {
  RecoveryAction,
  RecoveryPolicyBinding,
} from '../../../../domain/spi/recovery-definitions.js';

// ---------------------------------------------------------------------------
// Helper: build an action map keyed by formalization trigger events.
// ---------------------------------------------------------------------------

/**
 * The trigger-event vocabulary formalization verifier nodes emit. These are the
 * `domain.*` events the resolvers in `formalization-installation.ts` produce
 * when they detect a repairable gap, an acceptance block, or an unrecoverable
 * inconsistency. The runtime does not interpret these strings — it only looks
 * them up in the action map.
 */
export const FORMALIZATION_RECOVERY_TRIGGERS = {
  /** Resolver accepted the contract; recovery resolved. */
  completed: 'domain.completed',
  /** Reconciliation reached the reconciled state. */
  reconciled: 'domain.reconciled',
  /** Baseline frozen successfully. */
  frozen: 'domain.frozen',
  /** Repairable traceability/schema gap — route back to the producer. */
  repairRequired: 'domain.repair-required',
  /** Acceptance gate blocked the candidate — route back for rework. */
  acceptanceBlocked: 'domain.acceptance-blocked',
  /** Missing information — park for human clarification. */
  clarificationRequired: 'domain.clarification-required',
  /** Unresolved contract contradiction — terminal inconsistency. */
  inconsistent: 'domain.inconsistent',
  /** Architecture cannot satisfy the constraints — terminal infeasible. */
  infeasible: 'domain.infeasible',
  /** Baseline changed after freeze — terminal drift. */
  driftDetected: 'domain.drift-detected',
  /** Infrastructure could not produce an authoritative result. */
  failed: 'domain.failed',
} as const;

// ---------------------------------------------------------------------------
// Per-verifier-node recovery policy bindings.
// ---------------------------------------------------------------------------

/**
 * Product-contract resolver recovery. A `repair-required` or
 * `acceptance-blocked` event routes back to the `define-product-contract`
 * producer node (return-to-producer). `clarification-required` parks for a
 * human; `failed` terminates.
 */
export const FORMALIZATION_RECOVERY_PRODUCT: RecoveryPolicyBinding = {
  nodeId: 'resolve-product-contract',
  actionMap: {
    [FORMALIZATION_RECOVERY_TRIGGERS.repairRequired]: 'return-to-producer',
    [FORMALIZATION_RECOVERY_TRIGGERS.acceptanceBlocked]: 'return-to-producer',
    [FORMALIZATION_RECOVERY_TRIGGERS.clarificationRequired]: 'request-human',
    [FORMALIZATION_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Use-case resolver recovery. Same shape as the product resolver: repairable
 * gaps route back to `model-use-cases`; an unresolved inconsistency after
 * repair-budget exhaustion terminates the run as `inconsistent`.
 */
export const FORMALIZATION_RECOVERY_USE_CASES: RecoveryPolicyBinding = {
  nodeId: 'resolve-use-cases',
  actionMap: {
    [FORMALIZATION_RECOVERY_TRIGGERS.repairRequired]: 'return-to-producer',
    [FORMALIZATION_RECOVERY_TRIGGERS.acceptanceBlocked]: 'return-to-producer',
    [FORMALIZATION_RECOVERY_TRIGGERS.clarificationRequired]: 'request-human',
    [FORMALIZATION_RECOVERY_TRIGGERS.inconsistent]: 'terminate',
    [FORMALIZATION_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Acceptance resolver recovery. Repairable AC traceability gaps route back to
 * `define-acceptance-contract`; an unresolved inconsistency terminates as
 * `inconsistent`.
 */
export const FORMALIZATION_RECOVERY_ACCEPTANCE: RecoveryPolicyBinding = {
  nodeId: 'resolve-acceptance-contract',
  actionMap: {
    [FORMALIZATION_RECOVERY_TRIGGERS.repairRequired]: 'return-to-producer',
    [FORMALIZATION_RECOVERY_TRIGGERS.acceptanceBlocked]: 'return-to-producer',
    [FORMALIZATION_RECOVERY_TRIGGERS.clarificationRequired]: 'request-human',
    [FORMALIZATION_RECOVERY_TRIGGERS.inconsistent]: 'terminate',
    [FORMALIZATION_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Reconciliation resolver recovery. A repair-required event routes back to the
 * `reconcile-what` producer. Because reconciliation is the last WHAT-side
 * gate before baseline freeze, an unresolved inconsistency after
 * repair-budget exhaustion escalates (the integrator decides whether to
 * re-baseline or terminate) rather than silently looping.
 */
export const FORMALIZATION_RECOVERY_RECONCILIATION: RecoveryPolicyBinding = {
  nodeId: 'resolve-reconciliation',
  actionMap: {
    [FORMALIZATION_RECOVERY_TRIGGERS.repairRequired]: 'return-to-producer',
    [FORMALIZATION_RECOVERY_TRIGGERS.inconsistent]: 'escalate',
    [FORMALIZATION_RECOVERY_TRIGGERS.clarificationRequired]: 'request-human',
    [FORMALIZATION_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Baseline freezer recovery. This is a kernel-only node (no LM producer), so
 * its recovery surface is narrow: a `drift-detected` event means the AC set
 * changed between reconciliation and freeze — that is an unrecoverable
 * inconsistency (terminate), not a repairable gap. A `failed` event also
 * terminates.
 */
export const FORMALIZATION_RECOVERY_BASELINE_FREEZER: RecoveryPolicyBinding = {
  nodeId: 'freeze-acceptance-baseline',
  actionMap: {
    [FORMALIZATION_RECOVERY_TRIGGERS.driftDetected]: 'terminate',
    [FORMALIZATION_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Architecture resolver recovery. A `repair-required` or
 * `acceptance-blocked` event routes back to `define-architecture-contract`.
 * `infeasible` is terminal (the constraints cannot be met); `inconsistent`
 * and `clarification-required` escalate or park, matching the reconciler's
 * post-baseline severity.
 */
export const FORMALIZATION_RECOVERY_ARCHITECTURE: RecoveryPolicyBinding = {
  nodeId: 'resolve-architecture-contract',
  actionMap: {
    [FORMALIZATION_RECOVERY_TRIGGERS.repairRequired]: 'return-to-producer',
    [FORMALIZATION_RECOVERY_TRIGGERS.acceptanceBlocked]: 'return-to-producer',
    [FORMALIZATION_RECOVERY_TRIGGERS.clarificationRequired]: 'request-human',
    [FORMALIZATION_RECOVERY_TRIGGERS.inconsistent]: 'escalate',
    [FORMALIZATION_RECOVERY_TRIGGERS.infeasible]: 'terminate',
    [FORMALIZATION_RECOVERY_TRIGGERS.failed]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Settlement recovery. The settlement handler is the final kernel node; its
 * only recoverable path is a transient infrastructure failure (retry the
 * current node once). Every domain outcome it emits is terminal — the
 * settlement decision (formalized / clarification-required / inconsistent /
 * infeasible) ends the run.
 */
export const FORMALIZATION_RECOVERY_SETTLEMENT: RecoveryPolicyBinding = {
  nodeId: 'settle-formalization',
  actionMap: {
    [FORMALIZATION_RECOVERY_TRIGGERS.failed]: 'retry-current-node',
    [FORMALIZATION_RECOVERY_TRIGGERS.clarificationRequired]: 'terminate',
    [FORMALIZATION_RECOVERY_TRIGGERS.inconsistent]: 'terminate',
    [FORMALIZATION_RECOVERY_TRIGGERS.infeasible]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

// ---------------------------------------------------------------------------
// Aggregate — the complete recovery-policy binding set.
// ---------------------------------------------------------------------------

/**
 * Every recovery-policy binding the Formalization package declares, one per
 * verifier (resolver/kernel) node. The manifest (W8-A1) carries these so the
 * runtime's recovery engine can consult them without a module-name switch.
 *
 * Order follows the flow's resolver-node order (product → use-cases →
 * acceptance → reconciliation → baseline → architecture → settlement) so the
 * binding set reads in flow order.
 */
export const FORMALIZATION_RECOVERY_POLICY_BINDINGS: readonly RecoveryPolicyBinding[] = Object.freeze([
  FORMALIZATION_RECOVERY_PRODUCT,
  FORMALIZATION_RECOVERY_USE_CASES,
  FORMALIZATION_RECOVERY_ACCEPTANCE,
  FORMALIZATION_RECOVERY_RECONCILIATION,
  FORMALIZATION_RECOVERY_BASELINE_FREEZER,
  FORMALIZATION_RECOVERY_ARCHITECTURE,
  FORMALIZATION_RECOVERY_SETTLEMENT,
]);
