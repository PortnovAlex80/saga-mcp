// tests/infrastructure/transition-obligation-redrive-reason.test.mjs
//
// BLINDSIGHT CENSUS, Lifecycle layer F3 — "Obligation redrive игнорирует
// lastReasonKey (MED)".
//
// The B-004/O-D6 reason-identity valve (see transition-obligation-reason-valve
// .test.mjs) ends SAME-KEY repetition at N=3 and the absolute attempt ceiling
// at 30. But BETWEEN those thresholds the redrive is completely reason-blind:
// every sweep re-leases and re-dispatches the obligation immediately, whatever
// the persisted typed reason says. The typed reason (last_reason_key) and the
// durable prose (last_error) are written by defer/fail and then never READ at
// the redrive decision point — the exact "данные записаны, но не доставляются
// к точке решения" blindsight.
//
// CONVEYOR §15 — the redrive must branch on the typed reason:
//   - deterministic-retryable (transient: SQLITE_BUSY, lease loss, network) →
//     retry WITH BACKOFF — the retry is honest work, but a thundering retry
//     storm is spin the system creates itself;
//   - requires human judgment (the fail-closed park vocabulary:
//     RECOVERY_BUDGET_EXHAUSTED, GATE_HUMAN_REQUIRED, REPLAN_*) → park
//     human_required — a fail-closed terminal abandon, NOT another lease and
//     NOT an infinite loop;
//   - uncategorized → the existing behavior (immediate retry; the §15 valve
//     still caps repetition/ceiling).
//
// This suite drives the REAL ledger + REAL reconciler with registered
// handlers (the same seam product-lifecycle-runtime uses) and proves:
//   R1  a deterministic-retryable failure is NOT re-dispatched inside its
//       backoff window; after the window elapses the retry resumes;
//   R2  a human-judgment reason parks the obligation terminally with the typed
//       OBLIGATION_HUMAN_PARK marker — no further dispatch happens (the loop
//       ends honestly instead of leasing a human decision forever);
//   R3  an uncategorized reason keeps the immediate-retry behavior (the
//       pre-existing contract is unchanged);
//   R4  the backoff schedule is exponential in the persisted reason-repeat
//       count and capped;
//   R5  the human park is journalled as 'obligation.human_park'.
//
// BEFORE the fix this is RED on R1 (immediate re-dispatch), R2 (the human
// reason is re-leased forever below the valve thresholds) and R4/R5 (the
// classifier, backoff schedule and journal kind do not exist).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { TransitionObligationReconciler } from
  '../../dist/process-modules/application/transition-obligation-reconciler.js';

const reconcilerModule = await import(
  '../../dist/process-modules/application/transition-obligation-reconciler.js'
);
const classifyObligationRedrive = reconcilerModule.classifyObligationRedrive ?? null;
const obligationRedriveBackoffMs = reconcilerModule.obligationRedriveBackoffMs ?? null;
const OBLIGATION_BACKOFF_BASE_MS = reconcilerModule.OBLIGATION_BACKOFF_BASE_MS ?? null;
const OBLIGATION_BACKOFF_CAP_MS = reconcilerModule.OBLIGATION_BACKOFF_CAP_MS ?? null;
const OBLIGATION_HUMAN_PARK_MARKER = reconcilerModule.OBLIGATION_HUMAN_PARK_MARKER ?? null;

process.env.SAGA_RUN_JOURNAL = 'off';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function sampleObligationInput(overrides = {}) {
  return {
    sourceKind: 'candidate-set-sealed',
    sourceRef: 'candidate-set/7/cell/item/aaaa',
    sourceDigest: 'a'.repeat(64),
    subjectRef: 'workplace/7/test-module@1.0.0/cell/item',
    handoffKind: 'run-gate',
    ownerCapability: 'gate-run-driver',
    ...overrides,
  };
}

function makeReconciler(db, handler) {
  const ledger = new SqliteTransitionObligationLedger(db);
  const reconciler = new TransitionObligationReconciler(ledger);
  reconciler.registerHandler(handler);
  return { ledger, reconciler };
}

async function sweepOnce(reconciler) {
  return reconciler.reconcile({ leaseOwner: 'redrive-test' });
}

// Age the obligation's persisted failure timestamp so the backoff window has
// demonstrably elapsed (hermetic time control — the ledger writes
// updated_at=datetime('now') in UTC seconds).
function ageLastFailure(db, key, seconds) {
  db.prepare(
    `UPDATE factory_transition_obligations
        SET updated_at=datetime('now', ?)
      WHERE obligation_key=?`,
  ).run(`-${seconds} seconds`, key);
}

// ===========================================================================
// R4 — the backoff schedule is exponential in the reason-repeat count, capped.
// ===========================================================================
test('R4: obligationRedriveBackoffMs is exponential in repeat count and capped', () => {
  assert.equal(typeof obligationRedriveBackoffMs, 'function',
    'obligationRedriveBackoffMs must be exported');
  assert.equal(typeof OBLIGATION_BACKOFF_BASE_MS, 'number',
    'OBLIGATION_BACKOFF_BASE_MS must be exported');
  assert.equal(typeof OBLIGATION_BACKOFF_CAP_MS, 'number',
    'OBLIGATION_BACKOFF_CAP_MS must be exported');
  const base = OBLIGATION_BACKOFF_BASE_MS;
  assert.ok(obligationRedriveBackoffMs(1) === base, 'repeat=1 waits the base window');
  assert.ok(obligationRedriveBackoffMs(2) === base * 2, 'repeat=2 doubles');
  assert.ok(obligationRedriveBackoffMs(3) === base * 4, 'repeat=3 doubles again');
  assert.ok(
    obligationRedriveBackoffMs(50) <= OBLIGATION_BACKOFF_CAP_MS,
    'the schedule is capped regardless of the repeat count',
  );
  assert.ok(
    obligationRedriveBackoffMs(50) > 0,
    'a persisted retryable reason always yields a positive window',
  );
});

// ===========================================================================
// R1 — deterministic-retryable: retry WITH BACKOFF (no immediate re-dispatch).
// ===========================================================================
test('R1: a deterministic-retryable failure waits its backoff window before the retry', async () => {
  const db = makeDb();
  let dispatches = 0;
  const { ledger, reconciler } = makeReconciler(db, {
    handoffKind: 'run-gate',
    execute() {
      dispatches += 1;
      throw new Error('SQLITE_BUSY: database is locked');
    },
  });
  const appended = ledger.appendFenced(sampleObligationInput());

  // Sweep 1: dispatch + fail — the typed reason SQLITE_BUSY is persisted.
  const first = await sweepOnce(reconciler);
  assert.equal(first.dispatched, 1);
  assert.equal(first.failed, 1);
  const afterFail = ledger.get(appended.obligationKey);
  assert.equal(afterFail.lastReasonKey, 'SQLITE_BUSY');
  assert.equal(afterFail.reasonRepeatCount, 1);

  // Sweep 2 (immediately): the persisted reason is deterministic-retryable and
  // the backoff window has NOT elapsed — the DEFECT re-dispatched it anyway.
  const second = await sweepOnce(reconciler);
  assert.equal(second.dispatched, 0,
    'DEFECT F3: a SQLITE_BUSY obligation was re-dispatched inside its backoff '
    + 'window — redrive ignores the persisted typed reason');
  assert.ok((second.backoff ?? 0) >= 1,
    'the sweep surfaces the backoff hold in its summary');
  assert.equal(ledger.get(appended.obligationKey).state, 'pending',
    'backoff holds the obligation pending — it is waiting, not terminal');

  // After the window elapses the retry resumes (deterministic-retryable is
  // retryable, not parked).
  ageLastFailure(db, appended.obligationKey, 120);
  const third = await sweepOnce(reconciler);
  assert.equal(third.dispatched, 1,
    'once the backoff window elapses the retry is honest work and resumes');
  assert.equal(dispatches, 2);
  db.close();
});

test('R1b: the lease-loss reclaim marker classifies as deterministic-retryable', () => {
  assert.equal(
    classifyObligationRedrive('ANY_STALE_KEY', 'LEASE_LOSS_RECLAIM'),
    'deterministic-retryable',
    'a reclaimed row (previous holder crashed) is retryable regardless of the '
      + 'stale reason key the reclaim did not clear',
  );
});

// ===========================================================================
// R2 — human judgment: park human_required, fail-closed, no infinite loop.
// ===========================================================================
test('R2: a human-judgment reason parks the obligation terminally instead of re-leasing it', async () => {
  const db = makeDb();
  let dispatches = 0;
  const { ledger, reconciler } = makeReconciler(db, {
    handoffKind: 'run-gate',
    execute() {
      dispatches += 1;
      throw new Error('GATE_HUMAN_REQUIRED: reviewer verdict demands a human decision');
    },
  });
  const appended = ledger.appendFenced(sampleObligationInput());

  // Sweep 1: the failure persists the typed human-judgment reason.
  const first = await sweepOnce(reconciler);
  assert.equal(first.failed, 1);

  // Sweep 2: the redrive READS the persisted reason and parks — the DEFECT
  // kept re-leasing a human decision below the §15 valve thresholds.
  const second = await sweepOnce(reconciler);
  assert.equal(second.dispatched, 0,
    'DEFECT F3: a GATE_HUMAN_REQUIRED obligation was re-dispatched — the loop '
    + 'leases a human decision forever');
  assert.ok((second.humanParked ?? 0) >= 1,
    'the sweep summary surfaces the human park');

  const parked = ledger.get(appended.obligationKey);
  assert.equal(parked.state, 'failed',
    'the human park is a fail-closed terminal abandon');
  assert.match(parked.lastError, /OBLIGATION_HUMAN_PARK/,
    'the terminal marker is the typed OBLIGATION_HUMAN_PARK prefix');
  assert.match(parked.lastError, /GATE_HUMAN_REQUIRED/,
    'the marker carries the typed reason-key identity');
  assert.equal(ledger.findReady().length, 0,
    'no further sweep can dispatch it — the loop ends, not spins');

  // The park is sticky: repeated sweeps change nothing.
  const third = await sweepOnce(reconciler);
  assert.equal(third.dispatched, 0);
  assert.equal(third.humanParked ?? 0, 0,
    'an already-parked obligation is not re-counted');
  assert.equal(dispatches, 1);
  db.close();
});

test('R2b: the fail-closed park vocabulary classifies as human-judgment', () => {
  for (const key of [
    'RECOVERY_BUDGET_EXHAUSTED',
    'GATE_HUMAN_REQUIRED',
    'REPLAN_MANDATED',
    'REPLAN_CYCLE_CAP',
    'REPLAN_CYCLE_RATCHET',
    'WORKER_RETRY_BUDGET_EXHAUSTED',
  ]) {
    assert.equal(classifyObligationRedrive(key, `${key}: prose detail`),
      'human-judgment', `${key} must classify as human-judgment`);
  }
  assert.equal(classifyObligationRedrive(null, 'DEFERRED: RECOVERY_BUDGET_EXHAUSTED park'),
    'human-judgment',
    'the vocabulary is matched in the durable prose too (defer paths)');
});

// ===========================================================================
// R3 — uncategorized reasons keep the immediate-retry contract unchanged.
// ===========================================================================
test('R3: an uncategorized reason is still re-dispatched immediately (valve owns it)', async () => {
  const db = makeDb();
  const { ledger, reconciler } = makeReconciler(db, {
    handoffKind: 'run-gate',
    execute() {
      throw new Error('SOME_UNCLASSIFIED_DEFECT: novel boundary');
    },
  });
  const appended = ledger.appendFenced(sampleObligationInput());

  await sweepOnce(reconciler);
  const second = await sweepOnce(reconciler);
  assert.equal(second.dispatched, 1,
    'an unclassified reason keeps the pre-existing immediate-retry behavior '
    + '(reason identity stays the valve\'s job, not the classifier\'s)');
  assert.equal(second.backoff ?? 0, 0);
  assert.equal(second.humanParked ?? 0, 0);
  assert.equal(ledger.get(appended.obligationKey).state, 'pending');
  db.close();
});

test('R3b: ordinary postcondition defers stay uncategorized', () => {
  assert.equal(
    classifyObligationRedrive(
      'terminal GateRun for the exact CandidateSet is not durable yet',
      'DEFERRED: terminal GateRun for the exact CandidateSet is not durable yet',
    ),
    'uncategorized',
    'a conveyor-paced postcondition wait is neither a park nor a transient storm',
  );
});

// ===========================================================================
// R5 — the human park is journalled (observation-only, like obligation.valve).
// ===========================================================================
test('R5: the human park journals obligation.human_park', async () => {
  const journalDir = mkdtempSync(join(tmpdir(), 'saga-human-park-journal-'));
  const journalPath = join(journalDir, 'run-journal.jsonl');
  process.env.SAGA_RUN_JOURNAL = journalPath;
  try {
    const db = makeDb();
    const { ledger, reconciler } = makeReconciler(db, {
      handoffKind: 'run-gate',
      execute: () => {
        throw new Error('RECOVERY_BUDGET_EXHAUSTED: attempts 5/5 burned');
      },
    });
    const appended = ledger.appendFenced(sampleObligationInput());
    await sweepOnce(reconciler);
    await sweepOnce(reconciler);
    assert.equal(ledger.get(appended.obligationKey).state, 'failed', 'parked');

    const events = readFileSync(journalPath, 'utf8').trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line));
    const parkEvents = events.filter((event) => event.kind === 'obligation.human_park');
    assert.ok(parkEvents.length >= 1,
      `the human park is journalled; got kinds: ${events.map((e) => e.kind).join(', ')}`);
    const event = parkEvents[0];
    assert.equal(event.data.obligation_key, appended.obligationKey);
    assert.equal(event.data.reason_key, 'RECOVERY_BUDGET_EXHAUSTED',
      'the typed reason-key identity is carried');
    assert.equal(event.data.terminal, 'failed');
    db.close();
  } finally {
    process.env.SAGA_RUN_JOURNAL = 'off';
    rmSync(journalDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Classifier unit contract.
// ===========================================================================
test('R6: classifyObligationRedrive covers the transient vocabulary', () => {
  for (const code of [
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'PROCESS_RUN_BUSY',
  ]) {
    assert.equal(classifyObligationRedrive(code, `${code}: transient detail`),
      'deterministic-retryable', `${code} must classify as deterministic-retryable`);
  }
  assert.equal(classifyObligationRedrive(null, null), 'uncategorized',
    'a fresh obligation with no persisted reason is never classified');
  assert.ok(OBLIGATION_HUMAN_PARK_MARKER === 'OBLIGATION_HUMAN_PARK',
    'the typed terminal marker constant is exported');
});
