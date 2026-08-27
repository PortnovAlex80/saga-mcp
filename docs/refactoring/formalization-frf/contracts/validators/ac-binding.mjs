/**
 * FRF-WP03 pure validator: AC binding
 * (contract frf-contracts.ac-binding.v1).
 *
 * Deterministic, closed-vocabulary, fail-closed with typed refusal codes.
 * This is the BOTH-citation-shapes contract: a scenario-facing AC must
 * retain its exact UC scenario binding (edge/0051) AND its terminal-branch
 * binding (edge/0052) - stripping either is refused (the plan's killed
 * mutation "keep AC coverage but remove its terminal scenario binding").
 * Every criterion binds exact FR or NFR material (RULE is not AC-bindable:
 * the grammar allows FR or NFR only).
 *
 * Typed refusals:
 *   MALFORMED_PRODUCT - structural violations, open evidence vocabulary.
 *   SCOPE_VIOLATION   - architecture or file-allocation content (WHAT-side
 *                       fence).
 *   MISSING_LINEAGE   - missing accepted sets, empty bindings, one-sided
 *                       scenario/branch citation.
 *   FOREIGN_LINEAGE   - refs outside the exact accepted sets; RULE-only
 *                       bindings; branches whose owning scenario is not
 *                       cited (cross-level citation).
 */

import {
  REFUSAL_REASONS,
  refused,
  requireIdSet,
  resolveBranchRefsWithinCitedScenarios,
  resolveRefs,
  sealed,
} from './common.mjs';

export const CONTRACT_KIND = 'frf-contracts.ac-binding.v1';

const EVIDENCE_KINDS = Object.freeze([
  'audit',
  'independent-agent-review',
  'monitoring',
  'test',
]);

/** WHAT-side fence: AC must not contain architecture or file allocation. */
const FORBIDDEN_KEYS = Object.freeze([
  'files',
  'moduleAllocation',
  'participatingModules',
]);

export function validateAcBinding(criterion, universe) {
  if (criterion === null || typeof criterion !== 'object' || Array.isArray(criterion)) {
    return refused('MALFORMED_PRODUCT', 'AC binding is not an object');
  }
  if (criterion.schemaVersion !== CONTRACT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${CONTRACT_KIND}`);
  }
  for (const forbidden of FORBIDDEN_KEYS) {
    if (criterion[forbidden] !== undefined) {
      return refused('SCOPE_VIOLATION', `AC remains WHAT-side verification and must not contain architecture or ${forbidden} allocation decisions`);
    }
  }
  if (typeof criterion.criterionId !== 'string' || criterion.criterionId.length === 0) {
    return refused('MALFORMED_PRODUCT', 'every AC needs a stable atomic identity');
  }
  const purpose = `AC ${criterion.criterionId}`;

  const bindsTo = criterion.bindsTo;
  if (bindsTo === null || typeof bindsTo !== 'object' || Array.isArray(bindsTo)) {
    return refused('MALFORMED_PRODUCT', `${purpose} needs a bindsTo record`);
  }

  // Requirement lineage: exact FR or NFR members (fail-closed).
  const frRefusal = requireIdSet(universe, 'frIds', 'AC binds exact FR material');
  if (frRefusal !== null) return frRefusal;
  const nfrRefusal = requireIdSet(universe, 'nfrIds', 'AC binds exact NFR material');
  if (nfrRefusal !== null) return nfrRefusal;
  const requirementRefs = bindsTo.requirementRefs;
  if (!Array.isArray(requirementRefs) || requirementRefs.length === 0) {
    return refused('MISSING_LINEAGE', `${purpose} binds no exact FR or NFR material`);
  }
  const acBindable = [...universe.idSets.frIds, ...universe.idSets.nfrIds];
  const foreignRequirements = requirementRefs.filter((ref) => !acBindable.includes(ref));
  if (foreignRequirements.length > 0) {
    const ruleIds = universe.idSets.ruleIds ?? [];
    if (foreignRequirements.every((ref) => ruleIds.includes(ref))) {
      return refused('FOREIGN_LINEAGE', `${purpose} binds RULE material ${foreignRequirements.sort().join(', ')}; the grammar allows AC to derive from FR or NFR only`);
    }
    return refused('FOREIGN_LINEAGE', `${purpose} binds requirement(s) ${foreignRequirements.sort().join(', ')} outside the exact accepted FR/NFR id sets`);
  }

  // BOTH citation shapes: scenario-level and branch-level bindings travel together.
  const scenarioRefs = bindsTo.ucScenarioRefs ?? [];
  const branchRefs = bindsTo.ucTerminalBranchRefs ?? [];
  if (branchRefs.length > 0 && scenarioRefs.length === 0) {
    return refused('MISSING_LINEAGE', `${purpose} retains terminal-branch bindings but strips its UC scenario binding (a scenario-facing AC must retain BOTH citation shapes)`);
  }
  if (scenarioRefs.length > 0 && branchRefs.length === 0) {
    return refused('MISSING_LINEAGE', `${purpose} retains its UC scenario binding but strips the terminal scenario branch binding (a scenario-facing AC must retain BOTH citation shapes)`);
  }
  if (scenarioRefs.length > 0 && branchRefs.length > 0) {
    const scenarioRefusal = resolveRefs(scenarioRefs, 'ucScenarioIds', universe, { purpose });
    if (scenarioRefusal !== null) return scenarioRefusal;
    const branchRefusal = resolveBranchRefsWithinCitedScenarios(branchRefs, scenarioRefs, universe, {
      branchSetMissing: 'no accepted ucBranchIdsByScenario map was supplied (fail-closed)',
      purpose,
    });
    if (branchRefusal !== null) return branchRefusal;
  }

  // Evidence method: closed vocabulary + observable terminal result (cr-05).
  const evidence = criterion.evidence;
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return refused('MALFORMED_PRODUCT', `${purpose} needs an evidence record`);
  }
  if (!EVIDENCE_KINDS.includes(evidence.evidenceKind)) {
    return refused('MALFORMED_PRODUCT', `${purpose} has evidence kind ${String(evidence.evidenceKind)} outside the closed four-value vocabulary`);
  }
  if (typeof evidence.observableTerminalResult !== 'string' || evidence.observableTerminalResult.length === 0) {
    return refused('MALFORMED_PRODUCT', `${purpose} must declare its observable terminal result`);
  }

  // Verifiable statement references (fail-closed against the supplied set).
  const statementRefusal = resolveRefs(criterion.verifiableStatementRefs, 'verifiableStatementIds', universe, { purpose });
  if (statementRefusal !== null) return statementRefusal;

  return sealed(CONTRACT_KIND, criterion);
}

export { REFUSAL_REASONS };
