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
const { mapLifecycleValues } = await import(
  '../../dist/process-modules/application/lifecycle-mapper.js'
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

test('Formalization formalized routes to Development', () => {
  const formalization = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'solution-formalization',
  );
  assert.ok(formalization);
  assert.deepEqual(routeProcessOutcome(formalization, 'formalized').target, {
    type: 'stage',
    stageId: 'solution-development',
  });
});

test('verified Development routes to Delivery and released Delivery terminates', () => {
  const development = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'solution-development',
  );
  const delivery = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'delivery-release',
  );
  assert.ok(development);
  assert.ok(delivery);
  assert.deepEqual(routeProcessOutcome(development, 'verified').target, {
    type: 'stage',
    stageId: 'delivery-release',
  });
  assert.deepEqual(routeProcessOutcome(delivery, 'released').target, {
    type: 'terminal',
    status: 'released',
  });
});

test('a Process Module does not silently choose a route for an unknown outcome', () => {
  const discovery = discoveryToFormalizationLifecycle.stages[0];
  assert.throws(
    () => routeProcessOutcome(discovery, 'invented-outcome'),
    /has no route/,
  );
});

const mappingRuntime = {
  projectId: 1,
  epicId: 2,
  lifecycleRunId: 3,
  stageId: 'stage',
  initiatedBy: 'test',
};

test('lifecycle mapping reads own JSON properties only', () => {
  const inherited = Object.create({ secret: 'must-not-leak' });
  const source = { payload: inherited };
  assert.throws(
    () => mapLifecycleValues({ value: '$.payload.secret' }, source, mappingRuntime),
    /LIFECYCLE_MAPPING_SOURCE_MISSING/,
  );
});

test('lifecycle mapping rejects prototype-mutating target paths', () => {
  assert.throws(
    () => mapLifecycleValues(
      { '__proto__.polluted': { literal: true } },
      {},
      mappingRuntime,
    ),
    /LIFECYCLE_MAPPING_INVALID_TARGET/,
  );
  assert.throws(
    () => mapLifecycleValues(
      { 'constructor.prototype.polluted': { literal: true } },
      {},
      mappingRuntime,
    ),
    /LIFECYCLE_MAPPING_INVALID_TARGET/,
  );
  assert.equal({}.polluted, undefined);
});
