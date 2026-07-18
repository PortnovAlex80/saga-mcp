// One worker's review verdict. Calls worker_done on a review task, prints JSON.
// Usage:  DB_PATH=<db> node tests/dispatcher-race/verdict.mjs <workerId> <taskId>
import { getDb, closeDb } from '../../dist/db.js';
import { handlers } from '../../dist/tools/dispatcher.js';

const workerId = process.argv[2];
const taskId = Number(process.argv[3]);
const executionId = process.argv[4];
if (!workerId || !taskId) {
  console.error('usage: DB_PATH=<db> node verdict.mjs <workerId> <taskId>');
  process.exit(2);
}

let out;
try {
  const r = handlers.worker_done({
    task_id: taskId,
    worker_id: workerId,
    execution_id: executionId,
    result: 'APPROVED',
  });
  out = { worker_id: workerId, verdict: r.completed_new_status };
} catch (e) {
  out = { worker_id: workerId, error: e.message };
} finally {
  closeDb();
}
console.log(JSON.stringify(out));
