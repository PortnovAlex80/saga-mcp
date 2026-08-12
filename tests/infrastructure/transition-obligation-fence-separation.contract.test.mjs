// tests/infrastructure/transition-obligation-fence-separation.contract.test.mjs
//
// ADR-053 C7-01 — CONTRACT TEST proving the two concerns previously conflated
// on the transition-obligation `fence` column / parameter are DISTINCT and NOT
// interchangeable:
//
//   (a) CAUSAL SOURCE REVISION — identifies WHICH source fact/revision caused
//       the obligation (provenance). Not an ordering token.
//   (b) LEASE FENCE — a MONOTONIC ordering token that prevents a stale lease
//       holder from completing/failing newer work. Not a source-fact id.
//
// This file covers the RUNTIME side of the contract:
//   - the two brands are runtime-distinguishable (equal value, different kind);
//   - swapping them at the ledger seams (append / lease) is a REJECTED
//     operation (brand mismatch).
//
// The COMPILE-TIME side of the contract — the two types are structurally
// disjoint, so assigning a CausalSourceRevision where a LeaseFence is required
// (or vice versa) is a type error — is enforced by `npx tsc` over src/:
// `SqliteTransitionObligationLedger.append` accepts only CausalSourceRevision
// and `.lease` accepts only LeaseFence; `ReconcilerOptions.fence` is LeaseFence.
// `tests/` is outside tsconfig's `include`, so the type-level guarantee lives in
// the production signatures, not here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { TransitionObligationReconciler } from
  '../../dist/process-modules/application/transition-obligation-reconciler.js';
import {
  causalSourceRevision,
  leaseFence,
  isCausalSourceRevision,
  isLeaseFence,
} from '../../dist/process-modules/domain/transition-obligation.js';

function makeLedger() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return { ledger: new SqliteTransitionObligationLedger(db), db };
}

const BASE_APPEND = {
  sourceKind: 'candidate-set-sealed',
  sourceRef: 'candidate-set/w1/exec-a',
  sourceDigest: 'sha256:source-fact',
  subjectRef: 'workplace/1/cell/item',
  handoffKind: 'run-gate',
  ownerCapability: 'gate-run-driver',
};

// ===========================================================================
// 1. The two brands are distinct: equal numeric value does NOT make a causal
//    revision interchangeable with a lease fence.
// ===========================================================================
test('C7-01 contract: CausalSourceRevision and LeaseFence are distinct brands', () => {
  const rev = causalSourceRevision(1);
  const fence = leaseFence(1);

  // Same payload value, different identity of CONCEPT.
  assert.equal(rev.value, fence.value, 'both wrap the same number');
  assert.notEqual(rev.kind, fence.kind, 'different concept discriminant');

  assert.ok(isCausalSourceRevision(rev), 'rev is a causal revision');
  assert.ok(!isCausalSourceRevision(fence), 'a lease fence is NOT a causal revision');
  assert.ok(isLeaseFence(fence), 'fence is a lease fence');
  assert.ok(!isLeaseFence(rev), 'a causal revision is NOT a lease fence');
});

// ===========================================================================
// 2. append requires a CAUSAL SOURCE REVISION. A LeaseFence is rejected — a
//    lease fence is an ordering token, not source-fact provenance.
// ===========================================================================
test('C7-01 contract: append rejects a LeaseFence as the causal source revision', () => {
  const { ledger, db } = makeLedger();
  assert.throws(
    () => ledger.append({ ...BASE_APPEND, causalSourceRevision: leaseFence(1) }),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  // Nothing was written.
  const n = db.prepare('SELECT COUNT(*) AS n FROM factory_transition_obligations').get().n;
  assert.equal(n, 0, 'rejected append wrote no row');
});

// ===========================================================================
// 3. lease requires a LEASE FENCE. A CausalSourceRevision is rejected — a
//    causal revision is source-fact provenance, not a lease ordering token.
// ===========================================================================
test('C7-01 contract: lease rejects a CausalSourceRevision as the lease fence', () => {
  const { ledger } = makeLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.throws(
    () => ledger.lease(ob.obligationKey, 'rec-1', causalSourceRevision(2)),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  // No lease taken: state unchanged.
  assert.equal(ledger.get(ob.obligationKey).state, 'pending');
  assert.equal(ledger.get(ob.obligationKey).attempt, 0);
});

// ===========================================================================
// 4. The reconciler carries the LEASE FENCE (never a causal revision) into the
//    lease. Handing it a CausalSourceRevision is rejected at the lease seam.
// ===========================================================================
test('C7-01 contract: reconciler rejects a CausalSourceRevision as its lease fence', async () => {
  const { ledger } = makeLedger();
  const reconciler = new TransitionObligationReconciler(ledger);
  // A handler MUST be registered so the reconciler reaches the lease() call
  // (otherwise the obligation is skipped before the brand check runs).
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute() {
      return { completionReceipt: 'should-not-reach', resultDigest: 'sha256:x' };
    },
  });
  ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  await assert.rejects(
    () => reconciler.reconcile({ leaseOwner: 'rec-1', fence: causalSourceRevision(1) }),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
});

// ===========================================================================
// 5. ADR-053 C7-02 storage split — the AFTER target of the overload that C7-01
//    pinned. append records the CAUSAL SOURCE REVISION on `fence`; lease now
//    writes the LEASE FENCE to the DISTINCT `lease_fence` column and does NOT
//    overwrite the causal revision. The two concepts now have separate durable
//    homes: `fence` is preserved across a lease; `leaseFence` carries the
//    monotonic ordering token.
// ===========================================================================
test('C7-02 storage split: append records causal revision on `fence`; lease writes the DISTINCT `lease_fence` column (causal revision preserved)', () => {
  const { ledger } = makeLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(7) });
  assert.equal(ledger.get(ob.obligationKey).fence, 7, 'causal revision 7 stored at append');
  assert.equal(ledger.get(ob.obligationKey).leaseFence, null, 'no lease fence until leased');

  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(9)));
  const afterLease = ledger.get(ob.obligationKey);
  assert.equal(afterLease.fence, 7, 'causal revision is PRESERVED — lease no longer overwrites fence');
  assert.equal(afterLease.leaseFence, 9, 'lease fence 9 persisted on the DISTINCT lease_fence column');
  assert.equal(afterLease.state, 'in_progress');
});

// ===========================================================================
// 6. Round-trip: a properly-branded causal revision at append and lease fence
//    at lease complete successfully (the legitimate path is unaffected).
// ===========================================================================
test('C7-01 contract: legitimate branded append + lease + complete succeeds', () => {
  const { ledger } = makeLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(1)));
  const completed = ledger.complete({
    obligationKey: ob.obligationKey,
    completionReceipt: 'gate-run/w1/receipt-1',
    resultDigest: 'sha256:r',
  });
  assert.equal(completed.state, 'completed');
  assert.equal(completed.completionReceipt, 'gate-run/w1/receipt-1');
});
