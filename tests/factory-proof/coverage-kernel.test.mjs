// tests/factory-proof/coverage-kernel.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  coverageToken,
  coverageItemsFromScenario,
  buildScenarioCoverageMatrix,
  buildEvidenceCoverageMatrix,
  summarizeCoverage,
  selectScenarioCover,
} from './coverage-kernel.mjs';

function scenario(id, coverageItems, extra = {}) {
  return {
    id,
    kind: 'positive',
    proves: [],
    coverageItems,
    ...extra,
  };
}

test('coverage tokens model gates, transitions, negative transitions and transition pairs without engine changes', () => {
  assert.equal(coverageToken.gate('formalization.acceptance', 'rejected'),
    'gate:formalization.acceptance:rejected');
  assert.equal(coverageToken.transition('authoring', 'verifying'),
    'transition:authoring->verifying');
  assert.equal(coverageToken.negativeTransition('repair_wait', 'terminal'),
    'negative-transition:repair_wait-/->terminal');
  assert.equal(coverageToken.transitionPair('running', 'verifying', 'repair_wait'),
    'transition-pair:running->verifying->repair_wait');
});

test('scenario dimensions automatically include obligations and causal fault taxonomy', () => {
  const items = coverageItemsFromScenario({
    defectId: 'fault/x',
    proves: ['frm.acceptance'],
    faultClass: 'authority-binding',
    injection: { boundary: 'worker-output' },
    expected: { detectorRef: 'gate/x', repairOwner: 'author' },
    counterfactualFeedback: ['absent', 'stale'],
    coverageItems: ['gate:frm:x:rejected'],
  });
  assert.ok(items.includes('obligation:frm.acceptance'));
  assert.ok(items.includes('fault-class:authority-binding'));
  assert.ok(items.includes('injection-boundary:worker-output'));
  assert.ok(items.includes('detector:gate/x'));
  assert.ok(items.includes('repair-owner:author'));
  assert.ok(items.includes('counterfactual:absent'));
  assert.ok(items.includes('gate:frm:x:rejected'));
});

test('exact set cover beats greedy on a corpus where the largest-first choice is suboptimal', () => {
  const required = ['u:1', 'u:2', 'u:3', 'u:4', 'u:5', 'u:6'];
  const scenarios = [
    scenario('A', ['u:1', 'u:2', 'u:3', 'u:4']),
    scenario('B', ['u:1', 'u:2', 'u:5']),
    scenario('C', ['u:3', 'u:4', 'u:6']),
    scenario('D', ['u:5']),
    scenario('E', ['u:6']),
  ];
  const matrix = buildScenarioCoverageMatrix(scenarios, { requiredItems: required });
  const summary = summarizeCoverage(matrix);
  assert.equal(summary.percent, 100);

  const exact = selectScenarioCover(matrix, { exactLimit: 10 });
  assert.equal(exact.exact, true);
  assert.deepEqual(exact.selected, ['B', 'C']);

  const greedy = selectScenarioCover(matrix, { exactLimit: 1 });
  assert.equal(greedy.exact, false);
  assert.deepEqual(greedy.selected, ['A', 'B', 'C']);
});

test('required but unreachable coverage is reported as infeasible, never rounded to green', () => {
  const matrix = buildScenarioCoverageMatrix([
    scenario('only', ['gate:a:accepted']),
  ], { requiredItems: ['gate:a:accepted', 'gate:a:rejected'] });
  assert.deepEqual(matrix.uncovered, ['gate:a:rejected']);
  const selected = selectScenarioCover(matrix);
  assert.equal(selected.feasible, false);
  assert.deepEqual(selected.uncovered, ['gate:a:rejected']);
  assert.equal(summarizeCoverage(matrix).percent, 50);
});

test('evidence coverage counts only passing executions by default', () => {
  const bundles = [
    {
      verdict: 'pass', bundleDigest: 'a'.repeat(64),
      scenario: { id: 'pass', kind: 'positive', proves: [], coverageItems: ['gate:x:accepted'] },
    },
    {
      verdict: 'fail', bundleDigest: 'b'.repeat(64),
      scenario: { id: 'fail', kind: 'causal-fault', proves: [], coverageItems: ['gate:x:rejected'] },
    },
  ];
  const matrix = buildEvidenceCoverageMatrix(bundles, {
    requiredItems: ['gate:x:accepted', 'gate:x:rejected'],
  });
  assert.deepEqual(matrix.scenarios.map(s => s.id), ['pass']);
  assert.deepEqual(matrix.excluded.map(s => s.id), ['fail']);
  assert.deepEqual(matrix.uncovered, ['gate:x:rejected']);

  const diagnostic = buildEvidenceCoverageMatrix(bundles, {
    requiredItems: ['gate:x:accepted', 'gate:x:rejected'],
    requirePass: false,
  });
  assert.equal(diagnostic.uncovered.length, 0);
});
