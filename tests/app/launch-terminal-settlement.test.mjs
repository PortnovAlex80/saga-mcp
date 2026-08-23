// tests/app/launch-terminal-settlement.test.mjs
//
// CC-GAP-2 — the launch/order/exit settlement must separate OPERATIONAL
// completion from the business verdict channels.
//
// The defect (found by the CC qualification audit): orchestrate-cli mapped
// `reason === 'completed'` (the lifecycle MACHINE finishing a routed terminal)
// straight onto launch 'completed' + order 'completed' + exit 0, with the
// business verdict (`terminal_status`, e.g. 'development-blocked',
// 'approval-required') nowhere next to those labels — so exit 0 / 'completed'
// read as product success (stage-19 post-mortem had to open the DB to prove
// the label truthful).
//
// The fix (src/app/launch-terminal-settlement.ts) keeps the operational
// mapping byte-for-byte (backward compatibility is pinned below) and ADDS the
// verdict channels. Terminal statuses are declarative per lifecycle package;
// the engine must NOT classify them (workshop-agnostic) — it must carry them.

import test from 'node:test';
import assert from 'node:assert/strict';

const { settleLaunchFromRunResult } = await import('../../dist/app/launch-terminal-settlement.js');

/** Minimal OrchestrationRunResult shaped like the lifecycle adapter's output. */
function runResult(overrides = {}) {
  return {
    projectId: 1,
    epicId: 1,
    finalStage: 'solution-development',
    endedAt: '2026-08-22T00:00:00.000Z',
    reason: 'completed',
    cycles: 3,
    lastError: null,
    lifecycleRun: {
      id: 42,
      ref: 'product-delivery@1.0.0',
      status: 'completed',
      currentStageId: null,
      terminalStatus: 'released',
    },
    processOutcome: {
      code: 'released',
      authority: 'delivery-settlement@1.0.0',
      outputRef: 'artifact:release-bundle:1',
    },
    outcome: 'released',
    outcomeAuthority: 'delivery-settlement@1.0.0',
    ...overrides,
  };
}

test('the gap counterexample: a lifecycle-completed run with a FAILURE-class verdict settles completed/exit-0 operationally, and the verdict travels WITH it — never implied', () => {
  const result = runResult({
    lifecycleRun: {
      id: 43,
      ref: 'product-delivery@1.0.0',
      status: 'completed',
      currentStageId: null,
      terminalStatus: 'development-blocked',
    },
    processOutcome: {
      code: 'blocked',
      authority: 'development-settlement@1.0.0',
      outputRef: null,
    },
    outcome: 'development-blocked',
  });
  const settlement = settleLaunchFromRunResult(result);

  // Operational facts (unchanged contract): the engine DID bring the run to a
  // lifecycle terminal state; the launch settled normally.
  assert.equal(settlement.operationalTerminal, true);
  assert.equal(settlement.launchState, 'completed');
  assert.equal(settlement.orderState, 'completed');
  assert.equal(settlement.exitCode, 0);
  assert.equal(settlement.launchError, null);

  // Separated verdict channels: exit 0 never travels without its verdict.
  assert.equal(settlement.lifecycleStatus, 'completed');
  assert.equal(settlement.lifecycleTerminalStatus, 'development-blocked');
  assert.equal(settlement.stageOutcome, 'blocked');
  assert.equal(settlement.productOutcome, 'development-blocked');

  // The separation itself: the operational word 'completed' must NOT appear
  // as a verdict, and the verdict must NOT flip the operational mapping.
  assert.notEqual(settlement.lifecycleTerminalStatus, settlement.launchState);
  assert.notEqual(settlement.productOutcome, 'completed');
});

test('stage-19 shape: terminal_status wins the product outcome, the stage-local outcome stays its own channel', () => {
  const settlement = settleLaunchFromRunResult(runResult({
    lifecycleRun: {
      id: 2,
      ref: 'solution-delivery@1.0.0',
      status: 'completed',
      currentStageId: null,
      terminalStatus: 'runnable-local',
    },
    processOutcome: {
      code: 'verified',
      authority: 'development-settlement@1.0.0',
      outputRef: 'artifact:run-receipt:7',
    },
    outcome: 'runnable-local',
  }));

  assert.equal(settlement.exitCode, 0);
  assert.equal(settlement.launchState, 'completed');
  assert.equal(settlement.lifecycleTerminalStatus, 'runnable-local');
  assert.equal(settlement.stageOutcome, 'verified');
  assert.equal(settlement.productOutcome, 'runnable-local');
});

test('paused: operational non-terminal — launch/order paused, exit 2, no verdict invented (backward-compatible)', () => {
  const settlement = settleLaunchFromRunResult(runResult({
    reason: 'paused',
    lifecycleRun: {
      id: 44,
      ref: 'product-delivery@1.0.0',
      status: 'paused',
      currentStageId: 'solution-development',
      terminalStatus: null,
    },
    processOutcome: undefined,
    outcome: undefined,
  }));

  assert.equal(settlement.operationalTerminal, false);
  assert.equal(settlement.launchState, 'paused');
  assert.equal(settlement.orderState, 'paused');
  assert.equal(settlement.exitCode, 2);
  assert.equal(settlement.exitReason, 'paused');
  assert.equal(settlement.launchError, null);
  assert.equal(settlement.lifecycleTerminalStatus, null);
  assert.equal(settlement.stageOutcome, null);
  assert.equal(settlement.productOutcome, null);
});

test('failed: operational failure — launch failed, order start_failed, exit 1, error payload preserved (backward-compatible)', () => {
  // Real fail() shape: the repository stamps terminal_status='failed'; the
  // failed stage never settled, so the adapter emits no processOutcome and
  // outcome = terminalStatus = 'failed'.
  const result = runResult({
    reason: 'failed',
    lastError: 'Lifecycle exceeded its transition budget of 100',
    lifecycleRun: {
      id: 45,
      ref: 'product-delivery@1.0.0',
      status: 'failed',
      currentStageId: 'solution-development',
      terminalStatus: 'failed',
    },
    processOutcome: undefined,
    outcome: 'failed',
  });
  const settlement = settleLaunchFromRunResult(result);

  assert.equal(settlement.launchState, 'failed');
  assert.equal(settlement.orderState, 'start_failed');
  assert.equal(settlement.exitCode, 1);
  assert.equal(settlement.exitReason, 'failed');
  // The legacy CLI embedded the full result JSON as the launch error.
  assert.equal(settlement.launchError, JSON.stringify(result));
  assert.deepEqual(JSON.parse(settlement.launchError), JSON.parse(JSON.stringify(result)));
  // Repository-stamped verdict channels: 'failed' is a verdict, not inferred
  // from the operational failure.
  assert.equal(settlement.lifecycleTerminalStatus, 'failed');
  assert.equal(settlement.stageOutcome, null);
  assert.equal(settlement.productOutcome, 'failed');
});

test('cancelled (reason stopped): settles completed/exit-0 operationally; the repository-stamped cancel verdict travels — never a fabricated success', () => {
  // Real cancel() shape: terminal_status='cancelled' is stamped by the
  // repository; the cancelled stage never settled (no processOutcome), and
  // outcome = terminalStatus = 'cancelled'.
  const settlement = settleLaunchFromRunResult(runResult({
    reason: 'stopped',
    lifecycleRun: {
      id: 46,
      ref: 'product-delivery@1.0.0',
      status: 'cancelled',
      currentStageId: 'formalization',
      terminalStatus: 'cancelled',
    },
    processOutcome: undefined,
    outcome: 'cancelled',
  }));

  assert.equal(settlement.operationalTerminal, true);
  assert.equal(settlement.launchState, 'completed');
  assert.equal(settlement.exitCode, 0);
  assert.equal(settlement.exitReason, 'stopped');
  // An operational stop is not product success: the stamped verdict says so.
  assert.equal(settlement.lifecycleStatus, 'cancelled');
  assert.equal(settlement.lifecycleTerminalStatus, 'cancelled');
  assert.equal(settlement.stageOutcome, null);
  assert.equal(settlement.productOutcome, 'cancelled');
  assert.notEqual(settlement.productOutcome, settlement.launchState);
});

test('backward-compatibility pin: the operational mapping equals the legacy inline CLI mapping for every reason class', () => {
  const legacyMapping = (result) => {
    const isTerminal = result.reason !== 'paused';
    return {
      launchState: isTerminal ? (result.reason === 'failed' ? 'failed' : 'completed') : 'paused',
      orderState: isTerminal ? (result.reason === 'failed' ? 'start_failed' : 'completed') : 'paused',
      launchError: result.reason === 'failed' ? JSON.stringify(result) : null,
      exitCode: isTerminal ? (result.reason === 'failed' ? 1 : 0) : 2,
    };
  };
  for (const reason of ['completed', 'failed', 'paused', 'stopped']) {
    const result = runResult({ reason });
    const settlement = settleLaunchFromRunResult(result);
    const legacy = legacyMapping(result);
    assert.equal(settlement.launchState, legacy.launchState, `launchState for ${reason}`);
    assert.equal(settlement.orderState, legacy.orderState, `orderState for ${reason}`);
    assert.equal(settlement.launchError, legacy.launchError, `launchError for ${reason}`);
    assert.equal(settlement.exitCode, legacy.exitCode, `exitCode for ${reason}`);
  }
});
