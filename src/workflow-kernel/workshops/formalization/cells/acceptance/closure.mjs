/**
 * FRF-WP06 define-acceptance-contract cell - THE CLOSURE VALIDATORS.
 *
 * The plan's named closure laws, as PURE checks the cell's gate runs
 * (plan "#Phase FRF-6": "Rebuild forward and reverse closure over
 * source, intent, scenario, requirements, acceptance, and evidence" and
 * the WP06 assignment):
 *
 *   1. REQUIREMENTS COVERAGE CLOSURE - every FR/NFR member of the
 *      accepted requirements bundle is covered by >=1 AC criterion OR
 *      carries an explicit deferred disposition (owner + reason; the
 *      plan's disposition grammar). An uncovered requirement is a typed
 *      COVERAGE_GAP naming the requirement. A deferral that targets a
 *      RULE or an unknown id is FOREIGN_LINEAGE (RULE is not
 *      AC-bindable and not deferrable at this desk; the grammar allows
 *      AC to derive from FR or NFR only). A requirement both covered
 *      and deferred is a contradictory double disposition
 *      (MALFORMED_PRODUCT).
 *
 *   2. AC-TO-SOURCE CLOSURE - every criterion binds accepted FR/NFR
 *      material (per-criterion law: the WP03 seam) AND cites accepted
 *      UC scenario + terminal branch TOGETHER whenever it verifies
 *      scenario-derived material (the BOTH-citation-shapes set law).
 *      A criterion that binds a scenario-derived FR/NFR but carries no
 *      UC citation at all is the one-sided "FR without UC" defect
 *      (MISSING_LINEAGE). A citation pair whose scenario is not the
 *      derivation scenario of ANY bound requirement is an unsupported
 *      substitution (FOREIGN_LINEAGE - a well-formed but semantically
 *      unrelated graph must not pass). Duplicate criterion ids are
 *      MALFORMED_PRODUCT (double emission).
 *
 *   3. TERMINAL-RESULT COVERAGE (cr-05, reverse edge/0007+0008) - every
 *      required UC terminal branch is covered by >=1 end-to-end
 *      criterion OR by an accepted standalone evidence binding whose
 *      evidence kind is in the closed four-value vocabulary and which
 *      declares an observable terminal result. Uncovered branches are
 *      COVERAGE_GAP naming the branch and its owning scenario.
 *
 * The report-only reconciliation over the same closed chain lives in
 * reconciliation.mjs (it NAMES gaps; it never mutates - the F-2 fix).
 *
 * PURITY: pure functions; node:crypto via the WP03 canonical rule only.
 * No I/O, no clock, no session, no SQL.
 */

import { sha256OfCanonical } from '../../../../../../docs/refactoring/formalization-frf/contracts/validators/common.mjs';
import {
  ACCEPTANCE_BUNDLE_SCHEMA_VERSION,
  EVIDENCE_KINDS,
} from './protocol.mjs';
import { validateAcBinding } from './wp03-seam.mjs';

/* ------------------------------------------------------------------ */
/* Typed refusals (the closed kernel vocabulary; shape pinned to        */
/* products.ts ProductRefusal)                                         */
/* ------------------------------------------------------------------ */

export const REFUSAL_REASONS = Object.freeze([
  'MALFORMED_PRODUCT',
  'FOREIGN_LINEAGE',
  'STALE_LINEAGE',
  'MISSING_LINEAGE',
  'COVERAGE_GAP',
  'DRIFT_DETECTED',
  'SCOPE_VIOLATION',
]);

function refused(reason, detail) {
  return { ok: false, refused: true, reason, detail };
}

/** One typed closure issue (the pure check finding a gate folds). */
export function closureIssue(source, subject, detail) {
  return { source, subject, detail };
}

/** The WHAT-side fence at bundle level (per-criterion fence: WP03 seam). */
const FORBIDDEN_BUNDLE_KEYS = Object.freeze([
  'participatingModules',
  'moduleAllocation',
  'files',
  'architecture',
]);

/* ------------------------------------------------------------------ */
/* Pure check 1: requirements coverage closure                          */
/* ------------------------------------------------------------------ */

/**
 * Every FR/NFR is covered by >=1 criterion or explicitly deferred.
 *
 * @param {readonly object[]} criteria the bundle's AC criteria (bindsTo.requirementRefs)
 * @param {readonly object[]} deferrals explicit deferred dispositions
 * @param {object} universe the accepted id-set universe (acceptanceUniverseFrom)
 * @returns {readonly object[]} typed closure issues (empty = closed)
 */
export function checkRequirementsCoverageClosure(criteria, deferrals, universe) {
  const issues = [];
  const idSets = universe?.idSets ?? {};
  const acBindable = [...(idSets.frIds ?? []), ...(idSets.nfrIds ?? [])];
  const ruleIds = idSets.ruleIds ?? [];
  const covered = new Set();
  for (const criterion of Array.isArray(criteria) ? criteria : []) {
    for (const ref of criterion?.bindsTo?.requirementRefs ?? []) covered.add(ref);
  }
  const deferred = new Map();
  for (const deferral of Array.isArray(deferrals) ? deferrals : []) {
    const subject = String(deferral?.requirementId ?? '<missing requirementId>');
    if (deferral?.disposition !== 'deferred') {
      issues.push(closureIssue('MALFORMED_PRODUCT', subject, `deferral of ${subject} has disposition ${String(deferral?.disposition)}; the only lawful disposition at this desk is deferred`));
      continue;
    }
    if (typeof deferral?.owner !== 'string' || deferral.owner.length === 0 || typeof deferral?.reason !== 'string' || deferral.reason.length === 0) {
      issues.push(closureIssue('MALFORMED_PRODUCT', subject, `deferral of ${subject} requires an owner and a reason (the plan's disposition grammar)`));
      continue;
    }
    if (deferred.has(subject)) {
      issues.push(closureIssue('MALFORMED_PRODUCT', subject, `requirement ${subject} is deferred twice (double emission)`));
      continue;
    }
    deferred.set(subject, deferral);
  }
  for (const [subject] of deferred) {
    if (ruleIds.includes(subject)) {
      issues.push(closureIssue('FOREIGN_LINEAGE', subject, `deferral targets RULE ${subject}; RULE is not AC-bindable and not deferrable at the acceptance desk (the grammar allows AC to derive from FR or NFR only)`));
    } else if (!acBindable.includes(subject)) {
      issues.push(closureIssue('FOREIGN_LINEAGE', subject, `deferral targets ${subject} outside the exact accepted FR/NFR id sets`));
    } else if (covered.has(subject)) {
      issues.push(closureIssue('MALFORMED_PRODUCT', subject, `requirement ${subject} is both covered by a criterion and deferred (contradictory double disposition)`));
    }
  }
  for (const requirementId of acBindable) {
    if (!covered.has(requirementId) && !deferred.has(requirementId)) {
      issues.push(closureIssue('COVERAGE_GAP', requirementId, `requirement ${requirementId} is covered by no AC criterion and carries no explicit deferred disposition (requirements coverage closure)`));
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Pure check 2: AC-to-source closure                                  */
/* ------------------------------------------------------------------ */

/**
 * Every criterion binds accepted FR/NFR material AND cites accepted UC
 * scenario + terminal branch together whenever it verifies
 * scenario-derived material; citations are supported by the bound
 * requirements' own derivation; criterion ids are unique.
 *
 * @param {readonly object[]} criteria the bundle's AC criteria
 * @param {object} universe the accepted id-set universe
 * @param {readonly object[]} requirements the accepted bundle members (derivation lineage)
 * @returns {readonly object[]} typed closure issues (empty = closed)
 */
export function checkAcToSourceClosure(criteria, requirements, universe) {
  const issues = [];
  const seen = new Map();
  const derivationByRequirement = new Map();
  for (const requirement of Array.isArray(requirements) ? requirements : []) {
    derivationByRequirement.set(requirement.requirementId, requirement.derivation ?? {});
  }
  for (const criterion of Array.isArray(criteria) ? criteria : []) {
    const subject = String(criterion?.criterionId ?? '<missing criterionId>');
    if (seen.has(subject)) {
      issues.push(closureIssue('MALFORMED_PRODUCT', subject, `duplicate criterion id ${subject} (double emission)`));
      continue;
    }
    seen.set(subject, criterion);
    const bindsTo = criterion?.bindsTo ?? {};
    const requirementRefs = Array.isArray(bindsTo.requirementRefs) ? bindsTo.requirementRefs : [];
    const scenarioRefs = Array.isArray(bindsTo.ucScenarioRefs) ? bindsTo.ucScenarioRefs : [];
    const branchRefs = Array.isArray(bindsTo.ucTerminalBranchRefs) ? bindsTo.ucTerminalBranchRefs : [];
    const scenarioDerivedBound = requirementRefs.filter((ref) => {
      const derivation = derivationByRequirement.get(ref);
      return derivation !== undefined && Array.isArray(derivation.ucScenarioRefs) && derivation.ucScenarioRefs.length > 0;
    });
    if (scenarioDerivedBound.length > 0 && scenarioRefs.length === 0 && branchRefs.length === 0) {
      issues.push(closureIssue('MISSING_LINEAGE', subject, `criterion ${subject} binds scenario-derived requirement(s) ${scenarioDerivedBound.sort().join(', ')} but cites no UC scenario or terminal branch (one-sided citation: FR without UC; a scenario-facing AC must retain BOTH citation shapes)`));
      continue;
    }
    if (scenarioDerivedBound.length > 0 && branchRefs.length === 0) {
      issues.push(closureIssue('MISSING_LINEAGE', subject, `criterion ${subject} retains its UC scenario binding but strips the terminal scenario branch binding (a scenario-facing AC must retain BOTH citation shapes)`));
      continue;
    }
    if (branchRefs.length > 0 && scenarioRefs.length === 0) {
      issues.push(closureIssue('MISSING_LINEAGE', subject, `criterion ${subject} retains terminal-branch bindings but strips its UC scenario binding (one-sided citation: branch without scenario)`));
      continue;
    }
    if (scenarioRefs.length > 0 && scenarioDerivedBound.length > 0) {
      const supportedScenarios = new Set(scenarioDerivedBound.flatMap((ref) => derivationByRequirement.get(ref)?.ucScenarioRefs ?? []));
      const unsupported = scenarioRefs.filter((ref) => !supportedScenarios.has(ref));
      if (unsupported.length > 0) {
        issues.push(closureIssue('FOREIGN_LINEAGE', subject, `criterion ${subject} cites UC scenario(s) ${unsupported.sort().join(', ')} that no bound requirement derives from (a well-formed but semantically unsupported substitution)`));
      }
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Pure check 3: terminal-result coverage (cr-05)                       */
/* ------------------------------------------------------------------ */

/**
 * Every required UC terminal branch is covered by >=1 end-to-end
 * criterion or by a well-formed accepted standalone evidence binding.
 *
 * @param {readonly object[]} criteria the bundle's AC criteria
 * @param {readonly object[]} standaloneEvidenceBindings cr-05 non-AC coverers
 * @param {object} universe the accepted id-set universe
 * @returns {readonly object[]} typed closure issues (empty = closed)
 */
export function checkTerminalResultCoverage(criteria, standaloneEvidenceBindings, universe) {
  const issues = [];
  const idSets = universe?.idSets ?? {};
  const byScenario = idSets.ucBranchIdsByScenario ?? {};
  const requiredBranches = new Map();
  for (const [scenarioId, branchIds] of Object.entries(byScenario)) {
    for (const branchId of branchIds) requiredBranches.set(branchId, scenarioId);
  }
  const covered = new Set();
  for (const criterion of Array.isArray(criteria) ? criteria : []) {
    for (const branchId of criterion?.bindsTo?.ucTerminalBranchRefs ?? []) covered.add(branchId);
  }
  const acceptedEvidenceIds = idSets.evidenceBindingIds ?? [];
  for (const binding of Array.isArray(standaloneEvidenceBindings) ? standaloneEvidenceBindings : []) {
    const subject = String(binding?.evidenceBindingId ?? '<missing evidenceBindingId>');
    if (!EVIDENCE_KINDS.includes(binding?.evidenceKind)) {
      issues.push(closureIssue('MALFORMED_PRODUCT', subject, `evidence binding ${subject} has kind ${String(binding?.evidenceKind)} outside the closed four-value vocabulary`));
      continue;
    }
    if (typeof binding?.observableTerminalResult !== 'string' || binding.observableTerminalResult.length === 0) {
      issues.push(closureIssue('MALFORMED_PRODUCT', subject, `evidence binding ${subject} must declare its observable terminal result`));
      continue;
    }
    if (acceptedEvidenceIds.length > 0 && !acceptedEvidenceIds.includes(subject)) {
      issues.push(closureIssue('FOREIGN_LINEAGE', subject, `evidence binding ${subject} is outside the accepted evidence-binding id set`));
      continue;
    }
    for (const branchId of binding?.ucTerminalBranchRefs ?? []) covered.add(branchId);
  }
  for (const [branchId, scenarioId] of requiredBranches) {
    if (!covered.has(branchId)) {
      issues.push(closureIssue('COVERAGE_GAP', branchId, `required UC terminal result ${branchId} of scenario ${scenarioId} has no end-to-end AC criterion and no accepted evidence binding (cr-05)`));
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* The cell's bundle gate validator                                     */
/* ------------------------------------------------------------------ */

/**
 * Validate the whole acceptance bundle: per-criterion WP03 validation
 * through the seam (refusals propagate VERBATIM), then the three
 * closure laws over the set. This is the pure validator the cell's
 * gate runs (gate.mjs).
 *
 * @param {object} product { schemaVersion, criteria, deferrals, standaloneEvidenceBindings }
 * @param {object} universe the accepted id-set universe (acceptanceUniverseFrom)
 * @param {readonly object[]} requirements the accepted bundle members (lineage for check 2)
 */
export function validateAcceptanceBundle(product, universe, requirements) {
  if (product === null || typeof product !== 'object' || Array.isArray(product)) {
    return refused('MALFORMED_PRODUCT', 'the acceptance bundle is not an object');
  }
  if (product.schemaVersion !== ACCEPTANCE_BUNDLE_SCHEMA_VERSION) {
    return refused('MALFORMED_PRODUCT', `product is not a ${ACCEPTANCE_BUNDLE_SCHEMA_VERSION}`);
  }
  for (const forbidden of FORBIDDEN_BUNDLE_KEYS) {
    if (product[forbidden] !== undefined) {
      return refused('SCOPE_VIOLATION', `AC remains WHAT-side verification and must not contain architecture or ${forbidden} allocation decisions`);
    }
  }
  const criteria = product.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return refused('MALFORMED_PRODUCT', 'the acceptance contract must contain at least one criterion');
  }

  // Per-criterion: the WP03 seam (fail-closed; refusals propagate verbatim).
  for (const criterion of criteria) {
    const validation = validateAcBinding(criterion, universe);
    if (!validation.ok) {
      return { ok: false, refused: true, reason: validation.reason, detail: `criterion ${String(criterion?.criterionId ?? '<unnamed>')}: ${validation.detail}` };
    }
  }

  // Set-level closure laws (the plan's named laws; order: source closure,
  // then coverage, then terminal results - one detector per defect).
  const sourceIssues = checkAcToSourceClosure(criteria, requirements, universe);
  if (sourceIssues.length > 0) {
    const first = sourceIssues[0];
    return refused(first.source, first.detail);
  }
  const coverageIssues = checkRequirementsCoverageClosure(criteria, product.deferrals ?? [], universe);
  if (coverageIssues.length > 0) {
    const first = coverageIssues[0];
    return refused(first.source, first.detail);
  }
  const terminalIssues = checkTerminalResultCoverage(criteria, product.standaloneEvidenceBindings ?? [], universe);
  if (terminalIssues.length > 0) {
    const first = terminalIssues[0];
    return refused(first.source, first.detail);
  }

  const digest = sha256OfCanonical(product);
  return { ok: true, artifact: { ref: `sha256:${digest}`, digest, content: product } };
}
