// Race test: N worker processes ALL call worker_done on the SAME review task.
// Proves exactly ONE verdict passes (review→done), the rest get a clean error.
// No double-done, no corruption.
//
// Usage:  node tests/dispatcher-race/review-verdict-race.mjs <numWorkers>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import Database from 'file:///D:/Development/saga-mcp/node_modules/better-sqlite3/lib/index.js';

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(thisDir));
const dbPath = join(thisDir, 'verdict-race.db');

// --- setup: fresh DB, 1 project, 1 task, dev-cycle done → task in review ---
for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbPath + ext); } catch {} }
const setup = new Database(dbPath);
setup.pragma('journal_mode = WAL');
setup.pragma('foreign_keys = ON');
setup.pragma('busy_timeout = 5000');
// minimal schema (just what we need)
setup.exec(`
  CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', tags TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE epics (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned', priority TEXT NOT NULL DEFAULT 'medium', sort_order INTEGER NOT NULL DEFAULT 0, branch TEXT, tags TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, epic_id INTEGER NOT NULL REFERENCES epics(id), title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'medium', sort_order INTEGER NOT NULL DEFAULT 0, assigned_to TEXT, estimated_hours REAL, actual_hours REAL, due_date TEXT, source_ref TEXT, tags TEXT NOT NULL DEFAULT '[]', metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id), author TEXT, content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE task_dependencies (task_id INTEGER NOT NULL REFERENCES tasks(id), depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (task_id, depends_on_task_id));
  CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, action TEXT NOT NULL, field_name TEXT, old_value TEXT, new_value TEXT, summary TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE INDEX idx_tasks_status ON tasks(status);
  CREATE INDEX idx_tasks_epic_id ON tasks(epic_id);
  CREATE INDEX idx_epics_project_id ON epics(project_id);
`);
setup.prepare("INSERT INTO projects (name) VALUES ('verdict-race')").run();
const pid = setup.prepare("SELECT id FROM projects WHERE name='verdict-race'").get().id;
setup.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'e')").run(pid);
const eid = setup.prepare("SELECT id FROM epics WHERE name='e'").get().id;
setup.prepare("INSERT INTO tasks (epic_id, title, status, assigned_to) VALUES (?, 'T', 'review', NULL)").run(eid);
setup.close();

const taskId = 1;
const numWorkers = Number(process.argv[2] ?? 8);
const owner = 'verdict-owner';
const executionId = 'verdict-race-execution';
process.env.DB_PATH = dbPath;
const { handlers } = await import('../../dist/tools/dispatcher.js');
const { closeDb } = await import('../../dist/db.js');
handlers.worker_next({
  worker_id: owner,
  project_id: pid,
  machine_id: os.hostname(),
  execution_id: executionId,
  run_id: 'verdict-race',
});
closeDb();
console.log(`\n=== RACE: ${numWorkers} calls from ONE fenced holder on review task #${taskId} ===\n`);

const results = await Promise.all(
  Array.from({ length: numWorkers }, (_, i) =>
    runWorker(owner, taskId, executionId)
  )
);

console.log('=== RESULTS ===');
const winners = results.filter(r => r.parsed?.verdict === 'done');
const losers = results.filter(r => r.parsed?.error);
for (const r of results) console.log(r.line);

console.log('\n=== ASSERTIONS ===');
// Verify final DB state: task must be 'done', exactly once.
const check = new Database(dbPath, { readonly: true });
const finalTask = check.prepare('SELECT status, assigned_to FROM tasks WHERE id=?').get(taskId);
const commentCount = check.prepare('SELECT COUNT(*) n FROM comments WHERE task_id=?').get(taskId).n;
check.close();

const okOneWinner = winners.length === 1;
const okFinalDone = finalTask.status === 'done';
const okFinalUnassigned = finalTask.assigned_to === null;
// Comments: 1 per winner (the verdict comment). Losers threw before inserting.
const okComments = commentCount === 1 && commentCount === winners.length;

console.log(`winners (review→done): ${winners.length} (expect 1)         ${okOneWinner ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`losers (got clean error): ${losers.length} (expect ${numWorkers - 1})  ${losers.length === numWorkers - 1 ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`final task status: ${finalTask.status} (expect done)        ${okFinalDone ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`final assigned_to: ${finalTask.assigned_to} (expect null)   ${okFinalUnassigned ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`comments inserted: ${commentCount} (expect 1, the winner's) ${okComments ? 'PASS ✅' : 'FAIL ❌'}`);

const allPass = okOneWinner && okFinalDone && okFinalUnassigned && okComments && losers.length === numWorkers - 1;
console.log(allPass ? '\n✅✅✅ NO DOUBLE-DONE — exactly one verdict wins, rest get clean errors.\n'
                   : '\n❌❌❌ RACE BUG.\n');
process.exit(allPass ? 0 : 1);

function runWorker(workerId, taskId, executionId) {
  return new Promise((resolve) => {
    const env = { ...process.env, DB_PATH: dbPath };
    const child = spawn(
      'node',
      [join(thisDir, 'verdict.mjs'), workerId, String(taskId), executionId],
      { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', () => {
      let parsed = {};
      try { parsed = JSON.parse(stdout.trim().split('\n').pop()); } catch { parsed = { raw: stdout, err: stderr }; }
      resolve({ workerId, line: stdout.trim().split('\n').pop(), parsed, stderr });
    });
  });
}
