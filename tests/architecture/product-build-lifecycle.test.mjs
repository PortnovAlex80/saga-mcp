import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    type: 'terminal', status: 'runnable-local',
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

test('generic Factory Start does not silently force static/no-dependency product architecture', () => {
  const gateway = readFileSync(new URL('../../scripts/factory.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(gateway, /staticFilesOnly\s*:\s*true/);
  assert.doesNotMatch(gateway, /noDependencies\s*:\s*true/);
  assert.match(gateway, /localRunRequired\s*:\s*true/);
  assert.match(gateway, /deploymentExcluded\s*:\s*true/);
  assert.match(gateway, /humanAcceptanceAfterLocalStart\s*:\s*true/);
  assert.match(gateway, /buildReferenceDevelopmentPolicy\(\)/);
  assert.doesNotMatch(gateway, /reference-development-policy['"],\s*version/);
});

test('Factory Start keeps the immutable package store beside the durable DB by default', () => {
  // The engine-child env (package store default included) moved to the
  // extracted detached-spawn module (E-P1); the gateway delegates to it.
  const gateway = readFileSync(new URL('../../scripts/factory.mjs', import.meta.url), 'utf8');
  const spawnModule = readFileSync(
    new URL('../../scripts/factory-engine-spawn.mjs', import.meta.url), 'utf8',
  );
  assert.match(gateway, /spawnOrchestrateCliEngine/);
  assert.match(spawnModule, /SAGA_PACKAGE_STORE_DIR:\s*baseEnv\.SAGA_PACKAGE_STORE_DIR/);
  assert.match(spawnModule, /join\(dirname\(resolve\(dbPath\)\),\s*'package-store'\)/);
  assert.doesNotMatch(spawnModule, /SAGA_PACKAGE_STORE_DIR:\s*join\(repoRoot/);
});
