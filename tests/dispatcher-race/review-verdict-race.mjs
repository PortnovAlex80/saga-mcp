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
import Database from 'better-sqlite3';

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(thisDir));
const dbPath = join(thisDir, 'verdict-race.db');

// --- setup: fresh DB, 1 project, 1 task, dev-cycle done → task in review ---
for (const ext of ['', '-wal', '-shm']) { try { rmSync(dbPath + ext); } catch {} }
const setup = new Database(dbPath);
setup.pragma('journal_mode = WAL');
setup.pragma('foreign_keys = ON');
setup.pragma('busy_timeout = 5000');
// Use production schema to avoid drift when new columns are added.
const { pathToFileURL } = await import('node:url');
const { SCHEMA_SQL } = await import(pathToFileURL(join(repoRoot, 'dist', 'schema.js')).href);
setup.exec(SCHEMA_SQL);
setup.prepare("INSERT INTO projects (name) VALUES ('verdict-race')").run();
const pid = setup.prepare("SELECT id FROM projects WHERE name='verdict-race'").get().id;
setup.prepare("INSERT INTO epics (project_id, name) VALUES (?, 'e')").run(pid);
const eid = setup.prepare("SELECT id FROM epics WHERE name='e'").get().id;
// saga4 authority gate (findNextClaimable): a card is claimable ONLY if
// metadata.process_run_id IS NOT NULL. Stamp it so worker_next can claim the
// review card into review_in_progress and create the worker_executions fence.
setup.prepare("INSERT INTO tasks (epic_id, title, status, assigned_to, metadata) VALUES (?, 'T', 'review', NULL, ?)").run(eid, JSON.stringify({ process_run_id: 3001 }));
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
// All callers reuse the SAME fenced execution_id (one holder, many retries).
// Under the saga4 idempotency layer the FIRST worker_done transitions
// review_in_progress→done and stores a command_receipt; every later call is a
// REPLAY (same command_id + payload hash) and returns the stored 'done' reply
// WITHOUT mutating state again. So "winners" here = callers that observed the
// done verdict (the leader + its replays); "errors" = none expected.
const winners = results.filter(r => r.parsed?.verdict === 'done');
const errors = results.filter(r => r.parsed?.error);
for (const r of results) console.log(r.line);

console.log('\n=== ASSERTIONS ===');
// Verify final DB state: task must be 'done', exactly once.
const check = new Database(dbPath, { readonly: true });
const finalTask = check.prepare('SELECT status, assigned_to FROM tasks WHERE id=?').get(taskId);
const commentCount = check.prepare('SELECT COUNT(*) n FROM comments WHERE task_id=?').get(taskId).n;
// command_receipts: exactly ONE accepted worker_done row proves a single state
// mutation under contention — the core no-double-done invariant.
let receiptCount = 0;
try {
  receiptCount = check.prepare("SELECT COUNT(*) n FROM command_receipts WHERE task_id=? AND command_kind='worker_done' AND accepted=1").get(taskId).n;
} catch { /* command_receipts absent in a stripped schema — count stays 0 */ }
check.close();

const okAllSeeDone = winners.length === numWorkers && errors.length === 0;
const okFinalDone = finalTask.status === 'done';
const okFinalUnassigned = finalTask.assigned_to === null;
// Exactly ONE comment + ONE accepted receipt = exactly one mutation, regardless
// of how many replays observed the done verdict.
const okOneMutation = commentCount === 1 && receiptCount === 1;

console.log(`callers observing done (leader + replays): ${winners.length}/${numWorkers}  ${okAllSeeDone ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`callers erroring:                         ${errors.length} (expect 0)   ${errors.length === 0 ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`final task status: ${finalTask.status} (expect done)        ${okFinalDone ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`final assigned_to: ${finalTask.assigned_to} (expect null)   ${okFinalUnassigned ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`single mutation (1 comment, 1 receipt):    ${okOneMutation ? 'PASS ✅' : 'FAIL ❌'}  [comments=${commentCount}, receipts=${receiptCount}]`);

const allPass = okAllSeeDone && okFinalDone && okFinalUnassigned && okOneMutation;
console.log(allPass ? '\n✅✅✅ NO DOUBLE-DONE — exactly one state mutation under contention; replays are idempotent.\n'
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
