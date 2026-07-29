/**
 * W9-A6 — Delivery package-local idempotency contribution subtree.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6 owns the idempotency contribution subtree),
 *       §11.4 (ModuleToolContribution idempotency/sideEffect),
 *       §0.12.6 (Delivery invariants observe-before-retry / push-is-not-release).
 *
 * ── What this file owns ───────────────────────────────────────────────────
 *
 * External publication cannot be made transactionally atomic across Git,
 * registries and deployment systems. The Delivery module therefore makes
 * every externally-visible action IDEMPOTENT under a deterministic, cross-run
 * action key, and requires observation of the target before any action is
 * repeated. This file is the package-local CONTRIBUTION surface for that
 * idempotency strategy:
 *
 *   1. `IdempotencyStrategyContribution` — the declaration of the module's
 *      idempotency strategy: how action keys are derived, what they exclude
 *      (ProcessRun id — deliberately, so a second run for the same immutable
 *      candidate/action reuses the first run's applied state), and which
 *      invariants enforce it.
 *
 *   2. `DELIVERY_IDEMPOTENT_TOOL_IDS` — the closed set of tool logical ids
 *      that carry `idempotency: 'idempotent'` (mirrors the tool contributions
 *      in `tool-contributions.ts`). Exposed so the runtime / tests can confirm
 *      the idempotency classification is consistent across the manifest and
 *      the tool catalog.
 *
 *   3. `DELIVERY_ACTION_KEY_IDENTITY_FIELDS` — the exact field set the
 *      `deliveryActionKey` hash folds in, documented as data. Mirrors
 *      `deliveryActionKey` in `delivery-settlement-policy.ts`. A consumer can
 *      assert the strategy contribution matches the implementation without
 *      importing the implementation module into the domain SPI.
 *
 * The deterministic action key (`delivery:<kind>:<identityHash>`) deliberately
 * EXCLUDES the ProcessRun id: a second run for the same immutable
 * candidate/action must observe and reuse the first run's already-applied
 * state (invariant `delivery.observe-before-retry`, enforced at runtime).
 * Retries use the action key and observe the target before acting. A
 * successful command response alone never establishes release (invariant
 * `delivery.push-is-not-release`, enforced by policy) — settlement requires
 * matching authoritative observed state.
 *
 * PURE DATA: readonly constants. No behavior — the `deliveryActionKey`
 * function itself lives in `delivery-settlement-policy.ts` (owned by the
 * legacy delivery lane); this file declares the package-local CONTRIBUTION
 * metadata the manifest carries.
 *
 * ── Dependency-direction ──────────────────────────────────────────────────
 *
 * This file lives under `src/process-modules/modules/delivery/`, so it is a
 * MODULE file. It imports nothing outside its own declarations — no
 * persistence, infra, db, sibling-module, or even domain-SPI imports. This
 * keeps the dependency-direction ratchet green and makes the file trivially
 * portable.
 */

// ---------------------------------------------------------------------------
// Idempotent tool logical ids (mirrors tool-contributions.ts).
// ---------------------------------------------------------------------------

/**
 * The closed set of tool logical ids that carry `idempotency: 'idempotent'`.
 * Mirrors the `idempotency: 'idempotent'` tools in `tool-contributions.ts`.
 *
 *   - `publish_deploy` — a replayed action observes the target before acting
 *     and reuses the already-applied state (observe-before-retry).
 *   - `observe_release` — a pure authoritative read is safe to retry.
 *   - `record_release` — the output repository reuses the first run's record
 *     for the same candidate + policy and returns `replayed: true`.
 *
 * The preflight/approve/settle tools are `'none'` idempotency: they are gated
 * by the run fence and a second call for the same execution is rejected.
 */
export const DELIVERY_IDEMPOTENT_TOOL_IDS = Object.freeze([
  'delivery.publish_deploy',
  'delivery.observe_release',
  'delivery.record_release',
] as const);

// ---------------------------------------------------------------------------
// Action-key identity fields (mirrors deliveryActionKey implementation).
// ---------------------------------------------------------------------------

/**
 * The exact field set the deterministic `deliveryActionKey` hash folds in.
 * Mirrors `deliveryActionKey` in `delivery-settlement-policy.ts`. The hash
 * deliberately EXCLUDES the ProcessRun id so that a second run for the same
 * immutable candidate/action reuses the first run's applied state. Exposed as
 * data so a consumer can assert the strategy contribution matches the
 * implementation without importing the implementation module.
 *
 * The fields:
 *   - `developmentCertificateHash` — the verified Development certificate.
 *   - `candidateHash` — the integrated candidate (immutable after Development).
 *   - `releasePolicyHash` — the immutable release policy content hash.
 *   - `actionId` — the action's stable id within the policy.
 *   - `kind` — the action kind (source-tag / source-release / package-publish / deployment).
 *   - `target` — the externally-visible target (tag, registry, environment).
 *   - `desiredStateHash` — the desired post-action state hash.
 *   - `payloadHash` — the action payload hash.
 */
export const DELIVERY_ACTION_KEY_IDENTITY_FIELDS = Object.freeze([
  'developmentCertificateHash',
  'candidateHash',
  'releasePolicyHash',
  'actionId',
  'kind',
  'target',
  'desiredStateHash',
  'payloadHash',
] as const);

/**
 * The key prefix every deterministic delivery action key carries. Matches the
 * `delivery:${action.kind}:${identityHash}` format produced by
 * `deliveryActionKey`.
 */
export const DELIVERY_ACTION_KEY_PREFIX = 'delivery:';

// ---------------------------------------------------------------------------
// IdempotencyStrategyContribution.
// ---------------------------------------------------------------------------

/**
 * The Delivery module's idempotency strategy contribution. Declares how action
 * keys are derived, what they exclude, the retry contract, and the invariants
 * that enforce it. Pure data — the runtime's recovery engine and the Wave 6
 * tool-contribution installer consult this to confirm the idempotency
 * classification is consistent with the module's guarantees.
 */
export interface IdempotencyStrategyContribution {
  /** Strategy name (stable identity). */
  readonly name: string;
  /** Strategy semantic version. */
  readonly version: string;
  /** Key format produced by the strategy (mirrors deliveryActionKey). */
  readonly keyFormat: string;
  /** The field set folded into the action-key identity hash. */
  readonly identityFields: readonly string[];
  /**
   * Fields deliberately EXCLUDED from the identity hash. Excluding ProcessRun
   * id is what makes a second run for the same immutable candidate/action
   * reuse the first run's applied state (observe-before-retry).
   */
  readonly excludedFields: readonly string[];
  /** The retry contract: observe before re-acting. */
  readonly retryContract: 'observe-before-retry';
  /** Tool logical ids that carry `idempotency: 'idempotent'`. */
  readonly idempotentToolIds: readonly string[];
  /** Invariant refs that enforce the strategy (enforcement surface). */
  readonly invariantRefs: readonly string[];
}

/**
 * The Delivery module's idempotency strategy. The deterministic action key
 * (`delivery:<kind>:<identityHash>`) folds in the candidate, policy, and
 * action identity — but deliberately EXCLUDES the ProcessRun id, so a second
 * run for the same immutable candidate/action observes and reuses the first
 * run's applied state. Retries use the action key and observe the target
 * before acting (invariant `delivery.observe-before-retry`).
 */
export const DELIVERY_IDEMPOTENCY_STRATEGY: IdempotencyStrategyContribution =
  Object.freeze({
    name: 'delivery-cross-run-action-key',
    version: '1.0.0',
    keyFormat: 'delivery:<kind>:<identityHash>',
    identityFields: DELIVERY_ACTION_KEY_IDENTITY_FIELDS,
    excludedFields: Object.freeze(['processRunId']),
    retryContract: 'observe-before-retry',
    idempotentToolIds: DELIVERY_IDEMPOTENT_TOOL_IDS,
    invariantRefs: Object.freeze([
      'delivery.observe-before-retry',
      'delivery.push-is-not-release',
      'delivery.candidate-is-immutable',
      'delivery.no-force-or-bypass',
    ]),
  });

// ---------------------------------------------------------------------------
// Aggregate.
// ---------------------------------------------------------------------------

/**
 * The complete idempotency contribution set. The manifest (W9-A5) carries this
 * so the runtime's recovery engine and the Wave 6 installer can confirm the
 * module's idempotency guarantees are consistently classified. Single-element
 * array — Delivery declares exactly one cross-run action-key strategy.
 */
export const DELIVERY_IDEMPOTENCY_STRATEGY_CONTRIBUTIONS: readonly IdempotencyStrategyContribution[] =
  Object.freeze([DELIVERY_IDEMPOTENCY_STRATEGY]);
