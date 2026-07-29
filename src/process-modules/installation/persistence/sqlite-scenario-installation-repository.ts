/**
 * W7-A1 — `SqliteScenarioInstallationRepository` adapter +
 * `ensureSaga3ScenarioInstallationSchema(db)`.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md`
 * (Lanes row W7-A1; §0.10.3 / §0.10.12). Plan: §4.3.3
 * (ScenarioInstallationRepository port), §6.6-6.7 (scenario installation
 * resolves module selectors to exact InstalledProcessModule + writes scenario
 * module lock; LifecycleRun pins both at start), §5.5.9 (deletion-restricted).
 * Task: `docs/refactor-management/05-subagent-tasks/W07-a1.md`.
 *
 * This is the SINGLE SQL owner of the `saga3_scenario_installations` and
 * `saga3_scenario_module_locks` tables (plan §0.5.2, C083). No other Wave 7
 * lane may create SQL tables or edit `db.ts`.
 *
 * ## What the SQL enforces
 *
 * `saga3_scenario_installations`:
 *   - The partial UNIQUE index
 *     `idx_saga3_scenario_installations_active ON (scenario_name, scenario_version) WHERE status='active'`
 *     is the scenario-version-immutability invariant (mirrors W2-A2 §4): at
 *     most ONE active installation per scenario identity. The adapter detects
 *     the resulting `SQLITE_CONSTRAINT_UNIQUE` violation on `installScenario`
 *     (active) / `activate` and translates it to
 *     `SCENARIO_INSTALLATION_VERSION_COLLISION` when the colliding row carries
 *     a DIFFERENT `scenario_digest`; an identical digest is an idempotent
 *     replay and returns the existing active row.
 *   - NO `ON DELETE SET NULL` (plan §5.5.9): installations referenced by
 *     LifecycleRuns are deletion-restricted. The repository exposes NO delete
 *     method — only `retire` (status `active` → `retired`), which releases the
 *     unique-active slot but preserves the row for replay verification.
 *
 * `saga3_scenario_module_locks`:
 *   - One row per `(scenario_installation_id, stage_id)`. The UNIQUE index
 *     `idx_saga3_scenario_module_locks_pair ON (scenario_installation_id, stage_id)`
 *     makes the lock a single durable pin per stage (plan §6.6-6.7).
 *   - `module_installation_id` REFERENCES `saga3_module_installations(id)`:
 *     the lock pins an EXACT installed module package, not just a name+version.
 *     `module_package_digest` is denormalized so a reader can detect drift
 *     without a JOIN.
 *   - `ON DELETE CASCADE` on `scenario_installation_id`: the lock is owned by
 *     its installation. (There is no delete path on the installation itself —
 *     `retire` keeps the row — so this cascade is defence-in-depth, never
 *     triggered in normal operation.)
 *
 * ## Serialization
 *
 * `manifest_snapshot` and `module_lock` are serialized via Wave 1's
 * `canonicalJson` and stored as TEXT. Reading deserializes them back with
 * `JSON.parse`; the record handed to callers round-trips byte-identically
 * through canonical re-serialization (the property `scenarioDigest` depends on).
 *
 * ## Atomicity
 *
 * `installScenario` writes the installation row and ALL module-lock rows in a
 * single `db.transaction`. If any lock INSERT fails, the whole install rolls
 * back — a partial lock never reaches the tables.
 *
 * ## Dual-placement (mirrors Wave 2/3/4/5 pattern)
 *
 * `saga3_scenario_installations` REFERENCES `saga3_module_installations`
 * (W2-A2) and `saga3_scenario_module_locks` REFERENCES both. On a fresh DB the
 * parent table exists (W2-A2's `ensureSaga3ModuleInstallationSchema` runs
 * earlier in `getDb()`), so the FK target is present and the schema can be
 * created here. `ensureSaga3ScenarioInstallationSchema` is therefore called
 * BOTH from the `SqliteScenarioInstallationRepository` constructor (lazy path)
 * AND from `db.ts` `getDb()` (upgrade path for pre-existing DBs). `CREATE
 * TABLE IF NOT EXISTS` makes the second placement a no-op, so both paths are
 * idempotent.
 *
 * ## Rule 5 / Rule 2 (ratchet)
 *
 * This file lives under `installation/persistence/`. It imports
 *   - `better-sqlite3` (type-only) — allowed: persistence adapter.
 *   - `../../db.js` is NOT imported here (the adapter takes the db handle via
 *     the constructor, mirroring W2-A2; `db.ts` imports THIS file).
 *   - `../../shared/canonical-json.js` — Wave 1 pure primitive.
 *   - `../scenario-store.js` — pure domain types + port (sibling).
 *   - `../domain/installation.js` — pure branded id (type-only).
 * None of these is a `domain/` import of a non-pure module, so Rule 5 holds.
 */

import type Database from 'better-sqlite3';
import { canonicalJson } from '../../shared/canonical-json.js';
import {
  asScenarioInstallationId,
  SCENARIO_INSTALLATION_NOT_FOUND,
  SCENARIO_INSTALLATION_VERSION_COLLISION,
  SCENARIO_MODULE_LOCK_INCOMPLETE,
  type InstallScenarioInput,
  type ScenarioInstallationId,
  type ScenarioInstallationRecord,
  type ScenarioInstallationStatus,
  type ScenarioModuleLockEntry,
  type ScenarioModuleLockRecord,
} from '../scenario-store.js';
import type { ModuleInstallationId } from '../domain/installation.js';

// ---------------------------------------------------------------------------
// Row shapes (SQLite snake_case).
// ---------------------------------------------------------------------------

interface ScenarioInstallationRow {
  id: number;
  scenario_name: string;
  scenario_version: string;
  scenario_digest: string;
  manifest_snapshot: string;
  module_lock: string;
  store_location: string;
  status: ScenarioInstallationStatus;
  installed_at: string;
  activated_at: string | null;
  retired_at: string | null;
}

interface ScenarioModuleLockRow {
  id: number;
  scenario_installation_id: number;
  stage_id: string;
  module_installation_id: number;
  module_name: string;
  module_version: string;
  module_package_digest: string;
  selector_version_range: string;
}

// ---------------------------------------------------------------------------
// Schema creation.
// ---------------------------------------------------------------------------

/**
 * Create the `saga3_scenario_installations` + `saga3_scenario_module_locks`
 * tables + indexes (plan §6.6-6.7, mirrors W2-A2 §3). Idempotent — safe to
 * call on every repository construction and from `db.ts` `getDb()`.
 *
 * The schema is created with `CREATE TABLE IF NOT EXISTS`; the indexes are
 * created with `CREATE [UNIQUE] INDEX IF NOT EXISTS`. Calling this on a DB
 * that already has both tables is a no-op.
 *
 * The partial UNIQUE index
 * `idx_saga3_scenario_installations_active ON (scenario_name, scenario_version) WHERE status='active'`
 * is the scenario-version-immutability invariant. NO `ON DELETE SET NULL`
 * (plan §5.5.9).
 */
export function ensureSaga3ScenarioInstallationSchema(
  db: Database.Database,
): void {
  db.exec(`
    -- Single source of truth for "which scenario is installed" (W7-A1).
    -- One row per installed scenario identity. Identity rules mirror W2-A2 §4.
    CREATE TABLE IF NOT EXISTS saga3_scenario_installations (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_name               TEXT NOT NULL,                    -- manifest.identity.name (denormalized for the active-unique index)
      scenario_version            TEXT NOT NULL,                    -- manifest.identity.version
      scenario_digest             TEXT NOT NULL,                    -- sha256Hex of canonical { manifest, moduleLock }
      manifest_snapshot           TEXT NOT NULL,                    -- canonical JSON of LifecycleScenarioManifest
      module_lock                 TEXT NOT NULL,                    -- canonical JSON of ScenarioModuleLockEntry[] (denormalized copy of the lock table rows)
      store_location              TEXT NOT NULL,                    -- content-addressed path
      status                      TEXT NOT NULL DEFAULT 'staged'    -- staged|active|retired
                                    CHECK (status IN ('staged','active','retired')),
      installed_at                TEXT NOT NULL,
      activated_at                TEXT,
      retired_at                  TEXT
    );

    -- Scenario version immutability (mirrors W2-A2 §4): at most ONE active
    -- installation per (scenario_name, scenario_version). A second active row
    -- under the same identity with a DIFFERENT scenario_digest is rejected by
    -- the adapter with SCENARIO_INSTALLATION_VERSION_COLLISION. SQLite's
    -- partial UNIQUE index is the structural enforcement; the adapter
    -- translates the violation.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_scenario_installations_active
      ON saga3_scenario_installations(scenario_name, scenario_version) WHERE status = 'active';

    -- Lookup by scenario digest (replay verification, registry selection).
    CREATE INDEX IF NOT EXISTS idx_saga3_scenario_installations_digest
      ON saga3_scenario_installations(scenario_digest);

    -- Per-stage exact module pin (plan §6.6-6.7). One row per
    -- (scenario_installation_id, stage_id). The UNIQUE index makes the lock a
    -- single durable pin per stage; module_installation_id pins the EXACT
    -- installed package (not just name+version).
    CREATE TABLE IF NOT EXISTS saga3_scenario_module_locks (
      id                            INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_installation_id      INTEGER NOT NULL REFERENCES saga3_scenario_installations(id) ON DELETE CASCADE,
      stage_id                      TEXT NOT NULL,                  -- ScenarioStageBinding.id within the manifest
      module_installation_id        INTEGER NOT NULL REFERENCES saga3_module_installations(id) ON DELETE RESTRICT,
      module_name                   TEXT NOT NULL,                  -- denormalized for lookup without a JOIN
      module_version                TEXT NOT NULL,                  -- denormalized
      module_package_digest         TEXT NOT NULL,                  -- exact pin: the module's package_digest (W2-A2)
      selector_version_range        TEXT NOT NULL                   -- the ModuleSelector.versionRange the manifest declared
    );

    -- One lock row per scenario stage (plan §6.6-6.7).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_scenario_module_locks_pair
      ON saga3_scenario_module_locks(scenario_installation_id, stage_id);

    -- Reverse lookup: which scenario installations pin this module installation?
    CREATE INDEX IF NOT EXISTS idx_saga3_scenario_module_locks_module
      ON saga3_scenario_module_locks(module_installation_id);
  `);
}

// ---------------------------------------------------------------------------
// Row <-> record mapping.
// ---------------------------------------------------------------------------

function lockEntryToRecord(
  row: ScenarioModuleLockRow,
): ScenarioModuleLockRecord {
  return {
    id: row.id,
    scenarioInstallationId: asScenarioInstallationId(row.scenario_installation_id),
    stageId: row.stage_id,
    moduleInstallationId: row.module_installation_id as ModuleInstallationId,
    moduleName: row.module_name,
    moduleVersion: row.module_version,
    modulePackageDigest: row.module_package_digest,
    selectorVersionRange: row.selector_version_range,
  };
}

function installationRowToRecord(
  row: ScenarioInstallationRow,
  lockRows: readonly ScenarioModuleLockRow[],
): ScenarioInstallationRecord {
  // The denormalized module_lock TEXT and the lock-table rows are written
  // together by installScenario; prefer the lock-table rows (the source of
  // truth) but fall back to the TEXT column if the table lookup returned
  // nothing (defence-in-depth for older reads).
  const lockEntries: ScenarioModuleLockEntry[] =
    lockRows.length > 0
      ? lockRows.map((r) => ({
        stageId: r.stage_id,
        moduleInstallationId: r.module_installation_id as ModuleInstallationId,
        moduleName: r.module_name,
        moduleVersion: r.module_version,
        modulePackageDigest: r.module_package_digest,
        selectorVersionRange: r.selector_version_range,
      }))
      : (JSON.parse(row.module_lock) as ScenarioModuleLockEntry[]);
  return {
    id: asScenarioInstallationId(row.id),
    scenarioName: row.scenario_name,
    scenarioVersion: row.scenario_version,
    scenarioDigest: row.scenario_digest,
    manifestSnapshot: JSON.parse(row.manifest_snapshot) as ScenarioInstallationRecord['manifestSnapshot'],
    moduleLock: lockEntries,
    storeLocation: row.store_location,
    status: row.status,
    installedAt: row.installed_at,
    activatedAt: row.activated_at ?? undefined,
    retiredAt: row.retired_at ?? undefined,
  };
}

function readInstallationRowById(
  db: Database.Database,
  id: ScenarioInstallationId,
): ScenarioInstallationRow | null {
  const row = db
    .prepare('SELECT * FROM saga3_scenario_installations WHERE id=?')
    .get(id) as ScenarioInstallationRow | undefined;
  return row ?? null;
}

function readLockRowsForInstallation(
  db: Database.Database,
  scenarioInstallationId: ScenarioInstallationId,
): ScenarioModuleLockRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM saga3_scenario_module_locks
        WHERE scenario_installation_id=?
        ORDER BY id ASC`,
    )
    .all(scenarioInstallationId) as ScenarioModuleLockRow[];
  return rows;
}

/**
 * Read the active installation row for `(scenarioName, scenarioVersion)`, or
 * null. The partial UNIQUE index guarantees at most one match.
 */
function readActiveRowByNameVersion(
  db: Database.Database,
  scenarioName: string,
  scenarioVersion: string,
): ScenarioInstallationRow | null {
  const row = db
    .prepare(
      `SELECT * FROM saga3_scenario_installations
        WHERE scenario_name=? AND scenario_version=? AND status='active'`,
    )
    .get(scenarioName, scenarioVersion) as ScenarioInstallationRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Lock validation (pure, pre-write).
// ---------------------------------------------------------------------------

/**
 * Validate that the supplied module lock exactly covers the manifest's stage
 * bindings: every `manifestSnapshot.stageBindings[].id` has exactly one lock
 * entry, and every lock entry's `stageId` matches a stage binding. Returns an
 * array of human-readable mismatch descriptions (empty == valid).
 *
 * Runs BEFORE any write in `installScenario` so a partial lock never reaches
 * the tables. Mirrors the fail-fast policy of W2-A6 `bindInstallation`.
 */
function validateLockAgainstManifest(
  input: InstallScenarioInput,
): string[] {
  const errors: string[] = [];
  const manifestStages = input.manifestSnapshot.stageBindings;
  const manifestStageIds = new Set<string>();
  for (const sb of manifestStages) {
    manifestStageIds.add(sb.id);
  }
  const lockStageIds = new Set<string>();
  for (const entry of input.moduleLock) {
    if (!manifestStageIds.has(entry.stageId)) {
      errors.push(
        `module lock entry for stage "${entry.stageId}" has no matching stageBinding in the manifest`,
      );
    }
    if (lockStageIds.has(entry.stageId)) {
      errors.push(`module lock has duplicate entry for stage "${entry.stageId}"`);
    }
    lockStageIds.add(entry.stageId);
  }
  for (const stageId of manifestStageIds) {
    if (!lockStageIds.has(stageId)) {
      errors.push(
        `manifest stage "${stageId}" has no module lock entry`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// SQLite adapter.
// ---------------------------------------------------------------------------

/**
 * Concrete SQLite implementation of `ScenarioInstallationRepository`.
 *
 * Construction is cheap and idempotent: the schema is created on first use
 * via {@link ensureSaga3ScenarioInstallationSchema} (CREATE IF NOT EXISTS).
 * Production wires one instance at the composition root; tests construct one
 * against a temp DB.
 */
export class SqliteScenarioInstallationRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    ensureSaga3ScenarioInstallationSchema(this.db);
  }

  installScenario(
    input: InstallScenarioInput,
  ): ScenarioInstallationRecord {
    // Fail-fast: validate the lock covers the manifest exactly BEFORE any
    // write. A partial lock never reaches the tables.
    const lockErrors = validateLockAgainstManifest(input);
    if (lockErrors.length > 0) {
      throw new Error(
        `${SCENARIO_MODULE_LOCK_INCOMPLETE}: ${lockErrors.join('; ')}`,
      );
    }

    const status: ScenarioInstallationStatus = input.status ?? 'active';
    const manifestSnapshotJson = canonicalJson(input.manifestSnapshot);
    const moduleLockJson = canonicalJson(input.moduleLock);
    const installedAt = new Date().toISOString();

    // Version immutability pre-check for the active path: resolve before INSERT
    // so we can distinguish idempotent replay (same digest) from collision
    // (different digest). The invariant is ALSO structurally enforced by the
    // partial UNIQUE index; the pre-check gives the right error message.
    if (status === 'active') {
      const existing = readActiveRowByNameVersion(
        this.db,
        input.scenarioName,
        input.scenarioVersion,
      );
      if (existing) {
        if (existing.scenario_digest === input.scenarioDigest) {
          // Idempotent replay: same (name, version, digest) already active.
          const lockRows = readLockRowsForInstallation(
            this.db,
            asScenarioInstallationId(existing.id),
          );
          return installationRowToRecord(existing, lockRows);
        }
        throw new Error(
          `${SCENARIO_INSTALLATION_VERSION_COLLISION}: an active scenario installation for `
          + `${input.scenarioName}@${input.scenarioVersion} already exists with scenario_digest `
          + `'${existing.scenario_digest}' (received '${input.scenarioDigest}'). `
          + `Released scenario identity is immutable; use a prerelease version for `
          + `development (plan §5.5.8).`,
        );
      }
    }

    // Atomic write: installation row + every lock row in one transaction.
    const install = ():
      { row: ScenarioInstallationRow; lockRows: ScenarioModuleLockRow[] } => {
      const tx = this.db.transaction(() => {
        let lastInsertRowid: number | bigint;
        try {
          const info = this.db.prepare(
            `INSERT INTO saga3_scenario_installations
               (scenario_name, scenario_version, scenario_digest,
                manifest_snapshot, module_lock, store_location, status,
                installed_at, activated_at, retired_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            input.scenarioName,
            input.scenarioVersion,
            input.scenarioDigest,
            manifestSnapshotJson,
            moduleLockJson,
            input.storeLocation,
            status,
            installedAt,
            status === 'active' ? installedAt : null,
            null,
          );
          lastInsertRowid = info.lastInsertRowid;
        } catch (err) {
          // Race: a concurrent INSERT won the active slot between the pre-check
          // and the INSERT. Translate any UNIQUE violation on the active index.
          const msg = (err as Error).message ?? '';
          if (
            msg.includes('UNIQUE')
            && msg.includes('idx_saga3_scenario_installations_active')
          ) {
            const existing = readActiveRowByNameVersion(
              this.db,
              input.scenarioName,
              input.scenarioVersion,
            );
            if (existing && existing.scenario_digest !== input.scenarioDigest) {
              throw new Error(
                `${SCENARIO_INSTALLATION_VERSION_COLLISION}: concurrent install won the active `
                + `slot for ${input.scenarioName}@${input.scenarioVersion} with a different scenario_digest.`,
              );
            }
          }
          throw err;
        }

        const newId = asScenarioInstallationId(Number(lastInsertRowid));
        // Insert one lock row per stage. The UNIQUE(scenario_installation_id,
        // stage_id) index + the pre-write validation guarantee no duplicates.
        const insertLock = this.db.prepare(
          `INSERT INTO saga3_scenario_module_locks
             (scenario_installation_id, stage_id, module_installation_id,
              module_name, module_version, module_package_digest,
              selector_version_range)
           VALUES (?,?,?,?,?,?,?)`,
        );
        for (const entry of input.moduleLock) {
          insertLock.run(
            newId,
            entry.stageId,
            entry.moduleInstallationId,
            entry.moduleName,
            entry.moduleVersion,
            entry.modulePackageDigest,
            entry.selectorVersionRange,
          );
        }
        const row = readInstallationRowById(this.db, newId);
        if (!row) {
          throw new Error('saga3: scenario_installation vanished after insert');
        }
        const lockRows = readLockRowsForInstallation(this.db, newId);
        return { row, lockRows };
      });
      return tx();
    };

    const { row, lockRows } = install();
    return installationRowToRecord(row, lockRows);
  }

  getScenarioInstallation(
    id: ScenarioInstallationId,
  ): ScenarioInstallationRecord | null {
    const row = readInstallationRowById(this.db, id);
    if (!row) return null;
    const lockRows = readLockRowsForInstallation(this.db, id);
    return installationRowToRecord(row, lockRows);
  }

  getModuleLock(
    scenarioInstallationId: ScenarioInstallationId,
  ): readonly ScenarioModuleLockRecord[] | null {
    const row = readInstallationRowById(this.db, scenarioInstallationId);
    if (!row) return null;
    const lockRows = readLockRowsForInstallation(this.db, scenarioInstallationId);
    return lockRows.map(lockEntryToRecord);
  }

  getActiveByNameVersion(
    scenarioName: string,
    scenarioVersion: string,
  ): ScenarioInstallationRecord | null {
    const row = readActiveRowByNameVersion(this.db, scenarioName, scenarioVersion);
    if (!row) return null;
    const lockRows = readLockRowsForInstallation(
      this.db,
      asScenarioInstallationId(row.id),
    );
    return installationRowToRecord(row, lockRows);
  }

  getByDigest(digest: string): ScenarioInstallationRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM saga3_scenario_installations WHERE scenario_digest=?',
      )
      .get(digest) as ScenarioInstallationRow | undefined;
    if (!row) return null;
    const lockRows = readLockRowsForInstallation(
      this.db,
      asScenarioInstallationId(row.id),
    );
    return installationRowToRecord(row, lockRows);
  }

  activate(id: ScenarioInstallationId): ScenarioInstallationRecord {
    const current = readInstallationRowById(this.db, id);
    if (!current) {
      throw new Error(
        `${SCENARIO_INSTALLATION_NOT_FOUND}: scenario installation id=${id} not found`,
      );
    }
    // Idempotent: already active.
    if (current.status === 'active') {
      const lockRows = readLockRowsForInstallation(this.db, id);
      return installationRowToRecord(current, lockRows);
    }

    // Version immutability: another row holding the active slot for the same
    // identity blocks this activation.
    const holder = readActiveRowByNameVersion(
      this.db,
      current.scenario_name,
      current.scenario_version,
    );
    if (holder && holder.id !== current.id) {
      throw new Error(
        `${SCENARIO_INSTALLATION_VERSION_COLLISION}: cannot activate `
        + `${current.scenario_name}@${current.scenario_version} (id=${id}); `
        + `installation id=${holder.id} already holds the active slot`
        + (holder.scenario_digest !== current.scenario_digest
          ? ` with a different scenario_digest ('${holder.scenario_digest}' vs '${current.scenario_digest}')`
          : ''),
      );
    }

    try {
      const info = this.db
        .prepare(
          `UPDATE saga3_scenario_installations
              SET status='active',
                  activated_at=COALESCE(activated_at, datetime('now'))
            WHERE id=?`,
        )
        .run(id);
      if (info.changes === 0) {
        throw new Error(
          `${SCENARIO_INSTALLATION_NOT_FOUND}: scenario installation id=${id} vanished during activate`,
        );
      }
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (
        msg.includes('UNIQUE')
        && msg.includes('idx_saga3_scenario_installations_active')
      ) {
        throw new Error(
          `${SCENARIO_INSTALLATION_VERSION_COLLISION}: concurrent activation won the `
          + `active slot for ${current.scenario_name}@${current.scenario_version}.`,
        );
      }
      throw err;
    }

    const after = readInstallationRowById(this.db, id);
    if (!after) {
      throw new Error(
        `${SCENARIO_INSTALLATION_NOT_FOUND}: scenario installation id=${id} vanished after activate`,
      );
    }
    const lockRows = readLockRowsForInstallation(this.db, id);
    return installationRowToRecord(after, lockRows);
  }

  retire(id: ScenarioInstallationId): ScenarioInstallationRecord {
    const info = this.db
      .prepare(
        `UPDATE saga3_scenario_installations
            SET status='retired',
                retired_at=COALESCE(retired_at, datetime('now'))
          WHERE id=?`,
      )
      .run(id);
    if (info.changes === 0) {
      throw new Error(
        `${SCENARIO_INSTALLATION_NOT_FOUND}: scenario installation id=${id} not found`,
      );
    }
    const after = readInstallationRowById(this.db, id);
    if (!after) {
      throw new Error(
        `${SCENARIO_INSTALLATION_NOT_FOUND}: scenario installation id=${id} vanished after retire`,
      );
    }
    const lockRows = readLockRowsForInstallation(this.db, id);
    return installationRowToRecord(after, lockRows);
  }

  listActive(): readonly ScenarioInstallationRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM saga3_scenario_installations
          WHERE status='active'
          ORDER BY scenario_name ASC, scenario_version ASC`,
      )
      .all() as ScenarioInstallationRow[];
    return rows.map((row) => {
      const lockRows = readLockRowsForInstallation(
        this.db,
        asScenarioInstallationId(row.id),
      );
      return installationRowToRecord(row, lockRows);
    });
  }
}
