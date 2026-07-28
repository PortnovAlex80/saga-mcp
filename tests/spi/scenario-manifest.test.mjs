// @ts-check
/**
 * W1-A3 — LifecycleScenarioManifest validator + round-trip tests.
 *
 * Covers plan §3.5 (canonical-serializable), §6.2 (manifest fields), §6.4
 * (NO routeResolver — structural absence), §6.9.5 (safe mapping paths),
 * §0.4.11 (serial gate + round-trip).
 *
 * Run: `node --test tests/spi/scenario-manifest.test.mjs` (after `npm run build`).
 *
 * The positive case maps the W0-A7 `campaign` fixture (a
 * LifecycleDefinition-SHAPED plain object) into the manifest shape by adding
 * the genuinely-new fields: per-stage `moduleSelector` (derived from each
 * stage's `moduleRef`), `scenarioPolicies`, budgets, and ContractRefs. The
 * fixture already satisfies §6.4 (no routeResolver) and §6.3.5 (complete
 * static route tables).
 *
 * Negative cases prove REJECTION of every rule:
 *   - routeResolver key present (§6.4)
 *   - entry stage missing
 *   - outcome route to nonexistent stage
 *   - empty terminalStatuses
 *   - unsafe mapping path (__proto__)
 *   - function / Map / Set / Symbol in any field (§3.5)
 *   - maxTransitions <= 0
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  campaignScenario,
  CAMPAIGN_SCENARIO_IDENTITY,
  CAMPAIGN_SCENARIO_INPUT_SCHEMA,
  CAMPAIGN_SCENARIO_OUTPUT_SCHEMA,
  campaignModuleRefs,
} from '../fixtures/synthetic-scenarios/campaign/definition.mjs';

// Built output (npm run build produces ESM .js mirroring src/ layout).
import { validateLifecycleScenarioManifest, isSafeMappingPath } from
  '../../dist/process-modules/domain/spi/scenario-manifest.js';
import { canonicalJson, sha256Hex } from
  '../../dist/process-modules/shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Helpers — build a manifest-shaped object from the W0-A7 campaign fixture.
// ---------------------------------------------------------------------------

/**
 * Build a ContractRef-shaped object. The real ContractRef type lives in W1-A5
 * (`./contract-ref.js`); here we only need the { schemaId; version; digest }
 * shape for canonical-serializable + structural validation.
 */
function contractRef(schemaId) {
  return {
    schemaId,
    version: '1.0.0',
    digest: sha256Hex({ schemaId, stub: 'w1-a3-test' }),
  };
}

/** Derive a ModuleSelector from a stage's moduleRef { name; version }. */
function selectorFromModuleRef(moduleRef) {
  return {
    name: moduleRef.name,
    // Pin to the exact version the fixture validated against (caret range).
    versionRange: `^${moduleRef.version}`,
  };
}

/**
 * Map the W0-A7 campaign fixture (LifecycleDefinition-shaped) into the
 * LifecycleScenarioManifest shape. Adds the genuinely-new fields; copies
 * reused fields verbatim.
 */
function buildCampaignManifest() {
  // Map each fixture stage (plain StageBinding) into a ScenarioStageBinding
  // by adding the derived moduleSelector.
  const stageBindings = campaignScenario.stages.map((s) => ({
    ...s,
    moduleSelector: selectorFromModuleRef(s.moduleRef),
  }));

  return {
    manifestFormatVersion: campaignScenario.manifestFormatVersion,
    identity: CAMPAIGN_SCENARIO_IDENTITY,
    inputContractRef: contractRef(CAMPAIGN_SCENARIO_INPUT_SCHEMA),
    outputContractRef: contractRef(CAMPAIGN_SCENARIO_OUTPUT_SCHEMA),
    entryStageId: campaignScenario.entryStageId,
    stageBindings,
    // Scenario-level outcome routes: the campaign has no scenario-level
    // routes (every terminal handoff is declared per-stage), so this is the
    // empty deterministic table.
    outcomeRoutes: {},
    inputMappings: {
      initiative: 'initiative',
    },
    outputMappings: {},
    terminalStatuses: campaignScenario.terminalStatuses,
    scenarioPolicies: {
      retry: { kind: 'fixed-backoff', params: { maxAttempts: 3 } },
      pause: { kind: 'manual' },
      cancellation: { kind: 'explicit' },
      escalation: { kind: 'human' },
    },
    requiredModuleSelectors: campaignModuleRefs.map(selectorFromModuleRef),
    transitionBudgets: { maxTransitions: 50 },
    reentryBudgets: { maxReentries: 0 },
    // NOTE: no routeResolver key anywhere — proves §6.4.
  };
}

// ---------------------------------------------------------------------------
// Positive tests.
// ---------------------------------------------------------------------------

test('W1-A3 positive: campaign fixture maps into a valid manifest', () => {
  const manifest = buildCampaignManifest();
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, true, `expected ok, got errors: ${JSON.stringify(result.errors)}`);
  assert.equal(result.errors.length, 0);
});

test('W1-A3 positive: manifest round-trips through canonical JSON', () => {
  const manifest = buildCampaignManifest();
  const json = canonicalJson(manifest);
  const reparsed = JSON.parse(json);
  // Re-validate the round-tripped object — it must still pass.
  const result = validateLifecycleScenarioManifest(reparsed);
  assert.equal(result.ok, true, `round-tripped manifest failed validation: ${JSON.stringify(result.errors)}`);
  // Deep-equal the two manifests (canonical both ways).
  assert.deepEqual(reparsed, JSON.parse(canonicalJson(manifest)));
});

test('W1-A3 positive: sha256Hex of the manifest is stable across calls', () => {
  const manifest = buildCampaignManifest();
  const h1 = sha256Hex(manifest);
  const h2 = sha256Hex(manifest);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64);
});

test('W1-A3 positive: isSafeMappingPath accepts normal paths, rejects unsafe segments', () => {
  assert.equal(isSafeMappingPath('stages.draft.output.campaignDraft'), true);
  assert.equal(isSafeMappingPath('initiative.brief'), true);
  assert.equal(isSafeMappingPath('a'), true);
  // Non-string expressions (object-shaped mappings) are not paths: pass through.
  assert.equal(isSafeMappingPath({ literal: 'x' }), true);
  assert.equal(isSafeMappingPath(undefined), true);
  // Unsafe segments.
  assert.equal(isSafeMappingPath('stages.__proto__.x'), false);
  assert.equal(isSafeMappingPath('prototype'), false);
  assert.equal(isSafeMappingPath('a.constructor.b'), false);
  assert.equal(isSafeMappingPath(''), false);
  assert.equal(isSafeMappingPath('a..b'), false);
});

// ---------------------------------------------------------------------------
// Negative tests — structural rules.
// ---------------------------------------------------------------------------

test('W1-A3 negative: rejects routeResolver key present (§6.4)', () => {
  const manifest = buildCampaignManifest();
  // Attach a routeResolver key — even a null/undefined value triggers rejection
  // because the rule is structural absence of the KEY, not just the function.
  const withResolver = { ...manifest, routeResolver: () => ({ type: 'terminal', status: 'x' }) };
  const result = validateLifecycleScenarioManifest(withResolver);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.code === 'ROUTE_RESOLVER_FORBIDDEN'),
    `expected ROUTE_RESOLVER_FORBIDDEN, got: ${JSON.stringify(result.errors)}`,
  );
});

test('W1-A3 negative: rejects routeResolver key present even when value is null (§6.4)', () => {
  const manifest = buildCampaignManifest();
  const withNullResolver = { ...manifest, routeResolver: null };
  const result = validateLifecycleScenarioManifest(withNullResolver);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'ROUTE_RESOLVER_FORBIDDEN'));
});

test('W1-A3 negative: rejects entry stage missing', () => {
  const manifest = buildCampaignManifest();
  const bad = { ...manifest, entryStageId: 'no-such-stage' };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'ENTRY_STAGE_MISSING'));
});

test('W1-A3 negative: rejects outcome route to nonexistent stage', () => {
  const manifest = buildCampaignManifest();
  // Mutate the first stage's outcome route to point at a stage that does not exist.
  const bad = {
    ...manifest,
    stageBindings: manifest.stageBindings.map((s, i) =>
      i === 0
        ? {
            ...s,
            outcomeRoutes: {
              'campaign-drafted': { type: 'stage', stageId: 'ghost-stage' },
            },
          }
        : s,
    ),
  };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) => e.code === 'OUTCOME_ROUTE_TARGET_INVALID' && e.path.includes('outcomeRoutes'),
    ),
    `expected OUTCOME_ROUTE_TARGET_INVALID, got: ${JSON.stringify(result.errors)}`,
  );
});

test('W1-A3 negative: rejects outcome route to undeclared terminal status', () => {
  const manifest = buildCampaignManifest();
  const bad = {
    ...manifest,
    outcomeRoutes: {
      done: { type: 'terminal', status: 'not-declared' },
    },
  };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'OUTCOME_ROUTE_TARGET_INVALID'));
});

test('W1-A3 negative: rejects empty terminalStatuses', () => {
  const manifest = buildCampaignManifest();
  const bad = { ...manifest, terminalStatuses: [] };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'TERMINAL_STATUSES_EMPTY'));
});

test('W1-A3 negative: rejects unsafe mapping path (__proto__) at scenario level', () => {
  const manifest = buildCampaignManifest();
  const bad = {
    ...manifest,
    inputMappings: { evil: 'stages.__proto__.polluted' },
  };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'UNSAFE_MAPPING_PATH'));
});

test('W1-A3 negative: rejects unsafe mapping path (constructor) at stage level', () => {
  const manifest = buildCampaignManifest();
  const bad = {
    ...manifest,
    stageBindings: manifest.stageBindings.map((s, i) =>
      i === 0
        ? { ...s, inputMapping: { x: 'a.constructor.b' } }
        : s,
    ),
  };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'UNSAFE_MAPPING_PATH'));
});

test('W1-A3 negative: rejects maxTransitions <= 0 (structural) and NaN/Infinity (canonical)', () => {
  const manifest = buildCampaignManifest();
  // Structural budget violations: finite numbers that are out of range, or
  // wrong-typed values, surface as TRANSITION_BUDGET_INVALID.
  for (const badValue of [0, -1, '5']) {
    const bad = { ...manifest, transitionBudgets: { maxTransitions: badValue } };
    const result = validateLifecycleScenarioManifest(bad);
    assert.equal(result.ok, false, `expected fail for maxTransitions=${String(badValue)}`);
    assert.ok(
      result.errors.some((e) => e.code === 'TRANSITION_BUDGET_INVALID'),
      `expected TRANSITION_BUDGET_INVALID for ${String(badValue)}, got: ${JSON.stringify(result.errors)}`,
    );
  }
  // Value-level canonical violations: NaN / Infinity are non-finite numbers,
  // rejected by the §3.5 canonical gate before the budget rule runs.
  for (const badValue of [NaN, Infinity]) {
    const bad = { ...manifest, transitionBudgets: { maxTransitions: badValue } };
    const result = validateLifecycleScenarioManifest(bad);
    assert.equal(result.ok, false, `expected fail for maxTransitions=${String(badValue)}`);
    assert.ok(
      result.errors.some((e) => e.code === 'NOT_CANONICAL_SERIALIZABLE'),
      `expected NOT_CANONICAL_SERIALIZABLE for ${String(badValue)}, got: ${JSON.stringify(result.errors)}`,
    );
  }
});

test('W1-A3 negative: rejects maxReentries < 0', () => {
  const manifest = buildCampaignManifest();
  const bad = { ...manifest, reentryBudgets: { maxReentries: -1 } };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'REENTRY_BUDGET_INVALID'));
});

test('W1-A3 positive: maxReentries === 0 is accepted (boundary)', () => {
  const manifest = buildCampaignManifest();
  // Already 0 from the builder; assert it passes.
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Negative tests — canonical serializability (plan §3.5).
// ---------------------------------------------------------------------------

test('W1-A3 negative: rejects a function in any field (§3.5)', () => {
  const manifest = buildCampaignManifest();
  const bad = { ...manifest, identity: { ...manifest.identity, description: () => 'boom' } };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.code === 'NOT_CANONICAL_SERIALIZABLE'),
    `expected NOT_CANONICAL_SERIALIZABLE, got: ${JSON.stringify(result.errors)}`,
  );
});

test('W1-A3 negative: rejects a Map in any field (§3.5)', () => {
  const manifest = buildCampaignManifest();
  const bad = { ...manifest, inputMappings: new Map([['k', 'v']]) };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'NOT_CANONICAL_SERIALIZABLE'));
});

test('W1-A3 negative: rejects a Set in any field (§3.5)', () => {
  const manifest = buildCampaignManifest();
  const bad = { ...manifest, terminalStatuses: new Set(['campaign-approved']) };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'NOT_CANONICAL_SERIALIZABLE'));
});

test('W1-A3 negative: rejects undefined inside an array (§3.5)', () => {
  const manifest = buildCampaignManifest();
  const bad = { ...manifest, terminalStatuses: ['campaign-approved', undefined] };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'NOT_CANONICAL_SERIALIZABLE'));
});

test('W1-A3 negative: rejects a Symbol in any field (§3.5)', () => {
  const manifest = buildCampaignManifest();
  const bad = { ...manifest, manifestFormatVersion: Symbol('x') };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'NOT_CANONICAL_SERIALIZABLE'));
});

test('W1-A3 negative: rejects a non-finite number (NaN) in budgets (§3.5)', () => {
  const manifest = buildCampaignManifest();
  // NaN is non-finite — caught by the canonical check first.
  const bad = { ...manifest, transitionBudgets: { maxTransitions: NaN } };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  // Either NOT_CANONICAL_SERIALIZABLE (canonical check) or TRANSITION_BUDGET_INVALID.
  assert.ok(
    result.errors.some(
      (e) => e.code === 'NOT_CANONICAL_SERIALIZABLE' || e.code === 'TRANSITION_BUDGET_INVALID',
    ),
  );
});

test('W1-A3 negative: rejects a class instance (not plain object) (§3.5)', () => {
  const manifest = buildCampaignManifest();
  class FakeIdentity {}
  const bad = { ...manifest, identity: new FakeIdentity() };
  const result = validateLifecycleScenarioManifest(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'NOT_CANONICAL_SERIALIZABLE'));
});

// ---------------------------------------------------------------------------
// Structural-absence-of-routeResolver: a manifest object literal must not even
// type-check with a routeResolver key (compile-time). At runtime, the
// validator is the guard. This test asserts the runtime guard one more way:
// even an extra unknown key like `executor` is fine (it's plain data), but
// `routeResolver` specifically is rejected by name.
// ---------------------------------------------------------------------------

test('W1-A3 negative: routeResolver is rejected by key name even if other extra keys are tolerated', () => {
  const manifest = buildCampaignManifest();
  // An extra plain-data key is NOT a structural violation per se — it survives
  // canonical serialization. The validator does not whitelist unknown keys in
  // general (Wave 1 only outlaws routeResolver by §6.4). We assert the
  // routeResolver key specifically flips the result.
  const withExtraPlain = { ...manifest, debugLabel: 'campaign-v1' };
  assert.equal(validateLifecycleScenarioManifest(withExtraPlain).ok, true);
  const withResolver = { ...manifest, routeResolver: undefined };
  const r = validateLifecycleScenarioManifest(withResolver);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'ROUTE_RESOLVER_FORBIDDEN'));
});
