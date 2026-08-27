/**
 * FRF-WP03 pure validator: whole-WHAT baseline
 * (contract frf-contracts.what-baseline.v1).
 *
 * Deterministic, closed-vocabulary, fail-closed with typed refusal codes.
 * The frozen container the WHAT-freeze desk seals: exact set equality
 * against the supplied accepted id sets (missing material cannot disappear
 * at freeze; foreign or substituted material cannot enter), the trace set
 * closed over the frozen members, dispositions as distinct named content,
 * evidence-method bindings, the Development handoff/obligation resolution
 * surface, and one canonical whole-WHAT digest. This validator is the
 * UC-FOREIGN fix TARGET shape: it takes the accepted id sets as INPUT and
 * refuses every binding that does not resolve against them.
 *
 * Digest rules (canonical rule of the kernel, mirrored from
 * src/workflow-kernel/domain/digest.ts):
 *   traceSet.traceDigest  = sha256(canonicalJson(traces))
 *   wholeWhatDigest       = sha256(canonicalJson(baseline minus wholeWhatDigest))
 *
 * Typed refusals:
 *   MALFORMED_PRODUCT - structural violations, open vocabularies, missing
 *                       disposition parts, wrong surface manifests.
 *   MISSING_LINEAGE   - missing accepted id sets / revision pins.
 *   STALE_LINEAGE     - container revision digests that are not the
 *                       accepted revisions.
 *   FOREIGN_LINEAGE   - ids/refs outside the exact accepted sets.
 *   COVERAGE_GAP      - missing accepted members, uncovered scope claims
 *                       (epic-scope-equality law), chain members with no
 *                       trace, terminal branches with no evidence (cr-05).
 *   DRIFT_DETECTED    - duplicate ids/digests (substitution), trace or
 *                       whole-WHAT digest mismatch, substituted case
 *                       identity.
 */

import {
  REFUSAL_REASONS,
  digestExcluding,
  findDuplicates,
  refused,
  setIdentical,
  sha256OfCanonical,
  sealed,
} from './common.mjs';

export const CONTRACT_KIND = 'frf-contracts.what-baseline.v1';

const REQUIRED_DESKS = Object.freeze([
  'define-acceptance-contract',
  'define-product-intent',
  'derive-system-requirements',
  'model-use-cases',
  'reconcile-what',
]);

const TRACE_KINDS = Object.freeze([
  'ac-derived-from-fr-or-nfr',
  'fr-derived-from-prd-and-uc-branches-when-scenario-derived',
  'nfr-derived-from-prd-optionally-uc-when-scenario-local',
  'prd-derived-from-brief-and-source-claims',
  'rule-derived-from-prd-optionally-uc-when-scenario-local',
  'scenario-facing-ac-derived-from-uc-and-terminal-branch',
  'srs-derived-from-frozen-what-baseline',
  'uc-derived-from-prd-intent-members',
]);

const EVIDENCE_KINDS = Object.freeze([
  'audit',
  'independent-agent-review',
  'monitoring',
  'test',
]);

export const HANDOFF_BINDING_KINDS = Object.freeze([
  'acceptance-bindings',
  'formalization-certificate',
  'integration-and-construction-obligations',
  'prd-intent-bindings',
  'repository-and-policy-bindings',
  'requirement-bindings',
  'scenario-bindings',
  'scenario-realization-bindings',
  'solution-contract',
  'srs-reference-and-hash',
  'terminal-claim-bindings',
  'what-baseline-reference-and-hash',
]);

export const WORK_ITEM_OBLIGATION_KINDS = Object.freeze([
  'acceptance-obligation',
  'infrastructure-obligation',
  'integration-or-composition-obligation',
  'requirement-obligation',
  'scenario-realization-obligation',
]);

const RESOLUTION_SURFACES = Object.freeze([
  'caseIdentity.discoveryCertificateRef',
  'caseIdentity.formalizationCaseRef',
  'containers.ac.criterionIds',
  'containers.fr.memberIds',
  'containers.nfr.memberIds',
  'containers.prd.memberIds',
  'containers.rule.memberIds',
  'containers.uc.scenarioIds',
  'postFreeze.development.repositoryPolicyRefs',
  'postFreeze.srs.realizationEntryIds',
  'postFreeze.srs.revisionDigest',
  'postFreeze.srs.surfaces',
  'postFreeze.settlement.solutionContractDigest',
  'sourceManifests.claimIds',
  'sourceManifests.constraintIds',
  'sourceManifests.terminalClaimIds',
  'wholeWhatDigest',
]);

const REQUIRED_ID_SETS = Object.freeze([
  'sourceClaimIds',
  'sourceConstraintIds',
  'terminalClaimIds',
  'prdMemberIds',
  'ucScenarioIds',
  'frIds',
  'nfrIds',
  'ruleIds',
  'criterionIds',
  'evidenceBindingIds',
]);

export function validateWhatBaseline(baseline, universe) {
  if (baseline === null || typeof baseline !== 'object' || Array.isArray(baseline)) {
    return refused('MALFORMED_PRODUCT', 'whole-WHAT baseline is not an object');
  }
  if (baseline.schemaVersion !== CONTRACT_KIND) {
    return refused('MALFORMED_PRODUCT', `product is not a ${CONTRACT_KIND}`);
  }

  // Fail-closed: the exact accepted id sets must be supplied.
  for (const setName of REQUIRED_ID_SETS) {
    const value = universe?.idSets?.[setName];
    if (!Array.isArray(value) || value.length === 0) {
      return refused('MISSING_LINEAGE', `no accepted ${setName} set was supplied; the freezer is fail-closed and never scans or guesses`);
    }
  }
  const branchMap = universe.idSets.ucBranchIdsByScenario;
  if (branchMap === undefined || branchMap === null || typeof branchMap !== 'object' || Array.isArray(branchMap)
    || Object.keys(branchMap).length === 0) {
    return refused('MISSING_LINEAGE', 'no accepted ucBranchIdsByScenario map was supplied; the freezer is fail-closed');
  }

  // Case identity: substitution fence against the supplied pins.
  const expectedCase = universe?.caseIdentity;
  if (expectedCase !== undefined) {
    for (const key of ['discoveryCertificateRef', 'formalizationCaseRef']) {
      if (baseline.caseIdentity?.[key] !== expectedCase[key]) {
        return refused('DRIFT_DETECTED', `case identity ${key} is ${String(baseline.caseIdentity?.[key])}, the accepted identity is ${String(expectedCase[key])} (substituted case material is refused)`);
      }
    }
  }

  // Source manifests: exact id-set equality (claims, constraints, terminal claims).
  const manifestPairs = [
    ['claims', 'sourceClaimIds'],
    ['constraints', 'sourceConstraintIds'],
    ['terminalClaims', 'terminalClaimIds'],
  ];
  for (const [manifestKey, setName] of manifestPairs) {
    const refusal = setIdentical(baseline.sourceManifests?.[manifestKey]?.ids ?? [], universe.idSets[setName], {
      subject: `source manifest ${manifestKey}`,
    });
    if (refusal !== null) return refusal;
  }

  // Acceptance records: exactly one per accepted pre-freeze desk.
  const records = baseline.acceptanceRecords ?? [];
  const recordDesks = records.map((record) => record.deskId);
  const deskDuplicates = findDuplicates(recordDesks);
  if (deskDuplicates.length > 0) {
    return refused('DRIFT_DETECTED', `acceptance record(s) for desk(s) ${deskDuplicates.join(', ')} appear more than once (double emission)`);
  }
  const unknownDesks = recordDesks.filter((deskId) => !REQUIRED_DESKS.includes(deskId));
  if (unknownDesks.length > 0) {
    return refused('FOREIGN_LINEAGE', `acceptance record(s) for desk(s) ${unknownDesks.join(', ')} outside the accepted pre-freeze desk vocabulary`);
  }
  const missingDesks = REQUIRED_DESKS.filter((deskId) => !recordDesks.includes(deskId));
  if (missingDesks.length > 0) {
    return refused('COVERAGE_GAP', `no acceptance record for accepted desk(s) ${missingDesks.join(', ')} (each accepted CellFinalAcceptance/CandidateSet/WorkplaceProductionRevision is frozen exactly)`);
  }

  // Containers: revision pins (fail-closed) then exact member-set equality.
  const pins = universe?.revisionPins ?? {};
  const containerPairs = [
    ['ac', 'criterionIds', 'criterionId'],
    ['fr', 'frIds', 'memberId'],
    ['nfr', 'nfrIds', 'memberId'],
    ['prd', 'prdMemberIds', 'memberId'],
    ['rule', 'ruleIds', 'memberId'],
    ['uc', 'ucScenarioIds', 'scenarioId'],
  ];
  const frozenUniverse = new Set([
    ...universe.idSets.sourceClaimIds,
    ...universe.idSets.sourceConstraintIds,
    ...universe.idSets.terminalClaimIds,
    ...universe.idSets.prdMemberIds,
    ...universe.idSets.ucScenarioIds,
    ...universe.idSets.frIds,
    ...universe.idSets.nfrIds,
    ...universe.idSets.ruleIds,
    ...universe.idSets.criterionIds,
  ]);
  for (const scenarioId of Object.keys(branchMap)) {
    frozenUniverse.add(scenarioId);
    for (const branchId of branchMap[scenarioId]) frozenUniverse.add(branchId);
  }
  const allDigests = [];
  const frozenBranches = [];
  for (const [containerKey, setName, idField] of containerPairs) {
    const container = baseline.containers?.[containerKey];
    if (container === undefined) {
      return refused('MALFORMED_PRODUCT', `the whole-WHAT baseline must freeze the ${containerKey.toUpperCase()} container`);
    }
    const pin = pins[containerKey];
    if (typeof pin !== 'string' || !/^[0-9a-f]{64}$/.test(pin)) {
      return refused('MISSING_LINEAGE', `no accepted ${containerKey} revision digest was supplied (fail-closed: the frozen revision pin cannot be verified)`);
    }
    if (container.revisionDigest !== pin) {
      return refused('STALE_LINEAGE', `the frozen ${containerKey} revision ${String(container.revisionDigest)} is not the accepted revision ${pin}`);
    }
    const members = container.members ?? [];
    const duplicateIds = findDuplicates(members.map((member) => member[idField]));
    if (duplicateIds.length > 0) {
      return refused('DRIFT_DETECTED', `${containerKey} member id(s) ${duplicateIds.join(', ')} appear more than once (an artifact was substituted or emitted twice)`);
    }
    const refusal = setIdentical(members.map((member) => member[idField]), universe.idSets[setName], {
      subject: `${containerKey} container`,
    });
    if (refusal !== null) return refusal;
    for (const member of members) {
      allDigests.push(member.digest);
    }
    if (containerKey === 'uc') {
      for (const member of members) {
        const branchIds = (member.branches ?? []).map((branch) => branch.branchId);
        const expectedBranches = branchMap[member.scenarioId] ?? [];
        const branchRefusal = setIdentical(branchIds, expectedBranches, {
          subject: `terminal branches of ${member.scenarioId}`,
        });
        if (branchRefusal !== null) return branchRefusal;
        for (const branch of member.branches ?? []) {
          frozenBranches.push(branch.branchId);
          allDigests.push(branch.digest);
        }
      }
    }
  }
  const duplicateDigests = findDuplicates(allDigests);
  if (duplicateDigests.length > 0) {
    return refused('DRIFT_DETECTED', `member digest(s) ${duplicateDigests.join(', ')} appear more than once (an artifact was substituted or emitted twice)`);
  }

  // Dispositions: distinct named content; deferred/outOfScope need owner+reason.
  const dispositions = baseline.dispositions ?? {};
  const disposedSubjects = new Set([
    ...(dispositions.deferred ?? []).map((entry) => entry.subjectRef),
    ...(dispositions.outOfScope ?? []).map((entry) => entry.subjectRef),
  ]);
  for (const [section, entries] of Object.entries(dispositions)) {
    if (!Array.isArray(entries)) {
      return refused('MALFORMED_PRODUCT', `disposition section ${section} is malformed`);
    }
    for (const entry of entries) {
      if ((section === 'deferred' || section === 'outOfScope')
        && (typeof entry.owner !== 'string' || entry.owner.length === 0 || typeof entry.reason !== 'string' || entry.reason.length === 0)) {
        return refused('MALFORMED_PRODUCT', `${section} disposition of ${String(entry.subjectRef)} requires an owner and a reason`);
      }
      if (!frozenUniverse.has(entry.subjectRef)) {
        return refused('FOREIGN_LINEAGE', `${section} disposition names subject ${String(entry.subjectRef)} outside the frozen member universe`);
      }
    }
  }

  // Evidence bindings: exact set equality + closed kind vocabulary.
  const evidenceBindings = baseline.evidenceBindings ?? [];
  if (evidenceBindings.length === 0) {
    return refused('MALFORMED_PRODUCT', 'the baseline must freeze at least one evidence-method binding');
  }
  const evidenceIds = evidenceBindings.map((entry) => entry.evidenceBindingId);
  const duplicateEvidence = findDuplicates(evidenceIds);
  if (duplicateEvidence.length > 0) {
    return refused('DRIFT_DETECTED', `evidence binding id(s) ${duplicateEvidence.join(', ')} appear more than once`);
  }
  const evidenceRefusal = setIdentical(evidenceIds, universe.idSets.evidenceBindingIds, {
    subject: 'evidence bindings',
  });
  if (evidenceRefusal !== null) return evidenceRefusal;
  for (const entry of evidenceBindings) {
    if (!EVIDENCE_KINDS.includes(entry.evidenceKind)) {
      return refused('MALFORMED_PRODUCT', `evidence binding ${String(entry.evidenceBindingId)} has kind ${String(entry.evidenceKind)} outside the closed four-value vocabulary`);
    }
    if (!frozenUniverse.has(entry.subjectRef)) {
      return refused('FOREIGN_LINEAGE', `evidence binding ${String(entry.evidenceBindingId)} names subject ${String(entry.subjectRef)} outside the frozen member universe`);
    }
  }

  // Trace set: closed grammar, resolved ends, canonical digest.
  const traces = baseline.traceSet?.traces ?? [];
  if (traces.length === 0) {
    return refused('MALFORMED_PRODUCT', 'the baseline must freeze a non-empty accepted trace set');
  }
  const traceEnds = new Set();
  for (const trace of traces) {
    if (!TRACE_KINDS.includes(trace.kind)) {
      return refused('MALFORMED_PRODUCT', `trace ${String(trace.fromRef)} -> ${String(trace.toRef)} has kind ${String(trace.kind)} outside the closed eight-rule grammar`);
    }
    for (const end of [trace.fromRef, trace.toRef]) {
      if (!frozenUniverse.has(end)) {
        return refused('FOREIGN_LINEAGE', `trace of kind ${trace.kind} cites ${String(end)} outside the frozen member universe (a srs-derived trace cannot exist at freeze time by construction)`);
      }
      traceEnds.add(end);
    }
  }
  const recomputedTraceDigest = sha256OfCanonical(traces);
  if (baseline.traceSet.traceDigest !== recomputedTraceDigest) {
    return refused('DRIFT_DETECTED', `the frozen trace digest ${String(baseline.traceSet.traceDigest)} does not verify against the canonical trace set (${recomputedTraceDigest})`);
  }

  // Chain closure: scenarios, requirements and criteria appear in the trace set.
  for (const id of [...universe.idSets.ucScenarioIds, ...universe.idSets.frIds, ...universe.idSets.nfrIds, ...universe.idSets.ruleIds, ...universe.idSets.criterionIds]) {
    if (!traceEnds.has(id)) {
      return refused('COVERAGE_GAP', `frozen member ${id} appears in no accepted trace (the WHAT chain is closed in both directions)`);
    }
  }
  // cr-05: every terminal branch has an end-to-end AC or an accepted evidence binding.
  const evidenceSubjects = new Set(evidenceBindings.map((entry) => entry.subjectRef));
  for (const branchId of frozenBranches) {
    if (!traceEnds.has(branchId) && !evidenceSubjects.has(branchId)) {
      return refused('COVERAGE_GAP', `terminal branch ${branchId} has no end-to-end AC trace and no accepted evidence binding (cr-05)`);
    }
  }
  // Epic-scope-equality law: every accepted scope claim is realized by a PRD
  // member trace or explicitly disposed (deferred / out of scope).
  const realizedClaims = new Set(traces
    .filter((trace) => trace.kind === 'prd-derived-from-brief-and-source-claims')
    .map((trace) => trace.fromRef));
  for (const claimId of universe.idSets.sourceClaimIds) {
    if (!realizedClaims.has(claimId) && !disposedSubjects.has(claimId)) {
      return refused('COVERAGE_GAP', `accepted scope claim ${claimId} has no exact PRD intent member and no explicit deferred/out-of-scope disposition (epic-scope-equality law)`);
    }
  }

  // Development surface: the exact twelve handoff kinds and five obligation kinds.
  const surface = baseline.developmentSurface ?? {};
  const checkKindMap = (map, expectedKinds, label) => {
    const keys = Object.keys(map ?? {}).sort();
    const expected = [...expectedKinds].sort();
    if (keys.join('\u0000') !== expected.join('\u0000')) {
      return refused('MALFORMED_PRODUCT', `${label} declares [${keys.join(', ')}], the closed vocabulary is [${expected.join(', ')}] (open or missing binding kinds are refused)`);
    }
    for (const [kind, entry] of Object.entries(map)) {
      for (const surfaceName of entry.resolvesAgainst ?? []) {
        if (!RESOLUTION_SURFACES.includes(surfaceName)) {
          return refused('MALFORMED_PRODUCT', `${label} entry ${kind} resolves against unknown surface ${String(surfaceName)} (open resolution-surface vocabulary)`);
        }
      }
    }
    return null;
  };
  const handoffRefusal = checkKindMap(surface.handoffBindingKinds, HANDOFF_BINDING_KINDS, 'handoffBindingKinds');
  if (handoffRefusal !== null) return handoffRefusal;
  const obligationRefusal = checkKindMap(surface.workItemObligationKinds, WORK_ITEM_OBLIGATION_KINDS, 'workItemObligationKinds');
  if (obligationRefusal !== null) return obligationRefusal;

  // One canonical whole-WHAT digest over the sealed content.
  const recomputedWhole = digestExcluding(baseline, ['wholeWhatDigest']);
  if (baseline.wholeWhatDigest !== recomputedWhole) {
    return refused('DRIFT_DETECTED', `the canonical whole-WHAT digest ${String(baseline.wholeWhatDigest)} does not verify against the sealed content (${recomputedWhole})`);
  }
  return sealed(CONTRACT_KIND, baseline);
}

export { REFUSAL_REASONS };
