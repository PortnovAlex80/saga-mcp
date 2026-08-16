// tests/app/operator-unpark-workplace.test.mjs
//
// Operator UNPARK of budget-exhaustion parks: the canonical repair-requeued
// transition (blocked/paused → queued, Kanban back to the role's active phase
// per REG-28-AC-02) applied to every parked workplace in scope, plus CLI
// wiring. Verified live first on P01 counter and P02 stopwatch (manual CAS),
// then productized here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { unparkWorkplaces } from '../../dist/app/operator-soft-stop.js';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-unpark-'));

function seedDb() {
  const db = new Database(path.join(temp, `unpark-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  db.prepare("INSERT INTO projects (id,name) VALUES (31,'unpark-p')").run();
  db.prepare(`INSERT INTO factory_process_runs
    (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
     executor_kind,input_schema,input_snapshot,input_hash,status)
    VALUES (3100,31,31,'solution-development','1.4.3','solution-development@1.4.3','k-unpark',
            'generic-flow','test.input.v1','{}','${'a'.repeat(64)}','running')`).run();
  const insert = db.prepare(`INSERT INTO factory_workplaces
    (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,kanban_phase,loop_state,next_role,revision)
    VALUES (?,?, 'solution-development@1.4.3','impl','w','blocked','paused',?,?)`);
  insert.run('workplace/3100/author-park', 3100, 'author', 5);
  insert.run('workplace/3100/reviewer-park', 3100, 'reviewer', 3);
  db.prepare(`INSERT INTO factory_workplaces
    (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,kanban_phase,loop_state,next_role,revision)
    VALUES ('workplace/3100/idle-one',3100,'solution-development@1.4.3','impl','w2','todo','idle','author',1)`).run();
  return db;
}

test.after(() => rmSync(temp, { recursive: true, force: true }));

test('unparkWorkplaces requeues every blocked/paused workplace with the role phase', () => {
  const db = seedDb();
  const result = unparkWorkplaces(db, { projectId: 31, actorId: 'test', reason: 'unit' });
  assert.equal(result.unparked.length, 2);
  const author = db.prepare('SELECT kanban_phase,loop_state,next_role,revision FROM factory_workplaces WHERE workplace_ref=?').get('workplace/3100/author-park');
  assert.deepEqual(author, { kanban_phase: 'in_progress', loop_state: 'queued', next_role: 'author', revision: 6 });
  const reviewer = db.prepare('SELECT kanban_phase,loop_state,next_role,revision FROM factory_workplaces WHERE workplace_ref=?').get('workplace/3100/reviewer-park');
  assert.deepEqual(reviewer, { kanban_phase: 'review_in_progress', loop_state: 'queued', next_role: 'reviewer', revision: 4 });
  // Idle workplaces are untouched.
  const idle = db.prepare('SELECT kanban_phase,loop_state,revision FROM factory_workplaces WHERE workplace_ref=?').get('workplace/3100/idle-one');
  assert.deepEqual(idle, { kanban_phase: 'todo', loop_state: 'idle', revision: 1 });
  // One audit row per unparked workplace.
  const audits = db.prepare("SELECT count(*) n FROM activity_log WHERE action='operator-unpark'").get().n;
  assert.equal(audits, 2);
  db.close();
});

test('unparkWorkplaces is idempotent and scoped by workplaceRef', () => {
  const db = seedDb();
  const first = unparkWorkplaces(db, { workplaceRef: 'workplace/3100/author-park', actorId: 'test', reason: 'unit' });
  assert.equal(first.unparked.length, 1);
  const again = unparkWorkplaces(db, { workplaceRef: 'workplace/3100/author-park', actorId: 'test', reason: 'unit' });
  assert.equal(again.unparked.length, 0);
  // Refused without scope.
  assert.throws(() => unparkWorkplaces(db, { actorId: 'test', reason: 'unit' }), /OPERATOR_UNPARK_SCOPE_REQUIRED/);
  db.close();
});

test('CLI unpark requeues parked workplaces and reports both holds and parks', () => {
  const db = seedDb();
  const dbPath = db.prepare('PRAGMA database_list').get().file;
  db.close();
  const out = execFileSync(
    process.execPath,
    ['scripts/factory.mjs', 'unpark', dbPath, '--project', '31'],
    { cwd: path.resolve(import.meta.dirname, '..', '..'), encoding: 'utf8' },
  );
  assert.match(out, /requeued workplace=workplace\/3100\/author-park rev=6/);
  assert.match(out, /requeued workplace=workplace\/3100\/reviewer-park rev=4/);
  assert.match(out, /2 parked workplace\(s\) requeued/);
});
