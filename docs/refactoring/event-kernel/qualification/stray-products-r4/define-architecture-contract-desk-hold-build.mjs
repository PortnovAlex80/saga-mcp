/**
 * define-architecture-contract desk (author) - UPSTREAM HOLD builder.
 *
 * Emission: UH-Define-Architecture-Contract-001 (stray-products-r4, author
 * seat). The desk's SOLE lawful upstream input is the frozen whole-WHAT
 * baseline (`frf-contracts.what-baseline.v1`) delivered by the
 * freeze-what-baseline desk on domain.frozen. That desk REFUSED: r3 hold
 * UH-Freeze-What-Baseline-001 (9f2d28b9...), r3 reviewer stage
 * RC-Freeze-What-Baseline-001 (c19344fd..., hold-upheld), r3 author
 * re-staff AS-Freeze-What-Baseline-001 (c2a08f04..., standing hold), and
 * the r4 reviewer adjudication FR-Freeze-What-Baseline-Reviewer-002
 * (d52746b6..., hold-upheld: the frame's "upstream-accepted e210334e..."
 * claim resolves to the contract-suite green fixture and is REFUSED as
 * acceptance authority). Census of record: 0 of 5 pre-freeze desks
 * accepted; the reconcile-what no-accept prohibition is undischarged.
 *
 * The installed gate is fail-closed before any validation:
 * src/workflow-kernel/workshops/formalization/cells/dispatch.mjs,
 * case 'define-architecture-contract' ->
 *   required(chain, 'baseline', 'the SRS realizes the frozen whole-WHAT
 *   baseline and the accepted UC set')  =>  MISSING_LINEAGE.
 * The accepted id-set universe (frozen ucScenarioIds, evidenceBindingIds,
 * whatBaselineDigest) plus the accepted srsRevisionDigest pin DO NOT EXIST
 * on this chain. Authoring the architecture contract anyway would require
 * fabricating the frozen universe - the exact content-states-that-do-not-
 * exist family this corpus has adjudicated CRIT since r1. Per the r2/r3
 * upstream-hold precedent (UH-Model-Use-Cases-001 6cccd162...,
 * UH-Define-Acceptance-Contract-001 a53a5e08...) this desk authors NO SRS
 * material and issues a hold record instead.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. All addresses are sha256 over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule
 * (src/workflow-kernel/domain/digest.ts). Every cited record digest is
 * recomputed from the corpus files in this script; nothing is trusted by
 * declaration.
 *
 * Run: node define-architecture-contract-desk-hold-build.mjs
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
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(DIR, '..', '..', '..', '..', '..');
const CREATED_AT = '2026-08-28T00:00:00Z';
const WS = '0 accepted upstream revisions travel by content address';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const SEMANTIC_PIN = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';
const R1_UPDATED_CLAIM = '8b2ec93c63b7b2de04fffb6deb1c8d700129f956b682c8f960ab3f4576a1d3c2';

/* The task-projection envelope (content addresses of this desk task). */
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

/* ------------------------------------------------------------------ */
/* Verified, accepted discovery import chain (the only accepted base)   */
/* ------------------------------------------------------------------ */

const expect = (cond, message) => { if (!cond) throw new Error(`hold basis failed: ${message}`); };

const importArt = JSON.parse(readFileSync(join(DIR, '..', 'stray-products-r2', 'import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));
expect(sha(importArt.content) === importArt.contentDigest, 'import artifact content digest drift');
expect(importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', 'import artifact address drift');
const IMPORT_REF = shaRef(importArt.contentDigest);

const envelopeRecompute = [];
const vsa = importArt.content.verifiedSubArtifacts;
const groups = [
  ['sourceClaims', vsa.sourceClaims],
  ['constraints', vsa.constraints],
  ['unknowns', vsa.unknowns],
  ['terminalLifecycleClaims', vsa.terminalLifecycleClaims],
  ['certificate', [vsa.certificate]],
];
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
/* Recompute every cited upstream record from the corpus                */
/* ------------------------------------------------------------------ */

const record = (relPath) => {
  const j = JSON.parse(readFileSync(join(REPO, relPath), 'utf8'));
  return {
    contentDigest: sha(j.content),
    verdict: j.content.verdict ?? j.content.decision ?? j.content.reviewDecision?.verdict ?? j.content.holdKind ?? null,
    reviewedCandidate: j.content.reviewedCandidate ?? j.content.reviewDecision?.subjectArtifactRef ?? null,
  };
};

const Q3 = (f) => `docs/refactoring/event-kernel/qualification/stray-products-r3/${f}`;
const Q2 = (f) => `docs/refactoring/event-kernel/qualification/stray-products-r2/${f}`;
const Q4 = (f) => `docs/refactoring/event-kernel/qualification/stray-products-r4/${f}`;
const Q1 = (f) => `docs/refactoring/event-kernel/qualification/stray-products-r1/${f}`;
const TB = (f) => `.factory-testbed/${f}`;

/* Link 1: define-product-intent - repair across every emission, no author reissue. */
const intentArt = record(Q3('define-product-intent-desk-product-intent.artifact.json'));
const frIntent1 = record(Q2('define-product-intent-desk-reviewer-review.json'));
const frIntent1b = record(Q2('define-product-intent-desk-reviewer-review-emission-b.json'));
const frIntent2 = record(Q2('define-product-intent-desk-reviewer2-review.json'));
expect(intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055', 'intent artifact address drift');
expect(frIntent1.verdict === 'repair' && frIntent1.contentDigest === 'e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4', 'FR-Define-Product-Intent-001 drift');
expect(frIntent1b.verdict === 'repair' && frIntent1b.contentDigest === '6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc', 'FR-Define-Product-Intent-001 emission-b drift');
expect(frIntent2.verdict === 'repair' && frIntent2.contentDigest === '0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc', 'FR-Define-Product-Intent-002 drift');

/* Link 2: model-use-cases - never reviewed at the consumed content address. */
const ucArt = record(Q3('model-use-cases-desk-uc-scenarios.artifact.json'));
const ucHoldR2 = record(Q2('model-use-cases-desk-upstream-hold.artifact.json'));
const frUc001 = record(TB('model-use-cases-reviewer-review.json'));
expect(ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b', 'UC artifact address drift');
expect(ucHoldR2.contentDigest === '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7', 'r2 UC upstream-hold address drift');
expect(frUc001.reviewId === undefined || frUc001.verdict !== null, 'UC factory-testbed review shape drift');
expect(JSON.stringify(frUc001).includes('c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8'), 'FR-Model-Use-Cases-001 candidate pin drift');
expect(!JSON.stringify(frUc001).includes(ucArt.contentDigest), 'FR-Model-Use-Cases-001 unexpectedly pins the corpus UC bundle');

/* Link 3: derive-system-requirements - repair + restaff confirmation, reviewer seat held. */
const srArt = record(Q3('derive-system-requirements-desk-system-requirements.artifact.json'));
const frSr1 = record(Q2('derive-system-requirements-desk-reviewer-review.json'));
const rsSr1 = record(Q2('derive-system-requirements-desk-reviewer-restaff2-confirmation.json'));
const uhSr1 = record(TB('derive-system-requirements-reviewer-hold.artifact.json'));
const uhSr2 = record(TB('derive-system-requirements-reviewer-hold2.artifact.json'));
expect(srArt.contentDigest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df', 'requirements artifact address drift');
expect(frSr1.verdict === 'repair' && frSr1.contentDigest === 'd31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0', 'FR-Derive-System-Requirements-001 drift');
expect(rsSr1.contentDigest === '1c30d28e8222eaa225195bf33d87f378054b98a01bdf50710fd4900f5339a0a6', 'RS-Derive-System-Requirements-001 drift');
expect(uhSr1.contentDigest === 'fbc0394bd8f79df2fc7e8956accd9fe25485bceab182044927de9f209f11d053', 'UH-Derive-System-Requirements-001 drift');
expect(uhSr2.contentDigest === 'b4eaaabaa5010c6e03594943e2437b030d352ec9f3027fb275d57f351692c995', 'UH-Derive-System-Requirements-002 drift');

/* Link 4: define-acceptance-contract - candidate of record under verdict contention. */
const candArt = record(Q3('define-acceptance-contract-desk-acceptance-bindings.artifact.json'));
const candTrc = record(Q3('define-acceptance-contract-desk-acceptance-bindings-trace.json'));
const candSub = record(Q3('define-acceptance-contract-desk-product-submission.json'));
const frDa001 = record(Q3('define-acceptance-contract-desk-reviewer-review-emission-a.json'));
const vvDa001 = record(Q3('define-acceptance-contract-desk-reviewer-verification-emission-a.json'));
const frDa002 = record(Q3('define-acceptance-contract-desk-reviewer-review-emission-c.json'));
const vvDa002 = record(Q3('define-acceptance-contract-desk-reviewer-verification-emission-c.json'));
const frDaCan = record(Q3('define-acceptance-contract-desk-reviewer-review.json'));
expect(candArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0', 'acceptance candidate artifact drift');
expect(candTrc.contentDigest === '2835aea3f7bbf362afabf729ca37a18827bd9579c76f30daad12d8a2272a84e1', 'acceptance candidate trace drift');
expect(candSub.contentDigest === '6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe', 'acceptance candidate submission drift');
expect(frDa001.verdict === 'repair' && frDa001.contentDigest === '83e675bb18c575cb0b30e3ededd2cca6b58b88c08cb50be9c08dfb130808c383', 'FR-Define-Acceptance-Contract-001 emission-a drift');
expect(vvDa001.contentDigest === '367a38fcf8d0bd061fa2e023aba4aaab0060a82a71278ca358d6b3415b5602bb', 'VV-Define-Acceptance-Contract-001 emission-a drift');
expect(frDa002.verdict === 'repair' && frDa002.contentDigest === '7e76176c431770477f2930747498f2df8b0a6ce6071c29ff065ad7d85edcac0e', 'FR-Define-Acceptance-Contract-002 emission-c drift');
expect(vvDa002.contentDigest === '61b9ce2e70b979f7e224bcbe17d492a3ffb85410a4b8a8ba139257cfbabd85a5', 'VV-Define-Acceptance-Contract-002 emission-c drift');
expect(frDaCan.verdict === 'accepted' && frDaCan.contentDigest === 'e5249d786aa3318a7426dde2ba36e111437d4e0ab0e7e6f9e7cda3b9463ce466', 'canonical accepted emission drift');

/* Link 5: reconcile-what - repair verdicts of record + the no-accept prohibition. */
const recSub = record(Q3('reconcile-what-desk-product-submission.json'));
const recArt = record(Q3('reconcile-what-desk-what-reconciliation.artifact.json'));
const recTrc = record(Q3('reconcile-what-desk-what-reconciliation-trace.json'));
const frRw1 = record(Q3('reconcile-what-desk-reviewer-review.json'));
const vvRw1 = record(Q3('reconcile-what-desk-reviewer-verification.json'));
const trRw1 = record(Q3('reconcile-what-desk-reviewer-trace.json'));
const subRw1 = record(Q3('reconcile-what-desk-reviewer-product-submission.json'));
const clRw1 = record(Q3('reconcile-what-desk-reviewer-collision-record.json'));
const frRw2 = record(Q3('reconcile-what-desk-reviewer-review-emission-b.json'));
expect(recSub.contentDigest === '0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba', 'reconcile author submission drift');
expect(recArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191', 'reconcile author artifact drift');
expect(recTrc.contentDigest === '09e800469f38c2d926dc1ef24974ca3b2f01ce72913ffcc5832dde071d6581e0', 'reconcile author trace drift');
expect(frRw1.verdict === 'repair' && frRw1.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6', 'FR-Reconcile-What-001 drift');
expect(vvRw1.contentDigest === 'cd7504a69eff07d39f9945f8cf3da3f7cf8c4d8e91932c897dab5f5fbab35cac', 'VV-Reconcile-What-001 drift');
expect(trRw1.contentDigest === 'fe108e09db2dedb37dbb151d46e56090128c7bc44da339e44be62a47e7755373', 'reconcile reviewer trace drift');
expect(subRw1.contentDigest === '9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce', 'reconcile reviewer submission drift');
expect(clRw1.contentDigest === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d', 'CL-Reconcile-What-001 drift');
expect(frRw2.verdict === 'repair' && frRw2.contentDigest === '702fc96755b828eb427a2287ea661d1f685336c2646d08a7328030ab6923e1ba', 'FR-Reconcile-What-002 emission-b drift');

/* Freeze-what-baseline: the desk's lawful upstream input was REFUSED, four times. */
const uhFrz = record(Q3('freeze-what-baseline-desk-upstream-hold.artifact.json'));
const uhFrzTrc = record(Q3('freeze-what-baseline-desk-upstream-hold-trace.json'));
const rcFrz = record(Q3('freeze-what-baseline-desk-reviewer-confirmation.json'));
const asFrz = record(Q3('freeze-what-baseline-desk-restaff-confirmation.json'));
const frFrz2 = record(Q4('freeze-what-baseline-desk-reviewer-review.json'));
const vvFrz2 = record(Q4('freeze-what-baseline-desk-reviewer-verification.json'));
const trFrz2 = record(Q4('freeze-what-baseline-desk-reviewer-trace.json'));
const subFrz2 = record(Q4('freeze-what-baseline-desk-reviewer-product-submission.json'));
expect(uhFrz.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f', 'UH-Freeze-What-Baseline-001 drift');
expect(uhFrzTrc.contentDigest === '17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202', 'UH-Freeze-What-Baseline-001 trace drift');
expect(rcFrz.contentDigest === 'c19344fd964655f226b777747b23b94da07877f2fc28614ea4a65c98c803ed44', 'RC-Freeze-What-Baseline-001 drift');
expect(asFrz.contentDigest === 'c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06', 'AS-Freeze-What-Baseline-001 drift');
expect(frFrz2.verdict === 'hold-upheld' && frFrz2.contentDigest === 'd52746b6620e8e4583592f1d23beff3053430d15ae8159643dcc7461b49d9190', 'FR-Freeze-What-Baseline-Reviewer-002 drift');
expect(vvFrz2.contentDigest === '8b04101005452d7906bcc1ca66f8f91d5ef6957518ae5af84f8a47f7e5781c21', 'VV-Freeze-What-Baseline-002 drift');
expect(trFrz2.contentDigest === '8bf4f283ec152b8e9f9a4d3706227776b1723805c675ea2580ffa59e2259e252', 'freeze reviewer r4 trace drift');
expect(subFrz2.contentDigest === '6f5294a924e2fa9d94067b2c60d46f2bf0e199098fefd22f5df9325ea26b9eac', 'freeze reviewer r4 submission drift');

/* The r4 impostor address resolves to the contract-suite green fixture (refused). */
const fixtureRaw = readFileSync(join(REPO, 'docs/refactoring/formalization-frf/contracts/fixtures/green/what-baseline.json'), 'utf8');
const fixtureWholeCanon = sha(JSON.parse(fixtureRaw));
expect(fixtureWholeCanon === 'e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de', 'green fixture whole-canon drift');

/* ------------------------------------------------------------------ */
/* This desk's own r1 stray authoring history (recomputed, superseded)  */
/* ------------------------------------------------------------------ */

const r1FileCanon = (f) => sha(JSON.parse(readFileSync(join(REPO, Q1(f)), 'utf8')));
const r1ArtifactContentCanon = (f) => {
  const j = JSON.parse(readFileSync(join(REPO, Q1(f)), 'utf8'));
  return sha(j.content);
};
const r1Formalization = r1FileCanon('define-architecture-contract-formalization.json');
const r1FormalizationUpdated = r1FileCanon('define-architecture-contract-formalization-updated.json');
const r1Trace = r1FileCanon('define-architecture-contract-trace.json');
const r1TraceUpdated = r1FileCanon('define-architecture-contract-trace-updated.json');
const r1Artifact = r1ArtifactContentCanon('define-architecture-contract-desk-architecture-contract.artifact.json');
const r1ArtifactUpdated = r1ArtifactContentCanon('define-architecture-contract-desk-architecture-contract-updated.artifact.json');
expect(r1Formalization === 'e2ae5d31da26a34230a7bc5e8cd6ed70b373f07a7b92e994083aff7956cc9330', 'r1 formalization whole-canon drift');
expect(r1FormalizationUpdated === '1f06d6636e0ee669efebbf6a2577762d14f350ead77316912f3e20a43a22f4e1', 'r1 formalization-updated whole-canon drift');
expect(r1Trace === '7c5433e4541f68f86f4552b4c13a1f743a971879f9eeb5f15b553550fa2431c0', 'r1 trace whole-canon drift');
expect(r1TraceUpdated === '129110ef95cc85da1c988eb558498cd1bce6f71a09d463f2d753d331ef4e2278', 'r1 trace-updated whole-canon drift');
expect(r1Artifact === 'f4846e5fed6808f8b0c33b14d58a337d9f72eddd02bf775bc048862b1d5626af', 'r1 artifact content-canon drift');
expect(r1ArtifactUpdated === '434c41b243ff0b9c350c58e1581eb0657b030a139fc4d7cc7002f44fa467c594', 'r1 artifact-updated content-canon drift');

const r1Review = JSON.parse(readFileSync(join(REPO, Q1('define-architecture-contract-review-verdict.json')), 'utf8'));
const r1Review2 = JSON.parse(readFileSync(join(REPO, Q1('define-architecture-contract-reviewer-decision-v2.json')), 'utf8'));
expect(r1Review.verdict === 'approved' && Array.isArray(r1Review.findings) && r1Review.findings.length === 0, 'r1 review-verdict drift');
expect(r1Review2.reviewDecision.verdict === 'approved' && r1Review2.reviewDecision.findings.length === 0, 'r1 reviewer-decision-v2 drift');
expect(r1Review2.reviewDecision.subjectArtifactRef === shaRef(R1_UPDATED_CLAIM), 'r1 updated subject pin drift');

/* The r1 projection (the claims the stray authoring consumed) is disjoint
 * from the accepted capsule's 8 envelope addresses. */
const R1_PROJECTION = [
  'fbe292e862ab174b29de15cbbf85b34e4211b3a0e508fd39245015c9ea12b180',
  'c9bfe922c5891e8bfeaaf07864a75d3beaa5239dd455d6bb889f1eef4b3dd0fc',
  '423be112883976126a9b2718226aa68628fbe5d60253e0c0c849d66925062035',
  'd7ce453b9dbb1aa1cecda1d591779b92dc347220c9f4f19c6db86629f5a18c2b',
  'f7acf9d19953686e3042a10755a867a8f80a7fdb3963bd8e78e725962c792276',
  'c292f69407b0d7752008069ac095dc556522ed5df9f386b9e2ec5bf31909e8f0',
  'f3d0a6a4aea6909d35d8e5368425b21b38799b7f44444d926176083b532c011b',
];
const envelopeDigests = Object.values(ENVELOPE);
expect(R1_PROJECTION.every((d) => !envelopeDigests.includes(d)), 'r1 projection unexpectedly overlaps the accepted capsule');
const r1FormalRaw = readFileSync(join(REPO, Q1('define-architecture-contract-formalization.json')), 'utf8');
expect(r1FormalRaw.includes(GOVERNING), 'r1 formalization does not declare the governing anchor');
expect(r1FormalRaw.includes(SEMANTIC_PIN), 'r1 formalization does not declare the stale r1 modules digest');
/* The claimed r1 digests do NOT recompute from their declaring files. */
expect(r1Formalization !== GOVERNING && r1Trace !== GOVERNING, 'a926df62 unexpectedly recomputes from an r1 file');
expect(r1FormalizationUpdated !== R1_UPDATED_CLAIM, '8b2ec93c unexpectedly recomputes from an r1 file');

/* The installed desk's own declared semantic-skill content digest
 * (provenance only; differs from the frame's semantic pin). */
const deskSemanticDigest = sha({ skillId: 'formalization-desk-define-architecture-contract', kind: 'semantic', desk: 'define-architecture-contract' });
expect(deskSemanticDigest === '131efbd99bd2d92e0ac790ab9c271218d0a72995df0053fc35cbffc4d7f176f3', 'desk semantic-skill digest drift');

/* Gate-law source grounding: the fail-closed baseline requirement. */
const dispatchSrc = readFileSync(join(REPO, 'src/workflow-kernel/workshops/formalization/cells/dispatch.mjs'), 'utf8');
expect(dispatchSrc.includes("case 'define-architecture-contract':"), 'dispatch case missing');
expect(dispatchSrc.includes("required(chain, 'baseline', 'the SRS realizes the frozen whole-WHAT baseline and the accepted UC set')"), 'baseline requirement law missing from dispatch');
expect(dispatchSrc.includes("reason: 'MISSING_LINEAGE'"), 'MISSING_LINEAGE refusal missing from dispatch required()');
expect(dispatchSrc.includes('authorArchitectureContract(draft, universe)'), 'desk assembly binding missing');
const deskSrc = readFileSync(join(REPO, 'src/workflow-kernel/workshops/formalization/cells/srs-realization/desk.ts'), 'utf8');
expect(deskSrc.includes("outputProductKind !== 'formalization.srs.v1'"), 'desk output product kind law missing');
expect(deskSrc.includes("'formalization.srs-structure.v1'") && deskSrc.includes("'validateSrs'"), 'desk provider law missing');
const manifestSrc = readFileSync(join(REPO, 'src/workflow-kernel/workshops/formalization/manifest.ts'), 'utf8');
expect(manifestSrc.includes("{ from: 'freeze-what-baseline', to: 'define-architecture-contract', on: 'domain.frozen' }"), 'domain.frozen transition missing from the installed manifest');

/* ------------------------------------------------------------------ */
/* The hold artifact                                                    */
/* ------------------------------------------------------------------ */

const UNRESOLVABLE = [
  {
    id: 'protocol-skill pin (the r1 CRIT-003 governing anchor)',
    address: shaRef(GOVERNING),
    role: 'declared in THIS desk task frame as the protocol-skill layer; the same address six r1 files declare as their Content Digest and every r2 desk pinned as governingContractRef',
    evidence: 'workspace-wide three-layer scan (raw bytes, whole-JSON canonical, .content canonical; this emission excluded) hash-resolves it to zero contents; the declaring r1 files recompute to different digests (r1 formalization e2ae5d31..., r1 trace 7c5433e4...)',
  },
  {
    id: 'semantic-skill pin (the stale r1 self-claimed digest)',
    address: shaRef(SEMANTIC_PIN),
    role: 'declared in THIS desk task frame as the semantic-skill layer; the r1 define-acceptance-contract acceptance-contract artifact self-claims it as contentDigest/contractDigest and r1 records cite it as traceRef',
    evidence: 'workspace-wide three-layer scan hash-resolves it to zero contents; the r1 artifact that claims it recomputes to f53af964... (.content canonical); r3 verifiers label it STALE_R1_PROTOCOL_SKILL',
  },
  {
    id: 'r1 updated-formalization claimed digest',
    address: shaRef(R1_UPDATED_CLAIM),
    role: 'subjectArtifactRef of the r1 reviewer-decision-v2 (approved) for this very desk',
    evidence: 'workspace-wide three-layer scan hash-resolves it to zero contents; the r1 formalization-updated file recomputes to 1f06d663... (whole-JSON canonical)',
  },
];

const artifactContent = {
  schemaVersion: 'formalization.upstream-hold.v1',
  deskRef: 'define-architecture-contract',
  deskNodeId: 'define-architecture-contract',
  role: 'author',
  itemInstanceId: 'formalization-item:define-architecture-contract',
  token: 'plan:formalization#item:architecture-contract',
  holdKind: 'srs-upstream-hold',
  decision: 'hold-no-authoring',
  statement: 'The define-architecture-contract desk authors NO architecture-contract / SRS material in this staffing. The desk\'s sole lawful upstream input is the frozen whole-WHAT baseline (frf-contracts.what-baseline.v1) delivered by the freeze-what-baseline desk on domain.frozen, and that baseline does not exist: the freeze desk refused across every staffing (r3 hold UH-Freeze-What-Baseline-001 9f2d28b9... hold-no-authoring; r3 reviewer stage RC-Freeze-What-Baseline-001 c19344fd... hold-upheld; r3 author re-staff AS-Freeze-What-Baseline-001 c2a08f04... standing hold; r4 reviewer adjudication FR-Freeze-What-Baseline-Reviewer-002 d52746b6... hold-upheld, which hash-resolved the frame\'s "upstream-accepted e210334e..." claim to the contract-suite green fixture and REFUSED it as acceptance authority). The chain census of record is 0 of 5 pre-freeze desks accepted (intent repair e49d8d11/6c9c8324/04632094 with no author reissue; UC 24f0aff2 never reviewed at its own address and authored against its own desk hold 6cccd162; requirements repair d31b044c with the reviewer seat held fbc0394b/b4eaaaba; acceptance candidate 2b01353d under the open verdict contention CL-Define-Acceptance-Contract-001 - repair emissions 83e675bb and 7e76176c vs a canonical accepted e5249d78 with no verification counterpart; reconcile-what repair 39a94a29 with the explicit no-accept prohibition, restated repair 702fc967, undischarged). The installed gate is fail-closed before any product validation: dispatch case define-architecture-contract requires chain.baseline - "the SRS realizes the frozen whole-WHAT baseline and the accepted UC set" - and refuses MISSING_LINEAGE; the accepted id-set universe (frozen ucScenarioIds, frozen evidenceBindingIds, whatBaselineDigest) plus the accepted srsRevisionDigest pin DO NOT EXIST on this chain. Authoring the SRS anyway would mean fabricating the frozen universe - realizing scenarios that were never frozen, citing evidence bindings that were never accepted, pinning a baseline that was never sealed - the exact content-states-that-do-not-exist family this corpus has adjudicated CRIT since r1. Additionally, THIS desk\'s own r1 authoring (AC-Define-Architecture-Contract-001 and its updated variant) is recorded as superseded stray history: authored against zero accepted upstream revisions (its own summary says so), approved with zero findings by verdicts that carried no verification, over a claim projection disjoint from the accepted capsule, at claimed digests (a926df62..., 8b2ec93c...) that recompute from no file in the workspace. The frame re-declares a926df62... as its protocol-skill layer and 95fafc84... as its semantic-skill layer; both are recorded verbatim as unresolvable envelope provenance and are NOT ratified. The desk waits for a genuinely frozen whole-WHAT baseline at its own content address.',
  protocolLineage: {
    protocolVersion: 'ek.discovery-handoff-capsule.ek8-wp11f.v1',
    protocolVersionCheck: 'CURRENT',
    pinnedVia: 'transitive: the accepted import artifact of the import-discovery-handoff desk declares this protocol version',
    viaImportArtifactRef: IMPORT_REF,
  },
  taskProjection: {
    verifiedSubArtifacts: Object.entries(ENVELOPE).map(([id, digest]) => ({ id, digest, ref: shaRef(digest) })),
    recompute: 'all 8 envelope entries recomputed from the accepted import-discovery-handoff capsule sub-artifact contents (9/9 including CERT-1) and matched exactly',
    envelopeRecompute,
    terminalClaimsDisposition: 'terminal:audited-1 and terminal:delivered-1 are carried Discovery lifecycle claims, verified as capsule content addresses only; this hold asserts NEITHER is satisfied - with no frozen baseline and no accepted SRS the chain cannot reach audit or delivery',
  },
  gateLaw: {
    deskNodeId: 'define-architecture-contract',
    nodeKind: 'production-cell',
    outputProductKind: 'formalization.srs.v1',
    checkProvider: 'formalization.srs-structure.v1',
    validator: 'validateSrs',
    requiredChainInput: 'chain.baseline (the fold fires only on the freeze desk ACCEPTED gate; the domain.frozen transition freeze-what-baseline -> define-architecture-contract is declared in the installed manifest)',
    gateBehavior: 'required(chain, \'baseline\', \'the SRS realizes the frozen whole-WHAT baseline and the accepted UC set\') -> MISSING_LINEAGE refusal before any product validation (fail-closed, never a scan, never a guess)',
    requiredUniverseInputs: ['frozen ucScenarioIds (baseline containers.uc.members[].scenarioId)', 'frozen evidenceBindingIds (baseline evidenceBindings[].evidenceBindingId)', 'whatBaselineDigest (the frozen baseline artifact digest)', 'accepted srsRevisionDigest pin (candidate.deskInput)'],
    availabilityOnThisChain: 'none of the four inputs exists; the freeze desk produced no baseline artifact and refused four times',
    sourceGrounding: ['src/workflow-kernel/workshops/formalization/cells/dispatch.mjs (case define-architecture-contract)', 'src/workflow-kernel/workshops/formalization/cells/srs-realization/desk.ts (desk declaration, verified against the installed manifest)', 'src/workflow-kernel/workshops/formalization/manifest.ts (domain.frozen transition)'],
  },
  upstreamObservations: {
    onlyAcceptedChain: {
      importArtifactRef: IMPORT_REF,
      certificateRef: shaRef(certDigest),
      note: 'the accepted discovery handoff capsule import is the only genuinely accepted upstream material; this hold is grounded in it and in nothing else',
    },
    unacceptedLinks: [
      {
        link: 'define-product-intent',
        artifactRef: shaRef(intentArt.contentDigest),
        status: 'repair-verdict across every reviewer emission; contention open; no author reissue in r1/r2/r3/r4; NOT accepted',
        evidenceRefs: [shaRef(frIntent1.contentDigest), shaRef(frIntent1b.contentDigest), shaRef(frIntent2.contentDigest)],
      },
      {
        link: 'model-use-cases',
        artifactRef: shaRef(ucArt.contentDigest),
        status: 'never reviewed at this content address; authored in violation of its own desk upstream hold; the only UC accepted verdict pins a different candidate (c6120e86..., factory-testbed namespace); NOT accepted',
        evidenceRefs: [shaRef(ucHoldR2.contentDigest), shaRef(frUc001.contentDigest)],
      },
      {
        link: 'derive-system-requirements',
        artifactRef: shaRef(srArt.contentDigest),
        status: 'repair-verdict + restaff confirmation; reviewer seat held; NOT accepted',
        evidenceRefs: [shaRef(frSr1.contentDigest), shaRef(rsSr1.contentDigest), shaRef(uhSr1.contentDigest), shaRef(uhSr2.contentDigest)],
      },
      {
        link: 'define-acceptance-contract',
        artifactRef: shaRef(candArt.contentDigest),
        status: 'candidate of record under the open reviewer verdict contention CL-Define-Acceptance-Contract-001 (repair emissions 83e675bb... + 7e76176c... with verifications vs a canonical accepted e5249d78... with no verification counterpart); NOT settled; NOT counted accepted by the census of record',
        evidenceRefs: [shaRef(frDa001.contentDigest), shaRef(vvDa001.contentDigest), shaRef(frDa002.contentDigest), shaRef(vvDa002.contentDigest), shaRef(frDaCan.contentDigest)],
      },
      {
        link: 'reconcile-what',
        artifactRef: shaRef(recArt.contentDigest),
        status: 'report-only desk; reviewer verdict of record repair 39a94a29... with the explicit no-accept prohibition; emission-b re-check repair 702fc967...; prohibition undischarged (only a re-run reviewer verdict of record can discharge it); NOT accepted',
        evidenceRefs: [shaRef(frRw1.contentDigest), shaRef(clRw1.contentDigest), shaRef(frRw2.contentDigest), shaRef(recSub.contentDigest)],
      },
    ],
    freezeState: {
      link: 'freeze-what-baseline',
      deskHoldRef: shaRef(uhFrz.contentDigest),
      deskHoldTraceRef: shaRef(uhFrzTrc.contentDigest),
      reviewerStageRef: shaRef(rcFrz.contentDigest),
      authorRestaffRef: shaRef(asFrz.contentDigest),
      r4AdjudicationReviewRef: shaRef(frFrz2.contentDigest),
      r4AdjudicationVerificationRef: shaRef(vvFrz2.contentDigest),
      r4AdjudicationTraceRef: shaRef(trFrz2.contentDigest),
      r4AdjudicationSubmissionRef: shaRef(subFrz2.contentDigest),
      status: 'REFUSED four times; the r4 adjudication hash-resolved the frame impostor e210334e... to the contract-suite green fixture (whole-JSON canonical recomputed in this build) and refused it as acceptance authority; no whole-WHAT baseline exists; domain.frozen never fired; chain.baseline absent',
    },
  },
  baselineAbsence: 'no whole-WHAT baseline artifact exists on this chain at any content address; the SRS desk therefore has no accepted id-set universe to validate against and no lawful pin to cite; this hold fabricates nothing',
  strayAuthoringHistory: {
    deskR1Authoring: {
      semanticCodes: ['AC-Define-Architecture-Contract-001', 'AC-002 (updated variant)'],
      claimedDigests: [shaRef(GOVERNING), shaRef(R1_UPDATED_CLAIM)],
      recomputedDigests: {
        r1FormalizationWholeCanon: shaRef(r1Formalization),
        r1FormalizationUpdatedWholeCanon: shaRef(r1FormalizationUpdated),
        r1TraceWholeCanon: shaRef(r1Trace),
        r1TraceUpdatedWholeCanon: shaRef(r1TraceUpdated),
        r1ArtifactContentCanon: shaRef(r1Artifact),
        r1ArtifactUpdatedContentCanon: shaRef(r1ArtifactUpdated),
      },
      reviewVerdicts: 'approved with zero findings (define-architecture-contract-review-verdict.json; define-architecture-contract-reviewer-decision-v2.json subject 8b2ec93c...), no verification records, and the r1 review passed "0 accepted upstream revisions travel by content address" AS A PASS CRITERION for a product authored against zero accepted lineage',
      projectionDisjointFromAcceptedCapsule: true,
      r1ProjectionDigests: R1_PROJECTION.map(shaRef),
      disposition: 'superseded stray authoring; never folded into the accepted chain (this desk sits 0/5 in the census of record); NOT product lineage; its claimed digests are the unresolvable instances enumerated in this hold',
    },
  },
  framePins: {
    protocolSkill: {
      address: shaRef(GOVERNING),
      declaredRole: 'protocol-skill layer of this desk task frame',
      resolutionScan: 'workspace-wide three-layer scan (raw bytes, whole-JSON canonical, .content canonical; .git, node_modules and this emission excluded): 0 hash-resolved contents',
      history: 'the r1 CRIT-003 digest-drift governing anchor: six r1 files declare it and recompute otherwise; carried unresolvable through r2 (MAJ-1), r3 and r4 (A7)',
      disposition: 'recorded verbatim as envelope provenance; NOT ratified; this hold does not depend on it',
    },
    semanticSkill: {
      address: shaRef(SEMANTIC_PIN),
      declaredRole: 'semantic-skill layer of this desk task frame',
      resolutionScan: 'workspace-wide three-layer scan: 0 hash-resolved contents',
      history: 'the r1 define-acceptance-contract acceptance-contract artifact self-claims it (recomputes to f53af964...); cited as traceRef across r1 records; r3 verifiers label it STALE_R1_PROTOCOL_SKILL',
      disposition: 'recorded verbatim as envelope provenance; NOT ratified; this hold does not depend on it',
    },
    deskDeclaredSemanticDigest: {
      address: shaRef(deskSemanticDigest),
      note: 'recomputed from the installed desk declaration identity {skillId: formalization-desk-define-architecture-contract, kind: semantic, desk: define-architecture-contract}; differs from the frame semantic pin; recorded as desk provenance only',
    },
  },
  noProductAuthored: true,
  fence: {
    forbiddenProductKeys: ['schemaVersion:formalization.architecture-contract.v1', 'schemaVersion:formalization.srs-realization.v1', 'realizationEntries', 'surfaces', 'developmentObligations', 'postFreeze', 'realizationDigest', 'canonicalDigest', 'acceptanceCriteria', 'criteria', 'frMembers', 'requirements', 'useCases'],
    observed: 'this hold is a desk artifact, not an SRS: no realization entry, architecture surface, runtime edge, composition owner, evidence binding, development obligation or postFreeze block is authored; no scenario id is invented; no baseline digest is pinned; unknown:browser-matrix-1 derives nothing; terminal:audited-1 and terminal:delivered-1 are not asserted satisfied',
  },
  resumeContract: [
    'R1: genuinely accepted revisions land for the five pre-freeze desks (define-product-intent, model-use-cases, derive-system-requirements, define-acceptance-contract, reconcile-what) through completed reviewer stages at their own content addresses; the CL-Define-Acceptance-Contract-001 contention is adjudicated by driver/human first (per the r4 freeze reviewer resume R1-R2)',
    'R2: the re-run reconcile-what reviewer verdict of record alone discharges the no-accept prohibition - never this desk, never a frame assertion',
    'R3: freeze-what-baseline re-staffs and authors the whole-WHAT baseline strictly against the accepted triples and frf-contracts.what-baseline.v1; only then does domain.frozen fire and chain.baseline exist',
    'R4: on the frozen baseline at its own content address, this desk is re-staffed and authors the architecture contract strictly against the frozen universe (baseline containers.uc.members scenario ids, baseline evidenceBindings ids, the frozen whatBaselineDigest) plus an accepted srsRevisionDigest pin, through the installed formalization.srs-structure.v1 / validateSrs surface',
    'R5: this hold is not carried as product lineage; the SRS cites only the frozen baseline and accepted revisions; the r1 stray authoring stays superseded history',
  ],
  governingContractRef: shaRef(GOVERNING),
  governingContractNote: 'declared in this desk task protocol-skill layer; recorded verbatim as envelope provenance. Unresolvable workspace-wide (see framePins and unresolvableInstances). NOT ratified by this desk; this hold does not depend on it.',
  verification: {
    declaredDigestsTrusted: false,
    importArtifactDigestRecomputed: true,
    capsuleSubArtifactDigestsRecomputed: true,
    envelopeProjectionDigestsRecomputed: true,
    citedRecordDigestsRecomputed: true,
    gateLawSourceGrounded: true,
    freezeRefusalChainRecomputed: true,
    impostorFixtureResolutionRecomputed: true,
    r1StrayHistoryRecomputed: true,
    r1ProjectionDisjointFromAcceptedCapsule: true,
    unresolvableInstancesEnumerated: UNRESOLVABLE.map((u) => u.address),
    noAcceptedStateAsserted: true,
    acceptedStateClaimsGatedOnVerdictRecords: true,
    productMaterialAuthored: false,
    staleProtocolRefusals: 0,
    deterministicAuthoring: true,
  },
  workspaceSummary: WS,
  unresolvableInstances: UNRESOLVABLE.map((u) => ({ ...u, resolved: false })),
};

const artifact = {
  artifactRef: shaRef(sha(artifactContent)),
  artifactKind: 'upstream-hold',
  productKind: 'formalization.upstream-hold.v1',
  contentDigest: sha(artifactContent),
  semanticCode: 'UH-Define-Architecture-Contract-001',
  createdAt: CREATED_AT,
  deskRef: 'define-architecture-contract',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: artifactContent,
};

/* ------------------------------------------------------------------ */
/* The hold trace                                                       */
/* ------------------------------------------------------------------ */

const resolveId = (id) => {
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (id === 'import:discovery-handoff') return importArt.contentDigest;
  if (id === 'cert:discovery-capsule') return certDigest;
  if (id === 'UH-Define-Architecture-Contract-001') return sha(artifactContent);
  if (id === 'link:define-product-intent') return intentArt.contentDigest;
  if (id === 'link:model-use-cases') return ucArt.contentDigest;
  if (id === 'link:derive-system-requirements') return srArt.contentDigest;
  if (id === 'link:define-acceptance-contract') return candArt.contentDigest;
  if (id === 'link:reconcile-what') return recArt.contentDigest;
  if (id === 'link:freeze-what-baseline') return uhFrz.contentDigest;
  if (id === 'FR-Freeze-What-Baseline-Reviewer-002') return frFrz2.contentDigest;
  if (id === 'AC-Define-Architecture-Contract-001-r1') return r1Formalization;
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
    'UH-Define-Architecture-Contract-001', 'verifies', id,
    'The hold\'s envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection.'.replace('${id}', id),
  )),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'import:discovery-handoff', 'The accepted discovery import chain is the only accepted base this hold is grounded in (content digest recomputed).'),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'link:define-product-intent', 'Census link 1: repair verdicts across every emission (e49d8d11, 6c9c8324, 04632094); no author reissue; NOT accepted.'),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'link:model-use-cases', 'Census link 2: never reviewed at its own content address; authored in violation of its own desk upstream hold (6cccd162); NOT accepted.'),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'link:derive-system-requirements', 'Census link 3: repair verdict d31b044c + restaff confirmation; reviewer seat held (fbc0394b, b4eaaaba); NOT accepted.'),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'link:define-acceptance-contract', 'Census link 4: candidate 2b01353d under the open verdict contention CL-Define-Acceptance-Contract-001 (repair 83e675bb + 7e76176c vs canonical accepted e5249d78 with no verification counterpart); NOT counted accepted.'),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'link:reconcile-what', 'Census link 5: reviewer verdict of record repair 39a94a29 with the explicit no-accept prohibition; emission-b re-check repair 702fc967; prohibition undischarged; NOT accepted.'),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'link:freeze-what-baseline', 'The desk\'s lawful upstream input was REFUSED: UH-Freeze-What-Baseline-001 9f2d28b9 hold-no-authoring; no whole-WHAT baseline exists; domain.frozen never fired; chain.baseline absent.'),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'FR-Freeze-What-Baseline-Reviewer-002', 'The r4 freeze adjudication (d52746b6, hold-upheld) hash-resolved the impostor e210334e to the green fixture and refused it as acceptance authority; census 0/5 and the prohibition recompute.'),
  rel('UH-Define-Architecture-Contract-001', 'observes', 'AC-Define-Architecture-Contract-001-r1', 'This desk\'s own r1 stray authoring recomputes to e2ae5d31 (whole-JSON canonical) at its declared address a926df62 which resolves to zero contents; approved with zero findings against zero accepted upstream revisions; superseded, NOT product lineage.'),
];

const traceContent = {
  deskRef: 'define-architecture-contract',
  role: 'author',
  traceKind: 'upstream-hold-trace',
  subjectSemanticCode: 'UH-Define-Architecture-Contract-001',
  subjectArtifactRef: artifact.artifactRef,
  relationVocabulary: ['observes', 'verifies'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: ['UH-Define-Architecture-Contract-001'] }])),
  holdCoverage: {
    noProductAuthored: true,
    unacceptedLinks: ['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements', 'link:define-acceptance-contract', 'link:reconcile-what'],
    freezeState: 'link:freeze-what-baseline REFUSED; chain.baseline absent; MISSING_LINEAGE gate law fail-closed',
    onlyAcceptedChain: 'import:discovery-handoff',
    strayAuthoringHistory: 'AC-Define-Architecture-Contract-001-r1 superseded; not product lineage',
  },
  branchResolutionNote: 'No scenario, surface, realization-entry, obligation or evidence-binding identities are authored by this hold; all observed links resolve at artifact granularity.',
  workspaceSummary: WS,
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'upstream-hold-trace',
  contentDigest: sha(traceContent),
  createdAt: CREATED_AT,
  deskRef: 'define-architecture-contract',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

/* ------------------------------------------------------------------ */
/* Write                                                                */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('define-architecture-contract-desk-upstream-hold.artifact.json', artifact);
writeJson('define-architecture-contract-desk-upstream-hold-trace.json', trace);

console.log(JSON.stringify({
  built: 'define-architecture-contract desk (author) upstream hold',
  semanticCode: 'UH-Define-Architecture-Contract-001',
  artifactRef: artifact.artifactRef,
  traceRef: trace.traceRef,
  envelopeRecomputed: '8/8 (+CERT-1)',
  unacceptedLinks: 5,
  freezeRefusals: 4,
  unresolvableInstances: UNRESOLVABLE.length,
  gateLaw: 'MISSING_LINEAGE (chain.baseline absent; fail-closed before validation)',
}, null, 2));
