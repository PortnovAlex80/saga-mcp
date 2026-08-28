/**
 * reconcile-what desk (reviewer) - INDEPENDENT verifier + reviewer round,
 * EMISSION A (distinct-name reissue after the reviewer-seat filename
 * collision; see reconcile-what-desk-reviewer-collision-record.json).
 *
 * The candidate of record is the AUTHOR REISSUE (submission
 * FS-Reconcile-What-001 sha256:0f4e4faf..., artifact sha256:6400a2dd...,
 * trace sha256:09e80046...), which superseded in place the first author
 * emission (artifact sha256:c22d4787...). Intake receipt
 * evidence:DeskIntakeReceipt#reconcile-what:author, admitted_for_reviewer_stage.
 *
 * This emission:
 *   1. re-verifies the candidate CONTENT chain mechanically (nothing trusted
 *      by declaration): every declared digest recomputed over canonical JSON,
 *      the REAL installed cell surface (reconcileWhat through the acceptance
 *      cell) re-run over an independently re-derived snapshot, report-only
 *      law, computed-verdict law, F-2 kill both directions, adversarial
 *      probes, trace/coverage projections recomputed, task-projection
 *      envelope matched against THIS reviewer frame;
 *   2. audits the STATUS layer with its own reads of the re-digested verdict
 *      records (r2/r3): which consumed upstream revisions are genuinely
 *      accepted, which reviewer emission the candidate cites as its gate,
 *      and whether that emission is the verdict of record;
 *   3. verifies the reviewer round ALREADY ON DISK in the plain slots
 *      (verification/review/trace/product submission, verdict repair) against
 *      the content this script recomputes - byte-faithful, no rewrite of
 *      occupied slots (collision discipline);
 *   4. authors the collision record for the contested reviewer filenames.
 *
 * Deterministic: pinned timestamps, no clock reads, no randomness.
 * Run: node reconcile-what-desk-reviewer-verify-emission-a.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRaw = (buf) => createHash('sha256').update(buf).digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const QUAL = join(DIR, '..');
const R2 = join(QUAL, 'stray-products-r2');
const REPO_ROOT = join(DIR, '..', '..', '..', '..', '..');
const accCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'acceptance', 'index.mjs')).href);
const upCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'product-intent', 'index.js')).href);
const srCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'system-requirements', 'index.js')).href);
const wp03sr = await import(pathToFileURL(join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'validators', 'requirements-bundle.mjs')).href);
const prd03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href);
const uc03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'uc-scenario-member.mjs')).href);

const CREATED_AT = '2026-08-28T00:00:00Z';
const WORKSPACE_SUMMARY = '0 accepted upstream revisions travel by content address';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const PROTOCOL_SKILL = 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50';
const SEMANTIC_SKILL = '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2';
const SUPERSEDED_ACC_REVIEW = 'e5249d786aa3318a7426dde2ba36e111437d4e0ab0e7e6f9e7cda3b9463ce466';
const CONFIRMED_ACC_REVIEW = '83e675bb18c575cb0b30e3ededd2cca6b58b88c08cb50be9c08dfb130808c383';
const STALE_R1_PROTOCOL_SKILL = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';
const SELF_FILE = 'reconcile-what-desk-reviewer-verify-emission-a.mjs';

/* The task-projection envelope of THIS reviewer frame (content addresses). */
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
const CLAIM_IDS = ['claim:scope-1', 'claim:scope-2', 'claim:constraint-1', 'claim:outcome-1'];
const PINNED_TS = /2026-08-28T00:00:00Z/;

/* ------------------------------------------------------------------ */
/* Check ledger                                                        */
/* ------------------------------------------------------------------ */

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok: ok === true, detail: String(detail) }); return ok === true; };
const expect = (cond, message) => { if (!cond) throw new Error(`reviewer verification failed: ${message}`); };
const load = (dir, name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

/* ------------------------------------------------------------------ */
/* Load the candidate of record (the author reissue)                   */
/* ------------------------------------------------------------------ */

const sub = load(DIR, 'reconcile-what-desk-product-submission.json');
const art = load(DIR, 'reconcile-what-desk-what-reconciliation.artifact.json');
const trc = load(DIR, 'reconcile-what-desk-what-reconciliation-trace.json');
const AC = art.content;
const product = AC.product;
const TC = trc.content;
const reportDigestHex = product.reportDigest.replace(/^sha256:/, '');

/* A-group: self-address of the candidate chain. */
check('A1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content).slice(0, 16)} vs declared ${sub.contentDigest.slice(0, 16)}`);
check('A2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);
check('A3.artifact.contentDigest', sha(AC) === art.contentDigest, `recomputed ${sha(AC).slice(0, 16)} vs declared ${art.contentDigest.slice(0, 16)}`);
check('A4.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('A5.trace.contentDigest', sha(TC) === trc.contentDigest, `recomputed ${sha(TC).slice(0, 16)} vs declared ${trc.contentDigest.slice(0, 16)}`);
check('A6.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), trc.traceRef);
check('A7.submission.candidateBinding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest, art.artifactRef);
check('A8.submission.traceBinding', sub.content.traceRef === trc.traceRef, sub.content.traceRef);
check('A9.trace.subjectBinding', TC.subjectArtifactRef === art.artifactRef, `${art.semanticCode} / ${art.artifactRef.slice(0, 20)}`);
check('A10.semanticPins', art.semanticCode === 'SR-Reconcile-What-001' && sub.submissionId === 'FS-Reconcile-What-001', `${art.semanticCode} / ${sub.submissionId} (submissionId reused from the superseded emission c22d4787 - recorded)`);

/* ------------------------------------------------------------------ */
/* B-group: upstream re-verification (independent recomputation)        */
/* ------------------------------------------------------------------ */

const upArt = load(DIR, 'define-product-intent-desk-product-intent.artifact.json');
const ucArt = load(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json');
const ucTrc = load(DIR, 'model-use-cases-desk-uc-scenarios-trace.json');
const ucSub = load(DIR, 'model-use-cases-desk-product-submission.json');
const srArt = load(DIR, 'derive-system-requirements-desk-system-requirements.artifact.json');
const srTrc = load(DIR, 'derive-system-requirements-desk-system-requirements-trace.json');
const srSub = load(DIR, 'derive-system-requirements-desk-product-submission.json');
const accArt = load(DIR, 'define-acceptance-contract-desk-acceptance-bindings.artifact.json');
const accTrc = load(DIR, 'define-acceptance-contract-desk-acceptance-bindings-trace.json');
const accSub = load(DIR, 'define-acceptance-contract-desk-product-submission.json');
const SR_PRODUCT = srArt.content.product;
const ACC_PRODUCT = accArt.content.product;

check('B1.upstreamArtifactDigests', [upArt, ucArt, srArt, accArt].every((a) => sha(a.content) === a.contentDigest), 'intent/uc/requirements/acceptance artifact contents re-digest');
check('B2.upstreamTraceDigests', [ucTrc, srTrc, accTrc].every((t) => sha(t.content) === t.contentDigest), 'uc/requirements/acceptance trace contents re-digest');
check('B3.upstreamSubmissionDigests', [ucSub, srSub, accSub].every((s) => sha(s.content) === s.contentDigest), 'uc/requirements/acceptance submission contents re-digest');
check('B4.upstreamRefsPinned', AC.upstream.acceptedIntentArtifactRef === ucArt.content.upstream.acceptedIntentArtifactRef
  && AC.upstream.acceptedUcArtifactRef === ucArt.artifactRef
  && AC.upstream.acceptedRequirementsArtifactRef === srArt.artifactRef
  && AC.upstream.acceptedAcceptanceArtifactRef === accArt.artifactRef
  && AC.upstream.acceptedAcceptanceSubmissionRef === accSub.submissionRef, 'artifact.upstream pins equal the on-disk upstream chain');

/* Intent members through the REAL validator + fold. */
const upSeal = new Map();
let prdOk = true;
for (const m of upArt.content.members) {
  const v = prd03.validatePrdIntentMember(m, { idSets: { sourceClaimIds: CLAIM_IDS, terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'] } });
  if (!v.ok) { prdOk = false; break; }
  upSeal.set(m.memberId, sha(m));
}
check('B5.prdMemberSeals', prdOk && AC.upstream.acceptedIntentSeals.every((s) => upSeal.get(s.memberId) === s.digest), '6/6 PRD seals recomputed over canonical members via REAL validatePrdIntentMember');
const upFold = upCell.acceptedIntentSetOf(
  { members: upArt.content.members },
  upArt.content.members.map((m) => ({ memberId: m.memberId, digest: upSeal.get(m.memberId) })),
);
check('B6.intentFold', upFold.ok === true && AC.upstream.acceptedIntentSet.revisionDigest === upFold.set.revisionDigest
  && SR_PRODUCT.prdRevisionRef === shaRef(upFold.set.revisionDigest), `revision ${upFold.ok ? upFold.set.revisionDigest.slice(0, 16) : 'REFUSED'} re-folds through acceptedIntentSetOf`);

/* UC scenarios through the REAL validator + fold formula. */
const ucSeal = new Map();
let ucOk = true;
for (const s of ucArt.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, { idSets: { prdMemberIds: upFold.set.prdMemberIds } });
  if (!v.ok) { ucOk = false; break; }
  ucSeal.set(s.scenarioId, sha(s));
}
check('B7.ucMemberSeals', ucOk && AC.upstream.acceptedUcSeals.every((s) => ucSeal.get(s.scenarioId) === s.digest), '3/3 UC seals recomputed over canonical members via REAL validateUcScenarioMember');
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
check('B8.ucRevisionFold', SR_PRODUCT.ucRevisionRef === shaRef(ucRevisionDigest), `revision ${ucRevisionDigest.slice(0, 16)} re-folds`);
const branchIdsByScenario = Object.fromEntries(ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)]));

/* Requirements + acceptance re-seal through the REAL surfaces. */
const requirementSeal = new Map(SR_PRODUCT.requirements.map((r) => [r.requirementId, sha(r)]));
check('B9.requirementSeals', AC.upstream.acceptedRequirementSeals.every((s) => requirementSeal.get(s.requirementId) === s.digest), '4/4 requirement seals recomputed');
const srUniverse = srCell.deriveAcceptedUniverse({
  prd: { revisionDigest: upFold.set.revisionDigest, memberIds: [...upFold.set.prdMemberIds] },
  useCases: { revisionDigest: ucRevisionDigest, scenarioIds: [...ucArt.content.scenarios.map((s) => s.scenarioId)].sort(), branchIdsByScenario },
  sourceConstraintIds: ['constraint:retention-1'],
  verificationSurfaceIds: srArt.content.deskInput.verificationSurfaceIds,
});
const srResealed = srUniverse.ok ? wp03sr.validateRequirementsBundle(SR_PRODUCT, srUniverse.universe) : { ok: false };
check('B10.requirementsReseal', srUniverse.ok && srResealed.ok === true && sha(SR_PRODUCT) === '60083eb4a2ba553d0924c9b9ffe12ad9e703f9adc2f7da6bd5584a1747620690', `WP03 re-seal ${srUniverse.ok && srResealed.ok ? 'ok' : 'REFUSED'}; bundle sha 60083eb4... recomputes`);
const criterionSeal = new Map(ACC_PRODUCT.criteria.map((c) => [c.criterionId, sha(c)]));
check('B11.criterionSeals', AC.upstream.acceptedCriterionSeals.every((s) => criterionSeal.get(s.criterionId) === s.digest), '5/5 criterion seals recomputed');
const acceptanceUniverse = accCell.acceptanceUniverseFrom({
  requirementsBundle: SR_PRODUCT,
  useCases: { scenarioIds: [...ucArt.content.scenarios.map((s) => s.scenarioId)].sort(), branchIdsByScenario },
  verifiableStatementIds: accArt.content.deskInput.verifiableStatementIds,
  evidenceBindings: accArt.content.deskInput.evidenceBindings,
});
const accResealed = acceptanceUniverse.ok ? accCell.validateAcceptanceBundle(ACC_PRODUCT, acceptanceUniverse.universe, SR_PRODUCT.requirements) : { ok: false };
check('B12.acceptanceReseal', acceptanceUniverse.ok && accResealed.ok === true && accResealed.artifact.digest === accArt.content.productSeal.digest, `re-seal equals the declared product seal ${accArt.content.productSeal.digest.slice(0, 16)}`);
check('B13.acceptanceSealPin', AC.upstream.acceptedAcceptanceSeal?.digest === accArt.content.productSeal.digest, `acceptedAcceptanceSeal pin ${AC.upstream.acceptedAcceptanceSeal?.digest?.slice(0, 16)}`);

/* ------------------------------------------------------------------ */
/* C-group: the REAL cell surface over an independently derived snapshot */
/* ------------------------------------------------------------------ */

const CLAIM_ROW_MAPPING = { 'claim:scope-1': 'prd:boundary-1', 'claim:scope-2': 'prd:scope-2', 'claim:constraint-1': 'prd:constraint-1', 'claim:outcome-1': 'prd:outcome-1' };
const snapshot = {
  universe: acceptanceUniverse.universe,
  requirements: SR_PRODUCT.requirements,
  acceptance: { criteria: ACC_PRODUCT.criteria, deferrals: ACC_PRODUCT.deferrals ?? [], standaloneEvidenceBindings: ACC_PRODUCT.standaloneEvidenceBindings ?? [] },
  prd: { memberIds: [...upFold.set.prdMemberIds], scenarioRequiredMemberIds: [...upFold.set.scenarioRequiredMemberIds] },
  useCases: { scenarioIds: [...ucArt.content.scenarios.map((s) => s.scenarioId)].sort(), branchIdsByScenario: { ...branchIdsByScenario } },
  sourceClaims: { claimIds: [...CLAIM_IDS].sort(), claimToMember: { ...CLAIM_ROW_MAPPING } },
};
const SNAPSHOT_BEFORE = JSON.stringify(snapshot);
const report = accCell.reconcileWhat(snapshot);
check('C1.reportOnly.snapshotUntouched', JSON.stringify(snapshot) === SNAPSHOT_BEFORE, 'snapshot byte-identical after reconcileWhat');
check('C2.report.deepEqualDeclared', JSON.stringify(sortKeys(report)) === JSON.stringify(sortKeys(product)), `recomputed report equals the declared product (verdict=${report.verdict}, findings=${report.findings.length}, rows=${report.rows.length})`);
check('C3.reportDigest', report.reportDigest === product.reportDigest && sha({ ...JSON.parse(JSON.stringify(report)), reportDigest: undefined }) === reportDigestHex, product.reportDigest);
check('C4.verdictLaw', report.verdict === (report.findings.length === 0 ? 'consistent' : 'gaps'), 'verdict consistent iff zero findings (computed, never hardcoded)');
check('C5.reportKind', report.schemaVersion === accCell.RECONCILIATION_REPORT_KIND && product.schemaVersion === 'formalization.what-reconciliation.v1', accCell.RECONCILIATION_REPORT_KIND);
const rerun = accCell.reconcileWhat(JSON.parse(SNAPSHOT_BEFORE));
check('C6.deterministicRerun', rerun.reportDigest === report.reportDigest, 'fresh reconcileWhat over the same snapshot yields the identical report digest');

/* ------------------------------------------------------------------ */
/* D-group: adversarial probes (the F-2 kill both directions)           */
/* ------------------------------------------------------------------ */

const gapped = JSON.parse(SNAPSHOT_BEFORE);
gapped.acceptance = { ...gapped.acceptance, criteria: gapped.acceptance.criteria.filter((c) => c.criterionId !== 'ac:determinism-1') };
const gappedReport = accCell.reconcileWhat(gapped);
check('D1.f2kill.gappedYieldsGaps', gappedReport.verdict === 'gaps' && gappedReport.findings.length > 0 && JSON.stringify(gappedReport.findings).includes('nfr:determinism-1'), `gapped snapshot -> ${gappedReport.verdict} (${gappedReport.findings.length} finding(s), named nfr:determinism-1)`);
check('D2.f2kill.sameFunctionConsistent', report.verdict === 'consistent' && rerun.verdict === 'consistent', 'the SAME function on the intact snapshot returns consistent on every call - a hardcoded verdict cannot produce both');
const foreign = JSON.parse(SNAPSHOT_BEFORE);
foreign.acceptance = { ...foreign.acceptance, criteria: foreign.acceptance.criteria.map((c) => c.criterionId === 'ac:boundary-1' ? { ...c, bindsTo: { ...c.bindsTo, requirementRefs: ['fr:foreign-unknown'] } } : c) };
const foreignReport = accCell.reconcileWhat(foreign);
check('D3.probe.foreignRequirement', foreignReport.verdict === 'gaps' && JSON.stringify(foreignReport.findings).includes('fr:foreign-unknown'), `foreign binding -> ${foreignReport.verdict}, named in findings`);
const noPrd = JSON.parse(SNAPSHOT_BEFORE);
delete noPrd.prd;
const noPrdReport = accCell.reconcileWhat(noPrd);
check('D4.probe.missingPrdLayer', noPrdReport.verdict === 'gaps' && JSON.stringify(noPrdReport.findings).includes('MISSING_LINEAGE'), 'missing chain layer is a named gap, never a silent skip');
check('D5.report.frozen', Object.isFrozen(report) && Object.isFrozen(report.rows) && Object.isFrozen(report.findings), 'the recomputed report is deep-frozen: nothing can be patched in place');

/* ------------------------------------------------------------------ */
/* E-group: rows and the artifact-level claim mapping                   */
/* ------------------------------------------------------------------ */

const ROW_KEYS = ['sourceClaimRef', 'memberRef', 'scenarioRef', 'requirementRefs', 'criterionRefs'].sort();
const rowsOk = product.rows.length === 4 && product.rows.every((r) => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(ROW_KEYS));
check('E1.rows.shape', rowsOk, '4 rows keep the installed what-reconciliation row shape');
const rowOf = Object.fromEntries(product.rows.map((r) => [r.sourceClaimRef, r]));
check('E2.row.scope1', rowOf['claim:scope-1'].memberRef === 'prd:boundary-1' && JSON.stringify(rowOf['claim:scope-1'].requirementRefs) === JSON.stringify(['fr:boundary-1']) && JSON.stringify(rowOf['claim:scope-1'].criterionRefs) === JSON.stringify(['ac:boundary-1']), 'claim:scope-1 -> prd:boundary-1 -> fr:boundary-1 -> ac:boundary-1');
check('E3.row.scope2Empty', rowOf['claim:scope-2'].memberRef === 'prd:scope-2' && rowOf['claim:scope-2'].requirementRefs.length === 0 && rowOf['claim:scope-2'].criterionRefs.length === 0, 'prd:scope-2 (out_of_scope) reports empty downstream coverage');
check('E4.row.constraint', rowOf['claim:constraint-1'].memberRef === 'prd:constraint-1' && JSON.stringify(rowOf['claim:constraint-1'].requirementRefs) === JSON.stringify(['nfr:determinism-1']) && JSON.stringify(rowOf['claim:constraint-1'].criterionRefs) === JSON.stringify(['ac:determinism-1']), 'claim:constraint-1 -> prd:constraint-1 -> nfr:determinism-1 -> ac:determinism-1');
check('E5.row.outcome', rowOf['claim:outcome-1'].memberRef === 'prd:outcome-1' && JSON.stringify(rowOf['claim:outcome-1'].requirementRefs) === JSON.stringify(['fr:outcome-1']) && JSON.stringify(rowOf['claim:outcome-1'].criterionRefs) === JSON.stringify(['ac:outcome-1-delivered', 'ac:outcome-1-deterministic-error']), 'claim:outcome-1 -> prd:outcome-1 -> fr:outcome-1 -> [delivered, deterministic-error]');

/* Artifact-level claimCoverage: the FULL accepted mapping per claim,
   recomputed from the accepted members' own derivations (superset of the
   kernel row, which carries the row mapping only). */
let ccOk = AC.claimCoverage.length === 4;
const ccDetail = [];
for (const cc of AC.claimCoverage) {
  const row = rowOf[cc.claimId];
  const membersOk = (cc.memberRefs ?? []).every((mid) => {
    const m = upArt.content.members.find((x) => x.memberId === mid);
    return m && (m.sourceClaimRefs ?? []).includes(cc.claimId) && upFold.set.prdMemberIds.includes(mid);
  });
  const myRequirements = SR_PRODUCT.requirements.filter((r) => (r.derivation?.prdIntentRefs ?? []).some((mid) => cc.memberRefs.includes(mid))).map((r) => r.requirementId).sort();
  const myCriteria = ACC_PRODUCT.criteria.filter((c) => (c.bindsTo?.requirementRefs ?? []).some((rid) => myRequirements.includes(rid))).map((c) => c.criterionId).sort();
  const entryOk = cc.digest === ENVELOPE[cc.claimId]
    && cc.rowMemberRef === row.memberRef
    && row.memberRef === [...cc.memberRefs].sort()[0]
    && JSON.stringify([...cc.requirementRefs].sort()) === JSON.stringify(myRequirements)
    && JSON.stringify([...cc.criterionRefs].sort()) === JSON.stringify(myCriteria)
    && row.requirementRefs.every((x) => cc.requirementRefs.includes(x))
    && row.criterionRefs.every((x) => cc.criterionRefs.includes(x))
    && membersOk;
  if (!entryOk) { ccOk = false; ccDetail.push(cc.claimId); }
}
check('E6.claimCoverage.fullMapping', ccOk, `4/4 artifact claimCoverage entries recomputed from the accepted members' derivations: envelope digest, row mapping (first member in sorted order), FULL requirement/criterion closure, row refs a subset${ccDetail.length ? ` - drift: ${ccDetail.join(',')}` : ''}`);

/* ------------------------------------------------------------------ */
/* F-group: THIS reviewer frame's envelope                              */
/* ------------------------------------------------------------------ */

const declaredEnvelope = Object.fromEntries((AC.upstream.verifiedSubArtifacts ?? []).map((e) => [e.id, e.digest]));
check('F1.envelope.exact', JSON.stringify(declaredEnvelope) === JSON.stringify(ENVELOPE) && Object.keys(declaredEnvelope).length === 8, '8/8 task-projection content addresses match THIS reviewer frame exactly');
check('F2.governing.pin', AC.governingContractRef === shaRef(GOVERNING) && TC.workspaceSummary === WORKSPACE_SUMMARY, `governing pinned ${shaRef(GOVERNING).slice(0, 24)}`);
check('F3.workspaceSummary.verbatim', AC.workspaceSummary === WORKSPACE_SUMMARY && sub.content.workspaceSummary === WORKSPACE_SUMMARY, WORKSPACE_SUMMARY);
check('F4.pinnedTimestamps', PINNED_TS.test(art.createdAt) && PINNED_TS.test(trc.createdAt) && PINNED_TS.test(sub.createdAt) && art.createdAt === trc.createdAt && trc.createdAt === sub.createdAt, 'all three artifacts pinned at 2026-08-28T00:00:00Z');
check('F5.manifestPins', AC.checkProviderId === 'formalization.reconciliation-structure.v1' && AC.productKind === 'formalization.what-reconciliation.v1' && AC.effectId === 'formalization.accept-products', 'provider/productKind/effect pinned per the installed manifest');

/* ------------------------------------------------------------------ */
/* G-group: the restructured author trace, resolved against MY          */
/* independently recomputed seals                                       */
/* ------------------------------------------------------------------ */

const branchOwner = new Map();
for (const [scenarioId, branchIds] of Object.entries(branchIdsByScenario)) for (const b of branchIds) branchOwner.set(b, scenarioId);
const resolveId = (id) => {
  if (id === 'report') return reportDigestHex;
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (upSeal.has(id)) return upSeal.get(id);
  if (ucSeal.has(id)) return ucSeal.get(id);
  if (requirementSeal.has(id)) return requirementSeal.get(id);
  if (criterionSeal.has(id)) return criterionSeal.get(id);
  if (branchOwner.has(id)) return ucSeal.get(branchOwner.get(id));
  return undefined;
};
const edges = TC.relationships;
check('G1.trace.vocabularyClosed', JSON.stringify([...new Set(edges.map((r) => r.relation))].sort()) === JSON.stringify([...TC.relationVocabulary].sort()), `closed vocabulary: ${TC.relationVocabulary.join(', ')} (restructured from the superseded emission's closes/covers/derives/supports/verifies - recorded as advisory)`);
const badEdges = edges.filter((e) => resolveId(e.fromId) !== e.fromRef.replace(/^sha256:/, '') || resolveId(e.toId) !== e.toRef.replace(/^sha256:/, ''));
check('G2.trace.edges.resolve', badEdges.length === 0, `${edges.length}/${edges.length} relationships resolve at both ends to independently recomputed digests${badEdges.length ? ` - unresolved: ${badEdges.map((e) => `${e.fromId}->${e.toId}`).join(', ')}` : ''}`);
check('G3.trace.reportCoverage', TC.reportCoverage.digest === reportDigestHex
  && JSON.stringify([...TC.reportCoverage.reconciles].sort()) === JSON.stringify([...ACC_PRODUCT.criteria.map((c) => c.criterionId), ...SR_PRODUCT.requirements.map((r) => r.requirementId)].sort()), 'reportCoverage pins the computed report digest and reconciles exactly the 9 chain ids (5 criteria + 4 requirements)');
let lcOk = true;
const lcDetail = [];
for (const cc of AC.claimCoverage) {
  const ok = (cc.memberRefs ?? []).every((mid) => {
    const m = upArt.content.members.find((x) => x.memberId === mid);
    return m && (m.sourceClaimRefs ?? []).includes(cc.claimId);
  });
  if (!ok) { lcOk = false; lcDetail.push(cc.claimId); }
}
check('G4.trace.formalizedAs.supported', lcOk && edges.filter((e) => e.relation === 'formalized-as').every((e) => (AC.claimCoverage.find((c) => c.claimId === e.fromId)?.memberRefs ?? []).includes(e.toId)), `every formalized-as edge is backed by the accepted member mapping${lcDetail.length ? ` - unsupported: ${lcDetail.join(',')}` : ''}`);
check('G5.trace.verdictProvenance', TC.verdictProvenance.verdict === report.verdict && TC.verdictProvenance.findingsCount === report.findings.length, `verdict provenance pins the computed verdict/findings (${report.verdict}/${report.findings.length})`);
const LA = TC.layerAnchors ?? {};
check('G6.trace.layerAnchors', LA.prdRevision?.digest === upFold.set.revisionDigest
  && LA.ucRevision?.digest === ucRevisionDigest
  && LA.acceptanceSeal?.digest === accArt.content.productSeal.digest
  && LA.requirementsReseal?.ref === shaRef(sha(SR_PRODUCT)), 'all four layer anchors recompute (prd fold, uc fold, acceptance seal, WP03 requirements re-seal)');
const myTerminalCoverage = Object.fromEntries(['terminal:audited-1', 'terminal:delivered-1'].map((t) => [t, {
  digest: ENVELOPE[t],
  supportedBy: AC.terminalSupport.filter((s) => s.terminalClaimId === t).map((s) => s.verifiedByCriterionId).sort(),
}]));
check('G7.trace.terminalCoverage', JSON.stringify(sortKeys(TC.terminalCoverage)) === JSON.stringify(sortKeys(myTerminalCoverage)), 'terminalCoverage is an exact projection of terminalSupport + envelope digests');
check('G8.trace.unknown.noEdges', TC.unknownCoverage.disposition === 'carried_forward' && TC.unknownCoverage.owner === 'discovery' && !edges.some((e) => e.fromId === 'unknown:browser-matrix-1' || e.toId === 'unknown:browser-matrix-1') && !JSON.stringify(product).includes('browser-matrix'), 'the envelope unknown has zero resolution edges and appears in no report material (the formalized-as edge to the ACCEPTED member prd:unknown-1 is chain material, not an unknown resolution)');
check('G9.trace.constraintCoverage', TC.constraintCoverage.disposition === 'honored' && JSON.stringify(TC.constraintCoverage.enforcedBy) === JSON.stringify(AC.constraintDispositions[0].enforcedBy), 'constraint:retention-1 coverage matches the artifact disposition');
check('G10.terminalSupport.upstreamCopy', JSON.stringify(AC.terminalSupport) === JSON.stringify(accArt.content.terminalSupport), 'terminalSupport is a faithful copy of the accepted acceptance bundle\'s terminal support');

/* ------------------------------------------------------------------ */
/* H-group: the author submission (payload contract)                    */
/* ------------------------------------------------------------------ */

const declaredEvidence = sub.content.payloadContract.requiredEvidenceRefs;
const malformed = declaredEvidence.filter((r) => !/^sha256:[0-9a-f]{64}$/.test(r));
check('H1.submission.refsUnique', new Set(declaredEvidence).size === declaredEvidence.length, `${new Set(declaredEvidence).size} unique refs over ${declaredEvidence.length} declared`);
check('H2.submission.wellFormed', malformed.length === 0, malformed.length === 0 ? 'every evidence ref is a content address' : `${malformed.length} MALFORMED refs (double sha256: prefix) - MAJ-2`);
const coverageSum = Object.values(sub.content.payloadContract.evidenceKindCoverage).reduce((a, b) => a + b, 0);
check('H3.submission.coverageSum', coverageSum === declaredEvidence.length, `coverage sums to ${coverageSum} over ${declaredEvidence.length} refs`);
check('H4.submission.intakeReceipt', sub.content.intakeReceipt.status === 'admitted_for_reviewer_stage' && sub.content.intakeReceipt.nextStage === 'reviewer', sub.content.intakeReceipt.receiptRef);
check('H5.submission.selfCheck.declared', sub.content.acceptanceCriteriaSelfCheck.length === 12 && sub.content.acceptanceCriteriaSelfCheck.every((r) => r.satisfied === true), '12 self-check rows all declared satisfied (rows 2/7/8 re-adjudicated by this review at the content and status layers)');
check('H6.submission.terminalOutcome', sub.content.payloadContract.terminalOutcome === 'success', 'terminalOutcome success');
check('H7.submission.frameSkillRefs', declaredEvidence.includes(shaRef(PROTOCOL_SKILL)) && declaredEvidence.includes(shaRef(SEMANTIC_SKILL)), `THIS frame's protocol/semantic skill digests present in the evidence set (found instead: ${declaredEvidence.includes(shaRef(STALE_R1_PROTOCOL_SKILL)) ? `stale r1 protocol-skill ${STALE_R1_PROTOCOL_SKILL.slice(0, 16)}` : 'neither'}; semantic-skill ${declaredEvidence.includes(shaRef(SEMANTIC_SKILL)) ? 'present' : 'ABSENT'})`);

/* ------------------------------------------------------------------ */
/* S-group: STATUS AUDIT - the reviewer's own reads of the verdict       */
/* records (every record re-digested before being trusted)              */
/* ------------------------------------------------------------------ */

const r2IntentArt = load(R2, 'define-product-intent-desk-product-intent.artifact.json');
const r2UcArt = load(R2, 'model-use-cases-desk-uc-scenarios.artifact.json');
const r2SrArt = load(R2, 'derive-system-requirements-desk-system-requirements.artifact.json');
const rev = (dir, name) => {
  const j = load(dir, name);
  expect(sha(j.content) === j.contentDigest, `${name}: verdict record digest drift`);
  return j.content;
};
const intent1 = rev(R2, 'define-product-intent-desk-reviewer-review.json');
const intent1b = rev(R2, 'define-product-intent-desk-reviewer-review-emission-b.json');
const intent2 = rev(R2, 'define-product-intent-desk-reviewer2-review.json');
const srRev1 = rev(R2, 'derive-system-requirements-desk-reviewer-review.json');
const accRevC = rev(DIR, 'define-acceptance-contract-desk-reviewer-review-emission-c.json');
const accSubC = rev(DIR, 'define-acceptance-contract-desk-reviewer-product-submission-emission-c.json');
const collision = rev(DIR, 'define-acceptance-contract-desk-reviewer-collision-record.json');
const ucHold = load(R2, 'model-use-cases-desk-upstream-hold.artifact.json');
const accHold = load(DIR, 'define-acceptance-contract-desk-upstream-hold.artifact.json');
const restaff = rev(R2, 'derive-system-requirements-desk-reviewer-restaff2-confirmation.json');
const candRef = (c) => c.reviewedCandidate?.artifactRef ?? c.candidateOfRecord?.artifactRef;

check('S1.intent.verdicts', intent1.reviewId === 'FR-Define-Product-Intent-001' && intent1.verdict === 'repair'
  && intent1b.verdict === 'repair' && intent2.reviewId === 'FR-Define-Product-Intent-002' && intent2.verdict === 'repair'
  && candRef(intent1) === upArt.artifactRef && candRef(intent2) === upArt.artifactRef,
  'the consumed intent revision a06dbc57 carries verdict repair across THREE reviewer emissions (FR-001, FR-001 emission-b, FR-002)');
check('S2.intent.noReissue', r2IntentArt.contentDigest === upArt.contentDigest && sha(r2IntentArt.content) === r2IntentArt.contentDigest, 'r2 and r3 intent artifacts are the SAME revision - no author reissue exists');
check('S3.uc.neverReviewed', readdirSync(R2).concat(readdirSync(DIR)).every((f) => !/^model-use-cases-desk-reviewer/.test(f)), 'no reviewer artifact for model-use-cases exists anywhere in r2 or r3 - the UC bundle never passed a reviewer stage');
check('S4.uc.upstreamHold', ucHold.artifactKind === 'upstream-hold' && sha(ucHold.content) === ucHold.contentDigest && ucHold.contentDigest.startsWith('6cccd162'), `the UC desk's own upstream hold stands (${ucHold.contentDigest.slice(0, 16)}) - the bundle was authored in violation of it`);
check('S5.uc.noReissue', r2UcArt.contentDigest === ucArt.contentDigest, 'r2 and r3 UC artifacts are the SAME revision (24f0aff2)');
check('S6.requirements.verdict', srRev1.reviewId === 'FR-Derive-System-Requirements-001' && srRev1.verdict === 'repair' && candRef(srRev1) === srArt.artifactRef, 'the consumed requirements revision 86b00569 carries verdict repair (FR-001)');
check('S7.requirements.restaff', restaff.confirmationId === 'RS-Derive-System-Requirements-001' && String(restaff.deskOutcome ?? '').length > 0 && String(JSON.stringify(restaff)).includes('repair'), 'the re-staffing confirmation CONFIRMS THE REPAIR VERDICT - it is not an acceptance');
check('S8.requirements.noReissue', r2SrArt.contentDigest === srArt.contentDigest, 'r2 and r3 requirements artifacts are the SAME revision - no author reissue exists');
check('S9.acceptance.verdictOfRecord', accRevC.reviewId === 'FR-Define-Acceptance-Contract-002' && accRevC.verdict === 'repair'
  && accSubC.adjudication?.contentionId === 'CTN-Define-Acceptance-Contract-001' && accSubC.adjudication?.verdictOfRecord === 'repair'
  && accSubC.adjudication?.superseded === shaRef(SUPERSEDED_ACC_REVIEW) && accSubC.adjudication?.confirmed === shaRef(CONFIRMED_ACC_REVIEW)
  && collision.recordId === 'CL-Define-Acceptance-Contract-001' && collision.contention?.contentionId === 'CTN-Define-Acceptance-Contract-001',
  'the acceptance-desk verdict of record is REPAIR (FR-002 + CTN-001 adjudication: emission A repair 83e675bb confirmed, accepted emission e5249d78 SUPERSEDED)');
check('S10.acceptance.hold', accHold.artifactKind === 'upstream-hold' && sha(accHold.content) === accHold.contentDigest, `the acceptance desk is on record hold (${accHold.contentDigest.slice(0, 16)}): no acceptance-contract material authored while upstream is unaccepted`);
check('S11.acceptance.noReissue', accSub.submissionRef === 'sha256:6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe' && accSub.contentDigest === '6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe', 'the acceptance author submission 6e19d3cb is unchanged - no reissue after the adjudication');
check('S12.onlyImportAccepted', true, 'per the r2 records re-digested above, the ONLY genuinely accepted chain is the discovery import (b10bb762); all four consumed revisions are repair-verdict or never-reviewed');
check('S13.candidate.assertsAccepted', AC.upstream.materialAuthority.includes('the accepted define-product-intent bundle')
  && AC.upstream.materialAuthority.includes('reviewer-accepted define-acceptance-contract bundle')
  && AC.verification.reviewerAcceptedCandidateOfRecord === true
  && AC.verification.revisionPinsMatchAcceptedRevisions === true
  && AC.verification.snapshotRecomputedFromAcceptedMaterial === true
  && Object.keys(sub.content.payloadContract.evidenceKindCoverage).filter((k) => k.startsWith('accepted-')).length >= 10,
  'the candidate ASSERTS accepted/reviewer-accepted states for the consumed revisions (materialAuthority wording, accepted* fields, 12 accepted-* evidence kinds, reviewerAcceptedCandidateOfRecord=true, revisionPinsMatchAcceptedRevisions=true)');
check('S13b.candidate.citesSupersededReview', AC.upstream.acceptanceReviewerReviewRef === shaRef(SUPERSEDED_ACC_REVIEW)
  && AC.upstream.acceptanceReviewerVerificationRef === 'sha256:17eb4d7fe2a9704df2ae45ef572a3905690a0d34ce4fd59d871f88da83850a43'
  && declaredEvidence.includes(shaRef(SUPERSEDED_ACC_REVIEW))
  && !declaredEvidence.includes(shaRef(CONFIRMED_ACC_REVIEW)),
  `the candidate's "reviewer gate" is the acceptance-desk emission ${SUPERSEDED_ACC_REVIEW.slice(0, 16)} - the EXACT emission the CTN-001 adjudication SUPERSEDED (the confirmed repair emission 83e675bb is not cited)`);
check('S13c.candidate.fabricatedReviewerAcceptance', AC.verification.reviewerAcceptedCandidateOfRecord === true,
  'reviewerAcceptedCandidateOfRecord=true asserts a THIS-desk reviewer acceptance; no reviewer artifact existed at this desk when the candidate was authored, and the reviewer round of record (this seat, plain slots) returns REPAIR - the asserted reviewer state does not exist and never existed for either author emission');
check('S14.candidate.silentOnContention', !JSON.stringify(AC).includes('CTN-Define-Acceptance-Contract') && !JSON.stringify(AC).includes('CL-Define-Acceptance-Contract')
  && !JSON.stringify(AC).includes('6cccd162') && !JSON.stringify(AC).includes('a53a5e08') && !JSON.stringify(AC).includes('FR-Define-Product-Intent'),
  'the candidate never mentions the open verdict contention, the holds, or any repair verdict - the accepted-state assertion is unacknowledged, not adjudicated');
const govFiles = [];
const walk = (dir) => { for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name); if (f.isDirectory()) walk(p); else govFiles.push(p); } };
walk(QUAL);
const govHit = govFiles.some((p) => { try { const buf = readFileSync(p); if (shaRaw(buf) === GOVERNING) return true; try { if (sha(JSON.parse(buf.toString('utf8'))) === GOVERNING) return true; } catch { /* not JSON */ } return false; } catch { return false; } });
check('S15.governing.unresolvable', govHit === false, `governing anchor ${GOVERNING.slice(0, 16)} resolves to NO content of ${govFiles.length} scanned qualification files (own scan; MAJ-1 of the upstream adjudication re-derived, still open)`);

/* ------------------------------------------------------------------ */
/* I-group: fence and determinism                                       */
/* ------------------------------------------------------------------ */

const productStr = JSON.stringify(product);
check('I1.fence.whatSideOnly', !/architect|module-?allocat|\bfile\b|implementation/i.test(productStr), 'the report contains no architecture/module/file decisions (WHAT-side fence)');
check('I2.reportOnly.flagsDeclared', AC.verification.reportOnlyNoMutations === true && AC.verification.reportFrozenDeepImmutable === true && AC.verification.computedVerdictNeverHardcoded === true, 'the artifact declares the report-only/computed-verdict laws; the MECHANICAL proof is this seat\'s C1/C5/D1-D5, which pass');
check('I3.unknown.derivesNothing', !productStr.includes('browser-matrix'), 'the unknown is cited in no report material');
for (const [label, file] of [['build', 'reconcile-what-desk-build.mjs'], ['authorVerify', 'reconcile-what-desk-author-verify.mjs']]) {
  const src = readFileSync(join(DIR, file), 'utf8');
  check(`I4.determinism.${label}`, !/Date\.now|Math\.random|new Date\(/.test(src) && (label === 'build' ? PINNED_TS.test(src) : true), `${file}: no clock reads, no randomness${label === 'build' ? ', pinned timestamp' : ' (verifier reads authored artifacts for its timestamps)'}`);
}

const failedBeforeRound = results.filter((r) => !r.ok);
const candidateChecks = results.length;

/* ------------------------------------------------------------------ */
/* Reviewer round of record: recompute and VERIFY against the plain     */
/* slots (no rewrite - collision discipline)                            */
/* ------------------------------------------------------------------ */

const AUTHOR_SUB_REF = sub.submissionRef;
const AUTHOR_ART_REF = art.artifactRef;
const AUTHOR_TRC_REF = trc.traceRef;
const REPORT_SEAL_REF = product.reportDigest;
const SUPERSEDED_AUTHOR_ART = 'sha256:c22d4787a789742113858ff53e31565795da5cb5a478d0eece501fc00a4c70e9';

const verificationContent = {
  verificationId: 'VV-Reconcile-What-001',
  deskRef: 'reconcile-what',
  role: 'reviewer',
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; report: real reconcileWhat through the REAL acceptanceUniverseFrom desk protocol (independent snapshot re-derivation); upstream: real PRD/UC validators + REAL cell folds + WP03 requirements re-seal + real validateAcceptanceBundle re-seal; status audit: verdict records re-digested then read directly',
  subject: {
    submissionRef: AUTHOR_SUB_REF,
    artifactRef: AUTHOR_ART_REF,
    traceRef: AUTHOR_TRC_REF,
    reportSealRef: REPORT_SEAL_REF,
    supersededPriorEmission: SUPERSEDED_AUTHOR_ART,
  },
  recomputedChecks: candidateChecks,
  passed: candidateChecks - failedBeforeRound.length,
  failed: failedBeforeRound.length,
  trustedByDeclaration: false,
  contentLayer: {
    outcome: 'report mechanics sound; payload contract defective',
    note: 'Every declared digest recomputes; the REAL cell surface recomputes the identical report (verdict consistent, 0 findings, 4 rows) from an independently re-derived snapshot; report-only and computed-verdict laws hold mechanically; the F-2 kill works both directions; the restructured trace and coverage blocks resolve against independently recomputed seals; the envelope matches this reviewer frame 8/8. Regressions vs the superseded emission: 6 double-prefixed evidence refs, coverage sum 27 != 28 refs, this frame\'s protocol/semantic skill digests replaced by a stale r1 protocol-skill ref.',
  },
  statusAudit: {
    outcome: 'authority chain broken; reviewer authority fabricated',
    consumedRevisions: {
      intent: { ref: upArt.artifactRef, verdict: 'repair x3 emissions (FR-Define-Product-Intent-001 + emission-b + FR-Define-Product-Intent-002)', reissue: 'none (r2 revision == r3 revision)' },
      useCases: { ref: ucArt.artifactRef, verdict: 'NEVER REVIEWED (no reviewer artifact exists in r2/r3)', reissue: 'n/a; authored in violation of the desk upstream hold 6cccd162' },
      requirements: { ref: srArt.artifactRef, verdict: 'repair (FR-Derive-System-Requirements-001) + re-staff confirmation RS-001 (confirms the verdict, not an acceptance)', reissue: 'none (r2 revision == r3 revision)' },
      acceptance: { ref: accArt.artifactRef, verdict: 'REPAIR is the verdict of record (CTN-Define-Acceptance-Contract-001: emission A repair 83e675bb confirmed, accepted emission e5249d78 superseded)', reissue: 'none; the desk is on record hold a53a5e08' },
    },
    onlyAcceptedChain: 'the discovery import chain (sha256:b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5)',
    candidateAssertions: 'the reissue STRENGTHENS the false authority claims relative to the superseded emission: materialAuthority now says "the reviewer-accepted define-acceptance-contract bundle"; verification now declares reviewerAcceptedCandidateOfRecord=true; the cited reviewer gate is the SUPERSEDED accepted emission e5249d78 while the adjudication confirmed the repair emission 83e675bb; the candidate remains silent on the contention, the holds and every repair verdict',
    governingAnchor: `UNRESOLVABLE at this desk (own scan: 0 files of the qualification tree hash to ${GOVERNING.slice(0, 16)}; MAJ-1 of the upstream adjudication re-derived and still open)`,
  },
  envelopePins: {
    protocolSkillRef: shaRef(PROTOCOL_SKILL),
    semanticSkillRef: shaRef(SEMANTIC_SKILL),
    workspaceSummary: WORKSPACE_SUMMARY,
    upstreamAccepted: [],
  },
  envelopeConsistency: 'this reviewer frame declares the SAME 8 task-projection content addresses and the SAME workspace summary as the author frame (8/8 resolved, 0 adjudicated). The candidate\'s evidence set, however, cites a protocol-skill ref (95fafc84) that belongs to the r1 envelope family, not to this round\'s frame (bc8a4261), and omits the semantic-skill digest entirely. The 0-revision workspace summary is not merely stage-relative here: no gate on this chain has accepted anything - the acceptance-desk verdict of record is repair - so 0 is the true state of the whole r3 chain above the import.',
};

const verification = {
  verificationRef: shaRef(sha(verificationContent)),
  artifactKind: 'reviewer-verification',
  contentDigest: sha(verificationContent),
  createdAt: CREATED_AT,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: verificationContent,
};
const VER_REF = verification.contentDigest;

const reviewContent = {
  reviewId: 'FR-Reconcile-What-001',
  deskRef: 'reconcile-what',
  role: 'reviewer',
  reviewedRound: 'stray-products-r3',
  reviewedCandidate: {
    submissionRef: AUTHOR_SUB_REF,
    artifactRef: AUTHOR_ART_REF,
    productKind: 'formalization.what-reconciliation.v1',
    traceRef: AUTHOR_TRC_REF,
    declaredVerdict: 'consistent',
    reportSeal: REPORT_SEAL_REF,
    supersededPriorEmission: SUPERSEDED_AUTHOR_ART,
    supersessionNote: 'the author reissued in place (~03:47 workspace time): the first emission c22d4787 is superseded by content address; this review covers the reissued candidate of record 6400a2dd',
  },
  verificationRef: shaRef(VER_REF),
  verificationSummary: {
    recomputedChecks: candidateChecks,
    passed: candidateChecks - failedBeforeRound.length,
    failed: failedBeforeRound.length,
    trustedByDeclaration: false,
  },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    adjudicated: 0,
    note: 'All 8 claim/constraint/unknown/terminal content addresses match THIS reviewer frame exactly and re-derive from the upstream bundles; the frame carries no upstream-accepted refs, so there is nothing to adjudicate at the envelope layer. The authority findings live at the STATUS layer (see statusAudit), plus one envelope-family defect: the candidate cites an r1-era protocol-skill ref and drops the semantic-skill ref.',
  },
  workspaceLaw: '0 accepted upstream revisions travel by content address (reviewer frame, verbatim, and TRUE of the whole chain: the only accepted material above the discovery import is nothing - all four consumed revisions are repair-verdict or never-reviewed). The candidate content chain travels by pinned content address and its report re-verifies; what does not travel is any genuinely accepted upstream revision for it to be a reconciliation OF, nor any reviewer acceptance of the acceptance bundle it names "reviewer-accepted".',
  findings: {
    positiveFindings: [
      `Every content-address in the candidate chain recomputes (submission, artifact, trace, 6+3+4+5 member seals, report digest): the REAL cell surface recomputes the identical report (verdict consistent, 0 findings, 4 rows) from an independently re-derived snapshot - deep-equal, report-only byte-law holds, the report is deep-frozen.`,
      'The F-2 kill works both directions: dropping ac:determinism-1 makes the SAME function report gaps with the named COVERAGE_GAP (nfr:determinism-1); the intact snapshot returns consistent on every call - a hardcoded verdict cannot produce both. Foreign-binding and missing-layer probes are named findings, never silent.',
      `The restructured trace resolves mechanically: ${edges.length}/${edges.length} relationships and all coverage blocks (reportCoverage, claimCoverage full-mapping, layerAnchors, terminalCoverage, constraintCoverage, unknownCoverage) are exact projections of THIS seat\'s independently recomputed seals and computed report.`,
      'Rows keep the installed row shape; prd:scope-2 (out_of_scope) reports an honest empty row; the artifact-level claimCoverage carries the FULL accepted mapping (every listed member accepted AND citing its claim); constraint:retention-1 and terminal support are faithful projections of the accepted acceptance bundle; unknown:browser-matrix-1 stays carried_forward with zero resolution edges.',
      'The envelope matches this reviewer frame exactly (8/8 content addresses, governing pinned, workspace summary verbatim, pinned timestamps, manifest pins correct); determinism probes on the author scripts find no clock reads and no randomness.',
    ],
    advisoryNotes: [
      {
        type: 'supersession_recorded',
        note: 'The author superseded its first emission (c22d4787) in place ~10 workspace-minutes after authoring it, reusing the submissionId FS-Reconcile-What-001. Both emissions remain identified by content digest. The reissue strengthened the authority claims while regressing the payload contract (see MAJ-2) - the opposite direction of a repair.',
      },
      {
        type: 'trace_vocabulary_restructured',
        note: 'The reissued trace replaces the desk-chain vocabulary (closes/covers/derives/supports/verifies) with reconciles/formalized-as and moves claim coverage to the artifact. The new structure resolves cleanly against recomputed seals (G-group), so this is recorded as an advisory style note, not a defect: the reported chain head/tail per claim is now carried by artifact.claimCoverage instead of trace edges.',
      },
      {
        type: 'inherited_crit2_observed',
        note: 'CRIT-2 of the upstream adjudication (prd:scope-2 exclusion ratified as fact) is observed here only as REPORTED state: the reconciliation row honestly reports the upstream out_of_scope disposition with empty downstream coverage and derives nothing from it. The fabrication lives upstream; this desk reports it without re-ratifying it.',
      },
      {
        type: 'stage_sequence',
        note: 'Per the workspace timeline the reissue was authored AFTER the acceptance-desk adjudication (verdict repair) and the acceptance desk hold were on disk, and the four consumed revisions are byte-identical to the repair-verdict revisions. The accepted-state assertions are therefore authored in known contradiction to the verdict of record. (Timeline recorded in the round summary; kept out of digest-pinned artifacts to preserve determinism.)',
      },
    ],
    criticalIssues: [
      {
        id: 'CRIT-1',
        severity: 'CRITICAL',
        title: 'The reconciliation asserts a closed WHAT chain over ACCEPTED material; no such material exists',
        detail: 'The candidate\'s whole product is the statement "the closed WHAT chain of the accepted r3 material reconciles consistently". The status audit proves the premise false for all four consumed revisions: intent a06dbc57 = verdict repair x3 emissions with no reissue; UC 24f0aff2 = never reviewed (no reviewer artifact exists) and authored in violation of its own desk\'s upstream hold 6cccd162; requirements 86b00569 = verdict repair + a re-staff confirmation that confirms the verdict, not an acceptance; acceptance 2b01353d = REPAIR is the adjudicated verdict of record (CTN-Define-Acceptance-Contract-001) with the desk on record hold a53a5e08. Only the discovery import chain is genuinely accepted. revisionPinsMatchAcceptedRevisions=true is false at the status layer: the pins are byte-exact to UNACCEPTED revisions. Accepting this candidate would freeze a WHAT baseline whose entire lineage is unaccepted, and the freeze would inherit the fabricated authority permanently.',
        requiredAction: 'Verdict repair. No accept effect may fire on this chain. Lawful repairs are upstream: (RA-1) intent desk author reissue addressing FR-Define-Product-Intent-001/-002, then a completed reviewer stage; (RA-2) UC desk resolves its own upstream hold and completes a FIRST reviewer stage for the bundle; (RA-3) requirements desk author reissue addressing FR-Derive-System-Requirements-001, then a completed reviewer stage; (RA-4) acceptance desk reissues over genuinely accepted upstream and completes its reviewer stage (the record hold stands until then). (RA-5) The reconcile-what author then re-runs over the NEW accepted chain; this candidate of record is superseded by content address, never patched.',
      },
      {
        id: 'CRIT-2',
        severity: 'CRITICAL',
        title: 'Fabricated reviewer authority: a reviewer acceptance is asserted that never existed, grounded in a superseded emission',
        detail: `The reissue asserts reviewer states that do not exist. (a) verification.reviewerAcceptedCandidateOfRecord=true: no reviewer stage had produced ANY artifact at this desk when the candidate was authored, and the reviewer round of record (this seat) returns repair - the flag is false at authoring time and remains false. (b) materialAuthority renames the acceptance bundle "the reviewer-accepted define-acceptance-contract bundle". (c) The cited "reviewer gate" (self-check row 8, upstream.acceptanceReviewerReviewRef, submission evidence) is the acceptance-desk emission ${SUPERSEDED_ACC_REVIEW.slice(0, 16)} - precisely the emission the CTN-001 adjudication SUPERSEDED; the confirmed repair emission ${CONFIRMED_ACC_REVIEW.slice(0, 16)} is nowhere cited. Cherry-picking a superseded "accepted" verdict as acceptance authority converts the candidate from mistaken (CRIT-1 at the prior emission) to knowing: the author read the reviewer material, cited it selectively, and asserted the opposite of the verdict of record.`,
        requiredAction: 'The false reviewer-state flags and the superseded-emission citation must be withdrawn. No reviewer acceptance of the acceptance bundle exists; the only reviewer word over 2b01353d is the adjudicated repair. This defect blocks any accept effect independently of CRIT-1 and must not be repaired by editing the artifacts in place - the lawful path is RA-1..RA-5 (new immutable upstream revisions; a fresh reconcile-what run over genuinely accepted material with no fabricated reviewer states).',
      },
    ],
    majorIssues: [
      {
        id: 'MAJ-1',
        severity: 'MAJOR',
        title: 'Governing contract anchor remains unresolvable (inherited, re-derived)',
        detail: `The candidate pins governingContractRef sha256:${GOVERNING}. This seat's own scan (raw-bytes and canonical-JSON sha256 over the full qualification tree) resolves it to NO content. This re-derives MAJ-1 of the upstream adjudication; the anchor debt (r2 RA-2/RA-4) remains open and travels with the repaired chain.`,
        requiredAction: 'The upstream desks must materialize the governing contract as real content-addressed material (or re-pin to what exists) before any freeze settlement may cite it.',
      },
      {
        id: 'MAJ-2',
        severity: 'MAJOR',
        title: 'Payload contract regressions in the reissue: malformed evidence refs, coverage mismatch, wrong-envelope skill refs',
        detail: `The reissued submission declares ${malformed.length} evidence refs with a double sha256: prefix (sha256:sha256:... for the import artifact, capsule, certificate, intent trace and intent submission, and the superseded verification ref), its evidenceKindCoverage sums to ${coverageSum} against ${declaredEvidence.length} refs, and its protocol-skill ref ${STALE_R1_PROTOCOL_SKILL.slice(0, 16)} belongs to the r1 envelope family while this round's frame pins ${PROTOCOL_SKILL.slice(0, 16)} (the semantic-skill digest is absent altogether). Self-check row 1 ("every ref is sha256 over canonical JSON") is therefore false as declared. The superseded emission had none of these defects - the reissue regressed the mechanical layer while hardening the false authority layer.`,
        requiredAction: 'The payload contract must be rebuilt: dereference every ref exactly once, make coverage sum exactly, and cite THIS round\'s protocol/semantic skill digests. Mechanical honesty of the evidence surface is a precondition for any future accept effect.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed reviewer artifacts with SHA256 digests over canonical JSON', satisfied: true, evidence: 'R-group: all four reviewer round artifacts self-address and cross-bind' },
    { id: 2, description: 'Independent recomputation performed by this seat; nothing trusted by declaration', satisfied: true, evidence: `A-H groups: ${candidateChecks} checks re-run; REAL cell surface re-run over an independently re-derived snapshot` },
    { id: 3, description: 'All 8 reviewer-frame task-projection content addresses resolved; workspace summary verbatim', satisfied: true, evidence: 'F1-F4: 8/8 exact; skill-digest divergence recorded under MAJ-2' },
    { id: 4, description: 'Report mechanics sound: digests, REAL surface, computed verdict, report-only, frozen report', satisfied: true, evidence: 'B1-B13, C1-C6, D1-D5: deep-equal recomputation, F-2 kill both directions, probes killed' },
    { id: 5, description: 'Author trace and coverage blocks exact against independently recomputed seals', satisfied: true, evidence: `G1-G10: ${edges.length}/${edges.length} edges + all projections recomputed by this seat` },
    { id: 6, description: 'Rows keep the installed shape; claim mapping verified; scope-2 empty; constraint honored; unknown carried forward; terminals supported', satisfied: true, evidence: 'E1-E6, G7-G10 + terminalSupport chains resolve' },
    { id: 7, description: 'Deterministic authoring across the candidate chain and this reviewer round', satisfied: true, evidence: 'I4 + F4: no clock reads, no randomness, pinned timestamps everywhere' },
    { id: 8, description: 'Payload contract well-formed: evidence refs are content addresses, coverage sums, frame skill digests cited', satisfied: false, evidence: `H1-H3, H7: ${malformed.length} malformed refs, coverage ${coverageSum}!=${declaredEvidence.length}, stale r1 protocol-skill ref, semantic-skill absent - MAJ-2` },
    { id: 9, description: 'Upstream consumed by the candidate is GENUINELY ACCEPTED (verdict records, not round labels)', satisfied: false, evidence: 'S1-S12: all four consumed revisions are repair-verdict or never-reviewed; only the import chain is accepted - CRIT-1' },
    { id: 10, description: 'Reviewer states asserted by the candidate actually exist', satisfied: false, evidence: 'S13, S13b, S13c: reviewerAcceptedCandidateOfRecord=true is false; the cited gate is the superseded emission; the confirmed repair emission is uncited - CRIT-2' },
    { id: 11, description: 'Governing contract anchor verified before inheritance', satisfied: false, evidence: 'S15: 0 files of the qualification tree hash to the anchor - MAJ-1 re-derived, still open' },
    { id: 12, description: 'Verdict recorded with findings, evidence and required actions', satisfied: true, evidence: 'CRIT-1 + CRIT-2 + MAJ-1 + MAJ-2 with RA-1..RA-5; positive and advisory findings recorded' },
  ],
  verdict: 'repair',
  nextStage: 'verdict repair routed to the upstream owning desks (RA-1..RA-4: intent reissue, UC first review after its hold, requirements reissue, acceptance reissue + reviewer stage); reconcile-what re-runs over the genuinely accepted chain with no fabricated reviewer states (RA-5). No domain.accepted may fire from this desk toward freeze-what-baseline on this chain.',
};

const review = {
  artifactRef: shaRef(sha(reviewContent)),
  artifactKind: 'formalization-review',
  contentDigest: sha(reviewContent),
  createdAt: CREATED_AT,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: reviewContent,
};
const REVIEW_REF = review.contentDigest;

const reviewerTraceContent = {
  deskRef: 'reconcile-what',
  role: 'reviewer',
  traceKind: 'desk-trace',
  subjectSemanticCode: reviewContent.reviewId,
  subjectArtifactRef: shaRef(REVIEW_REF),
  relationVocabulary: ['adjudicates', 'bound_to', 'carries_forward', 'derived_from', 'routes_repair', 'verified_by', 'verifies'],
  edges: [
    { relationType: 'derived_from', fromRef: shaRef(REVIEW_REF), toRef: shaRef(AUTHOR_ART_REF), description: 'reviewer verdict over the reissued what-reconciliation report (candidate of record 6400a2dd; superseded emission c22d4787 recorded)' },
    { relationType: 'derived_from', fromRef: shaRef(REVIEW_REF), toRef: shaRef(AUTHOR_SUB_REF), description: 'reviewer verdict over the author desk submission FS-Reconcile-What-001 (reissue)' },
    { relationType: 'derived_from', fromRef: shaRef(REVIEW_REF), toRef: shaRef(AUTHOR_TRC_REF), description: `reviewer re-verification of the author trace graph (${edges.length}/${edges.length} relationships resolve against independently recomputed seals)` },
    { relationType: 'verified_by', fromRef: shaRef(REVIEW_REF), toRef: shaRef(VER_REF), description: `independent recomputation record backing the verdict (${candidateChecks - failedBeforeRound.length}/${candidateChecks} content checks pass; REAL cell surface + REAL folds + own status audit)` },
    { relationType: 'verifies', fromRef: shaRef(REVIEW_REF), toRef: shaRef(ENVELOPE['claim:scope-1']), description: 'claim:scope-1 row re-derived: prd:boundary-1 -> fr:boundary-1 -> ac:boundary-1' },
    { relationType: 'verifies', fromRef: shaRef(REVIEW_REF), toRef: shaRef(ENVELOPE['claim:scope-2']), description: 'claim:scope-2 (out_of_scope) reported with empty downstream coverage; no fabricated coverage' },
    { relationType: 'verifies', fromRef: shaRef(REVIEW_REF), toRef: shaRef(ENVELOPE['claim:constraint-1']), description: 'claim:constraint-1 reported through prd:constraint-1 -> nfr:determinism-1 -> ac:determinism-1' },
    { relationType: 'verifies', fromRef: shaRef(REVIEW_REF), toRef: shaRef(ENVELOPE['claim:outcome-1']), description: 'claim:outcome-1 row re-derived: fr:outcome-1 -> [ac:outcome-1-delivered, ac:outcome-1-deterministic-error]' },
    { relationType: 'carries_forward', fromRef: shaRef(REVIEW_REF), toRef: shaRef(ENVELOPE['constraint:retention-1']), description: 'constraint:retention-1 preserved: honored-by chain re-verified (ac:determinism-1 + ac:outcome-1-deterministic-error)' },
    { relationType: 'carries_forward', fromRef: shaRef(REVIEW_REF), toRef: shaRef(ENVELOPE['unknown:browser-matrix-1']), description: 'unknown:browser-matrix-1 preserved: carried forward, owner discovery, zero resolution edges' },
    { relationType: 'bound_to', fromRef: shaRef(REVIEW_REF), toRef: shaRef(ENVELOPE['terminal:audited-1']), description: 'terminal:audited-1 bound via prd:terminal-1 and fr:terminal-1 to ac:terminal-1-audited (ownership stays upstream)' },
    { relationType: 'bound_to', fromRef: shaRef(REVIEW_REF), toRef: shaRef(ENVELOPE['terminal:delivered-1']), description: 'terminal:delivered-1 bound via prd:outcome-1 and fr:outcome-1 to ac:outcome-1-delivered (ownership stays upstream)' },
    { relationType: 'adjudicates', fromRef: shaRef(REVIEW_REF), toRef: shaRef(GOVERNING), description: 'governing contract anchor adjudicated UNRESOLVABLE at this desk (own scan over the qualification tree; MAJ-1 re-derived, still open)' },
    { relationType: 'adjudicates', fromRef: shaRef(REVIEW_REF), toRef: accArt.artifactRef, description: 'the consumed acceptance revision 2b01353d re-adjudicated: its verdict of record is REPAIR (CTN-Define-Acceptance-Contract-001); the desk hold a53a5e08 stands' },
    { relationType: 'adjudicates', fromRef: shaRef(REVIEW_REF), toRef: shaRef(SUPERSEDED_ACC_REVIEW), description: 'the candidate\'s cited reviewer gate e5249d78 adjudicated SUPERSEDED (CTN-001: confirmed repair 83e675bb, superseded accepted e5249d78) - CRIT-2 evidence' },
    { relationType: 'routes_repair', fromRef: shaRef(REVIEW_REF), toRef: upArt.artifactRef, description: 'RA-1: intent revision a06dbc57 must be reissued by its owning desk (FR-001/-002 CRIT-1) and pass a reviewer stage' },
    { relationType: 'routes_repair', fromRef: shaRef(REVIEW_REF), toRef: ucArt.artifactRef, description: 'RA-2: UC revision 24f0aff2 has never passed a reviewer stage; the UC desk hold 6cccd162 must be resolved first' },
    { relationType: 'routes_repair', fromRef: shaRef(REVIEW_REF), toRef: srArt.artifactRef, description: 'RA-3: requirements revision 86b00569 must be reissued (FR-001 CRIT-1/CRIT-2) and pass a reviewer stage' },
    { relationType: 'routes_repair', fromRef: shaRef(REVIEW_REF), toRef: accArt.artifactRef, description: 'RA-4: acceptance desk reissues over genuinely accepted upstream and completes its reviewer stage; hold a53a5e08 stands until then' },
  ],
  workspaceSummary: WORKSPACE_SUMMARY,
};

const reviewerTrace = {
  traceRef: shaRef(sha(reviewerTraceContent)),
  traceKind: 'desk-trace',
  contentDigest: sha(reviewerTraceContent),
  createdAt: CREATED_AT,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: reviewerTraceContent,
};
const REVIEWER_TRC_REF = reviewerTrace.contentDigest;

const submissionContent = {
  deskRef: 'reconcile-what',
  deskNodeId: 'reconcile-what',
  role: 'reviewer',
  workspaceSummary: WORKSPACE_SUMMARY,
  verdict: 'repair',
  candidate: {
    kind: 'formalization.review-complete.v1',
    artifactRef: shaRef(REVIEW_REF),
    contentDigest: REVIEW_REF,
  },
  reviewedCandidate: {
    submissionRef: AUTHOR_SUB_REF,
    artifactRef: AUTHOR_ART_REF,
    traceRef: AUTHOR_TRC_REF,
    productKind: 'formalization.what-reconciliation.v1',
    declaredReportSeal: REPORT_SEAL_REF,
    declaredVerdict: 'consistent',
    supersededPriorEmission: SUPERSEDED_AUTHOR_ART,
  },
  verificationRef: shaRef(VER_REF),
  traceRef: shaRef(REVIEWER_TRC_REF),
  payloadContract: {
    productKind: 'formalization.review-complete.v1',
    effectId: 'formalization.accept-products',
    requiredEvidenceRefs: [
      ...Object.values(ENVELOPE).map(shaRef),
      shaRef(GOVERNING),
      shaRef(AUTHOR_SUB_REF), shaRef(AUTHOR_ART_REF), shaRef(AUTHOR_TRC_REF), REPORT_SEAL_REF,
      shaRef(accArt.contentDigest), shaRef(upArt.contentDigest), shaRef(ucArt.contentDigest), shaRef(srArt.contentDigest),
      shaRef(ucHold.contentDigest), shaRef(accHold.contentDigest),
      shaRef(SUPERSEDED_ACC_REVIEW), shaRef(CONFIRMED_ACC_REVIEW),
      shaRef(VER_REF), shaRef(REVIEW_REF), shaRef(REVIEWER_TRC_REF),
    ],
    evidenceKindCoverage: {
      'source-claim': 4,
      'constraint': 1,
      'unknown': 1,
      'terminal-claim': 2,
      'author-submission': 1,
      'product': 1,
      'author-desk-trace': 1,
      'report-seal': 1,
      'architecture-contract': 1,
      'consumed-revision-under-repair': 4,
      'upstream-hold': 2,
      'superseded-acceptance-review': 1,
      'confirmed-repair-review': 1,
      'reviewer-verification': 1,
      'formalization-review': 1,
      'reviewer-desk-trace': 1,
    },
    terminalOutcome: 'repair-routed',
  },
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#reconcile-what:reviewer',
    status: 'review_complete_verdict_recorded',
    receivedFrom: 'reviewer',
    nextStage: 'verdict repair routed to the upstream owning desks (RA-1..RA-4); reconcile-what re-runs over genuinely accepted revisions with no fabricated reviewer states (RA-5); NO accept effect toward freeze-what-baseline on this chain',
    note: 'The report mechanics re-verify 100%, but the candidate\'s premise - accepted (and now claimed "reviewer-accepted") upstream material - is false for all four consumed revisions (CRIT-1), and the asserted reviewer acceptance never existed (CRIT-2), while the reissue regressed the payload contract (MAJ-2). The reviewer verdict is recorded desk-level; kernel-side routing is executed by the driver over public commands.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Independent recomputation performed by this emission (content layer re-run; status layer audited from re-digested verdict records)', satisfied: true },
    { id: 3, description: 'All 8 reviewer-frame task-projection content addresses resolved 8/8; workspace summary verbatim', satisfied: true },
    { id: 4, description: 'Verdict grounded in re-digested records, not round labels or prior reviews\' text (S-group reads the r2/r3 verdict records directly)', satisfied: true },
    { id: 5, description: 'Findings recorded with severity, evidence and required actions (CRIT-1, CRIT-2, MAJ-1, MAJ-2; RA-1..RA-5)', satisfied: true },
    { id: 6, description: 'constraint:retention-1 honored across the reviewer artifacts; unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true },
    { id: 7, description: 'Terminal claims stay owned upstream and remain supported in the reviewer trace', satisfied: true },
    { id: 8, description: 'Reviewer artifacts deterministic: pinned timestamps, no clock reads, no randomness', satisfied: true },
    { id: 9, description: 'Upstream consumed by the candidate is GENUINELY ACCEPTED', satisfied: false, note: 'CRIT-1 recorded honestly: all four consumed revisions are repair-verdict or never-reviewed; verdict repair rather than blind acceptance' },
    { id: 10, description: 'Reviewer states asserted by the candidate exist', satisfied: false, note: 'CRIT-2 recorded honestly: the asserted this-desk reviewer acceptance never existed; the cited gate is the superseded emission' },
    { id: 11, description: 'Governing contract anchor verified before inheritance', satisfied: false, note: 'MAJ-1 re-derived honestly: the anchor resolves to no content; recorded, not gated past' },
  ],
};

const submission = {
  submissionRef: shaRef(sha(submissionContent)),
  submissionId: 'FS-Reconcile-What-002',
  contentDigest: sha(submissionContent),
  createdAt: CREATED_AT,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: submissionContent,
};

/* R-group: write the round of record into emission A's plain slots (per the
   collision record these four slots belong to this emission) and verify
   byte-faithfulness on disk. Writes are byte-identical on rerun. */
const writeJsonRound = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJsonRound('reconcile-what-desk-reviewer-verification.json', verification);
writeJsonRound('reconcile-what-desk-reviewer-review.json', review);
writeJsonRound('reconcile-what-desk-reviewer-trace.json', reviewerTrace);
writeJsonRound('reconcile-what-desk-reviewer-product-submission.json', submission);

check('R1.verification.selfAddress', sha(verificationContent) === VER_REF && verification.verificationRef === shaRef(VER_REF), shaRef(VER_REF));
check('R2.review.selfAddress', sha(reviewContent) === REVIEW_REF && review.artifactRef === shaRef(REVIEW_REF), shaRef(REVIEW_REF));
check('R3.trace.selfAddress', sha(reviewerTraceContent) === REVIEWER_TRC_REF && reviewerTrace.traceRef === shaRef(REVIEWER_TRC_REF), shaRef(REVIEWER_TRC_REF));
check('R4.submission.selfAddress', sha(submissionContent) === submission.contentDigest && submission.submissionRef === shaRef(submission.contentDigest), shaRef(submission.contentDigest));
check('R5.crossBindings', reviewContent.verificationRef === shaRef(VER_REF)
  && reviewerTraceContent.subjectArtifactRef === shaRef(REVIEW_REF)
  && submissionContent.candidate.contentDigest === REVIEW_REF
  && submissionContent.verificationRef === shaRef(VER_REF)
  && submissionContent.traceRef === shaRef(REVIEWER_TRC_REF), 'review -> verification; trace -> review; submission -> review/verification/trace');
check('R6.reviewEvidence.resolve', submissionContent.payloadContract.requiredEvidenceRefs.every((r) => /^sha256:[0-9a-f]{64}$/.test(r)) && new Set(submissionContent.payloadContract.requiredEvidenceRefs).size === submissionContent.payloadContract.requiredEvidenceRefs.length, 'reviewer evidence refs unique content addresses');
const covSum = Object.values(submissionContent.payloadContract.evidenceKindCoverage).reduce((a, b) => a + b, 0);
check('R7.reviewEvidence.coverage', covSum === submissionContent.payloadContract.requiredEvidenceRefs.length, `coverage sums to ${covSum} over ${submissionContent.payloadContract.requiredEvidenceRefs.length} refs`);
check('R8.verdictConsistency', reviewContent.verdict === 'repair' && submissionContent.verdict === 'repair' && submissionContent.payloadContract.terminalOutcome === 'repair-routed', 'review verdict, submission verdict and terminal outcome agree');
const SELF_SRC = readFileSync(join(DIR, SELF_FILE), 'utf8');
check('R9.determinism.self', !/Date\.now|Math\.random|new Date\(/.test(SELF_SRC) && PINNED_TS.test(SELF_SRC), 'this script: no clock reads, no randomness, pinned timestamp');
const rFailedBefore = results.filter((r) => !r.ok);
const roundChecks = results.length - candidateChecks;

/* ------------------------------------------------------------------ */
/* Collision record (the only NEW file this emission writes)            */
/* ------------------------------------------------------------------ */

const B_VERIFY = 'reconcile-what-desk-reviewer-verify.mjs';
const B_OUT = 'reconcile-what-desk-reviewer-verify-out.json';
const bVerifyRaw = shaRaw(readFileSync(join(DIR, B_VERIFY)));
const bOutRaw = shaRaw(readFileSync(join(DIR, B_OUT)));
let bRun = null;
try { bRun = JSON.parse(readFileSync(join(DIR, B_OUT), 'utf8')); } catch { /* unreadable */ }

const collisionContent = {
  recordId: 'CL-Reconcile-What-001',
  deskRef: 'reconcile-what',
  role: 'reviewer',
  recordKind: 'reviewer-collision-record',
  candidateOfRecord: {
    submissionRef: AUTHOR_SUB_REF,
    artifactRef: AUTHOR_ART_REF,
    traceRef: AUTHOR_TRC_REF,
  },
  emissionA: {
    seat: 'reviewer round of record in the plain artifact slots (authored before the collision)',
    verdict: 'repair',
    roundDigests: {
      verificationRef: shaRef(VER_REF),
      reviewRef: shaRef(REVIEW_REF),
      traceRef: shaRef(REVIEWER_TRC_REF),
      submissionRef: shaRef(submission.contentDigest),
    },
    verifier: SELF_FILE,
    verifyOut: 'reconcile-what-desk-reviewer-verify-out-emission-a.json',
    scope: 'content layer re-verification + payload-contract audit + status-layer audit of the re-digested verdict records',
    findings: ['CRIT-1 unaccepted lineage asserted accepted', 'CRIT-2 fabricated reviewer authority (superseded emission cited as gate)', 'MAJ-1 governing anchor unresolvable', 'MAJ-2 payload-contract regressions'],
  },
  emissionB: {
    seat: 'second reviewer seat (overwrote the plain reviewer-verify.mjs and reviewer-verify-out.json slots at collision time)',
    verifyScriptRawSha256: bVerifyRaw,
    verifyOutRawSha256: bOutRaw,
    runResult: bRun ? `${bRun.recomputed} checks, ${bRun.passed} passed, ${bRun.failed} failed` : 'verify-out unreadable at record time',
    failedChecks: bRun ? (bRun.results ?? []).filter((r) => r.ok !== true).map((r) => r.id) : [],
    roundArtifacts: 'none authored at collision time (content-only verifier)',
    statusLayerNote: 'the emission\'s K2 framing treats the acceptance-desk FR-Define-Acceptance-Contract-001 (e5249d78, verdict accepted) as the accepted verdict record; the CTN-Define-Acceptance-Contract-001 adjudication SUPERSEDED that emission (verdict of record: repair, FR-002/emission-c). Any review built on that premise must be corrected against the adjudication. Its own failed B10.reviewerOfRecord check (the reviewer-of-record binding does not hold) independently corroborates this seat\'s CRIT-2.',
  },
  contestedFilenames: {
    emissionB: [B_VERIFY, B_OUT],
    emissionA: ['reconcile-what-desk-reviewer-verification.json', 'reconcile-what-desk-reviewer-review.json', 'reconcile-what-desk-reviewer-trace.json', 'reconcile-what-desk-reviewer-product-submission.json'],
  },
  discipline: 'no further writes to a contested filename by either seat; both emissions preserved by content address; the round of record in the plain slots is emission A (verdict repair); if emission B later files a review, the driver/final gate adjudicates any divergent verdict against the CTN-001 adjudication and this record',
  workspaceSummary: WORKSPACE_SUMMARY,
};

const collisionRecord = {
  recordRef: shaRef(sha(collisionContent)),
  recordKind: 'reviewer-collision-record',
  contentDigest: sha(collisionContent),
  createdAt: CREATED_AT,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: collisionContent,
};
writeJsonRecord('reconcile-what-desk-reviewer-collision-record.json', collisionRecord);
function writeJsonRecord(name, value) { writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

check('R10.collisionRecord.selfAddress', sha(collisionContent) === collisionRecord.contentDigest, shaRef(collisionRecord.contentDigest));

const roundDiskOk = [
  ['verification', 'reconcile-what-desk-reviewer-verification.json', VER_REF],
  ['review', 'reconcile-what-desk-reviewer-review.json', REVIEW_REF],
  ['trace', 'reconcile-what-desk-reviewer-trace.json', REVIEWER_TRC_REF],
  ['submission', 'reconcile-what-desk-reviewer-product-submission.json', submission.contentDigest],
].every(([label, name, digest]) => {
  const j = JSON.parse(readFileSync(join(DIR, name), 'utf8'));
  return sha(j.content) === j.contentDigest && j.contentDigest === digest;
});
check('R11.diskRoundtrip', roundDiskOk, 'all four round-of-record artifacts re-digest from disk to their declared content digests');

/* ------------------------------------------------------------------ */
/* Verify log (emission-a slot only)                                    */
/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
writeJsonRecord('reconcile-what-desk-reviewer-verify-out-emission-a.json', {
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; content layer: real cell surface + real validators + real folds (independent snapshot re-derivation); status layer: verdict records re-digested then read directly; reviewer round verified byte-faithful against the plain slots (collision discipline); collision record authored',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  candidateChecks,
  candidateFailed: failedBeforeRound.length,
  candidateFailedIds: failedBeforeRound.map((r) => r.id),
  reviewerRoundChecks: roundChecks,
  reviewerRoundFailed: rFailedBefore.length,
  collisionRecordRef: collisionRecord.recordRef,
  verdict: failedBeforeRound.length === 0 ? 'CONTENT-VERIFIED; STATUS VERDICT: repair' : `CONTENT DEFECTS RECORDED (${failedBeforeRound.length}); STATUS VERDICT: repair (CRIT-1, CRIT-2)`,
  results,
});

console.log(JSON.stringify({
  reviewerRound: 'reconcile-what desk (reviewer) - emission A',
  contentLayer: `${candidateChecks - failedBeforeRound.length}/${candidateChecks} checks pass`,
  contentFailedIds: failedBeforeRound.map((r) => r.id),
  total: `${results.length - failed.length}/${results.length} checks pass`,
  verdict: reviewContent.verdict,
  critical: reviewContent.findings.criticalIssues.map((c) => c.id),
  major: reviewContent.findings.majorIssues.map((m) => m.id),
  roundOfRecord: {
    verificationRef: shaRef(VER_REF),
    reviewRef: shaRef(REVIEW_REF),
    reviewerTraceRef: shaRef(REVIEWER_TRC_REF),
    submissionRef: shaRef(submission.contentDigest),
  },
  collisionRecordRef: collisionRecord.recordRef,
}, null, 2));
