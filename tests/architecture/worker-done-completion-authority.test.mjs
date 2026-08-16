import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { releaseExecutionAtomically } from '../../dist/lifecycle/atomic-release.js';
import { SCHEMA_SQL } from '../../dist/schema.js';

function executionFixture({ withAcceptedReceipt }) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);

  const projectId = Number(db.prepare(
    `INSERT INTO projects (name) VALUES ('worker-done-authority-test')`,
  ).run().lastInsertRowid);
  const epicId = Number(db.prepare(
    `INSERT INTO epics (project_id, name) VALUES (?, 'runtime')`,
  ).run(projectId).lastInsertRowid);
  const taskId = Number(db.prepare(
    `INSERT INTO tasks
       (epic_id, title, status, assigned_to, current_execution_id,
        task_kind, execution_mode, metadata)
     VALUES (?, 'candidate verifying', 'in_progress', 'worker-1', 'exec-1',
             'discovery.work', 'tracker_only', '{}')`,
  ).run(epicId).lastInsertRowid);

  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id,
        machine_id, state, phase)
     VALUES ('exec-1', 'run-1', ?, ?, ?, 'worker-1', 'test-machine',
             'running', 'finishing')`,
  ).run(projectId, epicId, taskId);

  if (withAcceptedReceipt) {
    const reply = JSON.stringify({
      completed: taskId,
      completed_new_status: 'done',
      stop: true,
      stop_reason: 'task completed',
    });
    db.prepare(
      `INSERT INTO command_receipts
         (command_id, command_kind, actor_kind, actor_id, execution_id,
          task_id, payload_hash, accepted, rejection_code, result_json,
          reply_json)
       VALUES ('exec-1:worker-done:approved', 'worker_done',
               'managed_execution', 'worker-1', 'exec-1', ?, 'hash-1',
               1, NULL, ?, ?)`,
    ).run(taskId, reply, reply);
  }

  return { db, taskId };
}

test('accepted worker_done closes the execution fence without requeueing the verifying task', () => {
  const { db, taskId } = executionFixture({ withAcceptedReceipt: true });

  const outcome = releaseExecutionAtomically(db, {
    executionId: 'exec-1',
    terminalState: 'exited',
    exitCode: 0,
    reason: 'process close callback',
  });

  const task = db.prepare(
    `SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?`,
  ).get(taskId);
  const execution = db.prepare(
    `SELECT state, exit_code FROM worker_executions WHERE execution_id='exec-1'`,
  ).get();

  assert.equal(outcome.taskReleased, true);
  assert.equal(outcome.restoredStatus, 'in_progress');
  assert.deepEqual(task, {
    status: 'in_progress',
    assigned_to: null,
    current_execution_id: null,
  });
  assert.deepEqual(execution, { state: 'exited', exit_code: 0 });
  db.close();
});
test('an execution without worker_done evidence retains crash recovery mapping', () => {
  const { db, taskId } = executionFixture({ withAcceptedReceipt: false });

  const outcome = releaseExecutionAtomically(db, {
    executionId: 'exec-1',
    terminalState: 'lost',
    reason: 'worker disappeared before completion',
  });

  const task = db.prepare(
    `SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?`,
  ).get(taskId);
  assert.equal(outcome.restoredStatus, 'todo');
  assert.deepEqual(task, {
    status: 'todo',
    assigned_to: null,
    current_execution_id: null,
  });
  db.close();
});
