/**
 * FINDING-TRAJECTORY BUDGET — the pure convergence predicate
 * (docs/architecture/FINDING-TRAJECTORY-BUDGET.md, variant d hybrid).
 *
 * CONVEYOR §15 ("Budget must count spin, not work"): a repair attempt whose
 * rejected-finding key set is a STRICT SUBSET of the previous attempt removed
 * another link of the defect chain — that is work, not spin, and the epoch
 * budget must not tax it. The honest signal is the SET RELATION, never the
 * count: 15 -> 14 with one NEW key has a falling count but is cosmetic churn
 * (a live core still rejects), while 15 -> 5 strict-subset is textbook
 * convergence.
 *
 * Semantics (mirroring the b004 obligationReasonKey/applyReasonIdentityValve
 * house pattern — reason IDENTITY, not prose):
 *   - `findingKey`    — typed code + normalized message identity. Semver
 *                       @tokens and hex runs >= 16 (run digests, content
 *                       hashes) are stripped: a re-run always churns those,
 *                       and churned identity would manufacture false "new
 *                       keys" (over-tax) or mask real ones.
 *   - `findingSet`    — the comparable identity of one rejection: digest,
 *                       count, canonically ordered keys, fatalKeys.
 *   - `trajectory`    — 'converging' | 'spinning' | 'churning'
 *                       | 'scope-impossible':
 *                       spinning  = byte-identical key set;
 *                       converging= strict subset (>= 1 removed AND 0 new)
 *                                   AND the fatal key set did not grow
 *                                   (severity growth re-taxes, §15 fail-safe:
 *                                   over-tax, never under-tax);
 *                       churning  = everything else;
 *                       scope-impossible = spinning-or-churning while the SAME
 *                                   path-outside-authority key sits in both
 *                                   sets (REPLAN-CYCLE-TZ §1 — re-plan
 *                                   mandate, not another attempt).
 *   - Review-path exclusion (design constraint): reviewer findings carry
 *     ORDINAL codes (`review-finding-N`, `deferred-out-of-scope-N`) over free
 *     prose — the same ordinal means a different finding on the next attempt,
 *     so those keys are unstable and are NEVER compared. Two attempts whose
 *     comparable sets are both empty are SPINNING (fail-safe charge).
 */

import { canonicalJson, sha256Hex } from '../../../shared/canonical-json.js';

/** Ordinal review-path codes — index-derived, unstable between attempts. */
const ORDINAL_REVIEW_CODE = /^(?:review-finding|deferred-out-of-scope)-\d+$/;

/**
 * Tests the DIAGNOSTIC segment of a composed provider-scoped code
 * (`${providerId}:${diagnostic.code}`): the provider prefix is stable, the
 * trailing ordinal is the attempt-local part.
 */
export function isOrdinalReviewCode(code: string): boolean {
  const segments = String(code ?? '').split(':');
  return ORDINAL_REVIEW_CODE.test(segments[segments.length - 1] ?? '');
}

const SEMVER_TOKEN = /@v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/g;
const HEX_RUN_16 = /[0-9a-fA-F]{16,}/g;

/**
 * Strip the volatile identity noise from a finding message: provider semver
 * tokens (a version bump is not a new defect) and hex runs of 16+ chars
 * (digests / content hashes — always fresh per run). Shorter hex (task ids,
 * ordinals embedded in prose) is identity and stays.
 */
export function normalizeFindingMessage(message: string): string {
  return String(message ?? '')
    .replace(SEMVER_TOKEN, '@<semver>')
    .replace(HEX_RUN_16, '<hex>')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TrajectoryFinding {
  /** Composed provider-scoped code (`${providerId}:${diagnostic.code}`). */
  readonly code: string;
  readonly severity: 'fatal' | 'error';
  readonly message: string;
}

export function findingKey(finding: TrajectoryFinding): string {
  return `${finding.code}::${normalizeFindingMessage(finding.message)}`;
}

export interface FindingSet {
  /** SHA-256 over the canonical comparable identity (order-insensitive). */
  readonly digest: string;
  /** Number of COMPARABLE findings (ordinal review findings excluded). */
  readonly count: number;
  /** Canonically ordered comparable keys. */
  readonly keys: readonly string[];
  /** Canonically ordered subset of `keys` that carried severity 'fatal'. */
  readonly fatalKeys: readonly string[];
}

/**
 * The comparable identity of one rejection. Ordinal review findings are
 * excluded from the identity: their codes are attempt-local ordinals over
 * free prose and would manufacture false convergence / false novelty between
 * attempts (design: comparison covers check-diagnostic findings only).
 */
export function findingSet(findings: readonly TrajectoryFinding[]): FindingSet {
  const keys = new Set<string>();
  const fatal = new Set<string>();
  for (const finding of findings) {
    if (isOrdinalReviewCode(finding.code)) continue;
    const key = findingKey(finding);
    keys.add(key);
    if (finding.severity === 'fatal') fatal.add(key);
  }
  const orderedKeys = [...keys].sort();
  const fatalKeys = [...fatal].sort();
  return {
    digest: sha256Hex(canonicalJson({ keys: orderedKeys, fatalKeys })),
    count: orderedKeys.length,
    keys: orderedKeys,
    fatalKeys,
  };
}

export type FindingTrajectory = 'converging' | 'spinning' | 'churning' | 'scope-impossible';

/**
 * RE-PLAN CYCLE (REPLAN-CYCLE-TZ §1) — the diagnostic code of the frozen
 * changeScopes authority check (development-check-providers.ts). A finding
 * with this code names Git paths OUTSIDE the item's frozen scope: the worker
 * physically cannot repair it inside its own authority — the defect is
 * cross-seam, and the cure is a re-carve, not another attempt.
 */
const PATH_OUTSIDE_AUTHORITY_CODE = 'path-outside-authority';

/** Tests a comparable key's CODE segment (`${code}::${message}`). */
export function isPathOutsideAuthorityKey(key: string): boolean {
  const code = String(key ?? '').split('::')[0] ?? '';
  return code === PATH_OUTSIDE_AUTHORITY_CODE
    || code.endsWith(`:${PATH_OUTSIDE_AUTHORITY_CODE}`);
}

/**
 * The path-outside-authority keys present in BOTH sets — the cross-seam
 * defects that survived a full repair attempt unchanged.
 */
export function survivingScopeViolationKeys(
  prev: FindingSet,
  latest: FindingSet,
): readonly string[] {
  const prevKeys = new Set(prev.keys);
  return latest.keys.filter(key => prevKeys.has(key) && isPathOutsideAuthorityKey(key));
}

/**
 * The trajectory between two consecutive rejections of one
 * (workplace, gate, role, check-plan) chain.
 *
 * converging:      strict subset (>= 1 removed, 0 new) AND fatalKeys(next)
 *                  is a subset of fatalKeys(prev) — severity never grew.
 * spinning:        byte-identical key set (the same defect chain returns).
 * churning:        everything else — including any new key and any severity
 *                  growth. Fail-safe direction: over-tax, never under-tax.
 * scope-impossible: spinning-or-churning overall WHILE the same
 *                  path-outside-authority key sits in both sets — the worker
 *                  cannot write into the frozen scope it keeps offending, so
 *                  budget/tax semantics are moot: the route is a re-plan
 *                  mandate, never another attempt (REPLAN-CYCLE-TZ §1).
 */
export function trajectory(prev: FindingSet, next: FindingSet): FindingTrajectory {
  const base = baseTrajectory(prev, next);
  if (base !== 'converging' && survivingScopeViolationKeys(prev, next).length > 0) {
    return 'scope-impossible';
  }
  return base;
}

function baseTrajectory(prev: FindingSet, next: FindingSet): FindingTrajectory {
  const prevKeys = new Set(prev.keys);
  const nextKeys = new Set(next.keys);
  const identical = prevKeys.size === nextKeys.size
    && next.keys.every(key => prevKeys.has(key));
  if (identical) return 'spinning';
  const removed = [...prevKeys].filter(key => !nextKeys.has(key)).length;
  const added = [...nextKeys].filter(key => !prevKeys.has(key)).length;
  if (removed >= 1 && added === 0) {
    const prevFatal = new Set(prev.fatalKeys);
    const fatalGrew = next.fatalKeys.some(key => !prevFatal.has(key));
    return fatalGrew ? 'churning' : 'converging';
  }
  return 'churning';
}

/**
 * The number of consecutive CONVERGING steps ending at the last set of the
 * chain (oldest -> newest). Identity (spinning) and churn both break the run.
 * A single set cannot converge against nothing: streak 0.
 */
export function convergingStreak(sets: readonly FindingSet[]): number {
  let streak = 0;
  for (let i = sets.length - 1; i >= 1; i -= 1) {
    if (trajectory(sets[i - 1]!, sets[i]!) !== 'converging') break;
    streak += 1;
  }
  return streak;
}
