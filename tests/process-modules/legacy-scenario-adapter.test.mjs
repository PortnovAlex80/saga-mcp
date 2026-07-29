// W7-A8 tests: Legacy Product Delivery scenario adapter (compatibility bridge).
//
// Verifies the adapter:
//   - Wraps the legacy `productDeliveryLifecycle` definition into one
//     `LifecycleScenarioManifest` per Discovery gate mode (permissive + strict).
//   - Produces manifests that PASS `validateLifecycleScenarioManifest` (the
//     Wave 1 serial + structural gate).
//   - Carries NO `routeResolver` key anywhere (plan §6.4 — the manifest is
//     structurally incapable of executable routing).
//   - Round-trips through canonical JSON byte-identically (the manifest is
//     plain data; the legacy definition's non-enumerable routeResolver does
//     not leak in).
//   - Faithfully encodes the legacy lifecycle's observable routing behavior in
//     BOTH gate modes — every stage outcome route in the manifest matches the
//     legacy definition's static `outcomeRoutes`, except the Discovery stage
//     under the strict gate (where non-go outcomes terminate, exactly as the
//     legacy resolver prescribes).
//   - Declares the complete terminal-status set and every required module
//     selector derived from the legacy definition.
//
// These are compatibility tests: they prove a legacy Product Delivery run,
// executed through the new Wave 7 scenario runtime against the adapter's
// manifest, would route identically to a run against the legacy definition.
//
// Run: `node --test tests/process-modules/legacy-scenario-adapter.test.mjs`
// (after `npm run build`).

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Hex } from '../../dist/saga3/shared/discovery-canonical.js';
import { validateLifecycleScenarioManifest } from
  '../../dist/process-modules/domain/spi/scenario-manifest.js';
import { productDeliveryLifecycle } from
  '../../dist/process-modules/lifecycles/product-delivery-lifecycle.js';
import {
  LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  LEGACY_PRODUCT_DELIVERY_SCENARIOS,
  LEGACY_PRODUCT_DELIVERY_MANIFEST_FORMAT_VERSION,
  LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY,
  LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY,
  legacyProductDeliveryScenarioFor,
  validateLegacyProductDeliveryScenario,
} from '../../dist/process-modules/application/legacy-scenario-adapter.js';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Index the legacy lifecycle's stages by id for easy lookup. */
function legacyStageIndex() {
  const index = new Map();
  for (const stage of productDeliveryLifecycle.stages) {
    index.set(stage.id, stage);
  }
  return index;
}

/** Discovery stage id (the only stage whose routes differ by gate mode). */
const DISCOVERY_STAGE_ID = 'initial-discovery';

/**
 * Terminal statuses reachable from any stage in the legacy definition's
 * static outcomeRoutes (i.e. the permissive-mode reachable set; the strict
 * mode ADDS the discovery-gate terminals, which are a subset).
 */
function legacyPermissiveTerminals() {
  const set = new Set();
  for (const stage of productDeliveryLifecycle.stages) {
    for (const target of Object.values(stage.outcomeRoutes)) {
      if (target.type === 'terminal') set.add(target.status);
    }
  }
  return set;
}

/** Strict-gate discovery terminal statuses (mirrors the legacy resolver). */
const STRICT_DISCOVERY_TERMINALS = {
  clarify: 'clarification-required',
  reject: 'rejected',
  defer: 'deferred',
  inconclusive: 'inconclusive',
  failed: 'failed',
};

// ---------------------------------------------------------------------------
// Section 1: both manifests pass the Wave 1 manifest validator.
// ---------------------------------------------------------------------------

test('W7-A8: permissive legacy manifest passes validateLifecycleScenarioManifest', () => {
  const result = validateLifecycleScenarioManifest(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE);
  assert.equal(
    result.ok,
    true,
    `permissive manifest invalid: ${JSON.stringify(result.errors)}`,
  );
});

test('W7-A8: strict legacy manifest passes validateLifecycleScenarioManifest', () => {
  const result = validateLifecycleScenarioManifest(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT);
  assert.equal(
    result.ok,
    true,
    `strict manifest invalid: ${JSON.stringify(result.errors)}`,
  );
});

test('W7-A8: validateLegacyProductDeliveryScenario returns ok for both manifests', () => {
  const p = validateLegacyProductDeliveryScenario(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE);
  const s = validateLegacyProductDeliveryScenario(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT);
  assert.equal(p.ok, true, `permissive: ${JSON.stringify(p.errors)}`);
  assert.equal(s.ok, true, `strict: ${JSON.stringify(s.errors)}`);
});

// ---------------------------------------------------------------------------
// Section 2: structural absence of routeResolver (plan §6.4).
// ---------------------------------------------------------------------------

test('W7-A8: permissive manifest has no routeResolver own key (§6.4)', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE, 'routeResolver'),
    false,
  );
});

test('W7-A8: strict manifest has no routeResolver own key (§6.4)', () => {
  assert.equal(
    Object.prototype.hasOwnProperty.call(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT, 'routeResolver'),
    false,
  );
});

test('W7-A8: neither manifest surfaces routeResolver via JSON serialization', () => {
  // The legacy definition hides its resolver via Object.defineProperty
  // (enumerable: false); the manifest must not even need that dodge — the key
  // is simply absent.
  const permissiveJson = canonicalJson(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE);
  const strictJson = canonicalJson(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT);
  assert.ok(!permissiveJson.includes('routeResolver'), 'routeResolver leaked into permissive JSON');
  assert.ok(!strictJson.includes('routeResolver'), 'routeResolver leaked into strict JSON');
});

// ---------------------------------------------------------------------------
// Section 3: canonical round-trip (manifest is plain data).
// ---------------------------------------------------------------------------

test('W7-A8: permissive manifest round-trips through canonical JSON byte-identically', () => {
  const json = canonicalJson(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE);
  const reparsed = JSON.parse(json);
  assert.deepEqual(reparsed, JSON.parse(json), 'round-trip is not stable');
  // Re-validate after round-trip.
  const result = validateLifecycleScenarioManifest(reparsed);
  assert.equal(result.ok, true, `round-tripped permissive manifest invalid: ${JSON.stringify(result.errors)}`);
});

test('W7-A8: strict manifest round-trips through canonical JSON byte-identically', () => {
  const json = canonicalJson(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT);
  const reparsed = JSON.parse(json);
  assert.deepEqual(reparsed, JSON.parse(json), 'round-trip is not stable');
  const result = validateLifecycleScenarioManifest(reparsed);
  assert.equal(result.ok, true, `round-tripped strict manifest invalid: ${JSON.stringify(result.errors)}`);
});

test('W7-A8: manifest hash is stable across calls (permissive)', () => {
  const h1 = sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE);
  const h2 = sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test('W7-A8: permissive and strict manifests hash to DIFFERENT digests', () => {
  // The two manifests differ only in the Discovery stage's outcomeRoutes and
  // the identity block; that MUST produce distinct content hashes.
  const hp = sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE);
  const hs = sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT);
  assert.notEqual(hp, hs, 'permissive and strict manifests must differ');
});

// ---------------------------------------------------------------------------
// Section 4: faithful routing compatibility — permissive mode.
//
// Under the permissive gate, the manifest's stage outcomeRoutes MUST match
// the legacy definition's static outcomeRoutes table verbatim. This is the
// core compatibility guarantee: every legacy route is preserved.
// ---------------------------------------------------------------------------

test('W7-A8: permissive manifest preserves every legacy stage outcome route', () => {
  const legacyIndex = legacyStageIndex();
  for (const manifestStage of LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.stageBindings) {
    const legacyStage = legacyIndex.get(manifestStage.id);
    assert.ok(legacyStage, `manifest stage ${manifestStage.id} not in legacy definition`);
    assert.deepEqual(
      manifestStage.outcomeRoutes,
      legacyStage.outcomeRoutes,
      `stage ${manifestStage.id} outcomeRoutes differ from legacy`,
    );
  }
});

test('W7-A8: permissive manifest preserves every legacy stage input/output mapping', () => {
  const legacyIndex = legacyStageIndex();
  for (const manifestStage of LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.stageBindings) {
    const legacyStage = legacyIndex.get(manifestStage.id);
    assert.deepEqual(
      manifestStage.inputMapping,
      legacyStage.inputMapping,
      `stage ${manifestStage.id} inputMapping differ from legacy`,
    );
    assert.deepEqual(
      manifestStage.outputMapping,
      legacyStage.outputMapping,
      `stage ${manifestStage.id} outputMapping differ from legacy`,
    );
  }
});

test('W7-A8: permissive manifest entry stage matches legacy entry stage', () => {
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.entryStageId,
    productDeliveryLifecycle.entryStageId,
  );
});

test('W7-A8: permissive manifest declares every legacy terminal status', () => {
  const declared = new Set(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.terminalStatuses);
  for (const terminal of legacyPermissiveTerminals()) {
    assert.ok(
      declared.has(terminal),
      `permissive manifest missing terminal "${terminal}" reachable from a legacy stage`,
    );
  }
});

// ---------------------------------------------------------------------------
// Section 5: faithful routing compatibility — strict mode.
//
// Under the strict gate, every stage's outcomeRoutes match the legacy table
// EXCEPT the Discovery stage, where non-go outcomes terminate (exactly as the
// legacy `resolveProductDeliveryRoute` resolver prescribes in strict mode).
// ---------------------------------------------------------------------------

test('W7-A8: strict manifest matches legacy outcome routes on every non-Discovery stage', () => {
  const legacyIndex = legacyStageIndex();
  for (const manifestStage of LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT.stageBindings) {
    if (manifestStage.id === DISCOVERY_STAGE_ID) continue;
    const legacyStage = legacyIndex.get(manifestStage.id);
    assert.deepEqual(
      manifestStage.outcomeRoutes,
      legacyStage.outcomeRoutes,
      `strict-mode stage ${manifestStage.id} outcomeRoutes differ from legacy`,
    );
  }
});

test('W7-A8: strict manifest Discovery go outcome still forwards to Formalization', () => {
  const discovery = LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT.stageBindings.find(
    (s) => s.id === DISCOVERY_STAGE_ID,
  );
  assert.ok(discovery, 'Discovery stage missing from strict manifest');
  assert.deepEqual(discovery.outcomeRoutes.go, {
    type: 'stage',
    stageId: 'solution-formalization',
  });
});

test('W7-A8: strict manifest Discovery non-go outcomes terminate with the legacy gate statuses', () => {
  const discovery = LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT.stageBindings.find(
    (s) => s.id === DISCOVERY_STAGE_ID,
  );
  assert.ok(discovery, 'Discovery stage missing from strict manifest');
  for (const [outcome, expectedStatus] of Object.entries(STRICT_DISCOVERY_TERMINALS)) {
    assert.deepEqual(
      discovery.outcomeRoutes[outcome],
      { type: 'terminal', status: expectedStatus },
      `strict Discovery outcome "${outcome}" did not terminate at "${expectedStatus}"`,
    );
  }
});

test('W7-A8: strict manifest declares every strict-gate terminal status', () => {
  const declared = new Set(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT.terminalStatuses);
  for (const expectedStatus of Object.values(STRICT_DISCOVERY_TERMINALS)) {
    assert.ok(
      declared.has(expectedStatus),
      `strict manifest missing terminal "${expectedStatus}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// Section 6: module selector derivation.
//
// Every module selector the manifest declares MUST be derivable from the
// legacy definition's stage moduleRefs, and every stage's selector MUST match
// its moduleRef. The patch range (`~version`) permits only patch upgrades,
// preserving the legacy freeze guarantee.
// ---------------------------------------------------------------------------

test('W7-A8: every manifest stage carries a moduleSelector matching its moduleRef', () => {
  for (const manifest of [
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  ]) {
    const legacyIndex = legacyStageIndex();
    for (const stage of manifest.stageBindings) {
      const legacyStage = legacyIndex.get(stage.id);
      assert.ok(legacyStage, `stage ${stage.id} not in legacy`);
      assert.equal(stage.moduleSelector.name, legacyStage.moduleRef.name);
      assert.equal(
        stage.moduleSelector.versionRange,
        `~${legacyStage.moduleRef.version}`,
        `stage ${stage.id} selector range is not patch-pinned`,
      );
    }
  }
});

test('W7-A8: requiredModuleSelectors lists every distinct legacy module contract', () => {
  // The legacy definition uses 4 distinct modules (discovery, formalization,
  // development, delivery); the manifest must declare exactly those 4 (no
  // duplicates, no missing, no extra).
  const expectedNames = productDeliveryLifecycle.stages.map((s) => s.moduleRef.name);
  const declaredNames = LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.requiredModuleSelectors.map(
    (s) => s.name,
  );
  assert.deepEqual(declaredNames, expectedNames);
  // Strict manifest declares the same set.
  const declaredStrict = LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT.requiredModuleSelectors.map(
    (s) => s.name,
  );
  assert.deepEqual(declaredStrict, expectedNames);
});

test('W7-A8: requiredModuleSelectors are de-duplicated by name@versionRange', () => {
  // No two selectors in the list should share the same name@versionRange key.
  for (const manifest of [
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  ]) {
    const keys = manifest.requiredModuleSelectors.map((s) => `${s.name}@${s.versionRange}`);
    assert.equal(new Set(keys).size, keys.length, 'duplicate required module selectors');
  }
});

// ---------------------------------------------------------------------------
// Section 7: identity, contract refs, budgets, policies.
// ---------------------------------------------------------------------------

test('W7-A8: both manifests share the legacy identity name and base version', () => {
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY.name,
    'legacy-product-delivery',
  );
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY.name,
    'legacy-product-delivery',
  );
  // Versions are `<lifecycle-version>+permissive|strict`.
  const baseVersion = productDeliveryLifecycle.identity.version;
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY.version,
    `${baseVersion}+permissive`,
  );
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY.version,
    `${baseVersion}+strict`,
  );
});

test('W7-A8: both manifests differ only in identity + Discovery stage outcomeRoutes', () => {
  // Diff every field; record which top-level fields differ. The ONLY
  // legitimate differences are `identity` and the Discovery stage entry inside
  // `stageBindings`.
  const p = LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE;
  const s = LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT;

  // identity differs.
  assert.notDeepEqual(p.identity, s.identity);

  // manifestFormatVersion, contractRefs, entryStageId, outcomeRoutes,
  // inputMappings, outputMappings, terminalStatuses, scenarioPolicies,
  // requiredModuleSelectors, budgets all IDENTICAL.
  assert.equal(p.manifestFormatVersion, s.manifestFormatVersion);
  assert.deepEqual(p.inputContractRef, s.inputContractRef);
  assert.deepEqual(p.outputContractRef, s.outputContractRef);
  assert.equal(p.entryStageId, s.entryStageId);
  assert.deepEqual(p.outcomeRoutes, s.outcomeRoutes);
  assert.deepEqual(p.inputMappings, s.inputMappings);
  assert.deepEqual(p.outputMappings, s.outputMappings);
  assert.deepEqual(p.terminalStatuses, s.terminalStatuses);
  assert.deepEqual(p.scenarioPolicies, s.scenarioPolicies);
  assert.deepEqual(p.requiredModuleSelectors, s.requiredModuleSelectors);
  assert.deepEqual(p.transitionBudgets, s.transitionBudgets);
  assert.deepEqual(p.reentryBudgets, s.reentryBudgets);

  // stageBindings: same length, same stage ids, same field-for-field except
  // the Discovery stage's outcomeRoutes.
  assert.equal(p.stageBindings.length, s.stageBindings.length);
  for (let i = 0; i < p.stageBindings.length; i++) {
    const ps = p.stageBindings[i];
    const ss = s.stageBindings[i];
    assert.equal(ps.id, ss.id, `stage ${i} id differs`);
    if (ps.id === DISCOVERY_STAGE_ID) {
      assert.notDeepEqual(
        ps.outcomeRoutes,
        ss.outcomeRoutes,
        'Discovery outcomeRoutes should differ between modes',
      );
    } else {
      assert.deepEqual(
        ps.outcomeRoutes,
        ss.outcomeRoutes,
        `stage ${ps.id} outcomeRoutes should be identical across modes`,
      );
    }
    // Every other field on a non-Discovery stage is identical.
    assert.deepEqual(ps.moduleSelector, ss.moduleSelector);
    assert.deepEqual(ps.inputMapping, ss.inputMapping);
    assert.deepEqual(ps.outputMapping, ss.outputMapping);
  }
});

test('W7-A8: manifest envelope format version is 1', () => {
  assert.equal(LEGACY_PRODUCT_DELIVERY_MANIFEST_FORMAT_VERSION, '1');
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.manifestFormatVersion,
    '1',
  );
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT.manifestFormatVersion,
    '1',
  );
});

test('W7-A8: inputContractRef schemaId matches the legacy lifecycle input schema', () => {
  // The Wave 1 placeholder digest is documented and intended; the schemaId
  // still carries the real logical identity Wave 2/3 will bind a real digest
  // against.
  for (const manifest of [
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  ]) {
    assert.ok(manifest.inputContractRef.schemaId.startsWith('saga3.product-delivery-lifecycle-input'));
    assert.equal(manifest.inputContractRef.digest, 'pending@wave-2');
  }
});

test('W7-A8: transition budget is positive and finite', () => {
  for (const manifest of [
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  ]) {
    assert.ok(
      Number.isFinite(manifest.transitionBudgets.maxTransitions)
        && manifest.transitionBudgets.maxTransitions > 0,
    );
  }
});

test('W7-A8: reentry budget is zero (legacy lifecycle has no back-edges)', () => {
  for (const manifest of [
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  ]) {
    assert.equal(manifest.reentryBudgets.maxReentries, 0);
  }
});

// ---------------------------------------------------------------------------
// Section 8: adapter API (lookup + resolver function).
// ---------------------------------------------------------------------------

test('W7-A8: LEGACY_PRODUCT_DELIVERY_SCENARIOS maps both gate modes', () => {
  assert.deepEqual(
    LEGACY_PRODUCT_DELIVERY_SCENARIOS.permissive,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  );
  assert.deepEqual(
    LEGACY_PRODUCT_DELIVERY_SCENARIOS.strict,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  );
});

test('W7-A8: legacyProductDeliveryScenarioFor(undefined) returns permissive (legacy default)', () => {
  assert.deepEqual(
    legacyProductDeliveryScenarioFor(undefined),
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  );
});

test('W7-A8: legacyProductDeliveryScenarioFor(permissive) returns permissive', () => {
  assert.deepEqual(
    legacyProductDeliveryScenarioFor('permissive'),
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  );
});

test('W7-A8: legacyProductDeliveryScenarioFor(strict) returns strict', () => {
  assert.deepEqual(
    legacyProductDeliveryScenarioFor('strict'),
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  );
});

test('W7-A8: legacyProductDeliveryScenarioFor returns a frozen manifest constant', () => {
  // The resolver returns one of the two module-level constants by reference;
  // it never allocates. Same reference across calls.
  const a = legacyProductDeliveryScenarioFor('strict');
  const b = legacyProductDeliveryScenarioFor('strict');
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// Section 9: W13-A3 — the legacy lifecycle's routeResolver has been REMOVED.
//
// Wave 13 deleted the runtime routeResolver function field and the
// Object.defineProperty({enumerable:false}) dodge. The runtime
// productDeliveryLifecycle is now purely declarative (permissive: every
// Discovery outcome forwards to Formalization). The legacy strict go/no-go
// gate survives ONLY as the separate declarative manifest
// `LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT` produced by this adapter — it does
// NOT live on the runtime lifecycle definition anymore.
// ---------------------------------------------------------------------------

test('W13-A3: legacy productDeliveryLifecycle exposes NO routeResolver', () => {
  assert.equal(
    productDeliveryLifecycle.routeResolver,
    undefined,
    'runtime lifecycle must not carry a routeResolver after W13-A3',
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(productDeliveryLifecycle, 'routeResolver'),
    false,
  );
  const json = canonicalJson(productDeliveryLifecycle);
  assert.ok(!json.includes('routeResolver'), 'resolver key leaked into canonical JSON');
});

test('W7-A8 regression: legacy lifecycle still has 4 stages in canonical order', () => {
  const ids = productDeliveryLifecycle.stages.map((s) => s.id);
  assert.deepEqual(ids, [
    'initial-discovery',
    'solution-formalization',
    'solution-development',
    'delivery-release',
  ]);
});

// ---------------------------------------------------------------------------
// Section 10: negative — a hand-built malformed legacy manifest is rejected.
//
// Defense in depth: if someone manually constructs a manifest that smuggles a
// routeResolver key, the validator (and thus validateLegacyProductDeliveryScenario)
// must reject it. This proves the adapter's eager-load validation would catch
// a corrupted manifest.
// ---------------------------------------------------------------------------

test('W7-A8 negative: validateLegacyProductDeliveryScenario rejects a manifest smuggling routeResolver', () => {
  const corrupted = {
    ...LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
    routeResolver: () => ({ type: 'terminal', status: 'released' }),
  };
  const result = validateLegacyProductDeliveryScenario(corrupted);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'ROUTE_RESOLVER_FORBIDDEN'));
});
