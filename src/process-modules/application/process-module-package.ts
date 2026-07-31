/**
 * ProcessModulePackage assembly + digest computation. Introduced in P-PM-1.
 *
 * This is the bridge between a `ProcessModuleDefinition` (structural, knows
 * names but not bytes) and a `ProcessModulePackage` (hash-pinned, replay-safe).
 *
 * Why this lives in application/, not domain/:
 *   - Digest computation depends on `canonicalJson`/`sha256Hex` (shared layer).
 *   - Domain stays pure data; this module is the pure-ish transformer that
 *     assembles the package from definition + resolved resources.
 *
 * Why resource hashes are an INPUT, not resolved here:
 *   - Reading files is a Runtime concern (the Runtime owns the package root and
 *     the escape-check). This module only computes digests; the Runtime supplies
 *     the resolved `{path → sha256}` map after walking the package tree.
 *
 * Determinism guarantees:
 *   - `definitionDigest` excludes the non-enumerable `routeResolver` because
 *     `canonicalJson` walks via `Object.keys`, which skips non-enumerable
 *     properties. Verified by a dedicated test.
 *   - `packageDigest` is stable under map key reordering (canonicalJson sorts).
 *   - Re-running the same input byte-for-byte reproduces the same digests.
 */

import {
  type ProcessModuleDefinition,
  type ProcessModuleDigestInput,
  type ProcessModulePackage,
} from '../domain/process-module.js';
import { sha256Hex } from '../shared/canonical-json.js';

/**
 * Compute the definition digest: SHA-256 over the canonical JSON of the
 * definition. Excludes the non-enumerable `routeResolver` automatically.
 *
 * This is registered in the catalog and persisted in
 * `saga3_process_module_installations.definition_digest`.
 */
export function computeDefinitionDigest(definition: ProcessModuleDefinition): string {
  return sha256Hex(definition);
}

/**
 * Compute the package digest: SHA-256 over the canonical JSON of
 * `{definitionDigest, resourceHashes, handlerVersions}`.
 *
 * This is what a ProcessRun pins via `installation_id` FK. Editing any shipped
 * resource (skill, template, checklist) without bumping the module version
 * changes this digest, making the drift observable.
 */
export function computePackageDigest(input: ProcessModuleDigestInput): string {
  const definitionDigest = computeDefinitionDigest(input.definition);
  // Map → sorted array of [path, hash] for deterministic canonicalization.
  // canonicalJson already sorts object keys, but a Map iteration order is
  // insertion order — so we materialize a sorted plain object to be safe.
  const sortedResources: Record<string, string> = {};
  for (const key of [...input.resourceHashes.keys()].sort()) {
    sortedResources[key] = input.resourceHashes.get(key)!;
  }
  const sortedHandlers: Record<string, string> = {};
  for (const key of [...input.handlerVersions.keys()].sort()) {
    sortedHandlers[key] = input.handlerVersions.get(key)!;
  }
  return sha256Hex({
    definitionDigest,
    resourceHashes: sortedResources,
    handlerVersions: sortedHandlers,
  });
}

/**
 * Assemble a `ProcessModulePackage` from a definition plus its resolved
 * resource hashes and handler versions.
 *
 * The caller (Runtime, at installation time) is responsible for:
 *   - walking every `ResourceRef` referenced in the definition,
 *   - reading each resolved file,
 *   - computing its SHA-256,
 *   - supplying the resulting map here.
 *
 * This function then computes both digests and returns the immutable package.
 */
export function assembleProcessModulePackage(
  input: ProcessModuleDigestInput,
): ProcessModulePackage {
  const definitionDigest = computeDefinitionDigest(input.definition);
  const packageDigest = computePackageDigest(input);
  return {
    definition: input.definition,
    resourceHashes: input.resourceHashes,
    handlerVersions: input.handlerVersions,
    definitionDigest,
    packageDigest,
  };
}
