// Isolation test: prove that worker_next with project_id=A never returns
// a task from project B (the shared-DB leak the bug was about).
//
// Setup: 2 projects (A has 1 task, B has 1 task). A worker asks for project A.
// Pass = gets A's task, B's task stays untouched (assigned_to NULL).
// Usage:  node tests/dispatcher-race/isolation.mjs
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { getDb, closeDb } from '../../dist/db.js';
import { handlers } from '../../dist/tools/dispatcher.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';

const thisDir = dirname(fileURLToPath(import.meta.url));
const dbPath = join(thisDir, 'iso.db');

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(dbPath + ext); } catch { /* not present */ }
}

// --- direct setup: 2 projects, 1 task each ---
const setup = new Database(dbPath);
setup.pragma('journal_mode = WAL');
setup.pragma('foreign_keys = ON');
setup.pragma('busy_timeout = 5000');
setup.exec(SCHEMA_SQL);
try { setup.exec('CREATE INDEX IF NOT EXISTS idx_epics_branch ON epics(branch)'); } catch {}

setup.prepare("INSERT INTO projects (name) VALUES ('proj-A')").run();
setup.prepare("INSERT INTO projects (name) VALUES ('proj-B')").run();
const aId = setup.prepare("SELECT id FROM projects WHERE name='proj-A'").get().id;
const bId = setup.prepare("SELECT id FROM projects WHERE name='proj-B'").get().id;
setup.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'epic-A')").run(aId);
setup.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'epic-B')").run(bId);
const epicA = setup.prepare("SELECT id FROM epics WHERE name='epic-A'").get().id;
const epicB = setup.prepare("SELECT id FROM epics WHERE name='epic-B'").get().id;
setup.prepare("INSERT INTO tasks (epic_id, title, status, priority, assigned_to) VALUES (?, 'task-in-A', 'todo', 'low', NULL)").run(epicA);
setup.prepare("INSERT INTO tasks (epic_id, title, status, priority, assigned_to) VALUES (?, 'task-in-B', 'todo', 'critical', NULL)").run(epicB);
setup.close();

// --- run via the real handler, asking for project A ---
process.env.DB_PATH = dbPath;
const db = getDb();

console.log(`\n=== ISOLATION TEST: worker asks for project A (id=${aId}); project B (id=${bId}) has a CRITICAL task ===`);
const res = handlers.worker_next({ worker_id: 'iso-agent', project_id: aId });

const claimedId = res.task ? res.task.id : null;
const claimedTitle = res.task ? res.task.title : null;
const bTaskAfter = db.prepare("SELECT assigned_to, status FROM tasks WHERE title='task-in-B'").get();

console.log('worker_next(project_id=A) returned:', { id: claimedId, title: claimedTitle, skill: res.skill });
console.log('task-in-B after:', bTaskAfter);

const pass =
  claimedTitle === 'task-in-A'                         // got A's task, not B's
  && bTaskAfter.assigned_to === null                   // B's task untouched
  && bTaskAfter.status === 'todo';                     // B's task still todo

console.log('\n=== VERDICT ===');
console.log(`worker got task-in-A (not B's critical):   ${claimedTitle === 'task-in-A' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`project B task untouched (assigned=NULL):  ${bTaskAfter.assigned_to === null ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`project B task still todo:                 ${bTaskAfter.status === 'todo' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(pass ? '\n✅✅✅ ISOLATION HOLDS — project_id scoping prevents cross-project leak.\n'
                 : '\n❌❌❌ ISOLATION BROKEN — worker saw another project.\n');

// Also verify the error path: bad project_id → explicit error
try {
  handlers.worker_next({ worker_id: 'iso-agent', project_id: 99999 });
  console.log('❌ FAIL: bogus project_id did not error');
} catch (e) {
  console.log(`error path (bogus project_id=99999): throws "${e.message}" ✅`);
}
// And missing project_id → explicit error
try {
  handlers.worker_next({ worker_id: 'iso-agent' });
  console.log('❌ FAIL: missing project_id did not error');
} catch (e) {
  console.log(`error path (missing project_id): throws "${e.message}" ✅`);
}

closeDb();
process.exit(pass ? 0 : 1);
