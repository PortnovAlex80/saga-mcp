/**
 * ProcessRunInstallationAdapter — reads/writes the `installation_id` +
 * `package_digest` columns on `saga3_process_runs` via RAW SQL, and provides
 * the LEGACY NULLABLE ADAPTER (plan §14.3.7) for pre-Wave-2 runs.
 *
 * Wave 2 immutable-installation layer (W2-A4). See
 * `installation/domain/process-run-pinning.ts` for the pure value layer and
 * `WAVE2-IMMUTABLE-INSTALLATION-SPEC.md` §1 rows 7,8, §3 (the ALTERs), §4
 * (pinning rules), §5 (anti-scope — "No edits to existing
 * sqlite-process-run-repository.ts").
 *
 * Why raw SQL instead of extending `SqliteProcessRunRepository`:
 *   1. W2-A2 is the SINGLE SQL writer (C083, spec §3). The two new columns are
 *      added by W2-A2's idempotent ALTERs in `db.ts`. Touching the existing
 *      `sqlite-process-run-repository.ts` would be a hot-file conflict
 *      (plan §0.2.4) and would duplicate the schema-writer role.
 *   2. The ratchet (Rule 6) allowlists `composition/product-lifecycle-runtime.ts`
 *      as the ONLY composition-root smell. Adding a NEW sqlite/db edge there is
 *      a violation. This adapter lives under `installation/persistence/`, which
 *      is a NEW directory not covered by Rules 1-6 — it imports only
 *      `better-sqlite3` (type) and the pure domain layer, so it adds ZERO
 *      ratchet violations.
 *
 * The adapter takes a `Database` (better-sqlite3) in its constructor. Tests
 * pass an mkdtemp-backed DB; production will wire it at the composition root
 * (Wave 11 cutover — not this lane).
 *
 * Legacy nullable adapter (plan §14.3.7):
 *   Pre-Wave-2 ProcessRuns have BOTH `installation_id` and `package_digest`
 *   NULL. `getPinnedInstallation` returns `null` for those rows, and
 *   `resolveInstallationForLegacyRun` resolves the installation by the run's
 *   `module_name`+`module_version` through an injected fallback registry
 *   (W2-A5's `PackageRegistry` port, or any `(name, version) => record`
 *   callable). Wave 13 removes this path entirely once all runs are pinned.
 *
 * INTEGRATION NOTE (integrator, Wave 2 cherry-pick): `ModuleInstallationRecord`
 * and the `LegacyInstallationResolver` shape are defined here ONLY because W2-A4
 * runs in isolation and W2-A2/W2-A5 have not landed in this worktree. The
 * canonical `ModuleInstallationRecord` lives in W2-A2's
 * `installation/domain/installation.ts`; the canonical `PackageRegistry` lives
 * in W2-A5's `installation/domain/package-registry.ts`. At cherry-pick, either
 * re-export the canonical types from here or rewrite these imports to point at
 * the canonical files and delete the local definitions. The local shapes are
 * structural subsets so the swap is mechanical.
 */

import type Database from 'better-sqlite3';
import {
  asModuleInstallationId,
  type ModuleInstallationId,
  type PinnedInstallation,
} from '../domain/process-run-pinning.js';

// ---------------------------------------------------------------------------
// LegacyInstallationResolver — the fallback port injected into
// `resolveInstallationForLegacyRun`. Structural subset of W2-A5's
// PackageRegistry (`select(selector): ModuleInstallationRecord`).
// ---------------------------------------------------------------------------

/**
 * Selector used to resolve a legacy run's installation by module identity.
 * Structural subset of W2-A5's `ModuleSelector { name; versionRange }`. We
 * only ever pass an EXACT version (legacy runs always carry an exact
 * `module_version`), so `versionRange` is the pinned version string.
 */
export interface LegacyInstallationSelector {
  readonly name: string;
  /** Exact version string (e.g. '3.0.0'). Legacy runs never carry a range. */
  readonly versionRange: string;
}

/**
 * Minimal resolver port injected into `resolveInstallationForLegacyRun`.
 *
 * This is a structural subset of W2-A5's `PackageRegistry` port — the adapter
 * depends only on "given (name, version), return the active installation
 * record or null". W2-A5's `InstallationBasedPackageRegistry` satisfies this
 * shape (its `select(selector)` returns `ModuleInstallationRecord`); tests
 * pass a plain object/function.
 *
 * Using a structural subset (rather than importing W2-A5's port directly) is
 * required because W2-A4 runs in isolation and W2-A5 has not landed. At
 * cherry-pick the integrator MAY narrow this to import W2-A5's port directly.
 */
export interface LegacyInstallationResolver {
  /**
   * Resolve the active installation for the given selector, or `null` if no
   * active installation matches. Must NOT perform module-name switching
   * (plan §14.4.1).
   */
  resolve(selector: LegacyInstallationSelector): ModuleInstallationRecord | null;
}

// ---------------------------------------------------------------------------
// ModuleInstallationRecord (local isolation copy — canonical owner is W2-A2).
// ---------------------------------------------------------------------------

/**
 * Status of a module installation row (W2-A2 §3 schema). The ProcessRun pinning
 * layer does not enforce status transitions — it only READS the record.
 */
export type ModuleInstallationStatus =
  | 'staged'
  | 'validated'
  | 'active'
  | 'retired'
  | 'corrupt';

/**
 * Minimal projection of a `saga3_module_installations` row sufficient for the
 * legacy resolver to return. This is a STRUCTURAL SUBSET of W2-A2's canonical
 * `ModuleInstallationRecord` (which also carries `manifestSnapshot`,
 * `storeLocation`, `resourceIndex`, `handlerRefs`, `dependencyLock`,
 * `installedAt`, `activatedAt`). The pinning layer only needs identity +
 * digest + status to (a) name the resolved installation and (b) let the caller
 * (Wave 3 executor) verify the pinned digest against the resolved record's
 * digest.
 *
 * Canonical owner: W2-A2 `installation/domain/installation.ts`.
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
 * `saga3_process_runs` via raw SQL, plus the legacy nullable resolver.
 *
 * Does NOT import or extend `SqliteProcessRunRepository` (spec §5 anti-scope).
 * Does NOT create the columns — W2-A2's `db.ts` ALTERs own the schema
 * (C083). The adapter assumes the columns exist on the supplied `db` (they
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
   * `UPDATE saga3_process_runs SET installation_id=?, package_digest=? WHERE id=?`.
   * Idempotent: re-pinning the same run with new values overwrites the
   * previous pin (this is the documented "re-pin (update)" path, spec W2-A4).
   * Returns the number of rows affected (0 if the run does not exist — caller
   * decides whether to treat that as an error; this method is a no-op on a
   * missing row, matching the "no-op or error (document your choice)" option
   * in the task spec — we choose no-op + count so callers can detect it).
   */
  setPinnedInstallation(
    processRunId: number,
    installationId: ModuleInstallationId,
    packageDigest: string,
  ): number {
    const info = this.db
      .prepare(
        'UPDATE saga3_process_runs SET installation_id=?, package_digest=? WHERE id=?',
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
   * `SELECT installation_id, package_digest FROM saga3_process_runs WHERE id=?`.
   * Returns `null` when:
   *   - the run row does not exist, OR
   *   - BOTH columns are NULL (legacy pre-Wave-2 run, plan §14.3.7).
   *
   * A row with exactly one of the two columns NULL is treated as corrupt and
   * throws `PROCESS_RUN_PIN_PARTIAL` — the schema invariant is "both set or
   * both NULL" (spec §4, §14.3.7). New Wave-2+ runs set both atomically.
   */
  getPinnedInstallation(processRunId: number): PinnedInstallation | null {
    const row = this.db
      .prepare(
        'SELECT installation_id, package_digest FROM saga3_process_runs WHERE id=?',
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
   * LEGACY NULLABLE ADAPTER (plan §14.3.7). For a ProcessRun whose
   * `installation_id` is NULL, resolve the installation by the run's
   * `module_name`+`module_version` through the injected fallback resolver.
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
   * Wave 13 removes this method entirely once all runs are pinned at start
   * time (plan §16.9, §14.3.7).
   */
  resolveInstallationForLegacyRun(
    processRunId: number,
    fallback: LegacyInstallationResolver,
  ): ModuleInstallationRecord | null {
    const row = this.db
      .prepare(
        'SELECT module_name, module_version, installation_id FROM saga3_process_runs WHERE id=?',
      )
      .get(processRunId) as ModuleRefRow | undefined;

    if (!row) return null;

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
      .prepare('SELECT updated_at FROM saga3_process_runs WHERE id=?')
      .get(processRunId) as { updated_at: string } | undefined;
    return row?.updated_at ?? '';
  }
}
