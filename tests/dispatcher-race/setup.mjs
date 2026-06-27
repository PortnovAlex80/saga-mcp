// Race-test setup: create a fresh test DB with N free tasks in 'todo'.
// Usage:  node tests/dispatcher-race/setup.mjs <dbPath> <numTasks>
// Deletes any existing DB at dbPath first for a clean slate.
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';

const thisDir = dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] ?? join(thisDir, 'race.db');
const numTasks = Number(process.argv[3] ?? 1);

// Clean slate — remove old DB + WAL/SHM sidecars
for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(dbPath + ext); } catch { /* not present */ }
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.exec(SCHEMA_SQL);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_epics_branch ON epics(branch)'); } catch {}

// One project + one epic, then N free tasks of varied priority to make
// contention realistic (multiple candidates, but each claimable once).
db.prepare("INSERT INTO projects (name, description) VALUES ('race-test', 'dispatcher race test')").run();
const projId = db.prepare("SELECT id FROM projects WHERE name='race-test'").get().id;
db.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'race-epic')").run(projId);
const epicId = db.prepare("SELECT id FROM epics WHERE name='race-epic'").get().id;

const insert = db.prepare(
  "INSERT INTO tasks (epic_id, title, status, priority, assigned_to) VALUES (?, ?, 'todo', ?, NULL)"
);
const priorities = ['critical', 'high', 'medium', 'low'];
for (let i = 1; i <= numTasks; i++) {
  insert.run(epicId, `task-${i}`, priorities[i % priorities.length]);
}

db.close();
console.log(`SETUP OK: ${dbPath} with ${numTasks} free task(s)`);
