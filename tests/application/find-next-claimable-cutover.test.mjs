// tests/application/find-next-claimable-cutover.test.mjs
//
// Conveyor v4 step 5.2 — findNextClaimable queue gate is v4_workplaces in
// cutover mode (REG-10-AC-01: "queue consists of Workplace with
// loopState=queued").
//
// In SAGA_WORKPLACE_READ=new mode, a task is queue-eligible iff its bound
// workplace is in idle/queued loop. A task whose workplace is leased/running/
// repair_wait is NOT claimable, even if its tasks.status happens to be 'todo'
// (stale reverse projection). This is the load-bearing test that the queue
// no longer treats tasks.status as orchestration truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef, serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { findNextClaimable } from '../../dist/lifecycle/work-assignment-core.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedTask(db, taskId, { status = 'todo', meta = null } = {}) {
  const now = new Date().toISOString();
  const projectId = db.prepare(
    `INSERT INTO projects (name, description, status, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
  ).get('q', 'q', 'active', '[]', '{}', now, now).id;
  const epicId = db.prepare(
    `INSERT INTO epics (project_id, name, description, status, priority, branch, tags, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(projectId, 'q', 'q', 'planned', 'medium', 'main', '[]', 0, now, now).id;
  const m = JSON.stringify(meta ?? { process_run_id: 1, process_node_id: 'c', module_ref: 'development@1.0.0', work_key: `i-${taskId}` });
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, description, status, priority, task_kind, execution_mode, workflow_stage, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(taskId, epicId, 'q', 'q', status, 'medium', 'development.code', 'git_change', 'development', '[]', m, now, now);
  return projectId;
}

function bindWorkplace(db, taskId, loopState, kanbanPhase = 'todo') {
  const meta = db.prepare(`SELECT metadata FROM tasks WHERE id=?`).get(taskId).metadata;
  const parsed = JSON.parse(meta);
  const ref = asWorkplaceRef({
    processRunId: parsed.process_run_id,
    moduleRef: parsed.module_ref,
    productionCellId: parsed.process_node_id,
    workKey: parsed.work_key,
  });
  const repo = new SqliteWorkplaceRepository(db);
  repo.materialize({
    processRunId: parsed.process_run_id,
    moduleRef: parsed.module_ref,
    productionCellId: parsed.process_node_id,
    workKey: parsed.work_key,
  });
  if (loopState !== 'idle' || kanbanPhase !== 'todo') {
    const cur = repo.read(ref);
    repo.applyTransition({
      workplaceRef: ref, expectedRevision: cur.revision,
      kanbanPhase: kanbanPhase, loopState: loopState, nextRole: 'author', terminalReason: null,
    });
  }
  db.prepare(`UPDATE tasks SET workplace_ref=? WHERE id=?`).run(serializeWorkplaceRef(ref), taskId);
  return ref;
}

test('REG-10-AC-01 cutover: task with workplace loop=idle IS claimable', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'todo' });
  bindWorkplace(db, 1, 'idle', 'todo');

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.ok(task, 'claimable when workplace loop=idle');
  assert.equal(task.id, 1);
  db.close();
});

test('REG-10-AC-01 cutover: task with workplace loop=running NOT claimable', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'todo' }); // stale reverse projection
  bindWorkplace(db, 1, 'running', 'in_progress');

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.equal(task, null, 'NOT claimable — workplace loop=running');
  db.close();
});

test('REG-10-AC-01 cutover: task with workplace loop=repair_wait NOT claimable', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'todo' });
  bindWorkplace(db, 1, 'repair_wait', 'in_progress');

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.equal(task, null, 'NOT claimable — workplace in repair_wait');
  db.close();
});

test('REG-10-AC-01 cutover: task with workplace loop=queued IS claimable (re-queue)', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'in_progress' });
  bindWorkplace(db, 1, 'queued', 'in_progress');

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.ok(task, 'claimable when workplace loop=queued (repair re-queue)');
  db.close();
});

test('REG-10-AC-01 cutover: task WITHOUT workplace binding NOT claimable', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'todo' });
  // No bindWorkplace call — task.workplace_ref is NULL.

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.equal(task, null, 'NOT claimable without a workplace binding');
  db.close();
});

test('legacy mode: task queue gate is tasks.status (not workplace)', () => {
  delete process.env.SAGA_WORKPLACE_READ;
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'todo' });
  // No workplace binding at all — legacy mode does not require one.

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.ok(task, 'legacy mode: tasks.status=todo is claimable without a workplace');
  db.close();
});

test('teardown: reset SAGA_WORKPLACE_READ', () => {
  delete process.env.SAGA_WORKPLACE_READ;
  assert.ok(true);
});
