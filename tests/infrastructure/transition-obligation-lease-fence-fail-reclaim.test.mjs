// tests/infrastructure/transition-obligation-lease-fence-fail-reclaim.test.mjs
//
// ADR-053 C7-05 — FENCE OBLIGATION FAILURE, EXPIRY, AND RECLAIM TRANSITIONS.
//
// C7-04 fenced COMPLETION by the lease token. C7-05 extends the SAME fencing to
// the remaining state-mutating transitions — failure and reclaim (which covers
// the lease-expiry / lease-loss path) — so they are SYMMETRIC with completion:
//
//   * require owner + fence (fail closed without either);
//   * reject a stale (lower) fence after a newer fence has taken over;
//   * never lower the stored monotonic `lease_fence`;
//   * never alter a terminal (`completed` / `failed`) state from any
//     transition, stale or current.
//
// Crucially, this card keeps BUSINESS-HANDLER FAILURE (the effect itself
// failed — `fail`) DISTINCT from LEASE LOSS (the holder lost the fence —
// `reclaim`): `fail` records the business error on `last_error`, while
// `reclaim` records the `LEASE_LOSS_RECLAIM_MARKER` sentinel, so a reader can
// tell the two apart in the durable record.
//
// This file proves the C7-05 guarantees for BOTH fail and reclaim:
//   1. LEGITIMATE PATH — current owner + valid (>= stored) fence succeeds.
//   2. REQUIRES OWNER — without an owner (or with an empty owner) fails closed.
//   3. REQUIRES FENCE — without a fence (or with a wrongly-branded token) fails
//      closed.
//   4. STALE FENCE REJECTED — after a newer fence takes over, an older fence is
//      rejected; the stale holder cannot fail/reclaim.
//   5. STORED FENCE NEVER LOWERS — a fail/reclaim attempt never decreases the
//      stored monotonic `lease_fence`.
//   6. TERMINAL STATE PROTECTED — a stale (or even current) transition cannot
//      change a terminal state.
//   7. BUSINESS FAILURE ≠ LEASE LOSS — the two transitions record distinct,
//      distinguishable markers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  SqliteTransitionObligationLedger,
  LEASE_LOSS_RECLAIM_MARKER,
} from '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import {
  causalSourceRevision,
  leaseFence,
} from '../../dist/process-modules/domain/transition-obligation.js';

const BASE_APPEND = {
  sourceKind: 'candidate-set-sealed',
  sourceRef: 'candidate-set/w1/exec-a',
  sourceDigest: 'sha256:source-fact',
  subjectRef: 'workplace/1/cell/item',
  handoffKind: 'run-gate',
  ownerCapability: 'gate-run-driver',
};

function freshLedger() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return { ledger: new SqliteTransitionObligationLedger(db), db };
}

// Backdate the live lease so a takeover lease can succeed without waiting.
function expireLease(db, key) {
  db.prepare(
    `UPDATE factory_transition_obligations SET lease_expires_at = '2020-01-01 00:00:00'
      WHERE obligation_key = ?`,
  ).run(key);
}

// =============================================================================
//  FAILURE (`fail`) — business-handler failure fencing, symmetric with complete.
// =============================================================================

// ---------------------------------------------------------------------------
// 1. LEGITIMATE PATH — the current lease holder fails with its current
//    (>= stored) fence; the obligation returns to pending for retry and the
//    business error is recorded.
// ---------------------------------------------------------------------------
test('C7-05 fail: current owner + valid fence returns the obligation to pending', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  const failed = ledger.fail({
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(1),
    error: 'simulated business crash',
  });
  assert.equal(failed.state, 'pending', 'failure returns to pending for retry');
  assert.equal(failed.lastError, 'simulated business crash', 'business error recorded');
  assert.equal(failed.leaseOwner, null, 'failure releases the lease');
  assert.equal(failed.leaseExpiresAt, null);
});

test('C7-05 fail: fence equal to the stored lease_fence is accepted (current holder)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 1);
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 2);
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(2)));

  const failed = ledger.fail({
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(2), // == stored lease_fence (2)
    error: 'boom',
  });
  assert.equal(failed.state, 'pending');
});

// ---------------------------------------------------------------------------
// 2. REQUIRES OWNER — a failure without an owner (or with an empty owner) fails
//    closed. The obligation is NOT transitioned.
// ---------------------------------------------------------------------------
test('C7-05 fail: without an owner is rejected (fails closed)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  assert.throws(
    () => ledger.fail({
      obligationKey: ob.obligationKey,
      fence: leaseFence(1),
      error: 'boom',
      // owner omitted
    }),
    /TRANSITION_OBLIGATION_FAILURE_REQUIRES_OWNER/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress', 'not transitioned');
});

test('C7-05 fail: empty/whitespace owner is rejected (fails closed)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  for (const badOwner of ['', '   ']) {
    assert.throws(
      () => ledger.fail({
        obligationKey: ob.obligationKey,
        owner: badOwner,
        fence: leaseFence(1),
        error: 'boom',
      }),
      /TRANSITION_OBLIGATION_FAILURE_REQUIRES_OWNER/,
    );
  }
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ---------------------------------------------------------------------------
// 3. REQUIRES FENCE — a failure without a fence fails closed. A causal source
//    revision is NOT a lease token, so it is rejected at the brand seam.
// ---------------------------------------------------------------------------
test('C7-05 fail: without a fence is rejected (fails closed)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  assert.throws(
    () => ledger.fail({
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      error: 'boom',
      // fence omitted
    }),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

test('C7-05 fail: a CausalSourceRevision (not a LeaseFence) is rejected at the brand seam', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  assert.throws(
    () => ledger.fail({
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      fence: causalSourceRevision(1), // wrong brand — provenance is not a lease token
      error: 'boom',
    }),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ---------------------------------------------------------------------------
// 4. STALE FENCE REJECTED — after a NEWER fence takes the obligation over, a
//    failure presenting an OLDER fence is rejected. The stale lease holder
//    cannot fail work the newer fence now owns.
// ---------------------------------------------------------------------------
test('C7-05 fail: stale fence rejected after a newer allocation', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-old', leaseFence(1)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 1);

  // A newer fence (2) is allocated — the obligation is now owned by fence 2.
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 2);
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 2);

  // rec-old (stale, fence 1) attempts to fail — REJECTED.
  assert.throws(
    () => ledger.fail({
      obligationKey: ob.obligationKey,
      owner: 'rec-old',
      fence: leaseFence(1),
      error: 'boom',
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress', 'not failed by stale holder');

  // The current fence holder fails successfully.
  const failed = ledger.fail({
    obligationKey: ob.obligationKey,
    owner: 'rec-old',
    fence: leaseFence(2),
    error: 'boom',
  });
  assert.equal(failed.state, 'pending');
});

test('C7-05 fail: stale fence rejected after a newer lease (takeover revokes authority)', () => {
  const { ledger, db } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-old', leaseFence(1)));

  // Lease expires; rec-new takes over under a strictly higher fence (2).
  expireLease(db, ob.obligationKey);
  assert.ok(ledger.lease(ob.obligationKey, 'rec-new', leaseFence(2)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 2);
  assert.equal(ledger.get(ob.obligationKey).leaseOwner, 'rec-new');

  // rec-old (stale, fence 1) attempts to fail — REJECTED: takeover happened.
  assert.throws(
    () => ledger.fail({
      obligationKey: ob.obligationKey,
      owner: 'rec-old',
      fence: leaseFence(1),
      error: 'boom',
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ---------------------------------------------------------------------------
// 5. STORED FENCE NEVER LOWERS — a failure attempt never decreases the stored
//    monotonic `lease_fence`, whether successful or stale-rejected.
// ---------------------------------------------------------------------------
test('C7-05 fail: stored lease_fence never decreases across a successful failure', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(7)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 7);

  ledger.fail({
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(7),
    error: 'boom',
  });
  // The stored monotonic fence is preserved — failure did not lower it.
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 7);
  assert.equal(ledger.get(ob.obligationKey).state, 'pending');
});

test('C7-05 fail: a stale-rejected failure does not lower the stored fence', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(10)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 10);

  assert.throws(
    () => ledger.fail({
      obligationKey: ob.obligationKey,
      owner: 'rec-stale',
      fence: leaseFence(1),
      error: 'boom',
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 10, 'rejected attempt lowered nothing');
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// =============================================================================
//  RECLAIM (`reclaim`) — lease-loss / expiry fencing, symmetric with complete.
//  Records the LEASE_LOSS_RECLAIM_MARKER, DISTINCT from a business failure.
// =============================================================================

// ---------------------------------------------------------------------------
// 1. LEGITIMATE PATH — the current lease holder reclaims with a valid (>=
//    stored) fence; the obligation returns to pending and the lease-loss
//    sentinel is recorded (NOT a business error).
// ---------------------------------------------------------------------------
test('C7-05 reclaim: current owner + valid fence returns the obligation to pending', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  const reclaimed = ledger.reclaim({
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(1),
  });
  assert.equal(reclaimed.state, 'pending', 'reclaim returns to pending for a fresh lease');
  assert.equal(reclaimed.lastError, LEASE_LOSS_RECLAIM_MARKER, 'lease-loss sentinel recorded');
  assert.equal(reclaimed.leaseOwner, null, 'reclaim releases the lease');
  assert.equal(reclaimed.leaseExpiresAt, null);
});

test('C7-05 reclaim: a newer holder reclaims after expiry takeover', () => {
  const { ledger, db } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-old', leaseFence(1)));
  expireLease(db, ob.obligationKey);
  // rec-new takes over under fence 2 (the lease expired — lease loss).
  assert.ok(ledger.lease(ob.obligationKey, 'rec-new', leaseFence(2)));

  const reclaimed = ledger.reclaim({
    obligationKey: ob.obligationKey,
    owner: 'rec-new',
    fence: leaseFence(2),
  });
  assert.equal(reclaimed.state, 'pending');
  assert.equal(reclaimed.lastError, LEASE_LOSS_RECLAIM_MARKER);
});

// ---------------------------------------------------------------------------
// 2. REQUIRES OWNER — a reclaim without an owner fails closed.
// ---------------------------------------------------------------------------
test('C7-05 reclaim: without an owner is rejected (fails closed)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  assert.throws(
    () => ledger.reclaim({
      obligationKey: ob.obligationKey,
      fence: leaseFence(1),
      // owner omitted
    }),
    /TRANSITION_OBLIGATION_RECLAIM_REQUIRES_OWNER/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress', 'not transitioned');
});

test('C7-05 reclaim: empty/whitespace owner is rejected (fails closed)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  for (const badOwner of ['', '   ']) {
    assert.throws(
      () => ledger.reclaim({
        obligationKey: ob.obligationKey,
        owner: badOwner,
        fence: leaseFence(1),
      }),
      /TRANSITION_OBLIGATION_RECLAIM_REQUIRES_OWNER/,
    );
  }
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ---------------------------------------------------------------------------
// 3. REQUIRES FENCE — a reclaim without a fence fails closed; a causal source
//    revision is rejected at the brand seam.
// ---------------------------------------------------------------------------
test('C7-05 reclaim: without a fence is rejected (fails closed)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  assert.throws(
    () => ledger.reclaim({
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      // fence omitted
    }),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

test('C7-05 reclaim: a CausalSourceRevision is rejected at the brand seam', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  assert.throws(
    () => ledger.reclaim({
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      fence: causalSourceRevision(1),
    }),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ---------------------------------------------------------------------------
// 4. STALE FENCE REJECTED — a stale holder cannot reclaim an obligation a newer
//    fence owns; only the current (>= stored) fence may reclaim.
// ---------------------------------------------------------------------------
test('C7-05 reclaim: stale fence rejected after a newer allocation', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-old', leaseFence(1)));
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 2);

  // rec-old (stale, fence 1) attempts to reclaim — REJECTED.
  assert.throws(
    () => ledger.reclaim({
      obligationKey: ob.obligationKey,
      owner: 'rec-old',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress', 'not reclaimed by stale holder');

  // The current fence holder reclaims successfully.
  const reclaimed = ledger.reclaim({
    obligationKey: ob.obligationKey,
    owner: 'rec-old',
    fence: leaseFence(2),
  });
  assert.equal(reclaimed.state, 'pending');
  assert.equal(reclaimed.lastError, LEASE_LOSS_RECLAIM_MARKER);
});

test('C7-05 reclaim: stale fence rejected after a newer lease (takeover)', () => {
  const { ledger, db } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-old', leaseFence(1)));
  expireLease(db, ob.obligationKey);
  assert.ok(ledger.lease(ob.obligationKey, 'rec-new', leaseFence(2)));

  assert.throws(
    () => ledger.reclaim({
      obligationKey: ob.obligationKey,
      owner: 'rec-old',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ---------------------------------------------------------------------------
// 5. STORED FENCE NEVER LOWERS — a reclaim attempt never decreases the stored
//    monotonic `lease_fence`.
// ---------------------------------------------------------------------------
test('C7-05 reclaim: stored lease_fence never decreases across a successful reclaim', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(7)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 7);

  ledger.reclaim({
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(7),
  });
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 7, 'reclaim did not lower the fence');
  assert.equal(ledger.get(ob.obligationKey).state, 'pending');
});

test('C7-05 reclaim: a stale-rejected reclaim does not lower the stored fence', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(10)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 10);

  assert.throws(
    () => ledger.reclaim({
      obligationKey: ob.obligationKey,
      owner: 'rec-stale',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 10);
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// =============================================================================
//  6. TERMINAL STATE PROTECTED — a stale (or even current) transition cannot
//    change a terminal state. A converged obligation cannot be failed or
//    reclaimed back to pending.
// =============================================================================
test('C7-05: a completed obligation cannot be failed (terminal state protected)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));
  ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'gate-run/w1/receipt-1',
    resultDigest: 'sha256:result',
    owner: 'rec-1',
    fence: leaseFence(1),
  });
  assert.equal(ledger.get(ob.obligationKey).state, 'completed');

  // Even the CURRENT fence cannot un-complete the obligation.
  assert.throws(
    () => ledger.fail({
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      fence: leaseFence(1),
      error: 'late boom',
    }),
    /TRANSITION_OBLIGATION_TERMINAL/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'completed', 'terminal state preserved');
});

test('C7-05: a completed obligation cannot be reclaimed (terminal state protected)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));
  ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'gate-run/w1/receipt-1',
    resultDigest: 'sha256:result',
    owner: 'rec-1',
    fence: leaseFence(1),
  });

  assert.throws(
    () => ledger.reclaim({
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_TERMINAL/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'completed');
});

test('C7-05: a STALE failure cannot change a terminal state after takeover', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));
  ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'gate-run/w1/receipt-1',
    resultDigest: 'sha256:result',
    owner: 'rec-1',
    fence: leaseFence(1),
  });
  // A newer fence (2) is allocated after convergence.
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 2);

  // A stale holder (fence 1) attempts to fail the completed obligation.
  assert.throws(
    () => ledger.fail({
      obligationKey: ob.obligationKey,
      owner: 'rec-stale',
      fence: leaseFence(1),
      error: 'boom',
    }),
    /TRANSITION_OBLIGATION_TERMINAL/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'completed', 'stale transition left terminal state intact');
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 2, 'fence not lowered');
});

test('C7-05: a STALE reclaim cannot change a terminal state after takeover', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));
  ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'gate-run/w1/receipt-1',
    resultDigest: 'sha256:result',
    owner: 'rec-1',
    fence: leaseFence(1),
  });
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 2);

  assert.throws(
    () => ledger.reclaim({
      obligationKey: ob.obligationKey,
      owner: 'rec-stale',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_TERMINAL/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'completed');
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 2);
});

test('C7-05: a permanently-failed (failed) obligation is also terminal-protected', () => {
  const { ledger, db } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  // Force the obligation into the terminal 'failed' state directly (no ledger
  // path produces it today; the guard must still protect it).
  db.prepare(
    `UPDATE factory_transition_obligations SET state = 'failed' WHERE obligation_key = ?`,
  ).run(ob.obligationKey);
  assert.equal(ledger.get(ob.obligationKey).state, 'failed');

  assert.throws(
    () => ledger.fail({
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      fence: leaseFence(1),
      error: 'boom',
    }),
    /TRANSITION_OBLIGATION_TERMINAL/,
  );
  assert.throws(
    () => ledger.reclaim({
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_TERMINAL/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'failed', 'terminal failed state preserved');
});

// =============================================================================
//  7. BUSINESS FAILURE ≠ LEASE LOSS — fail records the business error; reclaim
//    records the LEASE_LOSS_RECLAIM_MARKER. The two are distinguishable.
// =============================================================================
test('C7-05: business failure and lease-loss reclaim record distinguishable markers', () => {
  const { ledger } = freshLedger();
  const obFail = ledger.append({
    ...BASE_APPEND,
    sourceRef: 'candidate-set/w1/exec-fail',
    causalSourceRevision: causalSourceRevision(1),
  });
  const obReclaim = ledger.append({
    ...BASE_APPEND,
    sourceRef: 'candidate-set/w1/exec-reclaim',
    causalSourceRevision: causalSourceRevision(1),
  });

  // Business failure: the effect threw.
  assert.ok(ledger.lease(obFail.obligationKey, 'rec-1', leaseFence(1)));
  ledger.fail({
    obligationKey: obFail.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(1),
    error: 'EFFECT_FAILED: handler threw',
  });

  // Lease loss: the holder lost the fence (NOT a business failure).
  assert.ok(ledger.lease(obReclaim.obligationKey, 'rec-1', leaseFence(1)));
  ledger.reclaim({
    obligationKey: obReclaim.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(1),
  });

  const afterFail = ledger.get(obFail.obligationKey);
  const afterReclaim = ledger.get(obReclaim.obligationKey);

  // Both return to pending (retryable), but the recorded markers differ.
  assert.equal(afterFail.state, 'pending');
  assert.equal(afterReclaim.state, 'pending');
  assert.equal(afterFail.lastError, 'EFFECT_FAILED: handler threw', 'business error recorded');
  assert.equal(afterReclaim.lastError, LEASE_LOSS_RECLAIM_MARKER, 'lease-loss sentinel recorded');
  assert.notEqual(
    afterFail.lastError,
    afterReclaim.lastError,
    'business failure is distinguishable from lease loss',
  );
  // The marker is itself distinguishable from any business error: a reader can
  // test `lastError === LEASE_LOSS_RECLAIM_MARKER` to detect lease loss.
  assert.notEqual(afterFail.lastError, LEASE_LOSS_RECLAIM_MARKER, 'fail did not write the lease-loss sentinel');
  assert.equal(afterReclaim.lastError, LEASE_LOSS_RECLAIM_MARKER, 'reclaim wrote the lease-loss sentinel');
});
