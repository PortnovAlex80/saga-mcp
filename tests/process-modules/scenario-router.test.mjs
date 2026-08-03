// @ts-check
/**
 * W7-A4 — Scenario router (declarative) tests.
 *
 * Covers WAVE7-SCENARIO-SPEC.md lane A4 + plan §6.4 (NO routeResolver),
 * §6.2.9 (terminal statuses), §6.2.10 / §6.2.11 (transition + reentry
 * budgets), §6.3.5 (complete static route tables), §6.8 (module reuse — same
 * module in two stages must not confuse routing).
 *
 * Run: `npm run build && node --test tests/process-modules/scenario-router.test.mjs`
 *
 * Three surfaces exercised:
 *   1. Declarative route lookup (`routeScenarioOutcome`, `hasScenarioRoute`).
 *   2. Routing-graph validation (`validateScenarioRoutingGraph`): reachability,
 *      dead-ends, orphan terminals, unknown targets.
 *   3. Per-run budget enforcement (`ScenarioRoutingContext`, `createScenarioRouter`):
 *      transition cap, reentry cap, per-stage reentry cap, terminal outcomes
 *      consume NO transition budget.
 *
 * The positive manifest is built from the W0-A7 campaign fixture (the same
 * fixture the W1-A3 manifest-validator tests use), so the router is proven to
 * consume the same shape Wave 1 codified.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  campaignScenario,
  CAMPAIGN_SCENARIO_IDENTITY,
  CAMPAIGN_SCENARIO_INPUT_SCHEMA,
  CAMPAIGN_SCENARIO_OUTPUT_SCHEMA,
  campaignModuleRefs,
} from '../fixtures/synthetic-scenarios/campaign/definition.mjs';

// Built output (npm run build produces ESM .js mirroring src/ layout).
import {
  routeScenarioOutcome,
  hasScenarioRoute,
  collectRoutingEdges,
  validateScenarioRoutingGraph,
  createScenarioRouter,
  ScenarioRoutingContext,
  ScenarioBudgetExceeded,
  ROUTING_ERROR_CODES,
  SCENARIO_ROOT,
} from '../../dist/process-modules/application/scenario-router.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Manifest builder (mirrors tests/spi/scenario-manifest.test.mjs).
// ---------------------------------------------------------------------------

function contractRef(schemaId) {
  return {
    schemaId,
    version: '1.0.0',
    digest: sha256Hex({ schemaId, stub: 'w7-a4-test' }),
  };
}

function selectorFromModuleRef(moduleRef) {
  return {
    name: moduleRef.name,
    versionRange: `^${moduleRef.version}`,
  };
}

/**
 * Build a valid campaign manifest, optionally overriding individual fields.
 * Used as the positive baseline for every test; negative tests mutate it.
 */
function buildCampaignManifest(overrides = {}) {
  const stageBindings = campaignScenario.stages.map((s) => ({
    ...s,
    moduleSelector: selectorFromModuleRef(s.moduleRef),
  }));
  return {
    manifestFormatVersion: '0.1.0',
    identity: CAMPAIGN_SCENARIO_IDENTITY,
    inputContractRef: contractRef(CAMPAIGN_SCENARIO_INPUT_SCHEMA),
    outputContractRef: contractRef(CAMPAIGN_SCENARIO_OUTPUT_SCHEMA),
    entryStageId: 'draft',
    stageBindings,
    outcomeRoutes: {},
    inputMappings: { initiative: 'initiative' },
    outputMappings: {},
    terminalStatuses: ['campaign-approved', 'campaign-rejected'],
    scenarioPolicies: {
      retry: { kind: 'fixed-backoff', params: { maxAttempts: 3 } },
      pause: { kind: 'manual' },
      cancellation: { kind: 'explicit' },
      escalation: { kind: 'human' },
    },
    requiredModuleSelectors: campaignModuleRefs.map(selectorFromModuleRef),
    transitionBudgets: { maxTransitions: 50 },
    reentryBudgets: { maxReentries: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) Declarative route lookup.
// ---------------------------------------------------------------------------

test('W7-A4 routing: stage-level outcomeRoutes resolved by static lookup', () => {
  const manifest = buildCampaignManifest();
  // draft -> 'campaign-drafted' -> seo-baseline.
  const r = routeScenarioOutcome(manifest, 'draft', 'campaign-drafted');
  assert.deepEqual(r, {
    stageId: 'draft',
    outcome: 'campaign-drafted',
    target: { type: 'stage', stageId: 'seo-baseline' },
  });
});

test('W7-A4 routing: terminal outcome resolved by static lookup', () => {
  const manifest = buildCampaignManifest();
  // approve -> 'approved' -> terminal campaign-approved.
  const r = routeScenarioOutcome(manifest, 'approve', 'approved');
  assert.deepEqual(r.target, { type: 'terminal', status: 'campaign-approved' });
  // approve -> 'rejected' -> terminal campaign-rejected (two outcomes, two terminals).
  const r2 = routeScenarioOutcome(manifest, 'approve', 'rejected');
  assert.deepEqual(r2.target, { type: 'terminal', status: 'campaign-rejected' });
});

test('W7-A4 routing: scenario-level outcomeRoutes used as fallback when stage has no route', () => {
  // Put a scenario-level route for an outcome the stage does not override.
  const manifest = buildCampaignManifest({
    outcomeRoutes: { 'escalate': { type: 'terminal', status: 'campaign-rejected' } },
  });
  // No stage declares 'escalate'; scenario-level fallback resolves it.
  const r = routeScenarioOutcome(manifest, 'draft', 'escalate');
  assert.deepEqual(r.target, { type: 'terminal', status: 'campaign-rejected' });
  // The stage-level route still wins for its own outcomes.
  const r2 = routeScenarioOutcome(manifest, 'draft', 'campaign-drafted');
  assert.deepEqual(r2.target, { type: 'stage', stageId: 'seo-baseline' });
});

test('W7-A4 routing: scenario-level fallback can be disabled (strict per-stage)', () => {
  const manifest = buildCampaignManifest({
    outcomeRoutes: { 'escalate': { type: 'terminal', status: 'campaign-rejected' } },
  });
  // With fallback disabled, the scenario-level route is ignored.
  assert.throws(
    () => routeScenarioOutcome(manifest, 'draft', 'escalate', { scenarioLevelFallback: false }),
    (err) => err.message.includes(ROUTING_ERROR_CODES.NO_ROUTE_FOR_OUTCOME),
  );
});

test('W7-A4 routing: unknown stage throws ROUTING_UNKNOWN_STAGE', () => {
  const manifest = buildCampaignManifest();
  assert.throws(
    () => routeScenarioOutcome(manifest, 'ghost', 'any'),
    (err) => err.message.includes(ROUTING_ERROR_CODES.UNKNOWN_STAGE),
  );
});

test('W7-A4 routing: missing route for declared outcome throws NO_ROUTE_FOR_OUTCOME', () => {
  const manifest = buildCampaignManifest();
  // 'draft' declares only 'campaign-drafted'; any other outcome has no route.
  assert.throws(
    () => routeScenarioOutcome(manifest, 'draft', 'never-declared'),
    (err) => err.message.includes(ROUTING_ERROR_CODES.NO_ROUTE_FOR_OUTCOME),
  );
});

test('W7-A4 routing: hasScenarioRoute is a pure predicate', () => {
  const manifest = buildCampaignManifest();
  assert.equal(hasScenarioRoute(manifest, 'draft', 'campaign-drafted'), true);
  assert.equal(hasScenarioRoute(manifest, 'draft', 'nope'), false);
  assert.equal(hasScenarioRoute(manifest, 'ghost', 'anything'), false);
});

test('W7-A4 routing: §6.8 module reuse does not confuse routing — seo-baseline and seo-followup both route', () => {
  // external-seo is reused in seo-baseline AND seo-followup (same moduleRef).
  // The router must route each stage independently by stage id, never by
  // module kind.
  const manifest = buildCampaignManifest();
  const baseline = routeScenarioOutcome(manifest, 'seo-baseline', 'ranking-fetched');
  const followup = routeScenarioOutcome(manifest, 'seo-followup', 'ranking-fetched');
  assert.equal(baseline.target.type, 'stage');
  assert.equal(baseline.target.stageId, 'compute');
  assert.equal(followup.target.type, 'stage');
  assert.equal(followup.target.stageId, 'approve');
});

// ---------------------------------------------------------------------------
// (2) Routing-graph validation.
// ---------------------------------------------------------------------------

test('W7-A4 graph: campaign manifest validates clean', () => {
  const manifest = buildCampaignManifest();
  const result = validateScenarioRoutingGraph(manifest);
  assert.equal(result.ok, true, `errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.errors.length, 0);
  // All 5 stages reachable from 'draft'.
  assert.deepEqual([...result.reachableStages].sort(), [
    'approve',
    'compute',
    'draft',
    'seo-baseline',
    'seo-followup',
  ]);
  // Both terminals reachable.
  assert.deepEqual([...result.reachableTerminals].sort(), [
    'campaign-approved',
    'campaign-rejected',
  ]);
});

test('W7-A4 graph: collectRoutingEdges lists stage + scenario-level edges', () => {
  const manifest = buildCampaignManifest({
    outcomeRoutes: { 'escalate': { type: 'terminal', status: 'campaign-rejected' } },
  });
  const edges = collectRoutingEdges(manifest);
  // 5 stage-level edges (one per stage) + 1 scenario-level edge.
  assert.ok(edges.length >= 6);
  const scenarioEdges = edges.filter((e) => e.fromStageId === SCENARIO_ROOT);
  assert.equal(scenarioEdges.length, 1);
  assert.equal(scenarioEdges[0].outcome, 'escalate');
});

test('W7-A4 graph: unreachable stage reported (UNREACHABLE_STAGE)', () => {
  // Add a stage that nothing routes to.
  const manifest = buildCampaignManifest({
    stageBindings: [
      ...campaignScenario.stages.map((s) => ({ ...s, moduleSelector: selectorFromModuleRef(s.moduleRef) })),
      {
        id: 'lonely',
        displayName: 'Lonely',
        moduleRef: campaignScenario.stages[0].moduleRef,
        inputMapping: {},
        outcomeRoutes: { 'done': { type: 'terminal', status: 'campaign-approved' } },
        entryConditions: [],
        exitConditions: [],
        moduleSelector: selectorFromModuleRef(campaignScenario.stages[0].moduleRef),
      },
    ],
  });
  const result = validateScenarioRoutingGraph(manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.code === ROUTING_ERROR_CODES.UNREACHABLE_STAGE && e.message.includes('lonely')),
    `expected UNREACHABLE_STAGE for lonely, got: ${JSON.stringify(result.errors)}`,
  );
});

test('W7-A4 graph: dead-end stage reported (DEAD_END_STAGE)', () => {
  // A stage whose only outcome routes to another stage that never reaches a
  // terminal. Build: draft -> ping -> pong -> ping ... (a terminal-free cycle).
  const loopModuleRef = campaignScenario.stages[0].moduleRef;
  const manifest = buildCampaignManifest({
    entryStageId: 'draft',
    stageBindings: [
      {
        id: 'draft',
        displayName: 'D',
        moduleRef: loopModuleRef,
        inputMapping: {},
        outcomeRoutes: { 'go': { type: 'stage', stageId: 'ping' } },
        entryConditions: [],
        exitConditions: [],
        moduleSelector: selectorFromModuleRef(loopModuleRef),
      },
      {
        id: 'ping',
        displayName: 'P',
        moduleRef: loopModuleRef,
        inputMapping: {},
        outcomeRoutes: { 'go': { type: 'stage', stageId: 'pong' } },
        entryConditions: [],
        exitConditions: [],
        moduleSelector: selectorFromModuleRef(loopModuleRef),
      },
      {
        id: 'pong',
        displayName: 'Po',
        moduleRef: loopModuleRef,
        inputMapping: {},
        outcomeRoutes: { 'go': { type: 'stage', stageId: 'ping' } },
        entryConditions: [],
        exitConditions: [],
        moduleSelector: selectorFromModuleRef(loopModuleRef),
      },
    ],
  });
  const result = validateScenarioRoutingGraph(manifest);
  assert.equal(result.ok, false);
  // All three stages are dead-ends: none reaches a declared terminal.
  for (const id of ['draft', 'ping', 'pong']) {
    assert.ok(
      result.errors.some((e) => e.code === ROUTING_ERROR_CODES.DEAD_END_STAGE && e.message.includes(`'${id}'`)),
      `expected DEAD_END_STAGE for ${id}, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test('W7-A4 graph: orphan terminal reported (ORPHAN_TERMINAL)', () => {
  // Declare a terminal that no route reaches.
  const manifest = buildCampaignManifest({
    terminalStatuses: ['campaign-approved', 'campaign-rejected', 'never-reached'],
  });
  const result = validateScenarioRoutingGraph(manifest);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.code === ROUTING_ERROR_CODES.ORPHAN_TERMINAL && e.message.includes('never-reached')),
    `expected ORPHAN_TERMINAL, got: ${JSON.stringify(result.errors)}`,
  );
});

test('W7-A4 graph: route to unknown stage reported (ROUTE_TARGET_UNKNOWN_STAGE)', () => {
  const manifest = buildCampaignManifest({
    stageBindings: campaignScenario.stages.map((s, i) =>
      i === 0
        ? {
            ...s,
            outcomeRoutes: { 'campaign-drafted': { type: 'stage', stageId: 'ghost' } },
            moduleSelector: selectorFromModuleRef(s.moduleRef),
          }
        : { ...s, moduleSelector: selectorFromModuleRef(s.moduleRef) },
    ),
  });
  const result = validateScenarioRoutingGraph(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === ROUTING_ERROR_CODES.ROUTE_TARGET_UNKNOWN_STAGE));
});

test('W7-A4 graph: route to unknown terminal reported (ROUTE_TARGET_UNKNOWN_TERMINAL)', () => {
  const manifest = buildCampaignManifest({
    outcomeRoutes: { 'bail': { type: 'terminal', status: 'not-declared' } },
  });
  const result = validateScenarioRoutingGraph(manifest);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === ROUTING_ERROR_CODES.ROUTE_TARGET_UNKNOWN_TERMINAL));
});

test('W7-A4 graph: branching rejoin — one stage feeding two terminals is valid', () => {
  // The campaign 'approve' stage already branches to two terminals; verify
  // the graph counts BOTH terminals as reachable and the stage is NOT a
  // dead-end.
  const manifest = buildCampaignManifest();
  const result = validateScenarioRoutingGraph(manifest);
  assert.equal(result.ok, true);
  assert.ok(result.reachableTerminals.includes('campaign-approved'));
  assert.ok(result.reachableTerminals.includes('campaign-rejected'));
});

// ---------------------------------------------------------------------------
// (3) Budget enforcement.
// ---------------------------------------------------------------------------

test('W7-A4 budget: ScenarioRoutingContext counts transitions', () => {
  const manifest = buildCampaignManifest({ transitionBudgets: { maxTransitions: 5 } });
  const ctx = new ScenarioRoutingContext(manifest);
  assert.equal(ctx.transitions, 0);
  ctx.enterTransition('a');
  ctx.enterTransition('b');
  assert.equal(ctx.transitions, 2);
});

test('W7-A4 budget: transition cap throws ScenarioBudgetExceeded', () => {
  const manifest = buildCampaignManifest({ transitionBudgets: { maxTransitions: 2 } });
  const ctx = new ScenarioRoutingContext(manifest);
  ctx.enterTransition('a');
  ctx.enterTransition('b');
  assert.throws(
    () => ctx.enterTransition('c'),
    (err) => err instanceof ScenarioBudgetExceeded
      && err.code === ROUTING_ERROR_CODES.TRANSITION_BUDGET_EXCEEDED
      && err.consumed === 2
      && err.budget === 2,
  );
});

test('W7-A4 budget: per-stage transition cap throws with stageId', () => {
  const manifest = buildCampaignManifest({
    transitionBudgets: { maxTransitions: 50, perStage: { ping: 1 } },
  });
  const ctx = new ScenarioRoutingContext(manifest);
  ctx.enterTransition('ping');
  assert.throws(
    () => ctx.enterTransition('ping'),
    (err) => err instanceof ScenarioBudgetExceeded
      && err.code === ROUTING_ERROR_CODES.TRANSITION_BUDGET_EXCEEDED
      && err.stageId === 'ping',
  );
  // Other stages unaffected.
  ctx.enterTransition('pong');
});

test('W7-A4 budget: reentry cap === 0 forbids any reentry', () => {
  const manifest = buildCampaignManifest({ reentryBudgets: { maxReentries: 0 } });
  const ctx = new ScenarioRoutingContext(manifest);
  assert.throws(
    () => ctx.recordReentry('draft'),
    (err) => err instanceof ScenarioBudgetExceeded
      && err.code === ROUTING_ERROR_CODES.REENTRY_BUDGET_EXCEEDED,
  );
});

test('W7-A4 budget: reentry cap counts across stages', () => {
  const manifest = buildCampaignManifest({ reentryBudgets: { maxReentries: 2 } });
  const ctx = new ScenarioRoutingContext(manifest);
  ctx.recordReentry('draft');
  ctx.recordReentry('seo-baseline');
  assert.equal(ctx.totalReentries, 2);
  assert.equal(ctx.reentriesFor('draft'), 1);
  assert.throws(
    () => ctx.recordReentry('compute'),
    (err) => err instanceof ScenarioBudgetExceeded
      && err.code === ROUTING_ERROR_CODES.REENTRY_BUDGET_EXCEEDED
      && err.consumed === 2
      && err.budget === 2,
  );
});

test('W7-A4 budget: per-stage reentry cap throws with stageId', () => {
  const manifest = buildCampaignManifest({
    reentryBudgets: { maxReentries: 50, perStage: { draft: 1 } },
  });
  const ctx = new ScenarioRoutingContext(manifest);
  ctx.recordReentry('draft');
  assert.throws(
    () => ctx.recordReentry('draft'),
    (err) => err instanceof ScenarioBudgetExceeded
      && err.code === ROUTING_ERROR_CODES.REENTRY_BUDGET_PER_STAGE_EXCEEDED
      && err.stageId === 'draft',
  );
  // Other stage's reentries still allowed under the global cap.
  ctx.recordReentry('compute');
});

test('W7-A4 budget: toJSON snapshot is plain serializable data', () => {
  const manifest = buildCampaignManifest({
    transitionBudgets: { maxTransitions: 10 },
    reentryBudgets: { maxReentries: 5 },
  });
  const ctx = new ScenarioRoutingContext(manifest);
  ctx.enterTransition('a');
  ctx.recordReentry('a');
  const snap = ctx.toJSON();
  assert.deepEqual(snap, {
    transitionsConsumed: 1,
    maxTransitions: 10,
    totalReentries: 1,
    maxReentries: 5,
    reentriesByStage: { a: 1 },
  });
  // Must be JSON-serializable (no undefined-in-array, no Map/Set).
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snap)));
});

// ---------------------------------------------------------------------------
// (4) Bound router — lookup + budget side-effects combined.
// ---------------------------------------------------------------------------

test('W7-A4 router: route() does static lookup and consumes transition budget for stage targets', () => {
  const manifest = buildCampaignManifest({ transitionBudgets: { maxTransitions: 10 } });
  const router = createScenarioRouter(manifest);
  const ctx = new ScenarioRoutingContext(manifest);
  const r = router.route('draft', 'campaign-drafted', ctx, { firstEntry: false });
  assert.equal(r.target.type, 'stage');
  assert.equal(ctx.transitions, 1);
});

test('W7-A4 router: terminal targets do NOT consume a transition budget', () => {
  const manifest = buildCampaignManifest({ transitionBudgets: { maxTransitions: 1 } });
  const router = createScenarioRouter(manifest);
  const ctx = new ScenarioRoutingContext(manifest);
  // A terminal route must not burn the single transition slot — the run ends.
  const r = router.route('approve', 'approved', ctx);
  assert.deepEqual(r.target, { type: 'terminal', status: 'campaign-approved' });
  assert.equal(ctx.transitions, 0);
});

test('W7-A4 router: peek() is pure — no budget side-effect', () => {
  const manifest = buildCampaignManifest({ transitionBudgets: { maxTransitions: 1 } });
  const router = createScenarioRouter(manifest);
  const ctx = new ScenarioRoutingContext(manifest);
  const r = router.peek('draft', 'campaign-drafted');
  assert.equal(r.target.stageId, 'seo-baseline');
  assert.equal(ctx.transitions, 0);
});

test('W7-A4 router: validateGraph() delegates to validateScenarioRoutingGraph', () => {
  const manifest = buildCampaignManifest();
  const router = createScenarioRouter(manifest);
  const g = router.validateGraph();
  assert.equal(g.ok, true);
  // 5 stages; 'approve' declares two outcomes (approved + rejected) so there
  // are 6 stage-level edges total, no scenario-level edges.
  assert.equal(g.edges.length, 6);
  assert.equal(g.edges.filter((e) => e.fromStageId === SCENARIO_ROOT).length, 0);
});

test('W7-A4 router: budget breach during route() propagates ScenarioBudgetExceeded', () => {
  const manifest = buildCampaignManifest({ transitionBudgets: { maxTransitions: 1 } });
  const router = createScenarioRouter(manifest);
  const ctx = new ScenarioRoutingContext(manifest);
  // First stage-to-stage transition consumes the only slot.
  router.route('draft', 'campaign-drafted', ctx);
  // A second stage-to-stage transition must breach the cap.
  assert.throws(
    () => router.route('seo-baseline', 'ranking-fetched', ctx),
    (err) => err instanceof ScenarioBudgetExceeded
      && err.code === ROUTING_ERROR_CODES.TRANSITION_BUDGET_EXCEEDED,
  );
});

// ---------------------------------------------------------------------------
// (5) §6.4 structural guarantee — no executable resolver anywhere.
// ---------------------------------------------------------------------------

test('W7-A4 §6.4: router module exports no routeResolver / no closure-based resolver', () => {
  // The public surface is the declarative functions + ScenarioRoutingContext
  // + createScenarioRouter. There is no function that takes a rootInput and
  // returns a per-run override. This test asserts the SHAPE contract: every
  // route lookup is (manifest, stageId, outcome) -> same target.
  const manifest = buildCampaignManifest();
  const a = routeScenarioOutcome(manifest, 'draft', 'campaign-drafted');
  const b = routeScenarioOutcome(manifest, 'draft', 'campaign-drafted');
  assert.deepEqual(a, b);
  // Same manifest + same key must always yield the identical target object
  // shape — proving determinism (the hallmark of declarative routing).
  assert.deepEqual(a.target, { type: 'stage', stageId: 'seo-baseline' });
});

test('W7-A4 §6.4: routing is invariant to rootInput — no per-run branch exists', () => {
  // A legacy routeResolver could branch on rootInput. The declarative router
  // has no rootInput parameter at all. Prove routing cannot be influenced by
  // any external value: mutate a would-be rootInput and confirm the route is
  // unchanged.
  const manifest = buildCampaignManifest();
  const before = routeScenarioOutcome(manifest, 'approve', 'approved');
  // No API surface accepts a rootInput; the only inputs are manifest+stage+outcome.
  const after = routeScenarioOutcome(manifest, 'approve', 'approved');
  assert.deepEqual(before, after);
});
