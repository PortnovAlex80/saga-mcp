// tests/infrastructure/transition-obligation-lease-fence-completion.test.mjs
//
// ADR-053 C7-04 — FENCE OBLIGATION COMPLETION BY LEASE TOKEN.
//
// C7-02 gave the lease fence durable, monotonic storage. C7-03 made allocation
// atomic and store-minted. C7-04 closes the completion seam: the obligation
// ledger's `complete()` now REQUIRES the lease owner AND the lease fence, and
// REJECTS a completion whose fence is LOWER than the obligation's stored
// monotonic `lease_fence`. A stale lease holder (an older fence) can therefore
// NOT complete work that a newer fence has since taken over — takeover revokes
// the old holder's authority to finish the handoff.
//
// This file proves the five C7-04 guarantees:
//   1. LEGITIMATE PATH — completion with the current owner + a valid (>= stored)
//      fence succeeds and converges the obligation.
//   2. REQUIRES OWNER — a completion without an owner (or with an empty owner)
//      fails closed; the obligation is NOT transitioned to completed.
//   3. REQUIRES FENCE — a completion without a fence (or with a wrongly-branded
//      token) fails closed; the obligation is NOT transitioned.
//   4. STALE FENCE REJECTED — after a NEWER fence takes the obligation over
//      (via lease / allocateLeaseFence / persistLeaseFence), a completion
//      presenting an older fence is REJECTED; the stale holder cannot complete.
//   5. STORED FENCE NEVER LOWERS — a completion attempt (successful or stale)
//      never decreases the stored monotonic `lease_fence`.
//
// Out of scope (later cards): fencing failure/reclaim/expiry transitions — C7-05.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
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

const COMPLETE_BASE = {
  completionReceipt: 'gate-run/w1/receipt-1',
  resultDigest: 'sha256:result',
};

// ===========================================================================
// 1. LEGITIMATE PATH — the current lease holder completes with its current
//    (>= stored) fence and the obligation converges to exactly one receipt.
// ===========================================================================
test('C7-04: current owner + valid fence completes the obligation', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));
  const completed = ledger.complete({
    ...COMPLETE_BASE,
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(1),
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completionReceipt, 'gate-run/w1/receipt-1');
  assert.equal(completed.leaseOwner, null, 'completion releases the lease');
});

// And a fence EQUAL to the stored fence is accepted (boundary: not strictly
// greater, but current). This is the canonical reconciler case.
test('C7-04: fence equal to the stored lease_fence is accepted (current holder)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  // Allocate twice so the stored fence is 2; lease under that current fence.
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 1);
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 2);
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(2)));

  const completed = ledger.complete({
    ...COMPLETE_BASE,
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(2), // == stored lease_fence (2)
  });
  assert.equal(completed.state, 'completed');
});

// ===========================================================================
// 2. REQUIRES OWNER — a completion without an owner (or with an empty owner)
//    fails closed. The obligation stays NOT completed.
// ===========================================================================
test('C7-04: completion without an owner is rejected (fails closed)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  assert.throws(
    () => ledger.complete({
      ...COMPLETE_BASE,
      obligationKey: ob.obligationKey,
      fence: leaseFence(1),
      // owner omitted
    }),
    /TRANSITION_OBLIGATION_COMPLETION_REQUIRES_OWNER/,
  );
  // Fail closed: the obligation was NOT transitioned to completed.
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

test('C7-04: completion with an empty/whitespace owner is rejected (fails closed)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  for (const badOwner of ['', '   ']) {
    assert.throws(
      () => ledger.complete({
        ...COMPLETE_BASE,
        obligationKey: ob.obligationKey,
        owner: badOwner,
        fence: leaseFence(1),
      }),
      /TRANSITION_OBLIGATION_COMPLETION_REQUIRES_OWNER/,
    );
  }
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ===========================================================================
// 3. REQUIRES FENCE — a completion without a fence fails closed. A causal
//    source revision is NOT a lease token, so it is rejected at the brand seam.
// ===========================================================================
test('C7-04: completion without a fence is rejected (fails closed)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  assert.throws(
    () => ledger.complete({
      ...COMPLETE_BASE,
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      // fence omitted
    }),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

test('C7-04: completion with a CausalSourceRevision (not a LeaseFence) is rejected at the brand seam', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));

  assert.throws(
    () => ledger.complete({
      ...COMPLETE_BASE,
      obligationKey: ob.obligationKey,
      owner: 'rec-1',
      fence: causalSourceRevision(1), // wrong brand — provenance is not a lease token
    }),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ===========================================================================
// 4. STALE FENCE REJECTED — after a NEWER fence takes the obligation over, a
//    completion presenting an OLDER fence is rejected. The stale lease holder
//    cannot complete work the newer fence now owns. Proven for each of the three
//    paths that can raise the stored monotonic fence: allocate, lease, persist.
// ===========================================================================
test('C7-04: stale fence rejected after a newer allocation (stale holder cannot complete)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  // rec-old leases under fence 1.
  assert.ok(ledger.lease(ob.obligationKey, 'rec-old', leaseFence(1)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 1);

  // A newer fence (2) is allocated — the obligation is now owned by fence 2.
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 2);
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 2);

  // rec-old (stale, fence 1) attempts to complete — REJECTED.
  assert.throws(
    () => ledger.complete({
      ...COMPLETE_BASE,
      obligationKey: ob.obligationKey,
      owner: 'rec-old',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  // Not completed; only the current fence (2) can complete.
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
  // The current fence holder completes successfully.
  const completed = ledger.complete({
    ...COMPLETE_BASE,
    obligationKey: ob.obligationKey,
    owner: 'rec-old',
    fence: leaseFence(2),
  });
  assert.equal(completed.state, 'completed');
});

test('C7-04: stale fence rejected after a newer lease (takeover revokes old holder authority)', () => {
  const { ledger, db } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  // rec-old leases under fence 1.
  assert.ok(ledger.lease(ob.obligationKey, 'rec-old', leaseFence(1)));

  // Lease expires; rec-new takes over under a strictly higher fence (2).
  db.prepare(
    `UPDATE factory_transition_obligations SET lease_expires_at = '2020-01-01 00:00:00'`,
  ).run();
  assert.ok(ledger.lease(ob.obligationKey, 'rec-new', leaseFence(2)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 2);
  assert.equal(ledger.get(ob.obligationKey).leaseOwner, 'rec-new');

  // rec-old (stale, fence 1) attempts to complete — REJECTED: takeover happened.
  assert.throws(
    () => ledger.complete({
      ...COMPLETE_BASE,
      obligationKey: ob.obligationKey,
      owner: 'rec-old',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

test('C7-04: stale fence rejected after a newer persistLeaseFence (pre-reserved higher fence)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  // rec-old leases under fence 1.
  assert.ok(ledger.lease(ob.obligationKey, 'rec-old', leaseFence(1)));
  // A higher fence (5) is pre-reserved via persistLeaseFence (no lease taken).
  assert.equal(ledger.persistLeaseFence(ob.obligationKey, leaseFence(5)), 5);

  // rec-old (stale, fence 1) attempts to complete — REJECTED.
  assert.throws(
    () => ledger.complete({
      ...COMPLETE_BASE,
      obligationKey: ob.obligationKey,
      owner: 'rec-old',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ===========================================================================
// 5. STORED FENCE NEVER LOWERS — a completion attempt never decreases the
//    stored monotonic `lease_fence`. Confirmed for a successful completion
//    (which must not touch the column) and for a stale-rejected attempt (which
//    must not have lowered the floor that just rejected it).
// ===========================================================================
test('C7-04: stored lease_fence never decreases across a successful completion', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(7)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 7);

  const completed = ledger.complete({
    ...COMPLETE_BASE,
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(7),
  });
  assert.equal(completed.state, 'completed');
  // The stored monotonic fence is preserved — completion did not lower it.
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 7);
  // Idempotent re-completion does not lower it either.
  ledger.complete({
    ...COMPLETE_BASE,
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(7),
  });
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 7);
});

test('C7-04: a stale-rejected completion does not lower the stored fence', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(10)));
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 10);

  // Stale attempt with a much lower fence — rejected.
  assert.throws(
    () => ledger.complete({
      ...COMPLETE_BASE,
      obligationKey: ob.obligationKey,
      owner: 'rec-stale',
      fence: leaseFence(1),
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  // The stored fence is unchanged — the rejected attempt lowered nothing.
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 10);
  assert.equal(ledger.get(ob.obligationKey).state, 'in_progress');
});

// ===========================================================================
// 6. Idempotent re-completion of a converged obligation still requires owner +
//    fence (no anonymous re-completion), but a stale fence is not re-checked on
//    the converged read path.
// ===========================================================================
test('C7-04: idempotent re-completion still requires owner + fence (converged read is fenced too)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));
  const first = ledger.complete({
    ...COMPLETE_BASE,
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(1),
  });
  // Re-completion without owner/fence fails closed even on the converged path.
  assert.throws(
    () => ledger.complete({ ...COMPLETE_BASE, obligationKey: ob.obligationKey }),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  // Re-completion WITH owner+fence and the same receipt is a no-op return.
  const second = ledger.complete({
    ...COMPLETE_BASE,
    obligationKey: ob.obligationKey,
    owner: 'rec-1',
    fence: leaseFence(1),
  });
  assert.deepEqual(first, second);
});
