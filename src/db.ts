import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.DB_PATH;
  if (!dbPath) {
    throw new Error(
      'DB_PATH environment variable is required. Set it to the path of your .saga.db file, e.g., DB_PATH=/path/to/project/.saga.db'
    );
  }

  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  db.exec(SCHEMA_SQL);
  migrate(db);

  return db;
}

/** Additive column migrations. `CREATE TABLE IF NOT EXISTS` never touches an
 *  existing table, so a database created by an older build needs the new
 *  columns added explicitly. Only additive, only nullable — a migration must
 *  never rewrite the log or the material store. */
function migrate(database: Database.Database): void {
  const columns = (table: string): Set<string> =>
    new Set(
      (database.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name)
    );
  const executions = columns('executions');
  if (!executions.has('progress')) {
    database.exec('ALTER TABLE executions ADD COLUMN progress TEXT');
  }
  if (!executions.has('progress_at')) {
    database.exec('ALTER TABLE executions ADD COLUMN progress_at TEXT');
  }
  if (!executions.has('round')) {
    database.exec('ALTER TABLE executions ADD COLUMN round INTEGER NOT NULL DEFAULT 1');
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
