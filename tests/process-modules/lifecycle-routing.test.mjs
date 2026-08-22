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
const { DISCOVERY_PROCESS_MODULE_REF } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const DISCOVERY_MODULE_REF = DISCOVERY_PROCESS_MODULE_REF;
const { routeProcessOutcome, validateLifecycleDefinition } = await import(
  '../../dist/process-modules/application/lifecycle-router.js'
);
const { mapLifecycleValues } = await import(
  '../../dist/process-modules/application/lifecycle-mapper.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
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

// Discovery is a product idea-STRENGTH gate, not a build gate. An operator who
// starts the lifecycle has already decided to see the product built. Every
// Discovery outcome (including non-go) forwards to Formalization; the strength
// of the idea is recorded in the discovery certificate and does NOT block the
// conveyor (commit 2af9709 — permissive discovery gate). Formalization is the
// real go/no-go gate: its non-formalized outcomes terminate there.
test('Discovery forwards every outcome to Formalization (permissive gate; risks in certificate)', () => {
  // The strict "non-go terminates" behaviour was a regression of this contract
  // and was reverted. Every Discovery outcome advances to Formalization so the
  // conveyor can reason about the contract on its own merits.
  const discovery = discoveryToFormalizationLifecycle.stages.find(
    stage => stage.id === 'initial-discovery',
  );
  assert.ok(discovery);
  for (const outcome of ['go', 'clarify', 'reject']) {
    const route = routeProcessOutcome(discovery, outcome);
    assert.deepEqual(
      route.target,
      { type: 'stage', stageId: 'solution-formalization' },
      `${outcome} must forward to solution-formalization, got ${JSON.stringify(route.target)}`,
    );
    assert.equal(route.target.status, undefined,
      `${outcome} must not be terminal (no status)`);
  }
  // 'failed' is runtime-only (§15 budget terminal / kernel failure, 9d37a9e1):
  // a failed Discovery produced no certificate and no proposal, so
  // Formalization's entry conditions are unsatisfiable — it ends honestly.
  assert.deepEqual(
    routeProcessOutcome(discovery, 'failed').target,
    { type: 'terminal', status: 'failed' },
    "outcome 'failed' must be the honest terminal (no forwardable material)",
  );
});

// W13-A3: routing is now purely declarative. The runtime product-delivery
// lifecycle has NO per-run routeResolver and NO discoveryGate override — every
// go/no-go gate survives as a separate declarative Lifecycle Scenario Package
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
  // saga4: every idea-strength Discovery outcome routes forward to
  // Formalization (permissive gate — risks are carried by the discovery
  // certificate, not by blocking); runtime-only 'failed' ends honestly.
  for (const outcome of ['go', 'clarify', 'reject']) {
    assert.deepEqual(
      routeProcessOutcome(discovery, outcome).target,
      { type: 'stage', stageId: 'solution-formalization' },
      `${outcome} must route forward to solution-formalization`,
    );
  }
  assert.deepEqual(
    routeProcessOutcome(discovery, 'failed').target,
    { type: 'terminal', status: 'failed' },
  );
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

// --- Phase 4 / F1: stages must be reachable from the entry stage ---

test('F1: validator rejects a stage that is unreachable from the entry stage', () => {
  const broken = structuredClone(discoveryToFormalizationLifecycle);
  // Append an orphan stage no outcome route ever targets. It references the
  // discovery module so the moduleRef check passes; only reachability fails.
  broken.stages.push({
    id: 'orphan-stage',
    displayName: 'Orphan',
    moduleRef: DISCOVERY_MODULE_REF,
    inputMapping: { subject: '$.initiative.subject' },
    outcomeRoutes: {
      go: { type: 'terminal', status: 'orphan-done' },
    },
    entryConditions: [],
    exitConditions: [],
  });

  const validation = validateLifecycleDefinition(broken, registry);
  assert.equal(validation.valid, false);
  assert.match(
    validation.errors.join('\n'),
    /stage 'orphan-stage' is unreachable from entry stage/,
  );
});

test('F1: validator still passes the built-in product-delivery lifecycle (all reachable)', () => {
  const validation = validateLifecycleDefinition(discoveryToFormalizationLifecycle, registry);
  assert.equal(validation.valid, true, validation.errors.join('\n'));
  const reachabilityError = validation.errors
    .find(error => /is unreachable from entry stage/.test(error));
  assert.equal(reachabilityError, undefined);
});

// --- Phase 4 / F2: inputMapping must reference stages that exist ---

test('F2: validator rejects an inputMapping referencing an unknown stage', () => {
  const broken = structuredClone(discoveryToFormalizationLifecycle);
  const formalization = broken.stages.find(stage => stage.id === 'solution-formalization');
  assert.ok(formalization);
  // Point discoveryCertificateRef at a stage id that does not exist.
  formalization.inputMapping.discoveryCertificateRef =
    '$.stages.nonexistent-discovery.certificate.ref';

  const validation = validateLifecycleDefinition(broken, registry);
  assert.equal(validation.valid, false);
  assert.match(
    validation.errors.join('\n'),
    /inputMapping references unknown stage 'nonexistent-discovery'/,
  );
});

test('F2: validator accepts an inputMapping referencing an existing stage', () => {
  const validation = validateLifecycleDefinition(discoveryToFormalizationLifecycle, registry);
  const refError = validation.errors
    .find(error => /inputMapping references unknown stage/.test(error));
  assert.equal(refError, undefined, validation.errors.join('\n'));
  assert.equal(validation.valid, true);
});

test('F2: continuation accepts a mapping source from its authoritative inherited prefix', () => {
  const continuation = structuredClone(discoveryToFormalizationLifecycle);
  continuation.identity.name = 'product-delivery-continuation-fixture';
  continuation.entryStageId = 'solution-formalization';
  continuation.inheritedStages = [{
    id: 'initial-discovery',
    displayName: 'Initial Discovery',
    moduleRef: { name: 'product-discovery', version: '3.0.2' },
  }];
  continuation.stages = continuation.stages.filter(
    stage => stage.id !== 'initial-discovery',
  );

  const validation = validateLifecycleDefinition(continuation, registry);
  assert.equal(validation.valid, true, validation.errors.join('\n'));
});

test('F2: inherited stages cannot also be executable stages', () => {
  const broken = structuredClone(discoveryToFormalizationLifecycle);
  broken.inheritedStages = [{
    id: 'initial-discovery',
    displayName: 'Initial Discovery',
    moduleRef: { name: 'product-discovery', version: '3.0.2' },
  }];
  const validation = validateLifecycleDefinition(broken, registry);
  assert.equal(validation.valid, false);
  assert.match(
    validation.errors.join('\n'),
    /stage 'initial-discovery' is both executable and inherited/,
  );
});

test('F2: validator ignores literal and runtime mappings (no stage references)', () => {
  // A stage whose inputMapping uses only literal/runtime expressions must not
  // produce any unknown-stage error, even though it has no $.stages.* path.
  const broken = structuredClone(discoveryToFormalizationLifecycle);
  const discovery = broken.stages.find(stage => stage.id === 'initial-discovery');
  assert.ok(discovery);
  discovery.inputMapping = {
    projectId: { runtime: 'projectId' },
    schemaVersion: { literal: 'factory.case.v1' },
  };
  const validation = validateLifecycleDefinition(broken, registry);
  const refError = validation.errors
    .find(error => /inputMapping references unknown stage/.test(error));
  assert.equal(refError, undefined);
});
