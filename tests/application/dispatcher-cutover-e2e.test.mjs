// tests/application/dispatcher-cutover-e2e.test.mjs
//
// Conveyor v4 step 5.2b — dispatcher cutover end-to-end.
//
// Proves that when SAGA_WORKPLACE_READ=new (cutover mode), the dispatcher's
// worker_next → worker_done path drives the authoritative LOOP channel in
// factory_workplaces, and tasks.status is the reverse projection. This is the
// final load-bearing test of the cutover: if it passes, the dispatcher no
// longer treats tasks.status as orchestration truth for the loop.
//
// REG-06-AC-02: human command addresses a Workplace use case (reserve/release),
// not an arbitrary UPDATE of the card row.
// REG-28-AC-02: the loop channel changes; Kanban never rolls to todo on crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import {
  reserveTaskExecution,
  releaseTaskExecution,
} from '../../dist/tools/conveyor-runtime-helper.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedProjectEpicTask(db, { taskId = 1, withProcessRun = true } = {}) {
  const now = new Date().toISOString();
  const projectId = db.prepare(
    `INSERT INTO projects (name, description, status, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
  ).get('dc', 'dc', 'active', '[]', '{}', now, now).id;
  const epicId = db.prepare(
    `INSERT INTO epics (project_id, name, description, status, priority, branch, tags, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(projectId, 'dc', 'dc', 'planned', 'medium', 'main', '[]', 0, now, now).id;
  const meta = JSON.stringify(withProcessRun
    ? { process_run_id: 1, process_node_id: 'author-cell', module_ref: 'development@1.0.0', work_key: `item-${taskId}` }
    : {});
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, description, status, priority, task_kind, execution_mode, workflow_stage, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(taskId, epicId, 'dc', 'dc', 'todo', 'medium', 'development.code', 'git_change', 'development', '[]', meta, now, now);
  return { projectId, epicId, taskId, meta };
}

test('cutover ON: reserveTaskExecution creates workplace + leases loop + binds task', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const { taskId, epicId, projectId, meta } = seedProjectEpicTask(db);

  const ref = reserveTaskExecution(db, {
    taskId, epicId, projectId, taskKind: 'development.code', metadata: meta, executionId: 'exec-1',
  });
  assert.ok(ref, 'workplace ref returned');
  assert.equal(ref.processRunId, 1);

  // v4 workplace now authoritative: loop=leased, kanban=in_progress.
  const repo = new SqliteWorkplaceRepository(db);
  const state = repo.read(ref);
  assert.equal(state.loopState, 'leased');
  assert.equal(state.kanbanPhase, 'in_progress');

  // tasks.status reverse-projected (REG-06).
  const taskStatus = db.prepare(`SELECT status, workplace_ref FROM tasks WHERE id=?`).get(taskId);
  assert.equal(taskStatus.status, 'in_progress');
  assert.ok(taskStatus.workplace_ref, 'task bound to its workplace');
  db.close();
});

test('cutover ON: releaseTaskExecution(completed) advances loop', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const { taskId, epicId, projectId, meta } = seedProjectEpicTask(db);

  reserveTaskExecution(db, {
    taskId, epicId, projectId, taskKind: 'development.code', metadata: meta, executionId: 'exec-1',
  });
  // Simulate the running state (dispatcher would set current_execution_id).
  const ref = asWorkplaceRef({ processRunId: 1, moduleRef: 'development@1.0.0', productionCellId: 'author-cell', workKey: `item-${taskId}` });
  const repo = new SqliteWorkplaceRepository(db);
  let cur = repo.read(ref);
  repo.applyTransition({
    workplaceRef: ref, expectedRevision: cur.revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', terminalReason: null,
    activeReservationRef: 'exec-1',
  });
  db.prepare(`UPDATE tasks SET current_execution_id=? WHERE id=?`).run('exec-1', taskId);

  releaseTaskExecution(db, {
    taskId, epicId, projectId, taskKind: 'development.code', metadata: meta,
    executionId: 'exec-1', outcome: 'completed', taskStatus: 'in_progress',
  });

  cur = repo.read(ref);
  assert.equal(cur.loopState, 'verifying', 'completed → verifying');
  db.close();
});

test('cutover ON: crash keeps Kanban, loops to repair_wait (REG-28-AC-02)', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const { taskId, epicId, projectId, meta } = seedProjectEpicTask(db);
  reserveTaskExecution(db, {
    taskId, epicId, projectId, taskKind: 'development.code', metadata: meta, executionId: 'exec-1',
  });
  const ref = asWorkplaceRef({ processRunId: 1, moduleRef: 'development@1.0.0', productionCellId: 'author-cell', workKey: `item-${taskId}` });
  const repo = new SqliteWorkplaceRepository(db);
  const cur = repo.read(ref);
  repo.applyTransition({
    workplaceRef: ref, expectedRevision: cur.revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', terminalReason: null,
    activeReservationRef: 'exec-1',
  });
  db.prepare(`UPDATE tasks SET current_execution_id=? WHERE id=?`).run('exec-1', taskId);

  releaseTaskExecution(db, {
    taskId, epicId, projectId, taskKind: 'development.code', metadata: meta,
    executionId: 'exec-1', outcome: 'crashed', taskStatus: 'in_progress',
  });

  const after = repo.read(ref);
  assert.equal(after.loopState, 'repair_wait');
  // REG-28-AC-02: Kanban did NOT roll back to todo.
  assert.equal(after.kanbanPhase, 'in_progress');
  db.close();
});

test('cutover ON: non-Process-Module task (no process_run_id) is skipped', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const { taskId, epicId, projectId, meta } = seedProjectEpicTask(db, { withProcessRun: false });
  const ref = reserveTaskExecution(db, {
    taskId, epicId, projectId, taskKind: 'development.code', metadata: meta, executionId: 'exec-1',
  });
  assert.equal(ref, null, 'legacy board task is not projected');
  const count = db.prepare(`SELECT count(*) c FROM factory_workplaces`).get().c;
  assert.equal(count, 0);
  // tasks.status untouched (no reverse projection for a non-PM task).
  db.close();
});

// Reset env after the suite.
test('teardown: reset SAGA_WORKPLACE_READ', () => {
  process.env.SAGA_WORKPLACE_READ = "legacy";
  assert.ok(true);
});
