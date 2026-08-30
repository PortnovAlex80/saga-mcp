// Child process for the SIGKILL recovery test: drives a run one node at a
// time with pauses, giving the parent a wide window to kill it mid-run.
import { getDb, closeDb } from '../../dist/db.js';
import { resumeRun } from '../../dist/kernel/runner.js';
import { getRun } from '../../dist/events.js';

const [dbPath, runId] = process.argv.slice(2);
process.env.DB_PATH = dbPath;
const db = getDb();

for (;;) {
  resumeRun(db, runId, { maxNodeExecutions: 1 });
  const run = getRun(db, runId);
  if (run.status !== 'running') break;
  await new Promise((resolve) => setTimeout(resolve, 8));
}
closeDb();
