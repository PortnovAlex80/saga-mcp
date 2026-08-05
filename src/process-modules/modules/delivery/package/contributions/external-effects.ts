/**
 * W9-A6 — Delivery package-local external-effects contribution subtree.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6 owns the external-effects contribution subtree),
 *       §8.4 (EvidenceRequirement), §8.2 (NodeProtocol external node).
 *
 * ── What this file owns ───────────────────────────────────────────────────
 *
 * External publication cannot be made transactionally atomic across Git,
 * registries and deployment systems. The Delivery module therefore models
 * desired-state ACTIONS and authoritative OBSERVATIONS explicitly, through two
 * injected external adapters (publish-deploy, observe-release). This file is
 * the package-local CONTRIBUTION surface for those external effects:
 *
 *   1. `ExternalEffectAdapterContribution` — one declaration per external
 *      adapter the package contributes. Each declares the adapter's logical
 *      id (mirrors `DELIVERY_EXTERNAL_ADAPTER_IDS` in `delivery-kernel-ports.ts`),
 *      the action kinds it covers, the external-receipt evidence contract it
 *      emits, and the invariants that constrain it. The Wave 6 adapter
 *      installer registers these without the runtime hardcoding the delivery
 *      adapter catalog.
 *
 *   2. `DELIVERY_EXTERNAL_RECEIPT_EVIDENCE` — the canonical external-receipt
 *      evidence requirement every external adapter's products must satisfy.
 *      Mirrors `EXTERNAL_RECEIPT_EVIDENCE` in W9-A5's node protocols so the
 *      manifest + protocols + this contribution surface stay aligned.
 *
 *   3. `DELIVERY_RELEASE_ACTION_KINDS` — the closed set of externally-visible
 *      action kinds the publication adapter may apply (source-tag /
 *      source-release / package-publish / deployment). Mirrors
 *      `ReleaseActionKind` in `delivery-schemas.ts`.
 *
 * External-effect adapters are EXPLICITLY INJECTED. No fallback may perform
 * release effects (invariant `delivery.no-default-provider`, enforced
 * statically). Adapters must NOT force push, bypass branch protection, bypass
 * registry immutability or bypass deployment policy (invariant
 * `delivery.no-force-or-bypass`, enforced by test). A successful command
 * response alone never establishes release (invariant
 * `delivery.push-is-not-release`, enforced by policy) — settlement requires
 * matching authoritative observed state.
 *
 * PURE DATA: readonly constants. No behavior, no adapter instances. The
 * actual `DeliveryPublicationPort` / `DeliveryObservationPort` interfaces live
 * in `delivery-kernel-ports.ts` (owned by the legacy delivery lane); this file
 * declares the package-local CONTRIBUTION metadata the manifest carries.
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
// Closed set of externally-visible action kinds.
// ---------------------------------------------------------------------------

/**
 * The closed set of externally-visible release action kinds the publication
 * adapter may apply. Mirrors `ReleaseActionKind` in `delivery-schemas.ts` and
 * the validation in `delivery-settlement-policy.ts`. Each kind is produced by
 * exactly one injected action provider (invariant
 * `delivery.no-default-provider`).
 */
export const DELIVERY_RELEASE_ACTION_KINDS = Object.freeze([
  'source-tag',
  'source-release',
  'package-publish',
  'deployment',
] as const);

/**
 * One member of {@link DELIVERY_RELEASE_ACTION_KINDS}.
 */
export type DeliveryReleaseActionKind =
  (typeof DELIVERY_RELEASE_ACTION_KINDS)[number];

// ---------------------------------------------------------------------------
// External-receipt evidence contract.
// ---------------------------------------------------------------------------

/**
 * The canonical external-receipt evidence contract. Every external adapter's
 * products (publication receipts, observation observations) must satisfy this
 * evidence category — the runtime surfaces it as an `EvidenceRequirement` on
 * the publish-deploy and observe-release node protocols (W9-A5). Mirrors
 * `EXTERNAL_RECEIPT_EVIDENCE` in `delivery-node-protocols.ts`.
 *
 * The contract id is `factory.evidence.external-receipt.v1`; the digest is the
 * documented Wave-2 placeholder until the ContractSchemaRegistry ships a
 * codec.
 */
export const DELIVERY_EXTERNAL_RECEIPT_EVIDENCE = Object.freeze({
  category: 'external-receipt',
  contractRef: contractRef('factory.evidence.external-receipt.v1', '1.0.0'),
  required: true,
} as const);

// ---------------------------------------------------------------------------
// ExternalEffectAdapterContribution — one declaration per external adapter.
// ---------------------------------------------------------------------------

/**
 * One external-effect adapter contribution. Declares the adapter's logical id,
 * the Flow node it owns, the action kinds it covers, the input/output contract
 * refs, the evidence contract its products satisfy, and the invariants that
 * constrain it. Pure data — the Wave 6 adapter installer resolves
 * `adapterId` to the concrete `DeliveryPublicationPort` /
 * `DeliveryObservationPort` implementation by name.
 */
export interface ExternalEffectAdapterContribution {
  /** Adapter logical id (mirrors `DELIVERY_EXTERNAL_ADAPTER_IDS`). */
  readonly adapterId: string;
  /** Adapter semantic version. */
  readonly version: string;
  /** Owning Flow node id (mirrors `DELIVERY_NODE_FLOW_IDS`). */
  readonly owningFlowNodeId: string;
  /** The externally-visible side effect this adapter produces. */
  readonly sideEffect: 'external' | 'read';
  /** Action kinds this adapter covers (publication adapter only; observation is a read). */
  readonly actionKinds: readonly DeliveryReleaseActionKind[];
  /** Input contract ref. */
  readonly inputContractRef: ContractRef;
  /** Output contract ref. */
  readonly outputContractRef: ContractRef;
  /** Evidence contract the adapter's products satisfy. */
  readonly evidenceContract: typeof DELIVERY_EXTERNAL_RECEIPT_EVIDENCE;
  /** Invariant refs that constrain this adapter (enforcement surface). */
  readonly invariantRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// publish-deploy adapter contribution.
// ---------------------------------------------------------------------------

/**
 * The `publish-deploy` external adapter contribution. Applies every required
 * release action (all four action kinds) through explicit providers using the
 * deterministic cross-run action key. Side effect `'external'`. Constrained by
 * `delivery.no-default-provider`, `delivery.no-force-or-bypass`,
 * `delivery.observe-before-retry`, and `delivery.push-is-not-release`.
 */
export const DELIVERY_PUBLISH_DEPLOY_ADAPTER_CONTRIBUTION: ExternalEffectAdapterContribution =
  Object.freeze({
    adapterId: 'delivery-publish-deploy',
    version: '1.0.0',
    owningFlowNodeId: 'publish-deploy',
    sideEffect: 'external',
    actionKinds: DELIVERY_RELEASE_ACTION_KINDS,
    inputContractRef: contractRef('factory.delivery-approval-decision.v1', '1.0.0'),
    outputContractRef: contractRef('factory.delivery-publication.v1', '1.0.0'),
    evidenceContract: DELIVERY_EXTERNAL_RECEIPT_EVIDENCE,
    invariantRefs: Object.freeze([
      'delivery.no-default-provider',
      'delivery.no-force-or-bypass',
      'delivery.observe-before-retry',
      'delivery.push-is-not-release',
      'delivery.explicit-operator-authorization',
    ]),
  });

// ---------------------------------------------------------------------------
// observe-release adapter contribution.
// ---------------------------------------------------------------------------

/**
 * The `observe-release` external adapter contribution. Reads authoritative
 * target state for every published destination — including destinations whose
 * publication response was uncertain or failed. Side effect `'read'` (pure
 * authoritative read). Constrained by `delivery.no-default-provider`,
 * `delivery.observe-before-retry`, and `delivery.push-is-not-release`
 * (observation is the input to settlement; a push response alone never
 * establishes release).
 */
export const DELIVERY_OBSERVE_RELEASE_ADAPTER_CONTRIBUTION: ExternalEffectAdapterContribution =
  Object.freeze({
    adapterId: 'delivery-observe-release',
    version: '1.0.0',
    owningFlowNodeId: 'observe-release',
    sideEffect: 'read',
    actionKinds: Object.freeze([]),
    inputContractRef: contractRef('factory.delivery-publication.v1', '1.0.0'),
    outputContractRef: contractRef('factory.delivery-observation.v1', '1.0.0'),
    evidenceContract: DELIVERY_EXTERNAL_RECEIPT_EVIDENCE,
    invariantRefs: Object.freeze([
      'delivery.no-default-provider',
      'delivery.observe-before-retry',
      'delivery.push-is-not-release',
    ]),
  });

// ---------------------------------------------------------------------------
// Aggregate — the complete external-effect adapter contribution set.
// ---------------------------------------------------------------------------

/**
 * Every external-effect adapter contribution the Delivery package declares.
 * The manifest (W9-A5) carries this so the Wave 6 adapter installer can
 * register both adapters without hardcoding the delivery adapter catalog.
 * Order is stable (flow order: publish-deploy → observe-release) so the
 * canonical-JSON digest of a manifest carrying this set is reproducible.
 */
export const DELIVERY_EXTERNAL_EFFECT_ADAPTER_CONTRIBUTIONS: readonly ExternalEffectAdapterContribution[] =
  Object.freeze([
    DELIVERY_PUBLISH_DEPLOY_ADAPTER_CONTRIBUTION,
    DELIVERY_OBSERVE_RELEASE_ADAPTER_CONTRIBUTION,
  ]);
