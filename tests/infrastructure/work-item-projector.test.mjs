/**
 * WorkItem projector tests (Conveyor v4, step 1.3).
 *
 * Target contract: REG-06 (Карточка — WorkItem projection). Verifies:
 *   - projectWorkItemsForRun derives cards from factory_workplaces.
 *   - projectWorkItem reads one card by exact ref.
 *   - rebuildAllWorkItems is idempotent (E2E-10: drop+rebuild reproduces
 *     both channels identically).
 *   - the projection is read-only (no writes to tasks, no worker launch).
 *   - displayLabel combines both channels per v4 §«Projection rule».
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import {
  projectWorkItem,
  projectWorkItemsForRun,
  rebuildAllWorkItems,
} from '../../dist/infrastructure/projections/work-item-projector.js';

const REF = asWorkplaceRef({
  processRunId: 42,
  moduleRef: 'formalization@1.0.0',
  productionCellId: 'srs-author',
});

function dbWithWorkplace() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  new SqliteWorkplaceRepository(db).materialize(REF);
  return db;
}

test('REG-06: projectWorkItemsForRun lists materialized workplaces', () => {
  const db = dbWithWorkplace();
  const items = projectWorkItemsForRun(db, 42);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.kanbanPhase, 'todo');
  assert.equal(item.loopState, 'idle');
  assert.equal(item.nextRole, 'author');
  assert.equal(item.revision, 0);
  db.close();
});

test('REG-06: projectWorkItem reads one card by exact ref', () => {
  const db = dbWithWorkplace();
  const item = projectWorkItem(db, REF);
  assert.ok(item);
  assert.equal(item.workplaceRef.productionCellId, 'srs-author');
  assert.equal(item.workItemId, 'workplace/42/formalization@1.0.0/srs-author/default');
  db.close();
});

test('REG-06: projectWorkItem returns null for unknown ref', () => {
  const db = dbWithWorkplace();
  const other = asWorkplaceRef({
    processRunId: 42,
    moduleRef: 'development@1.0.0',
    productionCellId: 'implement',
    workKey: 'item-9',
  });
  assert.equal(projectWorkItem(db, other), null);
  db.close();
});

test('REG-06: projection reflects Workplace transitions (two channels)', () => {
  const db = dbWithWorkplace();
  const repo = new SqliteWorkplaceRepository(db);
  // Transition to in_progress/queued.
  repo.applyTransition({
    workplaceRef: REF,
    expectedRevision: 0,
    kanbanPhase: 'in_progress',
    loopState: 'queued',
    nextRole: 'author',
    terminalReason: null,
  });
  const item = projectWorkItem(db, REF);
  assert.equal(item.kanbanPhase, 'in_progress');
  assert.equal(item.loopState, 'queued');
  assert.equal(item.revision, 1);
  db.close();
});

test('REG-06: displayLabel combines both channels (v4 Projection rule)', () => {
  const db = dbWithWorkplace();
  const item = projectWorkItem(db, REF);
  // Label contains the human-readable phase, the loop, the role, the rev.
  assert.match(item.displayLabel, /Todo/);
  assert.match(item.displayLabel, /idle/);
  assert.match(item.displayLabel, /author/);
  assert.match(item.displayLabel, /rev 0/);
  db.close();
});

test('E2E-10: rebuild is identical (drop+rebuild reproduces both channels)', () => {
  const db = dbWithWorkplace();
  const repo = new SqliteWorkplaceRepository(db);
  // Push the workplace through a couple of transitions so the projection has
  // non-trivial state to reproduce.
  repo.applyTransition({
    workplaceRef: REF, expectedRevision: 0,
    kanbanPhase: 'in_progress', loopState: 'queued',
    nextRole: 'author', terminalReason: null,
  });
  repo.applyTransition({
    workplaceRef: REF, expectedRevision: 1,
    kanbanPhase: 'in_progress', loopState: 'running',
    nextRole: 'author', terminalReason: null,
  });
  const result = rebuildAllWorkItems(db, 42);
  assert.equal(result.identical, true);
  assert.equal(result.before.length, 1);
  assert.equal(result.after.length, 1);
  assert.equal(result.before[0].loopState, 'running');
  assert.equal(result.after[0].loopState, 'running');
  db.close();
});

test('REG-06-AC-02: projector does not write to tasks (read-only)', () => {
  const db = dbWithWorkplace();
  // Count tasks rows before and after a projection read — must be unchanged.
  // (The projector only SELECTs from factory_workplaces; it never touches tasks.)
  const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  projectWorkItemsForRun(db, 42);
  projectWorkItem(db, REF);
  rebuildAllWorkItems(db, 42);
  const after = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  assert.equal(after, before);
  db.close();
});

test('REG-06: projection of a terminal workplace shows terminal reason', () => {
  const db = dbWithWorkplace();
  const repo = new SqliteWorkplaceRepository(db);
  repo.applyTransition({
    workplaceRef: REF, expectedRevision: 0,
    kanbanPhase: 'done', loopState: 'terminal',
    nextRole: 'author', terminalReason: 'accepted',
  });
  const item = projectWorkItem(db, REF);
  assert.equal(item.kanbanPhase, 'done');
  assert.equal(item.loopState, 'terminal');
  assert.equal(item.terminalReason, 'accepted');
  db.close();
});
