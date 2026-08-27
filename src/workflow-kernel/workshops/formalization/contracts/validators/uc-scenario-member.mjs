/**
 * FRF-WP03 pure validator: UC scenario member
 * (contract frf-contracts.uc-scenario-member.v1).
 *
 * Deterministic, closed-vocabulary, fail-closed with typed refusal codes.
 * A UC may be human-neutral but never actorless (actorKind is the closed
 * five-value vocabulary). Terminal branch identities are their own level:
 * material flows must resolve to declared terminal branches of the matching
 * kind (the level distinction the reverse grammar requires).
 *
 * Typed refusals:
 *   MALFORMED_PRODUCT - structural violations, open actor/evidence/branch
 *                       vocabularies, actorless scenarios, dangling material
 *                       flows, zero or multiple main branches.
 *   SCOPE_VIOLATION   - the member requires a pre-existing FR or creates
 *                       requirement/AC artifacts (model-use-cases fence).
 *   MISSING_LINEAGE   - no accepted PRD member set supplied; empty intent refs.
 *   FOREIGN_LINEAGE   - PRD intent refs outside the exact accepted set.
 */

import {
  REFUSAL_REASONS,
  refused,
  resolveRefs,
  sealed,
} from './common.mjs';

export const CONTRACT_KIND = 'frf-contracts.uc-scenario-member.v1';

const ACTOR_KINDS = Object.freeze([
  'external_system',
  'human',
  'operator',
  'scheduler_or_clock',
  'sensor_or_environment',
]);

const EVIDENCE_KINDS = Object.freeze([
  'audit',
  'independent-agent-review',
  'monitoring',
  'test',
]);

const BRANCH_KINDS = Object.freeze(['alternate', 'error', 'main']);

/** Keys the UC desk must never require or produce (plan desk contract). */
const FORBIDDEN_KEYS = Object.freeze([
  'acceptance',
  'acceptanceCriteria',
  'frRefs',
  'nfrRefs',
  'requirementRefs',
  'requirements',
  'ruleRefs',
]);

export function validateUcScenarioMember(scenario, universe) {
  if (scenario === null || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return refused('MALFORMED_PRODUCT', 'UC scenario is not an object');
  }
  if (scenario.schemaVersion !== CONTRACT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${CONTRACT_KIND}`);
  }
  for (const forbidden of FORBIDDEN_KEYS) {
    if (scenario[forbidden] !== undefined) {
      return refused('SCOPE_VIOLATION', `the UC desk must not require a pre-existing FR and must not produce ${forbidden} content`);
    }
  }
  if (typeof scenario.scenarioId !== 'string' || scenario.scenarioId.length === 0) {
    return refused('MALFORMED_PRODUCT', 'every UC needs a stable scenario identity');
  }
  const purpose = `UC ${scenario.scenarioId}`;

  // Actor: closed five-kind vocabulary, never actorless (red-team condition).
  if (scenario.actorKind === undefined) {
    return refused('MALFORMED_PRODUCT', `${purpose} is actorless (a UC may be human-neutral but never actorless)`);
  }
  if (!ACTOR_KINDS.includes(scenario.actorKind)) {
    return refused('MALFORMED_PRODUCT', `${purpose} has actor kind ${String(scenario.actorKind)} outside the closed five-kind vocabulary`);
  }
  if (typeof scenario.actorIdentity !== 'string' || scenario.actorIdentity.length === 0) {
    return refused('MALFORMED_PRODUCT', `${purpose} must declare its actor identity`);
  }
  for (const field of ['goal', 'trigger', 'postcondition']) {
    if (typeof scenario[field] !== 'string' || scenario[field].length === 0) {
      return refused('MALFORMED_PRODUCT', `${purpose} needs a ${field}`);
    }
  }
  if (!Array.isArray(scenario.operationalSteps) || scenario.operationalSteps.length === 0
    || scenario.operationalSteps.some((step) => typeof step !== 'string' || step.length === 0)) {
    return refused('MALFORMED_PRODUCT', `${purpose} needs a non-empty main flow of operational steps`);
  }

  // Evidence kinds: closed four-value vocabulary.
  if (!Array.isArray(scenario.evidenceKindRefs)) {
    return refused('MALFORMED_PRODUCT', `${purpose} must declare its evidence kind references`);
  }
  const openEvidence = scenario.evidenceKindRefs.filter((kind) => !EVIDENCE_KINDS.includes(kind));
  if (openEvidence.length > 0) {
    return refused('MALFORMED_PRODUCT', `${purpose} cites evidence kind(s) ${openEvidence.sort().join(', ')} outside the closed four-value vocabulary`);
  }

  // Terminal branches: the identity level distinguished from the scenario level.
  const branches = scenario.terminalBranches;
  if (!Array.isArray(branches) || branches.length === 0) {
    return refused('MALFORMED_PRODUCT', `${purpose} declares no terminal branches`);
  }
  const branchIds = new Set();
  const byKind = { alternate: new Set(), error: new Set(), main: new Set() };
  for (const branch of branches) {
    if (branch === null || typeof branch !== 'object' || typeof branch.branchId !== 'string' || branch.branchId.length === 0) {
      return refused('MALFORMED_PRODUCT', `${purpose} has a terminal branch without a stable identity`);
    }
    if (branchIds.has(branch.branchId)) {
      return refused('MALFORMED_PRODUCT', `${purpose} declares terminal branch ${branch.branchId} more than once`);
    }
    if (!BRANCH_KINDS.includes(branch.branchKind)) {
      return refused('MALFORMED_PRODUCT', `terminal branch ${branch.branchId} of ${purpose} has kind ${String(branch.branchKind)} outside the closed branch-kind vocabulary`);
    }
    if (typeof branch.terminalResult !== 'string' || branch.terminalResult.length === 0) {
      return refused('MALFORMED_PRODUCT', `terminal branch ${branch.branchId} of ${purpose} needs an observable terminal result`);
    }
    branchIds.add(branch.branchId);
    byKind[branch.branchKind].add(branch.branchId);
  }
  if (byKind.main.size !== 1) {
    return refused('MALFORMED_PRODUCT', `${purpose} declares ${byKind.main.size} main terminal branches (exactly one is required)`);
  }
  // Material alternate/error flows resolve to declared branches of the matching kind.
  for (const [field, kind] of [['alternateFlows', 'alternate'], ['errorFlows', 'error']]) {
    const flows = scenario[field] ?? [];
    if (!Array.isArray(flows)) {
      return refused('MALFORMED_PRODUCT', `${purpose} has a malformed ${field} array`);
    }
    for (const flow of flows) {
      if (flow === null || typeof flow !== 'object' || typeof flow.branchId !== 'string') {
        return refused('MALFORMED_PRODUCT', `${purpose} has a malformed ${field} entry`);
      }
      if (!byKind[kind].has(flow.branchId)) {
        return refused('MALFORMED_PRODUCT', `${field} of ${purpose} cites branch ${flow.branchId} which is not a declared ${kind} terminal branch (cross-level citation: a material flow resolves to a terminal branch of its own kind)`);
      }
      if (!Array.isArray(flow.steps) || flow.steps.length === 0 || flow.steps.some((step) => typeof step !== 'string' || step.length === 0)) {
        return refused('MALFORMED_PRODUCT', `material flow ${flow.branchId} of ${purpose} needs non-empty steps`);
      }
    }
  }

  // Lineage: exact accepted PRD intent members (fail-closed).
  const intentRefusal = resolveRefs(scenario.prdIntentRefs, 'prdMemberIds', universe, { purpose });
  if (intentRefusal !== null) return intentRefusal;

  return sealed(CONTRACT_KIND, scenario);
}

export { REFUSAL_REASONS };
