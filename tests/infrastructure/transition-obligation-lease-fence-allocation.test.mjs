// tests/infrastructure/transition-obligation-lease-fence-allocation.test.mjs
//
// ADR-053 C7-03 — the ATOMIC FENCE ALLOCATOR.
//
// C7-02 gave the lease fence durable, monotonic STORAGE: a caller-supplied
// fence is persisted via a MAX-based CAS so the stored value never decreases.
// C7-03 closes the other half — a caller OBTAINS the next monotonic fence from
// the ledger atomically. The fence is ALLOCATED by the store, not supplied, so
// a caller can neither choose a specific fence, predict a future one, nor
// lower the stored value.
//
// This file proves the three C7-03 guarantees:
//   1. CONCURRENCY — N parallel allocators (separate worker threads / database
//      connections racing on one obligation) receive N DISTINCT, strictly-
//      increasing fences. Monotonicity is enforced by the STORE (one IMMEDIATE
//      transaction with the MAX-based CAS), NOT by process memory or wall-clock
//      ordering.
//   2. CAN'T LOWER — once a fence is allocated, a caller supplying a LOWER
//      value (via persistLeaseFence or lease) cannot decrease the stored fence;
//      the stored monotonic value wins.
//   3. RECONCILER SEAM — the reconciler obtains its fence by ALLOCATION when
//      none is supplied (allocate, not supply); the legacy supplied-fence path
//      still works unchanged; allocated fences stay monotonic across recovery.
//
// Out of scope (later cards): completion/failure CAS that ENFORCES the fence
// against a stale lease holder — C7-04/C7-05.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { TransitionObligationReconciler } from
  '../../dist/process-modules/application/transition-obligation-reconciler.js';
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

function fileLedger(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL); // idempotent
  return { ledger: new SqliteTransitionObligationLedger(db), db };
}

// ===========================================================================
// 1. Sequential allocation is strictly monotonic; the causal `fence` column is
//    untouched (allocation only writes `lease_fence`).
// ===========================================================================
test('C7-03: sequential allocateLeaseFence yields strictly-increasing fences; causal fence preserved', () => {
  const { ledger } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(7) });
  assert.equal(ledger.readLeaseFence(ob.obligationKey), null, 'NULL before any allocation');

  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 1);
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 2);
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 3);
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 3, 'stored value is the last allocated');

  // The causal source revision (the `fence` column) is untouched by allocation.
  assert.equal(ledger.get(ob.obligationKey).fence, 7, 'causal revision preserved');
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 3, 'lease fence is the allocated value');
});

// ===========================================================================
// 2. CONCURRENCY (genuine parallelism): K worker threads each open their own
//    connection to a shared WAL database and race on allocateLeaseFence for the
//    SAME obligation. Every allocator must receive a DISTINCT fence; the union
//    of all returned fences is exactly {1..K*M}; the stored value ends at K*M.
//    Proves the store hands out strictly-distinct monotonically-increasing
//    fences under contention — no duplicates, no gaps, no decreases.
// ===========================================================================
test('C7-03 concurrency: K parallel allocators receive K*M distinct strictly-increasing fences', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'saga-c7-03-'));
  const dbPath = path.join(tempDir, 'alloc.db');
  try {
    // Seed the obligation from one connection, then close it so the workers
    // each own their own connection (the real cross-process shape).
    const seed = fileLedger(dbPath);
    const ob = seed.ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
    seed.db.close();

    const K = 4;  // concurrent allocators (worker threads)
    const M = 25; // allocations each
    const TOTAL = K * M;
    const workerUrl = new URL('./lease-fence-allocator-worker.mjs', import.meta.url);

    const runOne = () => new Promise((resolve, reject) => {
      const w = new Worker(workerUrl, {
        workerData: { dbPath, obligationKey: ob.obligationKey, count: M },
      });
      w.on('message', resolve);
      w.on('error', reject);
      w.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
    });
    const results = await Promise.all(Array.from({ length: K }, runOne));
    const all = results.flat().sort((a, b) => a - b);

    // Every allocated fence is distinct → the allocator never handed the same
    // fence to two concurrent callers.
    assert.equal(new Set(all).size, TOTAL, 'all allocated fences are distinct');
    // The set is exactly {1, 2, ..., TOTAL} — strictly increasing, no gaps.
    assert.equal(all[0], 1, 'lowest allocated fence is 1');
    assert.equal(all[TOTAL - 1], TOTAL, 'highest allocated fence is K*M');
    for (let i = 0; i < TOTAL; i++) {
      assert.equal(all[i], i + 1, `fence at index ${i} is ${i + 1} (contiguous monotonic)`);
    }

    // The durable stored value converged to the highest allocated fence.
    const verify = fileLedger(dbPath);
    assert.equal(verify.ledger.readLeaseFence(ob.obligationKey), TOTAL,
      'stored fence is the highest allocated');
    verify.db.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 3. CONCURRENCY across two independent connections (no worker threads):
//    interleaved allocations from two handles on a shared WAL file are all
//    distinct and contiguous. Repo-idiomatic two-connection proof matching
//    tests/architecture/supervision-lease-concurrency.test.mjs — each
//    allocateLeaseFence is one IMMEDIATE transaction, so SQLite's write lock
//    serializes the connections.
// ===========================================================================
test('C7-03: interleaved allocations across two connections are distinct and contiguous', () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'saga-c7-03b-'));
  const dbPath = path.join(tempDir, 'alloc2.db');
  try {
    const a = fileLedger(dbPath);
    const ob = a.ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
    const b = fileLedger(dbPath);

    const collected = [];
    for (let i = 0; i < 10; i++) {
      collected.push(a.ledger.allocateLeaseFence(ob.obligationKey).value);
      collected.push(b.ledger.allocateLeaseFence(ob.obligationKey).value);
    }
    collected.sort((x, y) => x - y);
    assert.equal(new Set(collected).size, 20, 'all 20 cross-connection allocations are distinct');
    for (let i = 0; i < 20; i++) {
      assert.equal(collected[i], i + 1, `contiguous monotonic at index ${i}`);
    }
    a.db.close();
    b.db.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// 4. CAN'T LOWER: a caller cannot decrease the stored fence. After allocating
//    up to N, supplying a LOWER value via persistLeaseFence AND via lease
//    leaves N in effect (the MAX-CAS wins). Allocating again yields N+1.
// ===========================================================================
test('C7-03: a lower supplied fence is ignored — the allocated monotonic value wins', () => {
  const { ledger, db } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  // Allocate up to fence = 5.
  for (let i = 0; i < 5; i++) ledger.allocateLeaseFence(ob.obligationKey);
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 5, 'allocated up to 5');

  // A caller tries to SUPPLY a lower fence via persistLeaseFence. The MAX-CAS
  // must ignore it — the stored monotonic value wins.
  assert.equal(ledger.persistLeaseFence(ob.obligationKey, leaseFence(2)), 5,
    'persistLeaseFence returns the higher stored value');
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 5, 'lower persist did not decrease the fence');

  // A stale caller leases with a LOWER fence. Fail-closed lease semantics
  // (exact-lease-authority hardening): a caller that cannot present a fence at
  // least as high as the stored monotonic value is stale and the lease CAS is
  // REJECTED — the stored fence is preserved and no authority is granted.
  // (The obligation is still pending, so only the fence guard rejects it.)
  assert.equal(ledger.get(ob.obligationKey).state, 'pending');
  assert.equal(ledger.lease(ob.obligationKey, 'stale-rec', leaseFence(1)), false,
    'stale lower-fence lease is rejected');
  assert.equal(ledger.readLeaseFence(ob.obligationKey), 5,
    'rejected stale lease does not lower the fence');
  assert.equal(ledger.get(ob.obligationKey).state, 'pending',
    'rejected stale lease leaves the obligation pending');

  // Allocation continues strictly increasing from the stored value.
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 6, 'next allocation is 6');
});

// ===========================================================================
// 5. Robustness: allocating a fence for an unknown obligation is a rejected
//    operation (a fence can only be allocated for a durable obligation).
// ===========================================================================
test('C7-03: allocateLeaseFence on an unknown key throws TRANSITION_OBLIGATION_NOT_FOUND', () => {
  const { ledger, db } = freshLedger();
  assert.throws(
    () => ledger.allocateLeaseFence('does:not:exist'),
    /TRANSITION_OBLIGATION_NOT_FOUND/,
  );
  // Nothing was written.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_transition_obligations').get().n,
    0,
  );
});

// ===========================================================================
// 6. RECONCILER SEAM (allocate, not supply): with no fence supplied, the
//    reconciler allocates a fresh monotonic fence per obligation and drives
//    the lease + completion. The allocated fence is persisted on the obligation.
// ===========================================================================
test('C7-03 reconciler seam: with no fence supplied, the reconciler allocates and leases to completion', async () => {
  const { ledger } = freshLedger();
  const reconciler = new TransitionObligationReconciler(ledger);
  let captured;
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      captured = obligation;
      return { completionReceipt: 'gate-receipt:alloc', resultDigest: 'sha256:r' };
    },
  });
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  // No `fence` supplied → the reconciler must OBTAIN one by allocation.
  const result = await reconciler.reconcile({ leaseOwner: 'rec-alloc' });
  assert.equal(result.dispatched, 1);
  assert.equal(result.completed, 1);
  assert.ok(captured, 'handler ran');

  const completed = ledger.get(ob.obligationKey);
  assert.equal(completed.state, 'completed');
  assert.ok(completed.leaseFence >= 1, 'a monotonic fence was allocated and persisted');
});

// ===========================================================================
// 7. RECONCILER SEAM (legacy): supplying a fence still works unchanged — the
//    supplied fence is carried into the lease as before.
// ===========================================================================
test('C7-03 reconciler seam: supplying a fence still works (legacy path)', async () => {
  const { ledger } = freshLedger();
  const reconciler = new TransitionObligationReconciler(ledger);
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute() {
      return { completionReceipt: 'gate-receipt:supplied', resultDigest: 'sha256:r' };
    },
  });
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  const result = await reconciler.reconcile({ leaseOwner: 'rec-supplied', fence: leaseFence(42) });
  assert.equal(result.completed, 1);
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 42, 'supplied fence used as-is');
});

// ===========================================================================
// 8. RECONCILER SEAM (monotonic across recovery): crash mid-execution, then a
//    recovery sweep re-allocates a STRICTLY HIGHER fence and converges.
// ===========================================================================
test('C7-03 reconciler seam: allocated fences are monotonic across recovery sweeps', async () => {
  const { ledger } = freshLedger();
  const reconciler = new TransitionObligationReconciler(ledger);
  let calls = 0;
  let firstFence;
  reconciler.registerHandler({
    handoffKind: 'run-gate',
    execute(obligation) {
      calls += 1;
      if (calls === 1) {
        firstFence = obligation.leaseFence;
        throw new Error('simulated crash');
      }
      return { completionReceipt: 'gate-receipt:retry', resultDigest: 'sha256:r' };
    },
  });
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  // Sweep 1: allocate a fence, lease, then crash mid-execution → fail to pending.
  const r1 = await reconciler.reconcile({ leaseOwner: 'rec' });
  assert.equal(r1.failed, 1);
  assert.ok(firstFence >= 1, 'first sweep allocated a fence');

  // Sweep 2: the obligation is ready again; recovery allocates a higher fence.
  const r2 = await reconciler.reconcile({ leaseOwner: 'rec' });
  assert.equal(r2.completed, 1);

  const final = ledger.get(ob.obligationKey);
  assert.equal(final.state, 'completed');
  assert.ok(final.leaseFence > firstFence, 'recovery allocated a strictly higher fence');
});
