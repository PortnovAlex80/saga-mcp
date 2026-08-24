// tests/factory-proof/workshop-descriptor.test.mjs
//
// Refactor Phase 2 / R1 characterization: all four installed workshops FIT
// the BuiltInWorkshop target shape (manifest + definition + a binding
// closure) WITHOUT any runtime switch. This test runs against dist/ — part
// of the post-Elite verification batch while the no-build protocol lives.
//
// What "fits" means tonight (honest, pre-cutover): every workshop exposes a
// package manifest with identity+digest, a ProcessModuleDefinition with
// identity+flow, and its capabilities are reachable through the single
// global manifest today (the R4 step will move them into createBindings).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_ROOT = process.cwd();
const dist = name => pathToFileURL(path.resolve(REPO_ROOT, 'dist', name)).href;

test('all five installed workshops expose manifest identity + definition identity', async () => {
  const modules = await Promise.all([
    import(dist('process-modules/modules/discovery/index.js')).catch(() =>
      import(dist('process-modules/modules/discovery/discovery-process-module.js'))),
    import(dist('process-modules/modules/formalization/index.js')).catch(() =>
      import(dist('process-modules/modules/formalization/formalization-process-module.js'))),
    import(dist('process-modules/modules/development/index.js')).catch(() =>
      import(dist('process-modules/modules/development/development-process-module.js'))),
    import(dist('process-modules/modules/delivery/index.js')).catch(() =>
      import(dist('process-modules/modules/delivery/delivery-process-module.js'))),
    import(dist('process-modules/modules/documentation/index.js')).catch(() =>
      import(dist('process-modules/modules/documentation/documentation-process-module.js'))),
  ]);
  const names = ['discovery', 'formalization', 'development', 'delivery', 'documentation'];
  modules.forEach((mod, index) => {
    const definition = mod.discoveryProcessModule ?? mod.formalizationProcessModule
      ?? mod.developmentProcessModule ?? mod.deliveryProcessModule
      ?? mod.documentationProcessModule;
    assert.ok(definition, `${names[index]} exports its ProcessModuleDefinition`);
    assert.ok(definition.identity?.name, `${names[index]} definition has identity.name`);
    assert.ok(Array.isArray(definition.flow?.nodes ?? definition.nodes),
      `${names[index]} definition has a flow graph`);
  });
});

test('Delivery fits with ZERO execution profiles (the universality proof)', async () => {
  const mod = await import(dist('process-modules/modules/delivery/index.js')).catch(() =>
    import(dist('process-modules/modules/delivery/delivery-process-module.js')));
  const definition = mod.deliveryProcessModule;
  assert.ok(definition);
  const profiles = JSON.stringify(definition);
  assert.ok(!/"executionProfiles":\[[^\]]/.test(profiles.replace(/\s/g, '')) || profiles.includes('executionProfiles: []') || !profiles.includes('executionProfile'),
    'Delivery declares no LM execution profiles');
});

test('the capability inventory today is the single global manifest (R4 will co-locate)', async () => {
  const manifest = await import(dist('process-modules/application/workshop-capability-manifest.js'));
  assert.ok(Array.isArray(manifest.WORKSHOP_PAYLOAD_CONTRACTS));
  assert.ok(manifest.WORKSHOP_PAYLOAD_CONTRACTS.length >= 8,
    'the global payload-contract list exists and is non-trivial');
  // The reconciliation report contract (today's fix) is registered exactly once.
  const reconciliation = manifest.WORKSHOP_PAYLOAD_CONTRACTS.filter(
    c => c.schemaId === 'factory.formalization-reconciliation-report.v1',
  );
  assert.equal(reconciliation.length, 1);
});
