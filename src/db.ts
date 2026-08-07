import Database from 'better-sqlite3';
import { SCHEMA_SQL, ensureArtifactStorageKindColumn, migrateSyntheticBriefsToDbNative, rebuildFactoryOrdersWithoutColumnUniques } from './schema.js';
import { ensureFactoryModuleInstallationSchema } from './process-modules/installation/persistence/installation-repository.js';
import { ensureFactoryScenarioInstallationSchema } from './process-modules/installation/persistence/sqlite-scenario-installation-repository.js';
import { ensureFactoryProtocolRunSchema } from './process-modules/persistence/sqlite-protocol-run-repository.js';
import { ensureFactoryCallInstanceSchema } from './process-modules/persistence/sqlite-call-instance-repository.js';
import { initSubmissionRegistries } from './process-modules/application/submission-registries.js';

let db: Database.Database | null = null;

/**
 * Open (or return the cached) saga SQLite database.
 *
 * The schema is defined entirely in {@link SCHEMA_SQL} (schema.ts) and the
 * lazy `ensureFactory*Schema` calls below. This function is clean-foundation:
 * all migration sediment (ALTER TABLE try/catch blocks, table-rebuild
 * databases to migrate — the product has not shipped to clients.
 *
 * **DB compatibility policy:** disposable pre-release. `user_version` is
 * stamped on every fresh DB. If a DB with a mismatched version is opened,
 * the call warns but does NOT delete or block — saga is a governance
 * platform, the database IS the product (artifacts, traces, tasks,
 * evidence). When the schema changes, versioned migrations must handle the
 * upgrade.
 *
 * **SCHEMA_VERSION history:**
 *   1 = saga4 clean foundation.
 *   2 = Conveyor v4 additive layer (CONVEYOR-V4-MIGRATION-PLAN step 6):
 *       the 7 `factory_*` authoritative Workplace/CandidateSet/Gate tables plus
 *       4 immutability triggers are now a required part of the schema, and
 *       tables are retained as projections through the cutover window.
 *   3 = Replay-first cardinality (CONVEYOR v4.3 §7): drop lifetime UNIQUE on
 *       factory_orders.project_id/epic_id so one Project may own many
 *       historical Factory Runs. source_digest becomes provenance (non-unique).
 *       Applied via table rebuild for existing DBs.
 *
 * Pragmas: WAL (concurrent reader + writer), foreign_keys ON, busy_timeout
 * 5s (SQLite serializes all writes under a single writer), synchronous
 * NORMAL (safe under WAL).
 */

/** Increment when the schema changes incompatibly. 3 = Replay-first cardinality. */
const SCHEMA_VERSION = 3;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    throw new Error(
      'DB_PATH environment variable is required. Set it to the path of your .tracker.db file, e.g., DB_PATH=/path/to/project/.tracker.db'
    );
  }

  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  // DB version stamp. user_version is set on fresh DBs and checked on reopen.
  // If the version differs, the system warns but does NOT delete or block —
  // saga is a governance platform, the database IS the product (artifacts,
  // traces, tasks, evidence). Deleting it is never the right answer.
  // When the schema changes, versioned migrations must handle the upgrade.
  const existingVersion = db.pragma('user_version', { simple: true }) as number;
  if (existingVersion !== 0 && existingVersion !== SCHEMA_VERSION) {
    console.warn(
      `[saga] DB at ${dbPath} has user_version=${existingVersion}, ` +
        `current schema is ${SCHEMA_VERSION}. ` +
        'The database will be opened as-is. If errors occur, a versioned ' +
        'migration is needed — do NOT delete the database.',
    );
  }

  // Core schema — all tables, columns, indexes, CHECK constraints.
  db.exec(SCHEMA_SQL);
  // Replay-first cardinality (v3): rebuild factory_orders without the legacy
  // lifetime-UNIQUE on project_id/epic_id so one Project may own many
  // historical Factory Runs. No-op on fresh DBs (SCHEMA_SQL already correct).
  rebuildFactoryOrdersWithoutColumnUniques(db);
  // Additive migration: artifacts.storage_kind (file_backed | db_native |
  // external_ref). Fresh DBs get the column from CREATE TABLE; pre-existing
  // DBs created before this column get it added here with the safe default
  // 'file_backed'. The synthetic brief is repaired to db_native separately.
  ensureArtifactStorageKindColumn(db);
  // One-shot repair: promote synthetic auto-provisioned briefs (no physical
  // file, hash from canonical JSON) to db_native with content persisted in
  // metadata. Verified against the stored content_hash — never guesses.
  const briefMigration = migrateSyntheticBriefsToDbNative(db);
  if (briefMigration.migrated > 0) {
    console.warn(
      `[factory] migrated ${briefMigration.migrated} synthetic brief(s) to db_native `
        + `(inspected ${briefMigration.inspected}, skipped ${briefMigration.skipped})`,
    );
  }

  // Mandatory node submission validation: register policy declarations +
  // validators for every LM-node. worker_done reads these to enforce the
  // domain contract at the submission boundary (shift-left), not post-hoc.
  initSubmissionRegistries(db);

  // Lazy schema for factory_* process-module tables. These are created here
  // (eagerly at DB-open time) AND in their respective repository constructors
  // (lazily). Both paths are idempotent (CREATE TABLE IF NOT EXISTS).
  ensureFactoryModuleInstallationSchema(db);
  ensureFactoryScenarioInstallationSchema(db);
  // ProtocolRun + CallInstance tables reference factory_process_runs, which is
  // created lazily by SqliteProcessRunRepository. On a fresh DB the table may
  // not exist yet — ensureFactory* guard internally on table existence.
  ensureFactoryProtocolRunSchema(db);
  ensureFactoryCallInstanceSchema(db);

  // Stamp the schema version on fresh DBs (existingVersion === 0).
  if (existingVersion === 0) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
