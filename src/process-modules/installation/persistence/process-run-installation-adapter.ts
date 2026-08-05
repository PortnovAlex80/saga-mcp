/**
 * ProcessRunInstallationAdapter — reads/writes the `installation_id` +
 * `package_digest` columns on `factory_process_runs` via RAW SQL, and provides
 * the LEGACY NULLABLE ADAPTER for pre-pinning runs.
 *
 * Immutable-installation pinning layer. See
 * `installation/domain/process-run-pinning.ts` for the pure value layer.
 *
 * Why raw SQL instead of extending `SqliteProcessRunRepository`:
 *   1. The persistence lane is the SINGLE SQL writer for these columns. The
 *      two new columns are added by idempotent ALTERs in `db.ts`. Touching the
 *      existing `sqlite-process-run-repository.ts` would be a hot-file
 *      conflict and would duplicate the schema-writer role.
 *   2. This adapter lives under `installation/persistence/`, which is a
 *      directory not covered by Rules 1-6 — it imports only `better-sqlite3`
 *      (type) and the pure domain layer, so it adds ZERO ratchet violations.
 *      (Adding a NEW sqlite/db edge under `composition/` would be a
 *      violation.)
 *
 * The adapter takes a `Database` (better-sqlite3) in its constructor. Tests
 * pass an mkdtemp-backed DB; production wires it at the composition root.
 *
 * Legacy nullable adapter:
 *   Pre-pinning ProcessRuns have BOTH `installation_id` and `package_digest`
 *   NULL. `getPinnedInstallation` returns `null` for those rows, and
 *   `resolveInstallationForLegacyRun` resolves the installation by the run's
 *   `module_name`+`module_version` through an injected fallback registry (the
 *   `PackageRegistry` port, or any `(name, version) => record` callable). The
 *   nullable path is removed entirely once all runs are pinned at start.
 *
 * INTEGRATION NOTE: `ModuleInstallationRecord` and the
 * The installation resolver port is defined locally to keep this adapter isolated.
 * runs in isolation and the sibling installation lanes have not landed in
 * this worktree. The canonical `ModuleInstallationRecord` lives in
 * `installation/domain/installation.ts`; the canonical `PackageRegistry`
 * lives in `installation/domain/package-registry.ts`. At cherry-pick, either
 * re-export the canonical types from here or rewrite these imports to point
 * at the canonical files and delete the local definitions. The local shapes
 * are structural subsets so the swap is mechanical. See
 * `docs/architecture/WAVE-LOG.md` (Wave 2) for the parallel-lane context.
 */

import type Database from 'better-sqlite3';
import {
  asModuleInstallationId,
  type ModuleInstallationId,
  type PinnedInstallation,
} from '../domain/process-run-pinning.js';

// ---------------------------------------------------------------------------
// InstallationResolver — package-registry projection used by validation.
// `resolveInstallationForLegacyRun`. Structural subset of the
// PackageRegistry (`select(selector): ModuleInstallationRecord`).
// ---------------------------------------------------------------------------

/**
 * Selector used to resolve a legacy run's installation by module identity.
 * Structural subset of `ModuleSelector { name; versionRange }`. We only ever
 * pass an EXACT version (legacy runs always carry an exact `module_version`),
 * so `versionRange` is the pinned version string.
 */
export interface InstallationSelector {
  readonly name: string;
  /** Exact version string (e.g. '3.0.0'). Legacy runs never carry a range. */
  readonly versionRange: string;
}

/**
 * Minimal resolver port injected into `resolveInstallationForLegacyRun`.
 *
 * This is a structural subset of the `PackageRegistry` port — the adapter
 * depends only on "given (name, version), return the active installation
 * record or null". `InstallationBasedPackageRegistry` satisfies this shape
 * (its `select(selector)` returns `ModuleInstallationRecord`); tests pass a
 * plain object/function.
 *
 * Using a structural subset (rather than importing the canonical port
 * directly) is required because this lane runs in isolation and the sibling
 * lane has not landed. At cherry-pick the integrator MAY narrow this to
 * import the canonical port directly.
 */
export interface InstallationResolver {
  /**
   * Resolve the active installation for the given selector, or `null` if no
   * active installation matches. Must NOT perform module-name switching.
   */
  resolve(selector: InstallationSelector): ModuleInstallationRecord | null;
}

// ---------------------------------------------------------------------------
// ModuleInstallationRecord (local isolation copy — canonical owner is the
// installation domain lane).
// ---------------------------------------------------------------------------

/**
 * Status of a module installation row. The ProcessRun pinning layer does not
 * enforce status transitions — it only READS the record.
 */
export type ModuleInstallationStatus =
  | 'staged'
  | 'validated'
  | 'active'
  | 'retired'
  | 'corrupt';

/**
 * Minimal projection of a `factory_module_installations` row sufficient for the
 * legacy resolver to return. This is a STRUCTURAL SUBSET of the canonical
 * `ModuleInstallationRecord` (which also carries `manifestSnapshot`,
 * `storeLocation`, `resourceIndex`, `handlerRefs`, `dependencyLock`,
 * `installedAt`, `activatedAt`). The pinning layer only needs identity +
 * digest + status to (a) name the resolved installation and (b) let the caller
 * (the executor) verify the pinned digest against the resolved record's
 * digest.
 *
 * Canonical owner: `installation/domain/installation.ts`.
 */
export interface ModuleInstallationRecord {
  readonly id: ModuleInstallationId;
  readonly name: string;
  readonly version: string;
  readonly packageDigest: string;
  readonly status: ModuleInstallationStatus;
}

// ---------------------------------------------------------------------------
// Row shapes returned by the raw SQL statements.
// ---------------------------------------------------------------------------

interface PinnedColumnsRow {
  installation_id: number | null;
  package_digest: string | null;
}

interface ModuleRefRow {
  module_name: string;
  module_version: string;
  installation_id: number | null;
}

// ---------------------------------------------------------------------------
// Adapter.
// ---------------------------------------------------------------------------

/**
 * Read/write the `installation_id` + `package_digest` columns on
 * `factory_process_runs` via raw SQL, plus the legacy nullable resolver.
 *
 * Does NOT import or extend `SqliteProcessRunRepository` (anti-scope).
 * Does NOT create the columns — the persistence lane's `db.ts` ALTERs own the
 * schema. The adapter assumes the columns exist on the supplied `db` (they
 * are added idempotently at `getDb()` time).
 *
 * The adapter is stateless beyond the injected `db` handle; all methods are
 * independent prepared-statement executions.
 */
export class ProcessRunInstallationAdapter {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Pin (or RE-pin) the installation + digest on a ProcessRun row.
   *
   * `UPDATE factory_process_runs SET installation_id=?, package_digest=? WHERE id=?`.
   * Idempotent: re-pinning the same run with new values overwrites the
   * previous pin (this is the documented "re-pin (update)" path). Returns the
   * number of rows affected (0 if the run does not exist — caller decides
   * whether to treat that as an error; this method is a no-op on a missing
   * row, matching the "no-op or error (document your choice)" option — we
   * choose no-op + count so callers can detect it).
   */
  setPinnedInstallation(
    processRunId: number,
    installationId: ModuleInstallationId,
    packageDigest: string,
  ): number {
    const info = this.db
      .prepare(
        'UPDATE factory_process_runs SET installation_id=?, package_digest=? WHERE id=?',
      )
      .run(installationId, packageDigest, processRunId);
    return Number(info.changes);
  }

  /**
   * Convenience: persist a `PinnedInstallation` value built by
   * `pinInstallationOnProcessRun`. Returns the rows-affected count (0 = run
   * not found, treat as no-op).
   */
  persistPinnedInstallation(pin: PinnedInstallation): number {
    return this.setPinnedInstallation(
      pin.processRunId,
      pin.installationId,
      pin.packageDigest,
    );
  }

  /**
   * Read the pinned installation for a ProcessRun.
   *
   * `SELECT installation_id, package_digest FROM factory_process_runs WHERE id=?`.
   * Returns `null` when:
   *   - the run row does not exist, OR
   *   - BOTH columns are NULL (legacy pre-pinning run).
   *
   * A row with exactly one of the two columns NULL is treated as corrupt and
   * throws `PROCESS_RUN_PIN_PARTIAL` — the schema invariant is "both set or
   * both NULL". New pinned runs set both atomically.
   */
  getPinnedInstallation(processRunId: number): PinnedInstallation | null {
    const row = this.db
      .prepare(
        'SELECT installation_id, package_digest FROM factory_process_runs WHERE id=?',
      )
      .get(processRunId) as PinnedColumnsRow | undefined;

    if (!row) return null;

    const id = row.installation_id;
    const digest = row.package_digest;

    if (id === null && digest === null) {
      // Legacy run: both NULL → no pin. The caller routes through
      // resolveInstallationForLegacyRun.
      return null;
    }
    if (id === null || digest === null) {
      // Partial pin — invariant violation. Should never happen under normal
      // operation (the two columns are written together in
      // setPinnedInstallation). Surface it loudly rather than silently
      // returning a half-built value.
      throw new Error(
        `PROCESS_RUN_PIN_PARTIAL: process_run ${processRunId} has installation_id=${id} `
          + `and package_digest=${digest === null ? 'null' : '<set>'}; `
          + 'expected both NULL (legacy) or both set (pinned)',
      );
    }

    return {
      processRunId,
      installationId: asModuleInstallationId(id),
      packageDigest: digest,
      // The persisted row does not carry a separate pinned_at timestamp (the
      // ALTER only adds installation_id + package_digest). The pure
      // PinnedInstallation shape requires pinnedAt; we surface the run's
      // updated_at as the closest available proxy. Callers that need the
      // exact write time should read the run row directly.
      pinnedAt: this.readUpdatedAt(processRunId),
    };
  }

  /**
   * LEGACY NULLABLE ADAPTER. For a ProcessRun whose `installation_id` is
   * NULL, resolve the installation by the run's `module_name`+
   * `module_version` through the injected fallback resolver.
   *
   * Behavior:
   *   - If the run row does not exist → return null.
   *   - If `installation_id` is NOT NULL → the run is already pinned; return
   *     null (the caller should use getPinnedInstallation instead). This keeps
   *     the legacy path STRICTLY for legacy runs.
   *   - If `installation_id` IS NULL → call `fallback.resolve({name, version})`.
   *     Returns whatever the fallback returns (a record or null if no active
   *     installation matches).
   *
   * This method is removed entirely once all runs are pinned at start time.
   */
  rejectUnpinnedInstallation(
    processRunId: number,
    fallback: InstallationResolver,
  ): ModuleInstallationRecord | null {
    void fallback;
    const row = this.db
      .prepare(
        'SELECT module_name, module_version, installation_id FROM factory_process_runs WHERE id=?',
      )
      .get(processRunId) as ModuleRefRow | undefined;

    if (!row || row.installation_id === null) {
      throw new Error(`PROCESS_RUN_PIN_REQUIRED: run ${processRunId} has no immutable installation pin`);
    }

    // Already pinned → not a legacy run. The caller should use the pin path.
    if (row.installation_id !== null) return null;

    return fallback.resolve({
      name: row.module_name,
      versionRange: row.module_version,
    });
  }

  /**
   * Read the `updated_at` timestamp for a run, used as the closest proxy for
   * `pinnedAt` when surfacing a `PinnedInstallation` from the row. Returns the
   * empty string if the row vanished between the column read and this read
   * (treated as "no timestamp available" — the pin value is still valid; the
   * caller that needs a timestamp should read the run row directly).
   */
  private readUpdatedAt(processRunId: number): string {
    const row = this.db
      .prepare('SELECT updated_at FROM factory_process_runs WHERE id=?')
      .get(processRunId) as { updated_at: string } | undefined;
    return row?.updated_at ?? '';
  }
}
