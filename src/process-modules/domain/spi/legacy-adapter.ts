/**
 * W1-A7 — LegacyProcessModuleAdapter.
 *
 * Pure adapter (no class, no behavior) that wraps an existing
 * `ProcessModuleDefinition` — which already lacks the new manifest fields —
 * into a `ProcessModuleManifest` with empty/optional new fields.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` §1 row 15.
 * Plan ref: §14.2.4.
 *
 * The produced manifest is a uniformly-shaped pure envelope: legacy modules are
 * NOT marked with a `legacy: true` boolean (that would split the manifest
 * shape). Instead `manifestFormatVersion: 'legacy-0'` is the sole signal that
 * the envelope wraps a legacy definition with no declared resources/handlers.
 * Wave 8/9 migrate legacy modules to populate `resourceIndex` / `handlerRefs`
 * and bump the format version; until then both arrays are empty by design.
 *
 * The result MUST pass `validateProcessModuleManifest` (imported from W1-A2),
 * which enforces canonical serializability (no functions / Map / Set / undefined
 * in arrays / class instances / Symbols / non-finite numbers — plan §3.5).
 */

import type { ProcessModuleDefinition, SchemaReference } from '../process-module.js';
import type { ContractRef } from './contract-ref.js';
import type { ProcessModuleManifest } from './module-manifest.js';
import { validateProcessModuleManifest } from './module-manifest.js';

/**
 * Manifest format version emitted by this adapter.
 *
 * `'legacy-0'` signals: the envelope wraps a legacy `ProcessModuleDefinition`
 * that carries no declared `resourceIndex` / `handlerRefs`. Wave 8/9 replace
 * this with a populated `'1'` manifest when a module is migrated.
 */
export const LEGACY_MANIFEST_FORMAT_VERSION = 'legacy-0';

/**
 * Runtime compatibility range for legacy module envelopes.
 *
 * Legacy definitions were authored against the saga 2.x process-module SPI;
 * the 3.x cutover (Wave 11) is the earliest point they may stop validating.
 */
export const LEGACY_RUNTIME_COMPATIBILITY_RANGE = '>=2.0.0 <3.0.0';

/**
 * Placeholder digest used by the legacy adapter for every derived
 * `ContractRef`. Real content digests arrive in Wave 2 once the
 * `ContractSchemaRegistry` (W1-A5) ships concrete codecs behind each schema id.
 */
export const LEGACY_CONTRACT_DIGEST = 'pending@wave-2';

/**
 * Version string stamped onto every legacy-derived `ContractRef`. Legacy
 * `SchemaReference` carries only `{ id }` with no version field, so the adapter
 * records the literal `'legacy'` sentinel until migration attaches a real
 * schema version.
 */
export const LEGACY_CONTRACT_VERSION = 'legacy';

/**
 * Options for {@link adaptLegacyProcessModule}.
 */
export interface AdaptLegacyProcessModuleOptions {
  /**
   * Override the emitted `manifestFormatVersion`. Defaults to
   * {@link LEGACY_MANIFEST_FORMAT_VERSION} (`'legacy-0'`). Callers SHOULD NOT
   * override this unless they are migrating a module and have populated the
   * resource/handler arrays themselves (out of scope for Wave 1).
   */
  manifestFormatVersion?: string;
}

/**
 * Derive a {@link ContractRef} from a legacy {@link SchemaReference}.
 *
 * Legacy schema references carry only `{ id }`; the adapter stamps the version
 * sentinel `'legacy'` and the placeholder digest `'pending@wave-2'` until Wave
 * 2 ships a real `ContractSchemaRegistry` that can compute the canonical schema
 * document digest.
 */
function deriveContractRef(schema: SchemaReference): ContractRef {
  return {
    schemaId: schema.id,
    version: LEGACY_CONTRACT_VERSION,
    digest: LEGACY_CONTRACT_DIGEST,
  };
}

/**
 * Wrap an existing legacy {@link ProcessModuleDefinition} into a pure
 * {@link ProcessModuleManifest} envelope.
 *
 * Pure function: no class, no closures retained, no side effects. The returned
 * manifest:
 *   - carries `manifestFormatVersion: opts?.manifestFormatVersion ?? 'legacy-0'`;
 *   - embeds the input `definition` verbatim;
 *   - declares `resourceIndex: []` and `handlerRefs: []` (legacy modules bind
 *     resources/handlers at composition time, not in the manifest — documented
 *     gap filled by Waves 8/9 for migrated modules);
 *   - derives `inputContractRef` / `outputContractRef` from the definition's
 *     `inputContract` / `outputContract` (`SchemaReference { id }`) into a
 *     `ContractRef { schemaId: id; version: 'legacy'; digest: 'pending@wave-2' }`;
 *   - stamps `runtimeCompatibilityRange: '>=2.0.0 <3.0.0'`;
 *   - omits the optional tool / assistance / guards / capabilities fields
 *     (they are optional on `ProcessModuleManifest`).
 *
 * The result is validated by {@link validateProcessModuleManifest} before
 * return: if the input definition carries non-serializable values (functions,
 * `Map`, `Set`, `undefined` inside arrays, class instances, `Symbol`s,
 * non-finite numbers), validation fails and this function throws an
 * `LegacyManifestAdapterError` carrying the structured validation errors.
 *
 * @param definition the legacy {@link ProcessModuleDefinition} to wrap.
 * @param opts        optional overrides (currently only `manifestFormatVersion`).
 * @returns the validated {@link ProcessModuleManifest} envelope.
 * @throws {LegacyManifestAdapterError} when the wrapped manifest fails
 *         `validateProcessModuleManifest` (e.g. injected non-serializable value).
 */
export function adaptLegacyProcessModule(
  definition: ProcessModuleDefinition,
  opts?: AdaptLegacyProcessModuleOptions,
): ProcessModuleManifest {
  const manifest: ProcessModuleManifest = {
    manifestFormatVersion: opts?.manifestFormatVersion ?? LEGACY_MANIFEST_FORMAT_VERSION,
    definition,
    resourceIndex: [],
    handlerRefs: [],
    inputContractRef: deriveContractRef(definition.inputContract),
    outputContractRef: deriveContractRef(definition.outputContract),
    runtimeCompatibilityRange: LEGACY_RUNTIME_COMPATIBILITY_RANGE,
  };

  const validation = validateProcessModuleManifest(manifest);
  if (!validation.ok) {
    throw new LegacyManifestAdapterError(manifest, validation.errors);
  }
  return manifest;
}

/**
 * Error thrown when a legacy definition cannot be wrapped because the resulting
 * manifest fails {@link validateProcessModuleManifest}.
 *
 * Carries the structured validation errors so callers can report exactly which
 * field violated canonical serializability (plan §3.5).
 */
export class LegacyManifestAdapterError extends Error {
  constructor(
    manifest: ProcessModuleManifest,
    readonly validationErrors: readonly ValidationErrorSnapshot[],
  ) {
    const name = manifest?.definition?.identity?.name ?? '<unknown>';
    const version = manifest?.definition?.identity?.version ?? '<unknown>';
    const rendered = validationErrors
      .map((e) => `  at ${e.path}: [${e.code}] ${e.message}`)
      .join('\n');
    super(
      `legacy process module ${name}@${version} could not be wrapped into a manifest: \n${rendered}`,
    );
    this.name = 'LegacyManifestAdapterError';
  }
}

/**
 * Structural snapshot of a single validation error, as produced by
 * `validateProcessModuleManifest`. Re-declared locally (matching the frozen
 * `ValidationResult` shape from WAVE1-PURE-SPI-SPEC §2) so this module does not
 * need to import the full `ValidationResult` type just to render errors.
 */
interface ValidationErrorSnapshot {
  code: string;
  path: string;
  message: string;
}
