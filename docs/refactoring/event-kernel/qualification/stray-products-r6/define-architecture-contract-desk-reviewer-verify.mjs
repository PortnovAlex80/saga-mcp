/**
 * define-architecture-contract desk (reviewer) - REVIEWER REFUSAL verification (r6).
 *
 * Verifies FR-Define-Architecture-Contract-001 (define-architecture-contract-
 * desk-reviewer-review.json + -verification.json + -trace.json +
 * -product-submission.json) against independently recomputed workspace state.
 * Nothing is trusted by declaration. Frozen kernel rule:
 *   src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Layers:
 *   V1  the four emission records recompute from raw bytes (self-digests,
 *       kinds, ids, pinned timestamps).
 *   V2  acyclic cross-binding: FR -> VV, RT -> FR/VV, FS -> FR/VV/RT,
 *       reviewed candidate pinned to the r5 author hold; FS effectFired
 *       false; intake receipt status; evidence coverage; no self-paradox.
 *   V3  FR internal consistency: verdict/decision refusal, acceptance
 *       criteria profile (7 true / 3 false: 8, 9, 10), verification
 *       summary equal to the recomputed VV check census, claim adjudication
 *       UNRESOLVED-at-content-layer + REFUSED (phantom).
 *   V4  frame identity: THIS staffing's 8 projection refs, the
 *       upstream-accepted[0] adjudication (unresolved-phantom, REFUSED),
 *       skill pins, workspace summary verbatim + adjudicated FALSE,
 *       write-authority envelope laws.
 *   V5  basis re-verified fresh (independent scans + digest recomputes):
 *       claimed address hash-resolves to ZERO contents workspace-wide;
 *       citers = the testbed adjudication set + this emission family only;
 *       skill pins resolve to zero; installed pins differ; governing anchor
 *       open; capsule 8/8 + CERT-1; r5 hold + receipt byte-stable (29/29);
 *       r4-round hold + testbed round (author hold d58e6a6a, reviewer hold
 *       83501c22, receipts VERIFIED); freeze refusal round (effectFired
 *       false); prohibition undischarged; census 0 of 6; schema pin;
 *       installed desk declaration; r1 stray drift.
 *   V6  trace: all edges resolve at both ends to recomputed digests, closed
 *       vocabulary, 8/8 projection coverage + claimed-acceptance coverage,
 *       holdCoverage pins the refusal state.
 *   V7  emission discipline: deterministic authoring sources (no clock
 *       reads, no randomness), expected file family only in this round
 *       directory.
 *   V8  verify-out self-digest + green summary.
 *
 * Run: node define-architecture-contract-desk-reviewer-verify.mjs
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
const DIR_REL = 'docs/refactoring/event-kernel/qualification/stray-products-r6';
const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';
const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R4 = 'docs/refactoring/event-kernel/qualification/stray-products-r4';
const R5 = 'docs/refactoring/event-kernel/qualification/stray-products-r5';
const TESTBED = '.factory-testbed';
const CREATED_AT = '2026-08-28T00:00:00Z';
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
  address: 'b7f34c48d77b8eea22d7f0b6143960a3f9d2588b17dbba366b7d9375a1c80f41',
  label: 'accepted revision of define-architecture-contract',
  workspaceSummary: 'workspace: 1 accepted upstream revisions travel by content address',
};
const SKILL = {
  protocol: 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
  semantic: '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
};
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const LAWFUL_CITER_PREFIXES = [
  `${TESTBED}/define-architecture-contract-reviewer-hold`,
  `${TESTBED}/settle-formalization-`,
  `${DIR_REL}/`,
];

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

const vv = rec(`${DIR_REL}/define-architecture-contract-desk-reviewer-verification.json`);
const fr = rec(`${DIR_REL}/define-architecture-contract-desk-reviewer-review.json`);
const rt = rec(`${DIR_REL}/define-architecture-contract-desk-reviewer-trace.json`);
const fsr = rec(`${DIR_REL}/define-architecture-contract-desk-reviewer-product-submission.json`);

check('V1.verificationRecord', vv.digest === vv.j.contentDigest && vv.j.artifactRef === shaRef(vv.digest) && vv.j.artifactKind === 'reviewer-verification' && vv.j.semanticCode === 'VV-Define-Architecture-Contract-002' && vv.j.createdAt === CREATED_AT, `VV recomputes ${vv.digest}; kind/id/timestamp pin`);
check('V1.reviewRecord', fr.digest === fr.j.contentDigest && fr.j.artifactRef === shaRef(fr.digest) && fr.j.artifactKind === 'formalization-review' && fr.j.semanticCode === 'FR-Define-Architecture-Contract-001' && fr.j.createdAt === CREATED_AT, `FR recomputes ${fr.digest}; kind/id/timestamp pin`);
check('V1.traceRecord', rt.digest === rt.j.contentDigest && rt.j.traceRef === shaRef(rt.digest) && rt.j.traceKind === 'reviewer-refusal-trace' && rt.j.semanticCode === 'RT-Define-Architecture-Contract-001' && rt.j.createdAt === CREATED_AT, `RT recomputes ${rt.digest}; kind/id/timestamp pin`);
check('V1.submissionRecord', fsr.digest === fsr.j.contentDigest && fsr.j.submissionRef === shaRef(fsr.digest) && fsr.j.submissionId === 'FS-Define-Architecture-Contract-Reviewer-001' && fsr.j.createdAt === CREATED_AT, `FS recomputes ${fsr.digest}; id/timestamp pin`);
check('V1.digestRule', [vv, fr, rt, fsr].every((r) => r.j.digestRule === 'sha256 over canonical JSON of content (recursively key-sorted, compact)'), 'all four records pin the frozen digest rule verbatim');
check('V1.deskRole', [vv, fr, rt, fsr].every((r) => r.j.deskRef === 'define-architecture-contract' && r.j.role === 'reviewer'), 'all four records pin desk=define-architecture-contract role=reviewer');

/* ------------------------------------------------------------------ */
/* V2: acyclic cross-binding                                            */
/* ------------------------------------------------------------------ */

check('V2.reviewBindsVerification', fr.j.content.verificationRef === shaRef(vv.digest) && fr.j.content.verificationSummary.recomputedChecks === vv.j.content.checks.length, 'FR binds VV by content address');
check('V2.traceBindsReview', rt.j.content.subjectArtifactRef === fr.j.artifactRef && rt.j.content.verificationRef === shaRef(vv.digest), 'RT binds FR (subject) and VV (verification)');
check('V2.submissionBindsPackage', fsr.j.content.candidate.artifactRef === fr.j.artifactRef && fsr.j.content.candidate.contentDigest === fr.digest && fsr.j.content.verificationRef === shaRef(vv.digest) && fsr.j.content.traceRef === rt.j.traceRef, 'FS binds FR + VV + RT');
const holdArt = rec(`${R5}/define-architecture-contract-desk-upstream-hold.artifact.json`);
const holdTrc = rec(`${R5}/define-architecture-contract-desk-upstream-hold-trace.json`);
check('V2.reviewedCandidateIsHold', fr.j.content.reviewedCandidate.artifactRef === shaRef(holdArt.digest) && fr.j.content.reviewedCandidate.traceRef === shaRef(holdTrc.digest) && fr.j.content.reviewedCandidate.productKind === 'formalization.upstream-hold.v1' && fr.j.content.reviewedCandidate.declaredDecision === 'hold-no-authoring', 'FR reviewed candidate pinned to the r5 author hold (no SRS candidate exists)');
check('V2.fsCandidateBinding', fsr.j.content.reviewedCandidate.artifactRef === shaRef(holdArt.digest) && fsr.j.content.payloadContract.effectFired === false && fsr.j.content.payloadContract.terminalOutcome === 'hold-upheld-claim-refused-phantom-upstream' && fsr.j.content.intakeReceipt.status === 'review_complete_verdict_recorded', 'FS reviewed candidate = hold; no effect fired; intake receipt recorded');

const evidenceRefs = fsr.j.content.payloadContract.requiredEvidenceRefs;
const evidenceResolvable = evidenceRefs.every((r) => typeof r === 'string' && r.startsWith('sha256:') && r.length === 71);
check('V2.evidenceWellFormed', evidenceResolvable && evidenceRefs.length >= 30 && new Set(evidenceRefs).size === evidenceRefs.length, `FS evidence list: ${evidenceRefs.length} unique well-formed refs (floor 30)`);
check('V2.evidenceCoversPackage', [shaRef(vv.digest), shaRef(fr.digest), rt.j.traceRef, shaRef(holdArt.digest), shaRef(CLAIMED.address)].every((r) => evidenceRefs.includes(r)), 'FS evidence covers this package (VV/FR/RT), the reviewed hold and the adjudicated claim content');
check('V2.noSelfParadox', !JSON.stringify(fsr.j.content).includes(shaRef(fsr.digest)) && !JSON.stringify(fr.j.content).includes(shaRef(fr.digest)) && !JSON.stringify(rt.j.content).includes(shaRef(rt.digest)), 'no record contains its own content address (acyclic self-binding)');
const coverage = fsr.j.content.payloadContract.evidenceKindCoverage;
check('V2.evidenceCoverageSum', Object.values(coverage).reduce((a, b) => a + b, 0) === evidenceRefs.length, `evidenceKindCoverage sums to the evidence count (${evidenceRefs.length})`);

/* ------------------------------------------------------------------ */
/* V3: FR internal consistency                                          */
/* ------------------------------------------------------------------ */

check('V3.verdict', fr.j.content.verdict === 'hold-upheld' && typeof fr.j.content.decision === 'string' && fr.j.content.decision.includes('REFUSE the frame upstream-accepted claim') && fr.j.content.decision.includes('uphold UH-Define-Architecture-Contract-001'), 'verdict hold-upheld; decision refuses the frame claim and upholds the author hold');
const ac = fr.j.content.acceptanceCriteria;
const acFalse = ac.filter((a) => a.satisfied === false).map((a) => a.id);
check('V3.acceptanceCriteriaProfile', ac.length === 10 && JSON.stringify(acFalse) === JSON.stringify([8, 9, 10]) && ac.find((a) => a.id === 8)?.note.includes('phantom') && ac.find((a) => a.id === 9)?.note.includes('hold') && ac.find((a) => a.id === 10)?.note.includes('phantom'), 'criteria profile honest: exactly 8/9/10 unsatisfied (frame summary false; no SRS candidate; claim is a phantom, not a chain revision)');
const critIds = fr.j.content.findings.criticalIssues.map((i) => i.id);
const majIds = fr.j.content.findings.majorIssues.map((i) => i.id);
check('V3.findingsStructure', JSON.stringify(critIds) === JSON.stringify(['CRIT-1', 'CRIT-2', 'CRIT-3']) && JSON.stringify(majIds) === JSON.stringify(['MAJ-1']) && fr.j.content.claimedAcceptanceAdjudication.adjudication.startsWith('REFUSED'), 'findings: CRIT-1..3 + MAJ-1; claim adjudication REFUSED');
check('V3.vvSummaryConsistent', fr.j.content.verificationSummary.passed === fr.j.content.verificationSummary.recomputedChecks && fr.j.content.verificationSummary.failed === 0 && fr.j.content.verificationSummary.trustedByDeclaration === false && vv.j.content.checksSummary.total === vv.j.content.checks.length && vv.j.content.checksSummary.fail === 0, 'verification summaries self-consistent and green; nothing trusted by declaration');
const adj = fr.j.content.claimedAcceptanceAdjudication;
check('V3.adjudicationContentLayer', adj.resolution.startsWith('UNRESOLVED at the content layer') && adj.authorityAudit.hashResolvedContents === 0 && adj.authorityAudit.ratifyingCitations === 0 && adj.authorityAudit.isWorkplaceProductionRevisionOfThisChain === false && adj.wrongReferentLaw.includes('own product kind') && adj.processLaw.includes('noProductAuthored=true'), 'adjudication: unresolved phantom (0 hash-resolutions), process-impossible, wrong-referent; refused as authority');

/* ------------------------------------------------------------------ */
/* V4: frame identity (this staffing, verbatim)                         */
/* ------------------------------------------------------------------ */

const rtCov = rt.j.content.taskProjectionCoverage;
const covOk = Object.keys(THIS_FRAME).every((id) => rtCov[id]?.digest === THIS_FRAME[id] && JSON.stringify(rtCov[id].verifiedBy) === JSON.stringify(['FR-Define-Architecture-Contract-Reviewer-001'])) && Object.keys(rtCov).length === 8;
check('V4.projectionCoverage', covOk, 'RT pins the exact 8-entry task projection of THIS staffing frame');
const caCov = rt.j.content.claimedAcceptanceCoverage['upstream-accepted[0]'];
check('V4.claimedAcceptanceCoverage', caCov.address === shaRef(CLAIMED.address) && caCov.resolution === 'unresolved-phantom' && caCov.hashResolvedContents === 0 && caCov.adjudication.includes('REFUSED'), 'RT pins the upstream-accepted[0] adjudication (unresolved-phantom, REFUSED)');
check('V4.workspaceSummary', rt.j.content.workspaceSummary.includes(CLAIMED.workspaceSummary) && rt.j.content.workspaceSummary.includes('adjudicated FALSE') && rt.j.content.workspaceSummary.includes('0 accepted upstream revisions') && fsr.j.content.workspaceSummary === rt.j.content.workspaceSummary, 'frame workspace summary recorded verbatim and adjudicated FALSE in RT + FS');
check('V4.skillPinsRecorded', vv.j.content.resolutionScan.frameSkillPins.protocolSkill === shaRef(SKILL.protocol) && vv.j.content.resolutionScan.frameSkillPins.semanticSkill === shaRef(SKILL.semantic) && vv.j.content.resolutionScan.frameSkillPins.disposition.includes('not ratified'), 'frame skill pins recorded verbatim as provenance, not ratified');
check('V4.envelopeConsistency', fr.j.content.envelopeConsistency.taskProjectionContentAddresses === 8 && fr.j.content.envelopeConsistency.resolved === 8 && fr.j.content.envelopeConsistency.adjudicated === 1, 'FR envelope consistency: 8 resolved + 1 adjudicated');
check('V4.envelopeLawsCarried', fr.j.content.acceptanceCriteria.find((a) => a.id === 6)?.description.includes('constraint:retention-1') === true && fr.j.content.acceptanceCriteria.find((a) => a.id === 6)?.description.includes('unknown:browser-matrix-1') === true, 'constraint:retention-1 + unknown:browser-matrix-1 carried, never resolved by the review');

/* ------------------------------------------------------------------ */
/* V5: basis re-verified fresh (independent scans + recomputes)         */
/* ------------------------------------------------------------------ */

const targets = new Set([CLAIMED.address, ...Object.values(SKILL), GOVERNING]);
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

check('V5.claimedAddressUnresolvable', scan.resolved[CLAIMED.address].length === 0, `workspace-wide (${scan.files} files): the claimed address hash-resolves to ZERO contents in all three body layers`);
/* Allowed citers: lawful refusing adjudication/verification families + this emission. */
const citers = scan.mentions[CLAIMED.address];
const unexpected = citers.filter((p) => !LAWFUL_CITER_PREFIXES.some((pre) => p.startsWith(pre)));
check('V5.noRatifyingCiters', unexpected.length === 0 && citers.length >= 4, `claimed address cited only by lawful refusing families (testbed adjudication sets; settle-formalization hold records; this emission) - ${citers.length} files; unexpected citers: ${unexpected.length}`);
check('V5.skillPinsResolveZero', scan.resolved[SKILL.protocol].length === 0 && scan.resolved[SKILL.semantic].length === 0, 'frame skill pins hash-resolve to zero contents (provenance only)');
const installedProtocol = sha({ skillId: 'saga-process-module-worker-protocol', kind: 'protocol' });
const installedSemantic = sha({ skillId: 'formalization-desk-define-architecture-contract', kind: 'semantic', desk: 'define-architecture-contract' });
check('V5.installedPinsDiffer', installedProtocol !== SKILL.protocol && installedSemantic !== SKILL.semantic && vv.j.content.resolutionScan.frameSkillPins.installedManifestPins.protocolSkill === shaRef(installedProtocol) && vv.j.content.resolutionScan.frameSkillPins.installedManifestPins.semanticSkill === shaRef(installedSemantic), 'installed manifest pins recompute and BOTH differ from the frame pins');
check('V5.governingAnchorOpen', scan.resolved[GOVERNING].length === 0, 'r2-era governing anchor still resolves to zero contents (inherited debt, not pinned by this frame)');

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

/* The desk candidate of record + receipts. */
check('V5.holdByteStable', holdArt.digest === '6a32f180f10366833f0c2be102704749379fb7c2c13cca4c103c255c149d2023' && holdTrc.digest === '1f54d1f317a9c0ec4f50f26b453112be72ca3abfca7859d07c4b454c5be8d6f3' && holdArt.j.content.decision === 'hold-no-authoring' && holdArt.j.content.noProductAuthored === true && holdArt.j.content.chainAcceptanceCensus.acceptedUpstreamDeskCount === 0, 'r5 author hold recomputes byte-stable (hold-no-authoring, census 0 of 6)');
const holdOut = readJson(`${R5}/define-architecture-contract-desk-hold-verify-out.json`);
check('V5.holdReceiptGreen', holdOut.summary.allPass === true && holdOut.summary.pass === 29 && holdOut.summary.fail === 0, 'r5 hold receipt recomputes green (29/29)');
const holdArtR4 = rec(`${R4}/define-architecture-contract-desk-upstream-hold.artifact.json`);
const holdTrcR4 = rec(`${R4}/define-architecture-contract-desk-upstream-hold-trace.json`);
check('V5.r4RoundHold', holdArtR4.digest === 'b831c67ed75bfc56024ddd78407a8ef8fdec593e6998963d86905b30c4bfb33b' && holdArtR4.j.content.decision === 'hold-no-authoring' && holdTrcR4.digest === 'e5a4749ec21bfaff7042c421fa832e64820ce5ef61f271ecf2801afe343656f9', 'r4-round author hold recomputes (hold-no-authoring)');

/* The parallel testbed round: author hold + reviewer hold + receipts. */
const tbAuthorHold = rec(`${TESTBED}/define-architecture-contract-author-hold.artifact.json`);
const tbAuthorTrc = rec(`${TESTBED}/define-architecture-contract-author-hold-trace.json`);
const tbHold = rec(`${TESTBED}/define-architecture-contract-reviewer-hold.artifact.json`);
const tbTrc = rec(`${TESTBED}/define-architecture-contract-reviewer-hold-trace.json`);
const tbAuthorOut = readJson(`${TESTBED}/define-architecture-contract-author-hold-verify-out.json`);
const tbReviewerOut = readJson(`${TESTBED}/define-architecture-contract-reviewer-hold-verify-out.json`);
check('V5.testbedRound', tbAuthorHold.digest === 'd58e6a6a149c660aec7af57c83550b326431e1dbc48e2a9d10ac762c55efe7e7' && tbAuthorHold.j.content.decision === 'hold-no-authoring' && tbAuthorTrc.digest === 'b0b5b62330a9ace320869ef284d9d55519ad13a4cbb178e99caa5c373d83cf0c' && tbHold.digest === '83501c2234353de8fd2520dd86967d87a485f1a66964d6165b481f572ab0ba83' && tbHold.j.content.decision === 'hold-no-review' && tbHold.j.content.upstreamProjectionAudit?.envelopeProjection?.includes(CLAIMED.address) === true && tbTrc.digest === 'f187d5248013adfceca1a2c844147f1b3095ecf47ed15c3254a6bc665c8380ea', 'testbed round recomputes: author hold d58e6a6a (hold-no-authoring) + reviewer hold 83501c22 (hold-no-review, phantom adjudication of b7f34c48...)');
check('V5.testbedReceiptsGreen', tbAuthorOut.decision === 'VERIFIED' && tbAuthorOut.checks.filter((c) => c.pass === false).length === 0 && tbReviewerOut.decision === 'VERIFIED' && tbReviewerOut.checks.filter((c) => c.pass === false).length === 0, 'both testbed verifier receipts recompute VERIFIED with 0 fails');

/* The round co-tenant + testbed twin: settle-formalization desk holds. */
const settleArt = rec(`${DIR_REL}/settle-formalization-desk-upstream-hold.artifact.json`);
const settleTrc = rec(`${DIR_REL}/settle-formalization-desk-upstream-hold-trace.json`);
const tbSettleArt = rec(`${TESTBED}/settle-formalization-author-hold.artifact.json`);
const tbSettleOut = readJson(`${TESTBED}/settle-formalization-author-hold-verify-out.json`);
const settleOut = readJson(`${DIR_REL}/settle-formalization-desk-hold-verify-out.json`);
check('V5.settleRoundRecomputes', settleArt.digest === 'b40d7616bb607ccfe389258829d304f065e1cac46888b6541c3c5c35b8402251' && settleArt.j.content.decision === 'hold-no-authoring' && settleTrc.digest === 'f7ee0830d5812841dc70417fc3143a8030fadfd5d1018871aaab40c60c1b3bae' && tbSettleArt.digest === '8e1bcf73542e217bd702e59d5879200c43c3e21e17d6b94a3f02b63b4d16d3a7' && (tbSettleOut.decision === 'VERIFIED' || tbSettleOut.summary?.allPass === true) && (settleOut.decision === 'VERIFIED' || settleOut.summary?.allPass === true), 'settle-formalization holds recompute (r6 co-tenant b40d7616 + testbed twin 8e1bcf73, both hold-no-authoring, verifiers green) - the downstream spine holds consistently');

/* The upstream gate: freeze refusal round + prohibition + census + contract. */
const frFreeze = rec(`${R4}/freeze-what-baseline-desk-reviewer-review.json`);
const vvFreeze = rec(`${R4}/freeze-what-baseline-desk-reviewer-verification.json`);
const rtFreeze = rec(`${R4}/freeze-what-baseline-desk-reviewer-trace.json`);
const fsFreeze = rec(`${R4}/freeze-what-baseline-desk-reviewer-product-submission.json`);
check('V5.freezeRefusalRound', frFreeze.digest === 'd52746b6620e8e4583592f1d23beff3053430d15ae8159643dcc7461b49d9190' && frFreeze.j.content.verdict === 'hold-upheld' && vvFreeze.digest === '8b04101005452d7906bcc1ca66f8f91d5ef6957518ae5af84f8a47f7e5781c21' && rtFreeze.digest === '8bf4f283ec152b8e9f9a4d3706227776b1723805c675ea2580ffa59e2259e252' && fsFreeze.digest === '6f5294a924e2fa9d94067b2c60d46f2bf0e199098fefd22f5df9325ea26b9eac' && fsFreeze.j.content.payloadContract.effectFired === false, 'freeze refusal round recomputes: ratification REFUSED, effect never fired');
const freezeHold = rec(`${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`);
const frRw = rec(`${R3}/reconcile-what-desk-reviewer-review.json`);
const frRwB = rec(`${R3}/reconcile-what-desk-reviewer-review-emission-b.json`);
check('V5.prohibitionUndischarged', freezeHold.digest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f' && frRw.digest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6' && frRw.j.content.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline') && frRwB.j.content.verdict === 'repair', 'standing freeze hold + no-accept prohibition recompute undischarged; both gate reviewer emissions = repair');
const intentArt = rec(`${R3}/define-product-intent-desk-product-intent.artifact.json`);
const frIntent = rec(`${R2}/define-product-intent-desk-reviewer-review.json`);
const ucArt = rec(`${R3}/model-use-cases-desk-uc-scenarios.artifact.json`);
const srArt = rec(`${R3}/derive-system-requirements-desk-system-requirements.artifact.json`);
const frSr = rec(`${R2}/derive-system-requirements-desk-reviewer-review.json`);
const acArt = rec(`${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`);
const frAc2 = rec(`${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`);
const uhAc = rec(`${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`);
const rwArt = rec(`${R3}/reconcile-what-desk-what-reconciliation.artifact.json`);
const censusOk = intentArt.digest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055'
  && frIntent.j.content.verdict === 'repair'
  && ucArt.digest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b'
  && srArt.digest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df'
  && frSr.j.content.verdict === 'repair'
  && acArt.digest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0'
  && frAc2.j.content.verdict === 'repair'
  && uhAc.digest === 'a53a5e08a9c7f0f6ad550fd5d2db142238683e1d285458eb2ded5330cce39d84'
  && rwArt.digest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191';
check('V5.censusZeroOfSix', censusOk, 'census recomputes 0 of 6 accepted upstream desks (intent repair; UC never reviewed at its own address; requirements repair; acceptance adjudicated repair; reconcile-what repair; freeze on standing hold)');
const schemaBytes = readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json'));
const schema = JSON.parse(schemaBytes.toString('utf8'));
check('V5.freezeContractUnsatisfiable', shaRaw(schemaBytes) === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09' && schema.properties.acceptanceRecords.minItems === 5, 'freeze contract recomputes: acceptanceRecords minItems 5 > 0 accepted - the root blocker stands');
const manifestSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'manifest.ts'), 'utf8');
check('V5.deskDeclaration', manifestSrc.includes("outputProductKind: 'formalization.srs.v1'") && manifestSrc.includes("{ from: 'freeze-what-baseline', to: 'define-architecture-contract', on: 'domain.frozen' }") && manifestSrc.includes("{ from: 'define-architecture-contract', to: 'settle-formalization', on: 'domain.accepted' }"), 'installed desk declaration re-derives from the installed manifest source');
const strayR1 = readJson(`${R1Self()}`);
check('V5.r1StrayDriftRecomputes', sha(strayR1.content) === 'f4846e5fed6808f8b0c33b14d58a337d9f72eddd02bf775bc048862b1d5626af' && GOVERNING !== sha(strayR1.content), 'r1 stray product drift recomputes: declared a926df6284... vs content f4846e5f...; retired, never lineage');

function R1Self() {
  return 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-desk-architecture-contract.artifact.json';
}

/* ------------------------------------------------------------------ */
/* V6: trace integrity                                                  */
/* ------------------------------------------------------------------ */

const resolveId = (id) => {
  if (THIS_FRAME[id] !== undefined) return THIS_FRAME[id];
  if (id === 'FR-Define-Architecture-Contract-001') return fr.digest;
  if (id === 'VV-Define-Architecture-Contract-002') return vv.digest;
  if (id === 'UH-Define-Architecture-Contract-001') return holdArt.digest;
  if (id === 'RT-UH-Define-Architecture-Contract-001') return holdTrc.digest;
  if (id === 'UH-Define-Architecture-Contract-001@stray-products-r4') return holdArtR4.digest;
  if (id === 'UH-Define-Architecture-Contract-002') return tbHold.digest;
  if (id === 'RT-UH-Define-Architecture-Contract-002') return tbTrc.digest;
  if (id === 'UH-Define-Architecture-Contract-001@factory-testbed') return tbAuthorHold.digest;
  if (id === 'UH-Settle-Formalization-001') return settleArt.digest;
  if (id === 'RT-UH-Settle-Formalization-001') return settleTrc.digest;
  if (id === 'UH-Settle-Formalization-001@factory-testbed') return tbSettleArt.digest;
  if (id === 'import:discovery-handoff') return importArt.digest;
  if (id === 'cert:discovery-capsule') return '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21';
  if (id === 'FR-Freeze-What-Baseline-002') return frFreeze.digest;
  if (id === 'VV-Freeze-What-Baseline-002') return vvFreeze.digest;
  if (id === 'RT-Freeze-What-Baseline-002') return rtFreeze.digest;
  if (id === 'FS-Freeze-What-Baseline-Reviewer-001') return fsFreeze.digest;
  if (id === 'UH-Freeze-What-Baseline-001') return freezeHold.digest;
  if (id === 'RC-Freeze-What-Baseline-001') return rec(`${R3}/freeze-what-baseline-desk-reviewer-confirmation.json`).digest;
  if (id === 'AS-Freeze-What-Baseline-001') return rec(`${R3}/freeze-what-baseline-desk-restaff-confirmation.json`).digest;
  if (id === 'FR-Reconcile-What-001') return frRw.digest;
  if (id === 'FR-Reconcile-What-002') return frRwB.digest;
  if (id === 'link:define-product-intent') return intentArt.digest;
  if (id === 'link:model-use-cases') return ucArt.digest;
  if (id === 'link:derive-system-requirements') return srArt.digest;
  if (id === 'link:define-acceptance-contract') return acArt.digest;
  if (id === 'link:reconcile-what') return rwArt.digest;
  if (id === 'UH-Define-Acceptance-Contract-001') return uhAc.digest;
  if (id === 'FR-Define-Acceptance-Contract-002') return frAc2.digest;
  if (id === 'phantom:b7f34c48') return CLAIMED.address;
  if (id === 'schema:what-baseline') return shaRaw(schemaBytes);
  if (id === 'fixture:what-baseline-green') return 'e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de';
  return undefined;
};
let edgesOk = rt.j.content.relationships.length >= 30;
for (const e of rt.j.content.relationships) {
  edgesOk = edgesOk && resolveId(e.fromId) === e.fromRef.slice(7) && resolveId(e.toId) === e.toRef.slice(7);
}
check('V6.traceResolution', edgesOk, `all ${rt.j.content.relationships.length} trace edges resolve at both ends to independently recomputed digests`);
check('V6.vocabularyClosed', JSON.stringify(rt.j.content.relationVocabulary) === JSON.stringify(['observes', 'verifies']) && rt.j.content.relationships.every((e) => ['observes', 'verifies'].includes(e.relation)), 'closed relation vocabulary observes/verifies');
const hc = rt.j.content.holdCoverage;
check('V6.holdCoverage', hc.verdict === 'hold-upheld' && hc.srsReviewed === false && hc.productVerdictMinted === false && hc.noProductAuthored === true && hc.acceptedUpstreamDesks === 0 && hc.upstreamDesksRequired === 6 && hc.prohibitionDischarged === false && hc.unacceptedLinks.length === 5 && hc.onlyAcceptedChain === 'import:discovery-handoff', 'trace holdCoverage pins the recomputed refusal state (0/6, prohibition undischarged, import-only acceptance, no product verdict)');
check('V6.noIdentityAuthored', rt.j.content.branchResolutionNote.includes('No scenario, surface, realization-entry, requirement, criterion, container or baseline identities are authored by this review'), 'the review authors no scenario/surface/realization/requirement/criterion/container/baseline identities');

/* ------------------------------------------------------------------ */
/* V7: emission discipline                                              */
/* ------------------------------------------------------------------ */

const FORBIDDEN = [/Date\.now\(/, /new Date\(/, /Math\.random\(/, /performance\.now\(/, /process\.hrtime\(/];
const sourcesOk = [`${DIR_REL}/define-architecture-contract-desk-reviewer-build.mjs`, `${DIR_REL}/define-architecture-contract-desk-reviewer-verify.mjs`].map((rel) => ({
  rel,
  src: readFileSync(join(REPO, rel), 'utf8'),
})).every(({ rel, src }) => {
  const body = src.replace(/^\/\*[\s\S]*?\*\//m, '');
  return FORBIDDEN.every((re) => !re.test(body));
});
check('V7.deterministicSources', sourcesOk, 'no clock reads, no randomness in builder/verifier executable bodies (pinned CREATED_AT only)');
/* Round co-tenancy law: this desk's namespace carries exactly its 8-file family;
 * any other files in the shared round directory must belong to a foreign desk
 * namespace (e.g. settle-formalization-desk-*), never squat in ours. */
const MY_PREFIX = 'define-architecture-contract-desk-reviewer-';
const MY_FAMILY = [
  'define-architecture-contract-desk-reviewer-build.mjs',
  'define-architecture-contract-desk-reviewer-product-submission.json',
  'define-architecture-contract-desk-reviewer-review.json',
  'define-architecture-contract-desk-reviewer-submission-summary.md',
  'define-architecture-contract-desk-reviewer-trace.json',
  'define-architecture-contract-desk-reviewer-verification.json',
  'define-architecture-contract-desk-reviewer-verify-out.json',
  'define-architecture-contract-desk-reviewer-verify.mjs',
];
const family = readdirSync(DIR).sort();
const mine = family.filter((f) => f.startsWith(MY_PREFIX));
const others = family.filter((f) => !f.startsWith(MY_PREFIX));
/* verify-out.json is THIS verifier's own output (written at V8) - optional at check time. */
const REQUIRED_MINE = MY_FAMILY.filter((f) => f !== 'define-architecture-contract-desk-reviewer-verify-out.json');
const missing = REQUIRED_MINE.filter((f) => !mine.includes(f));
const extraMine = mine.filter((f) => !MY_FAMILY.includes(f));
check('V7.fileFamily', missing.length === 0 && extraMine.length === 0 && others.every((f) => f.startsWith('settle-formalization-')), `this desk's namespace carries exactly its emission family (7 required + the verify-out this script writes at V8); ${others.length} co-tenant files belong to the settle-formalization desk namespace (shared round directory, lawful co-tenancy)`);
check('V7.recordDeterminism', [vv, fr, rt, fsr].every((r) => r.j.createdAt === CREATED_AT), 'all four records carry the pinned timestamp');

/* ------------------------------------------------------------------ */
/* V8: verify-out assembly + self-digest                                */
/* ------------------------------------------------------------------ */

const passCount = checks.filter((c) => c.pass).length;
const verifyOut = {
  verifyOutKind: 'reviewer-refusal-verify',
  semanticCode: 'FR-Define-Architecture-Contract-001',
  reviewRef: fr.j.artifactRef,
  verificationRef: vv.j.artifactRef,
  traceRef: rt.j.traceRef,
  submissionRef: fsr.j.submissionRef,
  createdAt: CREATED_AT,
  declaredDigestsTrusted: false,
  checks,
  summary: { total: checks.length, pass: passCount, fail: checks.length - passCount, allPass: passCount === checks.length, scanFiles: scan.files },
  workspaceSummary: `workspace: ${CLAIMED.workspaceSummary} (frame line; adjudicated FALSE by FR-Define-Architecture-Contract-001: the one projected address is a phantom - zero hash-resolutions, process-impossible, wrong-referent - refused as acceptance authority; recomputed truth 0 accepted upstream revisions on this chain)`,
  upstreamAcceptedAdjudication: 'UNRESOLVED at the content layer (phantom-upstream-projection; stale shell metadata; CRIT-1 family); REFUSED as acceptance authority; NOT ratified',
  ratifiedWorkspaceCensus: '0 of 6 upstream desks accepted; only the discovery import chain is accepted',
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

writeFileSync(join(DIR, 'define-architecture-contract-desk-reviewer-verify-out.json'), `${JSON.stringify(verifyOut, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  verified: 'FR-Define-Architecture-Contract-001 (define-architecture-contract desk reviewer refusal emission)',
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
