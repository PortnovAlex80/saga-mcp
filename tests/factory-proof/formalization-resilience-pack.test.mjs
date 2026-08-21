// tests/factory-proof/formalization-resilience-pack.test.mjs
// Contract-level closure checks only; no Factory drive.

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRunnableScenario } from './scenario-runner.mjs';
import {
  FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE,
  FORMALIZATION_CLOSURE_SCENARIOS,
  FORMALIZATION_RESILIENCE_SCENARIOS,
  buildFormalizationUnifiedRuntimeCase,
  planFormalizationClosureCoverage,
} from './formalization-resilience-pack.mjs';
import {
  FORMALIZATION_PLATFORM_FAULT_EDGES,
  FORMALIZATION_TARGETS,
} from './formalization-scenario-pack.mjs';

test('Formalization closure: every scenario is unique, valid and runtime-mapped', () => {
  assert.equal(FORMALIZATION_RESILIENCE_SCENARIOS.length, 18);
  assert.equal(FORMALIZATION_CLOSURE_SCENARIOS.length, 26);
  const ids = FORMALIZATION_CLOSURE_SCENARIOS.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);

  for (const scenario of FORMALIZATION_CLOSURE_SCENARIOS) {
    assert.deepEqual(validateRunnableScenario(scenario), [], scenario.id);
    const runtime = buildFormalizationUnifiedRuntimeCase(scenario.id);
    assert.equal(runtime.scenario, scenario);
    assert.ok(runtime.handlers && typeof runtime.handlers === 'object');
    if (runtime.specialDrive) {
      assert.ok([
        'formalization-restart-idempotency',
        'formalization-retry-exhaustion',
      ].includes(runtime.specialDrive), runtime.specialDrive);
    } else {
      assert.ok(Array.isArray(runtime.oracles) && runtime.oracles.length >= 2);
      assert.ok(Number.isInteger(runtime.driveOptions?.maxCycles));
    }
  }
});

test('Formalization closure: planned workshop coverage is exactly complete', () => {
  const plan = planFormalizationClosureCoverage();
  assert.equal(plan.summary.total, FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE.length);
  assert.equal(plan.summary.covered, FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE.length);
  assert.equal(plan.summary.percent, 100);
  assert.deepEqual(plan.summary.uncovered, []);
  assert.equal(plan.minimalScenarioCover.feasible, true);
  assert.deepEqual(plan.minimalScenarioCover.uncovered, []);
});

test('Formalization closure: every reviewed Cell has crash and terminal exhaustion obligations', () => {
  const required = new Set(FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE);
  for (const target of Object.values(FORMALIZATION_TARGETS)) {
    assert.ok(required.has(`crash:${target.cell}:bounded-recovery`), target.cell);
    assert.ok(required.has(`recovery:${target.cell}:retry-exhaustion-terminal`), target.cell);
    assert.ok(required.has(`transition:${target.node}->complete-failed`), target.node);
  }
});

test('Formalization closure: causal feedback, fence, tool lifecycle and restart are load-bearing', () => {
  const required = new Set(FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE);
  for (const item of [
    'recovery:formalization-reviewed-cell:exact-feedback-repair',
    'counterfactual:formalization-reviewed-cell:absent-feedback-no-magical-repair',
    'counterfactual:formalization-reviewed-cell:stale-feedback-no-magical-repair',
    'counterfactual:formalization-reviewed-cell:corrupted-feedback-no-magical-repair',
    'idempotency:formalization-reconciliation:duplicate-submit',
    'tool-lifecycle:formalization-reconciliation:late-call-denied',
    'fence:formalization-product-contract:stale-execution-denied',
    'restart:formalization:same-input-replay',
    'restart:formalization:incompatible-input-cold',
    'idempotency:formalization:semantic-start-replay',
  ]) assert.ok(required.has(item), item);
});

test('Formalization closure: internal kernel/effect timing faults remain explicitly K4-owned', () => {
  assert.deepEqual(FORMALIZATION_PLATFORM_FAULT_EDGES, [
    'transition:freeze-acceptance-baseline->complete-inconsistent',
    'transition:freeze-acceptance-baseline->complete-failed',
    'transition:settle-formalization->complete-inconsistent',
    'transition:settle-formalization->complete-failed',
    'effect-fault:formalization-accept-products:post-gate-pre-effect-drift',
  ]);
  for (const edge of FORMALIZATION_PLATFORM_FAULT_EDGES) {
    assert.ok(!FORMALIZATION_CLOSURE_COVERAGE_UNIVERSE.includes(edge), edge);
  }
});
