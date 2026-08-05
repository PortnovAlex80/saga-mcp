/**
 * W9-A6 — Delivery package-local output contracts.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Task: docs/refactor-management/05-subagent-tasks/W09-a6.md.
 * Plan: §0.12.6 (W9-A6), §7.6 (NodeProductionEnvelope), §13.20
 *       (ProcessModuleOutputEnvelope), §7.5.6 (ModuleCompletion).
 *
 * This file declares the exact product/output contracts the Delivery package
 * emits, as pure Wave 1 SPI data:
 *
 *   - `ContractRef` for every input/output/bundle/certificate schema the
 *     module speaks. These are the schema identities the delivery kernel
 *     handlers, external/human adapters and settlement policy produce; the
 *     manifest (W9-A5) carries the top-level input/output pair, and this file
 *     declares the full per-node bundle set so a downstream consumer (the
 *     lifecycle mapper, the product-delivery lifecycle) can resolve every
 *     production the module emits.
 *   - The module's declared `ModuleCompletion` outcome set, mapping each
 *     terminal delivery outcome to its `terminal` flag. This is the explicit
 *     completion envelope (plan §7.5.6) that replaces the legacy magic
 *     certificate bindings: the settlement handler emits one of these
 *     outcomes, and the runtime knows from `terminal: true` that the run is
 *     done.
 *
 * The schema ids mirror `delivery-schemas.ts` and
 * `delivery-process-module.ts` exactly — this file is the package-local
 * CONTRACT surface (the `ContractRef` digests the runtime content-addresses),
 * while `delivery-schemas.ts` remains the implementation-layer type
 * declarations. Keeping them separate lets the manifest carry contract refs
 * without importing the implementation module into the domain SPI.
 *
 * PURE DATA: readonly constants typed by the Wave 1 SPI. No behavior.
 */

import type { ContractRef } from '../../../../domain/spi/contract-ref.js';

// ---------------------------------------------------------------------------
// Contract-ref minter.
// ---------------------------------------------------------------------------

/**
 * Placeholder digest helper. Wave 9 does not yet register concrete JSON
 * schemas with the ContractSchemaRegistry (wiring lands at the Wave 11
 * composition-root cutover). Until then contract refs carry the documented
 * `'pending@wave-2'` digest so the manifest round-trips and the canonical-
 * serialization gate accepts the declarations. The `schemaId` is the real
 * saga3 schema identity so the runtime can resolve it once a codec is
 * registered.
 */
function contractRef(schemaId: string, version: string): ContractRef {
  return { schemaId, version, digest: 'pending@wave-2' };
}

// ---------------------------------------------------------------------------
// Input contract — the DeliveryReleaseCase bound to a verified candidate.
// ---------------------------------------------------------------------------

/**
 * The module's input contract: one `DeliveryReleaseCase` binding a verified
 * Development certificate and integrated candidate to either an authorized
 * immutable release policy or an explicit content-addressed deferred profile.
 * Matches `factory.delivery-release-case.v2`.
 */
export const DELIVERY_INPUT_CONTRACT: ContractRef = contractRef(
  'factory.delivery-release-case.v2',
  '1.0.0',
);

// ---------------------------------------------------------------------------
// Per-node bundle output contracts — the products each node emits.
// ---------------------------------------------------------------------------

/**
 * Output contract of the `preflight-release` kernel node: the complete
 * deterministic release-guard evidence snapshot for the exact certified
 * candidate. Matches `factory.delivery-preflight.v1`.
 */
export const DELIVERY_PREFLIGHT_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.delivery-preflight.v1',
  '1.0.0',
);

/**
 * Output contract of the `approve-release` human node: the authorized decision
 * bound to the candidate, preflight snapshot and release policy. Matches
 * `factory.delivery-approval-decision.v1`.
 */
export const DELIVERY_APPROVAL_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.delivery-approval-decision.v1',
  '1.0.0',
);

/**
 * Output contract of the `publish-deploy` external node: the durable
 * desired-state action receipts, including uncertain external responses.
 * Matches `factory.delivery-publication.v1`.
 */
export const DELIVERY_PUBLICATION_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.delivery-publication.v1',
  '1.0.0',
);

/**
 * Output contract of the `observe-release` external node: the authoritative
 * post-action state observations used to settle external effects safely.
 * Matches `factory.delivery-observation.v1`.
 */
export const DELIVERY_OBSERVATION_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.delivery-observation.v1',
  '1.0.0',
);

/**
 * The intermediate settlement-input contract the settlement handler assembles
 * from the durable preflight/approval/publication/observation productions plus
 * the current candidate hash. Matches `factory.delivery-settlement-input.v1`.
 */
export const DELIVERY_SETTLEMENT_INPUT_CONTRACT: ContractRef = contractRef(
  'factory.delivery-settlement-input.v1',
  '1.0.0',
);

/**
 * Output contract of the canonical ReleaseRecord — the externally-visible
 * record of every observed release destination for the certified candidate.
 * Matches `factory.release-record.v1`. The manifest (W9-A5) carries this as
 * `outputContractRef`.
 */
export const DELIVERY_RELEASE_RECORD_CONTRACT: ContractRef = contractRef(
  'factory.release-record.v1',
  '1.0.0',
);

// ---------------------------------------------------------------------------
// Module output + certificate contracts.
// ---------------------------------------------------------------------------

/**
 * The module's terminal certificate contract: the immutable delivery
 * settlement decision and exact product-lineage hashes. Matches
 * `factory.delivery-certificate.v2`. Emitted on every terminal outcome
 * (released / approval-required / blocked / failed).
 */
export const DELIVERY_OUTPUT_CONTRACT: ContractRef = contractRef(
  'factory.delivery-certificate.v2',
  '1.0.0',
);

/**
 * The certificate payload contract the generic ProcessOutcomeCertificate layer
 * wraps around the delivery decision. Matches
 * `factory.delivery-certificate.generic.v1`.
 */
export const DELIVERY_CERTIFICATE_CONTRACT: ContractRef = contractRef(
  'factory.delivery-certificate.generic.v1',
  '1.0.0',
);

/**
 * Every per-node bundle output contract the delivery flow emits, in flow
 * order. A downstream consumer can iterate this to resolve every production
 * the module produced without hardcoding schema ids.
 *
 * Order: preflight → approval → publication → observation → settlement-input
 * → release-record. The terminal certificate is carried separately as
 * `DELIVERY_OUTPUT_CONTRACT`.
 */
export const DELIVERY_NODE_OUTPUT_CONTRACTS: readonly ContractRef[] = Object.freeze([
  DELIVERY_PREFLIGHT_BUNDLE_CONTRACT,
  DELIVERY_APPROVAL_BUNDLE_CONTRACT,
  DELIVERY_PUBLICATION_BUNDLE_CONTRACT,
  DELIVERY_OBSERVATION_BUNDLE_CONTRACT,
  DELIVERY_SETTLEMENT_INPUT_CONTRACT,
  DELIVERY_RELEASE_RECORD_CONTRACT,
]);

// ---------------------------------------------------------------------------
// Declared outcomes — the explicit ModuleCompletion surface (plan §7.5.6).
// ---------------------------------------------------------------------------

/**
 * One declared delivery outcome. The `outcome` code matches the flow's
 * terminal `complete-<code>` nodes and the `OutcomeDefinition` list in the
 * process-module definition; `terminal: true` marks every delivery outcome as
 * run-ending (the module never returns a non-terminal outcome).
 *
 * `description` mirrors `OutcomeDefinition.description` so a consumer can
 * render the outcome without dereferencing the process-module definition.
 */
export interface DeliveryDeclaredOutcome {
  readonly outcome: string;
  readonly terminal: boolean;
  readonly description: string;
}

/**
 * The full declared-outcome set. Each entry corresponds to one
 * `complete-<code>` kernel node and one `OutcomeDefinition` in the delivery
 * process module. The settlement handler emits one of these; the runtime's
 * `ModuleCompletion` envelope carries the selected outcome verbatim.
 *
 * Order matches the `OutcomeDefinition` declaration order in
 * `delivery-process-module.ts` so the two surfaces stay aligned.
 */
export const DELIVERY_DECLARED_OUTCOMES: readonly DeliveryDeclaredOutcome[] = Object.freeze([
  {
    outcome: 'released',
    terminal: true,
    description:
      'Every required release action is authoritatively observed at its desired state.',
  },
  {
    outcome: 'approval-required',
    terminal: true,
    description:
      'A current authorized human decision is required before release effects may begin.',
  },
  {
    outcome: 'blocked',
    terminal: true,
    description:
      'A policy guard, denied decision, unavailable provider or inconclusive external state blocks release.',
  },
  {
    outcome: 'failed',
    terminal: true,
    description:
      'Delivery integrity, lineage or external-state validation failed.',
  },
]);

/**
 * The set of outcome codes, derived from {@link DELIVERY_DECLARED_OUTCOMES}.
 * Convenient for membership checks (e.g. validating that a settlement decision
 * is one of the declared outcomes) without iterating the full descriptors.
 */
export const DELIVERY_OUTCOME_CODES: readonly string[] = Object.freeze(
  DELIVERY_DECLARED_OUTCOMES.map((o) => o.outcome),
);
