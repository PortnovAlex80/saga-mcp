/**
 * W2-A2 — `ModuleInstallationRepository` PORT + `SqliteModuleInstallationRepository`
 * adapter + `ensureSaga3ModuleInstallationSchema(db)`.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 * §1 row 5, §3, §4. Task:
 * `docs/refactor-management/05-subagent-tasks/W02-A2-installation-repository-sql-owner.md`.
 *
 * This is the SINGLE SQL owner of the `saga3_module_installations` table (plan
 * §0.5.2, C083). No other Wave 2 lane may create SQL tables or edit `db.ts`.
 *
 * ## What the SQL enforces
 *
 * The partial UNIQUE index
 * `idx_saga3_module_installations_active ON (name, version) WHERE status='active'`
 * is the version-immutability invariant (spec §4): at most ONE active
 * installation per `(name, version)`. The adapter detects the resulting SQLite
 * `SQLITE_CONSTRAINT_UNIQUE` violation on `insert`/`activate` and translates it
 * to `MODULE_INSTALLATION_VERSION_COLLISION` when the colliding row carries a
 * DIFFERENT `package_digest`; an identical digest is an idempotent replay and
 * returns the existing active row.
 *
 * There is NO `ON DELETE SET NULL` (plan §5.5.9): installations referenced by
 * ProcessRuns are deletion-restricted. The repository exposes NO delete method
 * — only `retire` (status transition `active` → `retired`), which releases the
 * unique-active slot but preserves the row for replay verification.
 *
 * ## Serialization
 *
 * `manifestSnapshot`, `resourceIndex`, `handlerRefs`, and `dependencyLock` are
 * serialized via Wave 1's `canonicalJson` and stored as TEXT. Reading
 * deserializes them back with `JSON.parse`; the record handed to callers
 * therefore round-trips byte-identically through canonical re-serialization
 * (the property `computePackageDigest` depends on, spec §4).
 *
 * ## Rule 5 / Rule 2 (ratchet)
 *
 * This file lives under `installation/persistence/`. It imports
 *   - `better-sqlite3` (type-only) — allowed: persistence adapter.
 *   - `../../db.js` (runtime) — allowed: persistence adapter (Rule 2 governs
 *     `modules/*`, not `installation/persistence/*`; Rule 5 governs `domain/*`).
 *   - `../../shared/canonical-json.js` — Wave 1 pure primitive.
 *   - `../domain/installation.js` — pure domain types.
 * None of these is a `domain/` import of a non-pure module, so Rule 5 holds.
 */

import type Database from 'better-sqlite3';
import { canonicalJson } from '../../shared/canonical-json.js';
import {
  asModuleInstallationId,
  MODULE_INSTALLATION_CORRUPT,
  MODULE_INSTALLATION_NOT_FOUND,
  MODULE_INSTALLATION_VERSION_COLLISION,
  type ModuleInstallationId,
  type ModuleInstallationRecord,
  type ModuleInstallationStatus,
} from '../domain/installation.js';

// ---------------------------------------------------------------------------
// Row shape (SQLite snake_case).
// ---------------------------------------------------------------------------

interface ModuleInstallationRow {
  id: number;
  name: string;
  version: string;
  package_digest: string;
  manifest_snapshot: string;
  store_location: string;
  resource_index: string;
  handler_refs: string;
  dependency_lock: string;
  status: ModuleInstallationStatus;
  installed_at: string;
  activated_at: string | null;
  retired_at: string | null;
}

// ---------------------------------------------------------------------------
// Schema creation.
// ---------------------------------------------------------------------------

/**
 * Create the `saga3_module_installations` table + indexes (spec §3). Idempotent
 * — safe to call on every repository construction and from `db.ts` `getDb()`.
 *
 * The schema is created with `CREATE TABLE IF NOT EXISTS`; the two indexes are
 * created with `CREATE [UNIQUE] INDEX IF NOT EXISTS`. Calling this on a DB that
 * already has the table is a no-op.
 *
 * The partial UNIQUE index
 * `idx_saga3_module_installations_active ON (name, version) WHERE status='active'`
 * is the version-immutability invariant. NO `ON DELETE SET NULL` (plan §5.5.9).
 */
export function ensureSaga3ModuleInstallationSchema(db: Database.Database): void {
  db.exec(`
    -- Single source of truth for "what is installed" (W2-A2, spec §3).
    -- One row per installed package version. Identity rules: spec §4.
    CREATE TABLE IF NOT EXISTS saga3_module_installations (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      name                        TEXT NOT NULL,                    -- module identity name (denormalized for the active-unique index)
      version                     TEXT NOT NULL,                    -- module identity version
      package_digest              TEXT NOT NULL,                    -- sha256Hex of canonical manifest+resources
      manifest_snapshot           TEXT NOT NULL,                    -- canonical JSON of ProcessModuleManifest
      store_location              TEXT NOT NULL,                    -- content-addressed path
      resource_index              TEXT NOT NULL,                    -- canonical JSON of ResourceIndexEntry[]
      handler_refs                TEXT NOT NULL,                    -- canonical JSON of HandlerRef[]
      dependency_lock             TEXT NOT NULL,                    -- canonical JSON of DependencyLock
      status                      TEXT NOT NULL DEFAULT 'staged'    -- staged|validated|active|retired|corrupt
                                    CHECK (status IN ('staged','validated','active','retired','corrupt')),
      installed_at                TEXT NOT NULL,
      activated_at                TEXT,
      retired_at                  TEXT
    );

    -- Version immutability (spec §4): at most ONE active installation per
    -- (name, version). A second active row under the same (name, version) with
    -- a DIFFERENT package_digest is rejected by the adapter with
    -- MODULE_INSTALLATION_VERSION_COLLISION. SQLite's partial UNIQUE index is
    -- the structural enforcement; the adapter translates the violation.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_module_installations_active
      ON saga3_module_installations(name, version) WHERE status = 'active';

    -- Lookup by package digest (replay verification, registry selection).
    CREATE INDEX IF NOT EXISTS idx_saga3_module_installations_digest
      ON saga3_module_installations(package_digest);
  `);
}

// ---------------------------------------------------------------------------
// Row <-> record mapping.
// ---------------------------------------------------------------------------

function rowToRecord(row: ModuleInstallationRow): ModuleInstallationRecord {
  return {
    id: asModuleInstallationId(row.id),
    name: row.name,
    version: row.version,
    packageDigest: row.package_digest,
    manifestSnapshot: JSON.parse(row.manifest_snapshot) as ModuleInstallationRecord['manifestSnapshot'],
    storeLocation: row.store_location,
    resourceIndex: JSON.parse(row.resource_index) as ModuleInstallationRecord['resourceIndex'],
    handlerRefs: JSON.parse(row.handler_refs) as ModuleInstallationRecord['handlerRefs'],
    dependencyLock: JSON.parse(row.dependency_lock) as ModuleInstallationRecord['dependencyLock'],
    status: row.status,
    installedAt: row.installed_at,
    activatedAt: row.activated_at ?? undefined,
    retiredAt: row.retired_at ?? undefined,
  };
}

function readRowById(db: Database.Database, id: ModuleInstallationId): ModuleInstallationRow | null {
  const row = db.prepare('SELECT * FROM saga3_module_installations WHERE id=?')
    .get(id) as ModuleInstallationRow | undefined;
  return row ?? null;
}

/**
 * Read the active installation row for `(name, version)`, or null. The partial
 * UNIQUE index guarantees at most one match.
 */
function readActiveRowByNameVersion(
  db: Database.Database,
  name: string,
  version: string,
): ModuleInstallationRow | null {
  const row = db.prepare(
    `SELECT * FROM saga3_module_installations WHERE name=? AND version=? AND status='active'`,
  ).get(name, version) as ModuleInstallationRow | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// PORT (interface).
// ---------------------------------------------------------------------------

/**
 * Persistence port for `saga3_module_installations`. Implementations:
 * `SqliteModuleInstallationRepository` (this file). Future swaps (Wave 13)
 * implement this interface without touching `domain/`.
 *
 * The port intentionally exposes NO delete method (deletion-restricted,
 * plan §5.5.9). Use `retire` to release the active slot.
 */
export interface ModuleInstallationRepository {
  /**
   * Insert a new installation record. `status` is taken from `record.status`
   * (typically `'staged'` or `'validated'`; an installer that has already
   * validated may insert directly as `'active'`). The returned record carries
   * the database-assigned `id` and the row's timestamps.
   *
   * Version immutability (spec §4): if an installation with `status='active'`
   * already exists for the same `(name, version)`:
   *   - with the SAME `packageDigest` → idempotent replay: return the existing
   *     active record (caller can detect via `result.id !== record.id`).
   *   - with a DIFFERENT `packageDigest` → throw
   *     `MODULE_INSTALLATION_VERSION_COLLISION`.
   * For non-active inserts (`'staged'`/`'validated'`) there is no uniqueness
   * conflict: multiple staged rows for the same `(name, version)` are allowed
   * (the UNIQUE index is partial on `status='active'`).
   */
  insert(record: Omit<ModuleInstallationRecord, 'id' | 'installedAt' | 'activatedAt' | 'retiredAt'>
    & Partial<Pick<ModuleInstallationRecord, 'installedAt' | 'activatedAt' | 'retiredAt'>>): ModuleInstallationRecord;

  /** Read by primary key. Returns null if not found. */
  getById(id: ModuleInstallationId): ModuleInstallationRecord | null;

  /** Read by `package_digest`. Returns null if not found. */
  getByPackageDigest(digest: string): ModuleInstallationRecord | null;

  /**
   * Read the active installation for `(name, version)`, or null. The partial
   * UNIQUE index guarantees at most one match.
   */
  getActiveByNameVersion(name: string, version: string): ModuleInstallationRecord | null;

  /**
   * Transition an installation to `status='active'`. Sets `activated_at` (first
   * activation only — `COALESCE` guard). Enforces version immutability: if
   * another active installation already holds `(name, version)` with a
   * DIFFERENT `package_digest`, throws `MODULE_INSTALLATION_VERSION_COLLISION`.
   * Throws `MODULE_INSTALLATION_NOT_FOUND` if `id` does not exist.
   */
  activate(id: ModuleInstallationId): ModuleInstallationRecord;

  /**
   * Transition an installation to `status='retired'`. Sets `retired_at`. This
   * releases the unique-active slot but PRESERVES the row (deletion-restricted,
   * plan §5.5.9) for replay verification. Throws
   * `MODULE_INSTALLATION_NOT_FOUND` if `id` does not exist.
   */
  retire(id: ModuleInstallationId): ModuleInstallationRecord;

  /**
   * Mark an installation `status='corrupt'` (replay verification failed, spec
   * §4 / §5.5.7). A corrupt installation MUST NOT be selected for new runs.
   * Throws `MODULE_INSTALLATION_NOT_FOUND` if `id` does not exist.
   */
  markCorrupt(id: ModuleInstallationId): ModuleInstallationRecord;

  /** All installations currently `status='active'`. Ordered by `(name, version)`. */
  listActive(): readonly ModuleInstallationRecord[];
}

// ---------------------------------------------------------------------------
// SQLite adapter.
// ---------------------------------------------------------------------------

/**
 * Concrete SQLite implementation of {@link ModuleInstallationRepository}.
 *
 * Construction is cheap and idempotent: the schema is created on first use via
 * {@link ensureSaga3ModuleInstallationSchema} (CREATE IF NOT EXISTS). Production
 * wires one instance at the composition root; tests construct one against a
 * temp DB.
 */
export class SqliteModuleInstallationRepository implements ModuleInstallationRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    ensureSaga3ModuleInstallationSchema(this.db);
  }

  insert(record: Omit<ModuleInstallationRecord, 'id' | 'installedAt' | 'activatedAt' | 'retiredAt'>
    & Partial<Pick<ModuleInstallationRecord, 'installedAt' | 'activatedAt' | 'retiredAt'>>): ModuleInstallationRecord {
    // If the caller is inserting as active, the partial UNIQUE index may fire.
    // Resolve the version-immutability invariant BEFORE the INSERT so we can
    // distinguish idempotent replay (same digest) from collision (different
    // digest). The invariant is also structurally enforced by the index; the
    // pre-check gives the right error message without relying on catch parsing.
    if (record.status === 'active') {
      const existing = readActiveRowByNameVersion(this.db, record.name, record.version);
      if (existing) {
        if (existing.package_digest === record.packageDigest) {
          // Idempotent replay: same (name, version, digest) already active.
          return rowToRecord(existing);
        }
        throw new Error(
          `${MODULE_INSTALLATION_VERSION_COLLISION}: an active installation for `
          + `${record.name}@${record.version} already exists with package_digest `
          + `'${existing.package_digest}' (received '${record.packageDigest}'). `
          + `Released package identity is immutable; use a prerelease version for `
          + `development (plan §5.5.8).`,
        );
      }
    }

    const manifestSnapshotJson = canonicalJson(record.manifestSnapshot);
    const resourceIndexJson = canonicalJson(record.resourceIndex);
    const handlerRefsJson = canonicalJson(record.handlerRefs);
    const dependencyLockJson = canonicalJson(record.dependencyLock);
    const installedAt = record.installedAt ?? new Date().toISOString();

    let lastInsertRowid: number | bigint;
    try {
      const info = this.db.prepare(
        `INSERT INTO saga3_module_installations
           (name, version, package_digest, manifest_snapshot, store_location,
            resource_index, handler_refs, dependency_lock, status,
            installed_at, activated_at, retired_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        record.name,
        record.version,
        record.packageDigest,
        manifestSnapshotJson,
        record.storeLocation,
        resourceIndexJson,
        handlerRefsJson,
        dependencyLockJson,
        record.status,
        installedAt,
        record.activatedAt ?? null,
        record.retiredAt ?? null,
      );
      lastInsertRowid = info.lastInsertRowid;
    } catch (err) {
      // The pre-check above resolves the common case; this catch handles the
      // race where a concurrent INSERT won the active slot between the check
      // and the INSERT. Translate any UNIQUE violation on the active index to
      // the version-collision error.
      const msg = (err as Error).message ?? '';
      if (msg.includes('UNIQUE') && msg.includes('idx_saga3_module_installations_active')) {
        const existing = readActiveRowByNameVersion(this.db, record.name, record.version);
        if (existing && existing.package_digest !== record.packageDigest) {
          throw new Error(
            `${MODULE_INSTALLATION_VERSION_COLLISION}: concurrent insert won the active `
            + `slot for ${record.name}@${record.version} with a different package_digest.`,
          );
        }
        throw err;
      }
      throw err;
    }

    const row = readRowById(this.db, asModuleInstallationId(Number(lastInsertRowid)));
    if (!row) throw new Error('saga3: module_installation vanished after insert');
    return rowToRecord(row);
  }

  getById(id: ModuleInstallationId): ModuleInstallationRecord | null {
    const row = readRowById(this.db, id);
    return row ? rowToRecord(row) : null;
  }

  getByPackageDigest(digest: string): ModuleInstallationRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM saga3_module_installations WHERE package_digest=?',
    ).get(digest) as ModuleInstallationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getActiveByNameVersion(name: string, version: string): ModuleInstallationRecord | null {
    const row = readActiveRowByNameVersion(this.db, name, version);
    return row ? rowToRecord(row) : null;
  }

  activate(id: ModuleInstallationId): ModuleInstallationRecord {
    const current = readRowById(this.db, id);
    if (!current) {
      throw new Error(`${MODULE_INSTALLATION_NOT_FOUND}: installation id=${id} not found`);
    }

    // If this row is already the active one, no-op (idempotent).
    if (current.status === 'active') {
      return rowToRecord(current);
    }

    // Version immutability: another row holding the active slot for the same
    // (name, version) blocks this activation. Same digest → still a collision
    // (two distinct rows must not both be active); different digest →
    // collision. Either way the invariant is "one active row per
    // (name, version)".
    const holder = readActiveRowByNameVersion(this.db, current.name, current.version);
    if (holder && holder.id !== current.id) {
      throw new Error(
        `${MODULE_INSTALLATION_VERSION_COLLISION}: cannot activate `
        + `${current.name}@${current.version} (id=${id}); installation id=${holder.id} `
        + `already holds the active slot`
        + (holder.package_digest !== current.package_digest
          ? ` with a different package_digest ('${holder.package_digest}' vs '${current.package_digest}')`
          : ''),
      );
    }

    try {
      const info = this.db.prepare(
        `UPDATE saga3_module_installations
            SET status='active',
                activated_at=COALESCE(activated_at, datetime('now'))
          WHERE id=?`,
      ).run(id);
      if (info.changes === 0) {
        // Concurrent delete — should not happen (no delete path), but guard.
        throw new Error(`${MODULE_INSTALLATION_NOT_FOUND}: installation id=${id} vanished during activate`);
      }
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('UNIQUE') && msg.includes('idx_saga3_module_installations_active')) {
        throw new Error(
          `${MODULE_INSTALLATION_VERSION_COLLISION}: concurrent activation won the `
          + `active slot for ${current.name}@${current.version}.`,
        );
      }
      throw err;
    }

    const after = readRowById(this.db, id);
    if (!after) throw new Error(`${MODULE_INSTALLATION_NOT_FOUND}: installation id=${id} vanished after activate`);
    return rowToRecord(after);
  }

  retire(id: ModuleInstallationId): ModuleInstallationRecord {
    const info = this.db.prepare(
      `UPDATE saga3_module_installations
          SET status='retired',
              retired_at=COALESCE(retired_at, datetime('now'))
        WHERE id=?`,
    ).run(id);
    if (info.changes === 0) {
      throw new Error(`${MODULE_INSTALLATION_NOT_FOUND}: installation id=${id} not found`);
    }
    const after = readRowById(this.db, id);
    if (!after) throw new Error(`${MODULE_INSTALLATION_NOT_FOUND}: installation id=${id} vanished after retire`);
    return rowToRecord(after);
  }

  markCorrupt(id: ModuleInstallationId): ModuleInstallationRecord {
    const info = this.db.prepare(
      `UPDATE saga3_module_installations
          SET status='corrupt'
        WHERE id=?`,
    ).run(id);
    if (info.changes === 0) {
      throw new Error(`${MODULE_INSTALLATION_NOT_FOUND}: installation id=${id} not found`);
    }
    const after = readRowById(this.db, id);
    if (!after) throw new Error(`${MODULE_INSTALLATION_CORRUPT}: installation id=${id} vanished after markCorrupt`);
    return rowToRecord(after);
  }

  listActive(): readonly ModuleInstallationRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM saga3_module_installations
        WHERE status='active'
        ORDER BY name ASC, version ASC`,
    ).all() as ModuleInstallationRow[];
    return rows.map(rowToRecord);
  }
}
