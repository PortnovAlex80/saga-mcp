// One worker's assignTask attempt. Connects to the same DB, calls
// SqliteWorkAssignmentAdapter.assignTask() (the new WorkAssignmentPort), prints
// a single JSON line with the outcome, exits.
//
// This is the WorkAssignmentPort analogue of claim.mjs (which exercises the
// invariant under concurrency; this script proves the NEW port is race-safe
// across real OS processes, not just on a single connection.
//
// Usage:  DB_PATH=<dbPath> node tests/dispatcher-race/assign-claim.mjs <workerId>
import { getDb, closeDb } from '../../dist/db.js';
import { SqliteWorkAssignmentAdapter } from '../../dist/infrastructure/work/sqlite-work-assignment-adapter.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import os from 'node:os';

const thisDir = dirname(fileURLToPath(import.meta.url));
const workerId = process.argv[2];
if (!workerId) {
  console.error('usage: DB_PATH=<db> node assign-claim.mjs <workerId>');
  process.exit(2);
}

const proj = JSON.parse(readFileSync(join(thisDir, 'project.txt'), 'utf8'));

const t0 = Date.now();
let outcome;
try {
  const adapter = new SqliteWorkAssignmentAdapter(getDb());
  const work = adapter.assignTask({
    projectId: proj.project_id,
    workerId,
    workerExecutionId: `exec-race-${workerId}-${Date.now()}`,
    runId: `assign-race-${Date.now()}`,
    machineId: os.hostname(),
  });
  outcome = {
    worker_id: workerId,
    claimed_task_id: work ? work.taskId : null,
    fence_token: work ? work.fenceToken : null,
    reason: work ? null : 'queue empty or card unclaimable',
  };
} catch (err) {
  outcome = { worker_id: workerId, error: err.message };
} finally {
  closeDb();
}
outcome.elapsed_ms = Date.now() - t0;
console.log(JSON.stringify(outcome));
