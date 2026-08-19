// tests/infrastructure/transition-obligation-reason-valve.test.mjs
//
// B-004 cluster repair, DEFECT 1 (O-D6/E-1) — the livelock valve.
//
// The stage-10/11 evidence (PREVENTIVE-HUNT O-D6+E1+B4): a transition
// obligation whose postcondition can never become satisfied has NO exit.
// defer/fail return it to pending with no cap, findReady is unlimited, the
// `attempt` column increments but is never compared (observed >1500), and the
// only exits — complete and abandon — are unreachable for a paused lifecycle
// (burial matches terminal_status='failed' exclusively). The reconciler
// re-drives baseEngine.run every sweep, forever.
//
// CONVEYOR §15 — "Budget must count spin, not work":
//   - abort rules key on identical-reason repetition, never on iteration count;
//   - a NEW reason key is another link of the defect chain removed = WORK;
//   - a hard absolute cap still terminates even converging chains.
//
// This suite drives the REAL ledger + REAL reconciler with registered
// handlers (the same seam product-lifecycle-runtime uses) and proves:
//   V1  the same defer reason repeating N times ends in an honest terminal
//       abandon with a typed OBLIGATION_VALVE marker;
//   V2  alternating/distinct reasons (a converging chain) do NOT trip the
//       repetition valve — only the absolute attempt ceiling ends them;
//   V3  a failed handler with the same typed error CODE (message prose after
//       the colon may vary) repeating N times ends the same way — the reason
//       identity is the CODE prefix, not the whole message;
//   V4  the valve trip is journalled as 'obligation.valve' (observation-only:
//       written, never read back by the factory);
//   V5  the thresholds are named exported constants (N=3, ceiling=30 — the
//       ADR-075 DEFAULT_RECOVERY_TOTAL_ATTEMPTS value);
//   V6  the happy path is untouched: an obligation that completes never sees
//       the valve, and a fresh obligation starts with a zeroed counter.
//
// BEFORE the fix this is RED on V1/V2/V3 (the obligation stays pending
// forever — the livelock) and on V5 (the constants do not exist).

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

// RED-first: the valve constants do not exist yet. Read them defensively so
// the first failure you see is the DEFECT assertion (still pending forever),
// not a module-load error. After the fix these resolve to the real exports.
const reconcilerModule = await import(
  '../../dist/process-modules/application/transition-obligation-reconciler.js'
);
const REPEAT_THRESHOLD = reconcilerModule.OBLIGATION_VALVE_REPEAT_THRESHOLD ?? null;
const ATTEMPT_CEILING = reconcilerModule.OBLIGATION_VALVE_ATTEMPT_CEILING ?? null;

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

async function sweep(reconciler, times = 1) {
  let last;
  const totals = { dispatched: 0, completed: 0, failed: 0, deferred: 0, skipped: 0, valved: 0 };
  for (let i = 0; i < times; i += 1) {
    last = await reconciler.reconcile({ leaseOwner: 'valve-test' });
    for (const key of Object.keys(totals)) totals[key] += last[key] ?? 0;
  }
  return { last, totals };
}

// ===========================================================================
// V5 — the thresholds are named exported constants.
// ===========================================================================
test('V5: valve thresholds are named exported constants (N=3, ceiling=30=ADR-075)', () => {
  assert.equal(REPEAT_THRESHOLD, 3,
    'OBLIGATION_VALVE_REPEAT_THRESHOLD must be exported and equal 3');
  assert.equal(ATTEMPT_CEILING, 30,
    'OBLIGATION_VALVE_ATTEMPT_CEILING must be exported and equal 30 '
    + '(matching DEFAULT_RECOVERY_TOTAL_ATTEMPTS)');
});

// ===========================================================================
// V1 — the livelock itself: the same defer reason repeating N times must end
// in an honest terminal abandon, not an eternal pending loop.
// ===========================================================================
test('V1: same defer reason repeated N times ends the loop with a typed OBLIGATION_VALVE abandon', async () => {
  const db = makeDb();
  const reason = 'terminal GateRun for the exact CandidateSet is not durable yet';
  let defers = 0;
  const { ledger, reconciler } = makeReconciler(db, {
    handoffKind: 'run-gate',
    execute() {
      defers += 1;
      return { outcome: 'deferred', reason };
    },
  });
  const appended = ledger.appendFenced(sampleObligationInput());
  assert.equal(appended.state, 'pending');

  // The DEFECT: before the valve, this stays pending forever (attempt grows
  // unbounded). Drive a few extra sweeps to make the livelock undeniable.
  const sweeps = (REPEAT_THRESHOLD ?? 3) + 2;
  const { totals } = await sweep(reconciler, sweeps);
  const obligation = ledger.get(appended.obligationKey);

  assert.notEqual(obligation.state, 'pending',
    `DEFECT O-D6: after ${sweeps} sweeps with the IDENTICAL defer reason the `
    + `obligation is still state='${obligation.state}' attempt=${obligation.attempt} `
    + `— the defer loop has no exit (livelock)`);
  assert.equal(obligation.state, 'failed',
    'the valve routes to the ledger abandon terminal state');
  assert.match(obligation.lastError, /OBLIGATION_VALVE/,
    'the terminal marker is the typed OBLIGATION_VALVE prefix');
  assert.ok(defers <= (REPEAT_THRESHOLD ?? 3),
    `the valve tripped at the threshold (${REPEAT_THRESHOLD ?? 3}), not after ${defers} defers`);
  assert.equal(ledger.findReady().length, 0,
    'findReady no longer returns the valve-terminated obligation');
  assert.ok(totals.valved >= 1 || totals.failed >= 1,
    'the sweep summary surfaces the valve trip');
});

// ===========================================================================
// V2 — converging chains are WORK: distinct reason keys reset the repetition
// counter; only the absolute attempt ceiling may end them.
// ===========================================================================
test('V2: distinct defer reasons are work — repetition never trips, only the attempt ceiling ends the chain', async () => {
  const db = makeDb();
  let n = 0;
  const { ledger, reconciler } = makeReconciler(db, {
    handoffKind: 'run-gate',
    execute() {
      n += 1;
      return { outcome: 'deferred', reason: `converging defect-chain link #${n} removed` };
    },
  });
  const appended = ledger.appendFenced(sampleObligationInput());

  // Well below the ceiling: a healthy converging chain keeps working.
  const midSweeps = Math.floor((ATTEMPT_CEILING ?? 30) / 3);
  await sweep(reconciler, midSweeps);
  let obligation = ledger.get(appended.obligationKey);
  assert.equal(obligation.state, 'pending',
    `a chain of ${midSweeps} DISTINCT reasons is work, not spin — the repetition `
    + 'valve must not tax it');
  assert.ok(obligation.attempt >= midSweeps);

  // The hard cap: even converging chains terminate (§15 rule 4).
  await sweep(reconciler, (ATTEMPT_CEILING ?? 30));
  obligation = ledger.get(appended.obligationKey);
  assert.equal(obligation.state, 'failed',
    'the absolute attempt ceiling is the hard cap regardless of reason novelty');
  assert.match(obligation.lastError, /OBLIGATION_VALVE/);
  assert.ok(obligation.attempt <= (ATTEMPT_CEILING ?? 30),
    `the ceiling ended the chain at attempt ${obligation.attempt}, not later`);
});

test('V2b: alternating reasons never accumulate a repetition (each new key resets)', async () => {
  const db = makeDb();
  const reasons = ['repair routed: integrate', 'repair routed: freeze'];
  let i = 0;
  const { ledger, reconciler } = makeReconciler(db, {
    handoffKind: 'run-gate',
    execute() {
      const reason = reasons[i % reasons.length];
      i += 1;
      return { outcome: 'deferred', reason };
    },
  });
  const appended = ledger.appendFenced(sampleObligationInput());
  // Far more sweeps than the repeat threshold, but no reason repeats
  // CONSECUTIVELY — a converging ping-pong is still work.
  await sweep(reconciler, (REPEAT_THRESHOLD ?? 3) * 4);
  const obligation = ledger.get(appended.obligationKey);
  assert.equal(obligation.state, 'pending',
    'alternating distinct reasons never trip the repetition valve');
});

// ===========================================================================
// V3 — failed handlers: the reason identity is the typed error CODE prefix
// (before the colon); varying prose after the colon is the SAME reason.
// ===========================================================================
test('V3: same typed error CODE with varying prose still trips the valve at N', async () => {
  const db = makeDb();
  let k = 0;
  const { ledger, reconciler } = makeReconciler(db, {
    handoffKind: 'run-gate',
    execute() {
      k += 1;
      throw new Error(`REPLAY_CAPTURE_TRACE_NOT_FOUND: expected 12, resolved ${k - 1}`);
    },
  });
  const appended = ledger.appendFenced(sampleObligationInput());
  await sweep(reconciler, (REPEAT_THRESHOLD ?? 3) + 1);
  const obligation = ledger.get(appended.obligationKey);
  assert.equal(obligation.state, 'failed',
    'the same typed error CODE repeating N times ends the fail loop');
  assert.match(obligation.lastError, /OBLIGATION_VALVE/);
  assert.match(obligation.lastError, /REPLAY_CAPTURE_TRACE_NOT_FOUND/,
    'the valve marker carries the typed reason-key identity');
  assert.equal(ledger.findReady().length, 0);
});

// ===========================================================================
// V4 — observation: the valve trip is journalled as 'obligation.valve'.
// ===========================================================================
test('V4: the valve trip journals obligation.valve (write-only observation)', async () => {
  const journalDir = mkdtempSync(join(tmpdir(), 'saga-valve-journal-'));
  const journalPath = join(journalDir, 'run-journal.jsonl');
  process.env.SAGA_RUN_JOURNAL = journalPath;
  try {
    const db = makeDb();
    const { ledger, reconciler } = makeReconciler(db, {
      handoffKind: 'run-gate',
      execute: () => ({ outcome: 'deferred', reason: 'postcondition never becomes durable' }),
    });
    const appended = ledger.appendFenced(sampleObligationInput());
    await sweep(reconciler, (REPEAT_THRESHOLD ?? 3));
    const obligation = ledger.get(appended.obligationKey);
    assert.equal(obligation.state, 'failed', 'valve tripped');

    const events = readFileSync(journalPath, 'utf8').trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line));
    const valveEvents = events.filter((event) => event.kind === 'obligation.valve');
    assert.ok(valveEvents.length >= 1,
      `exactly the valve trip is journalled; got kinds: ${events.map((e) => e.kind).join(', ')}`);
    const event = valveEvents[0];
    assert.equal(event.data.obligation_key, appended.obligationKey);
    assert.equal(event.workplace_ref, 'workplace/7/test-module@1.0.0/cell/item',
      'correlation keys follow the obligation.deferred shape');
    assert.ok(typeof event.data.reason_key === 'string' && event.data.reason_key.length > 0,
      'the typed reason-key identity is carried');
    assert.ok(typeof event.data.repeated === 'number');
    assert.ok(typeof event.data.attempt === 'number');
    // Observation-only ratchet: this TEST is the reader; the factory never
    // reads the journal back.
  } finally {
    process.env.SAGA_RUN_JOURNAL = 'off';
    rmSync(journalDir, { recursive: true, force: true });
  }
});

// ===========================================================================
// V6 — the happy path is untouched.
// ===========================================================================
test('V6: a completing obligation never meets the valve; fresh rows start at zero', async () => {
  const db = makeDb();
  let calls = 0;
  const { ledger, reconciler } = makeReconciler(db, {
    handoffKind: 'run-gate',
    execute() {
      calls += 1;
      if (calls < 3) return { outcome: 'deferred', reason: 'waiting for the gate window' };
      return {
        completionReceipt: 'gate-run/workplace-7/receipt-1',
        resultDigest: 'b'.repeat(64),
      };
    },
  });
  const appended = ledger.appendFenced(sampleObligationInput());
  const { totals } = await sweep(reconciler, 3);
  const obligation = ledger.get(appended.obligationKey);
  assert.equal(obligation.state, 'completed',
    'a chain that converges to completion is work — the valve must not fire');
  assert.equal(totals.completed, 1);
  assert.equal(totals.deferred, 2);
  assert.equal(totals.valved, 0);
});

test('V6b: a fresh obligation starts with a zeroed valve counter', () => {
  const db = makeDb();
  const ledger = new SqliteTransitionObligationLedger(db);
  const appended = ledger.appendFenced(sampleObligationInput());
  assert.equal(appended.reasonRepeatCount, 0);
  assert.equal(appended.lastReasonKey, null);
});
