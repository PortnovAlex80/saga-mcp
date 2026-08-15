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

function seedWorkplace(db, { ref, loopState, reservation, nextRole = 'author' }) {
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, revision, created_at, updated_at)
     VALUES (?, 1, 'm@1', 'cell', 'singleton', 'in_progress', ?, ?, 6,
             datetime('now'), datetime('now'))`,
  ).run(ref, loopState, nextRole);
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

function seedSpawnFailed(db, executionId) {
  // pid/started_at stay NULL: the process never existed (dispatch-time abort).
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
        launcher, state, phase, stuck_state)
     VALUES (?, 'run:1', 1, 1, 1, 'w:1', 'host', 'claude', 'spawn_failed', 'executing', 'active')`,
  ).run(executionId);
}

function seedTask(db, ref) {
  // ConveyorRuntime enables foreign_keys on the connection, so the full
  // tasks -> epics -> projects chain must exist for the projection UPDATE.
  db.prepare(
    `INSERT INTO projects (id, name) VALUES (1, 'p') ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'e') ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (epic_id, title, status, workplace_ref)
     VALUES (1, 't', 'in_progress', ?)`,
  ).run(ref);
}

test('adopted: terminal execution with accepted worker_done keeps its verifying reservation (contribution-author pointer)', () => {
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
    // The reservation is RETAINED: in verifying it is the durable pointer to
    // the contribution's author (executor: readActiveActors → contributorRef).
    // Nulling it makes the lifecycle fail with "verifying Workplace has no
    // producer reservation".
    assert.equal(wp.active_reservation_ref, exec);
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

test('idempotent: repeated adoption passes are no-ops on the DB', () => {
  const db = fresh();
  try {
    const ref = 'workplace/1/m@1/cell/singleton';
    const exec = 'worker-execution:dead-4';
    seedWorkplace(db, { ref, loopState: 'effect_pending', reservation: exec });
    seedExecution(db, { executionId: exec, state: 'exited' });
    seedReceipt(db, exec);

    assert.equal(adoptTerminalExecutionsAtEngineStart(db).adopted, 1);
    const second = adoptTerminalExecutionsAtEngineStart(db);
    // The receipt branch re-counts the pair (the reservation is deliberately
    // retained), but it performs no writes — repeated passes converge.
    assert.equal(second.adopted, 1);
    assert.equal(second.skippedNoReceipt, 0);
  } finally {
    db.close();
  }
});

test('spawn-failed hybrid (leased desk): paused for human, fence cleared, idempotent', () => {
  const db = fresh();
  try {
    const ref = 'workplace/1/m@1/cell/leased';
    const exec = 'worker-execution:never-spawned';
    seedWorkplace(db, { ref, loopState: 'leased', reservation: exec });
    seedSpawnFailed(db, exec);
    seedTask(db, ref);

    const result = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(result.spawnFailedRepaired.length, 1);
    assert.equal(result.spawnFailedRepaired[0].loopState, 'leased');

    const wp = db.prepare(
      'SELECT kanban_phase, loop_state, active_reservation_ref FROM factory_workplaces WHERE workplace_ref=?',
    ).get(ref);
    // The reducer's human-required edge has no source-state precondition — the
    // ONLY legal way out of a leased desk whose holder provably never started.
    // releaseExecution('crashed') would throw here (worker-crashed requires
    // running) and be silently swallowed, re-stranding the desk every restart.
    assert.equal(wp.loop_state, 'paused');
    assert.equal(wp.kanban_phase, 'blocked');
    assert.equal(wp.active_reservation_ref, null);

    const task = db.prepare('SELECT status FROM tasks WHERE workplace_ref=?').get(ref);
    assert.equal(task.status, 'blocked');

    // Idempotent: the desk left leased/running, so the second pass sees nothing.
    const second = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(second.spawnFailedRepaired.length, 0);
  } finally {
    db.close();
  }
});

test('spawn-failed hybrid (running desk): crashed to repair_wait, kanban preserved', () => {
  const db = fresh();
  try {
    const ref = 'workplace/1/m@1/cell/running';
    const exec = 'worker-execution:never-spawned-2';
    seedWorkplace(db, { ref, loopState: 'running', reservation: exec });
    seedSpawnFailed(db, exec);
    seedTask(db, ref);

    const result = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(result.spawnFailedRepaired.length, 1);
    assert.equal(result.spawnFailedRepaired[0].loopState, 'running');

    const wp = db.prepare(
      'SELECT kanban_phase, loop_state, active_reservation_ref FROM factory_workplaces WHERE workplace_ref=?',
    ).get(ref);
    // REG-28-AC-02: a crash moves the loop only — the kanban stage stays.
    assert.equal(wp.loop_state, 'repair_wait');
    assert.equal(wp.kanban_phase, 'in_progress');
    assert.equal(wp.active_reservation_ref, null);

    const task = db.prepare('SELECT status FROM tasks WHERE workplace_ref=?').get(ref);
    assert.equal(task.status, 'in_progress');
  } finally {
    db.close();
  }
});
