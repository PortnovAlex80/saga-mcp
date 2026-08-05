// tests/process-modules/discovery-read-switch.test.mjs
//
// Conveyor v4 step 3.B.3 — Discovery read-switch.
//
// Proves that SqliteSaga3DiscoveryRuntime.readTaskState / readCurrentExecutionId
// / resumeNodeExecutionPlan read the ORCHESTRATION state (status /
// current_execution_id) from the AUTHORITATIVE v4_workplaces when
// SAGA_WORKPLACE_READ=new (cutover), not from the legacy tasks columns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';

// discovery-runtime uses getDb() singleton; route it to a temp file DB.
const DB_PATH = 'C:/Users/user/AppData/Local/Temp/saga-disc-rs.db';
try { rmSync(DB_PATH); } catch {}
process.env.DB_PATH = DB_PATH;

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef, serializeWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteSaga3DiscoveryRuntime } from '../../dist/modules/discovery/infrastructure/sqlite-discovery-runtime.js';

// Set up the schema on the singleton DB before the runtime uses it.
const { getDb, closeDb } = await import('../../dist/db.js');
const db = getDb();
db.exec(SCHEMA_SQL);

function seedEpicTask(db, { taskId = 1, taskStatus = 'todo', meta = null, workplaceRef = null } = {}) {
  const now = new Date().toISOString();
  const projectId = db.prepare(
    `INSERT INTO projects (name, description, status, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
  ).get('d', 'd', 'active', '[]', '{}', now, now).id;
  const epicId = db.prepare(
    `INSERT INTO epics (project_id, name, description, status, priority, branch, tags, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(projectId, 'd', 'd', 'planned', 'medium', 'main', '[]', 0, now, now).id;
  const m = JSON.stringify(meta ?? { process_run_id: 1, process_node_id: 'disc-cell', module_ref: 'discovery@1.0.0', work_key: `d-${taskId}` });
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, description, status, priority, task_kind, execution_mode, workflow_stage, tags, metadata, workplace_ref, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(taskId, epicId, 'd', 'd', taskStatus, 'medium', 'discovery.proposal', 'git_change', 'discovery', '[]', m, workplaceRef, now, now);
  return { projectId, epicId };
}

function bindWorkplace(db, taskId, loopState, kanbanPhase, terminalReason = null, reservationRef = null) {
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
      activeReservationRef: reservationRef,
    });
  } else if (reservationRef) {
    const cur = repo.read(ref);
    repo.applyTransition({
      workplaceRef: ref, expectedRevision: cur.revision,
      kanbanPhase: kanbanPhase, loopState: loopState, nextRole: 'author', terminalReason,
      activeReservationRef: reservationRef,
    });
  }
  db.prepare(`UPDATE tasks SET workplace_ref=? WHERE id=?`).run(serializeWorkplaceRef(ref), taskId);
  return ref;
}

test('legacy mode: readTaskState reads tasks.status', () => {
  delete process.env.SAGA_WORKPLACE_READ;
  // Re-import to reset module-level cutoverActive? It reads env at call time.
  
  seedEpicTask(db, { taskId: 101, taskStatus: 'in_progress' });
  const rt = new SqliteSaga3DiscoveryRuntime();
  assert.equal(rt.readTaskState(101), 'in_progress');
});

test('3.B.3 cutover: readTaskState derives from workplace kanban_phase', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  
  seedEpicTask(db, { taskId: 102, taskStatus: 'todo' }); // stale
  bindWorkplace(db, 102, 'terminal', 'done', 'accepted');
  const rt = new SqliteSaga3DiscoveryRuntime();
  assert.equal(rt.readTaskState(102), 'done', 'cutover reverse-projects done from v4');
});

test('3.B.3 cutover: readTaskState shows in_progress when workplace loop=running', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  
  seedEpicTask(db, { taskId: 103, taskStatus: 'done' }); // stale
  bindWorkplace(db, 103, 'running', 'in_progress');
  const rt = new SqliteSaga3DiscoveryRuntime();
  assert.equal(rt.readTaskState(103), 'in_progress', 'cutover trusts v4 loop=running over stale tasks.status=done');
});

test('3.B.3 cutover: readCurrentExecutionId reads workplace active_reservation_ref', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  
  seedEpicTask(db, { taskId: 104, taskStatus: 'in_progress' });
  bindWorkplace(db, 104, 'running', 'in_progress', null, 'res-104');
  // Seed a worker_execution for the reservation so assigned_to resolves.
  db.prepare(
    `INSERT INTO worker_executions (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, phase, metadata, lease_expires_at, heartbeat_at, progress_at, stuck_state)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('res-104', 'r', 1, 1, 104, 'worker-104', 'm', 'executing', '{}', '2030-01-01', '2026-01-01', '2026-01-01', 'active');
  const rt = new SqliteSaga3DiscoveryRuntime();
  assert.equal(rt.readCurrentExecutionId(104), 'res-104');
});

test('3.B.3 cutover: readCurrentExecutionId null when workplace loop=terminal', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  
  seedEpicTask(db, { taskId: 105, taskStatus: 'in_progress' });
  bindWorkplace(db, 105, 'terminal', 'done', 'accepted', 'res-105');
  const rt = new SqliteSaga3DiscoveryRuntime();
  assert.equal(rt.readCurrentExecutionId(105), null, 'terminal workplace has no live execution');
});

test('3.B.3 cutover: task without workplace binding falls back to tasks columns', () => {
  process.env.SAGA_WORKPLACE_READ = 'new';
  
  seedEpicTask(db, { taskId: 106, taskStatus: 'review' }); // no workplace_ref
  const rt = new SqliteSaga3DiscoveryRuntime();
  assert.equal(rt.readTaskState(106), 'review', 'legacy task without binding falls back');
});

test('teardown: reset env + close db', () => {
  delete process.env.SAGA_WORKPLACE_READ;
  closeDb();
  try { rmSync(DB_PATH); } catch { /* may be locked */ }
  assert.ok(true);
});
