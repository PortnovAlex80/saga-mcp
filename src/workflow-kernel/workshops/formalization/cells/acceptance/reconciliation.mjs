/**
 * FRF-WP06 define-acceptance-contract cell - REPORT-ONLY RECONCILIATION.
 *
 * Desk contract authority: plan "#Desk contracts/reconcile-what" - "The
 * Cell validates and reports the closed chain:
 *   Discovery source claim -> PRD intent member or explicit disposition
 *   -> UC or justified direct requirement -> FR/NFR/RULE
 *   -> AC/evidence obligation.
 * The reconciler may not add, delete, or patch an accepted artifact,
 * member, or trace."
 *
 * THE F-2 FINDING FIX (forward graph finding F-2, ledger D-9/A5
 * tightening): the INSTALLED accepted-material fold hardcodes
 * reconciliation verdict 'consistent' regardless of the product's
 * actual verdict (contribution.ts:99-100; an accepted 'gaps' report
 * still folds as consistent). This module is the replacement surface:
 * the verdict is COMPUTED from the actual typed findings -
 *   verdict === 'gaps'  iff  findings.length > 0
 *   verdict === 'consistent' iff  findings.length === 0
 * - never hardcoded, never a parameter, never trusted from input. The
 * computed-verdict law is enforced structurally (reconcileWhat takes no
 * verdict input at all) and proven by tests: a snapshot with any gap
 * MUST yield verdict 'gaps' with the named gap, and the
 * hardcode-'consistent' mutation is killed.
 *
 * REPORT-ONLY LAW (cr-12): this module names gaps; it NEVER mutates.
 * It performs no writes, emits no revisions, patches no artifact, and
 * returns a deep-frozen report. A lawful repair creates a new immutable
 * revision in the OWNING upstream cell - never here. Tests prove
 * input-immutability byte-for-byte (deep clone compare) and report
 * frozenness.
 *
 * Row shape continuity: rows keep the INSTALLED
 * formalization.what-reconciliation.v1 shape
 * { sourceClaimRef, memberRef, scenarioRef|'direct', requirementRefs,
 * criterionRefs } so the FRF-WP11 cutover can adopt the report without
 * a new artifact family.
 *
 * PURITY: pure functions; node:crypto via the WP03 canonical rule only.
 * No I/O, no clock, no session, no SQL, no mutation of any input.
 */

import { sha256OfCanonical } from '../../../../../../docs/refactoring/formalization-frf/contracts/validators/common.mjs';
import { validateAcBinding } from './wp03-seam.mjs';
import {
  checkAcToSourceClosure,
  checkRequirementsCoverageClosure,
  checkTerminalResultCoverage,
} from './closure.mjs';

export const RECONCILIATION_REPORT_KIND = 'formalization.what-reconciliation.v1';

/** Recursively freeze (the report and everything inside it is immutable). */
function deepFrozen(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFrozen(entry);
    Object.freeze(value);
    return value;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFrozen(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** One typed reconciliation finding over one chain layer. */
function finding(direction, layer, reason, subject, detail) {
  return { direction, layer, reason, subject, detail };
}

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * Recompute the closed WHAT chain over the accepted snapshot and REPORT
 * it. Forward direction: does every upstream member carry downstream
 * material? Reverse direction: does every downstream binding resolve to
 * accepted upstream material? Findings use the closed typed refusal
 * vocabulary; nothing is ever mutated.
 *
 * @param {object} snapshot the accepted material:
 *   { universe, requirements, acceptance: { criteria, deferrals,
 *     standaloneEvidenceBindings }, prd?: { memberIds, scenarioRequiredMemberIds,
 *     directRequirementMemberIds, deferredMemberIds }, useCases?: { scenarioIds,
 *     branchIdsByScenario }, sourceClaims?: { claimIds, claimToMember? } }
 * @returns {object} the deep-frozen report (verdict COMPUTED - see header)
 */
export function reconcileWhat(snapshot) {
  const findings = [];
  const universe = snapshot?.universe;
  const requirements = asArray(snapshot?.requirements);
  const criteria = asArray(snapshot?.acceptance?.criteria);
  const deferrals = asArray(snapshot?.acceptance?.deferrals);
  const evidenceBindings = asArray(snapshot?.acceptance?.standaloneEvidenceBindings);

  // Fail-closed layer presence (a missing layer is a named gap, not a skip).
  if (universe === null || typeof universe !== 'object') {
    findings.push(finding('forward', 'chain', 'MISSING_LINEAGE', 'universe', 'no accepted id-set universe was supplied; the reconciler is fail-closed and will not guess the accepted chain'));
  } else {
    // Reverse: every criterion resolves against the accepted universe
    // (the WP03 seam per criterion - refusals become named findings).
    for (const criterion of criteria) {
      const validation = validateAcBinding(criterion, universe);
      if (!validation.ok) {
        findings.push(finding('reverse', 'acceptance', validation.reason, String(criterion?.criterionId ?? '<unnamed>'), `criterion ${String(criterion?.criterionId ?? '<unnamed>')}: ${validation.detail}`));
      }
    }
    // The three closure laws (same pure checks the gate runs).
    for (const issue of checkAcToSourceClosure(criteria, requirements, universe)) {
      findings.push(finding('reverse', 'acceptance', issue.source, issue.subject, issue.detail));
    }
    for (const issue of checkRequirementsCoverageClosure(criteria, deferrals, universe)) {
      findings.push(finding('forward', 'requirements', issue.source, issue.subject, issue.detail));
    }
    for (const issue of checkTerminalResultCoverage(criteria, evidenceBindings, universe)) {
      findings.push(finding('forward', 'evidence', issue.source, issue.subject, issue.detail));
    }
  }

  // Forward: the PRD -> scenario layer (report-only; the owning cells gate it).
  const prd = snapshot?.prd;
  const useCases = snapshot?.useCases;
  if (prd === null || prd === undefined || useCases === null || useCases === undefined) {
    findings.push(finding('forward', 'chain', 'MISSING_LINEAGE', 'prd/useCases', 'the reconciler reports the complete accepted chain (claim -> intent -> scenario -> requirement -> criterion); a layer is absent'));
  } else {
    const scenarioCovered = new Set();
    for (const requirement of requirements) {
      for (const ref of asArray(requirement?.derivation?.ucScenarioRefs)) scenarioCovered.add(ref);
    }
    for (const memberId of asArray(prd.scenarioRequiredMemberIds)) {
      const coveredBy = requirements.filter((requirement) =>
        asArray(requirement?.derivation?.prdIntentRefs).includes(memberId));
      if (coveredBy.length === 0) {
        findings.push(finding('forward', 'intent', 'COVERAGE_GAP', memberId, `scenario_required PRD member ${memberId} reaches no accepted requirement (intent -> requirement layer gap)`));
      }
    }
    for (const scenarioId of asArray(useCases.scenarioIds)) {
      if (!scenarioCovered.has(scenarioId)) {
        findings.push(finding('forward', 'scenario', 'COVERAGE_GAP', scenarioId, `accepted UC scenario ${scenarioId} produces no requirement obligation (scenario survival gap; cr-06)`));
      }
    }
  }

  // The computed verdict - THE F-2 FIX. Never a parameter, never trusted.
  const verdict = findings.length === 0 ? 'consistent' : 'gaps';

  const report = {
    schemaVersion: RECONCILIATION_REPORT_KIND,
    verdict,
    gaps: findings.map((entry) => ({ direction: entry.direction, reason: entry.reason, detail: entry.detail })),
    findings,
    reconciledBy: 'frf-cells.acceptance.reconciliation.v1 (report-only; computed verdict)',
    rows: chainRows(snapshot),
  };
  report.reportDigest = `sha256:${sha256OfCanonical({ ...report, reportDigest: undefined })}`;
  return deepFrozen(report);
}

/** The closed-chain claim coverage rows (installed row shape). */
function chainRows(snapshot) {
  const requirements = asArray(snapshot?.requirements);
  const criteria = asArray(snapshot?.acceptance?.criteria);
  const claims = asArray(snapshot?.sourceClaims?.claimIds);
  const claimToMember = snapshot?.sourceClaims?.claimToMember ?? {};
  if (claims.length === 0) return [];
  return claims.map((claimId) => {
    const memberRef = String(claimToMember[claimId] ?? 'unmapped');
    const scenarioRef = 'direct';
    const requirementRefs = requirements
      .filter((requirement) => asArray(requirement?.derivation?.prdIntentRefs).includes(memberRef))
      .map((requirement) => requirement.requirementId);
    const criterionRefs = criteria
      .filter((criterion) => asArray(criterion?.bindsTo?.requirementRefs).some((ref) => requirementRefs.includes(ref)))
      .map((criterion) => criterion.criterionId);
    return { sourceClaimRef: claimId, memberRef, scenarioRef, requirementRefs, criterionRefs };
  });
}
