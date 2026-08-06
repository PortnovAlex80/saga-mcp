import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { ensureAuthorityBindingInvariant } from '../../dist/infrastructure/projections/workplace-projector.js';
import { SCHEMA_SQL } from '../../dist/schema.js';

function fixture({ installInvariant = true } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  if (installInvariant) ensureAuthorityBindingInvariant(db);

  const projectId = Number(db.prepare(
    `INSERT INTO projects (name) VALUES ('authority-binding-test')`,
  ).run().lastInsertRowid);
  const epicId = Number(db.prepare(
    `INSERT INTO epics (project_id, name) VALUES (?, 'REQ-001-test')`,
  ).run(projectId).lastInsertRowid);

  return { db, projectId, epicId };
}

function createBinding(db, epicId, suffix, kind = 'discovery', intentStatus = 'executing') {
  const workplaceRef = `workplace/${suffix}/product-discovery@1.0.0/produce-proposal/task-${suffix}`;
  const taskId = Number(db.prepare(
    `INSERT INTO tasks
       (epic_id, title, status, assigned_to, current_execution_id,
        task_kind, execution_mode, workplace_ref, metadata)
     VALUES (?, ?, 'todo', ?, ?, 'discovery.work', 'tracker_only', ?, '{}')`,
  ).run(
    epicId,
    `Discovery task ${suffix}`,
    `worker-${suffix}`,
    `exec-${suffix}`,
    workplaceRef,
  ).lastInsertRowid);

  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id,
        work_key, kanban_phase, loop_state, next_role,
        active_reservation_ref)
     VALUES (?, ?, 'product-discovery@1.0.0', 'produce-proposal', ?,
             'in_progress', 'verifying', 'author', ?)`,
  ).run(workplaceRef, suffix, `task-${suffix}`, `exec-${suffix}`);

  const intentId = Number(db.prepare(
    `INSERT INTO factory_work_intents
       (epic_id, kind, objective, authority_scope, output_schema,
        projected_task_id, status)
     VALUES (?, ?, 'test objective', ?, 'factory.work-intent.discovery.v1', ?, ?)`,
  ).run(
    epicId,
    kind,
    JSON.stringify({
      snapshot_ref: `snapshot-${suffix}`,
      scope: 'test',
      allowed_tools: [],
      enforcement: 'runtime',
    }),
    taskId,
    intentStatus,
  ).lastInsertRowid);

  return { intentId, taskId, workplaceRef };
}

function readState(db, binding) {
  const workplace = db.prepare(
    `SELECT kanban_phase, loop_state, terminal_reason,
            active_reservation_ref, revision
       FROM factory_workplaces
      WHERE workplace_ref=?`,
  ).get(binding.workplaceRef);
  const task = db.prepare(
    `SELECT status, assigned_to, current_execution_id
       FROM tasks WHERE id=?`,
  ).get(binding.taskId);
  const intent = db.prepare(
    `SELECT status FROM factory_work_intents WHERE id=?`,
  ).get(binding.intentId);
  return { workplace, task, intent };
}

test('concluding an accepted durable proposal atomically terminalizes its Workplace and task projection', () => {
  const { db, epicId } = fixture();
  const binding = createBinding(db, epicId, 1);

  db.prepare(
    `INSERT INTO factory_proposals
       (intent_id, task_id, execution_id, kind, schema_version,
        payload, content_hash, status)
     VALUES (?, ?, 'exec-1', 'discovery', 'factory.discovery-proposal.v1',
             '{}', 'proposal-hash-1', 'submitted')`,
  ).run(binding.intentId, binding.taskId);

  db.prepare(
    `UPDATE factory_work_intents SET status='concluded' WHERE id=?`,
  ).run(binding.intentId);

  const state = readState(db, binding);
  assert.deepEqual(
    {
      phase: state.workplace.kanban_phase,
      loop: state.workplace.loop_state,
      reason: state.workplace.terminal_reason,
      reservation: state.workplace.active_reservation_ref,
      taskStatus: state.task.status,
      assignedTo: state.task.assigned_to,
      fence: state.task.current_execution_id,
      intent: state.intent.status,
    },
    {
      phase: 'done',
      loop: 'terminal',
      reason: 'accepted',
      reservation: null,
      taskStatus: 'done',
      assignedTo: null,
      fence: null,
      intent: 'concluded',
    },
  );
  db.close();
});

test('a syntactically rejected discovery submission terminates the Workplace as failed, never as claimable todo', () => {
  const { db, epicId } = fixture();
  const binding = createBinding(db, epicId, 2);

  db.prepare(
    `INSERT INTO factory_raw_submissions
       (intent_id, task_id, execution_id, kind, schema_version,
        raw_payload, raw_hash, status)
     VALUES (?, ?, 'exec-2', 'discovery', 'factory.discovery-proposal.v1',
             '{', 'raw-hash-2', 'rejected_syntax')`,
  ).run(binding.intentId, binding.taskId);

  db.prepare(
    `UPDATE factory_work_intents SET status='concluded' WHERE id=?`,
  ).run(binding.intentId);

  const state = readState(db, binding);
  assert.equal(state.workplace.kanban_phase, 'failed');
  assert.equal(state.workplace.loop_state, 'terminal');
  assert.equal(state.workplace.terminal_reason, 'failed');
  assert.equal(state.task.status, 'done');
  assert.equal(state.intent.status, 'concluded');
  db.close();
});

test('database open reconciliation repairs historical concluded + verifying/todo split brain', () => {
  const { db, epicId } = fixture({ installInvariant: false });
  const binding = createBinding(db, epicId, 3, 'discovery', 'concluded');

  db.prepare(
    `INSERT INTO factory_proposals
       (intent_id, task_id, execution_id, kind, schema_version,
        payload, content_hash, status)
     VALUES (?, ?, 'exec-3', 'discovery', 'factory.discovery-proposal.v1',
             '{}', 'proposal-hash-3', 'submitted')`,
  ).run(binding.intentId, binding.taskId);

  const result = ensureAuthorityBindingInvariant(db);
  const state = readState(db, binding);

  assert.deepEqual(result, {
    inspected: 1,
    workplacesAdvanced: 1,
    taskProjectionsRebuilt: 1,
  });
  assert.equal(state.workplace.kanban_phase, 'done');
  assert.equal(state.workplace.loop_state, 'terminal');
  assert.equal(state.workplace.terminal_reason, 'accepted');
  assert.equal(state.task.status, 'done');
  assert.equal(state.task.current_execution_id, null);
  assert.equal(state.intent.status, 'concluded');
  db.close();
});
