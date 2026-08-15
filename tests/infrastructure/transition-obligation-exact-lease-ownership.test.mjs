import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import {
  causalSourceRevision,
  leaseFence,
} from '../../dist/process-modules/domain/transition-obligation.js';

function fresh() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const ledger = new SqliteTransitionObligationLedger(db);
  const obligation = ledger.append({
    sourceKind: 'candidate-set-sealed',
    sourceRef: 'candidate:exact-owner',
    sourceDigest: 'd'.repeat(64),
    subjectRef: 'workplace/1/module@1/cell/item',
    handoffKind: 'run-gate',
    ownerCapability: 'gate-run-driver',
    causalSourceRevision: causalSourceRevision(1),
  });
  assert.equal(ledger.lease(obligation.obligationKey, 'owner-a', leaseFence(1)), true);
  return { db, ledger, obligation };
}

test('completion rejects a different owner even with the current fence', () => {
  const { db, ledger, obligation } = fresh();
  try {
    assert.throws(
      () => ledger.complete({
        obligationKey: obligation.obligationKey,
        completionReceipt: 'receipt:wrong-owner',
        resultDigest: 'r'.repeat(64),
        owner: 'owner-b',
        fence: leaseFence(1),
      }),
      /TRANSITION_OBLIGATION_COMPLETION_REQUIRES_CURRENT_LEASE/,
    );
    assert.equal(ledger.get(obligation.obligationKey).state, 'in_progress');
  } finally {
    db.close();
  }
});

test('completion rejects a fabricated future fence that was never leased', () => {
  const { db, ledger, obligation } = fresh();
  try {
    assert.throws(
      () => ledger.complete({
        obligationKey: obligation.obligationKey,
        completionReceipt: 'receipt:future-fence',
        resultDigest: 'r'.repeat(64),
        owner: 'owner-a',
        fence: leaseFence(2),
      }),
      /TRANSITION_OBLIGATION_FENCE_MISMATCH/,
    );
    assert.equal(ledger.get(obligation.obligationKey).state, 'in_progress');
    assert.equal(ledger.get(obligation.obligationKey).leaseFence, 1);
  } finally {
    db.close();
  }
});

test('failure and defer reject a different owner under the current fence', () => {
  for (const mutation of ['fail', 'defer']) {
    const { db, ledger, obligation } = fresh();
    try {
      const invoke = mutation === 'fail'
        ? () => ledger.fail({
            obligationKey: obligation.obligationKey,
            owner: 'owner-b',
            fence: leaseFence(1),
            error: 'boom',
          })
        : () => ledger.defer({
            obligationKey: obligation.obligationKey,
            owner: 'owner-b',
            fence: leaseFence(1),
            reason: 'not ready',
          });
      assert.throws(invoke, /REQUIRES_CURRENT_LEASE/);
      assert.equal(ledger.get(obligation.obligationKey).state, 'in_progress');
      assert.equal(ledger.get(obligation.obligationKey).leaseOwner, 'owner-a');
    } finally {
      db.close();
    }
  }
});
