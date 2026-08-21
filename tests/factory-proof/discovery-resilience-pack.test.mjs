// tests/factory-proof/discovery-resilience-pack.test.mjs
// Contract-level closure checks only; no Factory drive.

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRunnableScenario } from './scenario-runner.mjs';
import {
  DISCOVERY_CLOSURE_COVERAGE_UNIVERSE,
  DISCOVERY_CLOSURE_SCENARIOS,
  DISCOVERY_PLATFORM_FAULT_EDGES,
  DISCOVERY_RESILIENCE_SCENARIOS,
  buildDiscoveryUnifiedRuntimeCase,
  planDiscoveryClosureCoverage,
} from './discovery-resilience-pack.mjs';

test('Discovery closure: every scenario is unique, valid and runtime-mapped', () => {
  assert.equal(DISCOVERY_RESILIENCE_SCENARIOS.length, 19);
  assert.equal(DISCOVERY_CLOSURE_SCENARIOS.length, 27);
  const ids = DISCOVERY_CLOSURE_SCENARIOS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const scenario of DISCOVERY_CLOSURE_SCENARIOS) {
    assert.deepEqual(validateRunnableScenario(scenario), [], scenario.id);
    const runtime = buildDiscoveryUnifiedRuntimeCase(scenario.id);
    assert.equal(runtime.scenario, scenario);
    assert.ok(runtime.handlers && typeof runtime.handlers === 'object');
    if (runtime.specialDrive) {
      assert.equal(runtime.specialDrive, 'discovery-restart-idempotency');
    } else {
      assert.ok(Array.isArray(runtime.oracles) && runtime.oracles.length >= 3);
      assert.ok(Number.isInteger(runtime.driveOptions?.maxCycles));
    }
  }
});

test('Discovery closure: planned workshop coverage is exactly complete', () => {
  const plan = planDiscoveryClosureCoverage();
  assert.equal(plan.summary.total, DISCOVERY_CLOSURE_COVERAGE_UNIVERSE.length);
  assert.equal(plan.summary.covered, DISCOVERY_CLOSURE_COVERAGE_UNIVERSE.length);
  assert.equal(plan.summary.percent, 100);
  assert.deepEqual(plan.summary.uncovered, []);
  assert.equal(plan.minimalScenarioCover.feasible, true);
  assert.deepEqual(plan.minimalScenarioCover.uncovered, []);
});

test('Discovery closure: all requested resilience axes are load-bearing coverage items', () => {
  const required = new Set(DISCOVERY_CLOSURE_COVERAGE_UNIVERSE);
  for (const target of ['proposal', 'readiness']) {
    for (const item of [
      `recovery:discovery-${target}:exact-feedback-repair`,
      `counterfactual:discovery-${target}:absent-feedback-no-magical-repair`,
      `counterfactual:discovery-${target}:stale-feedback-no-magical-repair`,
      `counterfactual:discovery-${target}:corrupted-feedback-no-magical-repair`,
      `crash:discovery-${target}:bounded-recovery`,
      `recovery:discovery-${target}:retry-exhaustion-bounded-epoch`,
      `idempotency:discovery-${target}:duplicate-submit`,
      `tool-lifecycle:discovery-${target}:late-call-denied`,
      `fence:discovery-${target}:stale-execution-denied`,
    ]) assert.ok(required.has(item), `missing ${item}`);
  }
  for (const item of [
    'restart:discovery:same-input-replay',
    'restart:discovery:incompatible-input-cold',
    'idempotency:discovery:semantic-start-replay',
  ]) assert.ok(required.has(item), `missing ${item}`);
});

test('Discovery closure: internal failed routes remain explicitly K4 platform-owned', () => {
  assert.deepEqual(
    DISCOVERY_PLATFORM_FAULT_EDGES,
    [
      'transition:produce-proposal->complete-failed',
      'transition:assess-readiness->complete-failed',
      'transition:settle->complete-failed',
    ],
  );
  for (const edge of DISCOVERY_PLATFORM_FAULT_EDGES) {
    assert.ok(!DISCOVERY_CLOSURE_COVERAGE_UNIVERSE.includes(edge), edge);
  }
});
