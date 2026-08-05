/**
 * WorkplaceReadComparator tests (Conveyor v4, step 5.3).
 *
 * Verifies the `both`-mode comparison: legacy tasks.status vs v4_workplaces
 * shadow. Tests in-sync, drift, no-shadow (non-PM task), and mode detection.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

// Enable the projector so v4_workplaces rows are actually written.
process.env.SAGA_WORKPLACE_WRITE = 'on';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureSaga3ProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { WorkplaceProjector } from '../../dist/infrastructure/projections/workplace-projector.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { asWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import {
  compareTaskStatus,
  expectedKanbanPhase,
  getWorkplaceReadMode,
  shouldCompareReads,
} from '../../dist/infrastructure/projections/workplace-read-comparator.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureSaga3ProcessRunSchema(db);
  return db;
}

const META = JSON.stringify({ process_run_id: 1, process_node_id: 'proposal' });

function task(status) {
  return { id: 1, status, task_kind: 'discovery.work', metadata: META };
}

test('5.3: expectedKanbanPhase maps all legacy statuses', () => {
  assert.equal(expectedKanbanPhase('todo'), 'todo');
  assert.equal(expectedKanbanPhase('in_progress'), 'in_progress');
  assert.equal(expectedKanbanPhase('review'), 'review');
  assert.equal(expectedKanbanPhase('review_in_progress'), 'review_in_progress');
  assert.equal(expectedKanbanPhase('done'), 'done');
  assert.equal(expectedKanbanPhase('pending_verification'), 'done');
  assert.equal(expectedKanbanPhase('blocked'), 'blocked');
  assert.equal(expectedKanbanPhase('weird'), null);
});

test('5.3: in-sync when v4 shadow matches legacy', () => {
  const db = freshDb();
  // Force-write the v4_workplaces row directly (bypass projector env check).
  const repo = new SqliteWorkplaceRepository(db);
  repo.materialize({ processRunId: 1, moduleRef: 'discovery@1.0.0', productionCellId: 'proposal', workKey: 'task-1' });
  repo.applyTransition({
    workplaceRef: asWorkplaceRef({ processRunId: 1, moduleRef: 'discovery@1.0.0', productionCellId: 'proposal', workKey: 'task-1' }),
    expectedRevision: 0,
    kanbanPhase: 'in_progress', loopState: 'queued', nextRole: 'author', terminalReason: null,
  });
  const result = compareTaskStatus(db, task('in_progress'));
  assert.equal(result.inSync, true);
  assert.equal(result.driftDetail, '');
  db.close();
});

test('5.3: drift detected when v4 shadow differs from legacy', () => {
  const db = freshDb();
  const proj = new WorkplaceProjector(db);
  // Shadow says in_progress, but legacy says done.
  proj.projectStatusChange({ ...task('in_progress'), epicId: 1, projectId: 1 });
  const result = compareTaskStatus(db, task('done'));
  assert.equal(result.inSync, false);
  assert.match(result.driftDetail, /DRIFT/);
  db.close();
});

test('5.3: non-PM task (no process_run_id) → inSync, no shadow', () => {
  const db = freshDb();
  const result = compareTaskStatus(db, { id: 1, status: 'in_progress', task_kind: null, metadata: '{}' });
  assert.equal(result.inSync, true);
  assert.equal(result.v4KanbanPhase, null);
  db.close();
});

test('5.3: no v4 row yet (shadow not projected) → drift', () => {
  const db = freshDb();
  const result = compareTaskStatus(db, task('in_progress'));
  assert.equal(result.inSync, false);
  assert.match(result.driftDetail, /DRIFT/);
  db.close();
});

test('5.3: getWorkplaceReadMode defaults to legacy', () => {
  const old = process.env.SAGA_WORKPLACE_READ;
  delete process.env.SAGA_WORKPLACE_READ;
  assert.equal(getWorkplaceReadMode(), 'legacy');
  process.env.SAGA_WORKPLACE_READ = old;
});

test('5.3: getWorkplaceReadMode respects both/new', () => {
  const old = process.env.SAGA_WORKPLACE_READ;
  process.env.SAGA_WORKPLACE_READ = 'both';
  assert.equal(getWorkplaceReadMode(), 'both');
  assert.equal(shouldCompareReads(), true);
  process.env.SAGA_WORKPLACE_READ = 'new';
  assert.equal(getWorkplaceReadMode(), 'new');
  assert.equal(shouldCompareReads(), false); // 'new' does not compare
  process.env.SAGA_WORKPLACE_READ = old;
});
