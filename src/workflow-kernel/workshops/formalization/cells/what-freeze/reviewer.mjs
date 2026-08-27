/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/reviewer.mjs -
 * the reviewer route of the WHAT-freeze and settle kernel desks
 * (FRF-WP07): typed review verdict payloads over EXACT content-addressed
 * artifacts.
 *
 * LAWS:
 *   - A verdict BINDS its exact artifact: the payload must cite the
 *     artifact ref AND (for the baseline) the whole-WHAT digest of the
 *     artifact the desk produced. A verdict over any other ref is a
 *     FOREIGN_LINEAGE refusal; a verdict citing the right ref with a
 *     mismatched digest is DRIFT_DETECTED.
 *   - Monotonicity: a rejection requires at least one typed issue from
 *     the closed refusal vocabulary; an acceptance requires zero issues
 *     (a prose-only or issue-carrying acceptance is refused).
 *   - The reviewer never produces the baseline/contract itself (the
 *     freezer builds from accepted inputs; the settler seals from the
 *     two authorities) - the verdict is the reviewer's only product.
 *
 * PURITY: pure functions. No I/O.
 */

import { isRefused, refused } from './shared.mjs';
import { PRODUCT_REFUSAL_REASONS } from './shared.mjs';

/** The closed verdict vocabulary of the kernel desks' reviewer. */
export const REVIEW_VERDICTS = Object.freeze(['accepted', 'rejected']);

/**
 * Validate one review verdict payload over the desk's exact artifact.
 * `artifact` is { ref, digest, content } (the sealed desk product).
 */
export function validateArtifactReview(payload, artifact, { wholeDigestKey = null } = {}) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return refused('MALFORMED_PRODUCT', 'the review verdict payload is not an object');
  }
  if (!REVIEW_VERDICTS.includes(payload.verdict)) {
    return refused('MALFORMED_PRODUCT', `verdict ${String(payload.verdict)} is outside the closed vocabulary {accepted, rejected}`);
  }
  if (typeof payload.artifactRef !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(payload.artifactRef)) {
    return refused('MALFORMED_PRODUCT', 'the verdict must cite the reviewed artifact as a content-addressed ref (sha256:<64 hex>)');
  }
  if (payload.artifactRef !== artifact.ref) {
    return refused('FOREIGN_LINEAGE', `the verdict cites artifact ${payload.artifactRef}, the desk produced ${artifact.ref} (a verdict binds its exact artifact)`);
  }
  if (wholeDigestKey !== null) {
    if (typeof payload[wholeDigestKey] !== 'string' || payload[wholeDigestKey] !== artifact.content?.[wholeDigestKey]) {
      return refused('DRIFT_DETECTED', `the verdict's ${wholeDigestKey} does not match the produced artifact (a verdict over partially-substituted content is refused)`);
    }
  }
  const issues = payload.issues ?? [];
  if (!Array.isArray(issues)) {
    return refused('MALFORMED_PRODUCT', 'the verdict issues must be a typed list');
  }
  for (const issue of issues) {
    if (!PRODUCT_REFUSAL_REASONS.includes(issue?.reason) || typeof issue?.detail !== 'string' || issue.detail.length === 0) {
      return refused('MALFORMED_PRODUCT', `issue ${JSON.stringify(issue)} is not typed {reason: <closed vocabulary>, detail}`);
    }
  }
  if (payload.verdict === 'accepted' && issues.length > 0) {
    return refused('MALFORMED_PRODUCT', 'an accepting verdict must carry no issues (monotonicity; a conditioned acceptance is not an acceptance)');
  }
  if (payload.verdict === 'rejected' && issues.length === 0) {
    return refused('MALFORMED_PRODUCT', 'a rejecting verdict requires at least one typed issue (no prose-only rejections)');
  }
  return { ok: true, verdict: payload.verdict };
}

/** Convenience: the baseline review (binds the whole-WHAT digest). */
export function validateBaselineReview(payload, baselineArtifact) {
  const result = validateArtifactReview(payload, baselineArtifact, { wholeDigestKey: 'wholeWhatDigest' });
  if (isRefused(result)) return result;
  return { ok: true, verdict: result.verdict, boundWholeWhatDigest: baselineArtifact.content.wholeWhatDigest };
}

/** Convenience: the solution-contract review (binds the canonical digest). */
export function validateSettlementReview(payload, contractArtifact) {
  const result = validateArtifactReview(payload, contractArtifact);
  if (isRefused(result)) return result;
  if (typeof payload.canonicalDigest !== 'string' || payload.canonicalDigest !== contractArtifact.content?.canonicalDigest) {
    return refused('DRIFT_DETECTED', 'the verdict must bind the contract\'s canonical digest');
  }
  return { ok: true, verdict: result.verdict, boundCanonicalDigest: contractArtifact.content.canonicalDigest };
}
