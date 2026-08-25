/**
 * workflow-kernel/context-envelope/accountant.ts - the ONE cumulative
 * context accountant + the pinned token-counter protocol v1 (WP-18).
 *
 * Authority: docs/refactoring/event-kernel/specs/context-envelope-semantics.md
 * sections 3 (the accounting model + frozen formulas), 6 (token-counter
 * protocol) and prompt-budget-profile.schema.json (the frozen
 * PromptBudgetProfile value shape; positive finite limits only).
 *
 * Laws implemented here:
 *   - ONE cumulative accountant before EVERY provider request, covering
 *     initial prompt, protocol/semantic skills, tool schemas, hook
 *     additionalContext, recovery history, workspace summary, retained tool
 *     results and the reference layers (classification CS-01..CS-13).
 *   - Frozen formulas EXACTLY:
 *       effectiveInputLimit = providerContextLimit - reservedOutputTokens
 *         - providerOverheadReserveTokens - safetyMarginTokens
 *       requestInputTokens <= min(maxTotalInputTokens, effectiveInputLimit)
 *       cumulativeInputTokens + requestInputTokens <= maxCumulativeSessionInputTokens
 *       requestOrdinal <= maxProviderRequests
 *       serializedRequestBytes <= maxPromptBytes
 *       layerTokens <= layerBudget   (static | dynamic | recovery | toolResult)
 *   - Zero, missing and unsupported provider/model limits fail closed; the
 *     limit table is a read-only exact-key lookup bound by digest (no
 *     selection, no fallback, no wildcard).
 *   - The counter is version-pinned: the running implementation identity must
 *     equal the profile pin or the request is refused with the typed
 *     TOKEN_COUNTER_MISMATCH - never a silent recount, never a fallback
 *     estimate.
 *
 * PURITY: node builtins only; the pure domain digest rule
 * (../domain/digest.js). No network, no clock, no randomness.
 */

import { createHash } from 'node:crypto';
import { sha256OfCanonical } from '../domain/digest.js';
import {
  deepFreeze,
  envelopeDigestOf,
  externalReferencesOf,
  layerDigestOf,
  layerRule,
  LAYER_RULES,
  normalizeEnvelopeLayers,
  optionalLayerOmissionOrder,
  serializeEnvelopeLayers,
} from './receipt.js';
import type {
  ContextEnvelope,
  ContextViolation,
  CounterIdentityPin,
  ExternalReference,
  LayerName,
  LimitCheck,
  ProviderRoutePin,
} from './receipt.js';

/** A typed violation with its exact detail string. */
export interface ViolationDetail {
  readonly violation: ContextViolation;
  readonly detail: string;
}

/* ------------------------------------------------------------------ */
/* PromptBudgetProfile (frozen schema mirror, WP-16 part 3)            */
/* ------------------------------------------------------------------ */

/** $defs/ProviderModelLimitTableRef: immutable content-addressed artifact pin. */
export interface ProviderModelLimitTableRef {
  readonly ref: string;
  readonly digest: string;
  readonly digestAlgorithm: 'sha256';
}

/**
 * The frozen PromptBudgetProfile value (prompt-budget-profile.schema.json).
 * Every limit is a positive finite integer; there is no unbounded
 * representation (no null, no Infinity, no sentinel).
 */
export interface PromptBudgetProfile {
  readonly providerModelLimitTableRef: ProviderModelLimitTableRef;
  readonly providerContextLimitTokens: number;
  readonly tokenCounterRef: CounterIdentityPin;
  readonly maxProviderRequests: number;
  readonly maxStaticTokens: number;
  readonly maxDynamicTokens: number;
  readonly maxRecoveryTokens: number;
  readonly maxToolResultTokens: number;
  readonly maxTotalInputTokens: number;
  readonly maxCumulativeSessionInputTokens: number;
  readonly reservedOutputTokens: number;
  readonly providerOverheadReserveTokens: number;
  readonly safetyMarginTokens: number;
  readonly maxPromptBytes: number;
}

/** One exact-key row of the read-only provider/model limit table. */
export interface ProviderModelLimitTableRow {
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  readonly contextLimitTokens: number;
}

/** The immutable limit-table artifact (schema $defs/ProviderModelLimitTable). */
export interface ProviderModelLimitTableArtifact {
  readonly kind: 'provider-model-limit-table';
  readonly rows: readonly ProviderModelLimitTableRow[];
}

/* ------------------------------------------------------------------ */
/* The pinned token counter (saga-token-counter-protocol v1)           */
/* ------------------------------------------------------------------ */

export const TOKEN_COUNTER_NAME = 'saga-token-counter-protocol';
export const TOKEN_COUNTER_PROTOCOL_VERSION = '1';
export const TOKEN_COUNTER_ENCODING = 'saga-deterministic-word-v1';
export const TOKEN_COUNTER_IMPLEMENTATION_REF = 'content://token-counters/saga-deterministic-word-v1';

/**
 * The frozen counting rule of the v1 encoding. Part of the pinned identity:
 * any change to this rule changes the implementation digest and therefore
 * mismatches every profile pinning the previous counter (drift = typed
 * failure, by design).
 */
export const TOKEN_COUNTER_RULE =
  'split the exact serialized text on the /\s+/ regex dropping empty runs; each word of n UTF-16 code units contributes ceil(n/4) tokens; total = sum over words; pure local deterministic function of the bytes';

const COUNTER_IDENTITY_WITHOUT_DIGEST = {
  name: TOKEN_COUNTER_NAME,
  protocolVersion: TOKEN_COUNTER_PROTOCOL_VERSION,
  implementationRef: TOKEN_COUNTER_IMPLEMENTATION_REF,
  digestAlgorithm: 'sha256',
  encoding: TOKEN_COUNTER_ENCODING,
} as const;

/**
 * The running counter identity: content-addressed as sha256 over the
 * canonical implementation descriptor (identity fields + the frozen rule).
 * Profiles pin THIS digest; any other pin is a TOKEN_COUNTER_MISMATCH.
 */
export const RUNNING_COUNTER_IDENTITY: CounterIdentityPin = deepFreeze({
  ...COUNTER_IDENTITY_WITHOUT_DIGEST,
  digest: 'sha256:' + sha256OfCanonical({ ...COUNTER_IDENTITY_WITHOUT_DIGEST, rule: TOKEN_COUNTER_RULE }),
});

/**
 * saga-token-counter-protocol v1: local pure function over the exact
 * serialized bytes. Identical bytes + identical pinned identity => identical
 * counts on any machine. Provider-reported usage is postflight evidence,
 * never the admission oracle.
 */
export function countTokens(text: string): number {
  let total = 0;
  for (const word of text.split(/\s+/)) {
    if (word.length === 0) continue;
    total += Math.ceil(word.length / 4);
  }
  return total;
}

/** True iff the pinned counter identity IS the running implementation (exact equality on every field). */
export function verifyCounterPin(pin: CounterIdentityPin): boolean {
  return (
    pin.name === RUNNING_COUNTER_IDENTITY.name &&
    pin.protocolVersion === RUNNING_COUNTER_IDENTITY.protocolVersion &&
    pin.implementationRef === RUNNING_COUNTER_IDENTITY.implementationRef &&
    pin.digest === RUNNING_COUNTER_IDENTITY.digest &&
    pin.digestAlgorithm === RUNNING_COUNTER_IDENTITY.digestAlgorithm &&
    pin.encoding === RUNNING_COUNTER_IDENTITY.encoding
  );
}

/* ------------------------------------------------------------------ */
/* Limit-table binding (read-only exact-key lookup, digest-bound)      */
/* ------------------------------------------------------------------ */

/**
 * The table digest rule: sha256 over the canonicalized rows array - the SAME
 * content addressing validate-prompt-budget.mjs applies (behavioral equality
 * is pinned by tests against the frozen example artifact).
 */
export function tableRowsDigestOf(rows: readonly ProviderModelLimitTableRow[]): string {
  return 'sha256:' + sha256OfCanonical(rows);
}

/**
 * Exact-key lookup of the pinned route triple. Wildcards and missing rows
 * fail closed; the table never selects, reroutes or falls back.
 */
export function lookupContextLimit(
  table: ProviderModelLimitTableArtifact,
  routePin: ProviderRoutePin,
): ProviderModelLimitTableRow | undefined {
  if (routePin.provider === '*' || routePin.model === '*' || routePin.version === '*') return undefined;
  return table.rows.find(
    (row) => row.provider === routePin.provider && row.model === routePin.model && row.version === routePin.version,
  );
}

/* ------------------------------------------------------------------ */
/* Profile fail-closed validation (positive finite + formula coherence)*/
/* ------------------------------------------------------------------ */

const POSITIVE_FINITE_FIELDS = [
  'providerContextLimitTokens',
  'maxProviderRequests',
  'maxStaticTokens',
  'maxDynamicTokens',
  'maxRecoveryTokens',
  'maxToolResultTokens',
  'maxTotalInputTokens',
  'maxCumulativeSessionInputTokens',
  'reservedOutputTokens',
  'providerOverheadReserveTokens',
  'safetyMarginTokens',
  'maxPromptBytes',
] as const;

const SHA256_REF_RE = /^sha256:[0-9a-f]{64}$/;
const CONTENT_REF_RE = /^content:\/\/[a-z0-9._/-]+$/;

/** Fail-closed positive-finite + shape check (mirrors the frozen validator laws). */
export function profileViolation(profile: PromptBudgetProfile): ViolationDetail | undefined {
  for (const field of POSITIVE_FINITE_FIELDS) {
    const value = profile[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || !Number.isSafeInteger(value)) {
      return { violation: 'PROFILE_NOT_POSITIVE_FINITE', detail: `profile.${field} = ${JSON.stringify(value)}: zero, missing, fractional, non-number and unbounded sentinels all fail closed` };
    }
  }
  const tableRef = profile.providerModelLimitTableRef;
  if (!tableRef || !CONTENT_REF_RE.test(tableRef.ref) || !SHA256_REF_RE.test(tableRef.digest) || tableRef.digestAlgorithm !== 'sha256') {
    return { violation: 'PROFILE_NOT_POSITIVE_FINITE', detail: 'profile.providerModelLimitTableRef must be a content-addressed sha256 artifact pin' };
  }
  const pin = profile.tokenCounterRef;
  if (
    !pin ||
    typeof pin.implementationRef !== 'string' ||
    !CONTENT_REF_RE.test(pin.implementationRef) ||
    !SHA256_REF_RE.test(pin.digest) ||
    pin.digestAlgorithm !== 'sha256' ||
    typeof pin.encoding !== 'string' ||
    pin.encoding.length < 1
  ) {
    return { violation: 'PROFILE_NOT_POSITIVE_FINITE', detail: 'profile.tokenCounterRef must be a well-formed pinned counter identity' };
  }
  return undefined;
}

/** The frozen effectiveInputLimit formula (context-envelope-semantics section 3.2). */
export function effectiveInputLimitOf(profile: PromptBudgetProfile): number {
  return profile.providerContextLimitTokens - profile.reservedOutputTokens - profile.providerOverheadReserveTokens - profile.safetyMarginTokens;
}

/** The per-request admission cap: min(maxTotalInputTokens, effectiveInputLimit). */
export function perRequestCapOf(profile: PromptBudgetProfile): number {
  return Math.min(profile.maxTotalInputTokens, effectiveInputLimitOf(profile));
}

/** Formula coherence (the same laws the frozen admission validator freezes). */
export function formulaCoherenceViolation(profile: PromptBudgetProfile): ViolationDetail | undefined {
  const effective = effectiveInputLimitOf(profile);
  if (effective < 1) {
    return { violation: 'PROFILE_FORMULA_INCOHERENT', detail: `effectiveInputLimit = ${effective} (must be positive)` };
  }
  if (profile.maxTotalInputTokens > effective) {
    return { violation: 'PROFILE_FORMULA_INCOHERENT', detail: `maxTotalInputTokens (${profile.maxTotalInputTokens}) > effectiveInputLimit (${effective})` };
  }
  if (profile.maxCumulativeSessionInputTokens < perRequestCapOf(profile)) {
    return { violation: 'PROFILE_FORMULA_INCOHERENT', detail: `maxCumulativeSessionInputTokens (${profile.maxCumulativeSessionInputTokens}) < per-request cap (${perRequestCapOf(profile)})` };
  }
  for (const field of ['maxStaticTokens', 'maxDynamicTokens', 'maxRecoveryTokens', 'maxToolResultTokens'] as const) {
    if (profile[field] > profile.maxTotalInputTokens) {
      return { violation: 'PROFILE_FORMULA_INCOHERENT', detail: `${field} (${profile[field]}) > maxTotalInputTokens (${profile.maxTotalInputTokens})` };
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* The cumulative accountant                                           */
/* ------------------------------------------------------------------ */

/** The CAS-fenced attempt counters the accountant reads (never receipts). */
export interface AttemptAccountingState {
  readonly providerRoutePin: ProviderRoutePin;
  readonly nextRequestOrdinal: number;
  readonly cumulativeInputTokens: number;
}

/** Per-budget-class token sums. */
export interface BudgetClassTokens {
  readonly static: number;
  readonly dynamic: number;
  readonly recovery: number;
  readonly toolResult: number;
  readonly reference: number;
}

/** The accountant verdict over one assembled envelope. */
export interface AccountantVerdict {
  readonly ok: boolean;
  readonly violation?: ContextViolation;
  readonly violationDetail?: string;
  readonly counterPinVerified: boolean;
  readonly providerContextLimitTokens: number;
  readonly effectiveInputLimit: number;
  readonly perRequestCap: number;
  readonly providerRoutePin: ProviderRoutePin;
  readonly layerNames: readonly LayerName[];
  readonly layerDigests: readonly string[];
  readonly layerTokenCounts: readonly number[];
  readonly budgetClassTokens: BudgetClassTokens;
  readonly requestInputTokens: number;
  readonly serializedRequestBytes: number;
  readonly omittedOptionalLayers: readonly LayerName[];
  readonly externalReferences: readonly ExternalReference[];
  readonly limitChecks: readonly LimitCheck[];
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/**
 * The ONE cumulative accountant. Runs at the admission boundary, before
 * final serialization/network send, covering every classified context
 * source. Returns the complete verdict (per-layer digests/counts, per-limit
 * checks, first typed violation in the deterministic check order) from which
 * the receipt is built. Pure: same profile + table + counters + envelope =>
 * same verdict.
 */
export function accountEnvelope(
  profile: PromptBudgetProfile,
  table: ProviderModelLimitTableArtifact,
  attempt: AttemptAccountingState,
  envelope: ContextEnvelope,
): AccountantVerdict {
  const checks: LimitCheck[] = [];
  const fail = (violation: ContextViolation, detail: string, partial: Partial<AccountantVerdict>): AccountantVerdict => {
    checks.push({ limit: `violation:${violation}`, value: 0, pass: false });
    return {
      ok: false,
      violation,
      violationDetail: detail,
      counterPinVerified: false,
      providerContextLimitTokens: 0,
      effectiveInputLimit: 0,
      perRequestCap: 0,
      providerRoutePin: attempt.providerRoutePin,
      layerNames: [],
      layerDigests: [],
      layerTokenCounts: [],
      budgetClassTokens: { static: 0, dynamic: 0, recovery: 0, toolResult: 0, reference: 0 },
      requestInputTokens: 0,
      serializedRequestBytes: 0,
      omittedOptionalLayers: [],
      externalReferences: [],
      ...partial,
      limitChecks: checks,
    };
  };

  // 1. Profile fail-closed (positive finite, then formula coherence).
  const structural = profileViolation(profile);
  if (structural) return fail(structural.violation, structural.detail, {});
  const coherence = formulaCoherenceViolation(profile);
  if (coherence) return fail(coherence.violation, coherence.detail, {});

  // 2. Counter pin: drift = typed mismatch failure, never a silent recount.
  const counterPinVerified = verifyCounterPin(profile.tokenCounterRef);
  checks.push({ limit: 'tokenCounterPin', value: counterPinVerified ? 1 : 0, pass: counterPinVerified });
  if (!counterPinVerified) {
    return fail('TOKEN_COUNTER_MISMATCH', `pinned counter identity ${JSON.stringify(profile.tokenCounterRef)} != running ${JSON.stringify(RUNNING_COUNTER_IDENTITY)}; drift is a typed mismatch failure, never a silent recount`, {});
  }

  // 3. Limit table: digest-bound read-only exact-key lookup.
  const tableDigest = tableRowsDigestOf(table.rows);
  const tableBound = tableDigest === profile.providerModelLimitTableRef.digest;
  checks.push({ limit: 'limitTableDigest', value: tableBound ? 1 : 0, pass: tableBound });
  if (!tableBound) {
    return fail('LIMIT_TABLE_DIGEST_MISMATCH', `installed limit-table rows digest ${tableDigest} != profile pin ${profile.providerModelLimitTableRef.digest}`, {});
  }
  const row = lookupContextLimit(table, attempt.providerRoutePin);
  checks.push({ limit: 'providerRouteExactKeyRow', value: row ? 1 : 0, pass: row !== undefined });
  if (!row) {
    return fail('PROVIDER_LIMIT_UNSUPPORTED', `no exact-key row for ${attempt.providerRoutePin.provider}/${attempt.providerRoutePin.model}/${attempt.providerRoutePin.version}; zero, missing and unsupported provider/model limits fail closed`, {});
  }
  const agrees = row.contextLimitTokens === profile.providerContextLimitTokens;
  checks.push({ limit: 'providerContextLimitAgrees', value: profile.providerContextLimitTokens, pass: agrees });
  if (!agrees) {
    return fail('PROVIDER_LIMIT_DISAGREEMENT', `profile.providerContextLimitTokens (${profile.providerContextLimitTokens}) != limit-table row (${row.contextLimitTokens}) for the pinned route`, {});
  }

  // 4. Layer normalization: closed registry, fixed order.
  const normalized = normalizeEnvelopeLayers(envelope.layers);
  if (!normalized.ok) {
    return fail(normalized.violation, normalized.detail, {});
  }
  const ordered = normalized.ordered;
  const present = new Set(ordered.map((layer) => layer.layer));

  // 5. Mandatory layers never disappear through silent truncation.
  const mandatoryRules = LAYER_RULES.filter((rule) => rule.mandatory);
  const missingMandatory = mandatoryRules.filter((rule) => !present.has(rule.layer));
  checks.push({ limit: 'mandatoryLayersPresent', value: mandatoryRules.length - missingMandatory.length, pass: missingMandatory.length === 0 });
  if (missingMandatory.length > 0) {
    return fail('MANDATORY_LAYER_MISSING', `mandatory-inline layer(s) absent: ${missingMandatory.map((r) => `${r.layer} (${r.classificationId})`).join(', ')}; a mandatory layer may never disappear through silent truncation`, { layerNames: ordered.map((l) => l.layer) });
  }

  // 6. CS-14/CS-16 grammar detector: bounded transport form only.
  const unbounded = ordered.filter((layer) => layerRule(layer.layer)?.requiresBoundedTransportForm === true && layer.boundedTransportForm !== true);
  checks.push({ limit: 'boundedTransportForms', value: ordered.length - unbounded.length, pass: unbounded.length === 0 });
  if (unbounded.length > 0) {
    return fail('FORBIDDEN_DUPLICATION', `layer(s) not in the bounded transport form: ${unbounded.map((l) => l.layer).join(', ')}; the raw mutable row / wholesale recopy is forbidden duplication (classification CS-14/CS-16)`, { layerNames: ordered.map((l) => l.layer) });
  }

  // 7. Count with the pinned counter (per-layer, layer-wise).
  const layerNames = ordered.map((layer) => layer.layer);
  const layerDigests = ordered.map((layer) => layerDigestOf(layer));
  const layerTokenCounts = ordered.map((layer) => countTokens(layer.content));
  const budgetClassTokens = { static: 0, dynamic: 0, recovery: 0, toolResult: 0, reference: 0 } as Record<string, number>;
  ordered.forEach((layer, index) => {
    const rule = layerRule(layer.layer);
    if (rule) budgetClassTokens[rule.budgetClass] += layerTokenCounts[index];
  });
  const requestInputTokens = layerTokenCounts.reduce((sum, count) => sum + count, 0);
  const serialized = serializeEnvelopeLayers(ordered);
  const serializedRequestBytes = byteLength(serialized);
  const omittedOptionalLayers = optionalLayerOmissionOrder().filter((layer) => !present.has(layer));

  const effectiveInputLimit = effectiveInputLimitOf(profile);
  const perRequestCap = perRequestCapOf(profile);

  const base: Partial<AccountantVerdict> = {
    counterPinVerified,
    providerContextLimitTokens: profile.providerContextLimitTokens,
    effectiveInputLimit,
    perRequestCap,
    providerRoutePin: attempt.providerRoutePin,
    layerNames,
    layerDigests,
    layerTokenCounts,
    budgetClassTokens: budgetClassTokens as unknown as BudgetClassTokens,
    requestInputTokens,
    serializedRequestBytes,
    omittedOptionalLayers,
    externalReferences: externalReferencesOf(ordered),
  };

  // 8. Layer budgets (static | dynamic | recovery | toolResult).
  const layerBudgetChecks: readonly [string, number, number][] = [
    ['maxStaticTokens', budgetClassTokens.static, profile.maxStaticTokens],
    ['maxDynamicTokens', budgetClassTokens.dynamic, profile.maxDynamicTokens],
    ['maxRecoveryTokens', budgetClassTokens.recovery, profile.maxRecoveryTokens],
    ['maxToolResultTokens', budgetClassTokens.toolResult, profile.maxToolResultTokens],
  ];
  for (const [limit, value, cap] of layerBudgetChecks) {
    const pass = value <= cap;
    checks.push({ limit, value, pass });
    if (!pass) {
      const violation = (limit === 'maxStaticTokens' ? 'MAX_STATIC_TOKENS_EXCEEDED'
        : limit === 'maxDynamicTokens' ? 'MAX_DYNAMIC_TOKENS_EXCEEDED'
          : limit === 'maxRecoveryTokens' ? 'MAX_RECOVERY_TOKENS_EXCEEDED'
            : 'MAX_TOOL_RESULT_TOKENS_EXCEEDED') as ContextViolation;
      return fail(violation, `${limit}: ${value} > ${cap} (layerTokens <= layerBudget)`, base);
    }
  }

  // 9. Per-request total cap: requestInputTokens <= min(maxTotalInputTokens, effectiveInputLimit).
  const totalPass = requestInputTokens <= perRequestCap;
  checks.push({ limit: 'min(maxTotalInputTokens, effectiveInputLimit)', value: requestInputTokens, pass: totalPass });
  if (!totalPass) {
    return fail('MAX_TOTAL_INPUT_TOKENS_EXCEEDED', `requestInputTokens (${requestInputTokens}) > per-request cap (${perRequestCap} = min(${profile.maxTotalInputTokens}, ${effectiveInputLimit}))`, base);
  }

  // 10. Cumulative session budget.
  const cumulativeAfter = attempt.cumulativeInputTokens + requestInputTokens;
  const cumulativePass = cumulativeAfter <= profile.maxCumulativeSessionInputTokens;
  checks.push({ limit: 'maxCumulativeSessionInputTokens', value: cumulativeAfter, pass: cumulativePass });
  if (!cumulativePass) {
    return fail('CUMULATIVE_SESSION_BUDGET_EXCEEDED', `cumulativeInputTokens (${attempt.cumulativeInputTokens}) + requestInputTokens (${requestInputTokens}) > maxCumulativeSessionInputTokens (${profile.maxCumulativeSessionInputTokens})`, base);
  }

  // 11. Request ordinal bound.
  const ordinalPass = attempt.nextRequestOrdinal <= profile.maxProviderRequests;
  checks.push({ limit: 'maxProviderRequests', value: attempt.nextRequestOrdinal, pass: ordinalPass });
  if (!ordinalPass) {
    return fail('MAX_PROVIDER_REQUESTS_EXCEEDED', `requestOrdinal (${attempt.nextRequestOrdinal}) > maxProviderRequests (${profile.maxProviderRequests})`, base);
  }

  // 12. Byte backstop (no unlimited representation).
  const bytesPass = serializedRequestBytes <= profile.maxPromptBytes;
  checks.push({ limit: 'maxPromptBytes', value: serializedRequestBytes, pass: bytesPass });
  if (!bytesPass) {
    return fail('MAX_PROMPT_BYTES_EXCEEDED', `serializedRequestBytes (${serializedRequestBytes}) > maxPromptBytes (${profile.maxPromptBytes})`, base);
  }

  return { ok: true, ...base, limitChecks: checks } as AccountantVerdict;
}

/**
 * The digest of an envelope rejected before counting completed (used for
 * refused receipts whose normalization itself failed): canonical digest over
 * the raw layer list.
 */
export function rejectedEnvelopeDigestOf(envelope: ContextEnvelope): string {
  const normalized = normalizeEnvelopeLayers(envelope.layers);
  if (normalized.ok) return envelopeDigestOf(normalized.ordered);
  return 'sha256:' + createHash('sha256').update(JSON.stringify(envelope.layers.map((layer) => ({ layer: layer.layer, content: layer.content }))), 'utf8').digest('hex');
}
