/**
 * W9-A6 — Delivery package-local receipts contribution subtree.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6 owns the receipts contribution subtree),
 *       §8.4 (EvidenceRequirement), §0.12.6 (Delivery durable receipts).
 *
 * ── What this file owns ───────────────────────────────────────────────────
 *
 * External publication cannot be made transactionally atomic, so Delivery
 * persists a DURABLE RECEIPT for every externally-visible action and a DURABLE
 * OBSERVATION for every published destination. These receipts are the
 * authoritative record the settlement gate consults — a successful command
 * response alone never establishes release (invariant
 * `delivery.push-is-not-release`); settlement requires matching authoritative
 * observed state. This file is the package-local CONTRIBUTION surface for
 * those receipt types:
 *
 *   1. `ReceiptTypeContribution` — one declaration per durable receipt type
 *      (action receipt, action observation). Each declares the receipt's
 *      logical id, the schema it conforms to, the field set it carries
 *      (mirrors `DeliveryActionReceipt` / `DeliveryActionObservation` in
 *      `delivery-schemas.ts`), and the evidence category it satisfies.
 *
 *   2. `DELIVERY_RECEIPT_TYPES` — the complete receipt-type contribution set.
 *
 *   3. `DELIVERY_RECEIPT_STATUS_VALUES` / `DELIVERY_OBSERVATION_OUTCOME_VALUES`
 *      — the closed status vocabularies receipts/observations may carry,
 *      including the UNCERTAIN statuses that must be persisted for the
 *      observation adapter instead of triggering a blind retry.
 *
 * Receipts carry the deterministic action key (so a replayed action is
 * detectable), the provider binding (so untrusted providers are rejected at
 * settlement), and a `replayed` flag (so the output repository can mark a
 * reused record). Observations carry the observed state hash and an outcome
 * classification (matched / mismatched / unknown / error) — settlement admits
 * release only when every required observation is `matched`.
 *
 * PURE DATA: readonly constants. No behavior — the actual receipt/observation
 * types live in `delivery-schemas.ts` (owned by the legacy delivery lane);
 * this file declares the package-local CONTRIBUTION metadata the manifest
 * carries.
 *
 * ── Dependency-direction ──────────────────────────────────────────────────
 *
 * This file lives under `src/process-modules/modules/delivery/`, so it is a
 * MODULE file. It imports only the pure domain SPI
 * (`domain/spi/contract-ref.js`) — no persistence, infra, db, or sibling-
 * module imports. This keeps the dependency-direction ratchet green.
 */

import type { ContractRef } from '../../../../domain/spi/contract-ref.js';

// ---------------------------------------------------------------------------
// Placeholder digest helper (mirrors output-contracts.ts).
// ---------------------------------------------------------------------------

function contractRef(schemaId: string, version: string): ContractRef {
  return { schemaId, version, digest: 'pending@wave-2' };
}

// ---------------------------------------------------------------------------
// Closed receipt-status + observation-outcome vocabularies.
// ---------------------------------------------------------------------------

/**
 * The closed set of statuses a durable action receipt may carry. Mirrors the
 * `status` field of `DeliveryActionReceipt` in `delivery-schemas.ts`. An
 * `'uncertain'` receipt MUST be persisted for the observation adapter instead
 * of triggering a blind retry (invariant `delivery.observe-before-retry`).
 */
export const DELIVERY_RECEIPT_STATUS_VALUES = Object.freeze([
  'succeeded',
  'failed',
  'blocked',
  'uncertain',
] as const);

/**
 * The closed set of outcomes a durable action observation may carry. Mirrors
 * the `outcome` field of `DeliveryActionObservation` in `delivery-schemas.ts`.
 * Settlement admits release only when every REQUIRED observation is
 * `'matched'`; `'mismatched'` / `'unknown'` / `'error'` deny release.
 */
export const DELIVERY_OBSERVATION_OUTCOME_VALUES = Object.freeze([
  'matched',
  'mismatched',
  'unknown',
  'error',
] as const);

// ---------------------------------------------------------------------------
// ReceiptTypeContribution.
// ---------------------------------------------------------------------------

/**
 * One durable receipt-type contribution. Declares the receipt's logical id,
 * the schema it conforms to, the field set it carries, the evidence category
 * it satisfies, and the invariants that govern its use. Pure data.
 */
export interface ReceiptTypeContribution {
  /** Receipt type logical id (stable, module-namespaced). */
  readonly receiptTypeId: string;
  /** Receipt type semantic version. */
  readonly version: string;
  /** Contract ref of the schema this receipt conforms to. */
  readonly contractRef: ContractRef;
  /** Field set the receipt carries (mirrors delivery-schemas.ts). */
  readonly fields: readonly string[];
  /** Evidence category this receipt satisfies. */
  readonly evidenceCategory: string;
  /** Invariant refs that govern this receipt type (enforcement surface). */
  readonly invariantRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Action receipt contribution.
// ---------------------------------------------------------------------------

/**
 * The durable action-receipt contribution. Every externally-visible desired-
 * state action the publish-deploy adapter applies produces one receipt under
 * the deterministic action key. Mirrors `DeliveryActionReceipt` in
 * `delivery-schemas.ts`. Carries the action key, action identity, the provider
 * binding, the externalRef/resultHash, the status, and a `replayed` flag.
 *
 * Field set mirrors `DeliveryActionReceipt` exactly so a consumer can assert
 * the contribution matches the implementation.
 */
export const DELIVERY_ACTION_RECEIPT_CONTRIBUTION: ReceiptTypeContribution =
  Object.freeze({
    receiptTypeId: 'delivery.action-receipt',
    version: '1.0.0',
    contractRef: contractRef('saga3.delivery-publication.v1', '1.0.0'),
    fields: Object.freeze([
      'actionKey',
      'actionId',
      'kind',
      'target',
      'payloadHash',
      'desiredStateHash',
      'status',
      'externalRef',
      'resultHash',
      'provider',
      'replayed',
    ]),
    evidenceCategory: 'external-receipt',
    invariantRefs: Object.freeze([
      'delivery.observe-before-retry',
      'delivery.push-is-not-release',
      'delivery.no-default-provider',
    ]),
  });

// ---------------------------------------------------------------------------
// Action observation contribution.
// ---------------------------------------------------------------------------

/**
 * The durable action-observation contribution. Every published destination is
 * authoritatively observed through the observe-release adapter, producing one
 * observation under the action key. Mirrors `DeliveryActionObservation` in
 * `delivery-schemas.ts`. Carries the action key, target, desired vs observed
 * state hash, the outcome classification, the observation reference, and the
 * provider binding.
 *
 * Field set mirrors `DeliveryActionObservation` exactly so a consumer can
 * assert the contribution matches the implementation.
 */
export const DELIVERY_ACTION_OBSERVATION_CONTRIBUTION: ReceiptTypeContribution =
  Object.freeze({
    receiptTypeId: 'delivery.action-observation',
    version: '1.0.0',
    contractRef: contractRef('saga3.delivery-observation.v1', '1.0.0'),
    fields: Object.freeze([
      'actionKey',
      'target',
      'desiredStateHash',
      'observedStateHash',
      'outcome',
      'observation',
      'provider',
    ]),
    evidenceCategory: 'external-receipt',
    invariantRefs: Object.freeze([
      'delivery.observe-before-retry',
      'delivery.push-is-not-release',
      'delivery.no-default-provider',
    ]),
  });

// ---------------------------------------------------------------------------
// Aggregate — the complete receipt-type contribution set.
// ---------------------------------------------------------------------------

/**
 * Every durable receipt-type contribution the Delivery package declares. The
 * manifest (W9-A5) carries this so the settlement gate and the Wave 6 installer
 * can confirm the receipt vocabulary the module persists is consistently
 * classified. Order is stable (action receipt → action observation) so the
 * canonical-JSON digest of a manifest carrying this set is reproducible.
 */
export const DELIVERY_RECEIPT_TYPES: readonly ReceiptTypeContribution[] =
  Object.freeze([
    DELIVERY_ACTION_RECEIPT_CONTRIBUTION,
    DELIVERY_ACTION_OBSERVATION_CONTRIBUTION,
  ]);
