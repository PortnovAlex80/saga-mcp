// @ts-check
/**
 * W0-A7 synthetic fixture: Campaign Lifecycle Scenario.
 *
 * Data-only fixture describing a `LifecycleScenarioManifest`-SHAPED plain
 * object. The final `LifecycleScenarioManifest` TypeScript type does NOT exist
 * yet — it is Wave 1's serial work (W1-A3, plan §0.4.5). This fixture is a
 * documented plain object mirroring plan §6.2 and the existing `StageBinding`
 * shape from `src/process-modules/domain/lifecycle.ts`. Wave 1 will codify the
 * type; until then this fixture deliberately stays a plain documented object.
 *
 * CRITICAL proof points baked into this fixture:
 *
 * 1. §6.4 — NO `routeResolver` function. Routes are declarative static
 *    `outcomeRoutes` only. The Runtime must look up the target from the static
 *    table; there is no executable closure anywhere in this manifest.
 *
 * 2. §6.8 — `synthetic-external-seo` is REUSED in two stages
 *    (`seo-baseline` and `seo-followup`). The Runtime must not derive a stage
 *    from module kind or task-kind prefix; the same module package legitimately
 *    participates in multiple stages with different input/output mappings.
 *
 * 3. §6.3.5 / §6.9.3 — Every declared module outcome has exactly one
 *    deterministic static route. The Human stage's two outcomes
 *    (`approved` / `rejected`) route to two different terminal statuses.
 *
 * 4. §6.3.3 / §6.9.5 — Each stage has typed input/output mappings using only
 *    safe own-property paths (root-input paths, prior-stage output paths, and
 *    immutable runtime fields). No executable expression language.
 *
 * 5. §6.2.9 — Explicit terminal statuses (`campaign-approved`,
 *    `campaign-rejected`).
 *
 * Stages:
 *   draft (LM marketing)            -> 'campaign-drafted'
 *      |
 *   seo-baseline (External seo)     -> 'ranking-fetched'    [reuse #1 of seo]
 *      |
 *   compute (Kernel analytics)      -> 'metrics-computed'
 *      |
 *   seo-followup (External seo)     -> 'ranking-fetched'    [reuse #2 of seo]
 *      |
 *   approve (Human director)        -> 'approved' | 'rejected'
 *
 * Proof target:
 *   - Wave 7 Lifecycle Scenario Runtime (install + execute with NO Runtime
 *     changes — plan §0.10.12).
 *   - Wave 10 Campaign Lifecycle production scenario mirrors this shape
 *     (plan §0.13.4, §0.13.10).
 *
 * Plan ref: §0.3.8, §6.2, §6.3, §6.4, §6.8, §6.9, §14.1.4, §15.11.
 *
 * @typedef {import('../../../../src/process-modules/domain/lifecycle.ts').StageBinding} StageBinding
 * @typedef {import('../../../../src/process-modules/domain/lifecycle.ts').LifecycleMappingExpression} LifecycleMappingExpression
 */

import {
  LM_MARKETING_MODULE_REF,
  LM_MARKETING_OUTPUT_SCHEMA,
} from '../../synthetic-modules/lm-marketing/definition.mjs';
import {
  KERNEL_ANALYTICS_MODULE_REF,
  KERNEL_ANALYTICS_OUTPUT_SCHEMA,
} from '../../synthetic-modules/kernel-analytics/definition.mjs';
import {
  HUMAN_DIRECTOR_APPROVAL_MODULE_REF,
  HUMAN_DIRECTOR_OUTPUT_SCHEMA,
} from '../../synthetic-modules/human-director-approval/definition.mjs';
import {
  EXTERNAL_SEO_MODULE_REF,
  EXTERNAL_SEO_OUTPUT_SCHEMA,
} from '../../synthetic-modules/external-seo/definition.mjs';

/**
 * Scenario identity. Mirrors `LifecycleIdentity` from the domain contract.
 */
export const CAMPAIGN_SCENARIO_IDENTITY = Object.freeze({
  name: 'synthetic-campaign',
  version: '0.1.0',
  displayName: 'Synthetic Campaign Lifecycle',
  description:
    'W0-A7 synthetic lifecycle scenario. Composes 4 module kinds across 5 stages, reuses external-seo twice, uses declarative static routes only.',
});

export const CAMPAIGN_SCENARIO_INPUT_SCHEMA = 'synthetic.campaign.input.v1';
export const CAMPAIGN_SCENARIO_OUTPUT_SCHEMA = 'synthetic.campaign.output.v1';

/** Terminal statuses declared by this scenario (plan §6.2.9). */
export const CAMPAIGN_TERMINAL_STATUSES = Object.freeze([
  'campaign-approved',
  'campaign-rejected',
]);

/**
 * Stage bindings.
 *
 * `inputMapping` keys are downstream module input field names; values are
 * `LifecycleMappingExpression` shapes:
 *   - `'path.string'`              -> JSON-path read from the durable lifecycle
 *                                     frame (root input or prior stage output).
 *   - `{ literal: <value> }`       -> immutable declared literal.
 *   - `{ runtime: 'projectId' }`   -> immutable runtime field.
 *
 * All paths use safe own-property traversal only (plan §6.9.5).
 *
 * @type {readonly StageBinding[]}
 */
const campaignStages = [
  {
    id: 'draft',
    displayName: 'Draft Campaign',
    moduleRef: LM_MARKETING_MODULE_REF,
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
  {
    id: 'seo-baseline',
    displayName: 'SEO Baseline Fetch',
    // REUSE #1 of synthetic-external-seo (plan §6.8).
    moduleRef: EXTERNAL_SEO_MODULE_REF,
    inputMapping: {
      keywords: 'stages.draft.output.keywords',
      market: { literal: 'baseline' },
    },
    outputMapping: {
      baselineRanking: 'output.rankingSnapshot',
    },
    outcomeRoutes: {
      'ranking-fetched': { type: 'stage', stageId: 'compute' },
    },
    entryConditions: ['draft stage produced a campaign draft'],
    exitConditions: ['ranking-fetched outcome emitted'],
  },
  {
    id: 'compute',
    displayName: 'Compute Metrics',
    moduleRef: KERNEL_ANALYTICS_MODULE_REF,
    inputMapping: {
      campaignDraft: 'stages.draft.output.campaignDraft',
      baselineRanking: 'stages.seo-baseline.output.baselineRanking',
    },
    outputMapping: {
      metrics: 'output.metrics',
    },
    outcomeRoutes: {
      'metrics-computed': { type: 'stage', stageId: 'seo-followup' },
    },
    entryConditions: ['draft + baseline outputs available'],
    exitConditions: ['metrics-computed outcome emitted'],
  },
  {
    id: 'seo-followup',
    displayName: 'SEO Follow-up Fetch',
    // REUSE #2 of synthetic-external-seo (plan §6.8). Same module package,
    // different stage, different input mapping.
    moduleRef: EXTERNAL_SEO_MODULE_REF,
    inputMapping: {
      keywords: 'stages.draft.output.keywords',
      metrics: 'stages.compute.output.metrics',
      market: { literal: 'followup' },
    },
    outputMapping: {
      followupRanking: 'output.rankingSnapshot',
    },
    outcomeRoutes: {
      'ranking-fetched': { type: 'stage', stageId: 'approve' },
    },
    entryConditions: ['compute stage produced metrics'],
    exitConditions: ['ranking-fetched outcome emitted'],
  },
  {
    id: 'approve',
    displayName: 'Director Sign-off',
    moduleRef: HUMAN_DIRECTOR_APPROVAL_MODULE_REF,
    inputMapping: {
      campaignDraft: 'stages.draft.output.campaignDraft',
      metrics: 'stages.compute.output.metrics',
      followupRanking: 'stages.seo-followup.output.followupRanking',
      requestedBy: { runtime: 'initiatedBy' },
    },
    outputMapping: {
      directorDecision: 'output.decision',
    },
    outcomeRoutes: {
      // §6.3.5: complete route table for EVERY declared module outcome.
      // Two outcomes -> two different terminal statuses.
      approved: { type: 'terminal', status: 'campaign-approved' },
      rejected: { type: 'terminal', status: 'campaign-rejected' },
    },
    entryConditions: ['all upstream stage outputs available'],
    exitConditions: ['approved or rejected outcome emitted'],
  },
];

/**
 * The campaign scenario as a plain documented object.
 *
 * NOTE: This is NOT typed as `LifecycleScenarioManifest` because that type
 * does not exist yet (Wave 1, W1-A3). It is a `LifecycleDefinition`-SHAPED
 * object — `LifecycleDefinition` already exists in the domain contract, so
 * Wave 7's scenario runtime and Wave 1's manifest validator can consume this
 * shape directly or adapt it through an explicit legacy adapter (plan §3.13).
 *
 * There is NO `routeResolver` field anywhere on this object — that omission
 * is the proof of plan §6.4.
 */
export const campaignScenario = Object.freeze({
  manifestFormatVersion: '0.1.0',
  source: 'W0-A7 synthetic fixture (data-only)',
  identity: CAMPAIGN_SCENARIO_IDENTITY,
  inputContract: { id: CAMPAIGN_SCENARIO_INPUT_SCHEMA },
  outputContract: { id: CAMPAIGN_SCENARIO_OUTPUT_SCHEMA },
  entryStageId: 'draft',
  stages: campaignStages,
  terminalStatuses: CAMPAIGN_TERMINAL_STATUSES,
  // Intentionally absent: routeResolver. Proves §6.4.
});

/**
 * Helper: list module refs used by this scenario. Used by the smoke test and
 * by Wave 7 to prove the scenario depends only on public module contracts
 * (plan §6.10).
 */
export const campaignModuleRefs = Object.freeze([
  LM_MARKETING_MODULE_REF,
  EXTERNAL_SEO_MODULE_REF,
  KERNEL_ANALYTICS_MODULE_REF,
  HUMAN_DIRECTOR_APPROVAL_MODULE_REF,
]);

export default campaignScenario;
