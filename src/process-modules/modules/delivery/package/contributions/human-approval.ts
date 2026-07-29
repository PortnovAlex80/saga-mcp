/**
 * W9-A6 — Delivery package-local human-approval contribution subtree.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6 owns the human-approval contribution subtree),
 *       §8.4 (EvidenceRequirement), §8.2 (NodeProtocol human node).
 *
 * ── What this file owns ───────────────────────────────────────────────────
 *
 * Delivery is the only standard process module authorized to create
 * externally-visible release state, and that authorization is gated behind an
 * EXPLICIT human decision bound to the exact candidate, preflight result and
 * release policy. This file is the package-local CONTRIBUTION surface for that
 * human-approval interaction:
 *
 *   1. `HumanApprovalAdapterContribution` — the declaration of the
 *      `approve-release` human interaction adapter. It declares the adapter's
 *      logical id (mirrors `DELIVERY_HUMAN_ADAPTER_IDS.approval` in
 *      `delivery-kernel-ports.ts`), the human-receipt evidence contract it
 *      emits, the decision statuses it may produce, and the invariants that
 *      constrain it.
 *
 *   2. `DELIVERY_HUMAN_RECEIPT_EVIDENCE` — the canonical human-receipt
 *      evidence requirement the approval decision must satisfy. Mirrors
 *      `HUMAN_RECEIPT_EVIDENCE` in W9-A5's node protocols.
 *
 *   3. `DELIVERY_APPROVAL_STATUSES` — the closed set of approval statuses the
 *      adapter may produce. A `pending` decision is a normal RESUMABLE result
 *      and must NOT be converted into an approval by the adapter.
 *
 * Human approval binds the candidate hash, preflight hash and release-policy
 * hash and cannot float to a later revision (invariant
 * `delivery.approval-binds-exact-input`, enforced by policy). No externally-
 * visible release action may begin without an explicit operator grant (invariant
 * `delivery.explicit-operator-authorization`, enforced by policy).
 *
 * PURE DATA: readonly constants. No behavior, no adapter instances. The actual
 * `DeliveryApprovalPort` / `DeliveryApprovalSource` interfaces live in
 * `delivery-kernel-ports.ts` / `delivery-provider-ports.ts` (owned by the
 * legacy delivery lane); this file declares the package-local CONTRIBUTION
 * metadata the manifest carries.
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
// Closed set of approval statuses.
// ---------------------------------------------------------------------------

/**
 * The closed set of approval decision statuses the human-approval adapter may
 * produce. Mirrors `DeliveryApprovalStatus` in `delivery-schemas.ts`. A
 * `pending` status is a normal RESUMABLE result (the run pauses until the
 * authorized-decision provider resolves) and must NOT be converted into an
 * `approved` decision by the adapter — that would bypass the explicit human
 * authority (invariant `delivery.explicit-operator-authorization`).
 */
export const DELIVERY_APPROVAL_STATUSES = Object.freeze([
  'not-required',
  'pending',
  'approved',
  'denied',
  'expired',
] as const);

/**
 * One member of {@link DELIVERY_APPROVAL_STATUSES}.
 */
export type DeliveryApprovalStatus =
  (typeof DELIVERY_APPROVAL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Human-receipt evidence contract.
// ---------------------------------------------------------------------------

/**
 * The canonical human-receipt evidence contract. The approval decision the
 * human adapter materializes must satisfy this evidence category — the runtime
 * surfaces it as an `EvidenceRequirement` on the approve-release node protocol
 * (W9-A5). Mirrors `HUMAN_RECEIPT_EVIDENCE` in `delivery-node-protocols.ts`.
 *
 * The contract id is `saga3.evidence.human-receipt.v1`; the digest is the
 * documented Wave-2 placeholder until the ContractSchemaRegistry ships a
 * codec.
 */
export const DELIVERY_HUMAN_RECEIPT_EVIDENCE = Object.freeze({
  category: 'human-receipt',
  contractRef: contractRef('saga3.evidence.human-receipt.v1', '1.0.0'),
  required: true,
} as const);

// ---------------------------------------------------------------------------
// HumanApprovalAdapterContribution.
// ---------------------------------------------------------------------------

/**
 * The human-approval adapter contribution. Declares the adapter's logical id,
 * the Flow node it owns, the input/output contract refs, the evidence contract
 * its decision satisfies, the resumable status it must not auto-convert, and
 * the invariants that constrain it. Pure data — the Wave 6 adapter installer
 * resolves `adapterId` to the concrete `DeliveryApprovalPort` /
 * `DeliveryApprovalSource` implementation by name.
 */
export interface HumanApprovalAdapterContribution {
  /** Adapter logical id (mirrors `DELIVERY_HUMAN_ADAPTER_IDS.approval`). */
  readonly adapterId: string;
  /** Adapter semantic version. */
  readonly version: string;
  /** Owning Flow node id (mirrors `DELIVERY_NODE_FLOW_IDS.approval`). */
  readonly owningFlowNodeId: string;
  /** Input contract ref (the preflight snapshot). */
  readonly inputContractRef: ContractRef;
  /** Output contract ref (the approval decision). */
  readonly outputContractRef: ContractRef;
  /** Evidence contract the approval decision satisfies. */
  readonly evidenceContract: typeof DELIVERY_HUMAN_RECEIPT_EVIDENCE;
  /**
   * The resumable status the adapter MUST NOT auto-convert into an approval.
   * A `pending` decision pauses the run; the authorized-decision provider
   * resolves it asynchronously.
   */
  readonly nonTerminalStatus: 'pending';
  /** Invariant refs that constrain this adapter (enforcement surface). */
  readonly invariantRefs: readonly string[];
}

/**
 * The `approve-release` human-approval adapter contribution. Materializes an
 * authorized decision bound to the exact candidate, preflight result and
 * release policy. A `pending` decision pauses the run (it is never converted
 * into an approval). Constrained by `delivery.explicit-operator-authorization`
 * and `delivery.approval-binds-exact-input`.
 */
export const DELIVERY_APPROVE_RELEASE_ADAPTER_CONTRIBUTION: HumanApprovalAdapterContribution =
  Object.freeze({
    adapterId: 'delivery-release-approval',
    version: '1.0.0',
    owningFlowNodeId: 'approve-release',
    inputContractRef: contractRef('saga3.delivery-preflight.v1', '1.0.0'),
    outputContractRef: contractRef('saga3.delivery-approval-decision.v1', '1.0.0'),
    evidenceContract: DELIVERY_HUMAN_RECEIPT_EVIDENCE,
    nonTerminalStatus: 'pending',
    invariantRefs: Object.freeze([
      'delivery.explicit-operator-authorization',
      'delivery.approval-binds-exact-input',
      'delivery.no-default-provider',
    ]),
  });

// ---------------------------------------------------------------------------
// Aggregate — the complete human-approval adapter contribution set.
// ---------------------------------------------------------------------------

/**
 * Every human-approval adapter contribution the Delivery package declares.
 * Delivery has exactly one human interaction node (`approve-release`); the
 * manifest (W9-A5) carries this single-element array so the Wave 6 adapter
 * installer can register it without hardcoding the delivery human catalog.
 */
export const DELIVERY_HUMAN_APPROVAL_ADAPTER_CONTRIBUTIONS: readonly HumanApprovalAdapterContribution[] =
  Object.freeze([DELIVERY_APPROVE_RELEASE_ADAPTER_CONTRIBUTION]);
