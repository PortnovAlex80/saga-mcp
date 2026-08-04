// tests/spi/legacy-adapter.test.mjs
//
// W1-A7 — LegacyProcessModuleAdapter tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md §1 row 15.
// Task: docs/refactor-management/05-subagent-tasks/W01-A7-legacy-adapter.md.
//
// Proves:
//   - adaptLegacyProcessModule wraps each of the 4 production module
//     definitions (discovery/formalization/development/delivery, iterated via
//     createBuiltInProcessModuleRegistry().list()) into a manifest that PASSES
//     validateProcessModuleManifest and round-trips through canonical JSON.
//   - the W0-A7 synthetic lm-marketing fixture wraps, validates and round-trips.
//   - the wrapped manifest still REJECTS injected non-serializable values
//     (a function planted in a legacy extension field surfaces as a validation
//     failure / thrown error).
//   - the manifest envelope shape is uniform: manifestFormatVersion 'legacy-0'
//     is the sole legacy signal (no `legacy: true` boolean); resourceIndex and
//     handlerRefs are empty by design; ContractRefs carry the placeholder digest.
//
// Run: node --test tests/spi/legacy-adapter.test.mjs
//
// Imports use dynamic `await import()` from dist/ (the repo convention for
// tests of compiled TypeScript). `npm run build` must succeed first. In
// isolated Wave-1 lane work the build depends on sibling lane files
// (W1-A2 module-manifest, W1-A5 contract-ref) that may not have landed in this
// worktree yet; the test will fail at the relevant dynamic import until
// integration. This is the documented local-failure mode — the assertions
// themselves are correct and pass at W1-A8 integration.

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
const {
  adaptLegacyProcessModule,
  LEGACY_CONTRACT_DIGEST,
  LEGACY_CONTRACT_VERSION,
  LEGACY_MANIFEST_FORMAT_VERSION,
  LEGACY_RUNTIME_COMPATIBILITY_RANGE,
  LegacyManifestAdapterError,
} = await import(
  '../../dist/process-modules/domain/spi/manifest-adapter.js'
);
const { validateProcessModuleManifest } = await import(
  '../../dist/process-modules/domain/spi/module-manifest.js'
);
// Canonical helpers: the existing process-modules/shared re-export (not the
// W1-A1 domain/shared path), so this test does not take a W1-A1 dependency for
// round-trip assertions.
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

// W0-A7 synthetic lm-marketing fixture (already a ProcessModuleDefinition).
const { default: lmMarketingModule } = await import(
  '../fixtures/synthetic-modules/lm-marketing/definition.mjs'
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deep round-trip: parse(canonicalJson(manifest)) must deepEqual the manifest,
 * AND sha256Hex must be stable across two serializations (canonicalJson
 * determinism, plan §0.4.11 / §4).
 *
 * @param {unknown} manifest
 * @param {string} label
 */
function assertRoundTrip(manifest, label) {
  const json1 = canonicalJson(manifest);
  const json2 = canonicalJson(manifest);
  assert.equal(json1, json2, `${label}: canonicalJson is stable across runs`);
  const hash1 = sha256Hex(manifest);
  const hash2 = sha256Hex(manifest);
  assert.equal(hash1, hash2, `${label}: sha256Hex is stable across runs`);
  const parsed = JSON.parse(json1);
  assert.deepEqual(parsed, manifest, `${label}: parse(canonicalJson(m)) deepEquals m`);
}

/**
 * Assert the envelope shape produced by the legacy adapter matches the frozen
 * contract (§1 row 15): legacy format version, empty resource/handler arrays,
 * derived ContractRefs with the placeholder digest, the stamped runtime range,
 * and NO `legacy: true` boolean (uniform manifest shape).
 *
 * @param {any} manifest
 * @param {string} label
 */
function assertLegacyEnvelopeShape(manifest, label) {
  assert.equal(
    manifest.manifestFormatVersion,
    LEGACY_MANIFEST_FORMAT_VERSION,
    `${label}: manifestFormatVersion === 'legacy-0'`,
  );
  assert.ok(
    Array.isArray(manifest.resourceIndex) && manifest.resourceIndex.length === 0,
    `${label}: resourceIndex is an empty array (legacy gap, Waves 8/9 fill)`,
  );
  assert.ok(
    Array.isArray(manifest.handlerRefs) && manifest.handlerRefs.length === 0,
    `${label}: handlerRefs is an empty array (legacy binds at composition time)`,
  );
  assert.equal(
    manifest.runtimeCompatibilityRange,
    LEGACY_RUNTIME_COMPATIBILITY_RANGE,
    `${label}: runtimeCompatibilityRange === '>=2.0.0 <3.0.0'`,
  );
  // Uniform manifest shape: NO legacy boolean marker.
  assert.equal(
    'legacy' in manifest,
    false,
    `${label}: manifest must NOT carry a 'legacy' boolean (uniform shape, §1 row 15)`,
  );
  // ContractRefs derived from the definition's SchemaReferences.
  for (const refField of ['inputContractRef', 'outputContractRef']) {
    const ref = manifest[refField];
    assert.ok(ref && typeof ref === 'object', `${label}: ${refField} present`);
    assert.equal(
      ref.version,
      LEGACY_CONTRACT_VERSION,
      `${label}: ${refField}.version === 'legacy'`,
    );
    assert.equal(
      ref.digest,
      LEGACY_CONTRACT_DIGEST,
      `${label}: ${refField}.digest === 'pending@wave-2'`,
    );
    assert.equal(typeof ref.schemaId, 'string', `${label}: ${refField}.schemaId is a string`);
  }
}

// ---------------------------------------------------------------------------
// Positive: the 4 production module definitions wrap + validate + round-trip.
// ---------------------------------------------------------------------------

const registry = createBuiltInProcessModuleRegistry();
const builtInModules = registry.list();

test('the built-in registry exposes exactly the 4 production modules', () => {
  // Guard: this test is meaningless if the built-in module set changes
  // underneath us. Wave 13 replaced the catalog file with inline registration;
  // the 4 production modules remain the set the legacy adapter must cover.
  assert.equal(builtInModules.length, 4, 'exactly 4 built-in production modules');
  const names = builtInModules.map((/** @type {any} */ m) => m.identity.name).sort();
  assert.deepEqual(
    names,
    ['delivery-release', 'product-discovery', 'solution-development', 'solution-formalization'],
    'the 4 production module names',
  );
});

for (const mod of builtInModules) {
  const name = mod.identity.name;
  const version = mod.identity.version;

  test(`legacy adapter wraps production module '${name}@${version}' into a valid manifest`, () => {
    const manifest = adaptLegacyProcessModule(mod);
    // The adapter's own return already validated; re-validate independently to
    // prove the result passes the canonical validator.
    const validation = validateProcessModuleManifest(manifest);
    assert.ok(validation.ok, `validateProcessModuleManifest ok for ${name}: ${JSON.stringify(validation.errors)}`);
    assertLegacyEnvelopeShape(manifest, `${name}`);
    // The definition is embedded verbatim.
    assert.equal(manifest.definition, mod, `${name}: definition embedded by reference`);
    // ContractRef schemaIds mirror the definition's SchemaReference ids.
    assert.equal(manifest.inputContractRef.schemaId, mod.inputContract.id, `${name}: input schemaId derived`);
    assert.equal(manifest.outputContractRef.schemaId, mod.outputContract.id, `${name}: output schemaId derived`);
  });

  test(`legacy adapter: '${name}@${version}' manifest round-trips through canonical JSON`, () => {
    const manifest = adaptLegacyProcessModule(mod);
    assertRoundTrip(manifest, `${name}@${version}`);
  });
}

// ---------------------------------------------------------------------------
// Positive: the W0-A7 synthetic lm-marketing fixture wraps + validates +
// round-trips (proves the SPI is module-kind-agnostic per §6 exit gate 7).
// ---------------------------------------------------------------------------

test('legacy adapter wraps the W0-A7 synthetic lm-marketing fixture into a valid manifest', () => {
  const manifest = adaptLegacyProcessModule(lmMarketingModule);
  const validation = validateProcessModuleManifest(manifest);
  assert.ok(
    validation.ok,
    `validateProcessModuleManifest ok for lm-marketing: ${JSON.stringify(validation.errors)}`,
  );
  assertLegacyEnvelopeShape(manifest, 'lm-marketing');
  assert.equal(
    manifest.inputContractRef.schemaId,
    'synthetic.marketing.input.v1',
    'lm-marketing: input schemaId derived',
  );
  assert.equal(
    manifest.outputContractRef.schemaId,
    'synthetic.marketing.output.v1',
    'lm-marketing: output schemaId derived',
  );
});

test('legacy adapter: lm-marketing manifest round-trips through canonical JSON', () => {
  const manifest = adaptLegacyProcessModule(lmMarketingModule);
  assertRoundTrip(manifest, 'lm-marketing');
});

// ---------------------------------------------------------------------------
// Negative: the wrapped manifest must still REJECT injected non-serializable
// values (plan §3.5 / §3 negative test contract).
// ---------------------------------------------------------------------------

test('legacy adapter REJECTS a function planted in a legacy extension field', () => {
  // Clone the lm-marketing definition and inject a function into an extension
  // field. validateProcessModuleManifest must reject it (functions are not
  // canonical-serializable), surfacing as a thrown LegacyManifestAdapterError.
  /** @type {any} */
  const poisoned = JSON.parse(JSON.stringify(lmMarketingModule));
  poisoned.extension = { callback: () => 'not serializable' };
  assert.throws(
    () => adaptLegacyProcessModule(poisoned),
    (err) => {
      assert.ok(err instanceof LegacyManifestAdapterError, 'throws LegacyManifestAdapterError');
      assert.equal(err.name, 'LegacyManifestAdapterError');
      assert.ok(err.validationErrors.length > 0, 'carries structured validation errors');
      return true;
    },
    'adaptLegacyProcessModule must throw on a function value',
  );
});

test('legacy adapter REJECTS a Map planted in a legacy extension field', () => {
  /** @type {any} */
  const poisoned = JSON.parse(JSON.stringify(lmMarketingModule));
  poisoned.extension = { table: new Map([['k', 1]]) };
  assert.throws(
    () => adaptLegacyProcessModule(poisoned),
    (err) => err instanceof LegacyManifestAdapterError,
    'adaptLegacyProcessModule must throw on a Map value',
  );
});

test('legacy adapter REJECTS undefined inside an array field', () => {
  /** @type {any} */
  const poisoned = JSON.parse(JSON.stringify(lmMarketingModule));
  // Push undefined into an existing array field (outcomes) so it travels inside
  // an array — the §3 negative contract specifically targets undefined-in-array
  // (object-key undefined is dropped by canonicalJson intentionally).
  poisoned.outcomes = [poisoned.outcomes[0], undefined];
  assert.throws(
    () => adaptLegacyProcessModule(poisoned),
    (err) => err instanceof LegacyManifestAdapterError,
    'adaptLegacyProcessModule must throw on undefined inside an array',
  );
});

test('legacy adapter REJECTS a Symbol planted in a legacy field', () => {
  // Symbols cannot survive JSON round-trip; clone with structuredClone then
  // assign directly so the Symbol actually reaches the validator.
  /** @type {any} */
  const direct = structuredClone(lmMarketingModule);
  direct.identity.kind = Symbol('not serializable');
  assert.throws(
    () => adaptLegacyProcessModule(direct),
    (err) => err instanceof LegacyManifestAdapterError,
    'adaptLegacyProcessModule must throw on a Symbol value',
  );
});

test('legacy adapter REJECTS a non-finite number (NaN) in a legacy field', () => {
  /** @type {any} */
  const direct = structuredClone(lmMarketingModule);
  direct.identity.version = NaN; // not a finite number
  assert.throws(
    () => adaptLegacyProcessModule(direct),
    (err) => err instanceof LegacyManifestAdapterError,
    'adaptLegacyProcessModule must throw on a non-finite number',
  );
});

// ---------------------------------------------------------------------------
// Contract: exported constants match the frozen spec.
// ---------------------------------------------------------------------------

test('exported constants match the frozen SPI spec (§1 row 15)', () => {
  assert.equal(LEGACY_MANIFEST_FORMAT_VERSION, 'legacy-0');
  assert.equal(LEGACY_RUNTIME_COMPATIBILITY_RANGE, '>=2.0.0 <3.0.0');
  assert.equal(LEGACY_CONTRACT_VERSION, 'legacy');
  assert.equal(LEGACY_CONTRACT_DIGEST, 'pending@wave-2');
});

// ---------------------------------------------------------------------------
// Contract: the manifestFormatVersion option override is honored.
// ---------------------------------------------------------------------------

test('adaptLegacyProcessModule honors opts.manifestFormatVersion override', () => {
  const manifest = adaptLegacyProcessModule(lmMarketingModule, {
    manifestFormatVersion: 'migrating-1',
  });
  assert.equal(manifest.manifestFormatVersion, 'migrating-1');
  // Override still produces a valid manifest.
  const validation = validateProcessModuleManifest(manifest);
  assert.ok(validation.ok, `validateProcessModuleManifest ok with override: ${JSON.stringify(validation.errors)}`);
});
