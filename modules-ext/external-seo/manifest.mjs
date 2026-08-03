// @ts-check
/**
 * W10-A2 — Central ProcessModuleManifest for the External SEO/Analytics package.
 *
 * This is the single object an installer receives: it wraps the pure
 * {@link externalSeoProcessModule} definition (definition.mjs) and declares the
 * pinned resources, adapter refs, contract refs, and runtime compatibility
 * range. It is validated at module load by the Wave 1 SPI
 * `validateProcessModuleManifest` (domain/spi/module-manifest.js) — a structural
 * regression throws synchronously.
 *
 * §0.13.10 PROOF — the import list:
 *   This file imports ONLY from the compiled runtime SPI under `dist/`:
 *     - validateProcessModuleManifest   (domain/spi/module-manifest.js)
 *     - validateNodeProtocolDefinition  (domain/spi/node-protocol.js)
 *     - ExternalAdapterRegistry type    (application/external-adapter-registry.js)
 *     - sha256Hex                       (shared/canonical-json.js)
 *   It NEVER imports `src/index.ts`, `modules/catalog.ts`, the composition
 *   root, or any built-in module implementation. That import list IS the
 *   extensibility proof: the package installs against the SPI alone.
 *
 * Content-addressing:
 *   Unlike the W0-A7 fixture (which used the `pending@wave-2` digest
 *   placeholder everywhere), this package computes REAL `sha256Hex` digests of
 *   its resource files at load time. This proves the package is a genuine
 *   content-addressed artifact, not a placeholder.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`.
 * Task: `docs/refactor-management/05-subagent-tasks/W10-a2.md`.
 *
 * @typedef {import('../../dist/process-modules/domain/spi/module-manifest.js').ProcessModuleManifest} ProcessModuleManifest
 * @typedef {import('../../dist/process-modules/domain/spi/module-manifest.js').HandlerRef} HandlerRef
 * @typedef {import('../../dist/process-modules/domain/spi/module-manifest.js').ResourceIndexEntry} ResourceIndexEntry
 * @typedef {import('../../dist/process-modules/domain/spi/module-manifest.js').ValidationResult} ValidationResult
 * @typedef {import('../../dist/process-modules/domain/spi/contract-ref.js').ContractRef} ContractRef
 * @typedef {import('../../dist/process-modules/domain/spi/node-protocol.js').NodeProtocolDefinition} NodeProtocolDefinition
 * @typedef {import('../../dist/process-modules/application/external-adapter-registry.js').ExternalAdapter} ExternalAdapter
 * @typedef {import('../../dist/process-modules/application/external-adapter-registry.js').ExternalAdapterRegistry} ExternalAdapterRegistry
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validateProcessModuleManifest } from '../../dist/process-modules/domain/spi/module-manifest.js';
import { validateNodeProtocolDefinition } from '../../dist/process-modules/domain/spi/node-protocol.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

import {
  externalSeoProcessModule,
  EXTERNAL_SEO_INPUT_SCHEMA,
  EXTERNAL_SEO_OUTPUT_SCHEMA,
  EXTERNAL_SEO_MODULE_REF,
  EXTERNAL_SEO_MODULE_KEY,
  SEO_RANKING_ADAPTER_REF,
} from './definition.mjs';
import { externalSeoNodeProtocols } from './node-protocols.mjs';
import { seoRankingAdapter } from './adapter.mjs';

// ---------------------------------------------------------------------------
// Manifest format + runtime identity.
// ---------------------------------------------------------------------------

/**
 * Format version of THIS manifest envelope. `'1'` signals the envelope wraps a
 * ProcessModuleDefinition that populates `resourceIndex` / `handlerRefs`
 * (mirrors the Wave 8/9 production modules).
 */
export const EXTERNAL_SEO_MANIFEST_FORMAT_VERSION = '1';

/**
 * Runtime API compatibility range this package requires. Built against the
 * saga 3.x process-module SPI; valid for any 3.x runtime.
 */
export const EXTERNAL_SEO_RUNTIME_COMPATIBILITY_RANGE = '^3.0.0';

// ---------------------------------------------------------------------------
// Content-addressed resource index.
//
// REAL digests: each entry's `digest` is `sha256Hex` of the resource file's
// raw UTF-8 content, computed at load time. This upgrades the W0-A7 fixture
// (which used the `pending@wave-2` placeholder) into a genuine
// content-addressed package. The Wave 2 installer can verify each entry
// against the bytes on disk.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read a package-relative resource file and compute its sha256Hex digest.
 * @param {string} relPath module-relative POSIX path
 * @returns {{path:string;digest:string}}
 */
function resource(relPath) {
  const fullPath = path.join(HERE, relPath);
  const bytes = readFileSync(fullPath, 'utf8');
  return { path: relPath, digest: sha256Hex(bytes) };
}

const INPUT_SCHEMA_RESOURCE = resource('schemas/seo-ranking-input.schema.json');
const OUTPUT_SCHEMA_RESOURCE = resource('schemas/seo-ranking-output.schema.json');
const CHECKLIST_RESOURCE = resource('resources/fetch-ranking-checklist.md');
const DESCRIPTION_RESOURCE = resource('resources/package-description.md');

/**
 * The full content-addressed resource index for the external-seo package.
 * Pinned by `logicalId` (module-namespaced, unique within this manifest).
 * @type {readonly ResourceIndexEntry[]}
 */
export const EXTERNAL_SEO_RESOURCE_INDEX = Object.freeze([
  {
    logicalId: 'external-seo.schema.input',
    path: INPUT_SCHEMA_RESOURCE.path,
    kind: 'schema',
    digest: INPUT_SCHEMA_RESOURCE.digest,
  },
  {
    logicalId: 'external-seo.schema.output',
    path: OUTPUT_SCHEMA_RESOURCE.path,
    kind: 'schema',
    digest: OUTPUT_SCHEMA_RESOURCE.digest,
  },
  {
    logicalId: 'external-seo.checklist.fetch-ranking',
    path: CHECKLIST_RESOURCE.path,
    kind: 'checklist',
    digest: CHECKLIST_RESOURCE.digest,
  },
  {
    logicalId: 'external-seo.description.package',
    path: DESCRIPTION_RESOURCE.path,
    kind: 'description',
    digest: DESCRIPTION_RESOURCE.digest,
  },
]);

// ---------------------------------------------------------------------------
// Adapter refs.
//
// Stable, content-addressed references to the external adapter the flow node
// pins. The implementation ships in `adapter.mjs` and is registered under the
// versioned id via `ExternalAdapterRegistry`. The digest is the sha256Hex of
// the adapter module's canonical source — proving the implementation is
// content-addressed alongside its declaration.
// ---------------------------------------------------------------------------

const ADAPTER_SOURCE_DIGEST = sha256Hex(readFileSync(path.join(HERE, 'adapter.mjs'), 'utf8'));

/**
 * The adapter reference declared by the `fetch-ranking` external node. The
 * `logicalId` matches `node.adapter` on the flow node; the registry resolves it
 * to the shipped `seoRankingAdapter`.
 * @type {HandlerRef}
 */
export const EXTERNAL_SEO_ADAPTER_REF = Object.freeze({
  logicalId: SEO_RANKING_ADAPTER_REF,
  version: '1.0.0',
  digest: ADAPTER_SOURCE_DIGEST,
});

/**
 * All handler/adapter references for this package. External modules reference
 * adapters (not kernel handlers), but they ride the same `handlerRefs` envelope
 * so the manifest shape is uniform across node kinds (plan §3.6).
 */
export const EXTERNAL_SEO_HANDLER_REFS = Object.freeze([EXTERNAL_SEO_ADAPTER_REF]);

// ---------------------------------------------------------------------------
// Contract refs.
//
// Input/output contract references. `schemaId` matches the wrapped
// definition's inputContract/outputContract ids; `version`/`digest` use the
// documented pending placeholder until the ContractSchemaRegistry (W1-A5)
// ships concrete codecs behind each schema id. The real resource digests above
// already content-address the schema DOCUMENTS; the contract-ref digest will
// pin the codec once it lands.
// ---------------------------------------------------------------------------

/**
 * Build a ContractRef for an external-seo schema id.
 * @param {string} schemaId
 * @returns {ContractRef}
 */
function externalSeoContractRef(schemaId) {
  return { schemaId, version: '1.0.0', digest: 'pending@wave-2' };
}

/** Input contract: the ranking snapshot request. */
export const EXTERNAL_SEO_INPUT_CONTRACT_REF = externalSeoContractRef(EXTERNAL_SEO_INPUT_SCHEMA);

/** Output contract: the ranking snapshot envelope. */
export const EXTERNAL_SEO_OUTPUT_CONTRACT_REF = externalSeoContractRef(EXTERNAL_SEO_OUTPUT_SCHEMA);

// ---------------------------------------------------------------------------
// Adapter contribution (the shipped implementation).
//
// The package ships the adapter implementation alongside its reference. The
// `register` helper binds it onto an ExternalAdapterRegistry so a composition
// root (or test) can dispatch the fetch-ranking node without touching src/.
// ---------------------------------------------------------------------------

/**
 * Adapter implementations keyed by their versioned registry id. The composition
 * root registers these onto an `ExternalAdapterRegistry` before running the
 * module; the runtime then resolves `node.adapter` through the registry.
 * @type {Readonly<Record<string, ExternalAdapter>>}
 */
export const EXTERNAL_SEO_ADAPTERS = Object.freeze({
  [SEO_RANKING_ADAPTER_REF]: seoRankingAdapter,
});

/**
 * Register every shipped adapter onto an ExternalAdapterRegistry. Returns the
 * registry for chaining. This is the single integration point a composition
 * root calls; everything else is read-only manifest data.
 *
 * @param {ExternalAdapterRegistry} registry
 * @returns {ExternalAdapterRegistry}
 */
export function registerExternalSeoAdapters(registry) {
  registry.registerAll(EXTERNAL_SEO_ADAPTERS);
  return registry;
}

// ---------------------------------------------------------------------------
// Central manifest — validated at module load.
// ---------------------------------------------------------------------------

/**
 * Validate the node protocols at load. A structural regression (unknown step,
 * unsupported retry semantics, dangling transition) throws synchronously.
 */
function validateNodeProtocols() {
  for (const protocol of externalSeoNodeProtocols) {
    /** @type {ValidationResult} */
    const result = validateNodeProtocolDefinition(protocol);
    if (!result.ok) {
      const rendered = result.errors
        .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
        .join('\n');
      throw new Error(
        `external-seo node protocol '${protocol.id}' failed validation:\n${rendered}`,
      );
    }
  }
}

/**
 * The central, validated ProcessModuleManifest for the External SEO/Analytics
 * package. Validated at module load by `validateProcessModuleManifest`; a
 * structural regression throws synchronously and fails the importing test.
 * @type {ProcessModuleManifest}
 */
export const externalSeoManifest = (() => {
  /** @type {ProcessModuleManifest} */
  const manifest = {
    manifestFormatVersion: EXTERNAL_SEO_MANIFEST_FORMAT_VERSION,
    definition: externalSeoProcessModule,
    resourceIndex: EXTERNAL_SEO_RESOURCE_INDEX,
    handlerRefs: EXTERNAL_SEO_HANDLER_REFS,
    inputContractRef: EXTERNAL_SEO_INPUT_CONTRACT_REF,
    outputContractRef: EXTERNAL_SEO_OUTPUT_CONTRACT_REF,
    runtimeCompatibilityRange: EXTERNAL_SEO_RUNTIME_COMPATIBILITY_RANGE,
  };
  /** @type {ValidationResult} */
  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    const rendered = validation.errors
      .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
      .join('\n');
    throw new Error(
      `external-seo package manifest failed validation:\n${rendered}`,
    );
  }
  // Validate node protocols alongside the manifest envelope.
  validateNodeProtocols();
  return manifest;
})();

export default externalSeoManifest;
