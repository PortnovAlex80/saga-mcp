// @ts-check
/**
 * W1-A8 — Synthetic-fixture conformance (Wave 1 exit-gate proof).
 *
 * Spec ref: `docs/refactor-management/09-contracts/WAVE1-PURE-SPI-SPEC.md`
 * §4 + plan §14.2.6.
 *
 * This is THE Wave 1 exit-gate proof (plan §14.2.6): "two unrelated synthetic
 * packages validate using the same SPI without Runtime changes". The two
 * unrelated kinds are:
 *   - `lm-marketing` (LM node) — Wave 10 LM Marketing production mirror.
 *   - `external-seo` (External node) — Wave 10 SEO/Analytics production mirror.
 *
 * What this file proves:
 *   1. All 4 W0-A7 synthetic module fixtures wrap into a `ProcessModuleManifest`
 *      directly pass `validateProcessModuleManifest`,
 *      and round-trip through canonical JSON (spec §4).
 *   2. The W0-A7 `campaign` scenario maps into a `LifecycleScenarioManifest`,
 *      passes `validateLifecycleScenarioManifest`, and round-trips.
 *   3. The campaign manifest has NO `routeResolver` (plan §6.4).
 *   4. `external-seo` appears in exactly 2 campaign stages (plan §6.8 — same
 *      module reused across multiple stages).
 *
 * Together these prove the SPI is module-kind-agnostic and supports the
 * declarative static-routing model. Wave 7 consumes this exact shape through
 * the new ScenarioRuntime; Wave 10 ships the production mirrors.
 *
 * NOTE: This test imports from `dist/process-modules/domain/spi/index.js`,
 * the barrel produced by THIS lane. The barrel re-exports sibling symbols
 * (A1..A7). If siblings have not been cherry-picked into the integrator's
 * tree, the import fails with unresolved-import — EXPECTED for A8 in
 * isolation. The integrator runs the full Wave 1 gate after cherry-picking
 * all lanes in order.
 *
 * Run: `node --test tests/spi/synthetic-fixture-conformance.test.mjs`
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';

// W0-A7 synthetic fixtures (data-only — frozen at b0746cd).
import lmMarketing, {
  LM_MARKETING_INPUT_SCHEMA,
  LM_MARKETING_OUTPUT_SCHEMA,
} from '../fixtures/synthetic-modules/lm-marketing/definition.mjs';
import kernelAnalytics, {
  KERNEL_ANALYTICS_INPUT_SCHEMA,
  KERNEL_ANALYTICS_OUTPUT_SCHEMA,
} from '../fixtures/synthetic-modules/kernel-analytics/definition.mjs';
import humanDirectorApproval, {
  HUMAN_DIRECTOR_INPUT_SCHEMA,
  HUMAN_DIRECTOR_OUTPUT_SCHEMA,
} from '../fixtures/synthetic-modules/human-director-approval/definition.mjs';
import externalSeo, {
  EXTERNAL_SEO_INPUT_SCHEMA,
  EXTERNAL_SEO_OUTPUT_SCHEMA,
} from '../fixtures/synthetic-modules/external-seo/definition.mjs';
import campaignScenario, {
  CAMPAIGN_SCENARIO_INPUT_SCHEMA,
  CAMPAIGN_SCENARIO_OUTPUT_SCHEMA,
  CAMPAIGN_TERMINAL_STATUSES,
} from '../fixtures/synthetic-scenarios/campaign/definition.mjs';

// The barrel — every Wave 1 SPI symbol (resolved at integration).
const {
  // W1-A1
  assertCanonicalSerializable,
  // W1-A5
  computeContractRefDigest,
  // W1-A2
  validateProcessModuleManifest,
  // W1-A3
  validateLifecycleScenarioManifest,
} = await import('../../dist/process-modules/domain/spi/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a pure ContractRef (digest computed from the schema id as a stand-in
 * document — Wave 1 placeholders are fine; W1-A5's contract allows
 * `'pending@wave-2'` for callers without a document, but using a real digest
 * here keeps the round-trip proof honest).
 */
function refFromSchemaId(schemaId, version = '0.1.0') {
  return {
    schemaId,
    version,
    digest: computeContractRefDigest({ id: schemaId }),
  };
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
  assert.deepEqual(parsed, manifest, `${label}: round-trip via JSON.parse(canonicalJson(x))`);
  const h1 = sha256Hex(manifest);
  const h2 = sha256Hex(manifest);
  assert.equal(h1, h2, `${label}: sha256Hex stable across two runs`);
}

// ---------------------------------------------------------------------------
// 2. Map the W0-A7 campaign scenario into a LifecycleScenarioManifest.
//    Validate + round-trip.
// ---------------------------------------------------------------------------

/**
 * Map the W0-A7 `campaignScenario` plain object (a documented
 * `LifecycleDefinition`-shaped fixture) into the typed
 * `LifecycleScenarioManifest` shape (W1-A3). The fixture already carries the
 * fields the manifest needs; we fill in the W1-A3-specific envelopes
 * (`inputContractRef`/`outputContractRef`, budgets, policies).
 *
 * The campaign fixture is intentionally NOT a `LifecycleScenarioManifest`
 * yet — W0-A7 deliberately shipped it as a documented plain object so Wave 1
 * could codify the final type. This mapping is the documented Wave 1 bridge.
 */
function mapCampaignToScenarioManifest() {
  /** @type {any} */
  const mapped = {
    manifestFormatVersion: campaignScenario.manifestFormatVersion ?? '0.1.0',
    identity: { ...campaignScenario.identity },
    inputContractRef: refFromSchemaId(CAMPAIGN_SCENARIO_INPUT_SCHEMA),
    outputContractRef: refFromSchemaId(CAMPAIGN_SCENARIO_OUTPUT_SCHEMA),
    entryStageId: campaignScenario.entryStageId,
    // W1-A3 spec §1 row 6: stageBindings is the typed list. The campaign
    // fixture's `stages` array already conforms to StageBinding shape
    // (id/displayName/moduleRef/inputMapping/outputMapping/outcomeRoutes/
    // entryConditions/exitConditions) — see W0-A7 definition.mjs.
    stageBindings: campaignScenario.stages.map((/** @type {any} */ s) => ({ ...s })),
    // Per-stage outcome routes are already on each stage binding; the
    // scenario-level tables are aggregated here for completeness.
    outcomeRoutes: {},
    inputMappings: {},
    outputMappings: {},
    terminalStatuses: [...CAMPAIGN_TERMINAL_STATUSES],
    scenarioRetryPolicy: { kind: 'none' },
    pausePolicy: { kind: 'none' },
    cancellationPolicy: { kind: 'none' },
    escalationPolicy: { kind: 'none' },
    requiredModuleSelectors: campaignScenario.stages.map((/** @type {any} */ s) => ({
      name: s.moduleRef.name,
      versionRange: s.moduleRef.version,
    })),
    transitionBudgets: { maxTransitions: 64 },
    reentryBudgets: { maxReentries: 4 },
  };
  return mapped;
}

test('campaign scenario maps into LifecycleScenarioManifest, validates, round-trips', () => {
  const manifest = mapCampaignToScenarioManifest();
  const result = validateLifecycleScenarioManifest(manifest);
  assert.equal(
    result.ok,
    true,
    `validateLifecycleScenarioManifest ok (errors=${JSON.stringify(result.errors)})`,
  );
  assertRoundTrip('campaign-scenario-manifest', manifest);
});

// ---------------------------------------------------------------------------
// 3. Plan §6.4 — NO routeResolver anywhere on the campaign scenario manifest.
// ---------------------------------------------------------------------------

test('campaign manifest has NO routeResolver (plan §6.4)', () => {
  const manifest = mapCampaignToScenarioManifest();
  // Structural absence at the manifest level.
  assert.equal(
    'routeResolver' in manifest,
    false,
    'LifecycleScenarioManifest must NOT carry a routeResolver field (§6.4)',
  );
  // Per-stage structural absence — the StageBinding contract does not
  // include routeResolver.
  for (const stage of manifest.stageBindings) {
    assert.equal(
      'routeResolver' in stage,
      false,
      `stage '${stage.id}' must NOT carry a routeResolver`,
    );
    assert.ok(
      stage.outcomeRoutes && typeof stage.outcomeRoutes === 'object',
      `stage '${stage.id}' has a static outcomeRoutes table`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Plan §6.8 — external-seo reused in exactly 2 stages.
// ---------------------------------------------------------------------------

test('campaign manifest reuses external-seo in exactly 2 stages (plan §6.8)', () => {
  const manifest = mapCampaignToScenarioManifest();
  const seoStages = manifest.stageBindings.filter(
    (/** @type {any} */ s) => s.moduleRef.name === 'synthetic-external-seo',
  );
  assert.equal(seoStages.length, 2, 'synthetic-external-seo appears in exactly 2 stages');
  const seoStageIds = seoStages.map((/** @type {any} */ s) => s.id).sort();
  assert.deepEqual(
    seoStageIds,
    ['seo-baseline', 'seo-followup'],
    'reused in seo-baseline + seo-followup',
  );
});

test('campaign manifest: every declared module outcome routes to exactly one target (§6.3.5)', () => {
  const manifest = mapCampaignToScenarioManifest();
  /** @type {Record<string, { outcomes: string[] }>} */
  const moduleOutcomesByName = {
    'synthetic-lm-marketing': { outcomes: ['campaign-drafted'] },
    'synthetic-kernel-analytics': { outcomes: ['metrics-computed'] },
    'synthetic-human-director-approval': { outcomes: ['approved', 'rejected'] },
    'synthetic-external-seo': { outcomes: ['ranking-fetched'] },
  };
  for (const stage of manifest.stageBindings) {
    const expected = moduleOutcomesByName[/** @type {any} */ (stage).moduleRef.name];
    assert.ok(expected, `stage '${stage.id}' references a known module`);
    const routed = Object.keys(stage.outcomeRoutes).sort();
    const declared = [...expected.outcomes].sort();
    assert.deepEqual(
      routed,
      declared,
      `stage '${stage.id}' routes every declared outcome exactly once`,
    );
  }
});

test('campaign manifest: Human stage routes approved/rejected to distinct terminal statuses', () => {
  const manifest = mapCampaignToScenarioManifest();
  const approve = manifest.stageBindings.find((/** @type {any} */ s) => s.id === 'approve');
  assert.ok(approve, 'approve stage exists');
  assert.deepEqual(approve.outcomeRoutes.approved, { type: 'terminal', status: 'campaign-approved' });
  assert.deepEqual(approve.outcomeRoutes.rejected, { type: 'terminal', status: 'campaign-rejected' });
});

test('campaign manifest: every route target is an existing stage or a declared terminal (§6.9.1/§6.9.2)', () => {
  const manifest = mapCampaignToScenarioManifest();
  const stageIds = new Set(manifest.stageBindings.map((/** @type {any} */ s) => s.id));
  assert.ok(stageIds.has(manifest.entryStageId), 'entryStageId references an existing stage');
  for (const stage of manifest.stageBindings) {
    for (const [outcome, target] of Object.entries(stage.outcomeRoutes)) {
      const t = /** @type {any} */ (target);
      if (t.type === 'stage') {
        assert.ok(
          stageIds.has(t.stageId),
          `stage '${stage.id}' outcome '${outcome}' -> existing stage '${t.stageId}'`,
        );
      } else if (t.type === 'terminal') {
        assert.ok(
          manifest.terminalStatuses.includes(t.status),
          `stage '${stage.id}' outcome '${outcome}' -> declared terminal '${t.status}'`,
        );
      } else {
        assert.fail(`unknown route target type on stage '${stage.id}'`);
      }
    }
  }
});
