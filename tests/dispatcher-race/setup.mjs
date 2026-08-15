// Race-test setup: create a fresh test DB with N free tasks in 'todo',
// and write the project id+name to a sidecar so claim.mjs can pass project_id.
// Usage:  node tests/dispatcher-race/setup.mjs <dbPath> <numTasks>
// Deletes any existing DB at dbPath first for a clean slate.
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { ensureRunningProcessRun } from './process-run-fixture.mjs';

const thisDir = dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] ?? join(thisDir, 'race.db');
const numTasks = Number(process.argv[3] ?? 1);

// Clean slate — remove old DB + WAL/SHM sidecars + project sidecar
for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(dbPath + ext); } catch { /* not present */ }
}
try { rmSync(join(thisDir, 'project.txt')); } catch { /* not present */ }

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
ensureRunningProcessRun(db, 999, projId, epicId);

const insert = db.prepare(
  "INSERT INTO tasks (epic_id, title, status, priority, assigned_to, metadata) VALUES (?, ?, 'todo', ?, NULL, ?)"
);
const priorities = ['critical', 'high', 'medium', 'low'];
// saga4 cutover: a task is claimable ONLY if bound to a Process Module node via
// metadata.process_run_id. Stamp a synthetic run id so the race fixture stays
// claimable under the new single-authority dispatcher.
const metadata = JSON.stringify({ process_run_id: 999 });
for (let i = 1; i <= numTasks; i++) {
  insert.run(epicId, `task-${i}`, priorities[i % priorities.length], metadata);
}

// Sidecar with project_id + name so claim.mjs can pass project_id to worker_next.
writeFileSync(join(thisDir, 'project.txt'), JSON.stringify({ project_id: projId, name: 'race-test' }));

db.close();
console.log(`SETUP OK: ${dbPath} with ${numTasks} free task(s) in project_id=${projId}`);
