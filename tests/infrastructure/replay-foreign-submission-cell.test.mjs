// tests/infrastructure/replay-foreign-submission-cell.test.mjs
//
// Packaging defect regression (2026-08-22, 4/6 live repro):
// REPLAY_CAPTURE_GIT_RECIPE_MISSING killed solution-development
// NONDETERMINISTICALLY. Root cause: isForeignManagedSubmission (F-R1) treated
// a managed submission as foreign on EXECUTION identity alone. A retry/repair
// successor execution of the SAME task accepts a cumulative CandidateSet whose
// implementation product was submitted by a predecessor execution of that task
// (ADR-053 C14, P18 cross-execution repair); the skip left the accepted
// capsule without the implementation product — and a git_change capsule
// without the implementation product has NO Git recipe, so completeness
// failed closed and the stage died. Whether the retry path fired varied
// run-to-run, hence the coin-flip flake.
//
// Pins the CELL rule: "own" is the TASK, not the execution.
//   same execution          -> own (never foreign)
//   predecessor, same task  -> own  (the packaging defect: was foreign)
//   another task's execution-> foreign (F-R1 reviewer protection intact)
//   capturing execution unknown -> foreign (legacy fail-closed shape)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { ensureManagedNodeSubmissionSchema } from '../../dist/process-modules/persistence/sqlite-managed-node-submission-repository.js';
import { isForeignManagedSubmission } from '../../dist/infrastructure/replay/replay-capsule-completeness.js';

function makeDb() {
  const db = new Database(':memory:');
  ensureManagedNodeSubmissionSchema(db);
  db.exec(`CREATE TABLE worker_executions (
    execution_id TEXT PRIMARY KEY,
    task_id INTEGER NOT NULL
  )`);
  db.pragma('foreign_keys=OFF');
  return db;
}

function insertSubmission(db, id, taskId, executionId) {
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
        schema_version,payload_snapshot,content_hash,submitted_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, 1, 'solution-development@1.4.4', 'implement-work-items', 'intent', taskId,
    executionId, 'v1', '{}', '0'.repeat(64), '2026-08-22T00:00:00.000Z',
  );
}

test('same-task predecessor submission is OWN material, not foreign (packaging defect)', () => {
  const db = makeDb();
  insertSubmission(db, 10, 14, 'worker-execution:predecessor');
  db.prepare(`INSERT INTO worker_executions (execution_id,task_id) VALUES (?,?)`)
    .run('worker-execution:successor', 14);
  // Before the cell fix this returned true — the capsule skipped the
  // implementation product and died REPLAY_CAPTURE_GIT_RECIPE_MISSING.
  assert.equal(
    isForeignManagedSubmission(db, 'managed-node-submission:10', 'worker-execution:successor'),
    false,
  );
});

test('another task\'s submission stays foreign (F-R1 reviewer protection intact)', () => {
  const db = makeDb();
  insertSubmission(db, 11, 14, 'worker-execution:author');
  db.prepare(`INSERT INTO worker_executions (execution_id,task_id) VALUES (?,?)`)
    .run('worker-execution:reviewer', 16);
  assert.equal(
    isForeignManagedSubmission(db, 'managed-node-submission:11', 'worker-execution:reviewer'),
    true,
  );
});

test('same execution is never foreign', () => {
  const db = makeDb();
  insertSubmission(db, 12, 14, 'worker-execution:own');
  db.prepare(`INSERT INTO worker_executions (execution_id,task_id) VALUES (?,?)`)
    .run('worker-execution:own', 14);
  assert.equal(
    isForeignManagedSubmission(db, 'managed-node-submission:12', 'worker-execution:own'),
    false,
  );
});

test('unknown capturing execution keeps the legacy foreign fail-closed shape', () => {
  const db = makeDb();
  insertSubmission(db, 13, 14, 'worker-execution:someone-else');
  assert.equal(
    isForeignManagedSubmission(db, 'managed-node-submission:13', 'worker-execution:missing'),
    true,
  );
});
