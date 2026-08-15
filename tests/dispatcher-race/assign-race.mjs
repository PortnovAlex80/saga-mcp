// Race-test runner for WorkAssignmentPort: spawns N worker processes that ALL
// call SqliteWorkAssignmentAdapter.assignTask() at the same time on the same DB.
// Collects results, asserts the race invariant: NO two workers are assigned the
// same task (each task assigned at most once).
//
// This is the multi-process proof that the NEW WorkAssignmentPort (not just the
// test calls one adapter sequentially on one connection; this script exercises
// real OS-process contention through separate DB connections.
//
// Usage:  node tests/dispatcher-race/assign-race.mjs <numTasks> <numWorkers>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(thisDir));
const dbPath = join(thisDir, 'assign-race.db');
const numTasks = Number(process.argv[2] ?? 1);
const numWorkers = Number(process.argv[3] ?? 5);

// sidecar (project.txt). The tasks lack process_run_id, so we stamp it on all
// of them afterwards to satisfy the saga4 authority gate.
console.log(`\n=== SETUP (assignTask race): ${numTasks} task(s), ${numWorkers} workers ===`);
await runSync('node', [join(thisDir, 'setup.mjs'), dbPath, String(numTasks)], repoRoot);

// Stamp process_run_id on every task the setup created (saga4 authority gate).
await runSync('node', [join(thisDir, 'stamp-process-run.mjs'), dbPath], repoRoot);

// Spawn N workers simultaneously. All share the same DB_PATH.
const results = await Promise.all(
  Array.from({ length: numWorkers }, (_, i) => runWorker(`agent-${i + 1}`))
);

console.log('\n=== RESULTS (one line per worker) ===');
const claimedIds = [];
const childErrors = [];
for (const r of results) {
  console.log(r.line);
  // FAIL on ANY child error (UNIQUE constraint, crash, non-zero exit). A child
  // that threw must NOT be silently counted as a "loser" — it could indicate a
  // race-safety hole (e.g. two workers INSERT-clashing rows). The only valid
  // non-winner outcome is "queue empty or card unclaimable" (a clean null).
  if (r.parsed.error) {
    childErrors.push({ worker_id: r.parsed.worker_id, error: r.parsed.error });
  }
  if (r.parsed.claimed_task_id != null) claimedIds.push(r.parsed.claimed_task_id);
}

console.log('\n=== ASSERTIONS ===');
const counts = {};
let dup = false;
for (const id of claimedIds) {
  counts[id] = (counts[id] ?? 0) + 1;
  if (counts[id] > 1) dup = true;
}
const winners = claimedIds.length;
const losers = numWorkers - winners;

const okNoDup = !dup;
const okWinnersCount = winners === Math.min(numTasks, numWorkers);
// No child may error — every non-winner must be a CLEAN "queue empty" null,
// never a crash/SQL-error. This catches the nondeterministic UNIQUE-constraint
// clash that a loose "winners only" check would mask.
const okNoChildErrors = childErrors.length === 0;

console.log(`winners (assigned a task):        ${winners}`);
console.log(`losers (queue empty for them):    ${losers}`);
console.log(`expected winners (= min(N,W)):   ${Math.min(numTasks, numWorkers)}`);
console.log(`child errors:                     ${childErrors.length}`);
if (childErrors.length > 0) {
  for (const e of childErrors) {
    console.log(`  ❌ ${e.worker_id}: ${e.error}`);
  }
}
console.log(`INVARIANT: no task assigned twice: ${okNoDup ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`INVARIANT: winner count correct:   ${okWinnersCount ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`INVARIANT: no child errors:        ${okNoChildErrors ? 'PASS ✅' : 'FAIL ❌'}`);

if (okNoDup && okWinnersCount && okNoChildErrors) {
  console.log('\n✅✅✅ ASSIGN-RACE PASSED — WorkAssignmentPort is race-safe across processes, no double-assignment.');
  process.exit(0);
} else {
  console.log('\n❌❌❌ ASSIGN-RACE FAILED — see invariants above. A child error or wrong winner count means the race is not safe.');
  process.exit(1);
}

function runWorker(workerId) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(thisDir, 'assign-claim.mjs'), workerId], {
      cwd: repoRoot,
      env: { ...process.env, DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => {
      const lines = stdout.trim().split('\n');
      const line = lines[lines.length - 1];
      let parsed = {};
      try { parsed = JSON.parse(line); } catch { parsed = { error: 'non-JSON output', raw: line }; }
      resolve({ line, parsed });
    });
  });
}

function runSync(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
}
