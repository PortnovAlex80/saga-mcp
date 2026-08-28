/**
 * settle-formalization desk (author) - SETTLEMENT UPSTREAM HOLD builder.
 *
 * Emission: UH-Settle-Formalization-001 (stray-products-r6, author seat).
 * Deterministic authoring.
 *
 * This desk (the installed manifest node settle-formalization, KERNEL
 * node, output product kind frf-contracts.solution-contract.v1, check
 * provider formalization.settlement-structure.v1 / settleSolutionContract,
 * effect formalization.settle-solution-contract, operator staffed)
 * consumes the FROZEN baseline artifact (exact) + the accepted SRS
 * revision + the typed Development handoff values over the single inbound
 * edge define-architecture-contract --domain.accepted-->
 * settle-formalization, and settles only through the three-rung ladder:
 *   R1 authority-pins     - all five input classes present (frozenBaseline,
 *                           baselineArtifact, srs, repositoryPolicyRefs,
 *                           handoff); "settlement never discovers authorities";
 *   R2 binding-resolution - the twelve handoff kinds typed, required,
 *                           NON-EMPTY, each resolved against the FROZEN
 *                           baseline's developmentSurface declaration (any
 *                           binding outside the frozen surface is a typed
 *                           FOREIGN_LINEAGE refusal - the UC-FOREIGN kill);
 *   R3 sealed-contract    - canonical digest over the sealed body + the
 *                           self-seal surface
 *                           postFreeze.settlement.solutionContractDigest
 *                           (the A2 settler fence: the ladder validates its
 *                           own output before emitting).
 *
 * On this chain NONE of the five input classes exists: the recomputed
 * census is 0 of 7 accepted upstream desks - no WHAT-baseline has ever
 * existed (freeze author hold UH-Freeze-What-Baseline-001 9f2d28b9...,
 * upheld by FR-Freeze-What-Baseline-002 d52746b6... with freeze
 * ratification REFUSED), the domain.frozen edge has never lawfully fired,
 * and the immediate upstream desk (define-architecture-contract) is itself
 * on record hold (UH-Define-Architecture-Contract-001 6a32f180..., r5
 * verifier 29/29) with NO SRS candidate ever authored - so no accepted SRS
 * revision, no frozen baseline artifact and no lawful handoff values
 * exist, and the inbound domain.accepted edge into this desk has never
 * lawfully fired. Any lawful run of the ladder on this staffing refuses at
 * R1 with MISSING_LINEAGE ("settlement was given no frozenBaseline input
 * (fail-closed; settlement never discovers authorities)") and the desk's
 * frozen routing table routes MISSING_LINEAGE to the outcome `failed`
 * (domain.failed -> complete-failed). This author seat fires no domain
 * edge; the hold is the emission of record. Every fabrication path is
 * typed-refused: a forged baseline pin dies at R1 DRIFT_DETECTED
 * (sha256OfCanonical(frozenBaseline) must equal the pinned artifact
 * digest), any invented handoff value dies at R2 FOREIGN_LINEAGE (the
 * frozen universe is absent; the twelve kinds must be non-empty AND
 * resolve), and a self-seal without a real contract body is
 * MALFORMED_PRODUCT - no honest frf-contracts.solution-contract.v1 can
 * exist here; the hold is the only honest emission.
 *
 * Frame adjudication (this round): the task frame pins protocol-skill
 * a926df6284... (the SAME inherited r2/r3-era anchor debt; also the
 * drifted declared self-address of the define-architecture-contract desk's
 * r1 stray product AND the trace-identity pin inside THIS desk's own r1
 * reviewer-seat stray trace) and semantic-skill 95fafc847b... (the r3-era
 * frame semantic pin). Both hash-resolve to ZERO workspace contents
 * (re-scanned by this build's verifier); neither matches the installed
 * manifest skill digests (recomputed b88267a1... / the settle-formalization
 * semantic digest recomputed below); both are recorded verbatim as
 * envelope provenance and REFUSED as authority. The frame's workspace
 * summary ("0 accepted upstream revisions travel by content address") is
 * adjudicated TRUE of the chain (census 0 of 7).
 *
 * This desk's own stray-product record (r1 reviewer seat): the family
 * settle-formalization-reviewer-{decision,product-submission,trace}.json
 * fabricated an entire claim universe (7 invented artifact refs + a
 * phantom candidate set f975e878...), declared acceptedUpstreamRevisions=1
 * against this frame's 0, declared the unknown resolved against the D10
 * carry law, pinned its trace identity to the drifted anchor a926df6284...,
 * "accepted" a product kind (formalization.solution-contract.v1) that is
 * not the installed product kind (frf-contracts.solution-contract.v1), and
 * its decision file is not parseable JSON at all (a raw JS expression in
 * place of a value). None of it is lineage; retired.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. All addresses are sha256 over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule
 * (src/workflow-kernel/domain/digest.ts). Every cited record digest is
 * recomputed from the corpus files in this script; nothing is trusted by
 * declaration.
 *
 * Run: node settle-formalization-desk-hold-build.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
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
const relPath = (p) => relative(REPO, p).split('\\').join('/');
const CREATED_AT = '2026-08-28T00:00:00Z';
const SELF_ROUND = 'stray-products-r6';
const WS = '0 accepted upstream revisions travel by content address';

/* The frame pins carried by THIS desk task frame (verbatim). */
const PIN_PROTOCOL = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const PIN_SEMANTIC = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';
/* The installed manifest protocol skill digest (recomputed below). */
const INSTALLED_PROTOCOL = 'b88267a1df84ae503d0e9744734a26671506f7bb719cb7b457f8d5ad6745997f';
/* The installed semantic skill digest for THIS desk (recomputed below). */
const installedSemanticOf = (desk) => sha({ skillId: `formalization-desk-${desk}`, kind: 'semantic', desk });
const INSTALLED_SEMANTIC = installedSemanticOf('settle-formalization');
/* The define-architecture-contract desk's r1 stray product (drift of record). */
const R1_UPSTREAM_STRAY_FILE = 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-desk-architecture-contract.artifact.json';
const R1_UPSTREAM_STRAY_RECOMPUTED = 'f4846e5fed6808f8b0c33b14d58a337d9f72eddd02bf775bc048862b1d5626af';

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

const expect = (cond, message) => { if (!cond) throw new Error(`hold basis failed: ${message}`); };

/* ------------------------------------------------------------------ */
/* Verified, accepted discovery import chain (the only accepted base)   */
/* ------------------------------------------------------------------ */

const importArt = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r2/import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));
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
/* Recompute every cited record from the corpus                         */
/* ------------------------------------------------------------------ */

const record = (p) => {
  const j = JSON.parse(readFileSync(join(REPO, p), 'utf8'));
  return {
    contentDigest: sha(j.content),
    verdict: j.content.verdict ?? j.content.decision ?? j.content.holdKind ?? null,
    reviewId: j.content.reviewId ?? j.semanticCode ?? j.content.recordId ?? j.submissionId ?? null,
    reviewedCandidate: j.content.reviewedCandidate ?? j.content.candidateOfRecord ?? null,
    raw: j,
  };
};

/* The freeze desk: the author hold of record + both confirmations. */
const holdArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-upstream-hold.artifact.json');
const holdTrc = record('docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-upstream-hold-trace.json');
expect(holdArt.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f', 'author hold artifact drift');
expect(holdTrc.contentDigest === '17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202', 'author hold trace drift');
expect(holdArt.raw.content.decision === 'hold-no-authoring' && holdArt.raw.content.noProductAuthored === true, 'author hold decision drift');
expect(holdArt.raw.content.chainAcceptanceCensus.acceptedPreFreezeDeskCount === 0, 'author hold census drift');
const asConf = record('docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-restaff-confirmation.json');
expect(asConf.contentDigest === 'c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06', 'AS-Freeze-What-Baseline-001 drift');
expect(asConf.raw.content.holdDisposition?.state === 'STANDING (not discharged; not re-emitted)' && asConf.raw.content.upstreamStateRecheck?.movementScan?.newAcceptedLineageSinceHold === 0, 'AS-001 disposition drift');
const rcConf = record('docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-reviewer-confirmation.json');
expect(rcConf.contentDigest === 'c19344fd964655f226b777747b23b94da07877f2fc28614ea4a65c98c803ed44', 'RC-Freeze-What-Baseline-001 drift');
expect(rcConf.raw.content.decision === 'hold-upheld-no-candidate-to-review' && rcConf.raw.content.upstreamAcceptedAdjudication?.ratified === false, 'RC-001 adjudication drift');
const rcTrc = record('docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-reviewer-confirmation-trace.json');
expect(rcTrc.contentDigest === '38192e08e601f35302e80650e8a7d8f84f7e9b6334d18f6cd092092e3c9e1b5d' && rcTrc.raw.content.subjectArtifactRef === shaRef(rcConf.contentDigest), 'RC-001 trace drift');
const holdVerifyOut = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-hold-verify-out.json'), 'utf8'));
const restaffVerifyOut = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-restaff-verify-out.json'), 'utf8'));
const rcVerifyOut = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-reviewer-confirmation-verify-out.json'), 'utf8'));
expect([holdVerifyOut, restaffVerifyOut, rcVerifyOut].every((v) => v.summary?.allPass === true && v.summary?.fail === 0), 'an r3 freeze-desk verifier is no longer green');

/* The r4 round: the freeze desk reviewer emission of record (REFUSAL). */
const r4Dir = 'docs/refactoring/event-kernel/qualification/stray-products-r4/';
const frR4 = record(`${r4Dir}freeze-what-baseline-desk-reviewer-review.json`);
const vvR4 = record(`${r4Dir}freeze-what-baseline-desk-reviewer-verification.json`);
const rtR4 = record(`${r4Dir}freeze-what-baseline-desk-reviewer-trace.json`);
const fsR4 = record(`${r4Dir}freeze-what-baseline-desk-reviewer-product-submission.json`);
expect(frR4.contentDigest === 'd52746b6620e8e4583592f1d23beff3053430d15ae8159643dcc7461b49d9190', 'FR-Freeze-What-Baseline-002 drift');
expect(vvR4.contentDigest === '8b04101005452d7906bcc1ca66f8f91d5ef6957518ae5af84f8a47f7e5781c21', 'VV-Freeze-What-Baseline-002 drift');
expect(rtR4.contentDigest === '8bf4f283ec152b8e9f9a4d3706227776b1723805c675ea2580ffa59e2259e252', 'RT-Freeze-What-Baseline-002 drift');
expect(fsR4.contentDigest === '6f5294a924e2fa9d94067b2c60d46f2bf0e199098fefd22f5df9325ea26b9eac', 'FS-Freeze-What-Baseline-Reviewer-001 drift');
expect(frR4.verdict === 'hold-upheld', 'r4 reviewer verdict drift');
expect(frR4.reviewedCandidate?.artifactRef === shaRef(holdArt.contentDigest), 'r4 reviewer candidate binding drift');
const frR4Raw = JSON.parse(readFileSync(join(REPO, `${r4Dir}freeze-what-baseline-desk-reviewer-review.json`), 'utf8')).content;
expect(frR4Raw.decision.includes('REFUSE freeze ratification'), 'r4 reviewer refusal decision drift');
expect(frR4Raw.claimedAcceptanceAdjudication?.adjudication.startsWith('REFUSED as acceptance authority'), 'r4 frame-claim adjudication drift');
const r4VerifyOut = JSON.parse(readFileSync(join(REPO, `${r4Dir}freeze-what-baseline-desk-reviewer-verify-out.json`), 'utf8'));
expect(r4VerifyOut.summary?.allPass === true && r4VerifyOut.summary?.fail === 0, 'r4 reviewer verifier no longer green');

/* The immediate upstream: the r5 define-architecture-contract hold. */
const r5Dir = 'docs/refactoring/event-kernel/qualification/stray-products-r5/';
const acHoldR5 = record(`${r5Dir}define-architecture-contract-desk-upstream-hold.artifact.json`);
const acHoldTrcR5 = record(`${r5Dir}define-architecture-contract-desk-upstream-hold-trace.json`);
expect(acHoldR5.contentDigest === '6a32f180f10366833f0c2be102704749379fb7c2c13cca4c103c255c149d2023', 'r5 SRS upstream hold artifact drift');
expect(acHoldTrcR5.contentDigest === '1f54d1f317a9c0ec4f50f26b453112be72ca3abfca7859d07c4b454c5be8d6f3', 'r5 SRS upstream hold trace drift');
expect(acHoldR5.raw.content.decision === 'hold-no-authoring' && acHoldR5.raw.content.noProductAuthored === true, 'r5 hold decision drift');
expect(acHoldR5.raw.content.deskContract.deskId === 'define-architecture-contract' && acHoldR5.raw.content.upstreamGate.gateEdgeBlocked.includes('never lawfully fired'), 'r5 hold gate law drift');
const r5VerifyOut = JSON.parse(readFileSync(join(REPO, `${r5Dir}define-architecture-contract-desk-hold-verify-out.json`), 'utf8'));
expect(r5VerifyOut.summary?.allPass === true && r5VerifyOut.summary?.fail === 0, 'r5 hold verifier no longer green');
expect(r5VerifyOut.verified === 'UH-Define-Architecture-Contract-001', 'r5 verifier identity drift');

/* The gate beneath the freeze: reconcile-what, reviewer round of record. */
const rwArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-what-reconciliation.artifact.json');
const rwSub = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-product-submission.json');
const frRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-review.json');
const clRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-collision-record.json');
expect(rwArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191', 'reconcile-what artifact address drift');
expect(rwSub.contentDigest === '0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba', 'reconcile-what submission address drift');
expect(frRw.reviewId === 'FR-Reconcile-What-001' && frRw.verdict === 'repair' && frRw.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6', 'FR-Reconcile-What-001 drift');
expect(clRw.contentDigest === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d', 'CL-Reconcile-What-001 drift');
const frRwRaw = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-review.json'), 'utf8')).content;
expect(frRwRaw.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline'), 'nextStage prohibition drift');

/* The chain beneath the gate: the four pre-freeze revisions are NOT accepted. */
const intentArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-product-intent-desk-product-intent.artifact.json');
const frIntent1 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-review.json');
const frIntent1b = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-review-emission-b.json');
const frIntent2 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer2-review.json');
expect(intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055', 'intent artifact address drift');
expect(frIntent1.verdict === 'repair' && frIntent1.contentDigest === 'e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4', 'FR-Define-Product-Intent-001 drift');
expect(frIntent1b.verdict === 'repair' && frIntent1b.contentDigest === '6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc', 'FR-Define-Product-Intent-001 emission-b drift');
expect(frIntent2.verdict === 'repair' && frIntent2.contentDigest === '0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc', 'FR-Define-Product-Intent-002 drift');

const ucArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/model-use-cases-desk-uc-scenarios.artifact.json');
const ucHoldR2 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/model-use-cases-desk-upstream-hold.artifact.json');
const frUc001 = record('.factory-testbed/model-use-cases-reviewer-review.json');
expect(ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b', 'UC artifact address drift');
expect(ucHoldR2.contentDigest === '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7', 'r2 UC upstream-hold address drift');
expect(frUc001.reviewId === 'FR-Model-Use-Cases-001' && frUc001.verdict === 'accepted', 'FR-Model-Use-Cases-001 drift');
expect(frUc001.reviewedCandidate?.artifactRef === 'sha256:c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8', 'FR-Model-Use-Cases-001 candidate pin drift');
expect(frUc001.reviewedCandidate?.artifactRef !== ucArt.contentDigest, 'FR-Model-Use-Cases-001 unexpectedly pins the corpus UC bundle');

const srArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/derive-system-requirements-desk-system-requirements.artifact.json');
const frSr1 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/derive-system-requirements-desk-reviewer-review.json');
const rsSr1 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/derive-system-requirements-desk-reviewer-restaff2-confirmation.json');
const uhSr1 = record('.factory-testbed/derive-system-requirements-reviewer-hold.artifact.json');
const uhSr2 = record('.factory-testbed/derive-system-requirements-reviewer-hold2.artifact.json');
expect(srArt.contentDigest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df', 'requirements artifact address drift');
expect(frSr1.verdict === 'repair' && frSr1.contentDigest === 'd31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0', 'FR-Derive-System-Requirements-001 drift');
expect(rsSr1.contentDigest === '1c30d28e8222eaa225195bf33d87f378054b98a01bdf50710fd4900f5339a0a6', 'RS-Derive-System-Requirements-001 drift');
expect(uhSr1.contentDigest === 'fbc0394bd8f79df2fc7e8956accd9fe25485bceab182044927de9f209f11d053', 'UH-Derive-System-Requirements-001 drift');
expect(uhSr2.contentDigest === 'b4eaaabaa5010c6e03594943e2437b030d352ec9f3027fb275d57f351692c995', 'UH-Derive-System-Requirements-002 drift');

const acArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-acceptance-bindings.artifact.json');
const uhAc = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-upstream-hold.artifact.json');
const frAc2 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-review-emission-c.json');
expect(acArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0', 'acceptance artifact address drift');
expect(uhAc.contentDigest === 'a53a5e08a9c7f0f6ad550fd5d2db142238683e1d285458eb2ded5330cce39d84', 'UH-Define-Acceptance-Contract-001 drift');
expect(frAc2.reviewId === 'FR-Define-Acceptance-Contract-002' && frAc2.verdict === 'repair' && frAc2.contentDigest === '7e76176c431770477f2930747498f2df8b0a6ce6071c29ff065ad7d85edcac0e', 'FR-Define-Acceptance-Contract-002 (adjudicating emission C) drift');

/* The upstream desk's own r1 stray product (drift of record). */
const r1StrayBytes = readFileSync(join(REPO, R1_UPSTREAM_STRAY_FILE));
const r1Stray = JSON.parse(r1StrayBytes.toString('utf8'));
expect(r1Stray.contentDigest === PIN_PROTOCOL, 'r1 stray declared address drift');
const r1StrayActual = sha(r1Stray.content);
expect(r1StrayActual === R1_UPSTREAM_STRAY_RECOMPUTED, 'r1 stray recomputed content address drift');
expect(r1StrayActual !== r1Stray.contentDigest, 'r1 stray drift unexpectedly resolved');
/* The r2 recomputation that documented the drift family. */
const v2Drift = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-verification.json');
expect(v2Drift.contentDigest === 'c0215ebcbf494c3d4c71c7e8f342cfa91eb9dddcf6f50f78f5d20f4b0be7579a', 'VV-Define-Product-Intent-001 drift');
expect(JSON.stringify(v2Drift.raw.content).includes(R1_UPSTREAM_STRAY_RECOMPUTED) && JSON.stringify(v2Drift.raw.content).includes('CRIT-003'), 'r2 drift-evidence record no longer cites the drift family');
/* The r1 gate verdict over the upstream stray (old-format record). */
const r1VerdictParsed = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-review-verdict.json'), 'utf8'));
const r1VerdictDigest = shaRaw(Buffer.from(canon(r1VerdictParsed), 'utf8'));
expect(r1VerdictParsed.verdict === 'approved' && r1VerdictDigest === 'bc1c5e59f1555eee27d7bf62e82f0578208af749f025621f6e0d102128a94252', 'r1 gate verdict drift');

/* THIS desk's own r1 stray family (reviewer seat). */
const R1_SELF_DIR = 'docs/refactoring/event-kernel/qualification/stray-products-r1/';
const SELF_STRAY_FILES = {
  decision: `${R1_SELF_DIR}settle-formalization-reviewer-decision.json`,
  submission: `${R1_SELF_DIR}settle-formalization-reviewer-product-submission.json`,
  trace: `${R1_SELF_DIR}settle-formalization-reviewer-trace.json`,
};
const selfStrayRawBytes = Object.fromEntries(Object.entries(SELF_STRAY_FILES).map(([k, p]) => [k, readFileSync(join(REPO, p))]));
const selfStrayRawDigests = Object.fromEntries(Object.entries(selfStrayRawBytes).map(([k, b]) => [k, shaRaw(b)]));
expect(selfStrayRawDigests.decision === 'ad698a85b0a76d8c7be5220c9300c2413dea6f70fd28e162b09ab68519f8e2ed', 'r1 self stray decision raw address drift');
expect(selfStrayRawDigests.submission === '0b0c9d2ef98f37c065aa7379764a92625369cd15dad43ea7cbe9ca52eb52ccc6', 'r1 self stray submission raw address drift');
expect(selfStrayRawDigests.trace === 'f3cf410a36f97f0e2a0476e5baf157620dcd907408444ddd5e9745b5f9c22f51', 'r1 self stray trace raw address drift');
let decisionParseError = null;
try { JSON.parse(selfStrayRawBytes.decision.toString('utf8')); } catch (e) { decisionParseError = String(e.message).split('\n')[0]; }
expect(decisionParseError !== null, 'the r1 self stray decision file unexpectedly parses as JSON');
const selfStraySubmission = JSON.parse(selfStrayRawBytes.submission.toString('utf8'));
const selfStrayTrace = JSON.parse(selfStrayRawBytes.trace.toString('utf8'));
/* Label-shaped pseudo-addresses (not sha256 hex). */
expect(selfStraySubmission.productRef === 'sha256:settle-formalization-reviewer-product-2026-08-27', 'r1 self stray productRef label drift');
expect(!/^sha256:[0-9a-f]{64}$/.test(selfStraySubmission.productRef), 'r1 self stray productRef unexpectedly a real content address');
/* The fabricated claim universe (7 invented refs) + the phantom candidate set. */
const PHANTOM_CANDIDATE = 'f975e878501cac72035467a6dc197705a8e3680e24c0c2ce9f021587ee57c6e6';
const INVENTED_REFS = [
  'fbe292e862ab174b29de15cbbf85b34e4211b3a0e508fd39245015c9ea12b180',
  'c9bfe922c5891e8bfeaaf07864a75d3beaa5239dd455d6bb889f1eef4b3dd0fc',
  '423be112883976126a9b2718226aa68628fbe5d60253e0c0c849d66925062035',
  'd7ce453b9dbb1aa1cecda1d591779b92dc347220c9f4f19c6db86629f5a18c2b',
  'f7acf9d19953686e3042a10755a867a8f80a7fdb3963bd8e78e725962c792276',
  'c292f69407b0d7752008069ac095dc556522ed5df9f386b9e2ec5bf31909e8f0',
  'f3d0a6a4aea6909d35d8e5368425b21b38799b7f44444d926176083b532c011b',
];
for (const ref of INVENTED_REFS) {
  expect(JSON.stringify(selfStraySubmission).includes(ref), `invented ref ${ref} missing from the r1 submission`);
}
expect(selfStraySubmission.subjectCandidateSetRef === shaRef(PHANTOM_CANDIDATE), 'r1 self stray phantom candidate drift');
expect(selfStraySubmission.candidate.upstreamAcceptedRevision === shaRef(PHANTOM_CANDIDATE), 'r1 self stray phantom upstream revision drift');
expect(selfStraySubmission.reviewVerdict?.decision === 'ACCEPTED', 'r1 self stray verdict drift');
expect(selfStraySubmission.candidate.reviewId === 'RV-Settle-Formalization-001', 'r1 self stray reviewId drift');
expect(selfStrayTrace.traceRelationship.participants.some((p) => p.digest === shaRef(PIN_PROTOCOL)), 'r1 self stray trace anchor pin drift');
/* None of the invented/phantom addresses may appear in THIS envelope. */
for (const ref of [...INVENTED_REFS, PHANTOM_CANDIDATE]) {
  expect(!Object.values(ENVELOPE).includes(ref), `invented ref ${ref} collides with the task-projection envelope`);
}

/* ------------------------------------------------------------------ */
/* The freeze payload contract + the installed settle desk contract     */
/* ------------------------------------------------------------------ */

const schemaPath = join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json');
const schemaBytes = readFileSync(schemaPath);
const schemaRawDigest = shaRaw(schemaBytes);
expect(schemaRawDigest === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09', 'what-baseline schema raw digest drift');
const schema = JSON.parse(schemaBytes.toString('utf8'));
expect(schema.properties.acceptanceRecords.minItems === 5, 'what-baseline acceptanceRecords minItems drift');
expect(schema.properties.schemaVersion.const === 'frf-contracts.what-baseline.v1', 'what-baseline schemaVersion drift');

/* The installed desk contract facts (src/workflow-kernel manifest + cell). */
const manifestSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'manifest.ts'), 'utf8');
expect(manifestSrc.includes("id: 'settle-formalization'") && manifestSrc.includes("outputProductKind: 'frf-contracts.solution-contract.v1'") && manifestSrc.includes("checkProviderId: 'formalization.settlement-structure.v1'"), 'installed manifest settle desk row drift');
expect(manifestSrc.includes("effectId: 'formalization.settle-solution-contract', operatorStaffed: true"), 'installed manifest settle effect/staffing drift');
expect(manifestSrc.includes("{ from: 'define-architecture-contract', to: 'settle-formalization', on: 'domain.accepted' }"), 'installed manifest inbound edge drift');
expect(manifestSrc.includes("{ from: 'settle-formalization', to: 'complete-formalized', on: 'domain.formalized' }"), 'installed manifest formalized edge drift');
expect(manifestSrc.includes("{ from: 'settle-formalization', to: 'complete-inconsistent', on: 'domain.inconsistent' }"), 'installed manifest inconsistent edge drift');
expect(manifestSrc.includes("{ from: 'settle-formalization', to: 'complete-failed', on: 'domain.failed' }"), 'installed manifest failed edge drift');
expect(manifestSrc.includes("{ providerId: 'formalization.settlement-structure.v1', nodeId: 'settle-formalization', productKind: 'frf-contracts.solution-contract.v1', validator: 'settleSolutionContract' }"), 'installed check-provider row drift');
const settlementSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'settlement.mjs'), 'utf8');
expect(settlementSrc.includes("'frozenBaseline',") && settlementSrc.includes("'baselineArtifact',") && settlementSrc.includes("'srs',") && settlementSrc.includes("'repositoryPolicyRefs',") && settlementSrc.includes("'handoff',"), 'settlement input classes drift');
expect(settlementSrc.includes('settlement never discovers authorities'), 'settlement fail-closed law text drift');
expect(settlementSrc.includes('sha256OfCanonical(inputs.frozenBaseline)'), 'R1 baseline recomputation drift');
expect(settlementSrc.includes('postFreeze.settlement.solutionContractDigest'), 'self-seal surface drift');
expect(settlementSrc.includes('at most one handoff kind may resolve against the settlement self-seal surface'), 'self-seal cardinality law drift');
const protocolSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'protocol.mjs'), 'utf8');
expect(protocolSrc.includes("MISSING_LINEAGE: 'failed'") && protocolSrc.includes("MALFORMED_PRODUCT: 'failed'"), 'settle routing table drift');
expect(protocolSrc.includes("FOREIGN_LINEAGE: 'inconsistent'") && protocolSrc.includes("DRIFT_DETECTED: 'inconsistent'"), 'settle inconsistent routing drift');
expect(protocolSrc.includes("SETTLE_EFFECT_ID = 'formalization.settle-solution-contract'"), 'settle effect id drift');
const whatBaselineSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'what-baseline.mjs'), 'utf8');
const HANDOFF_KINDS = [
  'acceptance-bindings',
  'formalization-certificate',
  'integration-and-construction-obligations',
  'prd-intent-bindings',
  'repository-and-policy-bindings',
  'requirement-bindings',
  'scenario-bindings',
  'scenario-realization-bindings',
  'solution-contract',
  'srs-reference-and-hash',
  'terminal-claim-bindings',
  'what-baseline-reference-and-hash',
];
for (const kind of HANDOFF_KINDS) {
  expect(whatBaselineSrc.includes(`'${kind}',`), `handoff binding kind ${kind} missing from the frozen validator vocabulary`);
}
/* The installed skill digests, recomputed by the documented canonical rule. */
const installedProtocolRecomputed = sha({ skillId: 'saga-process-module-worker-protocol', kind: 'protocol' });
expect(installedProtocolRecomputed === INSTALLED_PROTOCOL, 'installed protocol skill digest drift');
expect(installedSemanticOf('define-architecture-contract') === '131efbd99bd2d92e0ac790ab9c271218d0a72995df0053fc35cbffc4d7f176f3', 'r5-era installed semantic digest drift');
expect(PIN_PROTOCOL !== INSTALLED_PROTOCOL && PIN_SEMANTIC !== INSTALLED_SEMANTIC, 'frame pins unexpectedly match the installed manifest');

/* ------------------------------------------------------------------ */
/* The ladder projection (recomputed, not asserted)                     */
/* ------------------------------------------------------------------ */

const INPUT_CLASS_ABSENCE = [
  { inputClass: 'frozenBaseline', presence: 'absent', reason: 'no WHAT-baseline candidate has ever existed; the freeze never ratified (FR-Freeze-What-Baseline-002 REFUSE; the domain.frozen edge never lawfully fired)' },
  { inputClass: 'baselineArtifact', presence: 'absent', reason: 'no content-addressed kernel-evidence artifact of any frozen baseline exists (nothing to pin; R1 demands ref === sha256:<digest> with the digest recomputed over the baseline)' },
  { inputClass: 'srs', presence: 'absent', reason: 'no accepted SRS revision exists; the define-architecture-contract desk is itself on record hold (UH-Define-Architecture-Contract-001) with NO SRS candidate ever authored' },
  { inputClass: 'repositoryPolicyRefs', presence: 'absent', reason: 'no post-freeze repository/policy authority refs were supplied by any accepted upstream revision' },
  { inputClass: 'handoff', presence: 'absent', reason: 'no typed Development handoff values exist; the twelve kinds must be non-empty AND resolve against the frozen developmentSurface declaration, which does not exist' },
];
const LADDER_PROJECTION = {
  inputClassPresence: INPUT_CLASS_ABSENCE,
  projectedFirstRefusal: {
    rung: 'R1 authority-pins',
    reason: 'MISSING_LINEAGE',
    detail: 'settlement was given no frozenBaseline input (fail-closed; settlement never discovers authorities)',
    source: 'settlementAuthorityPins (cells/what-freeze/settlement.mjs), first absent class in declared order',
  },
  routedOutcome: 'failed',
  routingSource: 'SETTLE_OUTCOME_OF_REASON.MISSING_LINEAGE (cells/what-freeze/protocol.mjs frozen table)',
  domainProjection: 'domain.failed -> complete-failed (kernel-owned; NOT fired by this author seat)',
  fabricationFence: 'every fabrication path is typed-refused: a forged baseline pin dies at R1 DRIFT_DETECTED (sha256OfCanonical(frozenBaseline) must equal the pinned artifact digest); any invented handoff value dies at R2 FOREIGN_LINEAGE (the frozen resolution universe is absent; the twelve kinds must be non-empty AND resolve); a self-seal without a real contract body is MALFORMED_PRODUCT; no honest frf-contracts.solution-contract.v1 can exist on this staffing',
};

/* ------------------------------------------------------------------ */
/* The hold artifact                                                    */
/* ------------------------------------------------------------------ */

const artifactContent = {
  schemaVersion: 'formalization.upstream-hold.v1',
  deskRef: 'settle-formalization',
  deskNodeId: 'settle-formalization',
  role: 'author',
  itemInstanceId: 'formalization-item:settle-formalization',
  token: 'plan:formalization#item:solution-contract',
  holdKind: 'settlement-upstream-hold',
  decision: 'hold-no-authoring',
  statement: 'The settle-formalization desk authors NO solution-contract material in this staffing. The desk contract (installed manifest: kernel node, output product kind frf-contracts.solution-contract.v1, check provider formalization.settlement-structure.v1/settleSolutionContract, effect formalization.settle-solution-contract, operator staffed) consumes the FROZEN baseline artifact (exact) + the accepted SRS revision + the typed Development handoff values over the single inbound edge define-architecture-contract --domain.accepted--> settle-formalization, and settles only through the three-rung ladder: R1 authority-pins (all five input classes present: frozenBaseline, baselineArtifact, srs, repositoryPolicyRefs, handoff - settlement never discovers authorities), R2 binding-resolution (the twelve handoff kinds typed, required, NON-EMPTY, each resolved against the frozen baseline developmentSurface declaration; any binding outside the frozen surface is a typed FOREIGN_LINEAGE refusal - the UC-FOREIGN kill at the contract level), R3 sealed-contract (canonical digest over the sealed body + the self-seal surface postFreeze.settlement.solutionContractDigest; the A2 settler fence: the ladder validates its own output before emitting). On this chain NONE of the five input classes exists: the recomputed census is 0 of 7 accepted upstream desks - no WHAT-baseline has ever existed (freeze author hold UH-Freeze-What-Baseline-001 9f2d28b9..., upheld by FR-Freeze-What-Baseline-002 d52746b6... with freeze ratification REFUSED), the domain.frozen edge has never lawfully fired, and the immediate upstream desk (define-architecture-contract) is itself on record hold (UH-Define-Architecture-Contract-001 6a32f180..., r5 verifier 29/29) with NO SRS candidate ever authored - so no accepted SRS revision, no frozen baseline artifact and no lawful handoff values exist, and the inbound domain.accepted edge into this desk has never lawfully fired. Any lawful run of the ladder on this staffing refuses at R1 with MISSING_LINEAGE (settlement was given no frozenBaseline input - fail-closed; settlement never discovers authorities) and the desk frozen routing table routes MISSING_LINEAGE to the outcome failed (domain.failed -> complete-failed). This author seat fires no domain edge; the hold is the emission of record. Every fabrication path is typed-refused: a forged baseline pin dies at R1 DRIFT_DETECTED (sha256OfCanonical(frozenBaseline) must equal the pinned artifact digest), any invented handoff value dies at R2 FOREIGN_LINEAGE (the frozen resolution universe is absent; the twelve kinds must be non-empty AND resolve), and a self-seal without a real contract body is MALFORMED_PRODUCT - no honest frf-contracts.solution-contract.v1 can exist here; the hold is the only honest emission. This desk also knows its own stray-product record: the r1 reviewer-seat family (settle-formalization-reviewer-{decision,product-submission,trace}.json) fabricated an entire claim universe (7 invented artifact refs + a phantom candidate set f975e878...), declared acceptedUpstreamRevisions=1 against this frame 0, declared the unknown resolved against the D10 carry law, pinned its trace identity to the drifted anchor a926df6284..., accepted a product kind (formalization.solution-contract.v1) that is not even the installed product kind (frf-contracts.solution-contract.v1), and its decision file is not parseable JSON at all - none of it is lineage; retired.',
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
  },
  deskContract: {
    deskId: 'settle-formalization',
    nodeKind: 'kernel',
    outputProductKind: 'frf-contracts.solution-contract.v1',
    checkProviderId: 'formalization.settlement-structure.v1',
    validator: 'settleSolutionContract',
    effectId: 'formalization.settle-solution-contract',
    operatorStaffed: true,
    repairTargetRole: 'author',
    inboundEdge: { from: 'define-architecture-contract', on: 'domain.accepted' },
    outboundEdges: [
      { to: 'complete-formalized', on: 'domain.formalized' },
      { to: 'complete-inconsistent', on: 'domain.inconsistent' },
      { to: 'complete-failed', on: 'domain.failed' },
    ],
    inputClasses: ['frozenBaseline', 'baselineArtifact', 'srs', 'repositoryPolicyRefs', 'handoff'],
    settlementLadder: [
      { rung: 'R1', name: 'authority-pins', law: 'both authorities sealed and exact; all five input classes present; the baseline recomputes against its pinned artifact digest (DRIFT_DETECTED otherwise); settlement never discovers authorities' },
      { rung: 'R2', name: 'binding-resolution', law: 'the twelve handoff kinds typed, required, NON-EMPTY, each resolved against the frozen developmentSurface.handoffBindingKinds[kind].resolvesAgainst declaration; foreign bindings are FOREIGN_LINEAGE (the UC-FOREIGN kill); at most one kind may resolve against the self-seal surface' },
      { rung: 'R3', name: 'sealed-contract', law: 'one canonical digest over the sealed body + the self-seal surface postFreeze.settlement.solutionContractDigest; the A2 settler fence: the ladder validates its own output before emitting' },
    ],
    handoffBindingKinds: HANDOFF_KINDS,
    selfSealSurface: 'postFreeze.settlement.solutionContractDigest',
    outcomeRouting: {
      FOREIGN_LINEAGE: 'inconsistent',
      STALE_LINEAGE: 'inconsistent',
      DRIFT_DETECTED: 'inconsistent',
      COVERAGE_GAP: 'inconsistent',
      MALFORMED_PRODUCT: 'failed',
      MISSING_LINEAGE: 'failed',
      SCOPE_VIOLATION: 'failed',
    },
    failClosedLaw: 'MISSING_LINEAGE when any input class is absent (settlement was given no <inputClass> input - fail-closed; settlement never discovers authorities); FOREIGN_LINEAGE for bindings outside the frozen surfaces; DRIFT_DETECTED for pin/digest mismatch; the settler never scans, guesses or reselects accepted material',
    source: 'src/workflow-kernel/workshops/formalization/manifest.ts + cells/what-freeze/{settlement,protocol,shared}.mjs (re-verified by this build)',
  },
  upstreamGate: {
    deskId: 'define-architecture-contract',
    candidateOfRecord: {
      semanticCode: 'UH-Define-Architecture-Contract-001',
      artifactRef: shaRef(acHoldR5.contentDigest),
      traceRef: shaRef(acHoldTrcR5.contentDigest),
      productKind: 'formalization.upstream-hold.v1',
      declaredDecision: 'hold-no-authoring',
      status: 'the candidate of record at the immediate upstream desk; NO SRS candidate exists (none was ever lawfully authorable on this chain); r5 verifier 29/29 green',
    },
    reviewerRound: 'none exists at the hold content address (the r5 staffing ended at the author hold); recorded honestly - the absence of a reviewer verdict is itself part of the blocked chain',
    explicitProhibition: 'No accepted SRS revision exists; therefore no domain.accepted input exists for settle-formalization. The chain is blocked at its root: the freeze never ratified (FR-Freeze-What-Baseline-002 REFUSED; the no-accept prohibition of FR-Reconcile-What-001 stands undischarged), so no WHAT-baseline exists, so the SRS desk could hold, and what it never authored cannot have been accepted.',
    prohibitionSource: 'recomputed from FR-Freeze-What-Baseline-002 decision + FR-Reconcile-What-001 nextStage + UH-Define-Architecture-Contract-001 (noProductAuthored)',
    gateEdgeBlocked: 'define-architecture-contract --domain.accepted--> settle-formalization has never lawfully fired on this chain',
  },
  chainAcceptanceCensus: {
    upstreamDeskCount: 7,
    acceptedUpstreamDeskCount: 0,
    schemaRef: 'docs/refactoring/formalization-frf/contracts/schemas/what-baseline.schema.json',
    schemaRawSha256: schemaRawDigest,
    contractLaw: 'the settle desk consumes the frozen baseline artifact + the accepted SRS revision + the typed handoff over the domain.accepted edge; every desk counts only through an accepted reviewer verdict at its own content address',
    upstreamDesks: [
      {
        deskId: 'define-product-intent',
        revisionRef: shaRef(intentArt.contentDigest),
        verdictOfRecord: 'repair (FR-Define-Product-Intent-001 e49d8d11..., emission-b 6c9c8324..., FR-Define-Product-Intent-002 04632094...)',
        accepted: false,
        evidenceRefs: [shaRef(frIntent1.contentDigest), shaRef(frIntent1b.contentDigest), shaRef(frIntent2.contentDigest)],
      },
      {
        deskId: 'model-use-cases',
        revisionRef: shaRef(ucArt.contentDigest),
        verdictOfRecord: 'never reviewed at this content address; authored in violation of its own desk upstream hold (UH-Model-Use-Cases-001 6cccd162...); the only UC reviewer verdict (FR-Model-Use-Cases-001) pins a different candidate (c6120e86...)',
        accepted: false,
        evidenceRefs: [shaRef(ucHoldR2.contentDigest), shaRef(frUc001.contentDigest)],
      },
      {
        deskId: 'derive-system-requirements',
        revisionRef: shaRef(srArt.contentDigest),
        verdictOfRecord: 'repair (FR-Derive-System-Requirements-001 d31b044c...) + re-staff confirmation (RS-...-001 1c30d28e...); reviewer seat held (UH-...-001 fbc0394b..., UH-...-002 b4eaaaba...)',
        accepted: false,
        evidenceRefs: [shaRef(frSr1.contentDigest), shaRef(rsSr1.contentDigest), shaRef(uhSr1.contentDigest), shaRef(uhSr2.contentDigest)],
      },
      {
        deskId: 'define-acceptance-contract',
        revisionRef: shaRef(acArt.contentDigest),
        verdictOfRecord: 'adjudicated repair (FR-Define-Acceptance-Contract-002 7e76176c... emission C confirms emission-A repair, supersedes the accepted emission); desk on record hold (UH-Define-Acceptance-Contract-001 a53a5e08...)',
        accepted: false,
        evidenceRefs: [shaRef(frAc2.contentDigest), shaRef(uhAc.contentDigest)],
      },
      {
        deskId: 'reconcile-what',
        revisionRef: shaRef(rwArt.contentDigest),
        verdictOfRecord: 'repair (FR-Reconcile-What-001 39a94a29..., reviewer round of record per CL-Reconcile-What-001 841194ce...; explicit no-accept prohibition toward freeze-what-baseline)',
        accepted: false,
        evidenceRefs: [shaRef(frRw.contentDigest), shaRef(clRw.contentDigest)],
      },
      {
        deskId: 'freeze-what-baseline',
        revisionRef: null,
        verdictOfRecord: 'no candidate ever authored; author hold UH-Freeze-What-Baseline-001 9f2d28b9... STANDING (re-verified by AS-...-001 c2a08f04...), upheld by RC-...-001 c19344fd... and re-upheld by FR-Freeze-What-Baseline-002 d52746b6... (freeze ratification REFUSED; r4 frame upstream-accepted claim REFUSED)',
        accepted: false,
        evidenceRefs: [shaRef(holdArt.contentDigest), shaRef(holdTrc.contentDigest), shaRef(asConf.contentDigest), shaRef(rcConf.contentDigest), shaRef(frR4.contentDigest)],
      },
      {
        deskId: 'define-architecture-contract',
        revisionRef: null,
        verdictOfRecord: 'no SRS candidate ever authored; author hold UH-Define-Architecture-Contract-001 6a32f180... STANDING with verifier 29/29 (r5); no reviewer round at the hold content address; the r1 stray product of this desk (AC-Define-Architecture-Contract-001) is retired digest-drift history',
        accepted: false,
        evidenceRefs: [shaRef(acHoldR5.contentDigest), shaRef(acHoldTrcR5.contentDigest), shaRef(R1_UPSTREAM_STRAY_RECOMPUTED)],
      },
    ],
  },
  ladderProjection: LADDER_PROJECTION,
  selfStrayProductHistory: {
    scope: 'the r1 reviewer-seat stray family of THIS desk (settle-formalization); the author seat has no r1 product of its own',
    decision: {
      file: SELF_STRAY_FILES.decision,
      rawBytesSha256: shaRef(selfStrayRawDigests.decision),
      parseable: false,
      parseError: decisionParseError,
      facts: 'not parseable JSON at all (a raw JS expression sits where a value belongs at line 144); it carries no lawful content address in the corpus digest rule; it fabricates a 3+1+1+2 claim universe whose seven artifact refs appear nowhere in this envelope; it declares acceptedUpstreamRevisions=1 against this frame 0; it declares the unknown (UNK-1) resolved via terminal_claim_derivation against the D10 carry law',
    },
    submission: {
      file: SELF_STRAY_FILES.submission,
      rawBytesSha256: shaRef(selfStrayRawDigests.submission),
      parseable: true,
      facts: 'productRef sha256:settle-formalization-reviewer-product-2026-08-27 is a LABEL, not a content address (not sha256 hex); reviewDigest is likewise a label; subjectCandidateSetRef/candidate.upstreamAcceptedRevision pin the phantom set f975e878...; cites the 7 invented refs; verdict ACCEPTED over productKind factory.review-verdict.v1.1 with solutionContractValidation.schemaVersion formalization.solution-contract.v1 - not the installed product kind frf-contracts.solution-contract.v1',
    },
    trace: {
      file: SELF_STRAY_FILES.trace,
      rawBytesSha256: shaRef(selfStrayRawDigests.trace),
      parseable: true,
      facts: 'participants pin the phantom set (material-authority) and the drifted anchor a926df6284... (relationship-structure); derivationChain is the invented 3/1+1/2 claim universe; workspaceContext.acceptedUpstreamRevisions=1',
    },
    phantomAddressCensus: {
      phantomCandidateSet: shaRef(PHANTOM_CANDIDATE),
      inventedArtifactRefs: INVENTED_REFS.map(shaRef),
      resolution: 'all 8 addresses are unresolvable workspace-wide (raw bytes, whole-JSON canonical, .content canonical; this round excluded) - fabricated, never ratified',
    },
    disposition: 'NOT lineage: no reviewer candidate exists at any content address for this desk; the verdict of record at settle-formalization is "no product exists to review"; this author staffing inherits nothing from the r1 reviewer-seat family',
  },
  frameAdjudication: {
    workspaceSummary: {
      claim: WS,
      adjudication: 'TRUE of the chain: recomputed census 0 of 7 accepted upstream desks; the only accepted base is the discovery import chain',
    },
    protocolSkillPin: {
      address: shaRef(PIN_PROTOCOL),
      layer: 'protocol-skill',
      resolution: 'unresolvable: zero hash-resolutions workspace-wide (verifier re-scans; r4/r5 reviewer scans concur)',
      extraIdentity: 'the drifted declared self-address of the define-architecture-contract desk r1 stray product (recomputed f4846e5f...) AND the relationship-structure/trace pin inside THIS desk own r1 reviewer-seat stray trace',
      installedManifestPin: shaRef(INSTALLED_PROTOCOL),
      adjudication: 'REFUSED as authority - unresolvable at the content layer and not the installed protocol skill; recorded verbatim as envelope provenance',
    },
    semanticSkillPin: {
      address: shaRef(PIN_SEMANTIC),
      layer: 'semantic-skill',
      resolution: 'unresolvable: zero hash-resolutions workspace-wide; the SAME r3-era frame semantic pin (reconcile-what SEMANTIC_SKILL; r1 formalization section pins)',
      installedManifestPin: shaRef(INSTALLED_SEMANTIC),
      adjudication: 'REFUSED as authority - unresolvable and not the installed semantic skill for this desk; recorded verbatim as envelope provenance',
    },
    frameFamilyHistory: 'the r2/r3 frames carried a926df6284... as the protocol-skill governingContractRef; the r4 frame dropped it; the r5 and r6 frames carry it again - the anchor debt stands, now doubly identified (the upstream desk r1 stray drifted address + the trace pin inside this desk own r1 reviewer stray). The installed manifest pins (recomputed) remain the only lawful skill authority, and this hold depends on neither frame pin.',
  },
  unresolvableInstances: [
    {
      id: 'protocol-skill pin',
      address: shaRef(PIN_PROTOCOL),
      role: 'protocol-skill layer digest of this desk task frame; the SAME inherited r2/r3-era anchor carried by every r2/r3/r5 desk frame as governingContractRef and dropped by the r4 frame',
      extraIdentity: `the DECLARED (drifted) self-address of the define-architecture-contract desk r1 stray product ${R1_UPSTREAM_STRAY_FILE} (recomputed content address ${shaRef(R1_UPSTREAM_STRAY_RECOMPUTED)}, r1 CRIT-003 digest-drift family) and the relationship-structure pin of THIS desk own r1 reviewer stray trace`,
      evidence: 'no content in the workspace hashes to this address (raw bytes, whole-JSON canonical, or .content canonical); recorded as envelope provenance, never ratified',
      resolved: false,
    },
    {
      id: 'semantic-skill pin',
      address: shaRef(PIN_SEMANTIC),
      role: 'semantic-skill layer digest of this desk task frame; the SAME r3-era frame semantic pin carried by the r3 desk frames (e.g. reconcile-what SEMANTIC_SKILL) and the r1 formalization section pins',
      evidence: 'no content in the workspace hashes to this address; not the installed manifest semantic digest for this desk (recomputed at build time); recorded as envelope provenance, never ratified',
      resolved: false,
    },
    ...[...INVENTED_REFS, PHANTOM_CANDIDATE].map((ref) => ({
      id: `r1 self-stray phantom ${ref.slice(0, 8)}...`,
      address: shaRef(ref),
      role: 'an invented address of THIS desk r1 reviewer-seat stray family (fabricated claim universe / phantom candidate set)',
      evidence: 'no content in the workspace hashes to this address; fabrication provenance of the r1 family, never ratified, never lineage',
      resolved: false,
    })),
  ],
  noProductAuthored: true,
  fence: {
    forbiddenProductSections: [
      'schemaVersion: frf-contracts.solution-contract.v1',
      'authority pins (baselineRef, baselineWholeWhatDigest, srsRevisionDigest)',
      'developmentHandoff (the twelve handoff binding kinds; values + resolvedAgainst)',
      'binding-resolution record',
      'self-seal (sealBase / postFreeze.settlement.solutionContractDigest value)',
      'canonicalDigest',
    ],
    observed: 'this hold is a desk artifact, not a solution contract: no authority pin, handoff binding, resolution record, self-seal value or canonical digest is authored; the 8 task-projection claims are observed as content addresses only, and unknown:browser-matrix-1 derives nothing',
  },
  acceptanceLaws: [
    { id: 1, description: 'constraint:retention-1 honored - deterministic authoring (pinned timestamps, no clock/random reads); no retention disposition authored by this seat', satisfied: true },
    { id: 2, description: 'unknown:browser-matrix-1 carried forward, never resolved by this hold (owner discovery; D10)', satisfied: true },
    { id: 3, description: 'terminal:audited-1 and terminal:delivered-1 observed as content addresses only; no terminal lifecycle effect authored (this seat fires no domain edge)', satisfied: true },
    { id: 4, description: 'noProductAuthored - no frf-contracts.solution-contract.v1 material exists in this emission', satisfied: true },
  ],
  resumeContract: [
    'R1: the freeze desk resume contract R1-R4 (UH-Freeze-What-Baseline-001, upheld by FR-Freeze-What-Baseline-002) completes FIRST: genuinely accepted revisions land for define-product-intent, model-use-cases, derive-system-requirements and define-acceptance-contract through completed reviewer stages at their own content addresses; RA-5 re-runs reconcile-what over the NEW accepted chain; the re-run reviewer verdict alone discharges the no-accept prohibition; the freeze ratifies on five accepted pre-freeze desks (acceptanceRecords minItems 5)',
    'R2: domain.frozen fires only from the ratified freeze; the define-architecture-contract desk is re-staffed with the REAL frozen WHAT-baseline revision, authors a genuine sealed SRS (formalization.srs.v1) and passes a completed reviewer stage at its own content address; domain.accepted fires only from that accepted revision (this discharges UH-Define-Architecture-Contract-001, not this desk)',
    'R3: this desk is re-staffed only with ALL FIVE settlement input classes: the frozen baseline artifact (ref sha256:<digest> with the digest recomputed over the baseline), the accepted SRS revision (revisionDigest + realizationEntryIds + surfaces), the post-freeze repository/policy refs and the typed Development handoff values - never a fixture, never a stray product, never a frame assertion',
    'R4: settlement then runs the ladder exactly: R1 pins -> R2 binding resolution against the frozen resolution surfaces (the twelve kinds, non-empty, resolved; FOREIGN_LINEAGE otherwise) -> R3 sealed contract; the settler validates its own output (A2 fence) before emitting domain.formalized',
    'R5: this hold is not carried as product lineage; the future solution contract cites only the two authority pins and the frozen id sets; the r1 reviewer-seat stray family of this desk stays retired (its phantom addresses and invented claim universe are never used as lineage refs)',
  ],
  verification: {
    declaredDigestsTrusted: false,
    importArtifactDigestRecomputed: true,
    capsuleSubArtifactDigestsRecomputed: true,
    envelopeProjectionDigestsRecomputed: true,
    citedRecordDigestsRecomputed: true,
    r3FreezeRoundRecomputed: true,
    r4ReviewerRoundRecomputed: true,
    r5UpstreamHoldRecomputed: true,
    r1SelfStrayFamilyRecomputed: true,
    phantomAddressFabricationRecorded: true,
    ladderProjectionRecomputed: true,
    settleDeskContractRecomputed: true,
    installedSkillDigestsRecomputed: true,
    schemaRawDigestRecomputed: true,
    unresolvableInstancesEnumerated: [
      shaRef(PIN_PROTOCOL),
      shaRef(PIN_SEMANTIC),
      ...[...INVENTED_REFS, PHANTOM_CANDIDATE].map(shaRef),
    ],
    noAcceptedStateAsserted: true,
    acceptedStateClaimsGatedOnVerdictRecords: true,
    productMaterialAuthored: false,
    staleProtocolRefusals: 0,
    deterministicAuthoring: true,
  },
  workspaceSummary: WS,
};

const artifact = {
  artifactRef: shaRef(sha(artifactContent)),
  artifactKind: 'upstream-hold',
  productKind: 'formalization.upstream-hold.v1',
  contentDigest: sha(artifactContent),
  semanticCode: 'UH-Settle-Formalization-001',
  createdAt: CREATED_AT,
  deskRef: 'settle-formalization',
  role: 'author',
  reviewedRound: SELF_ROUND,
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
  if (id === 'UH-Settle-Formalization-001') return sha(artifactContent);
  if (id === 'UH-Define-Architecture-Contract-001') return acHoldR5.contentDigest;
  if (id === 'trace:UH-Define-Architecture-Contract-001') return acHoldTrcR5.contentDigest;
  if (id === 'UH-Freeze-What-Baseline-001') return holdArt.contentDigest;
  if (id === 'trace:UH-Freeze-What-Baseline-001') return holdTrc.contentDigest;
  if (id === 'AS-Freeze-What-Baseline-001') return asConf.contentDigest;
  if (id === 'RC-Freeze-What-Baseline-001') return rcConf.contentDigest;
  if (id === 'trace:RC-Freeze-What-Baseline-001') return rcTrc.contentDigest;
  if (id === 'FR-Freeze-What-Baseline-002') return frR4.contentDigest;
  if (id === 'VV-Freeze-What-Baseline-002') return vvR4.contentDigest;
  if (id === 'RT-Freeze-What-Baseline-002') return rtR4.contentDigest;
  if (id === 'FS-Freeze-What-Baseline-Reviewer-001') return fsR4.contentDigest;
  if (id === 'FR-Reconcile-What-001') return frRw.contentDigest;
  if (id === 'CL-Reconcile-What-001') return clRw.contentDigest;
  if (id === 'FS-Reconcile-What-001') return rwSub.contentDigest;
  if (id === 'link:define-product-intent') return intentArt.contentDigest;
  if (id === 'link:model-use-cases') return ucArt.contentDigest;
  if (id === 'link:derive-system-requirements') return srArt.contentDigest;
  if (id === 'link:define-acceptance-contract') return acArt.contentDigest;
  if (id === 'link:reconcile-what') return rwArt.contentDigest;
  if (id === 'UH-Model-Use-Cases-001') return ucHoldR2.contentDigest;
  if (id === 'UH-Define-Acceptance-Contract-001') return uhAc.contentDigest;
  if (id === 'FR-Define-Acceptance-Contract-002') return frAc2.contentDigest;
  if (id === 'r1stray:architecture-contract') return R1_UPSTREAM_STRAY_RECOMPUTED;
  if (id === 'r1verdict:architecture-contract') return r1VerdictDigest;
  if (id === 'VV-Define-Product-Intent-001') return v2Drift.contentDigest;
  if (id === 'r1selfstray:settle-reviewer-decision') return selfStrayRawDigests.decision;
  if (id === 'r1selfstray:settle-reviewer-submission') return selfStrayRawDigests.submission;
  if (id === 'r1selfstray:settle-reviewer-trace') return selfStrayRawDigests.trace;
  if (id === 'r1selfstray:phantom-candidate-set') return PHANTOM_CANDIDATE;
  if (id === 'schema:what-baseline') return schemaRawDigest;
  if (id === 'framepin:protocol-skill') return PIN_PROTOCOL;
  if (id === 'framepin:semantic-skill') return PIN_SEMANTIC;
  if (id === 'installed:protocol-skill') return INSTALLED_PROTOCOL;
  if (id === 'installed:semantic-skill') return INSTALLED_SEMANTIC;
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

const S = 'UH-Settle-Formalization-001';
const relationships = [
  ...Object.keys(ENVELOPE).map((id) => rel(
    S, 'verifies', id,
    `The hold's envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection.`,
  )),
  rel(S, 'observes', 'import:discovery-handoff', 'The accepted discovery import chain is the only accepted base this hold is grounded in (content digest recomputed).'),
  rel(S, 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel(S, 'observes', 'UH-Define-Architecture-Contract-001', 'The immediate upstream candidate of record: the r5 SRS author hold (hold-no-authoring); NO SRS candidate exists; no accepted revision exists for this desk to consume.'),
  rel(S, 'observes', 'trace:UH-Define-Architecture-Contract-001', 'The r5 SRS author hold trace, byte-stable.'),
  rel(S, 'observes', 'UH-Freeze-What-Baseline-001', 'The root upstream candidate of record: the freeze author hold (hold-no-authoring); NO WHAT-baseline candidate exists.'),
  rel(S, 'observes', 'trace:UH-Freeze-What-Baseline-001', 'The freeze author hold trace, byte-stable.'),
  rel(S, 'observes', 'AS-Freeze-What-Baseline-001', 'The freeze author re-staff confirmation: hold STANDING, 0 new accepted lineage since hold.'),
  rel(S, 'observes', 'RC-Freeze-What-Baseline-001', 'The freeze reviewer confirmation: hold-upheld-no-candidate-to-review; the r3 frame upstream-accepted claim not ratified.'),
  rel(S, 'observes', 'trace:RC-Freeze-What-Baseline-001', 'The freeze reviewer confirmation trace.'),
  rel(S, 'observes', 'FR-Freeze-What-Baseline-002', 'The freeze reviewer emission of record (r4): verdict hold-upheld; freeze ratification REFUSED; the frame fixture claim adjudicated REFUSED as acceptance authority.'),
  rel(S, 'observes', 'VV-Freeze-What-Baseline-002', 'The r4 reviewer verification (50/50 checks, nothing trusted by declaration).'),
  rel(S, 'observes', 'RT-Freeze-What-Baseline-002', 'The r4 reviewer trace.'),
  rel(S, 'observes', 'FS-Freeze-What-Baseline-Reviewer-001', 'The r4 reviewer product submission (terminalOutcome hold-ratified-freeze-refused).'),
  rel(S, 'observes', 'FR-Reconcile-What-001', 'The gate beneath the freeze: repair verdict of record with the no-accept prohibition toward freeze-what-baseline (undischarged).'),
  rel(S, 'observes', 'CL-Reconcile-What-001', 'The gate collision record: emission A is the reviewer round of record.'),
  rel(S, 'observes', 'FS-Reconcile-What-001', 'The gate author candidate of record; NOT settled.'),
  rel(S, 'observes', 'link:define-product-intent', 'Upstream desk 1: repair across every emission (e49d8d11, 6c9c8324, 04632094); NOT accepted.'),
  rel(S, 'observes', 'link:model-use-cases', 'Upstream desk 2: never reviewed at its own content address; authored in violation of its desk hold; NOT accepted.'),
  rel(S, 'observes', 'link:derive-system-requirements', 'Upstream desk 3: repair + re-staff confirmation; reviewer seat held; NOT accepted.'),
  rel(S, 'observes', 'link:define-acceptance-contract', 'Upstream desk 4: adjudicated repair (emission C); desk on record hold; NOT accepted.'),
  rel(S, 'observes', 'link:reconcile-what', 'Upstream desk 5 (the gate): repair verdict of record; NOT accepted.'),
  rel(S, 'observes', 'UH-Model-Use-Cases-001', 'The standing r2 upstream hold of the model-use-cases desk.'),
  rel(S, 'observes', 'UH-Define-Acceptance-Contract-001', 'The standing r3 upstream hold of the define-acceptance-contract desk.'),
  rel(S, 'observes', 'FR-Define-Acceptance-Contract-002', 'The adjudicating emission C of the acceptance desk: repair confirmed, the accepted emission superseded.'),
  rel(S, 'observes', 'r1stray:architecture-contract', 'The upstream desk own r1 stray product at its RECOMPUTED content address; declared self-address a926df6284... is drifted; NOT lineage (retired).'),
  rel(S, 'observes', 'r1verdict:architecture-contract', 'The pre-regime r1 gate verdict (approved) over the upstream stray product; history, not acceptance of record.'),
  rel(S, 'observes', 'VV-Define-Product-Intent-001', 'The r2 recomputation that documented the CRIT-003 digest-drift family.'),
  rel(S, 'observes', 'r1selfstray:settle-reviewer-decision', 'THIS desk own r1 reviewer-seat stray decision, addressed at the RAW-BYTES layer (the file is not parseable JSON, so no canonical content address exists); fabrication provenance, NOT lineage.'),
  rel(S, 'observes', 'r1selfstray:settle-reviewer-submission', 'THIS desk own r1 reviewer-seat stray submission, addressed at the RAW-BYTES layer; label pseudo-addresses + phantom pins inside; fabrication provenance, NOT lineage.'),
  rel(S, 'observes', 'r1selfstray:settle-reviewer-trace', 'THIS desk own r1 reviewer-seat stray trace, addressed at the RAW-BYTES layer; pins the phantom set and the drifted anchor; fabrication provenance, NOT lineage.'),
  rel(S, 'observes', 'r1selfstray:phantom-candidate-set', 'The phantom candidate set f975e878... fabricated by the r1 reviewer-seat family; unresolvable workspace-wide; recorded as provenance, never ratified.'),
  rel(S, 'observes', 'schema:what-baseline', 'The freeze payload contract (raw sha256 ab1b7f5e..., acceptanceRecords minItems 5): the root lawful-authoring blocker of the upstream chain.'),
  rel(S, 'observes', 'framepin:protocol-skill', 'The frame protocol-skill pin: unresolvable inherited r2/r3-era anchor; also the upstream desk r1 stray drifted address and the trace pin of this desk own r1 reviewer stray; REFUSED as authority.'),
  rel(S, 'observes', 'framepin:semantic-skill', 'The frame semantic-skill pin: unresolvable r3-era frame pin; REFUSED as authority.'),
  rel(S, 'observes', 'installed:protocol-skill', 'The installed manifest protocol skill digest (recomputed): the only lawful protocol authority; differs from the frame pin.'),
  rel(S, 'observes', 'installed:semantic-skill', 'The installed manifest semantic skill digest for THIS desk (recomputed): the only lawful semantic authority; differs from the frame pin.'),
];

const traceContent = {
  deskRef: 'settle-formalization',
  role: 'author',
  traceKind: 'upstream-hold-trace',
  subjectSemanticCode: S,
  subjectArtifactRef: artifact.artifactRef,
  relationVocabulary: ['observes', 'verifies'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: [S] }])),
  holdCoverage: {
    noProductAuthored: true,
    upstreamDesksTotal: 7,
    upstreamDesksAccepted: 0,
    unacceptedLinks: ['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements', 'link:define-acceptance-contract', 'link:reconcile-what'],
    freezeCandidateExists: false,
    freezeRatified: false,
    srsCandidateExists: false,
    onlyAcceptedChain: 'import:discovery-handoff',
    gateEdgeBlocked: 'define-architecture-contract --domain.accepted--> settle-formalization never lawfully fired',
    upstreamGateState: 'UH-Define-Architecture-Contract-001 (r5 author hold; no reviewer round at its content address)',
    freezeVerdictOfRecord: 'FR-Freeze-What-Baseline-002 (hold-upheld; freeze ratification refused)',
    noAcceptProhibitionDischarged: false,
    projectedLadderOutcomeIfRun: 'failed (MISSING_LINEAGE at R1; SETTLE_OUTCOME_OF_REASON)',
  },
  branchResolutionNote: 'No scenario, branch, requirement, criterion, surface, realization-entry, baseline, SRS-revision or solution-contract identities are authored by this hold; all observed links resolve at record/artifact granularity.',
  workspaceSummary: WS,
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'upstream-hold-trace',
  contentDigest: sha(traceContent),
  createdAt: CREATED_AT,
  deskRef: 'settle-formalization',
  role: 'author',
  reviewedRound: SELF_ROUND,
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

/* ------------------------------------------------------------------ */
/* Submission summary (authored deterministically)                      */
/* ------------------------------------------------------------------ */

const summary = `# settle-formalization desk (author) - settlement upstream hold (stray-products-r6)

Emission of record: **UH-Settle-Formalization-001** (formalization.upstream-hold.v1,
decision \`hold-no-authoring\`, noProductAuthored: true).

- Artifact: ${artifact.artifactRef}
- Trace: ${trace.traceRef}

## Why this desk authors nothing

The desk's only lawful output is the sealed solution contract
(\`frf-contracts.solution-contract.v1\`, provider
\`formalization.settlement-structure.v1\`/\`settleSolutionContract\`, effect
\`formalization.settle-solution-contract\`), settled over the single inbound edge
\`define-architecture-contract --domain.accepted--> settle-formalization\` through
the three-rung ladder: R1 authority-pins (all five input classes:
frozenBaseline, baselineArtifact, srs, repositoryPolicyRefs, handoff -
settlement never discovers authorities), R2 binding-resolution (the twelve
handoff kinds non-empty and resolved against the frozen developmentSurface
declaration; FOREIGN_LINEAGE otherwise - the UC-FOREIGN kill), R3 sealed-contract
(canonical digest + the self-seal surface; the A2 settler fence).

Recomputed truth of this chain: **0 of 7** accepted upstream desks. No
WHAT-baseline has ever existed (freeze hold \`9f2d28b9...\`, upheld by
FR-Freeze-What-Baseline-002 \`d52746b6...\`, freeze ratification REFUSED) and no
SRS candidate has ever been authored (the immediate upstream desk is itself on
record hold UH-Define-Architecture-Contract-001 \`6a32f180...\`, r5 verifier
29/29). ALL FIVE settlement input classes are absent: any lawful ladder run
refuses at R1 with \`MISSING_LINEAGE\`, routed by the frozen table to the outcome
\`failed\`. This author seat fires no domain edge; the hold is the emission of
record. Every fabrication path is typed-refused (forged pin -> DRIFT_DETECTED;
invented binding -> FOREIGN_LINEAGE; bodiless self-seal -> MALFORMED_PRODUCT),
so no honest solution contract can exist on this staffing.

## This desk's own stray-product record (r1 reviewer seat)

The r1 family \`settle-formalization-reviewer-{decision,product-submission,trace}.json\`
fabricated an entire claim universe (7 invented refs + phantom candidate set
\`f975e878...\`), declared \`acceptedUpstreamRevisions: 1\` against this frame's 0,
declared the unknown resolved against the D10 carry law, pinned its trace
identity to the drifted anchor \`a926df6284...\`, "accepted" a product kind that is
not the installed kind, and its decision file is not parseable JSON at all
(raw-bytes address \`ad698a85...\`). None of it is lineage; retired (resume
contract R5).

## Frame adjudication (this round)

- workspace summary "${WS}" - adjudicated **TRUE** (census 0 of 7; only accepted base: the discovery import chain).
- protocol-skill pin \`a926df6284...\` - the inherited r2/r3-era anchor, doubly identified (the upstream desk's r1 stray drifted address; the trace pin inside this desk's own r1 reviewer stray). Hash-resolves to zero contents; not the installed protocol skill (\`b88267a1...\` recomputes). **REFUSED as authority**; recorded verbatim.
- semantic-skill pin \`95fafc847b...\` - the r3-era frame semantic pin. Hash-resolves to zero contents; not the installed semantic skill for this desk (recomputed at build). **REFUSED as authority**; recorded verbatim.

## Resume contract

R1: the freeze desk resume contract R1-R4 completes first (five genuinely
accepted pre-freeze desks -> RA-5 reconcile-what re-run -> freeze ratified).
R2: the SRS desk re-staffs against the REAL frozen baseline, authors and passes
review on a genuine sealed SRS; domain.accepted fires only from that revision.
R3: this desk re-staffs only with ALL FIVE input classes. R4: settlement runs
the ladder exactly (pins -> binding resolution -> seal; A2 fence). R5: this hold
and the r1 reviewer-seat stray family are never carried as product lineage.
`;

/* ------------------------------------------------------------------ */
/* Write                                                                */
/* ------------------------------------------------------------------ */

const writeText = (name, value) => writeFileSync(join(DIR, name), value, 'utf8');
writeText('settle-formalization-desk-upstream-hold.artifact.json', `${JSON.stringify(artifact, null, 2)}\n`);
writeText('settle-formalization-desk-upstream-hold-trace.json', `${JSON.stringify(trace, null, 2)}\n`);
writeText('settle-formalization-desk-hold-submission-summary.md', summary);

console.log(JSON.stringify({
  built: 'settle-formalization desk (author) settlement upstream hold',
  round: SELF_ROUND,
  semanticCode: artifact.semanticCode,
  artifactRef: artifact.artifactRef,
  traceRef: trace.traceRef,
  envelopeRecomputed: '8/8 (+CERT-1)',
  acceptedUpstreamDesks: '0 of 7',
  projectedLadderOutcome: 'failed (MISSING_LINEAGE at R1; not fired by this seat)',
  freezeVerdictOfRecord: 'FR-Freeze-What-Baseline-002 (hold-upheld; freeze ratification refused)',
  upstreamGateState: 'UH-Define-Architecture-Contract-001 (r5 author hold; no SRS candidate exists)',
  selfStrayFamilyRecorded: 'r1 reviewer-seat family retired (decision unparseable; 8 phantom addresses)',
  framePinsAdjudicated: 'both REFUSED as authority (unresolvable; not the installed manifest pins)',
  unresolvableInstances: artifactContent.unresolvableInstances.length,
}, null, 2));
