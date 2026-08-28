/**
 * freeze-what-baseline desk (author) - RE-STAFF CONFIRMATION builder.
 *
 * Emission: AS-Freeze-What-Baseline-001. Deterministic authoring of the
 * freeze-what-baseline desk's author seat, staffing #3 of stray-products-r3.
 *
 * This staffing's desk task envelope is byte-identical to the standing
 * staffing's envelope (all 8 task-projection content addresses, the
 * protocol/semantic skill pins a926df62/95fafc84, the workspace summary
 * line "0 accepted upstream revisions travel by content address" and the
 * write authority "artifact-create,trace-add,fs:read,fs:write"). Desk law
 * on re-staffing with an identical envelope: the outcome is idempotent by
 * content address - this staffing re-verifies the standing upstream hold
 * UH-Freeze-What-Baseline-001 (9f2d28b9...) and re-checks the upstream
 * state, then mints a CONFIRMATION record, never a second hold, never
 * product material.
 *
 * The hold basis is recomputed, not trusted: envelope 8/8 from the accepted
 * capsule (9/9 with CERT-1), the gate verdict of record FR-Reconcile-What-001
 * (repair) with its explicit no-accept prohibition toward this desk, the
 * census 0 of 5 accepted pre-freeze desks, a workspace-wide movement scan
 * proving no accepted verdict landed at any pre-freeze desk's own content
 * address since the hold, and the what-baseline schema pin. The freeze
 * product contract (frf-contracts.what-baseline.v1) still demands
 * acceptanceRecords minItems 5 - the direct lawful-authoring blocker. The
 * hold's resume contract R1-R4 is unfulfilled; the hold STANDS.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. All addresses are sha256 over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule
 * (src/workflow-kernel/domain/digest.ts).
 *
 * Run: node freeze-what-baseline-desk-restaff-build.mjs
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
const QUAL = join(REPO, 'docs', 'refactoring', 'event-kernel', 'qualification');
const FB = join(REPO, '.factory-testbed');
const CREATED_AT = '2026-08-28T12:00:00Z';
const WS = '0 accepted upstream revisions travel by content address';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const SEMANTIC_SKILL = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';

/* The task-projection envelope (content addresses of this desk task;
 * byte-identical to the standing hold's ENVELOPE). */
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

const expect = (cond, message) => { if (!cond) throw new Error(`restaff basis failed: ${message}`); };

const loadRec = (relPath) => JSON.parse(readFileSync(join(REPO, relPath), 'utf8'));
const digestOf = (relPath) => sha(loadRec(relPath).content);

const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';

/* ------------------------------------------------------------------ */
/* Envelope identity: 8/8 recomputed from the accepted capsule          */
/* ------------------------------------------------------------------ */

const importArt = loadRec(`${R2}/import-discovery-handoff-desk-discovery-import.artifact.json`);
expect(sha(importArt.content) === importArt.contentDigest, 'import artifact content digest drift');
expect(importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', 'import artifact address drift');
const IMPORT_REF = shaRef(importArt.contentDigest);

const vsa = importArt.content.verifiedSubArtifacts;
const groups = [
  ['sourceClaims', vsa.sourceClaims],
  ['constraints', vsa.constraints],
  ['unknowns', vsa.unknowns],
  ['terminalLifecycleClaims', vsa.terminalLifecycleClaims],
  ['certificate', [vsa.certificate]],
];
const envelopeRecompute = [];
for (const [group, arr] of groups) {
  for (const s of arr) {
    const digest = sha(s.content);
    expect(digest === s.digest, `capsule sub-artifact ${s.semanticCode} digest drift`);
    const envelopeHit = Object.entries(ENVELOPE).find(([id, d]) => d === digest);
    envelopeRecompute.push({
      semanticCode: s.semanticCode,
      group,
      digest,
      ref: shaRef(digest),
      envelopeId: envelopeHit ? envelopeHit[0] : null,
      envelopeMatch: envelopeHit ? envelopeHit[1] === digest : false,
    });
  }
}
for (const [id, digest] of Object.entries(ENVELOPE)) {
  expect(envelopeRecompute.some((e) => e.envelopeId === id && e.envelopeMatch), `envelope id ${id} does not recompute from the accepted capsule`);
}
const certDigest = sha(vsa.certificate.content);
expect(certDigest === '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21', 'capsule certificate digest drift');

/* ------------------------------------------------------------------ */
/* The standing package of record: UH-Freeze-What-Baseline-001          */
/* ------------------------------------------------------------------ */

const holdArt = loadRec(`${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`);
const holdTrc = loadRec(`${R3}/freeze-what-baseline-desk-upstream-hold-trace.json`);
expect(sha(holdArt.content) === holdArt.contentDigest && holdArt.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f', 'standing hold artifact digest drift');
expect(sha(holdTrc.content) === holdTrc.contentDigest && holdTrc.contentDigest === '17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202', 'standing hold trace digest drift');
expect(holdArt.content.decision === 'hold-no-authoring' && holdArt.content.noProductAuthored === true, 'standing hold decision drift');
/* The hold's own envelope projection is byte-equal to this staffing's envelope. */
expect(
  holdArt.content.taskProjection.verifiedSubArtifacts.length === 8 &&
  Object.entries(ENVELOPE).every(([id, d]) => holdArt.content.taskProjection.verifiedSubArtifacts.some((v) => v.id === id && v.digest === d)),
  'standing hold envelope projection != this staffing envelope',
);
expect(holdArt.content.workspaceSummary === WS, 'standing hold workspace summary drift');
/* The standing hold receipt: verified semantically (its whole-file digest is
 * regenerable - scanFiles counts qualification tree files and grows with the
 * corpus; the semantic pins are stable). */
const holdVo = loadRec(`${R3}/freeze-what-baseline-desk-hold-verify-out.json`);
expect(holdVo.summary?.allPass === true && holdVo.summary?.pass === 33 && holdVo.summary?.fail === 0, 'standing hold receipt semantic drift');
expect(holdVo.artifactRef === shaRef(holdArt.contentDigest) && holdVo.traceRef === shaRef(holdTrc.contentDigest), 'standing hold receipt subject binding drift');
/* Census of record. */
const census = holdArt.content.chainAcceptanceCensus;
expect(census.acceptedPreFreezeDeskCount === 0 && census.requiredByFreezeContract === 5, 'standing hold census drift');

/* ------------------------------------------------------------------ */
/* The upstream gate: recomputed, unchanged                             */
/* ------------------------------------------------------------------ */

const g = {
  rwArt: digestOf(`${R3}/reconcile-what-desk-what-reconciliation.artifact.json`),
  rwTrc: digestOf(`${R3}/reconcile-what-desk-what-reconciliation-trace.json`),
  rwSub: digestOf(`${R3}/reconcile-what-desk-product-submission.json`),
  frRw: digestOf(`${R3}/reconcile-what-desk-reviewer-review.json`),
  vvRw: digestOf(`${R3}/reconcile-what-desk-reviewer-verification.json`),
  rtRw: digestOf(`${R3}/reconcile-what-desk-reviewer-trace.json`),
  fsRw2: digestOf(`${R3}/reconcile-what-desk-reviewer-product-submission.json`),
  clRw: digestOf(`${R3}/reconcile-what-desk-reviewer-collision-record.json`),
};
expect(g.rwArt === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191', 'reconcile-what artifact address drift');
expect(g.rwTrc === '09e800469f38c2d926dc1ef24974ca3b2f01ce72913ffcc5832dde071d6581e0', 'reconcile-what trace address drift');
expect(g.rwSub === '0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba', 'reconcile-what submission address drift');
expect(g.frRw === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6', 'FR-Reconcile-What-001 drift');
expect(g.vvRw === 'cd7504a69eff07d39f9945f8cf3da3f7cf8c4d8e91932c897dab5f5fbab35cac', 'VV-Reconcile-What-001 drift');
expect(g.rtRw === 'fe108e09db2dedb37dbb151d46e56090128c7bc44da339e44be62a47e7755373', 'RT-Reconcile-What-001 drift');
expect(g.fsRw2 === '9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce', 'FS-Reconcile-What-002 drift');
expect(g.clRw === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d', 'CL-Reconcile-What-001 drift');
const frRwRaw = loadRec(`${R3}/reconcile-what-desk-reviewer-review.json`).content;
expect(frRwRaw.reviewId === 'FR-Reconcile-What-001' && frRwRaw.verdict === 'repair', 'gate verdict of record drift');
expect(frRwRaw.reviewedCandidate?.submissionRef === shaRef(g.rwSub) && frRwRaw.reviewedCandidate?.artifactRef === shaRef(g.rwArt), 'gate reviewer candidate binding drift');
expect(frRwRaw.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline'), 'gate nextStage prohibition drift');
expect(frRwRaw.findings.criticalIssues.some((f) => f.id === 'CRIT-1' && f.requiredAction.includes('No accept effect may fire on this chain')), 'gate CRIT-1 prohibition drift');
const clRwRaw = loadRec(`${R3}/reconcile-what-desk-reviewer-collision-record.json`).content;
expect(clRwRaw.emissionA?.verdict === 'repair' && clRwRaw.discipline?.includes('round of record in the plain slots is emission A'), 'gate collision record drift');

/* ------------------------------------------------------------------ */
/* Census recompute: the five pre-freeze revisions, none accepted       */
/* ------------------------------------------------------------------ */

const REV = {
  'define-product-intent': digestOf(`${R3}/define-product-intent-desk-product-intent.artifact.json`),
  'model-use-cases': digestOf(`${R3}/model-use-cases-desk-uc-scenarios.artifact.json`),
  'derive-system-requirements': digestOf(`${R3}/derive-system-requirements-desk-system-requirements.artifact.json`),
  'define-acceptance-contract': digestOf(`${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`),
  'reconcile-what': g.rwArt,
};
expect(REV['define-product-intent'] === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055', 'intent revision address drift');
expect(REV['model-use-cases'] === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b', 'UC revision address drift');
expect(REV['derive-system-requirements'] === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df', 'requirements revision address drift');
expect(REV['define-acceptance-contract'] === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0', 'acceptance revision address drift');

/* Verdict-of-record evidence recomputed. */
const frIntent1 = loadRec(`${R2}/define-product-intent-desk-reviewer-review.json`).content;
const frIntent1b = loadRec(`${R2}/define-product-intent-desk-reviewer-review-emission-b.json`).content;
const frIntent2 = loadRec(`${R2}/define-product-intent-desk-reviewer2-review.json`).content;
expect(frIntent1.verdict === 'repair' && frIntent1b.verdict === 'repair' && frIntent2.verdict === 'repair', 'intent verdict-of-record drift');
const frUc001 = loadRec('.factory-testbed/model-use-cases-reviewer-review.json').content;
expect(frUc001.reviewId === 'FR-Model-Use-Cases-001' && frUc001.verdict === 'accepted' && frUc001.reviewedCandidate?.artifactRef === 'sha256:c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8', 'UC only-verdict drift');
expect(frUc001.reviewedCandidate.artifactRef !== shaRef(REV['model-use-cases']), 'UC verdict unexpectedly pins the corpus bundle');
const frSr1 = loadRec(`${R2}/derive-system-requirements-desk-reviewer-review.json`).content;
expect(frSr1.verdict === 'repair', 'requirements verdict-of-record drift');
const uhAc = digestOf(`${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`);
expect(uhAc === 'a53a5e08a9c7f0f6ad550fd5d2db142238683e1d285458eb2ded5330cce39d84', 'UH-Define-Acceptance-Contract-001 drift');
const frAc2 = loadRec(`${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`).content;
expect(frAc2.reviewId === 'FR-Define-Acceptance-Contract-002' && frAc2.verdict === 'repair' && frAc2.reviewedCandidate?.artifactRef === shaRef(REV['define-acceptance-contract']), 'CTN adjudicating emission C drift');
const fsAc2Raw = loadRec(`${R3}/define-acceptance-contract-desk-reviewer-product-submission-emission-c.json`).content;
expect(JSON.stringify(fsAc2Raw).includes('CTN-Define-Acceptance-Contract-001'), 'CTN adjudication reference drift');

/* ------------------------------------------------------------------ */
/* Movement scan: no accepted verdict at any pre-freeze desk's own      */
/* content address landed since the hold (workspace-wide, r1+r2+r3+FB)  */
/* ------------------------------------------------------------------ */

const BENIGN_ACCEPTED_CANDIDATES = new Set([
  '745cadc1131468039f167043c000fc0af170ed98764f545f22d867be36da1c35', // stale shell metadata family (define-product-intent, .factory-testbed)
  'c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8', // the accepted UC product - a DIFFERENT candidate than the corpus bundle
  'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', // the accepted import artifact (the only accepted chain)
]);
const REVSET = new Set(Object.values(REV));
const movement = { filesScanned: 0, verdictRecords: 0, acceptedAtOwnAddress: {}, acceptedElsewhere: [], unparseable: 0 };
for (const desk of Object.keys(REV)) movement.acceptedAtOwnAddress[desk] = [];
const walkTree = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let isDir;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (isDir) { walkTree(p); continue; }
    if (!e.endsWith('.json')) continue;
    movement.filesScanned += 1;
    let obj = null;
    try { obj = JSON.parse(readFileSync(p, 'utf8')); } catch { movement.unparseable += 1; continue; }
    const c = obj?.content;
    if (!c || typeof c !== 'object') continue;
    const verdict = typeof c.verdict === 'string' ? c.verdict : null;
    const candRef = typeof c.reviewedCandidate?.artifactRef === 'string' ? c.reviewedCandidate.artifactRef : null;
    if (!verdict || !candRef) continue;
    movement.verdictRecords += 1;
    if (verdict !== 'accepted') continue;
    const cand = candRef.startsWith('sha256:') ? candRef.slice(7) : candRef;
    const deskHit = Object.entries(REV).find(([, d]) => d === cand);
    if (deskHit) movement.acceptedAtOwnAddress[deskHit[0]].push({ file: relQualPath(p), reviewId: c.reviewId ?? null, candidateRef: candRef });
    else movement.acceptedElsewhere.push({ file: relQualPath(p), reviewId: c.reviewId ?? null, candidateRef: candRef });
  }
};
function relQualPath(p) {
  const a = REPO.split('\\').join('/');
  return p.split('\\').join('/').slice(a.length + 1);
}
walkTree(QUAL);
walkTree(FB);
/* accepted records at a pre-freeze desk's own address: for the acceptance
 * desk exactly the two superseded plain-slot round records (the FR-Define-
 * Acceptance-Contract-001 review + its reviewer product submission) - both
 * SUPERSEDED by the CTN-Define-Acceptance-Contract-001 adjudication (emission
 * C repair is the round of record, recomputed above). Every other desk: zero. */
for (const desk of Object.keys(REV)) {
  const hits = movement.acceptedAtOwnAddress[desk];
  if (desk === 'define-acceptance-contract') {
    expect(hits.length === 2, `acceptance desk accepted-record census drift: ${JSON.stringify(hits)}`);
    const reviewHit = hits.find((h) => h.reviewId === 'FR-Define-Acceptance-Contract-001');
    const submissionHit = hits.find((h) => h.reviewId === null && h.file.endsWith('define-acceptance-contract-desk-reviewer-product-submission.json'));
    expect(Boolean(reviewHit) && Boolean(submissionHit), `acceptance desk superseded-round record shapes drift: ${JSON.stringify(hits)}`);
    /* supersession recomputed above (frAc2 repair + CTN reference in fsAc2) */
  } else {
    expect(hits.length === 0, `unexpected accepted verdict at ${desk}'s own address: ${JSON.stringify(hits)}`);
  }
}
for (const h of movement.acceptedElsewhere) {
  const cand = h.candidateRef.startsWith('sha256:') ? h.candidateRef.slice(7) : h.candidateRef;
  expect(BENIGN_ACCEPTED_CANDIDATES.has(cand), `unexpected accepted verdict outside the known-benign set: ${JSON.stringify(h)}`);
}

/* ------------------------------------------------------------------ */
/* The freeze product contract + the governing anchor                   */
/* ------------------------------------------------------------------ */

const schemaPath = join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json');
const schemaBytes = readFileSync(schemaPath);
const schemaRawDigest = shaRaw(schemaBytes);
expect(schemaRawDigest === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09', 'what-baseline schema raw digest drift');
const schema = JSON.parse(schemaBytes.toString('utf8'));
expect(schema.properties.acceptanceRecords.minItems === 5 && schema.properties.schemaVersion.const === 'frf-contracts.what-baseline.v1', 'freeze contract law drift');

/* Governing anchor: resolution scan (content-addressed resolution, not
 * textual mention). No .content block anywhere in the scanned trees hashes
 * to the anchor; textual mentions are provenance, recorded as such. */
const resolutionScan = { filesScanned: 0, contentBlocksHashed: 0, resolutions: 0, textualMentions: 0, unparseable: movement.unparseable };
const walkRes = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let isDir;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (isDir) { walkRes(p); continue; }
    if (!e.endsWith('.json') && !e.endsWith('.mjs') && !e.endsWith('.md')) continue;
    resolutionScan.filesScanned += 1;
    const bytes = readFileSync(p);
    if (bytes.toString('utf8').includes(GOVERNING)) resolutionScan.textualMentions += 1;
    try {
      const j = JSON.parse(bytes.toString('utf8'));
      const blocks = [];
      if (j && typeof j === 'object' && j.content !== undefined) blocks.push(j.content);
      if (Array.isArray(j)) for (const x of j) if (x && typeof x === 'object' && x.content !== undefined) blocks.push(x.content);
      for (const b of blocks) {
        resolutionScan.contentBlocksHashed += 1;
        if (sha(b) === GOVERNING) resolutionScan.resolutions += 1;
      }
    } catch { /* counted unparseable in the movement pass */ }
  }
};
walkRes(QUAL);
walkRes(FB);
expect(resolutionScan.resolutions === 0, 'governing anchor RESOLVED somewhere in the workspace - envelope provenance would become ratifiable');
expect(resolutionScan.textualMentions > 0, 'governing anchor provenance mentions missing (the standing hold pins it verbatim)');

/* ------------------------------------------------------------------ */
/* The confirmation artifact content                                    */
/* ------------------------------------------------------------------ */

const artifactContent = {
  schemaVersion: 'formalization.author-restaff-confirmation.v1',
  deskRef: 'freeze-what-baseline',
  deskNodeId: 'freeze-what-baseline',
  role: 'author',
  itemInstanceId: 'formalization-item:freeze-what-baseline',
  token: 'plan:formalization#item:what-baseline',
  confirmationId: 'AS-Freeze-What-Baseline-001',
  staffingRound: 'stray-products-r3 author staffing #3 (re-staffing with a byte-identical desk task envelope; the standing upstream hold UH-Freeze-What-Baseline-001 is re-verified, not re-emitted)',
  confirmedPackageOfRecord: {
    holdArtifact: {
      id: 'UH-Freeze-What-Baseline-001',
      file: 'freeze-what-baseline-desk-upstream-hold.artifact.json',
      ref: shaRef(holdArt.contentDigest),
      kind: 'formalization.upstream-hold.v1',
      decision: 'hold-no-authoring',
    },
    holdTrace: {
      file: 'freeze-what-baseline-desk-upstream-hold-trace.json',
      ref: shaRef(holdTrc.contentDigest),
      edges: holdTrc.content.relationships.length,
    },
    holdVerifier: {
      file: 'freeze-what-baseline-desk-hold-verify.mjs',
      receipt: 'freeze-what-baseline-desk-hold-verify-out.json',
      receiptSemantics: '33/33 checks pass (allPass true); receipt subject binds the hold artifact/trace refs; the receipt whole-file digest is intentionally NOT pinned - it is regenerable and its scanFiles field tracks qualification-tree growth',
      checksPassed: 33,
    },
  },
  envelopeIdentity: {
    envelopeEqual: 'A1-A4: 8/8 task-projection ids+digests byte-equal the standing hold ENVELOPE and its verifiedSubArtifacts projection; 8/8 digests independently recomputed from the accepted r2 capsule (9/9 with CERT-1 03972527); workspace summary "0 accepted upstream revisions travel by content address" and write authority "artifact-create,trace-add,fs:read,fs:write" equal the standing staffing; skill pins a926df62/95fafc84 recorded verbatim as declared envelope provenance (the governing anchor stays unresolvable workspace-wide, NOT ratified)',
    projectionAdjudication: 'the 8 task-projection claims remain content addresses of the accepted capsule claims; none carries a new accepted verdict since UH-Freeze-What-Baseline-001 (movement scan recomputed workspace-wide); unknown:browser-matrix-1 derives nothing (carried never resolved, D10)',
    contentDelta: 'none (C1): the standing hold package recomputes byte-stable at its own content addresses (9f2d28b9/17c09566); no upstream desk reissued; the reconcile-what reviewer round of record is unchanged',
    envelopeRecompute,
  },
  upstreamStateRecheck: {
    gate: {
      deskId: 'reconcile-what',
      verdictOfRecord: {
        semanticCode: 'FR-Reconcile-What-001',
        verdict: 'repair',
        reviewRef: shaRef(g.frRw),
        verificationRef: shaRef(g.vvRw),
        reviewerTraceRef: shaRef(g.rtRw),
        reviewerSubmissionRef: shaRef(g.fsRw2),
      },
      candidateOfRecord: {
        semanticCode: 'FS-Reconcile-What-001',
        submissionRef: shaRef(g.rwSub),
        artifactRef: shaRef(g.rwArt),
        traceRef: shaRef(g.rwTrc),
      },
      reviewerCollision: {
        semanticCode: 'CL-Reconcile-What-001',
        recordRef: shaRef(g.clRw),
        emissionAVerdict: 'repair',
        roundOfRecord: 'emission A (plain review/verification/trace/submission slots); emission B contested only the verify slots',
      },
      explicitProhibition: 'No domain.accepted may fire from this desk toward freeze-what-baseline on this chain.',
      prohibitionRecomputed: true,
    },
    census: { requiredByFreezeContract: 5, acceptedPreFreezeDeskCount: 0 },
    movementScan: {
      law: 'every desk counts only through an accepted reviewer verdict at its own content address',
      counterPolicy: 'tree-size counters (filesScanned/verdictRecords) are intentionally NOT published in this content-addressed record - they grow with the qualification tree and would break byte-stable re-derivation; they live in the regenerable desk receipt only. The published blocks below are content-derived and byte-stable.',
      acceptedAtOwnAddress: Object.fromEntries(Object.entries(movement.acceptedAtOwnAddress).map(([desk, hits]) => [desk, {
        count: hits.length,
        ...(desk === 'define-acceptance-contract' ? {
          disposition: 'exactly the two superseded plain-slot round records (FR-Define-Acceptance-Contract-001 review + its reviewer product submission) - SUPERSEDED by the CTN-Define-Acceptance-Contract-001 adjudication; the round of record is emission C repair (FR-Define-Acceptance-Contract-002 7e76176c..., recomputed) and the desk stands on record hold a53a5e08 - still NOT accepted',
          records: hits,
        } : {
          disposition: 'none',
        }),
      }])),
      acceptedElsewhereCount: movement.acceptedElsewhere.length,
      acceptedElsewhere: movement.acceptedElsewhere,
      knownBenignLaw: 'every accepted verdict outside the five pre-freeze addresses pins one of exactly three known candidates: the stale shell metadata family 745cadc1 (define-product-intent, .factory-testbed), the genuinely accepted UC product c6120e86 (a DIFFERENT candidate than the corpus bundle 24f0aff2), and the genuinely accepted import artifact b10bb762 (the only accepted chain)',
      newAcceptedLineageSinceHold: 0,
    },
  },
  holdDisposition: {
    state: 'STANDING (not discharged; not re-emitted)',
    basis: 'the freeze product contract (frf-contracts.what-baseline.v1, schema raw sha256 ab1b7f5e...) still demands acceptanceRecords minItems 5; the recomputed census is 0 of 5 accepted pre-freeze desks; the gate verdict of record FR-Reconcile-What-001 (repair) still carries the explicit prohibition "No domain.accepted may fire from this desk toward freeze-what-baseline on this chain" with the CRIT-1 permanence warning; a freeze over unaccepted lineage would still inherit the fabricated authority permanently',
    resumeContract: 'R1-R4 of UH-Freeze-What-Baseline-001 unfulfilled: no accepted pre-freeze revision landed (R1), no accepted reconcile-what re-run verdict discharged the prohibition (R2), so this desk authors nothing (R3) and carries no hold bytes as product lineage (R4)',
  },
  emissionDiscipline: {
    noSecondHoldEmission: 'C2: the author outcome is idempotent by content address - one standing hold (9f2d28b9), one hold trace (17c09566), one hold receipt; this staffing mints NO second hold, NO product, NO baseline material (the CR anti-pattern family)',
    adv5: 'this emission writes ONLY restaff-namespaced files; zero existing files modified or deleted (the standing package recomputes in place; the hold receipt regenerates byte-stable under its deterministic verifier)',
    writeAuthorityExercised: 'only the frame-allowed operations: artifact-create + trace-add + fs:read/fs:write inside the desk namespace; no product_submit',
  },
  deskOutcome: {
    decision: 'hold-no-authoring (carried)',
    product: 'none',
    productKind: null,
    terminalClaims: 'terminal:audited-1 and terminal:delivered-1 remain envelope content addresses only - witnessed by no desk product on this chain, never re-minted',
    carriedForward: [
      'constraint:retention-1 sha256:807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be',
      'unknown:browser-matrix-1 sha256:38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf (carried never resolved, D10)',
      'claim:scope-2 sha256:cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da (upstream-contested carried boundary material; reconcile-what RA routing)',
    ],
  },
  governingContractRef: shaRef(GOVERNING),
  governingContractNote: 'declared in this desk task protocol-skill layer; recorded verbatim as envelope provenance. Resolution scan recomputed this staffing: 0 content blocks hash to the anchor workspace-wide; textual mentions are provenance only. NOT ratified by this desk; this confirmation does not depend on it.',
  envelopePins: {
    protocolSkillRef: shaRef(GOVERNING),
    semanticSkillRef: shaRef(SEMANTIC_SKILL),
    workspaceSummary: WS,
    upstreamAccepted: [],
    writeAuthority: 'write authority: desk artifacts only; allowed=artifact-create,trace-add,fs:read,fs:write',
  },
  verification: {
    declaredDigestsTrusted: false,
    importArtifactDigestRecomputed: true,
    capsuleSubArtifactDigestsRecomputed: true,
    envelopeProjectionDigestsRecomputed: true,
    standingPackageRecomputed: true,
    citedRecordDigestsRecomputed: true,
    gateProhibitionRecomputedFromVerdictRecord: true,
    movementScanRecomputedWorkspaceWide: true,
    schemaRawDigestRecomputed: true,
    governingAnchorResolutionScan: { resolutions: resolutionScan.resolutions },
    noAcceptedStateAsserted: true,
    acceptedStateClaimsGatedOnVerdictRecords: true,
    productMaterialAuthored: false,
    deterministicAuthoring: true,
  },
  trace: { file: 'freeze-what-baseline-desk-restaff-trace.json', edgeCount: 25 },
  workspaceSummary: WS,
};

const confirmation = {
  confirmationRef: shaRef(sha(artifactContent)),
  artifactKind: 'author-restaff-confirmation',
  contentDigest: sha(artifactContent),
  semanticCode: 'AS-Freeze-What-Baseline-001',
  createdAt: CREATED_AT,
  deskRef: 'freeze-what-baseline',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: artifactContent,
};

/* ------------------------------------------------------------------ */
/* The confirmation trace (embeds the confirmation by content digest;   */
/* the confirmation binds the trace by file + edge count only - acyclic)*/
/* ------------------------------------------------------------------ */

const resolveId = (id) => {
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (id === 'AS-Freeze-What-Baseline-001') return sha(artifactContent);
  if (id === 'UH-Freeze-What-Baseline-001') return holdArt.contentDigest;
  if (id === 'trace:UH-Freeze-What-Baseline-001') return holdTrc.contentDigest;
  if (id === 'import:discovery-handoff') return importArt.contentDigest;
  if (id === 'cert:discovery-capsule') return certDigest;
  if (id === 'FR-Reconcile-What-001') return g.frRw;
  if (id === 'VV-Reconcile-What-001') return g.vvRw;
  if (id === 'RT-Reconcile-What-001') return g.rtRw;
  if (id === 'FS-Reconcile-What-002') return g.fsRw2;
  if (id === 'CL-Reconcile-What-001') return g.clRw;
  if (id === 'FS-Reconcile-What-001') return g.rwSub;
  if (id === 'art:what-reconciliation') return g.rwArt;
  if (id === 'FR-Define-Acceptance-Contract-002') return sha(loadRec(`${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`).content);
  if (id === 'link:define-product-intent') return REV['define-product-intent'];
  if (id === 'link:model-use-cases') return REV['model-use-cases'];
  if (id === 'link:derive-system-requirements') return REV['derive-system-requirements'];
  if (id === 'link:define-acceptance-contract') return REV['define-acceptance-contract'];
  if (id === 'link:reconcile-what') return REV['reconcile-what'];
  throw new Error(`trace id ${id} does not resolve to a recomputed digest`);
};

const rel = (fromId, relation, toId, description) => ({
  fromId,
  relation,
  toId,
  description,
  fromRef: shaRef(resolveId(fromId)),
  toRef: shaRef(resolveId(toId)),
});

const relationships = [
  ...Object.keys(ENVELOPE).map((id) => rel(
    'AS-Freeze-What-Baseline-001', 'verifies', id,
    `The confirmation's envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection byte-for-byte with the standing staffing.`,
  )),
  rel('AS-Freeze-What-Baseline-001', 'confirms', 'UH-Freeze-What-Baseline-001', 'The standing hold package of record recomputes byte-stable (artifact 9f2d28b9); STANDING in this staffing, not re-emitted.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'trace:UH-Freeze-What-Baseline-001', 'The standing hold trace (23 edges) recomputes; subject binds the hold artifact ref.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'import:discovery-handoff', 'The accepted discovery import chain remains the only accepted base (content digest recomputed).'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'FR-Reconcile-What-001', 'The upstream gate verdict of record: repair, recomputed; prohibition intact.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'VV-Reconcile-What-001', 'The reviewer verification of record recomputes.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'RT-Reconcile-What-001', 'The reviewer trace recomputes.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'FS-Reconcile-What-002', 'The reviewer product submission (verdict repair, RA-1..RA-5 routing) recomputes.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'CL-Reconcile-What-001', 'The reviewer-seat collision record: emission A (repair) remains the round of record.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'FS-Reconcile-What-001', 'The upstream author candidate of record; NOT settled; unchanged since the hold.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'art:what-reconciliation', 'The upstream reconciliation artifact of record recomputes at its own address.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'link:define-product-intent', 'Pre-freeze desk 1: repair verdicts across every emission recomputed; movement scan: no accepted verdict at its own address.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'link:model-use-cases', 'Pre-freeze desk 2: still never reviewed at its own content address (only verdict pins c6120e86); NOT accepted.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'link:derive-system-requirements', 'Pre-freeze desk 3: repair verdict + re-staff confirmation recomputed; reviewer seat held; NOT accepted.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'link:define-acceptance-contract', 'Pre-freeze desk 4: the single accepted emission remains superseded by the CTN adjudication (emission C repair); desk on record hold; NOT accepted.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'link:reconcile-what', 'Pre-freeze desk 5 (the upstream gate): repair verdict of record recomputed; NOT accepted.'),
  rel('AS-Freeze-What-Baseline-001', 'observes', 'FR-Define-Acceptance-Contract-002', 'The CTN adjudicating emission C recomputes: repair confirmed, the accepted emission superseded.'),
];

expect(relationships.length === 25, `trace edge count drift: ${relationships.length} != the edge count bound in the confirmation content`);
expect(relationships.every((r) => ['observes', 'verifies', 'confirms'].includes(r.relation)), 'trace relation vocabulary drift');

const traceContent = {
  deskRef: 'freeze-what-baseline',
  role: 'author',
  traceKind: 'author-restaff-confirmation-trace',
  subjectSemanticCode: 'AS-Freeze-What-Baseline-001',
  subjectArtifactRef: confirmation.confirmationRef,
  relationVocabulary: ['observes', 'verifies', 'confirms'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: ['AS-Freeze-What-Baseline-001'] }])),
  confirmationCoverage: {
    standingPackage: 'UH-Freeze-What-Baseline-001 (artifact 9f2d28b9, trace 17c09566) recomputed byte-stable; STANDING',
    gateVerdictOfRecord: 'FR-Reconcile-What-001 (repair; prohibition intact)',
    preFreezeDesksAccepted: 0,
    preFreezeDesksRequired: 5,
    newAcceptedLineageSinceHold: 0,
    productAuthored: false,
  },
  branchResolutionNote: 'No scenario, branch, requirement, criterion, container or baseline identities are authored by this confirmation; all observed links resolve at record/artifact granularity.',
  confirmationContentDigest: confirmation.contentDigest,
  workspaceSummary: WS,
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'author-restaff-confirmation-trace',
  contentDigest: sha(traceContent),
  createdAt: CREATED_AT,
  deskRef: 'freeze-what-baseline',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

/* ------------------------------------------------------------------ */
/* Write                                                                */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('freeze-what-baseline-desk-restaff-confirmation.json', confirmation);
writeJson('freeze-what-baseline-desk-restaff-trace.json', trace);

console.log(JSON.stringify({
  built: 'freeze-what-baseline desk (author) re-staff confirmation',
  semanticCode: 'AS-Freeze-What-Baseline-001',
  confirmationRef: confirmation.confirmationRef,
  traceRef: trace.traceRef,
  standingHold: 'UH-Freeze-What-Baseline-001 STANDING (9f2d28b9)',
  envelopeRecomputed: '8/8 (+CERT-1)',
  acceptedPreFreezeDesks: '0 of 5 (required 5 by frf-contracts.what-baseline.v1)',
  movementScan: { files: movement.filesScanned, verdictRecords: movement.verdictRecords, newAcceptedLineage: 0 },
  governingAnchorResolutions: resolutionScan.resolutions,
}, null, 2));
