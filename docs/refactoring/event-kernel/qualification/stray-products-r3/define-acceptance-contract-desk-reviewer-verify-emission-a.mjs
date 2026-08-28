/**
 * define-acceptance-contract desk (reviewer) - independent recomputation
 * evidence for the r3 author candidate of record
 * (submission FS-Define-Acceptance-Contract-001, artifact
 * SR-Define-Acceptance-Contract-001 sha256:2b01353d..., trace
 * sha256:2835aea3...).
 *
 * EMISSION A collision-free copy: the canonical reviewer filenames were
 * overwritten in place by a concurrent writer mid-review (2026-08-28
 * 03:14-03:15); this -emission-a copy preserves the evidence generator of
 * the first reviewer emission, which produced
 * VV-Define-Acceptance-Contract-001 (sha256:58632e555ab648f9039a6d4445ed0224e1ce10d279d41b88424e31c2ddf90510),
 * FR-Define-Acceptance-Contract-001 (sha256:000a871aa1efa2e7ceb6d94bb3d711b2739a4c153c1039608a892d3bfddb09a3),
 * RT-Define-Acceptance-Contract-001 (sha256:95e6cc350f873034aae3514a8d9df1866fb383447d784af02f36cff998b8a289)
 * and FS-Define-Acceptance-Contract-002 (sha256:cd8d55485d6d594de829a7c67974f1726656f959815ec4b4c05deae3f2679b60,
 * which also survives under its canonical filename). See the collision
 * record for the full contention (emission A verdict: repair; the
 * concurrent emission's canonical FR records accepted).
 *
 * Frozen kernel rule: src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Nothing is trusted by declaration:
 *   - EVERY declared digest of the candidate recomputes (submission,
 *     artifact, trace, 5 criterion seals, 5 verifiable-statement seals).
 *   - Upstream chain re-verified through the REAL surfaces: PRD member
 *     seals via the REAL kernel WP03 validator + REAL acceptedIntentSetOf
 *     fold; UC seals via the REAL uc validator + REAL fold; the accepted
 *     requirements bundle re-sealed against its recomputed WP03 universe.
 *   - The bundle re-seals through the REAL acceptance cell
 *     (acceptanceUniverseFrom -> validateAcceptanceBundle -> the WP03
 *     validateAcBinding seam once per criterion) - the same declared
 *     provider the author gate ran (reviewer route: same-provider-recheck,
 *     zero softening).
 *   - Adversarial negative probes re-run independently (rev-4 class).
 *   - rev-1 duty: every scenario-facing criterion citation pair re-derived
 *     from the bound requirement's own derivation.
 *   - Envelope cross-check (8 reviewer-frame content addresses), trace
 *     graph resolution + exact coverage projections, payload contract.
 *   - I4: governing-contract address resolvability, workspace-wide.
 *   - K2: the envelope's upstream-accepted projection (sha256:32892970...)
 *     adjudicated by a workspace-wide resolvability scan.
 *   - M/N: upstream ACCEPTANCE-STATE audit - the digest layer cannot see
 *     workflow status, so the reviewer checks it: are the consumed
 *     upstream revisions genuinely accepted (verdict records), does a UC
 *     reviewer stage exist at all, and does the candidate assert states
 *     that do not exist?
 *
 * Run: node define-acceptance-contract-desk-reviewer-verify-emission-a.mjs
 * Expected (candidate of record, unchanged since 2026-08-28 03:00):
 *   99 recomputations, 92 pass, 7 fail
 *   (I4.governingContract.resolves, L2.verificationFlags,
 *    M2.intentRevision.accepted, M3.ucReviewerStage.exists,
 *    M4.requirementsRevision.accepted, M5.candidate.acceptedStatusClaims,
 *    N1.scope2.notRatified).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRef = (d) => `sha256:${d}`;
const fileSha = (p) => JSON.parse(readFileSync(p, 'utf8'));

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..', '..', '..', '..');
const QUAL = join(DIR, '..');
const R2 = join(DIR, '..', 'stray-products-r2');

/* The candidate of record (author artifacts, r3). */
const sub = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-product-submission.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings-trace.json'), 'utf8'));

/* Upstream chain (r3 copies; identical content to the r2-reviewed material). */
const upArt = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));
const ucArt = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json'), 'utf8'));
const ucTrc = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios-trace.json'), 'utf8'));
const ucSub = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-product-submission.json'), 'utf8'));
const srArt = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-system-requirements.artifact.json'), 'utf8'));
const srTrc = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-system-requirements-trace.json'), 'utf8'));
const srSub = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-product-submission.json'), 'utf8'));

/* The only genuinely accepted link of the chain (r2 import desk). */
const imp = JSON.parse(readFileSync(join(R2, 'import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));
const impTrc = JSON.parse(readFileSync(join(R2, 'import-discovery-handoff-desk-discovery-import-trace.json'), 'utf8'));
const impRev = JSON.parse(readFileSync(join(R2, 'import-discovery-handoff-desk-reviewer-review.json'), 'utf8'));

/* Upstream verdict records (r2 reviewer rounds). */
const intentRev1 = JSON.parse(readFileSync(join(R2, 'define-product-intent-desk-reviewer-review.json'), 'utf8'));
const intentRev2 = JSON.parse(readFileSync(join(R2, 'define-product-intent-desk-reviewer2-review.json'), 'utf8'));
const srRev = JSON.parse(readFileSync(join(R2, 'derive-system-requirements-desk-reviewer-review.json'), 'utf8'));
const srRestaff = JSON.parse(readFileSync(join(R2, 'derive-system-requirements-desk-reviewer-restaff2-confirmation.json'), 'utf8'));
const ucHold = JSON.parse(readFileSync(join(R2, 'model-use-cases-desk-upstream-hold.artifact.json'), 'utf8'));

/* REAL kernel surfaces - the same code the driver executes. */
const accCell = await import(pathToFileURL(join(ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'acceptance', 'index.mjs')).href);
const upCell = await import(pathToFileURL(join(ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'product-intent', 'index.js')).href);
const srCell = await import(pathToFileURL(join(ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'system-requirements', 'index.js')).href);
const wp03sr = await import(pathToFileURL(join(ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'validators', 'requirements-bundle.mjs')).href);
const prd03 = await import(pathToFileURL(join(ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href);
const uc03 = await import(pathToFileURL(join(ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'uc-scenario-member.mjs')).href);

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); return ok; };

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
const UPSTREAM_PROJECTED = '32892970b44cb1d25a5fdce61e4cea43500ccd1cc4cb8fb03e2b268e1758645d';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const PINNED_TS = '2026-08-28T00:00:00Z';

/* ------------------------------------------------------------------ */
/* A. submission self-address + pins                                    */
/* ------------------------------------------------------------------ */
const subDigest = sha(sub.content);
check('A1.submission.contentDigest', subDigest === sub.contentDigest, `recomputed ${subDigest} vs declared ${sub.contentDigest}`);
check('A2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);
check('A3.submission.pins', sub.content.deskRef === 'define-acceptance-contract' && sub.content.deskNodeId === 'define-acceptance-contract' && sub.content.itemInstanceId === 'formalization-item:define-acceptance-contract' && sub.content.token === 'plan:formalization#item:acceptance-contract' && sub.content.role === 'author', `${sub.content.deskRef}/${sub.content.itemInstanceId}/${sub.content.token}`);

/* ------------------------------------------------------------------ */
/* B. artifact self-address + candidate binding                         */
/* ------------------------------------------------------------------ */
const artDigest = sha(art.content);
check('B1.artifact.contentDigest', artDigest === art.contentDigest, `recomputed ${artDigest} vs declared ${art.contentDigest}`);
check('B2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('B3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest && sub.content.candidate.kind === 'formalization.acceptance-bindings.v1', sub.content.candidate.artifactRef);

/* ------------------------------------------------------------------ */
/* C. trace self-address + subject binding                              */
/* ------------------------------------------------------------------ */
const trcDigest = sha(trc.content);
check('C1.trace.contentDigest', trcDigest === trc.contentDigest, `recomputed ${trcDigest} vs declared ${trc.contentDigest}`);
check('C2.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest) && sub.content.traceRef === trc.traceRef, trc.traceRef);
check('C3.trace.subjectBinding', trc.content.subjectArtifactRef === art.artifactRef && trc.content.subjectSemanticCode === art.semanticCode, `${trc.content.subjectArtifactRef} / ${trc.content.subjectSemanticCode}`);

/* ------------------------------------------------------------------ */
/* D. upstream chain re-verification through the REAL surfaces          */
/* ------------------------------------------------------------------ */
const PRD_IDS = ['claim:scope-1', 'claim:scope-2', 'claim:constraint-1', 'claim:outcome-1'];
const TERM_IDS = ['terminal:audited-1', 'terminal:delivered-1'];
const intentUniverse = { idSets: { sourceClaimIds: PRD_IDS, terminalClaimIds: TERM_IDS } };
const upSeal = new Map();
for (const m of upArt.content.members) {
  const v = prd03.validatePrdIntentMember(m, intentUniverse);
  const declared = upArt.content.memberSeals?.find((s) => s.memberId === m.memberId)?.digest
    ?? art.content.upstream.acceptedIntentSeals.find((s) => s.memberId === m.memberId)?.digest;
  const ok = v.ok === true && v.digest === declared && declared?.length === 64;
  check(`D.prdMember.${m.memberId}`, ok, `wp03=${v.ok === true ? 'sealed' : `${v.reason}`} recomputed ${v.ok === true ? v.digest : 'n/a'} vs declared ${declared}`);
  upSeal.set(m.memberId, sha(m));
}
const upFold = upCell.acceptedIntentSetOf(
  { members: upArt.content.members },
  upArt.content.members.map((m) => ({ memberId: m.memberId, digest: upSeal.get(m.memberId) })),
);
check('D.intentFold', upFold.ok === true && shaRef(upFold.set.revisionDigest) === srArt.content.product.prdRevisionRef, upFold.ok === true ? `revisionDigest ${upFold.set.revisionDigest} pins the requirements bundle's prdRevisionRef` : upFold.detail);
const intentSetExact = upFold.ok === true
  && JSON.stringify([...upFold.set.memberDigests].sort()) === JSON.stringify([...art.content.upstream.acceptedIntentSet.memberDigests].sort())
  && JSON.stringify([...upFold.set.prdMemberIds].sort()) === JSON.stringify([...art.content.upstream.acceptedIntentSet.prdMemberIds].sort())
  && JSON.stringify([...upFold.set.scenarioRequiredMemberIds].sort()) === JSON.stringify([...art.content.upstream.acceptedIntentSet.scenarioRequiredMemberIds].sort());
check('D.intentSet.transport', intentSetExact, 'artifact.upstream.acceptedIntentSet equals the recomputed fold set');

const ucUniverse = { idSets: { prdMemberIds: upFold.ok ? upFold.set.prdMemberIds : [] } };
const ucSeal = new Map();
for (const s of ucArt.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, ucUniverse);
  const declared = art.content.upstream.acceptedUcSeals.find((x) => x.scenarioId === s.scenarioId)?.digest;
  const ok = v.ok === true && v.digest === declared;
  check(`D.ucScenario.${s.scenarioId}`, ok, `uc03=${v.ok === true ? 'sealed' : v.reason} recomputed ${v.ok === true ? v.digest : 'n/a'} vs declared ${declared}`);
  ucSeal.set(s.scenarioId, sha(s));
}
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
check('D.ucRevision.pin', shaRef(ucRevisionDigest) === srArt.content.product.ucRevisionRef, `recomputed ${ucRevisionDigest} vs pinned ${srArt.content.product.ucRevisionRef}`);
const acceptedUcSet = {
  memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort(),
  scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(),
  branchIdsByScenario: Object.fromEntries(ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)])),
  revisionDigest: ucRevisionDigest,
};
check('D.ucSet.transport', JSON.stringify(acceptedUcSet.revisionDigest) === JSON.stringify(art.content.upstream.acceptedUcSet.revisionDigest) && JSON.stringify(acceptedUcSet.scenarioIds) === JSON.stringify([...art.content.upstream.acceptedUcSet.scenarioIds].sort()) && JSON.stringify(acceptedUcSet.memberDigests) === JSON.stringify([...art.content.upstream.acceptedUcSet.memberDigests].sort()), 'artifact.upstream.acceptedUcSet equals the recomputed set');

const requirementSeal = new Map();
for (const r of srArt.content.product.requirements) {
  requirementSeal.set(r.requirementId, sha(r));
  const declared = art.content.upstream.acceptedRequirementSeals.find((x) => x.requirementId === r.requirementId)?.digest;
  check(`D.requirement.${r.requirementId}`, sha(r) === declared, `recomputed ${sha(r)} vs declared ${declared}`);
}
const srUniverse = srCell.deriveAcceptedUniverse({
  prd: { revisionDigest: upFold.set.revisionDigest, memberIds: [...upFold.set.prdMemberIds] },
  useCases: { revisionDigest: ucRevisionDigest, scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  sourceConstraintIds: ['constraint:retention-1'],
  verificationSurfaceIds: srArt.content.deskInput.verificationSurfaceIds,
});
const srSealedNow = srUniverse.ok === true ? wp03sr.validateRequirementsBundle(srArt.content.product, srUniverse.universe) : { ok: false };
check('D.requirementsRevalidated', srUniverse.ok === true && srSealedNow.ok === true, `requirements bundle re-sealed against its recomputed WP03 universe: ${srSealedNow.ok === true ? shaRef(srSealedNow.digest ?? srSealedNow.ref) : `${srUniverse.detail ?? srSealedNow.reason}`}`);

const upstreamRefsOk =
  art.content.upstream.acceptedIntentArtifactRef === upArt.artifactRef && art.content.upstream.acceptedIntentArtifactDigest === upArt.contentDigest
  && art.content.upstream.acceptedUcArtifactRef === ucArt.artifactRef && art.content.upstream.acceptedUcArtifactDigest === ucArt.contentDigest
  && art.content.upstream.acceptedUcTraceRef === ucTrc.traceRef && art.content.upstream.acceptedUcSubmissionRef === ucSub.submissionRef
  && art.content.upstream.acceptedRequirementsArtifactRef === srArt.artifactRef && art.content.upstream.acceptedRequirementsArtifactDigest === srArt.contentDigest
  && art.content.upstream.acceptedRequirementsTraceRef === srTrc.traceRef && art.content.upstream.acceptedRequirementsSubmissionRef === srSub.submissionRef
  && sha(ucTrc.content) === ucTrc.contentDigest && sha(ucSub.content) === ucSub.contentDigest
  && sha(srTrc.content) === srTrc.contentDigest && sha(srSub.content) === srSub.contentDigest;
check('D.upstreamRefs', upstreamRefsOk, 'all accepted-* artifact/trace/submission refs bind the recomputed upstream digests');

/* ------------------------------------------------------------------ */
/* E. the REAL acceptance cell surface (same-provider-recheck)          */
/* ------------------------------------------------------------------ */
const PRODUCT = art.content.product;
const DESK_INPUT = art.content.deskInput;
const universe = accCell.acceptanceUniverseFrom({
  requirementsBundle: srArt.content.product,
  useCases: { scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  verifiableStatementIds: DESK_INPUT.verifiableStatementIds,
  evidenceBindings: DESK_INPUT.evidenceBindings,
});
check('E1.universe.protocol', universe.ok === true, universe.ok === true
  ? `id sets: fr=${universe.universe.idSets.frIds.length} nfr=${universe.universe.idSets.nfrIds.length} rule=${universe.universe.idSets.ruleIds.length} scenarios=${universe.universe.idSets.ucScenarioIds.length} branches=${Object.values(universe.universe.idSets.ucBranchIdsByScenario).flat().length} stmts=${universe.universe.idSets.verifiableStatementIds.length} evidenceBindings=${universe.universe.idSets.evidenceBindingIds.length}`
  : `${universe.reason}: ${universe.detail}`);
const sealedNow = universe.ok === true ? accCell.validateAcceptanceBundle(PRODUCT, universe.universe, srArt.content.product.requirements) : { ok: false };
check('E2.product.seal', sealedNow.ok === true && sealedNow.artifact.digest === art.content.productSeal.digest && sealedNow.artifact.ref === art.content.productSeal.ref, `REAL validateAcceptanceBundle re-seal ${sealedNow.ok === true ? sealedNow.artifact.ref : `${sealedNow.reason}: ${sealedNow.detail}`} vs declared ${art.content.productSeal.ref}`);

const criterionSeal = new Map();
for (const c of PRODUCT.criteria) {
  const v = accCell.validateAcBinding(c, universe.universe);
  const declared = art.content.memberSeals.find((s) => s.criterionId === c.criterionId)?.digest;
  const ok = v.ok === true && v.digest === declared;
  criterionSeal.set(c.criterionId, sha(c));
  check(`E3.criterion.${c.criterionId}`, ok, `wp03 seam=${v.ok === true ? 'sealed' : `${v.reason}: ${v.detail}`} recomputed ${sha(c)} vs declared ${declared}`);
}
const stmtSeal = new Map();
for (const s of art.content.verifiableStatements) {
  const recomputed = sha({ statement: s.statement, statementId: s.statementId });
  const declared = DESK_INPUT.verifiableStatementIds.includes(s.statementId);
  const src = PRODUCT.criteria.flatMap((c) => c.verifiableStatementRefs).filter((x) => x === s.statementId).length;
  stmtSeal.set(s.statementId, recomputed);
  check(`E4.statement.${s.statementId}`, recomputed === s.digest && s.ref === shaRef(s.digest) && declared && src >= 1, `recomputed ${recomputed} vs declared ${s.digest}; in desk input=${declared}; cited by ${src} criterion/criteria`);
}
const kinds = [...new Set(PRODUCT.criteria.map((c) => c.evidence.evidenceKind))];
check('E5.evidenceKind.vocabulary', kinds.every((k) => accCell.EVIDENCE_KINDS.includes(k)), `used [${kinds.join(', ')}] of closed [${accCell.EVIDENCE_KINDS.join(', ')}]`);

/* ------------------------------------------------------------------ */
/* F. envelope task-projection cross-check                              */
/* ------------------------------------------------------------------ */
for (const x of art.content.upstream.verifiedSubArtifacts) {
  const hex = x.digest.startsWith('sha256:') ? x.digest.slice(7) : x.digest;
  check(`F.${x.id}`, ENVELOPE[x.id] === hex && x.ref === shaRef(hex), `artifact-transported digest ${x.digest} vs envelope ${ENVELOPE[x.id] ?? 'ABSENT'}`);
}
check('F1.envelopeCoverage', art.content.upstream.verifiedSubArtifacts.length === 8 && art.content.upstream.verifiedAgainstTaskProjection === true, '8/8 reviewer-frame content addresses transported in artifact.upstream');

/* ------------------------------------------------------------------ */
/* G. adversarial negative probes (rev-4 class; same provider re-run)   */
/* ------------------------------------------------------------------ */
if (universe.ok === true) {
  const stripBranch = JSON.parse(canon(PRODUCT.criteria[0]));
  delete stripBranch.bindsTo.ucTerminalBranchRefs;
  const p1 = accCell.validateAcBinding(stripBranch, universe.universe);
  check('G1.probe.strippedBranchCitation', p1.ok === false && p1.reason === 'MISSING_LINEAGE', `${p1.reason ?? 'ACCEPTED (probe should fail)'}: ${p1.detail ?? ''}`);

  const foreignScenario = JSON.parse(canon(PRODUCT.criteria[0]));
  foreignScenario.bindsTo.ucScenarioRefs = ['uc:terminal-1'];
  foreignScenario.bindsTo.ucTerminalBranchRefs = ['branch:terminal-1-main'];
  const p2 = accCell.validateAcceptanceBundle({ ...PRODUCT, criteria: [foreignScenario, ...PRODUCT.criteria.slice(1)] }, universe.universe, srArt.content.product.requirements);
  check('G2.probe.foreignScenarioSubstitution', p2.ok === false && p2.reason === 'FOREIGN_LINEAGE', `${p2.reason ?? 'ACCEPTED (probe should fail)'}: ${p2.detail ?? ''}`);

  const foreignReq = JSON.parse(canon(PRODUCT.criteria[0]));
  foreignReq.bindsTo.requirementRefs = ['fr:foreign-1'];
  const p3 = accCell.validateAcBinding(foreignReq, universe.universe);
  check('G3.probe.foreignRequirement', p3.ok === false && p3.reason === 'FOREIGN_LINEAGE', `${p3.reason ?? 'ACCEPTED (probe should fail)'}: ${p3.detail ?? ''}`);

  const uncovered = { ...PRODUCT, criteria: PRODUCT.criteria.filter((c) => c.criterionId !== 'ac:determinism-1') };
  const p4 = accCell.validateAcceptanceBundle(uncovered, universe.universe, srArt.content.product.requirements);
  check('G4.probe.uncoveredRequirement', p4.ok === false && p4.reason === 'COVERAGE_GAP', `${p4.reason ?? 'ACCEPTED (probe should fail)'}: ${p4.detail ?? ''}`);

  const whatSide = JSON.parse(canon(PRODUCT.criteria[0]));
  whatSide.participatingModules = ['kernel'];
  const p5 = accCell.validateAcceptanceBundle({ ...PRODUCT, criteria: [whatSide, ...PRODUCT.criteria.slice(1)] }, universe.universe, srArt.content.product.requirements);
  check('G5.probe.whatSideKey', p5.ok === false && p5.reason === 'SCOPE_VIOLATION', `${p5.reason ?? 'ACCEPTED (probe should fail)'}: ${p5.detail ?? ''}`);
}

/* ------------------------------------------------------------------ */
/* H. trace graph over recomputed digests + rev-1 re-derivations        */
/* ------------------------------------------------------------------ */
const branchOwner = new Map();
for (const [scenarioId, branchIds] of Object.entries(acceptedUcSet.branchIdsByScenario)) {
  for (const branchId of branchIds) branchOwner.set(branchId, scenarioId);
}
const resolveId = (id) => {
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (criterionSeal.has(id)) return criterionSeal.get(id);
  if (requirementSeal.has(id)) return requirementSeal.get(id);
  if (ucSeal.has(id)) return ucSeal.get(id);
  if (stmtSeal.has(id)) return stmtSeal.get(id);
  if (branchOwner.has(id)) return ucSeal.get(branchOwner.get(id));
  return undefined;
};
const VOCAB = new Set(trc.content.relationVocabulary);
let relOk = true;
for (const [i, r] of trc.content.relationships.entries()) {
  const f = resolveId(r.fromId);
  const t = resolveId(r.toId);
  const ok = VOCAB.has(r.relation) && f !== undefined && t !== undefined && r.fromRef === shaRef(f) && r.toRef === shaRef(t);
  relOk = relOk && ok;
  if (!ok) check(`H.rel[${i}]`, false, `${r.fromId} -${r.relation}-> ${r.toId} does not resolve to recomputed digests`);
}
check('H1.relationships.resolve', relOk && trc.content.relationships.length === 16, `${trc.content.relationships.length} relationships checked against recomputed digests`);

let critCovOk = true;
for (const [criterionId, cov] of Object.entries(trc.content.criterionCoverage)) {
  const edges = trc.content.relationships.filter((r) => r.fromId === criterionId);
  const pick = (rel) => edges.filter((r) => r.relation === rel).map((r) => r.toId).sort();
  const ok = cov.digest === criterionSeal.get(criterionId)
    && JSON.stringify([...cov.verifies].sort()) === JSON.stringify(pick('verifies'))
    && JSON.stringify([...cov.covers].sort()) === JSON.stringify(pick('covers'))
    && JSON.stringify([...cov.cites].sort()) === JSON.stringify(pick('cites'))
    && JSON.stringify([...(cov.supports ?? [])].sort()) === JSON.stringify(pick('supports'));
  critCovOk = critCovOk && ok;
  check(`H2.criterionCoverage.${criterionId}`, ok, `verifies=${pick('verifies')} covers=${pick('covers')} cites=${pick('cites')} supports=${pick('supports')}`);
}
let reqCovOk = true;
for (const [requirementId, cov] of Object.entries(trc.content.requirementCoverage)) {
  const verifiedBy = trc.content.relationships.filter((r) => r.relation === 'verifies' && r.toId === requirementId).map((r) => r.fromId).sort();
  const ok = cov.digest === requirementSeal.get(requirementId) && JSON.stringify([...cov.verifiedBy].sort()) === JSON.stringify(verifiedBy);
  reqCovOk = reqCovOk && ok;
  check(`H3.requirementCoverage.${requirementId}`, ok, `verifiedBy=${verifiedBy.join(',')}`);
}
let branchCovOk = true;
for (const [branchId, cov] of Object.entries(trc.content.branchCoverage)) {
  const coveredBy = trc.content.relationships.filter((r) => r.relation === 'covers' && r.toId === branchId).map((r) => r.fromId).sort();
  const ok = cov.owningScenario === branchOwner.get(branchId) && cov.digest === ucSeal.get(cov.owningScenario) && JSON.stringify([...cov.coveredBy].sort()) === JSON.stringify(coveredBy);
  branchCovOk = branchCovOk && ok;
  check(`H4.branchCoverage.${branchId}`, ok, `owningScenario=${cov.owningScenario} coveredBy=${coveredBy.join(',')}`);
}
for (const t of TERM_IDS) {
  const supportedBy = trc.content.relationships.filter((r) => r.relation === 'supports' && r.toId === t).map((r) => r.fromId).sort();
  const cov = trc.content.terminalCoverage[t];
  const sup = art.content.terminalSupport.find((x) => x.terminalClaimId === t);
  const ok = cov !== undefined && cov.digest === ENVELOPE[t] && JSON.stringify([...cov.supportedBy].sort()) === JSON.stringify(supportedBy) && sup?.digest === ENVELOPE[t];
  check(`H5.terminal.${t}`, ok, `supportedBy=${supportedBy.join(',')} terminalSupport digest bound=${sup?.digest === ENVELOPE[t]}`);
}
const cc = trc.content.constraintCoverage;
const ccArt = art.content.constraintDispositions.find((x) => x.constraintId === 'constraint:retention-1');
check('H6.constraint.coverage', cc?.digest === ENVELOPE['constraint:retention-1'] && cc?.disposition === 'honored' && JSON.stringify(cc.enforcedBy) === JSON.stringify(ccArt.enforcedBy) && JSON.stringify(cc.constrainedCriteria) === JSON.stringify(ccArt.constrainedCriteria), `enforcedBy=${cc.enforcedBy.join(',')} constrainedCriteria=${cc.constrainedCriteria.length}`);
const unkDerives = trc.content.relationships.some((r) => r.fromId === 'unknown:browser-matrix-1' || r.toId === 'unknown:browser-matrix-1');
const unkCov = trc.content.unknownCoverage;
check('H7.unknown.carriedNotDerived', unkCov?.disposition === 'carried_forward' && unkCov?.owner === 'discovery' && unkCov?.digest === ENVELOPE['unknown:browser-matrix-1'] && !unkDerives && art.content.unknownDispositions[0]?.disposition === 'carried_forward', `disposition=carried_forward owner=discovery derivation edges=${unkDerives}`);
check('H8.relationVocabulary', trc.content.relationVocabulary.length === 4 && trc.content.relationships.every((r) => VOCAB.has(r.relation)), trc.content.relationVocabulary.join(','));

/* rev-1: re-derive every scenario-facing citation pair from the bound
   requirement's own derivation. */
const reqsByScenario = new Map();
for (const r of srArt.content.product.requirements) {
  for (const sc of r.derivation?.ucScenarioRefs ?? []) {
    if (!reqsByScenario.has(sc)) reqsByScenario.set(sc, new Map());
    reqsByScenario.get(sc).set(r.requirementId, r.derivation.ucTerminalBranchRefs ?? []);
  }
}
let rev1Ok = true;
for (const c of PRODUCT.criteria) {
  const isScenarioFacing = (c.bindsTo.ucScenarioRefs ?? []).length > 0;
  if (!isScenarioFacing) {
    const nfrOnly = c.bindsTo.requirementRefs.every((id) => (srArt.content.product.requirements.find((r) => r.requirementId === id)?.derivation?.ucScenarioRefs ?? []).length === 0);
    check(`H9.citationPair.${c.criterionId}`, nfrOnly && !(c.bindsTo.ucTerminalBranchRefs ?? []).length, 'non-scenario-derived NFR: no UC citation (lawful single shape)');
    continue;
  }
  for (const reqId of c.bindsTo.requirementRefs) {
    const derivationBranches = reqsByScenario.get(c.bindsTo.ucScenarioRefs[0])?.get(reqId);
    const pairOk = derivationBranches !== undefined && (c.bindsTo.ucTerminalBranchRefs ?? []).every((b) => derivationBranches.includes(b));
    rev1Ok = rev1Ok && pairOk;
    check(`H9.citationPair.${c.criterionId}.${reqId}`, pairOk, `cited (${c.bindsTo.ucScenarioRefs.join(',')} x ${(c.bindsTo.ucTerminalBranchRefs ?? []).join(',')}) vs requirement derivation (${derivationBranches === undefined ? 'scenario not in derivation' : derivationBranches.join(',')})`);
  }
}

/* ------------------------------------------------------------------ */
/* I. payload contract + governing anchor resolvability                 */
/* ------------------------------------------------------------------ */
const expectedEvidence = [
  srArt.contentDigest, ucArt.contentDigest, upArt.contentDigest,
  imp.contentDigest,
  (() => { const c = imp.content.capsule; return c.capsuleDigest; })(),
  imp.content.verifiedSubArtifacts.certificate.digest,
  ...Object.values(ENVELOPE),
  GOVERNING,
  art.content.upstream.acceptedIntentTraceRef.slice(7),
  art.content.upstream.acceptedIntentSubmissionRef.slice(7),
  ucTrc.contentDigest, ucSub.contentDigest, srTrc.contentDigest, srSub.contentDigest,
].map(shaRef).sort();
const gotEvidence = [...sub.content.payloadContract.requiredEvidenceRefs].sort();
check('I1.evidenceRefs.exact', JSON.stringify(gotEvidence) === JSON.stringify(expectedEvidence), `${gotEvidence.length} refs, exact set match=${JSON.stringify(gotEvidence) === JSON.stringify(expectedEvidence)}`);
const covKinds = sub.content.payloadContract.evidenceKindCoverage;
const kindSum = Object.values(covKinds).reduce((a, b) => a + b, 0);
check('I2.evidenceKindCoverage', kindSum === gotEvidence.length && covKinds['source-claim'] === 4 && covKinds['terminal-claim'] === 2 && Object.entries(covKinds).every(([k, n]) => k.startsWith('accepted-') || ['architecture-contract', 'constraint', 'unknown'].includes(k) || n >= 1), `sum=${kindSum} vs refs=${gotEvidence.length}; kinds=${Object.keys(covKinds).length}`);
const capDigest = imp.content.capsule.capsuleDigest;
check('I3.upstreamAuthority.binding', art.content.upstream.importArtifactRef === shaRef(imp.contentDigest) && imp.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5' && art.content.upstream.capsuleRef === shaRef(capDigest) && art.content.upstream.certificateRef === shaRef(imp.content.verifiedSubArtifacts.certificate.digest) && sha(impTrc.content) === impTrc.contentDigest && sha(impRev.content) === impRev.contentDigest && impRev.content.verdict === 'accepted', `import artifact ${art.content.upstream.importArtifactRef} recomputes; accepted import review ${impRev.contentDigest} recomputes (verdict accepted)`);

/* I4. governing contract continuity: workspace-wide resolution scan */
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
let govRawHit = null;
let govCanonHit = null;
let govContentHit = null;
const govClaimants = [];
let govMentions = 0;
for (const f of walk(QUAL)) {
  const buf = readFileSync(f);
  const text = buf.toString('utf8');
  if (createHash('sha256').update(buf).digest('hex') === GOVERNING) govRawHit = f;
  if (text.includes(GOVERNING)) govMentions += 1;
  if (f.endsWith('.json')) {
    try {
      const j = JSON.parse(text);
      if (sha(j) === GOVERNING) govCanonHit = f;
      if (j.content !== undefined && sha(j.content) === GOVERNING) govContentHit = f;
      if ((j.artifactRef ?? '').includes(GOVERNING) || (j.contentDigest ?? '') === GOVERNING || (j.submissionRef ?? '').includes(GOVERNING)) {
        govClaimants.push({ file: f.split('stray-products').pop(), declared: j.contentDigest ?? j.artifactRef ?? j.submissionRef, recomputed: j.content !== undefined ? sha(j.content) : null });
      }
    } catch { /* not JSON */ }
  }
}
check('I4.governingContract.resolves', govRawHit !== null || govCanonHit !== null || govContentHit !== null, govRawHit !== null || govCanonHit !== null || govContentHit !== null
  ? `governing address resolves (${govContentHit ?? govCanonHit ?? govRawHit})`
  : `UNRESOLVED across ${govMentions} mentioning files under qualification/: no content (raw bytes, whole-JSON canonical, or .content canonical) hashes to sha256:${GOVERNING}; claimants declaring it as their own address all recompute otherwise: ${JSON.stringify(govClaimants)}`);

/* ------------------------------------------------------------------ */
/* J. desk pins, universe, closure laws, determinism                    */
/* ------------------------------------------------------------------ */
check('J1.deskPins', art.content.schemaVersion === 'formalization.acceptance-bindings.v1' && art.content.productKind === 'formalization.acceptance-bindings.v1' && art.content.effectId === 'formalization.accept-products' && art.content.contractKind === 'frf-contracts.ac-binding.v1' && art.content.checkProviderId === 'frf.acceptance-closure.v1' && art.content.deskSkillId === 'formalization-desk-define-acceptance-contract', `${art.content.productKind}/${art.content.checkProviderId}/${art.content.deskSkillId}`);
check('J2.submission.pins', sub.content.token === art.content.token && sub.content.itemInstanceId === art.content.itemInstanceId && sub.content.deskNodeId === art.content.deskNodeId, 'submission pins match artifact pins');
check('J3.criterionUniverse', PRODUCT.criteria.length === 5 && new Set(PRODUCT.criteria.map((c) => c.criterionId)).size === 5 && art.content.memberSeals.length === 5, PRODUCT.criteria.map((c) => c.criterionId).join(','));
check('J4.deferrals.standalone', PRODUCT.deferrals.length === 0 && PRODUCT.standaloneEvidenceBindings.length === 0 && DESK_INPUT.evidenceBindings.length === 0, 'zero deferrals, zero standalone evidence bindings (all required branches covered end-to-end)');
check('J5.pinnedTimestamps', sub.createdAt === PINNED_TS && art.createdAt === PINNED_TS && trc.createdAt === PINNED_TS, `pinned ${PINNED_TS} across submission/artifact/trace`);
check('J6.closureLaws', reqCovOk && branchCovOk, `requirements coverage all-exact=${reqCovOk} + branch coverage all-exact=${branchCovOk} over ${reqsByScenario.size} scenarios / ${branchOwner.size} branches`);

/* ------------------------------------------------------------------ */
/* K. workspace law + envelope upstream-accepted adjudication           */
/* ------------------------------------------------------------------ */
check('K1.workspace.zeroUpstream.consistent', art.content.workspaceSummary === '0 accepted upstream revisions travel by content address' && sub.content.workspaceSummary === art.content.workspaceSummary && trc.content.workspaceSummary === art.content.workspaceSummary && art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0, art.content.workspaceSummary);

let k2Raw = 0;
let k2Canon = 0;
let k2Content = 0;
const k2Text = [];
let k2Scanned = 0;
for (const f of walk(QUAL)) {
  k2Scanned += 1;
  const buf = readFileSync(f);
  const text = buf.toString('utf8');
  if (text.includes(UPSTREAM_PROJECTED)) k2Text.push(f.split('stray-products').pop());
  if (createHash('sha256').update(buf).digest('hex') === UPSTREAM_PROJECTED) k2Raw += 1;
  if (f.endsWith('.json')) {
    try {
      const j = JSON.parse(text);
      if (sha(j) === UPSTREAM_PROJECTED) k2Canon += 1;
      if (j.content !== undefined && sha(j.content) === UPSTREAM_PROJECTED) k2Content += 1;
    } catch { /* not JSON */ }
  }
}
check('K2.upstreamProjection.unresolvable', k2Raw === 0 && k2Canon === 0 && k2Content === 0, `scanned ${k2Scanned} workspace files under qualification/: raw-bytes hits=${k2Raw}, canonical-JSON hits=${k2Canon}, .content canonical hits=${k2Content}, textual mentions=${k2Text.length}${k2Text.length > 0 ? ` (${k2Text.join(' | ')})` : ''}`);

/* ------------------------------------------------------------------ */
/* L. declared verification-flag honesty + fence                        */
/* ------------------------------------------------------------------ */
const fenceBundleKeys = ['participatingModules', 'moduleAllocation', 'files', 'architecture'];
const fenceClean = fenceBundleKeys.every((k) => PRODUCT[k] === undefined)
  && PRODUCT.criteria.every((c) => ['participatingModules', 'moduleAllocation', 'files', 'architecture'].every((k) => c[k] === undefined));
check('L1.fence.scan', fenceClean, 'no WHAT-side forbidden keys anywhere in the bundle (WP03/closure SCOPE_VIOLATION surface)');

const v = art.content.verification;
const declaredTrue = Object.entries(v).filter(([, val]) => val === true).map(([k]) => k);
const flagProblems = [];
/* Digest-layer flags the reviewer re-confirms: */
if (v.memberSealsRecomputedOverCanonicalMembers !== true) flagProblems.push('memberSealsRecomputedOverCanonicalMembers');
if (v.declaredDigestsTrusted !== false) flagProblems.push('declaredDigestsTrusted');
if (v.deterministicAuthoring !== true) flagProblems.push('deterministicAuthoring');
if (v.upstreamRequirementsBundleReverified !== true) flagProblems.push('upstreamRequirementsBundleReverified');
if (v.wp03ValidationSealed !== true) flagProblems.push('wp03ValidationSealed');
if (v.acceptedUpstreamRevisionsTravelingByContentAddress !== 0) flagProblems.push('acceptedUpstreamRevisionsTravelingByContentAddress');
/* Status-layer flags: names assert ACCEPTED-lineage states that the M-group
   audit decides. If any consumed upstream revision is not genuinely
   accepted, these flags are false no matter how exact the digests are. */
const m2ok = results.find((r) => r.id === 'M2.intentRevision.accepted')?.ok === true;
const m3ok = results.find((r) => r.id === 'M3.ucReviewerStage.exists')?.ok === true;
const m4ok = results.find((r) => r.id === 'M4.requirementsRevision.accepted')?.ok === true;
if (v.revisionPinsMatchAcceptedRevisions === true && !(m2ok && m3ok && m4ok)) flagProblems.push('revisionPinsMatchAcceptedRevisions (pins are byte-exact to UNACCEPTED revisions)');
check('L2.verificationFlags', flagProblems.length === 0, flagProblems.length === 0 ? `all ${declaredTrue.length}+ declared verification flags agree with independent recomputation` : `flag honesty failures: ${flagProblems.join('; ')}`);

/* ------------------------------------------------------------------ */
/* M. upstream ACCEPTANCE-STATE audit (the status layer)                */
/* ------------------------------------------------------------------ */
check('M1.importChain.accepted', sha(imp.content) === imp.contentDigest && impRev.content.verdict === 'accepted' && intentRev1.content.reviewedCandidate.artifactRef === upArt.artifactRef, `the discovery import chain is the one genuinely accepted link (import artifact ${imp.contentDigest}, review verdict accepted)`);

/* M2: the intent revision is verdict-repair across every reviewer round,
   with no author reissue anywhere (r2 or r3). */
const intentArtifactFiles = [];
for (const round of ['stray-products-r1', 'stray-products-r2', 'stray-products-r3']) {
  const d = join(QUAL, round);
  if (!existsSync(d)) continue;
  for (const f of walk(d)) {
    if (f.endsWith('product-intent.artifact.json') || f.endsWith('intent.artifact.json')) {
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        if (j.content?.members) intentArtifactFiles.push({ file: f.split('stray-products').pop(), digest: j.contentDigest });
      } catch { /* not an artifact */ }
    }
  }
}
const noReissue = intentArtifactFiles.every((x) => x.digest === upArt.contentDigest);
check('M2.intentRevision.accepted', intentRev1.content.verdict === 'accepted' && intentRev2.content.verdict === 'accepted',
  `intent candidate of record ${upArt.contentDigest}: reviewer verdicts '${intentRev1.content.verdict}' (FR-Define-Product-Intent-001) and '${intentRev2.content.verdict}' (FR-Define-Product-Intent-002, both round CRIT-1: prd:scope-2 fabricated disposition authority; MAJ-1: governing anchor) - intent artifact files in workspace: ${JSON.stringify(intentArtifactFiles)}; no author reissue exists = ${noReissue}`);

/* M3: does ANY reviewer stage exist for the model-use-cases bundle? */
const ucReviewerFiles = [];
for (const round of ['stray-products-r1', 'stray-products-r2', 'stray-products-r3']) {
  const d = join(QUAL, round);
  if (!existsSync(d)) continue;
  for (const f of walk(d)) {
    const base = f.split(/[\\/]/).pop();
    if (base.startsWith('model-use-cases') && (base.includes('reviewer') || base.includes('review'))) ucReviewerFiles.push(f.split('stray-products').pop());
  }
}
check('M3.ucReviewerStage.exists', ucReviewerFiles.length > 0,
  `NO reviewer artifacts for the model-use-cases bundle exist anywhere in the corpus (scan found ${ucReviewerFiles.length}); the bundle was authored in violation of its own desk's upstream hold (hold artifact sha256:${ucHold.contentDigest}, holdKind=${ucHold.content.holdKind}) and admitted for a reviewer stage that never ran`);

/* M4: the requirements revision verdict. */
check('M4.requirementsRevision.accepted', srRev.content.verdict === 'accepted',
  `requirements candidate of record ${srArt.contentDigest}: reviewer verdict '${srRev.content.verdict}' (FR-Derive-System-Requirements-001; CRIT-1 unaccepted lineage asserted accepted, CRIT-2 scope-2 ratification, MAJ-1 governing anchor) + re-staffing confirmation '${srRestaff.semanticCode}' (${srRestaff.contentDigest === sha(srRestaff.content) ? 'recomputes' : 'DIGEST DRIFT'}) - the verdict stands unremediated and the r3 copy is byte-identical`);

/* M5: does the candidate assert acceptance states that do not exist? */
const assertsAccepted =
  art.content.upstream.materialAuthority.startsWith('the accepted ')
  && ['acceptedIntentArtifactRef', 'acceptedUcArtifactRef', 'acceptedRequirementsArtifactRef'].every((k) => k in art.content.upstream)
  && Object.keys(covKinds).filter((k) => k.startsWith('accepted-')).length >= 6;
const selfCheck9 = sub.content.acceptanceCriteriaSelfCheck.find((x) => x.id === 9)?.description ?? '';
check('M5.candidate.acceptedStatusClaims', !assertsAccepted,
  `the candidate's material authority ("${art.content.upstream.materialAuthority}"), its accepted* upstream field family and its accepted-* evidence kinds assert accepted intent/UC/requirements revisions; self-check 9 ("${selfCheck9.slice(0, 120)}...") asserts "accepted ... re-sealed" - all three consumed revisions are NON-accepted (M2/M3/M4), so these are workflow-status fabrications the digest layer cannot see`);

/* ------------------------------------------------------------------ */
/* N. scope-2 ratification scan (rev duty: never ratify fabricated      */
/*    dispositions into the acceptance surface)                         */
/* ------------------------------------------------------------------ */
const sc2 = imp.content.verifiedSubArtifacts.sourceClaims.find((x) => x.semanticCode === 'SC-2');
const scope2Member = upArt.content.members.find((m) => m.memberId === 'prd:scope-2');
const ratifies = (art.content.brief ?? '').includes('out-of-scope intent member prd:scope-2')
  || (sub.content.acceptanceCriteriaSelfCheck.find((x) => x.id === 10)?.description ?? '').includes('prd:scope-2 (out_of_scope)');
check('N1.scope2.notRatified', !ratifies,
  `candidate restates the prd:scope-2 exclusion as settled fact (brief + self-check 10), but the accepted capsule material for claim:scope-2 (SC-2 ${sc2?.digest}) recomputes to a bare claim statement (no decision) and certificate CERT-1 is a subject-level go; the exclusion authority was established as nonexistent by FR-Define-Product-Intent-001 CRIT-1, FR-Define-Product-Intent-002 CRIT-1 and FR-Derive-System-Requirements-001 CRIT-2; the consumed member still reads "${scope2Member?.disposition?.reason?.slice(0, 90)}..." - zero derivation edges from prd:scope-2 would be lawful under contest, restating the exclusion as fact is not`);

/* ------------------------------------------------------------------ */
/* Summary                                                              */
/* ------------------------------------------------------------------ */
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; validators/folds = REAL kernel cell surfaces (same-provider-recheck, zero softening)',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failedCheckIds: failed.map((r) => r.id),
  results,
}, null, 2));
