/**
 * W2-A1 — ModulePackageStore PORT + pure value types for the immutable
 * content-addressed package store.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 *       §1 rows 1,2 (PORT + adapter ownership), §2 (ports vs adapters),
 *       §4 (identity rules — package_digest formula).
 * Task: `docs/refactor-management/05-subagent-tasks/W02-A1-filesystem-package-store.md`.
 *
 * This module is PURE DATA + a PORT interface only (plan §3.5 purity style).
 * It defines the contract every content-addressed package store must honor;
 * the filesystem adapter (`installation/adapters/filesystem-package-store.ts`)
 * provides the concrete implementation. Persistence/filesystem touches live
 * behind the PORT so the domain stays swappable (Wave 13 may swap adapters
 * without touching this file).
 *
 * Imports (purity convention — task §"Own", Rule-5-style even though the
 * mechanical ratchet regex `^src/process-modules/domain/` does not match
 * `installation/domain/`):
 *   - `ProcessModuleManifest`, `ResourceIndexEntry`, `ResourceKind` from the
 *     Wave 1 SPI barrel (`domain/spi/index.ts`) — frozen, pure.
 *   - `canonicalJson`, `sha256Hex` from `shared/canonical-json.ts` — frozen
 *     primitives (only node:crypto under the hood). Used for the
 *     `packageDigest` formula.
 *   - `createHash` from `node:crypto` — a node builtin, used ONLY to hash raw
 *     resource bytes (`ResourceBlob.digest`). The shared `sha256Hex` cannot be
 *     used for raw bytes: it canonical-JSON-serializes its input first, which
 *     turns a `Uint8Array` into `{"0":..,"1":..}` and hashes THAT — not the
 *     bytes. The task explicitly requires `digest = sha256Hex(bytes)` "via
 *     crypto, NOT canonicalJson — bytes are raw". `node:crypto` in domain is
 *     the same purity tier as the existing `shared/canonical-json.ts` (which
 *     itself imports `node:crypto`), so this does not weaken the layer.
 */

import { createHash } from 'node:crypto';

import { sha256Hex } from '../../shared/canonical-json.js';
import type {
  ProcessModuleManifest,
  ResourceIndexEntry,
  ResourceKind,
} from '../../domain/spi/index.js';

// ---------------------------------------------------------------------------
// Value types.
// ---------------------------------------------------------------------------

/**
 * A single resource blob staged for immutable storage.
 *
 * `digest` is `sha256Hex` of the RAW BYTES — i.e.
 * `createHash('sha256').update(bytes).digest('hex')`. It is NOT the shared
 * `sha256Hex(bytes)` (which canonical-JSON-serializes first); bytes are hashed
 * directly. Use {@link computeResourceDigest} to compute it consistently.
 *
 * @property logicalId  Stable, module-namespaced identifier. MUST appear in the
 *                      manifest's `resourceIndex` (the store rejects undeclared
 *                      blobs). MUST be a safe path segment (no `..`, no
 *                      absolute paths) — the filesystem adapter slugifies and
 *                      rejects traversal.
 * @property kind       One of {@link ResourceKind}. Mirrors the manifest entry.
 * @property bytes      Raw resource bytes. Stored content-addressed; read back
 *                      byte-identical.
 * @property digest     `sha256Hex` of `bytes` (raw, via crypto). The store
 *                      verifies this on every read.
 */
export interface ResourceBlob {
  readonly logicalId: string;
  readonly kind: ResourceKind;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

/**
 * An immutable, content-addressed Process Module package as returned by the
 * store. The manifest + resources are the exact bytes persisted; `packageDigest`
 * is the content address (and the directory name on disk); `storedAt` is the
 * implementation-specific location URI/path (for the filesystem adapter, the
 * absolute content-addressed directory).
 *
 * @property manifest       The canonical manifest envelope (Wave 1).
 * @property resources      The resource blobs, in the order supplied to `store`.
 * @property packageDigest  The content address — see {@link computePackageDigest}.
 * @property storedAt       Implementation-specific location string.
 */
export interface StoredModulePackage {
  readonly manifest: ProcessModuleManifest;
  readonly resources: readonly ResourceBlob[];
  readonly packageDigest: string;
  readonly storedAt: string;
}

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

/**
 * Error codes raised by `ModulePackageStore` implementations. The PORT is
 * intentionally unspecified about the concrete error class (adapters may throw
 * their own `Error` subclass); callers SHOULD discriminate on `code` rather
 * than on the class. Every `PackageStoreError` carries one of these codes on
 * its `code` property.
 *
 *   - `PACKAGE_STORE_PATH_TRAVERSAL` — a `logicalId` (or resolved path)
 *     escapes the package root (`..`, absolute paths, etc.). Rejected before
 *     any byte is written.
 *   - `PACKAGE_STORE_DIGEST_MISMATCH` — a stored resource's recomputed digest
 *     does not match the recorded digest, OR the on-disk `packageDigest` does
 *     not match the directory name. Indicates corruption / tampering.
 *   - `PACKAGE_STORE_NOT_FOUND` — `read`/`verify`/`exists` queried a digest
 *     that has no stored package.
 *   - `PACKAGE_STORE_CORRUPT` — the package directory exists but is
 *     structurally unreadable (missing manifest, missing meta, malformed JSON).
 */
export const PACKAGE_STORE_PATH_TRAVERSAL = 'PACKAGE_STORE_PATH_TRAVERSAL';
export const PACKAGE_STORE_DIGEST_MISMATCH = 'PACKAGE_STORE_DIGEST_MISMATCH';
export const PACKAGE_STORE_NOT_FOUND = 'PACKAGE_STORE_NOT_FOUND';
export const PACKAGE_STORE_CORRUPT = 'PACKAGE_STORE_CORRUPT';

/**
 * The set of all valid `PackageStoreError` codes (for runtime validation).
 */
export const PACKAGE_STORE_ERROR_CODES: readonly string[] = Object.freeze([
  PACKAGE_STORE_PATH_TRAVERSAL,
  PACKAGE_STORE_DIGEST_MISMATCH,
  PACKAGE_STORE_NOT_FOUND,
  PACKAGE_STORE_CORRUPT,
]);

/**
 * Base error type thrown by store implementations. Concrete adapters throw a
 * subclass; callers discriminate on {@link code}.
 */
export class PackageStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PackageStoreError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Digest primitives (pure).
// ---------------------------------------------------------------------------

/**
 * Compute the digest of a resource's raw bytes. This is `sha256Hex` over the
 * BYTES directly (via `node:crypto`), NOT over the canonical-JSON form. The
 * shared `sha256Hex` from `shared/canonical-json.ts` canonical-JSON-serializes
 * its input first and would hash `{"0":..,"1":..}` for a `Uint8Array` — wrong.
 *
 * Use this helper to build the `digest` field of a {@link ResourceBlob} so the
 * store and the caller agree byte-for-byte.
 */
export function computeResourceDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Compute the content address (`packageDigest`) of a package.
 *
 * Canonical formula (Decision D-20260728-03, reconciled at Wave 2 integration):
 *
 * ```
 *   packageDigest = sha256Hex({
 *     manifest,
 *     resourceIndex: manifest.resourceIndex,
 *     resourceDigests: resources.map(r => r.digest),
 *   })
 * ```
 *
 * The shared `sha256Hex(value)` canonicalizes internally (one canonicalization).
 * The earlier task-file formula `sha256Hex(canonicalJson({...}))` DOUBLE-
 * canonicalized (canonicalJson is not idempotent on strings — it re-quotes
 * them), producing a divergent digest family from every other content hash in
 * the codebase. D-20260728-03 standardized on single canonicalization to align
 * packageDigest with the frozen lineage-hash primitive. W2-A1 originally
 * implemented the double-canonicalization form; this one-line normalization
 * was applied at Wave 2 checkpoint integration.
 *
 * Stability: deterministic (canonical JSON key sort + the frozen `sha256Hex`
 * primitive), so identical `{manifest, resources}` inputs always yield the
 * same `packageDigest`.
 */
export function computePackageDigest(
  manifest: ProcessModuleManifest,
  resources: readonly ResourceBlob[],
): string {
  return sha256Hex({
    manifest,
    resourceIndex: manifest.resourceIndex as readonly ResourceIndexEntry[],
    resourceDigests: resources.map((r) => r.digest),
  });
}

// ---------------------------------------------------------------------------
// PORT.
// ---------------------------------------------------------------------------

/**
 * PORT: a content-addressed, immutable store for Process Module packages.
 *
 * Implementations MUST honor these invariants (spec §4, plan §5.5.7, §9.2):
 *
 *   - **Content-addressed.** The `packageDigest` is the address. Two `store`
 *     calls with identical `{manifest, resources}` produce the same digest and
 *     the same on-disk location (idempotent write).
 *   - **Immutable.** Once written, the package bytes do not change. Mutating
 *     the in-memory input after `store` does NOT affect subsequent `read`
 *     results (§14.3.8 exit-gate proof).
 *   - **Self-verifying.** `read` recomputes every resource digest AND verifies
 *     the directory-name digest; mismatch → `PACKAGE_STORE_DIGEST_MISMATCH`.
 *     `verify` returns `false` (never throws) on any corruption.
 *   - **Traversal-safe.** `store` rejects `logicalId`s that escape the package
 *     root (`..`, absolute paths) with `PACKAGE_STORE_PATH_TRAVERSAL`.
 *   - **Declared-only.** `store` rejects blobs whose `logicalId` is not in
 *     `manifest.resourceIndex`.
 *
 * The filesystem adapter is the default; Wave 13 may add alternatives (e.g. an
 * object-store adapter) behind this same PORT.
 */
export interface ModulePackageStore {
  /**
   * Persist a package content-addressed. Idempotent for identical inputs
   * (returns the same `packageDigest` and `storedAt`). Throws
   * `PACKAGE_STORE_PATH_TRAVERSAL` for unsafe `logicalId`s and
   * `PACKAGE_STORE_*` errors for declared-resource / I/O failures.
   */
  store(
    manifest: ProcessModuleManifest,
    resources: readonly ResourceBlob[],
  ): Promise<StoredModulePackage>;

  /**
   * Read a stored package by its content address. Verifies every resource
   * digest and the directory-name digest; mismatch →
   * `PACKAGE_STORE_DIGEST_MISMATCH`. Throws `PACKAGE_STORE_NOT_FOUND` if no
   * package exists at that digest.
   */
  read(packageDigest: string): Promise<StoredModulePackage>;

  /**
   * Whether a package with the given digest is present in the store. Returns
   * `false` (never throws) if the digest is unknown or the entry is unreadable.
   */
  exists(packageDigest: string): Promise<boolean>;

  /**
   * Whether a stored package is intact: re-reads, recomputes the
   * `packageDigest` from the loaded content, and compares to the stored value.
   * Returns `false` on ANY corruption (digest mismatch, missing files, I/O
   * error). Returns `true` only when the package is byte-faithful.
   */
  verify(packageDigest: string): Promise<boolean>;
}
