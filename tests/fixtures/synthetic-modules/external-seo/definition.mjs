// @ts-check
/**
 * W0-A7 synthetic fixture: External-node module.
 *
 * Data-only fixture describing a `ProcessModuleDefinition`-shaped object for an
 * External node module. External nodes call an external provider (e.g. an SEO
 * API) through an adapter (plan §7.2, §4.4.7). This fixture declares an
 * adapter *reference* string only — `seo-api-adapter@1.0.0` — and ships no
 * real adapter code.
 *
 * This module is intentionally REUSED across two stages of the campaign
 * scenario (plan §6.8: "the same module may appear in multiple stages"). That
 * reuse is the core proof that the Runtime must not derive a stage from module
 * kind or task-kind prefix (plan §3.6, §6.8).
 *
 * Proof target:
 *   - Wave 1 SPI (External node `adapter` shape).
 *   - Wave 7 scenario runtime (same module reused in multiple stages).
 *   - Wave 10 SEO/Analytics production package mirrors this shape.
 *
 * Plan ref: §0.3.8, §6.8, §14.1.4, §15.11.
 *
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').ProcessModuleDefinition} ProcessModuleDefinition
 * @typedef {import('../../../../src/process-modules/domain/process-module.ts').FlowDefinition} FlowDefinition
 */

/** @type {Readonly<{ name: string; version: string }>} */
export const EXTERNAL_SEO_MODULE_REF = Object.freeze({
  name: 'synthetic-external-seo',
  version: '0.1.0',
});

export const EXTERNAL_SEO_INPUT_SCHEMA = 'synthetic.seo.input.v1';
export const EXTERNAL_SEO_OUTPUT_SCHEMA = 'synthetic.seo.output.v1';

/**
 * Exact versioned adapter reference (plan §5.5.10). Wave 2 binds this to the
 * external-adapter registry.
 */
export const SEO_API_ADAPTER_REF = 'seo-api-adapter@1.0.0';

/**
 * One FlowDefinition with one External node (`fetch-ranking`) referencing the
 * adapter above.
 *
 * @type {FlowDefinition}
 */
const externalSeoFlow = {
  id: 'synthetic.external-seo.standard',
  version: '0.1.0',
  entryNodeId: 'fetch-ranking',
  nodes: [
    {
      id: 'fetch-ranking',
      label: 'Fetch Ranking',
      kind: 'external',
      description:
        'Fetch current search-engine ranking for the campaign keywords from an external SEO API.',
      adapter: SEO_API_ADAPTER_REF,
      inputSchema: { id: EXTERNAL_SEO_INPUT_SCHEMA },
      outputSchema: { id: EXTERNAL_SEO_OUTPUT_SCHEMA },
      emitsOutcome: 'ranking-fetched',
    },
  ],
  transitions: [],
  terminalNodeIds: ['fetch-ranking'],
};

/**
 * The full data-only module fixture.
 *
 * @type {ProcessModuleDefinition}
 */
export const externalSeoModule = {
  identity: {
    ...EXTERNAL_SEO_MODULE_REF,
    kind: 'external-seo',
    displayName: 'Synthetic External SEO',
    description:
      'W0-A7 synthetic External-node fixture. Data-only — no real adapter. Reused across two campaign scenario stages to prove §6.8.',
  },
  inputContract: { id: EXTERNAL_SEO_INPUT_SCHEMA },
  outputContract: { id: EXTERNAL_SEO_OUTPUT_SCHEMA },
  outcomes: [
    {
      code: 'ranking-fetched',
      description: 'A ranking snapshot was fetched from the external SEO API.',
      terminal: true,
    },
  ],
  flow: externalSeoFlow,
  artifacts: [
    {
      type: 'synthetic.ranking-snapshot',
      schema: { id: EXTERNAL_SEO_OUTPUT_SCHEMA },
      authority: 'external',
      description: 'Opaque ranking snapshot envelope produced by the External node.',
    },
  ],
  policies: [],
  invariants: [],
  executionProfiles: [],
};

export const externalSeoResourceIndex = Object.freeze([
  { logicalId: 'input-schema', path: 'schemas/seo-input.schema.json', kind: 'schema' },
]);

export default externalSeoModule;
