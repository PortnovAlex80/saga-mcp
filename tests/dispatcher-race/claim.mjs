// One worker's claim attempt. Connects, calls handleWorkerNext, prints a
// single JSON line with the outcome. Exits.
// Usage:  DB_PATH=<dbPath> node tests/dispatcher-race/claim.mjs <workerId>
import { getDb, closeDb } from '../../dist/db.js';
import { handlers } from '../../dist/tools/dispatcher.js';

const workerId = process.argv[2];
if (!workerId) {
  console.error('usage: DB_PATH=<db> node claim.mjs <workerId>');
  process.exit(2);
}

const t0 = Date.now();
let outcome;
try {
  const result = handlers.worker_next({ worker_id: workerId });
  outcome = {
    worker_id: workerId,
    claimed_task_id: result.task ? result.task.id : null,
    skill: result.skill,
    reason: result.reason ?? null,
  };
} catch (err) {
  outcome = { worker_id: workerId, error: err.message };
} finally {
  closeDb();
}
outcome.elapsed_ms = Date.now() - t0;
console.log(JSON.stringify(outcome));
