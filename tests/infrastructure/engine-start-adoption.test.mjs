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

function seedWorkplace(
  db,
  { ref, loopState, reservation, nextRole = 'author', kanbanPhase },
) {
  const phase = kanbanPhase
    ?? (nextRole === 'reviewer' ? 'review_in_progress' : 'in_progress');
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, revision, created_at, updated_at)
     VALUES (?, 1, 'm@1', 'cell', 'singleton', ?, ?, ?, 6,
             datetime('now'), datetime('now'))`,
  ).run(ref, phase, loopState, nextRole);
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

function seedTask(db, ref, role = 'author') {
  // ConveyorRuntime enables foreign_keys on the connection, so the full
  // tasks -> epics -> projects chain must exist for the projection UPDATE.
  // TASK-SHADOW F2 — the durable `$.role` metadata binding is part of the
  // seeded surface: the adoption pass resolves the CURRENT role's EXACT task
  // projection through it (never the newest row).
  db.prepare(
    `INSERT INTO projects (id, name) VALUES (1, 'p') ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'e') ON CONFLICT(id) DO NOTHING`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (epic_id, title, status, workplace_ref, metadata)
     VALUES (1, 't', 'in_progress', ?, ?)`,
  ).run(ref, JSON.stringify({ role }));
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

// ---------------------------------------------------------------------------
// TASK-SHADOW F2 — the retired newest-wins task reads. Both repair branches
// used `SELECT id FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1`;
// in a multi-task singleton workplace that binds the conveyor command to the
// REVIEWER's row while the workplace's repair target is the AUTHOR (and to a
// SUPERSEDED reviewer generation while the current generation is the target).
// These regressions pin the exact active-role/generation binding.
// ---------------------------------------------------------------------------

test('F2 regression: no-receipt repair targets the AUTHOR task when the newer reviewer rows shadow the desk', () => {
  const db = fresh();
  try {
    const ref = 'workplace/1/m@1/cell/shadowed-author';
    const exec = 'worker-execution:dead-no-receipt';
    seedWorkplace(db, { ref, loopState: 'verifying', reservation: exec, nextRole: 'author' });
    seedExecution(db, { executionId: exec, state: 'lost' });
    db.prepare(
      `INSERT INTO projects (id, name) VALUES (1, 'p') ON CONFLICT(id) DO NOTHING`,
    ).run();
    db.prepare(
      `INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'e') ON CONFLICT(id) DO NOTHING`,
    ).run();
    // The desk history: author task (oldest, pre-claim 'todo') + TWO reviewer
    // generations (subjects A and B — a legal second review round). The
    // newest row is a reviewer card, NOT the repair target.
    db.prepare(
      `INSERT INTO tasks (epic_id, title, status, workplace_ref, metadata)
       VALUES (1, 'author', 'todo', ?, ?)`,
    ).run(ref, JSON.stringify({ role: 'author' }));
    const authorTaskId = db.prepare('SELECT id FROM tasks WHERE workplace_ref=?').get(ref).id;
    db.prepare(
      `INSERT INTO tasks (epic_id, title, status, workplace_ref, metadata)
       VALUES (1, 'rev-1', 'done', ?, ?), (1, 'rev-2', 'review_in_progress', ?, ?)`,
    ).run(
      ref, JSON.stringify({ role: 'reviewer', subject_candidate_set_ref: 'cs:a' }),
      ref, JSON.stringify({ role: 'reviewer', subject_candidate_set_ref: 'cs:b' }),
    );
    const newestRow = db.prepare(
      'SELECT id FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1',
    ).get(ref);
    assert.ok(newestRow.id > authorTaskId, 'the newest row is a reviewer card');

    const result = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(result.repaired.length, 1);
    assert.equal(result.skippedNoReceipt, 0);

    // The repair landed on the AUTHOR card (todo → in_progress through the
    // reverse projection); the reviewer cards keep their statuses. Under the
    // retired newest-wins read the NEWEST reviewer card would have been
    // rewritten to in_progress and the author card stranded in todo.
    const statuses = db.prepare(
      "SELECT json_extract(metadata,'$.role') AS role, status FROM tasks WHERE workplace_ref=? ORDER BY id",
    ).all(ref);
    assert.equal(statuses[0].role, 'author');
    assert.equal(statuses[0].status, 'in_progress',
      'the AUTHOR card received the repair projection');
    assert.equal(statuses[1].status, 'done', 'superseded reviewer untouched');
    assert.equal(statuses[2].status, 'review_in_progress',
      'the newest reviewer card was NOT retargeted');
  } finally {
    db.close();
  }
});

test('F2 regression: no-receipt repair with NO exact role binding skips honestly (no newest-row fallback)', () => {
  const db = fresh();
  try {
    const ref = 'workplace/1/m@1/cell/no-binding';
    const exec = 'worker-execution:dead-no-binding';
    seedWorkplace(db, { ref, loopState: 'verifying', reservation: exec, nextRole: 'author' });
    seedExecution(db, { executionId: exec, state: 'lost' });
    // A neighbor card WITHOUT the durable $.role binding: the retired read
    // picked it silently; the exact read resolves absence and skips.
    db.prepare(
      `INSERT INTO projects (id, name) VALUES (1, 'p') ON CONFLICT(id) DO NOTHING`,
    ).run();
    db.prepare(
      `INSERT INTO epics (id, project_id, name) VALUES (1, 1, 'e') ON CONFLICT(id) DO NOTHING`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (epic_id, title, status, workplace_ref, metadata)
       VALUES (1, 'unbound', 'in_progress', ?, '{}')`,
    ).run(ref);

    const result = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(result.repaired.length, 0);
    assert.equal(result.skippedNoReceipt, 1);
    const task = db.prepare('SELECT status FROM tasks WHERE workplace_ref=?').get(ref);
    assert.equal(task.status, 'in_progress', 'the unbound neighbor row is untouched');
  } finally {
    db.close();
  }
});

test('F2 regression: spawn-failed reviewer repair binds the CURRENT generation, not the superseded newest-ambiguous set', () => {
  const db = fresh();
  try {
    const ref = 'workplace/1/m@1/cell/reviewer-gen';
    const exec = 'worker-execution:never-spawned-rev';
    seedWorkplace(db, { ref, loopState: 'running', reservation: exec, nextRole: 'reviewer' });
    seedSpawnFailed(db, exec);
    seedTask(db, ref, 'author');
    // Two reviewer generations; the CURRENT one is the head-bound subject
    // 'cs:current' (minted first here — the head decides, not row order). Its
    // card sits in the reviewer buffer ('review'); the superseded generation
    // is the NEWEST row.
    db.prepare(
      `INSERT INTO tasks (epic_id, title, status, workplace_ref, metadata)
       VALUES (1, 'rev-current', 'review', ?, ?), (1, 'rev-superseded', 'done', ?, ?)`,
    ).run(
      ref, JSON.stringify({ role: 'reviewer', subject_candidate_set_ref: 'cs:current' }),
      ref, JSON.stringify({ role: 'reviewer', subject_candidate_set_ref: 'cs:old' }),
    );
    const currentId = db.prepare(
      "SELECT id FROM tasks WHERE workplace_ref=? AND json_extract(metadata,'$.subject_candidate_set_ref')='cs:current'",
    ).get(ref).id;
    const newestId = db.prepare(
      'SELECT id FROM tasks WHERE workplace_ref=? ORDER BY id DESC LIMIT 1',
    ).get(ref).id;
    assert.notEqual(currentId, newestId, 'the CURRENT generation is deliberately NOT the newest row');
    db.prepare(
      `INSERT INTO factory_accepted_authority_head
         (workplace_ref, accepted_author_candidate_set_ref,
          accepted_author_gate_decision_key, revision, recorded_at)
       VALUES (?, 'cs:current', 'gate:decision:current', 1, datetime('now'))`,
    ).run(ref);

    const result = adoptTerminalExecutionsAtEngineStart(db);
    assert.equal(result.spawnFailedRepaired.length, 1);

    // releaseExecution('crashed') moved the loop and reverse-projected the
    // CURRENT reviewer generation's card (review → review_in_progress, the
    // workplace's kanban phase); the superseded card keeps its 'done'.
    // Under the retired newest-wins read the SUPERSEDED (newest) row would
    // have received the projection instead.
    const statuses = db.prepare(
      `SELECT json_extract(metadata,'$.subject_candidate_set_ref') AS subject, status
         FROM tasks WHERE workplace_ref=? ORDER BY id`,
    ).all(ref);
    const bySubject = new Map(statuses.map(row => [row.subject, row.status]));
    assert.equal(bySubject.get('cs:current'), 'review_in_progress',
      'the CURRENT generation received the repair projection');
    assert.equal(bySubject.get('cs:old'), 'done',
      'the superseded (newest) reviewer card was NOT retargeted');
  } finally {
    db.close();
  }
});
