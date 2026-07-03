import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

let db: Database.Database | null = null;

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

  db.exec(SCHEMA_SQL);

  // Migrations for existing databases
  try { db.exec('ALTER TABLE tasks ADD COLUMN source_ref TEXT'); } catch { /* column already exists */ }
  try { db.exec('ALTER TABLE epics ADD COLUMN branch TEXT'); } catch { /* column already exists */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_epics_branch ON epics(branch)'); } catch { /* index already exists */ }

  // Migration: add 'review_in_progress' status. SQLite CHECK constraints cannot
  // be altered in-place, so we detect the old schema (status lacks the new value)
  // and rebuild the tasks table with the updated CHECK. Concurrent-safe under the
  // single-writer assumption at startup. Existing rows with status='review' AND
  // assigned_to NOT NULL (reviewer was working) become 'review_in_progress'.
  migrateReviewInProgress(db);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Detect whether the tasks table already accepts the 'review_in_progress' status.
 * If the CHECK constraint is the old one (lacks this value), rebuild the table
 * with the updated CHECK and migrate rows in 'review' that have an assigned_to
 * (reviewer was actively working) to 'review_in_progress'.
 *
 * Detection: try to validate by inspecting sqlite_schema — the new CHECK string
 * contains 'review_in_progress'. Cheaper than a trial INSERT that could leave
 * side effects. Falls back gracefully if anything is unexpected.
 */
function migrateReviewInProgress(db: Database.Database): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_schema WHERE type='table' AND name='tasks'",
  ).get() as { sql: string } | undefined;
  if (!row?.sql) return; // table doesn't exist yet (fresh DB) — SCHEMA_SQL will create it correctly

  // Already migrated?
  if (row.sql.includes('review_in_progress')) return;

  // Old schema detected. Rebuild tasks with updated CHECK.
  // NOTE: SQLite table rebuild — preserve all columns, indexes are recreated by SCHEMA_SQL IF NOT EXISTS.
  db.exec('BEGIN IMMEDIATE');
  try {
    // Snapshot original DDL columns by reading pragma table_info — we rebuild
    // with explicit columns matching the current schema.ts definition.
    db.exec(`
      CREATE TABLE tasks_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo'
              CHECK (status IN ('todo', 'in_progress', 'review', 'review_in_progress', 'done', 'blocked')),
        priority TEXT NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('low', 'medium', 'high', 'critical')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        assigned_to TEXT,
        estimated_hours REAL,
        actual_hours REAL,
        due_date TEXT,
        source_ref TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Copy rows; flip review+assigned_to -> review_in_progress.
    db.exec(`
      INSERT INTO tasks_new (id, epic_id, title, description, status, priority, sort_order,
                             assigned_to, estimated_hours, actual_hours, due_date, source_ref,
                             tags, metadata, created_at, updated_at)
      SELECT id, epic_id, title, description,
             CASE WHEN status='review' AND assigned_to IS NOT NULL AND assigned_to != ''
                  THEN 'review_in_progress' ELSE status END,
             priority, sort_order, assigned_to, estimated_hours, actual_hours, due_date, source_ref,
             tags, metadata, created_at, updated_at
      FROM tasks
    `);
    db.exec('DROP TABLE tasks');
    db.exec('ALTER TABLE tasks_new RENAME TO tasks');
    // Recreate indexes (CREATE IF NOT EXISTS in SCHEMA_SQL handles this on next getDb,
    // but we run them now to be safe within this migration).
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_epic_id ON tasks(epic_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(epic_id, sort_order)');
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* tx not active */ }
    // Re-throw: failing to migrate is a hard stop — better than silent corruption.
    throw new Error(`Migration 'review_in_progress' failed: ${(err as Error).message}`);
  }
}
