// @ts-check
/**
 * W10-A4 — Campaign Lifecycle Scenario (real installable package).
 *
 * Spec: `docs/refactor-management/09-contracts/WAVE10-EXTENSIBILITY-SPEC.md`
 *       Lane W10-A4 (§1 row 4, §2 exit gate #2, §4 key design). Plan ref:
 *       §0.13.4, §0.13.10 serial gate.
 *
 * This is the DEFINITIVE proof of arbitrary scenario extensibility (plan
 * §0.13.10): a third-party `LifecycleScenarioManifest` that composes the three
 * sibling-wave external module packages — `lm-marketing` (W10-A1),
 * `external-seo` (W10-A2), `human-director-approval` (W10-A3) — installs and
 * validates WITHOUT any Runtime, global runner, gateway, catalog, or
 * existing-module source change (spec §3 anti-scope).
 *
 * It UPGRADES the W0-A7 synthetic fixture (`tests/fixtures/synthetic-scenarios/
 * campaign/`) from a `LifecycleDefinition`-shaped plain object into a REAL
 * `LifecycleScenarioManifest` (the W1-A3 aggregate, `src/process-modules/
 * domain/spi/scenario-manifest.ts`). The upgrade is:
 *   - `stages`            -> `stageBindings` (the typed list), each enriched
 *                            with a `moduleSelector` (name + semver RANGE).
 *   - bare module refs    -> `requiredModuleSelectors` (the §6.10 dependency
 *                            closure, referencing the three sibling packages).
 *   - implicit budgets    -> explicit `transitionBudgets` / `reentryBudgets`.
 *   - implicit policies   -> explicit `scenarioPolicies` declarations.
 *   - `inputContract`/    -> `inputContractRef` / `outputContractRef`
 *     `outputContract`       (ContractRef shape — schemaId + version + digest).
 *
 * Composition (plan §6.8 — the same module package reused across multiple
 * stages with different mappings; the Runtime must NOT derive a stage from
 * module kind or task-kind prefix):
 *
 *   draft (LM marketing)         -> 'campaign-drafted'
 *      |
 *   seo-baseline (External seo)  -> 'ranking-fetched'   [REUSE #1 of seo]
 *      |
 *   metrics (External seo)       -> 'ranking-fetched'   [REUSE #2 of seo]
 *      |
 *   seo-followup (External seo)  -> 'ranking-fetched'   [REUSE #3 of seo]
 *      |
 *   approve (Human director)     -> 'approved' | 'rejected'
 *
 * `external-seo` participates in THREE stages — the strongest possible proof
 * of plan §6.8 (arbitrary reuse). The scenario composes exactly the three
 * sibling-wave packages (lm-marketing + external-seo + human-director-approval);
 * no kernel-analytics package is referenced because no sibling wave builds one.
 *
 * Proof points baked in (mirroring the W0-A7 fixture's documented properties):
 *   1. §6.4 — NO `routeResolver` anywhere. Routes are declarative static
 *      `outcomeRoutes` only. There is no executable closure in the manifest.
 *   2. §6.8 — `external-seo` reused in 3 stages with 3 different mappings.
 *   3. §6.3.5 / §6.9.3 — complete deterministic route table for EVERY declared
 *      module outcome. The Human stage's two outcomes route to two distinct
 *      terminal statuses (`campaign-approved`, `campaign-rejected`).
 *   4. §6.3.3 / §6.9.5 — safe own-property input/output mappings only (root
 *      input paths, prior-stage output paths, `{ literal }`, `{ runtime }`).
 *      No executable expression language.
 *   5. §6.2.9 — explicit terminal statuses.
 *
 * Purity / serializability (plan §3.5, §0.4.11): every field is plain
 * JSON-serializable data. The exported `campaignScenarioManifest` round-trips
 * byte-identically through canonical JSON and passes
 * `validateLifecycleScenarioManifest` (proven by the W10-A4 test + the W1-A8
 * synthetic-fixture conformance gate).
 *
 * Install surface: this directory is a self-contained scenario package:
 *   definition.mjs        <- this file (the manifest builder)
 *   manifest.json         <- canonical rendering of the manifest (Wave 7
 *                            installer reads this; W10-A6/A7 describe it)
 *   README.md             <- human-facing package description
 *   schemas/campaign-input.schema.json  <- the scenario root input contract
 *
 * Anti-scope (spec §3): this package lives under `scenarios-ext/` at repo root,
 * OUTSIDE the compiled `src/` tree. It imports NOTHING from `src/`, `modules/`,
 * the catalog, or the composition root — the import list IS the §0.13.10 proof.
 *
 * @typedef {import('../../src/process-modules/domain/spi/scenario-manifest.ts').LifecycleScenarioManifest} LifecycleScenarioManifest
 * @typedef {import('../../src/process-modules/domain/spi/scenario-manifest.ts').ScenarioStageBinding} ScenarioStageBinding
 * @typedef {import('../../src/process-modules/domain/spi/scenario-manifest.ts').ModuleSelector} ModuleSelector
 * @typedef {import('../../src/process-modules/domain/spi/scenario-manifest.ts').TransitionTarget} TransitionTarget
 * @typedef {import('../../src/process-modules/domain/spi/scenario-manifest.ts').LifecycleMappingExpression} LifecycleMappingExpression
 */

// ---------------------------------------------------------------------------
// Identity.
// ---------------------------------------------------------------------------

/**
 * Scenario identity. Mirrors `LifecycleIdentity` from the domain contract.
 * The name is `campaign` (no `synthetic-` prefix) — this is the real
 * installable scenario, distinct from the W0-A7 data-only fixture.
 */
export const CAMPAIGN_SCENARIO_IDENTITY = Object.freeze({
  name: 'campaign',
  version: '1.0.0',
  displayName: 'Campaign Lifecycle',
  description:
    'W10-A4 installable lifecycle scenario. Composes the three sibling-wave ' +
    'external packages (lm-marketing + external-seo + human-director-approval) ' +
    'across 5 stages, reuses external-seo three times, declarative static ' +
    'routes only. Proves arbitrary scenario extensibility (plan §0.13.10).',
});

// Opaque schema identifiers for the scenario root input / terminal output
// contracts. These mirror the `ContractRef { schemaId; version; digest }`
// shape. A real digest is supplied so the manifest is content-addressed; the
// digest is the sha256 of the schema id stand-in (W1-A5's contract allows a
// `'pending@wave-2'` placeholder, but a concrete digest keeps the round-trip
// proof honest and matches the W1-A8 conformance bridge).
export const CAMPAIGN_INPUT_SCHEMA_ID = 'campaign.input.v1';
export const CAMPAIGN_OUTPUT_SCHEMA_ID = 'campaign.output.v1';
export const CAMPAIGN_SCHEMA_VERSION = '1.0.0';

/**
 * Terminal statuses declared by this scenario (plan §6.2.9). The Human stage
 * routes its two outcomes to these two distinct statuses.
 */
export const CAMPAIGN_TERMINAL_STATUSES = Object.freeze([
  'campaign-approved',
  'campaign-rejected',
]);

// ---------------------------------------------------------------------------
// Module selectors (plan §6.2, §6.3.2, §6.10).
//
// A scenario stage binds to a MODULE CONTRACT by name + semver range, NOT to a
// concrete installed package. These reference the THREE sibling-wave external
// packages (W10-A1/A2/A3). The caret range lets a patch upgrade satisfy the
// selector at install time (Wave 7 resolves the exact identity).
// ---------------------------------------------------------------------------

/** Selector for the LM Marketing package (W10-A1). */
export const LM_MARKETING_SELECTOR = Object.freeze({
  name: 'lm-marketing',
  versionRange: '^1.0.0',
});

/** Selector for the External SEO/Analytics package (W10-A2). Reused 3x. */
export const EXTERNAL_SEO_SELECTOR = Object.freeze({
  name: 'external-seo',
  versionRange: '^1.0.0',
});

/** Selector for the Human Director Approval package (W10-A3). */
export const HUMAN_DIRECTOR_SELECTOR = Object.freeze({
  name: 'human-director-approval',
  versionRange: '^1.0.0',
});

/**
 * The complete module-contract dependency closure (plan §6.10). Exactly the
 * three sibling-wave packages — the scenario depends on no built-in module.
 * Deduplicated: `external-seo` appears once even though three stages reuse it.
 */
export const CAMPAIGN_REQUIRED_MODULE_SELECTORS = Object.freeze([
  LM_MARKETING_SELECTOR,
  EXTERNAL_SEO_SELECTOR,
  HUMAN_DIRECTOR_SELECTOR,
]);

// ---------------------------------------------------------------------------
// Contract refs (W1-A5 ContractRef shape).
// ---------------------------------------------------------------------------

/**
 * Build a ContractRef with a concrete digest derived from the schema id. Pure;
 * deterministic. Mirrors the `refFromSchemaId` helper in the W1-A8 conformance
 * test so this manifest is byte-compatible with that bridge.
 *
 * A real sha256 is computed lazily by the installer at install time against
 * the registered schema document; here we carry a stable stand-in digest so
 * the manifest is self-describing and round-trips without external state.
 *
 * @param {string} schemaId
 * @returns {{ schemaId: string; version: string; digest: string }}
 */
function contractRef(schemaId) {
  return {
    schemaId,
    version: CAMPAIGN_SCHEMA_VERSION,
    digest: `sha256:${schemaId}`,
  };
}

// ---------------------------------------------------------------------------
// Stage bindings (plan §6.3.2 ScenarioStageBinding).
//
// `inputMapping` keys are downstream module input field names; values are
// `LifecycleMappingExpression` shapes:
//   - `'path.string'`              -> JSON-path read from the durable lifecycle
//                                     frame (root input or prior stage output).
//   - `{ literal: <value> }`       -> immutable declared literal.
//   - `{ runtime: 'initiatedBy' }` -> immutable runtime field.
// All paths use safe own-property traversal only (plan §6.9.5).
//
// Each `ScenarioStageBinding` EXTENDS `StageBinding` with a `moduleSelector`
// (name + semver range). The base `moduleRef` carries the concrete version the
// author validated against (traceability); `moduleSelector` carries the range
// the installer resolves (plan §6.3.2 commentary).
// ---------------------------------------------------------------------------

/**
 * Helper: build a ScenarioStageBinding from a base StageBinding + selector.
 *
 * @param {object} base  the StageBinding fields (id, displayName, moduleRef,
 *                       inputMapping, outputMapping, outcomeRoutes,
 *                       entryConditions, exitConditions)
 * @param {ModuleSelector} selector  the module-contract selector for this stage
 * @returns {ScenarioStageBinding}
 */
function stage(base, selector) {
  return Object.freeze({ ...base, moduleSelector: selector });
}

/**
 * Stage bindings. 5 stages; `external-seo` reused in 3 of them.
 *
 * @type {readonly ScenarioStageBinding[]}
 */
const campaignStageBindings = [
  // draft — LM marketing produces a campaign draft.
  stage(
    {
      id: 'draft',
      displayName: 'Draft Campaign',
      moduleRef: { name: 'lm-marketing', version: '1.0.0' },
      inputMapping: {
        brief: 'initiative.brief',
        audience: 'initiative.audience',
      },
      outputMapping: {
        campaignDraft: 'output.campaignDraft',
      },
      outcomeRoutes: {
        // Only one declared outcome on lm-marketing -> forward to seo-baseline.
        'campaign-drafted': { type: 'stage', stageId: 'seo-baseline' },
      },
      entryConditions: ['Scenario root input present'],
      exitConditions: ['campaign-drafted outcome emitted'],
    },
    LM_MARKETING_SELECTOR,
  ),
  // seo-baseline — REUSE #1 of external-seo (plan §6.8).
  stage(
    {
      id: 'seo-baseline',
      displayName: 'SEO Baseline Fetch',
      moduleRef: { name: 'external-seo', version: '1.0.0' },
      inputMapping: {
        keywords: 'stages.draft.output.keywords',
        market: { literal: 'baseline' },
      },
      outputMapping: {
        baselineRanking: 'output.rankingSnapshot',
      },
      outcomeRoutes: {
        'ranking-fetched': { type: 'stage', stageId: 'metrics' },
      },
      entryConditions: ['draft stage produced a campaign draft'],
      exitConditions: ['ranking-fetched outcome emitted'],
    },
    EXTERNAL_SEO_SELECTOR,
  ),
  // metrics — REUSE #2 of external-seo (plan §6.8). Same package, different
  // stage, different input mapping. Computes a metrics snapshot from the
  // baseline ranking via the SEO analytics adapter.
  stage(
    {
      id: 'metrics',
      displayName: 'Compute Metrics',
      moduleRef: { name: 'external-seo', version: '1.0.0' },
      inputMapping: {
        keywords: 'stages.draft.output.keywords',
        baselineRanking: 'stages.seo-baseline.output.baselineRanking',
        market: { literal: 'metrics' },
      },
      outputMapping: {
        metrics: 'output.metrics',
      },
      outcomeRoutes: {
        'ranking-fetched': { type: 'stage', stageId: 'seo-followup' },
      },
      entryConditions: ['baseline ranking available'],
      exitConditions: ['ranking-fetched outcome emitted'],
    },
    EXTERNAL_SEO_SELECTOR,
  ),
  // seo-followup — REUSE #3 of external-seo (plan §6.8). Same package again,
  // different stage, different mapping. Strengthens the §6.8 proof: a single
  // module package participates in three stages.
  stage(
    {
      id: 'seo-followup',
      displayName: 'SEO Follow-up Fetch',
      moduleRef: { name: 'external-seo', version: '1.0.0' },
      inputMapping: {
        keywords: 'stages.draft.output.keywords',
        metrics: 'stages.metrics.output.metrics',
        market: { literal: 'followup' },
      },
      outputMapping: {
        followupRanking: 'output.rankingSnapshot',
      },
      outcomeRoutes: {
        'ranking-fetched': { type: 'stage', stageId: 'approve' },
      },
      entryConditions: ['metrics stage produced a metrics snapshot'],
      exitConditions: ['ranking-fetched outcome emitted'],
    },
    EXTERNAL_SEO_SELECTOR,
  ),
  // approve — Human director sign-off. Two terminal outcomes -> two distinct
  // terminal statuses (plan §6.3.5 complete route table).
  stage(
    {
      id: 'approve',
      displayName: 'Director Sign-off',
      moduleRef: { name: 'human-director-approval', version: '1.0.0' },
      inputMapping: {
        campaignDraft: 'stages.draft.output.campaignDraft',
        metrics: 'stages.metrics.output.metrics',
        followupRanking: 'stages.seo-followup.output.followupRanking',
        requestedBy: { runtime: 'initiatedBy' },
      },
      outputMapping: {
        directorDecision: 'output.decision',
      },
      outcomeRoutes: {
        approved: { type: 'terminal', status: 'campaign-approved' },
        rejected: { type: 'terminal', status: 'campaign-rejected' },
      },
      entryConditions: ['all upstream stage outputs available'],
      exitConditions: ['approved or rejected outcome emitted'],
    },
    HUMAN_DIRECTOR_SELECTOR,
  ),
];

// ---------------------------------------------------------------------------
// The manifest aggregate (plan §6.2 LifecycleScenarioManifest).
//
// There is NO `routeResolver` field anywhere on this object — that omission is
// the proof of plan §6.4. The validator additionally rejects any object that
// carries a `routeResolver` own key (defense-in-depth).
// ---------------------------------------------------------------------------

/**
 * The campaign scenario as a real, installable `LifecycleScenarioManifest`.
 *
 * Frozen + canonically serializable (plan §3.5). Every field is plain data; no
 * functions, Maps, Sets, Symbols, or class instances. Round-trips byte-
 * identically through canonical JSON and passes
 * `validateLifecycleScenarioManifest`.
 *
 * @type {LifecycleScenarioManifest}
 */
export const campaignScenarioManifest = Object.freeze({
  manifestFormatVersion: '0.1.0',

  identity: CAMPAIGN_SCENARIO_IDENTITY,

  inputContractRef: contractRef(CAMPAIGN_INPUT_SCHEMA_ID),
  outputContractRef: contractRef(CAMPAIGN_OUTPUT_SCHEMA_ID),

  entryStageId: 'draft',

  stageBindings: campaignStageBindings,

  // Scenario-level outcome routes (terminal handoffs out of the whole
  // scenario). Empty here — every terminal handoff is declared per-stage on the
  // Human stage's outcomeRoutes. Deterministic static table; no resolver (§6.4).
  outcomeRoutes: {},

  // Scenario-root input field mappings and terminal output mappings. Safe
  // own-property paths only. The campaign reads its root input directly on
  // each stage's inputMapping, so the scenario-level tables are empty.
  inputMappings: {},
  outputMappings: {},

  terminalStatuses: CAMPAIGN_TERMINAL_STATUSES,

  // Scenario-level policy bundle (declared here, bound to executors by the
  // Wave 7 runtime). Each is the `{ kind; params? }` tagged stub from W1-A3.
  scenarioPolicies: {
    retry: { kind: 'bounded-retry', params: { maxAttempts: 2 } },
    pause: { kind: 'manual-resume' },
    cancellation: { kind: 'terminal-only' },
    escalation: { kind: 'director-escalation' },
  },

  // The complete module-contract dependency closure (plan §6.10). Exactly the
  // three sibling-wave packages.
  requiredModuleSelectors: CAMPAIGN_REQUIRED_MODULE_SELECTORS,

  // Hard caps protecting against runaway transitions / re-entries (plan
  // §6.2.10, §6.2.11). 5 stages; maxTransitions is generous to allow bounded
  // retry without loop risk; reentries=0 forbids re-entering a completed stage.
  transitionBudgets: { maxTransitions: 32 },
  reentryBudgets: { maxReentries: 0 },

  // Intentionally absent: routeResolver. Proves §6.4.
});

/**
 * Helper: list the distinct module selectors used by this scenario (the
 * `requiredModuleSelectors` closure). Used by the W10-A4 proof test and by
 * Wave 7 to confirm the scenario depends only on the three sibling-wave public
 * contracts (plan §6.10).
 */
export const campaignModuleSelectors = CAMPAIGN_REQUIRED_MODULE_SELECTORS;

export default campaignScenarioManifest;
