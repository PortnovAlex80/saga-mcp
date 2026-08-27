/**
 * workflow-kernel/workshops/development/handoff/shared.mjs -
 * the FRF-WP09 Development handoff package: the shared typed-refusal
 * surface, the upstream seam, and the twelve-domain vocabulary.
 *
 * FRF-WP09 (plan phase FRF-9, "Make Development consume scenarios") owns
 * the lifecycle mapping, the DevelopmentCase, the WorkItem bindings, the
 * planning gates, and the replan/adoption/settlement/verification identity
 * preservation. This package is TEST-ONLY REACHABLE until the FRF-WP11
 * coordinator lands the package integration: no production entrypoint
 * imports it, and it is not wired into the installed workshop manifest.
 *
 * THE UPSTREAM SEAM (documented law of this package):
 *   The Development handoff CONSUMES three sealed upstream authorities and
 *   never re-derives them:
 *     1. the frozen whole-WHAT baseline (FRF-WP03 contract, sealed by the
 *        FRF-WP07 freeze desk) - its exact id sets are the ONLY accepted
 *        universe every DevelopmentCase binding domain resolves against;
 *     2. the sealed solution contract (FRF-WP07 settle desk) - validated
 *        through the SAME WP07 binding-aware validator before any case is
 *        constructed (the byte-for-byte handoff, reverse edge/0015);
 *     3. the sealed architecture contract (FRF-WP08 define-architecture-
 *        contract desk) - the typed composition/infrastructure surface and
 *        realization-entry index the planning gates consume.
 *   The imports travel by exact relative path to the sibling FRF cell
 *   packages (.mjs, test-only reachable like this one) and to the FRF-WP03
 *   docs/ validators (the same seam the WP07 cell pins). At FRF-WP11
 *   integration the seam flips to the compiled in-package validators.
 *
 * THE CONSUMER-SIDE UC-FOREIGN KILL (audit defect D-1..D-4; reverse
 * cr-02): the audit found that "Development does not read
 * scenarioBindings / scenarioRealizationBindings". Here the frozen
 * baseline's `developmentSurface.handoffBindingKinds[kind].resolvesAgainst`
 * declaration IS the accepted universe ON THE CONSUMER SIDE: a
 * DevelopmentCase built over foreign or unrelated bindings is refused
 * typed (FOREIGN_LINEAGE), never constructed, never planned.
 *
 * PURITY: node:crypto (via the WP03/WP07 helpers) and pure functions only.
 * No session, no SQL, no clock, no network, no filesystem reads.
 */

/* The seam imports (single import site; re-exported for the package). */
import {
  HANDOFF_BINDING_KINDS,
  WORK_ITEM_OBLIGATION_KINDS,
  digestExcluding,
  findDuplicates,
  setIdentical,
  sha256OfCanonical,
} from '../../formalization/cells/what-freeze/shared.mjs';
import { isRefused as isUpstreamRefused, refused as upstreamRefused, artifactOf } from '../../formalization/cells/what-freeze/shared.mjs';

export {
  HANDOFF_BINDING_KINDS,
  WORK_ITEM_OBLIGATION_KINDS,
  digestExcluding,
  findDuplicates,
  setIdentical,
  sha256OfCanonical,
  artifactOf,
};

/* ------------------------------------------------------------------ */
/* Typed refusals (the closed seven-code kernel vocabulary)            */
/* ------------------------------------------------------------------ */

export const HANDOFF_REFUSAL_REASONS = Object.freeze([
  'COVERAGE_GAP',
  'DRIFT_DETECTED',
  'FOREIGN_LINEAGE',
  'MALFORMED_PRODUCT',
  'MISSING_LINEAGE',
  'SCOPE_VIOLATION',
  'STALE_LINEAGE',
]);

export function refused(reason, detail) {
  if (!HANDOFF_REFUSAL_REASONS.includes(reason)) {
    throw new Error(`DEVELOPMENT-HANDOFF-REFUSAL-UNKNOWN: ${String(reason)} is outside the closed refusal vocabulary`);
  }
  return { detail, ok: false, reason, refused: true };
}

export function isRefused(value) {
  return isUpstreamRefused(value);
}

/** Adapt an upstream (WP03/WP07/WP08-shaped) refusal to this package's shape (identity-preserving). */
export function adoptRefusal(upstream) {
  if (!isUpstreamRefused(upstream)) return null;
  if (!HANDOFF_REFUSAL_REASONS.includes(upstream.reason)) {
    // Never widen the vocabulary: an upstream reason outside the closed
    // seven is a malformed product on our side (fail-closed).
    return refused('MALFORMED_PRODUCT', `the upstream authority refused with reason outside the closed vocabulary: ${String(upstream.reason)} (${String(upstream.detail)})`);
  }
  return { detail: upstream.detail, ok: false, reason: upstream.reason, refused: true };
}

/* ------------------------------------------------------------------ */
/* The twelve binding domains                                          */
/* ------------------------------------------------------------------ */

/**
 * The twelve DevelopmentCase handoff binding domains (reverse graph
 * vocabularies.handoffBindingKinds; WP03 HANDOFF_BINDING_KINDS): each kind
 * maps to its installed DevelopmentCase field name (the reverse graph's
 * `installedField` column - the byte-for-byte mapping surface of reverse
 * edge/0015 "hands-off-byte-for-byte").
 */
export const HANDOFF_DOMAIN_FIELDS = Object.freeze({
  'acceptance-bindings': 'acceptanceBindings',
  'formalization-certificate': 'certificateRef',
  'integration-and-construction-obligations': 'integrationObligations',
  'prd-intent-bindings': 'prdIntentBindings',
  'repository-and-policy-bindings': 'repositoryPolicyBindings',
  'requirement-bindings': 'requirementBindings',
  'scenario-bindings': 'scenarioBindings',
  'scenario-realization-bindings': 'scenarioRealizationBindings',
  'solution-contract': 'solutionContractRef',
  'srs-reference-and-hash': 'srsRef',
  'terminal-claim-bindings': 'terminalClaimBindings',
  'what-baseline-reference-and-hash': 'baselineRef',
});

/** The closed set of the twelve DevelopmentCase domain field names. */
export const HANDOFF_DOMAIN_FIELD_NAMES = Object.freeze(Object.values(HANDOFF_DOMAIN_FIELDS));

/** The handoff kind of a domain field name (inverse lookup, fail-closed). */
export function handoffKindOfField(fieldName) {
  for (const [kind, field] of Object.entries(HANDOFF_DOMAIN_FIELDS)) {
    if (field === fieldName) return kind;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

/** The id list of a member/criterion array (order preserved, shape-tolerant). */
export const idsOf = (members, idKey) => members.map((member) => member[idKey]);

/** Sorted unique string list (canonical set view for fingerprints). */
export const sortedUnique = (values) => [...new Set(values)].sort();

/** True when every element of `subset` is in `superset` (set containment). */
export function subsetOf(subset, superset) {
  const universe = new Set(superset);
  return [...subset].every((value) => universe.has(value));
}

/** True when two unordered string collections are set-equal. */
export function sameSet(a, b) {
  const left = sortedUnique(a ?? []);
  const right = sortedUnique(b ?? []);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Guard: a non-empty array of non-empty strings. */
export function isNonEmptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);
}

/** Guard: a sha256 hex digest. */
export const isHex64 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** Guard: a content-addressed ref. */
export const isShaRef = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);

/** Guard: the closed WP03 frozen id pattern. */
export const ID_PATTERN = /^[a-z][a-z0-9]*(:[A-Za-z0-9][A-Za-z0-9._-]*)+$/;
export const isFrozenId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

/** Deterministic refusal routing for the development-entry handoff desk (declared table, never a guess). */
export const HANDOFF_OUTCOME_OF_REASON = Object.freeze({
  FOREIGN_LINEAGE: 'handoff-refused',
  STALE_LINEAGE: 'handoff-refused',
  DRIFT_DETECTED: 'handoff-refused',
  MISSING_LINEAGE: 'handoff-incomplete',
  COVERAGE_GAP: 'handoff-incomplete',
  MALFORMED_PRODUCT: 'handoff-malformed',
  SCOPE_VIOLATION: 'handoff-malformed',
});

/** Route one typed refusal reason through the handoff table (fail-closed on unknown). */
export function routeHandoffRefusal(refusalOrReason) {
  const reason = typeof refusalOrReason === 'string' ? refusalOrReason : refusalOrReason?.reason;
  const outcome = HANDOFF_OUTCOME_OF_REASON[reason];
  if (outcome === undefined) {
    return refused('SCOPE_VIOLATION', `reason ${String(reason)} has no declared route in the development-entry handoff table`);
  }
  return { ok: true, outcome };
}
