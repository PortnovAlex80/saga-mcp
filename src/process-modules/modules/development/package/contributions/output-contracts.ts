/**
 * W9-A4 — Development package-local output contracts.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE9-PRODUCTION-MIGRATION-SPEC.md.
 * Plan: §0.12.6 (W9-A4), §7.6 (NodeProductionEnvelope), §13.20
 *       (ProcessModuleOutputEnvelope), §7.5.6 (ModuleCompletion).
 *
 * This file declares the exact product/output contracts the Development package
 * emits, as pure Wave 1 SPI data:
 *
 *   - `ContractRef` for every input/output/bundle/certificate schema the
 *     module speaks. These are the schema identities the development kernel
 *     handlers, external adapters and settlement policy produce; the manifest
 *     carries the top-level input/output pair, and this file declares the full
 *     per-node bundle set so a downstream consumer (the lifecycle mapper, the
 *     delivery module's ReleaseCase builder) can resolve every production the
 *     module emits.
 *   - The module's declared `ModuleCompletion` outcome set, mapping each
 *     terminal development outcome to its `terminal` flag. This is the explicit
 *     completion envelope (plan §7.5.6) that replaces the legacy magic
 *     certificate bindings: the settlement handler emits one of these outcomes,
 *     and the runtime knows from `terminal: true` that the run is done.
 *
 * The schema ids mirror `development-schemas.ts` and the saga3 domain schema
 * constants exactly — this file is the package-local CONTRACT surface (the
 * `ContractRef` digests the runtime content-addresses), while the saga3 domain
 * modules remain the implementation-layer type declarations. Keeping them
 * separate lets the manifest carry contract refs without importing the
 * implementation module into the domain SPI.
 *
 * PURE DATA: readonly constants typed by the Wave 1 SPI. No behavior.
 */

import type { ContractRef } from '../../../../domain/spi/contract-ref.js';

// ---------------------------------------------------------------------------
// Contract-ref minter.
// ---------------------------------------------------------------------------

/**
 * Placeholder digest helper. Wave 9 does not yet register concrete JSON schemas
 * with the ContractSchemaRegistry (wiring lands at the Wave 11 composition-root
 * cutover). Until then contract refs carry the documented `'pending@wave-2'`
 * digest so the manifest round-trips and the canonical-serialization gate
 * accepts the declarations. The `schemaId` is the real saga3 schema identity so
 * the runtime can resolve it once a codec is registered.
 */
function contractRef(schemaId: string, version: string): ContractRef {
  return { schemaId, version, digest: 'pending@wave-2' };
}

// ---------------------------------------------------------------------------
// Input contract — the DevelopmentCase bound to a formalization certificate.
// ---------------------------------------------------------------------------

/**
 * The module's input contract: one `DevelopmentCase` binding a formalization
 * certificate, accepted baseline, SRS and repository bases to a development
 * episode. Matches `saga3.development-case.v1` (the `inputContract` on
 * `development-process-module.ts`).
 */
export const DEVELOPMENT_INPUT_CONTRACT: ContractRef = contractRef(
  'saga3.development-case.v1',
  '1.0.0',
);

// ---------------------------------------------------------------------------
// Per-node bundle output contracts — the products each flow stage emits.
// ---------------------------------------------------------------------------

/**
 * Output contract of the `plan-task-graph` LM node: the advisory task-graph
 * proposal. Matches `saga3.development-task-graph-proposal.v1`. Advisory only —
 * it has no execution authority until kernel resolution.
 */
export const DEVELOPMENT_TASK_GRAPH_PROPOSAL_CONTRACT: ContractRef = contractRef(
  'saga3.development-task-graph-proposal.v1',
  '1.0.0',
);

/**
 * Output contract of the `resolve-task-graph` kernel node: the canonical,
 * coverage-complete, acyclic task and integration graph. Matches
 * `saga3.development-task-graph.v1`.
 */
export const DEVELOPMENT_TASK_GRAPH_CONTRACT: ContractRef = contractRef(
  'saga3.development-task-graph.v1',
  '1.0.0',
);

/**
 * Output contract of the `execute-implementation-workset` external adapter: the
 * durable implementation and independent-review workset. Matches
 * `saga3.development-implementation-workset.v1`.
 */
export const DEVELOPMENT_IMPLEMENTATION_WORKSET_CONTRACT: ContractRef = contractRef(
  'saga3.development-implementation-workset.v1',
  '1.0.0',
);

/**
 * Output contract of the `integrate-release-candidate` external adapter: the
 * frozen repository commits, tree hashes and build digests. Matches
 * `saga3.integrated-release-candidate.v1`.
 */
export const DEVELOPMENT_INTEGRATED_CANDIDATE_CONTRACT: ContractRef = contractRef(
  'saga3.integrated-release-candidate.v1',
  '1.0.0',
);

/**
 * Output contract of the `verify-acceptance-workset` external adapter: the
 * trusted acceptance-verification evidence bound to the exact frozen candidate
 * hash. Matches `saga3.acceptance-verification-workset.v1`.
 */
export const DEVELOPMENT_ACCEPTANCE_VERIFICATION_CONTRACT: ContractRef = contractRef(
  'saga3.acceptance-verification-workset.v1',
  '1.0.0',
);

/**
 * The intermediate settlement-input contract the settlement handler assembles
 * from the re-read durable products. Matches
 * `saga3.development-settlement-input.v1`.
 */
export const DEVELOPMENT_SETTLEMENT_INPUT_CONTRACT: ContractRef = contractRef(
  'saga3.development-settlement-input.v1',
  '1.0.0',
);

// ---------------------------------------------------------------------------
// Module output + certificate contracts.
// ---------------------------------------------------------------------------

/**
 * The module's terminal output contract: the immutable
 * `VerifiedIntegrationBundle` the settlement handler persists on the `verified`
 * outcome — the canonical Development output consumed by Delivery/Release.
 * Matches `saga3.verified-integration-bundle.v1`. The manifest carries this as
 * `outputContractRef`.
 */
export const DEVELOPMENT_OUTPUT_CONTRACT: ContractRef = contractRef(
  'saga3.verified-integration-bundle.v1',
  '1.0.0',
);

/**
 * The certificate payload contract the settlement handler issues: the immutable
 * development decision + exact product-lineage hashes. Matches
 * `saga3.development-certificate.v1`.
 */
export const DEVELOPMENT_CERTIFICATE_CONTRACT: ContractRef = contractRef(
  'saga3.development-certificate.v1',
  '1.0.0',
);

/**
 * The certificate payload contract the generic ProcessOutcomeCertificate layer
 * wraps around the development decision. Matches
 * `saga3.development-certificate.generic.v1`.
 */
export const DEVELOPMENT_CERTIFICATE_GENERIC_CONTRACT: ContractRef = contractRef(
  'saga3.development-certificate.generic.v1',
  '1.0.0',
);

/**
 * Every per-node bundle output contract the development flow emits, in flow
 * order (plan → resolve → implement → integrate → verify → settlement-input).
 * A downstream consumer (e.g. the delivery module's ReleaseCase builder) can
 * iterate this to resolve every production the module produced without
 * hardcoding schema ids.
 *
 * The terminal verified-integration-bundle + certificate are carried separately
 * as `DEVELOPMENT_OUTPUT_CONTRACT` / `DEVELOPMENT_CERTIFICATE_CONTRACT`.
 */
export const DEVELOPMENT_NODE_OUTPUT_CONTRACTS: readonly ContractRef[] = Object.freeze([
  DEVELOPMENT_TASK_GRAPH_PROPOSAL_CONTRACT,
  DEVELOPMENT_TASK_GRAPH_CONTRACT,
  DEVELOPMENT_IMPLEMENTATION_WORKSET_CONTRACT,
  DEVELOPMENT_INTEGRATED_CANDIDATE_CONTRACT,
  DEVELOPMENT_ACCEPTANCE_VERIFICATION_CONTRACT,
  DEVELOPMENT_SETTLEMENT_INPUT_CONTRACT,
]);

// ---------------------------------------------------------------------------
// Declared outcomes — the explicit ModuleCompletion surface (plan §7.5.6).
// ---------------------------------------------------------------------------

/**
 * One declared development outcome. The `outcome` code matches the flow's
 * terminal `complete-<code>` nodes and the `OutcomeDefinition` list in the
 * process-module definition; `terminal: true` marks every development outcome
 * as run-ending (the module never returns a non-terminal outcome).
 *
 * `description` mirrors `OutcomeDefinition.description` so a consumer can render
 * the outcome without dereferencing the process-module definition.
 */
export interface DevelopmentDeclaredOutcome {
  readonly outcome: string;
  readonly terminal: boolean;
  readonly description: string;
}

/**
 * The full declared-outcome set. Each entry corresponds to one `complete-<code>`
 * kernel node and one `OutcomeDefinition` in the development process module.
 * The settlement handler emits one of these; the runtime's `ModuleCompletion`
 * envelope carries the selected outcome verbatim.
 *
 * Order matches the `OutcomeDefinition` declaration order in
 * `development-process-module.ts` so the two surfaces stay aligned.
 */
export const DEVELOPMENT_DECLARED_OUTCOMES: readonly DevelopmentDeclaredOutcome[] = Object.freeze([
  {
    outcome: 'verified',
    terminal: true,
    description:
      'All required implementation and acceptance evidence binds to the unchanged frozen candidate.',
  },
  {
    outcome: 'rework-required',
    terminal: true,
    description:
      'Implementation, review or acceptance evidence found a product defect that requires a new work cycle.',
  },
  {
    outcome: 'clarification-required',
    terminal: true,
    description:
      'The accepted decomposition cannot be converted into a complete, deterministic task graph.',
  },
  {
    outcome: 'blocked',
    terminal: true,
    description:
      'Required work, trusted evidence, integration state or a human decision is unavailable.',
  },
  {
    outcome: 'failed',
    terminal: true,
    description: 'Development infrastructure or immutable lineage validation failed.',
  },
]);

/**
 * The set of outcome codes, derived from {@link DEVELOPMENT_DECLARED_OUTCOMES}.
 * Convenient for membership checks (e.g. validating that a settlement decision
 * is one of the declared outcomes) without iterating the full descriptors.
 */
export const DEVELOPMENT_OUTCOME_CODES: readonly string[] = Object.freeze(
  DEVELOPMENT_DECLARED_OUTCOMES.map((o) => o.outcome),
);
