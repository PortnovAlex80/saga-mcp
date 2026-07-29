// @ts-check
/**
 * W10-A2 — External SEO/Analytics Process Module DEFINITION.
 *
 * Production-grade upgrade of the W0-A7 synthetic external-seo fixture
 * (`tests/fixtures/synthetic-modules/external-seo/definition.mjs`). The fixture
 * was data-only and declared an adapter *reference* string with no real
 * adapter. This package upgrades it into a full installable External-node
 * module: a real `ProcessModuleDefinition` plus a real `ExternalAdapter`
 * (shipped in `adapter.mjs`) plus a real `NodeProtocolDefinition` (shipped in
 * `node-protocols.mjs`).
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a2.md`.
 *
 * PROOF TARGET (§0.13.10):
 *   - This file imports ONLY the pure ProcessModuleDefinition / FlowDefinition
 *     TYPE shapes (via JSDoc) from the runtime SPI. It defines pure data.
 *   - The manifest (`manifest.mjs`) imports the SPI validators + adapter
 *     registry from `dist/` and validates this definition at load.
 *   - No import reaches `src/index.ts`, `modules/catalog.ts`, or any built-in
 *     module implementation. That import list IS the extensibility proof.
 *
 * Plan ref: §0.13.10, §3.6 (Runtime is module-kind-agnostic), §6.8 (a module
 * may be reused across multiple scenario stages), §7.2 / §4.4.7 (external
 * adapter shape).
 *
 * @typedef {import('../../dist/process-modules/domain/process-module.js').ProcessModuleDefinition} ProcessModuleDefinition
 * @typedef {import('../../dist/process-modules/domain/process-module.js').FlowDefinition} FlowDefinition
 * @typedef {import('../../dist/process-modules/domain/process-module.js').ProcessModuleReference} ProcessModuleReference
 */

// ---------------------------------------------------------------------------
// Identity + schema ids.
//
// Schema ids match the `$id` of the JSON Schema documents under `schemas/`.
// They are the load-bearing contract strings; the matching canonical schema
// documents are content-addressed by `manifest.mjs` via `sha256Hex`.
// ---------------------------------------------------------------------------

/**
 * Canonical `name@version` identity of this package.
 * @type {const}
 * @readonly
 */
export const EXTERNAL_SEO_MODULE_REF = Object.freeze({
  name: 'external-seo',
  version: '1.0.0',
});

/** `name@version` key the runtime indexes installations by. */
export const EXTERNAL_SEO_MODULE_KEY =
  `${EXTERNAL_SEO_MODULE_REF.name}@${EXTERNAL_SEO_MODULE_REF.version}`;

/**
 * Exact versioned adapter reference (plan §5.5.10). The flow node pins this
 * string; the package registers the matching implementation under it via
 * `ExternalAdapterRegistry` (see `manifest.mjs`).
 */
export const SEO_RANKING_ADAPTER_REF = 'seo-ranking-adapter@1.0.0';

/** Input contract schema id (matches schemas/seo-ranking-input.schema.json). */
export const EXTERNAL_SEO_INPUT_SCHEMA = 'ext.external-seo.ranking-input.v1';

/** Output contract schema id (matches schemas/seo-ranking-output.schema.json). */
export const EXTERNAL_SEO_OUTPUT_SCHEMA = 'ext.external-seo.ranking-snapshot.v1';

/**
 * The single outcome this module emits. External ranking fetch is terminal:
 * the node produces a ranking snapshot and the run settles on `ranking-fetched`.
 */
export const EXTERNAL_SEO_OUTCOME = Object.freeze({
  code: 'ranking-fetched',
  description:
    'A ranking snapshot was fetched from the external SEO provider and content-addressed.',
  terminal: true,
});

/**
 * One FlowDefinition with one External node (`fetch-ranking`) referencing the
 * versioned adapter above. The Runtime dispatches the node by `kind: 'external'`
 * and resolves `adapter` through the ExternalAdapterRegistry — it never switches
 * on the module name (plan §3.6).
 *
 * @type {FlowDefinition}
 */
const externalSeoFlow = {
  id: 'ext.external-seo.standard',
  version: '1.0.0',
  entryNodeId: 'fetch-ranking',
  nodes: [
    {
      id: 'fetch-ranking',
      label: 'Fetch Ranking',
      kind: 'external',
      description:
        'Fetch current search-engine ranking for the campaign keywords from an external SEO provider and produce a content-addressed ranking snapshot.',
      adapter: SEO_RANKING_ADAPTER_REF,
      inputSchema: { id: EXTERNAL_SEO_INPUT_SCHEMA },
      outputSchema: { id: EXTERNAL_SEO_OUTPUT_SCHEMA },
      emitsOutcome: EXTERNAL_SEO_OUTCOME.code,
    },
  ],
  transitions: [],
  terminalNodeIds: ['fetch-ranking'],
};

/**
 * The full pure ProcessModuleDefinition for the External SEO/Analytics package.
 *
 * Pure data only (plan §3.5): every field is canonically serializable. The
 * manifest wraps this definition and runs `validateProcessModuleManifest` at
 * module load; a structural regression throws synchronously.
 *
 * @type {ProcessModuleDefinition}
 */
export const externalSeoProcessModule = {
  identity: {
    ...EXTERNAL_SEO_MODULE_REF,
    kind: 'external-seo',
    displayName: 'External SEO/Analytics',
    description:
      'Installable External-node package: fetches keyword ranking snapshots from an external SEO provider. Upgrades the W0-A7 synthetic fixture into a real package with a real adapter and node protocol.',
  },
  inputContract: { id: EXTERNAL_SEO_INPUT_SCHEMA },
  outputContract: { id: EXTERNAL_SEO_OUTPUT_SCHEMA },
  outcomes: [EXTERNAL_SEO_OUTCOME],
  flow: externalSeoFlow,
  artifacts: [
    {
      type: 'ext.ranking-snapshot',
      schema: { id: EXTERNAL_SEO_OUTPUT_SCHEMA },
      authority: 'external',
      description:
        'Content-addressed ranking snapshot envelope produced by the External node.',
    },
  ],
  policies: [],
  invariants: [
    {
      id: 'ext.external-seo.adapter-pinned',
      description:
        'The fetch-ranking node must reference the exact versioned adapter seo-ranking-adapter@1.0.0; the runtime must resolve it through the ExternalAdapterRegistry and never through module-name lookup.',
      enforcement: 'static',
    },
  ],
  executionProfiles: [],
};

export default externalSeoProcessModule;
