import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryLifecycleRunSchema } from '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { runFactoryBootRevision } from '../../dist/app/factory-boot-revision.js';

// The reaper checks PID liveness via process.kill(pid, 0). We inject a fake
// probe that reports a controlled set of "alive" PIDs so tests don't depend
// on real OS processes.
function fakeProbe(alivePids = new Set()) {
  return {
    isAlive: pid => alivePids.has(pid),
    readBirthToken: () => 'test-birth-token',
    killVerified: () => true,
  };
}

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryLifecycleRunSchema(db);
  ensureFactoryProcessRunSchema(db);
  db.prepare("INSERT INTO projects (id, name) VALUES (1, 'p')").run();
  db.prepare("INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'e')").run();
  db.prepare(`
    INSERT INTO factory_process_runs
      (id, project_id, epic_id, module_name, module_version, module_ref_key,
       idempotency_key, executor_kind, input_schema, input_snapshot, input_hash, status)
    VALUES (1, 1, 1, 'm', '1', 'm@1', 'k', 'generic-flow', 's', '{}', 'h', 'running')
  `).run();
  return db;
}

function seedWorkplace(db, { ref, loop, kanban, reservation, role = 'author' }) {
  db.prepare(`
    INSERT INTO factory_workplaces
      (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
       kanban_phase, loop_state, next_role, revision, active_reservation_ref)
    VALUES (?, 1, 'm@1', 'cell', 'singleton', ?, ?, ?, 5, ?)
  `).run(ref, kanban, loop, role, reservation);
}

function seedExecution(db, { id, state, pid = null, stuck = 'active', task = 1 }) {
  db.prepare(`
    INSERT INTO worker_executions
      (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
       state, phase, pid, process_birth_token, started_at, stuck_state, lease_expires_at)
    VALUES (?, 'r', 1, 1, ?, 'w', 'test-host', ?, 'executing', ?, 'test-birth-token',
            datetime('now', '-5 minutes'), ?, datetime('now', '-1 minute'))
  `).run(id, task, state, pid, stuck);
}

function seedTask(db, { id, status, workplaceRef }) {
  db.prepare(`
    INSERT INTO tasks (id, epic_id, title, status, workplace_ref, current_execution_id)
    VALUES (?, 1, 't', ?, ?, NULL)
  `).run(id, status, workplaceRef);
}

test('dead worker (running, stale pid) → swept to lost', () => {
  const db = fresh();
  seedWorkplace(db, { ref: 'workplace/1/m@1/cell/a', loop: 'running', kanban: 'in_progress', reservation: 'we:dead' });
  seedExecution(db, { id: 'we:dead', state: 'running', pid: 999999, task: 1 });
  seedTask(db, { id: 1, status: 'in_progress', workplaceRef: 'workplace/1/m@1/cell/a', executionId: 'we:dead' });

  const result = runFactoryBootRevision(db, { hostname: 'test-host' });
  assert.equal(result.swept.length, 1, 'one dead worker swept');
  assert.equal(result.swept[0].action, 'lost');

  const exec = db.prepare("SELECT state FROM worker_executions WHERE execution_id='we:dead'").get();
  assert.equal(exec.state, 'lost', 'execution terminalized');

  const wp = db.prepare("SELECT loop_state FROM factory_workplaces WHERE workplace_ref='workplace/1/m@1/cell/a'").get();
  assert.equal(wp.loop_state, 'repair_wait', 'workplace moved to repair_wait (hire buffer)');

  const task = db.prepare('SELECT status, current_execution_id FROM tasks WHERE id=1').get();
  assert.equal(task.status, 'in_progress', 'Kanban phase preserved (REG-28-AC-02)');
  assert.equal(task.current_execution_id, null, 'task fence cleared');
  db.close();
});

test('live worker (running, alive pid, future lease) → untouched', () => {
  const db = fresh();
  const realPid = process.pid; // this test process is definitely alive
  seedWorkplace(db, { ref: 'workplace/1/m@1/cell/b', loop: 'running', kanban: 'in_progress', reservation: 'we:alive' });
  seedExecution(db, { id: 'we:alive', state: 'running', pid: realPid, task: 2 });
  // Remote-lease: push the expiry to the future so the reaper's remote check
  // sees a valid lease and KEEPs the worker
  db.prepare("UPDATE worker_executions SET lease_expires_at=datetime('now','+5 minutes') WHERE execution_id='we:alive'").run();
  seedTask(db, { id: 2, status: 'in_progress', workplaceRef: 'workplace/1/m@1/cell/b', executionId: 'we:alive' });

  const result = runFactoryBootRevision(db, { hostname: 'test-host' });
  const sweptThis = result.swept.filter(s => s.executionId === 'we:alive');
  assert.equal(sweptThis.length, 0, 'live worker NOT swept');

  const exec = db.prepare("SELECT state FROM worker_executions WHERE execution_id='we:alive'").get();
  assert.equal(exec.state, 'running', 'execution untouched');
  db.close();
});

test('verifying with accepted receipt → NOT swept (adoption owns it)', () => {
  const db = fresh();
  seedWorkplace(db, { ref: 'workplace/1/m@1/cell/c', loop: 'verifying', kanban: 'in_progress', reservation: 'we:sealed' });
  seedExecution(db, { id: 'we:sealed', state: 'exited', pid: 999998, stuck: 'active', task: 3 });
  seedTask(db, { id: 3, status: 'in_progress', workplaceRef: 'workplace/1/m@1/cell/c' });
  db.prepare(`
    INSERT INTO command_receipts (execution_id, command_id, command_kind, actor_kind, payload_hash, accepted, reply_json)
    VALUES ('we:sealed', 'cmd:1', 'worker_done', 'managed_execution', 'h', 1, '{}')
  `).run();

  const result = runFactoryBootRevision(db, { hostname: 'test-host' });
  const sweptThis = result.swept.filter(s => s.executionId === 'we:sealed');
  assert.equal(sweptThis.length, 0, 'verifying with receipt NOT in reaper scope');

  const wp = db.prepare("SELECT loop_state FROM factory_workplaces WHERE workplace_ref='workplace/1/m@1/cell/c'").get();
  assert.equal(wp.loop_state, 'verifying', 'kernel-owned state preserved for adoption');
  db.close();
});

test('idempotent: second boot revision finds 0 rows to sweep', () => {
  const db = fresh();
  seedWorkplace(db, { ref: 'workplace/1/m@1/cell/d', loop: 'running', kanban: 'in_progress', reservation: 'we:dead2' });
  seedExecution(db, { id: 'we:dead2', state: 'running', pid: 999997, task: 4 });
  seedTask(db, { id: 4, status: 'in_progress', workplaceRef: 'workplace/1/m@1/cell/d', executionId: 'we:dead2' });

  const first = runFactoryBootRevision(db, { hostname: 'test-host' });
  assert.ok(first.swept.length > 0, 'first sweep finds the dead worker');

  const second = runFactoryBootRevision(db, { hostname: 'test-host' });
  assert.equal(second.swept.length, 0, 'second sweep is a no-op');
  db.close();
});

test('reviewer death preserves review_in_progress and next_role=reviewer', () => {
  const db = fresh();
  seedWorkplace(db, { ref: 'workplace/1/m@1/cell/e', loop: 'running', kanban: 'review_in_progress', reservation: 'we:rev-dead', role: 'reviewer' });
  seedExecution(db, { id: 'we:rev-dead', state: 'running', pid: 999996, task: 5 });
  seedTask(db, { id: 5, status: 'review_in_progress', workplaceRef: 'workplace/1/m@1/cell/e', executionId: 'we:rev-dead' });

  const result = runFactoryBootRevision(db, { hostname: 'test-host' });
  assert.ok(result.swept.length > 0);

  const wp = db.prepare("SELECT kanban_phase, loop_state, next_role FROM factory_workplaces WHERE workplace_ref='workplace/1/m@1/cell/e'").get();
  assert.equal(wp.kanban_phase, 'review_in_progress', 'reviewer Kanban preserved');
  assert.equal(wp.loop_state, 'repair_wait', 'reviewer loop in repair_wait');
  assert.equal(wp.next_role, 'reviewer', 'next hire is a reviewer, not re-authoring');
  db.close();
});
