// tests/factory-proof/development-scenario-pack.test.mjs
//
// Structural pins for the Development pack, tranche D-A:
// - scenario ids unique and runnable-scenario shaped;
// - every scenario maps to a runtime case;
// - the spine's declared coverage is inside the pack's own declarations;
// - HONEST TRANCHE BOUNDARY: the pending D2–D10 universe and the K4 fault
//   edges are explicitly listed — Development closure is NOT claimed.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVELOPMENT_SCENARIOS,
  DEVELOPMENT_PENDING_UNIVERSE,
  DEVELOPMENT_PLATFORM_FAULT_EDGES,
  DEVELOPMENT_TOPOLOGY,
  buildDevelopmentRuntimeCase,
} from './development-scenario-pack.mjs';
import { validateRunnableScenario } from './scenario-runner.mjs';

test('Development topology inventory matches the installed module', () => {
  assert.equal(DEVELOPMENT_TOPOLOGY.moduleRef, 'solution-development@1.4.4');
  const nodeIds = DEVELOPMENT_TOPOLOGY.nodes.map(node => node.id);
  assert.deepEqual(nodeIds, [
    'plan-task-graph',
    'resolve-task-graph',
    'implement-work-items',
    'freeze-integrated-candidate',
    'certify-product-readiness',
    'bind-runnable-candidate',
    'verify-acceptance',
    'settle-development',
  ]);
  assert.deepEqual(DEVELOPMENT_TOPOLOGY.outcomes, ['verified', 'blocked', 'failed']);
  // Continuation variants are part of Development conformance, not optional
  // history (authoring guide §9.2).
  assert.ok(DEVELOPMENT_TOPOLOGY.installedVariants.length >= 3);
});

test('scenario ids are unique and runnable-scenario shaped', () => {
  const ids = DEVELOPMENT_SCENARIOS.map(scenario => scenario.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const scenario of DEVELOPMENT_SCENARIOS) {
    assert.deepEqual(validateRunnableScenario(scenario), [], scenario.id);
    assert.ok(scenario.coverageItems.length > 0);
  }
});

test('every scenario maps to a runtime case with handlers and oracles', () => {
  for (const scenario of DEVELOPMENT_SCENARIOS) {
    const runtime = buildDevelopmentRuntimeCase(scenario.id);
    assert.equal(runtime.scenario.id, scenario.id);
    assert.ok(runtime.handlers && Object.keys(runtime.handlers).length > 0);
    // Multi-phase proofs (restart) run through their dedicated proof runner
    // and carry their oracles there — a specialDrive runtime case has none.
    assert.ok(runtime.oracles.length > 0 || runtime.specialDrive !== undefined);
    assert.ok(runtime.driveOptions.maxCycles > 0);
  }
  assert.throws(() => buildDevelopmentRuntimeCase('development/nonexistent'),
    /DEVELOPMENT_SCENARIO_UNKNOWN/);
});

test('honest tranche boundary: pending universe and K4 edges declared, closure NOT claimed', () => {
  // W2 (2026-08-25): the D2–D10 corpus, the feedback pair, the restart
  // proof and the production-sized satisfiability scenarios LANDED — the
  // pending universe is now exactly the six honestly-undemonstrable tokens
  // (each carrying its precise reason in the pack source). It may only
  // SHRINK by landing a demonstration, never by deletion.
  assert.ok(DEVELOPMENT_PENDING_UNIVERSE.length >= 6,
    'the honest residue must stay explicit');
  assert.ok(DEVELOPMENT_PENDING_UNIVERSE.every(item => /^(D\d+|restart|feedback):/.test(item)));
  assert.ok(DEVELOPMENT_PLATFORM_FAULT_EDGES.length >= 2);
  assert.ok(DEVELOPMENT_PLATFORM_FAULT_EDGES.every(item => item.startsWith('K4:')));
});
