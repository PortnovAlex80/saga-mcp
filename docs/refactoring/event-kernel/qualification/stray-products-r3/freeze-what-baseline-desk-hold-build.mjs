/**
 * freeze-what-baseline desk (author) - FREEZE UPSTREAM HOLD builder.
 *
 * Emission: UH-Freeze-What-Baseline-001. Deterministic authoring of the
 * freeze-what-baseline desk's author seat in stray-products-r3.
 *
 * The desk's product (the whole-WHAT baseline, frf-contracts.what-baseline.v1)
 * is a statement ABOUT accepted material: its payload contract requires
 * acceptanceRecords with minItems 5 - exactly one accepted
 * CandidateSet/CellFinalAcceptance/WorkplaceProductionRevision triple per
 * accepted pre-freeze desk. On this chain ZERO pre-freeze desks are accepted,
 * and the desk's immediate upstream gate - the reconcile-what desk - returned
 * verdict repair (FR-Reconcile-What-001, emission A, the reviewer round of
 * record per CL-Reconcile-What-001) with the explicit prohibition that NO
 * domain.accepted may fire from reconcile-what toward freeze-what-baseline on
 * this chain. Freezing over unaccepted lineage would inherit the fabricated
 * authority permanently (the reviewer's own CRIT-1 wording) - exactly the
 * CRIT-2 failure class the round just adjudicated. Per the r3 upstream-hold
 * precedent (UH-Define-Acceptance-Contract-001, UH-Model-Use-Cases-001) this
 * desk therefore authors NO WHAT-baseline material and issues a hold record.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. All addresses are sha256 over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule
 * (src/workflow-kernel/domain/digest.ts). Every cited record digest is
 * recomputed from the corpus files in this script; nothing is trusted by
 * declaration.
 *
 * Run: node freeze-what-baseline-desk-hold-build.mjs
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
const WS = '0 accepted upstream revisions travel by content address';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';

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

const importArt = JSON.parse(readFileSync(join(DIR, '..', 'stray-products-r2', 'import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));
expect(sha(importArt.content) === importArt.contentDigest, 'import artifact content digest drift');
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
    reviewId: j.content.reviewId ?? j.semanticCode ?? j.content.recordId ?? null,
    reviewedCandidate: j.content.reviewedCandidate ?? j.content.candidateOfRecord ?? null,
  };
};

/* The immediate upstream gate: reconcile-what, reviewer round of record (emission A). */
const rwArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-what-reconciliation.artifact.json');
const rwTrc = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-what-reconciliation-trace.json');
const rwSub = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-product-submission.json');
const frRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-review.json');
const vvRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-verification.json');
const rtRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-trace.json');
const fsRw2 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-product-submission.json');
const clRw = record('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-collision-record.json');
expect(rwArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191', 'reconcile-what artifact address drift');
expect(rwTrc.contentDigest === '09e800469f38c2d926dc1ef24974ca3b2f01ce72913ffcc5832dde071d6581e0', 'reconcile-what trace address drift');
expect(rwSub.contentDigest === '0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba', 'reconcile-what submission address drift');
expect(frRw.reviewId === 'FR-Reconcile-What-001' && frRw.verdict === 'repair' && frRw.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6', 'FR-Reconcile-What-001 drift');
expect(vvRw.contentDigest === 'cd7504a69eff07d39f9945f8cf3da3f7cf8c4d8e91932c897dab5f5fbab35cac', 'VV-Reconcile-What-001 drift');
expect(rtRw.contentDigest === 'fe108e09db2dedb37dbb151d46e56090128c7bc44da339e44be62a47e7755373', 'reviewer trace RT-Reconcile-What-001 drift');
expect(fsRw2.contentDigest === '9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce', 'reviewer submission FS-Reconcile-What-002 drift');
expect(clRw.contentDigest === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d', 'CL-Reconcile-What-001 drift');
/* The reviewer of record reviewed exactly the author candidate of record. */
expect(frRw.reviewedCandidate?.submissionRef === shaRef(rwSub.contentDigest), 'reviewer-of-record candidate binding drift');
expect(frRw.reviewedCandidate?.artifactRef === shaRef(rwArt.contentDigest), 'reviewer-of-record artifact binding drift');
/* Emission A is the round of record in the plain slots; emission B contested only the verify slots. */
const clRwRaw = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-collision-record.json'), 'utf8')).content;
expect(clRwRaw.emissionA?.verdict === 'repair', 'collision record emission A verdict drift');
expect(clRwRaw.discipline?.includes('round of record in the plain slots is emission A'), 'collision record discipline drift');

/* The explicit prohibition, recomputed from the verdict record itself. */
const frRwRaw = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-review.json'), 'utf8')).content;
const crit1 = frRwRaw.findings.criticalIssues.find((f) => f.id === 'CRIT-1');
expect(Boolean(crit1), 'CRIT-1 missing from the reviewer round of record');
expect(crit1.requiredAction.includes('No accept effect may fire on this chain'), 'CRIT-1 requiredAction prohibition drift');
expect(frRwRaw.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline'), 'nextStage prohibition drift');
expect(JSON.stringify(frRwRaw).includes('the freeze would inherit the fabricated authority permanently'), 'CRIT-1 permanent-inheritance wording drift');

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
const vvAc2 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-verification-emission-c.json');
const fsAc2 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-product-submission-emission-c.json');
expect(acArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0', 'acceptance artifact address drift');
expect(uhAc.contentDigest === 'a53a5e08a9c7f0f6ad550fd5d2db142238683e1d285458eb2ded5330cce39d84', 'UH-Define-Acceptance-Contract-001 drift');
expect(frAc2.reviewId === 'FR-Define-Acceptance-Contract-002' && frAc2.verdict === 'repair' && frAc2.contentDigest === '7e76176c431770477f2930747498f2df8b0a6ce6071c29ff065ad7d85edcac0e', 'FR-Define-Acceptance-Contract-002 (adjudicating emission C) drift');
expect(vvAc2.contentDigest === '61b9ce2e70b979f7e224bcbe17d492a3ffb85410a4b8a8ba139257cfbabd85a5', 'VV-Define-Acceptance-Contract-002 drift');
expect(fsAc2.contentDigest === 'bdd577ae01eccfdcf1334239271fae5478351294a4523607f832603a95ae33ac', 'reviewer submission emission C drift');
expect(fsAc2.verdict === 'repair', 'adjudicated submission verdict drift');
const fsAc2Raw = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-product-submission-emission-c.json'), 'utf8')).content;
expect(JSON.stringify(fsAc2Raw).includes('CTN-Define-Acceptance-Contract-001'), 'CTN adjudication reference drift');
expect(frAc2.reviewedCandidate?.artifactRef === shaRef(acArt.contentDigest), 'adjudicating review candidate binding drift');

/* The freeze product contract itself: the reason zero authoring is lawful. */
const schemaPath = join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json');
const schemaBytes = readFileSync(schemaPath);
const schemaRawDigest = shaRaw(schemaBytes);
expect(schemaRawDigest === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09', 'what-baseline schema raw digest drift');
const schema = JSON.parse(schemaBytes.toString('utf8'));
expect(schema.properties.acceptanceRecords.minItems === 5, 'what-baseline acceptanceRecords minItems drift');
expect(schema.properties.schemaVersion.const === 'frf-contracts.what-baseline.v1', 'what-baseline schemaVersion drift');

/* Unresolvable instance asserted in this hold (scan-proofed by the verifier). */
const UNRESOLVABLE = [
  {
    id: 'governing-contract anchor',
    address: shaRef(GOVERNING),
    role: 'protocol-skill layer governingContractRef, declared in this desk task frame and pinned by every r3 desk artifact',
    evidence: 'no content in the workspace hashes to this address; recorded as envelope provenance, never ratified',
  },
];

/* ------------------------------------------------------------------ */
/* The hold artifact                                                    */
/* ------------------------------------------------------------------ */

const artifactContent = {
  schemaVersion: 'formalization.upstream-hold.v1',
  deskRef: 'freeze-what-baseline',
  deskNodeId: 'freeze-what-baseline',
  role: 'author',
  itemInstanceId: 'formalization-item:freeze-what-baseline',
  token: 'plan:formalization#item:what-baseline',
  holdKind: 'freeze-upstream-hold',
  decision: 'hold-no-authoring',
  statement: 'The freeze-what-baseline desk authors NO WHAT-baseline material in this staffing. The whole-WHAT baseline is a statement ABOUT accepted material: its payload contract (frf-contracts.what-baseline.v1, schema raw sha256 ab1b7f5e...) requires acceptanceRecords with minItems 5 - exactly one accepted CandidateSet/CellFinalAcceptance/WorkplaceProductionRevision triple per accepted pre-freeze desk. On this chain the accepted pre-freeze desk count is 0 of 5, and the desk upstream gate - the reconcile-what desk - returned verdict repair: FR-Reconcile-What-001 39a94a29... (reviewer round of record, emission A per CL-Reconcile-What-001 841194ce...), with the recomputed prohibition "No domain.accepted may fire from this desk toward freeze-what-baseline on this chain" and the CRIT-1 warning that a freeze over unaccepted lineage would "inherit the fabricated authority permanently". The four consumed pre-freeze revisions are themselves NOT accepted: define-product-intent a06dbc57... repair across every emission (e49d8d11..., 6c9c8324..., 04632094...); model-use-cases 24f0aff2... never reviewed at its own content address (the only UC verdict 8aeee351... pins a different candidate c6120e86...) and authored in violation of its desk hold 6cccd162...; derive-system-requirements 86b00569... repair d31b044c... plus re-staff confirmation 1c30d28e... with the reviewer seat held (fbc0394b..., b4eaaaba...); define-acceptance-contract 2b01353d... adjudicated repair (CTN-Define-Acceptance-Contract-001: FR-Define-Acceptance-Contract-002 7e76176c... confirms emission-A repair, supersedes the accepted emission) with the desk on record hold a53a5e08.... Only the discovery import chain is genuinely accepted (import artifact b10bb762... recomputes; all 9 capsule sub-artifact digests recompute and match this desk task envelope 8/8 including CERT-1). The reconcile-what author candidate of record (FS-Reconcile-What-001 0f4e4faf..., artifact 6400a2dd..., trace 09e80046...) is NOT settled and its repair routing (RA-1..RA-5) supersedes it for this desk authoring basis. Freezing now would fabricate the five acceptanceRecords the contract demands - the exact CRIT-2 failure class (asserted reviewer authority that does not exist) the round just adjudicated; this hold records the block instead and authors no baseline sections.',
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
  upstreamGate: {
    deskId: 'reconcile-what',
    candidateOfRecord: {
      semanticCode: 'FS-Reconcile-What-001',
      submissionRef: shaRef(rwSub.contentDigest),
      artifactRef: shaRef(rwArt.contentDigest),
      traceRef: shaRef(rwTrc.contentDigest),
      status: 'author candidate of record of the upstream desk; verdict of record repair; NOT settled; superseded for this desk authoring basis by the RA-1..RA-5 repair routing',
    },
    verdictOfRecord: {
      semanticCode: 'FR-Reconcile-What-001',
      verdict: 'repair',
      reviewRef: shaRef(frRw.contentDigest),
      verificationRef: shaRef(vvRw.contentDigest),
      reviewerTraceRef: shaRef(rtRw.contentDigest),
      reviewerSubmissionRef: shaRef(fsRw2.contentDigest),
      criticalFindings: ['CRIT-1 unaccepted lineage asserted accepted', 'CRIT-2 fabricated reviewer authority', 'MAJ-1 governing anchor unresolvable', 'MAJ-2 payload-contract regressions'],
    },
    reviewerCollision: {
      semanticCode: 'CL-Reconcile-What-001',
      recordRef: shaRef(clRw.contentDigest),
      emissionAVerdict: 'repair',
      roundOfRecord: 'emission A (plain review/verification/trace/submission slots); emission B contested only the verify slots and authored no round artifacts at collision time',
    },
    explicitProhibition: 'No domain.accepted may fire from this desk toward freeze-what-baseline on this chain.',
    prohibitionSource: 'recomputed from FR-Reconcile-What-001 nextStage and CRIT-1 requiredAction ("No accept effect may fire on this chain")',
  },
  chainAcceptanceCensus: {
    requiredByFreezeContract: 5,
    acceptedPreFreezeDeskCount: 0,
    schemaRef: 'docs/refactoring/formalization-frf/contracts/schemas/what-baseline.schema.json',
    schemaRawSha256: schemaRawDigest,
    contractLaw: 'acceptanceRecords minItems 5, one record per accepted pre-freeze desk; every desk counts only through an accepted reviewer verdict at its own content address',
    preFreezeDesks: [
      {
        deskId: 'define-product-intent',
        revisionRef: shaRef(intentArt.contentDigest),
        verdictOfRecord: 'repair (FR-Define-Product-Intent-001 e49d8d11..., emission-b 6c9c8324..., FR-Define-Acceptance-Contract-002 inherit FR-Define-Product-Intent-002 04632094...)',
        accepted: false,
        evidenceRefs: [shaRef(frIntent1.contentDigest), shaRef(frIntent1b.contentDigest), shaRef(frIntent2.contentDigest)],
      },
      {
        deskId: 'model-use-cases',
        revisionRef: shaRef(ucArt.contentDigest),
        verdictOfRecord: 'never reviewed at this content address; authored in violation of its own desk upstream hold (UH-Model-Use-Cases-001 6cccd162...); the only UC reviewer verdict (FR-Model-Use-Cases-001 8aeee351...) pins a different candidate (c6120e86...)',
        accepted: false,
        evidenceRefs: [shaRef(ucHoldR2.contentDigest), shaRef(frUc001.contentDigest)],
      },
      {
        deskId: 'derive-system-requirements',
        revisionRef: shaRef(srArt.contentDigest),
        verdictOfRecord: 'repair (FR-Derive-System-Requirements-001 d31b044c...) + re-staff confirmation (RS-...-001 1c30d28e..., confirms the verdict, not an acceptance); reviewer seat held (UH-...-001 fbc0394b..., UH-...-002 b4eaaaba...)',
        accepted: false,
        evidenceRefs: [shaRef(frSr1.contentDigest), shaRef(rsSr1.contentDigest), shaRef(uhSr1.contentDigest), shaRef(uhSr2.contentDigest)],
      },
      {
        deskId: 'define-acceptance-contract',
        revisionRef: shaRef(acArt.contentDigest),
        verdictOfRecord: 'adjudicated repair (CTN-Define-Acceptance-Contract-001: FR-Define-Acceptance-Contract-002 7e76176c... emission C confirms emission-A repair 83e675bb..., supersedes the accepted emission); desk on record hold (UH-Define-Acceptance-Contract-001 a53a5e08...)',
        accepted: false,
        evidenceRefs: [shaRef(frAc2.contentDigest), shaRef(vvAc2.contentDigest), shaRef(fsAc2.contentDigest), shaRef(uhAc.contentDigest)],
      },
      {
        deskId: 'reconcile-what',
        revisionRef: shaRef(rwArt.contentDigest),
        verdictOfRecord: 'repair (FR-Reconcile-What-001 39a94a29..., reviewer round of record; CRIT-1 + CRIT-2; explicit no-accept prohibition toward freeze-what-baseline)',
        accepted: false,
        evidenceRefs: [shaRef(frRw.contentDigest), shaRef(vvRw.contentDigest), shaRef(clRw.contentDigest)],
      },
    ],
  },
  unresolvableInstances: UNRESOLVABLE.map((u) => ({ ...u, resolved: false })),
  noProductAuthored: true,
  fence: {
    forbiddenBaselineSections: [
      'acceptanceRecords',
      'caseIdentity',
      'containers',
      'developmentSurface',
      'dispositions',
      'evidenceBindings',
      'sourceManifests',
      'traceSet',
      'wholeWhatDigest',
    ],
    observed: 'this hold is a desk artifact, not a WHAT baseline: no acceptance record, container member, source manifest, trace, disposition, evidence binding or whole-WHAT digest is authored; the 8 task-projection claims are observed as content addresses only, and unknown:browser-matrix-1 derives nothing',
  },
  resumeContract: [
    'R1: upstream repair routing RA-1..RA-4 lands genuinely accepted revisions for define-product-intent, model-use-cases, derive-system-requirements and define-acceptance-contract (each through a completed reviewer stage at its own content address); the reconciliation repair routing RA-5 then re-runs reconcile-what over the NEW accepted chain',
    'R2: the reconcile-what reviewer stage of the re-run returns a verdict of record; on accepted, the no-accept prohibition toward freeze-what-baseline is discharged by that verdict record itself, never by this desk',
    'R3: on five accepted pre-freeze desks, this desk is re-staffed and authors the whole-WHAT baseline strictly against the accepted CandidateSet/CellFinalAcceptance/WorkplaceProductionRevision triples and the frf-contracts.what-baseline.v1 payload contract (acceptanceRecords minItems 5)',
    'R4: this hold is not carried as product lineage; the baseline cites only accepted revisions',
  ],
  governingContractRef: shaRef(GOVERNING),
  governingContractNote: 'declared in this desk task protocol-skill layer; recorded verbatim as envelope provenance. Unresolvable workspace-wide (see unresolvableInstances). NOT ratified by this desk; this hold does not depend on it.',
  verification: {
    declaredDigestsTrusted: false,
    importArtifactDigestRecomputed: true,
    capsuleSubArtifactDigestsRecomputed: true,
    envelopeProjectionDigestsRecomputed: true,
    citedRecordDigestsRecomputed: true,
    reviewerCandidateBindingRecomputed: true,
    prohibitionRecomputedFromVerdictRecord: true,
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
  semanticCode: 'UH-Freeze-What-Baseline-001',
  createdAt: CREATED_AT,
  deskRef: 'freeze-what-baseline',
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
  if (id === 'UH-Freeze-What-Baseline-001') return sha(artifactContent);
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
  ...Object.keys(ENVELOPE).map((id) => rel(
    'UH-Freeze-What-Baseline-001', 'verifies', id,
    `The hold's envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection.`,
  )),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'import:discovery-handoff', 'The accepted discovery import chain is the only accepted base this hold is grounded in (content digest recomputed).'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'FR-Reconcile-What-001', 'The upstream gate verdict of record: repair (CRIT-1 + CRIT-2; MAJ-1/MAJ-2), recomputed from the plain review slot owned by emission A.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'VV-Reconcile-What-001', 'The reviewer verification of record (84 content/status checks, nothing trusted by declaration).'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'RT-Reconcile-What-001', 'The reviewer trace (19 edges resolving against recomputed digests).'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'FS-Reconcile-What-002', 'The reviewer product submission recording verdict repair and the repair routing to the upstream owning desks.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'CL-Reconcile-What-001', 'The reviewer-seat collision record: emission A (repair) is the round of record; emission B contested only the verify slots.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'FS-Reconcile-What-001', 'The upstream author candidate of record; NOT settled; superseded for this desk authoring basis by the RA-1..RA-5 routing.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'link:define-product-intent', 'Pre-freeze desk 1: repair verdicts across every emission (e49d8d11, 6c9c8324, 04632094), no author reissue; NOT accepted.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'link:model-use-cases', 'Pre-freeze desk 2: never reviewed at its own content address; authored in violation of its desk upstream hold; NOT accepted.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'link:derive-system-requirements', 'Pre-freeze desk 3: repair verdict + re-staff confirmation; reviewer seat held; NOT accepted.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'link:define-acceptance-contract', 'Pre-freeze desk 4: adjudicated repair (CTN-001) with the desk on record hold a53a5e08; NOT accepted.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'link:reconcile-what', 'Pre-freeze desk 5 (the upstream gate): repair verdict of record; NOT accepted.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'UH-Define-Acceptance-Contract-001', 'The standing upstream hold of the define-acceptance-contract desk; its resume contract R1-R5 precedes this desk re-staffing.'),
  rel('UH-Freeze-What-Baseline-001', 'observes', 'FR-Define-Acceptance-Contract-002', 'The adjudicating reviewer emission C of the acceptance desk: repair confirmed (CTN-Define-Acceptance-Contract-001 resolved), the accepted emission superseded.'),
];

const traceContent = {
  deskRef: 'freeze-what-baseline',
  role: 'author',
  traceKind: 'upstream-hold-trace',
  subjectSemanticCode: 'UH-Freeze-What-Baseline-001',
  subjectArtifactRef: artifact.artifactRef,
  relationVocabulary: ['observes', 'verifies'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: ['UH-Freeze-What-Baseline-001'] }])),
  holdCoverage: {
    noProductAuthored: true,
    preFreezeDesksAccepted: 0,
    preFreezeDesksRequired: 5,
    unacceptedLinks: ['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements', 'link:define-acceptance-contract', 'link:reconcile-what'],
    onlyAcceptedChain: 'import:discovery-handoff',
    gateVerdictOfRecord: 'FR-Reconcile-What-001 (repair)',
    explicitProhibition: artifactContent.upstreamGate.explicitProhibition,
  },
  branchResolutionNote: 'No scenario, branch, requirement, criterion, container or baseline identities are authored by this hold; all observed links resolve at record/artifact granularity.',
  workspaceSummary: WS,
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'upstream-hold-trace',
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
writeJson('freeze-what-baseline-desk-upstream-hold.artifact.json', artifact);
writeJson('freeze-what-baseline-desk-upstream-hold-trace.json', trace);

console.log(JSON.stringify({
  built: 'freeze-what-baseline desk (author) freeze upstream hold',
  semanticCode: 'UH-Freeze-What-Baseline-001',
  artifactRef: artifact.artifactRef,
  traceRef: trace.traceRef,
  envelopeRecomputed: '8/8 (+CERT-1)',
  acceptedPreFreezeDesks: '0 of 5 (required 5 by frf-contracts.what-baseline.v1)',
  gateVerdictOfRecord: 'FR-Reconcile-What-001 (repair)',
  unresolvableInstances: UNRESOLVABLE.length,
}, null, 2));
