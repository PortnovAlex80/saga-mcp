/**
 * define-acceptance-contract desk (author) - UPSTREAM HOLD builder.
 *
 * Emission: UH-Define-Acceptance-Contract-001. Deterministic re-staffing
 * of the author seat after the reviewer verdict contention
 * CL-Define-Acceptance-Contract-001. The desk's first authoring
 * (SR-Define-Acceptance-Contract-001, sha256:2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0)
 * asserted accepted upstream lineage; the reviewer emission-A status audit
 * (99 recomputations, 7 hard failures) and this seat's own independent
 * recomputation prove the three consumed upstream revisions are NOT
 * accepted. Per the r2 upstream-hold precedent
 * (UH-Model-Use-Cases-001, sha256:6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7)
 * and FR-Define-Acceptance-Contract-001 RA-1, this desk authors NO
 * acceptance-contract material and issues a hold record instead.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. All addresses are sha256 over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule
 * (src/workflow-kernel/domain/digest.ts). Every cited record digest is
 * recomputed from the corpus files in this script; nothing is trusted by
 * declaration.
 *
 * Run: node define-acceptance-contract-desk-hold-build.mjs
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

/* ------------------------------------------------------------------ */
/* Verified, accepted discovery import chain (the only accepted base)   */
/* ------------------------------------------------------------------ */

const expect = (cond, message) => { if (!cond) throw new Error(`hold basis failed: ${message}`); };

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
/* Recompute every cited upstream record from the corpus                */
/* ------------------------------------------------------------------ */

const record = (relPath) => {
  const j = JSON.parse(readFileSync(join(DIR, '..', '..', '..', '..', '..', relPath), 'utf8'));
  return {
    contentDigest: sha(j.content),
    verdict: j.content.verdict ?? j.content.decision ?? j.content.holdKind ?? null,
    reviewId: j.content.reviewId ?? j.semanticCode ?? j.content.recordId ?? null,
    reviewedCandidate: j.content.reviewedCandidate ?? null,
  };
};

/* Link 1: define-product-intent - repair across every emission, no author reissue */
const intentArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-product-intent-desk-product-intent.artifact.json');
const frIntent1 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-review.json');
const frIntent1b = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-review-emission-b.json');
const frIntent2 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer2-review.json');
expect(intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055', 'intent artifact address drift');
expect(frIntent1.verdict === 'repair' && frIntent1.contentDigest === 'e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4', 'FR-Define-Product-Intent-001 drift');
expect(frIntent1b.verdict === 'repair' && frIntent1b.contentDigest === '6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc', 'FR-Define-Product-Intent-001 emission-b drift');
expect(frIntent2.verdict === 'repair' && frIntent2.contentDigest === '0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc', 'FR-Define-Product-Intent-002 drift');

/* Link 2: model-use-cases - never reviewed at the consumed content address */
const ucArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/model-use-cases-desk-uc-scenarios.artifact.json');
const ucHoldR2 = record('docs/refactoring/event-kernel/qualification/stray-products-r2/model-use-cases-desk-upstream-hold.artifact.json');
const frUc001 = record('.factory-testbed/model-use-cases-reviewer-review.json');
expect(ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b', 'UC artifact address drift');
expect(ucHoldR2.contentDigest === '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7', 'r2 UC upstream-hold address drift');
/* The only UC reviewer verdict in the workspace pins a DIFFERENT candidate. */
expect(frUc001.reviewId === 'FR-Model-Use-Cases-001' && frUc001.verdict === 'accepted', 'FR-Model-Use-Cases-001 drift');
expect(frUc001.reviewedCandidate?.artifactRef === 'sha256:c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8', 'FR-Model-Use-Cases-001 candidate pin drift');
expect(frUc001.reviewedCandidate?.artifactRef !== ucArt.contentDigest, 'FR-Model-Use-Cases-001 unexpectedly pins the corpus UC bundle');

/* Link 3: derive-system-requirements - repair + restaff confirmation, reviewer seat held */
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

/* This desk's own candidate of record + the verdict contention */
const candArt = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-acceptance-bindings.artifact.json');
const candTrc = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-acceptance-bindings-trace.json');
const candSub = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-product-submission.json');
const frDa001 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-review-emission-a.json');
const vvDa001 = record('docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-verification-emission-a.json');
expect(candArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0', 'candidate artifact drift');
expect(candTrc.contentDigest === '2835aea3f7bbf362afabf729ca37a18827bd9579c76f30daad12d8a2272a84e1', 'candidate trace drift');
expect(candSub.contentDigest === '6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe', 'candidate submission drift');
expect(frDa001.verdict === 'repair' && frDa001.contentDigest === '83e675bb18c575cb0b30e3ededd2cca6b58b88c08cb50be9c08dfb130808c383', 'FR-Define-Acceptance-Contract-001 emission-a drift');
expect(vvDa001.contentDigest === '367a38fcf8d0bd061fa2e023aba4aaab0060a82a71278ca358d6b3415b5602bb', 'VV-Define-Acceptance-Contract-001 emission-a drift');

/* Unresolvable instances asserted in this hold (verified by this build). */
const UNRESOLVABLE = [
  {
    id: 'governing-contract anchor',
    address: shaRef(GOVERNING),
    role: 'protocol-skill layer governingContractRef, declared in every r3 desk frame and pinned by the candidate of record',
    evidence: 'no content in the workspace hashes to this address; recorded as envelope provenance, never ratified',
  },
  {
    id: 'contending accepted intent instance',
    address: 'sha256:bff4aca147aaee18c7224b6b05d4d533190bd42ee15e967b321dffbe24990f08',
    role: 'the "accepted" define-product-intent instance quoted inside FR-Define-Product-Intent-002 contentionRecord',
    evidence: 'no content in the workspace hashes to this address; it travels only as quoted metadata inside review records',
  },
];

/* ------------------------------------------------------------------ */
/* The hold artifact                                                    */
/* ------------------------------------------------------------------ */

const artifactContent = {
  schemaVersion: 'formalization.upstream-hold.v1',
  deskRef: 'define-acceptance-contract',
  deskNodeId: 'define-acceptance-contract',
  role: 'author',
  itemInstanceId: 'formalization-item:define-acceptance-contract',
  token: 'plan:formalization#item:acceptance-contract',
  holdKind: 'acceptance-upstream-hold',
  decision: 'hold-no-authoring',
  statement: 'The define-acceptance-contract desk authors NO acceptance-contract material in this staffing. An acceptance contract is a statement ABOUT accepted material; the three upstream revisions the desk candidate of record consumed while declaring them accepted are NOT accepted: (a) the define-product-intent revision a06dbc57... carries verdict repair across every reviewer emission (FR-Define-Product-Intent-001 e49d8d11..., its emission-b 6c9c8324..., FR-Define-Product-Intent-002 04632094...) with no author reissue anywhere in r1/r2/r3 and the intent contention still open; (b) the model-use-cases revision 24f0aff2... has never passed a reviewer stage at its own content address - the only UC reviewer verdict in the workspace (FR-Model-Use-Cases-001 8aeee351..., factory-testbed namespace) pins a different candidate (c6120e86...) - and the bundle was authored in violation of its own desk upstream hold (UH-Model-Use-Cases-001 6cccd162...); (c) the derive-system-requirements revision 86b00569... carries verdict repair (FR-Derive-System-Requirements-001 d31b044c...) plus a re-staffing confirmation (RS-Derive-System-Requirements-001 1c30d28e...) that confirms the verdict, not an acceptance, and the requirements reviewer seat is itself held (UH-Derive-System-Requirements-001 fbc0394b..., UH-Derive-System-Requirements-002 b4eaaaba...). Only the discovery import chain is genuinely accepted (import artifact b10bb762... recomputes; all 9 capsule sub-artifact digests recompute and match this desk task envelope 8/8). The desk candidate of record (SR-Define-Acceptance-Contract-001 2b01353d...) is under an unresolved reviewer verdict contention (CL-Define-Acceptance-Contract-001: emission A repair 83e675bb... grounded in 99 recomputations vs emission B accepted with no status-layer audit) routed to driver/human adjudication. Authoring a replacement contract now would re-ratify the same fabricated lineage; the desk waits for genuinely accepted upstream revisions.',
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
  candidateOfRecord: {
    semanticCode: 'SR-Define-Acceptance-Contract-001',
    artifactRef: shaRef(candArt.contentDigest),
    traceRef: shaRef(candTrc.contentDigest),
    submissionRef: shaRef(candSub.contentDigest),
    status: 'authored 2026-08-28T00:00:00Z pin, byte-unchanged since; reviewer verdict contention open; NOT settled; superseded for authoring basis by this hold',
    defectSummary: 'CRIT-1 unaccepted lineage asserted accepted (this hold, links 1-3); CRIT-2 prd:scope-2 fabricated exclusion restated as fact; MAJ-1 governing anchor unresolvable workspace-wide',
  },
  verdictContention: {
    contentionId: 'CL-Define-Acceptance-Contract-001',
    state: 'open; driver/human adjudication required before settle',
    emissionA: {
      verdict: 'repair',
      reviewRef: shaRef(frDa001.contentDigest),
      verificationRef: shaRef(vvDa001.contentDigest),
      note: 'grounded in 99 recomputations incl. the M/N ACCEPTANCE-STATE audit; re-issued collision-free under -emission-a filenames',
    },
    emissionB: {
      verdict: 'accepted',
      note: 'written to canonical filenames by a concurrent writer; no status-layer audit counterpart; addresses recorded in CL-Define-Acceptance-Contract-001',
    },
    resolutionDemand: 'the final gate must not consume an accepted reviewer verdict that contradicts recomputable evidence still on disk; both emissions travel by content address and neither may be erased by filename ownership',
  },
  upstreamObservations: {
    onlyAcceptedChain: {
      importArtifactRef: IMPORT_REF,
      certificateRef: shaRef(certDigest),
      note: 'the accepted discovery handoff capsule import is the only genuinely accepted upstream material; this hold is grounded in it',
    },
    unacceptedLinks: [
      {
        link: 'define-product-intent',
        consumedAs: 'acceptedIntentArtifactRef',
        artifactRef: shaRef(intentArt.contentDigest),
        status: 'repair-verdict; contention open; NOT accepted',
        evidenceRefs: [shaRef(frIntent1.contentDigest), shaRef(frIntent1b.contentDigest), shaRef(frIntent2.contentDigest)],
        evidenceNote: 'FR-Define-Product-Intent-001 (canonical, repair), FR-Define-Product-Intent-001 emission-b (repair), FR-Define-Product-Intent-002 (repair, records the contention and escalation); no author reissue exists in r1/r2/r3',
      },
      {
        link: 'model-use-cases',
        consumedAs: 'acceptedUcArtifactRef',
        artifactRef: shaRef(ucArt.contentDigest),
        status: 'never reviewed at this content address; authored in violation of its own desk upstream hold; NOT accepted',
        evidenceRefs: [shaRef(ucHoldR2.contentDigest), shaRef(frUc001.contentDigest)],
        evidenceNote: 'UH-Model-Use-Cases-001 (r2 upstream hold); FR-Model-Use-Cases-001 is an accepted verdict but pins a different candidate (c6120e86..., factory-testbed namespace) and therefore gives this revision no reviewer stage',
      },
      {
        link: 'derive-system-requirements',
        consumedAs: 'acceptedRequirementsArtifactRef',
        artifactRef: shaRef(srArt.contentDigest),
        status: 'repair-verdict + restaff confirmation; reviewer seat held; NOT accepted',
        evidenceRefs: [shaRef(frSr1.contentDigest), shaRef(rsSr1.contentDigest), shaRef(uhSr1.contentDigest), shaRef(uhSr2.contentDigest)],
        evidenceNote: 'FR-Derive-System-Requirements-001 (repair); RS-Derive-System-Requirements-001 (re-staffing confirmation, not an acceptance); UH-Derive-System-Requirements-001/002 (current reviewer seat hold-no-review)',
      },
    ],
    unresolvableInstances: UNRESOLVABLE.map((u) => ({ ...u, resolved: false })),
  },
  noProductAuthored: true,
  fence: {
    forbiddenBundleKeys: ['criteria', 'deferrals', 'standaloneEvidenceBindings', 'verifiableStatements'],
    observed: 'this hold is a desk artifact, not an acceptance bundle: no criterion, evidence kind, verifiable statement or observable terminal result is authored; prd:scope-2 is not restated as fact and unknown:browser-matrix-1 derives nothing',
  },
  resumeContract: [
    'R1: driver/human adjudicates CL-Define-Acceptance-Contract-001 (emission A repair 83e675bb... vs emission B accepted) and the define-product-intent contention by content address (repair e49d8d11.../6c9c8324.../04632094... vs unresolvable "accepted" bff4aca1...)',
    'R2: the define-product-intent desk reissues against the adjudicated basis; FR-Define-Product-Intent-001/002 CRIT-1 (prd:scope-2 disposition authority) must be remediated in that reissue',
    'R3: the model-use-cases revision 24f0aff2... receives its reviewer stage at its own content address, or is reissued and then reviewed; the r2 upstream-hold violation is recorded as resolved or repaired',
    'R4: the derive-system-requirements revision 86b00569... is repaired and re-reviewed (or its hold chain resolves) so a verdict record exists for the revision this desk would consume',
    'R5: on genuinely accepted revisions of all three links, this desk is re-staffed and reissues the acceptance contract against those content addresses only; this hold is not carried as product lineage',
  ],
  governingContractRef: shaRef(GOVERNING),
  governingContractNote: 'declared in this desk task protocol-skill layer; recorded verbatim as envelope provenance. Unresolvable workspace-wide (see unresolvableInstances). NOT ratified by this desk; this hold does not depend on it.',
  verification: {
    declaredDigestsTrusted: false,
    importArtifactDigestRecomputed: true,
    capsuleSubArtifactDigestsRecomputed: true,
    envelopeProjectionDigestsRecomputed: true,
    citedRecordDigestsRecomputed: true,
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
  semanticCode: 'UH-Define-Acceptance-Contract-001',
  createdAt: CREATED_AT,
  deskRef: 'define-acceptance-contract',
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
  if (id === 'UH-Define-Acceptance-Contract-001') return sha(artifactContent);
  if (id === 'SR-Define-Acceptance-Contract-001') return candArt.contentDigest;
  if (id === 'FS-Define-Acceptance-Contract-001') return candSub.contentDigest;
  if (id === 'link:define-product-intent') return intentArt.contentDigest;
  if (id === 'link:model-use-cases') return ucArt.contentDigest;
  if (id === 'link:derive-system-requirements') return srArt.contentDigest;
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
    'UH-Define-Acceptance-Contract-001', 'verifies', id,
    `The hold's envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection.`,
  )),
  rel('UH-Define-Acceptance-Contract-001', 'observes', 'import:discovery-handoff', 'The accepted discovery import chain is the only accepted base this hold is grounded in (content digest recomputed).'),
  rel('UH-Define-Acceptance-Contract-001', 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel('UH-Define-Acceptance-Contract-001', 'observes', 'SR-Define-Acceptance-Contract-001', 'The desk candidate of record is byte-unchanged and under an unresolved reviewer verdict contention; NOT settled.'),
  rel('UH-Define-Acceptance-Contract-001', 'observes', 'FS-Define-Acceptance-Contract-001', 'The author submission of record; superseded for authoring basis by this hold.'),
  rel('UH-Define-Acceptance-Contract-001', 'observes', 'link:define-product-intent', 'Link 1: repair verdicts across every emission (e49d8d11, 6c9c8324, 04632094), no author reissue, contention open.'),
  rel('UH-Define-Acceptance-Contract-001', 'observes', 'link:model-use-cases', 'Link 2: never reviewed at its own content address; authored in violation of the r2 upstream hold.'),
  rel('UH-Define-Acceptance-Contract-001', 'observes', 'link:derive-system-requirements', 'Link 3: repair verdict + restaff confirmation; reviewer seat held (UH-...-001/002).'),
];

const traceContent = {
  deskRef: 'define-acceptance-contract',
  role: 'author',
  traceKind: 'upstream-hold-trace',
  subjectSemanticCode: 'UH-Define-Acceptance-Contract-001',
  subjectArtifactRef: artifact.artifactRef,
  relationVocabulary: ['observes', 'verifies'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: ['UH-Define-Acceptance-Contract-001'] }])),
  holdCoverage: {
    noProductAuthored: true,
    unacceptedLinks: ['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements'],
    onlyAcceptedChain: 'import:discovery-handoff',
    contentionOfRecord: 'CL-Define-Acceptance-Contract-001',
  },
  branchResolutionNote: 'No scenario, branch, requirement or criterion identities are authored by this hold; all observed links resolve at artifact granularity.',
  workspaceSummary: WS,
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'upstream-hold-trace',
  contentDigest: sha(traceContent),
  createdAt: CREATED_AT,
  deskRef: 'define-acceptance-contract',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

/* ------------------------------------------------------------------ */
/* Write                                                                */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('define-acceptance-contract-desk-upstream-hold.artifact.json', artifact);
writeJson('define-acceptance-contract-desk-upstream-hold-trace.json', trace);

console.log(JSON.stringify({
  built: 'define-acceptance-contract desk (author) upstream hold',
  semanticCode: 'UH-Define-Acceptance-Contract-001',
  artifactRef: artifact.artifactRef,
  traceRef: trace.traceRef,
  envelopeRecomputed: '8/8 (+CERT-1)',
  unacceptedLinks: 3,
  unresolvableInstances: UNRESOLVABLE.length,
}, null, 2));
