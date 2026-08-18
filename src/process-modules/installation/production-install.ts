/**
 * Production package installation helper.
 *
 * Bridges the existing Wave 2 content-addressed installer SPI to the
 * composition root: reads the caller-supplied ProcessModuleManifests' declared
 * resources from disk, installs each into the durable ModulePackageStore +
 * ModuleInstallationRepository, and returns the PackageRegistry the workspace
 * materializer + ProcessRun pinning consume.
 *
 * W13-AUDIT §18.5 / §18.9: until this wiring existed, ProcessRuns carried
 * `installation_id: null` / `package_digest: null` (the SPI was built and
 * tested but never called from production). This module closes that gap.
 *
 * Architecture (cutover ratchet / CONVEYOR-MENTAL-MODEL §"Workshop"): this
 * installation layer is GENERIC machinery — it installs whatever manifests it
 * is handed. The SET of manifests to install is a composition-layer decision
 * (which modules exist), not an installation-layer decision. This file
 * therefore does NOT import any `modules/*` implementation: doing so would be
 * a hidden fallback (the cutover ratchet's rule 1) — the new execution lane
 * silently reaching back into concrete module implementations. Callers in the
 * composition layer (e.g. `orchestrate-cli.ts`) supply the ordered manifest
 * list; this helper only reads their declared resources and persists them.
 *
 * Idempotency: a second call against the SAME DB + store with UNCHANGED module
 * bytes is a no-op (the active record already matches the computed
 * packageDigest). Changed bytes under the same name@version fail loudly with
 * MODULE_INSTALLATION_VERSION_COLLISION — an edited resource MUST bump the
 * module version (immutable identity contract).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import type { ProcessModuleManifest } from '../domain/spi/module-manifest.js';
import type { WorkspacePackageRegistry } from '../application/workspace-projection.js';
import {
  FilesystemModulePackageStore,
  SqliteModuleInstallationRepository,
  InstallationBasedPackageRegistry,
  installPackage,
  type ModuleInstallationRecord,
  type ResourceBlob,
  type StoredModulePackage,
} from './index.js';
import { asModuleInstallationId } from './domain/installation.js';
import { recordPackageChangedInvalidations } from '../../infrastructure/replay/sqlite-replay-capsule-repository.js';
import {
  PackageInstallerError,
  MODULE_INSTALLATION_RESTART_REQUIRED,
} from './domain/installer.js';

/**
 * Read the resources declared in a manifest's `resourceIndex` from disk and
 * build the `ResourceBlob[]` the installer expects.
 *
 * `resourceIndex[i].path` is a repo-root-relative POSIX path (e.g.
 * `src/process-modules/modules/discovery/package/resources/X.md`). The
 * `basePath` MUST be the saga-mcp repository root so each path resolves.
 *
 * `digest` is the RAW sha256 of the bytes (not canonical-json sha256Hex —
 * `ResourceBlob.digest` is the byte-level content address the store verifies
 * on every read). Uses `createHash('sha256')` directly, matching
 * `computeResourceDigest` in package-store.ts.
 */
export function readResourceBlobs(
  manifest: ProcessModuleManifest,
  basePath: string,
): ResourceBlob[] {
  return manifest.resourceIndex.map(entry => {
    const abs = path.join(basePath, entry.path);
    const buf = readFileSync(abs);
    const bytes = new Uint8Array(buf);
    return {
      logicalId: entry.logicalId,
      kind: entry.kind,
      bytes,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
  });
}

/**
 * Result of installing the production modules. The composition root threads
 * these into the orchestrator (pin resolution) and the worker executor factory
 * (workspace projection).
 */
export interface ProductionInstallation {
  /**
   * Resolves active installations by selector (name + semver range) AND by
   * surrogate id (getById). The workspace materializer needs getById to read
   * the pinned record; the orchestrator needs the records map. Typed as
   * WorkspacePackageRegistry (PackageRegistry & InstallationRecordById) so it
   * plugs directly into buildWorkspaceProjection.
   */
  readonly registry: WorkspacePackageRegistry;
  /** The underlying repository (for pin lookups by name@version). */
  readonly repository: SqliteModuleInstallationRepository;
  /** The content-addressed byte store (verified on every read). */
  readonly store: FilesystemModulePackageStore;
  /** One record per production module, keyed by module name. */
  readonly records: ReadonlyMap<string, ModuleInstallationRecord>;
  /** Verified immutable package snapshots keyed by package digest. */
  readonly packages: ReadonlyMap<string, StoredModulePackage>;
}

interface PinnedProcessPackageRow {
  readonly id: number;
  readonly package_digest: string;
}

/**
 * Process runs retain their exact installation/package pin after a compatible
 * toolset replacement retires the old active installation.  The worker host
 * therefore needs both the freshly installed package snapshots and every
 * historical snapshot referenced by a non-terminal durable ProcessRun.
 *
 * Some package-installation consumers intentionally use a small database that
 * has no lifecycle schema.  Treat that as an installation-only host; once the
 * process-run table exists, however, every non-null pin is mandatory.
 */
function readPinnedProcessPackages(
  db: Database.Database,
): readonly PinnedProcessPackageRow[] {
  const processRunTable = db.prepare(
    `SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='factory_process_runs'`,
  ).get();
  if (!processRunTable) return [];
  const columns = db.prepare('PRAGMA table_info(factory_process_runs)')
    .all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === 'package_digest')) return [];
  const hasStatus = columns.some(column => column.name === 'status');
  return db.prepare(
    `SELECT MIN(id) AS id, package_digest
       FROM factory_process_runs
      WHERE package_digest IS NOT NULL
        ${hasStatus
          ? "AND status IN ('created','preparing','running','paused','settling')"
          : ''}
      GROUP BY package_digest
      ORDER BY MIN(id)`,
  ).all() as PinnedProcessPackageRow[];
}

/**
 * Install (or reuse) a set of production module packages against the given DB +
 * store root.
 *
 * @param db         Open saga SQLite handle (the same one the rest of the
 *                   runtime uses; `factory_module_installations` is created here
 *                   if absent).
 * @param repoRoot   Absolute path to the saga-mcp repository root. Manifest
 *                   resource paths are repo-root-relative POSIX.
 * @param manifests  The ordered production ProcessModuleManifests to install.
 *                   Supplied by the composition-layer caller (which owns the
 *                   decision about which modules exist); this helper does not
 *                   import any module implementation, so it cannot derive the
 *                   set itself (cutover ratchet rule 1 — see file header).
 * @param storeRoot  Directory under which content-addressed package bytes are
 *                   persisted. Defaults to `<repoRoot>/.saga/package-store`.
 */
export async function installProductionModules(
  db: Database.Database,
  repoRoot: string,
  manifests: readonly ProcessModuleManifest[],
  storeRoot?: string,
): Promise<ProductionInstallation> {
  return installModulePackages(
    db,
    repoRoot,
    manifests,
    storeRoot,
  );
}

/**
 * Install an explicit module set. Hosts use this for a partial lifecycle such
 * as a standalone Discovery run without installing unrelated modules.
 */
export async function installModulePackages(
  db: Database.Database,
  repoRoot: string,
  manifests: readonly ProcessModuleManifest[],
  storeRoot?: string,
): Promise<ProductionInstallation> {
  if (manifests.length === 0) {
    throw new Error('MODULE_PACKAGE_SET_EMPTY: at least one manifest is required');
  }
  const store = new FilesystemModulePackageStore(
    storeRoot ?? path.join(repoRoot, '.saga', 'package-store'),
  );
  const repository = new SqliteModuleInstallationRepository(db);
  const records = new Map<string, ModuleInstallationRecord>();
  const packages = new Map<string, StoredModulePackage>();

  for (const manifest of manifests) {
    const { name } = manifest.definition.identity;
    const resources = readResourceBlobs(manifest, repoRoot);

    // The installer owns immutable identity, idempotency and replay
    // verification. A name@version-only shortcut would hide changed source
    // bytes and corrupt package-store entries on restart. When the toolset
    // changed since the last run, retire the old slot and reinstall (CGAD P18:
    // resume is about the work on the card, not the toolset version — the
    // workplace's artifacts/submissions/tasks in the DB are unchanged).
    let record;
    try {
      record = await installPackage(
        manifest, resources, { store, repo: repository },
        { replaceOnDigestChange: true },
      );
    } catch (error) {
      // K5 (Saga Core Renewal): handler implementations were rewritten under
      // stable logicalIds. Route EXPLICITLY instead of a raw host crash: the
      // refusal names the non-terminal ProcessRuns that still pin the old
      // package - each needs an explicit new lifecycle (or an operator
      // decision); terminal/accepted history is never mutated.
      if (
        error instanceof PackageInstallerError
        && error.code === MODULE_INSTALLATION_RESTART_REQUIRED
      ) {
        const oldDigest = (error.detail as { existing?: { packageDigest?: string } })?.existing
          ?.packageDigest;
        const attemptedDigest = (error.detail as { attempted?: string })?.attempted ?? null;
        const processRunsTable = db.prepare(
          `SELECT 1 FROM sqlite_master WHERE type='table' AND name='factory_process_runs'`,
        ).get();
        const pinnedRuns = oldDigest && processRunsTable
          ? db.prepare(
              `SELECT COUNT(*) AS n FROM factory_process_runs
                WHERE package_digest=? AND status NOT IN ('completed','failed','cancelled')`,
            ).get(oldDigest) as { n: number }
          : { n: 0 };
        // ADR-080 §2 package-changed: capsules sealed under the OLD package
        // stop certifying anything once the implementation moved — record
        // append-only evidence (authority binds the exact attempted digest,
        // so successive changes append rather than collide). Regeneration
        // then flows through the NORMAL production path: the next claim for
        // the work resolves a miss and takes the selected route; the old
        // capsule and its acceptance history are never mutated.
        if (oldDigest) {
          recordPackageChangedInvalidations(db, {
            moduleName: name,
            moduleVersion: manifest.definition.identity.version,
            oldPackageDigest: oldDigest,
            attemptedPackageDigest: attemptedDigest,
          });
        }
        throw new Error(
          `PRODUCTION_RESUME_RESTART_REQUIRED: ${name} handler implementations `
          + `changed under stable logicalIds (pinned package ${String(oldDigest ?? '?').slice(0, 12)}…, `
          + `${pinnedRuns.n} non-terminal ProcessRun(s) pin it). Resume is refused: `
          + 'start an explicit new lifecycle for each pinned run; '
          + 'terminal and accepted work stays immutable.',
          { cause: error },
        );
      }
      throw error;
    }
    records.set(name, record);
    packages.set(record.packageDigest, await store.read(record.packageDigest));
  }

  // A compatible reinstall may have retired an installation that an existing
  // non-terminal ProcessRun still pins. Retired means "not selectable for a
  // new run", not "unreadable for replay/resume". Materialize and verify those immutable
  // bytes before the engine can reserve a task, so corruption/missing state is
  // a host-start failure rather than a misleading worker spawn failure.
  for (const pin of readPinnedProcessPackages(db)) {
    if (packages.has(pin.package_digest)) continue;
    const record = repository.getByPackageDigest(pin.package_digest);
    if (!record) {
      throw new Error(
        `PINNED_PACKAGE_INSTALLATION_MISSING: ProcessRun ${pin.id} pins `
        + `${pin.package_digest}, but no installation record exists`,
      );
    }
    try {
      packages.set(pin.package_digest, await store.read(pin.package_digest));
    } catch (error) {
      throw new Error(
        `PINNED_PACKAGE_SNAPSHOT_MISSING: ProcessRun ${pin.id} pins `
        + `${pin.package_digest}, but its immutable package snapshot could not be verified`,
        { cause: error },
      );
    }
  }

  // WorkspacePackageRegistry = PackageRegistry & InstallationRecordById.
  // InstallationBasedPackageRegistry implements select/has/listSelectors but
  // NOT getById (that lives on the repository). Compose both so the result
  // plugs directly into buildWorkspaceProjection without the caller needing to
  // know about the split.
  const baseRegistry = new InstallationBasedPackageRegistry(repository);
  const registry: WorkspacePackageRegistry = Object.assign(baseRegistry, {
    getById: (id: number) => repository.getById(asModuleInstallationId(id)),
  });
  return { registry, repository, store, records, packages };
}
