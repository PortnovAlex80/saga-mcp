import assert from 'node:assert/strict';
import test from 'node:test';

const { validateProcessModuleDefinition } = await import(
  '../../dist/process-modules/application/validate-process-module.js'
);
const { createBuiltInProcessModuleRegistry } = await import(
  '../../dist/process-modules/modules/catalog.js'
);
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { formalizationProcessModule } = await import(
  '../../dist/process-modules/modules/formalization/formalization-process-module.js'
);
const { developmentProcessModule } = await import(
  '../../dist/process-modules/modules/development/development-process-module.js'
);
const { deliveryProcessModule } = await import(
  '../../dist/process-modules/modules/delivery/delivery-process-module.js'
);

for (const module of [
  discoveryProcessModule,
  formalizationProcessModule,
  developmentProcessModule,
  deliveryProcessModule,
]) {
  test(`${module.identity.name}: definition is structurally valid`, () => {
    const validation = validateProcessModuleDefinition(module);
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.deepEqual(validation.errors, []);
  });

  test(`${module.identity.name}: every LM node has a bound execution profile and recovery`, () => {
    const profiles = new Map(module.executionProfiles.map(profile => [profile.id, profile]));
    for (const node of module.flow.nodes.filter(candidate => candidate.kind === 'lm')) {
      const profile = profiles.get(node.executionProfile);
      assert.ok(profile, `missing profile ${node.executionProfile}`);
      assert.ok(profile.outputSchema.id, `${profile.id} must declare its typed output`);
      assert.equal(profile.recoveryPolicy.resumeFromCheckpoint, true);
      assert.equal(profile.recoveryPolicy.reuseWorkIntent, true);
    }
  });

  test(`${module.identity.name}: every terminal process outcome is emitted`, () => {
    const terminalIds = new Set(module.flow.terminalNodeIds);
    const emitted = new Set(
      module.flow.nodes
        .filter(node => terminalIds.has(node.id))
        .map(node => node.emitsOutcome),
    );
    for (const outcome of module.outcomes.filter(candidate => candidate.terminal)) {
      assert.ok(emitted.has(outcome.code), `terminal outcome ${outcome.code} is not emitted`);
    }
  });
}

for (const module of [discoveryProcessModule, formalizationProcessModule]) {
  test(`${module.identity.name}: authoring LM profiles include operational templates`, () => {
    const profiles = new Map(module.executionProfiles.map(profile => [profile.id, profile]));
    for (const node of module.flow.nodes.filter(candidate => candidate.kind === 'lm')) {
      const profile = profiles.get(node.executionProfile);
      assert.equal(typeof profile.trackerTemplate, 'string');
      assert.ok(profile.callTemplates.length > 0, `${profile.id} must materialize tool calls`);
      assert.ok(profile.checklists.length > 0, `${profile.id} must have a checklist`);
    }
  });
}

test('built-in registry registers all lifecycle modules by versioned identity', () => {
  const registry = createBuiltInProcessModuleRegistry();
  const refs = registry.list().map(module => `${module.identity.name}@${module.identity.version}`);
  assert.deepEqual(refs.sort(), [
    'delivery-release@1.0.0',
    'product-discovery@3.0.0',
    'solution-development@1.0.0',
    'solution-formalization@1.0.0',
  ]);
});

test('validator rejects an LM node without an execution profile', () => {
  const broken = structuredClone(discoveryProcessModule);
  const node = broken.flow.nodes.find(candidate => candidate.kind === 'lm');
  assert.ok(node);
  node.executionProfile = 'missing-profile';
  const validation = validateProcessModuleDefinition(broken);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join('\n'), /missing execution profile/);
});
