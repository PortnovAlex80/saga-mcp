// tests/installation/product-delivery-scenario-package.test.mjs
//
// W11-A1 — Installed Product Delivery Lifecycle Scenario package tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md
//       §2 Lane W11-A1. Plan: §0.14 / Phase 13 preparation (§0.14.11 serial gate).
// Task: docs/refactor-management/05-subagent-tasks/W11-a1.md.
//
// Coverage:
//   - The package exposes the production (permissive) Product Delivery manifest
//     re-exported from the W7-A8 legacy scenario adapter, plus the strict
//     variant, the four-module dependency closure, and the manifest-format
//     version.
//   - The four production module selectors are exactly discovery,
//     formalization, development, delivery (the legacy stage moduleRefs), each
//     carrying a patch-only `~<version>` range (W7-A8 freeze guarantee).
//   - installProductDeliveryScenario drives the Wave 7 ScenarioInstaller:
//     compile → resolve lock (4 entries, one per stage) → bind installations →
//     persist lock → return InstalledScenario with manifest hash + lock digest.
//     Asserts the lock is written exactly once and covers every stage.
//   - Discovery-gate selection: permissive (default) and strict resolve to the
//     two distinct W7-A8 manifests (distinct identity versions).
//   - The package surfaces the injected-port failure modes verbatim:
//     SCENARIO_INSTALL_NOT_INSTALLED when a production module is not registered.
//   - Purity / data surface: the manifest and the selectors are plain
//     JSON-serializable data (no routeResolver, no functions).
//
// Run: `node --test tests/installation/product-delivery-scenario-package.test.mjs`
// (after `npm run build`). Tests run against COMPILED dist/ output.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  PRODUCT_DELIVERY_SCENARIO_MANIFEST,
  PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT,
  PRODUCT_DELIVERY_SCENARIO_MANIFESTS,
  PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS,
  PRODUCT_DELIVERY_SCENARIO_MANIFEST_FORMAT_VERSION,
  productDeliveryScenarioManifestFor,
  installProductDeliveryScenario,
  installProductDeliveryScenarioPermissive,
  installProductDeliveryScenarioStrict,
} = await import(
  '../../dist/process-modules/installation/product-delivery-scenario-package.js'
);
const { ScenarioInstallerError, SCENARIO_INSTALL_NOT_INSTALLED } = await import(
  '../../dist/process-modules/application/scenario-runner.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

// ---------------------------------------------------------------------------
// Assertions about the production manifest surface.
// ---------------------------------------------------------------------------

// The four production module CONTRACT names the legacy lifecycle binds to
// (the stage `moduleRef.name` fields). These differ from the short stage
// labels: discovery → 'product-discovery', formalization → 'solution-
// formalization', development → 'solution-development', delivery → 'delivery-
// release'. Derived from the manifest so the test tracks any future rename.
const PRODUCTION_MODULE_NAMES = PRODUCT_DELIVERY_SCENARIO_MANIFEST.stageBindings.map(
  (s) => s.moduleRef.name,
);

test('W11-A1: package exposes the permissive Product Delivery manifest as the production default', () => {
  assert.ok(PRODUCT_DELIVERY_SCENARIO_MANIFEST, 'production manifest must be exported');
  // Identity is the legacy Product Delivery lifecycle (permissive gate).
  assert.equal(PRODUCT_DELIVERY_SCENARIO_MANIFEST.identity.name, 'legacy-product-delivery');
  assert.ok(
    PRODUCT_DELIVERY_SCENARIO_MANIFEST.identity.version.endsWith('+permissive'),
    `permissive manifest version should end with +permissive, got ${
      PRODUCT_DELIVERY_SCENARIO_MANIFEST.identity.version
    }`,
  );
  // Entry stage is the legacy discovery stage.
  assert.equal(PRODUCT_DELIVERY_SCENARIO_MANIFEST.entryStageId, 'initial-discovery');
});

test('W11-A1: package exposes the strict variant and a keyed map of both gate modes', () => {
  assert.ok(
    PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT.identity.version.endsWith('+strict'),
    'strict manifest version should end with +strict',
  );
  // Both gate modes are present in the keyed map.
  assert.equal(PRODUCT_DELIVERY_SCENARIO_MANIFESTS.permissive, PRODUCT_DELIVERY_SCENARIO_MANIFEST);
  assert.equal(PRODUCT_DELIVERY_SCENARIO_MANIFESTS.strict, PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT);
  // productDeliveryScenarioManifestFor resolves both gate modes (default = permissive).
  assert.equal(productDeliveryScenarioManifestFor(undefined), PRODUCT_DELIVERY_SCENARIO_MANIFEST);
  assert.equal(productDeliveryScenarioManifestFor('permissive'), PRODUCT_DELIVERY_SCENARIO_MANIFEST);
  assert.equal(
    productDeliveryScenarioManifestFor('strict'),
    PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT,
  );
});

test('W11-A1: required module selectors are the four production modules with patch-only ranges', () => {
  assert.equal(
    PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS.length,
    4,
    'Product Delivery depends on exactly four production modules',
  );
  const names = PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS.map((s) => s.name);
  assert.deepEqual(names, PRODUCTION_MODULE_NAMES, 'stage-declaration order: discovery→formalization→development→delivery');
  // Every selector carries a patch-only `~<version>` range (W7-A8 freeze guarantee).
  for (const selector of PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS) {
    assert.ok(
      selector.versionRange.startsWith('~'),
      `selector ${selector.name} range must be patch-only (~), got ${selector.versionRange}`,
    );
    assert.ok(typeof selector.name === 'string' && selector.name.length > 0);
  }
  // The closure matches the manifest's own requiredModuleSelectors (no drift).
  assert.equal(
    PRODUCT_DELIVERY_REQUIRED_MODULE_SELECTORS,
    PRODUCT_DELIVERY_SCENARIO_MANIFEST.requiredModuleSelectors,
    'package closure must be the manifest closure (same reference, no copy drift)',
  );
});

test('W11-A1: manifest surface is plain JSON-serializable data with NO routeResolver', () => {
  // Re-exported format version is the W7-A8 envelope version.
  assert.equal(typeof PRODUCT_DELIVERY_SCENARIO_MANIFEST_FORMAT_VERSION, 'string');
  assert.ok(PRODUCT_DELIVERY_SCENARIO_MANIFEST_FORMAT_VERSION.length > 0);
  // The manifest round-trips through canonical JSON (W7-A8 guarantees this;
  // re-assert here so a future re-export change cannot break serializability).
  const roundTripped = JSON.parse(canonicalJson(PRODUCT_DELIVERY_SCENARIO_MANIFEST));
  assert.equal(roundTripped.identity.name, PRODUCT_DELIVERY_SCENARIO_MANIFEST.identity.name);
  // §6.4 proof: no executable route resolver on the manifest.
  assert.equal(
    Object.prototype.hasOwnProperty.call(PRODUCT_DELIVERY_SCENARIO_MANIFEST, 'routeResolver'),
    false,
    'manifest must NOT carry a routeResolver (spec §6.4)',
  );
});

// ---------------------------------------------------------------------------
// Fake ScenarioInstaller deps (mirrors tests/process-modules/scenario-runner.test.mjs).
// ---------------------------------------------------------------------------

/**
 * Build a fake ProcessModuleInstallationRegistry that resolves every production
 * module selector to a stub ProcessModuleInstallation. The installer only needs
 * `require(ref)` to return a `{ definition, executor }`-shaped binding.
 */
function fakeInstallationRegistry({ installed = true } = {}) {
  return {
    require(ref) {
      if (!installed) {
        throw new Error(`process module ${ref.name}@${ref.version} is not installed`);
      }
      return {
        definition: {
          identity: { ...ref, kind: ref.name, displayName: ref.name, description: 'stub' },
          inputContract: { id: `${ref.name}.input` },
          outputContract: { id: `${ref.name}.output` },
          outcomes: [{ code: 'go', description: 'go', terminal: false }],
          flow: { id: `${ref.name}.flow`, version: ref.version, entryNodeId: 'n', nodes: [], transitions: [], terminalNodeIds: [] },
          artifacts: [],
          policies: [],
          invariants: [],
          executionProfiles: [],
        },
        executor: null,
      };
    },
  };
}

function fakeCompiler({ ok = true, errors = [] } = {}) {
  return () => ({ ok, errors });
}

/**
 * Build a lock from a manifest: one ScenarioModuleLockEntry per stage binding,
 * each pinning the stage's selector to a stub installed module identity. This
 * mirrors what the W7-A2 lockResolver would produce against a real package
 * registry.
 */
function buildLock(manifest, { installationIdBase = 100 } = {}) {
  const entries = manifest.stageBindings.map((s, i) => ({
    stageId: s.id,
    selector: s.moduleSelector,
    installedModuleRef: { name: s.moduleSelector.name, version: s.moduleSelector.versionRange.slice(1) },
    installationId: installationIdBase + i,
    packageDigest: sha256Hex({ stage: s.id, stamp: 'w11-a1' }),
  }));
  return {
    scenarioIdentity: manifest.identity,
    entries,
    lockDigest: sha256Hex(canonicalJson(entries)),
  };
}

function fakeLockResolver(lock) {
  return () => Promise.resolve(lock);
}

function fakeLockStore() {
  const written = [];
  return {
    write: async (l) => {
      written.push(l);
      return l;
    },
    read: async () => null,
    _written: written,
  };
}

function okDeps(manifest, overrides = {}) {
  const lockStore = overrides.lockStore ?? fakeLockStore();
  return {
    deps: {
      compiler: overrides.compiler ?? fakeCompiler(),
      lockResolver: overrides.lockResolver ?? fakeLockResolver(buildLock(manifest)),
      lockStore,
      installationRegistry: overrides.installationRegistry ?? fakeInstallationRegistry(),
    },
    lockStore,
  };
}

// ---------------------------------------------------------------------------
// installProductDeliveryScenario tests.
// ---------------------------------------------------------------------------

test('W11-A1: installProductDeliveryScenario installs the permissive scenario and pins all four stages', async () => {
  const { deps, lockStore } = okDeps(PRODUCT_DELIVERY_SCENARIO_MANIFEST);
  const installed = await installProductDeliveryScenario(deps);

  // InstalledScenario carries the manifest snapshot + content-addressed hash.
  assert.equal(installed.manifest, PRODUCT_DELIVERY_SCENARIO_MANIFEST);
  assert.equal(installed.manifestHash, sha256Hex(PRODUCT_DELIVERY_SCENARIO_MANIFEST));
  assert.equal(installed.manifestSnapshot, canonicalJson(PRODUCT_DELIVERY_SCENARIO_MANIFEST));

  // The lock covers every Product Delivery stage (4 stages → 4 pins).
  const stageIds = PRODUCT_DELIVERY_SCENARIO_MANIFEST.stageBindings.map((s) => s.id);
  assert.equal(installed.lock.entries.length, stageIds.length, 'one lock entry per stage');
  assert.deepEqual(
    installed.lock.entries.map((e) => e.stageId),
    stageIds,
  );
  // Every stage is bound to a ProcessModuleInstallation (no re-resolution at run time).
  for (const stageId of stageIds) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(installed.installationsByStageId, stageId),
      `stage ${stageId} must be bound to an installation`,
    );
  }

  // The lock was persisted exactly once through the injected lock store.
  assert.equal(lockStore._written.length, 1);
  assert.equal(lockStore._written[0], installed.lock);
});

test('W11-A1: installProductDeliveryScenario defaults to the permissive gate', async () => {
  const { deps } = okDeps(PRODUCT_DELIVERY_SCENARIO_MANIFEST);
  const installed = await installProductDeliveryScenario(deps);
  assert.equal(
    installed.manifest.identity.version,
    PRODUCT_DELIVERY_SCENARIO_MANIFEST.identity.version,
    'default install must select the permissive (legacy-default) manifest',
  );
});

test('W11-A1: installProductDeliveryScenario({ discoveryGate: "strict" }) installs the strict manifest', async () => {
  const { deps } = okDeps(PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT);
  const installed = await installProductDeliveryScenario(deps, { discoveryGate: 'strict' });
  assert.equal(installed.manifest, PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT);
  assert.ok(installed.manifest.identity.version.endsWith('+strict'));
});

test('W11-A1: permissive/strict convenience wrappers match the gated entry point', async () => {
  const perm = await installProductDeliveryScenarioPermissive(
    okDeps(PRODUCT_DELIVERY_SCENARIO_MANIFEST).deps,
  );
  assert.equal(perm.manifest, PRODUCT_DELIVERY_SCENARIO_MANIFEST);

  const strict = await installProductDeliveryScenarioStrict(
    okDeps(PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT).deps,
  );
  assert.equal(strict.manifest, PRODUCT_DELIVERY_SCENARIO_MANIFEST_STRICT);
});

test('W11-A1: a missing production-module registration surfaces SCENARIO_INSTALL_NOT_INSTALLED', async () => {
  // The lock resolves all four selectors, but the installation registry is
  // empty — the installer must surface SCENARIO_INSTALL_NOT_INSTALLED at
  // install time (not at first stage execution). This is the cutover-time
  // failure the composition loader (W11-A2) prevents by pre-installing the
  // four production modules.
  const { deps } = okDeps(PRODUCT_DELIVERY_SCENARIO_MANIFEST, {
    installationRegistry: fakeInstallationRegistry({ installed: false }),
  });
  await assert.rejects(
    () => installProductDeliveryScenario(deps),
    (err) => err instanceof ScenarioInstallerError && err.code === SCENARIO_INSTALL_NOT_INSTALLED,
  );
});
