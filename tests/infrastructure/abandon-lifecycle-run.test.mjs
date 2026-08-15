import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryLifecycleRunSchema } from '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';
import { abandonLifecycleRun } from '../../dist/app/factory-start.js';

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryLifecycleRunSchema(db);
  db.prepare("INSERT INTO projects (id, name) VALUES (1, 'p')").run();
  db.prepare("INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'e')").run();
  db.prepare(`INSERT INTO factory_lifecycle_runs
    (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name, description,
     definition_snapshot, definition_hash, project_id, epic_id, initiated_by, idempotency_key,
     input_schema, input_snapshot, input_hash, status, entry_stage_id)
    VALUES (5, 'l', '1', 'k', 'd', 'd', '{}', 'h', 1, 1, 't', 'k1', 's', '{}', 'h', 'paused', 'stage')`).run();
  return db;
}

test('refuses: active workers keep the run alive', () => {
  const db = fresh();
  db.prepare(`INSERT INTO worker_executions
    (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase)
    VALUES ('we:1', 'r', 1, 1, 1, 'w', 'm', 'running', 'executing')`).run();
  assert.throws(() => abandonLifecycleRun(db, { projectId: 1, actorId: 'op', reason: 'r' }),
    /lifecycle 5 still has 1 active worker/);
  const lr = db.prepare('SELECT status FROM factory_lifecycle_runs WHERE id=5').get();
  assert.equal(lr.status, 'paused', 'run untouched after refusal');
  db.close();
});

test('refuses: open human request', () => {
  const db = fresh();
  db.prepare(`INSERT INTO tasks (epic_id, title, status) VALUES (1, 't', 'blocked')`).run();
  db.prepare(`INSERT INTO human_requests (request_id, task_id, resume_phase, question, state)
    VALUES ('hr:1', 1, 'implementation', 'q?', 'open')`).run();
  assert.throws(() => abandonLifecycleRun(db, { projectId: 1, actorId: 'op', reason: 'r' }),
    /open human request/);
  db.close();
});

test('refuses: live controller lease', () => {
  const db = fresh();
  db.prepare(`INSERT INTO factory_orders (order_ref, project_id, epic_id, source_kind, state)
    VALUES ('o:1', 1, 1, 'existing_project', 'running')`).run();
  db.prepare(`INSERT INTO factory_launch_requests
    (launch_ref, order_ref, mode, project_id, epic_id, initiated_by, idempotency_key, concurrency, state)
    VALUES ('l:1', 'o:1', 'new', 1, 1, 't', 'k', 1, 'running')`).run();
  db.prepare(`INSERT INTO factory_launch_controller_terms
    (term_ref, launch_ref, epoch, holder_id, machine_id, process_id, token_digest, takeover_reason, acquired_at)
    VALUES ('t:1', 'l:1', 1, 'h', 'm', 1, 'd', 'initial', datetime('now'))`).run();
  db.prepare(`INSERT INTO factory_launch_controller_leases
    (launch_ref, current_term_ref, epoch, token_digest, heartbeat_at, expires_at)
    VALUES ('l:1', 't:1', 1, 'd', datetime('now'), datetime('now', '+30 seconds'))`).run();
  assert.throws(() => abandonLifecycleRun(db, { projectId: 1, actorId: 'op', reason: 'r' }),
    /live controller lease/);
  db.close();
});

test('abandons: paused poisoned run goes terminally failed + burial cascade runs', () => {
  const db = fresh();
  // poisoned residue: a kernel-owned workplace stuck verifying with a dead
  // reservation holder, an open obligation, and a phantom in-flight task.
  db.prepare(`INSERT INTO factory_process_runs
    (id, project_id, epic_id, module_name, module_version, module_ref_key, idempotency_key,
     executor_kind, projected_stage, input_schema, input_snapshot, input_hash, status)
    VALUES (9, 1, 1, 'm', '1', 'm@1', 'k9', 'generic-flow', 'stage', 'sch', '{}', 'h', 'paused')`).run();
  db.prepare(`INSERT INTO factory_stage_runs
    (lifecycle_run_id, ordinal, stage_id, attempt, module_name, module_version, module_ref_key,
     binding_snapshot, binding_hash, input_schema, input_snapshot, input_hash, status, process_run_id)
    VALUES (5, 0, 's', 1, 'm', '1', 'k', '{}', 'bh', 'sch', '{}', 'h', 'paused', 9)`).run();
  db.prepare(`INSERT INTO factory_workplaces
    (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
     kanban_phase, loop_state, next_role, revision, active_reservation_ref)
    VALUES ('workplace/9/m@1/cell/singleton', 9, 'm@1', 'cell', 'singleton',
            'in_progress', 'verifying', 'author', 6, 'we:dead')`).run();
  db.prepare(`INSERT INTO factory_transition_obligations
    (obligation_key, source_kind, source_ref, source_digest, subject_ref, handoff_kind, owner_capability, fence, state)
    VALUES ('obl:1', 'candidate-set-sealed', 'cs:1', 'd', 'workplace/9/m@1/cell/singleton',
            'run-gate', 'gate-run-driver', 1, 'pending')`).run();
  db.prepare(`INSERT INTO worker_executions
    (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id, state, phase)
    VALUES ('we:dead', 'r', 1, 1, 1, 'w', 'm', 'exited', 'executing')`).run();
  db.prepare(`INSERT INTO tasks (epic_id, title, status, workplace_ref)
    VALUES (1, 'phantom', 'in_progress', 'workplace/9/m@1/cell/singleton')`).run();

  const result = abandonLifecycleRun(db, { projectId: 1, actorId: 'op', reason: 'poisoned' });
  assert.equal(result.alreadyTerminal, false);
  assert.equal(result.lifecycleRunId, 5);

  const lr = db.prepare('SELECT status, terminal_status, error FROM factory_lifecycle_runs WHERE id=5').get();
  assert.equal(lr.status, 'failed');
  assert.equal(lr.terminal_status, 'failed');
  assert.match(lr.error, /LIFECYCLE_ABANDONED: actor=op; reason=poisoned/);

  assert.equal(result.burial.buried, 1, 'open obligation abandoned');
  assert.equal(result.burial.workplacesReleased, 1, 'kernel workplace released');
  assert.equal(result.burial.tasksCancelled, 1, 'phantom task cancelled');
  const wp = db.prepare('SELECT kanban_phase, loop_state FROM factory_workplaces WHERE workplace_ref=?')
    .get('workplace/9/m@1/cell/singleton');
  assert.equal(wp.loop_state, 'terminal');
  assert.equal(wp.kanban_phase, 'failed');
  db.close();
});

test('idempotent: abandoning an already-terminal run is a no-op that still buries', () => {
  const db = fresh();
  db.prepare("UPDATE factory_lifecycle_runs SET status='failed', terminal_status='failed' WHERE id=5").run();
  const again = abandonLifecycleRun(db, { projectId: 1, actorId: 'op', reason: 'again' });
  assert.equal(again.alreadyTerminal, true);
  assert.equal(again.lifecycleRunId, 5);
  db.close();
});
