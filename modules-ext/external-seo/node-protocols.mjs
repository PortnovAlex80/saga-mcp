// @ts-check
/**
 * W10-A2 — NodeProtocolDefinitions for the external-seo flow nodes.
 *
 * A `NodeProtocolDefinition` (Wave 1 SPI, `domain/spi/node-protocol.ts`)
 * describes the ordered actions INSIDE a single flow node. The W0-A7 fixture
 * shipped none; this package ships a real protocol for the `fetch-ranking`
 * external node, validated at module load by `validateNodeProtocolDefinition`.
 *
 * The protocol is pure canonical data (plan §3.5): no functions, no closures.
 * The Runtime owns the ProtocolRun / ProtocolStepRun state machine; the package
 * only declares the steps, transitions, evidence requirements and retry
 * semantics. For an external node the protocol captures the provider call
 * lifecycle: validate input -> invoke provider -> verify output contract.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a2.md`.
 *
 * @typedef {import('../../dist/process-modules/domain/spi/node-protocol.js').NodeProtocolDefinition} NodeProtocolDefinition
 * @typedef {import('../../dist/process-modules/domain/spi/node-protocol.js').EvidenceRequirement} EvidenceRequirement
 * @typedef {import('../../dist/process-modules/domain/spi/contract-ref.js').ContractRef} ContractRef
 */

import {
  EXTERNAL_SEO_INPUT_SCHEMA,
  EXTERNAL_SEO_OUTPUT_SCHEMA,
} from './definition.mjs';

/**
 * Input contract reference for the protocol's input-validation evidence.
 * Uses the documented pending digest placeholder until the codec registry
 * content-addresses the schema document (the manifest computes the real
 * resource digest separately).
 * @type {ContractRef}
 */
const INPUT_CONTRACT_REF = {
  schemaId: EXTERNAL_SEO_INPUT_SCHEMA,
  version: '1.0.0',
  digest: 'pending@wave-2',
};

/**
 * Output contract reference for the protocol's output-verification evidence.
 * @type {ContractRef}
 */
const OUTPUT_CONTRACT_REF = {
  schemaId: EXTERNAL_SEO_OUTPUT_SCHEMA,
  version: '1.0.0',
  digest: 'pending@wave-2',
};

/**
 * The NodeProtocolDefinition for the `fetch-ranking` external node.
 *
 * Three steps:
 *   1. `validate-input`   — assert the request matches the input contract.
 *   2. `invoke-provider`  — dispatch the external adapter (registry-resolved).
 *   3. `verify-output`    — assert the snapshot matches the output contract;
 *                           the terminal evidence requirement is the external
 *                           ranking receipt.
 *
 * Retry semantics: the runtime retries with linear backoff (plan §8.2.11) —
 * external providers are idempotent for read-only ranking fetches.
 *
 * @type {NodeProtocolDefinition}
 */
export const fetchRankingNodeProtocol = {
  id: 'ext.external-seo.fetch-ranking.protocol',
  version: '1.0.0',
  owningFlowNodeId: 'fetch-ranking',
  entryStep: 'validate-input',
  steps: [
    {
      id: 'validate-input',
      instructions:
        'Validate the ranking request against the ext.external-seo.ranking-input.v1 contract: keywords non-empty, searchEngine supported, locale well-formed.',
      resources: ['schemas/seo-ranking-input.schema.json'],
      allowedTools: [],
      evidenceRequirements: [
        {
          category: 'module-verifier-receipt',
          contractRef: INPUT_CONTRACT_REF,
          required: true,
        },
      ],
    },
    {
      id: 'invoke-provider',
      instructions:
        'Dispatch the seo-ranking-adapter@1.0.0 adapter registered under the ExternalAdapterRegistry. The adapter owns the provider protocol; the runtime only resolves the versioned id.',
      resources: ['resources/fetch-ranking-checklist.md'],
      allowedTools: [],
      evidenceRequirements: [
        {
          category: 'external-receipt',
          contractRef: OUTPUT_CONTRACT_REF,
          required: true,
        },
      ],
    },
    {
      id: 'verify-output',
      instructions:
        'Verify the produced ranking snapshot against the ext.external-seo.ranking-snapshot.v1 contract: every requested keyword has exactly one rank entry with a positive position and a valid URL.',
      resources: ['schemas/seo-ranking-output.schema.json'],
      allowedTools: [],
      evidenceRequirements: [
        {
          category: 'artifact-reference',
          contractRef: OUTPUT_CONTRACT_REF,
          required: true,
        },
      ],
    },
  ],
  transitions: [
    { from: 'validate-input', to: 'invoke-provider', kind: 'linear' },
    { from: 'invoke-provider', to: 'verify-output', kind: 'linear' },
  ],
  nodeCompletionEvidence: [
    {
      category: 'external-receipt',
      contractRef: OUTPUT_CONTRACT_REF,
      required: true,
    },
  ],
  recoveryEntrySteps: ['invoke-provider'],
  retrySemantics: 'runtime-implemented-linear',
};

/**
 * All NodeProtocolDefinitions exported by this package, keyed by owning flow
 * node id. Consumed by `manifest.mjs` (validation) and surfaced to operators.
 */
export const externalSeoNodeProtocols = Object.freeze([fetchRankingNodeProtocol]);

export default fetchRankingNodeProtocol;
