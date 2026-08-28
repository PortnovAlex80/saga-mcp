/**
 * define-architecture-contract desk (author) - SRS UPSTREAM HOLD builder.
 *
 * Emission: UH-Define-Architecture-Contract-001 (stray-products-r5,
 * author seat). Deterministic authoring.
 *
 * This desk (the installed manifest node define-architecture-contract,
 * production cell, output product kind formalization.srs.v1, check
 * provider formalization.srs-structure.v1 / validateSrs) consumes the
 * FROZEN WHAT baseline over the edge freeze-what-baseline
 * --domain.frozen--> define-architecture-contract and seals the
 * architecture contract only against an ACCEPTED id-set universe
 * (frozen scenario ids, frozen evidence-binding ids, the frozen
 * whatBaselineDigest pin AND an accepted srsRevisionDigest pin). The
 * desk is fail-closed: without an accepted srsRevisionDigest pin it
 * refuses MISSING_LINEAGE and will not seal against a guessed SRS
 * revision; against any id set not supplied it refuses FOREIGN_LINEAGE;
 * it never scans, guesses or reselects accepted material.
 *
 * On this chain NONE of that input exists: the recomputed census is 0 of
 * 6 accepted upstream desks (five pre-freeze desks + the freeze desk
 * itself), the freeze desk has NEVER produced a WHAT-baseline candidate
 * (its author seat is on record hold UH-Freeze-What-Baseline-001
 * 9f2d28b9..., upheld by RC-Freeze-What-Baseline-001 c19344fd... and
 * re-upheld by the r4 reviewer emission FR-Freeze-What-Baseline-002
 * d52746b6..., which adjudicated the r4 frame's fixture-as-accepted-
 * revision claim as REFUSED and refused freeze ratification), so the
 * domain.frozen edge into this desk has never lawfully fired. Authoring
 * an SRS now would fabricate exactly the accepted-upstream authority
 * this series spent r2-r4 refusing - the stray-product failure class
 * this desk itself authored once already (the r1 stray product
 * AC-Define-Architecture-Contract-001, whose DECLARED self-address
 * a926df6284... drifts from its recomputed content address f4846e5f...,
 * r1 CRIT-003 digest-drift family). Per the r2/r3 upstream-hold
 * precedent (UH-Model-Use-Cases-001, UH-Define-Acceptance-Contract-001,
 * UH-Freeze-What-Baseline-001) this desk therefore authors NO SRS
 * material and issues a hold record.
 *
 * Frame adjudication (this round's delta): the task frame pins
 * protocol-skill a926df6284... - the SAME inherited r2/r3-era anchor
 * debt, which is ALSO the declared (drifted) self-address of this desk's
 * own r1 stray product - and semantic-skill 95fafc847b..., the r3-era
 * frame semantic pin. Both hash-resolve to ZERO workspace contents
 * (re-scanned by this build's verifier); neither matches the installed
 * manifest skill digests (recomputed b88267a1... / 131efbd9...); both
 * are recorded verbatim as envelope provenance and REFUSED as authority.
 * The frame's workspace summary ("0 accepted upstream revisions travel
 * by content address") is adjudicated TRUE of the chain (census 0 of 6).
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
const SELF_ROUND = 'stray-products-r5';
const WS = '0 accepted upstream revisions travel by content address';

/* The r2/r3-era frame pins carried by THIS desk task frame (verbatim). */
const PIN_PROTOCOL = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const PIN_SEMANTIC = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';
/* The installed manifest skill digests (recomputed below, structural). */
const INSTALLED_PROTOCOL = 'b88267a1df84ae503d0e9744734a26671506f7bb719cb7b457f8d5ad6745997f';
const INSTALLED_SEMANTIC = '131efbd99bd2d92e0ac790ab9c271218d0a72995df0053fc35cbffc4d7f176f3';
/* This desk's own r1 stray product: declared vs recomputed (drift of record). */
const R1_STRAY_FILE = 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-desk-architecture-contract.artifact.json';
const R1_STRAY_DECLARED = PIN_PROTOCOL;
const R1_STRAY_RECOMPUTED = 'f4846e5fed6808f8b0c33b14d58a337d9f72eddd02bf775bc048862b1d5626af';

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

const record = (relPath) => {
  const j = JSON.parse(readFileSync(join(REPO, relPath), 'utf8'));
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

/* THIS desk's own r1 stray product: the declared-address drift, recomputed. */
const r1StrayBytes = readFileSync(join(REPO, R1_STRAY_FILE));
const r1Stray = JSON.parse(r1StrayBytes.toString('utf8'));
expect(r1Stray.contentDigest === R1_STRAY_DECLARED, 'r1 stray declared address drift');
const r1StrayActual = sha(r1Stray.content);
expect(r1StrayActual === R1_STRAY_RECOMPUTED, 'r1 stray recomputed content address drift');
expect(r1StrayActual !== r1Stray.contentDigest, 'r1 stray drift unexpectedly resolved');
expect(r1Stray.semanticCode === 'AC-Define-Architecture-Contract-001' && r1Stray.deskRef === 'define-architecture-contract', 'r1 stray identity drift');
/* The r1 trace of this desk declares the same drifted address. */
const r1TraceRaw = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-trace.json'), 'utf8'));
expect(r1TraceRaw.traceDigest === R1_STRAY_DECLARED && r1TraceRaw.deskRef === 'define-architecture-contract', 'r1 desk trace drift identity');
/* The r2 recomputation that documented the drift family. */
const v2Drift = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-verification.json');
expect(v2Drift.contentDigest === 'c0215ebcbf494c3d4c71c7e8f342cfa91eb9dddcf6f50f78f5d20f4b0be7579a', 'VV-Define-Product-Intent-001 drift');
expect(JSON.stringify(v2Drift.raw.content).includes(R1_STRAY_RECOMPUTED) && JSON.stringify(v2Drift.raw.content).includes('CRIT-003'), 'r2 drift-evidence record no longer cites the drift family');
/* The r1 gate verdict (old-format record, addressed at the whole-file layer). */
const r1VerdictParsed = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-review-verdict.json'), 'utf8'));
const r1VerdictDigest = shaRaw(Buffer.from(canon(r1VerdictParsed), 'utf8'));
expect(r1VerdictParsed.verdict === 'approved' && r1VerdictDigest === 'bc1c5e59f1555eee27d7bf62e82f0578208af749f025621f6e0d102128a94252', 'r1 gate verdict drift');

/* The freeze payload contract itself: the root lawful-authoring blocker. */
const schemaPath = join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json');
const schemaBytes = readFileSync(schemaPath);
const schemaRawDigest = shaRaw(schemaBytes);
expect(schemaRawDigest === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09', 'what-baseline schema raw digest drift');
const schema = JSON.parse(schemaBytes.toString('utf8'));
expect(schema.properties.acceptanceRecords.minItems === 5, 'what-baseline acceptanceRecords minItems drift');
expect(schema.properties.schemaVersion.const === 'frf-contracts.what-baseline.v1', 'what-baseline schemaVersion drift');

/* The installed desk contract facts (src/workflow-kernel manifest + cell). */
const manifestSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'manifest.ts'), 'utf8');
expect(manifestSrc.includes("id: 'define-architecture-contract'") && manifestSrc.includes("outputProductKind: 'formalization.srs.v1'") && manifestSrc.includes("checkProviderId: 'formalization.srs-structure.v1'"), 'installed manifest desk row drift');
expect(manifestSrc.includes("{ from: 'freeze-what-baseline', to: 'define-architecture-contract', on: 'domain.frozen' }"), 'installed manifest inbound edge drift');
expect(manifestSrc.includes("{ from: 'define-architecture-contract', to: 'settle-formalization', on: 'domain.accepted' }"), 'installed manifest outbound accepted edge drift');
const deskSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'srs-realization', 'desk.ts'), 'utf8');
expect(deskSrc.includes('no accepted srsRevisionDigest pin was supplied'), 'desk fail-closed MISSING_LINEAGE law drift');
const contractSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'srs-realization', 'contract.ts'), 'utf8');
expect(contractSrc.includes("SRS_REALIZATION_SECTION_KIND = 'formalization.srs-realization.v1'"), 'SRS realization section kind drift');
expect(contractSrc.includes("SRS_TRACE_RULE = 'srs-derived-from-frozen-what-baseline'"), 'SRS trace rule drift');
/* The installed skill digests, recomputed by the documented canonical rule. */
const shaOfCanonical = (v) => sha(v);
const installedProtocolRecomputed = shaOfCanonical({ skillId: 'saga-process-module-worker-protocol', kind: 'protocol' });
const installedSemanticRecomputed = shaOfCanonical({ skillId: 'formalization-desk-define-architecture-contract', kind: 'semantic', desk: 'define-architecture-contract' });
expect(installedProtocolRecomputed === INSTALLED_PROTOCOL, 'installed protocol skill digest drift');
expect(installedSemanticRecomputed === INSTALLED_SEMANTIC, 'installed semantic skill digest drift');
expect(PIN_PROTOCOL !== INSTALLED_PROTOCOL && PIN_SEMANTIC !== INSTALLED_SEMANTIC, 'frame pins unexpectedly match the installed manifest');

/* ------------------------------------------------------------------ */
/* Unresolvable instance asserted in this hold (scan-proofed by the     */
/* verifier: zero hash-resolutions workspace-wide, r5 excluded)         */
/* ------------------------------------------------------------------ */

const UNRESOLVABLE = [
  {
    id: 'protocol-skill pin',
    address: shaRef(PIN_PROTOCOL),
    role: 'protocol-skill layer digest of this desk task frame; the SAME inherited r2/r3-era anchor carried by every r2/r3 desk frame as governingContractRef, dropped by the r4 frame, and returned by this frame',
    extraIdentity: `also the DECLARED (drifted) self-address of this desk's own r1 stray product ${R1_STRAY_FILE} (recomputed content address ${shaRef(R1_STRAY_RECOMPUTED)}, r1 CRIT-003 digest-drift family)`,
    evidence: 'no content in the workspace hashes to this address (raw bytes, whole-JSON canonical, or .content canonical); recorded as envelope provenance, never ratified',
  },
  {
    id: 'semantic-skill pin',
    address: shaRef(PIN_SEMANTIC),
    role: 'semantic-skill layer digest of this desk task frame; the SAME r3-era frame semantic pin carried by the r3 desk frames (e.g. reconcile-what SEMANTIC_SKILL) and the r1 formalization section pins',
    evidence: 'no content in the workspace hashes to this address; not the installed manifest semantic digest (recomputed 131efbd9...); recorded as envelope provenance, never ratified',
  },
];

/* ------------------------------------------------------------------ */
/* The hold artifact                                                    */
/* ------------------------------------------------------------------ */

const artifactContent = {
  schemaVersion: 'formalization.upstream-hold.v1',
  deskRef: 'define-architecture-contract',
  deskNodeId: 'define-architecture-contract',
  role: 'author',
  itemInstanceId: 'formalization-item:define-architecture-contract',
  token: 'plan:formalization#item:srs-realization',
  holdKind: 'srs-upstream-hold',
  decision: 'hold-no-authoring',
  statement: 'The define-architecture-contract desk authors NO SRS material in this staffing. The desk contract (installed manifest: production cell, output product kind formalization.srs.v1, check provider formalization.srs-structure.v1/validateSrs, effect formalization.accept-products) consumes the FROZEN WHAT baseline over the single inbound edge freeze-what-baseline --domain.frozen--> define-architecture-contract, and seals the architecture contract only against an ACCEPTED id-set universe: the frozen scenario id set (containers.uc.scenarioIds), the frozen evidence-binding id set, the frozen whatBaselineDigest pin AND an accepted srsRevisionDigest pin. The desk is fail-closed by its own cell law: without an accepted srsRevisionDigest pin it refuses MISSING_LINEAGE and "will not seal against a guessed SRS revision"; against any reference class whose accepted set was not supplied it refuses FOREIGN_LINEAGE; it never scans, guesses or reselects accepted material. On this chain NONE of that input exists: the recomputed census is 0 of 6 accepted upstream desks. (1) define-product-intent a06dbc57... - repair across every emission (e49d8d11..., 6c9c8324..., 04632094...), no author reissue. (2) model-use-cases 24f0aff2... - never reviewed at its own content address (the only UC verdict pins a different candidate c6120e86...), authored in violation of its desk hold 6cccd162.... (3) derive-system-requirements 86b00569... - repair d31b044c..., re-staff confirmation 1c30d28e..., reviewer seat held (fbc0394b..., b4eaaaba...). (4) define-acceptance-contract 2b01353d... - adjudicated repair (FR-Define-Acceptance-Contract-002 7e76176c... emission C), desk on record hold a53a5e08.... (5) reconcile-what 6400a2dd... - repair verdict of record FR-Reconcile-What-001 39a94a29... (emission A per CL-Reconcile-What-001 841194ce...) with the no-accept prohibition toward freeze-what-baseline undischarged. (6) freeze-what-baseline - NO WHAT-baseline candidate has ever existed: the author seat is on record hold UH-Freeze-What-Baseline-001 9f2d28b9... (trace 17c09566..., hold-no-authoring), re-verified standing by AS-Freeze-What-Baseline-001 c2a08f04... (0 new accepted lineage since hold), upheld by RC-Freeze-What-Baseline-001 c19344fd... (hold-upheld-no-candidate-to-review), and re-upheld by the r4 reviewer emission FR-Freeze-What-Baseline-002 d52746b6... (verify 8b041010..., trace 8bf4f283..., submission 6f5294a9...; 50/50 verifier green), which adjudicated the r4 frame\'s upstream-accepted entry as REFUSED (fixture-misdeclared-as-accepted-revision) and REFUSED freeze ratification. The freeze contract itself (frf-contracts.what-baseline.v1, schema raw sha256 ab1b7f5e..., acceptanceRecords minItems 5) recomputes as the direct blocker: 0 of 5 accepted pre-freeze desks. Therefore the domain.frozen edge into THIS desk has never lawfully fired, and no accepted srsRevisionDigest pin exists. Authoring an SRS now would fabricate exactly the accepted-upstream authority this series spent r2-r4 refusing - and this desk authored that failure class once already: its r1 stray product AC-Define-Architecture-Contract-001 declares self-address a926df6284... while its content recomputes to f4846e5f... (r1 CRIT-003 digest-drift family, recomputed by VV-Define-Product-Intent-001 c0215ebc...), approved only by the pre-regime r1 gate verdict bc1c5e59... which carries no content-addressed reviewer stage at the product\'s recomputed address. That stray product is NOT lineage: it is not resumed, not repaired in place, not re-submitted. Per the r2/r3 upstream-hold precedent (UH-Model-Use-Cases-001 6cccd162..., UH-Define-Acceptance-Contract-001 a53a5e08..., UH-Freeze-What-Baseline-001 9f2d28b9...) this desk issues a hold. Only the discovery import chain is genuinely accepted (import artifact b10bb762... recomputes; all 9 capsule sub-artifact digests recompute and match this desk task envelope 8/8 including CERT-1).',
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
    deskId: 'define-architecture-contract',
    nodeKind: 'production-cell',
    outputProductKind: 'formalization.srs.v1',
    checkProviderId: 'formalization.srs-structure.v1',
    validator: 'validateSrs',
    effectId: 'formalization.accept-products',
    inboundEdge: { from: 'freeze-what-baseline', on: 'domain.frozen' },
    outboundEdges: [
      { to: 'settle-formalization', on: 'domain.accepted' },
      { to: 'complete-failed', on: 'domain.failed' },
    ],
    inputContractKinds: ['frf-contracts.what-baseline.v1', 'formalization.srs-realization.v1'],
    acceptedUniverseRequired: {
      idSets: ['frozen uc scenario ids (containers.uc.scenarioIds)', 'frozen evidence-binding ids (baseline evidenceBindings)'],
      revisionPins: ['frozen whatBaselineDigest (sha256 hex)', 'accepted srsRevisionDigest (sha256 hex)'],
    },
    failClosedLaw: 'MISSING_LINEAGE without an accepted srsRevisionDigest pin ("the desk is fail-closed and will not seal against a guessed SRS revision"); FOREIGN_LINEAGE against any reference class whose accepted set was not supplied; the cell never scans, guesses or reselects accepted material',
    traceRule: 'srs-derived-from-frozen-what-baseline',
    surfaceKinds: ['composition', 'infrastructure'],
    obligationKinds: ['infrastructure-obligation', 'integration-or-composition-obligation'],
    postFreezeSurfaces: ['postFreeze.srs.realizationEntryIds', 'postFreeze.srs.revisionDigest', 'postFreeze.srs.surfaces'],
    source: 'src/workflow-kernel/workshops/formalization/manifest.ts + cells/srs-realization/{desk,contract}.ts (re-verified by this build)',
  },
  upstreamGate: {
    deskId: 'freeze-what-baseline',
    candidateOfRecord: {
      semanticCode: 'UH-Freeze-What-Baseline-001',
      artifactRef: shaRef(holdArt.contentDigest),
      traceRef: shaRef(holdTrc.contentDigest),
      productKind: 'formalization.upstream-hold.v1',
      declaredDecision: 'hold-no-authoring',
      status: 'the candidate of record at the upstream desk; NO WHAT-baseline candidate exists (none was ever lawfully authorable on this chain)',
    },
    verdictOfRecord: {
      semanticCode: 'FR-Freeze-What-Baseline-002',
      verdict: 'hold-upheld',
      reviewRef: shaRef(frR4.contentDigest),
      verificationRef: shaRef(vvR4.contentDigest),
      reviewerTraceRef: shaRef(rtR4.contentDigest),
      reviewerSubmissionRef: shaRef(fsR4.contentDigest),
      decision: 'REFUSE freeze ratification; adjudicate the r4 frame upstream-accepted claim as REFUSED (fixture-misdeclared-as-accepted-revision); uphold UH-Freeze-What-Baseline-001',
      verifierGreen: `${r4VerifyOut.summary.pass}/${r4VerifyOut.summary.total}`,
    },
    confirmations: [
      {
        semanticCode: 'AS-Freeze-What-Baseline-001',
        recordRef: shaRef(asConf.contentDigest),
        fact: 'author re-staff confirmation: hold STANDING, 0 new accepted lineage since hold',
      },
      {
        semanticCode: 'RC-Freeze-What-Baseline-001',
        recordRef: shaRef(rcConf.contentDigest),
        traceRef: shaRef(rcTrc.contentDigest),
        fact: 'reviewer confirmation: hold-upheld-no-candidate-to-review; the r3 frame upstream-accepted claim not ratified',
      },
    ],
    explicitProhibition: 'No WHAT-baseline exists; therefore no domain.frozen input exists for define-architecture-contract. The upstream no-accept prohibition ("No domain.accepted may fire from this desk toward freeze-what-baseline on this chain", recomputed from FR-Reconcile-What-001 nextStage) stands undischarged, and the freeze ratification itself is refused by FR-Freeze-What-Baseline-002.',
    prohibitionSource: 'recomputed from FR-Reconcile-What-001 nextStage + FR-Freeze-What-Baseline-002 decision/verdict-of-record',
    gateEdgeBlocked: 'freeze-what-baseline --domain.frozen--> define-architecture-contract has never lawfully fired on this chain',
  },
  chainAcceptanceCensus: {
    upstreamDeskCount: 6,
    acceptedUpstreamDeskCount: 0,
    schemaRef: 'docs/refactoring/formalization-frf/contracts/schemas/what-baseline.schema.json',
    schemaRawSha256: schemaRawDigest,
    contractLaw: 'the freeze contract demands 5 accepted pre-freeze desks (acceptanceRecords minItems 5) before any WHAT-baseline exists; this desk consumes that baseline over the domain.frozen edge; every desk counts only through an accepted reviewer verdict at its own content address',
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
    ],
  },
  strayProductHistory: {
    r1StrayProduct: {
      file: R1_STRAY_FILE,
      semanticCode: 'AC-Define-Architecture-Contract-001',
      declaredContentDigest: shaRef(r1Stray.contentDigest),
      recomputedContentDigest: shaRef(r1StrayActual),
      drift: 'DECLARED != RECOMPUTED (r1 CRIT-003 digest-drift family; recomputed by VV-Define-Product-Intent-001 c0215ebc...)',
      r1GateVerdict: {
        file: 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-review-verdict.json',
        verdict: r1VerdictParsed.verdict,
        wholeFileCanonDigest: shaRef(r1VerdictDigest),
        standing: 'pre-regime history: predates the r2-r4 adjudication regime, carries no content-addressed reviewer stage at the recomputed product address; NOT acceptance of record',
      },
      disposition: 'NOT lineage: not accepted, not resumed, not repaired in place, not re-submitted; any future SRS of this desk is a NEW sealed revision',
    },
    r1DeskTrace: {
      file: 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-trace.json',
      fact: 'the r1 desk trace declares the same drifted address (traceDigest a926df6284...)',
    },
    lesson: 'this desk knows the stray-product failure class from its own record; the hold is the corrected behavior',
  },
  frameAdjudication: {
    workspaceSummary: {
      claim: WS,
      adjudication: 'TRUE of the chain: recomputed census 0 of 6 accepted upstream desks; the only accepted base is the discovery import chain',
    },
    protocolSkillPin: {
      address: shaRef(PIN_PROTOCOL),
      layer: 'protocol-skill',
      resolution: 'unresolvable: zero hash-resolutions workspace-wide (verifier re-scans; r4 reviewer scan concurs)',
      extraIdentity: `identifies this desk's own r1 stray product by DECLARATION (drifted self-address); recomputed stray address ${shaRef(R1_STRAY_RECOMPUTED)}`,
      installedManifestPin: shaRef(INSTALLED_PROTOCOL),
      adjudication: 'REFUSED as authority - unresolvable at the content layer, self-referential to this desk\'s stray product, and not the installed protocol skill; recorded verbatim as envelope provenance',
    },
    semanticSkillPin: {
      address: shaRef(PIN_SEMANTIC),
      layer: 'semantic-skill',
      resolution: 'unresolvable: zero hash-resolutions workspace-wide; the SAME r3-era frame semantic pin (reconcile-what SEMANTIC_SKILL; r1 formalization section pins)',
      installedManifestPin: shaRef(INSTALLED_SEMANTIC),
      adjudication: 'REFUSED as authority - unresolvable and not the installed semantic skill; recorded verbatim as envelope provenance',
    },
    frameFamilyHistory: 'the r2/r3 frames carried a926df6284... as the protocol-skill governingContractRef; the r4 frame dropped it (recording the debt as inherited); THIS frame carries it again as the protocol-skill layer digest - the anchor debt returns, now additionally identified as this desk\'s own drifted stray-product address. The installed manifest pins (recomputed) remain the only lawful skill authority, and this hold depends on neither frame pin.',
  },
  unresolvableInstances: UNRESOLVABLE.map((u) => ({ ...u, resolved: false })),
  noProductAuthored: true,
  fence: {
    forbiddenProductSections: [
      'schemaVersion: formalization.architecture-contract.v1',
      'lineage (traceRule/baselineRef/srsRevisionDigest)',
      'realization.realizationEntries (realizationEntryId, scenarioRef, entrypointSurfaceRef, participatingSurfaceRefs, runtimeEdges, externalInterfaces, implementationSurfaceRefs, compositionOwnerSurfaceRef, terminalResult, evidenceBinding)',
      'realization.surfaces (surfaceId, surfaceKind composition|infrastructure, realizedScenarioRefs)',
      'developmentObligations (integrationOrComposition, infrastructure)',
      'postFreeze.srs.* (realizationEntryIds, surfaces, revisionDigest)',
      'canonicalDigest',
    ],
    observed: 'this hold is a desk artifact, not an SRS product: no realization entry, surface, runtime edge, obligation binding, post-freeze resolution surface or canonical SRS digest is authored; the 8 task-projection claims are observed as content addresses only, and unknown:browser-matrix-1 derives nothing',
  },
  acceptanceLaws: [
    { id: 1, description: 'constraint:retention-1 honored - no disposition, binding or retention decision authored by this seat', satisfied: true },
    { id: 2, description: 'unknown:browser-matrix-1 carried forward, never resolved by this hold', satisfied: true },
    { id: 3, description: 'terminal:audited-1 and terminal:delivered-1 observed as content addresses only; no terminal lifecycle effect authored', satisfied: true },
  ],
  resumeContract: [
    'R1: the freeze desk resume contract R1-R4 (UH-Freeze-What-Baseline-001, upheld by FR-Freeze-What-Baseline-002) completes FIRST: genuinely accepted revisions land for define-product-intent, model-use-cases, derive-system-requirements and define-acceptance-contract through completed reviewer stages at their own content addresses; RA-5 re-runs reconcile-what over the NEW accepted chain; the re-run reviewer verdict alone discharges the no-accept prohibition; the freeze ratifies on five accepted pre-freeze desks (acceptanceRecords minItems 5)',
    'R2: domain.frozen fires only from the ratified freeze; this desk is re-staffed with an envelope whose upstream material carries the REAL frozen WHAT-baseline revision (frf-contracts.what-baseline.v1 at its own content address) - never a fixture, never a stray product, never a frame assertion',
    'R3: this desk then authors the architecture contract strictly per the desk contract: parse the SRS realization draft (closed vocabulary) -> validate against the accepted id-set universe (frozen scenario ids, frozen evidence-binding ids, whatBaselineDigest + accepted srsRevisionDigest pins) -> seal with recomputed canonical digests; every surface cited with the scenarios it realizes; MISSING_LINEAGE and FOREIGN_LINEAGE remain typed refusals, never silently repaired',
    'R4: this hold is not carried as product lineage; the future architecture contract cites only the accepted baseline pin, the accepted SRS revision pin and accepted material',
    'R5: the r1 stray product AC-Define-Architecture-Contract-001 stays retired: not resumed, not repaired in place, not re-submitted; its drifted declared address (a926df6284...) is never used as a lineage ref',
  ],
  verification: {
    declaredDigestsTrusted: false,
    importArtifactDigestRecomputed: true,
    capsuleSubArtifactDigestsRecomputed: true,
    envelopeProjectionDigestsRecomputed: true,
    citedRecordDigestsRecomputed: true,
    r4ReviewerRoundRecomputed: true,
    r1StrayDriftRecomputed: true,
    installedSkillDigestsRecomputed: true,
    schemaRawDigestRecomputed: true,
    unresolvableInstancesEnumerated: UNRESOLVABLE.map((u) => u.address),
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
  semanticCode: 'UH-Define-Architecture-Contract-001',
  createdAt: CREATED_AT,
  deskRef: 'define-architecture-contract',
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
  if (id === 'UH-Define-Architecture-Contract-001') return sha(artifactContent);
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
  if (id === 'r1stray:architecture-contract') return r1StrayActual;
  if (id === 'r1verdict:architecture-contract') return r1VerdictDigest;
  if (id === 'VV-Define-Product-Intent-001') return v2Drift.contentDigest;
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

const S = 'UH-Define-Architecture-Contract-001';
const relationships = [
  ...Object.keys(ENVELOPE).map((id) => rel(
    S, 'verifies', id,
    `The hold's envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection.`,
  )),
  rel(S, 'observes', 'import:discovery-handoff', 'The accepted discovery import chain is the only accepted base this hold is grounded in (content digest recomputed).'),
  rel(S, 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel(S, 'observes', 'UH-Freeze-What-Baseline-001', 'The upstream desk candidate of record: the freeze author hold (hold-no-authoring); NO WHAT-baseline candidate exists.'),
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
  rel(S, 'observes', 'UH-Define-Acceptance-Contract-001', 'The standing r3 upstream hold of the define-acceptance-contract desk; its resume contract precedes this desk re-staffing.'),
  rel(S, 'observes', 'FR-Define-Acceptance-Contract-002', 'The adjudicating emission C of the acceptance desk: repair confirmed, the accepted emission superseded.'),
  rel(S, 'observes', 'r1stray:architecture-contract', 'THIS desk\'s own r1 stray product at its RECOMPUTED content address; declared self-address a926df6284... is drifted; NOT lineage (retired per resume contract R5).'),
  rel(S, 'observes', 'r1verdict:architecture-contract', 'The pre-regime r1 gate verdict (approved) over the stray product; history, not acceptance of record; no content-addressed reviewer stage at the recomputed product address.'),
  rel(S, 'observes', 'VV-Define-Product-Intent-001', 'The r2 recomputation that documented the CRIT-003 digest-drift family including this desk\'s r1 stray product.'),
  rel(S, 'observes', 'schema:what-baseline', 'The freeze payload contract (raw sha256 ab1b7f5e..., acceptanceRecords minItems 5): the root lawful-authoring blocker of the upstream chain.'),
  rel(S, 'observes', 'framepin:protocol-skill', 'The frame protocol-skill pin: unresolvable inherited r2/r3-era anchor; ALSO this desk\'s r1 stray product drifted declared address; REFUSED as authority.'),
  rel(S, 'observes', 'framepin:semantic-skill', 'The frame semantic-skill pin: unresolvable r3-era frame pin; REFUSED as authority.'),
  rel(S, 'observes', 'installed:protocol-skill', 'The installed manifest protocol skill digest (recomputed): the only lawful protocol authority; differs from the frame pin.'),
  rel(S, 'observes', 'installed:semantic-skill', 'The installed manifest semantic skill digest for THIS desk (recomputed): the only lawful semantic authority; differs from the frame pin.'),
];

const traceContent = {
  deskRef: 'define-architecture-contract',
  role: 'author',
  traceKind: 'upstream-hold-trace',
  subjectSemanticCode: S,
  subjectArtifactRef: artifact.artifactRef,
  relationVocabulary: ['observes', 'verifies'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: [S] }])),
  holdCoverage: {
    noProductAuthored: true,
    upstreamDesksTotal: 6,
    upstreamDesksAccepted: 0,
    unacceptedLinks: ['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements', 'link:define-acceptance-contract', 'link:reconcile-what'],
    freezeCandidateExists: false,
    freezeRatified: false,
    onlyAcceptedChain: 'import:discovery-handoff',
    gateEdgeBlocked: 'freeze-what-baseline --domain.frozen--> define-architecture-contract never lawfully fired',
    freezeVerdictOfRecord: 'FR-Freeze-What-Baseline-002 (hold-upheld; freeze ratification refused)',
    noAcceptProhibitionDischarged: false,
  },
  branchResolutionNote: 'No scenario, branch, requirement, criterion, surface, realization-entry or baseline identities are authored by this hold; all observed links resolve at record/artifact granularity.',
  workspaceSummary: WS,
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'upstream-hold-trace',
  contentDigest: sha(traceContent),
  createdAt: CREATED_AT,
  deskRef: 'define-architecture-contract',
  role: 'author',
  reviewedRound: SELF_ROUND,
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

/* ------------------------------------------------------------------ */
/* Submission summary (authored deterministically)                      */
/* ------------------------------------------------------------------ */

const summary = `# define-architecture-contract desk (author) - SRS upstream hold (stray-products-r5)

Emission of record: **UH-Define-Architecture-Contract-001** (formalization.upstream-hold.v1,
decision \`hold-no-authoring\`, noProductAuthored: true).

- Artifact: ${artifact.artifactRef}
- Trace: ${trace.traceRef}

## Why this desk authors nothing

The desk's only lawful output is the sealed architecture contract
(\`formalization.srs.v1\`, provider \`formalization.srs-structure.v1\`/\`validateSrs\`),
sealed over the single inbound edge \`freeze-what-baseline --domain.frozen-->
define-architecture-contract\` against an ACCEPTED id-set universe (frozen scenario
ids, frozen evidence-binding ids, the frozen \`whatBaselineDigest\` AND an accepted
\`srsRevisionDigest\`). The desk is fail-closed (\`MISSING_LINEAGE\` without accepted
pins; \`FOREIGN_LINEAGE\` otherwise; never scans, guesses or reselects).

Recomputed truth of this chain: **0 of 6** accepted upstream desks. No WHAT-baseline
has ever existed - the freeze desk is on record hold
(UH-Freeze-What-Baseline-001 \`9f2d28b9...\`), re-verified standing (AS-001
\`c2a08f04...\`), upheld (RC-001 \`c19344fd...\`) and re-upheld by the r4 reviewer
emission FR-Freeze-What-Baseline-002 (\`d52746b6...\`, verifier 50/50): freeze
ratification REFUSED. The \`domain.frozen\` edge into this desk has never lawfully
fired. Authoring an SRS now would fabricate the accepted-upstream authority this
series spent r2-r4 refusing.

## This desk's own stray-product record

The r1 stray product AC-Define-Architecture-Contract-001 declares self-address
\`a926df6284...\` while its content recomputes to \`f4846e5f...\` (r1 CRIT-003
digest-drift family, recomputed by VV-Define-Product-Intent-001 \`c0215ebc...\`); its
r1 \`approved\` gate verdict (\`bc1c5e59...\`, whole-file) predates the r2-r4
adjudication regime and carries no content-addressed reviewer stage at the
recomputed address. It is NOT lineage: retired, not resumed, not repaired in place,
not re-submitted (resume contract R5).

## Frame adjudication (this round's delta)

- workspace summary "${WS}" - adjudicated **TRUE** (census 0 of 6; only accepted base: the discovery import chain).
- protocol-skill pin \`a926df6284...\` - the inherited r2/r3-era anchor (dropped by the r4 frame, returned here), AND this desk's own r1 stray product drifted declared address. Hash-resolves to zero contents; not the installed protocol skill (\`b88267a1...\` recomputes). **REFUSED as authority**; recorded verbatim.
- semantic-skill pin \`95fafc847b...\` - the r3-era frame semantic pin. Hash-resolves to zero contents; not the installed semantic skill (\`131efbd9...\` recomputes). **REFUSED as authority**; recorded verbatim.

## Resume contract

R1: the freeze desk resume contract R1-R4 completes first (five genuinely accepted
pre-freeze desks -> RA-5 reconcile-what re-run -> freeze ratified). R2: this desk
re-staffs only against the REAL frozen WHAT-baseline revision. R3: authoring follows
the desk contract (parse closed vocabulary -> validate against the accepted universe
-> seal; every surface cited with the realizing scenarios). R4: this hold is not
carried as product lineage. R5: the r1 stray product stays retired.
`;

/* ------------------------------------------------------------------ */
/* Write                                                                */
/* ------------------------------------------------------------------ */

const writeText = (name, value) => writeFileSync(join(DIR, name), value, 'utf8');
writeText('define-architecture-contract-desk-upstream-hold.artifact.json', `${JSON.stringify(artifact, null, 2)}\n`);
writeText('define-architecture-contract-desk-upstream-hold-trace.json', `${JSON.stringify(trace, null, 2)}\n`);
writeText('define-architecture-contract-desk-hold-submission-summary.md', summary);

console.log(JSON.stringify({
  built: 'define-architecture-contract desk (author) SRS upstream hold',
  round: SELF_ROUND,
  semanticCode: artifact.semanticCode,
  artifactRef: artifact.artifactRef,
  traceRef: trace.traceRef,
  envelopeRecomputed: '8/8 (+CERT-1)',
  acceptedUpstreamDesks: '0 of 6',
  freezeVerdictOfRecord: 'FR-Freeze-What-Baseline-002 (hold-upheld; freeze ratification refused)',
  framePinsAdjudicated: 'both REFUSED as authority (unresolvable; not the installed manifest pins)',
  unresolvableInstances: UNRESOLVABLE.length,
}, null, 2));
