/**
 * Persisted Process Module Installation record. Introduced in P-PM-1.
 *
 * One row per (module_name, module_version) that has been installed with a
 * hash-pinned `ProcessModulePackage`. This is the durable side of the in-memory
 * `ProcessModuleInstallationRegistry`: the registry answers "can this run
 * start?" in-process; this table answers "which exact bytes did it ship with,
 * reproducibly, across restarts?".
 *
 * A `factory_process_runs` row references this via `installation_id` FK. That
 * means: editing a shipped resource (skill, template, checklist) WITHOUT
 * bumping the module version produces a NEW installation row with a NEW
 * `package_digest`, and replays against the OLD ProcessRun detect the mismatch
 * (the run was pinned to a different installation).
 *
 * The table stores digests and the JSON of resource_hashes / handler_versions
 * (not the file bytes — the package root on disk is the source of bytes; this
 * table is the source of pinned identity). Resource paths are the keys of
 * `resource_hashes_json`.
 */

import type { ProcessModuleReference } from '../domain/process-module.js';

export interface ProcessModuleInstallationRecord {
  id: number;
  moduleRef: ProcessModuleReference;
  moduleRefKey: string;
  /** Executor kind recorded for observability (matches ProcessRun.executor_kind). */
  executorKind: string;
  /** SHA-256 over canonical definition JSON. Excludes routeResolver. */
  definitionDigest: string;
  /** SHA-256 over {definitionDigest, resourceHashes, handlerVersions}. */
  packageDigest: string;
  /** Canonical JSON of `{path: sha256}`. Insertion-sorted for stability. */
  resourceHashesJson: string;
  /** Canonical JSON of `{handlerId: version}`. */
  handlerVersionsJson: string;
  createdAt: string;
}

/**
 * Input shape for inserting a new installation row. The Runtime assembles this
 * from the in-memory `ProcessModuleInstallation.package` after resolving all
 * ResourceRefs against the package root.
 */
export interface InsertProcessModuleInstallationInput {
  moduleRef: ProcessModuleReference;
  executorKind: string;
  definitionDigest: string;
  packageDigest: string;
  /** path → sha256, exactly as resolved from disk. */
  resourceHashes: ReadonlyMap<string, string>;
  /** handlerId / adapterId / toolId → declared version. */
  handlerVersions: ReadonlyMap<string, string>;
}

export interface ProcessModuleInstallationRepository {
  /**
   * Insert a new installation row. Idempotent on
   * (module_name, module_version, package_digest): re-inserting the same
   * package returns the existing row. A different package_digest under the
   * same (module_name, module_version) creates a NEW row — this is how
   * "edited resource, same version" is captured as a distinct installation
   * rather than a silent overwrite.
   */
  upsert(input: InsertProcessModuleInstallationInput): ProcessModuleInstallationRecord;

  /** Read by surrogate id (the FK stored on factory_process_runs). */
  read(id: number): ProcessModuleInstallationRecord | null;

  /**
   * Find the LATEST installation for a module ref. "Latest" = highest id, which
   * corresponds to most recent install. Used by `process_run_start` when the
   * caller does not pin a specific installation_id (the common path).
   */
  findLatestForModule(moduleRef: ProcessModuleReference): ProcessModuleInstallationRecord | null;

  /**
   * Find an installation matching an exact package_digest. Used during replay:
   * a ProcessRun pinned to installation_id=N must resolve to the same package.
   */
  findByPackageDigest(
    moduleRef: ProcessModuleReference,
    packageDigest: string,
  ): ProcessModuleInstallationRecord | null;
}
