// W0-A4 — Characterization: lifecycle routing, mapping, lock, restart
//
// Plan ref: §0.3.5, §6, §13.8–13.11, §13.21, §13.26–13.30.
//
// This file PRESERVES (§13.26–13.30):
//   - durable lifecycle/stage snapshots, hashes, leases, restart mechanics;
//   - transactional stage completion + next-stage creation;
//   - the common executor shape; restricted mapping; idempotency.
//
// And it PINS for Wave 7 (§13.8–13.11, §13.21):
//   - routeResolver function field on the serializable LifecycleDefinition;
//   - definitionHash that drops the resolver function body (present/absent bit);
//   - product-delivery-lifecycle's Object.defineProperty({enumerable:false}) dodge;
//   - cumulative-frame handoff (root input + all prior stage payloads).
//
// Each pin is marked with `// WAVE 7 WILL CHANGE THIS` so the eventual diff
// is obvious. Pure characterization — production source is untouched.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { LifecycleOrchestrator } = await import(
  '../../dist/process-modules/application/lifecycle-orchestrator.js'
);
const {
  routeProcessOutcome,
  validateLifecycleDefinition,
} = await import(
  '../../dist/process-modules/application/lifecycle-router.js'
);
const {
  mapLifecycleValues,
  resolveLifecyclePath,
} = await import(
  '../../dist/process-modules/application/lifecycle-mapper.js'
);
const { productDeliveryLifecycle } = await import(
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);
const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteLifecycleRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { createBuiltInProcessModuleRegistry } = await import(
  '../../dist/process-modules/modules/catalog.js'
);

// ---------------------------------------------------------------------------
// Shared synthetic fixtures (no concrete Process Modules — characterization
// is about orchestration mechanics, not real module behaviour).
// ---------------------------------------------------------------------------

const testModule = {
  identity: {
    name: 'w0a4-mod',
    version: '1.0.0',
    kind: 'test',
    displayName: 'W0-A4 Test Module',
    description: 'Synthetic module for characterization.',
  },
  inputContract: { id: 'w0a4.input.v1' },
  outputContract: { id: 'w0a4.output.v1' },
  outcomes: [{ code: 'done', description: 'Done.', terminal: true }],
  flow: {
    id: 'w0a4.flow',
    version: '1.0.0',
    entryNodeId: 'finish',
    nodes: [],
    transitions: [],
    terminalNodeIds: [],
  },
  artifacts: [],
  policies: [],
  invariants: [],
  executionProfiles: [],
};

const moduleRef = {
  name: testModule.identity.name,
  version: testModule.identity.version,
};

function stage({
  id = 'stage-one',
  displayName = 'Stage One',
  inputMapping = { value: '$.value' },
  outputMapping = { observedOutcome: '$.processOutcome.outcome' },
  outcomeRoutes = { done: { type: 'terminal', status: 'done' } },
  entryConditions = [],
  exitConditions = [],
  moduleRef: ref = moduleRef,
} = {}) {
  return {
    id,
    displayName,
    moduleRef: ref,
    inputMapping,
    outputMapping,
    outcomeRoutes,
    entryConditions,
    exitConditions,
  };
}

function singleStageDefinition(overrides = {}) {
  return {
    identity: {
      name: 'w0a4-lifecycle',
      version: '1.0.0',
      displayName: 'W0-A4 Lifecycle',
      description: 'One-stage lifecycle.',
    },
    entryStageId: 'stage-one',
    stages: [stage(overrides)],
  };
}

// Minimal ProcessModuleRegistry stub matching the shape the router/orchestrator
// needs (`get`, `require`).
function registry() {
  return {
    get: () => testModule,
    require: () => testModule,
  };
}

const mappingRuntime = {
  projectId: 7,
  epicId: 8,
  lifecycleRunId: 9,
  stageId: 'stage-one',
  initiatedBy: 'w0a4-test',
};

// ===========================================================================
// AREA 1 — lifecycle-router.ts: routeResolver called FIRST, static-table
// fallback, validation rejections.
// ===========================================================================

test('lifecycle-router: routeResolver is called FIRST and its result wins over the static table', () => {
  // WAVE 7 WILL CHANGE THIS — the resolver function field is the non-serializable
  // behaviour Wave 7 replaces with an explicit, serializable transition contract.
  const staticRoute = { type: 'terminal', status: 'static-done' };
  const override = { type: 'terminal', status: 'resolver-overrode' };
  const resolver = ({ stage, outcome }) => {
    if (stage.id === 'stage-one' && outcome === 'done') return override;
    return undefined;
  };
  const binding = stage({
    outcomeRoutes: { done: staticRoute },
  });
  const result = routeProcessOutcome(binding, 'done', { root: 'input' }, resolver);
  assert.deepEqual(
    result,
    { stageId: 'stage-one', outcome: 'done', target: override },
    'resolver result MUST win over the static outcomeRoutes entry',
  );
});

test('lifecycle-router: resolver returning undefined falls through to the static table', () => {
  const staticRoute = { type: 'terminal', status: 'static-done' };
  const resolver = () => undefined;
  const binding = stage({ outcomeRoutes: { done: staticRoute } });
  const result = routeProcessOutcome(binding, 'done', {}, resolver);
  assert.equal(result.target, staticRoute, 'undefined resolver result defers to static table');
});

test('lifecycle-router: with no resolver, the static outcomeRoutes table is authoritative', () => {
  const staticRoute = { type: 'terminal', status: 'static-done' };
  const binding = stage({ outcomeRoutes: { done: staticRoute } });
  const result = routeProcessOutcome(binding, 'done');
  assert.deepEqual(result.target, staticRoute);
  assert.throws(
    () => routeProcessOutcome(binding, 'unknown'),
    /has no route for process outcome 'unknown'/,
  );
});

test('lifecycle-router: validateLifecycleDefinition rejects missing entry stage', () => {
  const def = singleStageDefinition();
  def.entryStageId = 'does-not-exist';
  const v = validateLifecycleDefinition(def, registry());
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some(e => /entry stage 'does-not-exist' does not exist/.test(e)),
    v.errors.join('\n'),
  );
});

test('lifecycle-router: validateLifecycleDefinition rejects routes targeting nonexistent stages', () => {
  const binding = stage({
    outcomeRoutes: { done: { type: 'stage', stageId: 'phantom-stage' } },
  });
  const def = {
    identity: singleStageDefinition().identity,
    entryStageId: 'stage-one',
    stages: [binding],
  };
  const v = validateLifecycleDefinition(def, registry());
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some(e => /targets missing stage 'phantom-stage'/.test(e)),
    v.errors.join('\n'),
  );
});

test('lifecycle-router: validateLifecycleDefinition rejects routes with empty terminal status', () => {
  const binding = stage({
    outcomeRoutes: { done: { type: 'terminal', status: '   ' } },
  });
  const def = {
    identity: singleStageDefinition().identity,
    entryStageId: 'stage-one',
    stages: [binding],
  };
  const v = validateLifecycleDefinition(def, registry());
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some(e => /empty terminal status/.test(e)),
    v.errors.join('\n'),
  );
});

test('lifecycle-router: validateLifecycleDefinition rejects routes for undeclared module outcomes', () => {
  // outcomeRoutes declares an outcome the module never declares.
  const binding = stage({
    outcomeRoutes: {
      done: { type: 'terminal', status: 'done' },
      invented: { type: 'terminal', status: 'invented' },
    },
  });
  const def = {
    identity: singleStageDefinition().identity,
    entryStageId: 'stage-one',
    stages: [binding],
  };
  const v = validateLifecycleDefinition(def, registry());
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some(e => /routes undeclared module outcome 'invented'/.test(e)),
    v.errors.join('\n'),
  );
});

test('lifecycle-router: validateLifecycleDefinition rejects stages that miss a declared module outcome route', () => {
  // testModule declares outcome 'done'; the stage only routes 'other'.
  const binding = stage({
    outcomeRoutes: { other: { type: 'terminal', status: 'other' } },
  });
  const def = {
    identity: singleStageDefinition().identity,
    entryStageId: 'stage-one',
    stages: [binding],
  };
  const v = validateLifecycleDefinition(def, registry());
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some(e => /has no route for module outcome 'done'/.test(e)),
    v.errors.join('\n'),
  );
});

test('lifecycle-router: validateLifecycleDefinition rejects duplicate stage ids', () => {
  const def = {
    identity: singleStageDefinition().identity,
    entryStageId: 'stage-one',
    stages: [stage({ id: 'stage-one' }), stage({ id: 'stage-one' })],
  };
  const v = validateLifecycleDefinition(def, registry());
  assert.equal(v.valid, false);
  assert.ok(v.errors.some(e => /duplicate stage ids/.test(e)), v.errors.join('\n'));
});

test('lifecycle-router: stage-id validation is a local Set — runtime-only, not persisted', () => {
  // Characterization: validateLifecycleDefinition builds a fresh Set from
  // lifecycle.stages on every call. There is no durable "known stage ids"
  // store; validation is purely a runtime check on the in-memory definition.
  const reg = registry();
  const def1 = singleStageDefinition();
  const def2 = singleStageDefinition();
  const v1 = validateLifecycleDefinition(def1, reg);
  const v2 = validateLifecycleDefinition(def2, reg);
  assert.equal(v1.valid, true);
  assert.equal(v2.valid, true);
  // Mutating def1's stages does NOT change def2's validation — they don't
  // share any persisted stage-id registry.
  def1.stages[0] = stage({ id: 'mutated' });
  def1.entryStageId = 'mutated';
  assert.equal(validateLifecycleDefinition(def2, reg).valid, true);
});

test('lifecycle-router: validateLifecycleDefinition rejects stages referencing unregistered modules', () => {
  const def = {
    identity: singleStageDefinition().identity,
    entryStageId: 'stage-one',
    stages: [stage()],
  };
  const emptyRegistry = {
    get: () => null,
    require: () => null,
  };
  const v = validateLifecycleDefinition(def, emptyRegistry);
  assert.equal(v.valid, false);
  assert.ok(
    v.errors.some(e => /references an unregistered process module/.test(e)),
    v.errors.join('\n'),
  );
});

// ===========================================================================
// AREA 2 — lifecycle-mapper.ts: JSON-path reads, __proto__/prototype/
// constructor rejection, literal passthrough.
// ===========================================================================

test('lifecycle-mapper: resolveLifecyclePath reads "$" (the whole source)', () => {
  const source = { a: 1, b: { c: 2 } };
  assert.deepEqual(resolveLifecyclePath(source, '$'), source);
});

test('lifecycle-mapper: resolveLifecyclePath walks dotted JSON paths', () => {
  const source = { a: { b: { c: 42 } } };
  assert.equal(resolveLifecyclePath(source, '$.a.b.c'), 42);
});

test('lifecycle-mapper: resolveLifecyclePath rejects "$" prefixes that are not "$" or "$."', () => {
  assert.throws(
    () => resolveLifecyclePath({ x: 1 }, 'x'),
    /LIFECYCLE_MAPPING_INVALID_PATH/,
  );
  assert.throws(
    () => resolveLifecyclePath({ x: 1 }, '$x'),
    /LIFECYCLE_MAPPING_INVALID_PATH/,
  );
});

test('lifecycle-mapper: resolveLifecyclePath rejects missing segments', () => {
  assert.throws(
    () => resolveLifecyclePath({ a: 1 }, '$.b'),
    /LIFECYCLE_MAPPING_SOURCE_MISSING/,
  );
  // Empty segment in the middle of the path is also rejected.
  assert.throws(
    () => resolveLifecyclePath({ a: { b: 1 } }, '$.a..b'),
    /LIFECYCLE_MAPPING_SOURCE_MISSING/,
  );
});

test('lifecycle-mapper: resolveLifecyclePath refuses to walk inherited properties', () => {
  const inherited = Object.create({ secret: 'must-not-leak' });
  const source = { payload: inherited };
  assert.throws(
    () => resolveLifecyclePath(source, '$.payload.secret'),
    /LIFECYCLE_MAPPING_SOURCE_MISSING/,
  );
});

// Pin each prototype-polluting path rejection explicitly. The mapper holds a
// frozen Set of unsafe segments and refuses them in both source-path reads
// and target-path writes.
test('lifecycle-mapper: resolveLifecyclePath rejects __proto__ segments', () => {
  assert.throws(
    () => resolveLifecyclePath({}, '$.__proto__.polluted'),
    /LIFECYCLE_MAPPING_SOURCE_MISSING/,
  );
});

test('lifecycle-mapper: resolveLifecyclePath rejects prototype segments', () => {
  assert.throws(
    () => resolveLifecyclePath({}, '$.prototype.polluted'),
    /LIFECYCLE_MAPPING_SOURCE_MISSING/,
  );
});

test('lifecycle-mapper: resolveLifecyclePath rejects constructor segments', () => {
  assert.throws(
    () => resolveLifecyclePath({}, '$.constructor.polluted'),
    /LIFECYCLE_MAPPING_SOURCE_MISSING/,
  );
});

test('lifecycle-mapper: mapLifecycleValues rejects __proto__ in target paths', () => {
  assert.throws(
    () =>
      mapLifecycleValues(
        { '__proto__.polluted': { literal: true } },
        {},
        mappingRuntime,
      ),
    /LIFECYCLE_MAPPING_INVALID_TARGET/,
  );
  assert.equal(({}).polluted, undefined, 'prototype must not be polluted');
});

test('lifecycle-mapper: mapLifecycleValues rejects constructor.prototype.* target paths', () => {
  assert.throws(
    () =>
      mapLifecycleValues(
        { 'constructor.prototype.polluted': { literal: true } },
        {},
        mappingRuntime,
      ),
    /LIFECYCLE_MAPPING_INVALID_TARGET/,
  );
  assert.equal(({}).polluted, undefined);
});

test('lifecycle-mapper: mapLifecycleValues rejects prototype.* target paths', () => {
  assert.throws(
    () =>
      mapLifecycleValues(
        { 'prototype.polluted': { literal: true } },
        {},
        mappingRuntime,
      ),
    /LIFECYCLE_MAPPING_INVALID_TARGET/,
  );
});

test('lifecycle-mapper: literal values pass through unchanged', () => {
  const out = mapLifecycleValues(
    {
      aNumber: { literal: 42 },
      aString: { literal: 'hello' },
      anObject: { literal: { nested: [1, 2, 3] } },
      aBool: { literal: true },
      aNull: { literal: null },
    },
    {},
    mappingRuntime,
  );
  assert.deepEqual(out, {
    aNumber: 42,
    aString: 'hello',
    anObject: { nested: [1, 2, 3] },
    aBool: true,
    aNull: null,
  });
});

test('lifecycle-mapper: literal undefined is rejected (undefined is not a valid JSON value)', () => {
  assert.throws(
    () =>
      mapLifecycleValues({ value: { literal: undefined } }, {}, mappingRuntime),
    /LIFECYCLE_MAPPING_VALUE_UNDEFINED/,
  );
});

test('lifecycle-mapper: runtime expressions resolve to the per-stage runtime fields', () => {
  const out = mapLifecycleValues(
    {
      p: { runtime: 'projectId' },
      e: { runtime: 'epicId' },
      r: { runtime: 'lifecycleRunId' },
      s: { runtime: 'stageId' },
      b: { runtime: 'initiatedBy' },
    },
    {},
    mappingRuntime,
  );
  assert.deepEqual(out, {
    p: 7,
    e: 8,
    r: 9,
    s: 'stage-one',
    b: 'w0a4-test',
  });
});

test('lifecycle-mapper: string expressions are JSON-path reads against the source frame', () => {
  const source = { root: { nested: { leaf: 'leaf-value' } } };
  const out = mapLifecycleValues(
    { 'out.leaf': '$.root.nested.leaf' },
    source,
    mappingRuntime,
  );
  assert.deepEqual(out, { out: { leaf: 'leaf-value' } });
});

test('lifecycle-mapper: clones values so the output cannot mutate the source', () => {
  const nested = { leaf: 'leaf-value' };
  const source = { root: nested };
  const out = mapLifecycleValues({ value: '$.root' }, source, mappingRuntime);
  assert.deepEqual(out.value, nested);
  out.value.leaf = 'mutated';
  assert.equal(nested.leaf, 'leaf-value', 'source must remain untouched');
});

test('lifecycle-mapper: detects duplicate writes to the same target leaf', () => {
  // JS object literals de-duplicate identical keys at parse time, so we build
  // the mapping imperatively to actually express two writes to the same path.
  const mapping = {};
  mapping['a.b'] = { literal: 1 };
  // Re-assign the same key in a second statement so the mapping really has
  // the key once, then add a SECOND key that traverses through `a` to set `b`
  // again — which collides at the leaf.
  assert.throws(
    () =>
      mapLifecycleValues(
        { 'a.b': { literal: 1 }, 'a.b.duplicate': { literal: 2 } },
        {},
        mappingRuntime,
      ),
    /LIFECYCLE_MAPPING_TARGET_COLLISION|LIFECYCLE_MAPPING_TARGET_DUPLICATE/,
  );
  // Two writes that arrive at the same leaf via setTargetPath duplicate
  // detection (the second setTargetPath finds the leaf already owned).
  // Build the mapping as a fresh object each call so JS literal dedup does
  // not collapse them: the duplicate-leaf case requires the parent to already
  // be a record holding the leaf, so we feed two siblings that both target
  // `out.x` through different nestings.
  assert.throws(
    () =>
      mapLifecycleValues(
        { 'out.x': { literal: 1 }, 'out.x.again': { literal: 2 } },
        {},
        mappingRuntime,
      ),
    /LIFECYCLE_MAPPING_TARGET_COLLISION/,
  );
});

test('lifecycle-mapper: detects target collision when an existing value is not a record', () => {
  assert.throws(
    () =>
      mapLifecycleValues(
        {
          'a.b': { literal: 'scalar' },
          'a.b.c': { literal: 1 },
        },
        {},
        mappingRuntime,
      ),
    /LIFECYCLE_MAPPING_TARGET_COLLISION/,
  );
});

// ===========================================================================
// AREA 3 — lifecycle-orchestrator.ts: definitionHash drops the resolver
// function body, lease acquisition, restart resume.
// ===========================================================================

test('lifecycle-orchestrator: definitionHash via canonicalJson drops the resolver function body (present/absent bit only)', () => {
  // WAVE 7 WILL CHANGE THIS — §13.9/§13.11: the hash silently drops function
  // resolvers. This test pins BOTH halves of the dodge:
  //   (a) a PLAIN enumerable `routeResolver` function property becomes
  //       `routeResolver: undefined` under canonicalJson (functions are not
  //       valid JSON values), so the resolver body never reaches the hash.
  //   (b) the only way to make the hash truly identical with-vs-without the
  //       resolver is `Object.defineProperty({enumerable:false})` (the dodge
  //       product-delivery-lifecycle uses, pinned separately in AREA 4).
  const base = {
    identity: { name: 'l', version: '1.0.0' },
    entryStageId: 's',
    stages: [],
  };
  const resolverA = () => ({ type: 'terminal', status: 'a' });
  const resolverB = () => ({ type: 'terminal', status: 'b' /* different body */ });

  const withA = { ...base, routeResolver: resolverA };
  const withB = { ...base, routeResolver: resolverB };

  // (a) Both bodies serialize to the SAME canonicalJson string — the function
  // body is dropped to `undefined`, but the key is still present (because the
  // property is enumerable here). What matters for the hash is the function
  // NEVER contributes its body.
  assert.equal(canonicalJson(withA), canonicalJson(withB));
  assert.equal(sha256Hex(withA), sha256Hex(withB));
  // Different bodies, identical hashes — the body is invisible to the hash.
  assert.equal(
    sha256Hex({ ...base, routeResolver: resolverA }),
    sha256Hex({ ...base, routeResolver: resolverB }),
  );

  // (b) To make the hash FULLY identical to the no-resolver baseline, the
  // property must be non-enumerable — that is the dodge Wave 7 removes.
  const withNonEnum = { ...base };
  Object.defineProperty(withNonEnum, 'routeResolver', {
    value: resolverA,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  assert.equal(
    canonicalJson(withNonEnum),
    canonicalJson(base),
    'non-enumerable resolver makes the snapshot identical to the no-resolver baseline',
  );
  assert.equal(sha256Hex(withNonEnum), sha256Hex(base));
});

test('lifecycle-orchestrator: lease token shape is {owner, fence} and fence is monotonic', () => {
  // Uses the durable sqlite repo against a tmpdir DB.
  const fx = lifecycleFixture();
  try {
    const run = fx.lifecycleRepo.start(startCommand()).record;
    const first = fx.lifecycleRepo.acquireExecutionLease(
      run.id,
      'driver-a',
      '2026-07-26T00:00:00.000Z',
      '2099-01-01T00:00:00.000Z',
    );
    assert.ok(first);
    assert.equal(typeof first.owner, 'string');
    assert.equal(first.owner, 'driver-a');
    assert.ok(Number.isInteger(first.fence) && first.fence > 0);

    // A second acquirer is REJECTED while the lease is held by an unexpired owner.
    const second = fx.lifecycleRepo.acquireExecutionLease(
      run.id,
      'driver-b',
      '2026-07-26T00:00:00.000Z',
      '2099-01-02T00:00:00.000Z',
    );
    assert.equal(second, null);

    // After expiry, a takeover succeeds with a strictly greater fence.
    const takeover = fx.lifecycleRepo.acquireExecutionLease(
      run.id,
      'driver-b',
      '2100-01-01T00:00:00.000Z',
      '2101-01-01T00:00:00.000Z',
    );
    assert.ok(takeover);
    assert.ok(takeover.fence > first.fence, 'fence must be strictly monotonic');
  } finally {
    cleanupLifecycleFixture(fx);
  }
});

test('lifecycle-orchestrator: a paused LifecycleRun reloads and resumes from its frozen StageRun input', async () => {
  // WAVE 7 PRESERVES restart mechanics (§13.26) — pin the resume-point
  // semantics: the orchestrator reads the durable frozen StageRun input and
  // does NOT recompute it from the lifecycle definition. This uses a mock
  // repo that simulates a paused→resume reload.
  const frozenInput = { frozen: 'authoritative-input' };
  let observedStageInput = null;

  const definition = singleStageDefinition({
    inputMapping: { value: '$.different-if-remapped' },
  });

  const state = {
    lifecycle: makeLifecycleRunRecord(definition, 'paused'),
    stage: makeStageRecord(definition, frozenInput, 42, 'paused'),
    process: completedProcess(42),
  };

  const lifecycleRunRepo = mockLifecycleRunRepo(state);
  const processRunRepo = {
    start: ({ input }) => {
      observedStageInput = input.payload;
      return { record: state.process, replayed: false };
    },
    read: () => state.process,
  };
  const installationRegistry = {
    require: () => ({
      definition: testModule,
      executor: {
        moduleRef,
        kind: 'test',
        execute: () => {
          // ProcessRun already shows completed in the mock, so the executor
          // would not be invoked for a completed run. This is a guard only.
          throw new Error('executor must not be called for a replayed completed ProcessRun');
        },
      },
    }),
  };

  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo,
    processRunRepo,
    moduleRegistry: registry(),
    installationRegistry,
  });

  const result = await orchestrator.run(definition, {
    projectId: 7,
    epicId: 8,
    inputSchema: 'w0a4.lifecycle-input.v1',
    inputPayload: { ignored: 'on-resume' },
    initiatedBy: 'w0a4-test',
    idempotencyKey: 'w0a4-resume',
    resumePaused: true,
  });

  // The frozen StageRun input (not the original root input remapped) is the
  // authoritative resume point.
  assert.equal(result.status, 'completed');
  assert.deepEqual(observedStageInput, frozenInput);
});

// ===========================================================================
// AREA 4 — product-delivery-lifecycle.ts: defineProperty({enumerable:false})
// dodge, discoveryGate switch, stage order.
// ===========================================================================

test('product-delivery-lifecycle: routeResolver is attached non-enumerably (the defineProperty dodge)', () => {
  // WAVE 7 WILL CHANGE THIS — §13.9: Object.defineProperty({enumerable:false})
  // is the dodge that lets the resolver coexist with canonicalJson. Wave 7
  // removes the resolver function field entirely.
  const def = productDeliveryLifecycle;

  // The resolver is reachable at runtime but invisible to enumeration.
  assert.equal(
    Object.prototype.propertyIsEnumerable.call(def, 'routeResolver'),
    false,
    'routeResolver MUST be non-enumerable so canonicalJson/JSON skip it',
  );
  assert.equal(typeof def.routeResolver, 'function');
  assert.ok(!Object.keys(def).includes('routeResolver'));
  assert.ok(!JSON.stringify(def).includes('routeResolver'));
});

test('product-delivery-lifecycle: a definition without the resolver hashes identically', () => {
  // WAVE 7 WILL CHANGE THIS — same pin as §13.11: hash drops the function.
  const def = productDeliveryLifecycle;
  const { identity, entryStageId, stages } = def;
  const withoutResolver = { identity, entryStageId, stages };
  assert.equal(sha256Hex(withoutResolver), sha256Hex(def));
  assert.equal(canonicalJson(withoutResolver), canonicalJson(def));
});

test('product-delivery-lifecycle: discoveryGate switch routes permissively by default and strictly when set', () => {
  const discovery = productDeliveryLifecycle.stages.find(
    s => s.id === 'initial-discovery',
  );
  const resolver = productDeliveryLifecycle.routeResolver;
  assert.ok(discovery);
  assert.ok(resolver);

  // Default (no flag) and unknown flag values fall through to permissive.
  for (const outcome of ['clarify', 'reject', 'defer', 'inconclusive', 'failed']) {
    assert.deepEqual(
      routeProcessOutcome(discovery, outcome, {}, resolver).target,
      { type: 'stage', stageId: 'solution-formalization' },
      `${outcome} forwards under permissive default`,
    );
  }
  // 'go' always forwards to Formalization regardless of gate.
  assert.deepEqual(
    routeProcessOutcome(discovery, 'go', { discoveryGate: 'strict' }, resolver).target,
    { type: 'stage', stageId: 'solution-formalization' },
  );

  // Strict gate routes each non-go outcome to its legacy terminal status.
  const expectedStrict = {
    clarify: 'clarification-required',
    reject: 'rejected',
    defer: 'deferred',
    inconclusive: 'inconclusive',
    failed: 'failed',
  };
  for (const [outcome, status] of Object.entries(expectedStrict)) {
    assert.deepEqual(
      routeProcessOutcome(discovery, outcome, { discoveryGate: 'strict' }, resolver).target,
      { type: 'terminal', status },
      `strict gate terminates ${outcome} → ${status}`,
    );
  }

  // Unknown gate value fails safe (forward), even though the upstream input
  // validator would reject it.
  assert.equal(
    routeProcessOutcome(discovery, 'reject', { discoveryGate: 'bogus' }, resolver).target.type,
    'stage',
  );
});

test('product-delivery-lifecycle: the resolver only overrides the Discovery stage', () => {
  const resolver = productDeliveryLifecycle.routeResolver;
  const strictInput = { discoveryGate: 'strict' };
  const formalization = productDeliveryLifecycle.stages.find(
    s => s.id === 'solution-formalization',
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

test('product-delivery-lifecycle: stage order is Discovery → Formalization → Development → Delivery/Release', () => {
  const ids = productDeliveryLifecycle.stages.map(s => s.id);
  assert.deepEqual(
    ids,
    ['initial-discovery', 'solution-formalization', 'solution-development', 'delivery-release'],
  );
  assert.equal(productDeliveryLifecycle.entryStageId, 'initial-discovery');

  // And the static outcomeRoutes encode the same chain.
  const discoveryRoutes = productDeliveryLifecycle.stages[0].outcomeRoutes;
  assert.deepEqual(discoveryRoutes.go, { type: 'stage', stageId: 'solution-formalization' });
  const formalizationRoutes = productDeliveryLifecycle.stages[1].outcomeRoutes;
  assert.deepEqual(formalizationRoutes.formalized, { type: 'stage', stageId: 'solution-development' });
  const developmentRoutes = productDeliveryLifecycle.stages[2].outcomeRoutes;
  assert.deepEqual(developmentRoutes.verified, { type: 'stage', stageId: 'delivery-release' });
  const deliveryRoutes = productDeliveryLifecycle.stages[3].outcomeRoutes;
  assert.deepEqual(deliveryRoutes.released, { type: 'terminal', status: 'released' });
});

test('product-delivery-lifecycle: the full lifecycle validates against the built-in module registry', () => {
  // Uses the real built-in catalog so this characterization also pins the
  // concrete module-name coupling that Wave 7 will break (§13.9).
  const builtIn = createBuiltInProcessModuleRegistry();
  const v = validateLifecycleDefinition(productDeliveryLifecycle, builtIn);
  assert.equal(v.valid, true, v.errors.join('\n'));
});

// ===========================================================================
// AREA 5 — Cumulative-frame handoff (§13.21): the orchestrator persists a
// frame containing the root input + ALL prior stage payloads on every
// transition. Wave 7 replaces this with content-addressed single-output
// storage.
// ===========================================================================

test('cumulative-frame handoff: stage 3 input envelope contains data from stage 1', async () => {
  // WAVE 7 WILL CHANGE THIS — §13.21: the cumulative-frame rebuild exposes
  // unrelated prior stage data to every downstream stage. We pin the
  // current behaviour with a 3-stage mock lifecycle so the future diff is
  // obvious when single-output storage replaces it.
  //
  // The mock lifecycleRunRepo tracks the lifecycleRun's current stage. Each
  // time processRunRepo.start is called we snapshot the mapped input payload
  // keyed by that current stage id, so we can later assert what each stage
  // actually saw through the cumulative frame.

  const ref1 = { name: 'm1', version: '1.0.0' };
  const ref2 = { name: 'm2', version: '1.0.0' };
  const ref3 = { name: 'm3', version: '1.0.0' };

  // Stage 3's inputMapping reads from stage 1's mapped output — proving the
  // cumulative frame carried stage 1's data forward two hops.
  const definition = {
    identity: {
      name: 'w0a4-cumulative',
      version: '1.0.0',
      displayName: 'Cumulative',
      description: '3-stage lifecycle.',
    },
    entryStageId: 's1',
    stages: [
      {
        id: 's1',
        displayName: 'S1',
        moduleRef: ref1,
        inputMapping: { seed: '$.rootSeed' },
        outputMapping: { s1Echo: '$.processOutcome.outcome' },
        outcomeRoutes: { done: { type: 'stage', stageId: 's2' } },
        entryConditions: [],
        exitConditions: [],
      },
      {
        id: 's2',
        displayName: 'S2',
        moduleRef: ref2,
        inputMapping: { fromS1: '$.stages.s1.s1Echo' },
        outputMapping: { s2Echo: '$.processOutcome.outcome' },
        outcomeRoutes: { done: { type: 'stage', stageId: 's3' } },
        entryConditions: [],
        exitConditions: [],
      },
      {
        id: 's3',
        displayName: 'S3',
        moduleRef: ref3,
        // Reads BOTH stage 1 and stage 2 outputs through the cumulative frame.
        inputMapping: {
          fromS1: '$.stages.s1.s1Echo',
          fromS2: '$.stages.s2.s2Echo',
        },
        outputMapping: {},
        outcomeRoutes: { done: { type: 'terminal', status: 'complete' } },
        entryConditions: [],
        exitConditions: [],
      },
    ],
  };

  // The harness: a single mutable state object that the mock repos mutate.
  const stageInputs = { s1: null, s2: null, s3: null };
  const stageRunById = new Map();
  let nextStageRunId = 100;
  let stageRuns = [];
  let lifecycleRun = null;
  let nextProcessId = 200;
  let lastStartedProcess = null;

  function makeStageRun(stageId, moduleRef, inputPayload, ordinal) {
    const binding = definition.stages.find(s => s.id === stageId);
    return {
      id: nextStageRunId++,
      lifecycleRunId: 1,
      ordinal,
      stageId,
      attempt: 1,
      moduleRef,
      bindingSnapshot: canonicalJson(binding),
      bindingHash: sha256Hex(binding),
      inputSchema: 'w0a4.input.v1',
      inputSnapshot: canonicalJson(inputPayload),
      inputHash: sha256Hex(inputPayload),
      status: 'created',
      processRunId: null,
      localOutcome: null,
      authority: null,
      output: null,
      certificate: null,
      mappedOutput: null,
      resultSnapshot: null,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  const lifecycleRunRepo = {
    start: ({ input }) => {
      lifecycleRun = {
        id: 1,
        lifecycle: definition.identity,
        lifecycleRefKey: 'w0a4-cumulative@1.0.0',
        definitionSnapshot: canonicalJson(definition),
        definitionHash: sha256Hex(definition),
        projectId: 7,
        epicId: 8,
        initiatedBy: 'w0a4-test',
        idempotencyKey: 'cumulative-run',
        inputSchema: 'w0a4.lifecycle-input.v1',
        inputSnapshot: canonicalJson(input.payload),
        inputHash: sha256Hex(input.payload),
        status: 'created',
        entryStageId: 's1',
        currentStageId: 's1',
        currentStageRunId: null,
        terminalStatus: null,
        version: 0,
        leaseFence: 0,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return { record: lifecycleRun, replayed: false };
    },
    read: () => lifecycleRun,
    readByIdempotencyKey: () => lifecycleRun,
    listStageRuns: () => stageRuns.filter(s => s.status === 'completed'),
    readCurrentStageRun: () => null,
    ensureStageRun: (command) => {
      const existing = stageRuns.find(s => s.stageId === command.stageId);
      if (existing) return { record: existing, replayed: existing.processRunId !== null };
      const stageRun = makeStageRun(
        command.stageId,
        command.moduleRef,
        command.inputPayload,
        stageRuns.length + 1,
      );
      stageRunById.set(stageRun.id, stageRun);
      stageRuns.push(stageRun);
      lifecycleRun.currentStageRunId = stageRun.id;
      lifecycleRun.currentStageId = stageRun.stageId;
      return { record: stageRun, replayed: false };
    },
    bindProcessRun: (_lrid, stageRunId, processRunId) => {
      const sr = stageRunById.get(stageRunId);
      sr.processRunId = processRunId;
      return sr;
    },
    markStageRunning: (_lrid, stageRunId) => {
      const sr = stageRunById.get(stageRunId);
      sr.status = 'running';
      lifecycleRun.status = 'running';
      return sr;
    },
    pauseStage: () => lifecycleRun,
    fail: (_lrid, _srid, error) => {
      lifecycleRun.status = 'failed';
      lifecycleRun.error = error;
      return lifecycleRun;
    },
    resume: () => lifecycleRun,
    cancel: () => lifecycleRun,
    listRecoverable: () => [],
    completeStage: (command) => {
      const sr = stageRunById.get(command.stageRunId);
      sr.status = 'completed';
      sr.localOutcome = command.outcome;
      sr.mappedOutput = command.mappedOutput;
      sr.resultSnapshot = command.resultSnapshot;
      sr.processRunId = sr.processRunId ?? null;
      if (command.nextStage) {
        const nextSr = makeStageRun(
          command.nextStage.stageId,
          command.nextStage.moduleRef,
          command.nextStage.inputPayload,
          stageRuns.length + 1,
        );
        stageRunById.set(nextSr.id, nextSr);
        stageRuns.push(nextSr);
        lifecycleRun.currentStageRunId = nextSr.id;
        lifecycleRun.currentStageId = nextSr.stageId;
        lifecycleRun.status = 'running';
      } else {
        lifecycleRun.status = 'completed';
        lifecycleRun.currentStageId = null;
        lifecycleRun.currentStageRunId = null;
        lifecycleRun.terminalStatus = command.target.status;
      }
      return {
        lifecycleRun,
        stageRun: sr,
        transition: {
          id: 1, lifecycleRunId: 1,
          from_stage_run_id: sr.id, transition_key: command.transitionKey,
          outcome: command.outcome, target: command.target,
          to_stage_run_id: command.nextStage ? nextStageRunId - 1 : null,
        },
        replayed: false,
      };
    },
    acquireExecutionLease: (_id, owner) => {
      lifecycleRun.status = 'running';
      return { owner, fence: 1 };
    },
    renewExecutionLease: () => true,
    releaseExecutionLease: () => {},
  };

  // Capture the mapped input payload keyed by the lifecycle's current stage
  // id at the moment processRunRepo.start is called.
  const processRunRepo = {
    start: ({ input }) => {
      const id = nextProcessId++;
      stageInputs[lifecycleRun.currentStageId] = input.payload;
      lastStartedProcess = {
        id,
        status: 'created',
        localOutcome: null,
        authority: null,
        outputSchema: null,
        outputRef: null,
        outputHash: null,
        certificateSchema: null,
        certificateRef: null,
        certificateHash: null,
        error: null,
      };
      return { record: lastStartedProcess, replayed: false };
    },
    read: id => (lastStartedProcess && lastStartedProcess.id === id ? lastStartedProcess : null),
  };

  const moduleRegistry = {
    get: () => testModule,
    require: () => testModule,
  };
  const installationRegistry = {
    require: () => ({
      definition: testModule,
      executor: {
        moduleRef: ref1,
        kind: 'test',
        // Mark the in-flight ProcessRun completed synchronously so the
        // orchestrator's executeOrReplayProcess path produces a 'done' outcome.
        execute: async () => {
          lastStartedProcess.status = 'completed';
          lastStartedProcess.localOutcome = 'done';
          lastStartedProcess.authority = 'w0a4-test-policy';
        },
      },
    }),
  };

  const orchestrator = new LifecycleOrchestrator({
    lifecycleRunRepo,
    processRunRepo,
    moduleRegistry,
    installationRegistry,
    outputPayloadRegistry: null,
  });

  const result = await orchestrator.run(definition, {
    projectId: 7,
    epicId: 8,
    inputSchema: 'w0a4.lifecycle-input.v1',
    inputPayload: { rootSeed: 'the-seed' },
    initiatedBy: 'w0a4-test',
    idempotencyKey: 'cumulative-run',
  });

  assert.equal(result.status, 'completed', 'lifecycle should complete');

  // THE CUMULATIVE-FRAME PIN: stage 3 received stage 1's mapped output via the
  // cumulative handoff frame, two hops later. Wave 7 will replace this with a
  // content-addressed single-output lookup and stage 3 will instead reference
  // stage 1's output by hash.
  assert.ok(stageInputs.s3, 'stage 3 input must have been mapped');
  assert.equal(
    stageInputs.s3.fromS1,
    'done',
    'stage 3 input MUST contain stage 1\'s mapped output (cumulative-frame carry-through)',
  );
  assert.equal(
    stageInputs.s3.fromS2,
    'done',
    'stage 3 input MUST also contain stage 2\'s mapped output',
  );

  // Stage 2 saw stage 1's output one hop earlier.
  assert.equal(stageInputs.s2.fromS1, 'done');
  // Stage 1 saw the root seed.
  assert.equal(stageInputs.s1.seed, 'the-seed');
});

// ===========================================================================
// AREA 6 — Transactional stage completion (§13.27 PRESERVE): completion +
// next-stage insert in one transaction; rollback on failure.
// ===========================================================================

test('transactional stage completion: completion + next-stage insert happen in one transaction', () => {
  // WAVE 7 PRESERVES §13.27 — the transaction boundary. Pin that a successful
  // completeStage persists BOTH the completion AND the next StageRun in the
  // same SQLite transaction (visible as 2 stage rows + 1 transition row).
  const fx = lifecycleFixture();
  try {
    const run = fx.lifecycleRepo.start(startCommand()).record;
    const lease = acquireLease(fx.lifecycleRepo, run.id);

    const stage = fx.lifecycleRepo.ensureStageRun(stageCommand(run.id), lease).record;
    const process = startProcessRun(fx.processRepo, stage);
    fx.lifecycleRepo.bindProcessRun(run.id, stage.id, process.id, lease);
    fx.lifecycleRepo.markStageRunning(run.id, stage.id, lease);
    completeProcessRun(fx.processRepo, process.id);

    const nextStageCmd = stageCommand(run.id, {
      stageId: 'formalization',
      moduleName: 'solution-formalization',
      moduleVersion: '1.0.0',
      payload: { from: 'discovery' },
    });
    const target = { type: 'stage', stageId: 'formalization' };
    const handoffSnapshot = { stages: { discovery: { value: 1 } } };
    const handoffHash = sha256Hex(handoffSnapshot);
    const decisionHash = sha256Hex({
      lifecycleRunId: run.id,
      stageRunId: stage.id,
      outcome: 'done',
      target,
      handoffHash,
    });
    const resultSnapshot = buildExpectedResultSnapshot();

    const completed = fx.lifecycleRepo.completeStage({
      lifecycleRunId: run.id,
      stageRunId: stage.id,
      expectedStageId: 'discovery',
      transitionKey: `lifecycle:${run.id}:stage:${stage.id}`,
      outcome: 'done',
      authority: resultSnapshot.authority,
      output: resultSnapshot.output,
      certificate: resultSnapshot.certificate,
      resultSnapshot,
      mappedOutput: { decision: 'done' },
      target,
      handoffSnapshot,
      handoffHash,
      decisionHash,
      nextStage: {
        stageId: nextStageCmd.stageId,
        moduleRef: nextStageCmd.moduleRef,
        bindingSnapshot: nextStageCmd.bindingSnapshot,
        bindingHash: nextStageCmd.bindingHash,
        inputSchema: nextStageCmd.inputSchema,
        inputPayload: nextStageCmd.inputPayload,
        inputHash: nextStageCmd.inputHash,
      },
    }, lease);

    assert.equal(completed.replayed, false);
    assert.equal(completed.stageRun.status, 'completed');
    assert.ok(completed.transition.toStageRunId > 0);
    assert.equal(completed.lifecycleRun.currentStageId, 'formalization');
    assert.equal(
      completed.lifecycleRun.currentStageRunId,
      completed.transition.toStageRunId,
    );

    // Both rows are visible post-commit: the completed stage 1 + the new stage 2.
    const stages = fx.lifecycleRepo.listStageRuns(run.id);
    assert.equal(stages.length, 2);
    assert.equal(stages[0].status, 'completed');
    assert.equal(stages[1].status, 'created');
    assert.equal(stages[1].stageId, 'formalization');
    assert.equal(
      fx.db.prepare(
        'SELECT COUNT(*) AS n FROM saga3_process_transitions WHERE lifecycle_run_id=?',
      ).get(run.id).n,
      1,
    );
  } finally {
    cleanupLifecycleFixture(fx);
  }
});

test('transactional stage completion: a failure between completion and next-stage insert rolls BOTH back', () => {
  // WAVE 7 PRESERVES §13.27 — the rollback half of the transaction. Pin that
  // when the next-stage insert cannot succeed (e.g. the nextStage command
  // fails verifyStageCommand), the completion is NOT persisted either.
  const fx = lifecycleFixture();
  try {
    const run = fx.lifecycleRepo.start(startCommand()).record;
    const lease = acquireLease(fx.lifecycleRepo, run.id);

    const stage = fx.lifecycleRepo.ensureStageRun(stageCommand(run.id), lease).record;
    const process = startProcessRun(fx.processRepo, stage);
    fx.lifecycleRepo.bindProcessRun(run.id, stage.id, process.id, lease);
    fx.lifecycleRepo.markStageRunning(run.id, stage.id, lease);
    completeProcessRun(fx.processRepo, process.id);

    const target = { type: 'stage', stageId: 'formalization' };
    const handoffSnapshot = { stages: { discovery: { value: 1 } } };
    const handoffHash = sha256Hex(handoffSnapshot);
    const decisionHash = sha256Hex({
      lifecycleRunId: run.id,
      stageRunId: stage.id,
      outcome: 'done',
      target,
      handoffHash,
    });
    const resultSnapshot = buildExpectedResultSnapshot();

    // The next-stage command has a deliberately mismatched inputHash, which
    // fails verifyStageCommand inside completeStage — BEFORE the transaction
    // writes anything. The completion UPDATE for stage 1 must NOT persist.
    const badNextStage = {
      stageId: 'formalization',
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      bindingSnapshot: canonicalJson({ stageId: 'formalization' }),
      bindingHash: sha256Hex({ stageId: 'formalization' }),
      inputSchema: 'saga3.formalization-case.v1',
      inputPayload: { from: 'discovery' },
      inputHash: sha256Hex({ from: 'NOT-the-payload' }), // mismatched hash
    };

    assert.throws(
      () =>
        fx.lifecycleRepo.completeStage({
          lifecycleRunId: run.id,
          stageRunId: stage.id,
          expectedStageId: 'discovery',
          transitionKey: `lifecycle:${run.id}:stage:${stage.id}`,
          outcome: 'done',
          authority: resultSnapshot.authority,
          output: resultSnapshot.output,
          certificate: resultSnapshot.certificate,
          resultSnapshot,
          mappedOutput: { decision: 'done' },
          target,
          handoffSnapshot,
          handoffHash,
          decisionHash,
          nextStage: badNextStage,
        }, lease),
      /LIFECYCLE_STAGE_INPUT_HASH_MISMATCH/,
    );

    // Rollback assertion: the stage is NOT completed, no transition row, no
    // second StageRun.
    const stages = fx.lifecycleRepo.listStageRuns(run.id);
    assert.equal(stages.length, 1, 'no next-stage row should exist after rollback');
    assert.notEqual(stages[0].status, 'completed', 'stage 1 completion must be rolled back');
    assert.equal(
      fx.db.prepare(
        'SELECT COUNT(*) AS n FROM saga3_process_transitions WHERE lifecycle_run_id=?',
      ).get(run.id).n,
      0,
      'no transition row should exist after rollback',
    );
  } finally {
    cleanupLifecycleFixture(fx);
  }
});

// ---------------------------------------------------------------------------
// Helpers — durable tmpdir SQLite fixture for the persistence-backed tests.
// ---------------------------------------------------------------------------

function lifecycleFixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-w0a4-lifecycle-'));
  process.env.DB_PATH = path.join(temp, 'lifecycle.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E1')`).run();
  return {
    temp,
    db,
    lifecycleRepo: new SqliteLifecycleRunRepository(db),
    processRepo: new SqliteProcessRunRepository(db),
  };
}

function cleanupLifecycleFixture(fx) {
  closeDb();
  rmSync(fx.temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function startCommand({
  idempotencyKey = 'w0a4-run-1',
  payload = { value: 'mapped-value' },
} = {}) {
  const definition = {
    name: 'w0a4-lifecycle',
    version: '1.0.0',
    entryStage: 'discovery',
    stages: ['discovery', 'formalization'],
  };
  return {
    lifecycle: {
      name: 'w0a4-lifecycle',
      version: '1.0.0',
      displayName: 'W0-A4',
      description: 'Characterization lifecycle.',
    },
    definitionSnapshot: canonicalJson(definition),
    definitionHash: sha256Hex(definition),
    entryStageId: 'discovery',
    input: {
      schema: 'w0a4.lifecycle-input.v1',
      payload,
      contentHash: sha256Hex(payload),
    },
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'w0a4-test',
      idempotencyKey,
    },
  };
}

function stageCommand(lifecycleRunId, {
  stageId = 'discovery',
  moduleName = 'w0a4-mod',
  moduleVersion = '1.0.0',
  payload = { value: 'mapped-value' },
} = {}) {
  const binding = {
    stageId,
    module: `${moduleName}@${moduleVersion}`,
    inputMapping: { value: '$.value' },
  };
  return {
    lifecycleRunId,
    stageId,
    moduleRef: { name: moduleName, version: moduleVersion },
    bindingSnapshot: canonicalJson(binding),
    bindingHash: sha256Hex(binding),
    inputSchema: `w0a4.${stageId}-input.v1`,
    inputPayload: payload,
    inputHash: sha256Hex(payload),
  };
}

function acquireLease(repo, lifecycleRunId, owner = 'w0a4-driver-a') {
  const lease = repo.acquireExecutionLease(
    lifecycleRunId,
    owner,
    '2026-07-26T00:00:00.000Z',
    '2099-01-01T00:00:00.000Z',
  );
  assert.ok(lease, 'lease acquisition must succeed');
  return lease;
}

function startProcessRun(processRepo, stage, {
  idempotencyKey = `stage-${stage.stageId}`,
  payload = stage.inputPayload ?? JSON.parse(stage.inputSnapshot),
} = {}) {
  return processRepo.start({
    moduleRef: stage.moduleRef,
    executorKind: 'generic-flow',
    projectedStage: null,
    input: {
      schema: stage.inputSchema,
      payload,
      contentHash: sha256Hex(payload),
    },
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'lifecycle',
      idempotencyKey,
    },
  }).record;
}

function completeProcessRun(processRepo, processRunId) {
  processRepo.update(processRunId, { status: 'running' });
  processRepo.update(processRunId, {
    status: 'completed',
    localOutcome: 'done',
    authority: 'w0a4-test-policy',
  });
}

function buildExpectedResultSnapshot() {
  return {
    code: 'done',
    outcome: 'done',
    authority: 'w0a4-test-policy',
    output: null,
    certificate: null,
    outputRef: null,
    outputHash: null,
    outputSchema: null,
    certificateRef: null,
    certificateHash: null,
    certificateSchema: null,
  };
}

// ---------------------------------------------------------------------------
// Mock helpers for the orchestrator-level tests (non-sqlite).
// ---------------------------------------------------------------------------

function makeLifecycleRunRecord(definition, status = 'created') {
  return {
    id: 1,
    lifecycle: definition.identity,
    lifecycleRefKey: `${definition.identity.name}@${definition.identity.version}`,
    definitionSnapshot: canonicalJson(definition),
    definitionHash: sha256Hex(definition),
    projectId: 7,
    epicId: 8,
    initiatedBy: 'w0a4-test',
    idempotencyKey: 'w0a4-run',
    inputSchema: 'w0a4.lifecycle-input.v1',
    inputSnapshot: canonicalJson({ root: 'input' }),
    inputHash: sha256Hex({ root: 'input' }),
    status,
    entryStageId: definition.entryStageId,
    currentStageId: status === 'created' ? null : definition.entryStageId,
    currentStageRunId: status === 'created' ? null : 11,
    terminalStatus: null,
    version: 0,
    leaseFence: 0,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeStageRecord(definition, inputPayload, processRunId = 42, status = 'created') {
  const binding = definition.stages[0];
  return {
    id: 11,
    lifecycleRunId: 1,
    ordinal: 1,
    stageId: binding.id,
    attempt: 1,
    moduleRef: binding.moduleRef,
    bindingSnapshot: canonicalJson(binding),
    bindingHash: sha256Hex(binding),
    inputSchema: testModule.inputContract.id,
    inputSnapshot: canonicalJson(inputPayload),
    inputHash: sha256Hex(inputPayload),
    status,
    processRunId,
    localOutcome: status === 'completed' ? 'done' : null,
    authority: status === 'completed' ? 'w0a4-test-policy' : null,
    output: null,
    certificate: null,
    mappedOutput: null,
    resultSnapshot: null,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function completedProcess(id = 42) {
  return {
    id,
    status: 'completed',
    localOutcome: 'done',
    authority: 'w0a4-test-policy',
    outputSchema: null,
    outputRef: null,
    outputHash: null,
    certificateSchema: null,
    certificateRef: null,
    certificateHash: null,
    error: null,
  };
}

function mockLifecycleRunRepo(state) {
  return {
    start: () => ({ record: state.lifecycle, replayed: state.lifecycle.status !== 'created' }),
    read: () => state.lifecycle,
    readByIdempotencyKey: () => state.lifecycle,
    listStageRuns: () => (state.stage ? [state.stage] : []),
    readCurrentStageRun: () => state.stage,
    ensureStageRun: ({ inputPayload }) => {
      if (state.stage === null) {
        state.stage = makeStageRecord(
          { entryStageId: 'stage-one', stages: [{ id: 'stage-one', moduleRef }] },
          inputPayload,
          null,
        );
        state.lifecycle.currentStageRunId = state.stage.id;
      }
      return { record: state.stage, replayed: state.stage.processRunId !== null };
    },
    bindProcessRun: (_lrid, _srid, processRunId) => {
      state.stage.processRunId = processRunId;
      return state.stage;
    },
    markStageRunning: () => {
      state.stage.status = 'running';
      state.lifecycle.status = 'running';
      return state.stage;
    },
    pauseStage: () => state.lifecycle,
    fail: (_lrid, _srid, error) => {
      state.lifecycle.status = 'failed';
      state.lifecycle.error = error;
      return state.lifecycle;
    },
    resume: () => state.lifecycle,
    cancel: () => state.lifecycle,
    listRecoverable: () => [],
    completeStage: (command) => {
      state.stage.status = 'completed';
      state.stage.localOutcome = command.outcome;
      state.stage.mappedOutput = command.mappedOutput;
      state.stage.resultSnapshot = command.resultSnapshot;
      state.stage.processRunId = state.stage.processRunId ?? 42;
      state.lifecycle.status = 'completed';
      state.lifecycle.currentStageId = null;
      state.lifecycle.currentStageRunId = null;
      state.lifecycle.terminalStatus = command.target.status;
      return {
        lifecycleRun: state.lifecycle,
        stageRun: state.stage,
        transition: {
          id: 1,
          lifecycleRunId: 1,
          fromStageRunId: state.stage.id,
          transitionKey: command.transitionKey,
          outcome: command.outcome,
          target: command.target,
          toStageRunId: null,
        },
        replayed: false,
      };
    },
    acquireExecutionLease: (_id, owner) => {
      state.lifecycle.status = 'running';
      return { owner, fence: 1 };
    },
    renewExecutionLease: () => true,
    releaseExecutionLease: () => {},
  };
}
