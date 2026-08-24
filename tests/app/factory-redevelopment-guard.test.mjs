// tests/app/factory-redevelopment-guard.test.mjs
//
// STAGE-23 (2026-08-24 desk-coverage audit) — the redevelop parent guard,
// pinned SYNTHETICALLY on every branch.
//
// The live-shaped suite (tests/app/factory-redevelopment.test.mjs) needs the
// stage-15 sandbox and skips everywhere else, so before this file the guard
// had NO always-running coverage — and the post-GAP-2 terminal shape
// (status='completed' + terminal_status='failed', current_stage_id cleared,
// the failing stage only in the last factory_stage_runs row) was accepted by
// no test at all, although it is the exact shape the Elite-8/Elite-9 parents
// died in (fix a9a3f289). The abandon shape used by the stage-23 entry
// (status='failed' + terminal_status='failed', current_stage_id retained) is
// pinned here too.
//
// Guard-only fixture: once the guard passes, the next deterministic error is
// DEVELOPMENT_REDEVELOPMENT_REPOSITORY_NOT_EXACT (no project_repositories
// rows) — that marker proves the run got PAST the guard without needing the
// capsule chain.

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { prepareDevelopmentRedevelopment } from '../../dist/app/factory-redevelopment.js';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';
import { ensureFactoryLifecycleRunSchema } from '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  ensureFactoryLifecycleRunSchema(db);
  db.pragma('foreign_keys=OFF');
  return db;
}

/**
 * Parent lifecycle 1 with the given terminal shape plus its stage-run tail
 * (ordered; the last entry is what `ORDER BY id DESC LIMIT 1` sees).
 */
function seedParent(db, { status, terminalStatus, currentStageId }, stages) {
  db.prepare(
    `INSERT INTO factory_lifecycle_runs
       (id, lifecycle_name, lifecycle_version, lifecycle_ref_key, display_name, description,
        definition_snapshot, definition_hash, project_id, epic_id, initiated_by, idempotency_key,
        input_schema, input_snapshot, input_hash, status, entry_stage_id, current_stage_id,
        terminal_status, version, created_at, updated_at)
     VALUES (1,'product-delivery','1.0.0','ld:guard','d','d','{}','h',1,1,'guard-test','idem-1',
             'factory.development-case.v1','{}','h',?,'initial-discovery',?,?,1,
             datetime('now'),datetime('now'))`,
  ).run(status, currentStageId, terminalStatus);
  let attempt = 0;
  for (const [stageId, outcome] of stages) {
    attempt += 1;
    db.prepare(
      `INSERT INTO factory_stage_runs
         (lifecycle_run_id, stage_id, attempt, ordinal, module_name, module_version,
          module_ref_key, binding_snapshot, binding_hash, input_schema, input_snapshot,
          input_hash, local_outcome, status)
       VALUES (1,?,?,?, 'stub', '1.0.0', 'stub@1.0.0', '{}', 'h',
               'factory.synthetic-input.v1', '{}', 'h', ?, 'completed')`,
    ).run(stageId, attempt, attempt, outcome);
  }
}

const PRELUDE = [
  ['initial-discovery', 'go'],
  ['solution-formalization', 'formalized'],
];

function call(db) {
  try {
    prepareDevelopmentRedevelopment(db, {
      orderRef: 'order-guard',
      parentLifecycleRunId: 1,
      actorId: 'guard-test',
      reason: 'synthetic guard-shape probe',
    });
    return 'no-throw';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('guard accepts the legacy terminal shape (failed + current_stage_id retained)', () => {
  const db = makeDb();
  seedParent(db,
    { status: 'failed', terminalStatus: null, currentStageId: 'solution-development' },
    [...PRELUDE, ['solution-development', null]]);
  assert.equal(call(db), 'DEVELOPMENT_REDEVELOPMENT_REPOSITORY_NOT_EXACT',
    'the guard passes (the run reaches the repository check)');
  db.close();
});

test('guard accepts the post-GAP-2 terminal shape (completed + terminal_status=failed, stage id cleared)', () => {
  const db = makeDb();
  seedParent(db,
    { status: 'completed', terminalStatus: 'failed', currentStageId: null },
    [...PRELUDE, ['solution-development', 'failed']]);
  assert.equal(call(db), 'DEVELOPMENT_REDEVELOPMENT_REPOSITORY_NOT_EXACT',
    'a9a3f289: the failing stage falls back to the last factory_stage_runs row — '
    + 'the exact shape the Elite-8/Elite-9 parents died in');
  db.close();
});

test('guard accepts the abandon shape (failed + terminal_status=failed, stage id retained)', () => {
  const db = makeDb();
  seedParent(db,
    { status: 'failed', terminalStatus: 'failed', currentStageId: 'solution-development' },
    [...PRELUDE, ['solution-development', null]]);
  assert.equal(call(db), 'DEVELOPMENT_REDEVELOPMENT_REPOSITORY_NOT_EXACT',
    'the stage-23 entry shapes a paused parent with abandon; the guard must accept it');
  db.close();
});

test('guard rejects a formalization failure (no development capsule exists)', () => {
  const db = makeDb();
  seedParent(db,
    { status: 'completed', terminalStatus: 'failed', currentStageId: null },
    [['initial-discovery', 'go'], ['solution-formalization', 'failed']]);
  assert.match(call(db), /DEVELOPMENT_REDEVELOPMENT_PARENT_NOT_EXACT/,
    'a failed formalization has no capsule to consume');
  db.close();
});

test('guard rejects a non-terminal parent (paused)', () => {
  const db = makeDb();
  seedParent(db,
    { status: 'paused', terminalStatus: null, currentStageId: 'solution-development' },
    [...PRELUDE, ['solution-development', null]]);
  assert.match(call(db), /DEVELOPMENT_REDEVELOPMENT_PARENT_NOT_EXACT/,
    'a paused run is not a terminal failure and must not be redeveloped');
  db.close();
});
