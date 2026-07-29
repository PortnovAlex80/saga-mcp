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

// The permissive default above is overridable per run. An operator who starts
// the lifecycle with `discoveryGate: 'strict'` gets the legacy go/no-go gate:
// non-go Discovery outcomes terminate (regulated/contractual environments).
// `go` always forwards regardless of the flag.
test('Discovery strict gate: non-go outcomes terminate, go still forwards', () => {
  const discovery = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'initial-discovery',
  );
  assert.ok(discovery);
  const resolver = discoveryToFormalizationLifecycle.routeResolver;
  assert.ok(resolver, 'lifecycle must declare a routeResolver for the gate');
  const strictInput = { discoveryGate: 'strict' };

  // go always forwards to Formalization, even under strict.
  assert.deepEqual(
    routeProcessOutcome(discovery, 'go', strictInput, resolver),
    {
      stageId: 'initial-discovery',
      outcome: 'go',
      target: { type: 'stage', stageId: 'solution-formalization' },
    },
  );

  // Each non-go outcome terminates with its legacy status.
  const expectedTerminalStatus = {
    clarify: 'clarification-required',
    reject: 'rejected',
    defer: 'deferred',
    inconclusive: 'inconclusive',
    failed: 'failed',
  };
  for (const [outcome, status] of Object.entries(expectedTerminalStatus)) {
    assert.deepEqual(
      routeProcessOutcome(discovery, outcome, strictInput, resolver),
      {
        stageId: 'initial-discovery',
        outcome,
        target: { type: 'terminal', status },
      },
      `strict gate should terminate ${outcome} → ${status}`,
    );
  }
});

test('Discovery gate defaults to permissive when the flag is absent or unknown', () => {
  const discovery = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'initial-discovery',
  );
  assert.ok(discovery);
  const resolver = discoveryToFormalizationLifecycle.routeResolver;
  // No discoveryGate field → permissive → forward.
  assert.equal(
    routeProcessOutcome(discovery, 'clarify', {}, resolver).target.type,
    'stage',
  );
  // Unknown gate value → permissive (validator rejects it upstream, but the
  // resolver must fail safe to forward rather than terminate).
  assert.equal(
    routeProcessOutcome(discovery, 'reject', { discoveryGate: 'bogus' }, resolver).target.type,
    'stage',
  );
});

test('Discovery gate resolver only affects the Discovery stage, not Formalization/Development/Delivery', () => {
  const resolver = discoveryToFormalizationLifecycle.routeResolver;
  const strictInput = { discoveryGate: 'strict' };
  // Formalization, Development, Delivery routes must be unchanged by the flag.
  const formalization = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'solution-formalization',
  );
  assert.deepEqual(
    routeProcessOutcome(formalization, 'formalized', strictInput, resolver).target,
    { type: 'stage', stageId: 'solution-development' },
  );
  assert.deepEqual(
    routeProcessOutcome(formalization, 'inconsistent', strictInput, resolver).target,
    { type: 'terminal', status: 'formalization-inconsistent' },
  );
});

// The lifecycle definition is pinned by hash for the lifetime of a run, so the
// routeResolver (a function) must NOT appear in the serialized form. It is
// attached as a non-enumerable property, so canonicalJson (which iterates
// Object.keys) skips it entirely. Two consequences this test guards:
//   1. The definition snapshot stays valid JSON (no `undefined` values), so
//      JSON.parse on the persisted snapshot does not throw.
//   2. The definition hash is identical whether or not a resolver is attached,
//      so existing in-flight lifecycle runs can be replayed after this feature
//      ships without LIFECYCLE_DEFINITION_CHANGED_FOR_REPLAY.
test('routeResolver is non-enumerable and does not break definition-hash replay', () => {
  const def = discoveryToFormalizationLifecycle;

  // The resolver is reachable at runtime but invisible to serialization.
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(def, 'routeResolver'),
    false,
    'routeResolver must be non-enumerable so canonicalJson skips it',
  );
  assert.equal(typeof def.routeResolver, 'function', 'resolver must still be callable');

  // Same object hashed twice → identical hash (replay-stable).
  const hash1 = sha256Hex(def);
  const hash2 = sha256Hex(def);
  assert.equal(hash1, hash2, 'definition hash must be deterministic across calls');

  // A definition constructed without the resolver must hash the SAME as the
  // real definition — the resolver is not part of the serialized identity.
  const { identity, entryStageId, stages } = def;
  const withoutResolver = { identity, entryStageId, stages };
  assert.equal(
    sha256Hex(withoutResolver),
    hash1,
    'resolver presence must not change the definition hash (replay compatibility)',
  );

  // The serialized snapshot must be valid JSON (parseable), proving the
  // non-enumerable attachment removed the function from the persisted form.
  const snapshot = JSON.parse(JSON.stringify(def));
  assert.equal(
    Object.prototype.hasOwnProperty.call(snapshot, 'routeResolver'),
    false,
    'serialized snapshot must not contain routeResolver',
  );
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
