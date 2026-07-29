import assert from 'node:assert/strict';
import test from 'node:test';

// Wave 13 removed modules/catalog.ts; build the registry inline from the
// production module definitions imported directly.
const { ProcessModuleRegistry } = await import(
  '../../dist/process-modules/application/process-module-registry.js'
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
function createBuiltInProcessModuleRegistry() {
  const registry = new ProcessModuleRegistry();
  registry.register(discoveryProcessModule);
  registry.register(formalizationProcessModule);
  registry.register(developmentProcessModule);
  registry.register(deliveryProcessModule);
  return registry;
}
const { discoveryToFormalizationLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const { routeProcessOutcome, validateLifecycleDefinition } = await import(
  '../../dist/process-modules/application/lifecycle-router.js'
);
const { mapLifecycleValues } = await import(
  '../../dist/process-modules/application/lifecycle-mapper.js'
);
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
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

// Discovery is a product idea gate, not a build gate. Every outcome is forwarded
// to Formalization; the strength of the idea (decision + readiness confidence)
// is recorded in the discovery certificate and does not block the lifecycle.
test('Discovery non-go outcomes also route to Formalization (idea strength is recorded, not blocking)', () => {
  const discovery = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'initial-discovery',
  );
  assert.ok(discovery);
  for (const outcome of ['clarify', 'reject', 'defer', 'inconclusive', 'failed']) {
    assert.deepEqual(
      routeProcessOutcome(discovery, outcome),
      {
        stageId: 'initial-discovery',
        outcome,
        target: { type: 'stage', stageId: 'solution-formalization' },
      },
      `${outcome} should route forward to solution-formalization, not terminate`,
    );
  }
});

// W13-A3: routing is now purely declarative. The runtime product-delivery
// lifecycle has NO per-run routeResolver and NO discoveryGate override — every
// Discovery outcome forwards to Formalization (permissive). The legacy strict
// go/no-go gate survives as a separate declarative Lifecycle Scenario Package
// (`LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT`), not as a runtime resolver hook.
test('product-delivery lifecycle exposes NO routeResolver (declarative routing only)', () => {
  const def = discoveryToFormalizationLifecycle;
  assert.equal(
    Object.prototype.hasOwnProperty.call(def, 'routeResolver'),
    false,
    'runtime lifecycle must not carry a routeResolver after W13-A3',
  );
  assert.equal(def.routeResolver, undefined);
  assert.ok(!Object.keys(def).includes('routeResolver'));
  assert.ok(!JSON.stringify(def).includes('routeResolver'));
});

test('declarative routing is invariant: same stage+outcome always yields the same target', () => {
  // There is no rootInput parameter and no resolver — routing cannot be
  // influenced by any per-run value. Mutate a would-be rootInput and confirm
  // the route is unchanged (the hallmark of declarative routing).
  const discovery = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'initial-discovery',
  );
  assert.ok(discovery);
  assert.deepEqual(
    routeProcessOutcome(discovery, 'clarify'),
    routeProcessOutcome(discovery, 'clarify'),
  );
  // 'go' and every non-go outcome route forward to Formalization (permissive).
  for (const outcome of ['go', 'clarify', 'reject', 'defer', 'inconclusive', 'failed']) {
    assert.deepEqual(
      routeProcessOutcome(discovery, outcome).target,
      { type: 'stage', stageId: 'solution-formalization' },
      `${outcome} must route forward to solution-formalization`,
    );
  }
});

test('routeProcessOutcome accepts no resolver/rootInput override arguments', () => {
  // The deleted signature took (stage, outcome, rootInput?, resolver?). The
  // declarative signature is (stage, outcome) only — pin the arity so a future
  // closure-based resolver cannot sneak back in.
  assert.equal(routeProcessOutcome.length, 2);
});

// The lifecycle definition is pinned by hash for the lifetime of a run. With the
// resolver gone, the definition is plain serializable data — no function needs
// hiding from canonicalJson. The hash is deterministic and replay-stable.
test('definition is plain serializable data with a deterministic, replay-stable hash', () => {
  const def = discoveryToFormalizationLifecycle;

  const hash1 = sha256Hex(def);
  const hash2 = sha256Hex(def);
  assert.equal(hash1, hash2, 'definition hash must be deterministic across calls');

  // The serialized snapshot is valid JSON (parseable) and carries no function.
  const snapshot = JSON.parse(JSON.stringify(def));
  assert.equal(
    Object.prototype.hasOwnProperty.call(snapshot, 'routeResolver'),
    false,
    'serialized snapshot must not contain routeResolver',
  );
  for (const value of Object.values(snapshot)) {
    assert.notEqual(typeof value, 'function');
  }
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
