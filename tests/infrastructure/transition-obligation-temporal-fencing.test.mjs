// tests/infrastructure/transition-obligation-temporal-fencing.test.mjs
//
// ADR-053 C7-07 — the TEMPORAL FENCING closeout proof (closes the C7 lane).
//
// C7-01..C7-06 landed the pieces: brands (C7-01), durable monotonic storage
// (C7-02), the atomic allocator (C7-03), fenced completion (C7-04), fenced
// failure + lease-loss reclaim with distinct markers (C7-05), and the production
// cutover that wires real fences + reclaim into the sweep (C7-06). This file
// proves the TEMPORAL fencing END-TO-END and closes C7.
//
// TEMPORAL fencing is the property that a stale lease holder — an older fence
// whose lease a newer fence has since taken over — can NEVER mutate the work the
// newer fence owns. Across concurrent takeover, the monotonic lease_fence is the
// single source of truth for "which generation may act." This file proves the
// five C7-07 outcomes:
//
//   1. under concurrent takeover, fences are strictly monotonic and distinct;
//   2. a stale (lower) fence CANNOT complete, fail, or reclaim an obligation a
//      newer fence owns;
//   3. the stored lease_fence NEVER decreases across any transition
//      (complete / fail / reclaim / stale-rejection);
//   4. lease-loss reclaim is DISTINCT from business-handler failure (different
//      markers);
//   5. a terminal state is never altered by a stale or current transition.
//
// DETERMINISM CONTRACT. Every assertion in this file holds for EVERY interleaving
// the store can produce — there are NO wall-clock races. The concurrency is real
// (K worker_threads, each with its own connection to a shared WAL database, the
// genuine cross-process shape), but the assertions are on ORDER-INVARIANT
// invariants that the store's write lock + MAX-based CAS make deterministic:
//
//   * fences are store-minted by one IMMEDIATE transaction each → distinct &
//     monotonically increasing regardless of who wins the race;
//   * `lease_fence = MAX(COALESCE(lease_fence, 0), :new)` → the stored value can
//     only climb, never decrease;
//   * the stale-lease guard is a single comparison (`input.fence < stored`) and
//     the stored value only climbs → a fence below the seeded floor is ALWAYS
//     rejected;
//   * the terminal-state guard runs before any mutating UPDATE and performs no
//     write on a terminal obligation → a converged obligation is immutable under
//     any number of concurrent attackers.
//
// The flaky `tests/factory-temporal/*` suite (which drives the orchestrate-cli
// child process) is NOT touched here — this file proves the same temporal
// properties DETERMINISTICALLY at the ledger level with controlled concurrency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';

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

function fileLedger(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 15000');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA_SQL); // idempotent
  return { ledger: new SqliteTransitionObligationLedger(db), db };
}

// Backdate the live lease so a takeover lease can succeed without waiting.
function expireLease(db, key) {
  db.prepare(
    `UPDATE factory_transition_obligations SET lease_expires_at = '2020-01-01 00:00:00'
      WHERE obligation_key = ?`,
  ).run(key);
}

const WORKER_URL = new URL('./temporal-fencing-worker.mjs', import.meta.url);

function runWorkers(workerDataList) {
  return Promise.all(workerDataList.map((wd) => new Promise((resolve, reject) => {
    const w = new Worker(WORKER_URL, { workerData: wd });
    w.on('message', resolve);
    w.on('error', reject);
    w.on('exit', (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  })));
}

// =============================================================================
//  OUTCOME 1 + 3 (CONCURRENT) — under concurrent takeover the fences are
//  strictly monotonic & distinct, and the stored lease_fence NEVER decreases.
//
//  K worker threads each open their own connection to a shared WAL database and
//  race allocateLeaseFence on ONE obligation. Every allocator runs in its own
//  IMMEDIATE transaction, so SQLite's write lock serializes them: the union of
//  all allocated fences is exactly {seedMax+1 .. seedMax+K*rounds}, the stored
//  value converges to the top, and each worker's sampled stored values are
//  non-decreasing. This is the monotonic backbone that every stale-rejection
//  assertion below rests on.
// =============================================================================
test('C7-07 concurrent: K workers yield distinct strictly-increasing fences; stored lease_fence only climbs (never decreases)', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'saga-c7-07-mono-'));
  const dbPath = path.join(tempDir, 'takeover.db');
  try {
    // Seed the obligation and climb the stored fence to SEED_MAX so the stale
    // attacks in the sibling test start below the floor. Lease it in_progress
    // (a real "old generation holds the work" shape), then close the seed
    // connection so workers each own their own.
    const SEED_MAX = 5;
    const seed = fileLedger(dbPath);
    const ob = seed.ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
    for (let i = 0; i < SEED_MAX; i++) seed.ledger.allocateLeaseFence(ob.obligationKey);
    assert.equal(seed.ledger.readLeaseFence(ob.obligationKey), SEED_MAX);
    assert.ok(seed.ledger.lease(ob.obligationKey, 'seed-old', leaseFence(SEED_MAX)));
    seed.db.close();

    const K = 4;     // concurrent allocators (worker threads)
    const ROUNDS = 25; // allocations each
    const TOTAL = K * ROUNDS;
    const results = await runWorkers(Array.from({ length: K }, (_, id) => ({
      dbPath,
      obligationKey: ob.obligationKey,
      workerId: id,
      rounds: ROUNDS,
      staleFence: 1,
      mode: 'takeover-race',
    })));

    // Outcome 1: every allocated fence is distinct, and the set is exactly the
    // contiguous monotonic sequence above the seed floor.
    const all = results.flatMap((r) => r.allocated).sort((a, b) => a - b);
    assert.equal(new Set(all).size, TOTAL, 'all allocated fences are distinct');
    for (let i = 0; i < TOTAL; i++) {
      assert.equal(all[i], SEED_MAX + i + 1, `fence at index ${i} is ${SEED_MAX + i + 1}`);
    }

    // Outcome 3: the stored value converged to the highest allocated fence and
    // every worker observed a NON-DECREASING stored value across its rounds.
    const verify = fileLedger(dbPath);
    assert.equal(verify.ledger.readLeaseFence(ob.obligationKey), SEED_MAX + TOTAL,
      'stored fence is the highest allocated (never decreased)');
    for (const r of results) {
      let prev = SEED_MAX; // the seeded floor before this worker's first read
      for (const { before, after } of r.storedSamples) {
        assert.ok(before >= prev, `stored sample before (${before}) >= prior (${prev})`);
        assert.ok(after >= before, `allocation climbed the stored fence (${before} → ${after})`);
        prev = after;
      }
    }
    verify.db.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// =============================================================================
//  OUTCOME 2 (CONCURRENT) — a stale (lower) fence CANNOT complete, fail, or
//  reclaim an obligation a newer fence owns, under concurrent takeover pressure.
//
//  The same K workers that climb the fence also mount a stale attack (complete /
//  fail / reclaim with fence 1) every round. Because the stored fence is seeded
//  at 5 and only climbs, fence 1 is ALWAYS below the floor → EVERY attack is
//  rejected (TRANSITION_OBLIGATION_STALE_FENCE). No stale attack ever mutates
//  the obligation: the seeded in_progress lease, owner, and the absence of any
//  completion receipt are all preserved. Deterministic for every interleaving.
// =============================================================================
test('C7-07 concurrent: a stale fence cannot complete, fail, or reclaim while K workers race on the obligation', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'saga-c7-07-stale-'));
  const dbPath = path.join(tempDir, 'stale.db');
  try {
    const SEED_MAX = 5;
    const seed = fileLedger(dbPath);
    const ob = seed.ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
    for (let i = 0; i < SEED_MAX; i++) seed.ledger.allocateLeaseFence(ob.obligationKey);
    assert.ok(seed.ledger.lease(ob.obligationKey, 'seed-old', leaseFence(SEED_MAX)));
    seed.db.close();

    const K = 4;
    const ROUNDS = 25;
    const results = await runWorkers(Array.from({ length: K }, (_, id) => ({
      dbPath,
      obligationKey: ob.obligationKey,
      workerId: id,
      rounds: ROUNDS,
      staleFence: 1,
      mode: 'takeover-race',
    })));

    // Every stale attack was rejected — none ever recorded a 'SUCCESS'.
    const attempts = K * ROUNDS;
    for (const r of results) {
      assert.deepEqual(r.attackResults.complete, Array(ROUNDS).fill('STALE_FENCE'),
        'every stale complete rejected with STALE_FENCE');
      assert.deepEqual(r.attackResults.fail, Array(ROUNDS).fill('STALE_FENCE'),
        'every stale fail rejected with STALE_FENCE');
      assert.deepEqual(r.attackResults.reclaim, Array(ROUNDS).fill('STALE_FENCE'),
        'every stale reclaim rejected with STALE_FENCE');
    }

    // No stale attack mutated the obligation: it is still in_progress under the
    // seeded lease, with no completion receipt and no business / reclaim error.
    const verify = fileLedger(dbPath);
    const after = verify.ledger.get(ob.obligationKey);
    assert.equal(after.state, 'in_progress', 'stale attacks never transitioned the state');
    assert.equal(after.leaseOwner, 'seed-old', 'stale attacks never stole the lease owner');
    assert.equal(after.completionReceipt, null, 'stale attacks never recorded a receipt');
    assert.equal(after.lastError, null, 'stale attacks never wrote an error / reclaim marker');
    // The stored fence only climbed (outcome 3 reaffirmed under attack pressure).
    assert.equal(after.leaseFence, SEED_MAX + attempts, 'stored fence is the highest allocated');
    verify.db.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// =============================================================================
//  OUTCOME 5 (CONCURRENT) — a terminal state is NEVER altered by a stale or
//  current transition, under concurrent attack.
//
//  The obligation is converged to 'completed' under a known receipt, then K
//  workers attack it with stale AND current/higher fences via complete (divergent
//  receipt), fail, and reclaim, plus an idempotent re-complete with the ORIGINAL
//  receipt. complete() / fail() / reclaim() perform NO mutating write on a
//  terminal obligation (the terminal / already-completed guard returns or throws
//  before any UPDATE), so the converged state, receipt, and completion timestamp
//  are immutable under any number of concurrent attackers.
// =============================================================================
test('C7-07 concurrent: a completed obligation is never altered by K workers attacking with stale or current fences', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'saga-c7-07-term-'));
  const dbPath = path.join(tempDir, 'terminal.db');
  const RECEIPT = 'gate-run/w1/converged';
  try {
    const seed = fileLedger(dbPath);
    const ob = seed.ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });
    assert.ok(seed.ledger.lease(ob.obligationKey, 'seed', leaseFence(1)));
    seed.ledger.complete({
      obligationKey: ob.obligationKey,
      owner: 'seed',
      fence: leaseFence(1),
      completionReceipt: RECEIPT,
      resultDigest: 'sha256:result',
    });
    const before = seed.ledger.get(ob.obligationKey);
    assert.equal(before.state, 'completed');
    const beforeCompletedAt = before.completedAt;
    seed.db.close();

    const K = 4;
    const ROUNDS = 25;
    const results = await runWorkers(Array.from({ length: K }, (_, id) => ({
      dbPath,
      obligationKey: ob.obligationKey,
      workerId: id,
      rounds: ROUNDS,
      staleFence: 1,
      originalReceipt: RECEIPT,
      mode: 'terminal-attack',
    })));

    // Every MUTATING attack was rejected; the idempotent re-complete with the
    // original receipt is the only accepted operation (and it performs no write).
    for (const r of results) {
      assert.ok(!r.results.completeDivergent.includes('SUCCESS'),
        'a divergent receipt never overwrote the converged receipt');
      assert.ok(!r.results.fail.includes('SUCCESS'), 'fail never ran on the terminal obligation');
      assert.ok(!r.results.reclaim.includes('SUCCESS'), 'reclaim never ran on the terminal obligation');
      assert.deepEqual(r.results.completeIdempotent, Array(ROUNDS).fill('SUCCESS'),
        'idempotent re-complete with the original receipt is the only accepted operation');
    }

    // The terminal state, receipt, and completion timestamp are unchanged.
    const verify = fileLedger(dbPath);
    const after = verify.ledger.get(ob.obligationKey);
    assert.equal(after.state, 'completed', 'terminal state preserved');
    assert.equal(after.completionReceipt, RECEIPT, 'converged receipt preserved');
    assert.equal(after.completedAt, beforeCompletedAt, 'completion timestamp preserved');
    assert.equal(after.lastError, null, 'no error / reclaim marker written on a terminal obligation');
    // The fence only climbed (workers allocated higher fences that could not lower it).
    assert.ok(after.leaseFence >= 1, 'stored fence never decreased');
    verify.db.close();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// =============================================================================
//  OUTCOME 2 (DETERMINISTIC) — after a newer fence takes the obligation over,
//  a stale fence is rejected for ALL THREE mutating transitions (complete, fail,
//  reclaim), while the current (>= stored) fence succeeds. A positive control for
//  each transition confirms the rejection is the FENCE, not a broken operation.
// =============================================================================
test('C7-07: after a newer fence takes over, a stale fence cannot complete, fail, or reclaim (all three transitions)', () => {
  const { ledger, db } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  // rec-old leases under fence 1; a newer fence (2) then takes the obligation over.
  assert.ok(ledger.lease(ob.obligationKey, 'rec-old', leaseFence(1)));
  assert.equal(ledger.allocateLeaseFence(ob.obligationKey).value, 2);
  assert.equal(ledger.get(ob.obligationKey).leaseFence, 2);

  // STALE complete — rejected.
  assert.throws(
    () => ledger.complete({
      obligationKey: ob.obligationKey,
      owner: 'rec-old',
      fence: leaseFence(1),
      completionReceipt: 'stale-receipt',
      resultDigest: 'sha256:stale',
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  // STALE fail — rejected.
  assert.throws(
    () => ledger.fail({ obligationKey: ob.obligationKey, owner: 'rec-old', fence: leaseFence(1), error: 'boom' }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  // STALE reclaim — rejected.
  assert.throws(
    () => ledger.reclaim({ obligationKey: ob.obligationKey, owner: 'rec-old', fence: leaseFence(1) }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );

  // Positive controls: the CURRENT fence (2) can reclaim, then complete.
  assert.equal(ledger.reclaim({ obligationKey: ob.obligationKey, owner: 'rec-new', fence: leaseFence(2) }).state, 'pending');
  assert.ok(ledger.lease(ob.obligationKey, 'rec-new', leaseFence(2)));
  const completed = ledger.complete({
    obligationKey: ob.obligationKey,
    owner: 'rec-new',
    fence: leaseFence(2),
    completionReceipt: 'gate-run/w1/current',
    resultDigest: 'sha256:result',
  });
  assert.equal(completed.state, 'completed');
});

// =============================================================================
//  OUTCOME 3 (DETERMINISTIC) — the stored lease_fence NEVER decreases across the
//  full lifecycle of transitions: lease → fail → re-lease → reclaim → stale
//  rejection → re-lease → complete. The stored value is sampled after every
//  transition and asserted non-decreasing.
// =============================================================================
test('C7-07: stored lease_fence never decreases across complete / fail / reclaim / stale-rejection', () => {
  const { ledger, db } = freshLedger();
  const ob = ledger.append({ ...BASE_APPEND, causalSourceRevision: causalSourceRevision(1) });

  const samples = [];
  const sample = (label) => samples.push({ label, fence: ledger.readLeaseFence(ob.obligationKey) });

  sample('append (null floor)');
  // lease under 3 → stored climbs to 3.
  assert.ok(ledger.lease(ob.obligationKey, 'rec', leaseFence(3)));
  sample('lease 3');
  // business failure under 3 → stored UNCHANGED (fail does not write lease_fence).
  ledger.fail({ obligationKey: ob.obligationKey, owner: 'rec', fence: leaseFence(3), error: 'EFFECT_FAILED' });
  sample('fail 3');
  // re-lease under 4 → stored climbs to 4.
  assert.ok(ledger.lease(ob.obligationKey, 'rec', leaseFence(4)));
  sample('lease 4');
  // lease-loss reclaim under 4 → stored UNCHANGED (reclaim does not write lease_fence).
  ledger.reclaim({ obligationKey: ob.obligationKey, owner: 'rec', fence: leaseFence(4) });
  sample('reclaim 4');
  // stale complete under 1 → REJECTED; stored UNCHANGED.
  assert.throws(
    () => ledger.complete({
      obligationKey: ob.obligationKey,
      owner: 'stale',
      fence: leaseFence(1),
      completionReceipt: 'stale',
      resultDigest: 'sha256:stale',
    }),
    /TRANSITION_OBLIGATION_STALE_FENCE/,
  );
  sample('stale-rejected complete');
  // re-lease under 5 and complete → stored climbs to 5, then held.
  assert.ok(ledger.lease(ob.obligationKey, 'rec', leaseFence(5)));
  sample('lease 5');
  ledger.complete({
    obligationKey: ob.obligationKey,
    owner: 'rec',
    fence: leaseFence(5),
    completionReceipt: 'gate-run/w1/done',
    resultDigest: 'sha256:result',
  });
  sample('complete 5');

  // The stored fence is non-decreasing across every transition (NULL treated as 0).
  let prev = 0;
  for (const s of samples) {
    const v = s.fence ?? 0;
    assert.ok(v >= prev, `stored fence never decreased at "${s.label}": ${v} < ${prev}`);
    prev = v;
  }
  assert.equal(prev, 5, 'final stored fence is the highest seen');
});

// =============================================================================
//  OUTCOME 4 (DETERMINISTIC) — lease-loss reclaim is DISTINCT from business-
//  handler failure: reclaim writes the LEASE_LOSS_RECLAIM_MARKER sentinel, fail
//  writes the actual business error. A reader can tell the two apart by comparing
//  last_error to the marker.
// =============================================================================
test('C7-07: lease-loss reclaim marker is distinct from a business-handler failure marker', () => {
  const { ledger } = freshLedger();
  const obFail = ledger.append({
    ...BASE_APPEND, sourceRef: 'candidate-set/w1/exec-fail', causalSourceRevision: causalSourceRevision(1),
  });
  const obReclaim = ledger.append({
    ...BASE_APPEND, sourceRef: 'candidate-set/w1/exec-reclaim', causalSourceRevision: causalSourceRevision(1),
  });

  // Business-handler failure: the effect itself threw.
  assert.ok(ledger.lease(obFail.obligationKey, 'rec', leaseFence(1)));
  ledger.fail({
    obligationKey: obFail.obligationKey, owner: 'rec', fence: leaseFence(1), error: 'EFFECT_FAILED: handler threw',
  });
  // Lease-loss reclaim: the holder lost the fence (NOT a business failure).
  assert.ok(ledger.lease(obReclaim.obligationKey, 'rec', leaseFence(1)));
  ledger.reclaim({ obligationKey: obReclaim.obligationKey, owner: 'rec', fence: leaseFence(1) });

  const afterFail = ledger.get(obFail.obligationKey);
  const afterReclaim = ledger.get(obReclaim.obligationKey);

  // Both are retryable (pending), but the recorded markers differ.
  assert.equal(afterFail.state, 'pending');
  assert.equal(afterReclaim.state, 'pending');
  assert.equal(afterFail.lastError, 'EFFECT_FAILED: handler threw', 'business error recorded by fail');
  assert.equal(afterReclaim.lastError, LEASE_LOSS_RECLAIM_MARKER, 'lease-loss sentinel recorded by reclaim');
  assert.notEqual(afterFail.lastError, afterReclaim.lastError,
    'business failure is distinguishable from lease-loss reclaim');
  // A reader can detect lease loss by equality with the sentinel, and a business
  // failure is never equal to it.
  assert.notEqual(afterFail.lastError, LEASE_LOSS_RECLAIM_MARKER);
  assert.equal(afterReclaim.lastError, LEASE_LOSS_RECLAIM_MARKER);
});
