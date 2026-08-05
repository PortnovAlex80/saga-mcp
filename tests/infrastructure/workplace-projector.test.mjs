/**
 * WorkplaceProjector dual-write tests (Conveyor v4, step 5.2).
 *
 * Verifies that the projector shadows legacy task status transitions into
 * v4_workplaces. Tests run with SAGA_WORKPLACE_WRITE=on so the projector
 * is active.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Enable the projector BEFORE importing modules that read process.env.
process.env.SAGA_WORKPLACE_WRITE = 'on';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureSaga3ProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { WorkplaceProjector } from '../../dist/infrastructure/projections/workplace-projector.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureSaga3ProcessRunSchema(db);
  return db;
}

function makeSnapshot(status, overrides = {}) {
  return {
    taskId: 1,
    status,
    epicId: 1,
    projectId: 1,
    taskKind: 'discovery.work',
    metadata: JSON.stringify({ process_run_id: 1, process_node_id: 'proposal' }),
    ...overrides,
  };
}

test('5.2: projector creates v4_workplaces row on first claim (in_progress)', () => {
  const db = freshDb();
  const projector = new WorkplaceProjector(db);
  projector.projectStatusChange(makeSnapshot('in_progress'));
  const repo = new SqliteWorkplaceRepository(db);
  const items = repo.listInProcessRun(1);
  assert.equal(items.length, 1);
  assert.equal(items[0].state.kanbanPhase, 'in_progress');
  assert.equal(items[0].state.loopState, 'running');
  db.close();
});

test('5.2: projector updates v4 row on done', () => {
  const db = freshDb();
  const projector = new WorkplaceProjector(db);
  projector.projectStatusChange(makeSnapshot('in_progress'));
  projector.projectStatusChange(makeSnapshot('done'));
  const repo = new SqliteWorkplaceRepository(db);
  const items = repo.listInProcessRun(1);
  assert.equal(items[0].state.kanbanPhase, 'done');
  assert.equal(items[0].state.loopState, 'terminal');
  assert.equal(items[0].state.terminalReason, 'accepted');
  db.close();
});

test('5.2: projector updates v4 row on review', () => {
  const db = freshDb();
  const projector = new WorkplaceProjector(db);
  projector.projectStatusChange(makeSnapshot('in_progress'));
  projector.projectStatusChange(makeSnapshot('review'));
  const repo = new SqliteWorkplaceRepository(db);
  const items = repo.listInProcessRun(1);
  assert.equal(items[0].state.kanbanPhase, 'review');
  assert.equal(items[0].state.loopState, 'queued');
  assert.equal(items[0].state.nextRole, 'reviewer');
  db.close();
});

test('5.2: projector skips tasks without process_run_id metadata', () => {
  const db = freshDb();
  const projector = new WorkplaceProjector(db);
  projector.projectStatusChange(makeSnapshot('in_progress', {
    metadata: '{}', // no process_run_id
  }));
  const repo = new SqliteWorkplaceRepository(db);
  assert.equal(repo.listInProcessRun(1).length, 0);
  db.close();
});

test('5.2: projector is idempotent (same status → no revision bump)', () => {
  const db = freshDb();
  const projector = new WorkplaceProjector(db);
  projector.projectStatusChange(makeSnapshot('in_progress'));
  const repo = new SqliteWorkplaceRepository(db);
  const rev1 = repo.listInProcessRun(1)[0].state.revision;
  projector.projectStatusChange(makeSnapshot('in_progress')); // same status
  const rev2 = repo.listInProcessRun(1)[0].state.revision;
  assert.equal(rev1, rev2);
  db.close();
});

test('5.2: projector handles blocked status', () => {
  const db = freshDb();
  const projector = new WorkplaceProjector(db);
  projector.projectStatusChange(makeSnapshot('in_progress'));
  projector.projectStatusChange(makeSnapshot('blocked'));
  const repo = new SqliteWorkplaceRepository(db);
  const items = repo.listInProcessRun(1);
  assert.equal(items[0].state.kanbanPhase, 'blocked');
  assert.equal(items[0].state.loopState, 'paused');
  db.close();
});

test('5.2: projector no-ops when SAGA_WORKPLACE_WRITE is off', () => {
  const oldVal = process.env.SAGA_WORKPLACE_WRITE;
  process.env.SAGA_WORKPLACE_WRITE = 'off';
  const db = freshDb();
  // Re-construct so it reads the env.
  const projector = new WorkplaceProjector(db);
  projector.projectStatusChange(makeSnapshot('in_progress'));
  const repo = new SqliteWorkplaceRepository(db);
  assert.equal(repo.listInProcessRun(1).length, 0);
  process.env.SAGA_WORKPLACE_WRITE = oldVal;
  db.close();
});
