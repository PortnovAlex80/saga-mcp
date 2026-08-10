import test from 'node:test';
import assert from 'node:assert/strict';
import { productBuildLifecycle } from '../../dist/process-modules/lifecycles/product-build-lifecycle.js';
import { productDeliveryLifecycle } from '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js';

test('default product build terminates after verified Development without Delivery', () => {
  assert.equal(productBuildLifecycle.identity.name, 'product-build');
  assert.deepEqual(
    productBuildLifecycle.stages.map(stage => stage.id),
    ['initial-discovery', 'solution-formalization', 'solution-development'],
  );
  const development = productBuildLifecycle.stages.at(-1);
  assert.deepEqual(development.outcomeRoutes.verified, {
    type: 'terminal', status: 'verified-local',
  });
  assert.equal(
    productBuildLifecycle.stages.some(stage => stage.id === 'delivery-release'),
    false,
  );
});

test('legacy product-delivery definition remains unchanged for pinned runs', () => {
  assert.equal(productDeliveryLifecycle.identity.name, 'product-delivery');
  assert.equal(
    productDeliveryLifecycle.stages.some(stage => stage.id === 'delivery-release'),
    true,
  );
});
