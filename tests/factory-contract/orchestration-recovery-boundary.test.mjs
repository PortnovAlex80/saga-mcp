import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

import {
  readCurrentStageWorkplaceState,
} from '../../dist/app/orchestration-idle-state.js';
import {
  formalizationProcessModule,
} from '../../dist/process-modules/modules/formalization/formalization-process-module.js';

function setupLifecycleScope() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_lifecycle_runs (
      id INTEGER PRIMARY KEY,
      current_stage_run_id INTEGER
    );
    CREATE TABLE factory_stage_runs (
      id INTEGER PRIMARY KEY,
      lifecycle_run_id INTEGER NOT NULL,
      process_run_id INTEGER
    );
    CREATE TABLE factory_workplaces (
      workplace_ref TEXT PRIMARY KEY,
      process_run_id INTEGER NOT NULL,
      loop_state TEXT NOT NULL
    );
  `);
  // Deliberately make StageRun id != ProcessRun id. A direct
  // current_stage_run_id = workplace.process_run_id join must fail this test.
  db.prepare(
    'INSERT INTO factory_lifecycle_runs(id,current_stage_run_id) VALUES (1,10)',
  ).run();
  db.prepare(
    'INSERT INTO factory_stage_runs(id,lifecycle_run_id,process_run_id) VALUES (10,1,99)',
  ).run();
  return db;
}

test('current-stage workplace lookup crosses StageRun -> ProcessRun explicitly', () => {
  const db = setupLifecycleScope();
  try {
    db.prepare(
      `INSERT INTO factory_workplaces(workplace_ref,process_run_id,loop_state)
       VALUES ('correct',99,'repair_wait'), ('integer-collision',10,'paused')`,
    ).run();
    const state = readCurrentStageWorkplaceState(db, 1);
    assert.equal(state.kernelProgressCount, 1);
    assert.equal(state.humanPausedCount, 0);
    assert.deepEqual(state.states, { repair_wait: 1 });
  } finally {
    db.close();
  }
});

test('repair_wait/verifying/effect_pending are kernel progress but paused is human-required', () => {
  const db = setupLifecycleScope();
  try {
    db.prepare(
      `INSERT INTO factory_workplaces(workplace_ref,process_run_id,loop_state)
       VALUES
         ('repair',99,'repair_wait'),
         ('verify',99,'verifying'),
         ('effect',99,'effect_pending'),
         ('human',99,'paused'),
         ('queue',99,'queued'),
         ('done',99,'terminal')`,
    ).run();
    const state = readCurrentStageWorkplaceState(db, 1);
    assert.equal(state.kernelProgressCount, 3);
    assert.equal(state.humanPausedCount, 1);
    assert.equal(state.otherNonTerminalCount, 1);
    assert.equal(state.states.terminal, undefined);
  } finally {
    db.close();
  }
});

test('orchestrate-cli performs on-demand supervision and never treats paused as automatic recovery', () => {
  const source = readFileSync(
    new URL('../../src/orchestrate-cli.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, /supervisionHandle\.reconcileOnce\(\)/);
  assert.match(source, /humanPausedCount > 0/);
  assert.match(source, /require explicit resume/);
  assert.match(source, /kernelProgressCount > 0/);
  assert.doesNotMatch(
    source,
    /lr\.current_stage_run_id\s*=\s*w\.process_run_id/,
  );
  assert.doesNotMatch(
    source,
    /loop_state IN \([^)]*'paused'[^)]*\)[\s\S]{0,300}pending recovery/,
  );
});

test('Formalization keeps recovery bounded but allows multiple author/reviewer repair rounds', () => {
  const cells = formalizationProcessModule.flow.nodes
    .filter(node => node.kind === 'production-cell')
    .map(node => node.cellDefinition);
  assert.ok(cells.length >= 4);
  for (const cell of cells) {
    assert.equal(cell.recovery.maxAttempts, 5, cell.id);
    assert.equal(cell.recovery.onExhausted, 'pause', cell.id);
  }

  for (const profile of formalizationProcessModule.executionProfiles) {
    assert.equal(profile.retryPolicy.maxAttempts, 5, profile.id);
    assert.equal(profile.recoveryPolicy.onExhausted, 'pause', profile.id);
  }
});
