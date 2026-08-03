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
 * Pragmas: WAL (concurrent reader + writer), foreign_keys ON, busy_timeout
 * 5s (SQLite serializes all writes under a single writer), synchronous
 * NORMAL (safe under WAL).
 */
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

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
