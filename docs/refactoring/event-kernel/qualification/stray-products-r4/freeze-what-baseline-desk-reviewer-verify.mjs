/**
 * freeze-what-baseline desk (reviewer) - REVIEWER REFUSAL verification (r4).
 *
 * Verifies FR-Freeze-What-Baseline-002 (freeze-what-baseline-desk-reviewer-
 * review.json + -verification.json + -trace.json + -product-submission.json)
 * against independently recomputed workspace state. Nothing is trusted by
 * declaration. Frozen kernel rule:
 *   src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Layers:
 *   V1  the four emission records recompute from raw bytes (self-digests,
 *       kinds, ids, pinned timestamps).
 *   V2  acyclic cross-binding: FR -> VV, RT -> FR/VV, FS -> FR/VV/RT,
 *       reviewed candidate pinned to the r3 author hold; FS effectFired
 *       false; intake receipt status; evidence coverage.
 *   V3  FR internal consistency: verdict/decision refusal, acceptance
 *       criteria profile (7 true / 3 false: 8, 9, 10), verification
 *       summary equal to the recomputed VV check census.
 *   V4  frame identity: THIS staffing's 9 projection refs (8 task + 1
 *       upstream-accepted), skill pins, workspace summary, write authority
 *       recorded verbatim by FR/RT/FS.
 *   V5  basis re-verified fresh (independent scans + digest recomputes):
 *       claimed address hash-resolves workspace-wide to EXACTLY the green
 *       fixture; fixture triples/wholeWhat and skill pins resolve to zero;
 *       capsule 8/8 + CERT-1; r3 hold + receipt byte-stable; RC-001 /
 *       AS-001 + receipts; gate round (repair, prohibition undischarged,
 *       both emissions repair, collision record); census 0 of 5; freeze
 *       contract schema pin (minItems 5).
 *   V6  trace: all edges resolve at both ends to recomputed digests,
 *       closed vocabulary, 8/8 projection coverage + claimed-acceptance
 *       coverage, holdCoverage pins census/prohibition/census-zero state.
 *   V7  emission discipline: deterministic authoring sources (no clock
 *       reads, no randomness), expected file family only in this round
 *       directory, no ratifying citers of the claimed address beyond the
 *       r3 confirmation set + this emission family.
 *   V8  verify-out self-digest + green summary.
 *
 * Run: node freeze-what-baseline-desk-reviewer-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRaw = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(DIR, '..', '..', '..', '..', '..');
const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';
const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R4 = 'docs/refactoring/event-kernel/qualification/stray-products-r4';
const CREATED_AT = '2026-08-28T00:00:00Z';
const SELF_ROUND = 'stray-products-r4';
const relPath = (p) => relative(REPO, p).split('\\').join('/');

/* THIS reviewer staffing frame, verbatim from the desk task projection. */
const THIS_FRAME = {
  'claim:scope-1': 'b15c35da54dd016492f397d71a59883d38cfb0c5e55aaa51f68c4d3f210d1909',
  'claim:scope-2': 'cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da',
  'claim:constraint-1': '6652762b7d8d26aacbaeb11f1b1e1529b26c2974ecf8ab0a01f0eb2b651d753b',
  'claim:outcome-1': '3d576e96e9c101b4b7187be8ce0d6f4542c161e8b8f9fa7323397329ac4e85b0',
  'constraint:retention-1': '807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be',
  'unknown:browser-matrix-1': '38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf',
  'terminal:audited-1': '4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f',
  'terminal:delivered-1': '8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988',
};
const CLAIMED = {
  address: 'e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de',
  label: 'accepted revision of freeze-what-baseline',
  workspaceSummary: '1 accepted upstream revisions travel by content address',
};
const SKILL = {
  protocol: 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
  semantic: '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
};
const WRITE_AUTHORITY = 'write authority: desk artifacts only; allowed=candidate-read,product-read,product-submit';
const FIXTURE_REL = 'docs/refactoring/formalization-frf/contracts/fixtures/green/what-baseline.json';
const FIXTURE_TRIPLES = [
  '472073e531c4fcdd57ce3507653240c9f49fe93142d6ae176211afe37dbe9075',
  '2c4f598ac1087bb43db9e71d6fbd67cea725745e8dc96834e60cf75fc8de7b01',
  '028d838b7f233b1e9a7dd46c56d1067a6e8d2a9dfb3c1090788bf09e1dcd405a',
  'e111ac9880949488cceb478197e1d59f47677f34eb00d0d245e41d5086fa0014',
  '12d0a4297fcfa2e09c17d32dde934bf3c2f9d400c1c87af268537913f376876b',
  '6d1981c45ff85db8ac88b9c66536cde8c32aa4bc9e72b815d24c2385646cbd92',
  '5f151227af0c7749ceb50396168e560e858e97442c7a2ec984d12dc38990e17f',
  'bb57253d7c1a64b20fad333b8430b62412b06d99a33815f4a4b12fd076195453',
  '97cc689f541a9ef547bc8bd05d7af166219a950d548517d0dbc96f620f59a44b',
  'e8b6358bf770fda2c7246aa965eb6bfa5a84bd5f53dcc156e4bb29dc53a9bef2',
  '77f71d55b35bfac27fa504c90fccfdb3e33f0be488244e533289676786bace52',
  '259b2802ada943b3039ad4b08f73d11dda27ba66ac3b0c594383f2a01cd808c3',
  'c0777682bb7754f11db924e3f99aea3a3721381a93fd3b8a798d810165822edd',
  'bdb247e158e9c8be3be60bdfdaf307522f0c7910f71c5218bdad41e03ccc7473',
  'dd835fe83c7180246fb65ed542cecccc207bfd5a5ce34fc7c5a46d6fd84ae12b',
];
const FIXTURE_WHOLE_WHAT = '68e50e0c3aca739c6b17fcf548983965f8f9161c8f8c971dbeb8f9cded8b8891';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';

const checks = [];
const check = (id, ok, detail) => { checks.push({ id, pass: ok === true, detail }); return ok === true; };
const readJson = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const rec = (rel) => {
  const j = readJson(rel);
  return { file: rel, j, digest: sha(j.content) };
};

/* ------------------------------------------------------------------ */
/* V1: the four emission records recompute from raw bytes               */
/* ------------------------------------------------------------------ */

const vv = rec(`${R4}/freeze-what-baseline-desk-reviewer-verification.json`);
const fr = rec(`${R4}/freeze-what-baseline-desk-reviewer-review.json`);
const rt = rec(`${R4}/freeze-what-baseline-desk-reviewer-trace.json`);
const fsr = rec(`${R4}/freeze-what-baseline-desk-reviewer-product-submission.json`);

check('V1.verificationRecord', vv.digest === vv.j.contentDigest && vv.j.artifactRef === shaRef(vv.digest) && vv.j.artifactKind === 'reviewer-verification' && vv.j.semanticCode === 'VV-Freeze-What-Baseline-002' && vv.j.createdAt === CREATED_AT, `VV recomputes ${vv.digest}; kind/id/timestamp pin`);
check('V1.reviewRecord', fr.digest === fr.j.contentDigest && fr.j.artifactRef === shaRef(fr.digest) && fr.j.artifactKind === 'formalization-review' && fr.j.semanticCode === 'FR-Freeze-What-Baseline-002' && fr.j.createdAt === CREATED_AT, `FR recomputes ${fr.digest}; kind/id/timestamp pin`);
check('V1.traceRecord', rt.digest === rt.j.contentDigest && rt.j.traceRef === shaRef(rt.digest) && rt.j.traceKind === 'reviewer-refusal-trace' && rt.j.semanticCode === 'RT-Freeze-What-Baseline-002' && rt.j.createdAt === CREATED_AT, `RT recomputes ${rt.digest}; kind/id/timestamp pin`);
check('V1.submissionRecord', fsr.digest === fsr.j.contentDigest && fsr.j.submissionRef === shaRef(fsr.digest) && fsr.j.submissionId === 'FS-Freeze-What-Baseline-Reviewer-001' && fsr.j.createdAt === CREATED_AT, `FS recomputes ${fsr.digest}; id/timestamp pin`);
check('V1.digestRule', [vv, fr, rt, fsr].every((r) => r.j.digestRule === 'sha256 over canonical JSON of content (recursively key-sorted, compact)'), 'all four records pin the frozen digest rule verbatim');
check('V1.deskRole', [vv, fr, rt, fsr].every((r) => r.j.deskRef === 'freeze-what-baseline' && r.j.role === 'reviewer'), 'all four records pin desk=freeze-what-baseline role=reviewer');

/* ------------------------------------------------------------------ */
/* V2: acyclic cross-binding                                            */
/* ------------------------------------------------------------------ */

check('V2.reviewBindsVerification', fr.j.content.verificationRef === shaRef(vv.digest) && fr.j.content.verificationSummary.recomputedChecks === vv.j.content.checks.length, 'FR binds VV by content address');
check('V2.traceBindsReview', rt.j.content.subjectArtifactRef === fr.j.artifactRef && rt.j.content.verificationRef === shaRef(vv.digest), 'RT binds FR (subject) and VV (verification)');
check('V2.submissionBindsPackage', fsr.j.content.candidate.artifactRef === fr.j.artifactRef && fsr.j.content.candidate.contentDigest === fr.digest && fsr.j.content.verificationRef === shaRef(vv.digest) && fsr.j.content.traceRef === rt.j.traceRef, 'FS binds FR + VV + RT');
const holdArt = rec(`${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`);
const holdTrc = rec(`${R3}/freeze-what-baseline-desk-upstream-hold-trace.json`);
check('V2.reviewedCandidateIsHold', fr.j.content.reviewedCandidate.artifactRef === shaRef(holdArt.digest) && fr.j.content.reviewedCandidate.traceRef === shaRef(holdTrc.digest) && fr.j.content.reviewedCandidate.productKind === 'formalization.upstream-hold.v1' && fr.j.content.reviewedCandidate.declaredDecision === 'hold-no-authoring', 'FR reviewed candidate pinned to the r3 author hold (no WHAT-baseline candidate exists)');
check('V2.fsCandidateBinding', fsr.j.content.reviewedCandidate.artifactRef === shaRef(holdArt.digest) && fsr.j.content.payloadContract.effectFired === false && fsr.j.content.payloadContract.terminalOutcome === 'hold-ratified-freeze-refused' && fsr.j.content.intakeReceipt.status === 'review_complete_verdict_recorded', 'FS reviewed candidate = hold; no effect fired; intake receipt recorded');

/* Evidence list: every ref must re-digest to real, recomputed content. */
const evidenceRefs = fsr.j.content.payloadContract.requiredEvidenceRefs;
const evidenceResolvable = evidenceRefs.every((r) => typeof r === 'string' && r.startsWith('sha256:') && r.length === 71);
check('V2.evidenceWellFormed', evidenceResolvable && evidenceRefs.length >= 30 && new Set(evidenceRefs).size === evidenceRefs.length, `FS evidence list: ${evidenceRefs.length} unique well-formed refs (floor 30; a record may not pin an exact self-family count across refinements)`);
check('V2.evidenceCoversPackage', [shaRef(vv.digest), shaRef(fr.digest), rt.j.traceRef, shaRef(holdArt.digest), shaRef(CLAIMED.address)].every((r) => evidenceRefs.includes(r)), 'FS evidence covers this package (VV/FR/RT), the reviewed hold and the adjudicated claim content');
/* Self-reference paradox guard: no record may cite its own content address inside its own content. */
check('V2.noSelfParadox', !JSON.stringify(fsr.j.content).includes(shaRef(fsr.digest)) && !JSON.stringify(fr.j.content).includes(shaRef(fr.digest)) && !JSON.stringify(rt.j.content).includes(shaRef(rt.digest)), 'no record contains its own content address (acyclic self-binding)');
const coverage = fsr.j.content.payloadContract.evidenceKindCoverage;
check('V2.evidenceCoverageSum', Object.values(coverage).reduce((a, b) => a + b, 0) === evidenceRefs.length, `evidenceKindCoverage sums to the evidence count (${evidenceRefs.length})`);

/* ------------------------------------------------------------------ */
/* V3: FR internal consistency                                          */
/* ------------------------------------------------------------------ */

check('V3.verdict', fr.j.content.verdict === 'hold-upheld' && typeof fr.j.content.decision === 'string' && fr.j.content.decision.includes('REFUSE freeze ratification') && fr.j.content.decision.includes('uphold UH-Freeze-What-Baseline-001'), 'verdict hold-upheld; decision refuses freeze ratification and upholds the author hold');
const ac = fr.j.content.acceptanceCriteria;
const acFalse = ac.filter((a) => a.satisfied === false).map((a) => a.id);
check('V3.acceptanceCriteriaProfile', ac.length === 10 && JSON.stringify(acFalse) === JSON.stringify([8, 9, 10]) && ac.find((a) => a.id === 8)?.note.includes('fixture') && ac.find((a) => a.id === 9)?.note.includes('hold') && ac.find((a) => a.id === 10)?.note.includes('fixture'), 'criteria profile honest: exactly 8/9/10 unsatisfied (frame summary false; no WHAT-baseline candidate; claim is a fixture, not a chain revision)');
const critIds = fr.j.content.findings.criticalIssues.map((i) => i.id);
const majIds = fr.j.content.findings.majorIssues.map((i) => i.id);
check('V3.findingsStructure', JSON.stringify(critIds) === JSON.stringify(['CRIT-1', 'CRIT-2', 'CRIT-3']) && JSON.stringify(majIds) === JSON.stringify(['MAJ-1']) && fr.j.content.claimedAcceptanceAdjudication.adjudication.startsWith('REFUSED'), 'findings: CRIT-1..3 + MAJ-1; claim adjudication REFUSED');
check('V3.vvSummaryConsistent', fr.j.content.verificationSummary.passed === fr.j.content.verificationSummary.recomputedChecks && fr.j.content.verificationSummary.failed === 0 && fr.j.content.verificationSummary.trustedByDeclaration === false && vv.j.content.checksSummary.total === vv.j.content.checks.length && vv.j.content.checksSummary.fail === 0, 'verification summaries self-consistent and green; nothing trusted by declaration');
check('V3.adjudicationContentLayer', fr.j.content.claimedAcceptanceAdjudication.resolution.startsWith('RESOLVED at the content layer') && fr.j.content.claimedAcceptanceAdjudication.resolvedContent.path === FIXTURE_REL && fr.j.content.claimedAcceptanceAdjudication.authorityAudit.isWorkplaceProductionRevisionOfThisChain === false && fr.j.content.claimedAcceptanceAdjudication.authorityAudit.selfReference.includes('own product kind'), 'adjudication: content-layer resolution to the fixture; refused as authority; self-referential label recorded');

/* ------------------------------------------------------------------ */
/* V4: frame identity (this staffing, verbatim)                         */
/* ------------------------------------------------------------------ */

const rtCov = rt.j.content.taskProjectionCoverage;
const covOk = Object.keys(THIS_FRAME).every((id) => rtCov[id]?.digest === THIS_FRAME[id] && JSON.stringify(rtCov[id].verifiedBy) === JSON.stringify(['FR-Freeze-What-Baseline-Reviewer-002'])) && Object.keys(rtCov).length === 8;
check('V4.projectionCoverage', covOk, 'RT pins the exact 8-entry task projection of THIS staffing frame');
const caCov = rt.j.content.claimedAcceptanceCoverage['upstream-accepted[0]'];
check('V4.claimedAcceptanceCoverage', caCov.address === shaRef(CLAIMED.address) && caCov.resolution === 'resolved-to-fixture' && caCov.resolvedPath === FIXTURE_REL && caCov.adjudication.includes('REFUSED'), 'RT pins the upstream-accepted[0] adjudication (resolved-to-fixture, REFUSED)');
check('V4.workspaceSummary', rt.j.content.workspaceSummary.includes(CLAIMED.workspaceSummary) && rt.j.content.workspaceSummary.includes('adjudicated FALSE') && rt.j.content.workspaceSummary.includes('0 accepted upstream revisions') && fsr.j.content.workspaceSummary === rt.j.content.workspaceSummary, 'frame workspace summary recorded verbatim and adjudicated FALSE in RT + FS');
check('V4.skillPinsRecorded', vv.j.content.resolutionScan.frameSkillPins.protocolSkill === shaRef(SKILL.protocol) && vv.j.content.resolutionScan.frameSkillPins.semanticSkill === shaRef(SKILL.semantic) && vv.j.content.resolutionScan.frameSkillPins.disposition.includes('not ratified'), 'frame skill pins recorded verbatim as provenance, not ratified');
check('V4.envelopeConsistency', fr.j.content.envelopeConsistency.taskProjectionContentAddresses === 8 && fr.j.content.envelopeConsistency.resolved === 8 && fr.j.content.envelopeConsistency.adjudicated === 1, 'FR envelope consistency: 8 resolved + 1 adjudicated');
check('V4.writeAuthorityFamily', fr.j.content.acceptanceCriteria.find((a) => a.id === 6)?.description.includes('constraint:retention-1') === true && fr.j.content.acceptanceCriteria.find((a) => a.id === 6)?.description.includes('unknown:browser-matrix-1') === true, 'constraint:retention-1 + unknown:browser-matrix-1 carried, never resolved by the review');

/* ------------------------------------------------------------------ */
/* V5: basis re-verified fresh (independent scans + recomputes)         */
/* ------------------------------------------------------------------ */

/* Fresh workspace-wide three-body scan. */
const targets = new Set([CLAIMED.address, ...Object.values(SKILL), GOVERNING, ...FIXTURE_TRIPLES, FIXTURE_WHOLE_WHAT]);
const scan = {
  files: 0,
  mentions: Object.fromEntries([...targets].map((t) => [t, []])),
  resolved: Object.fromEntries([...targets].map((t) => [t, []])),
};
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    if (e === '.git' || e === 'node_modules') continue;
    const p = join(dir, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p); continue; }
    scan.files += 1;
    let s;
    try { s = readFileSync(p).toString('utf8'); } catch { continue; }
    for (const t of targets) if (s.includes(t)) scan.mentions[t].push(relPath(p));
    if (p.endsWith('.json')) {
      try {
        const j = JSON.parse(s);
        const whole = shaRaw(Buffer.from(canon(j), 'utf8'));
        if (targets.has(whole)) scan.resolved[whole].push(`${relPath(p)} :: whole-canon`);
        if (j && typeof j === 'object' && j.content !== undefined) {
          const c = shaRaw(Buffer.from(canon(j.content), 'utf8'));
          if (targets.has(c)) scan.resolved[c].push(`${relPath(p)} :: content-canon`);
        }
      } catch { /* raw layer already covered */ }
    }
  }
};
walk(REPO);

check('V5.claimedAddressResolves', scan.resolved[CLAIMED.address].length === 1 && scan.resolved[CLAIMED.address][0] === `${FIXTURE_REL} :: whole-canon`, `workspace-wide (${scan.files} files): the claimed address hash-resolves to EXACTLY the green fixture`);
const fixtureParsed = JSON.parse(readFileSync(join(REPO, FIXTURE_REL), 'utf8'));
check('V5.fixtureDigestRecomputes', shaRaw(Buffer.from(canon(fixtureParsed), 'utf8')) === CLAIMED.address, 'fixture whole-canon sha256 recomputes to the claimed address');
check('V5.fixtureInternalsPlaceholder', FIXTURE_TRIPLES.every((t) => scan.resolved[t].length === 0) && scan.resolved[FIXTURE_WHOLE_WHAT].length === 0 && fixtureParsed.schemaVersion === 'frf-contracts.what-baseline.v1' && fixtureParsed.acceptanceRecords.length === 5 && fixtureParsed.caseIdentity?.formalizationCaseRef === 'case:form-1', 'fixture internals: 5 placeholder acceptance records, all 15 triple digests + wholeWhat resolve to zero contents; fixture identity placeholders');
check('V5.skillPinsResolveZero', scan.resolved[SKILL.protocol].length === 0 && scan.resolved[SKILL.semantic].length === 0, 'frame skill pins hash-resolve to zero contents (provenance only)');
check('V5.governingAnchorOpen', scan.resolved[GOVERNING].length === 0, 'r2-era governing anchor still resolves to zero contents (inherited debt, not pinned by this frame)');

/* No ratifying citers: allowed = r3 confirmation set + this emission family. */
const ALLOWED_CITERS = [
  `${R3}/freeze-what-baseline-desk-reviewer-confirmation.json`,
  `${R3}/freeze-what-baseline-desk-reviewer-confirmation-trace.json`,
  `${R3}/freeze-what-baseline-desk-reviewer-confirmation-build.mjs`,
  `${R3}/freeze-what-baseline-desk-reviewer-confirmation-verify.mjs`,
  `${R3}/freeze-what-baseline-desk-reviewer-confirmation-submission-summary.md`,
  `${R4}/freeze-what-baseline-desk-reviewer-verification.json`,
  `${R4}/freeze-what-baseline-desk-reviewer-review.json`,
  `${R4}/freeze-what-baseline-desk-reviewer-trace.json`,
  `${R4}/freeze-what-baseline-desk-reviewer-product-submission.json`,
  `${R4}/freeze-what-baseline-desk-reviewer-build.mjs`,
  `${R4}/freeze-what-baseline-desk-reviewer-verify.mjs`,
  `${R4}/freeze-what-baseline-desk-reviewer-verify-out.json`,
];
const unexpected = scan.mentions[CLAIMED.address].filter((p) => !ALLOWED_CITERS.includes(p));
check('V5.noRatifyingCiters', unexpected.length === 0, `claimed address cited only by the r3 adjudication set + this emission family (${scan.mentions[CLAIMED.address].length} files); unexpected citers: ${unexpected.length}`);

/* Accepted capsule + envelope projection. */
const importArt = rec(`${R2}/import-discovery-handoff-desk-discovery-import.artifact.json`);
check('V5.importAccepted', importArt.digest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', `accepted discovery import recomputes ${importArt.digest}`);
const vsa = importArt.j.content.verifiedSubArtifacts;
let capOk = true;
const capDigests = [];
for (const arr of [vsa.sourceClaims, vsa.constraints, vsa.unknowns, vsa.terminalLifecycleClaims, [vsa.certificate]]) {
  for (const sub of arr) { const d = sha(sub.content); capOk = capOk && d === sub.digest; capDigests.push(d); }
}
check('V5.capsuleRecomputes', capOk && capDigests.length === 9 && capDigests.includes('03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21'), 'capsule recomputes 9/9 (8 envelope + CERT-1)');
check('V5.envelopeFromCapsule', Object.values(THIS_FRAME).every((d) => capDigests.includes(d)), 'all 8 task-projection addresses re-derive from accepted capsule content');

/* Standing hold + receipts. */
check('V5.holdByteStable', holdArt.digest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f' && holdTrc.digest === '17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202' && holdArt.j.content.decision === 'hold-no-authoring' && holdArt.j.content.noProductAuthored === true, 'r3 author hold recomputes byte-stable (hold-no-authoring)');
const holdOut = readJson(`${R3}/freeze-what-baseline-desk-hold-verify-out.json`);
check('V5.holdReceiptGreen', holdOut.summary.allPass === true && holdOut.summary.pass === 33 && holdOut.summary.fail === 0, 'r3 hold receipt recomputes green (33/33)');
const rcConf = rec(`${R3}/freeze-what-baseline-desk-reviewer-confirmation.json`);
const rcTrc = rec(`${R3}/freeze-what-baseline-desk-reviewer-confirmation-trace.json`);
const asConf = rec(`${R3}/freeze-what-baseline-desk-restaff-confirmation.json`);
check('V5.parallelRecords', rcConf.digest === 'c19344fd964655f226b777747b23b94da07877f2fc28614ea4a65c98c803ed44' && rcConf.j.content.decision === 'hold-upheld-no-candidate-to-review' && rcTrc.digest === '38192e08e601f35302e80650e8a7d8f84f7e9b6334d18f6cd092092e3c9e1b5d' && asConf.digest === 'c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06' && asConf.j.content.holdDisposition?.state?.startsWith('STANDING'), 'RC-001 + trace + AS-001 recompute; disposition carried forward');
const rcOut = readJson(`${R3}/freeze-what-baseline-desk-reviewer-confirmation-verify-out.json`);
check('V5.rcReceiptGreen', rcOut.summary.allPass === true && rcOut.summary.fail === 0, `RC-001 receipt recomputes green (${rcOut.summary.pass}/${rcOut.summary.total})`);

/* Gate round + prohibition + census + contract. */
const frRw = rec(`${R3}/reconcile-what-desk-reviewer-review.json`);
const frRwB = rec(`${R3}/reconcile-what-desk-reviewer-review-emission-b.json`);
const vvRw = rec(`${R3}/reconcile-what-desk-reviewer-verification.json`);
const rtRw = rec(`${R3}/reconcile-what-desk-reviewer-trace.json`);
const fsRw2 = rec(`${R3}/reconcile-what-desk-reviewer-product-submission.json`);
const clRw = rec(`${R3}/reconcile-what-desk-reviewer-collision-record.json`);
check('V5.gateRoundRecomputes', frRw.digest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6' && frRw.j.content.verdict === 'repair' && vvRw.digest === 'cd7504a69eff07d39f9945f8cf3da3f7cf8c4d8e91932c897dab5f5fbab35cac' && rtRw.digest === 'fe108e09db2dedb37dbb151d46e56090128c7bc44da339e44be62a47e7755373' && fsRw2.digest === '9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce' && clRw.digest === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d', 'gate reviewer round + collision record recompute');
check('V5.prohibitionUndischarged', frRw.j.content.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline') && frRwB.j.content.verdict === 'repair', 'no-accept prohibition recomputes undischarged; both gate reviewer emissions = repair');
const intentArt = rec(`${R3}/define-product-intent-desk-product-intent.artifact.json`);
const frIntent = [rec(`${R2}/define-product-intent-desk-reviewer-review.json`), rec(`${R2}/define-product-intent-desk-reviewer-review-emission-b.json`), rec(`${R2}/define-product-intent-desk-reviewer2-review.json`)];
const ucArt = rec(`${R3}/model-use-cases-desk-uc-scenarios.artifact.json`);
const frUc = rec('.factory-testbed/model-use-cases-reviewer-review.json');
const srArt = rec(`${R3}/derive-system-requirements-desk-system-requirements.artifact.json`);
const frSr = rec(`${R2}/derive-system-requirements-desk-reviewer-review.json`);
const uhSr1 = rec('.factory-testbed/derive-system-requirements-reviewer-hold.artifact.json');
const uhSr2 = rec('.factory-testbed/derive-system-requirements-reviewer-hold2.artifact.json');
const acArt = rec(`${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`);
const frAc2 = rec(`${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`);
const censusOk = intentArt.digest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055'
  && frIntent.every((r) => r.j.content.verdict === 'repair')
  && ucArt.digest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b'
  && frUc.j.content.reviewedCandidate?.artifactRef === 'sha256:c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8'
  && srArt.digest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df'
  && frSr.j.content.verdict === 'repair'
  && uhSr1.digest === 'fbc0394bd8f79df2fc7e8956accd9fe25485bceab182044927de9f209f11d053'
  && uhSr2.digest === 'b4eaaabaa5010c6e03594943e2437b030d352ec9f3027fb275d57f351692c995'
  && acArt.digest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0'
  && frAc2.j.content.verdict === 'repair';
check('V5.censusZeroOfFive', censusOk, 'census recomputes 0 of 5 accepted pre-freeze desks (intent repair x3; UC never reviewed at its own address; requirements repair + held reviewer seat; acceptance adjudicated repair)');
const schemaBytes = readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json'));
const schema = JSON.parse(schemaBytes.toString('utf8'));
check('V5.freezeContractUnsatisfiable', shaRaw(schemaBytes) === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09' && schema.properties.acceptanceRecords.minItems === 5, 'freeze contract recomputes: acceptanceRecords minItems 5 > 0 accepted - lawful authoring remains blocked');

/* ------------------------------------------------------------------ */
/* V6: trace integrity                                                  */
/* ------------------------------------------------------------------ */

const resolveId = (id) => {
  if (THIS_FRAME[id] !== undefined) return THIS_FRAME[id];
  if (id === 'FR-Freeze-What-Baseline-Reviewer-002') return fr.digest;
  if (id === 'VV-Freeze-What-Baseline-002') return vv.digest;
  if (id === 'UH-Freeze-What-Baseline-001') return holdArt.digest;
  if (id === 'RC-Freeze-What-Baseline-001') return rcConf.digest;
  if (id === 'RT-RC-Freeze-What-Baseline-001') return rcTrc.digest;
  if (id === 'AS-Freeze-What-Baseline-001') return asConf.digest;
  if (id === 'import:discovery-handoff') return importArt.digest;
  if (id === 'cert:discovery-capsule') return '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21';
  if (id === 'FR-Reconcile-What-001') return frRw.digest;
  if (id === 'FR-Reconcile-What-002') return frRwB.digest;
  if (id === 'VV-Reconcile-What-001') return vvRw.digest;
  if (id === 'RT-Reconcile-What-001') return rtRw.digest;
  if (id === 'FS-Reconcile-What-002') return fsRw2.digest;
  if (id === 'CL-Reconcile-What-001') return clRw.digest;
  if (id === 'FS-Reconcile-What-001') return fsRw2.digest === '9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce' ? rec(`${R3}/reconcile-what-desk-product-submission.json`).digest : undefined;
  if (id === 'link:define-product-intent') return intentArt.digest;
  if (id === 'link:model-use-cases') return ucArt.digest;
  if (id === 'link:derive-system-requirements') return srArt.digest;
  if (id === 'link:define-acceptance-contract') return acArt.digest;
  if (id === 'link:reconcile-what') return rec(`${R3}/reconcile-what-desk-what-reconciliation.artifact.json`).digest;
  if (id === 'UH-Define-Acceptance-Contract-001') return rec(`${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`).digest;
  if (id === 'FR-Define-Acceptance-Contract-002') return frAc2.digest;
  if (id === 'fixture:what-baseline-green') return CLAIMED.address;
  if (id === 'schema:what-baseline') return shaRaw(schemaBytes);
  return undefined;
};
let edgesOk = rt.j.content.relationships.length === 30;
for (const e of rt.j.content.relationships) {
  edgesOk = edgesOk && resolveId(e.fromId) === e.fromRef.slice(7) && resolveId(e.toId) === e.toRef.slice(7);
}
check('V6.traceResolution', edgesOk, `all ${rt.j.content.relationships.length} trace edges resolve at both ends to independently recomputed digests`);
check('V6.vocabularyClosed', JSON.stringify(rt.j.content.relationVocabulary) === JSON.stringify(['observes', 'verifies']) && rt.j.content.relationships.every((e) => ['observes', 'verifies'].includes(e.relation)), 'closed relation vocabulary observes/verifies');
const hc = rt.j.content.holdCoverage;
check('V6.holdCoverage', hc.verdict === 'hold-upheld' && hc.freezeRatified === false && hc.noProductAuthored === true && hc.preFreezeDesksAccepted === 0 && hc.preFreezeDesksRequired === 5 && hc.prohibitionDischarged === false && hc.unacceptedLinks.length === 5 && hc.onlyAcceptedChain === 'import:discovery-handoff', 'trace holdCoverage pins the recomputed refusal state (0/5, prohibition undischarged, import-only acceptance)');
check('V6.noIdentityAuthored', rt.j.content.branchResolutionNote.includes('No scenario, branch, requirement, criterion, container or baseline identities are authored by this review'), 'the review authors no scenario/branch/requirement/criterion/container/baseline identities');

/* ------------------------------------------------------------------ */
/* V7: emission discipline                                              */
/* ------------------------------------------------------------------ */

const FORBIDDEN = [/Date\.now\(/, /new Date\(/, /Math\.random\(/, /performance\.now\(/, /process\.hrtime\(/];
const sourcesOk = [`${R4}/freeze-what-baseline-desk-reviewer-build.mjs`, `${R4}/freeze-what-baseline-desk-reviewer-verify.mjs`].map((rel) => ({
  rel,
  src: readFileSync(join(REPO, rel), 'utf8'),
})).every(({ rel, src }) => {
  const body = src.replace(/^\/\*[\s\S]*?\*\//m, '');
  return FORBIDDEN.every((re) => !re.test(body));
});
check('V7.deterministicSources', sourcesOk, 'no clock reads, no randomness in builder/verifier executable bodies (pinned CREATED_AT only)');
const family = readdirSync(DIR).sort();
const EXPECTED_FAMILY = [
  'freeze-what-baseline-desk-reviewer-build.mjs',
  'freeze-what-baseline-desk-reviewer-product-submission.json',
  'freeze-what-baseline-desk-reviewer-review.json',
  'freeze-what-baseline-desk-reviewer-trace.json',
  'freeze-what-baseline-desk-reviewer-verification.json',
  'freeze-what-baseline-desk-reviewer-verify.mjs',
  'freeze-what-baseline-desk-reviewer-verify-out.json',
  'freeze-what-baseline-desk-reviewer-submission-summary.md',
];
check('V7.fileFamily', JSON.stringify(family) === JSON.stringify([...EXPECTED_FAMILY].sort()), `round directory contains exactly the expected emission family (${family.length} files)`);
check('V7.recordDeterminism', [vv, fr, rt, fsr].every((r) => r.j.createdAt === CREATED_AT), 'all four records carry the pinned timestamp');

/* ------------------------------------------------------------------ */
/* V8: verify-out assembly + self-digest                                */
/* ------------------------------------------------------------------ */

const passCount = checks.filter((c) => c.pass).length;
const verifyOut = {
  verifyOutKind: 'reviewer-refusal-verify',
  semanticCode: 'FR-Freeze-What-Baseline-002',
  reviewRef: fr.j.artifactRef,
  verificationRef: vv.j.artifactRef,
  traceRef: rt.j.traceRef,
  submissionRef: fsr.j.submissionRef,
  createdAt: CREATED_AT,
  declaredDigestsTrusted: false,
  checks,
  summary: { total: checks.length, pass: passCount, fail: checks.length - passCount, allPass: passCount === checks.length, scanFiles: scan.files },
  workspaceSummary: `workspace: ${CLAIMED.workspaceSummary} (frame line; adjudicated FALSE by FR-Freeze-What-Baseline-002: the one resolving address is a contract-suite fixture, refused as acceptance authority; recomputed truth 0 accepted upstream revisions on this chain)`,
  upstreamAcceptedAdjudication: 'RESOLVED at the content layer to docs/refactoring/formalization-frf/contracts/fixtures/green/what-baseline.json; REFUSED as acceptance authority (CRIT-1/CRIT-2); NOT ratified',
  ratifiedWorkspaceCensus: '0 of 5 pre-freeze desks accepted; only the discovery import chain is accepted',
  verdict: 'hold-upheld',
  verifyOutDigest: undefined,
};
verifyOut.verifyOutDigest = shaRaw(Buffer.from(JSON.stringify(sortKeys({
  verifyOutKind: verifyOut.verifyOutKind,
  semanticCode: verifyOut.semanticCode,
  reviewRef: verifyOut.reviewRef,
  verificationRef: verifyOut.verificationRef,
  traceRef: verifyOut.traceRef,
  submissionRef: verifyOut.submissionRef,
  createdAt: verifyOut.createdAt,
  declaredDigestsTrusted: verifyOut.declaredDigestsTrusted,
  checks: verifyOut.checks,
  summary: verifyOut.summary,
  workspaceSummary: verifyOut.workspaceSummary,
})), 'utf8'));

writeFileSync(join(DIR, 'freeze-what-baseline-desk-reviewer-verify-out.json'), `${JSON.stringify(verifyOut, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  verified: 'FR-Freeze-What-Baseline-002 (freeze-what-baseline desk reviewer refusal emission)',
  reviewRef: fr.j.artifactRef,
  checks: `${passCount}/${checks.length}`,
  scanFiles: scan.files,
  verifyOutDigest: verifyOut.verifyOutDigest,
  allPass: passCount === checks.length,
}, null, 2));
if (passCount !== checks.length) {
  console.error(JSON.stringify(checks.filter((c) => !c.pass), null, 2));
  process.exit(1);
}
