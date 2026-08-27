/**
 * FRF-WP03 pure validator: requirements bundle
 * (contract frf-contracts.requirements-bundle.v1).
 *
 * Deterministic, closed-vocabulary, fail-closed with typed refusal codes.
 * FR/NFR/RULE members derive from exact accepted PRD and UC material only:
 * no requirement may derive from foreign, stale, superseded or unaccepted
 * material (cr-08). Branch citations resolve at their own level: a terminal
 * branch must resolve inside a CITED owning scenario (cross-level citations
 * are refused FOREIGN_LINEAGE). Every accepted UC scenario must produce at
 * least one observable behavior obligation (cr-06).
 *
 * Typed refusals:
 *   MALFORMED_PRODUCT - structural violations, open requirement-kind
 *                       vocabulary, duplicate ids.
 *   MISSING_LINEAGE   - missing accepted sets, empty derivation refs,
 *                       scenario-derived FR without branch lineage,
 *                       UC-cited bundle without a UC revision pin.
 *   STALE_LINEAGE     - revision pins that are not the accepted revisions.
 *   FOREIGN_LINEAGE   - any ref outside the exact accepted sets; branches
 *                       whose owning scenario is not cited.
 *   COVERAGE_GAP      - an accepted UC scenario produces no obligation.
 */

import {
  REFUSAL_REASONS,
  findDuplicates,
  refused,
  requireIdSet,
  resolveBranchRefsWithinCitedScenarios,
  resolveRefs,
  sealed,
} from './common.mjs';

export const CONTRACT_KIND = 'frf-contracts.requirements-bundle.v1';

const REQUIREMENT_KINDS = Object.freeze(['FR', 'NFR', 'RULE']);

export function validateRequirementsBundle(bundle, universe) {
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return refused('MALFORMED_PRODUCT', 'requirements bundle is not an object');
  }
  if (bundle.schemaVersion !== CONTRACT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${CONTRACT_KIND}`);
  }

  // Revision pins: the exact accepted revisions (never stale/superseded).
  const pinRefusal = requireIdSet(universe, 'prdMemberIds', 'requirements derive from accepted PRD material');
  if (pinRefusal !== null) return pinRefusal;
  const ucSetRefusal = requireIdSet(universe, 'ucScenarioIds', 'requirements derive from accepted UC material');
  if (ucSetRefusal !== null) return ucSetRefusal;
  const pins = universe?.revisionPins ?? {};
  if (typeof pins.prd !== 'string' || !/^[0-9a-f]{64}$/.test(pins.prd)) {
    return refused('MISSING_LINEAGE', 'no accepted PRD revision digest was supplied (fail-closed: a bundle pin cannot be verified without the accepted revision)');
  }
  if (typeof pins.uc !== 'string' || !/^[0-9a-f]{64}$/.test(pins.uc)) {
    return refused('MISSING_LINEAGE', 'no accepted UC revision digest was supplied (fail-closed: a bundle pin cannot be verified without the accepted revision)');
  }
  if (typeof bundle.prdRevisionRef !== 'string' || bundle.prdRevisionRef !== `sha256:${pins.prd}`) {
    return refused('STALE_LINEAGE', `the pinned PRD revision ${String(bundle.prdRevisionRef)} is not the accepted revision sha256:${pins.prd} (a requirement may not derive from a stale revision)`);
  }

  const requirements = bundle.requirements;
  if (!Array.isArray(requirements) || requirements.length === 0) {
    return refused('MALFORMED_PRODUCT', 'the requirements bundle must contain at least one FR, NFR or RULE');
  }
  const duplicateIds = findDuplicates(requirements.map((entry) => entry.requirementId));
  if (duplicateIds.length > 0) {
    return refused('MALFORMED_PRODUCT', `duplicate requirement id(s) ${duplicateIds.join(', ')}`);
  }

  const coveredScenarios = new Set();
  let citesUc = false;
  for (const requirement of requirements) {
    const purpose = `requirement ${String(requirement.requirementId)}`;
    if (requirement === null || typeof requirement !== 'object' || typeof requirement.requirementId !== 'string' || requirement.requirementId.length === 0) {
      return refused('MALFORMED_PRODUCT', 'every requirement needs a stable id');
    }
    if (!REQUIREMENT_KINDS.includes(requirement.requirementKind)) {
      return refused('MALFORMED_PRODUCT', `${purpose} has kind ${String(requirement.requirementKind)} outside the closed FR/NFR/RULE vocabulary`);
    }
    if (typeof requirement.statement !== 'string' || requirement.statement.length === 0) {
      return refused('MALFORMED_PRODUCT', `${purpose} needs a statement`);
    }
    const derivation = requirement.derivation;
    if (derivation === null || typeof derivation !== 'object' || Array.isArray(derivation)) {
      return refused('MALFORMED_PRODUCT', `${purpose} needs a derivation record`);
    }

    // Exact PRD intent lineage (required for every kind).
    const intentRefusal = resolveRefs(derivation.prdIntentRefs, 'prdMemberIds', universe, { purpose });
    if (intentRefusal !== null) return intentRefusal;

    // Verification surfaces (fail-closed against the supplied set).
    const surfaceRefusal = resolveRefs(requirement.verificationSurfaceRefs, 'verificationSurfaceIds', universe, { purpose });
    if (surfaceRefusal !== null) return surfaceRefusal;

    // Scenario lineage: scenario-level and branch-level are distinct bindings.
    const scenarioRefs = derivation.ucScenarioRefs ?? [];
    const branchRefs = derivation.ucTerminalBranchRefs ?? [];
    if (scenarioRefs.length > 0 || branchRefs.length > 0) {
      citesUc = true;
      if (scenarioRefs.length > 0) {
        const scenarioRefusal = resolveRefs(scenarioRefs, 'ucScenarioIds', universe, { purpose });
        if (scenarioRefusal !== null) return scenarioRefusal;
        for (const ref of scenarioRefs) coveredScenarios.add(ref);
      }
      if (branchRefs.length > 0) {
        const branchRefusal = resolveBranchRefsWithinCitedScenarios(branchRefs, scenarioRefs, universe, {
          branchSetMissing: 'no accepted ucBranchIdsByScenario map was supplied (fail-closed)',
          purpose,
        });
        if (branchRefusal !== null) return branchRefusal;
      }
      // A scenario-derived FR must bind terminal branches (edge/0056).
      if (requirement.requirementKind === 'FR' && scenarioRefs.length > 0 && branchRefs.length === 0) {
        return refused('MISSING_LINEAGE', `${purpose} is a scenario-derived FR but binds no exact UC terminal branch (scenario-level and branch-level lineage are both required)`);
      }
      // Branch-level without scenario-level is a cross-level citation.
      if (scenarioRefs.length === 0 && branchRefs.length > 0) {
        return refused('FOREIGN_LINEAGE', `${purpose} cites terminal branches without citing their owning UC scenarios (cross-level citation)`);
      }
    }

    // Cross-cutting direct lineage: exact accepted source constraints.
    const constraintRefs = derivation.sourceConstraintRefs ?? [];
    if (constraintRefs.length > 0) {
      const constraintRefusal = resolveRefs(constraintRefs, 'sourceConstraintIds', universe, { purpose });
      if (constraintRefusal !== null) return constraintRefusal;
    }
  }

  // Any UC citation requires the UC revision pin (fail-closed).
  if (citesUc) {
    if (typeof bundle.ucRevisionRef !== 'string' || bundle.ucRevisionRef !== `sha256:${pins.uc}`) {
      return refused('STALE_LINEAGE', `the pinned UC revision ${String(bundle.ucRevisionRef)} is not the accepted revision sha256:${String(pins.uc)} (a scenario-derived requirement may not derive from a stale revision)`);
    }
  }

  // Coverage: every accepted UC scenario yields at least one obligation (cr-06).
  for (const scenarioId of [...universe.idSets.ucScenarioIds].sort()) {
    if (!coveredScenarios.has(scenarioId)) {
      return refused('COVERAGE_GAP', `accepted UC ${scenarioId} produces no FR, RULE or scenario-local NFR obligation`);
    }
  }
  return sealed(CONTRACT_KIND, bundle);
}

export { REFUSAL_REASONS };
