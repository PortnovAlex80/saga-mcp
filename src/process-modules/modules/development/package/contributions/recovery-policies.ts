/**
 * W9-A4 — Development package-local recovery policies.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.6 (W9-A4), §8.10 (RecoveryAction), RecoveryPolicyBinding.
 *
 * This file declares the recovery-policy bindings the Development package pins
 * for its verifier (resolver/kernel/external) nodes, as pure Wave 1 SPI
 * `RecoveryPolicyBinding` data.
 *
 * A `RecoveryPolicyBinding` maps a verifier node's id to an action map. The
 * action map's KEYS are the module's own recovery vocabulary (the `domain.*`
 * trigger events the resolver/adapter/settlement emit); the VALUES are members
 * of the runtime-owned `RecoveryAction` union. The runtime's recovery engine
 * reads these bindings to decide what to do when a development node emits a
 * `RecoveryIssue`.
 *
 * The bindings here mirror the transition events + the `recovery[]` array in
 * `development-process-module.ts` but express them in the new SPI vocabulary.
 * The flow's `recovery[]` declarations (owned by W9-A3 node protocols) own the
 * maxAttempts/onExhausted semantics; this file owns the ACTION MAP the runtime
 * consults when a node emits a repairable or terminal issue.
 *
 * Development's recovery surface is deliberately narrow: only the task-graph
 * resolver has a declared repair loop (back to the planner, maxAttempts 2). The
 * external adapters and settlement emit terminal outcomes (the candidate is
 * immutable after freeze, so post-freeze failures are not repairable within the
 * run).
 *
 * PURE DATA: readonly constants typed by the Wave 1 SPI. No behavior.
 */

import type {
  RecoveryAction,
  RecoveryPolicyBinding,
} from '../../../../domain/spi/recovery-definitions.js';

// ---------------------------------------------------------------------------
// Helper: the development trigger-event vocabulary.
// ---------------------------------------------------------------------------

/**
 * The trigger-event vocabulary development verifier nodes emit. These are the
 * `domain.*` events the resolver in `development-installation.ts` and the
 * external adapters produce when they detect a repairable gap, a rework
 * requirement, or an unrecoverable failure. The runtime does not interpret
 * these strings — it only looks them up in the action map.
 */
export const DEVELOPMENT_RECOVERY_TRIGGERS = {
  /** Resolver materialized the canonical graph; recovery resolved. */
  valid: 'domain.valid',
  /** Repairable lineage/coverage/DAG gap — route back to the planner. */
  repairRequired: 'domain.repair-required',
  /** Accepted decomposition cannot yield a deterministic graph — terminal. */
  clarificationRequired: 'domain.clarification-required',
  /** External workset completed successfully. */
  runtimeCompleted: 'runtime.completed',
  /** External workset failed — settle the run. */
  runtimeFailed: 'runtime.failed',
  /** Implementation/review found a product defect — terminal rework cycle. */
  reworkRequired: 'domain.rework-required',
  /** Required work/evidence/decision unavailable — terminal blocked. */
  blocked: 'domain.blocked',
  /** Candidate drifted after freeze — terminal (evidence invalidated). */
  candidateDrifted: 'domain.candidate-drifted',
  /** Verification outcome was unknown/error — denial, not authorization. */
  verificationDenied: 'domain.verification-denied',
  /** Infrastructure could not produce an authoritative result. */
  failed: 'domain.failed',
} as const;

// ---------------------------------------------------------------------------
// Per-verifier-node recovery policy bindings.
// ---------------------------------------------------------------------------

/**
 * Task-graph resolver recovery. A `repair-required` event routes back to the
 * `plan-task-graph` producer node (return-to-producer) — this is the only
 * declared repair loop in the development flow (maxAttempts 2, onExhausted
 * pause, per `development-process-module.ts`). A `clarification-required` or
 * `failed` event routes to settlement which then emits the matching terminal
 * outcome.
 */
export const DEVELOPMENT_RECOVERY_RESOLVE_TASK_GRAPH: RecoveryPolicyBinding = {
  nodeId: 'resolve-task-graph',
  actionMap: {
    [DEVELOPMENT_RECOVERY_TRIGGERS.repairRequired]: 'return-to-producer',
    [DEVELOPMENT_RECOVERY_TRIGGERS.clarificationRequired]: 'escalate',
    [DEVELOPMENT_RECOVERY_TRIGGERS.failed]: 'escalate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Implementation workset recovery. The implementation adapter is an external
 * node; its only recoverable path is a transient infrastructure failure (retry
 * the current node once). A `runtime.failed` event routes to settlement; a
 * `rework-required` or `blocked` event is terminal (settlement emits the
 * matching outcome).
 */
export const DEVELOPMENT_RECOVERY_EXECUTE_IMPLEMENTATION: RecoveryPolicyBinding = {
  nodeId: 'execute-implementation-workset',
  actionMap: {
    [DEVELOPMENT_RECOVERY_TRIGGERS.runtimeFailed]: 'retry-current-node',
    [DEVELOPMENT_RECOVERY_TRIGGERS.reworkRequired]: 'escalate',
    [DEVELOPMENT_RECOVERY_TRIGGERS.blocked]: 'escalate',
    [DEVELOPMENT_RECOVERY_TRIGGERS.failed]: 'escalate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Candidate integration + freeze recovery. Once integration starts the
 * candidate is about to be frozen; a `runtime.failed` event retries the freeze
 * once, but a `candidate-drifted` event is terminal (the repository moved under
 * the freeze — unrecoverable within the run, invariant
 * `development.no-post-verification-mutation`).
 */
export const DEVELOPMENT_RECOVERY_INTEGRATE_CANDIDATE: RecoveryPolicyBinding = {
  nodeId: 'integrate-release-candidate',
  actionMap: {
    [DEVELOPMENT_RECOVERY_TRIGGERS.runtimeFailed]: 'retry-current-node',
    [DEVELOPMENT_RECOVERY_TRIGGERS.candidateDrifted]: 'terminate',
    [DEVELOPMENT_RECOVERY_TRIGGERS.failed]: 'escalate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Acceptance verification recovery. The verifier binds evidence to the exact
 * frozen candidate; a `verification-denied` (unknown/error) event is a denial,
 * not a failure — it routes to settlement which decides `rework-required` or
 * `blocked`. A `candidate-drifted` event terminates (all prior evidence is
 * invalidated).
 */
export const DEVELOPMENT_RECOVERY_VERIFY_ACCEPTANCE: RecoveryPolicyBinding = {
  nodeId: 'verify-acceptance-workset',
  actionMap: {
    [DEVELOPMENT_RECOVERY_TRIGGERS.verificationDenied]: 'escalate',
    [DEVELOPMENT_RECOVERY_TRIGGERS.candidateDrifted]: 'terminate',
    [DEVELOPMENT_RECOVERY_TRIGGERS.runtimeFailed]: 'retry-current-node',
    [DEVELOPMENT_RECOVERY_TRIGGERS.failed]: 'escalate',
  } as Readonly<Record<string, RecoveryAction>>,
};

/**
 * Settlement recovery. The settlement handler is the final kernel node; its
 * only recoverable path is a transient infrastructure failure (retry the
 * current node once). Every domain outcome it emits is terminal — the
 * settlement decision (verified / rework-required / clarification-required /
 * blocked / failed) ends the run.
 */
export const DEVELOPMENT_RECOVERY_SETTLEMENT: RecoveryPolicyBinding = {
  nodeId: 'settle-development',
  actionMap: {
    [DEVELOPMENT_RECOVERY_TRIGGERS.failed]: 'retry-current-node',
    [DEVELOPMENT_RECOVERY_TRIGGERS.reworkRequired]: 'terminate',
    [DEVELOPMENT_RECOVERY_TRIGGERS.clarificationRequired]: 'terminate',
    [DEVELOPMENT_RECOVERY_TRIGGERS.blocked]: 'terminate',
  } as Readonly<Record<string, RecoveryAction>>,
};

// ---------------------------------------------------------------------------
// Aggregate — the complete recovery-policy binding set.
// ---------------------------------------------------------------------------

/**
 * Every recovery-policy binding the Development package declares, one per
 * verifier (resolver/external/settlement) node. The manifest carries these so
 * the runtime's recovery engine can consult them without a module-name switch.
 *
 * Order follows the flow's verifier-node order (resolve → implement → integrate
 * → verify → settlement) so the binding set reads in flow order.
 */
export const DEVELOPMENT_RECOVERY_POLICY_BINDINGS: readonly RecoveryPolicyBinding[] = Object.freeze([
  DEVELOPMENT_RECOVERY_RESOLVE_TASK_GRAPH,
  DEVELOPMENT_RECOVERY_EXECUTE_IMPLEMENTATION,
  DEVELOPMENT_RECOVERY_INTEGRATE_CANDIDATE,
  DEVELOPMENT_RECOVERY_VERIFY_ACCEPTANCE,
  DEVELOPMENT_RECOVERY_SETTLEMENT,
]);
