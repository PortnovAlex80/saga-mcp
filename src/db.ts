import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import { ensureSaga3ModuleInstallationSchema } from './process-modules/installation/persistence/installation-repository.js';
import { ensureSaga3ScenarioInstallationSchema } from './process-modules/installation/persistence/sqlite-scenario-installation-repository.js';
import { ensureSaga3ProtocolRunSchema } from './process-modules/persistence/sqlite-protocol-run-repository.js';
import { ensureSaga3CallInstanceSchema } from './process-modules/persistence/sqlite-call-instance-repository.js';

let db: Database.Database | null = null;

/**
 * Open (or return the cached) saga SQLite database.
 *
 * The schema is defined entirely in {@link SCHEMA_SQL} (schema.ts) and the
 * lazy `ensureSaga3*Schema` calls below. This function is clean-foundation:
 * all migration sediment (ALTER TABLE try/catch blocks, table-rebuild
 * functions, backfill migrations) was removed because there are no legacy
 * databases to migrate — the product has not shipped to clients.
 *
 * **DB compatibility policy:** disposable pre-release. `user_version` is
 * stamped on every fresh DB. If a DB with a mismatched version is opened,
 * the call fails fast with a clear "delete and recreate" message rather than
 * silently running against an incompatible schema.
 *
 * Pragmas: WAL (concurrent reader + writer), foreign_keys ON, busy_timeout
 * 5s (SQLite serializes all writes under a single writer), synchronous
 * NORMAL (safe under WAL).
 */

/** Increment when the schema changes incompatibly. 1 = saga4 clean foundation. */
const SCHEMA_VERSION = 1;

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

  // DB compatibility check — disposable pre-release policy.
  // PRE-RELEASE: there are no clients and no data to preserve. When the schema
  // changes, SCHEMA_VERSION is bumped and old DBs are rejected. When the
  // product ships to real users, replace this with versioned migrations.
  const existingVersion = db.pragma('user_version', { simple: true }) as number;
  if (existingVersion !== 0 && existingVersion !== SCHEMA_VERSION) {
    db.close();
    db = null;
    throw new Error(
      `DB at ${dbPath} has user_version=${existingVersion}, expected ${SCHEMA_VERSION}. ` +
        'PRE-RELEASE: this DB is from an older schema version. Delete and recreate: ' +
        `rm ${dbPath}${dbPath.replace(/\.db$/, '{,.db-wal,.db-shm}')}` +
        '\n(NOT for production — when saga ships to real users, this will become a versioned migration.)',
    );
  }

  // Core schema — all tables, columns, indexes, CHECK constraints.
  db.exec(SCHEMA_SQL);

  // Lazy schema for saga3_* process-module tables. These are created here
  // (eagerly at DB-open time) AND in their respective repository constructors
  // (lazily). Both paths are idempotent (CREATE TABLE IF NOT EXISTS).
  ensureSaga3ModuleInstallationSchema(db);
  ensureSaga3ScenarioInstallationSchema(db);
  // ProtocolRun + CallInstance tables reference saga3_process_runs, which is
  // created lazily by SqliteProcessRunRepository. On a fresh DB the table may
  // not exist yet — ensureSaga3* guard internally on table existence.
  ensureSaga3ProtocolRunSchema(db);
  ensureSaga3CallInstanceSchema(db);

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
