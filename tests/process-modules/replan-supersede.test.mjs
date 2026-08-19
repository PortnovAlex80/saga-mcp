// tests/process-modules/replan-supersede.test.mjs
//
// RE-PLAN CYCLE (REPLAN-CYCLE-TZ §5) — superseding the un-raised cycle-1
// tasks at cycle-2 start, unit T6 of 9. The cycle-1 graph is immutable by
// (process_run_id, module, cell); cycle 2 is a NEW process run, so the new
// graph cannot conflict. The remaining cycle-1 tasks (not yet terminal) must
// be drained HONESTLY at the moment cycle 2 starts:
//   - tasks: metadata.$.superseded_by = <cycle2RunId>, card → cancelled
//   - workplace projections: kanban → cancelled, loop → terminal/cancelled
// Accepted (done) cycle-1 work is NEVER touched — it carries forward as the
// git baseline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { supersedeRemainingCycleTasks } from '../../dist/modules/development/application/replan-supersede.js';

const CYCLE1_RUN = 7;
const CYCLE2_RUN = 9;

function hermeticDb() {
  const dir = mkdtempSync(join(tmpdir(), 'replan-supersede-'));
  const db = new Database(join(dir, 'supersede.sqlite'));
  db.exec(SCHEMA_SQL);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedCycleOne(db) {
  db.prepare('INSERT INTO projects (name) VALUES (?)').run('supersede-test');
  db.prepare('INSERT INTO epics (id, project_id, name) VALUES (1, 1, ?)').run('supersede-test');
  const insertWorkplace = db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref, process_run_id, module_ref, production_cell_id, work_key,
        kanban_phase, loop_state, next_role, terminal_reason)
     VALUES (?, ?, 'solution-development@1.0.0', 'development-implementation', ?, ?, ?, 'author', ?)`,
  );
  const insertTask = db.prepare(
    `INSERT INTO tasks (epic_id, title, status, workplace_ref, metadata)
     VALUES (1, ?, ?, ?, ?)`,
  );
  // impl-physics-core closed (accepted); impl-shared-engine waits in todo;
  // impl-ui-shell sits in review.
  const rows = [
    { key: 'impl-physics-core', kanban: 'done', loop: 'terminal', reason: 'accepted', status: 'done' },
    { key: 'impl-shared-engine', kanban: 'todo', loop: 'queued', reason: null, status: 'todo' },
    { key: 'impl-ui-shell', kanban: 'review', loop: 'verifying', reason: null, status: 'review' },
  ];
  for (const row of rows) {
    const workplaceRef = `workplace/${CYCLE1_RUN}/solution-development@1.0.0/development-implementation/${row.key}`;
    insertWorkplace.run(
      workplaceRef, CYCLE1_RUN, row.key, row.kanban, row.loop, row.reason,
    );
    insertTask.run(
      `${row.key} (author)`, row.status, workplaceRef, JSON.stringify({ role: 'author' }),
    );
  }
}

function readState(db, key) {
  const workplaceRef = `workplace/${CYCLE1_RUN}/solution-development@1.0.0/development-implementation/${key}`;
  const task = db.prepare('SELECT id,status,metadata FROM tasks WHERE workplace_ref=?').get(workplaceRef);
  const workplace = db.prepare(
    'SELECT kanban_phase, loop_state, terminal_reason FROM factory_workplaces WHERE workplace_ref=?',
  ).get(workplaceRef);
  return { task, workplace };
}

test('T6 RED: supersedeRemainingCycleTasks cancels remaining cycle-1 tasks + drains projections, never accepted work', () => {
  const { db, cleanup } = hermeticDb();
  try {
    seedCycleOne(db);
    const drained = supersedeRemainingCycleTasks(db, {
      cycle1ProcessRunId: CYCLE1_RUN,
      cycle2RunId: CYCLE2_RUN,
    });
    assert.equal(drained.supersededTaskIds.length, 2,
      'exactly the two un-raised tasks are superseded');

    // The accepted item carries forward untouched (git baseline).
    const physics = readState(db, 'impl-physics-core');
    assert.equal(physics.task.status, 'done');
    assert.equal(physics.workplace.loop_state, 'terminal');
    assert.equal(physics.workplace.terminal_reason, 'accepted');

    // The remaining tasks: superseded_by + cancelled card.
    for (const key of ['impl-shared-engine', 'impl-ui-shell']) {
      const state = readState(db, key);
      assert.equal(state.task.status, 'cancelled',
        `${key}: the card is cancelled`);
      assert.equal(JSON.parse(state.task.metadata).superseded_by, String(CYCLE2_RUN),
        `${key}: metadata.$.superseded_by names the cycle-2 run`);
      assert.equal(state.workplace.kanban_phase, 'cancelled',
        `${key}: the workplace projection is drained`);
      assert.equal(state.workplace.loop_state, 'terminal');
      assert.equal(state.workplace.terminal_reason, 'cancelled');
    }

    // Idempotent: a replay of the cycle-2 start supersedes nothing new.
    const replay = supersedeRemainingCycleTasks(db, {
      cycle1ProcessRunId: CYCLE1_RUN,
      cycle2RunId: CYCLE2_RUN,
    });
    assert.equal(replay.supersededTaskIds.length, 0,
      'a replay drains nothing — everything remaining is already terminal');
  } finally {
    cleanup();
  }
});
