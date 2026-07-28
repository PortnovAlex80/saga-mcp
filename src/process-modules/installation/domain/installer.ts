/**
 * W2-A3 — PackageInstaller: pure orchestration of an immutable module install.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 * §1 row 5 + §4 digest/identity rules + §5 anti-scope.
 * Task: `docs/refactor-management/05-subagent-tasks/W02-A3-installer-dependency-lock.md`.
 *
 * The installer is the single orchestrator that turns a `ProcessModuleManifest`
 * + its `ResourceBlob[]` into an ACTIVE `ModuleInstallationRecord`. It owns NO
 * storage and NO sql: the {@link ModulePackageStore} (W2-A1) and
 * {@link ModuleInstallationRepository} (W2-A2) are INJECTED as deps. It never
 * imports `sqlite-*`, `db.ts`, `node:fs`, or any adapter (plan §3.16, Rule 5 —
 * `domain/` is pure).
 *
 * Install pipeline (spec §1 row 5):
 *   1. `validateProcessModuleManifest(manifest)`        — reject invalid.
 *   2. `assertCanonicalSerializable(manifest)`           — belt-and-suspenders.
 *   3. Resolve resources                                 — every `ResourceBlob.logicalId`
 *                                                          must be declared in
 *                                                          `manifest.resourceIndex`;
 *                                                          reject undeclared BEFORE
 *                                                          touching the store.
 *   4. `computeDependencyLock(manifest)`                 — immutable lock.
 *   5. `store.store(manifest, resources)`                — `StoredModulePackage`
 *                                                          (carries `packageDigest`).
 *   6. `repo.insert({ ... staged })`                     — catch
 *                                                          `MODULE_INSTALLATION_VERSION_COLLISION`
 *                                                          → rethrow (caller decides).
 *   7. `store.verify(packageDigest)`                     — false → `repo.markCorrupt(id)`
 *                                                          + throw `MODULE_INSTALLATION_CORRUPT`.
 *   8. `repo.activate(id)`                               — return the ACTIVE record.
 *
 * Integration note (integrator, Wave 2 cherry-pick): the {@link ModulePackageStore},
 * {@link StoredModulePackage}, {@link ResourceBlob}, {@link ResourceKind},
 * {@link ModuleInstallationRepository}, and {@link ModuleInstallationRecord}
 * types below are STRUCTURAL consumer-side declarations of the ports defined
 * canonically by W2-A1 (`installation/domain/package-store.ts`) and W2-A2
 * (`installation/domain/installation.ts`). They are deliberately re-declared
 * here (not `import type`-ed) so THIS lane builds in isolation against the
 * frozen contract even when the sibling files have not landed in the worktree
 * (plan §0.5.2 serial integration). TypeScript structural typing makes these
 * assignment-compatible with the canonical declarations at integration time;
 * if a sibling diverges from the spec, the integrator reconciles (escalate per
 * plan §0.1.7). After W2-A1/A2 land, the integrator MAY replace these inline
 * declarations with `import type` from the sibling `.js` specifiers — that
 * switch is a no-op behaviorally and is left to the integrator (single writer
 * per file).
 */

import type { ProcessModuleManifest } from '../../domain/spi/module-manifest.js';
import type { ResourceIndexEntry, ResourceKind } from '../../domain/spi/resource-index.js';
import type { HandlerRef } from '../../domain/spi/module-manifest.js';
import { validateProcessModuleManifest } from '../../domain/spi/module-manifest.js';
import { assertCanonicalSerializable } from '../../domain/spi/canonical-serialization.js';
import {
  computeDependencyLock,
  type DependencyLock,
} from './dependency-lock.js';

// ---------------------------------------------------------------------------
// Error code constants. Mirrors W2-A2's `installation.ts` error codes; the
// installer throws these by name so a downstream caller can match on `code`
// without importing W2-A2's module. Re-declared here as `const string`s (not
// re-exported from W2-A2) so this file builds in isolation. If W2-A2 mints the
// same constants, the integrator deduplicates at cherry-pick time.
// ---------------------------------------------------------------------------

/** A second ACTIVE row for the same `(name, version)` with a different digest. */
export const MODULE_INSTALLATION_VERSION_COLLISION = 'MODULE_INSTALLATION_VERSION_COLLISION';
/** `store.verify(packageDigest)` returned false after insert. */
export const MODULE_INSTALLATION_CORRUPT = 'MODULE_INSTALLATION_CORRUPT';
/** A `ResourceBlob.logicalId` is not declared in `manifest.resourceIndex`. */
export const MODULE_INSTALLATION_UNDECLARED_RESOURCE = 'MODULE_INSTALLATION_UNDECLARED_RESOURCE';
/** `validateProcessModuleManifest` returned `{ ok: false }`. */
export const MODULE_INSTALLATION_MANIFEST_INVALID = 'MODULE_INSTALLATION_MANIFEST_INVALID';

/**
 * Error thrown by {@link PackageInstaller.installPackage}. Carries a stable
 * `code` (one of the `MODULE_INSTALLATION_*` constants above) plus optional
 * structured detail. Always an `Error` instance so `try/catch` + `instanceof`
 * work uniformly across the injected-port failures the installer propagates.
 */
export class PackageInstallerError extends Error {
  readonly code: string;
  readonly detail?: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'PackageInstallerError';
    this.code = code;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}

// ---------------------------------------------------------------------------
// Consumed port shapes (structural — see module header integration note).
// These are the consumer-side contract; the canonical ports live in W2-A1's
// `installation/domain/package-store.ts` and W2-A2's
// `installation/domain/installation.ts`.
// ---------------------------------------------------------------------------

/**
 * A resource blob handed to the installer. `digest = sha256Hex(bytes)` (W2-A1
 * computes it; the installer only reads it for undeclared-resource checks).
 */
export interface ResourceBlob {
  readonly logicalId: string;
  readonly kind: ResourceKind;
  readonly bytes: Uint8Array;
  readonly digest: string;
}

/** A package persisted by the store. */
export interface StoredModulePackage {
  readonly manifest: ProcessModuleManifest;
  readonly resources: readonly ResourceBlob[];
  readonly packageDigest: string;
  readonly storedAt: string;
}

/**
 * Content-addressed package store port (W2-A1 owns the canonical declaration).
 * The installer depends on `store`, `read`, and `verify`.
 */
export interface ModulePackageStore {
  store(
    manifest: ProcessModuleManifest,
    resources: readonly ResourceBlob[],
  ): Promise<StoredModulePackage>;
  read(packageDigest: string): Promise<StoredModulePackage>;
  exists(packageDigest: string): Promise<boolean>;
  /** Re-read + recompute the package digest; `false` means corrupt. */
  verify(packageDigest: string): Promise<boolean>;
}

/** Status of an installation record. Mirrors W2-A2's `ModuleInstallationStatus`. */
export type ModuleInstallationStatus =
  | 'staged'
  | 'validated'
  | 'active'
  | 'retired'
  | 'corrupt';

/**
 * The single source of truth for "what is installed" (W2-A2 owns the canonical
 * declaration). The installer returns the ACTIVE record after step 8.
 */
export interface ModuleInstallationRecord {
  readonly id: number;
  readonly name: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly manifestSnapshot: ProcessModuleManifest;
  readonly storeLocation: string;
  readonly resourceIndex: readonly ResourceIndexEntry[];
  readonly handlerRefs: readonly HandlerRef[];
  readonly dependencyLock: DependencyLock;
  readonly status: ModuleInstallationStatus;
  readonly installedAt: string;
  readonly activatedAt?: string;
  readonly retiredAt?: string;
}

/**
 * Installation repository port (W2-A2 owns the canonical declaration). The
 * installer uses `insert`, `markCorrupt`, and `activate`.
 *
 * `insert` is expected to throw an error whose `code` equals
 * {@link MODULE_INSTALLATION_VERSION_COLLISION} when a second ACTIVE row for
 * the same `(name, version)` with a different `packageDigest` would be created
 * (the repo enforces this at the SQL UNIQUE-index level; the installer merely
 * propagates). Other insert failures propagate as-is.
 */
export interface ModuleInstallationRepository {
  insert(record: {
    readonly name: string;
    readonly version: string;
    readonly packageDigest: string;
    readonly manifestSnapshot: ProcessModuleManifest;
    readonly storeLocation: string;
    readonly resourceIndex: readonly ResourceIndexEntry[];
    readonly handlerRefs: readonly HandlerRef[];
    readonly dependencyLock: DependencyLock;
    readonly status: ModuleInstallationStatus;
    readonly installedAt: string;
  }): Promise<ModuleInstallationRecord>;
  getById(id: number): Promise<ModuleInstallationRecord>;
  getByPackageDigest(digest: string): Promise<ModuleInstallationRecord>;
  getActiveByNameVersion(
    name: string,
    version: string,
  ): Promise<ModuleInstallationRecord | null>;
  activate(id: number): Promise<ModuleInstallationRecord>;
  retire(id: number): Promise<ModuleInstallationRecord>;
  markCorrupt(id: number): Promise<ModuleInstallationRecord>;
  listActive(): Promise<readonly ModuleInstallationRecord[]>;
}

/**
 * Injected dependencies for {@link PackageInstaller.installPackage}.
 */
export interface PackageInstallerDeps {
  readonly store: ModulePackageStore;
  readonly repo: ModuleInstallationRepository;
}

/**
 * Options for {@link PackageInstaller.installPackage}.
 */
export interface PackageInstallerOptions {
  /**
   * Override the `installedAt` timestamp (ISO 8601). Defaults to
   * `new Date().toISOString()` at call time. Tests inject a fixed clock.
   */
  readonly now?: string;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Re-wrap an arbitrary thrown value (from an injected port) as a
 * {@link PackageInstallerError} preserving the original `code` when the value
 * is an object carrying one (the documented contract for
 * `MODULE_INSTALLATION_VERSION_COLLISION` from W2-A2's repo). Falls back to a
 * generic rethrow envelope so callers always see a typed error.
 */
function wrapPortError(value: unknown, fallbackCode: string): PackageInstallerError {
  if (value instanceof PackageInstallerError) return value;
  const code =
    typeof value === 'object' && value !== null && 'code' in value &&
    typeof (value as { code: unknown }).code === 'string'
      ? (value as { code: string }).code
      : fallbackCode;
  const message =
    typeof value === 'object' && value !== null && 'message' in value &&
    typeof (value as { message: unknown }).message === 'string'
      ? (value as { message: string }).message
      : String(value);
  return new PackageInstallerError(code, message, value);
}

// ---------------------------------------------------------------------------
// Installer.
// ---------------------------------------------------------------------------

/**
 * `PackageInstaller` — pure orchestrator that installs a module package into
 * an immutable, content-addressed store + installation repository.
 *
 * Stateless: holds no mutable fields. Construct once, call `installPackage`
 * any number of times. All storage/sql is delegated to the injected
 * {@link PackageInstallerDeps.store} + {@link PackageInstallerDeps.repo}.
 */
export class PackageInstaller {
  /**
   * Install `manifest` + `resources` as an ACTIVE `ModuleInstallationRecord`.
   *
   * Pipeline order is the spec §1 row 5 sequence (see module header). Every
   * failure mode is surfaced as a {@link PackageInstallerError} with a stable
   * `code`:
   *   - {@link MODULE_INSTALLATION_MANIFEST_INVALID} — validation failed.
   *   - {@link MODULE_INSTALLATION_UNDECLARED_RESOURCE} — a `ResourceBlob.logicalId`
   *     is not in `manifest.resourceIndex`.
   *   - {@link MODULE_INSTALLATION_VERSION_COLLISION} — propagated from
   *     `repo.insert` (a different digest is already ACTIVE for `(name,version)`).
   *   - {@link MODULE_INSTALLATION_CORRUPT} — `store.verify` returned false
   *     after insert; the staged record is flipped to `corrupt` first.
   *
   * @returns the ACTIVE `ModuleInstallationRecord`.
   */
  async installPackage(
    manifest: ProcessModuleManifest,
    resources: readonly ResourceBlob[],
    deps: PackageInstallerDeps,
    opts?: PackageInstallerOptions,
  ): Promise<ModuleInstallationRecord> {
    const { store, repo } = deps;
    const installedAt = opts?.now ?? new Date().toISOString();

    // Step 1 — validate. `validateProcessModuleManifest` calls
    // `assertCanonicalSerializable` internally first; it returns `{ok,errors}`
    // for ordinary structural failures and THROWS (a plain data object) only
    // for canonical-serialization impurity. We normalize both into a single
    // installer error surface.
    let validation;
    try {
      validation = validateProcessModuleManifest(manifest);
    } catch (e) {
      // CanonicalSerializationError (plain object) or any other throw.
      throw new PackageInstallerError(
        MODULE_INSTALLATION_MANIFEST_INVALID,
        'manifest failed canonical-serialization check before install',
        e,
      );
    }
    if (!validation.ok) {
      throw new PackageInstallerError(
        MODULE_INSTALLATION_MANIFEST_INVALID,
        `manifest failed validation: ${validation.errors
          .map((er) => `${er.path} [${er.code}] ${er.message}`)
          .join('; ')}`,
        validation.errors,
      );
    }

    // Step 2 — belt-and-suspenders canonical assertion. `validateProcessModuleManifest`
    // already ran this, but the spec calls it out as a distinct step and it is
    // cheap. Defends against a future validator refactor that loosens the
    // phase-1 check.
    try {
      assertCanonicalSerializable(manifest);
    } catch (e) {
      throw new PackageInstallerError(
        MODULE_INSTALLATION_MANIFEST_INVALID,
        'manifest failed canonical-serialization assertion',
        e,
      );
    }

    // Step 3 — resolve resources. Every blob must be declared in the manifest's
    // resourceIndex. This rejects BEFORE the store is touched, so an undeclared
    // blob never writes anything to disk.
    const declared = new Set(
      manifest.resourceIndex.map((r) => r.logicalId),
    );
    const undeclared = resources.filter((b) => !declared.has(b.logicalId));
    if (undeclared.length > 0) {
      throw new PackageInstallerError(
        MODULE_INSTALLATION_UNDECLARED_RESOURCE,
        `resources not declared in manifest.resourceIndex: ${undeclared
          .map((b) => b.logicalId)
          .join(', ')}`,
        undeclared.map((b) => b.logicalId),
      );
    }

    // Step 4 — dependency lock.
    const dependencyLock = computeDependencyLock(manifest);

    // Step 5 — store bytes (content-addressed). The store computes and returns
    // `packageDigest` per spec §4: `sha256Hex(canonicalJson({ manifest,
    // resourceIndex, resourceDigests }))`.
    const stored = await store.store(manifest, resources);

    // Step 6 — persist the staged installation record. Catch the version-
    // collision error code from the repo and propagate as a typed installer
    // error. The spec leaves the collision decision to the caller: development
    // mode MUST use a prerelease version (spec §4). The installer does NOT
    // auto-retire-and-replace.
    let staged: ModuleInstallationRecord;
    try {
      staged = await repo.insert({
        name: manifest.definition.identity.name,
        version: manifest.definition.identity.version,
        packageDigest: stored.packageDigest,
        manifestSnapshot: manifest,
        storeLocation: stored.storedAt,
        resourceIndex: manifest.resourceIndex,
        handlerRefs: manifest.handlerRefs,
        dependencyLock,
        status: 'staged',
        installedAt,
      });
    } catch (e) {
      // Propagate collision (and any other repo insert failure) as a typed
      // error preserving the original code.
      throw wrapPortError(e, 'MODULE_INSTALLATION_INSERT_FAILED');
    }

    // Step 7 — verify stored bytes by re-hashing. If the store reports the
    // package no longer hashes to its recorded digest, flip the staged record
    // to `corrupt` and throw. This is the spec §4 replay-verification gate.
    let verified: boolean;
    try {
      verified = await store.verify(stored.packageDigest);
    } catch (e) {
      // verify() throwing is treated as corruption (the spec models verify as
      // returning false on digest mismatch; a throw is a harder failure but
      // the safe interpretation is the same: the package is not trustworthy).
      await repo.markCorrupt(staged.id).catch(() => undefined);
      throw new PackageInstallerError(
        MODULE_INSTALLATION_CORRUPT,
        `store.verify threw for packageDigest ${stored.packageDigest}`,
        e,
      );
    }
    if (!verified) {
      try {
        await repo.markCorrupt(staged.id);
      } catch {
        // best-effort: the corrupt status flip is desirable but not required
        // for the throw below to be correct. Ignore secondary failure.
      }
      throw new PackageInstallerError(
        MODULE_INSTALLATION_CORRUPT,
        `stored package ${stored.packageDigest} failed replay verification`,
      );
    }

    // Step 8 — activate. The repo's UNIQUE-on-active index makes this the
    // final immutability gate: if another record somehow went active for the
    // same (name,version) between insert and here, activate throws (surfaced
    // as a typed collision error).
    try {
      return await repo.activate(staged.id);
    } catch (e) {
      throw wrapPortError(e, 'MODULE_INSTALLATION_ACTIVATE_FAILED');
    }
  }
}
