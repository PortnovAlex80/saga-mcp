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

test('REG-10-AC-01 cutover: task with workplace loop=running + active execution NOT claimable', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'todo' }); // stale reverse projection
  const ref = bindWorkplace(db, 1, 'running', 'in_progress');
  // An ACTIVE worker_execution holds the lease — the workplace is not orphaned.
  db.prepare(
    `INSERT INTO worker_executions (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, phase, metadata, lease_expires_at, heartbeat_at, progress_at, stuck_state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('active-exec', 'r', projectId, 1, 1, 'w', 'm', 'executing', '{}', '2030-01-01', '2026-01-01', '2026-01-01', 'active');
  // Bind the reservation ref so the orphan-check sees the active execution.
  const cur = db.prepare(`SELECT revision FROM v4_workplaces WHERE workplace_ref=?`).get(serializeWorkplaceRef(ref));
  db.prepare(`UPDATE v4_workplaces SET active_reservation_ref='active-exec' WHERE workplace_ref=?`).run(serializeWorkplaceRef(ref));

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.equal(task, null, 'NOT claimable — workplace loop=running with active execution');
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

test('REG-10-AC-01 cutover: PM task without workplace binding IS claimable (lazy materialize)', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'todo' });
  // No bindWorkplace call — task.workplace_ref is NULL but metadata has
  // process_run_id. First claim materializes the workplace (lazy binding).

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.ok(task, 'PM task without binding is claimable — lazy materialize on first claim');
  db.close();
});

test('REG-10-AC-01 cutover: non-PM task without binding NOT claimable', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'todo', meta: {} }); // no process_run_id
  // No binding AND no process_run_id → not a PM task, not claimable in cutover.

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.equal(task, null, 'non-PM task without binding NOT claimable');
  db.close();
});

test('legacy mode: task queue gate is tasks.status (not workplace)', () => {
  process.env.SAGA_WORKPLACE_READ = "legacy";
  const db = freshDb();
  const projectId = seedTask(db, 1, { status: 'todo' });
  // No workplace binding at all — legacy mode does not require one.

  const task = findNextClaimable(db, 'w-1', projectId);
  assert.ok(task, 'legacy mode: tasks.status=todo is claimable without a workplace');
  db.close();
});

test('teardown: reset SAGA_WORKPLACE_READ', () => {
  process.env.SAGA_WORKPLACE_READ = "legacy";
  assert.ok(true);
});
