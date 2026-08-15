// tests/infrastructure/transition-obligation-integrator.test.mjs
//
// ADR-053 Phase 8 — transition-obligation integrator tests.
//
// Proves the six conveyor handoffs can be recorded as durable obligations
// and the reconciler drives them to completion. Each obligation is
// idempotent: a replay of the source fact finds the existing obligation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { TransitionObligationReconciler } from
  '../../dist/process-modules/application/transition-obligation-reconciler.js';
import { TransitionObligationIntegrator, SOURCE_TO_HANDOFF } from
  '../../dist/process-modules/application/transition-obligation-integrator.js';

function makeLedger() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return { ledger: new SqliteTransitionObligationLedger(db), db };
}

// ===========================================================================
// 1. Each source fact creates the correct obligation.
// ===========================================================================
test('Phase 8: CandidateSet seal creates a run-gate obligation', () => {
  const { ledger } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  integrator.onCandidateSetSealed({
    candidateSetRef: 'cs-1',
    candidateSetDigest: 'sha256:cs',
    workplaceRef: 'workplace/1/cell/item',
  });
  const ready = ledger.findReady();
  assert.equal(ready.length, 1);
  assert.equal(ready[0].handoffKind, 'run-gate');
  assert.equal(ready[0].sourceKind, 'candidate-set-sealed');
  assert.equal(ready[0].ownerCapability, 'gate-run-driver');
});

test('Phase 8: all six source facts create their corresponding obligations', () => {
  const { ledger } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  integrator.onFinalPresentationCommitted({ commitmentRef: 'pc-1', commitmentDigest: 'd0', workplaceRef: 'w1' });
  integrator.onCandidateSetSealed({ candidateSetRef: 'cs-1', candidateSetDigest: 'd1', workplaceRef: 'w1' });
  integrator.onGateAccepted({ gateDecisionKey: 'gd-1', gateDecisionDigest: 'd2', workplaceRef: 'w1' });
  integrator.onEffectsSettled({ workplaceRef: 'w1', effectReceiptDigest: 'd3' });
  integrator.onFinalAcceptanceRecorded({ finalAcceptanceRef: 'fa-1', acceptanceDigest: 'd4', workplaceRef: 'w1' });
  integrator.onProcessSettled({ processRunId: 1, settlementDigest: 'd5', subjectRef: 'process-run:1' });
  const ready = ledger.findReady();
  assert.equal(ready.length, 6);
  const handoffs = ready.map(o => o.handoffKind).sort();
  assert.deepEqual(handoffs, [
    'close-presentation',
    'record-final-acceptance',
    'route-lifecycle',
    'run-effects',
    'run-gate',
    'settle-process',
  ]);
});

// ===========================================================================
// 2. Idempotent — appending the same obligation twice is a no-op.
// ===========================================================================
test('Phase 8: obligation creation is idempotent', () => {
  const { ledger, db } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  integrator.onCandidateSetSealed({ candidateSetRef: 'cs-1', candidateSetDigest: 'd', workplaceRef: 'w1' });
  integrator.onCandidateSetSealed({ candidateSetRef: 'cs-1', candidateSetDigest: 'd', workplaceRef: 'w1' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM factory_transition_obligations').get().n;
  assert.equal(count, 1);
});

// ===========================================================================
// 3. Full cycle: create obligation → reconcile with handler → completed.
// ===========================================================================
test('Phase 8: full cycle — CandidateSet seal → reconcile → gate runs', async () => {
  const { ledger } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  const reconciler = new TransitionObligationReconciler(ledger);
  let gateRan = false;
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      gateRan = true;
      return {
        completionReceipt: `gate-decision:${obligation.subjectRef}`,
        resultDigest: 'sha256:gate-result',
      };
    },
  });
  integrator.onCandidateSetSealed({
    candidateSetRef: 'cs-1',
    candidateSetDigest: 'sha256:cs',
    workplaceRef: 'workplace/1/cell/item',
  });
  const result = await reconciler.reconcile({ leaseOwner: 'rec-1' });
  assert.equal(result.dispatched, 1);
  assert.equal(result.completed, 1);
  assert.ok(gateRan, 'gate handler ran');
});

// ===========================================================================
// 4. Crash recovery — obligation survives crash, reconciler redrives it.
// ===========================================================================
test('Phase 8: crash recovery — obligation is redriven after crash', async () => {
  const { ledger } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  const reconciler = new TransitionObligationReconciler(ledger);
  let calls = 0;
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute() {
      calls++;
      if (calls === 1) throw new Error('simulated crash');
      return { completionReceipt: 'gate-1', resultDigest: 'sha256:r' };
    },
  });
  integrator.onCandidateSetSealed({ candidateSetRef: 'cs-1', candidateSetDigest: 'd', workplaceRef: 'w1' });

  // First sweep: crash.
  await reconciler.reconcile({ leaseOwner: 'rec-1' });
  // Second sweep: recovery.
  const r2 = await reconciler.reconcile({ leaseOwner: 'rec-1' });
  assert.equal(r2.completed, 1);
  assert.equal(calls, 2);
});

// ===========================================================================
// 5. Source-to-handoff mapping is complete and consistent.
// ===========================================================================
test('Phase 8: SOURCE_TO_HANDOFF maps all six source kinds', () => {
  assert.equal(SOURCE_TO_HANDOFF['final-presentation-committed'], 'close-presentation');
  assert.equal(SOURCE_TO_HANDOFF['candidate-set-sealed'], 'run-gate');
  assert.equal(SOURCE_TO_HANDOFF['gate-accepted'], 'run-effects');
  assert.equal(SOURCE_TO_HANDOFF['effects-settled'], 'record-final-acceptance');
  assert.equal(SOURCE_TO_HANDOFF['final-acceptance-recorded'], 'settle-process');
  assert.equal(SOURCE_TO_HANDOFF['process-settled'], 'route-lifecycle');
});
