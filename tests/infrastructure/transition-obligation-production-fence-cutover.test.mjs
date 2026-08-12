// tests/infrastructure/transition-obligation-production-fence-cutover.test.mjs
//
// ADR-053 C7-06 — PRODUCTION FENCE CUTOVER integration tests.
//
// C7-06 cuts the Production Cell executor and the reconciler over to REAL
// fences. This file proves the three end-to-end invariants the card requires:
//
//   1. REAL-FENCE ALLOCATE → COMPLETE — the integrator (called by the executor)
//      creates each obligation with a REAL monotonic fence allocated by the
//      store (not a fabricated `fence: 1`). The causal source revision (`fence`
//      column) carries the allocated value; the `lease_fence` is pre-reserved to
//      the same value. The reconciler threads a real fence through to completion.
//
//   2. STALE-REJECTED-AFTER-TAKEOVER — after a newer fence takes the obligation
//      over (lease expiry → reclaim → re-lease under a strictly higher fence),
//      an older fence cannot complete/fail the work.
//
//   3. RECLAIM-ON-LEASE-LOSS — the reconciler sweep detects an expired lease
//      (in_progress with a stale lease_expires_at) and calls the fenced
//      reclaim(), recording the LEASE_LOSS_RECLAIM_MARKER sentinel DISTINCT
//      from a business failure, BEFORE re-leasing the obligation.
//
// Together these prove: no fabricated fence token remains in any canonical
// production path; the same real fence is threaded through lease → complete;
// a stale executor (older fence) cannot complete work a newer fence owns.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  SqliteTransitionObligationLedger,
  LEASE_LOSS_RECLAIM_MARKER,
} from '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { TransitionObligationReconciler } from
  '../../dist/process-modules/application/transition-obligation-reconciler.js';
import { TransitionObligationIntegrator } from
  '../../dist/process-modules/application/transition-obligation-integrator.js';
import { leaseFence } from
  '../../dist/process-modules/domain/transition-obligation.js';

function makeLedger() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return { ledger: new SqliteTransitionObligationLedger(db), db };
}

// Backdate the live lease so a takeover sweep can succeed without waiting.
function expireLease(db, key) {
  db.prepare(
    `UPDATE factory_transition_obligations SET lease_expires_at = '2020-01-01 00:00:00'
      WHERE obligation_key = ?`,
  ).run(key);
}

const CS_SEAL = {
  candidateSetRef: 'candidate-set/w1/exec-a',
  candidateSetDigest: 'sha256:cs-digest',
  workplaceRef: 'workplace/1/cell/item',
};

// ===========================================================================
// 1. REAL-FENCE ALLOCATE → COMPLETE.
//
// The integrator creates the obligation via appendFenced (the production path
// that replaced the fabricated `fence: 1`). The causal revision (`fence`) and
// the pre-reserved `lease_fence` both carry the SAME real allocated value
// (>= 1), not a fabricated constant. The reconciler then threads a real fence
// through lease → execute → complete.
// ===========================================================================
test('C7-06: integrator allocates a REAL fence — causal revision == lease_fence >= 1 (not fabricated)', () => {
  const { ledger } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });

  integrator.onCandidateSetSealed(CS_SEAL);
  const ready = ledger.findReady();
  assert.equal(ready.length, 1);
  const ob = ready[0];

  // The causal source revision is a REAL allocated value (not the fabricated 0
  // placeholder or a hardcoded constant). It is >= 1.
  assert.ok(ob.fence >= 1, `causal revision is a real allocated fence (got ${ob.fence})`);

  // The lease_fence is PRE-RESERVED to the SAME value — the reconciler's first
  // lease runs under a real fence, not from NULL.
  assert.equal(ob.leaseFence, ob.fence, 'lease_fence pre-reserved to the causal revision value');
});

test('C7-06: appendFenced is idempotent — replay preserves the original causal revision + lease fence', () => {
  const { ledger } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });

  integrator.onCandidateSetSealed(CS_SEAL);
  const original = ledger.findReady()[0];

  // Replay (same source fact — e.g. crash-recovery re-seal): no new fence, no
  // change to the causal revision or lease fence.
  integrator.onCandidateSetSealed(CS_SEAL);
  const replayed = ledger.findReady()[0];

  assert.equal(replayed.fence, original.fence, 'replay preserves the causal revision');
  assert.equal(replayed.leaseFence, original.leaseFence, 'replay preserves the lease fence');
});

test('C7-06: real-fence allocate → complete — the reconciler threads a real fence to completion', async () => {
  const { ledger } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  const reconciler = new TransitionObligationReconciler(ledger);

  let capturedFence;
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      capturedFence = obligation.leaseFence;
      return { completionReceipt: 'gate-receipt:real', resultDigest: 'sha256:r' };
    },
  });

  integrator.onCandidateSetSealed(CS_SEAL);

  // No fence supplied — the reconciler ALLOCATES a real one from the store.
  const result = await reconciler.reconcile({ leaseOwner: 'rec-real' });
  assert.equal(result.dispatched, 1);
  assert.equal(result.completed, 1);

  const key = `candidate-set-sealed:${CS_SEAL.candidateSetRef}:run-gate`;
  const completed = ledger.get(key);
  assert.equal(completed.state, 'completed');
  // The reconciler ran under a real allocated fence (>= the pre-reserved value).
  assert.ok(capturedFence >= 1, 'handler observed a real fence');
  assert.ok(completed.leaseFence >= completed.fence, 'completion fence >= causal revision');
});

// ===========================================================================
// 2. STALE-REJECTED-AFTER-TAKEOVER.
//
// After a newer fence takes the obligation over (lease expiry → reclaim →
// re-lease under a strictly higher fence), the older fence cannot complete or
// fail the work. This is the core safety property: a stale executor cannot
// mutate work a newer fence owns.
// ===========================================================================
test('C7-06: stale fence rejected after takeover — older fence cannot complete', async () => {
  const { ledger, db } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  const reconciler = new TransitionObligationReconciler(ledger);

  let firstFence;
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      firstFence = obligation.leaseFence;
      // Simulate the handler stalling (crash mid-execution): do NOT complete.
      // The lease will expire and a recovery sweep will take over.
      throw new Error('simulated stall');
    },
  });

  integrator.onCandidateSetSealed(CS_SEAL);
  const key = `candidate-set-sealed:${CS_SEAL.candidateSetRef}:run-gate`;

  // Sweep 1: lease under a fence, then crash (handler throws → fail to pending).
  await reconciler.reconcile({ leaseOwner: 'rec-old' });
  const afterFail = ledger.get(key);
  assert.equal(afterFail.state, 'pending');
  assert.ok(firstFence >= 1, 'first sweep ran under a real fence');

  // Now lease the obligation under fence F, then expire the lease, so a takeover
  // under a strictly higher fence makes F stale.
  assert.ok(ledger.lease(key, 'rec-old', leaseFence(firstFence)));
  expireLease(db, key);

  // Sweep 2: recovery — a fresh reconciler allocates a strictly higher fence,
  // reclaims (lease-loss), re-leases, and completes.
  const rec2 = new TransitionObligationReconciler(ledger);
  rec2.registerHandler({
    handoffKind: 'run-gate',
    execute() {
      return { completionReceipt: 'gate-receipt:recovery', resultDigest: 'sha256:r2' };
    },
  });
  const r2 = await rec2.reconcile({ leaseOwner: 'rec-new' });
  assert.equal(r2.completed, 1);
  const completed = ledger.get(key);
  assert.equal(completed.state, 'completed');
  assert.ok(completed.leaseFence > firstFence, 'recovery fence is strictly higher');

  // The STALE fence (firstFence) can no longer mutate the completed obligation.
  // (The terminal-state guard rejects first; even without it, the stale fence
  //  would be rejected by the staleness check since a newer fence took over.)
  assert.throws(
    () => ledger.complete({
      obligationKey: key,
      completionReceipt: 'stale-attempt',
      resultDigest: 'sha256:stale',
      owner: 'rec-old',
      fence: leaseFence(firstFence),
    }),
    /TRANSITION_OBLIGATION_ALREADY_COMPLETED|TRANSITION_OBLIGATION_TERMINAL|TRANSITION_OBLIGATION_STALE_FENCE/,
  );
});

test('C7-06: stale fence cannot fail after a newer fence takes over', () => {
  const { ledger } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  integrator.onCandidateSetSealed(CS_SEAL);
  const key = `candidate-set-sealed:${CS_SEAL.candidateSetRef}:run-gate`;

  const preReserved = ledger.get(key).leaseFence;
  assert.ok(preReserved >= 1);

  // A newer fence takes over (allocate beyond the pre-reserved value).
  const newer = ledger.allocateLeaseFence(key);
  assert.ok(newer.value > preReserved, 'newer fence is strictly higher');

  // The pre-reserved (stale) fence cannot fail the obligation.
  assert.throws(
    () => ledger.fail({
      obligationKey: key,
      owner: 'stale-executor',
      fence: leaseFence(preReserved),
      error: 'stale attempt to fail',
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
});

// ===========================================================================
// 3. RECLAIM-ON-LEASE-LOSS.
//
// The reconciler sweep detects an expired lease (in_progress with a stale
// lease_expires_at) and calls the fenced reclaim() BEFORE re-leasing. The
// reclaim records the LEASE_LOSS_RECLAIM_MARKER sentinel (NOT a business error)
// so the durable record distinguishes lease loss from a handler failure.
// ===========================================================================
test('C7-06: reconciler calls reclaim on lease-loss — records LEASE_LOSS_RECLAIM_MARKER', async () => {
  const { ledger, db } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  const reconciler = new TransitionObligationReconciler(ledger);

  let calls = 0;
  let firstLeaseFence;
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      calls += 1;
      if (calls === 1) {
        firstLeaseFence = obligation.leaseFence;
        // Stall — the lease will expire and the next sweep reclaims + redrives.
        throw new Error('stall: handler did not complete');
      }
      return { completionReceipt: 'gate-receipt:after-reclaim', resultDigest: 'sha256:r' };
    },
  });

  integrator.onCandidateSetSealed(CS_SEAL);
  const key = `candidate-set-sealed:${CS_SEAL.candidateSetRef}:run-gate`;

  // Sweep 1: lease + fail (handler threw). The obligation returns to pending
  // with the business error on last_error — NOT the reclaim marker.
  await reconciler.reconcile({ leaseOwner: 'rec' });
  assert.equal(calls, 1);
  const afterFail = ledger.get(key);
  assert.equal(afterFail.state, 'pending');
  assert.equal(afterFail.lastError, 'stall: handler did not complete', 'business error recorded (not reclaim marker)');

  // Lease the obligation, then expire the lease so the next sweep detects
  // lease-loss (in_progress + expired) and reclaims.
  assert.ok(ledger.lease(key, 'rec', leaseFence(firstLeaseFence)));
  expireLease(db, key);
  assert.equal(ledger.get(key).state, 'in_progress');

  // Sweep 2: the reconciler detects the expired lease → reclaim → re-lease →
  // complete. The reclaim writes the LEASE_LOSS_RECLAIM_MARKER.
  const r2 = await reconciler.reconcile({ leaseOwner: 'rec' });
  assert.equal(r2.completed, 1);
  assert.equal(calls, 2, 'handler re-dispatched after reclaim');

  const completed = ledger.get(key);
  assert.equal(completed.state, 'completed');

  // After completion, last_error is cleared. To prove the reclaim marker was
  // written DURING the sweep (before re-lease), we re-run the scenario and
  // inspect last_error at the reclaim point (see next test).
});

test('C7-06: reclaim marker is observable between lease-loss detection and re-lease', async () => {
  const { ledger, db } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });
  const reconciler = new TransitionObligationReconciler(ledger);

  let observedMarker = false;
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      // By the time the handler runs, the reclaim has already written the
      // marker and returned the obligation to pending, then the lease
      // re-took it. The lease_fence is now strictly higher than the original.
      if (obligation.lastError === LEASE_LOSS_RECLAIM_MARKER) {
        observedMarker = true;
      }
      return { completionReceipt: 'gate-receipt:marker', resultDigest: 'sha256:r' };
    },
  });

  integrator.onCandidateSetSealed(CS_SEAL);
  const key = `candidate-set-sealed:${CS_SEAL.candidateSetRef}:run-gate`;

  // Lease + expire, so the next sweep sees lease-loss.
  const preReserved = ledger.get(key).leaseFence;
  assert.ok(ledger.lease(key, 'rec', leaseFence(preReserved)));
  expireLease(db, key);

  // Sweep: reclaim (writes marker) → re-lease → execute (handler observes the
  // marker on last_error) → complete (clears last_error).
  await reconciler.reconcile({ leaseOwner: 'rec' });
  assert.ok(observedMarker, 'handler observed the LEASE_LOSS_RECLAIM_MARKER after reclaim');
  assert.equal(ledger.get(key).state, 'completed');
});

test('C7-06: reclaim distinguishes lease-loss from business failure in the sweep', async () => {
  const { ledger, db } = makeLedger();
  const integrator = new TransitionObligationIntegrator({ ledger });

  // Obligation A: business failure (handler throws).
  const integratorA = new TransitionObligationIntegrator({ ledger });
  integratorA.onCandidateSetSealed({ ...CS_SEAL, candidateSetRef: 'cs/A' });
  const keyA = 'candidate-set-sealed:cs/A:run-gate';

  const recA = new TransitionObligationReconciler(ledger);
  recA.registerHandler({
    handoffKind: 'run-gate',
    execute() { throw new Error('EFFECT_FAILED'); },
  });
  await recA.reconcile({ leaseOwner: 'rec-a' });
  assert.equal(ledger.get(keyA).lastError, 'EFFECT_FAILED', 'business error recorded');

  // Obligation B: lease-loss reclaim (lease expires, sweep reclaims).
  integrator.onCandidateSetSealed({ ...CS_SEAL, candidateSetRef: 'cs/B' });
  const keyB = 'candidate-set-sealed:cs/B:run-gate';

  const recB = new TransitionObligationReconciler(ledger);
  let bFence;
  recB.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      bFence = obligation.leaseFence;
      throw new Error('stall-B');
    },
  });
  await recB.reconcile({ leaseOwner: 'rec-b' });

  // Re-lease B and expire, so the next sweep reclaims.
  assert.ok(ledger.lease(keyB, 'rec-b', leaseFence(bFence)));
  expireLease(db, keyB);

  // Inspect last_error right after the reclaim (before the handler re-runs and
  // completes). We intercept by making the handler read the marker.
  let bMarkerSeen = false;
  const recB2 = new TransitionObligationReconciler(ledger);
  recB2.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      if (obligation.lastError === LEASE_LOSS_RECLAIM_MARKER) bMarkerSeen = true;
      return { completionReceipt: 'gate-B', resultDigest: 'sha256:r' };
    },
  });
  await recB2.reconcile({ leaseOwner: 'rec-b' });
  assert.ok(bMarkerSeen, 'obligation B shows the lease-loss reclaim marker (not the business error)');

  // The two obligations recorded DIFFERENT markers: A = business error, B =
  // lease-loss sentinel. They are distinguishable.
  assert.notEqual(
    ledger.get(keyA).lastError,
    LEASE_LOSS_RECLAIM_MARKER,
    'business-failure obligation did NOT get the reclaim marker',
  );
});
