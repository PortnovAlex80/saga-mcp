/**
 * derive-system-requirements desk (reviewer) - RE-STAFFING #2 verification (r2).
 *
 * This seat was already served (standing reviewer staffing, files of record
 * 02:24-02:29). This staffing received a BYTE-EQUIVALENT desk task envelope.
 * Desk law on re-staffing with an identical envelope: the outcome is
 * idempotent by content address - re-emitting the package would mint new
 * addresses for identical semantics (the contention anti-pattern recorded as
 * CR-Model-Use-Cases-002 and CR-001..003). So this staffing VERIFIES AND
 * CONFIRMS the standing package of record and mints no second submission.
 *
 * Nothing is trusted by declaration. Frozen kernel rule:
 *   src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Layers:
 *   H  envelope identity: this frame's pins == the standing staffing's
 *      on-disk pins (VV envelopePins + FR workspaceAdjudication).
 *   R  standing package of record recomputed from raw bytes (VV, FR, RT, FS,
 *      subject trio), zero trust; desk-state census (no new author emission,
 *      no adjudication, no predecessor re-staff emission for this seat).
 *   K  REAL kernel re-run: provider, seam binder, REAL deriveAcceptedUniverse,
 *      REAL WP03 seal, author gate, kernel reviewer route, negative probe,
 *      upstream folds re-derived.
 *   M  the verdict rationale of record still stands (M4/M5/M6 re-derived).
 *   N  governing-contract resolvability scan (still unresolvable).
 *   O  envelope upstream-accepted projection adjudication (still unresolvable
 *      as content; textual mentions informational only).
 *   A  emission discipline: standing artifacts recompute byte-exact = zero
 *      existing files modified; restaff2 files are the only new writers.
 *
 * Run: node derive-system-requirements-desk-reviewer-restaff2-verify.mjs > derive-system-requirements-desk-reviewer-restaff2-verify-out.json
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaBytes = (buf) => createHash('sha256').update(buf).digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(DIR, '..', '..', '..', '..', '..');
const QUAL = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'qualification');
const wp03 = await import(pathToFileURL(join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'validators', 'requirements-bundle.mjs')).href);
const prd03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href);
const uc03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'uc-scenario-member.mjs')).href);
const upCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'product-intent', 'index.js')).href);
const srCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'system-requirements', 'index.js')).href);

const read = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const vv = read('derive-system-requirements-desk-reviewer-verification.json');
const fr = read('derive-system-requirements-desk-reviewer-review.json');
const rt = read('derive-system-requirements-desk-reviewer-trace.json');
const fs = read('derive-system-requirements-desk-reviewer-product-submission.json');
const art = read('derive-system-requirements-desk-system-requirements.artifact.json');
const trc = read('derive-system-requirements-desk-system-requirements-trace.json');
const sub = read('derive-system-requirements-desk-product-submission.json');
const upArt = read('define-product-intent-desk-product-intent.artifact.json');
const ucArt = read('model-use-cases-desk-uc-scenarios.artifact.json');
const iArt = read('import-discovery-handoff-desk-discovery-import.artifact.json');
const iRevA = read('define-product-intent-desk-reviewer-review.json');
const iRevB = read('define-product-intent-desk-reviewer-review-emission-b.json');
const iRev2 = read('define-product-intent-desk-reviewer2-review.json');

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); return ok; };

/* THIS staffing's task-projection envelope (byte-equivalent to staffing #1). */
const THIS_FRAME = {
  task: 'derive-system-requirements desk (reviewer)',
  projectionRefs: {
    'source-claim[0]': ['sha256:b15c35da54dd016492f397d71a59883d38cfb0c5e55aaa51f68c4d3f210d1909', 'claim:scope-1'],
    'source-claim[1]': ['sha256:cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da', 'claim:scope-2'],
    'source-claim[2]': ['sha256:6652762b7d8d26aacbaeb11f1b1e1529b26c2974ecf8ab0a01f0eb2b651d753b', 'claim:constraint-1'],
    'source-claim[3]': ['sha256:3d576e96e9c101b4b7187be8ce0d6f4542c161e8b8f9fa7323397329ac4e85b0', 'claim:outcome-1'],
    'constraint[0]': ['sha256:807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be', 'constraint:retention-1'],
    'unknown[0]': ['sha256:38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf', 'unknown:browser-matrix-1'],
    'terminal-claim[0]': ['sha256:4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f', 'terminal:audited-1'],
    'terminal-claim[1]': ['sha256:8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988', 'terminal:delivered-1'],
    'upstream-accepted[0]': ['sha256:65fe9a225a4425880513ae5321cce4d9b75c44e88fb3054f5e7f997b6956ee66', 'accepted revision of derive-system-requirements'],
  },
  skillPins: {
    protocolSkillRef: 'sha256:bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
    semanticSkillRef: 'sha256:2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
  },
  workspaceSummary: 'workspace: 1 accepted upstream revisions travel by content address',
  writeAuthority: 'write authority: desk artifacts only; allowed=candidate-read,product-read,product-submit',
};

/* ------------------------------------------------------------------ */
/* H. envelope identity: this frame == the standing staffing's pins     */
/* ------------------------------------------------------------------ */
const pins = vv.content.envelopePins;
const frameRefs = Object.fromEntries(Object.entries(THIS_FRAME.projectionRefs).map(([k, [ref, id]]) => [id, ref.slice(7)]));
const strip = (r) => (r.startsWith('sha256:') ? r.slice(7) : r);
let h1ok = Object.keys(pins.taskProjectionContentAddresses).length === 8;
for (const [id, digest] of Object.entries(pins.taskProjectionContentAddresses)) {
  h1ok = h1ok && frameRefs[id] === strip(digest);
}
check('H1.projectionRefs.equal', h1ok, '8/8 task-projection content addresses of this frame equal the standing staffing pins (VV envelopePins)');
check('H2.skillPins.equal', pins.protocolSkillRef === THIS_FRAME.skillPins.protocolSkillRef && pins.semanticSkillRef === THIS_FRAME.skillPins.semanticSkillRef, 'protocol bc8a4261 / semantic 2cbcf850 pins equal');
check('H3.upstreamProjection.equal', strip(pins.upstreamAcceptedProjection.address) === frameRefs['accepted revision of derive-system-requirements'], `upstream-accepted[0] ${pins.upstreamAcceptedProjection.address.slice(0, 16)}… equal (with the standing UNRESOLVABLE adjudication)`);
check('H4.workspaceAndAuthority.equal', fr.content.workspaceAdjudication.envelopeProjection.includes('1 accepted upstream revisions travel by content address')
  && fr.content.workspaceAdjudication.envelopeProjection.includes(pins.upstreamAcceptedProjection.address)
  && fs.content.acceptanceCriteriaSelfCheck.some((c) => c.id === 10 && c.satisfied === true && c.description.includes('candidate-read') && c.description.includes('product-submit')),
  'workspace summary line and write authority equal the standing staffing (FR workspaceAdjudication; FS self-check 10)');

/* ------------------------------------------------------------------ */
/* R. standing package of record recomputed from raw bytes              */
/* ------------------------------------------------------------------ */
check('R1.vv.selfAddress', sha(vv.content) === vv.contentDigest && vv.artifactRef === shaRef(vv.contentDigest) && vv.content.verificationId === 'VV-Derive-System-Requirements-001', `recomputed ${sha(vv.content)}`);
check('R2.fr.selfAddress', sha(fr.content) === fr.contentDigest && fr.artifactRef === shaRef(fr.contentDigest) && fr.content.reviewId === 'FR-Derive-System-Requirements-001' && fr.content.verdict === 'repair', `recomputed ${sha(fr.content)}, verdict=${fr.content.verdict}`);
check('R3.rt.selfAddress', sha(rt.content) === rt.contentDigest && rt.traceRef === shaRef(rt.contentDigest) && rt.content.traceId === 'RT-Derive-System-Requirements-001' && rt.content.verdict === 'repair' && rt.content.relationships.length === 6, `recomputed ${sha(rt.content)}, ${rt.content.relationships.length} edges`);
check('R4.fs.selfAddress', sha(fs.content) === fs.contentDigest && fs.submissionRef === shaRef(fs.contentDigest) && fs.content.verdict === 'repair' && fs.content.candidate.artifactRef === fr.artifactRef && fs.content.reviewRef === fr.artifactRef && fs.content.verificationRef === vv.artifactRef && fs.content.traceRef === rt.traceRef, `recomputed ${sha(fs.content)}; FS binds FR+VV+RT; verdict=${fs.content.verdict}`);
check('R5.subject.trio', sha(art.content) === art.contentDigest && sha(trc.content) === trc.contentDigest && sha(sub.content) === sub.contentDigest
  && art.artifactRef === shaRef(art.contentDigest) && trc.traceRef === shaRef(trc.contentDigest) && sub.submissionRef === shaRef(sub.contentDigest),
  `author trio recomputes: SR ${sha(art.content).slice(0, 16)}… / trace ${sha(trc.content).slice(0, 16)}… / FS-001 ${sha(sub.content).slice(0, 16)}…`);
check('R6.noContentDelta', fr.content.reviewedCandidate.artifactRef === art.artifactRef
  && fr.content.reviewedCandidate.submissionRef === sub.submissionRef
  && fr.content.reviewedCandidate.traceRef === trc.traceRef
  && vv.content.subject.artifactRef === art.artifactRef
  && fs.content.reviewedCandidateRefs.artifactRef === art.artifactRef,
  'C1: the reviewed subject recomputes to the exact address the standing staffing reviewed (author trio unchanged)');
const frCoverage = fr.content.acceptanceCriteria;
const unsatisfiedIds = frCoverage.filter((c) => c.satisfied === false).map((c) => c.id);
check('R7.fr.verdictStructure', fr.content.verdict === 'repair'
  && JSON.stringify(unsatisfiedIds) === JSON.stringify([6, 10, 11, 12])
  && fr.content.findings.criticalIssues.length === 2 && fr.content.findings.majorIssues.length === 1
  && fr.content.requiredActions.length === 5,
  'FR structure of record: verdict repair, unsatisfied criteria exactly [6,10,11,12], CRIT-1/CRIT-2 + MAJ-1, RA-1..RA-5');

/* R8. desk-state census: nothing new since the standing staffing. */
const dirFiles = readdirSync(DIR);
const PRED = 'derive-system-requirements-desk-reviewer-restaff';
const predRestaff = dirFiles.filter((f) => f.startsWith(PRED) && !f.startsWith(`${PRED}2`));
const restaff2Mine = dirFiles.filter((f) => f.startsWith(`${PRED}2`));
const authorSubmissions = dirFiles.filter((f) => f === 'derive-system-requirements-desk-product-submission.json');
const adjudication = dirFiles.filter((f) => /adjudic|human-response|settlement|final-gate-result/i.test(f));
const ucReviewer = dirFiles.filter((f) => f.startsWith('model-use-cases-desk') && f.includes('reviewer'));
check('R8.census.noNewMaterial', authorSubmissions.length === 1 && adjudication.length === 0 && ucReviewer.length === 0 && predRestaff.length === 0,
  `single author submission of record (FS-...-001); 0 adjudication/settlement records; 0 model-use-cases reviewer artifacts; 0 predecessor re-staff emissions for this seat (this is staffing #2); restaff2 files at verify time: ${restaff2Mine.length}`);

/* ------------------------------------------------------------------ */
/* K. REAL kernel re-run                                                */
/* ------------------------------------------------------------------ */
const ENVELOPE = frameRefs;
const upSeal = new Map();
for (const m of upArt.content.members) {
  const v = prd03.validatePrdIntentMember(m, {
    idSets: {
      sourceClaimIds: Object.keys(ENVELOPE).filter((id) => id.startsWith('claim:')),
      terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'],
    },
  });
  upSeal.set(m.memberId, sha(m));
  if (!v.ok) check('K8.upstreamFold', false, `PRD refusal ${v.reason}`);
}
const upFold = upCell.acceptedIntentSetOf(
  { members: upArt.content.members },
  upArt.content.members.map((m) => ({ memberId: m.memberId, digest: upSeal.get(m.memberId) })),
);
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
check('K8.folds.rederive', upFold.ok === true && upFold.set.revisionDigest === 'a30229a75bed4c5d7b4a9660f6a7644d333e6c0c63064901da9aa020cadca770'
  && ucRevisionDigest === '184981e5724c286d1ad71da645abd6fa8ee78ff8cba3746fbe461d4096b2457e'
  && art.content.product.prdRevisionRef === shaRef(upFold.set.revisionDigest)
  && art.content.product.ucRevisionRef === shaRef(ucRevisionDigest),
  `both upstream folds re-derive through the REAL validators + cell folds: prd ${upFold.set.revisionDigest.slice(0, 16)}…, uc ${ucRevisionDigest.slice(0, 16)}…; bundle pins byte-exact`);
const deskUniverse = srCell.deriveAcceptedUniverse({
  prd: { revisionDigest: upFold.set.revisionDigest, memberIds: [...upFold.set.prdMemberIds] },
  useCases: {
    revisionDigest: ucRevisionDigest,
    scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(),
    branchIdsByScenario: Object.fromEntries(ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)])),
  },
  sourceConstraintIds: ['constraint:retention-1'],
  verificationSurfaceIds: art.content.deskInput.verificationSurfaceIds,
});
check('K3.universe.derived', deskUniverse.ok === true, deskUniverse.ok ? 'REAL deriveAcceptedUniverse derives the accepted universe (desk protocol, fail-closed)' : deskUniverse.detail);
const wp03Seal = wp03.validateRequirementsBundle(art.content.product, deskUniverse.universe);
check('K4.wp03.sealStable', wp03Seal.ok === true && wp03Seal.ref === 'sha256:60083eb4a2ba553d0924c9b9ffe12ad9e703f9adc2f7da6bd5584a1747620690' && wp03Seal.ref === shaRef(sha(art.content.product)), `WP03 seal recomputes to the standing address ${wp03Seal.ref}`);
const declared = srCell.declaredSystemRequirementsProvider();
const seam = srCell.bindWp03RequirementsValidator(wp03);
check('K1.provider.seam', declared.ok === true && declared.provider.providerId === 'formalization.requirements-structure.v1' && seam.bound === true, `provider ${declared.provider.providerId}; seam binder fail-closed self-test passes`);
const candidate = srCell.candidateOf(art.content.product);
const gate = srCell.gateSystemRequirementsCandidate(declared.ok ? declared.provider : undefined, candidate, deskUniverse.ok ? deskUniverse.universe : undefined, seam);
check('K5.gate.accepted', gate.verdict === 'accepted', gate.verdict === 'accepted' ? `author-stage cell gate re-runs to accepted (${gate.results?.length ?? 0} checks)` : JSON.stringify({ verdict: gate.verdict, issues: gate.issues }));
const kernelRoute = srCell.reviewRequirementsBundle(candidate, deskUniverse.ok ? deskUniverse.universe : undefined, seam);
check('K6.kernelRoute.accept', kernelRoute.disposition === 'accept' && kernelRoute.productRef === wp03Seal.ref,
  `kernel reviewer route (mechanical surface only) -> ${kernelRoute.disposition}; the DESK verdict of record stays repair by the M-layer authority (acceptance-status audit) - consistent with the standing 77/80 whose only failures are M4/M5/M6`);
const mutated = (fn) => { const clone = structuredClone(candidate); fn(clone.product); return clone; };
const foreign = srCell.gateSystemRequirementsCandidate(declared.provider, mutated((p) => { p.requirements[0].derivation.prdIntentRefs = ['prd:FOREIGN']; }), deskUniverse.universe, seam);
check('K7.probe.foreignLineage', foreign.verdict === 'upstream-repair', `negative probe: foreign lineage -> ${foreign.verdict} (the gate is real, not rubber-stamped)`);

/* ------------------------------------------------------------------ */
/* M. the verdict rationale of record still stands                      */
/* ------------------------------------------------------------------ */
const intentVerdicts = [iRevA, iRevB, iRev2];
check('M4.acceptanceClaims.stillFalse', intentVerdicts.every((r) => r.content.verdict === 'repair') && ucReviewer.length === 0
  && String(art.content.upstream.materialAuthority).includes('accepted') === true
  && art.content.verification.revisionPinsMatchAcceptedRevisions === true,
  'CRIT-1 stands: the candidate still asserts accepted material authority; all intent emissions still carry verdict repair; the UC bundle still has no reviewer stage - no accepted upstream revision exists in r2');
const vsa = iArt.content.verifiedSubArtifacts;
const sc2 = vsa.sourceClaims.find((x) => x.content.claimId === 'claim:scope-2');
const cert = vsa.certificate;
const sc2Bare = sc2 !== undefined && sha(sc2.content) === ENVELOPE['claim:scope-2'] && Object.keys(sc2.content).sort().join(',') === 'claimId,statement';
const certSubjectLevel = cert !== undefined && sha(cert.content) === '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21'
  && JSON.stringify(sortKeys(cert.content)).includes('"decision":"go"') && !JSON.stringify(sortKeys(cert.content)).includes('scope');
check('M5.scope2Authority.stillAbsent', sc2Bare && certSubjectLevel
  && String(art.content.brief).includes('out-of-scope'),
  'CRIT-2 stands: SC-2 recomputes to a bare {claimId,statement} claim; CERT-1 is a subject-level go; no exclusion decision exists; the candidate brief still restates the exclusion');
check('M6.selfContradiction.stillPresent', art.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && String(art.content.upstream.materialAuthority).includes('accepted'),
  'MAJ of record stands: workspaceSummary 0-count vs materialAuthority "accepted" - the author-trio contradiction persists');
check('M7.ra.stillOpen', adjudication.length === 0
  && !JSON.stringify(sortKeys(art.content)).includes('SHA256REPAIR'),
  'RA-1..RA-5 remain open: no adjudication, no reissued candidate, no re-sealed governing contract since the standing staffing');

/* ------------------------------------------------------------------ */
/* N. governing-contract resolvability scan (workspace-wide)            */
/* ------------------------------------------------------------------ */
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const ENVELOPE_ACCEPTED = '65fe9a225a4425880513ae5321cce4d9b75c44e88fb3054f5e7f997b6956ee66';
const walk = (dir) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};
const wsFiles = walk(QUAL);
let gRaw = 0, gCanon = 0, gContent = 0;
let aRaw = 0, aCanon = 0, aContent = 0, aText = 0;
for (const p of wsFiles) {
  let buf;
  try { buf = readFileSync(p); } catch { continue; }
  const text = buf.toString('utf8');
  if (shaBytes(buf) === GOVERNING) gRaw += 1;
  if (shaBytes(buf) === ENVELOPE_ACCEPTED) aRaw += 1;
  if (text.includes(ENVELOPE_ACCEPTED)) aText += 1;
  if (p.endsWith('.json')) {
    try {
      const j = JSON.parse(text);
      if (sha(j) === GOVERNING) gCanon += 1;
      if (j && typeof j === 'object' && j.content !== undefined && sha(j.content) === GOVERNING) gContent += 1;
      if (sha(j) === ENVELOPE_ACCEPTED) aCanon += 1;
      if (j && typeof j === 'object' && j.content !== undefined && sha(j.content) === ENVELOPE_ACCEPTED) aContent += 1;
    } catch { /* non-JSON body */ }
  }
}
check('N1.governingContract.stillUnresolvable', gRaw === 0 && gCanon === 0 && gContent === 0, `MAJ-1 stands: sha256:${GOVERNING.slice(0, 16)}… scanned ${wsFiles.length} files under qualification/ - raw ${gRaw}, canonical ${gCanon}, .content ${gContent} hits (0 expected; RA-4 still open)`);

/* ------------------------------------------------------------------ */
/* O. envelope upstream-accepted projection adjudication                */
/* ------------------------------------------------------------------ */
check('O1.envelopeProjection.stillUnresolvable', aRaw === 0 && aCanon === 0 && aContent === 0,
  `upstream-accepted[0] sha256:${ENVELOPE_ACCEPTED.slice(0, 16)}… :: "accepted revision of derive-system-requirements": raw ${aRaw}, canonical ${aCanon}, .content ${aContent} hits across ${wsFiles.length} files; textual mentions ${aText} (informational - quotes in review documents, the 745cadc1… precedent). Adjudication of record stands: UNRESOLVABLE - no accepted revision of derive-system-requirements exists (verdict of record repair; the author desk has not reissued; the final gate never ran).`);
check('O2.authorPositionZero.upheld', art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0 && fs.content.workspaceSummary === '0 accepted upstream revisions travel by content address',
  'author 0 upheld at the desk layer; this staffing\'s reviewer-side accepted-revision count is likewise 0');

/* ------------------------------------------------------------------ */
/* A. emission discipline evidence                                      */
/* ------------------------------------------------------------------ */
const STANDING = [
  'derive-system-requirements-desk-reviewer-verification.json',
  'derive-system-requirements-desk-reviewer-review.json',
  'derive-system-requirements-desk-reviewer-trace.json',
  'derive-system-requirements-desk-reviewer-product-submission.json',
  'derive-system-requirements-desk-reviewer-verify-out.json',
  'derive-system-requirements-desk-reviewer-submission-summary.md',
  'derive-system-requirements-desk-reviewer-verify.mjs',
  'derive-system-requirements-desk-reviewer-build.mjs',
  'derive-system-requirements-desk-system-requirements.artifact.json',
  'derive-system-requirements-desk-system-requirements-trace.json',
  'derive-system-requirements-desk-product-submission.json',
  'derive-system-requirements-desk-submission-summary.md',
  'derive-system-requirements-desk-author-verify.mjs',
  'derive-system-requirements-desk-author-verify-out.json',
];
check('A1.standingFiles.intact', STANDING.every((f) => dirFiles.includes(f)), `all ${STANDING.length} standing desk files present and every self-address recomputed above (R1-R5) - zero standing bytes modified by this staffing`);
check('A2.singleSeat.restaff2Namespace', restaff2Mine.every((f) => f.startsWith('derive-system-requirements-desk-reviewer-restaff2-')) && predRestaff.length === 0,
  `this emission writes ONLY restaff2-namespaced files (ADV-5); at verify time: ${restaff2Mine.length} file(s)`);

/* ------------------------------------------------------------------ */
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; re-staffing #2 of the derive-system-requirements reviewer seat (byte-equivalent envelope): verify-and-confirm, no second submission; WP03 validator: real requirements-bundle.mjs through the REAL seam binder; gate + reviewer route: real dist system-requirements cell; universe: real deriveAcceptedUniverse desk protocol',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failedCheckIds: failed.map((r) => r.id),
  results,
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
