/** ProductionCellCoordinator state-machine tests (Conveyor v4, REG-13). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { asWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { ProductionCellCoordinator } from '../../dist/process-modules/application/production-cell-coordinator.js';

const REF = asWorkplaceRef({
  processRunId: 1,
  moduleRef: 'formalization@1.0.0',
  productionCellId: 'srs-author',
});

function harness() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const coordinator = new ProductionCellCoordinator({ db, workplaceRepo, now: () => new Date() });
  return { db, workplaceRepo, coordinator };
}

/** Simulate the canonical dispatcher's projected lease/start events. */
function projectWorkerStarted(workplaceRepo, ref, reservationRef = 'execution:test') {
  const queued = workplaceRepo.read(ref);
  assert.ok(queued);
  const leased = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: queued.revision,
    kanbanPhase: queued.kanbanPhase === 'review' ? 'review_in_progress' : queued.kanbanPhase,
    loopState: 'leased',
    nextRole: queued.nextRole,
    terminalReason: null,
    activeReservationRef: reservationRef,
  });
  assert.equal(leased.applied, true);
  const started = workplaceRepo.applyTransition({
    workplaceRef: ref,
    expectedRevision: leased.revision,
    kanbanPhase: leased.state.kanbanPhase,
    loopState: 'running',
    nextRole: leased.state.nextRole,
    terminalReason: null,
    activeReservationRef: reservationRef,
  });
  assert.equal(started.applied, true);
}

function runningHarness() {
  const h = harness();
  h.coordinator.materializeCell({
    processRunId: 1,
    moduleRef: 'formalization@1.0.0',
    productionCellId: 'srs-author',
  });
  h.coordinator.admitWork(REF);
  projectWorkerStarted(h.workplaceRepo, REF);
  return h;
}

test('REG-13: materialize and admit create todo/idle then in_progress/queued', () => {
  const h = harness();
  const initial = h.coordinator.materializeCell({
    processRunId: 1,
    moduleRef: 'formalization@1.0.0',
    productionCellId: 'srs-author',
  });
  assert.equal(initial.kanbanPhase, 'todo');
  assert.equal(initial.loopState, 'idle');
  const admitted = h.coordinator.admitWork(REF);
  assert.equal(admitted.applied, true);
  assert.equal(admitted.state.kanbanPhase, 'in_progress');
  assert.equal(admitted.state.loopState, 'queued');
  h.db.close();
});

test('REG-13: coordinator has no worker-launch capability', () => {
  const h = harness();
  assert.equal('launchWorker' in h.coordinator, false);
  assert.equal('markWorkerLaunched' in h.coordinator, false);
  h.db.close();
});

test('REG-13: accepted final candidate reaches done/terminal', () => {
  const h = runningHarness();
  const verifying = h.coordinator.sealCandidateSet(REF);
  assert.equal(verifying.state.loopState, 'verifying');
  const final = h.coordinator.applyGateDecision(REF, { verdict: 'accepted', isFinal: true });
  assert.equal(final.state.kanbanPhase, 'done');
  assert.equal(final.state.loopState, 'terminal');
  assert.equal(final.state.terminalReason, 'accepted');
  assert.equal(h.coordinator.isTerminal(REF), true);
  h.db.close();
});

test('REG-13: accepted author candidate hands off to reviewer', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const review = h.coordinator.applyGateDecision(REF, { verdict: 'accepted', isFinal: false });
  assert.equal(review.state.kanbanPhase, 'review');
  assert.equal(review.state.loopState, 'queued');
  assert.equal(review.state.nextRole, 'reviewer');
  h.db.close();
});

test('REG-13: repair decision waits and requeues the declared role', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const waiting = h.coordinator.applyGateDecision(REF, {
    verdict: 'repair_required',
    isFinal: false,
    repairTargetRole: 'author',
  });
  assert.equal(waiting.state.loopState, 'repair_wait');
  assert.equal(waiting.state.kanbanPhase, 'in_progress');
  const queued = h.coordinator.requeue(REF, 'author');
  assert.equal(queued.state.loopState, 'queued');
  assert.equal(queued.state.nextRole, 'author');
  h.db.close();
});

test('REG-13: repair decision without a role is rejected', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  assert.throws(
    () => h.coordinator.applyGateDecision(REF, { verdict: 'repair_required', isFinal: false }),
    /repairTargetRole/,
  );
  h.db.close();
});

test('REG-13: human-required pauses a blocked workplace', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const blocked = h.coordinator.applyGateDecision(REF, { verdict: 'human_required', isFinal: false });
  assert.equal(blocked.state.kanbanPhase, 'blocked');
  assert.equal(blocked.state.loopState, 'paused');
  h.db.close();
});

test('REG-13: failed gate reaches failed/terminal', () => {
  const h = runningHarness();
  h.coordinator.sealCandidateSet(REF);
  const failed = h.coordinator.applyGateDecision(REF, { verdict: 'failed', isFinal: false });
  assert.equal(failed.state.kanbanPhase, 'failed');
  assert.equal(failed.state.loopState, 'terminal');
  assert.equal(failed.state.terminalReason, 'failed');
  h.db.close();
});

test('REG-13: worker crash keeps Kanban progress and can be retried', () => {
  const h = runningHarness();
  const waiting = h.coordinator.recordWorkerCrash(REF);
  assert.equal(waiting.state.kanbanPhase, 'in_progress');
  assert.equal(waiting.state.loopState, 'repair_wait');
  h.coordinator.requeue(REF, 'author');
  projectWorkerStarted(h.workplaceRepo, REF, 'execution:retry');
  h.coordinator.sealCandidateSet(REF);
  const final = h.coordinator.applyGateDecision(REF, { verdict: 'accepted', isFinal: true });
  assert.equal(final.state.terminalReason, 'accepted');
  h.db.close();
});
