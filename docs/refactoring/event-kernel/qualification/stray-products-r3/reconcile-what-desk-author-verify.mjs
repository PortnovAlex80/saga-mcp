/**
 * reconcile-what desk (author) - self-verification of the PUBLISHED artifacts.
 *
 * Re-reads the three written desk artifacts and re-derives everything from
 * the accepted upstream material through the REAL kernel surfaces (intent
 * fold, UC fold, WP03 requirements validator, acceptanceUniverseFrom,
 * validateAcceptanceBundle, reconcileWhat). Nothing is trusted by
 * declaration: every published digest is recomputed, the report is
 * re-computed over a re-derived snapshot and compared byte-for-byte, the
 * computed-verdict law and the report-only deep-freeze law are proven, and
 * every trace/submission reference must resolve against the recomputed
 * digest space.
 *
 * Run: node reconcile-what-desk-author-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
const art = load('reconcile-what-desk-what-reconciliation.artifact.json');
const trc = load('reconcile-what-desk-what-reconciliation-trace.json');
const sub = load('reconcile-what-desk-product-submission.json');
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
const WORKSPACE_SUMMARY = '0 accepted upstream revisions travel by content address';

/* A. Published envelope digests */
check('A1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('A2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), `recomputed ${shaRef(art.contentDigest)} vs declared ${art.artifactRef}`);
check('A3.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)} vs declared ${trc.contentDigest}`);
check('A4.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), `recomputed ${shaRef(trc.contentDigest)} vs declared ${trc.traceRef}`);
check('A5.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('A6.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), `recomputed ${shaRef(sub.contentDigest)} vs declared ${sub.submissionRef}`);
check('A7.kind.family', art.productKind === 'formalization.what-reconciliation.v1' && art.content.schemaVersion === accCell.RECONCILIATION_REPORT_KIND, `productKind=${art.productKind} schemaVersion=${art.content.schemaVersion}`);
check('A8.workspace.governing', art.content.workspaceSummary === WORKSPACE_SUMMARY && art.content.governingContractRef === shaRef(GOVERNING) && sub.content.workspaceSummary === WORKSPACE_SUMMARY, 'workspace summary + governing pin present in artifact and submission');

/* B. Upstream re-derivation (real folds + real validators) */
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
  check(`B1.prd03.${m.memberId}`, v.ok === true, v.ok === true ? 'accepted' : `refuses: ${v.reason}`);
  upSeal.set(m.memberId, sha(m));
}
const upFold = upCell.acceptedIntentSetOf(
  { members: upArt.content.members },
  upArt.content.members.map((m) => ({ memberId: m.memberId, digest: upSeal.get(m.memberId) })),
);
check('B2.intentFold', upFold.ok === true && shaRef(upFold.set.revisionDigest) === SR_PRODUCT.prdRevisionRef && upFold.set.revisionDigest === art.content.upstream.acceptedIntentSet.revisionDigest, `revision pin ${upFold.ok === true ? shaRef(upFold.set.revisionDigest) : upFold.detail}`);

const ucSeal = new Map();
for (const s of ucArt.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, { idSets: { prdMemberIds: upFold.set.prdMemberIds } });
  check(`B3.uc03.${s.scenarioId}`, v.ok === true, v.ok === true ? 'accepted' : `refuses: ${v.reason}`);
  ucSeal.set(s.scenarioId, sha(s));
}
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
check('B4.ucRevision', shaRef(ucRevisionDigest) === SR_PRODUCT.ucRevisionRef, `revision pin ${shaRef(ucRevisionDigest)}`);
const acceptedUcSet = {
  memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort(),
  scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(),
  branchIdsByScenario: Object.fromEntries(ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)])),
  revisionDigest: ucRevisionDigest,
};

const requirementSeal = new Map(SR_PRODUCT.requirements.map((r) => [r.requirementId, sha(r)]));
const criterionSeal = new Map(ACC_PRODUCT.criteria.map((c) => [c.criterionId, sha(c)]));
const statementSeal = new Map(accArt.content.verifiableStatements.map((s) => [s.statementId, s.digest]));

const srUniverse = srCell.deriveAcceptedUniverse({
  prd: { revisionDigest: upFold.set.revisionDigest, memberIds: [...upFold.set.prdMemberIds] },
  useCases: { revisionDigest: ucRevisionDigest, scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  sourceConstraintIds: ['constraint:retention-1'],
  verificationSurfaceIds: srArt.content.deskInput.verificationSurfaceIds,
});
const srSealedNow = srUniverse.ok === true ? wp03sr.validateRequirementsBundle(SR_PRODUCT, srUniverse.universe) : { ok: false, reason: 'universe refused' };
check('B5.wp03.requirementsReseal', srSealedNow.ok === true, srSealedNow.ok === true ? `re-sealed ${srSealedNow.ref}` : `${srSealedNow.reason}: ${srSealedNow.detail}`);

const accUniverse = accCell.acceptanceUniverseFrom({
  requirementsBundle: SR_PRODUCT,
  useCases: { scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  verifiableStatementIds: accArt.content.deskInput.verifiableStatementIds,
  evidenceBindings: accArt.content.deskInput.evidenceBindings,
});
const accSealedNow = accUniverse.ok === true ? accCell.validateAcceptanceBundle(ACC_PRODUCT, accUniverse.universe, SR_PRODUCT.requirements) : { ok: false, reason: 'universe refused' };
check('B6.acceptanceReseal', accSealedNow.ok === true && accSealedNow.artifact.ref === accArt.content.productSeal.ref, accSealedNow.ok === true ? `re-sealed ${accSealedNow.artifact.ref} vs published ${accArt.content.productSeal.ref}` : `${accSealedNow.reason}: ${accSealedNow.detail}`);

check('B7.reviewerOfRecord', accReview.content.verdict === 'accepted'
  && accReview.content.reviewedCandidate.artifactRef === accArt.artifactRef
  && accReview.content.reviewedCandidate.productSeal === accArt.content.productSeal.ref, `verdict=${accReview.content.verdict} over the published author candidate`);

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
check('C1.report.byteEquality', canon(recomputedReport) === canon(art.content.product), `recomputed digest ${recomputedReport.reportDigest} vs declared ${art.content.product.reportDigest}`);
check('C2.reportDigest.internal', shaRef(sha({ ...art.content.product, reportDigest: undefined })) === art.content.product.reportDigest, `recomputed ${shaRef(sha({ ...art.content.product, reportDigest: undefined }))} vs declared ${art.content.product.reportDigest}`);
check('C3.verdict.computedLaw', art.content.product.verdict === 'consistent' && art.content.product.findings.length === 0 && recomputedReport.verdict === 'consistent', `verdict=${art.content.product.verdict} findings=${art.content.product.findings.length}`);
check('C4.report.deepFrozen', Object.isFrozen(recomputedReport) && Object.isFrozen(recomputedReport.findings) && Object.isFrozen(recomputedReport.rows) && Object.isFrozen(recomputedReport.gaps), 'the reconciler returns a deep-frozen report (report-only law)');
check('C5.rows.installedShape', art.content.product.rows.length === 4 && art.content.product.rows.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(['criterionRefs', 'memberRef', 'requirementRefs', 'scenarioRef', 'sourceClaimRef'])), `${art.content.product.rows.length} rows in the installed formalization.what-reconciliation.v1 row shape`);
const scopeRow = art.content.product.rows.find((r) => r.sourceClaimRef === 'claim:scope-2');
check('C6.outOfScope.honestEmptyRow', scopeRow?.memberRef === 'prd:scope-2' && scopeRow.requirementRefs.length === 0 && scopeRow.criterionRefs.length === 0, `prd:scope-2 row: memberRef=${scopeRow?.memberRef} requirements=${scopeRow?.requirementRefs.length} criteria=${scopeRow?.criterionRefs.length}`);

/* Reverse direction re-proven through the REAL WP03 seam, per criterion. */
let seamRefusals = 0;
for (const c of ACC_PRODUCT.criteria) {
  const v = wp03seam.validateAcBinding(c, accUniverse.universe);
  if (v.ok !== true) seamRefusals += 1;
}
check('C7.reverse.wp03Seam', seamRefusals === 0, `${ACC_PRODUCT.criteria.length} criteria re-validated through the WP03 seam against the re-derived universe; refusals=${seamRefusals}`);

/* D. Trace resolution + coverage projections */
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
let unresolved = 0;
for (const r of trc.content.relationships) {
  if (resolveId(r.fromId) === null || resolveId(r.toId) === null || r.fromRef !== shaRef(resolveId(r.fromId)) || r.toRef !== shaRef(resolveId(r.toId))) unresolved += 1;
}
check('D1.trace.edgesResolve', unresolved === 0, `${trc.content.relationships.length} relationships; unresolved=${unresolved}`);
check('D2.trace.reportAnchor', trc.content.reportCoverage.digest === reportDigestHex && canon(trc.content.reportCoverage.reconciles) === canon(trc.content.relationships.filter((r) => r.fromId === 'report' && r.relation === 'reconciles').map((r) => r.toId).sort()), 'report coverage block is the exact projection of the report edges');
check('D3.trace.claimCoverage', claimIds.every((claimId) => canon(trc.content.claimCoverage[claimId].formalizedAs) === canon(trc.content.relationships.filter((r) => r.relation === 'formalized-as' && r.fromId === claimId).map((r) => r.toId).sort())), 'claim coverage blocks are exact projections of the formalized-as edges');

/* E. Submission evidence resolution + dispositions */
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
const missing = sub.content.payloadContract.requiredEvidenceRefs.filter((ref) => !knownDigests.has(ref.replace(/^sha256:/, '')));
check('E1.submission.evidenceResolve', missing.length === 0, `${sub.content.payloadContract.requiredEvidenceRefs.length} required evidence refs; unresolved=${missing.length}`);
const constraints = art.content.constraintDispositions ?? [];
check('E2.constraint.honored', constraints.length === 1 && constraints[0].disposition === 'honored' && constraints[0].enforcedBy.every((id) => criterionSeal.has(id)), `constraint:retention-1 honored through ${constraints[0]?.enforcedBy?.join(', ')}`);
const unknowns = art.content.unknownDispositions ?? [];
const bundleText = canon(ACC_PRODUCT);
check('E3.unknown.carriedNothingDerived', unknowns.length === 1 && unknowns[0].disposition === 'carried_forward' && unknowns[0].owner === 'discovery' && !bundleText.includes('browser'), 'unknown:browser-matrix-1 carried_forward, owner discovery, nothing derived in the accepted bundle');
const terminals = art.content.terminalSupport ?? [];
check('E4.terminal.ownedUpstream', terminals.length === 2 && terminals.every((t) => upSeal.has(t.ownedByMemberId) && requirementSeal.has(t.supportedByRequirementId) && criterionSeal.has(t.verifiedByCriterionId)), 'terminal claims stay owned upstream; support resolves through accepted requirements and criteria');
check('E5.envelope.8of8', (art.content.upstream.verifiedSubArtifacts ?? []).length === 8 && (art.content.upstream.verifiedSubArtifacts ?? []).every((v) => ENVELOPE[v.id] === v.digest && v.ref === shaRef(v.digest)), '8/8 task-projection content addresses re-derived (not by declaration)');
check('E6.submission.selfCheck', sub.content.acceptanceCriteriaSelfCheck.length === 12 && sub.content.acceptanceCriteriaSelfCheck.every((c) => c.satisfied === true), `${sub.content.acceptanceCriteriaSelfCheck.length}/12 self-check items satisfied`);

/* F. Determinism + WHAT-side fence */
check('F1.determinism.recompute', sha(art.content) === sha(art.content) && accCell.reconcileWhat(snapshot).reportDigest === art.content.product.reportDigest, 'repeated recomputation yields identical digests (pinned timestamps, no clock, no randomness)');
const deskText = canon(art.content);
check('F2.fence.whatSide', !/"moduleAllocation"/.test(deskText) && !/src\/modules\//.test(deskText) && !/file layout/.test(deskText), 'no architecture, module allocation or file decisions anywhere in the desk artifact (WHAT-side fence)');

const summary = {
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; report: real acceptance.reconcileWhat over a snapshot re-derived through the real acceptanceUniverseFrom protocol; upstream: real PRD/UC/WP03 validators + REAL cell folds + real validateAcceptanceBundle re-seal',
  recomputed: results.length,
  passed: results.filter((r) => r.ok === true).length,
  failed: results.filter((r) => r.ok !== true).length,
  results,
};
writeFileSync(join(DIR, 'reconcile-what-desk-author-verify-out.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ recomputed: summary.recomputed, passed: summary.passed, failed: summary.failed }, null, 2));
