// Functional test for the worktree-isolation additions:
//   1. worker_done({ verdict: 'changes_requested' }) → review→todo,
//      assignment is released for a fresh developer; branch/worktree survives.
//   2. active_tasks[] appears in worker_next & worker_done responses
//      (parallel-work visibility) and lists siblings with their branch.
//   3. worker_merge_acquire: first caller granted, second denied (held_by).
//      worker_merge_release on 'conflict' flags needs-human + merged_into=conflict.
//      worker_health surfaces the stuck task.
//
// Single-process (no race): proves the logic, not concurrency. Concurrency is
// covered by run.mjs / review-verdict-race.mjs.
//
// Usage:  node tests/dispatcher-race/worktree-isolation.mjs
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rmSync } from 'node:fs';
import { handlers } from '../../dist/tools/dispatcher.js';
import { getDb, closeDb } from '../../dist/db.js';
import { SCHEMA_SQL } from '../../dist/schema.js';

const thisDir = dirname(fileURLToPath(import.meta.url));
const dbPath = join(thisDir, 'worktree-iso.db');

// Fresh DB.
for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbPath + ext); } catch {} }

// Minimal schema (full SCHEMA_SQL via the built module, same as real server).
const setup = new Database(dbPath);
setup.pragma('journal_mode = WAL');
setup.pragma('foreign_keys = ON');
setup.pragma('busy_timeout = 5000');
setup.exec(SCHEMA_SQL);

setup.prepare("INSERT INTO projects (name) VALUES ('wt-test')").run();
const projId = setup.prepare("SELECT id FROM projects WHERE name='wt-test'").get().id;
setup.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'wt-epic')").run(projId);
const epicId = setup.prepare("SELECT id FROM epics WHERE name='wt-epic'").get().id;
// Two medium-priority todo tasks so both are claimable.
setup.prepare("INSERT INTO tasks (epic_id, title, status, priority, assigned_to) VALUES (?, 'task-A', 'todo', 'medium', NULL)").run(epicId);
setup.prepare("INSERT INTO tasks (epic_id, title, status, priority, assigned_to) VALUES (?, 'task-B', 'todo', 'medium', NULL)").run(epicId);
setup.close();

// Point the dispatcher's getDb at our test DB.
process.env.DB_PATH = dbPath;
getDb(); // initialise the module-level db handle

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? 'PASS ✅' : 'FAIL ❌'}  ${name}${cond ? '' : `  — ${detail}`}`);
  cond ? passed++ : failed++;
}

console.log('\n=== TEST 1: active_tasks visibility in worker_next ===');
const next1 = handlers.worker_next({ worker_id: 'agent-A', project_id: projId });
check('agent-A claimed task-A', next1.task?.title === 'task-A', `got ${next1.task?.title}`);
// No siblings in_progress yet (A is the only one active) — but the field exists.
check('active_tasks field present in worker_next', Array.isArray(next1.active_tasks), 'missing');

console.log('\n=== TEST 2: a second worker shows up in active_tasks ===');
const next2 = handlers.worker_next({ worker_id: 'agent-B', project_id: projId });
check('agent-B claimed task-B', next2.task?.title === 'task-B', `got ${next2.task?.title}`);
check('agent-B sees agent-A in active_tasks',
  (next2.active_tasks ?? []).some(a => a.assigned_to === 'agent-A' && a.status === 'in_progress'),
  JSON.stringify(next2.active_tasks));
check('active_tasks entries carry branch="task/<id>"',
  (next2.active_tasks ?? []).every(a => /^task\/\d+$/.test(a.branch)),
  JSON.stringify(next2.active_tasks));

console.log('\n=== TEST 3: CHANGES REQUESTED → review→todo, release reviewer ===');
// agent-A finishes dev: in_progress → review.
const devDone = handlers.worker_done({ task_id: next1.task.id, worker_id: 'agent-A', result: 'impl done' });
check('dev-done moved task-A to review', devDone.completed_new_status === 'review', `got ${devDone.completed_new_status}`);
// Now a reviewer picks it up (worker_next returns review tasks with skill saga-reviewer).
const reviewPick = handlers.worker_next({ worker_id: 'agent-R', project_id: projId });
check('reviewer got a review task', reviewPick.task?.status === 'review', `status=${reviewPick.task?.status}`);
const reviewTaskId = reviewPick.task?.id;
// CHANGES REQUESTED verdict.
const cr = handlers.worker_done({ task_id: reviewTaskId, worker_id: 'agent-R', result: 'needs fixes', verdict: 'changes_requested' });
check('changes_requested moved task back to todo', cr.completed_new_status === 'todo', `got ${cr.completed_new_status}`);
// assigned_to must return to the reviewer (they are now the dev).
const afterCr = handlers.task_get?.({ id: reviewTaskId }) ?? null;
// task_get lives in tasks.ts, not exported here — read directly from DB to verify.
const row = getDb().prepare('SELECT assigned_to, status FROM tasks WHERE id=?').get(reviewTaskId);
check('task is unassigned after review', row.assigned_to === null, `assigned_to=${row.assigned_to}`);
check('task status is todo', row.status === 'todo', `status=${row.status}`);
getDb().prepare("UPDATE tasks SET priority='low' WHERE id=?").run(reviewTaskId);

console.log('\n=== TEST 4: APPROVED → done; merge-lock serializes ===');
// Finish task-B fully to APPROVED so we can exercise the merge-lock.
const devDoneB = handlers.worker_done({ task_id: next2.task.id, worker_id: 'agent-B', result: 'impl B' });
check('task-B dev-done → review', devDoneB.completed_new_status === 'review', `got ${devDoneB.completed_new_status}`);
const reviewPickB = handlers.worker_next({ worker_id: 'agent-B', project_id: projId });
const approvedB = handlers.worker_done({ task_id: reviewPickB.task.id, worker_id: 'agent-B', result: 'APPROVED' });
check('task-B APPROVED → done', approvedB.completed_new_status === 'done', `got ${approvedB.completed_new_status}`);
// worker_done response carries active_tasks too.
check('worker_done response includes active_tasks', Array.isArray(approvedB.active_tasks), 'missing');

// These fixtures are legacy untyped tasks, so no typed integration gate is
// required even though the explicit merge-lock API remains available.
const integrationB = getDb().prepare(
  'SELECT integration_state FROM tasks WHERE id=?',
).get(reviewPickB.task.id).integration_state;
check('legacy task integration_state stays "not_required"', integrationB === 'not_required', integrationB);

// First acquirer wins.
const acq1 = handlers.worker_merge_acquire({ task_id: reviewPickB.task.id, worker_id: 'agent-B' });
check('first merge_acquire granted', acq1.granted === true, JSON.stringify(acq1));
// Second concurrent caller (different worker, same project) is denied — the lock
// is per-PROJECT, not per-task, so even the same done task can't be merged by two
// workers at once. We ask for the SAME done task from a different worker to prove
// the lock is global to the project.
const acq2 = handlers.worker_merge_acquire({ task_id: reviewPickB.task.id, worker_id: 'agent-A' });
check('second merge_acquire denied (lock held)', acq2.granted === false, JSON.stringify(acq2));
check('denied response names the holder', acq2.held_by?.worker_id === 'agent-B', JSON.stringify(acq2.held_by));

console.log('\n=== TEST 5: merge conflict → needs-human + merged_into=conflict; health surfaces it ===');
const rel = handlers.worker_merge_release({ task_id: reviewPickB.task.id, worker_id: 'agent-B', result: 'conflict' });
check('merge_release accepted conflict verdict', rel.result === 'conflict', JSON.stringify(rel));
const rowB = getDb().prepare('SELECT tags, metadata FROM tasks WHERE id=?').get(reviewPickB.task.id);
const tagsB = JSON.parse(rowB.tags);
const metaB2 = JSON.parse(rowB.metadata);
check('conflict flagged needs-human tag', tagsB.includes('needs-human'), JSON.stringify(tagsB));
check('merged_into === "conflict"', metaB2.worktree?.merged_into === 'conflict', JSON.stringify(metaB2.worktree));

const health = handlers.worker_health({ project_id: projId });
check('worker_health lists the stuck merge', health.stuck_merges.some(s => s.task_id === reviewPickB.task.id), JSON.stringify(health.stuck_merges));
check('worker_health lists pending/never-merged where applicable', Array.isArray(health.never_merged), 'missing');

console.log('\n=== TEST 6: clean merge path → merged_into=dev ===');
// Re-acquire (lock was released) and report a successful merge.
const acq3 = handlers.worker_merge_acquire({ task_id: reviewPickB.task.id, worker_id: 'agent-B' });
check('re-acquire granted after release', acq3.granted === true, JSON.stringify(acq3));
const rel2 = handlers.worker_merge_release({ task_id: reviewPickB.task.id, worker_id: 'agent-B', result: 'merged', commit_sha: 'abc1234' });
check('clean merge recorded', rel2.result === 'merged' && rel2.merged_commit === 'abc1234', JSON.stringify(rel2));
const metaB3 = JSON.parse(getDb().prepare('SELECT metadata FROM tasks WHERE id=?').get(reviewPickB.task.id).metadata);
check('merged_into === "dev"', metaB3.worktree?.merged_into === 'dev', JSON.stringify(metaB3.worktree));
check('needs-human cleared on successful merge', !JSON.parse(getDb().prepare('SELECT tags FROM tasks WHERE id=?').get(reviewPickB.task.id).tags).includes('needs-human'), 'tag still present');

console.log('\n=== TEST 7: review_in_progress status — claim moves review→review_in_progress; stop signal in worker_done ===');
// New task C, walk it to the review buffer via dev-done. Insert via getDb (setup is closed).
getDb().prepare("INSERT INTO tasks (epic_id, title, status, priority, assigned_to) VALUES (?, 'task-C', 'todo', 'medium', NULL)").run(epicId);
const nextC = handlers.worker_next({ worker_id: 'agent-C', project_id: projId });
check('agent-C claimed task-C', nextC.task?.title === 'task-C', `got ${nextC.task?.title}`);
const devDoneC = handlers.worker_done({ task_id: nextC.task.id, worker_id: 'agent-C', result: 'impl C' });
check('task-C dev-done → review buffer', devDoneC.completed_new_status === 'review', `got ${devDoneC.completed_new_status}`);
check('worker_done response carries stop:true', devDoneC.stop === true, JSON.stringify({ stop: devDoneC.stop }));
check('worker_done response carries stop_reason', typeof devDoneC.stop_reason === 'string' && devDoneC.stop_reason.length > 0, JSON.stringify({ stop_reason: devDoneC.stop_reason }));
// A reviewer claims it: status in DB MUST move to review_in_progress (not stay 'review').
const reviewPickC = handlers.worker_next({ worker_id: 'agent-R2', project_id: projId });
check('reviewer got task-C', reviewPickC.task?.id === nextC.task.id, `got ${reviewPickC.task?.id}`);
const rowC = getDb().prepare('SELECT status, assigned_to FROM tasks WHERE id=?').get(nextC.task.id);
check('claim moved review → review_in_progress in DB', rowC.status === 'review_in_progress', `status=${rowC.status}`);
check('reviewer assigned_to set', rowC.assigned_to === 'agent-R2', `assigned_to=${rowC.assigned_to}`);
// Reviewer delivers APPROVED: review_in_progress → done.
const approvedC = handlers.worker_done({ task_id: nextC.task.id, worker_id: 'agent-R2', result: 'APPROVED' });
check('task-C APPROVED → done from review_in_progress', approvedC.completed_new_status === 'done', `got ${approvedC.completed_new_status}`);
check('APPROVED response also carries stop:true', approvedC.stop === true, JSON.stringify({ stop: approvedC.stop }));

closeDb();

console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
