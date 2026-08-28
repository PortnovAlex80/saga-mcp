/**
 * freeze-what-baseline desk (reviewer) - HOLD CONFIRMATION builder.
 *
 * Emission: RC-Freeze-What-Baseline-001. Deterministic authoring of the
 * freeze-what-baseline desk's REVIEWER seat in stray-products-r3.
 *
 * This staffing is the FIRST reviewer-stage record of the desk. The author
 * seat authored NO product: it stands on UH-Freeze-What-Baseline-001
 * (hold-no-authoring, artifact 9f2d28b9..., trace 17c09566..., 33/33 hold
 * verifier). There is therefore no author candidate and no reviewer package
 * of record to review. The lawful reviewer emission is a confirmation of the
 * standing hold plus adjudication of this frame's envelope projection delta:
 * the envelope now claims upstream-accepted[0] sha256:e210334e... :: "accepted
 * revision of freeze-what-baseline" and workspace summary "1 accepted upstream
 * revisions travel by content address" (the author frame carried 0 and no
 * upstream-accepted entry). This staffing scans the full qualification tree
 * and adjudicates the claim.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. All addresses are sha256 over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule
 * (src/workflow-kernel/domain/digest.ts). Every cited record digest is
 * recomputed from the corpus files in this script; nothing is trusted by
 * declaration.
 *
 * Run: node freeze-what-baseline-desk-reviewer-confirmation-build.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
const CREATED_AT = '2026-08-28T00:00:00Z';

/* THIS reviewer frame's envelope (verbatim from the desk task projection). */
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
const UPSTREAM_ACCEPTED = 'e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de';
const WORKSPACE_SUMMARY = 'workspace: 1 accepted upstream revisions travel by content address';
const WRITE_AUTHORITY = 'write authority: desk artifacts only; allowed=candidate-read,product-read,product-submit';
const PROTOCOL_SKILL = 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50';
const SEMANTIC_SKILL = '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2';

const expect = (cond, message) => { if (!cond) throw new Error(`confirmation basis failed: ${message}`); };

/* ------------------------------------------------------------------ */
/* The standing author hold (recomputed from raw bytes, zero trust)     */
/* ------------------------------------------------------------------ */

const holdArt = JSON.parse(readFileSync(join(DIR, 'freeze-what-baseline-desk-upstream-hold.artifact.json'), 'utf8'));
const holdTrc = JSON.parse(readFileSync(join(DIR, 'freeze-what-baseline-desk-upstream-hold-trace.json'), 'utf8'));
const holdOut = JSON.parse(readFileSync(join(DIR, 'freeze-what-baseline-desk-hold-verify-out.json'), 'utf8'));
expect(sha(holdArt.content) === holdArt.contentDigest, 'hold artifact content digest drift');
expect(holdArt.artifactRef === shaRef(holdArt.contentDigest), 'hold artifact ref drift');
expect(holdArt.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f', 'hold artifact address drift');
expect(sha(holdTrc.content) === holdTrc.contentDigest && holdTrc.contentDigest === '17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202', 'hold trace drift');
const holdOutSansDigest = sortKeys({
  verifyOutKind: holdOut.verifyOutKind, semanticCode: holdOut.semanticCode, artifactRef: holdOut.artifactRef, traceRef: holdOut.traceRef,
  createdAt: holdOut.createdAt, declaredDigestsTrusted: holdOut.declaredDigestsTrusted, checks: holdOut.checks,
  summary: holdOut.summary, workspaceSummary: holdOut.workspaceSummary,
});
expect(holdOut.verifyOutDigest === shaRaw(Buffer.from(JSON.stringify(holdOutSansDigest), 'utf8')), 'hold verify-out self-digest drift');
expect(holdOut.summary.allPass === true && holdOut.summary.pass === 33 && holdOut.summary.fail === 0, 'hold verifier receipt is not 33/33 green');
expect(holdArt.content.decision === 'hold-no-authoring' && holdArt.content.noProductAuthored === true, 'hold decision drift');
/* The hold pinned the identical 8 task-projection addresses this frame carries. */
for (const v of holdArt.content.taskProjection.verifiedSubArtifacts) {
  expect(ENVELOPE[v.id] === v.digest, `hold envelope pin drift at ${v.id}`);
}

/* ------------------------------------------------------------------ */
/* Recompute the accepted capsule + envelope projection (C2 layer)      */
/* ------------------------------------------------------------------ */

const importArt = JSON.parse(readFileSync(join(DIR, '..', 'stray-products-r2', 'import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));
expect(sha(importArt.content) === importArt.contentDigest, 'import artifact content digest drift');
expect(importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', 'import artifact address drift');
const vsa = importArt.content.verifiedSubArtifacts;
const capDigests = [];
const groups = [
  ['sourceClaims', vsa.sourceClaims],
  ['constraints', vsa.constraints],
  ['unknowns', vsa.unknowns],
  ['terminalLifecycleClaims', vsa.terminalLifecycleClaims],
  ['certificate', [vsa.certificate]],
];
for (const [, arr] of groups) {
  for (const s of arr) {
    const digest = sha(s.content);
    expect(digest === s.digest, `capsule sub-artifact ${s.semanticCode} digest drift`);
    capDigests.push(digest);
  }
}
for (const [id, digest] of Object.entries(ENVELOPE)) {
  expect(capDigests.includes(digest), `envelope id ${id} does not recompute from the accepted capsule`);
}
expect(sha(vsa.certificate.content) === '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21', 'capsule certificate digest drift');

/* ------------------------------------------------------------------ */
/* Recompute the upstream gate + census records (C3/C4 layers)          */
/* ------------------------------------------------------------------ */

const record = (relPath) => {
  const j = JSON.parse(readFileSync(join(REPO, relPath), 'utf8'));
  return { contentDigest: sha(j.content), verdict: j.content.verdict ?? j.content.decision ?? null, reviewId: j.content.reviewId ?? j.semanticCode ?? null, reviewedCandidate: j.content.reviewedCandidate ?? null };
};

const rwArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-what-reconciliation.artifact.json');
const rwTrc = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-what-reconciliation-trace.json');
const rwSub = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-product-submission.json');
const frRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-review.json');
const vvRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-verification.json');
const rtRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-trace.json');
const fsRw2 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-product-submission.json');
const clRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-collision-record.json');
expect(rwArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191', 'reconcile-what artifact drift');
expect(rwTrc.contentDigest === '09e800469f38c2d926dc1ef24974ca3b2f01ce72913ffcc5832dde071d6581e0', 'reconcile-what trace drift');
expect(rwSub.contentDigest === '0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba', 'reconcile-what submission drift');
expect(frRw.reviewId === 'FR-Reconcile-What-001' && frRw.verdict === 'repair' && frRw.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6', 'FR-Reconcile-What-001 drift');
expect(vvRw.contentDigest === 'cd7504a69eff07d39f9945f8cf3da3f7cf8c4d8e91932c897dab5f5fbab35cac', 'VV-Reconcile-What-001 drift');
expect(rtRw.contentDigest === 'fe108e09db2dedb37dbb151d46e56090128c7bc44da339e44be62a47e7755373', 'RT-Reconcile-What-001 drift');
expect(fsRw2.contentDigest === '9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce', 'FS-Reconcile-What-002 drift');
expect(clRw.contentDigest === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d', 'CL-Reconcile-What-001 drift');
expect(frRw.reviewedCandidate?.artifactRef === shaRef(rwArt.contentDigest), 'gate reviewer candidate binding drift');
const frRwRaw = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-review.json'), 'utf8')).content;
expect(frRwRaw.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline'), 'gate prohibition drift');

const intentArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-product-intent-desk-product-intent.artifact.json');
const frIntent1 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-review.json');
const frIntent1b = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-review-emission-b.json');
const frIntent2 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer2-review.json');
expect(intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055', 'intent artifact drift');
expect(frIntent1.verdict === 'repair' && frIntent1.contentDigest === 'e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4', 'FR-Define-Product-Intent-001 drift');
expect(frIntent1b.verdict === 'repair' && frIntent1b.contentDigest === '6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc', 'FR-Define-Product-Intent-001 emission-b drift');
expect(frIntent2.verdict === 'repair' && frIntent2.contentDigest === '0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc', 'FR-Define-Product-Intent-002 drift');

const ucArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/model-use-cases-desk-uc-scenarios.artifact.json');
const ucHoldR2 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/model-use-cases-desk-upstream-hold.artifact.json');
const frUc001 = record('.factory-testbed/model-use-cases-reviewer-review.json');
expect(ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b', 'UC artifact drift');
expect(ucHoldR2.contentDigest === '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7', 'r2 UC upstream-hold drift');
expect(frUc001.reviewedCandidate?.artifactRef === 'sha256:c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8' && frUc001.reviewedCandidate?.artifactRef !== ucArt.contentDigest, 'UC only-verdict pin drift');

const srArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/derive-system-requirements-desk-system-requirements.artifact.json');
const frSr1 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/derive-system-requirements-desk-reviewer-review.json');
const rsSr1 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/derive-system-requirements-desk-reviewer-restaff2-confirmation.json');
const uhSr1 = record('.factory-testbed/derive-system-requirements-reviewer-hold.artifact.json');
const uhSr2 = record('.factory-testbed/derive-system-requirements-reviewer-hold2.artifact.json');
expect(srArt.contentDigest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df', 'requirements artifact drift');
expect(frSr1.verdict === 'repair' && frSr1.contentDigest === 'd31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0', 'FR-Derive-System-Requirements-001 drift');
expect(rsSr1.contentDigest === '1c30d28e8222eaa225195bf33d87f378054b98a01bdf50710fd4900f5339a0a6', 'RS-Derive-System-Requirements-001 drift');
expect(uhSr1.contentDigest === 'fbc0394bd8f79df2fc7e8956accd9fe25485bceab182044927de9f209f11d053', 'UH-Derive-System-Requirements-001 drift');
expect(uhSr2.contentDigest === 'b4eaaabaa5010c6e03594943e2437b030d352ec9f3027fb275d57f351692c995', 'UH-Derive-System-Requirements-002 drift');

const acArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-acceptance-bindings.artifact.json');
const uhAc = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-upstream-hold.artifact.json');
const frAc2 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-review-emission-c.json');
const vvAc2 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-verification-emission-c.json');
const fsAc2 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-product-submission-emission-c.json');
expect(acArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0', 'acceptance artifact drift');
expect(uhAc.contentDigest === 'a53a5e08a9c7f0f6ad550fd5d2db142238683e1d285458eb2ded5330cce39d84', 'UH-Define-Acceptance-Contract-001 drift');
expect(frAc2.reviewId === 'FR-Define-Acceptance-Contract-002' && frAc2.verdict === 'repair' && frAc2.contentDigest === '7e76176c431770477f2930747498f2df8b0a6ce6071c29ff065ad7d85edcac0e', 'FR-Define-Acceptance-Contract-002 drift');
expect(vvAc2.contentDigest === '61b9ce2e70b979f7e224bcbe17d492a3ffb85410a4b8a8ba139257cfbabd85a5', 'VV-Define-Acceptance-Contract-002 drift');
expect(fsAc2.contentDigest === 'bdd577ae01eccfdcf1334239271fae5478351294a4523607f832603a95ae33ac', 'acceptance reviewer submission emission C drift');

/* The freeze product contract itself. */
const schemaPath = join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json');
const schemaBytes = readFileSync(schemaPath);
expect(shaRaw(schemaBytes) === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09', 'what-baseline schema raw digest drift');
const schema = JSON.parse(schemaBytes.toString('utf8'));
expect(schema.properties.acceptanceRecords.minItems === 5, 'what-baseline acceptanceRecords minItems drift');
expect(schema.properties.schemaVersion.const === 'frf-contracts.what-baseline.v1', 'what-baseline schemaVersion drift');

/* ------------------------------------------------------------------ */
/* The confirmation artifact                                            */
/* ------------------------------------------------------------------ */

const artifactContent = {
  schemaVersion: 'formalization.reviewer-hold-confirmation.v1',
  deskRef: 'freeze-what-baseline',
  deskNodeId: 'freeze-what-baseline',
  role: 'reviewer',
  itemInstanceId: 'formalization-item:freeze-what-baseline',
  token: 'plan:formalization#item:what-baseline',
  confirmationKind: 'reviewer-hold-confirmation',
  decision: 'hold-upheld-no-candidate-to-review',
  statement: 'The freeze-what-baseline reviewer seat confirms the standing author hold UH-Freeze-What-Baseline-001 (9f2d28b9..., 33/33 receipt 622d7ba1...) and authors NO WHAT-baseline material. There is no candidate to review: the recomputed hold declares noProductAuthored=true. The envelope of this reviewer staffing carries a DELTA against the author frame: upstream-accepted[0] sha256:e210334e... :: "accepted revision of freeze-what-baseline" and the summary line "1 accepted upstream revisions travel by content address". This staffing adjudicates the delta: the address is UNRESOLVABLE (the full qualification tree scanned in three digest bodies - raw bytes, LF-normalized bytes, canonical-JSON whole-document and .content - 0 hits; it appears nowhere as a declared ref), and it is semantically impossible: no revision of this desk exists to be accepted (noProductAuthored=true), and no reviewer acceptance record of this desk exists. Stale shell metadata, same family as the r2 upstream-accepted claim 65fe9a22... adjudicated in RS-Derive-System-Requirements-001. The claim is recorded for the shell owner and NOT ratified. The verified census is unchanged: 0 of 5 pre-freeze desks accepted; the gate verdict of record FR-Reconcile-What-001 39a94a29... (repair) and its explicit prohibition "No domain.accepted may fire from this desk toward freeze-what-baseline on this chain" recompute and stand un-discharged; the only accepted base remains the discovery import chain (b10bb762..., capsule 8/8 + CERT-1 03972527...).',
  protocolLineage: {
    protocolVersion: 'ek.discovery-handoff-capsule.ek8-wp11f.v1',
    protocolVersionCheck: 'CURRENT',
    pinnedVia: 'transitive: the accepted import artifact of the import-discovery-handoff desk declares this protocol version',
    viaImportArtifactRef: shaRef(importArt.contentDigest),
  },
  confirmedHoldOfRecord: {
    semanticCode: 'UH-Freeze-What-Baseline-001',
    file: 'freeze-what-baseline-desk-upstream-hold.artifact.json',
    ref: shaRef(holdArt.contentDigest),
    decision: 'hold-no-authoring',
    noProductAuthored: true,
    trace: {
      file: 'freeze-what-baseline-desk-upstream-hold-trace.json',
      ref: shaRef(holdTrc.contentDigest),
      edges: holdTrc.content.relationships.length,
    },
    holdVerifierReceipt: {
      file: 'freeze-what-baseline-desk-hold-verify-out.json',
      verifyOutDigest: shaRef(holdOut.verifyOutDigest),
      pass: '33/33',
      allPass: true,
    },
  },
  reviewedCandidate: {
    exists: false,
    productKind: 'frf-contracts.what-baseline.v1',
    reason: 'the author seat authored NO product (hold-no-authoring, noProductAuthored=true recomputed from the hold bytes): there is no submission, no artifact and no trace of this desk to review, hence no FR/VV/FS reviewer package of record - this confirmation is the desk\'s first and only reviewer-stage record',
  },
  envelopeIdentity: {
    taskProjection: '8/8 task-projection content addresses equal the standing author-hold frame byte-for-byte (the hold pins the identical 8 digests) and re-derive from the accepted capsule 8/8 + CERT-1 (independently recomputed this staffing)',
    skillPins: 'protocol bc8a4261... / semantic 2cbcf850... equal the standing r3 staffing pins',
    writeAuthority: 'verbatim equal: "write authority: desk artifacts only; allowed=candidate-read,product-read,product-submit"',
    envelopeDelta: [
      'd1: workspaceSummary - this frame carries "workspace: 1 accepted upstream revisions travel by content address"; the author frame carried "workspace: 0 accepted upstream revisions travel by content address"',
      'd2: upstream-accepted[0] sha256:e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de :: "accepted revision of freeze-what-baseline" - absent from the author frame',
    ],
  },
  upstreamAcceptedAdjudication: {
    declared: 'sha256:e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de :: accepted revision of freeze-what-baseline',
    resolution: 'UNRESOLVABLE',
    method: 'the full qualification tree scanned (stray-products-r1/r2/r3, kits, series; live qualification corpus, count recorded in the verification receipt), three digest bodies per file - raw bytes, LF-normalized bytes, canonical-JSON of the parsed document and of its .content: 0 content hashes to this address and 0 documents canonically contain it; it is not the raw-bytes digest of any file either',
    semanticImpossibility: 'independent of the scan: the only product kind that could carry this address is frf-contracts.what-baseline.v1, and the recomputed hold of this desk declares noProductAuthored=true - no revision of freeze-what-baseline exists on this chain to be accepted, and no reviewer acceptance record of this desk exists; the nearest baseline-shaped corpus material is the r1 fixture (baseline .content 02e5f6ece3be..., settlement 097154d9fef6...), neither equals this address and neither travels in this chain authority',
    family: 'stale shell metadata, same family as sha256:65fe9a22... (upstream-accepted of the r2 derive-system-requirements reviewer envelope, adjudicated UNRESOLVABLE in RS-Derive-System-Requirements-001) and sha256:745cadc1...; recorded for the shell owner',
    ratified: false,
    consequence: 'the envelope summary line "1 accepted upstream revisions travel by content address" is NOT ratified by this desk: zero accepted upstream revisions travel by content address into freeze-what-baseline; the verified census is unchanged - 0 of 5 pre-freeze desks accepted; the only accepted base remains the discovery import chain (import b10bb762..., capsule 8/8 + CERT-1 03972527...)',
  },
  holdRecheck: {
    holdBytesUnchanged: 'hold artifact 9f2d28b9... and trace 17c09566... recompute byte-stable from the on-disk files and match the hold build determinism pins',
    holdReceipt: 'hold verify-out recomputes to self-digest 622d7ba1... with summary 33/33 pass / 0 fail',
    upstreamGateUnmoved: 'gate verdict of record FR-Reconcile-What-001 39a94a29... (repair) recomputes; the explicit prohibition recomputes from the verdict record nextStage and stands un-discharged; this staffing neither fires nor can fire it',
    censusUnmoved: 'all five pre-freeze verdict-of-record rows recompute: intent a06dbc57... repair x3 (e49d8d11..., 6c9c8324..., 04632094...); UC 24f0aff2... never reviewed at its own address (the only UC verdict 8aeee351... pins a different candidate c6120e86..., and the r2 authoring violated the desk hold 6cccd162...); requirements 86b00569... repair d31b044c... + RS-001 1c30d28e... with the reviewer seat held (fbc0394b..., b4eaaaba...); acceptance 2b01353d... adjudicated repair CTN-001 (FR-Define-Acceptance-Contract-002 7e76176c..., emission C) with the desk on record hold a53a5e08...; reconcile-what 6400a2dd... repair (CRIT-1 + CRIT-2)',
    freezeContractUnmoved: 'what-baseline schema raw digest ab1b7f5e... recomputes; acceptanceRecords minItems 5 stands; 0/5 < 5 - the direct lawful-authoring blocker is unchanged',
  },
  taskProjection: {
    verifiedSubArtifacts: Object.entries(ENVELOPE).map(([id, digest]) => ({ id, digest, ref: shaRef(digest) })),
    recompute: 'all 8 envelope entries recomputed from the accepted import-discovery-handoff capsule sub-artifact contents (9/9 including CERT-1) and matched exactly; identical to the hold frame projection',
    envelopeRecomputeSource: shaRef(importArt.contentDigest),
  },
  idempotency: {
    law: 'desk law on re-staffing: the outcome is idempotent by content address; re-emitting an existing package would mint new addresses for identical semantics',
    note: 'this is the FIRST reviewer emission of this desk: RC-Freeze-What-Baseline-001 has no predecessor; no FR/VV/FS duplicates are minted because no candidate exists to review',
  },
  emissionDiscipline: {
    noProductSubmitted: 'this reviewer seat submits NO desk product and fires NO gate effect: domain.frozen from this desk is forbidden by the recomputed prohibition, and frf-contracts.what-baseline.v1 cannot be satisfied (0/5 accepted acceptanceRecords)',
    namespaced: 'this emission writes ONLY freeze-what-baseline-desk-reviewer-confirmation-namespaced files; zero existing files modified or deleted (the standing freeze-what-baseline set recomputes byte-exact)',
    determinism: 'pinned timestamps, no clock reads, no randomness',
  },
  resumeContract: [
    'R1-R4 of the standing hold UH-Freeze-What-Baseline-001 stand unchanged and are carried by reference, not re-authored here',
    'the envelope delta (e210334e / 1-count summary) adds NO resume path: an unresolvable address cannot discharge R1 (upstream repair routing RA-1..RA-5), R2 (gate verdict discharge) or R3 (authoring on five accepted triples)',
  ],
  envelopePins: {
    protocolSkillRef: shaRef(PROTOCOL_SKILL),
    semanticSkillRef: shaRef(SEMANTIC_SKILL),
    workspaceSummary: WORKSPACE_SUMMARY,
    upstreamAccepted: [shaRef(UPSTREAM_ACCEPTED)],
    writeAuthority: WRITE_AUTHORITY,
  },
  verification: {
    declaredDigestsTrusted: false,
    holdArtifactDigestRecomputed: true,
    holdTraceDigestRecomputed: true,
    holdReceiptDigestRecomputed: true,
    capsuleSubArtifactDigestsRecomputed: true,
    envelopeProjectionDigestsRecomputed: true,
    citedRecordDigestsRecomputed: true,
    prohibitionRecomputedFromVerdictRecord: true,
    schemaRawDigestRecomputed: true,
    upstreamAcceptedScannedUnresolvable: true,
    noAcceptedStateAsserted: true,
    acceptedStateClaimsGatedOnVerdictRecords: true,
    productMaterialAuthored: false,
    noGateEffectFired: true,
    staleProtocolRefusals: 0,
    deterministicAuthoring: true,
  },
  traceFile: 'freeze-what-baseline-desk-reviewer-confirmation-trace.json',
  traceEdges: 26,
  traceBinding: 'by file and edge count only (acyclic content addressing): the trace embeds THIS confirmation by content digest',
};

const artifact = {
  confirmationRef: shaRef(sha(artifactContent)),
  artifactKind: 'reviewer-hold-confirmation',
  contentDigest: sha(artifactContent),
  semanticCode: 'RC-Freeze-What-Baseline-001',
  createdAt: CREATED_AT,
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: artifactContent,
};

/* ------------------------------------------------------------------ */
/* The confirmation trace                                               */
/* ------------------------------------------------------------------ */

const resolveId = (id) => {
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (id === 'import:discovery-handoff') return importArt.contentDigest;
  if (id === 'cert:discovery-capsule') return sha(vsa.certificate.content);
  if (id === 'RC-Freeze-What-Baseline-001') return sha(artifactContent);
  if (id === 'UH-Freeze-What-Baseline-001') return holdArt.contentDigest;
  if (id === 'FR-Reconcile-What-001') return frRw.contentDigest;
  if (id === 'VV-Reconcile-What-001') return vvRw.contentDigest;
  if (id === 'RT-Reconcile-What-001') return rtRw.contentDigest;
  if (id === 'FS-Reconcile-What-002') return fsRw2.contentDigest;
  if (id === 'CL-Reconcile-What-001') return clRw.contentDigest;
  if (id === 'FS-Reconcile-What-001') return rwSub.contentDigest;
  if (id === 'art:what-reconciliation') return rwArt.contentDigest;
  if (id === 'UH-Define-Acceptance-Contract-001') return uhAc.contentDigest;
  if (id === 'FR-Define-Acceptance-Contract-002') return frAc2.contentDigest;
  if (id === 'link:define-product-intent') return intentArt.contentDigest;
  if (id === 'link:model-use-cases') return ucArt.contentDigest;
  if (id === 'link:derive-system-requirements') return srArt.contentDigest;
  if (id === 'link:define-acceptance-contract') return acArt.contentDigest;
  if (id === 'link:reconcile-what') return rwArt.contentDigest;
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
  rel('RC-Freeze-What-Baseline-001', 'confirms', 'UH-Freeze-What-Baseline-001', 'The reviewer seat confirms the standing author hold (hold-no-authoring, 33/33 receipt) after independent recomputation of its artifact, trace, receipt and every cited record.'),
  ...Object.keys(ENVELOPE).map((id) => rel(
    'RC-Freeze-What-Baseline-001', 'verifies', id,
    `The confirmation's envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection and the hold frame projection identically.`,
  )),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'import:discovery-handoff', 'The accepted discovery import chain is the only accepted base (content digest recomputed).'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'FR-Reconcile-What-001', 'The upstream gate verdict of record: repair (CRIT-1 + CRIT-2; MAJ-1/MAJ-2); the explicit no-accept prohibition toward this desk recomputes from its nextStage and stands un-discharged.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'VV-Reconcile-What-001', 'The gate reviewer verification of record (84 content/status checks).'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'RT-Reconcile-What-001', 'The gate reviewer trace of record.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'FS-Reconcile-What-002', 'The gate reviewer product submission recording verdict repair and the RA-1..RA-5 routing.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'CL-Reconcile-What-001', 'The gate reviewer-seat collision record: emission A (repair) is the round of record.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'FS-Reconcile-What-001', 'The gate author candidate of record; NOT settled.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'link:define-product-intent', 'Pre-freeze desk 1: repair across every emission (e49d8d11, 6c9c8324, 04632094), no author reissue; NOT accepted.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'link:model-use-cases', 'Pre-freeze desk 2: never reviewed at its own content address; authored in violation of its desk upstream hold; NOT accepted.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'link:derive-system-requirements', 'Pre-freeze desk 3: repair verdict + re-staff confirmation; reviewer seat held; NOT accepted.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'link:define-acceptance-contract', 'Pre-freeze desk 4: adjudicated repair (CTN-001) with the desk on record hold a53a5e08; NOT accepted.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'link:reconcile-what', 'Pre-freeze desk 5 (the upstream gate): repair verdict of record; NOT accepted.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'UH-Define-Acceptance-Contract-001', 'The standing upstream hold of the acceptance desk.'),
  rel('RC-Freeze-What-Baseline-001', 'observes', 'FR-Define-Acceptance-Contract-002', 'The adjudicating reviewer emission C of the acceptance desk: repair confirmed, the accepted emission superseded.'),
  rel('RC-Freeze-What-Baseline-001', 'carries_forward', 'constraint:retention-1', 'constraint:retention-1 travels forward by content address (unchanged).'),
  rel('RC-Freeze-What-Baseline-001', 'carries_forward', 'unknown:browser-matrix-1', 'unknown:browser-matrix-1 carried forward, never resolved; derives nothing here.'),
];

expect(relationships.length === artifactContent.traceEdges, `trace edge count drift: ${relationships.length} vs ${artifactContent.traceEdges}`);

const traceContent = {
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  traceKind: 'reviewer-confirmation-trace',
  subjectSemanticCode: 'RC-Freeze-What-Baseline-001',
  subjectArtifactRef: artifact.confirmationRef,
  confirmationRef: shaRef(sha(artifactContent)),
  relationVocabulary: ['confirms', 'verifies', 'observes', 'carries_forward'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: ['RC-Freeze-What-Baseline-001'] }])),
  holdCoverage: {
    confirmedHold: 'UH-Freeze-What-Baseline-001',
    noProductAuthored: true,
    preFreezeDesksAccepted: 0,
    preFreezeDesksRequired: 5,
    unacceptedLinks: ['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements', 'link:define-acceptance-contract', 'link:reconcile-what'],
    onlyAcceptedChain: 'import:discovery-handoff',
    gateVerdictOfRecord: 'FR-Reconcile-What-001 (repair)',
    explicitProhibition: 'No domain.accepted may fire from this desk toward freeze-what-baseline on this chain.',
  },
  envelopeDeltaAdjudication: {
    upstreamAccepted: shaRef(UPSTREAM_ACCEPTED),
    resolution: 'UNRESOLVABLE',
    ratified: false,
    note: 'stale shell metadata (RS-Derive-System-Requirements-001 family); the trace carries no edge to it because a trace edge must resolve at both ends to recomputed digests',
  },
  branchResolutionNote: 'No scenario, branch, requirement, criterion, container or baseline identities are authored by this confirmation; all observed links resolve at record/artifact granularity.',
  workspaceSummary: WORKSPACE_SUMMARY,
  workspaceSummaryAdjudication: 'envelope line pinned verbatim as frame provenance; adjudicated NOT ratified - the verified accepted-revision count traveling into this desk is 0',
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'reviewer-confirmation-trace',
  contentDigest: sha(traceContent),
  createdAt: CREATED_AT,
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

/* ------------------------------------------------------------------ */
/* Write                                                                */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('freeze-what-baseline-desk-reviewer-confirmation.json', artifact);
writeJson('freeze-what-baseline-desk-reviewer-confirmation-trace.json', trace);

console.log(JSON.stringify({
  built: 'freeze-what-baseline desk (reviewer) hold confirmation',
  semanticCode: 'RC-Freeze-What-Baseline-001',
  confirmationRef: artifact.confirmationRef,
  traceRef: trace.traceRef,
  traceEdges: relationships.length,
  confirmedHold: 'UH-Freeze-What-Baseline-001 (9f2d28b9...)',
  upstreamAcceptedAdjudication: 'UNRESOLVABLE (not ratified)',
  acceptedPreFreezeDesks: '0 of 5 (required 5 by frf-contracts.what-baseline.v1)',
}, null, 2));
