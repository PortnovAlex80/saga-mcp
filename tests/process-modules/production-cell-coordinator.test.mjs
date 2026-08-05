/**
 * ProductionCellCoordinator tests (Conveyor v4, REG-13).
 *
 * Drives a full author → seal → gate → decision lifecycle through the
 * coordinator, verifying it correctly sequences reducer events + CAS +
 * launcher calls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function makeFakeLauncher() {
  const launches = [];
  return {
    launch(req) {
      launches.push(req);
      return { pid: 1000 + launches.length, processBirthToken: null, logPath: `/tmp/log-${launches.length}.log`, startedAt: new Date().toISOString() };
    },
    stop(fence) {},
    dispose() {},
    _launches: launches,
  };
}

function makeFakeProductRepo() {
  return {
    submitProduct(input) {
      return { productRef: { schemaId: input.schemaRef, ref: 'test-ref', digest: 'a'.repeat(64) }, replayed: false };
    },
    readProduct(ref) { return null; },
  };
}

function makeCoordinator(db) {
  return new ProductionCellCoordinator({
    db,
    workplaceRepo: new SqliteWorkplaceRepository(db),
    launcher: makeFakeLauncher(),
    productRepo: makeFakeProductRepo(),
    now: () => new Date(),
  });
}

const REF = asWorkplaceRef({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });

test('REG-13: materialize creates todo/idle workplace', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  const state = coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  assert.equal(state.kanbanPhase, 'todo');
  assert.equal(state.loopState, 'idle');
  db.close();
});

test('REG-13: admitWork transitions to in_progress/queued', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  const result = coord.admitWork(REF);
  assert.equal(result.applied, true);
  assert.equal(result.state.kanbanPhase, 'in_progress');
  assert.equal(result.state.loopState, 'queued');
  db.close();
});

test('REG-13: launchWorker calls launcher + transitions to running', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  const result = coord.launchWorker(REF, {
    role: 'author',
    fenceToken: 'exec-1',
    skillRef: 'saga-analyst',
    capabilityPreset: 'text-author',
    workspacePath: '/tmp/ws',
    runId: 'run-1',
    workerId: 'w-1',
    machineId: 'host',
  });
  assert.ok(result.pid !== null);
  assert.equal(result.state.loopState, 'running');
  db.close();
});

test('REG-13: sealCandidateSet transitions to verifying', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  const result = coord.sealCandidateSet(REF);
  assert.equal(result.state.loopState, 'verifying');
  db.close();
});

test('REG-13: applyGateDecision accepted-final → done/terminal', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  coord.sealCandidateSet(REF);
  const result = coord.applyGateDecision(REF, { verdict: 'accepted', isFinal: true });
  assert.equal(result.state.kanbanPhase, 'done');
  assert.equal(result.state.loopState, 'terminal');
  assert.equal(result.state.terminalReason, 'accepted');
  assert.equal(coord.isTerminal(REF), true);
  db.close();
});

test('REG-13: applyGateDecision accepted-with-review → review/queued', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  coord.sealCandidateSet(REF);
  const result = coord.applyGateDecision(REF, { verdict: 'accepted', isFinal: false });
  assert.equal(result.state.kanbanPhase, 'review');
  assert.equal(result.state.nextRole, 'reviewer');
  db.close();
});

test('REG-13: applyGateDecision repair_required → repair_wait', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  coord.sealCandidateSet(REF);
  const result = coord.applyGateDecision(REF, { verdict: 'repair_required', isFinal: false, repairTargetRole: 'author' });
  assert.equal(result.state.loopState, 'repair_wait');
  assert.equal(result.state.kanbanPhase, 'in_progress');
  db.close();
});

test('REG-13: applyGateDecision human_required → blocked/paused', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  coord.sealCandidateSet(REF);
  const result = coord.applyGateDecision(REF, { verdict: 'human_required', isFinal: false });
  assert.equal(result.state.kanbanPhase, 'blocked');
  assert.equal(result.state.loopState, 'paused');
  db.close();
});

test('REG-13: applyGateDecision failed → failed/terminal', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  coord.sealCandidateSet(REF);
  const result = coord.applyGateDecision(REF, { verdict: 'failed', isFinal: false });
  assert.equal(result.state.kanbanPhase, 'failed');
  assert.equal(result.state.terminalReason, 'failed');
  db.close();
});

test('REG-13: repair_required without repairTargetRole throws', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  coord.sealCandidateSet(REF);
  assert.throws(
    () => coord.applyGateDecision(REF, { verdict: 'repair_required', isFinal: false }),
    /repairTargetRole/,
  );
  db.close();
});

test('REG-13: recordWorkerCrash → repair_wait, Kanban unchanged', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  const result = coord.recordWorkerCrash(REF);
  assert.equal(result.state.loopState, 'repair_wait');
  assert.equal(result.state.kanbanPhase, 'in_progress'); // NOT todo
  db.close();
});

test('REG-13: requeue from repair_wait → queued', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  coord.recordWorkerCrash(REF);
  const result = coord.requeue(REF, 'author');
  assert.equal(result.state.loopState, 'queued');
  db.close();
});

test('REG-13: full lifecycle — author → crash → repair → accepted', () => {
  const db = freshDb();
  const coord = makeCoordinator(db);
  coord.materializeCell({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
  coord.admitWork(REF);
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e1', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  // Worker crashes.
  coord.recordWorkerCrash(REF);
  assert.equal(coord.readState(REF).kanbanPhase, 'in_progress');
  // Repair: requeue → launch → seal → gate accepts.
  coord.requeue(REF, 'author');
  coord.launchWorker(REF, {
    role: 'author', fenceToken: 'e2', skillRef: 's', capabilityPreset: 'p',
    workspacePath: '/w', runId: 'r', workerId: 'w', machineId: 'h',
  });
  coord.sealCandidateSet(REF);
  const final = coord.applyGateDecision(REF, { verdict: 'accepted', isFinal: true });
  assert.equal(final.state.kanbanPhase, 'done');
  assert.equal(final.state.terminalReason, 'accepted');
  db.close();
});
