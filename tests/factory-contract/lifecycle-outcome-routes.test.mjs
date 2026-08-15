// tests/factory-contract/lifecycle-outcome-routes.test.mjs
//
// Workstream 8: Lifecycle outcome routing coverage.
//
// Verifies that the lifecycle definition declares the correct outcome routes
// for each module stage, matching the module's declared outcome codes.
//
// AC-31: lifecycle outcome routes are deterministically tested through the
// real lifecycle definition.

import { test } from 'node:test';
import assert from 'node:assert';
import { productDeliveryLifecycle } from '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js';
import { discoveryProcessModule } from '../../dist/process-modules/modules/discovery/discovery-process-module.js';
import { formalizationProcessModule } from '../../dist/process-modules/modules/formalization/formalization-process-module.js';
import { developmentProcessModule } from '../../dist/process-modules/modules/development/development-process-module.js';
import { deliveryProcessModule } from '../../dist/process-modules/modules/delivery/delivery-process-module.js';

const lifecycle = productDeliveryLifecycle;
const stages = new Map(lifecycle.stages.map(s => [s.id, s]));

test('Lifecycle has 4 stages: discovery, formalization, development, delivery', () => {
  assert.equal(lifecycle.stages.length, 4);
  assert.equal(stages.get('initial-discovery')?.moduleRef?.name, 'product-discovery');
  assert.equal(stages.get('solution-formalization')?.moduleRef?.name, 'solution-formalization');
  assert.equal(stages.get('solution-development')?.moduleRef?.name, 'solution-development');
  assert.equal(stages.get('delivery-release')?.moduleRef?.name, 'delivery-release');
});

// Discovery outcome routes — permissive by design
test('Discovery outcome routes: ALL outcomes forward to formalization (permissive gate)', () => {
  const disc = stages.get('initial-discovery');
  assert.ok(disc.outcomeRoutes);
  // Discovery is an idea-STRENGTH gate, not a build gate. Every outcome
  // forwards to Formalization, which is the real go/no-go gate.
  for (const code of ['go', 'clarify', 'reject', 'defer', 'inconclusive', 'failed']) {
    assert.ok(disc.outcomeRoutes[code], `Discovery route for '${code}' exists`);
    assert.equal(disc.outcomeRoutes[code].type, 'stage', `${code} forwards to formalization`);
    assert.equal(disc.outcomeRoutes[code].stageId, 'solution-formalization');
  }
});

// Discovery module declares matching outcomes
test('Discovery module declares all outcome codes the lifecycle routes', () => {
  const moduleOutcomes = new Set(discoveryProcessModule.outcomes.map(o => o.code));
  for (const code of ['go', 'clarify', 'reject', 'defer', 'inconclusive', 'failed']) {
    assert.ok(moduleOutcomes.has(code), `Discovery module declares outcome '${code}'`);
  }
});

// Formalization outcome routes
test('Formalization outcome routes: formalized → development, others terminal', () => {
  const frm = stages.get('solution-formalization');
  assert.equal(frm.outcomeRoutes.formalized?.type, 'stage');
  assert.equal(frm.outcomeRoutes.formalized?.stageId, 'solution-development');
  for (const code of ['clarification-required', 'inconsistent', 'infeasible', 'failed']) {
    assert.ok(frm.outcomeRoutes[code], `Formalization route for '${code}' exists`);
    assert.equal(frm.outcomeRoutes[code].type, 'terminal');
  }
});

test('Formalization module declares all outcome codes the lifecycle routes', () => {
  const moduleOutcomes = new Set(formalizationProcessModule.outcomes.map(o => o.code));
  for (const code of ['formalized', 'clarification-required', 'inconsistent', 'infeasible', 'failed']) {
    assert.ok(moduleOutcomes.has(code), `Formalization module declares outcome '${code}'`);
  }
});

// Development outcome routes
test('Development outcome routes: verified → delivery, others terminal', () => {
  const dev = stages.get('solution-development');
  assert.equal(dev.outcomeRoutes.verified?.type, 'stage');
  assert.equal(dev.outcomeRoutes.verified?.stageId, 'delivery-release');
  for (const code of ['rework-required', 'clarification-required', 'blocked', 'failed']) {
    assert.ok(dev.outcomeRoutes[code], `Development route for '${code}' exists`);
    assert.equal(dev.outcomeRoutes[code].type, 'terminal');
  }
});

test('Development module declares all outcome codes the lifecycle routes', () => {
  const moduleOutcomes = new Set(developmentProcessModule.outcomes.map(o => o.code));
  for (const code of ['verified', 'rework-required', 'clarification-required', 'blocked', 'failed']) {
    assert.ok(moduleOutcomes.has(code), `Development module declares outcome '${code}'`);
  }
});

// Delivery outcome routes (all terminal)
test('Delivery outcome routes: all terminal', () => {
  const del = stages.get('delivery-release');
  for (const code of ['released', 'approval-required', 'blocked', 'failed']) {
    assert.ok(del.outcomeRoutes[code], `Delivery route for '${code}' exists`);
    assert.equal(del.outcomeRoutes[code].type, 'terminal');
  }
});

test('Delivery module declares all outcome codes the lifecycle routes', () => {
  const moduleOutcomes = new Set(deliveryProcessModule.outcomes.map(o => o.code));
  for (const code of ['released', 'approval-required', 'blocked', 'failed']) {
    assert.ok(moduleOutcomes.has(code), `Delivery module declares outcome '${code}'`);
  }
});

// Verify no orphan routes (every lifecycle route code exists in module outcomes)
test('No orphan routes: every lifecycle route code exists in module outcomes', () => {
  const moduleByStage = {
    'initial-discovery': discoveryProcessModule,
    'solution-formalization': formalizationProcessModule,
    'solution-development': developmentProcessModule,
    'delivery-release': deliveryProcessModule,
  };
  for (const [stageId, module] of Object.entries(moduleByStage)) {
    const stage = stages.get(stageId);
    const moduleOutcomes = new Set(module.outcomes.map(o => o.code));
    for (const routeCode of Object.keys(stage.outcomeRoutes)) {
      assert.ok(
        moduleOutcomes.has(routeCode),
        `Stage '${stageId}' routes '${routeCode}' but module '${module.identity.name}' does not declare it`,
      );
    }
  }
});

// Verify every module terminal outcome has a lifecycle route
test('No missing routes: every module terminal outcome has a lifecycle route', () => {
  const moduleByStage = {
    'initial-discovery': discoveryProcessModule,
    'solution-formalization': formalizationProcessModule,
    'solution-development': developmentProcessModule,
    'delivery-release': deliveryProcessModule,
  };
  for (const [stageId, module] of Object.entries(moduleByStage)) {
    const stage = stages.get(stageId);
    const routeCodes = new Set(Object.keys(stage.outcomeRoutes));
    for (const outcome of module.outcomes) {
      assert.ok(
        routeCodes.has(outcome.code),
        `Module '${module.identity.name}' declares outcome '${outcome.code}' but stage '${stageId}' has no route for it`,
      );
    }
  }
});
