// tests/infrastructure/transition-obligation-lease-fence-storage.test.mjs
//
// ADR-053 C7-02 — DURABLE, DISTINCT storage for the monotonic lease fence.
//
// C7-01 typed the two concerns apart at the ledger seams (CausalSourceRevision
// at `append`, LeaseFence at `lease`) but deliberately left them sharing a
// single overloaded `fence` column. C7-02 gives the lease fence its OWN durable
// home: a nullable `lease_fence` column, written monotonically (a stored fence
// value never decreases on overwrite), migrated additively and non-
// destructively from pre-C7-02 databases.
//
// This file proves the two C7-02 guarantees:
//   1. NON-DESTRUCTIVE MIGRATION — a pre-C7-02 obligations table (no
//      `lease_fence`) keeps every row and every `fence` value untouched after
//      `ensureTransitionObligationLeaseFenceColumn`; the new column lands as
//      NULL (no backfill, no reset). Idempotent on replay.
//   2. MONOTONIC STORAGE — writing a higher fence persists it; writing a LOWER
//      fence does NOT overwrite (storage-level guarantee, independent of the
//      C7-03 allocator). The causal `fence` column is preserved across leases.
//
// Out of scope (later cards): atomic fence ALLOCATION ("callers can't choose a
// future fence") — C7-03; completion/failure CAS — C7-04/C7-05.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL, ensureTransitionObligationLeaseFenceColumn } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { causalSourceRevision, leaseFence } from
  '../../dist/process-modules/domain/transition-obligation.js';

// The pre-C7-02 shape of factory_transition_obligations: the SAME columns as
// SCHEMA_SQL except there is NO `lease_fence` column. This is what a v6
// database presents when opened by the C7-02 (v7) code path.
const PRE_C7_02_OBLIGATIONS_DDL = `
CREATE TABLE factory_transition_obligations (
  obligation_key      TEXT PRIMARY KEY,
  source_kind         TEXT NOT NULL,
  source_ref          TEXT NOT NULL,
  source_digest       TEXT NOT NULL,
  subject_ref         TEXT NOT NULL,
  handoff_kind        TEXT NOT NULL,
  owner_capability    TEXT NOT NULL,
  fence               INTEGER NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending','in_progress','completed','failed')),
  attempt             INTEGER NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  lease_expires_at    TEXT,
  completion_receipt  TEXT,
  result_digest       TEXT,
  last_error          TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  UNIQUE (source_kind, source_ref, handoff_kind)
);`;

// One row in the 'pending' state (fence holds a causal source revision), and
// one in 'in_progress' (fence holds a lease-fence value written by the legacy
// pre-C7-02 `lease` path). The migration must NOT rewrite either `fence` value.
function seedPreC7Obligations(db) {
  db.prepare(
    `INSERT INTO factory_transition_obligations
       (obligation_key, source_kind, source_ref, source_digest, subject_ref,
        handoff_kind, owner_capability, fence, state, attempt, lease_owner)
     VALUES
       ('candidate-set-sealed:cs-1:run-gate','candidate-set-sealed','cs-1','d1','w1',
        'run-gate','gate-run-driver',7,'pending',0,NULL),
       ('gate-accepted:gd-1:run-effects','gate-accepted','gd-1','d2','w1',
        'run-effects','production-cell-node-executor',42,'in_progress',3,'rec-legacy')`,
  ).run();
}

function freshLedger() {
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
// 1. NON-DESTRUCTIVE MIGRATION: a pre-C7-02 table keeps every row and every
//    `fence` value; the new `lease_fence` column lands as NULL.
// ===========================================================================
test('C7-02 migration: adds lease_fence as NULL, preserves all rows and fence values (non-destructive)', () => {
  const db = new Database(':memory:');
  db.exec(PRE_C7_02_OBLIGATIONS_DDL);
  seedPreC7Obligations(db);

  // Snapshot every column of every row BEFORE migration.
  const before = db.prepare('SELECT * FROM factory_transition_obligations ORDER BY obligation_key').all();
  assert.equal(before.length, 2);
  assert.ok(!('lease_fence' in before[0]), 'pre-migration row has no lease_fence column');

  ensureTransitionObligationLeaseFenceColumn(db);

  // The column now exists...
  const cols = db.prepare('PRAGMA table_info(factory_transition_obligations)').all().map(c => c.name);
  assert.ok(cols.includes('lease_fence'), 'lease_fence column added');

  // ...and is NULL for every pre-existing row (no backfill, no reset).
  const after = db.prepare('SELECT *, lease_fence AS lease_fence FROM factory_transition_obligations ORDER BY obligation_key').all();
  assert.equal(after.length, 2, 'no rows lost');
  assert.equal(after[0].lease_fence, null);
  assert.equal(after[1].lease_fence, null);

  // Every pre-existing column value is byte-for-byte unchanged.
  for (let i = 0; i < before.length; i++) {
    for (const [k, v] of Object.entries(before[i])) {
      assert.equal(after[i][k], v, `column ${k} preserved on row ${i}`);
    }
  }
  // The legacy ambiguous `fence` values (causal revision 7; legacy lease 42)
  // are deliberately NOT copied into lease_fence — the migration never launders
  // an ambiguous value into the new monotonic column.
  assert.deepEqual(after.map(r => r.fence), [7, 42]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

// ===========================================================================
// 2. Idempotent replay: running the migration a second time is a no-op.
// ===========================================================================
test('C7-02 migration: idempotent — replay is a no-op', () => {
  const db = new Database(':memory:');
  db.exec(PRE_C7_02_OBLIGATIONS_DDL);
  seedPreC7Obligations(db);

  ensureTransitionObligationLeaseFenceColumn(db);
  const afterFirst = db.prepare('SELECT * FROM factory_transition_obligations').all();

  ensureTransitionObligationLeaseFenceColumn(db);
  const afterSecond = db.prepare('SELECT * FROM factory_transition_obligations').all();

  assert.deepEqual(afterFirst, afterSecond, 'second migration run changed nothing');
});

// ===========================================================================
// 3. A pre-migration obligation (lease_fence = NULL) becomes usable once the
//    reconciler leases it: the new `lease` path writes lease_fence, leaving the
//    causal `fence` untouched. This is the no-reset live-obligation contract.
// ===========================================================================
test('C7-02: a migrated (lease_fence=NULL) obligation becomes usable on its next lease — causal fence preserved', () => {
  const db = new Database(':memory:');
  db.exec(PRE_C7_02_OBLIGATIONS_DDL);
  seedPreC7Obligations(db);
  ensureTransitionObligationLeaseFenceColumn(db);

  const ledger = new SqliteTransitionObligationLedger(db);
  // Backdate the in_progress row's lease so it is re-leaseable.
  db.prepare(
    `UPDATE factory_transition_obligations SET lease_expires_at = '2020-01-01 00:00:00' WHERE obligation_key = 'gate-accepted:gd-1:run-effects'`,
  ).run();

  const before = ledger.get('gate-accepted:gd-1:run-effects');
  assert.equal(before.fence, 42, 'legacy fence value retained pre-lease');
  assert.equal(before.leaseFence, null, 'lease_fence NULL until first C7-02 lease');

  assert.ok(ledger.lease('gate-accepted:gd-1:run-effects', 'rec-new', leaseFence(100)));

  const after = ledger.get('gate-accepted:gd-1:run-effects');
  assert.equal(after.fence, 42, 'causal/legacy fence NOT rewritten by the lease');
  assert.equal(after.leaseFence, 100, 'lease fence persisted on the new column');
  assert.equal(after.state, 'in_progress');
});

// ===========================================================================
// 4. MONOTONIC STORAGE via `lease`: a higher fence persists; a LOWER fence on a
//    later lease does NOT overwrite (storage-level guarantee, no allocator).
// ===========================================================================
test('C7-02 storage monotonicity: lease never decreases a persisted lease_fence', () => {
  const { ledger, db } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  // Backdate helper so repeated leases succeed without waiting for expiry.
  const backdate = () => db.prepare(
    `UPDATE factory_transition_obligations SET lease_expires_at = '2020-01-01 00:00:00' WHERE obligation_key = ?`,
  ).run(ob.obligationKey);

  assert.ok(ledger.lease(ob.obligationKey, 'rec-1', leaseFence(10)));
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 10, 'fence 10 persisted');

  backdate();
  assert.ok(ledger.lease(ob.obligationKey, 'rec-2', leaseFence(30)));
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 30, 'higher fence 30 overwrites');

  backdate();
  // A stale caller hands a LOWER fence than the one already persisted. The
  // storage layer must NOT let it decrease the durable value.
  assert.ok(ledger.lease(ob.obligationKey, 'rec-stale', leaseFence(5)));
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 30, 'lower fence does NOT overwrite — monotonic');
});

// ===========================================================================
// 5. MONOTONIC STORAGE via `persistLeaseFence` (the storage seam the C7-03
//    allocator will call). Read-back is monotonic; a lower value is ignored.
// ===========================================================================
test('C7-02 storage monotonicity: persistLeaseFence returns the max (higher wins, lower is ignored)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  assert.equal(ledger.readLeaseFence(ob.obligationKey), null, 'NULL before any fence persisted');

  assert.equal(ledger.persistLeaseFence(ob.obligationKey, leaseFence(20)), 20, 'first persist returns 20');
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 20);

  assert.equal(ledger.persistLeaseFence(ob.obligationKey, leaseFence(50)), 50, 'higher persist returns 50');
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 50);

  // Lower value must NOT decrease the persisted fence.
  assert.equal(ledger.persistLeaseFence(ob.obligationKey, leaseFence(3)), 50, 'lower persist leaves 50 in effect');
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 50);

  // The causal `fence` column is untouched by fence persistence.
  assert.equal(ledger.get(ob.obligationKey).fence, 1, 'causal revision preserved');
});

// ===========================================================================
// 6. persistLeaseFence + readLeaseFence carry the LeaseFence brand (a
//    CausalSourceRevision is rejected at the seam — the brands stay apart).
// ===========================================================================
test('C7-02 storage seam: persistLeaseFence rejects a CausalSourceRevision (brand mismatch)', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
  assert.throws(
    () => ledger.persistLeaseFence(ob.obligationKey, causalSourceRevision(99)),
    /TRANSITION_OBLIGATION_BRAND_MISMATCH/,
  );
  // Nothing persisted on the rejected call.
  assert.equal(ledger.readLeaseFence(ob.obligationKey), null);
});

// ===========================================================================
// 7. readLeaseFence on an unknown key returns NULL (no row, no throw).
// ===========================================================================
test('C7-02 storage: readLeaseFence on an unknown key returns null', () => {
  const { ledger } = freshLedger();
  assert.equal(ledger.readLeaseFence('does:not:exist'), null);
});
