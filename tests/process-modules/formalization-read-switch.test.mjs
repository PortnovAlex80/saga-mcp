// tests/process-modules/formalization-read-switch.test.mjs
//
// Conveyor v4 step 3.A.4 — Formalization read-switch.
//
// Proves that SqliteFormalizationArtifactGraph.areTasksReady reads the
// task's done-ness from the AUTHORITATIVE factory_workplaces loop_state when
// SAGA_WORKPLACE_READ=new (cutover), NOT from the legacy tasks.status. The
// integration_state / execution_mode / task_kind DATA columns are still read
// from tasks (they describe the task, not its orchestration loop).
//
// This is the first of three per-workshop read-switches (3.A.4 / 3.B.3 /
// 3.C.4). When it lands, formalization no longer treats tasks.status as
// orchestration truth for the gate decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef, serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteFormalizationArtifactGraph } from '../../dist/modules/formalization/infrastructure/sqlite-formalization-kernel.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedEpic(db) {
  const now = new Date().toISOString();
  const projectId = db.prepare(
    `INSERT INTO projects (name, description, status, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
  ).get('fr', 'fr', 'active', '[]', '{}', now, now).id;
  const epicId = db.prepare(
    `INSERT INTO epics (project_id, name, description, status, priority, branch, tags, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(projectId, 'fr', 'fr', 'planned', 'medium', 'main', '[]', 0, now, now).id;
  return { projectId, epicId };
}

function seedFormalizationTask(db, epicId, taskId, {
  taskStatus = 'todo',
  taskKind = 'formalization.ac',
  executionMode = 'artifact_change',
  integrationState = 'not_required',
  meta = null,
  workplaceRef = null,
} = {}) {
  const now = new Date().toISOString();
  const m = JSON.stringify(meta ?? { process_run_id: 1, process_node_id: 'cell', module_ref: 'formalization@1.0.0', work_key: `t-${taskId}` });
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, description, status, priority, task_kind, execution_mode, workflow_stage, integration_state, tags, metadata, workplace_ref, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(taskId, epicId, 'fr', 'fr', taskStatus, 'medium', taskKind, executionMode, 'formalization', integrationState, '[]', m, workplaceRef, now, now);
}

function bindWorkplace(db, taskId, loopState, kanbanPhase, terminalReason = null) {
  const meta = JSON.parse(db.prepare(`SELECT metadata FROM tasks WHERE id=?`).get(taskId).metadata);
  const ref = asWorkplaceRef({
    processRunId: meta.process_run_id,
    moduleRef: meta.module_ref,
    productionCellId: meta.process_node_id,
    workKey: meta.work_key,
  });
  const repo = new SqliteWorkplaceRepository(db);
  repo.materialize({
    processRunId: meta.process_run_id,
    moduleRef: meta.module_ref,
    productionCellId: meta.process_node_id,
    workKey: meta.work_key,
  });
  if (loopState !== 'idle' || kanbanPhase !== 'todo') {
    const cur = repo.read(ref);
    repo.applyTransition({
      workplaceRef: ref, expectedRevision: cur.revision,
      kanbanPhase: kanbanPhase, loopState: loopState, nextRole: 'author', terminalReason,
    });
  }
  db.prepare(`UPDATE tasks SET workplace_ref=? WHERE id=?`).run(serializeWorkplaceRef(ref), taskId);
  return ref;
}

test('legacy mode: areTasksReady reads tasks.status', () => {
  process.env.SAGA_WORKPLACE_READ = "legacy";
  const db = freshDb();
  const { epicId } = seedEpic(db);
  // Task with status=todo (NOT done) — no workplace binding.
  seedFormalizationTask(db, epicId, 1, { taskStatus: 'todo' });

  const graph = new SqliteFormalizationArtifactGraph(db);
  const result = graph.areTasksReady(epicId);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockingTaskIds, [1]);
  db.close();
});

test('legacy mode: areTasksReady true when tasks.status=done + merged', () => {
  process.env.SAGA_WORKPLACE_READ = "legacy";
  const db = freshDb();
  const { epicId } = seedEpic(db);
  seedFormalizationTask(db, epicId, 1, {
    taskStatus: 'done', executionMode: 'git_change', integrationState: 'merged',
  });
  const graph = new SqliteFormalizationArtifactGraph(db);
  const result = graph.areTasksReady(epicId);
  assert.equal(result.ready, true);
  db.close();
});

test('3.A.4 cutover: areTasksReady reads workplace loop=terminal (authoritative)', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const { epicId } = seedEpic(db);
  // Stale reverse projection: tasks.status='todo' but workplace loop=terminal.
  seedFormalizationTask(db, epicId, 1, { taskStatus: 'todo' });
  bindWorkplace(db, 1, 'terminal', 'done', 'accepted');

  const graph = new SqliteFormalizationArtifactGraph(db);
  const result = graph.areTasksReady(epicId);
  // Cutover: workplace loop=terminal ⇒ done ⇒ ready (despite stale tasks.status=todo).
  assert.equal(result.ready, true, 'cutover trusts v4 loop=terminal over stale tasks.status');
  db.close();
});

test('3.A.4 cutover: areTasksReady false when workplace loop=running (authoritative)', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const { epicId } = seedEpic(db);
  // Stale reverse projection: tasks.status='done' but workplace loop=running.
  seedFormalizationTask(db, epicId, 1, { taskStatus: 'done' });
  bindWorkplace(db, 1, 'running', 'in_progress');

  const graph = new SqliteFormalizationArtifactGraph(db);
  const result = graph.areTasksReady(epicId);
  // Cutover: workplace loop=running ⇒ NOT done ⇒ blocking (despite tasks.status=done).
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockingTaskIds, [1]);
  db.close();
});

test('3.A.4 cutover: git_change still requires integration_state=merged (DATA column)', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const { epicId } = seedEpic(db);
  seedFormalizationTask(db, epicId, 1, {
    taskStatus: 'done', executionMode: 'git_change', integrationState: 'pending',
  });
  bindWorkplace(db, 1, 'terminal', 'done', 'accepted');

  const graph = new SqliteFormalizationArtifactGraph(db);
  const result = graph.areTasksReady(epicId);
  // Workplace says done, but integration_state=pending (not merged) ⇒ blocking.
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockingTaskIds, [1]);
  db.close();
});

test('3.A.4 cutover: bookkeeping tasks (summary/recovery) excluded', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  const db = freshDb();
  const { epicId } = seedEpic(db);
  seedFormalizationTask(db, epicId, 1, { taskKind: 'summary.stage' });
  bindWorkplace(db, 1, 'running', 'in_progress');

  const graph = new SqliteFormalizationArtifactGraph(db);
  const result = graph.areTasksReady(epicId);
  // No gateable tasks (the only one is summary) ⇒ ready=false, no blockers.
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockingTaskIds, []);
  db.close();
});

test('teardown: reset SAGA_WORKPLACE_READ', () => {
  process.env.SAGA_WORKPLACE_READ = "legacy";
  assert.ok(true);
});
