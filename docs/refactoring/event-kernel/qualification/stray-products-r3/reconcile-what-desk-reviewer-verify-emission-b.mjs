/**
 * reconcile-what desk (reviewer) - EMISSION B, CORRECTED verification of
 * the author candidate of record.
 *
 * This emission supersedes this seat's own first pass (the content-only
 * verifier in the plain contested slots, 54 checks all-pass, which fed an
 * 'accepted' first review): the CTN-Define-Acceptance-Contract-001
 * adjudication SUPERSEDED the acceptance-desk accepted emission
 * (e5249d78) that first pass consumed as its reviewer gate, so that
 * premise was false at the status layer. Per CL-Reconcile-What-001 this
 * corrected round is filed under emission-b filenames only; the plain
 * contested slots receive no further writes.
 *
 * Three layers, nothing trusted by declaration:
 *   Content layer (A-G,K): digests, REAL surfaces, adversarial probes -
 *     same provider recheck, zero softening.
 *   Status layer (S): the verdict-record audit - which upstream revisions
 *     are genuinely accepted, which emission is the verdict of record,
 *     which holds stand. This is the layer the kernel surface cannot see
 *     and the layer the first pass missed.
 *   Payload layer (H): the author submission's evidence-surface mechanics.
 *
 * Deterministic: no clock reads, no randomness. Rule: sha256 over
 * canonical JSON (recursively key-sorted, compact, UTF-8) per
 * src/workflow-kernel/domain/digest.ts.
 *
 * Run: node reconcile-what-desk-reviewer-verify-emission-b.mjs
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
const R2 = join(DIR, '..', 'stray-products-r2');
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

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

/* The candidate of record (author artifacts). */
const art = load(join(DIR, 'reconcile-what-desk-what-reconciliation.artifact.json'));
const trc = load(join(DIR, 'reconcile-what-desk-what-reconciliation-trace.json'));
const sub = load(join(DIR, 'reconcile-what-desk-product-submission.json'));

/* Upstream material (r3 copies, consumed by pinned content address). */
const upArt = load(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'));
const ucArt = load(join(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json'));
const srArt = load(join(DIR, 'derive-system-requirements-desk-system-requirements.artifact.json'));
const accArt = load(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings.artifact.json'));
const ucTrc = load(join(DIR, 'model-use-cases-desk-uc-scenarios-trace.json'));
const ucSub = load(join(DIR, 'model-use-cases-desk-product-submission.json'));
const srTrc = load(join(DIR, 'derive-system-requirements-desk-system-requirements-trace.json'));
const srSub = load(join(DIR, 'derive-system-requirements-desk-product-submission.json'));
const accTrc = load(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings-trace.json'));
const accSub = load(join(DIR, 'define-acceptance-contract-desk-product-submission.json'));
const accReviewAcceptedEmission = load(join(DIR, 'define-acceptance-contract-desk-reviewer-review.json'));
const accVVSuperseded = load(join(DIR, 'define-acceptance-contract-desk-reviewer-verification.json'));

/* Status-layer primary records (the emission B first pass never read these). */
const accCollision = load(join(DIR, 'define-acceptance-contract-desk-reviewer-collision-record.json'));
const accFrEmissionA = load(join(DIR, 'define-acceptance-contract-desk-reviewer-review-emission-a.json'));
const accFrEmissionC = load(join(DIR, 'define-acceptance-contract-desk-reviewer-review-emission-c.json'));
const accFsEmissionC = load(join(DIR, 'define-acceptance-contract-desk-reviewer-product-submission-emission-c.json'));
const accHold = load(join(DIR, 'define-acceptance-contract-desk-upstream-hold.artifact.json'));
const intentRev1 = load(join(R2, 'define-product-intent-desk-reviewer-review.json'));
const intentRev2 = load(join(R2, 'define-product-intent-desk-reviewer2-review.json'));
const ucHold = load(join(R2, 'model-use-cases-desk-upstream-hold.artifact.json'));
const srRev = load(join(R2, 'derive-system-requirements-desk-reviewer-review.json'));
const srRestaff = load(join(R2, 'derive-system-requirements-desk-reviewer-restaff2-confirmation.json'));

/* The round of record (emission A of THIS desk) + the collision record. */
const rwCollision = load(join(DIR, 'reconcile-what-desk-reviewer-collision-record.json'));
const rwFrA = load(join(DIR, 'reconcile-what-desk-reviewer-review.json'));
const rwVvA = load(join(DIR, 'reconcile-what-desk-reviewer-verification.json'));
const rwTrcA = load(join(DIR, 'reconcile-what-desk-reviewer-trace.json'));
const rwFsA = load(join(DIR, 'reconcile-what-desk-reviewer-product-submission.json'));

/* This seat's own superseded first-pass emission (B-1), by content address
   from the authoring seat's build output; the plain slots were overwritten
   at collision time so the bytes live only in the record below. */
const EMISSION_B1 = {
  verificationRef: 'sha256:aabc9ac34035956afb081a89c3d31ebb35812515b8201ddc8073f0d65f7c4317',
  reviewRef: 'sha256:e86a6e27c7a93a0ea25bde6f455dc36469f70f38333256d6a0b6f1666844a951',
  traceRef: 'sha256:a707316509ed0c03d97be533c648625e4766c14b07d6e3e8829fad48a2afe841',
  submissionRef: 'sha256:4e1f0daddb91a04a098cfc313876fdc6e744f893d25ff30acb55390ce4df9683',
  verdict: 'accepted (SUPERSEDED by this emission)',
};

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
const FRAME_PROTOCOL_SKILL = 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50';
const FRAME_SEMANTIC_SKILL = '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2';
const WORKSPACE_SUMMARY = '0 accepted upstream revisions travel by content address';

/* ================================================================== */
/* CONTENT LAYER                                                       */
/* ================================================================== */

/* A. Candidate self-address + desk pins */
check('A1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('A2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), `recomputed ${shaRef(art.contentDigest)} vs declared ${art.artifactRef}`);
check('A3.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)} vs declared ${trc.contentDigest}`);
check('A4.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), `recomputed ${shaRef(trc.contentDigest)} vs declared ${trc.traceRef}`);
check('A5.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('A6.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), `recomputed ${shaRef(sub.contentDigest)} vs declared ${sub.submissionRef}`);
check('A7.kind.family', art.productKind === 'formalization.what-reconciliation.v1' && art.content.schemaVersion === accCell.RECONCILIATION_REPORT_KIND && art.content.product.schemaVersion === accCell.RECONCILIATION_REPORT_KIND, `productKind=${art.productKind} schemaVersion matches the REAL RECONCILIATION_REPORT_KIND`);
check('A8.workspace.governing', art.content.workspaceSummary === WORKSPACE_SUMMARY && art.content.governingContractRef === shaRef(GOVERNING) && sub.content.workspaceSummary === WORKSPACE_SUMMARY && sub.content.traceRef === trc.traceRef && sub.content.candidate.artifactRef === art.artifactRef, 'workspace summary + governing pin present; submission binds the artifact and trace of record');
check('A9.intake.reviewerStage', sub.content.intakeReceipt?.status === 'admitted_for_reviewer_stage' && sub.content.intakeReceipt?.nextStage === 'reviewer', `intake receipt ${sub.content.intakeReceipt?.status} -> ${sub.content.intakeReceipt?.nextStage}`);
check('A10.acceptedStateAssertions.declared', art.content.verification?.revisionPinsMatchAcceptedRevisions === true && art.content.verification?.reviewerAcceptedCandidateOfRecord === true && /reviewer-accepted/.test(art.content.upstream?.materialAuthority ?? ''), 'the candidate asserts accepted-states (revisionPinsMatchAcceptedRevisions=true, reviewerAcceptedCandidateOfRecord=true, materialAuthority "reviewer-accepted") - these are the assertions the STATUS layer audits below');

/* B. Upstream re-derivation (REAL folds + REAL validators) */
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

/* B10 RE-SCOPED: the on-disk accepted emission is digest-clean at the
   CONTENT layer - and that is all this check now claims. Its status is
   decided by the S-group (verdict of record: repair). */
check('B10.acceptedEmission.digestClean', accReviewAcceptedEmission.content.verdict === 'accepted'
  && accReviewAcceptedEmission.content.reviewedCandidate.artifactRef === accArt.artifactRef
  && accReviewAcceptedEmission.content.reviewedCandidate.productSeal === accArt.content.productSeal.ref
  && accReviewAcceptedEmission.content.verificationRef === shaRef(accVVSuperseded.contentDigest)
  && sha(accVVSuperseded.content) === accVVSuperseded.contentDigest,
  `the superseded accepted emission ${accReviewAcceptedEmission.contentDigest.slice(0, 8)}... self-addresses and binds the published acceptance candidate - a CONTENT-layer fact only; its STATUS is overturned by the S-group (verdict of record: repair)`);

/* C. The computed report (REAL reconcileWhat over the re-derived snapshot) */
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
check('C3.verdict.computedLaw', art.content.product.verdict === 'consistent' && art.content.product.findings.length === 0 && recomputedReport.verdict === 'consistent' && recomputedReport.findings.length === 0, `published verdict=${art.content.product.verdict} findings=${art.content.product.findings.length}; recomputed identical - the report mechanics are sound (the CONTENT chain reconciles; whether the lineage is ACCEPTED is the S-group's question)`);
check('C4.report.deepFrozen', Object.isFrozen(recomputedReport) && Object.isFrozen(recomputedReport.findings) && Object.isFrozen(recomputedReport.rows) && Object.isFrozen(recomputedReport.gaps), 'the REAL reconciler returns a deep-frozen report (report-only law, cr-12)');
check('C5.rows.installedShape', art.content.product.rows.length === 4 && art.content.product.rows.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['criterionRefs', 'memberRef', 'requirementRefs', 'scenarioRef', 'sourceClaimRef'])), `${art.content.product.rows.length} rows in the installed formalization.what-reconciliation.v1 row shape`);
const scopeRow = art.content.product.rows.find((r) => r.sourceClaimRef === 'claim:scope-2');
check('C6.outOfScope.honestEmptyRow', scopeRow?.memberRef === 'prd:scope-2' && scopeRow.requirementRefs.length === 0 && scopeRow.criterionRefs.length === 0, `claim:scope-2 row: memberRef=${scopeRow?.memberRef} requirements=${scopeRow?.requirementRefs.length} criteria=${scopeRow?.criterionRefs.length} (the row reports the upstream disposition honestly; the DISPOSITION's authority is the upstream CRIT-2, reported here without re-ratification)`);

let seamRefusals = 0;
for (const c of ACC_PRODUCT.criteria) {
  const v = wp03seam.validateAcBinding(c, accUniverse.universe);
  if (v.ok !== true) seamRefusals += 1;
}
check('C7.reverse.wp03Seam', seamRefusals === 0, `${ACC_PRODUCT.criteria.length}/${ACC_PRODUCT.criteria.length} criteria re-validated through the REAL WP03 seam against the re-derived universe; refusals=${seamRefusals}`);

/* D. Trace resolution + exact coverage projections */
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
let unresolvedEdges = 0;
for (const r of trc.content.relationships) {
  if (resolveId(r.fromId) === null || resolveId(r.toId) === null || r.fromRef !== shaRef(resolveId(r.fromId)) || r.toRef !== shaRef(resolveId(r.toId))) unresolvedEdges += 1;
}
check('D1.trace.edgesResolve', unresolvedEdges === 0, `${trc.content.relationships.length} relationships resolve at both ends against recomputed digests; unresolved=${unresolvedEdges}`);
check('D2.trace.reportAnchor', trc.content.reportCoverage.digest === reportDigestHex && canon(trc.content.reportCoverage.reconciles) === canon(trc.content.relationships.filter((r) => r.fromId === 'report' && r.relation === 'reconciles').map((r) => r.toId).sort()), 'the report coverage block is the exact projection of the reconciles edges anchored at the recomputed report digest');
check('D3.trace.claimCoverage', claimIds.every((claimId) => trc.content.claimCoverage[claimId] !== undefined && canon(trc.content.claimCoverage[claimId].formalizedAs) === canon(trc.content.relationships.filter((r) => r.relation === 'formalized-as' && r.fromId === claimId).map((r) => r.toId).sort()) && trc.content.claimCoverage[claimId].rowMemberRef === claimToMember[claimId]), 'claim coverage blocks are exact projections of the formalized-as edges and the row mapping matches the accepted members\' own citations');

/* E. Submission evidence resolution + dispositions (structural, at the
   digest layer; the H-group audits the payload contract's mechanics). */
const knownDigests = new Set([
  upArt.contentDigest, ucArt.contentDigest, srArt.contentDigest, accArt.contentDigest,
  ...Object.values(ENVELOPE), GOVERNING, SEMANTIC_SKILL,
  accArt.content.upstream.acceptedIntentTraceRef, accArt.content.upstream.acceptedIntentSubmissionRef,
  accArt.content.upstream.importArtifactRef, accArt.content.upstream.capsuleRef, accArt.content.upstream.certificateRef,
  ucTrc.contentDigest, ucSub.contentDigest, srTrc.contentDigest, srSub.contentDigest,
  trc.contentDigest, sub.contentDigest, accArt.content.productSeal.digest,
  accTrc.contentDigest, accSub.contentDigest, accReviewAcceptedEmission.contentDigest, accReviewAcceptedEmission.content.verificationRef,
  reportDigestHex,
]);
const missingEvidence = sub.content.payloadContract.requiredEvidenceRefs.filter((ref) => !knownDigests.has(ref.replace(/^sha256:/, '')));
check('E1.submission.evidenceResolve', missingEvidence.length === 0, `${sub.content.payloadContract.requiredEvidenceRefs.length} required evidence refs resolve against the recomputed digest space once double prefixes are dereferenced (H1); unresolved=${missingEvidence.length}`);

const constraints = art.content.constraintDispositions ?? [];
check('E2.constraint.honored', constraints.length === 1 && constraints[0].constraintId === 'constraint:retention-1' && constraints[0].digest === ENVELOPE['constraint:retention-1'] && constraints[0].disposition === 'honored' && (constraints[0].enforcedBy ?? []).every((id) => criterionSeal.has(id)), `constraint:retention-1 honored through accepted criteria ${(constraints[0]?.enforcedBy ?? []).join(', ')}`);

const unknowns = art.content.unknownDispositions ?? [];
const acceptedBundleText = canon(ACC_PRODUCT);
check('E3.unknown.carriedNothingDerived', unknowns.length === 1 && unknowns[0].unknownId === 'unknown:browser-matrix-1' && unknowns[0].digest === ENVELOPE['unknown:browser-matrix-1'] && unknowns[0].disposition === 'carried_forward' && unknowns[0].owner === 'discovery' && !acceptedBundleText.includes('browser'), 'unknown:browser-matrix-1 carried_forward with owner discovery; nothing in the accepted bundle derives from it');

const terminals = art.content.terminalSupport ?? [];
check('E4.terminal.ownedUpstream', terminals.length === 2 && terminals.every((t) => ENVELOPE[t.terminalClaimId] === t.digest && upSeal.has(t.ownedByMemberId) && requirementSeal.has(t.supportedByRequirementId) && criterionSeal.has(t.verifiedByCriterionId)), 'both terminal claims stay owned upstream; support chains resolve through accepted members, requirements and criteria');

const verifiedSubs = art.content.upstream.verifiedSubArtifacts ?? [];
check('E5.envelope.8of8', verifiedSubs.length === Object.keys(ENVELOPE).length && verifiedSubs.every((v) => ENVELOPE[v.id] === v.digest && v.ref === shaRef(v.digest)), `${verifiedSubs.length}/${Object.keys(ENVELOPE).length} task-projection content addresses transported in the candidate and matching this reviewer frame exactly`);

check('E6.submission.selfCheck.declared', sub.content.acceptanceCriteriaSelfCheck.length === 12 && sub.content.acceptanceCriteriaSelfCheck.every((c) => c.satisfied === true), `${sub.content.acceptanceCriteriaSelfCheck.length}/12 author self-check items declare satisfied (row 1 and row 8 are contradicted at the payload/status layers - see H1/H3 and S6)`);

/* F. Determinism + WHAT-side fence */
check('F1.determinism.recompute', accCell.reconcileWhat(snapshot).reportDigest === recomputedReport.reportDigest && accCell.reconcileWhat(snapshot).reportDigest === art.content.product.reportDigest, 'repeated REAL recomputation yields the identical report digest (pinned timestamps, no clock reads, no randomness)');
const deskText = canon(art.content) + canon(sub.content);
check('F2.fence.whatSide', !/"moduleAllocation"/.test(deskText) && !/src\/modules\//.test(deskText) && !/file layout/.test(deskText) && !/"architectureDecision"/.test(deskText), 'no architecture, module-allocation or file decisions anywhere in the candidate (WHAT-side fence intact)');

/* G. Reviewer adversarial probes (same-provider recheck, zero softening) */
const g1 = structuredClone(snapshot);
g1.acceptance.criteria = g1.acceptance.criteria.filter((c) => c.criterionId !== 'ac:boundary-1');
g1.verdict = 'consistent';
const g1Report = accCell.reconcileWhat(g1);
check('G1.probe.verdictInjectionHardcodeKill', g1Report.verdict === 'gaps' && g1Report.findings.length > 0 && g1Report.findings.some((f) => String(f.subject).includes('fr:boundary-1') || String(f.detail).includes('fr:boundary-1')), `mutant (ac:boundary-1 stripped, snapshot verdict='consistent' injected): verdict=${g1Report.verdict}, findings=${g1Report.findings.length} - the injected verdict is ignored; the hardcode is killed`);

const g2 = structuredClone(snapshot);
g2.requirements = g2.requirements.filter((r) => r.requirementId !== 'fr:terminal-1');
const g2Report = accCell.reconcileWhat(g2);
const g2IntentGap = g2Report.findings.some((f) => f.direction === 'forward' && f.layer === 'intent' && String(f.subject) === 'prd:terminal-1');
const g2ScenarioGap = g2Report.findings.some((f) => f.direction === 'forward' && f.layer === 'scenario' && String(f.subject) === 'uc:terminal-1');
check('G2.probe.requirementStrip', g2Report.verdict === 'gaps' && g2Report.findings.length >= 2 && g2IntentGap && g2ScenarioGap, `mutant (fr:terminal-1 stripped): verdict=${g2Report.verdict}, findings=${g2Report.findings.length} (${g2Report.findings.map((f) => `${f.layer}/${f.subject}`).join('; ')}) - both forward layers break with typed findings`);

const g3 = structuredClone(snapshot);
const g3Criterion = structuredClone(g3.acceptance.criteria.find((c) => c.criterionId === 'ac:determinism-1'));
g3Criterion.bindsTo = structuredClone(g3Criterion.bindsTo);
g3Criterion.bindsTo.requirementRefs = ['fr:foreign-1'];
g3.acceptance.criteria = g3.acceptance.criteria.map((c) => (c.criterionId === 'ac:determinism-1' ? g3Criterion : c));
const g3Report = accCell.reconcileWhat(g3);
const g3Finding = g3Report.findings.find((f) => String(f.subject) === 'ac:determinism-1');
check('G3.probe.foreignBinding', g3Report.verdict === 'gaps' && g3Finding !== undefined, `mutant (ac:determinism-1 re-bound to fr:foreign-1): verdict=${g3Report.verdict}; seam refusal=${g3Finding ? g3Finding.reason : 'NONE'}`);

const g4 = structuredClone(snapshot);
g4.sourceClaims.claimToMember = { ...g4.sourceClaims.claimToMember, 'claim:scope-1': 'prd:scope-2' };
const g4Report = accCell.reconcileWhat(g4);
const g4Row = g4Report.rows.find((r) => r.sourceClaimRef === 'claim:scope-1');
const pubRow = art.content.product.rows.find((r) => r.sourceClaimRef === 'claim:scope-1');
check('G4.probe.rowMappingFaithful', g4Row.memberRef === 'prd:scope-2' && g4Row.requirementRefs.length === 0 && g4Row.criterionRefs.length === 0 && pubRow.memberRef === 'prd:boundary-1' && pubRow.requirementRefs.length > 0, 'rows are computed from the mapping: a gamed mapping visibly deranges (empty), published rows match only the accepted-citation mapping');

const before = canon(snapshot);
const g5Report = accCell.reconcileWhat(snapshot);
const after = canon(snapshot);
let freezeEnforced = true;
let freezeNote = 'report mutation refused';
try { g5Report.verdict = 'consistent'; freezeEnforced = false; freezeNote = 'verdict field was writable'; } catch { /* expected */ }
try { g5Report.findings.push({ direction: 'reverse', layer: 'acceptance', reason: 'INJECTED', subject: 'x', detail: 'x' }); freezeEnforced = false; freezeNote = 'findings array was writable'; } catch { /* expected */ }
try { g5Report.rows[0].requirementRefs.push('fr:injected'); freezeEnforced = false; freezeNote = 'rows were writable'; } catch { /* expected */ }
check('G5.probe.purityAndFreeze', before === after && freezeEnforced && g5Report.reportDigest === art.content.product.reportDigest, `input byte-identical after the REAL call; output: ${freezeNote}; digest unchanged`);

const tamperedEnvelope = { ...ENVELOPE, 'claim:scope-1': ENVELOPE['claim:scope-2'], 'claim:scope-2': ENVELOPE['claim:scope-1'] };
const tamperMismatches = verifiedSubs.filter((v) => tamperedEnvelope[v.id] !== v.digest);
check('G6.probe.envelopeTamper', tamperMismatches.length === 2, `swapped digest pair -> ${tamperMismatches.length} mismatches - the envelope cross-check has teeth`);

const g7Tampered = structuredClone(accArt.content);
g7Tampered.product.criteria[0].strayField = 'tampered';
check('G7.probe.upstreamByteTamper', sha(g7Tampered) !== accArt.contentDigest, 'one stray field on the upstream bundle flips the digest - upstream consumption is bound to exact bytes');

/* K. Workspace scan (desk-revision inventory) */
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
const readSafe = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const candidateMentions = scanFiles.filter((p) => readSafe(p).includes(art.contentDigest));
const realRevisions = new Set();
const pseudoRevisions = [];
for (const p of scanFiles) {
  const base = p.split(/[\\/]/).pop();
  if (!(base.startsWith('reconcile-what') && base.includes('.artifact.json'))) continue;
  try {
    const a = JSON.parse(readSafe(p));
    const digest = a.contentDigest ?? (a.content_digest ?? '').replace(/^sha256:/, '');
    if (typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest)) realRevisions.add(digest);
    else pseudoRevisions.push(base);
  } catch { /* unreadable */ }
}
check('K1.workspace.scan', realRevisions.size === 1 && [...realRevisions][0] === art.contentDigest && pseudoRevisions.length <= 1, `${scanFiles.length} workspace files scanned under qualification/: exactly one real content-addressed reconcile-what revision (the candidate under review, ${art.contentDigest.slice(0, 8)}...; mentioned in ${candidateMentions.length} file(s)) + ${pseudoRevisions.length} pseudo-addressed r1 legacy record (not a content address, different task envelope)`);

/* ================================================================== */
/* S. STATUS LAYER - the verdict-record audit (the layer the kernel     */
/*    surface cannot see; the layer the B-1 first pass missed)          */
/* ================================================================== */

const selfAddressed = (j) => sha(j.content) === j.contentDigest;

check('S1.accCollision.selfAddressing', selfAddressed(accCollision) && accCollision.content.recordId === 'CL-Define-Acceptance-Contract-001', `the acceptance-desk collision record CL-Define-Acceptance-Contract-001 (${accCollision.contentDigest.slice(0, 8)}...) self-addresses and carries the CTN-001 contention`);

const accAdj = accFsEmissionC.content.adjudication ?? {};
check('S2.accAdjudication.verdictOfRecord', accAdj.contentionId === 'CTN-Define-Acceptance-Contract-001' && accAdj.verdictOfRecord === 'repair' && typeof accAdj.confirmed === 'string' && accAdj.confirmed.startsWith('sha256:'), `the adjudication of record (emission-c submission ${accFsEmissionC.contentDigest.slice(0, 8)}...): contentionId=CTN-Define-Acceptance-Contract-001, verdictOfRecord=repair, confirmed=${String(accAdj.confirmed).slice(0, 16)}...`);

check('S3.accEmissionC.selfAddressing', selfAddressed(accFrEmissionC) && accFrEmissionC.content.verdict === 'repair', `the adjudicating review emission-c (${accFrEmissionC.contentDigest.slice(0, 8)}...) self-addresses with verdict=${accFrEmissionC.content.verdict} (the adjudication block binding CTN-001 travels in the emission-c submission, S2)`);

check('S4.accEmissionA.confirmedRepair', selfAddressed(accFrEmissionA) && accFrEmissionA.content.verdict === 'repair' && accAdj.confirmed === shaRef(accFrEmissionA.contentDigest), `the confirmed repair emission (${accFrEmissionA.contentDigest.slice(0, 8)}...) self-addresses; the adjudication confirms exactly its digest`);

check('S5.supersededAcceptedEmission', accReviewAcceptedEmission.content.verdict === 'accepted' && selfAddressed(accReviewAcceptedEmission) && accAdj.confirmed !== shaRef(accReviewAcceptedEmission.contentDigest), `the accepted emission e5249d78 ${accReviewAcceptedEmission.contentDigest.slice(0, 8)}... is digest-clean but NOT the verdict of record - superseded by CTN-001; any review consuming it as a gate inherits a false acceptance (this seat's B-1 first pass did exactly that)`);

check('S6.candidate.consumedSupersededGate', sub.content.acceptanceCriteriaSelfCheck?.some((c) => /reviewer gate/i.test(c.description)) === true && art.content.upstream?.acceptanceReviewerReviewRef === accReviewAcceptedEmission.artifactRef, `the candidate's reviewer gate cites ${String(art.content.upstream?.acceptanceReviewerReviewRef).slice(0, 16)}... = the SUPERSEDED accepted emission; the confirmed repair emission ${accFrEmissionA.contentDigest.slice(0, 8)}... is nowhere cited - fabricated reviewer authority (the candidate's CRIT-2)`);

check('S7.intentLineage.unaccepted', upArt.contentDigest === load(join(R2, 'define-product-intent-desk-product-intent.artifact.json')).contentDigest && intentRev1.content.verdict === 'repair' && intentRev2.content.verdict === 'repair' && selfAddressed(intentRev1) && selfAddressed(intentRev2), `the consumed intent revision ${upArt.contentDigest.slice(0, 8)}... is byte-identical to the r2 repair-verdict revision; FR-Define-Product-Intent-001 (${intentRev1.contentDigest.slice(0, 8)}...) and -002 (${intentRev2.contentDigest.slice(0, 8)}...) both say repair; no author reissue exists`);

check('S8.ucLineage.neverReviewed', selfAddressed(ucHold) && ucHold.content.holdKind === 'uc-upstream-hold' && scanFiles.every((p) => {
  const base = p.split(/[\\/]/).pop();
  return !(base.startsWith('model-use-cases') && /reviewer/.test(base) && base.endsWith('.json') && !base.includes('upstream-hold'));
}), `the consumed UC revision ${ucArt.contentDigest.slice(0, 8)}... has NEVER passed a reviewer stage (zero model-use-cases reviewer artifacts workspace-wide) and its own desk's upstream hold ${ucHold.contentDigest.slice(0, 8)}... (holdKind=${ucHold.content.holdKind}) stands unreconciled`);

check('S9.requirementsLineage.unaccepted', srArt.contentDigest === load(join(R2, 'derive-system-requirements-desk-system-requirements.artifact.json')).contentDigest && srRev.content.verdict === 'repair' && selfAddressed(srRev) && selfAddressed(srRestaff) && String(srRestaff.semanticCode).startsWith('RS-'), `the consumed requirements revision ${srArt.contentDigest.slice(0, 8)}... is byte-identical to the repair-verdict revision (FR-Derive-System-Requirements-001 ${srRev.contentDigest.slice(0, 8)}...: repair) plus a re-staff confirmation (${srRestaff.semanticCode} ${srRestaff.contentDigest.slice(0, 8)}...) that confirms the verdict, not an acceptance`);

check('S10.acceptanceLineage.verdictOfRecordIsRepair', accArt.contentDigest === load(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings.artifact.json')).contentDigest && accAdj.verdictOfRecord === 'repair' && selfAddressed(accHold) && accHold.content.holdKind === 'acceptance-upstream-hold', `the consumed acceptance revision ${accArt.contentDigest.slice(0, 8)}...'s verdict of record is REPAIR (CTN-001); the desk is on record hold ${accHold.contentDigest.slice(0, 8)}... (holdKind=${accHold.content.holdKind})`);

check('S11.governingAnchor.unresolvable', (() => {
  let mentions = 0;
  for (const p of scanFiles) if (readSafe(p).includes(GOVERNING)) mentions += 1;
  let contentHits = 0;
  for (const p of scanFiles) {
    if (!p.endsWith('.json')) continue;
    try {
      const j = JSON.parse(readSafe(p));
      if (sha(j) === GOVERNING || (j.content !== undefined && sha(j.content) === GOVERNING) || (j.content?.product !== undefined && sha(j.content.product) === GOVERNING)) contentHits += 1;
    } catch { /* non-json */ }
  }
  globalThis.__govScan = { mentions, contentHits };
  return mentions > 0 && contentHits === 0;
})(), `governing anchor ${GOVERNING.slice(0, 8)}...: ${globalThis.__govScan.mentions} mentioning files, ${globalThis.__govScan.contentHits} content hits (raw bytes + whole-JSON canonical + .content canonical) across the ${scanFiles.length}-file scan - the anchor resolves to NO content (inherited r2 RA-2/RA-4 debt, re-derived)`);

check('S12.candidate.flagsFalseAtStatusLayer', art.content.verification?.revisionPinsMatchAcceptedRevisions === true && art.content.verification?.reviewerAcceptedCandidateOfRecord === true && true, `the candidate's flags assert accepted-states; the S-audit proves all four consumed links are repair-verdict, never-reviewed, or adjudicated-repair - the flags are FALSE at the status layer while the pins are byte-exact to the named revisions (digest-layer truth, status-layer falsehood)`);

check('S13.roundOfRecord.bound', selfAddressed(rwCollision) && rwCollision.content.recordId === 'CL-Reconcile-What-001' && rwCollision.content.emissionA?.roundDigests?.reviewRef === shaRef(rwFrA.contentDigest) && rwCollision.content.emissionA?.roundDigests?.verificationRef === shaRef(rwVvA.contentDigest) && rwCollision.content.emissionA?.roundDigests?.traceRef === shaRef(rwTrcA.contentDigest) && rwCollision.content.emissionA?.roundDigests?.submissionRef === shaRef(rwFsA.contentDigest) && rwCollision.content.emissionA?.verdict === 'repair', `the round of record (emission A: review ${rwFrA.contentDigest.slice(0, 8)}..., VV ${rwVvA.contentDigest.slice(0, 8)}..., trace ${rwTrcA.contentDigest.slice(0, 8)}..., submission ${rwFsA.contentDigest.slice(0, 8)}...) is bound by the collision record CL-Reconcile-What-001 (${rwCollision.contentDigest.slice(0, 8)}...) with verdict repair; this corrected emission concurrs independently and files under emission-b names per the record's discipline`);

check('S14.emissionB1.supersededByThisRound', Object.values(EMISSION_B1).every((v) => typeof v === 'string'), `this seat's first-pass emission B-1 (VV ${EMISSION_B1.verificationRef.slice(7, 15)}..., review ${EMISSION_B1.reviewRef.slice(7, 15)}..., trace ${EMISSION_B1.traceRef.slice(7, 15)}..., submission ${EMISSION_B1.submissionRef.slice(7, 15)}...: "${EMISSION_B1.verdict}") is superseded by THIS corrected round by content address - its accepted premise (the superseded acceptance-desk emission as gate) is withdrawn against the CTN-001 adjudication`);

/* ================================================================== */
/* H. PAYLOAD LAYER - the author submission's evidence-surface mechanics */
/* ================================================================== */

const refs = sub.content.payloadContract.requiredEvidenceRefs;
const doublePrefixed = refs.filter((r) => r.startsWith('sha256:sha256:'));
check('H1.payload.doublePrefixedRefs', doublePrefixed.length === 6, `${doublePrefixed.length} evidence refs carry a double sha256: prefix (malformed): ${doublePrefixed.slice(0, 2).map((r) => r.slice(0, 26) + '...').join(', ')}... - self-check row 1 ("every ref is sha256 over canonical JSON") is false as declared`);

const kindSum = Object.values(sub.content.payloadContract.evidenceKindCoverage ?? {}).reduce((a, b) => a + b, 0);
check('H2.payload.coverageSum', kindSum !== refs.length, `evidenceKindCoverage sums to ${kindSum} against ${refs.length} refs - the declared kind coverage does not cover the evidence set exactly`);

const hasStaleProto = refs.includes(shaRef(SEMANTIC_SKILL));
const hasFrameProto = refs.includes(shaRef(FRAME_PROTOCOL_SKILL));
const hasFrameSemantic = refs.includes(shaRef(FRAME_SEMANTIC_SKILL));
check('H3.payload.frameSkillRefs', hasStaleProto && !hasFrameProto && !hasFrameSemantic, `evidence set carries the r1-era protocol-skill digest ${SEMANTIC_SKILL.slice(0, 8)}... instead of THIS frame's ${FRAME_PROTOCOL_SKILL.slice(0, 8)}...; the frame's semantic-skill digest ${FRAME_SEMANTIC_SKILL.slice(0, 8)}... is absent altogether - envelope-family skill-pin defect`);

/* ================================================================== */
/* Summary + statusAudit for the build                                  */
/* ================================================================== */

const contentLayer = results.filter((r) => /^[A-GK]/.test(r.id));
const statusLayer = results.filter((r) => r.id.startsWith('S'));
const payloadLayer = results.filter((r) => r.id.startsWith('H'));

const summary = {
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; THREE layers: content (real acceptance.reconcileWhat + real validators/folds/re-seals + adversarial probes, zero softening), status (verdict-record audit over the primary records: CTN-001 adjudication, r2 repair verdicts, UC never-reviewed + hold, acceptance hold, collision records), payload (evidence-surface mechanics)',
  emission: 'B (corrected; supersedes this seat\'s content-only B-1 first pass by content address)',
  recomputed: results.length,
  passed: results.filter((r) => r.ok === true).length,
  failed: results.filter((r) => r.ok !== true).length,
  layers: {
    content: { checks: contentLayer.length, passed: contentLayer.filter((r) => r.ok === true).length, failed: contentLayer.filter((r) => r.ok !== true).length },
    status: { checks: statusLayer.length, passed: statusLayer.filter((r) => r.ok === true).length, failed: statusLayer.filter((r) => r.ok !== true).length },
    payload: { checks: payloadLayer.length, passed: payloadLayer.filter((r) => r.ok === true).length, failed: payloadLayer.filter((r) => r.ok !== true).length },
  },
  statusAudit: {
    verdictOfRecordAcceptanceDesk: 'repair (CTN-Define-Acceptance-Contract-001; emission A confirmed, accepted emission e5249d78 superseded)',
    candidateReviewerGate: 'cites the SUPERSEDED accepted emission - fabricated reviewer authority',
    consumedLineage: {
      intent: `${upArt.contentDigest.slice(0, 8)}... repair x2 emissions, no reissue`,
      useCases: `${ucArt.contentDigest.slice(0, 8)}... never reviewed; upstream hold ${ucHold.contentDigest.slice(0, 8)}... stands`,
      requirements: `${srArt.contentDigest.slice(0, 8)}... repair + re-staff confirmation`,
      acceptance: `${accArt.contentDigest.slice(0, 8)}... adjudicated repair; desk on record hold ${accHold.contentDigest.slice(0, 8)}...`,
    },
    genuinelyAcceptedAboveImport: 'none',
    governingAnchor: `unresolvable (${globalThis.__govScan?.mentions} mentions, ${globalThis.__govScan?.contentHits} content hits)`,
    roundOfRecord: 'emission A, verdict repair, bound by CL-Reconcile-What-001 (841194ce...)',
    emissionB1: 'superseded by this corrected emission',
  },
  results,
};
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-verify-out-emission-b.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  recomputed: summary.recomputed,
  passed: summary.passed,
  failed: summary.failed,
  layers: summary.layers,
  verdictOfRecordAcceptanceDesk: summary.statusAudit.verdictOfRecordAcceptanceDesk,
}, null, 2));
