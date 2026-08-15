/**
 * Delivery domain contracts — HumanInteractionRun + EffectAttempt/EffectReceipt
 * (Conveyor v4 step 3.D).
 *
 * Target contracts: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-22 (Вызов человека —
 * HumanInteractionRun) + REG-23 (Отгрузка / внешняя операция — EffectAttempt /
 * EffectReceipt) + Conveyor Mental Model v4 §«Checks versus effects».
 *
 * # Why these contracts exist
 *
 * Delivery proves the boundary between the production kernel (universal for LM
 * work) and the conveyor runtime (also supports non-LM control/effect nodes).
 * Two kinds of non-LM work live here:
 *
 *   1. HUMAN APPROVAL (REG-22) — a durable `HumanInteractionRun` that pauses
 *      the line in `blocked/paused` with a durable resume target. It is NOT a
 *      blocking call hidden inside a check — it is a first-class entity with
 *      its own lifecycle (requested → answered/expired/cancelled).
 *
 *   2. EXTERNAL EFFECTS (REG-23) — commit, merge, tag, push, publish, deploy.
 *      Each is a versioned, authorized, idempotent `EffectAttempt` that runs
 *      as a separate Flow control node AFTER a final accepted output binding.
 *      The effect binds an exact desired-state ProductRef/digest, an
 *      authorization digest, a deterministic idempotency key, and produces a
 *      durable `EffectReceipt`. Retry observes external state before repeating.
 *
 * # Checks vs effects (v4 §«Checks versus effects»)
 *
 * Schema validation, lint, build, tests in a disposable sandbox are CHECKS
 * (read-only, REG-16). Commit, merge, push, publish, deploy are EFFECTS
 * (separate control nodes, REG-23). The boundary is: checks never mutate
 * authoritative/external state; effects do, but only after final accepted
 * bindings + required durable authorization.
 *
 * # Pure domain
 *
 * These are pure data types + validators. Concrete EffectExecutorPort
 * implementations (git, CI, deploy providers) live in capability infrastructure.
 */

import type { ProductRef } from '../../../process-modules/domain/spi/index.js';

// ===========================================================================
// REG-22 — HumanInteractionRun
// ===========================================================================

/** The lifecycle of a human interaction request. */
export type HumanInteractionState = 'requested' | 'answered' | 'expired' | 'cancelled';

/**
 * A durable human-interaction request — the line stops in `blocked/paused`
 * with a durable resume target.
 *
 * REG-22. NOT a blocking call hidden inside a CheckProvider (REG-22-AC-04).
 * The request persists; the human answers asynchronously; the answer is a
 * durable decision with its own authority.
 */
export interface HumanInteractionRun {
  /** Stable request ref (idempotency key + subject refs). */
  readonly requestRef: string;
  /** What is being asked (free-form question for the human). */
  readonly question: string;
  /** The subject workplace/candidate/decision this request is about. */
  readonly subjectWorkplaceRef: string;
  readonly subjectCandidateSetRef: string | null;
  /** Authorization authority (who can answer). */
  readonly authority: string;
  readonly state: HumanInteractionState;
  /** The human's answer (null until answered). */
  readonly answer: string | null;
  readonly answeredBy: string | null;
  readonly answeredAt: string | null;
  /** Expiry deadline for the request. */
  readonly expiresAt: string;
  /** The resume target (which transition to apply after the answer). */
  readonly resumeTarget: 'author' | 'reviewer' | 'integration';
  readonly createdAt: string;
}

// ===========================================================================
// REG-23 — EffectAttempt / EffectReceipt
// ===========================================================================

/** The kind of external effect (REG-23 §«Граница»). */
export type EffectKind =
  | 'git-merge'
  | 'git-tag'
  | 'git-push'
  | 'publish'
  | 'deploy'
  | 'observe';

/** The lifecycle of one effect attempt. */
export type EffectAttemptState =
  | 'authorized'
  | 'observing'
  | 'executing'
  | 'observed-merged'
  | 'observed-conflict'
  | 'observed-base-advanced'
  | 'failed'
  | 'cancelled';

/**
 * A durable, authorized, idempotent external-effect attempt.
 *
 * REG-23. Runs as a separate Flow control node AFTER a final accepted output
 * binding. The effect binds:
 *   - an exact desired-state ProductRef/digest (what to apply);
 *   - an authorization digest (who authorized);
 *   - a deterministic idempotency key (so a retry is observed, not repeated);
 *
 * Each physical attempt appends a row; the external change is effective once.
 */
export interface EffectAttempt {
  /** Deterministic ref over (desired-state digest + authorization + idempotency). */
  readonly attemptRef: string;
  readonly effectKind: EffectKind;
  /** The exact desired-state product (TextSet, release record, etc.). */
  readonly desiredStateRef: ProductRef;
  /** Digest of the authorization that approved this effect. */
  readonly authorizationDigest: string;
  /** Deterministic idempotency key (same desired-state + auth → same key). */
  readonly idempotencyKey: string;
  /** The target environment/ref (e.g. 'refs/heads/dev', 'production'). */
  readonly targetRef: string;
  readonly state: EffectAttemptState;
  /** The resulting external state observation (null until observed). */
  readonly observedResult: string | null;
  /** The receipt for the effective external change (null until one is produced). */
  readonly receiptRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An immutable receipt for one external effect — proves one effective external
 * change happened (REG-23-AC-04: "crash/retry create append-only attempts,
 * but one effective external change").
 */
export interface EffectReceipt {
  readonly receiptRef: string;
  readonly attemptRef: string;
  readonly effectKind: EffectKind;
  /** The external system's identity for the change (e.g. merge commit SHA). */
  readonly externalChangeId: string;
  /** The desired-state that was applied. */
  readonly desiredStateRef: ProductRef;
  /** Whether this was a fresh change or an idempotent re-observation. */
  readonly effective: boolean;
  readonly observedAt: string;
  readonly receiptDigest: string;
}

// ===========================================================================
// EffectExecutorPort — the outbound port for authorized effects.
// ===========================================================================

/**
 * Result of observing external state before executing an effect.
 * REG-23-AC-03: "retry сначала наблюдает external state".
 */
export type EffectObservation =
  | { readonly kind: 'ready'; readonly observedTargetSha: string }
  | { readonly kind: 'already-applied'; readonly externalChangeId: string }
  | { readonly kind: 'base-advanced'; readonly observedTargetSha: string; readonly expectedTargetSha: string }
  | { readonly kind: 'conflict'; readonly detail: string };

/**
 * The outbound port for authorized external effects (REG-23).
 *
 * Implemented by versioned `EffectProvider` plugins (step 4): git-merge, CI,
 * deploy, etc. The port is the single surface through which the conveyor
 * executes irreversible effects. A worker NEVER gets direct deploy/publish
 * authority merely because it generated desired-state text (REG-23-AC-05).
 */
export interface EffectExecutorPort {
  /**
   * Observe external state before executing. REG-23-AC-03: observe first,
   * then act. Returns whether the effect is ready, already applied, or blocked.
   */
  observe(input: {
    readonly effectKind: EffectKind;
    readonly desiredStateRef: ProductRef;
    readonly targetRef: string;
  }): Promise<EffectObservation> | EffectObservation;

  /**
   * Execute the effect. The caller MUST have observed first and confirmed
   * `ready`. The executor uses the idempotency key so a crash-retry produces
   * one effective change, not a duplicate.
   */
  execute(input: {
    readonly effectKind: EffectKind;
    readonly desiredStateRef: ProductRef;
    readonly targetRef: string;
    readonly authorizationDigest: string;
    readonly idempotencyKey: string;
  }): Promise<EffectReceipt> | EffectReceipt;
}

// ===========================================================================
// Validators.
// ===========================================================================

/**
 * Validate a HumanInteractionRun (REG-22).
 */
export function assertValidHumanInteractionRun(run: HumanInteractionRun): void {
  requireNonEmpty(run.requestRef, 'requestRef');
  requireNonEmpty(run.question, 'question');
  requireNonEmpty(run.subjectWorkplaceRef, 'subjectWorkplaceRef');
  requireNonEmpty(run.authority, 'authority');
  requireNonEmpty(run.expiresAt, 'expiresAt');
  if (run.state === 'answered') {
    if (!run.answer || !run.answeredBy || !run.answeredAt) {
      throw new Error(
        'HumanInteractionRun: state=answered requires answer, answeredBy, answeredAt',
      );
    }
  }
}

/**
 * Validate an EffectAttempt (REG-23).
 */
export function assertValidEffectAttempt(attempt: EffectAttempt): void {
  requireNonEmpty(attempt.attemptRef, 'attemptRef');
  requireNonEmpty(attempt.authorizationDigest, 'authorizationDigest');
  requireNonEmpty(attempt.idempotencyKey, 'idempotencyKey');
  requireNonEmpty(attempt.targetRef, 'targetRef');
  if (!attempt.desiredStateRef || !attempt.desiredStateRef.schemaId) {
    throw new Error('EffectAttempt.desiredStateRef must be a valid ProductRef');
  }
}

/**
 * Validate an EffectReceipt (REG-23).
 */
export function assertValidEffectReceipt(receipt: EffectReceipt): void {
  requireNonEmpty(receipt.receiptRef, 'receiptRef');
  requireNonEmpty(receipt.attemptRef, 'attemptRef');
  requireNonEmpty(receipt.externalChangeId, 'externalChangeId');
  requireNonEmpty(receipt.observedAt, 'observedAt');
  if (!/^[a-f0-9]{64}$/i.test(receipt.receiptDigest)) {
    throw new Error('EffectReceipt.receiptDigest must be a 64-char hex SHA-256');
  }
}

// ===========================================================================
// Internals.
// ===========================================================================

function requireNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}
