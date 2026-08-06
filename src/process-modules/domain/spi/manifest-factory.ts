/**
 *
 * Pure adapter (no class, no behavior) that wraps an existing
 * `ProcessModuleDefinition` — which already lacks the new manifest fields —
 * into a `ProcessModuleManifest` with empty/optional new fields.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md` §1 row 15.
 * Plan ref: §14.2.4.
 *
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
 * that carries no declared `resourceIndex` / `handlerRefs`. Wave 8/9 replace
 * this with a populated `'1'` manifest when a module is migrated.
 */
export const MANIFEST_FORMAT_VERSION = '1';

/**
 *
 * the 3.x cutover (Wave 11) is the earliest point they may stop validating.
 */
export const RUNTIME_COMPATIBILITY_RANGE = '>=2.0.0 <3.0.0';

/**
 * `ContractRef`. Real content digests arrive in Wave 2 once the
 * `ContractSchemaRegistry` (W1-A5) ships concrete codecs behind each schema id.
 */
export const CONTRACT_DIGEST_PLACEHOLDER = 'synthetic-contract-digest';

/**
 * `SchemaReference` carries only `{ id }` with no version field, so the adapter
 * schema version.
 */
export const CONTRACT_VERSION = '1.0.0';

/**
 * Options for {@link createProcessModuleManifest}.
 */
export interface CreateProcessModuleManifestOptions {
  /**
   * Override the emitted `manifestFormatVersion`. Defaults to
   * override this unless they are migrating a module and have populated the
   * resource/handler arrays themselves (out of scope for Wave 1).
   */
  manifestFormatVersion?: string;
}

/**
 *
 * 2 ships a real `ContractSchemaRegistry` that can compute the canonical schema
 * document digest.
 */
function deriveContractRef(schema: SchemaReference): ContractRef {
  return {
    schemaId: schema.id,
    version: CONTRACT_VERSION,
    digest: CONTRACT_DIGEST_PLACEHOLDER,
  };
}

/**
 * {@link ProcessModuleManifest} envelope.
 *
 * Pure function: no class, no closures retained, no side effects. The returned
 * manifest:
 *   - embeds the input `definition` verbatim;
 *     resources/handlers at composition time, not in the manifest — documented
 *     gap filled by Waves 8/9 for migrated modules);
 *   - derives `inputContractRef` / `outputContractRef` from the definition's
 *     `inputContract` / `outputContract` (`SchemaReference { id }`) into a
 *   - stamps `runtimeCompatibilityRange: '>=2.0.0 <3.0.0'`;
 *   - omits the optional tool / assistance / guards / capabilities fields
 *     (they are optional on `ProcessModuleManifest`).
 *
 * The result is validated by {@link validateProcessModuleManifest} before
 * return: if the input definition carries non-serializable values (functions,
 * `Map`, `Set`, `undefined` inside arrays, class instances, `Symbol`s,
 * non-finite numbers), validation fails and this function throws an
 * `ManifestFactoryError` carrying the structured validation errors.
 *
 * @param opts        optional overrides (currently only `manifestFormatVersion`).
 * @returns the validated {@link ProcessModuleManifest} envelope.
 * @throws {ManifestFactoryError} when the wrapped manifest fails
 *         `validateProcessModuleManifest` (e.g. injected non-serializable value).
 */
export function createProcessModuleManifest(
  definition: ProcessModuleDefinition,
  opts?: CreateProcessModuleManifestOptions,
): ProcessModuleManifest {
  const manifest: ProcessModuleManifest = {
    manifestFormatVersion: opts?.manifestFormatVersion ?? MANIFEST_FORMAT_VERSION,
    definition,
    resourceIndex: [],
    handlerRefs: [],
    inputContractRef: deriveContractRef(definition.inputContract),
    outputContractRef: deriveContractRef(definition.outputContract),
    runtimeCompatibilityRange: RUNTIME_COMPATIBILITY_RANGE,
  };

  // validateProcessModuleManifest (W1-A2) calls assertCanonicalSerializable
  // (W1-A1) first, which THROWS a CanonicalSerializationError (a plain data
  // object, not an Error instance) on non-serializable input. We catch BOTH
  // the canonical-serialization throw and the structural ValidationResult
  // failure and wrap them uniformly in ManifestFactoryError so callers
  // get a single typed error surface regardless of which validation phase
  // rejected the input.
  try {
    const validation = validateProcessModuleManifest(manifest);
    if (!validation.ok) {
      throw new ManifestFactoryError(manifest, validation.errors);
    }
  } catch (e) {
    if (e instanceof ManifestFactoryError) {
      throw e;
    }
    // CanonicalSerializationError (plain object { code, path, reason }) or
    // any other thrown validator failure — normalize into our error surface.
    const canonicalErr =
      e && typeof e === 'object' && 'code' in e && 'path' in e && 'reason' in e
        ? (e as { code: string; path: string; reason: string })
        : { code: 'ADAPTER_VALIDATION_THREW', path: '$', reason: String(e) };
    throw new ManifestFactoryError(manifest, [
      {
        code: canonicalErr.code,
        path: canonicalErr.path,
        message: canonicalErr.reason,
      },
    ]);
  }
  return manifest;
}

/**
 * manifest fails {@link validateProcessModuleManifest}.
 *
 * Carries the structured validation errors so callers can report exactly which
 * field violated canonical serializability (plan §3.5).
 */
export class ManifestFactoryError extends Error {
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
      `process module ${name}@${version} could not form a manifest: \n${rendered}`,
    );
    this.name = 'ManifestFactoryError';
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
