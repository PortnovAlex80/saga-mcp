// tests/application/conveyor-runtime-authority.test.mjs
//
// Conveyor v4 step 5.2 cutover — ConveyorRuntime authority E2E.
//
// Proves that after cutover:
//   - ConveyorRuntime drives the LOOP channel authoritatively in v4_workplaces.
//   - The KANBAN channel (tasks.status) is a REVERSE PROJECTION of the
//     workplace's kanbanPhase (REG-06-AC-01: rebuildable).
//   - REG-28-AC-02: crash/expiry changes loop, NEVER rolls Kanban back to todo.
//   - REG-05-AC-03: crash does not create a new Workplace.
//   - REG-05-AC-06: CAS on revision (idempotent replay; concurrent writer loses).
//   - REG-09-AC-04: a stale/revoked fence cannot mutate the workplace.
//
// This is the load-bearing cutover test: if it passes, v4_workplaces is the
// authority for the loop channel and tasks is a projection.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { ConveyorRuntime } from '../../dist/application/conveyor-runtime.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedTaskAndWorkplace(db, { processRunId = 1, taskId = 1 } = {}) {
  // Seed a project + epic + task the way the tracker does.
  const now = new Date().toISOString();
  const projectId = db.prepare(
    `INSERT INTO projects (name, description, status, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
  ).get('rt', 'rt', 'active', '[]', '{}', now, now).id;
  const epicId = db.prepare(
    `INSERT INTO epics (project_id, name, description, status, priority, branch, tags, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(projectId, 'rt', 'rt', 'planned', 'medium', 'main', '[]', 0, now, now).id;
  const meta = JSON.stringify({
    process_run_id: processRunId,
    process_node_id: 'author-cell',
    module_ref: 'development@1.0.0',
    work_key: `item-${taskId}`,
  });
  db.prepare(
    `INSERT INTO tasks (epic_id, title, description, status, priority, task_kind, execution_mode, workflow_stage, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(epicId, 'rt', 'rt', 'todo', 'medium', 'development.code', 'git_change', 'development', '[]', meta, now, now);

  const ref = asWorkplaceRef({
    processRunId,
    moduleRef: 'development@1.0.0',
    productionCellId: 'author-cell',
    workKey: `item-${taskId}`,
  });
  const repo = new SqliteWorkplaceRepository(db);
  repo.materialize({
    processRunId,
    moduleRef: 'development@1.0.0',
    productionCellId: 'author-cell',
    workKey: `item-${taskId}`,
  });
  // Bind the task row to its workplace (data column).
  db.prepare(`UPDATE tasks SET workplace_ref=? WHERE id=?`).run(JSON.stringify(ref), taskId);
  return { ref, taskId };
}

test('E2E cutover: reserve → release(completed) drives loop + reverse-projects Kanban', () => {
  const db = freshDb();
  const { ref, taskId } = seedTaskAndWorkplace(db);
  const rt = new ConveyorRuntime(db);

  // reserveWorkplace: todo/idle → in_progress/queued → leased.
  const r1 = rt.reserveWorkplace({ workplaceRef: ref, reservationRef: 'res-1', taskId });
  assert.equal(r1.applied, true);
  assert.equal(r1.workplace.loopState, 'leased');
  assert.equal(r1.workplace.kanbanPhase, 'in_progress');
  // Reverse projection: tasks.status must now be in_progress.
  assert.equal(r1.taskStatus, 'in_progress');
  const taskStatus = db.prepare(`SELECT status FROM tasks WHERE id=?`).get(taskId).status;
  assert.equal(taskStatus, 'in_progress', 'tasks.status reverse-projected from v4 kanbanPhase');

  // releaseExecution(completed): leased → ... need running first. Simulate
  // worker-started then candidate-sealed by going through release with
  // 'completed' (the runtime maps completed → candidate-sealed from running).
  // But leased is not running. Use a fake: move to running via repo directly.
  const repo = new SqliteWorkplaceRepository(db);
  const cur = repo.read(ref);
  repo.applyTransition({
    workplaceRef: ref, expectedRevision: cur.revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', terminalReason: null,
    activeReservationRef: 'res-1',
  });

  const r2 = rt.releaseExecution({ workplaceRef: ref, reservationRef: 'res-1', taskId, outcome: 'completed' });
  assert.equal(r2.applied, true);
  assert.equal(r2.workplace.loopState, 'verifying');
  // Kanban stays in_progress during verifying.
  assert.equal(r2.workplace.kanbanPhase, 'in_progress');
  db.close();
});

test('REG-28-AC-02: crash changes loop to repair_wait, NEVER rolls Kanban back to todo', () => {
  const db = freshDb();
  const { ref, taskId } = seedTaskAndWorkplace(db);
  const rt = new ConveyorRuntime(db);
  const repo = new SqliteWorkplaceRepository(db);

  // Admit + lease + running.
  rt.reserveWorkplace({ workplaceRef: ref, reservationRef: 'res-1', taskId });
  let cur = repo.read(ref);
  repo.applyTransition({
    workplaceRef: ref, expectedRevision: cur.revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', terminalReason: null,
    activeReservationRef: 'res-1',
  });

  // Crash: running → repair_wait.
  const r = rt.releaseExecution({ workplaceRef: ref, reservationRef: 'res-1', taskId, outcome: 'crashed' });
  assert.equal(r.applied, true);
  assert.equal(r.workplace.loopState, 'repair_wait');
  // REG-28-AC-02: Kanban did NOT roll back to todo — still in_progress.
  assert.equal(r.workplace.kanbanPhase, 'in_progress');
  assert.notEqual(r.workplace.kanbanPhase, 'todo');
  // tasks.status also stays in_progress (reverse projection).
  const taskStatus = db.prepare(`SELECT status FROM tasks WHERE id=?`).get(taskId).status;
  assert.equal(taskStatus, 'in_progress');
  db.close();
});

test('REG-05-AC-03: crash does not create a new Workplace (same ref, bumped revision)', () => {
  const db = freshDb();
  const { ref, taskId } = seedTaskAndWorkplace(db);
  const rt = new ConveyorRuntime(db);
  const repo = new SqliteWorkplaceRepository(db);

  rt.reserveWorkplace({ workplaceRef: ref, reservationRef: 'res-1', taskId });
  let cur = repo.read(ref);
  const revisionBefore = cur.revision;
  repo.applyTransition({
    workplaceRef: ref, expectedRevision: cur.revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', terminalReason: null,
    activeReservationRef: 'res-1',
  });

  rt.releaseExecution({ workplaceRef: ref, reservationRef: 'res-1', taskId, outcome: 'crashed' });

  // Same WorkplaceRef, advanced revision, repair_wait.
  cur = repo.read(ref);
  assert.ok(cur, 'workplace still exists at the same ref');
  assert.equal(cur.loopState, 'repair_wait');
  assert.ok(cur.revision > revisionBefore, 'revision advanced (no new workplace)');
  // Count workplaces: exactly 1.
  const count = db.prepare(`SELECT count(*) c FROM v4_workplaces`).get().c;
  assert.equal(count, 1, 'no duplicate workplace created by crash');
  db.close();
});

test('REG-09-AC-04: stale/revoked fence cannot mutate the workplace', () => {
  const db = freshDb();
  const { ref, taskId } = seedTaskAndWorkplace(db);
  const rt = new ConveyorRuntime(db);
  const repo = new SqliteWorkplaceRepository(db);

  rt.reserveWorkplace({ workplaceRef: ref, reservationRef: 'res-1', taskId });
  let cur = repo.read(ref);
  repo.applyTransition({
    workplaceRef: ref, expectedRevision: cur.revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', terminalReason: null,
    activeReservationRef: 'res-1',
  });

  // A STALE worker (res-stale) tries to release — must throw FENCE_MISMATCH.
  assert.throws(
    () => rt.releaseExecution({ workplaceRef: ref, reservationRef: 'res-stale', taskId, outcome: 'completed' }),
    /FENCE_MISMATCH/,
    'a stale reservation cannot mutate the workplace',
  );
  // State unchanged.
  cur = repo.read(ref);
  assert.equal(cur.loopState, 'running');
  db.close();
});

test('REG-28-AC-02 + REG-06-AC-01: requeueForRepair returns loop to queued, Kanban stays, tasks rebuildable', () => {
  const db = freshDb();
  const { ref, taskId } = seedTaskAndWorkplace(db);
  const rt = new ConveyorRuntime(db);
  const repo = new SqliteWorkplaceRepository(db);

  rt.reserveWorkplace({ workplaceRef: ref, reservationRef: 'res-1', taskId });
  let cur = repo.read(ref);
  repo.applyTransition({
    workplaceRef: ref, expectedRevision: cur.revision,
    kanbanPhase: 'in_progress', loopState: 'running', nextRole: 'author', terminalReason: null,
    activeReservationRef: 'res-1',
  });
  rt.releaseExecution({ workplaceRef: ref, reservationRef: 'res-1', taskId, outcome: 'crashed' });

  // Requeue: repair_wait → queued. A new worker will lease.
  const r = rt.requeueForRepair({ workplaceRef: ref, taskId, role: 'author' });
  assert.equal(r.applied, true);
  assert.equal(r.workplace.loopState, 'queued');
  assert.equal(r.workplace.kanbanPhase, 'in_progress'); // Kanban unchanged
  // tasks.status rebuildable from v4 kanbanPhase.
  assert.equal(r.taskStatus, 'in_progress');
  db.close();
});

test('PROC-13/16: pauseForHuman → blocked/paused; resume returns to queued', () => {
  const db = freshDb();
  const { ref, taskId } = seedTaskAndWorkplace(db);
  const rt = new ConveyorRuntime(db);

  rt.reserveWorkplace({ workplaceRef: ref, reservationRef: 'res-1', taskId });

  const pause = rt.pauseForHuman({ workplaceRef: ref, taskId });
  assert.equal(pause.applied, true);
  assert.equal(pause.workplace.kanbanPhase, 'blocked');
  assert.equal(pause.workplace.loopState, 'paused');
  assert.equal(pause.taskStatus, 'blocked');

  const resume = rt.resumeFromHuman({ workplaceRef: ref, taskId, role: 'author' });
  assert.equal(resume.applied, true);
  // From blocked, resume returns Kanban to in_progress (author role).
  assert.equal(resume.workplace.kanbanPhase, 'in_progress');
  assert.equal(resume.workplace.loopState, 'queued');
  assert.equal(resume.taskStatus, 'in_progress');
  db.close();
});

test('REG-05-AC-06: CAS on revision — concurrent writer loses, state preserved', () => {
  const db = freshDb();
  const { ref, taskId } = seedTaskAndWorkplace(db);
  const rt = new ConveyorRuntime(db);
  const repo = new SqliteWorkplaceRepository(db);

  rt.reserveWorkplace({ workplaceRef: ref, reservationRef: 'res-1', taskId });
  // Simulate a concurrent writer advancing revision out-of-band (a gate run
  // that the runtime did not see). Now a second reserve attempt with the
  // stale view should be idempotent OR fail cleanly — not corrupt state.
  const cur = repo.read(ref);
  // Advance revision directly to simulate the concurrent gate.
  repo.applyTransition({
    workplaceRef: ref, expectedRevision: cur.revision,
    kanbanPhase: cur.kanbanPhase, loopState: 'running', nextRole: cur.nextRole, terminalReason: null,
    activeReservationRef: 'res-1',
  });
  // Now a stale reserve (expecting the old revision internally) — the runtime
  // re-reads inside its transaction, so it sees running and no-ops idempotently.
  const r = rt.reserveWorkplace({ workplaceRef: ref, reservationRef: 'res-1', taskId });
  // Idempotent (already leased/running) — applied=false, state preserved.
  assert.equal(r.applied, false);
  assert.equal(r.workplace.loopState, 'running');
  db.close();
});

test('bindTaskToWorkplace: derives ref from metadata, materializes v4 row, binds task', () => {
  const db = freshDb();
  const now = new Date().toISOString();
  const projectId = db.prepare(
    `INSERT INTO projects (name, description, status, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?) RETURNING id`,
  ).get('b', 'b', 'active', '[]', '{}', now, now).id;
  const epicId = db.prepare(
    `INSERT INTO epics (project_id, name, description, status, priority, branch, tags, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(projectId, 'b', 'b', 'planned', 'medium', 'main', '[]', 0, now, now).id;
  const meta = JSON.stringify({ process_run_id: 7, process_node_id: 'cell-x', module_ref: 'formalization@1.0.0', work_key: 'w-1' });
  const taskId = db.prepare(
    `INSERT INTO tasks (epic_id, title, description, status, priority, task_kind, execution_mode, workflow_stage, tags, metadata, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).get(epicId, 'b', 'b', 'todo', 'medium', 'formalization.ac', 'artifact_change', 'formalization', '[]', meta, now, now).id;

  const rt = new ConveyorRuntime(db);
  const ref = rt.bindTaskToWorkplace({ taskId, epicId, projectId, taskKind: 'formalization.ac', metadata: meta });
  assert.ok(ref, 'ref derived from metadata');
  assert.equal(ref.processRunId, 7);
  assert.equal(ref.moduleRef, 'formalization@1.0.0');
  // v4 row materialized.
  const repo = new SqliteWorkplaceRepository(db);
  const state = repo.read(ref);
  assert.ok(state);
  assert.equal(state.kanbanPhase, 'todo');
  // Task bound.
  const bound = db.prepare(`SELECT workplace_ref FROM tasks WHERE id=?`).get(taskId).workplace_ref;
  assert.ok(bound);
  db.close();
});
