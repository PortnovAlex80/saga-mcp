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

import { createHash } from 'node:crypto';
import type { ProcessModuleManifest } from '../../domain/spi/module-manifest.js';
import { validateProcessModuleManifest } from '../../domain/spi/module-manifest.js';
import { assertCanonicalSerializable } from '../../domain/spi/canonical-serialization.js';
import { computeDependencyLock } from './dependency-lock.js';
import { classifyResumeCompatibility } from './resume-compatibility-policy.js';
// Canonical types from sibling lanes (W2-A1 store, W2-A2 installation/repo).
// Re-exported below for callers; imported here for use in method signatures.
import {
  computePackageDigest,
  type ResourceBlob,
  type StoredModulePackage,
  type ModulePackageStore,
} from './package-store.js';
import type { ModuleInstallationRecord } from './installation.js';
import type { ModuleInstallationRepository } from '../persistence/installation-repository.js';

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
 * K5 (Saga Core Renewal): the attempted package rewrites handler
 * implementations under stable logicalIds. Resume is not automatic — no
 * silent slot replacement; route to an explicit new lifecycle or refusal.
 */
export const MODULE_INSTALLATION_RESTART_REQUIRED = 'MODULE_INSTALLATION_RESTART_REQUIRED';

/**
 * CONVEYOR Wave 8 — the package digest drifted AND the module contract changed
 * (identity version, input/output schema, or handler surface). A resumed
 * workplace would see a different contract; the runtime must pause without
 * mutating existing work.
 */
export const MODULE_INSTALLATION_INCOMPATIBLE_DRIFT = 'MODULE_INSTALLATION_INCOMPATIBLE_DRIFT';

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
export type { ResourceBlob } from './package-store.js';

/** A package persisted by the store. */
export type { StoredModulePackage } from './package-store.js';

/**
 * Content-addressed package store port (W2-A1 owns the canonical declaration).
 * The installer depends on `store`, `read`, and `verify`.
 */
export type { ModulePackageStore } from './package-store.js';

/** Status of an installation record. Mirrors W2-A2's `ModuleInstallationStatus`. */
export type { ModuleInstallationStatus } from './installation.js';

/**
 * The single source of truth for "what is installed" (W2-A2 owns the canonical
 * declaration). The installer returns the ACTIVE record after step 8.
 */
export type { ModuleInstallationRecord } from './installation.js';

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
export type { ModuleInstallationRepository } from '../persistence/installation-repository.js';

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
  /**
   * When the active installation slot for (name, version) already holds a
   * DIFFERENT package_digest, retire the old installation and install the new
   * one instead of throwing `MODULE_INSTALLATION_VERSION_COLLISION`.
   *
   * CGAD P18 (conveyor model): a run's WORK (artifacts/traces/submissions/
   * tasks) lives in the durable DB, not inside the package. The package is the
   * toolset/instructions. Coupling resume-correctness to `package_digest`
   * equality treats the toolset version as if it owned the work — same mistake
   * as coupling a gate's read to transient task identity. A toolset change must
   * not block resuming the workplace's existing work.
   *
   * When the new installation replaces the old, ProcessRuns that pinned the old
   * installation resolve the workplace's work by node-scope regardless of the
   * pinned id — so resume continues against the existing card/desk.
   */
  readonly replaceOnDigestChange?: boolean;
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

    // Step 3.5 — STAMP resource digests. The manifest may carry placeholder
    // digests ('pending@wave-2') from authoring time. Before storing, replace
    // each resourceIndex entry's digest with the REAL sha256 of the supplied
    // bytes (plan §5.5.4: "Compute resource hashes"). This guarantees
    // `computePackageDigest` (called by the store at write AND by verify at
    // read) uses identical real digests — otherwise the placeholder-vs-real
    // divergence makes every package fail replay verification. We build a new
    // manifest rather than mutating the caller's object.
    const bytesByLogicalId = new Map(resources.map((r) => [r.logicalId, r.bytes]));
    const stampedResourceIndex = manifest.resourceIndex.map((entry) => {
      const bytes = bytesByLogicalId.get(entry.logicalId);
      if (!bytes) {
        // Declared but no blob supplied — undeclared-resource check below
        // catches declared-but-missing, but be defensive.
        return entry;
      }
      // Mirror W2-A1's computeResourceDigest: sha256 over raw bytes via crypto.
      // (Cannot import computeResourceDigest without creating a domain→adapter
      // edge; the formula is `createHash('sha256').update(bytes).digest('hex')`
      // per W2-A1 spec — one-liner, stable.)
      const realDigest = createHash('sha256').update(bytes).digest('hex');
      return { ...entry, digest: realDigest };
    });
    const stampedManifest: ProcessModuleManifest = {
      ...manifest,
      resourceIndex: stampedResourceIndex,
    };

    // Step 4 — dependency lock (computed from the stamped manifest so lock
    // entries carry real resource digests too).
    const dependencyLock = computeDependencyLock(stampedManifest);

    // Immutable identity, idempotency and replay verification belong here,
    // not in individual composition roots. Reusing name@version without
    // comparing the attempted digest would silently hide source mutation.
    const attemptedPackageDigest = computePackageDigest(stampedManifest, resources);
    const moduleName = stampedManifest.definition.identity.name;
    const moduleVersion = stampedManifest.definition.identity.version;
    const existingActive = await repo.getActiveByNameVersion(moduleName, moduleVersion);
    if (existingActive !== null) {
      if (existingActive.packageDigest !== attemptedPackageDigest) {
        // CONVEYOR Wave 8 — ResumeCompatibilityPolicy. The drift decision is
        // now EXPLICIT: classify whether the digest change is a compatible
        // toolset update (contract stable → retire old, install new, resume) or
        // an incompatible contract change (→ pause, surface operator action).
        // This replaces raw digest equality with a structured verdict, so an
        // incompatible upgrade never silently replaces a contract a running
        // workplace depends on.
        const compatibility = classifyResumeCompatibility(
          existingActive,
          attemptedPackageDigest,
          stampedManifest,
        );
        if (compatibility.outcome === 'incompatible') {
          throw new PackageInstallerError(
            MODULE_INSTALLATION_INCOMPATIBLE_DRIFT,
            `${moduleName}@${moduleVersion}: package digest drifted AND the module contract changed `
            + `(${compatibility.changedFields.join('; ')}). A resumed workplace would see a different `
            + `contract — pause without mutating existing work (CONVEYOR Wave 8).`,
            { existing: existingActive, attempted: attemptedPackageDigest, compatibility },
          );
        }
        if (compatibility.outcome === 'restart-required') {
          // K5 (Saga Core Renewal): handler implementations were REWRITTEN
          // under stable logicalIds. Retiring the old slot and resuming would
          // execute rewritten code under the same pin — the exact silent
          // incompatibility the audit flagged. Fail closed: no silent
          // replacement; the runtime routes to an explicit new lifecycle or
          // a refusal (ADR-077 s3).
          throw new PackageInstallerError(
            MODULE_INSTALLATION_RESTART_REQUIRED,
            `${moduleName}@${moduleVersion}: handler implementation(s) changed under stable `
            + `logicalIds (${compatibility.changedHandlerImplementations.join('; ')}). `
            + 'Resume is not automatic — start an explicit new lifecycle or refuse; '
            + 'existing terminal and accepted work stays immutable.',
            { existing: existingActive, attempted: attemptedPackageDigest, compatibility },
          );
        }
        if (opts?.replaceOnDigestChange) {
          // CGAD P18 — resume-tolerant reinstall: the policy classified this as
          // `compatible` (contract stable, only toolset bytes changed). Retire
          // the old installation and proceed to install the new one; the run
          // resumes against the existing work by node-scope.
          try { await repo.retire(existingActive.id); } catch { /* best-effort; INSERT path handles the slot */ }
        } else {
          throw new PackageInstallerError(
            MODULE_INSTALLATION_VERSION_COLLISION,
            `cannot install ${moduleName}@${moduleVersion}: installation id=${existingActive.id} already holds the active slot with a different package_digest ('${existingActive.packageDigest}' vs '${attemptedPackageDigest}')`,
            { existing: existingActive, attempted: attemptedPackageDigest },
          );
        }
      } else {
        const verified = await store.verify(existingActive.packageDigest);
        if (!verified) {
          try { await repo.markCorrupt(existingActive.id); } catch { /* preserve primary error */ }
          throw new PackageInstallerError(
            MODULE_INSTALLATION_CORRUPT,
            `active installation id=${existingActive.id} references corrupt package ${existingActive.packageDigest}`,
            { existing: existingActive },
          );
        }
        return existingActive;
      }
    }

    // Step 5 — store bytes (content-addressed) using the STAMPED manifest so
    // the stored manifest.json carries real resource digests (matching what
    // verify will recompute on read). The store computes and returns
    // `packageDigest` per spec §4 / Decision D-20260728-03:
    // `sha256Hex({ manifest, resourceIndex, resourceDigests })`.
    const stored = await store.store(stampedManifest, resources);

    // Step 6 — persist the staged installation record. PRE-CHECK for version
    // collision first: the repo's UNIQUE-on-active index only enforces at
    // `activate` time (a `staged` row does not violate it), so we explicitly
    // check `getActiveByNameVersion` to surface `MODULE_INSTALLATION_VERSION_COLLISION`
    // at the right step with the canonical code (W2-A8 conformance expects this
    // code, not `MODULE_INSTALLATION_ACTIVATE_FAILED`). The spec leaves the
    // collision decision to the caller: development mode MUST use a prerelease
    // version (spec §4). The installer does NOT auto-retire-and-replace.
    let staged: ModuleInstallationRecord;
    try {
      staged = await repo.insert({
        name: moduleName,
        version: moduleVersion,
        packageDigest: stored.packageDigest,
        manifestSnapshot: stampedManifest,
        storeLocation: stored.storedAt,
        resourceIndex: stampedManifest.resourceIndex,
        handlerRefs: stampedManifest.handlerRefs,
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
      // repo.markCorrupt is synchronous in W2-A2's canonical port (returns
      // ModuleInstallationRecord, not a Promise). Guard against any throw so
      // the original corruption error is the one we surface.
      try { repo.markCorrupt(staged.id); } catch { /* swallow; surface verify error */ }
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

/**
 * Stateless convenience wrapper around {@link PackageInstaller.installPackage}
 * for callers that don't need to hold a `PackageInstaller` instance. Each call
 * constructs a fresh stateless installer (no shared mutable fields) and
 * delegates. This is the API surface the barrel + conformance tests consume.
 */
export async function installPackage(
  manifest: ProcessModuleManifest,
  resources: readonly ResourceBlob[],
  deps: PackageInstallerDeps,
  opts?: PackageInstallerOptions,
): Promise<ModuleInstallationRecord> {
  return new PackageInstaller().installPackage(manifest, resources, deps, opts);
}
