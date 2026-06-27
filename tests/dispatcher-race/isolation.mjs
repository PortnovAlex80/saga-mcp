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
// Add a medium task in A so the worker has something to claim (A's main task above is now low — must be skipped)
setup.prepare("INSERT INTO tasks (epic_id, title, status, priority, assigned_to) VALUES (?, 'task-in-A-medium', 'todo', 'medium', NULL)").run(epicA);
setup.close();

// --- run via the real handler, asking for project A ---
process.env.DB_PATH = dbPath;
const db = getDb();

console.log(`\n=== ISOLATION TEST: worker asks for project A (id=${aId}); project B (id=${bId}) has a CRITICAL task; A also has a LOW task ===`);
const res = handlers.worker_next({ worker_id: 'iso-agent', project_id: aId });

const claimedId = res.task ? res.task.id : null;
const claimedTitle = res.task ? res.task.title : null;
const bTaskAfter = db.prepare("SELECT assigned_to, status FROM tasks WHERE title='task-in-B'").get();
const aLowAfter = db.prepare("SELECT assigned_to, status, priority FROM tasks WHERE title='task-in-A'").get();

console.log('worker_next(project_id=A) returned:', { id: claimedId, title: claimedTitle, skill: res.skill });
console.log('task-in-B after:', bTaskAfter);
console.log('task-in-A (low) after:', aLowAfter);

const pass =
  claimedTitle === 'task-in-A-medium'                  // got A's medium task
  && bTaskAfter.assigned_to === null                   // B's critical task untouched (cross-project)
  && aLowAfter.assigned_to === null                    // A's low task untouched (priority filter)
  && aLowAfter.status === 'todo';                      // A's low task still todo

console.log('\n=== VERDICT ===');
console.log(`worker got A's medium task (not B, not A's low): ${claimedTitle === 'task-in-A-medium' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`cross-project: B task untouched:           ${bTaskAfter.assigned_to === null ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`priority filter: A's LOW task untouched:   ${aLowAfter.assigned_to === null ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`priority filter: A's LOW task still todo:  ${aLowAfter.status === 'todo' ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(pass ? '\n✅✅✅ ISOLATION HOLDS — project_id scoping prevents cross-project leak, low-priority filter holds.\n'
                 : '\n❌❌❌ FAILED.\n');

// === Priority-filter sub-test: ALL tasks low in a fresh DB → queue empty ===
const dbPath2 = join(thisDir, 'iso-low.db');
for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbPath2 + ext); } catch {} }
const setup2 = new Database(dbPath2);
setup2.pragma('journal_mode = WAL');
setup2.pragma('foreign_keys = ON');
setup2.pragma('busy_timeout = 5000');
setup2.exec(SCHEMA_SQL);
setup2.prepare("INSERT INTO projects (name) VALUES ('all-low')").run();
const p2 = setup2.prepare("SELECT id FROM projects WHERE name='all-low'").get().id;
setup2.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'e')").run(p2);
const e2 = setup2.prepare("SELECT id FROM epics WHERE name='e'").get().id;
setup2.prepare("INSERT INTO tasks (epic_id, title, status, priority, assigned_to) VALUES (?, 'only-low', 'todo', 'low', NULL)").run(e2);
setup2.close();

process.env.DB_PATH = dbPath2;
const db2 = getDb();
const resLow = handlers.worker_next({ worker_id: 'iso-agent', project_id: p2 });
console.log('=== LOW-ONLY SUB-TEST ===');
console.log('worker_next on a project with only a low task →', JSON.stringify({ task: resLow.task, skill: resLow.skill, reason: resLow.reason }));
const passLow = resLow.task === null && resLow.reason === 'очередь пуста';
console.log(`only-low project → queue empty: ${passLow ? 'PASS ✅' : 'FAIL ❌'}`);
closeDb();

// === Error paths (back on the main DB) ===
process.env.DB_PATH = dbPath;
getDb(); // re-open on the main DB (was closed above)
try {
  handlers.worker_next({ worker_id: 'x', project_id: 99999 });
  console.log('❌ FAIL: bogus project_id did not error');
} catch (e) {
  console.log(`error path (bogus project_id=99999): throws "${e.message}" ✅`);
}
try {
  handlers.worker_next({ worker_id: 'x' });
  console.log('❌ FAIL: missing project_id did not error');
} catch (e) {
  console.log(`error path (missing project_id): throws "${e.message}" ✅`);
}
closeDb();

const allPass = pass && passLow;
process.exit(allPass ? 0 : 1);
