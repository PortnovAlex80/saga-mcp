/**
 * Workplace E2E conformance scenarios (Conveyor v4, step 5.1).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY E2E-01..E2E-14.
 *
 * Each test maps to one E2E-* scenario from the registry. They drive the
 * pure-domain reducer + SQLite stores through the full lifecycle and assert
 * durable protocol facts (not wording).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { runConformanceScenario } from '../../dist/infrastructure/workplace/workplace-conformance-harness.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { projectWorkItem } from '../../dist/infrastructure/projections/work-item-projector.js';

const REF = asWorkplaceRef({
  processRunId: 1,
  moduleRef: 'formalization@1.0.0',
  productionCellId: 'srs-author',
});

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

// E2E-01: Worker completes one author cycle without review (final gate accepts).
test('E2E-01: worker shift without reviewer → done/terminal(accepted)', () => {
  const db = freshDb();
  const run = runConformanceScenario(db, REF, [
    { kind: 'work-admitted' },
    { kind: 'worker-leased', reservationRef: 'r1' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'gate-author-accepted-final' },
  ]);
  assert.equal(run.finalState.kanbanPhase, 'done');
  assert.equal(run.finalState.loopState, 'terminal');
  assert.equal(run.finalState.terminalReason, 'accepted');
  assert.equal(run.states.length, 6); // initial + 5 events
  db.close();
});

// E2E-02: Author accepted → review → reviewer accepted → done.
test('E2E-02: author accepted with review → reviewer accepted → done', () => {
  const db = freshDb();
  const run = runConformanceScenario(db, REF, [
    { kind: 'work-admitted' },
    { kind: 'worker-leased', reservationRef: 'r1' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'gate-author-accepted-with-review' }, // → review/queued/reviewer
    { kind: 'worker-leased', reservationRef: 'r2' }, // → review_in_progress/leased
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'reviewer-verdict', verdict: 'accepted' },
  ]);
  assert.equal(run.finalState.kanbanPhase, 'done');
  assert.equal(run.finalState.terminalReason, 'accepted');
  db.close();
});

// E2E-03: Gate repair → repair_wait → requeue → new author → done.
test('E2E-03: gate repair_required → repair_wait → requeue → done', () => {
  const db = freshDb();
  const run = runConformanceScenario(db, REF, [
    { kind: 'work-admitted' },
    { kind: 'worker-leased', reservationRef: 'r1' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'gate-repair-required', repairTargetRole: 'author' },
    { kind: 'repair-requeued', role: 'author' },
    { kind: 'worker-leased', reservationRef: 'r2' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'gate-author-accepted-final' },
  ]);
  assert.equal(run.finalState.kanbanPhase, 'done');
  // Kanban never went to todo during repair (REG-28-AC-02).
  const wentToTodo = run.states.some(s => s.kanbanPhase === 'todo' && s.revision > 0);
  assert.equal(wentToTodo, false);
  db.close();
});

// E2E-04: Reviewer output invalid → retry reviewer → accepted.
test('E2E-04: invalid reviewer output → retry reviewer → accepted', () => {
  const db = freshDb();
  const run = runConformanceScenario(db, REF, [
    { kind: 'work-admitted' },
    { kind: 'worker-leased', reservationRef: 'r1' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'gate-author-accepted-with-review' },
    { kind: 'worker-leased', reservationRef: 'r2' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'reviewer-verdict', verdict: 'invalid-output' }, // → repair_wait/reviewer
    { kind: 'repair-requeued', role: 'reviewer' },
    { kind: 'worker-leased', reservationRef: 'r3' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'reviewer-verdict', verdict: 'accepted' },
  ]);
  assert.equal(run.finalState.kanbanPhase, 'done');
  db.close();
});

// E2E-05: Reviewer proves defect → backward to author → fixed → done.
test('E2E-05: reviewer defect-proven → backward to author → fixed → done', () => {
  const db = freshDb();
  const run = runConformanceScenario(db, REF, [
    { kind: 'work-admitted' },
    { kind: 'worker-leased', reservationRef: 'r1' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'gate-author-accepted-with-review' },
    { kind: 'worker-leased', reservationRef: 'r2' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'reviewer-verdict', verdict: 'defect-proven' }, // → in_progress/repair_wait/author
    { kind: 'repair-requeued', role: 'author' },
    { kind: 'worker-leased', reservationRef: 'r3' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'gate-author-accepted-final' },
  ]);
  assert.equal(run.finalState.kanbanPhase, 'done');
  // The defect-proven transition moved review_in_progress → in_progress (backward).
  const defectState = run.states[9]; // after reviewer-verdict(defect-proven)
  assert.equal(defectState.kanbanPhase, 'in_progress');
  assert.equal(defectState.nextRole, 'author');
  db.close();
});

// E2E-06: Worker crashed → repair_wait (Kanban unchanged).
test('E2E-06: worker crashed → repair_wait, Kanban stays in_progress', () => {
  const db = freshDb();
  const run = runConformanceScenario(db, REF, [
    { kind: 'work-admitted' },
    { kind: 'worker-leased', reservationRef: 'r1' },
    { kind: 'worker-started' },
    { kind: 'worker-crashed' },
  ]);
  assert.equal(run.finalState.kanbanPhase, 'in_progress'); // NOT todo
  assert.equal(run.finalState.loopState, 'repair_wait');
  db.close();
});

// E2E-10: Projection rebuild reproduces both channels.
test('E2E-10: WorkItem projection rebuild reproduces both channels', () => {
  const db = freshDb();
  runConformanceScenario(db, REF, [
    { kind: 'work-admitted' },
    { kind: 'worker-leased', reservationRef: 'r1' },
    { kind: 'worker-started' },
  ]);
  const p1 = projectWorkItem(db, REF);
  const p2 = projectWorkItem(db, REF);
  assert.deepEqual(p1, p2);
  assert.equal(p1.kanbanPhase, 'in_progress');
  assert.equal(p1.loopState, 'running');
  db.close();
});

// REG-28-AC-02: No technical event rolls Kanban to todo.
test('REG-28-AC-02: crash/repair never roll Kanban to todo', () => {
  const db = freshDb();
  const run = runConformanceScenario(db, REF, [
    { kind: 'work-admitted' }, // → in_progress
    { kind: 'worker-leased', reservationRef: 'r1' },
    { kind: 'worker-started' },
    { kind: 'worker-crashed' }, // → repair_wait
    { kind: 'repair-requeued', role: 'author' },
    { kind: 'worker-leased', reservationRef: 'r2' },
    { kind: 'worker-started' },
    { kind: 'worker-lost' }, // → repair_wait
    { kind: 'repair-requeued', role: 'author' },
    { kind: 'worker-leased', reservationRef: 'r3' },
    { kind: 'worker-started' },
    { kind: 'candidate-sealed' },
    { kind: 'gate-repair-required', repairTargetRole: 'author' },
    { kind: 'repair-requeued', role: 'author' },
  ]);
  // After work-admitted, Kanban must NEVER be 'todo' again (until terminal).
  const postAdmission = run.states.slice(2); // skip initial + work-admitted
  const wentToTodo = postAdmission.some(s => s.kanbanPhase === 'todo');
  assert.equal(wentToTodo, false, 'Kanban rolled to todo during technical failure');
  db.close();
});
