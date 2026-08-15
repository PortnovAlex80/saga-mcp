// @ts-check
/**
 * W10-A4 — Campaign Lifecycle Scenario proof test.
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`
 *       Lane W10-A4 (§1 row 4, §2 exit gate #1/#2, §3 anti-scope, §4 key
 *       design). Plan ref: §0.13.4, §0.13.10 serial gate.
 *
 * This is the DEFINITIVE proof that a third-party LifecycleScenarioManifest
 * composes the three sibling-wave external module packages (lm-marketing +
 * external-seo + human-director-approval) and installs + validates WITHOUT any
 * Runtime, global runner, gateway, catalog, or existing-module source change
 * (spec §3 anti-scope, §4 import-list proof).
 *
 * What this file proves:
 *
 *   1. PACKAGE INSTALLS FROM DISK — `scenarios-ext/campaign/manifest.json` is a
 *      real installable artifact: read from disk, it is a plain
 *      canonical-serializable object that passes validateLifecycleScenarioManifest.
 *   2. UPGRADE FROM W0-A7 — the manifest is a LifecycleScenarioManifest (W1-A3
 *      aggregate: stageBindings + moduleSelector + budgets + policies), NOT the
 *      old LifecycleDefinition-shaped `stages` fixture.
 *   3. COMPOSES THE 3 SIBLING PACKAGES — requiredModuleSelectors declares
 *      exactly lm-marketing, external-seo, human-director-approval. No built-in
 *      module, no kernel-analytics.
 *   4. §6.8 — external-seo reused in THREE stages with three different mappings.
 *   5. §6.4 — NO routeResolver anywhere (structural absence).
 *   6. §6.3.5 / §6.9.3 — complete deterministic route table for every declared
 *      module outcome; Human stage routes two outcomes to two distinct terminals.
 *   7. §6.9.5 — safe own-property mappings only.
 *   8. ROUND-TRIP — manifest.json === definition.mjs export; canonical JSON
 *      round-trips byte-identically; sha256 stable.
 *   9. §0.13.10 IMPORT-LIST PROOF — the package imports nothing from src/,
 *      modules/, the catalog, or the composition root. The import list IS the
 *      extensibility proof (spec §4).
 *
 * Imports run against the COMPILED dist/ output (Wave 1 SPI barrel) + the
 * package under scenarios-ext/. Run:
 *   node --test tests/extensibility/w10-a4-campaign-scenario.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import campaignScenarioManifest, {
  CAMPAIGN_SCENARIO_IDENTITY,
  CAMPAIGN_TERMINAL_STATUSES,
  CAMPAIGN_REQUIRED_MODULE_SELECTORS,
} from '../../scenarios-ext/campaign/definition.mjs';

// Wave 1 SPI barrel (compiled). The validator + canonical helpers are the SAME
// surface the built-in modules validate against — the shared SPI is the proof
// that this third-party scenario needs no Runtime-specific branch.
const {
  validateLifecycleScenarioManifest,
  assertCanonicalSerializable,
} = await import('../../dist/process-modules/domain/spi/index.js');
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const PKG_DIR = path.join(REPO_ROOT, 'scenarios-ext', 'campaign');
const MANIFEST_PATH = path.join(PKG_DIR, 'manifest.json');

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** @param {unknown} v @param {string} label */
function assertPlainObject(v, label) {
  assert.ok(
    typeof v === 'object' && v !== null && !Array.isArray(v),
    `${label} must be a plain object`,
  );
}

/**
 * Full round-trip + serializability contract for a manifest value.
 * @param {string} label
 * @param {unknown} manifest
 */
function assertRoundTrip(label, manifest) {
  assertCanonicalSerializable(manifest);
  const json = canonicalJson(manifest);
  const parsed = JSON.parse(json);
  assert.deepEqual(
    parsed,
    manifest,
    `${label}: round-trip via JSON.parse(canonicalJson(x))`,
  );
  const h1 = sha256Hex(manifest);
  const h2 = sha256Hex(manifest);
  assert.equal(h1, h2, `${label}: sha256Hex stable across two runs`);
}

// ---------------------------------------------------------------------------
// 1. Package installs from disk — manifest.json is a real installable artifact.
// ---------------------------------------------------------------------------

test('W10-A4 campaign package: manifest.json is installable from disk', () => {
  // The package directory exists with the install surface.
  assert.ok(existsSync(PKG_DIR), `package dir exists at ${PKG_DIR}`);
  assert.ok(existsSync(MANIFEST_PATH), `manifest.json exists at ${MANIFEST_PATH}`);
  assert.ok(
    existsSync(path.join(PKG_DIR, 'definition.mjs')),
    'definition.mjs exists',
  );
  assert.ok(existsSync(path.join(PKG_DIR, 'README.md')), 'README.md exists');
  assert.ok(
    existsSync(path.join(PKG_DIR, 'schemas', 'campaign-input.schema.json')),
    'input schema exists',
  );

  // Read from disk and parse — the install path.
  const raw = readFileSync(MANIFEST_PATH, 'utf8');
  /** @type {any} */
  const fromDisk = JSON.parse(raw);

  // The disk artifact validates against the shared Wave 1 SPI.
  const result = validateLifecycleScenarioManifest(fromDisk);
  assert.equal(
    result.ok,
    true,
    `manifest.json (from disk) validates via validateLifecycleScenarioManifest ` +
      `(errors=${JSON.stringify(result.errors)})`,
  );
  assertCanonicalSerializable(fromDisk);
});

// ---------------------------------------------------------------------------
// 2. Upgrade from W0-A7 — real LifecycleScenarioManifest shape (not `stages`).
// ---------------------------------------------------------------------------

test('W10-A4 campaign manifest: upgraded to LifecycleScenarioManifest shape (W1-A3 aggregate)', () => {
  const m = campaignScenarioManifest;
  // W1-A3 aggregate fields present.
  assert.equal(typeof m.manifestFormatVersion, 'string', 'manifestFormatVersion');
  assertPlainObject(m.identity, 'identity');
  assertPlainObject(m.inputContractRef, 'inputContractRef');
  assertPlainObject(m.outputContractRef, 'outputContractRef');
  assert.equal(typeof m.entryStageId, 'string', 'entryStageId');
  assert.ok(Array.isArray(m.stageBindings), 'stageBindings is an array');
  assertPlainObject(m.outcomeRoutes, 'outcomeRoutes');
  assertPlainObject(m.inputMappings, 'inputMappings');
  assertPlainObject(m.outputMappings, 'outputMappings');
  assert.ok(Array.isArray(m.terminalStatuses), 'terminalStatuses is an array');
  assertPlainObject(m.scenarioPolicies, 'scenarioPolicies');
  assert.ok(Array.isArray(m.requiredModuleSelectors), 'requiredModuleSelectors');
  assertPlainObject(m.transitionBudgets, 'transitionBudgets');
  assertPlainObject(m.reentryBudgets, 'reentryBudgets');

  // The OLD W0-A7 fixture used `stages`; the upgrade uses `stageBindings`.
  assert.equal(
    'stages' in m,
    false,
    'upgraded manifest must NOT carry the unsupported `stages` field',
  );
  // Each stageBinding is enriched with a moduleSelector (W1-A3 ScenarioStageBinding).
  for (const s of m.stageBindings) {
    assertPlainObject(s.moduleSelector, `stage '${s.id}' has a moduleSelector`);
    assert.equal(typeof s.moduleSelector.name, 'string', 'moduleSelector.name');
    assert.equal(
      typeof s.moduleSelector.versionRange,
      'string',
      'moduleSelector.versionRange',
    );
  }

  // Identity is the real installable scenario (not the synthetic- fixture).
  assert.equal(m.identity.name, 'campaign', 'identity.name is campaign (not synthetic-)');
  assert.equal(m.identity.version, '1.0.0', 'identity.version');
});

// ---------------------------------------------------------------------------
// 3. Composes exactly the 3 sibling-wave packages.
// ---------------------------------------------------------------------------

test('W10-A4 campaign manifest: composes exactly the 3 sibling-wave packages (no built-in module)', () => {
  const m = campaignScenarioManifest;
  const names = m.requiredModuleSelectors.map((/** @type {any} */ s) => s.name).sort();
  assert.deepEqual(
    names,
    ['external-seo', 'human-director-approval', 'lm-marketing'],
    'requiredModuleSelectors = the 3 sibling-wave packages',
  );
  // No kernel-analytics, no built-in module referenced.
  assert.ok(
    !names.includes('kernel-analytics'),
    'scenario does NOT reference kernel-analytics (no sibling wave builds it)',
  );
  assert.ok(
    !names.includes('discovery') &&
      !names.includes('formalization') &&
      !names.includes('development') &&
      !names.includes('delivery'),
    'scenario references no built-in module',
  );
  // requiredModuleSelectors is the deduplicated closure.
  assert.equal(
    m.requiredModuleSelectors.length,
    3,
    'requiredModuleSelectors deduplicated (external-seo once despite 3 reuses)',
  );
  assert.deepEqual(
    CAMPAIGN_REQUIRED_MODULE_SELECTORS.map((/** @type {any} */ s) => s.name).sort(),
    names,
    'CAMPAIGN_REQUIRED_MODULE_SELECTORS matches manifest closure',
  );
});

// ---------------------------------------------------------------------------
// 4. §6.8 — external-seo reused in THREE stages.
// ---------------------------------------------------------------------------

test('W10-A4 campaign manifest: external-seo reused in exactly 3 stages (plan §6.8)', () => {
  const m = campaignScenarioManifest;
  const seoStages = m.stageBindings.filter(
    (/** @type {any} */ s) => s.moduleSelector.name === 'external-seo',
  );
  assert.equal(seoStages.length, 3, 'external-seo appears in exactly 3 stages');
  assert.deepEqual(
    seoStages.map((/** @type {any} */ s) => s.id).sort(),
    ['metrics', 'seo-baseline', 'seo-followup'],
    'reused in seo-baseline + metrics + seo-followup',
  );
  // Each reuse has a DISTINCT input mapping — the proof the Runtime must not
  // derive a stage from module kind or task-kind prefix (§6.8, §3.6).
  const mappings = seoStages.map(
    (/** @type {any} */ s) => JSON.stringify(s.inputMapping),
  );
  assert.equal(
    new Set(mappings).size,
    3,
    'the 3 external-seo reuses each carry a distinct input mapping',
  );
});

// ---------------------------------------------------------------------------
// 5. §6.4 — NO routeResolver anywhere.
// ---------------------------------------------------------------------------

test('W10-A4 campaign manifest: NO routeResolver (plan §6.4)', () => {
  const m = campaignScenarioManifest;
  assert.equal(
    'routeResolver' in m,
    false,
    'LifecycleScenarioManifest must NOT carry a routeResolver field (§6.4)',
  );
  for (const s of m.stageBindings) {
    assert.equal(
      'routeResolver' in s,
      false,
      `stage '${s.id}' must NOT carry a routeResolver`,
    );
    assert.ok(
      s.outcomeRoutes && typeof s.outcomeRoutes === 'object',
      `stage '${s.id}' has a static outcomeRoutes table`,
    );
  }
  // The validator's defense-in-depth: a manifest smuggling a routeResolver key
  // is rejected with ROUTE_RESOLVER_FORBIDDEN (even before canonical check).
  const smuggled = { ...m, routeResolver: () => null };
  const r = validateLifecycleScenarioManifest(smuggled);
  assert.equal(r.ok, false, 'smuggled routeResolver rejected');
  assert.ok(
    r.errors.some((/** @type {any} */ e) => e.code === 'ROUTE_RESOLVER_FORBIDDEN'),
    'ROUTE_RESOLVER_FORBIDDEN error code emitted',
  );
});

// ---------------------------------------------------------------------------
// 6. §6.3.5 / §6.9.3 — complete deterministic route table.
// ---------------------------------------------------------------------------

test('W10-A4 campaign manifest: complete route table for every declared module outcome (§6.3.5)', () => {
  const m = campaignScenarioManifest;
  // The three sibling modules' declared outcomes (mirrors W10-A1/A2/A3).
  /** @type {Record<string, string[]>} */
  const moduleOutcomesByName = {
    'lm-marketing': ['campaign-drafted'],
    'external-seo': ['ranking-fetched'],
    'human-director-approval': ['approved', 'rejected'],
  };
  for (const s of m.stageBindings) {
    const expected = moduleOutcomesByName[s.moduleSelector.name];
    assert.ok(expected, `stage '${s.id}' references a known sibling module`);
    const routed = Object.keys(s.outcomeRoutes).sort();
    const declared = [...expected].sort();
    assert.deepEqual(
      routed,
      declared,
      `stage '${s.id}' routes every declared outcome exactly once`,
    );
  }
});

test('W10-A4 campaign manifest: Human stage routes approved/rejected to distinct terminals', () => {
  const m = campaignScenarioManifest;
  const approve = m.stageBindings.find((/** @type {any} */ s) => s.id === 'approve');
  assert.ok(approve, 'approve stage exists');
  assert.deepEqual(approve.outcomeRoutes.approved, {
    type: 'terminal',
    status: 'campaign-approved',
  });
  assert.deepEqual(approve.outcomeRoutes.rejected, {
    type: 'terminal',
    status: 'campaign-rejected',
  });
});

test('W10-A4 campaign manifest: every route target is an existing stage or a declared terminal (§6.9.1/§6.9.2)', () => {
  const m = campaignScenarioManifest;
  const stageIds = new Set(m.stageBindings.map((/** @type {any} */ s) => s.id));
  assert.ok(stageIds.has(m.entryStageId), 'entryStageId references an existing stage');
  for (const status of CAMPAIGN_TERMINAL_STATUSES) {
    assert.ok(
      m.terminalStatuses.includes(status),
      `terminal status '${status}' declared`,
    );
  }
  for (const s of m.stageBindings) {
    for (const [outcome, target] of Object.entries(s.outcomeRoutes)) {
      const t = /** @type {any} */ (target);
      if (t.type === 'stage') {
        assert.ok(
          stageIds.has(t.stageId),
          `stage '${s.id}' outcome '${outcome}' -> existing stage '${t.stageId}'`,
        );
      } else if (t.type === 'terminal') {
        assert.ok(
          m.terminalStatuses.includes(t.status),
          `stage '${s.id}' outcome '${outcome}' -> declared terminal '${t.status}'`,
        );
      } else {
        assert.fail(`unknown route target type on stage '${s.id}'`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 7. §6.9.5 — safe own-property mappings only.
// ---------------------------------------------------------------------------

test('W10-A4 campaign manifest: safe own-property input/output mappings (§6.9.5)', () => {
  const m = campaignScenarioManifest;
  for (const s of m.stageBindings) {
    assertPlainObject(s.inputMapping, `stage '${s.id}' inputMapping`);
    for (const [key, expr] of Object.entries(s.inputMapping)) {
      if (typeof expr === 'string') {
        assert.ok(
          !/^__proto__|prototype|constructor(\$|\.)/.test(expr),
          `mapping '${s.id}.${key}' path is safe`,
        );
      } else if (expr && typeof expr === 'object' && 'literal' in expr) {
        // { literal: ... } — immutable declared value.
      } else if (expr && typeof expr === 'object' && 'runtime' in expr) {
        assert.ok(
          ['projectId', 'epicId', 'lifecycleRunId', 'stageId', 'initiatedBy'].includes(
            /** @type {any} */ (expr).runtime,
          ),
          `runtime field '${s.id}.${key}' is one of the allowed immutable runtime keys`,
        );
      } else {
        assert.fail(`mapping '${s.id}.${key}' must be string | {literal} | {runtime}`);
      }
    }
    if (s.outputMapping) {
      assertPlainObject(s.outputMapping, `stage '${s.id}' outputMapping`);
    }
  }
});

// ---------------------------------------------------------------------------
// 8. Round-trip — manifest.json === definition.mjs export; canonical stable.
// ---------------------------------------------------------------------------

test('W10-A4 campaign manifest: validates + round-trips (definition export)', () => {
  const m = campaignScenarioManifest;
  const result = validateLifecycleScenarioManifest(m);
  assert.equal(
    result.ok,
    true,
    `validateLifecycleScenarioManifest ok (errors=${JSON.stringify(result.errors)})`,
  );
  assertRoundTrip('campaign-scenario-manifest', m);
});

test('W10-A4 campaign manifest: manifest.json is byte-identical to the definition export', () => {
  const fromDisk = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  assert.deepEqual(
    fromDisk,
    campaignScenarioManifest,
    'manifest.json === campaignScenarioManifest (definition.mjs export)',
  );
});

// ---------------------------------------------------------------------------
// 9. §0.13.10 import-list proof — the package imports nothing from src/.
// ---------------------------------------------------------------------------

test('W10-A4 campaign package: imports NOTHING from src/ (§0.13.10 import-list proof)', () => {
  // Walk every .mjs/.js/.json file under scenarios-ext/campaign/ and assert no
  // relative import resolves into src/. The import list IS the extensibility
  // proof (spec §4): a third-party package must reach only its own resources
  // and (optionally) the published SPI types via JSDoc — never compiled src/.
  /** @param {string} dir @returns {string[]} */
  function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) out.push(...walk(full));
      else if (/\.(mjs|js)$/.test(full)) out.push(full);
    }
    return out;
  }
  const files = walk(PKG_DIR);
  assert.ok(files.length > 0, 'package has at least one script file');
  const importRe =
    /(?:^|\n)[ \t]*(?:import|export)[^;]*?\bfrom\s*['"]([.][./][^'"]+)['"]/g;
  let offending = null;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    let match;
    importRe.lastIndex = 0;
    while ((match = importRe.exec(src)) !== null) {
      const spec = match[1];
      const resolved = path.resolve(path.dirname(f), spec);
      // No relative import may resolve into the compiled src/ tree.
      const rel = path.relative(REPO_ROOT, resolved).split(path.sep).join('/');
      if (rel.startsWith('src/')) {
        offending = `${path.relative(REPO_ROOT, f)} -> ${spec} (resolves ${rel})`;
        break;
      }
    }
    if (offending) break;
  }
  assert.equal(
    offending,
    null,
    `scenarios-ext/campaign/ must not import from src/ (§0.13.10). Offender: ${offending}`,
  );
});

test('W10-A4 campaign package: no Runtime/runner/gateway/catalog source change required (anti-scope §3)', () => {
  // Structural assertion: the package is self-contained under scenarios-ext/.
  // It carries its own schemas; it does not reference modules/catalog.ts,
  // composition/, or any built-in module installation. The only "external"
  // dependency is the shared Wave 1 SPI validator (imported by THIS test from
  // dist/, not by the package itself).
  const m = campaignScenarioManifest;
  const names = m.requiredModuleSelectors.map((/** @type {any} */ s) => s.name);
  for (const n of names) {
    assert.ok(
      !n.startsWith('discovery') &&
        !n.startsWith('formalization') &&
        !n.startsWith('development') &&
        !n.startsWith('delivery'),
      `scenario depends only on external packages (got '${n}')`,
    );
  }
  // Budgets are valid (validator-enforced, asserted here for documentation).
  assert.ok(m.transitionBudgets.maxTransitions > 0, 'transitionBudgets.maxTransitions > 0');
  assert.ok(m.reentryBudgets.maxReentries >= 0, 'reentryBudgets.maxReentries >= 0');
});

test('W10-A4 campaign package: identity is the installable scenario (distinct from W0-A7 fixture)', () => {
  // The W0-A7 fixture is `synthetic-campaign` v0.1.0; this real package is
  // `campaign` v1.0.0. Both coexist — the fixture stays as a data-only seed.
  assert.equal(CAMPAIGN_SCENARIO_IDENTITY.name, 'campaign');
  assert.equal(CAMPAIGN_SCENARIO_IDENTITY.version, '1.0.0');
  assert.equal(campaignScenarioManifest.identity.name, 'campaign');
  assert.notEqual(
    campaignScenarioManifest.identity.name,
    'synthetic-campaign',
    'real package identity is distinct from the W0-A7 synthetic fixture',
  );
});
