// @ts-check
/**
 * W10-A1 — lm-marketing package contributions: resource index, handler refs,
 * contract refs.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a1.md`.
 *
 * Pure canonical data only (plan §3.5). This module assembles the
 * package-local contributions the manifest envelope carries:
 *   - `marketingResourceIndex`   — every skill, template, tracker, checklist,
 *                                  call-template and schema the package pins,
 *                                  with module-relative POSIX paths and the
 *                                  documented Wave-2 placeholder digest.
 *   - `marketingHandlerRefs`     — stable, content-addressed references to the
 *                                  handler the LM node hands off to. Handlers
 *                                  are NOT shipped in the manifest — only
 *                                  references (the LM-node executor resolves
 *                                  them by name).
 *   - `marketingInputContractRef`/
 *     `marketingOutputContractRef` — rich ContractRefs for the input/output
 *                                  schemas.
 *
 * The file imports ONLY the public process-module SPI from the compiled `dist/`
 * runtime surface — it never imports `src/index.ts`, `modules/catalog.ts`,
 * `tracker-view/`, the composition root, or any existing built-in module.
 *
 * @typedef {import('../../dist/process-modules/domain/spi/resource-index.js').ResourceIndexEntry} ResourceIndexEntry
 * @typedef {import('../../dist/process-modules/domain/spi/module-manifest.js').HandlerRef} HandlerRef
 * @typedef {import('../../dist/process-modules/domain/spi/contract-ref.js').ContractRef} ContractRef
 */

import { PENDING_DIGEST } from '../../dist/process-modules/domain/spi/module-manifest.js';
import { CONTRACT_REF_PENDING_DIGEST } from '../../dist/process-modules/domain/spi/contract-ref.js';
import {
  marketingResourcePaths,
  LM_MARKETING_INPUT_SCHEMA,
  LM_MARKETING_OUTPUT_SCHEMA,
} from './definition.mjs';

// ---------------------------------------------------------------------------
// Resource index.
//
// Built from the definition's declared paths so there is a single source of
// truth for WHAT the module pins (definition.mjs) and this file only adds the
// installer-facing `digest`. `digest` is the documented `'pending@wave-2'`
// placeholder: the Wave 2 content-addressed installer replaces it with
// `sha256Hex` of each resource's real bytes at install time.
// ---------------------------------------------------------------------------

/**
 * The full resource index for the lm-marketing package. Pinned by `logicalId`
 * (module-namespaced, unique within this manifest) so the runtime resolves
 * every resource through the package and never through global lookup
 * (WAVE10-EXTENSIBILITY-SPEC §4).
 *
 * @type {readonly ResourceIndexEntry[]}
 */
export const marketingResourceIndex = Object.freeze(
  marketingResourcePaths().map((entry) =>
    Object.freeze({
      logicalId: entry.logicalId,
      path: entry.path,
      kind: entry.kind,
      digest: PENDING_DIGEST,
    }),
  ),
);

// ---------------------------------------------------------------------------
// Handler refs.
//
// The `draft-campaign` LM node hands its writes off to a kernel handler named
// `marketing-resolve-campaign-draft`. The handler implementation is registered
// behind the installer's adapter registry (Wave 2+); here we carry only the
// stable, content-addressed reference. Mirrors the W9 DISCOVERY_HANDLER_REFS.
// ---------------------------------------------------------------------------

/** Module-owned handler id the draft-campaign node resolves through. */
export const MARKETING_HANDLER_IDS = Object.freeze({
  resolveCampaignDraft: 'marketing-resolve-campaign-draft',
});

/** Shared placeholder handler version (matches the module version's minor). */
const HANDLER_VERSION = '1.0.0';

/**
 * @param {string} logicalId
 * @returns {HandlerRef}
 */
function marketingHandlerRef(logicalId) {
  return Object.freeze({
    logicalId,
    version: HANDLER_VERSION,
    digest: PENDING_DIGEST,
  });
}

/**
 * The complete set of kernel handler references for the lm-marketing package.
 * @type {readonly HandlerRef[]}
 */
export const marketingHandlerRefs = Object.freeze([
  marketingHandlerRef(MARKETING_HANDLER_IDS.resolveCampaignDraft),
]);

// ---------------------------------------------------------------------------
// Contract refs.
//
// The input/output contracts of the lm-marketing package. `schemaId` matches
// the `inputContract.id` / `outputContract.id` on the wrapped definition;
// `version`/`digest` are the documented Wave-2 placeholders until the
// ContractSchemaRegistry (Wave 2/3) ships concrete codecs behind each schema id.
// ---------------------------------------------------------------------------

/**
 * @param {string} schemaId
 * @returns {ContractRef}
 */
function marketingContractRef(schemaId) {
  return Object.freeze({
    schemaId,
    version: '1.0.0',
    digest: CONTRACT_REF_PENDING_DIGEST,
  });
}

/** Input contract: one MarketingBrief. */
export const marketingInputContractRef = marketingContractRef(LM_MARKETING_INPUT_SCHEMA);

/** Output contract: the authoritative CampaignDraft. */
export const marketingOutputContractRef = marketingContractRef(LM_MARKETING_OUTPUT_SCHEMA);
