// tests/process-modules/replan-graph-checks.test.mjs
//
// RE-PLAN CYCLE (REPLAN-CYCLE-TZ §2 step 4) — the cycle-2 graph contract,
// units T4/T5 of 9. The cycle-2 planner sees the whole integrated cycle-1
// code, so the re-carve MUST exploit it (the operator's parallelism demand):
//
//   T4 Parallelism — two implementation items with NON-overlapping changeScopes
//      must NOT carry a dependency edge between them (serialization
//      anti-pattern: it starves concurrency=2 for no safety reason).
//   T5 Shared-surface — every path that burned path-outside-authority in
//      cycle 1 must be INSIDE some cycle-2 item's changeScopes (either the
//      scopes are re-carved around it, or a base-item owns it): otherwise the
//      cycle-2 planner reproduced the exact burn and the ratchet will deny
//      cycle 3.
//
// Plus the module-shape guards: the replan continuation module inserts the
// planner node ('replan-task-graph') BEFORE resolve-task-graph and restores
// the planner execution profile, while the plain continuation module stays
// deterministic (no planner) — the filter is conditional on the cycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parallelismViolations,
  uncoveredSharedSurfacePaths,
} = await import('../../dist/modules/development/domain/replan-graph-checks.js');
const {
  developmentContinuationProcessModule,
  developmentReplanContinuationProcessModule,
  DEVELOPMENT_REPLAN_CONTINUATION_PROCESS_MODULE_REF,
} = await import('../../dist/process-modules/modules/development/development-continuation-process-module.js');

function item(key, changeScopes, dependsOnKeys = []) {
  return { key, changeScopes, dependsOnKeys };
}

// The stage-11 cycle-1 burn: src/physics/spacecraft.js sat outside
// [package.json, src/game/, tests/].
const STAGE11_VIOLATION = {
  findingKey: 'development.implementation-scope.v1:path-outside-authority::Git paths [src/physics/spacecraft.js] are outside frozen changeScopes [package.json, src/game/, tests/].',
  paths: ['src/physics/spacecraft.js'],
  scopes: ['package.json', 'src/game/', 'tests/'],
};

test('T4 RED: a dependency edge between NON-overlapping scopes is a serialization anti-pattern', () => {
  // cycle-2 carve: physics-core owns src/physics/, ui-shell owns src/ui/ —
  // disjoint, yet the planner serialized them with a needless edge.
  const serialized = [
    item('impl-physics-core', ['src/physics/'], []),
    item('impl-ui-shell', ['src/ui/'], ['impl-physics-core']),
  ];
  const violations = parallelismViolations(serialized);
  assert.equal(violations.length, 1,
    'the needless edge must be flagged — concurrency=2 can never engage');
  assert.equal(violations[0].code, 'replan-serialization-antipattern');
  assert.match(violations[0].message, /impl-physics-core/);
  assert.match(violations[0].message, /impl-ui-shell/);

  // Same items WITHOUT the edge (or with genuinely overlapping scopes + an
  // order) stay clean.
  assert.deepEqual(parallelismViolations([
    item('impl-physics-core', ['src/physics/'], []),
    item('impl-ui-shell', ['src/ui/'], []),
  ]), [], 'disjoint scopes without an edge run in parallel — no violation');
  assert.deepEqual(parallelismViolations([
    item('impl-shared-surface', ['src/engine/'], []),
    // Overlapping scope on src/engine/vectors.js REQUIRES the order — legal.
    item('impl-physics-core', ['src/engine/vectors.js', 'src/physics/'], ['impl-shared-surface']),
  ]), [], 'an edge between OVERLAPPING scopes is required safety, not an anti-pattern');
});

test('T5 RED: a cycle-1 path-outside-authority burn must be INSIDE some cycle-2 scope (shared-surface extraction)', () => {
  // The planner reproduced the burn: nothing owns src/physics/spacecraft.js.
  const reproduced = uncoveredSharedSurfacePaths([STAGE11_VIOLATION], [
    item('impl-ui-shell', ['src/ui/'], []),
    item('impl-game-loop', ['src/game/', 'tests/'], []),
  ]);
  assert.equal(reproduced.length, 1);
  assert.equal(reproduced[0].code, 'replan-shared-surface-unassigned');
  assert.match(reproduced[0].message, /src\/physics\/spacecraft\.js/);

  // Shared-surface extraction: a base-item owns the previously-burned path
  // (scopes re-carved) and the consumers depend on it.
  const extracted = uncoveredSharedSurfacePaths([STAGE11_VIOLATION], [
    item('base-physics-surface', ['src/physics/'], []),
    item('impl-game-loop', ['src/game/', 'tests/'], []),
    item('impl-ui-shell', ['src/ui/'], []),
  ]);
  assert.deepEqual(extracted, [],
    'a cycle-2 item whose scope covers the burned path satisfies the shared-surface contract');
});

test('module shape: the REPLAN continuation module inserts the planner BEFORE resolve-task-graph and restores the planner profile', () => {
  const module = developmentReplanContinuationProcessModule;
  const ids = module.flow.nodes.map(node => node.id);
  const replanIndex = ids.indexOf('replan-task-graph');
  const resolveIndex = ids.indexOf('resolve-task-graph');
  assert.ok(replanIndex !== -1, 'the replan planner node exists');
  assert.ok(replanIndex < resolveIndex, 'the planner runs BEFORE the resolver');
  assert.equal(module.flow.entryNodeId, 'replan-task-graph');
  assert.ok(module.executionProfiles.some(profile =>
    profile.id === 'development-task-graph-planner'),
    'the planner execution profile is restored in the replan cycle');
  assert.ok(module.flow.transitions.some(transition =>
    transition.from === 'replan-task-graph' && transition.to === 'resolve-task-graph'
    && transition.on === 'domain.accepted'),
    'the accepted planner proposal flows into the resolver');
  // The replan planner gate carries the cycle-2 checks (base task-graph
  // provider + the replan parallelism/shared-surface provider).
  const plannerNode = module.flow.nodes[replanIndex];
  const providerIds = plannerNode.cellDefinition.authorGate.checkPlan.entries
    .map(entry => entry.check.providerId);
  assert.ok(providerIds.includes('development.replan-graph.v1'),
    'the cycle-2 gate runs the replan-graph check');
  assert.equal(DEVELOPMENT_REPLAN_CONTINUATION_PROCESS_MODULE_REF.version, '1.2.0');
});

test('module shape guard: the PLAIN continuation module stays deterministic (no planner inference)', () => {
  const ids = developmentContinuationProcessModule.flow.nodes.map(node => node.id);
  assert.equal(ids.includes('plan-task-graph'), false);
  assert.equal(ids.includes('replan-task-graph'), false,
    'the plain continuation never gains a planner — only the replan cycle does');
  assert.equal(developmentContinuationProcessModule.flow.entryNodeId, 'resolve-task-graph');
});
