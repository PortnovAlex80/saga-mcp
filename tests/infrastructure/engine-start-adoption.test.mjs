import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { adoptTerminalExecutionsAtEngineStart } from
  '../../dist/app/engine-start-adoption.js';

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function seedWorkplace(db, { ref, loopState, reservation }) {
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, revision, created_at, updated_at)
     VALUES (?, 1, 'm@1', 'cell', 'singleton', 'in_progress', ?, 'reviewer', 6,
             datetime('now'), datetime('now'))`,
  ).run(ref, loopState);
  if (reservation) {
    db.prepare('UPDATE factory_workplaces SET active_reservation_ref=? WHERE workplace_ref=?')
      .run(reservation, ref);
  }
}

function seedExecution(db, { executionId, state, stuck = 'active' }) {
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
        launcher, state, phase, started_at, stuck_state)
     VALUES (?, 'run:1', 1, 1, 1, 'w:1', 'host', 'claude', ?, 'executing',
             datetime('now'), ?)`,
  ).run(executionId, state, stuck);
}

function seedReceipt(db, executionId) {
  db.prepare(
    `INSERT INTO command_receipts
       (execution_id, command_id, command_kind, actor_kind, payload_hash, accepted, reply_json, accepted_at)
     VALUES (?, 'cmd:1', 'worker_done', 'managed_execution', 'h', 1, '{}', datetime('now'))`,
  ).run(executionId);
}

test('adopted: terminal execution with accepted worker_done loses its stale verifying reservation', () => {
  const db = fresh();
  try {
    const ref = 'workplace/1/m@1/cell/singleton';
    const exec = 'worker-execution:dead-1';
    seedWorkplace(db, { ref, loopState: 'verifying', reservation: exec });
    seedExecution(db, { executionId: exec, state: 'exited' });
    seedReceipt(db, exec);

    const result = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(result.adopted, 1);
    assert.equal(result.skippedNoReceipt, 0);

    const wp = db.prepare('SELECT loop_state, active_reservation_ref FROM factory_workplaces WHERE workplace_ref=?').get(ref);
    // Kernel-owned state preserved: the idempotent verifying re-drive continues.
    assert.equal(wp.loop_state, 'verifying');
  } finally {
    db.close();
  }
});

test('not adopted: terminal execution without worker_done receipt is left untouched', () => {
  const db = fresh();
  try {
    const ref = 'workplace/1/m@1/cell/singleton';
    const exec = 'worker-execution:dead-2';
    seedWorkplace(db, { ref, loopState: 'verifying', reservation: exec });
    seedExecution(db, { executionId: exec, state: 'lost' });

    const result = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(result.adopted, 0);
    assert.equal(result.skippedNoReceipt, 1);

    const wp = db.prepare('SELECT active_reservation_ref FROM factory_workplaces WHERE workplace_ref=?').get(ref);
    assert.equal(wp.active_reservation_ref, exec);
  } finally {
    db.close();
  }
});

test('ignored: live (running) reservation holder and non-kernel workplaces are invisible', () => {
  const db = fresh();
  try {
    seedWorkplace(db, {
      ref: 'workplace/1/m@1/cell/a',
      loopState: 'verifying',
      reservation: 'worker-execution:alive',
    });
    seedExecution(db, { executionId: 'worker-execution:alive', state: 'running' });

    seedWorkplace(db, {
      ref: 'workplace/1/m@1/cell/b',
      loopState: 'running',
      reservation: 'worker-execution:dead-3',
    });
    seedExecution(db, { executionId: 'worker-execution:dead-3', state: 'exited' });
    seedReceipt(db, 'worker-execution:dead-3');

    const result = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(result.adopted, 0);
    assert.equal(result.skippedNoReceipt, 0);
  } finally {
    db.close();
  }
});

test('idempotent: second adoption pass is a no-op', () => {
  const db = fresh();
  try {
    const ref = 'workplace/1/m@1/cell/singleton';
    const exec = 'worker-execution:dead-4';
    seedWorkplace(db, { ref, loopState: 'effect_pending', reservation: exec });
    seedExecution(db, { executionId: exec, state: 'exited' });
    seedReceipt(db, exec);

    assert.equal(adoptTerminalExecutionsAtEngineStart(db).adopted, 1);
    const second = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(second.adopted, 0);
    assert.equal(second.skippedNoReceipt, 0);
  } finally {
    db.close();
  }
});
