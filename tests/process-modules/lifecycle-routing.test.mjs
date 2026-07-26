import assert from 'node:assert/strict';
import test from 'node:test';

const { createBuiltInProcessModuleRegistry } = await import(
  '../../dist/process-modules/modules/catalog.js'
);
const { discoveryToFormalizationLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const { routeProcessOutcome, validateLifecycleDefinition } = await import(
  '../../dist/process-modules/application/lifecycle-router.js'
);

const registry = createBuiltInProcessModuleRegistry();

test('Discovery -> Formalization lifecycle is valid', () => {
  const validation = validateLifecycleDefinition(discoveryToFormalizationLifecycle, registry);
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  assert.deepEqual(validation.errors, []);
});

test('Discovery go routes to Formalization through Stage Binding', () => {
  const discovery = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'initial-discovery',
  );
  assert.ok(discovery);
  assert.deepEqual(routeProcessOutcome(discovery, 'go'), {
    stageId: 'initial-discovery',
    outcome: 'go',
    target: { type: 'stage', stageId: 'solution-formalization' },
  });
});

test('Formalization formalized stops at ready-for-development until Development is modularized', () => {
  const formalization = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'solution-formalization',
  );
  assert.ok(formalization);
  assert.deepEqual(routeProcessOutcome(formalization, 'formalized').target, {
    type: 'terminal',
    status: 'ready-for-development',
  });
});

test('a Process Module does not silently choose a route for an unknown outcome', () => {
  const discovery = discoveryToFormalizationLifecycle.stages[0];
  assert.throws(
    () => routeProcessOutcome(discovery, 'invented-outcome'),
    /has no route/,
  );
});
