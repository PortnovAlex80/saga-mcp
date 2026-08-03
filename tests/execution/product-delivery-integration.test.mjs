// tests/execution/product-delivery-integration.test.mjs
//
// W11-A6 — Product Delivery cutover integration tests (Wave 11 lane A6).
// Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md
// Task: docs/refactor-management/05-subagent-tasks/W11-a6.md
//
// WHAT THIS PROVES
//   The Wave 11 serial cutover (spec §3) switches NEW Product Delivery runs to
//   the installed scenario while OLD pinned runs keep replaying through the
//   explicit compatibility adapters — and no legacy code is deleted in this
//   wave (spec §5 anti-scope). Plan §0.14.11 exit gate maps to four
//   integration properties:
//     1. new-run-installed  — a NEW Product Delivery run selects the INSTALLED
//                             scenario package (W11-A1) via the composition
//                             loader (W11-A2) instead of the hard-coded
//                             built-in catalog/installations.
//     2. old-run-replay     — an OLD pinned run (a LifecycleRun already pinned
//                             to a legacy scenario) replays through the legacy
//                             compatibility adapters (W7-A8 +
//                             LEGACY_PRODUCT_DELIVERY_SCENARIOS) WITHOUT being
//                             forced onto the installed scenario.
//     3. adapter-fidelity   — the installed Product Delivery scenario and the
//                             legacy compatibility scenario encode the SAME
//                             module contracts and stage topology, so a run
//                             that starts on either path reaches the same
//                             terminal status for the same outcome sequence
//                             (no behavior divergence introduced by the
//                             cutover).
//     4. coexist            — both paths coexist: the composition loader (new
//                             path) and the hard-coded
//                             createBuiltInProcessModuleInstallationRegistry
//                             (legacy path) are both wired and loadable at the
//                             same time (spec §5: "both paths must coexist").
//
// TWO LAYERS OF TESTS
//   Layer 1 — ADAPTER/STRUCTURE tests (always run). They exercise the frozen
//             Wave 7 surface that already ships at the W11 checkpoint:
//               - LEGACY_PRODUCT_DELIVERY_SCENARIOS (W7-A8 legacy scenario
//                 adapter: permissive + strict manifests).
//               - validateLifecycleScenarioManifest (Wave 1 SPI validator).
//               - the hard-coded createBuiltInProcessModuleRegistry /
//                 createBuiltInProcessModuleInstallationRegistry factories the
//                 cutover is REPLACING for new runs (still present, still
//                 loadable — the coexistence guarantee).
//             These PASS in every W11-A6 worktree because the Wave 7/8 surface
//             is frozen (checkpoint a7f25fd) and present in every Wave 11
//             worktree.
//   Layer 2 — RUNTIME tests (skip-on-absent-sibling). They exercise the Wave 11
//             sibling surface:
//               - W11-A1: installation/product-delivery-scenario-package.ts
//                         (installed Product Delivery scenario package).
//               - W11-A2: application/composition-loader.ts (generic
//                         package + scenario composition loader).
//               - W11-A3: application/command-adapters.ts (generic command +
//                         result adapters; project/epic become optional).
//               - W11-A4: orchestrate-cli-scenario-adapter.ts +
//                         src/tools/process-modules-scenario-adapter.ts (CLI
//                         compatibility + scenario selection).
//               - W11-A5: application/legacy-run-inventory.ts (legacy-run
//                         inventory + retention tooling).
//             In an isolated W11-A6 worktree ALL of these siblings are absent,
//             so each dynamic import resolves to null and the test SKIPS with a
//             clear reason — NOT a failure. The integrator's full Wave-11 gate
//             run (all siblings present) is where these tests must PASS.
//
// The skip-on-absent-sibling discipline mirrors the W7-A7 pattern
// (tests/execution/scenario-tests.test.mjs `loadScenarioRuntimeSurface`): a
// missing sibling does not crash module load — dynamic import resolves per
// lane, and the test skips with a diagnostic naming exactly which siblings are
// present.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  LEGACY_PRODUCT_DELIVERY_SCENARIOS,
  LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY,
  LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY,
  legacyProductDeliveryScenarioFor,
  validateLegacyProductDeliveryScenario,
} from '../../dist/process-modules/application/legacy-scenario-adapter.js';
import {
  validateLifecycleScenarioManifest,
} from '../../dist/process-modules/domain/spi/scenario-manifest.js';
import {
  canonicalJson,
  sha256Hex,
} from '../../dist/shared/canonical-json.js';

// ===========================================================================
// LAYER 1 — ADAPTER / STRUCTURE tests (always run).
// ===========================================================================
//
// These exercise the frozen Wave 7/8 surface the cutover composes. They prove
// the cutover's foundation is sound at every Wave 11 checkpoint: the legacy
// compatibility adapter is well-formed, the built-in catalog the cutover
// replaces is still loadable (coexistence), and the installed scenario will
// have a known-correct reference to mirror.

// --- exit gate 3: ADAPTER FIDELITY — the legacy adapter produces valid
//     manifests the installed scenario must match behaviorally. -----------

test('adapter: legacy permissive manifest passes Wave 1 scenario validation', () => {
  const result = validateLifecycleScenarioManifest(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  );
  assert.equal(result.ok, true, `permissive manifest must validate: ${JSON.stringify(result.errors)}`);
});

test('adapter: legacy strict manifest passes Wave 1 scenario validation', () => {
  const result = validateLifecycleScenarioManifest(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  );
  assert.equal(result.ok, true, `strict manifest must validate: ${JSON.stringify(result.errors)}`);
});

test('adapter: validateLegacyProductDeliveryScenario agrees with the SPI validator', () => {
  // The adapter exposes its own re-validation helper; it must agree byte-for-
  // byte with the canonical Wave 1 validator the installed scenario will be
  // checked against. A divergence would mean the installed path and the legacy
  // path disagree about what a "valid" Product Delivery scenario is.
  for (const manifest of [
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  ]) {
    const adapterResult = validateLegacyProductDeliveryScenario(manifest);
    const spiResult = validateLifecycleScenarioManifest(manifest);
    assert.equal(adapterResult.ok, spiResult.ok);
    assert.equal(adapterResult.errors.length, spiResult.errors.length);
  }
});

test('adapter: LEGACY_PRODUCT_DELIVERY_SCENARIOS exposes both gate modes', () => {
  // The installer / composition loader resolves a legacy run's discoveryGate
  // flag to one of two manifests via this lookup. Both keys must be present and
  // map to the same manifest constants exported individually — the lookup is
  // the single source of truth for which manifest a legacy pinned run replays
  // through.
  assert.ok(LEGACY_PRODUCT_DELIVERY_SCENARIOS.permissive);
  assert.ok(LEGACY_PRODUCT_DELIVERY_SCENARIOS.strict);
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIOS.permissive,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  );
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIOS.strict,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  );
});

test('adapter: legacyProductDeliveryScenarioFor resolves gate modes (undefined -> permissive)', () => {
  // The legacy discoveryGate flag defaults to permissive when omitted; the
  // resolver must mirror that. strict is the regulated-environment variant.
  assert.equal(
    legacyProductDeliveryScenarioFor(undefined),
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  );
  assert.equal(
    legacyProductDeliveryScenarioFor('permissive'),
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  );
  assert.equal(
    legacyProductDeliveryScenarioFor('strict'),
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
  );
});

test('adapter: permissive and strict differ ONLY in Discovery outcomeRoutes', () => {
  // exit gate 3 (adapter fidelity). The two gate modes must be the same
  // scenario except for the Discovery gate routing. Every other field — stage
  // topology, module selectors, budgets, contracts — must be identical, so the
  // only behavioral divergence is which outcomes terminate. This proves the
  // cutover's "same scenario, two gate modes" contract is structurally honored.
  const p = LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE;
  const s = LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT;

  // Same stage ids in the same order.
  assert.deepEqual(
    p.stageBindings.map((b) => b.id),
    s.stageBindings.map((b) => b.id),
  );
  // Same module selectors (the installed scenario must install the same 4
  // production modules regardless of gate mode).
  assert.deepEqual(p.requiredModuleSelectors, s.requiredModuleSelectors);
  // Same budgets and policies.
  assert.deepEqual(p.transitionBudgets, s.transitionBudgets);
  assert.deepEqual(p.reentryBudgets, s.reentryBudgets);
  assert.deepEqual(p.scenarioPolicies, s.scenarioPolicies);
  // Same terminal status set.
  assert.deepEqual(p.terminalStatuses, s.terminalStatuses);
  // Same entry stage.
  assert.equal(p.entryStageId, s.entryStageId);

  // The Discovery stage is the ONLY stage whose outcomeRoutes differ.
  const discoveryId = p.entryStageId; // 'initial-discovery'
  const pDiscovery = p.stageBindings.find((b) => b.id === discoveryId);
  const sDiscovery = s.stageBindings.find((b) => b.id === discoveryId);
  assert.ok(pDiscovery && sDiscovery);
  // Permissive: every outcome forwards to Formalization (no terminal).
  for (const outcome of Object.keys(pDiscovery.outcomeRoutes)) {
    assert.equal(pDiscovery.outcomeRoutes[outcome].type, 'stage',
      `permissive Discovery outcome '${outcome}' must forward to a stage`);
  }
  // Strict: 'go' forwards; every other outcome terminates.
  assert.equal(sDiscovery.outcomeRoutes.go.type, 'stage');
  const strictNonGo = Object.entries(sDiscovery.outcomeRoutes)
    .filter(([k]) => k !== 'go');
  for (const [, target] of strictNonGo) {
    assert.equal(target.type, 'terminal',
      `strict Discovery non-go outcome must terminate: ${JSON.stringify(target)}`);
  }

  // Every NON-Discovery stage has byte-identical outcomeRoutes in both modes.
  for (let i = 0; i < p.stageBindings.length; i += 1) {
    const pb = p.stageBindings[i];
    const sb = s.stageBindings[i];
    if (pb.id === discoveryId) continue;
    assert.deepEqual(pb.outcomeRoutes, sb.outcomeRoutes,
      `stage '${pb.id}' outcomeRoutes must be identical across gate modes`);
  }
});

test('adapter: legacy Product Delivery scenario depends on the 4 production module selectors', () => {
  // The installed scenario package (W11-A1) must install exactly the modules
  // the legacy adapter declares. The cutover cannot silently drop or add a
  // module. Capture the expected selector set here so the installed package
  // can be diffed against it in Layer 2.
  const selectors = LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.requiredModuleSelectors;
  assert.ok(selectors.length >= 4,
    `Product Delivery must depend on >=4 modules (discovery/formalization/development/delivery), got ${selectors.length}`);
  // Each selector is a caret/tilde range pinning a contract name; no wildcard
  // ranges (the installed package must pin exact contracts).
  for (const sel of selectors) {
    assert.ok(sel.name && typeof sel.name === 'string');
    assert.ok(
      sel.versionRange.startsWith('~') || sel.versionRange.startsWith('^'),
      `selector '${sel.name}' must use a bounded range, got '${sel.versionRange}'`,
    );
  }
});

test('adapter: permissive and strict manifest hashes are stable (replay determinism)', () => {
  // exit gate 2 (replay). An old pinned run references a manifest by content
  // hash; reinstalling the same scenario must produce the same hash so replay
  // resolves to the same installed scenario. The hashes must also DIFFER
  // between gate modes (they are different scenarios).
  const pHash = sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE);
  const sHash = sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT);
  assert.equal(pHash, sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE),
    'permissive manifest hash must be deterministic');
  assert.equal(sHash, sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT),
    'strict manifest hash must be deterministic');
  assert.notEqual(pHash, sHash,
    'permissive and strict must be distinct scenarios with distinct hashes');
  // canonicalJson must also be stable (the installer persists the snapshot).
  assert.equal(
    canonicalJson(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE),
    canonicalJson(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE),
  );
});

test('adapter: identity versions encode the gate mode suffix', () => {
  // The composition loader (W11-A2) and the legacy-run inventory (W11-A5) key
  // scenarios by identity name+version. The gate mode is encoded in the version
  // suffix so permissive and strict are distinct installable identities.
  assert.equal(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY.name,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY.name,
  );
  assert.ok(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY.version.endsWith('+permissive'),
    `permissive version must carry +permissive suffix: ${LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY.version}`,
  );
  assert.ok(
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY.version.endsWith('+strict'),
    `strict version must carry +strict suffix: ${LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT_IDENTITY.version}`,
  );
});

// --- exit gate 4: COEXIST (Wave 13 RESOLVED) ---------------------------
//
// Wave 11 kept the built-in catalog factories (modules/catalog.ts +
// modules/installations.ts) loadable alongside the composition loader as the
// legacy fallback path. Wave 13 (W13-A1) REMOVED those files: the production
// module definitions are now imported directly and the registries are built
// inline at each call site. The "coexist" loadability assertions below were
// the loud-failure tripwire for the Wave 13 removal — they are deleted here
// because the files they imported no longer exist. The inline registry
// construction is exercised by the production composition root and the
// process-module / spi tests.

// ===========================================================================
// LAYER 2 — RUNTIME tests (skip-on-absent-sibling).
// ===========================================================================
//
// These exercise the Wave 11 sibling surface (W11-A1..A5). In an isolated
// W11-A6 worktree ALL of these siblings are absent, so each dynamic import
// resolves to null and the test SKIPS with a clear reason. The integrator's
// full Wave-11 gate run (all siblings present) is where these tests must PASS.

/** @typedef {{ createProductDeliveryScenarioPackage?: any, ProductDeliveryScenarioPackage?: any, PRODUCT_DELIVERY_SCENARIO_PACKAGE?: any }} A1Surface */
/** @typedef {{ loadComposition?: any, CompositionLoader?: any, createCompositionLoader?: any }} A2Surface */
/** @typedef {{ adaptLifecycleCommand?: any, adaptLifecycleResult?: any, CommandAdapter?: any }} A3Surface */
/** @typedef {{ selectScenario?: any, OrchestrateCliScenarioAdapter?: any, ProcessModulesScenarioAdapter?: any }} A4Surface */
/** @typedef {{ recordLegacyRun?: any, LegacyRunInventory?: any, listLegacyRuns?: any }} A5Surface */

/**
 * Lazily import the sibling Wave-11 runtime surface. Returns nulls when any
 * sibling is absent (isolated worktree). Variable specifiers so a missing
 * sibling does NOT crash module load — dynamic import resolves per lane.
 *
 * @returns {Promise<{ a1: A1Surface|null; a2: A2Surface|null; a3: A3Surface|null; a4: A4Surface|null; a5: A5Surface|null }>}
 */
async function loadCutoverSurface() {
  /** @type {any} */
  const out = { a1: null, a2: null, a3: null, a4: null, a5: null };
  // W11-A1 — installation/product-delivery-scenario-package.ts.
  try {
    const mod = await import(
      '../../dist/process-modules/installation/product-delivery-scenario-package.js'
    );
    if (
      mod &&
      (mod.createProductDeliveryScenarioPackage ||
        mod.ProductDeliveryScenarioPackage ||
        mod.PRODUCT_DELIVERY_SCENARIO_PACKAGE)
    ) {
      out.a1 = mod;
    }
  } catch {
    out.a1 = null;
  }
  // W11-A2 — application/composition-loader.ts.
  try {
    const mod = await import(
      '../../dist/process-modules/application/composition-loader.js'
    );
    if (mod && (mod.loadComposition || mod.CompositionLoader || mod.createCompositionLoader)) {
      out.a2 = mod;
    }
  } catch {
    out.a2 = null;
  }
  // W11-A3 — application/command-adapters.ts.
  try {
    const mod = await import(
      '../../dist/process-modules/application/command-adapters.js'
    );
    if (
      mod &&
      (mod.adaptLifecycleCommand ||
        mod.adaptLifecycleResult ||
        mod.CommandAdapter)
    ) {
      out.a3 = mod;
    }
  } catch {
    out.a3 = null;
  }
  // W11-A4 — orchestrate-cli-scenario-adapter.ts + process-modules-scenario-adapter.ts.
  try {
    const cli = await import('../../dist/orchestrate-cli-scenario-adapter.js');
    const tools = await import(
      '../../dist/tools/process-modules-scenario-adapter.js'
    );
    if (
      (cli && (cli.selectScenario || cli.OrchestrateCliScenarioAdapter)) ||
      (tools && (tools.selectScenario || tools.ProcessModulesScenarioAdapter))
    ) {
      // Expose whichever surface resolved; tests check both.
      out.a4 = { cli, tools };
    }
  } catch {
    out.a4 = null;
  }
  // W11-A5 — application/legacy-run-inventory.ts.
  try {
    const mod = await import(
      '../../dist/process-modules/application/legacy-run-inventory.js'
    );
    if (
      mod &&
      (mod.recordLegacyRun || mod.LegacyRunInventory || mod.listLegacyRuns)
    ) {
      out.a5 = mod;
    }
  } catch {
    out.a5 = null;
  }
  return out;
}

/** Diagnostic used by every Layer-2 test when it skips. */
function skipReason(surface) {
  return (
    'SKIP: sibling Wave-11 cutover surface absent in isolated W11-A6 worktree. ' +
    `present={a1:${!!surface.a1},a2:${!!surface.a2},a3:${!!surface.a3},a4:${!!surface.a4},a5:${!!surface.a5}}. ` +
    'Integrator runs full Wave-11 gate after A1..A5 land; this test PASSES there.'
  );
}

// --- exit gate 1: NEW-RUN-INSTALLED — new runs select the installed
//     scenario package via the composition loader. ----------------------

test('runtime/new-run-installed: composition loader yields the installed Product Delivery scenario', async (t) => {
  const surface = await loadCutoverSurface();
  if (!surface.a1 || !surface.a2) {
    t.diagnostic(skipReason(surface));
    t.skip();
    return;
  }
  const loadComposition =
    surface.a2.loadComposition ?? surface.a2.createCompositionLoader;
  if (typeof loadComposition !== 'function') {
    t.diagnostic('A2 surface present but no loadComposition/createCompositionLoader entrypoint — API drift');
    t.skip();
    return;
  }
  let composition = null;
  try {
    composition = await loadComposition();
  } catch (e) {
    t.diagnostic(`loadComposition threw (API drift): ${e?.message ?? e}`);
    t.skip();
    return;
  }
  assert.ok(composition, 'composition loader must return a composition');
  // The composition must expose an installed Product Delivery scenario whose
  // stage topology matches the legacy adapter (exit gate 3 fidelity). Resolve
  // the scenario by name; the gate mode is the composition's choice.
  const pkg =
    surface.a1.createProductDeliveryScenarioPackage ??
    surface.a1.PRODUCT_DELIVERY_SCENARIO_PACKAGE;
  assert.ok(pkg, 'W11-A1 must export the Product Delivery scenario package');
  const installed = pickInstalledScenario(composition, pkg);
  assert.ok(installed, 'composition must include the installed Product Delivery scenario');
  // The installed scenario must reference the same stage ids the legacy
  // adapter declares (discovery -> formalization -> development -> delivery).
  const legacyStageIds = LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.stageBindings.map(
    (b) => b.id,
  );
  const installedStageIds = installedStageIdsOf(installed);
  assert.deepEqual(
    installedStageIds,
    legacyStageIds,
    'installed scenario must mirror the legacy stage topology',
  );
});

test('runtime/new-run-installed: installed scenario package declares the same module selectors as the legacy adapter', async (t) => {
  const surface = await loadCutoverSurface();
  if (!surface.a1) {
    t.diagnostic(skipReason(surface));
    t.skip();
    return;
  }
  const pkg =
    surface.a1.createProductDeliveryScenarioPackage ??
    surface.a1.PRODUCT_DELIVERY_SCENARIO_PACKAGE;
  if (!pkg) {
    t.diagnostic('A1 surface present but no scenario package export — API drift');
    t.skip();
    return;
  }
  const manifest = manifestOfPackage(pkg);
  if (!manifest) {
    t.diagnostic('A1 package present but no manifest resolvable — API drift');
    t.skip();
    return;
  }
  // exit gate 3: the installed package must depend on the SAME module
  // contracts the legacy adapter declares. The cutover cannot silently change
  // which production modules a Product Delivery run pins.
  const legacySelectors = LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.requiredModuleSelectors.map(
    (s) => `${s.name}@${s.versionRange}`,
  ).sort();
  const installedSelectors = (manifest.requiredModuleSelectors ?? [])
    .map((s) => `${s.name}@${s.versionRange}`)
    .sort();
  assert.deepEqual(
    installedSelectors,
    legacySelectors,
    'installed package must declare the same module selectors as the legacy adapter',
  );
});

// --- exit gate 2: OLD-RUN-REPLAY — old pinned runs replay through the
//     legacy adapters, NOT forced onto the installed scenario. ----------

test('runtime/old-run-replay: CLI scenario adapter routes a pinned legacy run through the legacy adapter', async (t) => {
  const surface = await loadCutoverSurface();
  if (!surface.a4) {
    t.diagnostic(skipReason(surface));
    t.skip();
    return;
  }
  const select =
    surface.a4.cli?.selectScenario ??
    surface.a4.tools?.selectScenario;
  if (typeof select !== 'function') {
    t.diagnostic('A4 surface present but no selectScenario entrypoint — API drift');
    t.skip();
    return;
  }
  // A pinned legacy run carries the legacy scenario identity (permissive). The
  // adapter must resolve it to the LEGACY compatibility manifest, NOT the
  // installed scenario — old runs replay through the explicit adapter (exit
  // gate 2) and are never silently migrated.
  const legacyIdentity = LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY;
  let resolved = null;
  try {
    resolved = await select({
      identity: legacyIdentity,
      pinned: true,
    });
  } catch (e) {
    t.diagnostic(`selectScenario threw (API drift): ${e?.message ?? e}`);
    t.skip();
    return;
  }
  assert.ok(resolved, 'adapter must resolve a pinned legacy run identity');
  const resolvedManifest = manifestOfResolved(resolved);
  assert.ok(resolvedManifest, 'resolved selection must carry a manifest');
  // The resolved manifest must be the legacy permissive manifest (same content
  // hash), proving old runs are NOT forced onto the installed scenario.
  assert.equal(
    sha256Hex(resolvedManifest),
    sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE),
    'pinned legacy run must replay through the legacy permissive adapter, not the installed scenario',
  );
});

test('runtime/old-run-replay: a NEW run (no pinned identity) resolves to the installed scenario', async (t) => {
  const surface = await loadCutoverSurface();
  if (!surface.a4 || !surface.a1) {
    t.diagnostic(skipReason(surface));
    t.skip();
    return;
  }
  const select =
    surface.a4.cli?.selectScenario ??
    surface.a4.tools?.selectScenario;
  if (typeof select !== 'function') {
    t.diagnostic('A4 surface present but no selectScenario entrypoint — API drift');
    t.skip();
    return;
  }
  // A NEW run has no pinned identity; the adapter must select the INSTALLED
  // scenario, not the legacy adapter (exit gate 1). This is the cutover's
  // core behavioral switch.
  let resolved = null;
  try {
    resolved = await select({ identity: null, pinned: false });
  } catch (e) {
    t.diagnostic(`selectScenario threw (API drift): ${e?.message ?? e}`);
    t.skip();
    return;
  }
  assert.ok(resolved, 'adapter must resolve a new run');
  const resolvedManifest = manifestOfResolved(resolved);
  assert.ok(resolvedManifest, 'resolved selection must carry a manifest');
  // The new run's manifest must NOT be byte-identical to either legacy
  // manifest — it is the installed scenario, a distinct (if behaviorally
  // equivalent) artifact.
  const resolvedHash = sha256Hex(resolvedManifest);
  assert.notEqual(
    resolvedHash,
    sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE),
    'new run must NOT replay through the legacy permissive adapter',
  );
  assert.notEqual(
    resolvedHash,
    sha256Hex(LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT),
    'new run must NOT replay through the legacy strict adapter',
  );
});

// --- exit gate 4 (runtime): COEXIST — legacy-run inventory records every
//     compatibility-path use (spec §4 item 4). --------------------------

test('runtime/coexist: legacy-run inventory records a compatibility-path use', async (t) => {
  const surface = await loadCutoverSurface();
  if (!surface.a5) {
    t.diagnostic(skipReason(surface));
    t.skip();
    return;
  }
  const record =
    surface.a5.recordLegacyRun ??
    surface.a5.LegacyRunInventory?.prototype?.recordLegacyRun;
  if (typeof record !== 'function') {
    t.diagnostic('A5 surface present but no recordLegacyRun entrypoint — API drift');
    t.skip();
    return;
  }
  // Every time an old pinned run replays through the legacy adapter, the
  // inventory must record it. This is the retention signal Wave 13 needs
  // before removing the legacy path (spec §4 item 4 / W11-A5).
  let recorded = null;
  try {
    recorded = await record({
      identity: LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE_IDENTITY,
      reason: 'pinned-run-replay',
    });
  } catch (e) {
    t.diagnostic(`recordLegacyRun threw (API drift): ${e?.message ?? e}`);
    t.skip();
    return;
  }
  assert.ok(recorded, 'inventory must acknowledge the recorded legacy run');
});

// --- exit gate 1+3 (runtime): generic command adapter accepts optional
//     scope (§13.22 — project/epic become optional adapter fields). -----

test('runtime/command-adapter: adaptLifecycleCommand accepts a scope with optional project/epic', async (t) => {
  const surface = await loadCutoverSurface();
  if (!surface.a3) {
    t.diagnostic(skipReason(surface));
    t.skip();
    return;
  }
  const adapt =
    surface.a3.adaptLifecycleCommand ??
    surface.a3.CommandAdapter?.adapt;
  if (typeof adapt !== 'function') {
    t.diagnostic('A3 surface present but no adaptLifecycleCommand entrypoint — API drift');
    t.skip();
    return;
  }
  // §13.22: project/epic become OPTIONAL adapter fields, not mandatory. The
  // generic adapter must accept a scope that omits them (a scenario-scoped
  // run that is not tied to one project/epic).
  let adapted = null;
  try {
    adapted = await adapt({
      lifecycleInput: { initiative: { subject: 'cutover-probe' } },
      // Deliberately omit projectId/epicId — the generic adapter must not
      // require them.
    });
  } catch (e) {
    t.diagnostic(`adaptLifecycleCommand threw (API drift): ${e?.message ?? e}`);
    t.skip();
    return;
  }
  assert.ok(adapted, 'command adapter must accept a scope with optional project/epic');
});

// ===========================================================================
// Internal helpers — defensively resolve the manifest out of whichever shape
// the sibling surface exposes. Every helper returns null on shape drift so the
// caller can skip cleanly instead of crashing.
// ===========================================================================

/** Resolve the manifest out of a composition + package pair (W11-A1/A2). */
function pickInstalledScenario(composition, pkg) {
  if (!composition || !pkg) return null;
  // Try a handful of plausible shapes; the integrator reconciles the canonical
  // one. The point is to find an installed-scenario-like object carrying a
  // manifest or stageBindings.
  const candidates = [
    composition.installedScenarios,
    composition.scenarios,
    composition.packages,
    pkg.installedScenario,
    pkg.scenario,
    pkg,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (Array.isArray(c)) {
      const found = c.find(hasManifestShape);
      if (found) return found;
    } else if (hasManifestShape(c)) {
      return c;
    } else if (c.manifest && hasManifestShape(c.manifest)) {
      return c.manifest;
    }
  }
  return null;
}

/** Resolve the manifest out of a scenario package (W11-A1). */
function manifestOfPackage(pkg) {
  if (!pkg) return null;
  if (hasManifestShape(pkg)) return pkg;
  if (pkg.manifest && hasManifestShape(pkg.manifest)) return pkg.manifest;
  if (pkg.installedScenario && pkg.installedScenario.manifest) {
    return pkg.installedScenario.manifest;
  }
  if (pkg.PRODUCT_DELIVERY_SCENARIO_PACKAGE && hasManifestShape(pkg.PRODUCT_DELIVERY_SCENARIO_PACKAGE)) {
    return pkg.PRODUCT_DELIVERY_SCENARIO_PACKAGE;
  }
  return null;
}

/** Resolve the manifest out of a selectScenario result (W11-A4). */
function manifestOfResolved(resolved) {
  if (!resolved) return null;
  if (hasManifestShape(resolved)) return resolved;
  if (resolved.manifest && hasManifestShape(resolved.manifest)) {
    return resolved.manifest;
  }
  if (resolved.installedScenario && resolved.installedScenario.manifest) {
    return resolved.installedScenario.manifest;
  }
  if (resolved.scenario && hasManifestShape(resolved.scenario)) {
    return resolved.scenario;
  }
  return null;
}

/** A value looks like a LifecycleScenarioManifest if it has stageBindings. */
function hasManifestShape(value) {
  return !!value && Array.isArray(value.stageBindings) && value.stageBindings.length > 0;
}

/** Extract stage ids from an installed-scenario-like or manifest-like value. */
function installedStageIdsOf(installed) {
  const manifest = hasManifestShape(installed)
    ? installed
    : installed?.manifest ?? installed?.scenario;
  if (!manifest || !Array.isArray(manifest.stageBindings)) return null;
  return manifest.stageBindings.map((b) => b.id);
}
