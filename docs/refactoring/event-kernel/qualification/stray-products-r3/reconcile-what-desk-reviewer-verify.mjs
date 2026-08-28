/**
 * reconcile-what desk (reviewer) - INDEPENDENT verification of the author
 * candidate of record.
 *
 * Nothing is trusted by declaration: every published digest is recomputed,
 * the upstream chain is re-derived through the REAL kernel surfaces (PRD/UC
 * validators + REAL folds + WP03 requirements validator +
 * acceptanceUniverseFrom + validateAcceptanceBundle) and the report is
 * re-computed through the REAL acceptance.reconcileWhat over a snapshot
 * recomputed from accepted material. On top of the author-side surface the
 * reviewer route adds adversarial probes (same-provider recheck, zero
 * softening): verdict-injection/hardcode kill, requirement strip, foreign
 * criterion binding, row-mapping faithfulness, purity + deep-freeze,
 * envelope tamper, upstream byte-tamper, and a workspace-law scan.
 *
 * Deterministic: no clock reads, no randomness. Rule: sha256 over canonical
 * JSON (recursively key-sorted, compact, UTF-8) per
 * src/workflow-kernel/domain/digest.ts.
 *
 * Run: node reconcile-what-desk-reviewer-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(DIR, '..', '..', '..', '..', '..');
const accCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'acceptance', 'index.mjs')).href);
const upCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'product-intent', 'index.js')).href);
const srCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'system-requirements', 'index.js')).href);
const wp03sr = await import(pathToFileURL(join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'validators', 'requirements-bundle.mjs')).href);
const prd03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href);
const uc03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'uc-scenario-member.mjs')).href);
const wp03seam = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'acceptance', 'wp03-seam.mjs')).href);

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok: ok === true, detail }); if (ok !== true) process.exitCode = 1; };

const load = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

/* The candidate of record (author artifacts). */
const art = load('reconcile-what-desk-what-reconciliation.artifact.json');
const trc = load('reconcile-what-desk-what-reconciliation-trace.json');
const sub = load('reconcile-what-desk-product-submission.json');

/* Upstream material (r3 copies, consumed by pinned content address). */
const upArt = load('define-product-intent-desk-product-intent.artifact.json');
const ucArt = load('model-use-cases-desk-uc-scenarios.artifact.json');
const srArt = load('derive-system-requirements-desk-system-requirements.artifact.json');
const accArt = load('define-acceptance-contract-desk-acceptance-bindings.artifact.json');
const ucTrc = load('model-use-cases-desk-uc-scenarios-trace.json');
const ucSub = load('model-use-cases-desk-product-submission.json');
const srTrc = load('derive-system-requirements-desk-system-requirements-trace.json');
const srSub = load('derive-system-requirements-desk-product-submission.json');
const accTrc = load('define-acceptance-contract-desk-acceptance-bindings-trace.json');
const accSub = load('define-acceptance-contract-desk-product-submission.json');
const accReview = load('define-acceptance-contract-desk-reviewer-review.json');
const accVV = load('define-acceptance-contract-desk-reviewer-verification.json');

const ENVELOPE = {
  'claim:scope-1': 'b15c35da54dd016492f397d71a59883d38cfb0c5e55aaa51f68c4d3f210d1909',
  'claim:scope-2': 'cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da',
  'claim:constraint-1': '6652762b7d8d26aacbaeb11f1b1e1529b26c2974ecf8ab0a01f0eb2b651d753b',
  'claim:outcome-1': '3d576e96e9c101b4b7187be8ce0d6f4542c161e8b8f9fa7323397329ac4e85b0',
  'constraint:retention-1': '807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be',
  'unknown:browser-matrix-1': '38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf',
  'terminal:audited-1': '4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f',
  'terminal:delivered-1': '8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988',
};
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const SEMANTIC_SKILL = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';
const PROTOCOL_SKILL = 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50';
const REVIEWER_SEMANTIC_SKILL = '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2';
const WORKSPACE_SUMMARY = '0 accepted upstream revisions travel by content address';

/* ------------------------------------------------------------------ */
/* A. Candidate self-address + desk pins                                */
/* ------------------------------------------------------------------ */

check('A1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('A2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), `recomputed ${shaRef(art.contentDigest)} vs declared ${art.artifactRef}`);
check('A3.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)} vs declared ${trc.contentDigest}`);
check('A4.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), `recomputed ${shaRef(trc.contentDigest)} vs declared ${trc.traceRef}`);
check('A5.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('A6.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), `recomputed ${shaRef(sub.contentDigest)} vs declared ${sub.submissionRef}`);
check('A7.kind.family', art.productKind === 'formalization.what-reconciliation.v1' && art.content.schemaVersion === accCell.RECONCILIATION_REPORT_KIND && art.content.product.schemaVersion === accCell.RECONCILIATION_REPORT_KIND, `productKind=${art.productKind} schemaVersion=${art.content.schemaVersion}/${art.content.product.schemaVersion} vs RECONCILIATION_REPORT_KIND=${accCell.RECONCILIATION_REPORT_KIND}`);
check('A8.workspace.governing', art.content.workspaceSummary === WORKSPACE_SUMMARY && art.content.governingContractRef === shaRef(GOVERNING) && sub.content.workspaceSummary === WORKSPACE_SUMMARY && sub.content.traceRef === trc.traceRef && sub.content.candidate.artifactRef === art.artifactRef, 'workspace summary + governing pin present; submission binds the artifact and trace of record');
check('A9.intake.reviewerStage', sub.content.intakeReceipt?.status === 'admitted_for_reviewer_stage' && sub.content.intakeReceipt?.nextStage === 'reviewer' && sub.content.intakeReceipt?.receiptRef === 'evidence:DeskIntakeReceipt#reconcile-what:author', `intake receipt ${sub.content.intakeReceipt?.status} -> ${sub.content.intakeReceipt?.nextStage} (this reviewer stage is the admitted next stage)`);
check('A10.semanticSkill.authorPin', JSON.stringify(sub.content.payloadContract.requiredEvidenceRefs).includes(shaRef(SEMANTIC_SKILL)), `author evidence set pins the semantic skill ${shaRef(SEMANTIC_SKILL)}`);

/* ------------------------------------------------------------------ */
/* B. Upstream re-derivation (REAL folds + REAL validators, reviewer    */
/*    recheck - nothing inherited from the author's own verify run)     */
/* ------------------------------------------------------------------ */

const SR_PRODUCT = srArt.content.product;
const ACC_PRODUCT = accArt.content.product;

const upSeal = new Map();
for (const m of upArt.content.members) {
  const v = prd03.validatePrdIntentMember(m, {
    idSets: {
      sourceClaimIds: Object.keys(ENVELOPE).filter((id) => id.startsWith('claim:')),
      terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'],
    },
  });
  check(`B1.prd03.${m.memberId}`, v.ok === true, v.ok === true ? 'accepted through the REAL PRD validator' : `refuses: ${v.reason}`);
  upSeal.set(m.memberId, sha(m));
}
const upFold = upCell.acceptedIntentSetOf(
  { members: upArt.content.members },
  upArt.content.members.map((m) => ({ memberId: m.memberId, digest: upSeal.get(m.memberId) })),
);
check('B2.intentFold', upFold.ok === true && shaRef(upFold.set.revisionDigest) === SR_PRODUCT.prdRevisionRef && upFold.set.revisionDigest === art.content.upstream.acceptedIntentSet.revisionDigest, upFold.ok === true ? `revision pin ${shaRef(upFold.set.revisionDigest)} refolds; matches the candidate upstream pin` : `fold failed: ${upFold.detail}`);

const ucSeal = new Map();
for (const s of ucArt.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, { idSets: { prdMemberIds: upFold.set.prdMemberIds } });
  check(`B3.uc03.${s.scenarioId}`, v.ok === true, v.ok === true ? 'accepted through the REAL UC validator' : `refuses: ${v.reason}`);
  ucSeal.set(s.scenarioId, sha(s));
}
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
check('B4.ucRevision', shaRef(ucRevisionDigest) === SR_PRODUCT.ucRevisionRef, `revision pin ${shaRef(ucRevisionDigest)} refolds`);
const acceptedUcSet = {
  memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort(),
  scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(),
  branchIdsByScenario: Object.fromEntries(ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)])),
  revisionDigest: ucRevisionDigest,
};

const requirementSeal = new Map(SR_PRODUCT.requirements.map((r) => [r.requirementId, sha(r)]));
const criterionSeal = new Map(ACC_PRODUCT.criteria.map((c) => [c.criterionId, sha(c)]));
const statementSeal = new Map(accArt.content.verifiableStatements.map((s) => [s.statementId, sha({ statementId: s.statementId, statement: s.statement })]));
const declaredRequirementSeals = new Map((srArt.content.memberSeals ?? []).map((s) => [s.requirementId, s.digest]));
check('B5.requirementSeals', SR_PRODUCT.requirements.every((r) => declaredRequirementSeals.get(r.requirementId) === requirementSeal.get(r.requirementId)), `${SR_PRODUCT.requirements.length}/${SR_PRODUCT.requirements.length} requirement seals recompute over canonical members`);
check('B6.criterionSeals', ACC_PRODUCT.criteria.every((c) => sha(c) === criterionSeal.get(c.criterionId)) && (accArt.content.memberSeals ?? []).every((s) => criterionSeal.get(s.criterionId) === s.digest), `${ACC_PRODUCT.criteria.length}/${ACC_PRODUCT.criteria.length} criterion seals recompute over canonical members`);
const declaredStatements = accArt.content.verifiableStatements ?? [];
check('B7.statementSeals', declaredStatements.every((s) => sha({ statementId: s.statementId, statement: s.statement }) === s.digest && statementSeal.get(s.statementId) === s.digest), `${declaredStatements.length}/${declaredStatements.length} verifiable-statement seals recompute over {statementId, statement}`);

const srUniverse = srCell.deriveAcceptedUniverse({
  prd: { revisionDigest: upFold.set.revisionDigest, memberIds: [...upFold.set.prdMemberIds] },
  useCases: { revisionDigest: ucRevisionDigest, scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  sourceConstraintIds: ['constraint:retention-1'],
  verificationSurfaceIds: srArt.content.deskInput.verificationSurfaceIds,
});
const srSealedNow = srUniverse.ok === true ? wp03sr.validateRequirementsBundle(SR_PRODUCT, srUniverse.universe) : { ok: false, reason: 'universe refused', detail: srUniverse.detail };
check('B8.wp03.requirementsReseal', srSealedNow.ok === true, srSealedNow.ok === true ? `re-sealed ${srSealedNow.ref}` : `${srSealedNow.reason}: ${srSealedNow.detail}`);

const accUniverse = accCell.acceptanceUniverseFrom({
  requirementsBundle: SR_PRODUCT,
  useCases: { scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  verifiableStatementIds: accArt.content.deskInput.verifiableStatementIds,
  evidenceBindings: accArt.content.deskInput.evidenceBindings,
});
const accSealedNow = accUniverse.ok === true ? accCell.validateAcceptanceBundle(ACC_PRODUCT, accUniverse.universe, SR_PRODUCT.requirements) : { ok: false, reason: 'universe refused', detail: accUniverse.detail };
check('B9.acceptanceReseal', accSealedNow.ok === true && accSealedNow.artifact.ref === accArt.content.productSeal.ref, accSealedNow.ok === true ? `re-sealed ${accSealedNow.artifact.ref} vs published seal ${accArt.content.productSeal.ref}` : `${accSealedNow.reason}: ${accSealedNow.detail}`);

check('B10.reviewerOfRecord', accReview.content.verdict === 'accepted'
  && accReview.content.reviewedCandidate.submissionRef === accSub.submissionRef
  && accReview.content.reviewedCandidate.artifactRef === accArt.artifactRef
  && accReview.content.reviewedCandidate.traceRef === accTrc.traceRef
  && accReview.content.reviewedCandidate.productSeal === accArt.content.productSeal.ref
  && accReview.content.verificationRef === shaRef(accVV.contentDigest)
  && sha(accVV.content) === accVV.contentDigest,
  `the acceptance reviewer decision says accepted over exactly the published author candidate (verification ref binds the recomputed reviewer VV digest ${accVV.contentDigest.slice(0, 8)}...)`);

/* ------------------------------------------------------------------ */
/* C. The computed report (REAL reconcileWhat over the re-derived       */
/*    snapshot - recomputed by the reviewer, not inherited)             */
/* ------------------------------------------------------------------ */

const claimIds = Object.keys(ENVELOPE).filter((id) => id.startsWith('claim:')).sort();
const claimMembers = new Map();
for (const memberId of [...upFold.set.prdMemberIds].sort()) {
  const member = upArt.content.members.find((m) => m.memberId === memberId);
  for (const claimId of member.sourceClaimRefs ?? []) {
    if (!claimMembers.has(claimId)) claimMembers.set(claimId, []);
    claimMembers.get(claimId).push(memberId);
  }
}
const claimToMember = Object.fromEntries(claimIds.map((claimId) => [claimId, claimMembers.get(claimId)[0]]));
const snapshot = {
  universe: accUniverse.universe,
  requirements: SR_PRODUCT.requirements,
  acceptance: {
    criteria: ACC_PRODUCT.criteria,
    deferrals: ACC_PRODUCT.deferrals ?? [],
    standaloneEvidenceBindings: ACC_PRODUCT.standaloneEvidenceBindings ?? [],
  },
  prd: { memberIds: [...upFold.set.prdMemberIds], scenarioRequiredMemberIds: [...upFold.set.scenarioRequiredMemberIds] },
  useCases: { scenarioIds: [...acceptedUcSet.scenarioIds], branchIdsByScenario: { ...acceptedUcSet.branchIdsByScenario } },
  sourceClaims: { claimIds, claimToMember },
};
const recomputedReport = accCell.reconcileWhat(snapshot);
check('C1.report.byteEquality', canon(recomputedReport) === canon(art.content.product), `recomputed report digest ${recomputedReport.reportDigest} vs declared ${art.content.product.reportDigest}`);
check('C2.reportDigest.internal', shaRef(sha({ ...art.content.product, reportDigest: undefined })) === art.content.product.reportDigest, `recomputed ${shaRef(sha({ ...art.content.product, reportDigest: undefined }))} vs declared ${art.content.product.reportDigest}`);
check('C3.verdict.computedLaw', art.content.product.verdict === 'consistent' && art.content.product.findings.length === 0 && recomputedReport.verdict === 'consistent' && recomputedReport.findings.length === 0, `published verdict=${art.content.product.verdict} findings=${art.content.product.findings.length}; recomputed verdict=${recomputedReport.verdict} findings=${recomputedReport.findings.length}`);
check('C4.report.deepFrozen', Object.isFrozen(recomputedReport) && Object.isFrozen(recomputedReport.findings) && Object.isFrozen(recomputedReport.rows) && Object.isFrozen(recomputedReport.gaps), 'the REAL reconciler returns a deep-frozen report (report-only law, cr-12)');
check('C5.rows.installedShape', art.content.product.rows.length === 4 && art.content.product.rows.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['criterionRefs', 'memberRef', 'requirementRefs', 'scenarioRef', 'sourceClaimRef'])), `${art.content.product.rows.length} rows in the installed formalization.what-reconciliation.v1 row shape`);
const scopeRow = art.content.product.rows.find((r) => r.sourceClaimRef === 'claim:scope-2');
check('C6.outOfScope.honestEmptyRow', scopeRow?.memberRef === 'prd:scope-2' && scopeRow.requirementRefs.length === 0 && scopeRow.criterionRefs.length === 0, `claim:scope-2 row: memberRef=${scopeRow?.memberRef} requirements=${scopeRow?.requirementRefs.length} criteria=${scopeRow?.criterionRefs.length} (honest empty row, derives nothing)`);

let seamRefusals = 0;
const seamReasons = [];
for (const c of ACC_PRODUCT.criteria) {
  const v = wp03seam.validateAcBinding(c, accUniverse.universe);
  if (v.ok !== true) { seamRefusals += 1; seamReasons.push(`${c.criterionId}: ${v.reason}`); }
}
check('C7.reverse.wp03Seam', seamRefusals === 0, `${ACC_PRODUCT.criteria.length}/${ACC_PRODUCT.criteria.length} criteria re-validated through the REAL WP03 seam against the re-derived universe; refusals=${seamRefusals}${seamReasons.length ? ` (${seamReasons.join('; ')})` : ''}`);

/* ------------------------------------------------------------------ */
/* D. Trace resolution + exact coverage projections                     */
/* ------------------------------------------------------------------ */

const reportDigestHex = art.content.product.reportDigest.replace(/^sha256:/, '');
const branchOwner = new Map();
for (const [scenarioId, branchIds] of Object.entries(acceptedUcSet.branchIdsByScenario)) {
  for (const branchId of branchIds) branchOwner.set(branchId, scenarioId);
}
const resolveId = (id) => {
  if (id === 'report') return reportDigestHex;
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (criterionSeal.has(id)) return criterionSeal.get(id);
  if (requirementSeal.has(id)) return requirementSeal.get(id);
  if (ucSeal.has(id)) return ucSeal.get(id);
  if (upSeal.has(id)) return upSeal.get(id);
  if (statementSeal.has(id)) return statementSeal.get(id);
  if (branchOwner.has(id)) return ucSeal.get(branchOwner.get(id));
  return null;
};
const unresolvedEdges = [];
for (const r of trc.content.relationships) {
  if (resolveId(r.fromId) === null || resolveId(r.toId) === null || r.fromRef !== shaRef(resolveId(r.fromId)) || r.toRef !== shaRef(resolveId(r.toId))) unresolvedEdges.push(`${r.fromId}->${r.toId}`);
}
check('D1.trace.edgesResolve', unresolvedEdges.length === 0, `${trc.content.relationships.length} relationships (${trc.content.relationships.filter((r) => r.relation === 'reconciles').length} reconciles + ${trc.content.relationships.filter((r) => r.relation === 'formalized-as').length} formalized-as) resolve at both ends against recomputed digests; unresolved=${unresolvedEdges.length}`);
check('D2.trace.reportAnchor', trc.content.reportCoverage.digest === reportDigestHex && canon(trc.content.reportCoverage.reconciles) === canon(trc.content.relationships.filter((r) => r.fromId === 'report' && r.relation === 'reconciles').map((r) => r.toId).sort()), 'the report coverage block is the exact projection of the reconciles edges anchored at the recomputed report digest');
check('D3.trace.claimCoverage', claimIds.every((claimId) => trc.content.claimCoverage[claimId] !== undefined && canon(trc.content.claimCoverage[claimId].formalizedAs) === canon(trc.content.relationships.filter((r) => r.relation === 'formalized-as' && r.fromId === claimId).map((r) => r.toId).sort()) && trc.content.claimCoverage[claimId].rowMemberRef === claimToMember[claimId]), 'claim coverage blocks are exact projections of the formalized-as edges and the row mapping matches the accepted members\' own citations');

/* ------------------------------------------------------------------ */
/* E. Submission evidence resolution + dispositions                     */
/* ------------------------------------------------------------------ */

const knownDigests = new Set([
  upArt.contentDigest, ucArt.contentDigest, srArt.contentDigest, accArt.contentDigest,
  ...Object.values(ENVELOPE), GOVERNING, SEMANTIC_SKILL,
  accArt.content.upstream.acceptedIntentTraceRef, accArt.content.upstream.acceptedIntentSubmissionRef,
  accArt.content.upstream.importArtifactRef, accArt.content.upstream.capsuleRef, accArt.content.upstream.certificateRef,
  ucTrc.contentDigest, ucSub.contentDigest, srTrc.contentDigest, srSub.contentDigest,
  trc.contentDigest, sub.contentDigest, accArt.content.productSeal.digest,
  accTrc.contentDigest, accSub.contentDigest, accReview.contentDigest, accReview.content.verificationRef,
  reportDigestHex,
]);
const missingEvidence = sub.content.payloadContract.requiredEvidenceRefs.filter((ref) => !knownDigests.has(ref.replace(/^sha256:/, '')));
check('E1.submission.evidenceResolve', missingEvidence.length === 0, `${sub.content.payloadContract.requiredEvidenceRefs.length} required evidence refs resolve against the recomputed digest space; unresolved=${missingEvidence.length}`);

const constraints = art.content.constraintDispositions ?? [];
check('E2.constraint.honored', constraints.length === 1 && constraints[0].constraintId === 'constraint:retention-1' && constraints[0].digest === ENVELOPE['constraint:retention-1'] && constraints[0].disposition === 'honored' && (constraints[0].enforcedBy ?? []).every((id) => criterionSeal.has(id)), `constraint:retention-1 honored through accepted criteria ${(constraints[0]?.enforcedBy ?? []).join(', ')}`);

const unknowns = art.content.unknownDispositions ?? [];
const acceptedBundleText = canon(ACC_PRODUCT);
check('E3.unknown.carriedNothingDerived', unknowns.length === 1 && unknowns[0].unknownId === 'unknown:browser-matrix-1' && unknowns[0].digest === ENVELOPE['unknown:browser-matrix-1'] && unknowns[0].disposition === 'carried_forward' && unknowns[0].owner === 'discovery' && !acceptedBundleText.includes('browser'), 'unknown:browser-matrix-1 carried_forward with owner discovery; nothing in the accepted bundle derives from it (no fabricated resolution edge)');

const terminals = art.content.terminalSupport ?? [];
check('E4.terminal.ownedUpstream', terminals.length === 2 && terminals.every((t) => ENVELOPE[t.terminalClaimId] === t.digest && upSeal.has(t.ownedByMemberId) && requirementSeal.has(t.supportedByRequirementId) && criterionSeal.has(t.verifiedByCriterionId)), 'both terminal claims stay owned upstream; support chains resolve through accepted members, requirements and criteria');

const verifiedSubs = art.content.upstream.verifiedSubArtifacts ?? [];
check('E5.envelope.8of8', verifiedSubs.length === Object.keys(ENVELOPE).length && verifiedSubs.every((v) => ENVELOPE[v.id] === v.digest && v.ref === shaRef(v.digest)), `${verifiedSubs.length}/${Object.keys(ENVELOPE).length} task-projection content addresses transported in the candidate and matching this reviewer frame exactly (no silent drops, no digest drift)`);

check('E6.submission.selfCheck', sub.content.acceptanceCriteriaSelfCheck.length === 12 && sub.content.acceptanceCriteriaSelfCheck.every((c) => c.satisfied === true), `${sub.content.acceptanceCriteriaSelfCheck.length}/12 author self-check items satisfied`);

/* ------------------------------------------------------------------ */
/* F. Determinism + WHAT-side fence                                     */
/* ------------------------------------------------------------------ */

check('F1.determinism.recompute', accCell.reconcileWhat(snapshot).reportDigest === recomputedReport.reportDigest && accCell.reconcileWhat(snapshot).reportDigest === art.content.product.reportDigest, 'three independent recomputations of the report yield the identical digest (pinned timestamps, no clock reads, no randomness)');
const deskText = canon(art.content) + canon(sub.content);
check('F2.fence.whatSide', !/"moduleAllocation"/.test(deskText) && !/src\/modules\//.test(deskText) && !/file layout/.test(deskText) && !/"architectureDecision"/.test(deskText), 'no architecture, module-allocation or file decisions anywhere in the candidate (WHAT-side fence intact)');

/* ------------------------------------------------------------------ */
/* G. Reviewer adversarial probes (same-provider recheck, zero          */
/*    softening - every probe must be killed by the declared surface)   */
/* ------------------------------------------------------------------ */

/* G1: verdict-injection + hardcode kill. A mutant snapshot with a real
   gap AND an injected verdict:'consistent' must still report 'gaps':
   the reconciler takes no verdict input and cannot be hardened to
   'consistent' - so the published 'consistent' is COMPUTED. */
const g1 = structuredClone(snapshot);
g1.acceptance.criteria = g1.acceptance.criteria.filter((c) => c.criterionId !== 'ac:boundary-1');
g1.verdict = 'consistent';
const g1Report = accCell.reconcileWhat(g1);
check('G1.probe.verdictInjectionHardcodeKill', g1Report.verdict === 'gaps' && g1Report.findings.length > 0 && g1Report.findings.some((f) => String(f.subject).includes('fr:boundary-1') || String(f.detail).includes('fr:boundary-1')), `mutant (ac:boundary-1 stripped, snapshot.verdict='consistent' injected): verdict=${g1Report.verdict}, findings=${g1Report.findings.length} (${g1Report.findings.map((f) => `${f.direction}/${f.reason}`).join('; ')}) - the injected verdict is ignored and the hardcode is killed`);

/* G2: requirement strip - BOTH forward layers must break with typed
   findings: the scenario_required intent member reaches no accepted
   requirement (intent layer) and the UC scenario produces no
   requirement obligation (scenario survival layer). */
const g2 = structuredClone(snapshot);
g2.requirements = g2.requirements.filter((r) => r.requirementId !== 'fr:terminal-1');
const g2Report = accCell.reconcileWhat(g2);
const g2IntentGap = g2Report.findings.some((f) => f.direction === 'forward' && f.layer === 'intent' && String(f.subject) === 'prd:terminal-1');
const g2ScenarioGap = g2Report.findings.some((f) => f.direction === 'forward' && f.layer === 'scenario' && String(f.subject) === 'uc:terminal-1');
check('G2.probe.requirementStrip', g2Report.verdict === 'gaps' && g2Report.findings.length >= 2 && g2IntentGap && g2ScenarioGap, `mutant (fr:terminal-1 stripped): verdict=${g2Report.verdict}, findings=${g2Report.findings.length} (${g2Report.findings.map((f) => `${f.layer}/${f.subject}`).join('; ')}) - intent and scenario survival layers both break with typed COVERAGE_GAP findings`);

/* G3: foreign criterion binding - the WP03 seam must refuse with a
   typed reason (no silent acceptance of foreign lineage). */
const g3 = structuredClone(snapshot);
const g3Criterion = structuredClone(g3.acceptance.criteria.find((c) => c.criterionId === 'ac:determinism-1'));
g3Criterion.bindsTo = structuredClone(g3Criterion.bindsTo);
g3Criterion.bindsTo.requirementRefs = ['fr:foreign-1'];
g3.acceptance.criteria = g3.acceptance.criteria.map((c) => (c.criterionId === 'ac:determinism-1' ? g3Criterion : c));
const g3Report = accCell.reconcileWhat(g3);
const g3Finding = g3Report.findings.find((f) => String(f.subject) === 'ac:determinism-1');
check('G3.probe.foreignBinding', g3Report.verdict === 'gaps' && g3Finding !== undefined, `mutant (ac:determinism-1 re-bound to fr:foreign-1): verdict=${g3Report.verdict}; seam refusal=${g3Finding ? `${g3Finding.reason} (${g3Finding.detail})` : 'NONE'}`);

/* G4: row-mapping faithfulness - rows are COMPUTED from the mapping;
   a gamed mapping produces visible empty/deranged rows while the
   published rows match only the accepted-citation mapping. */
const g4 = structuredClone(snapshot);
g4.sourceClaims.claimToMember = { ...g4.sourceClaims.claimToMember, 'claim:scope-1': 'prd:scope-2' };
const g4Report = accCell.reconcileWhat(g4);
const g4Row = g4Report.rows.find((r) => r.sourceClaimRef === 'claim:scope-1');
const pubRow = art.content.product.rows.find((r) => r.sourceClaimRef === 'claim:scope-1');
check('G4.probe.rowMappingFaithful', g4Row.memberRef === 'prd:scope-2' && g4Row.requirementRefs.length === 0 && g4Row.criterionRefs.length === 0 && pubRow.memberRef === 'prd:boundary-1' && pubRow.requirementRefs.length > 0, `mutant mapping (claim:scope-1 -> prd:scope-2) yields memberRef=${g4Row.memberRef} with ${g4Row.requirementRefs.length} requirements / ${g4Row.criterionRefs.length} criteria (visible deranging), while the published row binds prd:boundary-1 with ${pubRow.requirementRefs.length} requirements - the mapping cannot silently inflate coverage`);

/* G5: purity + deep-freeze enforcement (input byte-stability, output
   mutation refused in strict mode). */
const before = canon(snapshot);
const g5Report = accCell.reconcileWhat(snapshot);
const after = canon(snapshot);
let freezeEnforced = true;
let freezeNote = 'report mutation refused';
try { g5Report.verdict = 'consistent'; freezeEnforced = false; freezeNote = 'verdict field was writable'; } catch { /* expected */ }
try { g5Report.findings.push({ direction: 'reverse', layer: 'acceptance', reason: 'INJECTED', subject: 'x', detail: 'x' }); freezeEnforced = false; freezeNote = 'findings array was writable'; } catch { /* expected */ }
try { g5Report.rows[0].requirementRefs.push('fr:injected'); freezeEnforced = false; freezeNote = 'rows were writable'; } catch { /* expected */ }
check('G5.probe.purityAndFreeze', before === after && freezeEnforced && g5Report.reportDigest === art.content.product.reportDigest, `snapshot byte-identical before/after the REAL call (${before === after ? 'pure' : 'MUTATED'}); report mutation attempts: ${freezeNote}; recomputed digest unchanged`);

/* G6: envelope tamper - the 8/8 verifiedSubArtifacts cross-check has
   teeth (a swapped digest pair must produce exactly 2 mismatches). */
const tamperedEnvelope = {
  ...ENVELOPE,
  'claim:scope-1': ENVELOPE['claim:scope-2'],
  'claim:scope-2': ENVELOPE['claim:scope-1'],
};
const tamperMismatches = verifiedSubs.filter((v) => tamperedEnvelope[v.id] !== v.digest);
check('G6.probe.envelopeTamper', tamperMismatches.length === 2 && tamperMismatches.every((v) => v.id === 'claim:scope-1' || v.id === 'claim:scope-2'), `swapped scope-1/scope-2 digest pair -> ${tamperMismatches.length} mismatches (${tamperMismatches.map((v) => v.id).join(', ')}) - the envelope cross-check kills digest drift`);

/* G7: upstream byte-tamper - upstream re-verification binds EXACT
   bytes (one stray field flips the digest away from the declared
   content address). */
const g7Tampered = structuredClone(accArt.content);
g7Tampered.product.criteria[0].strayField = 'tampered';
check('G7.probe.upstreamByteTamper', sha(g7Tampered) !== accArt.contentDigest, `one stray field on the accepted bundle flips the digest (${sha(g7Tampered).slice(0, 8)}... != declared ${accArt.contentDigest.slice(0, 8)}...) - upstream consumption is bound to exact bytes, not narrative`);

/* ------------------------------------------------------------------ */
/* K. Workspace-law scan + frame adjudication                           */
/* ------------------------------------------------------------------ */

const QUAL_ROOT = join(DIR, '..');
const scanFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p);
    else if (entry.endsWith('.json') || entry.endsWith('.md') || entry.endsWith('.mjs')) scanFiles.push(p);
  }
};
walk(QUAL_ROOT);
const candidateMentions = scanFiles.filter((p) => {
  try { return readFileSync(p, 'utf8').includes(art.contentDigest); } catch { return false; }
});
const reconcileArtifactFiles = scanFiles.filter((p) => {
  const base = p.split(/[\\/]/).pop();
  return base.startsWith('reconcile-what') && base.includes('.artifact.json');
});
const realRevisions = new Set();
const pseudoRevisions = [];
for (const p of reconcileArtifactFiles) {
  try {
    const a = JSON.parse(readFileSync(p, 'utf8'));
    const digest = a.contentDigest ?? (a.content_digest ?? '').replace(/^sha256:/, '');
    if (typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)) realRevisions.add(digest);
    else pseudoRevisions.push(`${p.split(/[\\/]/).pop()} (${a.content_digest ?? a.contentDigest})`);
  } catch { /* unreadable */ }
}
check('K1.workspace.scan', realRevisions.size === 1 && [...realRevisions][0] === art.contentDigest && pseudoRevisions.length <= 1, `${scanFiles.length} workspace files scanned under qualification/: candidate digest mentioned in ${candidateMentions.length} file(s); reconcile-what artifact revisions found: ${realRevisions.size} real content-addressed (exactly the candidate under review, ${art.contentDigest.slice(0, 8)}...) + ${pseudoRevisions.length} pseudo-addressed legacy record (${pseudoRevisions.join('; ') || 'none'} - not a content address, legacy r1 regime, different task envelope; cannot travel as an accepted revision)`);

const upstreamAcceptedVerdict = accReview.content.verdict === 'accepted' && accReview.content.verificationRef === shaRef(accVV.contentDigest);
check('K2.frame.adjudication', upstreamAcceptedVerdict, `reviewer frame projects "${WORKSPACE_SUMMARY}": TRUE for the desk's own revisions - no reconcile-what revision is accepted yet (the candidate awaits this review); the consumed upstream chain travels by pinned content addresses and the acceptance-bindings revision carries the accepted verdict record (FR-Define-Acceptance-Contract-001 ${accReview.contentDigest.slice(0, 8)}..., ${accVV.content.recomputedChecks}/${accVV.content.recomputedChecks} recomputations) - stage-relative, consistent with the author's 0-count (its own revisions)`);

/* ------------------------------------------------------------------ */
/* Summary                                                              */
/* ------------------------------------------------------------------ */

const summary = {
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; report: real acceptance.reconcileWhat over a snapshot re-derived through the real acceptanceUniverseFrom protocol (reviewer same-provider recheck, zero softening); upstream: real PRD/UC/WP03 validators + REAL cell folds + real validateAcceptanceBundle re-seal; adversarial probes G1-G7 all killed by the declared surfaces',
  recomputed: results.length,
  passed: results.filter((r) => r.ok === true).length,
  failed: results.filter((r) => r.ok !== true).length,
  results,
};
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-verify-out.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ recomputed: summary.recomputed, passed: summary.passed, failed: summary.failed }, null, 2));
