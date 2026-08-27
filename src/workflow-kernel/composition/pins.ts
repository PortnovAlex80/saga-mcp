/**
 * workflow-kernel/composition/pins.ts - the FROZEN production admission
 * pins (EK-8, WP-12).
 *
 * The plan (phase EK-8) requires production cognition through the WP-18
 * instrumented transport with the running counter identity PINNED: "EK-8
 * must pin RUNNING_COUNTER_IDENTITY (WP-18's residual note) or admission
 * fails closed as TOKEN_COUNTER_MISMATCH - pin it."
 *
 * Everything here is content-addressed and digest-verified at module load:
 *   - PRODUCTION_LIMIT_TABLE - the factory provider-model limit table,
 *     pinned at the EK-8 cutover (the WP-16 example table was marked
 *     "Real production limit tables are pinned at EK-8"; this IS that
 *     pinning). Its computed rows digest must equal the frozen
 *     PRODUCTION_LIMIT_TABLE_DIGEST or the composition aborts (drift =
 *     typed failure, never a silent re-count).
 *   - PRODUCTION_PROMPT_BUDGET_PROFILE - the production budget profile.
 *     Its tokenCounterRef is EXACTLY RUNNING_COUNTER_IDENTITY (the pin);
 *     any other value fails admission closed as TOKEN_COUNTER_MISMATCH.
 *   - PRODUCTION_ROUTE_PIN - the one provider/model route the composition
 *     serves (the Z.AI Coding Plan provider behind the opencode shim).
 */

import { tableRowsDigestOf, RUNNING_COUNTER_IDENTITY } from '../context-envelope/accountant.js';
import type { PromptBudgetProfile, ProviderModelLimitTableArtifact } from '../context-envelope/accountant.js';
import type { ProviderRoutePin } from '../context-envelope/receipt.js';
import { sha256OfCanonical } from '../domain/digest.js';

/** The frozen digest of the production rows (content address, sha256). */
// Repinned 2026-08-26 (operator directive: GLM-5.3-flash joins the catalog
// and becomes the default route, rate limit 6 at the channel). The digest
// moved with the rows in the SAME change — the fail-closed drift guard above
// forced this repin (computed 0bef5d84… at the change).
export const PRODUCTION_LIMIT_TABLE_DIGEST = 'sha256:0bef5d84cfc8c363664f3c7a906c8fc2be459d7bcf91db13d4035bfd148aefc3';

/**
 * The production provider-model limit table (pinned at the EK-8 cutover;
 * conservative 128K/200K-class numbers for the Z.AI Coding Plan catalog).
 */
export const PRODUCTION_LIMIT_TABLE: ProviderModelLimitTableArtifact = Object.freeze({
  kind: 'provider-model-limit-table',
  rows: Object.freeze([
    Object.freeze({ provider: 'zai', model: 'glm-5.2', version: 'catalog-2026-08-24', contextLimitTokens: 131072 }),
    Object.freeze({ provider: 'zai', model: 'glm-5.3-flash', version: 'catalog-2026-08-26', contextLimitTokens: 131072 }),
    Object.freeze({ provider: 'zai', model: 'glm-4.7', version: 'catalog-2026-08-24', contextLimitTokens: 204800 }),
  ]),
});

// Fail-closed digest pin: the computed content address of the frozen rows
// must equal the pinned digest or the composition never arms.
if (tableRowsDigestOf(PRODUCTION_LIMIT_TABLE.rows) !== PRODUCTION_LIMIT_TABLE_DIGEST) {
  throw new Error(
    `PRODUCTION_LIMIT_TABLE_DRIFT: computed ${tableRowsDigestOf(PRODUCTION_LIMIT_TABLE.rows)} != pinned ${PRODUCTION_LIMIT_TABLE_DIGEST}; the production limit table may never drift silently`,
  );
}

/** The one provider route the production composition serves. */
export const PRODUCTION_ROUTE_PIN: ProviderRoutePin = Object.freeze({
  provider: 'zai',
  model: 'glm-5.3-flash',
  version: 'catalog-2026-08-26',
});

/**
 * The production prompt-budget profile. The tokenCounterRef IS the running
 * counter identity (the WP-18 residual note pin): admission compares this
 * pin against the running implementation and fails closed with
 * TOKEN_COUNTER_MISMATCH on any drift - never a silent recount.
 */
export const PRODUCTION_PROMPT_BUDGET_PROFILE: PromptBudgetProfile = Object.freeze({
  providerModelLimitTableRef: {
    ref: 'content://provider-model-limit-tables/factory-production-2026-08-26-glm53flash',
    digest: PRODUCTION_LIMIT_TABLE_DIGEST,
    digestAlgorithm: 'sha256' as const,
  },
  tokenCounterRef: RUNNING_COUNTER_IDENTITY,
  providerContextLimitTokens: 131072,
  maxProviderRequests: 40,
  maxStaticTokens: 95000,
  maxDynamicTokens: 30000,
  maxRecoveryTokens: 8000,
  maxToolResultTokens: 12000,
  maxTotalInputTokens: 116000,
  maxCumulativeSessionInputTokens: 300000,
  reservedOutputTokens: 8192,
  providerOverheadReserveTokens: 2048,
  safetyMarginTokens: 4096,
  maxPromptBytes: 1048576,
});

/** The content-addressed identity of the profile (evidence pins carried by attempts). */
export const PRODUCTION_PROFILE_REF = 'content://prompt-budget-profiles/factory-production-2026-08-26-glm53flash';

/** The profile's content digest (sha256 over the canonicalized profile object). */
export const PRODUCTION_PROFILE_DIGEST: string = 'sha256:' + sha256OfCanonical(PRODUCTION_PROMPT_BUDGET_PROFILE);

/** The production admission pins (profile + limit table) of the transport. */
export function productionAdmissionPins(): {
  readonly pins: { readonly profile: PromptBudgetProfile; readonly limitTable: ProviderModelLimitTableArtifact };
  readonly profile: PromptBudgetProfile;
} {
  return { pins: { profile: PRODUCTION_PROMPT_BUDGET_PROFILE, limitTable: PRODUCTION_LIMIT_TABLE }, profile: PRODUCTION_PROMPT_BUDGET_PROFILE };
}
