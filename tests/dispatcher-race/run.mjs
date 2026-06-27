// Race-test runner: spawns N worker processes that ALL call worker_next at the
// same time on the same DB. Collects results, asserts the race invariant:
// NO two workers claim the same task (each task claimed at most once).
//
// Usage:  node tests/dispatcher-race/run.mjs <numTasks> <numWorkers>
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(thisDir));
const dbPath = join(thisDir, 'race.db');
const numTasks = Number(process.argv[2] ?? 1);
const numWorkers = Number(process.argv[3] ?? 5);

// Fresh setup
console.log(`\n=== SETUP: ${numTasks} task(s), ${numWorkers} workers ===`);
await runSync('node', [join(thisDir, 'setup.mjs'), dbPath, String(numTasks)], repoRoot);

// Spawn N workers simultaneously. All share the same DB_PATH.
const results = await Promise.all(
  Array.from({ length: numWorkers }, (_, i) => runWorker(`agent-${i + 1}`))
);

console.log('\n=== RESULTS (one line per worker) ===');
const claimedIds = [];
for (const r of results) {
  console.log(r.line);
  if (r.parsed.claimed_task_id != null) claimedIds.push(r.parsed.claimed_task_id);
}

console.log('\n=== ASSERTIONS ===');
// Invariant: each task id appears at most once across winners.
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

console.log(`winners (claimed a task):        ${winners}`);
console.log(`losers (queue empty for them):    ${losers}`);
console.log(`expected winners (= min(N,W)):   ${Math.min(numTasks, numWorkers)}`);
console.log(`INVARIANT: no task claimed twice: ${okNoDup ? 'PASS ✅' : 'FAIL ❌'}`);
console.log(`INVARIANT: winner count correct:  ${okWinnersCount ? 'PASS ✅' : 'FAIL ❌'}`);

if (dup) {
  console.log('  duplicated task ids:', Object.entries(counts).filter(([, c]) => c > 1));
}

console.log(okNoDup && okWinnersCount
  ? '\n✅✅✅ RACE TEST PASSED — no double-claim, every free task claimed exactly once.\n'
  : '\n❌❌❌ RACE TEST FAILED.\n');

process.exit(okNoDup && okWinnersCount ? 0 : 1);

// ---- helpers ----
function runWorker(workerId) {
  return new Promise((resolve) => {
    const env = { ...process.env, DB_PATH: dbPath };
    const child = spawn('node', [join(thisDir, 'claim.mjs'), workerId], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', () => {
      let parsed = {};
      try { parsed = JSON.parse(stdout.trim().split('\n').pop()); } catch { parsed = { raw: stdout, err: stderr }; }
      resolve({ workerId, line: stdout.trim().split('\n').pop(), parsed, stderr });
    });
  });
}

function runSync(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    spawn(cmd, args, { cwd, stdio: 'inherit' }).on('close', (c) =>
      c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))
    );
  });
}
