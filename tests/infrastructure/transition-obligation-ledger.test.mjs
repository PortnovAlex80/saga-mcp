// tests/infrastructure/transition-obligation-ledger.test.mjs
//
// ADR-053 Phase 2 — convergence tests for the durable transition-obligation
// substrate.
//
// Exit gate (ADR-053-CUTOVER-TODO Phase 2):
//   "crash after source commit, after external mutation, and after
//    acknowledgement all converge to one completion receipt."
//
// These tests prove the substrate in isolation. Phase 8 wires production
// handoffs onto it; Phase 9 adds the full cross-aggregate convergence tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger, transitionObligationKey, obligationResultDigest } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { TransitionObligationReconciler } from
  '../../dist/process-modules/application/transition-obligation-reconciler.js';
import { causalSourceRevision, leaseFence } from
  '../../dist/process-modules/domain/transition-obligation.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function sampleObligation(overrides = {}) {
  return {
    sourceKind: 'candidate-set-sealed',
    sourceRef: 'candidate-set/workplace-1/exec-a',
    sourceDigest: 'sha256:source-fact',
    subjectRef: 'workplace/1/cell/item',
    handoffKind: 'run-gate',
    ownerCapability: 'production-cell-node-executor',
    causalSourceRevision: causalSourceRevision(1),
    ...overrides,
  };
}

// ===========================================================================
// 1. Idempotent append — the same source fact never creates two obligations.
// ===========================================================================
test('Phase 2: append is idempotent on the deterministic key', () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  const input = sampleObligation();
  const a = ledger.append(input);
  const b = ledger.append(input);
  assert.equal(a.obligationKey, b.obligationKey);
  assert.equal(a.state, 'pending');
  assert.equal(a.attempt, 0);
  // Only one row.
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_transition_obligations',
  ).get().n;
  assert.equal(count, 1);
});

test('Phase 2: same key with a different source digest fails closed', () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  ledger.append(sampleObligation());
  assert.throws(
    () => ledger.append(sampleObligation({ sourceDigest: 'sha256:drifted-source' })),
    /TRANSITION_OBLIGATION_REPLAY_MISMATCH.*sourceDigest/,
  );
  const row = db.prepare(
    'SELECT source_digest FROM factory_transition_obligations',
  ).get();
  assert.equal(row.source_digest, 'sha256:source-fact');
});

// ===========================================================================
// 2. Deterministic key — same source fact + handoff always the same key.
// ===========================================================================
test('Phase 2: obligation key is deterministic', () => {
  const key = transitionObligationKey({
    sourceKind: 'gate-accepted',
    sourceRef: 'gate-decision/workplace-1',
    handoffKind: 'run-effects',
  });
  const key2 = transitionObligationKey({
    sourceKind: 'gate-accepted',
    sourceRef: 'gate-decision/workplace-1',
    handoffKind: 'run-effects',
  });
  assert.equal(key, key2);
  assert.equal(key, 'gate-accepted:gate-decision/workplace-1:run-effects');
});

// ===========================================================================
// 3. Lease + complete — the normal happy path.
// ===========================================================================
test('Phase 2: lease an obligation and complete it', () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  const ob = ledger.append(sampleObligation());
  assert.equal(ob.state, 'pending');

  const leased = ledger.lease(ob.obligationKey, 'reconciler-1', leaseFence(1));
  assert.equal(leased, true);
  const afterLease = ledger.get(ob.obligationKey);
  assert.equal(afterLease.state, 'in_progress');
  assert.equal(afterLease.attempt, 1);
  assert.equal(afterLease.leaseOwner, 'reconciler-1');

  const completed = ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'gate-run/workplace-1/receipt-1',
    resultDigest: obligationResultDigest({
      sourceKind: 'candidate-set-sealed',
      sourceRef: ob.sourceRef,
      handoffKind: 'run-gate',
      result: { verdict: 'accepted' },
    }),
    owner: 'reconciler-1',
    fence: leaseFence(1),
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completionReceipt, 'gate-run/workplace-1/receipt-1');
  assert.equal(completed.leaseOwner, null);
  assert.ok(completed.completedAt);
});

// ===========================================================================
// 4. Crash after lease — lease expires, recovery re-leases and completes.
//    Converges to ONE receipt.
// ===========================================================================
test('Phase 2: crash after lease → lease expiry → recovery converges to one receipt', () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  const ob = ledger.append(sampleObligation());

  // First lease (simulating a crash mid-execution — no completion recorded).
  assert.ok(ledger.lease(ob.obligationKey, 'reconciler-1', leaseFence(1)));
  // A second lease attempt while the first is live FAILS (lease held).
  assert.equal(ledger.lease(ob.obligationKey, 'reconciler-2', leaseFence(2)), false);

  // Simulate lease expiry by backdating the lease_expires_at.
  db.prepare(
    `UPDATE factory_transition_obligations SET lease_expires_at = '2020-01-01 00:00:00'`,
  ).run();

  // Recovery: a new lease succeeds after expiry.
  assert.ok(ledger.lease(ob.obligationKey, 'reconciler-2', leaseFence(2)));
  const afterRecovery = ledger.get(ob.obligationKey);
  assert.equal(afterRecovery.state, 'in_progress');
  assert.equal(afterRecovery.attempt, 2);
  assert.equal(afterRecovery.leaseOwner, 'reconciler-2');
  // C7-02 storage split: the lease fence lives on the DISTINCT lease_fence
  // column; the causal `fence` (revision 1 from append) is preserved across
  // leases and never overwritten.
  assert.equal(afterRecovery.leaseFence, 2);
  assert.equal(afterRecovery.fence, 1);

  // Complete with the SAME receipt the original would have produced.
  const completed = ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'gate-run/workplace-1/receipt-1',
    resultDigest: 'sha256:result',
    owner: 'reconciler-2',
    fence: leaseFence(2),
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completionReceipt, 'gate-run/workplace-1/receipt-1');
  assert.equal(completed.attempt, 2);
});

// ===========================================================================
// 5. Idempotent completion — completing twice with the SAME receipt is a no-op.
// ===========================================================================
test('Phase 2: idempotent completion — same receipt is a no-op', () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  const ob = ledger.append(sampleObligation());
  ledger.lease(ob.obligationKey, 'r1', leaseFence(1));
  const first = ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'receipt-A',
    resultDigest: 'sha256:A',
    owner: 'r1',
    fence: leaseFence(1),
  });
  const second = ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'receipt-A',
    resultDigest: 'sha256:A',
    owner: 'r1',
    fence: leaseFence(1),
  });
  assert.equal(first.state, 'completed');
  assert.equal(second.state, 'completed');
  assert.deepEqual(first, second);
});

// ===========================================================================
// 6. Divergent completion — a DIFFERENT receipt after convergence is rejected.
// ===========================================================================
test('Phase 2: divergent completion receipt is rejected', () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  const ob = ledger.append(sampleObligation());
  ledger.lease(ob.obligationKey, 'r1', leaseFence(1));
  ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'receipt-A',
    resultDigest: 'sha256:A',
    owner: 'r1',
    fence: leaseFence(1),
  });
  assert.throws(
    () => ledger.complete({
      obligationKey: ob.obligationKey,
      completionReceipt: 'receipt-B',
      resultDigest: 'sha256:B',
      owner: 'r1',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_ALREADY_COMPLETED/,
  );
});

// ===========================================================================
// 7. Reconciler convergence — full sweep dispatches and completes.
// ===========================================================================
test('Phase 2: reconciler dispatches a ready obligation to completion', async () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  const reconciler = new TransitionObligationReconciler(ledger);
  const handled = [];
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      handled.push(obligation.obligationKey);
      return {
        completionReceipt: `gate-receipt:${obligation.subjectRef}`,
        resultDigest: 'sha256:gate-result',
      };
    },
  });
  const ob = ledger.append(sampleObligation());
  const result = await reconciler.reconcile({ leaseOwner: 'rec-1', fence: leaseFence(1) });
  assert.equal(result.dispatched, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(handled, [ob.obligationKey]);
  assert.equal(ledger.get(ob.obligationKey).state, 'completed');
});

// ===========================================================================
// 8. Reconciler crash recovery — first sweep crashes (handler throws),
//    second sweep re-dispatches and completes. Converges to one receipt.
// ===========================================================================
test('Phase 2: reconciler crash mid-execution → retry converges to one receipt', async () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  const reconciler = new TransitionObligationReconciler(ledger);
  let calls = 0;
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute() {
      calls += 1;
      if (calls === 1) throw new Error('simulated crash');
      return {
        completionReceipt: 'gate-run/workplace-1/receipt-1',
        resultDigest: 'sha256:gate-result',
      };
    },
  });
  ledger.append(sampleObligation());

  // First sweep: handler crashes. Obligation returns to pending.
  const r1 = await reconciler.reconcile({ leaseOwner: 'rec-1', fence: leaseFence(1) });
  assert.equal(r1.dispatched, 1);
  assert.equal(r1.failed, 1);

  // Second sweep: the obligation failed back to pending and is ready again.
  const r2 = await reconciler.reconcile({ leaseOwner: 'rec-1', fence: leaseFence(2) });
  assert.equal(r2.dispatched, 1);
  assert.equal(r2.completed, 1);

  // Converged: exactly one completion receipt, two handler calls.
  assert.equal(calls, 2);
  const all = db.prepare(
    'SELECT completion_receipt, state FROM factory_transition_obligations',
  ).get();
  assert.equal(all.state, 'completed');
  assert.equal(all.completion_receipt, 'gate-run/workplace-1/receipt-1');
});

// ===========================================================================
// 9. Reconciler skips obligations with no registered handler (Phase 2
//    substrate — handlers are registered in Phase 8).
// ===========================================================================
test('Phase 2: reconciler skips obligations without a registered handler', async () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  const reconciler = new TransitionObligationReconciler(ledger);
  // No handler registered for 'run-gate'.
  ledger.append(sampleObligation({ handoffKind: 'run-gate' }));
  const result = await reconciler.reconcile({ leaseOwner: 'rec-1', fence: leaseFence(1) });
  assert.equal(result.dispatched, 0);
  assert.equal(result.skipped, 1);
  // Obligation stays pending — no handler, no lease acquired.
  assert.equal(ledger.get(ledger.findReady()[0].obligationKey).state, 'pending');
});
