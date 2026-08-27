/**
 * workflow-kernel/workshops/development/handoff/plan.mjs -
 * the FRF-WP09 DevelopmentPlan and its planning gates.
 *
 * THIS MODULE CLOSES THE AUDIT'S NAMED GAP (ledger D-4; reverse coverage
 * rule cr-01): "there is no AC-complete-but-scenario-incomplete task
 * graph check". Here a task graph that covers EVERY acceptance criterion
 * but drops ANY scenario identity - scenario-realization entry, scenario
 * entrypoint, runtime edge, composition owner, terminal result, or
 * verifier - is REFUSED TYPED before Development execution.
 *
 * LAWS (plan §"Development handoff requirements"; phase FRF-9 rows
 * "Reject AC-complete but scenario-incomplete task graphs" and "Permit
 * typed integration, composition, and infrastructure obligations that
 * are not one-to-one with AC"; reverse edges 0030-0039):
 *
 *   - Planning CONSUMES the DevelopmentCase (reverse edge/0030): the
 *     scenario bindings are mandatory planning inputs, not optional
 *     metadata - the gates read them, never re-derive them.
 *   - AC coverage: every case acceptance criterion is discharged by at
 *     least one acceptance obligation (COVERAGE_GAP).
 *   - Requirement preservation: every FR/NFR/RULE identity of the case
 *     survives into some requirement obligation (COVERAGE_GAP - the
 *     audit's "Development planning does not preserve UC/scenario
 *     identities" fix, requirement side).
 *   - SCENARIO COMPLETENESS (cr-01): for EVERY realization entry of the
 *     case's realization index, the plan must cover:
 *       1. the entry's scenario identity (a scenario-realization
 *          obligation citing the entry, carrying the terminal result);
 *       2. the entrypoint surface;
 *       3. every runtime-edge endpoint surface;
 *       4. the composition owner surface;
 *       5. the terminal result (carried by the realizing obligation);
 *       6. the verifier (a verifier obligation citing the entry with the
 *          frozen evidence method - reverse edge/0032).
 *   - DISCONNECTED LOCAL TASK (reverse edge/0038): a multi-module
 *     scenario cannot be represented by one disconnected local task - a
 *     WorkItem that alone realizes a multi-surface entry while its own
 *     surface obligations cover only a strict subset of that entry's
 *     runtime graph is refused (the composition must be carried by
 *     integration/composition obligations).
 *   - Typed infrastructure/composition obligations that do not map
 *     one-to-one to an AC are PERMITTED and first-class (the gates never
 *     require an AC behind an infrastructure obligation).
 *
 * PURITY: pure functions. No I/O, no session, no clock.
 */

import {
  digestExcluding,
  findDuplicates,
  isRefused,
  refused,
  sortedUnique,
} from './shared.mjs';
import { validateWorkItem, obligationIdsOf } from './workitem.mjs';

/** The DevelopmentPlan product kind (versioned contract identity). */
export const DEVELOPMENT_PLAN_KIND = 'frf-development.plan.v1';

/** The typed plan-gate outcomes (deterministic routing, never a guess). */
export const PLAN_GATE_OUTCOMES = Object.freeze({
  'acceptance-criteria-uncovered': 'COVERAGE_GAP',
  'requirements-uncovered': 'COVERAGE_GAP',
  'scenario-incomplete': 'COVERAGE_GAP',
  'verifier-omitted': 'COVERAGE_GAP',
  'disconnected-local-task': 'COVERAGE_GAP',
  'foreign-obligation': 'FOREIGN_LINEAGE',
  'malformed-plan': 'MALFORMED_PRODUCT',
});

/* ------------------------------------------------------------------ */
/* Coverage views                                                      */
/* ------------------------------------------------------------------ */

/** The flat plan-coverage view: which identities the WorkItems cover. */
export function planCoverageOf(workItems) {
  const coveredAcceptanceCriteria = new Set();
  const coveredRequirements = new Set();
  const coveredRealizationEntries = new Map(); // entryId -> [workItemIds]
  const coveredSurfaces = new Set();
  const coveredVerifiers = new Set(); // entryId
  const surfacesOfItem = new Map(); // workItemId -> Set(surfaceRef)
  for (const workItem of workItems) {
    const ids = obligationIdsOf(workItem);
    for (const criterionId of ids['acceptance-obligation']) coveredAcceptanceCriteria.add(criterionId);
    for (const requirementId of ids['requirement-obligation']) coveredRequirements.add(requirementId);
    for (const entryId of ids['scenario-realization-obligation']) {
      coveredRealizationEntries.set(entryId, [...(coveredRealizationEntries.get(entryId) ?? []), workItem.workItemId]);
    }
    const itemSurfaces = new Set([...ids['integration-or-composition-obligation'], ...ids['infrastructure-obligation']]);
    surfacesOfItem.set(workItem.workItemId, itemSurfaces);
    for (const surfaceRef of itemSurfaces) coveredSurfaces.add(surfaceRef);
    for (const verifier of workItem.verifierObligations ?? []) coveredVerifiers.add(verifier.realizationEntryId);
  }
  return { coveredAcceptanceCriteria, coveredRealizationEntries, coveredRequirements, coveredSurfaces, coveredVerifiers, surfacesOfItem };
}

/* ------------------------------------------------------------------ */
/* The planning gates                                                  */
/* ------------------------------------------------------------------ */

/**
 * Plan a Development task graph over a validated DevelopmentCase. Gate
 * order is deterministic; the first failing gate decides. Returns the
 * sealed plan (content-addressed) and its coverage record.
 */
export function planDevelopment(devCase, workItems, options = {}) {
  if (!Array.isArray(workItems) || workItems.length === 0) {
    return refused('MISSING_LINEAGE', 'a Development plan is composed of at least one WorkItem (an empty plan is not a plan)');
  }
  const duplicateIds = findDuplicates(workItems.map((workItem) => workItem?.workItemId));
  if (duplicateIds.length > 0) {
    return refused('MALFORMED_PRODUCT', `the plan cites WorkItem id(s) ${sortedUnique(duplicateIds).join(', ')} more than once`);
  }
  // Gate A: every WorkItem resolves against the case (the consumer kill
  // one level down: foreign obligations never enter a plan).
  for (const workItem of workItems) {
    const validation = validateWorkItem(workItem, devCase);
    if (isRefused(validation)) return validation;
  }
  const coverage = planCoverageOf(workItems);

  // Gate B: AC coverage.
  const uncoveredCriteria = devCase.acceptanceBindings
    .map((m) => m.criterionId)
    .filter((criterionId) => !coverage.coveredAcceptanceCriteria.has(criterionId));
  if (uncoveredCriteria.length > 0) {
    return refused('COVERAGE_GAP', `acceptance-criteria-uncovered: the plan covers every scenario surface but no acceptance obligation discharges AC criteria ${sortedUnique(uncoveredCriteria).join(', ')}`);
  }

  // Gate C: requirement identity preservation.
  const uncoveredRequirements = [
    ...devCase.requirementBindings.fr.map((m) => m.memberId),
    ...devCase.requirementBindings.nfr.map((m) => m.memberId),
    ...devCase.requirementBindings.rule.map((m) => m.memberId),
  ].filter((requirementId) => !coverage.coveredRequirements.has(requirementId));
  if (uncoveredRequirements.length > 0) {
    return refused('COVERAGE_GAP', `requirements-uncovered: FR/NFR/RULE identities ${sortedUnique(uncoveredRequirements).join(', ')} survive in no requirement obligation (planning preserves requirement identities in addition to AC identities)`);
  }

  // Gate D: SCENARIO COMPLETENESS - the audit kill (cr-01). Even with
  // every AC covered, a dropped scenario identity refuses the plan.
  const entries = devCase.realizationIndex?.entries ?? [];
  if (entries.length === 0) {
    return refused('MISSING_LINEAGE', 'the DevelopmentCase carries no realization index; the planning gates have no scenario surface to check (the case desk is the only lawful producer)');
  }
  for (const entry of entries) {
    const citers = coverage.coveredRealizationEntries.get(entry.realizationEntryId) ?? [];
    if (citers.length === 0) {
      return refused('COVERAGE_GAP', `scenario-incomplete: the task graph covers every AC criterion but no scenario-realization obligation realizes entry ${entry.realizationEntryId} (scenario ${entry.scenarioRef}) - an AC-complete but scenario-incomplete plan is invalid before Development execution (cr-01; the audit's named gap is closed here)`);
    }
    // The entrypoint, every runtime-edge endpoint and the composition
    // owner must be carried by typed construction obligations (the
    // terminal observable result is a plain graph node, not a surface -
    // it is carried by the realizing obligation itself).
    const requiredSurfaces = sortedUnique([
      entry.entrypointSurfaceRef,
      entry.compositionOwnerSurfaceRef,
      ...entry.runtimeEdges.flatMap((edge) => [edge.fromSurfaceRef, edge.toSurfaceRef]),
    ].filter((surfaceRef) => surfaceRef !== entry.terminalResult));
    const surfaceNodes = new Set([
      entry.entrypointSurfaceRef,
      entry.compositionOwnerSurfaceRef,
      ...entry.participatingSurfaceRefs,
      ...entry.runtimeEdges.flatMap((edge) => [edge.fromSurfaceRef, edge.toSurfaceRef]),
    ]);
    const uncoveredSurfaces = requiredSurfaces.filter((surfaceRef) => !coverage.coveredSurfaces.has(surfaceRef));
    if (uncoveredSurfaces.length > 0) {
      return refused('COVERAGE_GAP', `scenario-incomplete: realization entry ${entry.realizationEntryId} (scenario ${entry.scenarioRef}) omits scenario surface(s) ${uncoveredSurfaces.join(', ')} - entrypoint, runtime-edge endpoints and composition owner are mandatory planning obligations (cr-01)`);
    }
    // The terminal result: carried by every realizing WorkItem (the
    // scenario-realization obligation cites it - validateWorkItem already
    // refused a drifted one; here we require it to be EXPLICIT).
    for (const workItem of workItems) {
      const realizes = (workItem.obligations.scenarioRealizationObligations ?? [])
        .find((obligation) => (typeof obligation === 'string' ? obligation : obligation.realizationEntryId) === entry.realizationEntryId);
      if (realizes !== undefined && typeof realizes === 'object' && realizes.terminalResult === undefined) {
        return refused('COVERAGE_GAP', `scenario-incomplete: WorkItem ${workItem.workItemId} realizes entry ${entry.realizationEntryId} without carrying its terminal result ${entry.terminalResult} (cr-01: a scenario entrypoint without its terminal result is not a realization)`);
      }
    }
    // The verifier (edge/0032): every entry's frozen evidence method is
    // covered by a verifier obligation.
    if (!coverage.coveredVerifiers.has(entry.realizationEntryId)) {
      return refused('COVERAGE_GAP', `verifier-omitted: the plan covers every AC criterion but no verifier obligation covers the terminal evidence (${entry.evidenceBinding.evidenceKind}/${entry.evidenceBinding.evidenceBindingRef}) of realization entry ${entry.realizationEntryId} (a plan covering every AC but omitting the verifier is invalid - reverse edge/0032)`);
    }
    // Disconnected local task (edge/0038): exactly one WorkItem realizes a
    // multi-surface entry while its own construction obligations cover
    // only a strict subset of that entry's runtime graph.
    if (citers.length === 1) {
      const citerSurfaces = coverage.surfacesOfItem.get(citers[0]) ?? new Set();
      const entrySurfaces = [...surfaceNodes].filter((surfaceRef) => surfaceRef !== entry.terminalResult);
      const locallyMissing = entrySurfaces.filter((surfaceRef) => !citerSurfaces.has(surfaceRef));
      if (locallyMissing.length > 0) {
        return refused('COVERAGE_GAP', `disconnected-local-task: WorkItem ${citers[0]} alone realizes the multi-module scenario ${entry.scenarioRef} (entry ${entry.realizationEntryId}) while binding none of the runtime surface(s) ${sortedUnique(locallyMissing).join(', ')} - a multi-module scenario cannot be represented by one disconnected local task (reverse edge/0038: split the plan or bind the composition)`);
      }
    }
  }
  // Scenario identity survival across the whole case (belt and braces:
  // every case scenario is realized by some entry - already enforced at
  // the case desk - and every entry is covered above).
  const plan = {
    planId: options.planId ?? 'plan:development-1',
    schemaVersion: DEVELOPMENT_PLAN_KIND,
    caseDigest: devCase.caseDigest,
    handoffFingerprint: devCase.handoffFingerprint,
    workItems: workItems.map((workItem) => ({ ...workItem })),
  };
  plan.planDigest = digestExcluding(plan, ['planDigest']);
  const coverageRecord = {
    acceptanceCriteria: sortedUnique([...coverage.coveredAcceptanceCriteria]),
    realizationEntries: sortedUnique([...coverage.coveredRealizationEntries.keys()]),
    requirements: sortedUnique([...coverage.coveredRequirements]),
    surfaces: sortedUnique([...coverage.coveredSurfaces]),
    verifiers: sortedUnique([...coverage.coveredVerifiers]),
  };
  return { ok: true, coverage: coverageRecord, plan };
}

/**
 * Validate an existing plan payload against its case (the consumer-side
 * gate re-run: adoption, settlement and verification all call this before
 * accepting a plan record).
 */
export function validateDevelopmentPlan(plan, devCase) {
  if (plan === null || typeof plan !== 'object' || plan.schemaVersion !== DEVELOPMENT_PLAN_KIND) {
    return refused('MALFORMED_PRODUCT', `the candidate is not a ${DEVELOPMENT_PLAN_KIND}`);
  }
  if (plan.caseDigest !== devCase.caseDigest || plan.handoffFingerprint !== devCase.handoffFingerprint) {
    return refused('STALE_LINEAGE', 'the plan does not pin the exact DevelopmentCase (case digest + handoff fingerprint)');
  }
  const gates = planDevelopment(devCase, plan.workItems, { planId: plan.planId });
  if (isRefused(gates)) return gates;
  const recomputed = digestExcluding(plan, ['planDigest']);
  if (recomputed !== plan.planDigest) {
    return refused('DRIFT_DETECTED', 'the plan digest does not verify against the canonical plan content');
  }
  return { ok: true, coverage: gates.coverage };
}
