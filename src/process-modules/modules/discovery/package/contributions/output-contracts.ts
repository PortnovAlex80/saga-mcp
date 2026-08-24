/**
 * W9-A2 — Discovery package-local output contracts.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.4 (W9-A2), §7.6 (NodeProductionEnvelope), §13.20
 *       (ProcessModuleOutputEnvelope), §7.5.6 (ModuleCompletion).
 *
 * This file declares the exact product/output contracts the Discovery package
 * emits, as pure Wave 1 SPI data:
 *
 *   - `ContractRef` for every input/output/bundle/certificate schema the
 *     module speaks. These are the schema identities the discovery kernel
 *     handlers and settlement policy produce; the manifest (W9-A1) carries the
 *     top-level input/output pair, and this file declares the full per-node
 *     bundle set so a downstream consumer (the lifecycle mapper, the
 *     formalization module's FormalizationCase builder) can resolve every
 *     production the module emits.
 *   - The module's declared `ModuleCompletion` outcome set, mapping each
 *     terminal discovery outcome to its `terminal` flag. This is the explicit
 *     certificate bindings: the settlement handler emits one of these
 *     outcomes, and the runtime knows from `terminal: true` that the run is
 *     done.
 *
 * The schema ids mirror `discovery-process-module.ts` and the saga3 domain
 * schema constants exactly — this file is the package-local CONTRACT surface
 * (the `ContractRef` digests the runtime content-addresses), while the saga3
 * domain modules remain the implementation-layer type declarations. Keeping
 * them separate lets the manifest carry contract refs without importing the
 * implementation module into the domain SPI.
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
// Input contract — the DiscoveryCase bound to an episode.
// ---------------------------------------------------------------------------

/**
 * The module's input contract: one `DiscoveryCase` binding a discovery episode.
 * Matches `factory.discovery-case.v1` (the `inputContract` on
 * `discovery-process-module.ts`).
 */
export const DISCOVERY_INPUT_CONTRACT: ContractRef = contractRef(
  'factory.discovery-case.v1',
  '1.0.0',
);

// ---------------------------------------------------------------------------
// Per-node bundle output contracts — the products each kernel resolver emits.
// ---------------------------------------------------------------------------

/**
 * Output contract of the `produce-proposal` /
 * `resolve-proposal-submission` node pair: the canonical DiscoveryProposal.
 * Matches `factory.discovery-proposal.v1`.
 */
export const DISCOVERY_PROPOSAL_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.discovery-proposal.v1',
  '1.0.0',
);

/**
 * Output contract of the `prepare-normalization` /
 * `resolve-normalized-proposal` node pair: the canonical normalization
 * transformation proposal. Matches
 * `factory.discovery-normalization-proposal.v1`.
 */

/**
 * Output contract of the `prepare-readiness` / `resolve-readiness` node pair:
 * the canonical readiness assessment. Matches
 * `factory.discovery-readiness-assessment.v2`.
 */
export const DISCOVERY_READINESS_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.discovery-readiness-assessment.v2',
  '2.0.0',
);

/**
 * Output contract of the diagnosis advisor (post-completion observer): the
 * advisory diagnosis report. Matches `factory.discovery-diagnosis.v1`. The
 * diagnosis is advisory-only — it never enters the outcome-critical flow.
 */

/**
 * Output contract of the brief auto-provisioning projection: the synthetic
 * accepted brief created when a proposal is first accepted (so downstream
 * Formalization has its PRD → brief `derived_from` lineage). Matches
 * `factory.discovery-brief.v1`.
 */

/**
 * The intermediate settlement-input contract the settlement handler assembles
 * from the frozen graph. Matches `factory.discovery-settlement-input.v1`.
 */
export const DISCOVERY_SETTLEMENT_INPUT_CONTRACT: ContractRef = contractRef(
  'factory.discovery-settlement-input.v1',
  '1.0.0',
);

// ---------------------------------------------------------------------------
// Module output + certificate contracts.
// ---------------------------------------------------------------------------

/**
 * The module's terminal output contract: the immutable discovery outcome
 * certificate the settlement handler persists on every terminal outcome.
 * Matches `factory.discovery-outcome-certificate.v1`. The manifest (W9-A1)
 * carries this as `outputContractRef`.
 */
export const DISCOVERY_OUTPUT_CONTRACT: ContractRef = contractRef(
  'factory.discovery-outcome-certificate.v1',
  '1.0.0',
);

/**
 * The certificate payload contract the generic ProcessOutcomeCertificate layer
 * wraps around the discovery decision. Matches
 * `factory.discovery-outcome-certificate.generic.v1`.
 */
export const DISCOVERY_CERTIFICATE_CONTRACT: ContractRef = contractRef(
  'factory.discovery-outcome-certificate.generic.v1',
  '1.0.0',
);

/**
 * Every per-node bundle output contract the discovery flow emits, in flow
 * order. A downstream consumer (e.g. the formalization module's
 * FormalizationCase builder) can iterate this to resolve every production the
 * module produced without hardcoding schema ids.
 *
 * Order: proposal → normalization → readiness → diagnosis → brief →
 * settlement-input. The terminal outcome-certificate is carried separately as
 * `DISCOVERY_OUTPUT_CONTRACT`.
 */
export const DISCOVERY_NODE_OUTPUT_CONTRACTS: readonly ContractRef[] = Object.freeze([
  DISCOVERY_PROPOSAL_BUNDLE_CONTRACT,
  DISCOVERY_READINESS_BUNDLE_CONTRACT,
  DISCOVERY_SETTLEMENT_INPUT_CONTRACT,
]);

// ---------------------------------------------------------------------------
// Declared outcomes — the explicit ModuleCompletion surface (plan §7.5.6).
// ---------------------------------------------------------------------------

/**
 * One declared discovery outcome. The `outcome` code matches the flow's
 * terminal `complete-<code>` nodes and the `OutcomeDefinition` list in the
 * process-module definition; `terminal: true` marks every discovery outcome as
 * run-ending (the module never returns a non-terminal outcome).
 *
 * `description` mirrors `OutcomeDefinition.description` so a consumer can
 * render the outcome without dereferencing the process-module definition.
 */
export interface DiscoveryDeclaredOutcome {
  readonly outcome: string;
  readonly terminal: boolean;
  readonly description: string;
}

/**
 * The full declared-outcome set. Each entry corresponds to one
 * `complete-<code>` kernel node and one `OutcomeDefinition` in the discovery
 * process module. The settlement handler emits one of these (via the D4
 * settlement policy decision); the runtime's `ModuleCompletion` envelope
 * carries the selected outcome verbatim.
 *
 * Order matches the `OutcomeDefinition` declaration order in
 * `discovery-process-module.ts` so the two surfaces stay aligned.
 */
export const DISCOVERY_DECLARED_OUTCOMES: readonly DiscoveryDeclaredOutcome[] = Object.freeze([
  {
    outcome: 'go',
    terminal: true,
    description: 'The subject is sufficiently grounded to continue.',
  },
  {
    outcome: 'clarify',
    terminal: true,
    description: 'Material information is missing or contradictory.',
  },
  {
    outcome: 'reject',
    terminal: true,
    description: 'The subject should not continue under the current evidence and policy.',
  },
  {
    outcome: 'failed',
    terminal: true,
    description: 'Discovery infrastructure could not produce an authoritative result.',
  },
]);

/**
 * The set of outcome codes, derived from {@link DISCOVERY_DECLARED_OUTCOMES}.
 * Convenient for membership checks (e.g. validating that a settlement decision
 * is one of the declared outcomes) without iterating the full descriptors.
 */
export const DISCOVERY_OUTCOME_CODES: readonly string[] = Object.freeze(
  DISCOVERY_DECLARED_OUTCOMES.map((o) => o.outcome),
);
