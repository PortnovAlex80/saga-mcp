/**
 * W8-A7 — Formalization package-local output contracts.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE8-FORMALIZATION-SPEC.md.
 * Plan: §7.6 (NodeProductionEnvelope), §13.20 (ProcessModuleOutputEnvelope),
 *       §7.5.6 (ModuleCompletion).
 *
 * This file declares the exact product/output contracts the Formalization
 * package emits, as pure Wave 1 SPI data:
 *
 *   - `ContractRef` for every input/output/bundle/certificate schema the
 *     module speaks. These are the schema identities the formalization kernel
 *     handlers and settlement policy produce; the manifest (W8-A1) carries the
 *     top-level input/output pair, and this file declares the full per-node
 *     bundle set so a downstream consumer (the lifecycle mapper, the
 *     development module's DevelopmentCase builder) can resolve every
 *     production the module emits.
 *   - The module's declared `ModuleCompletion` outcome set, mapping each
 *     terminal formalization outcome to its `terminal` flag. This is the
 *     magic certificate bindings: the settlement handler emits one of these
 *     outcomes, and the runtime knows from `terminal: true` that the run is
 *     done.
 *
 * The schema ids mirror `formalization-schemas.ts` exactly — this file is the
 * package-local CONTRACT surface (the `ContractRef` digests the runtime
 * content-addresses), while `formalization-schemas.ts` remains the
 * implementation-layer type declarations. Keeping them separate lets the
 * manifest carry contract refs without importing the implementation module
 * into the domain SPI.
 *
 * PURE DATA: readonly constants typed by the Wave 1 SPI. No behavior.
 */

import type { ContractRef } from '../../../../domain/spi/contract-ref.js';

// ---------------------------------------------------------------------------
// Contract-ref minter.
// ---------------------------------------------------------------------------

/**
 * Placeholder digest helper. Wave 8 does not yet register concrete JSON
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
// Input contract — the FormalizationCase bound to a discovery certificate.
// ---------------------------------------------------------------------------

/**
 * The module's input contract: one `FormalizationCase` binding a discovery
 * certificate to a formalization episode. Matches
 * `factory.formalization-case.v1` in `formalization-schemas.ts`.
 */
export const FORMALIZATION_INPUT_CONTRACT: ContractRef = contractRef(
  'factory.formalization-case.v1',
  '1.0.0',
);

// ---------------------------------------------------------------------------
// Per-node bundle output contracts — the products each kernel resolver emits.
// ---------------------------------------------------------------------------

/**
 * Output contract of the `define-product-contract` /
 * `resolve-product-contract` node pair: the canonical PRD + FR + NFR + RULE
 * bundle. Matches `factory.formalization-product-bundle.v1`.
 */
export const FORMALIZATION_PRODUCT_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.formalization-product-bundle.v1',
  '1.0.0',
);

/**
 * Output contract of the `model-use-cases` / `resolve-use-cases` node pair: the
 * canonical UC bundle. Matches `factory.formalization-use-case-bundle.v1`.
 */
export const FORMALIZATION_USE_CASE_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.formalization-use-case-bundle.v1',
  '1.0.0',
);

/**
 * Output contract of the `define-acceptance-contract` /
 * `resolve-acceptance-contract` node pair: the canonical AC bundle. Matches
 * `factory.formalization-acceptance-bundle.v1`.
 */
export const FORMALIZATION_ACCEPTANCE_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.formalization-acceptance-bundle.v1',
  '1.0.0',
);

/**
 * Output contract of the `reconcile-what` / `resolve-reconciliation` node pair:
 * the WHAT-side reconciliation report. Matches
 * `factory.formalization-reconciliation-report.v1`.
 */
export const FORMALIZATION_RECONCILIATION_CONTRACT: ContractRef = contractRef(
  'factory.formalization-reconciliation-report.v1',
  '1.0.0',
);

/**
 * Output contract of the `freeze-acceptance-baseline` kernel node: the
 * immutable acceptance-baseline snapshot. Matches
 * `factory.acceptance-baseline-snapshot.v1`.
 */
export const FORMALIZATION_ACCEPTANCE_BASELINE_CONTRACT: ContractRef = contractRef(
  'factory.acceptance-baseline-snapshot.v1',
  '1.0.0',
);

/**
 * Output contract of the `define-architecture-contract` /
 * `resolve-architecture-contract` node pair: the canonical SRS bundle. Matches
 * `factory.formalization-architecture-bundle.v1`.
 */
export const FORMALIZATION_ARCHITECTURE_BUNDLE_CONTRACT: ContractRef = contractRef(
  'factory.formalization-architecture-bundle.v1',
  '1.0.0',
);

/**
 * The intermediate settlement-input contract the settlement handler assembles
 * from the frozen graph. Matches `factory.formalization-settlement-input.v1`.
 */
export const FORMALIZATION_SETTLEMENT_INPUT_CONTRACT: ContractRef = contractRef(
  'factory.formalization-settlement-input.v1',
  '1.0.0',
);

// ---------------------------------------------------------------------------
// Module output + certificate contracts.
// ---------------------------------------------------------------------------

/**
 * The module's terminal output contract: the immutable
 * `FormalizationSolutionContractPayload` the settlement handler persists on the
 * `formalized` outcome. Matches `factory.solution-contract-certificate.v1`. The
 * manifest (W8-A1) carries this as `outputContractRef`.
 */
export const FORMALIZATION_OUTPUT_CONTRACT: ContractRef = contractRef(
  'factory.solution-contract-certificate.v1',
  '1.0.0',
);

/**
 * The certificate payload contract the generic ProcessOutcomeCertificate layer
 * wraps around the formalization decision. Matches
 * `factory.solution-contract-certificate.generic.v1`.
 */
export const FORMALIZATION_CERTIFICATE_CONTRACT: ContractRef = contractRef(
  'factory.solution-contract-certificate.generic.v1',
  '1.0.0',
);

/**
 * Every per-node bundle output contract the formalization flow emits, in flow
 * order. A downstream consumer (e.g. the development module's
 * DevelopmentCase builder) can iterate this to resolve every production the
 * module produced without hardcoding schema ids.
 */
export const FORMALIZATION_NODE_OUTPUT_CONTRACTS: readonly ContractRef[] = Object.freeze([
  FORMALIZATION_PRODUCT_BUNDLE_CONTRACT,
  FORMALIZATION_USE_CASE_BUNDLE_CONTRACT,
  FORMALIZATION_ACCEPTANCE_BUNDLE_CONTRACT,
  FORMALIZATION_RECONCILIATION_CONTRACT,
  FORMALIZATION_ACCEPTANCE_BASELINE_CONTRACT,
  FORMALIZATION_ARCHITECTURE_BUNDLE_CONTRACT,
  FORMALIZATION_SETTLEMENT_INPUT_CONTRACT,
]);

// ---------------------------------------------------------------------------
// Declared outcomes — the explicit ModuleCompletion surface (plan §7.5.6).
// ---------------------------------------------------------------------------

/**
 * One declared formalization outcome. The `outcome` code matches the flow's
 * terminal `complete-<code>` nodes and the `OutcomeDefinition` list in the
 * process-module definition; `terminal: true` marks every formalization
 * outcome as run-ending (the module never returns a non-terminal outcome).
 *
 * `description` mirrors `OutcomeDefinition.description` so a consumer can
 * render the outcome without dereferencing the process-module definition.
 */
export interface FormalizationDeclaredOutcome {
  readonly outcome: string;
  readonly terminal: boolean;
  readonly description: string;
}

/**
 * The full declared-outcome set. Each entry corresponds to one
 * `complete-<code>` kernel node and one `OutcomeDefinition` in the
 * formalization process module. The settlement handler (or, for early
 * clarification/inconsistent exits, a resolver) emits one of these; the
 * runtime's `ModuleCompletion` envelope carries the selected outcome verbatim.
 *
 * Order matches the `OutcomeDefinition` declaration order in
 * `formalization-process-module.ts` so the two surfaces stay aligned.
 */
export const FORMALIZATION_DECLARED_OUTCOMES: readonly FormalizationDeclaredOutcome[] = Object.freeze([
  {
    outcome: 'formalized',
    terminal: true,
    description: 'A complete frozen solution contract is ready for downstream work.',
  },
  {
    outcome: 'clarification-required',
    terminal: true,
    description: 'Required product or acceptance information is missing.',
  },
  {
    outcome: 'inconsistent',
    terminal: true,
    description: 'The contract graph contains unresolved contradictions or traceability gaps.',
  },
  {
    outcome: 'infeasible',
    terminal: true,
    description: 'The requested solution cannot be implemented under the accepted constraints.',
  },
  {
    outcome: 'failed',
    terminal: true,
    description: 'Formalization infrastructure could not produce an authoritative result.',
  },
]);

/**
 * The set of outcome codes, derived from {@link FORMALIZATION_DECLARED_OUTCOMES}.
 * Convenient for membership checks (e.g. validating that a settlement decision
 * is one of the declared outcomes) without iterating the full descriptors.
 */
export const FORMALIZATION_OUTCOME_CODES: readonly string[] = Object.freeze(
  FORMALIZATION_DECLARED_OUTCOMES.map((o) => o.outcome),
);
