// tests/factory-proof/discovery-scenario-pack.test.mjs
//
// Contract-level checks for the first workshop pack. No Factory drive here:
// runtime execution lives in discovery-coverage-drive.mjs and is deliberately
// kept out of the blocking matrix until the first local green checkpoint.

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRunnableScenario } from './scenario-runner.mjs';
import {
  DISCOVERY_FULL_COVERAGE_UNIVERSE,
  DISCOVERY_PHASE1_REQUIRED_COVERAGE,
  DISCOVERY_SCENARIOS,
  buildDiscoveryRuntimeCase,
  planDiscoveryCoverage,
} from './discovery-scenario-pack.mjs';

test('Discovery pack: every scenario is valid, unique and runtime-mapped', () => {
  assert.equal(DISCOVERY_SCENARIOS.length, 8);
  const ids = DISCOVERY_SCENARIOS.map(scenario => scenario.id);
  assert.equal(new Set(ids).size, ids.length, 'scenario ids must be unique');

  for (const scenario of DISCOVERY_SCENARIOS) {
    assert.deepEqual(
      validateRunnableScenario(scenario),
      [],
      `${scenario.id} must validate against the unified KernelScenario contract`,
    );
    const runtime = buildDiscoveryRuntimeCase(scenario.id);
    assert.equal(runtime.scenario, scenario);
    assert.ok(runtime.handlers && typeof runtime.handlers === 'object');
    assert.ok(Array.isArray(runtime.oracles) && runtime.oracles.length >= 4);
    assert.ok(runtime.driveOptions && Number.isInteger(runtime.driveOptions.maxCycles));
  }
});

test('Discovery pack: Phase 1 planned coverage is complete and set-cover-feasible', () => {
  const plan = planDiscoveryCoverage();
  assert.equal(plan.phase1.summary.total, DISCOVERY_PHASE1_REQUIRED_COVERAGE.length);
  assert.equal(plan.phase1.summary.covered, DISCOVERY_PHASE1_REQUIRED_COVERAGE.length);
  assert.equal(plan.phase1.summary.percent, 100);
  assert.deepEqual(plan.phase1.summary.uncovered, []);
  assert.equal(plan.phase1.minimalScenarioCover.feasible, true);
  assert.equal(plan.phase1.minimalScenarioCover.uncovered.length, 0);
  assert.ok(plan.phase1.minimalScenarioCover.selected.length > 0);
  assert.ok(
    plan.phase1.minimalScenarioCover.selected.length <= DISCOVERY_SCENARIOS.length,
  );
});

test('Discovery pack: full target remains honestly incomplete before strict recovery/fault work', () => {
  const plan = planDiscoveryCoverage();
  assert.equal(plan.full.summary.total, DISCOVERY_FULL_COVERAGE_UNIVERSE.length);
  assert.ok(plan.full.summary.percent < 100,
    'Phase 1 must not masquerade as full Discovery conformance');
  assert.ok(plan.full.summary.uncovered.includes(
    'transition:produce-proposal->complete-failed',
  ));
  assert.ok(plan.full.summary.uncovered.includes(
    'recovery:discovery-readiness:exact-feedback-repair',
  ));
  assert.ok(plan.full.summary.uncovered.includes(
    'fence:discovery-proposal:stale-execution-denied',
  ));
  assert.equal(plan.full.minimalScenarioCover.feasible, false,
    'a set cover cannot be claimed while required full-conformance items are uncovered');
});

test('Discovery pack: positive outcomes prove all three permissive handoffs', () => {
  const byId = Object.fromEntries(DISCOVERY_SCENARIOS.map(s => [s.id, s]));
  for (const outcome of ['go', 'clarify', 'reject']) {
    const scenario = byId[`discovery/happy-${outcome}`];
    assert.ok(scenario);
    assert.ok(scenario.proves.includes('handoff.route-lifecycle'));
    assert.ok(scenario.coverageItems.includes(
      `handoff:initial-discovery->solution-formalization:${outcome}`,
    ));
    assert.ok(scenario.coverageItems.includes(
      `transition:settle->complete-${outcome}`,
    ));
  }
});
