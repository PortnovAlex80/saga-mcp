/**
 * workflow-kernel/workshops/formalization/cells/what-freeze/ingestion.mjs -
 * the EXACT ACCEPTED-AUTHORITY INGESTION of the WHAT-freeze desk (plan
 * §"Desk contracts"/freeze-what-baseline; plan §Phase FRF-7:
 * "Implement the whole-WHAT baseline from exact accepted transition
 * inputs"; red-team condition: "The whole-WHAT baseline consumes exact
 * final-acceptance and production-revision references; it never
 * reselects accepted artifacts").
 *
 * LAWS:
 *   - The freezer consumes ONLY the exact accepted upstream products
 *     carried by the transition, as content-addressed refs + digests (the
 *     WP03 schema's source manifests). There is NO scanning path in this
 *     module: no lookup by epic, lifecycle, task, execution, status,
 *     type, chronology, maximum id or "latest artifact"; no reparsing of
 *     mutable documents after their atomic member manifest was accepted.
 *     Structurally fail-closed: a surface class the transition did not
 *     carry yields MISSING_LINEAGE (the desk outcome `indeterminate`,
 *     routed to the D5 human-input wait) - the freezer never guesses the
 *     accepted universe.
 *   - EXACT SET EQUALITY, id-for-id AND digest-for-digest: every frozen
 *     member, branch, disposition record, evidence binding, trace, and
 *     acceptance record must equal the accepted authority surface
 *     exactly. Substitution of a well-formed but different member,
 *     digest duplication, or post-reconciliation mutation of accepted
 *     material is a typed DRIFT_DETECTED refusal (the freeze-drift human
 *     decision, D12 vocabulary only).
 *   - NO FOLDING (forward finding F-8 / ledger D-10): the plan's distinct
 *     disposition sections (deferral, constraint, assumption, unknown,
 *     out-of-scope) and the evidence-method bindings are frozen as their
 *     own named sections exactly as the WP03 schema declares. The legacy
 *     EK-8 folded shape (`formalization.what-baseline.v1` with
 *     `memberDigests` + `acceptedTraceDigest`) is REFUSED on sight, and a
 *     baseline that folds accepted disposition/evidence content into
 *     other sections (losing the named record) is refused DRIFT_DETECTED.
 *
 * PURITY: pure functions over the supplied surfaces. No I/O.
 */

import {
  CONTRACT_KIND,
  digestExcluding,
  findDuplicates,
  isRefused,
  refused,
  sameSet,
  sha256OfCanonical,
  validateWhatBaseline,
} from './shared.mjs';
import { PRE_FREEZE_DESKS } from './protocol.mjs';

/** The legacy folded baseline product kind (the F-8 shape this cell refuses). */
export const FOLDED_LEGACY_PRODUCT_KIND = 'formalization.what-baseline.v1';

/* ------------------------------------------------------------------ */
/* The accepted-authority surface contract (ALL upstream surfaces)      */
/* ------------------------------------------------------------------ */

/**
 * The exact accepted surfaces the transition must carry to the freezer.
 * Every member array is the ACCEPTED atomic manifest (ids AND content
 * digests); every `revisionDigest` is the accepted WorkplaceProduction-
 * Revision pin. The baseline is BUILT from these and verified against
 * these - never discovered.
 */
export const SURFACE_CLASSES = Object.freeze([
  'caseIdentity',
  'sourceManifests',
  'acceptanceRecords',
  'containers',
  'traceSet',
  'dispositions',
  'evidenceBindings',
  'developmentSurface',
]);

const CONTAINER_KEYS = Object.freeze(['ac', 'fr', 'nfr', 'prd', 'rule', 'uc']);
const DISPOSITION_SECTIONS = Object.freeze(['assumption', 'constraint', 'deferred', 'outOfScope', 'unknown']);
const SOURCE_MANIFEST_KEYS = Object.freeze(['claims', 'constraints', 'terminalClaims']);

/** Fail-closed surface-shape fence: every declared class must be carried. */
export function checkSurfacesCarried(surfaces) {
  if (surfaces === null || typeof surfaces !== 'object' || Array.isArray(surfaces)) {
    return refused('MALFORMED_PRODUCT', 'the accepted-authority surfaces are not an object');
  }
  for (const surfaceClass of SURFACE_CLASSES) {
    if (surfaces[surfaceClass] === undefined || surfaces[surfaceClass] === null) {
      return refused('MISSING_LINEAGE', `the transition carried no accepted ${surfaceClass} surface (fail-closed: the freezer never scans or guesses; the desk is INDETERMINATE pending the exact surface)`);
    }
  }
  const containers = surfaces.containers;
  if (containers === null || typeof containers !== 'object' || Array.isArray(containers)) {
    return refused('MISSING_LINEAGE', 'the containers surface is malformed (fail-closed)');
  }
  for (const key of CONTAINER_KEYS) {
    const container = containers[key];
    if (container === undefined || container === null || !Array.isArray(container.members) || container.members.length === 0
      || typeof container.revisionDigest !== 'string' || !/^[0-9a-f]{64}$/.test(container.revisionDigest)) {
      return refused('MISSING_LINEAGE', `no accepted ${key} container manifest was carried (exact member ids + digests + the accepted revision pin are all required; fail-closed)`);
    }
  }
  const dispositions = surfaces.dispositions;
  if (dispositions === null || typeof dispositions !== 'object' || Array.isArray(dispositions)) {
    return refused('MISSING_LINEAGE', 'the dispositions surface is malformed (fail-closed)');
  }
  for (const section of DISPOSITION_SECTIONS) {
    if (!Array.isArray(dispositions[section])) {
      return refused('MISSING_LINEAGE', `the accepted dispositions surface is missing its ${section} section (the five sections are distinct named content; fail-closed)`);
    }
  }
  if (!Array.isArray(surfaces.acceptanceRecords) || surfaces.acceptanceRecords.length === 0) {
    return refused('MISSING_LINEAGE', 'no accepted CellFinalAcceptance/CandidateSet/WorkplaceProductionRevision records were carried');
  }
  if (!Array.isArray(surfaces.evidenceBindings) || surfaces.evidenceBindings.length === 0) {
    return refused('MISSING_LINEAGE', 'no accepted evidence-method bindings were carried');
  }
  if (!Array.isArray(surfaces.traceSet?.traces) || surfaces.traceSet.traces.length === 0) {
    return refused('MISSING_LINEAGE', 'no accepted trace/member-binding set was carried');
  }
  const manifests = surfaces.sourceManifests;
  if (manifests === null || typeof manifests !== 'object' || Array.isArray(manifests)) {
    return refused('MISSING_LINEAGE', 'the source-manifest surface is malformed (fail-closed)');
  }
  for (const key of SOURCE_MANIFEST_KEYS) {
    const manifest = manifests[key];
    if (!Array.isArray(manifest?.ids) || manifest.ids.length === 0 || typeof manifest.manifestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.manifestDigest)) {
      return refused('MISSING_LINEAGE', `the accepted source manifest ${key} (exact id set + manifest digest) was not carried (fail-closed)`);
    }
  }
  const caseIdentity = surfaces.caseIdentity;
  if (typeof caseIdentity?.discoveryCertificateRef !== 'string' || caseIdentity.discoveryCertificateRef.length === 0
    || typeof caseIdentity?.formalizationCaseRef !== 'string' || caseIdentity.formalizationCaseRef.length === 0) {
    return refused('MISSING_LINEAGE', 'the FormalizationCase / Discovery certificate identity was not carried');
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The exact accepted-authority universe + baseline assembly           */
/* ------------------------------------------------------------------ */

const memberIdsOf = (container) => container.members.map((member) => member.memberId ?? member.criterionId ?? member.scenarioId);

/**
 * Derive the exact accepted universe (the WP03 validator's input) from the
 * carried surfaces. Pure projection: the id sets ARE the carried sets.
 * `pinnedCaseIdentity` is the EXTERNAL case-aggregate pin (the
 * FormalizationCase/Discovery certificate identity carried by the case,
 * not by the material): when supplied, the surfaces must carry the SAME
 * identity or the freeze is a substituted case (DRIFT_DETECTED).
 */
export function universeOfSurfaces(surfaces, pinnedCaseIdentity = undefined) {
  const carried = checkSurfacesCarried(surfaces);
  if (carried !== null) return carried;
  if (pinnedCaseIdentity !== undefined) {
    for (const key of ['discoveryCertificateRef', 'formalizationCaseRef']) {
      if (surfaces.caseIdentity[key] !== pinnedCaseIdentity[key]) {
        return refused('DRIFT_DETECTED', `the carried case identity ${key} is ${String(surfaces.caseIdentity[key])}, the case-aggregate pin is ${String(pinnedCaseIdentity[key])} (substituted case material is refused)`);
      }
    }
  }
  const branchesByScenario = {};
  for (const member of surfaces.containers.uc.members) {
    branchesByScenario[member.scenarioId] = (member.branches ?? []).map((branch) => branch.branchId);
  }
  return {
    ok: true,
    universe: {
      caseIdentity: pinnedCaseIdentity !== undefined ? { ...pinnedCaseIdentity } : { ...surfaces.caseIdentity },
      idSets: {
        sourceClaimIds: [...surfaces.sourceManifests.claims.ids],
        sourceConstraintIds: [...surfaces.sourceManifests.constraints.ids],
        terminalClaimIds: [...surfaces.sourceManifests.terminalClaims.ids],
        prdMemberIds: memberIdsOf(surfaces.containers.prd),
        ucScenarioIds: memberIdsOf(surfaces.containers.uc),
        frIds: memberIdsOf(surfaces.containers.fr),
        nfrIds: memberIdsOf(surfaces.containers.nfr),
        ruleIds: memberIdsOf(surfaces.containers.rule),
        criterionIds: memberIdsOf(surfaces.containers.ac),
        evidenceBindingIds: surfaces.evidenceBindings.map((entry) => entry.evidenceBindingId),
        ucBranchIdsByScenario: branchesByScenario,
      },
      revisionPins: Object.fromEntries(CONTAINER_KEYS.map((key) => [key, surfaces.containers[key].revisionDigest])),
    },
  };
}

/**
 * Build the whole-WHAT baseline payload from the carried surfaces: the
 * sections are carried into the payload AS DECLARED (no folding), the
 * canonical trace digest and the one canonical whole-WHAT digest are
 * computed, and the payload is validated via the FRF-WP03 typed validator
 * against the universe derived from the SAME surfaces.
 */
export function buildWhatBaseline(surfaces, pinnedCaseIdentity = undefined) {
  const universeResult = universeOfSurfaces(surfaces, pinnedCaseIdentity);
  if (!universeResult.ok) return universeResult;
  // Acceptance records: exactly one per accepted pre-freeze desk.
  const records = surfaces.acceptanceRecords;
  const desks = records.map((record) => record.deskId);
  const deskDuplicates = findDuplicates(desks);
  if (deskDuplicates.length > 0) {
    return refused('DRIFT_DETECTED', `acceptance record(s) for desk(s) ${deskDuplicates.join(', ')} were carried more than once (double emission)`);
  }
  const unknownDesks = desks.filter((deskId) => !PRE_FREEZE_DESKS.includes(deskId));
  if (unknownDesks.length > 0) {
    return refused('FOREIGN_LINEAGE', `acceptance record(s) for desk(s) ${unknownDesks.join(', ')} are outside the accepted pre-freeze desk vocabulary`);
  }
  const missingDesks = PRE_FREEZE_DESKS.filter((deskId) => !desks.includes(deskId));
  if (missingDesks.length > 0) {
    return refused('COVERAGE_GAP', `no acceptance record was carried for accepted desk(s) ${missingDesks.join(', ')} (each accepted CellFinalAcceptance/CandidateSet/WorkplaceProductionRevision is frozen exactly)`);
  }
  for (const record of records) {
    for (const refKey of ['candidateSetRef', 'cellFinalAcceptanceRef', 'workplaceProductionRevisionRef']) {
      if (typeof record[refKey] !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(record[refKey])) {
        return refused('MALFORMED_PRODUCT', `the acceptance record of desk ${record.deskId} does not pin ${refKey} as a content-addressed ref (sha256:<64 hex>)`);
      }
    }
  }
  const traces = surfaces.traceSet.traces;
  const traceDigest = sha256OfCanonical(traces);
  const baseline = {
    schemaVersion: CONTRACT_KIND,
    caseIdentity: { ...surfaces.caseIdentity },
    sourceManifests: {
      claims: { ids: [...surfaces.sourceManifests.claims.ids], manifestDigest: surfaces.sourceManifests.claims.manifestDigest },
      constraints: { ids: [...surfaces.sourceManifests.constraints.ids], manifestDigest: surfaces.sourceManifests.constraints.manifestDigest },
      terminalClaims: { ids: [...surfaces.sourceManifests.terminalClaims.ids], manifestDigest: surfaces.sourceManifests.terminalClaims.manifestDigest },
    },
    acceptanceRecords: records.map((record) => ({ ...record })),
    containers: Object.fromEntries(CONTAINER_KEYS.map((key) => [key, {
      revisionDigest: surfaces.containers[key].revisionDigest,
      members: JSON.parse(JSON.stringify(surfaces.containers[key].members)),
    }])),
    traceSet: { traces: JSON.parse(JSON.stringify(traces)), traceDigest },
    dispositions: Object.fromEntries(DISPOSITION_SECTIONS.map((section) => [section, JSON.parse(JSON.stringify(surfaces.dispositions[section]))])),
    evidenceBindings: JSON.parse(JSON.stringify(surfaces.evidenceBindings)),
    developmentSurface: JSON.parse(JSON.stringify(surfaces.developmentSurface)),
    wholeWhatDigest: '',
  };
  baseline.wholeWhatDigest = digestExcluding(baseline, ['wholeWhatDigest']);
  return { ok: true, baseline, universe: universeResult.universe };
}

/* ------------------------------------------------------------------ */
/* The anti-fold fences (F-8 / D-10)                                   */
/* ------------------------------------------------------------------ */

/**
 * Refuse the legacy folded baseline shape on sight: the EK-8
 * `formalization.what-baseline.v1` product (six authority digests folded
 * into `memberDigests`, the capsule ref as `acceptedTraceDigest`) is NOT
 * the whole-WHAT baseline and may not be frozen, presented or settled.
 */
export function refuseFoldedShape(candidate) {
  if (candidate === null || typeof candidate !== 'object') return null;
  if (candidate.schemaVersion === FOLDED_LEGACY_PRODUCT_KIND || candidate.memberDigests !== undefined || candidate.acceptedTraceDigest !== undefined) {
    return refused('MALFORMED_PRODUCT', 'the folded legacy baseline shape (memberDigests/acceptedTraceDigest; forward finding F-8, ledger D-10) is refused: the replacement whole-WHAT baseline freezes the six containers, the five disposition sections, the evidence-method bindings and the trace set as distinct named sections');
  }
  return null;
}

/**
 * The no-folding law over ACCEPTED content: every accepted disposition
 * record and evidence binding must appear in the baseline as its own
 * named-section record - folding one into another section (losing the
 * named record) is a drift of the accepted material, not a legal freeze.
 */
export function checkNoFolding(baseline, surfaces) {
  for (const section of DISPOSITION_SECTIONS) {
    const carried = surfaces.dispositions[section];
    const frozen = baseline.dispositions?.[section] ?? [];
    const carriedKeys = carried.map((entry) => `${entry.subjectRef}#${entry.owner ?? ''}#${entry.reason ?? ''}`);
    const frozenKeys = frozen.map((entry) => `${entry.subjectRef}#${entry.owner ?? ''}#${entry.reason ?? ''}`);
    const missing = carriedKeys.filter((key) => !frozenKeys.includes(key));
    if (missing.length > 0) {
      return refused('DRIFT_DETECTED', `accepted ${section} disposition(s) [${missing.join(', ')}] did not survive into the baseline's own ${section} section (folding that loses the plan's distinct disposition sections is refused; F-8)`);
    }
    const extra = frozenKeys.filter((key) => !carriedKeys.includes(key));
    if (extra.length > 0) {
      return refused('DRIFT_DETECTED', `the frozen ${section} section carries record(s) [${extra.join(', ')}] outside the accepted disposition surface (substituted disposition material is refused)`);
    }
  }
  const carriedEvidence = surfaces.evidenceBindings.map((entry) => `${entry.evidenceBindingId}#${entry.evidenceKind}#${entry.subjectRef}`);
  const frozenEvidence = (baseline.evidenceBindings ?? []).map((entry) => `${entry.evidenceBindingId}#${entry.evidenceKind}#${entry.subjectRef}`);
  if (!sameSet(carriedEvidence, frozenEvidence)) {
    return refused('DRIFT_DETECTED', 'the frozen evidence-method bindings do not equal the accepted evidence surface exactly (the evidence bindings are a distinct named section; F-8)');
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The exact-authority equality fence (the substitution kill)          */
/* ------------------------------------------------------------------ */

/**
 * Assert the frozen baseline equals the accepted authority surfaces
 * EXACTLY: members id-for-id AND digest-for-digest, branches likewise,
 * trace set and canonical digest, source manifests, case identity,
 * acceptance records and the Development surface. This runs AFTER the
 * WP03 validator (which pins id sets, revision pins, universe closure
 * and the whole-WHAT digest) and kills the substitution classes the id
 * sets alone cannot see (same id, different content digest).
 */
export function assertExactAuthority(baseline, surfaces) {
  // Containers: every member digest must match the accepted manifest digest.
  for (const key of CONTAINER_KEYS) {
    const frozen = baseline.containers?.[key];
    if (frozen === undefined) {
      return refused('MALFORMED_PRODUCT', `the baseline must freeze the ${key.toUpperCase()} container`);
    }
    const accepted = new Map(surfaces.containers[key].members.map((member) => [member.memberId ?? member.criterionId ?? member.scenarioId, member]));
    for (const member of frozen.members ?? []) {
      const id = member.memberId ?? member.criterionId ?? member.scenarioId;
      const acceptedMember = accepted.get(id);
      if (acceptedMember === undefined) {
        return refused('FOREIGN_LINEAGE', `frozen ${key} member ${id} is outside the accepted manifest (the freezer never adopts foreign material)`);
      }
      if (member.digest !== acceptedMember.digest) {
        return refused('DRIFT_DETECTED', `frozen ${key} member ${id} carries content digest ${String(member.digest)} but the accepted authority manifest pins ${acceptedMember.digest} (a substituted member payload is refused)`);
      }
      if (key === 'uc') {
        const acceptedBranches = acceptedMember.branches ?? [];
        const frozenBranches = member.branches ?? [];
        const acceptedBranchMap = new Map(acceptedBranches.map((branch) => [branch.branchId, branch.digest]));
        for (const branch of frozenBranches) {
          const pinned = acceptedBranchMap.get(branch.branchId);
          if (pinned === undefined) {
            return refused('FOREIGN_LINEAGE', `frozen terminal branch ${branch.branchId} of ${id} is outside the accepted branch manifest`);
          }
          if (branch.digest !== pinned) {
            return refused('DRIFT_DETECTED', `frozen terminal branch ${branch.branchId} of ${id} carries digest ${String(branch.digest)} but the accepted manifest pins ${pinned} (substituted branch material is refused)`);
          }
        }
      }
    }
  }
  // Trace set: the accepted traces survive byte-for-byte under one digest.
  const frozenTraces = baseline.traceSet?.traces ?? [];
  const frozenDigest = sha256OfCanonical(frozenTraces);
  if (baseline.traceSet?.traceDigest !== frozenDigest) {
    return refused('DRIFT_DETECTED', 'the frozen trace digest does not verify against the canonical trace set');
  }
  if (sha256OfCanonical(surfaces.traceSet.traces) !== frozenDigest) {
    return refused('DRIFT_DETECTED', 'the frozen trace set drifted from the accepted trace/member-binding set (mutating accepted material after reconciliation is refused)');
  }
  // Source manifests, case identity, acceptance records, Development surface.
  for (const key of SOURCE_MANIFEST_KEYS) {
    if (!sameSet(baseline.sourceManifests?.[key]?.ids ?? [], surfaces.sourceManifests[key].ids)
      || baseline.sourceManifests?.[key]?.manifestDigest !== surfaces.sourceManifests[key].manifestDigest) {
      return refused('DRIFT_DETECTED', `the frozen source manifest ${key} drifted from the accepted manifest (exact set + manifest digest)`);
    }
  }
  if (baseline.caseIdentity?.discoveryCertificateRef !== surfaces.caseIdentity.discoveryCertificateRef
    || baseline.caseIdentity?.formalizationCaseRef !== surfaces.caseIdentity.formalizationCaseRef) {
    return refused('DRIFT_DETECTED', 'the frozen case identity is not the accepted FormalizationCase/Discovery certificate identity (substituted case material is refused)');
  }
  const recordKeys = (records) => records.map((record) => `${record.deskId}#${record.candidateSetRef}#${record.cellFinalAcceptanceRef}#${record.workplaceProductionRevisionRef}`).sort();
  if (recordKeys(baseline.acceptanceRecords ?? []).join('\u0000') !== recordKeys(surfaces.acceptanceRecords).join('\u0000')) {
    return refused('DRIFT_DETECTED', 'the frozen acceptance records drifted from the carried CellFinalAcceptance/CandidateSet/WorkplaceProductionRevision surfaces');
  }
  if (JSON.stringify(baseline.developmentSurface) !== JSON.stringify(surfaces.developmentSurface)) {
    return refused('DRIFT_DETECTED', 'the frozen Development handoff/obligation resolution surface drifted from the declared surface');
  }
  const foldRefusal = checkNoFolding(baseline, surfaces);
  if (foldRefusal !== null) return foldRefusal;
  return null;
}

/** The complete ingestion: carry-check, build, WP03-validate, exact-authority assert. */
export function ingestAcceptedAuthority(surfaces, options = {}) {
  const folded = refuseFoldedShape(surfaces);
  if (folded !== null) return folded;
  const built = buildWhatBaseline(surfaces, options.pinnedCaseIdentity);
  if (isRefused(built)) return built;
  const exact = assertExactAuthority(built.baseline, surfaces);
  if (exact !== null) return exact;
  return built;
}

/**
 * Verify a PRESENTED baseline (a replayed capsule candidate, a re-frozen
 * artifact from another execution, or any material claiming to be the
 * frozen authority) against the exact accepted surfaces. This is the
 * substitution fence for material the desk did not build itself: the
 * folded shape is refused on sight, every section is compared to the
 * accepted authority id-for-id and digest-for-digest, and the payload
 * must seal via the FRF-WP03 validator against the universe derived
 * from the same surfaces. Substitution, folding and duplication are
 * typed DRIFT_DETECTED / FOREIGN_LINEAGE / MALFORMED_PRODUCT refusals.
 */
export function verifyPresentedBaseline(baseline, surfaces, options = {}) {
  const folded = refuseFoldedShape(baseline);
  if (folded !== null) return folded;
  const carried = checkSurfacesCarried(surfaces);
  if (carried !== null) return carried;
  const universe = universeOfSurfaces(surfaces, options.pinnedCaseIdentity);
  if (!universe.ok) return universe;
  const exact = assertExactAuthority(baseline, surfaces);
  if (exact !== null) return exact;
  const validation = validateWhatBaseline(baseline, universe.universe);
  if (validation.ok !== true) return validation;
  return { ok: true, baseline, universe: universe.universe };
}
