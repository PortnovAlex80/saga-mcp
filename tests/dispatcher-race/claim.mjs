// One worker's claim attempt. Connects, calls handleWorkerNext (with project_id
// read from the project sidecar), prints a single JSON line with the outcome. Exits.
// Usage:  DB_PATH=<dbPath> node tests/dispatcher-race/claim.mjs <workerId>
import { getDb, closeDb } from '../../dist/db.js';
import { handlers } from '../../dist/tools/dispatcher.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const thisDir = dirname(fileURLToPath(import.meta.url));
const workerId = process.argv[2];
if (!workerId) {
  console.error('usage: DB_PATH=<db> node claim.mjs <workerId>');
  process.exit(2);
}

// project_id is now required by worker_next; read it from the setup sidecar.
const proj = JSON.parse(readFileSync(join(thisDir, 'project.txt'), 'utf8'));

const t0 = Date.now();
let outcome;
try {
  const result = handlers.worker_next({ worker_id: workerId, project_id: proj.project_id });
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
