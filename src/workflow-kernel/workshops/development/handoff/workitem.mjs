/**
 * workflow-kernel/workshops/development/handoff/workitem.mjs -
 * the FRF-WP09 WorkItem bindings: every Development WorkItem carries its
 * scenario/requirement/AC identities as typed obligations.
 *
 * LAWS (plan §"Development handoff requirements"; reverse edges 0031,
 * 0033-0039, 0032; WP03 WORK_ITEM_OBLIGATION_KINDS):
 *
 *   - A WorkItem binds to ONE OR MORE of the five obligation kinds
 *     (reverse edge/0031); a WorkItem with no obligation is not a work
 *     item (MISSING_LINEAGE - "empty work is not a proof").
 *   - Every obligation value resolves against the DevelopmentCase's exact
 *     binding domains - FOREIGN_LINEAGE otherwise (the consumer kill one
 *     level down: a WorkItem citing a scenario/requirement/criterion/
 *     surface outside the frozen sets is refused typed).
 *   - THE FIVE KINDS (reverse vocabularies.workItemObligationKinds):
 *       acceptance-obligation               -> AC criteria ids
 *       scenario-realization-obligation     -> SRS realization entries
 *         (each citing the entry's TERMINAL RESULT - a scenario entrypoint
 *          without its terminal result is not a realization)
 *       requirement-obligation              -> FR/NFR/RULE member ids
 *       integration-or-composition-obligation -> composition surfaces
 *       infrastructure-obligation           -> typed construction surfaces
 *         (used when the WorkItem does not map one-to-one to an AC)
 *   - VERIFIER OBLIGATIONS (reverse edge/0032 must-cover-verifier; node
 *     material/verifier-obligation): the typed verifier facet of the
 *     scenario-realization obligation - each cites the realization entry
 *     whose terminal-evidence method it covers, with the EXACT frozen
 *     evidence kind and binding ref (DRIFT_DETECTED on any mismatch).
 *   - IDENTITY ANCHOR (cr-03): the workItemDigest is recomputed over the
 *     canonical obligation content; through replan cycles the identity of
 *     a surviving WorkItem (its digest) is IMMUTABLE (preservation.mjs).
 *
 * PURITY: pure functions. No I/O, no session, no clock.
 */

import {
  WORK_ITEM_OBLIGATION_KINDS,
  digestExcluding,
  findDuplicates,
  isRefused,
  isFrozenId,
  refused,
  sortedUnique,
} from './shared.mjs';

/** The WorkItem product kind (versioned contract identity). */
export const WORK_ITEM_KIND = 'frf-development.work-item.v1';

/** The closed obligation-field vocabulary (payload names of the five kinds). */
export const WORK_ITEM_OBLIGATION_FIELDS = Object.freeze({
  'acceptance-obligation': 'acceptanceObligations',
  'infrastructure-obligation': 'infrastructureObligations',
  'integration-or-composition-obligation': 'integrationObligations',
  'requirement-obligation': 'requirementObligations',
  'scenario-realization-obligation': 'scenarioRealizationObligations',
});

/** The flat domain view of a DevelopmentCase the WorkItem obligations resolve against. */
export function resolutionViewOf(devCase) {
  return {
    acceptanceCriterionIds: devCase.acceptanceBindings.map((m) => m.criterionId),
    realizationEntries: new Map((devCase.realizationIndex?.entries ?? []).map((entry) => [entry.realizationEntryId, entry])),
    realizationEntryIds: devCase.scenarioRealizationBindings.map((m) => m.realizationEntryId),
    requirementIds: [
      ...devCase.requirementBindings.fr.map((m) => m.memberId),
      ...devCase.requirementBindings.nfr.map((m) => m.memberId),
      ...devCase.requirementBindings.rule.map((m) => m.memberId),
    ],
    constructionSurfaceIds: [
      ...devCase.integrationObligations.integrationOrComposition.map((o) => o.surfaceRef),
      ...devCase.integrationObligations.infrastructure.map((o) => o.surfaceRef),
    ],
    scenarioIds: devCase.scenarioBindings.map((m) => m.scenarioId),
  };
}

/* ------------------------------------------------------------------ */
/* The builder                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build one WorkItem from typed obligation inputs. Values may be plain id
 * strings or typed objects; the builder normalizes to the canonical
 * per-family shapes (criterionId / realizationEntryId+terminalResult /
 * requirementId / surfaceRef). Resolution against the case happens in
 * validateWorkItem (and again in the planning gates).
 */
export function buildWorkItem(input) {
  if (input === null || typeof input !== 'object') {
    return refused('MALFORMED_PRODUCT', 'a WorkItem is built from a typed obligation input object');
  }
  const workItemId = input.workItemId;
  if (!isFrozenId(workItemId)) {
    return refused('MALFORMED_PRODUCT', `the WorkItem id ${String(workItemId)} is not a closed frozen-id shape (namespace:name)`);
  }
  const normalize = (values, key) => (values ?? []).map((value) =>
    typeof value === 'string' ? { [key]: value } : { ...value });
  const obligations = {
    acceptanceObligations: normalize(input.acceptance, 'criterionId'),
    scenarioRealizationObligations: normalize(input.scenarioRealization, 'realizationEntryId'),
    requirementObligations: normalize(input.requirements, 'requirementId'),
    integrationObligations: normalize(input.integration, 'surfaceRef'),
    infrastructureObligations: normalize(input.infrastructure, 'surfaceRef'),
  };
  const verifierObligations = (input.verifier ?? []).map((value) => ({ ...value }));
  const bound = WORK_ITEM_OBLIGATION_KINDS.some((kind) => obligations[WORK_ITEM_OBLIGATION_FIELDS[kind]].length > 0);
  if (!bound) {
    return refused('MISSING_LINEAGE', `WorkItem ${workItemId} binds none of the five obligation kinds (reverse edge/0031: a WorkItem binds one or more obligation kinds)`);
  }
  const workItem = {
    schemaVersion: WORK_ITEM_KIND,
    summary: typeof input.summary === 'string' ? input.summary : '',
    verifierObligations,
    workItemId,
    obligations,
  };
  workItem.workItemDigest = digestExcluding(workItem, ['workItemDigest']);
  return { ok: true, workItem };
}

/* ------------------------------------------------------------------ */
/* The validator (resolution against the DevelopmentCase)              */
/* ------------------------------------------------------------------ */

/** The flat obligation id lists of a WorkItem payload (kind -> ids). */
export function obligationIdsOf(workItem) {
  const o = workItem.obligations ?? {};
  const idList = (values, key) => (values ?? []).map((value) => (typeof value === 'string' ? value : value[key]));
  return {
    'acceptance-obligation': idList(o.acceptanceObligations, 'criterionId'),
    'infrastructure-obligation': idList(o.infrastructureObligations, 'surfaceRef'),
    'integration-or-composition-obligation': idList(o.integrationObligations, 'surfaceRef'),
    'requirement-obligation': idList(o.requirementObligations, 'requirementId'),
    'scenario-realization-obligation': idList(o.scenarioRealizationObligations, 'realizationEntryId'),
  };
}

/**
 * Validate one WorkItem against its DevelopmentCase: shape, the >=1-kind
 * law, exact-domain resolution of every obligation value, terminal-result
 * preservation, and verifier fidelity.
 */
export function validateWorkItem(workItem, devCase) {
  if (workItem === null || typeof workItem !== 'object' || workItem.schemaVersion !== WORK_ITEM_KIND) {
    return refused('MALFORMED_PRODUCT', `the candidate is not a ${WORK_ITEM_KIND}`);
  }
  if (!isFrozenId(workItem.workItemId)) {
    return refused('MALFORMED_PRODUCT', `the WorkItem id ${String(workItem.workItemId)} is not a closed frozen-id shape`);
  }
  const view = resolutionViewOf(devCase);
  const ids = obligationIdsOf(workItem);
  const boundKinds = WORK_ITEM_OBLIGATION_KINDS.filter((kind) => ids[kind].length > 0);
  if (boundKinds.length === 0) {
    return refused('MISSING_LINEAGE', `WorkItem ${workItem.workItemId} binds none of the five obligation kinds (reverse edge/0031)`);
  }
  // Acceptance obligations resolve against the case's AC criterion domain.
  for (const criterionId of ids['acceptance-obligation']) {
    if (!view.acceptanceCriterionIds.includes(criterionId)) {
      return refused('FOREIGN_LINEAGE', `WorkItem ${workItem.workItemId} cites AC criterion ${String(criterionId)} outside the DevelopmentCase acceptance-bindings domain (reverse edge/0033)`);
    }
  }
  // Scenario-realization obligations: entry id + terminal result fidelity.
  for (const obligation of workItem.obligations.scenarioRealizationObligations ?? []) {
    const entryId = typeof obligation === 'string' ? obligation : obligation.realizationEntryId;
    const entry = view.realizationEntries.get(entryId);
    if (entry === undefined) {
      return refused('FOREIGN_LINEAGE', `WorkItem ${workItem.workItemId} cites realization entry ${String(entryId)} outside the DevelopmentCase scenario-realization-bindings domain (reverse edge/0034)`);
    }
    if (typeof obligation === 'object' && obligation.terminalResult !== undefined && obligation.terminalResult !== entry.terminalResult) {
      return refused('DRIFT_DETECTED', `WorkItem ${workItem.workItemId} realizes entry ${String(entryId)} with terminal result ${String(obligation.terminalResult)}; the accepted terminal result is ${entry.terminalResult} (a scenario entrypoint without its terminal result is not a realization)`);
    }
  }
  // Requirement obligations resolve against the FR/NFR/RULE domain.
  for (const requirementId of ids['requirement-obligation']) {
    if (!view.requirementIds.includes(requirementId)) {
      return refused('FOREIGN_LINEAGE', `WorkItem ${workItem.workItemId} cites requirement ${String(requirementId)} outside the DevelopmentCase requirement-bindings domain (reverse edges 0035-0037: WorkItems preserve FR/NFR/RULE identities in addition to AC identities)`);
    }
  }
  // Composition + infrastructure obligations resolve against the surfaces.
  for (const kind of ['integration-or-composition-obligation', 'infrastructure-obligation']) {
    for (const surfaceRef of ids[kind]) {
      if (!view.constructionSurfaceIds.includes(surfaceRef)) {
        return refused('FOREIGN_LINEAGE', `WorkItem ${workItem.workItemId} cites construction surface ${String(surfaceRef)} outside the DevelopmentCase integration-and-construction-obligations domain (${kind})`);
      }
    }
  }
  // Verifier obligations: the typed verifier facet (edge/0032).
  const verifierObligations = workItem.verifierObligations ?? [];
  for (const verifier of verifierObligations) {
    const entry = view.realizationEntries.get(verifier.realizationEntryId);
    if (entry === undefined) {
      return refused('FOREIGN_LINEAGE', `WorkItem ${workItem.workItemId} declares a verifier obligation over realization entry ${String(verifier.realizationEntryId)} outside the accepted set`);
    }
    if (verifier.evidenceBindingRef !== entry.evidenceBinding.evidenceBindingRef || verifier.evidenceKind !== entry.evidenceBinding.evidenceKind) {
      return refused('DRIFT_DETECTED', `WorkItem ${workItem.workItemId} declares verifier evidence ${String(verifier.evidenceKind)}/${String(verifier.evidenceBindingRef)} for entry ${String(verifier.realizationEntryId)}; the accepted evidence is ${entry.evidenceBinding.evidenceKind}/${entry.evidenceBinding.evidenceBindingRef} (the verifier covers the frozen evidence method exactly)`);
    }
  }
  // Duplicate ids inside one obligation family are drift, not coverage.
  for (const kind of WORK_ITEM_OBLIGATION_KINDS) {
    const duplicates = findDuplicates(ids[kind]);
    if (duplicates.length > 0) {
      return refused('DRIFT_DETECTED', `WorkItem ${workItem.workItemId} cites duplicate obligation value(s) ${sortedUnique(duplicates).join(', ')} in ${kind}`);
    }
  }
  // The identity anchor: recomputed, never trusted.
  const recomputed = digestExcluding(workItem, ['workItemDigest']);
  if (recomputed !== workItem.workItemDigest) {
    return refused('DRIFT_DETECTED', `the workItemDigest of ${workItem.workItemId} does not verify against the canonical obligation content (cr-03: the WorkItem identity anchor)`);
  }
  return { ok: true, boundKinds, workItemDigest: workItem.workItemDigest };
}
