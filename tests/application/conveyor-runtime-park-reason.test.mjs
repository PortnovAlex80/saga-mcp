// Worker feedback loop map, Fix-1: «парк всегда с причиной».
//
// pauseForHuman accepts an optional reason; when present it is recorded as an
// append-only factory_workplace_park_reasons row IN THE SAME transaction as
// the blocked/paused transition, and factory_workplaces.active_recovery_case_ref
// points at it. A paused workplace must never exist without its reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ConveyorRuntime } from '../../dist/application/conveyor-runtime.js';

const SERIALIZED = 'workplace/1/m@1/cell/singleton';
const WREF = { processRunId: 1, moduleRef: 'm@1', productionCellId: 'cell', workKey: 'singleton' };

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT INTO projects (id, name, status) VALUES (1, 'p', 'active')`).run();
  db.prepare(`INSERT INTO epics (id, project_id, name, status, priority) VALUES (1, 1, 'e', 'planned', 'high')`).run();
  db.prepare(`INSERT INTO tasks (id, epic_id, title, status) VALUES (5, 1, 't', 'in_progress')`).run();
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, revision, created_at, updated_at)
     VALUES (?, 1, 'm@1', 'cell', 'singleton', 'in_progress', 'queued', 'author', 0,
             datetime('now'), datetime('now'))`,
  ).run(SERIALIZED);
  return db;
}

test('pauseForHuman with a reason records an append-only park reason atomically', () => {
  const db = makeDb();
  const runtime = new ConveyorRuntime(db);
  const result = runtime.pauseForHuman({
    workplaceRef: WREF,
    taskId: 5,
    reason: {
      code: 'WORKER_SPAWN_FAILED',
      message: 'Claude binary missing from PATH',
      evidenceRefs: ['worker-execution:abc'],
    },
  });
  assert.equal(result.applied, true);
  assert.equal(result.workplace.loopState, 'paused');
  assert.equal(result.workplace.kanbanPhase, 'blocked');

  const reasons = db.prepare(
    'SELECT id,reason_code,message,evidence_refs FROM factory_workplace_park_reasons WHERE workplace_ref=?',
  ).all(SERIALIZED);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].reason_code, 'WORKER_SPAWN_FAILED');
  assert.equal(reasons[0].message, 'Claude binary missing from PATH');
  assert.deepEqual(JSON.parse(reasons[0].evidence_refs), ['worker-execution:abc']);

  const workplace = db.prepare(
    'SELECT active_recovery_case_ref FROM factory_workplaces WHERE workplace_ref=?',
  ).get(SERIALIZED);
  assert.equal(workplace.active_recovery_case_ref, `workplace-park-reason:${reasons[0].id}`);

  // The reverse projection still lands on the task row.
  assert.equal(
    db.prepare('SELECT status FROM tasks WHERE id=5').get().status,
    'blocked',
  );
  db.close();
});

test('pauseForHuman without a reason keeps the historical behaviour (no row, no pointer)', () => {
  const db = makeDb();
  const runtime = new ConveyorRuntime(db);
  const result = runtime.pauseForHuman({ workplaceRef: WREF, taskId: 5 });
  assert.equal(result.applied, true);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_park_reasons').get().n,
    0,
  );
  db.close();
});

test('a repeated park appends another reason row (append-only audit)', () => {
  const db = makeDb();
  const runtime = new ConveyorRuntime(db);
  runtime.pauseForHuman({
    workplaceRef: WREF,
    taskId: 5,
    reason: { code: 'FIRST_PARK', message: 'first' },
  });
  // Resume to queued, then park again with a different cause.
  runtime.resumeFromHuman({ workplaceRef: WREF, taskId: 5, role: 'author' });
  runtime.pauseForHuman({
    workplaceRef: WREF,
    taskId: 5,
    reason: { code: 'SECOND_PARK', message: 'second' },
  });
  const rows = db.prepare(
    'SELECT reason_code FROM factory_workplace_park_reasons WHERE workplace_ref=? ORDER BY id',
  ).all(SERIALIZED);
  assert.deepEqual(rows.map(row => row.reason_code), ['FIRST_PARK', 'SECOND_PARK']);
  const latest = db.prepare(
    'SELECT active_recovery_case_ref FROM factory_workplaces WHERE workplace_ref=?',
  ).get(SERIALIZED);
  const secondId = db.prepare(
    'SELECT id FROM factory_workplace_park_reasons WHERE reason_code=?',
  ).get('SECOND_PARK').id;
  assert.equal(latest.active_recovery_case_ref, `workplace-park-reason:${secondId}`);
  db.close();
});

test('an invalid park reason fails closed before any write', () => {
  const db = makeDb();
  const runtime = new ConveyorRuntime(db);
  assert.throws(
    () => runtime.pauseForHuman({
      workplaceRef: WREF,
      taskId: 5,
      reason: { code: '  ', message: 'whitespace code' },
    }),
    /WORKPLACE_PARK_REASON_INVALID/,
  );
  assert.equal(db.prepare('SELECT loop_state FROM factory_workplaces WHERE workplace_ref=?').get(SERIALIZED).loop_state, 'queued',
    'no transition was applied');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_workplace_park_reasons').get().n, 0,
    'no reason row leaked');
  db.close();
});
