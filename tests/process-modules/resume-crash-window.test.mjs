// tests/process-modules/resume-crash-window.test.mjs
//
// BLINDSIGHT CENSUS, Lifecycle layer F4 + F5.
//
//   F4 — "Anti-cycle budget обнуляется на resume (MED)": the walk's malformed-
//        cycle bound (maxSteps) restarts at zero on every crash-resume, while
//        the durable attempt rows in factory_node_runs accumulate — the
//        attempt counter is write-only. A factory restarted 10 times gets 10
//        fresh anti-cycle budgets.
//
//   F5 — "Resume не видит failed NodeRuns между checkpoint и crash (MED)": the
//        resume cursor is readLastCompletedV2 (the last COMPLETED non-paused
//        NodeRun). Failed NodeRuns written AFTER that cursor and BEFORE the
//        crash are durable, but the resume decision never reads them — the
//        walk continues as if nothing failed ("не молча продолжает как ни в
//        чём не бывало").
//
// CONVEYOR §15 — "Budget must count spin, not work":
//   - the seed charges FAILED durable attempts only (crash-burned budget);
//     completed rows are work and are never taxed;
//   - the spin guard keys on REASON IDENTITY (the same typed error code
//     repeating consecutively), never on bare iteration count — a chain of
//     DISTINCT error codes is converging work and must pass;
//   - the honest end is a typed fail-closed error, not a silent re-execution.
//
// This suite proves:
//   W1  failed rows after the cursor are reported (the F5 delivery);
//   W2  failed rows BEFORE the cursor are not crash-window debris (they are
//       already behind the resume point);
//   W3  the anti-cycle budget seed is the count of ALL durable failed
//       attempts of the process run (a 10x-restarted factory enters with the
//       budget already 10-charged);
//   W4  the same typed error code repeating >= 3 times consecutively on the
//       same node is detected as resume spin; a DISTINCT code between repeats
//       resets the chain (work, not spin);
//   W5  the typed error identity is the CODE prefix before the first colon of
//       the first line (prose after the colon is volatile);
//   W6  the walk wiring: the executor calls the analyzer, seeds its step
//       budget from the durable failed attempts, throws the typed
//       RESUME_SPIN_DETECTED error on spin, and delivers the debris to the
//       engine log (the delivery-to-decision-point contract).
//
// BEFORE the fix this is RED on every group (the analyzer module does not
// exist, and the walk neither seeds nor logs nor fails closed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { analyzeResumeCrashWindow, RESUME_SPIN_REPEAT_THRESHOLD } = await import(
  '../../dist/process-modules/application/resume-crash-window.js'
);

function run(overrides) {
  return {
    id: 1,
    nodeId: 'node-a',
    nodeKind: 'kernel',
    attempt: 1,
    status: 'running',
    event: null,
    outputRef: null,
    outputSchema: null,
    outputHash: null,
    outputBindings: null,
    executionReceipt: null,
    acceptanceReceipt: null,
    recoveryIssue: null,
    errorMessage: null,
    startedAt: '2026-08-18 00:00:00',
    completedAt: null,
    ...overrides,
  };
}

// ===========================================================================
// W1 — the F5 delivery: failed rows between cursor and crash are reported.
// ===========================================================================
test('W1: failed NodeRuns after the resume cursor are reported as crash-window debris', () => {
  const allRuns = [
    run({ id: 10, nodeId: 'node-a', status: 'completed', event: 'runtime.completed' }),
    run({ id: 11, nodeId: 'node-b', status: 'failed', errorMessage: 'PROVIDER_TIMEOUT: provider stalled', attempt: 1 }),
    run({ id: 12, nodeId: 'node-b', status: 'failed', errorMessage: 'PROVIDER_TIMEOUT: provider stalled again', attempt: 2 }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, 10);
  assert.equal(report.failedAfterCursor.length, 2,
    'both failed rows between the cursor and the crash are delivered');
  assert.deepEqual(
    report.failedAfterCursor.map((entry) => entry.nodeId),
    ['node-b', 'node-b'],
  );
  assert.deepEqual(
    report.failedAfterCursor.map((entry) => entry.errorCode),
    ['PROVIDER_TIMEOUT', 'PROVIDER_TIMEOUT'],
    'the typed error identity is the CODE prefix, not the prose');
  assert.deepEqual(
    report.failedAfterCursor.map((entry) => entry.attempt),
    [1, 2],
  );
});

test('W1b: with no completed cursor every failed row of the run is crash-window debris', () => {
  const allRuns = [
    run({ id: 1, nodeId: 'entry', status: 'failed', errorMessage: 'ECONNREFUSED: no route' }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, null);
  assert.equal(report.failedAfterCursor.length, 1,
    'a run that never completed a node still reports its failed attempts');
});

// ===========================================================================
// W2 — failed rows before the cursor are behind the resume point.
// ===========================================================================
test('W2: failed rows before the cursor are not crash-window debris', () => {
  const allRuns = [
    run({ id: 10, nodeId: 'node-a', status: 'failed', errorMessage: 'SQLITE_BUSY: locked' }),
    run({ id: 11, nodeId: 'node-a', status: 'completed', event: 'runtime.completed', attempt: 2 }),
    run({ id: 12, nodeId: 'node-b', status: 'failed', errorMessage: 'SQLITE_BUSY: locked' }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, 11);
  assert.equal(report.failedAfterCursor.length, 1,
    'only the failure after the cursor is debris; the pre-cursor failure '
    + 'converged (a later attempt completed) and is history, not a blind spot');
  assert.equal(report.failedAfterCursor[0].nodeId, 'node-b');
});

// ===========================================================================
// W3 — the F4 seed: the budget is charged by durable FAILED attempts.
// ===========================================================================
test('W3: the anti-cycle seed is the count of all durable failed attempts', () => {
  const allRuns = [
    run({ id: 10, nodeId: 'node-a', status: 'completed', event: 'runtime.completed' }),
    run({ id: 11, nodeId: 'node-a', status: 'failed', errorMessage: 'X: pre-cursor' }),
    run({ id: 12, nodeId: 'node-b', status: 'failed', errorMessage: 'Y: post-cursor' }),
    run({ id: 13, nodeId: 'node-c', status: 'completed', event: 'runtime.completed' }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, 10);
  assert.equal(report.durableFailedAttempts, 2,
    'the seed charges failed attempts across the WHOLE run (durable '
      + 'attempt-counter), never completed work — §15: work is not taxed');
});

test('W3b: a clean run seeds zero', () => {
  const allRuns = [
    run({ id: 10, nodeId: 'node-a', status: 'completed', event: 'runtime.completed' }),
    run({ id: 11, nodeId: 'node-b', status: 'running' }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, 10);
  assert.equal(report.durableFailedAttempts, 0);
  assert.equal(report.failedAfterCursor.length, 0,
    'a hard crash leaves the row status=running (not failed) — no debris');
});

// ===========================================================================
// W4 — the spin guard: reason identity, not iteration count.
// ===========================================================================
test('W4: the same typed code repeating on the same node is resume spin', () => {
  const allRuns = [
    run({ id: 10, nodeId: 'node-a', status: 'completed', event: 'runtime.completed' }),
    run({ id: 11, nodeId: 'node-b', status: 'failed', errorMessage: 'REPLAY_CORRUPT: capsule bad', attempt: 1 }),
    run({ id: 12, nodeId: 'node-b', status: 'failed', errorMessage: 'REPLAY_CORRUPT: capsule worse', attempt: 2 }),
    run({ id: 13, nodeId: 'node-b', status: 'failed', errorMessage: 'REPLAY_CORRUPT: capsule still bad', attempt: 3 }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, 10);
  assert.ok(report.spin, 'three consecutive same-code failures on the re-entered node trip the guard');
  assert.equal(report.spin.nodeId, 'node-b');
  assert.equal(report.spin.errorCode, 'REPLAY_CORRUPT');
  assert.equal(report.spin.consecutive, 3);
  assert.equal(RESUME_SPIN_REPEAT_THRESHOLD, 3,
    'the threshold matches the §15 valve constant (3)');
});

test('W4b: a distinct code between repeats resets the chain (work, not spin)', () => {
  const allRuns = [
    run({ id: 10, nodeId: 'node-a', status: 'completed', event: 'runtime.completed' }),
    run({ id: 11, nodeId: 'node-b', status: 'failed', errorMessage: 'SQLITE_BUSY: locked', attempt: 1 }),
    run({ id: 12, nodeId: 'node-b', status: 'failed', errorMessage: 'PROVIDER_TIMEOUT: stall', attempt: 2 }),
    run({ id: 13, nodeId: 'node-b', status: 'failed', errorMessage: 'SQLITE_BUSY: locked again', attempt: 3 }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, 10);
  assert.equal(report.spin, null,
    'a converging chain of DISTINCT codes never trips the identity guard');
});

test('W4c: two repeats are below the threshold (transient crash-retry is tolerated)', () => {
  const allRuns = [
    run({ id: 10, nodeId: 'node-a', status: 'completed', event: 'runtime.completed' }),
    run({ id: 11, nodeId: 'node-b', status: 'failed', errorMessage: 'SQLITE_BUSY: locked', attempt: 1 }),
    run({ id: 12, nodeId: 'node-b', status: 'failed', errorMessage: 'SQLITE_BUSY: locked', attempt: 2 }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, 10);
  assert.equal(report.spin, null);
});

test('W4d: spin on a DIFFERENT node than the failures does not project', () => {
  const allRuns = [
    run({ id: 10, nodeId: 'node-a', status: 'completed', event: 'runtime.completed' }),
    run({ id: 11, nodeId: 'node-b', status: 'failed', errorMessage: 'REPLAY_CORRUPT: bad', attempt: 1 }),
    run({ id: 12, nodeId: 'node-b', status: 'failed', errorMessage: 'REPLAY_CORRUPT: bad', attempt: 2 }),
    run({ id: 13, nodeId: 'node-b', status: 'failed', errorMessage: 'REPLAY_CORRUPT: bad', attempt: 3 }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, 10, 'node-c');
  assert.equal(report.spin, null,
    'the guard applies to the node the resume is about to re-enter');
});

// ===========================================================================
// W5 — typed error identity extraction.
// ===========================================================================
test('W5: error identity is the first-line CODE prefix with a whole-line fallback', () => {
  const allRuns = [
    run({ id: 11, status: 'failed', errorMessage: 'CODE_X: prose with\nsecond line' }),
    run({ id: 12, status: 'failed', errorMessage: 'no colon whole line identity' }),
  ];
  const report = analyzeResumeCrashWindow(allRuns, null);
  assert.equal(report.failedAfterCursor[0].errorCode, 'CODE_X');
  assert.equal(report.failedAfterCursor[1].errorCode, 'no colon whole line identity');
});

// ===========================================================================
// W6 — the delivery-to-decision-point wiring inside the walk.
// ===========================================================================
test('W6: the walk seeds its budget, logs the debris and fails closed on spin', () => {
  const executorSource = readFileSync(
    new URL(
      '../../src/process-modules/application/generic-flow-executor.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(executorSource, /analyzeResumeCrashWindow\(/,
    'the walk must call the resume-crash-window analyzer at its resume point');
  assert.match(executorSource, /durableFailedAttempts/,
    'the walk\'s step budget must be seeded from the durable failed attempts');
  assert.match(executorSource, /RESUME_SPIN_DETECTED/,
    'the walk must fail closed with the typed RESUME_SPIN_DETECTED error');
  assert.match(executorSource, /RESUME-DEBRIS/,
    'the crash-window debris must be delivered to the engine log');
});

test('W6b: the epoch reader delivers last_diagnosis to the rollover decision', () => {
  const runtimeSource = readFileSync(
    new URL('../../src/app/product-lifecycle-runtime.ts', import.meta.url),
    'utf8',
  );
  assert.match(runtimeSource, /last_diagnosis/,
    'readRecoveryEpochBaseline must SELECT the persisted last_diagnosis');
  const executorSource = readFileSync(
    new URL(
      '../../src/process-modules/application/node-executors/production-cell-node-executor.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(executorSource, /lastDiagnosis/,
    'the rollover decision must read the previous epoch diagnosis from the baseline');
});
