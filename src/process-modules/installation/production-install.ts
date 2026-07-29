/**
 * Production package installation helper.
 *
 * Bridges the existing Wave 2 content-addressed installer SPI to the
 * composition root: reads the 4 production ProcessModuleManifests' declared
 * resources from disk, installs each into the durable ModulePackageStore +
 * ModuleInstallationRepository, and returns the PackageRegistry the workspace
 * materializer + ProcessRun pinning consume.
 *
 * W13-AUDIT §18.5 / §18.9: until this wiring existed, ProcessRuns carried
 * `installation_id: null` / `package_digest: null` (the SPI was built and
 * tested but never called from production). This module closes that gap.
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

/**
 * The 4 production manifests, in lifecycle stage order. Imported lazily by the
 * composition root; re-exported here so the install helper owns the canonical
 * ordered list the scenario installer / orchestrator also need.
 */
import { discoveryPackageManifest } from '../modules/discovery/package/manifest.js';
import { formalizationPackageManifest } from '../modules/formalization/package/manifest.js';
import { developmentPackageManifest } from '../modules/development/package/manifest.js';
import { deliveryPackageManifest } from '../modules/delivery/package/manifest.js';

export const PRODUCTION_MODULE_MANIFESTS: readonly ProcessModuleManifest[] = [
  discoveryPackageManifest,
  formalizationPackageManifest,
  developmentPackageManifest,
  deliveryPackageManifest,
];

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

/**
 * Install (or reuse) all 4 production module packages against the given DB +
 * store root.
 *
 * @param db         Open saga SQLite handle (the same one the rest of the
 *                   runtime uses; `saga3_module_installations` is created here
 *                   if absent).
 * @param repoRoot   Absolute path to the saga-mcp repository root. Manifest
 *                   resource paths are repo-root-relative POSIX.
 * @param storeRoot  Directory under which content-addressed package bytes are
 *                   persisted. Defaults to `<repoRoot>/.saga/package-store`.
 */
export async function installProductionModules(
  db: Database.Database,
  repoRoot: string,
  storeRoot?: string,
): Promise<ProductionInstallation> {
  return installModulePackages(
    db,
    repoRoot,
    PRODUCTION_MODULE_MANIFESTS,
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
    // bytes and corrupt package-store entries on restart.
    const record = await installPackage(manifest, resources, { store, repo: repository });
    records.set(name, record);
    packages.set(record.packageDigest, await store.read(record.packageDigest));
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
