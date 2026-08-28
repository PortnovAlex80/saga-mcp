/**
 * reconcile-what desk (reviewer) - EMISSION B, CORRECTED authoring of the
 * five reviewer artifacts (emission-b filenames per the CL-Reconcile-What-001
 * discipline; the plain contested slots receive no writes).
 *
 * Deterministic: pinned timestamp, no clock reads, no randomness. Every
 * content digest is computed over canonical JSON (recursively key-sorted,
 * compact, UTF-8) per src/workflow-kernel/domain/digest.ts; artifacts
 * already built are interleaved by content address.
 *
 * GROUNDING LAW: all verdict content derives from
 * reconcile-what-desk-reviewer-verify-out-emission-b.json (70 checks over
 * three layers: content 53, status 14, payload 3). Nothing is asserted
 * that the verify run did not establish; any referenced check id that is
 * missing or failed aborts the build (fail-closed).
 *
 * VERDICT LAW for this desk: 'accepted' requires the content layer clean
 * AND a genuinely accepted lineage above the discovery import AND a clean
 * payload surface. The status layer of this verify run proves the lineage
 * unaccepted and the candidate's reviewer gate superseded; the payload
 * layer proves mechanical defects. The verdict is therefore REPAIR -
 * concurring with the round of record (emission A) by independent
 * re-derivation, and superseding this seat's own B-1 accepted first pass.
 *
 * Run: node reconcile-what-desk-reviewer-build-emission-b.mjs
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
const PIN = '2026-08-28T00:00:00Z';
const DIGEST_RULE = 'sha256 over canonical JSON of content (recursively key-sorted, compact)';

const load = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));

/* The candidate of record (author artifacts). */
const art = load('reconcile-what-desk-what-reconciliation.artifact.json');
const trc = load('reconcile-what-desk-what-reconciliation-trace.json');
const sub = load('reconcile-what-desk-product-submission.json');
const FS_AUTHOR = sub.contentDigest;
const ART = art.contentDigest;
const TRC_AUTHOR = trc.contentDigest;
const REPORT = art.content.product.reportDigest;

/* Status-layer primary records (round of record + adjudication). */
const rwCollision = load('reconcile-what-desk-reviewer-collision-record.json');
const rwFrA = load('reconcile-what-desk-reviewer-review.json');
const rwVvA = load('reconcile-what-desk-reviewer-verification.json');
const rwTrcA = load('reconcile-what-desk-reviewer-trace.json');
const rwFsA = load('reconcile-what-desk-reviewer-product-submission.json');
const accFsEmissionC = load('define-acceptance-contract-desk-reviewer-product-submission-emission-c.json');
const accFrEmissionA = load('define-acceptance-contract-desk-reviewer-review-emission-a.json');
const accHold = load('define-acceptance-contract-desk-upstream-hold.artifact.json');
const ucHold = JSON.parse(readFileSync(join(DIR, '..', 'stray-products-r2', 'model-use-cases-desk-upstream-hold.artifact.json'), 'utf8'));

/* The evidence of record. */
const verifyRun = load('reconcile-what-desk-reviewer-verify-out-emission-b.json');
const resultOf = (id) => verifyRun.results.find((r) => r.id === id);
const mustPass = (id) => {
  const r = resultOf(id);
  if (!r) throw new Error(`grounding failure: check ${id} absent from the verify run`);
  if (r.ok !== true) throw new Error(`grounding failure: check ${id} did not pass: ${r.detail}`);
  return r.detail;
};
const detailOf = (id) => resultOf(id)?.detail ?? '';

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
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const FRAME_PROTOCOL_SKILL = 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50';
const FRAME_SEMANTIC_SKILL = '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2';
const WORKSPACE_SUMMARY = '0 accepted upstream revisions travel by content address';

/* This seat's superseded first-pass emission (B-1), by content address. */
const EMISSION_B1 = {
  verificationRef: 'sha256:aabc9ac34035956afb081a89c3d31ebb35812515b8201ddc8073f0d65f7c4317',
  reviewRef: 'sha256:e86a6e27c7a93a0ea25bde6f455dc36469f70f38333256d6a0b6f1666844a951',
  traceRef: 'sha256:a707316509ed0c03d97be533c648625e4766c14b07d6e3e8829fad48a2afe841',
  submissionRef: 'sha256:4e1f0daddb91a04a098cfc313876fdc6e744f893d25ff30acb55390ce4df9683',
};

/* Ground the decisive checks before authoring anything. */
mustPass('C1.report.byteEquality');
mustPass('C3.verdict.computedLaw');
mustPass('B9.acceptanceReseal');
mustPass('G1.probe.verdictInjectionHardcodeKill');
mustPass('S2.accAdjudication.verdictOfRecord');
mustPass('S5.supersededAcceptedEmission');
mustPass('S6.candidate.consumedSupersededGate');
mustPass('S12.candidate.flagsFalseAtStatusLayer');
mustPass('H1.payload.doublePrefixedRefs');

/* VERDICT LAW: content layer must be clean; the status layer's
   genuinely-accepted-above-import finding and the payload defects decide. */
const contentClean = verifyRun.layers.content.failed === 0;
const statusAudit = verifyRun.statusAudit;
const lineageAccepted = statusAudit.genuinelyAcceptedAboveImport !== 'none';
const payloadClean = detailOf('H1.payload.doublePrefixedRefs').startsWith('0 ') && detailOf('H2.payload.coverageSum').includes('sums to 28');
const VERDICT = contentClean && lineageAccepted && payloadClean ? 'accepted' : 'repair';
if (VERDICT !== 'repair') throw new Error('verdict law unexpectedly produced accepted - this build authors the repair path only');

const govScan = statusAudit.governingAnchor ?? '';

/* -------------------------------------------------------------- 1. VV */
const vvContent = {
  verificationId: 'VV-Reconcile-What-002',
  deskRef: 'reconcile-what',
  role: 'reviewer',
  emission: 'B (corrected; supersedes this seat\'s content-only B-1 first pass by content address)',
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; THREE layers: content (real acceptance.reconcileWhat + real PRD/UC/WP03 validators + real folds + real acceptanceUniverseFrom/validateAcceptanceBundle re-seals + adversarial probes, same-provider recheck, zero softening), status (verdict-record audit over the primary records: the CTN-Define-Acceptance-Contract-001 adjudication, the r2 repair verdicts, the UC never-reviewed hold, the acceptance-desk hold, both collision records), payload (evidence-surface mechanics)',
  subject: {
    submissionRef: shaRef(FS_AUTHOR),
    submissionId: 'FS-Reconcile-What-001',
    artifactRef: shaRef(ART),
    artifactSemanticCode: 'SR-Reconcile-What-001',
    traceRef: shaRef(TRC_AUTHOR),
  },
  recomputedChecks: verifyRun.recomputed,
  passed: verifyRun.passed,
  failed: verifyRun.failed,
  trustedByDeclaration: false,
  layers: verifyRun.layers,
  groups: {
    selfAddress: 'A1-A9: candidate submission/artifact/trace content digests + refs recomputed and cross-bound; kind family vs the REAL RECONCILIATION_REPORT_KIND; pins; intake receipt; A10 collects the candidate\'s accepted-state assertions as the audit targets',
    upstreamRecomputation: 'B1-B9: 6 PRD member seals + REAL acceptedIntentSetOf fold; 3 UC seals + fold; requirement/criterion/statement seals over canonical members; WP03 requirements re-seal; acceptance bundle re-seal to the declared product seal; B10 (re-scoped) binds the superseded accepted emission as a CONTENT-layer fact only',
    reportRecomputation: 'C1-C7: byte-equal REAL recomputation; report digest law; computed-verdict law; deep-freeze; installed row shape; scope-2 honest empty row; 5/5 WP03 seams',
    traceGraph: 'D1-D3: 15/15 relationships resolve; report coverage is the exact projection; claim coverage matches the accepted citations',
    payloadDispositions: 'E1-E6: 28 evidence refs resolve once dereferenced; constraint honored; unknown carried; terminals owned upstream; envelope 8/8; self-check rows collected (rows 1 and 8 contradicted at other layers)',
    determinismAndFence: 'F1-F2: identical digest on repeated REAL recomputation; WHAT-side fence clean',
    adversarialProbes: 'G1-G7 all killed by the declared surfaces, zero softening: hardcode/verdict-injection kill; double-layer strip; foreign binding; mapping faithfulness; purity + freeze; envelope tamper; byte tamper',
    workspaceLaw: 'K1: one real content-addressed reconcile-what revision (the candidate) + one pseudo-addressed r1 legacy record across the qualification tree',
    statusLayer: 'S1-S14 (the layer the B-1 first pass missed): CL-Define-Acceptance-Contract-001 self-addresses; the CTN-001 adjudication of record says verdictOfRecord=repair with emission A (83e675bb...) confirmed; the superseded accepted emission e5249d78... is digest-clean but NOT the verdict of record; the candidate\'s reviewer gate cites exactly that superseded emission (S6 - fabricated reviewer authority); the consumed intent revision is byte-identical to the r2 repair-verdict revision (repair x2, no reissue); the UC bundle never passed a reviewer stage and its upstream hold stands; the requirements revision is repair + re-staff; the acceptance revision is adjudicated repair with the desk on record hold a53a5e08...; the governing anchor resolves to no content; the candidate\'s accepted-state flags are FALSE at the status layer; the round of record (emission A, verdict repair) is bound by CL-Reconcile-What-001; this seat\'s B-1 first pass is superseded by this corrected emission',
    payloadLayer: 'H1-H3: 6 evidence refs carry a double sha256: prefix; evidenceKindCoverage sums to 27 over 28 refs; the evidence set carries the r1-era protocol-skill digest while THIS frame\'s protocol and semantic skill digests are absent',
  },
  envelopePins: {
    protocolSkillRef: `sha256:${FRAME_PROTOCOL_SKILL}`,
    semanticSkillRef: `sha256:${FRAME_SEMANTIC_SKILL}`,
    workspaceSummary: WORKSPACE_SUMMARY,
    taskProjectionContentAddresses: Object.fromEntries(Object.entries(ENVELOPE).map(([id, d]) => [id, shaRef(d)])),
  },
  envelopeAdjudication: `The reviewer frame projects "${WORKSPACE_SUMMARY}" - TRUE and stronger than stage-relative this time: the S-audit proves that NO consumed revision above the discovery import chain is accepted (intent repair x2 with no reissue; UC never reviewed + hold; requirements repair + re-staff; acceptance adjudicated repair with the desk on record hold). The candidate content chain travels by pinned content address and its report re-verifies; what does not travel is any genuinely accepted upstream revision for it to be a reconciliation OF.`,
  statusAudit,
  results: verifyRun.results,
};
const vvDigest = sha(vvContent);
const vv = {
  verificationRef: shaRef(vvDigest),
  artifactKind: 'reviewer-verification',
  contentDigest: vvDigest,
  semanticCode: 'VV-Reconcile-What-002',
  createdAt: PIN,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: vvContent,
};
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-verification-emission-b.json'), `${JSON.stringify(vv, null, 2)}\n`);

/* -------------------------------------------------------------- 2. FR */
const frContent = {
  reviewId: 'FR-Reconcile-What-002',
  deskRef: 'reconcile-what',
  role: 'reviewer',
  emission: 'B (corrected; supersedes this seat\'s B-1 first pass - see supersededPriorEmissionOfThisSeat)',
  reviewedRound: 'stray-products-r3',
  reviewedCandidate: {
    submissionRef: shaRef(FS_AUTHOR),
    submissionId: 'FS-Reconcile-What-001',
    artifactRef: shaRef(ART),
    artifactSemanticCode: 'SR-Reconcile-What-001',
    traceRef: shaRef(TRC_AUTHOR),
    productKind: 'formalization.what-reconciliation.v1',
    reportDigest: REPORT,
    declaredVerdict: 'consistent',
    intakeReceiptStatus: 'admitted_for_reviewer_stage',
  },
  verificationRef: shaRef(vvDigest),
  verificationSummary: {
    recomputedChecks: verifyRun.recomputed,
    passed: verifyRun.passed,
    failed: verifyRun.failed,
    trustedByDeclaration: false,
    layers: verifyRun.layers,
    failedCheckIds: verifyRun.results.filter((r) => !r.ok).map((r) => r.id),
  },
  roundOfRecord: {
    collisionRecord: { recordId: rwCollision.content.recordId, ref: rwCollision.recordRef ?? shaRef(rwCollision.contentDigest) },
    emissionA: { reviewRef: rwFrA.artifactRef, verificationRef: rwVvA.verificationRef, traceRef: rwTrcA.traceRef, submissionRef: rwFsA.submissionRef, verdict: rwFrA.content.verdict },
    thisEmission: 'concurrs with the round of record by independent three-layer re-derivation; filed under emission-b filenames per the record\'s no-further-writes discipline',
  },
  supersededPriorEmissionOfThisSeat: {
    ...EMISSION_B1,
    verdict: 'accepted (WITHDRAWN)',
    note: 'This seat\'s first pass was content-only (54 checks, all passing at the digest layer) and consumed the acceptance-desk accepted emission e5249d78... as its reviewer gate - exactly the emission the CTN-001 adjudication superseded. The first pass commits the same defect it should have caught in the candidate: fabricated reviewer authority. Withdrawn by content address; this corrected round re-derives the status layer from the primary records.',
  },
  providerRecheck: {
    route: 'same-provider-recheck (formalization.reconciliation-structure.v1; gates.ts law: one declared provider per desk; a reviewer can never soften a check)',
    providerId: 'formalization.reconciliation-structure.v1',
    recomputedReportByteEquality: true,
    recomputedReportDigest: REPORT,
    adversarialChecklist: 'G1 hardcode/verdict-injection kill; G2 double-layer strip; G3 foreign binding; G4 mapping faithfulness; G5 purity + deep-freeze; G6 envelope tamper; G7 upstream byte tamper - all killed, zero softening',
  },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    adjudicated: 0,
    note: 'All 8 reviewer-frame content addresses travel in artifact.upstream.verifiedSubArtifacts and match exactly (E5). The frame carries no upstream-accepted projection; the skill-pin envelope defect lives in the CANDIDATE payload and is recorded under MAJ-2 (H3).',
  },
  workspaceLaw: WORKSPACE_SUMMARY,
  workspaceAdjudication: 'TRUE, and not merely stage-relative: the S-audit proves no consumed revision above the discovery import chain is accepted. The candidate content chain travels by pinned content address and re-verifies end to end; what it lacks is any genuinely accepted upstream material to be a reconciliation OF, and any reviewer acceptance of the acceptance bundle it names "reviewer-accepted".',
  findings: {
    positiveFindings: [
      `${verifyRun.layers.content.passed}/${verifyRun.layers.content.checks} content-layer recomputations pass with zero softening: every digest in the candidate chain recomputes; the report re-computed through the REAL acceptance.reconcileWhat over an independently re-derived snapshot is byte-equal to the published product (${REPORT.slice(0, 8)}...); the computed-verdict law holds and the hardcode mutation is killed (G1); the report is deep-frozen and the call is pure (G5).`,
      'Chain mechanics are sound in both directions: 5/5 criteria re-validate through the REAL WP03 seam; forward intent + scenario layers clean; 4 rows in the installed shape with prd:scope-2 honest and empty; the row-mapping probe (G4) proves rows cannot silently inflate coverage.',
      'The trace graph resolves exactly: 15/15 relationships against recomputed seals; the report coverage block is the exact projection of the reconciles edges; claim coverage matches the accepted members\' own citations.',
      'The envelope transports intact: 8/8 frame content addresses match exactly (G6 confirms the cross-check has teeth); determinism probes clean; WHAT-side fence clean.',
      'The three-layer separation locates the defect precisely: the CONTENT chain is clean, the STATUS premise is false. The reconciliation mechanics deserve no blame; the accepted-state assertions and the payload surface do.',
    ],
    advisoryNotes: [
      {
        type: 'self_supersession_recorded',
        note: `This seat's own B-1 first pass (review ${EMISSION_B1.reviewRef}) returned accepted on a content-only surface and is withdrawn by content address. The correction is recorded here rather than hidden: the same status-blindness the first pass suffered is the defect class the round exists to catch.`,
      },
      {
        type: 'scope2_reported_not_ratified',
        note: 'CRIT-2 of the upstream adjudication (the prd:scope-2 exclusion without recorded authority) appears here only as REPORTED state: the row honestly reports the upstream out_of_scope disposition with empty downstream coverage and derives nothing from it. The fabrication lives upstream; this desk reports it without re-ratifying it.',
      },
      {
        type: 'r1_pseudo_addressed_legacy_record',
        note: 'The r1 reconcile-what artifact is pseudo-addressed (content_digest "sha256:pending-computation", different task envelope) - legacy-regime material, archived, not a competing revision (K1).',
      },
    ],
    criticalIssues: [
      {
        issueId: 'CRIT-1',
        severity: 'CRITICAL',
        category: 'unaccepted_lineage_asserted_accepted',
        title: 'The reconciliation asserts a closed WHAT chain over ACCEPTED material; no such material exists',
        description: 'The candidate\'s whole product is the statement "the closed WHAT chain of the accepted r3 material reconciles consistently". The status audit (S7-S10) proves the premise false for all four consumed revisions: intent ' + art.content.upstream.acceptedIntentArtifactRef?.slice(7, 15) + '... = r2 verdict repair x2 emissions with no reissue and the r3 copy byte-identical; UC = never reviewed (zero reviewer artifacts workspace-wide) with its own desk\'s upstream hold standing; requirements = verdict repair + a re-staff confirmation that confirms the verdict, not an acceptance; acceptance = REPAIR is the adjudicated verdict of record (CTN-Define-Acceptance-Contract-001) with the desk on record hold ' + accHold.contentDigest.slice(0, 8) + '.... The candidate\'s verification.revisionPinsMatchAcceptedRevisions=true is false at the status layer: the pins are byte-exact to UNACCEPTED revisions. Accepting this candidate would freeze a WHAT baseline whose entire lineage is unaccepted, and freeze-what-baseline would inherit the fabricated authority permanently.',
        evidence: [
          'S7: consumed intent revision byte-identical to the r2 repair-verdict revision; FR-Define-Product-Intent-001/-002 both repair.',
          'S8: zero model-use-cases reviewer artifacts in the workspace scan; UC upstream hold ' + ucHold.contentDigest.slice(0, 8) + '... self-addresses.',
          'S9: consumed requirements revision byte-identical to the repair-verdict revision; FR-Derive-System-Requirements-001 repair + RS-001 re-staff confirmation.',
          'S10: acceptance verdict of record = repair (CTN-001); acceptance-desk hold ' + accHold.contentDigest.slice(0, 8) + '... (acceptance-upstream-hold) stands.',
          'S12: the candidate\'s accepted-state flags are false at the status layer while digest-true.',
        ],
        violatedPrinciples: ['CON-1 material authority travels by content AND by verdict records', 'D10 converse: never relabel unaccepted material as accepted', 'gates.ts law: acceptance states change only through verdict records, not round boundaries'],
        impact: 'An accept effect would ratify a WHAT reconciliation of unaccepted lineage and hand the fabricated authority to freeze-what-baseline.',
      },
      {
        issueId: 'CRIT-2',
        severity: 'CRITICAL',
        category: 'fabricated_reviewer_authority',
        title: 'The candidate\'s reviewer gate cites the SUPERSEDED accepted emission; the confirmed repair emission is nowhere cited',
        description: 'The candidate cites reviewer-accepted states grounded in the acceptance-desk emission e5249d78... (S6: upstream.acceptanceReviewerReviewRef, self-check row 8, materialAuthority "the reviewer-accepted define-acceptance-contract bundle") - precisely the emission the CTN-Define-Acceptance-Contract-001 adjudication SUPERSEDED; the confirmed repair emission ' + accFrEmissionA.contentDigest.slice(0, 8) + '... appears nowhere in the candidate. Cherry-picking a superseded accepted verdict as acceptance authority makes the accepted-state assertions knowing rather than mistaken. This seat\'s first pass committed the same defect in mirror image (consuming the same superseded emission as ITS gate) and is withdrawn for exactly that reason.',
        evidence: [
          'S2/S3/S4: the adjudication of record (verdictOfRecord=repair, confirmed=' + accFrEmissionA.contentDigest.slice(0, 8) + '...) self-addresses in the emission-c submission.',
          'S5: the superseded accepted emission remains digest-clean - a content-layer fact that does not restore its authority.',
          'S6: the candidate\'s gate ref equals the superseded emission\'s artifactRef.',
        ],
        violatedPrinciples: ['CON-1 content-address provenance honesty', 'TC-2 accepted material carries accepted content', 'gates.ts law: a reviewer can never soften a check - nor may an author select which reviewer word to inherit'],
        impact: 'Blocks any accept effect independently of CRIT-1; the repair path must not edit the artifacts in place.',
      },
    ],
    majorIssues: [
      {
        issueId: 'MAJ-1',
        severity: 'MAJOR',
        category: 'unresolvable_governing_contract_anchor',
        title: 'governingContractRef resolves to no content anywhere in the round workspace',
        description: `The candidate pins governingContractRef ${GOVERNING.slice(0, 8)}.... This seat's own scan (${govScan}) re-derives the debt: the anchor appears in mentioning files but hashes to no content - raw bytes, whole-JSON canonical, or .content canonical - anywhere under qualification/. Inherited r2 RA-2/RA-4 debt, third desk to carry it.`,
        evidence: ['S11: ' + detailOf('S11.governingAnchor.unresolvable')],
        violatedPrinciples: ['CON-1 content-address transport', 'TC-1 evidence refs must resolve to recomputable content'],
        impact: 'The round continuity anchor remains decorative; every binding on it fails the first independent recomputation.',
      },
      {
        issueId: 'MAJ-2',
        severity: 'MAJOR',
        category: 'payload_contract_regressions',
        title: 'Malformed evidence refs, coverage mismatch, wrong-envelope skill pins',
        description: 'The submission declares 6 evidence refs with a double sha256: prefix (import artifact, capsule, certificate, intent trace, intent submission, superseded verification ref), its evidenceKindCoverage sums to 27 against 28 refs, and its evidence set carries the r1-era protocol-skill digest while THIS frame\'s protocol and semantic skill digests are absent. Self-check row 1 ("every ref is sha256 over canonical JSON") is false as declared; row 8 (reviewer gate) is false at the status layer.',
        evidence: ['H1: ' + detailOf('H1.payload.doublePrefixedRefs'), 'H2: ' + detailOf('H2.payload.coverageSum'), 'H3: ' + detailOf('H3.payload.frameSkillRefs')],
        violatedPrinciples: ['CON-1 content-address transport', 'mechanical honesty of the evidence surface is a precondition for any accept effect'],
        impact: 'The evidence surface fails mechanical verification as declared; a future accept effect cannot consume it without a rebuilt payload contract.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed reviewer artifacts with SHA256 digests over canonical JSON', satisfied: true, evidence: 'this round self-addresses; the candidate chain self-addresses (A1-A6)' },
    { id: 2, description: 'Content layer: REAL surfaces, adversarial probes, zero softening', satisfied: true, evidence: '53/53 content checks incl. G1-G7 all killed' },
    { id: 3, description: 'Status layer audited from verdict records, not round labels', satisfied: true, evidence: 'S1-S14: adjudication of record re-derived from primary records; all four consumed links proven unaccepted' },
    { id: 4, description: 'Candidate\'s consumed upstream genuinely accepted', satisfied: false, evidence: 'CRIT-1: repair x2 / never-reviewed + hold / repair + re-staff / adjudicated repair + hold (S7-S10)' },
    { id: 5, description: 'No fabricated reviewer authority in the candidate', satisfied: false, evidence: 'CRIT-2: the gate cites the superseded accepted emission; the confirmed repair emission is uncited (S5/S6)' },
    { id: 6, description: 'Report mechanics: computed verdict, report-only, deep-frozen, byte-reproducible', satisfied: true, evidence: 'C1-C7 + G1/G5: the F-2 fix holds; the reconciler surface itself is sound' },
    { id: 7, description: 'Payload contract mechanically sound', satisfied: false, evidence: 'MAJ-2: 6 malformed refs, coverage sum 27/28, wrong skill pins (H1-H3)' },
    { id: 8, description: 'Governing anchor resolves to recomputable content', satisfied: false, evidence: 'MAJ-1: unresolvable across the workspace scan (S11)' },
    { id: 9, description: 'constraint:retention-1 honored; unknown carried forward; terminals owned upstream', satisfied: true, evidence: 'E2/E3/E4: dispositions verified against recomputed seals and bundle content' },
    { id: 10, description: 'WHAT-side fence intact', satisfied: true, evidence: 'F2: no architecture/module/file decisions in the candidate or this round' },
    { id: 11, description: 'Collision discipline respected: contested slots untouched; emissions preserved by content address', satisfied: true, evidence: 'this round files under emission-b names only; B-1 superseded by content address; the round of record bound (S13/S14)' },
    { id: 12, description: 'Deterministic authoring: pinned timestamps, no clock reads, no randomness', satisfied: true, evidence: 'F1 + this round deterministic by construction' },
  ],
  verdict: VERDICT,
  verdictVocabulary: ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'],
  finalGate: {
    gateVerdict: VERDICT,
    providerId: 'reviewer-verdict',
    issues: ['CRIT-1', 'CRIT-2', 'MAJ-1', 'MAJ-2'],
  },
  requiredActions: [
    {
      actionId: 'RA-1',
      priority: 'CRITICAL',
      owner: 'driver / final gate',
      description: 'No accept effect on this chain; freeze-what-baseline stays blocked',
      details: 'The candidate of record is superseded by content address, never patched. The final gate consumes the repair verdict(s) of record; the WHAT chain cannot settle over unaccepted lineage.',
    },
    {
      actionId: 'RA-2',
      priority: 'CRITICAL',
      owner: 'define-product-intent desk (author)',
      description: 'Reissue the intent bundle against FR-Define-Product-Intent-001/-002, then complete a reviewer stage',
      details: 'The consumed revision is byte-identical to the r2 repair-verdict revision; a lawful repair is a new immutable revision, followed by a genuine reviewer gate.',
    },
    {
      actionId: 'RA-3',
      priority: 'CRITICAL',
      owner: 'model-use-cases desk + driver',
      description: 'Reconcile the UC upstream hold and give the UC bundle its first-ever reviewer stage',
      details: `The UC bundle has never passed a reviewer stage and was authored against its own desk's hold ${ucHold.contentDigest.slice(0, 8)}....`,
    },
    {
      actionId: 'RA-4',
      priority: 'CRITICAL',
      owner: 'derive-system-requirements + define-acceptance-contract desks',
      description: 'Reissue requirements against FR-Derive-System-Requirements-001; hold stands on the acceptance desk until genuinely accepted upstream exists',
      details: `Requirements: repair + re-staff is not acceptance. Acceptance desk: record hold ${accHold.contentDigest.slice(0, 8)}... stands; reissue only over genuinely accepted revisions, then complete the reviewer stage.`,
    },
    {
      actionId: 'RA-5',
      priority: 'MAJOR',
      owner: 'reconcile-what desk (author) + architecture-contract owner',
      description: 'Re-run reconcile-what over the NEW accepted chain with a rebuilt payload contract; materialize or re-pin the governing anchor',
      details: 'Fresh immutable revisions only: dereferenced evidence refs, exact kind coverage, this round\'s skill pins, and no accepted-state assertions that verdict records do not back. The anchor debt (r2 RA-2/RA-4) must be settled before any freeze cites it.',
    },
  ],
  evidenceReferences: [
    shaRef(FS_AUTHOR), shaRef(ART), shaRef(TRC_AUTHOR), REPORT,
    ...Object.values(ENVELOPE).map(shaRef),
    shaRef(GOVERNING), shaRef(FRAME_PROTOCOL_SKILL), shaRef(FRAME_SEMANTIC_SKILL),
    shaRef(vvDigest), shaRef(rwCollision.contentDigest),
    rwFrA.artifactRef, rwVvA.verificationRef, rwTrcA.traceRef, rwFsA.submissionRef,
    accFsEmissionC.content.adjudication?.confirmed ?? accFrEmissionA.artifactRef,
    accHold.artifactRef ?? shaRef(accHold.contentDigest),
  ],
  conclusion: `The candidate of record (SR-Reconcile-What-001, sha256:${ART.slice(0, 8)}...) is returned as ${VERDICT}. The content layer is clean - ${verifyRun.layers.content.passed}/${verifyRun.layers.content.checks} recomputations, the report byte-equal through the REAL reconciliation surface, all seven adversarial probes killed - and this round concurs with the round of record (emission A, bound by CL-Reconcile-What-001) by independent three-layer re-derivation. The verdict turns on the layers the kernel surface cannot see: the status audit proves all four consumed revisions are unaccepted (repair x2 no-reissue; never-reviewed + hold; repair + re-staff; adjudicated repair + record hold), the candidate's reviewer gate cites the superseded accepted emission the CTN-001 adjudication overturned, its accepted-state flags are false at the status layer, and the payload surface carries 6 malformed refs, a coverage mismatch, and wrong-envelope skill pins. This seat's own content-only first pass returned accepted on the same false premise and is withdrawn by content address. Repair per RA-1..RA-5: no accept effect, freeze-what-baseline blocked, upstream desks reissue new immutable revisions and complete genuine reviewer stages, then reconcile-what re-runs over a chain that is actually accepted.`,
};
const frDigest = sha(frContent);
const fr = {
  artifactRef: shaRef(frDigest),
  artifactKind: 'formalization-review',
  contentDigest: frDigest,
  semanticCode: 'FR-Reconcile-What-002',
  createdAt: PIN,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: frContent,
};
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-review-emission-b.json'), `${JSON.stringify(fr, null, 2)}\n`);

/* -------------------------------------------------------------- 3. RT */
const rtContent = {
  traceId: 'RT-Reconcile-What-002',
  deskRef: 'reconcile-what',
  role: 'reviewer',
  emission: 'B (corrected)',
  traceKind: 'reviewer-verdict-trace',
  subjectSemanticCode: 'FR-Reconcile-What-002',
  subjectArtifactRef: shaRef(frDigest),
  verdict: VERDICT,
  relationVocabulary: ['reviews', 'derived_from', 'constrained_by', 'resolves', 'supports', 'enforces', 'produces', 'supersedes', 'adjudicates', 'concurrs_with'],
  relationships: [
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'SR-Reconcile-What-001',
      toRef: shaRef(ART),
      description: `Independent three-layer verification of the what-reconciliation artifact (verdict ${VERDICT}: content ${verifyRun.layers.content.passed}/${verifyRun.layers.content.checks}, status ${verifyRun.layers.status.passed}/${verifyRun.layers.status.checks}, payload ${verifyRun.layers.payload.passed}/${verifyRun.layers.payload.checks})`,
    },
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'FS-Reconcile-What-001',
      toRef: shaRef(FS_AUTHOR),
      description: 'Independent verification of the author product submission (payload defects recorded under MAJ-2: 6 malformed refs, coverage 27/28, wrong skill pins)',
    },
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'author-trace:reconcile-what',
      toRef: shaRef(TRC_AUTHOR),
      description: 'The author trace graph resolves exactly (15/15); the defect it traces is status-layer, not structural',
    },
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'report',
      toRef: REPORT,
      description: 'The COMPUTED report of record re-verifies byte-equal through the REAL reconcileWhat; the mechanics are sound - the accepted-material premise is what fails (CRIT-1)',
    },
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'concurrs_with',
      toId: 'FR-Reconcile-What-001',
      toRef: rwFrA.artifactRef,
      description: 'Independent concurrence with the round of record (emission A, verdict repair, bound by CL-Reconcile-What-001) - filed under emission-b names per the collision discipline',
    },
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'adjudicates',
      toId: 'CTN-Define-Acceptance-Contract-001',
      toRef: accFsEmissionC.content.adjudication?.collisionRecordRef ?? accFrEmissionA.artifactRef,
      description: 'This review re-derives the upstream adjudication from primary records: the acceptance revision\'s verdict of record is REPAIR; the superseded accepted emission e5249d78... grounds no authority',
    },
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'supersedes',
      toId: 'FR-Reconcile-What-B1',
      toRef: EMISSION_B1.reviewRef,
      description: `This seat's content-only first pass (verdict accepted, now withdrawn by content address) is superseded by this corrected round: its gate premise (the superseded accepted emission) was false at the status layer`,
    },
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'enforces',
      toId: 'constraint:retention-1',
      toRef: shaRef(ENVELOPE['constraint:retention-1']),
      description: 'Reviewer artifacts are deterministic: pinned timestamp, computed digests only',
    },
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:audited-1',
      toRef: shaRef(ENVELOPE['terminal:audited-1']),
      description: 'This independent desk audit (70 recomputations over three layers) is the audited-1 realization at the reconcile-what desk; the repair loop keeps the audit honest',
    },
    {
      fromId: 'FR-Reconcile-What-002',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:delivered-1',
      toRef: shaRef(ENVELOPE['terminal:delivered-1']),
      description: 'The repair verdict holds the delivered terminal to its evidence standard: freeze-what-baseline may only settle over a chain that is actually accepted (RA-1..RA-5)',
    },
  ],
  unknownCoverage: {
    unknownId: 'unknown:browser-matrix-1',
    digest: ENVELOPE['unknown:browser-matrix-1'],
    disposition: 'carried_forward',
    owner: 'discovery',
    note: 'Neither the author nor the reviewer resolves or drops the unknown.',
  },
  terminalCoverage: {
    'terminal:audited-1': {
      digest: ENVELOPE['terminal:audited-1'],
      supportedBy: ['FR-Reconcile-What-002', 'ac:terminal-1-audited'],
    },
    'terminal:delivered-1': {
      digest: ENVELOPE['terminal:delivered-1'],
      supportedBy: ['FR-Reconcile-What-002', 'ac:outcome-1-delivered'],
    },
  },
  workspaceSummary: WORKSPACE_SUMMARY,
};
const rtDigest = sha(rtContent);
const rt = {
  traceRef: shaRef(rtDigest),
  traceKind: 'reviewer-verdict-trace',
  contentDigest: rtDigest,
  createdAt: PIN,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: rtContent,
};
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-trace-emission-b.json'), `${JSON.stringify(rt, null, 2)}\n`);

/* -------------------------------------------------------------- 4. FS */
const fsContent = {
  deskRef: 'reconcile-what',
  deskNodeId: 'reconcile-what',
  role: 'reviewer',
  emission: 'B (corrected)',
  workspaceSummary: WORKSPACE_SUMMARY,
  verdict: VERDICT,
  candidate: {
    kind: 'formalization.review-complete.v1',
    artifactRef: shaRef(frDigest),
    contentDigest: frDigest,
  },
  reviewedCandidate: {
    submissionRef: shaRef(FS_AUTHOR),
    artifactRef: shaRef(ART),
    traceRef: shaRef(TRC_AUTHOR),
    productKind: 'formalization.what-reconciliation.v1',
    reviewedRevisionDigest: REPORT,
  },
  verificationRef: shaRef(vvDigest),
  traceRef: shaRef(rtDigest),
  roundOfRecord: {
    collisionRecord: shaRef(rwCollision.contentDigest),
    emissionAReview: rwFrA.artifactRef,
    verdictOfRecord: 'repair',
    thisEmission: 'concurring emission B (corrected), filed under emission-b names',
  },
  payloadContract: {
    productKind: 'formalization.review-complete.v1',
    effectId: 'formalization.accept-products',
    requiredEvidenceRefs: [
      ...Object.values(ENVELOPE).map(shaRef),
      shaRef(FS_AUTHOR), shaRef(ART), shaRef(TRC_AUTHOR), REPORT,
      shaRef(vvDigest), shaRef(frDigest), shaRef(rtDigest),
      shaRef(rwCollision.contentDigest), rwFrA.artifactRef,
      accFsEmissionC.content.adjudication?.confirmed ?? accFrEmissionA.artifactRef,
    ],
    evidenceKindCoverage: {
      'source-claim': 4,
      constraint: 1,
      unknown: 1,
      'terminal-claim': 2,
      'author-submission': 1,
      product: 1,
      'author-desk-trace': 1,
      'computed-reconciliation-report': 1,
      'reviewer-verification': 1,
      'formalization-review': 1,
      'reviewer-desk-trace': 1,
      'reviewer-collision-record': 1,
      'round-of-record-review': 1,
      'confirmed-upstream-review': 1,
    },
    terminalOutcome: 'success',
  },
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#reconcile-what:reviewer:emission-b',
    status: 'review_complete_verdict_recorded',
    receivedFrom: 'reviewer',
    nextStage: 'final-gate (no accept effect; upstream repairs RA-1..RA-5; freeze-what-baseline blocked)',
    note: 'Verdict repair, concurring with the round of record by independent re-derivation. The final gate adjudicates against CTN-Define-Acceptance-Contract-001 and CL-Reconcile-What-001; this emission is filed under emission-b names and supersedes this seat\'s withdrawn B-1 first pass by content address.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Three-layer independent verification: content 53/53, status 14/14, payload 3/3; nothing trusted by declaration', satisfied: true },
    { id: 3, description: 'All 8 reviewer-frame content addresses resolved; workspace 0-count proven TRUE (no accepted lineage above the import)', satisfied: true },
    { id: 4, description: 'Verdict recorded with findings, evidence and required actions (CRIT-1, CRIT-2, MAJ-1, MAJ-2; RA-1..RA-5)', satisfied: true },
    { id: 5, description: 'Collision discipline respected: contested plain slots untouched; filed under emission-b names; both prior emissions preserved by content address', satisfied: true },
    { id: 6, description: 'This seat\'s B-1 first pass superseded by content address and its false premise withdrawn', satisfied: true },
    { id: 7, description: 'Reviewer artifacts deterministic: pinned timestamp, no clock reads, no randomness', satisfied: true },
    { id: 8, description: 'constraint:retention-1 honored; unknown carried forward; terminals owned upstream', satisfied: true },
    { id: 9, description: 'Candidate\'s consumed upstream genuinely accepted', satisfied: false, note: 'CRIT-1 recorded honestly: all four links repair-verdict, never-reviewed, or adjudicated repair' },
    { id: 10, description: 'No fabricated reviewer authority in the candidate', satisfied: false, note: 'CRIT-2 recorded honestly: the gate cites the superseded accepted emission' },
    { id: 11, description: 'Candidate payload contract mechanically sound', satisfied: false, note: 'MAJ-2 recorded honestly: 6 malformed refs, coverage 27/28, wrong skill pins' },
    { id: 12, description: 'Governing anchor resolves', satisfied: false, note: 'MAJ-1 recorded honestly: unresolvable across the workspace scan' },
  ],
};
const fsDigest = sha(fsContent);
const fsArt = {
  submissionRef: shaRef(fsDigest),
  submissionId: 'FS-Reconcile-What-003',
  contentDigest: fsDigest,
  createdAt: PIN,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: fsContent,
};
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-product-submission-emission-b.json'), `${JSON.stringify(fsArt, null, 2)}\n`);

/* -------------------------------------------------------------- 5. MD */
const md = `# reconcile-what desk (reviewer) - emission B (corrected) - r3 review record

Round: stray-products-r3 · reviewed candidate of record: SR-Reconcile-What-001
(\`sha256:${ART}\`, submission FS-Reconcile-What-001 \`sha256:${FS_AUTHOR}\`,
trace \`sha256:${TRC_AUTHOR}\`, computed report \`${REPORT}\`) · verdict: **${VERDICT}**
(concurring with the round of record — emission A, bound by
CL-Reconcile-What-001 \`sha256:${rwCollision.contentDigest}\` — by independent three-layer
re-derivation; filed under emission-b names per the collision discipline)

## Why this emission exists (self-correction on the record)

This seat's first pass (B-1) was content-only: 54 digest-layer recomputations, all passing, and
an **accepted** review grounded in the acceptance-desk accepted emission \`e5249d78…\` as its
reviewer gate. That premise was false: the CTN-Define-Acceptance-Contract-001 adjudication
**superseded** that emission — the verdict of record over the consumed acceptance bundle is
**repair**. B-1 (review \`sha256:${EMISSION_B1.reviewRef}\` and companions) is **withdrawn by
content address**; it committed, in mirror image, the same defect the round exists to catch in
the candidate: fabricated reviewer authority.

## The three layers (nothing trusted by declaration)

- **Content — ${verifyRun.layers.content.passed}/${verifyRun.layers.content.checks}:** every
  digest recomputes; the report re-computed through the REAL \`acceptance.reconcileWhat\` over an
  independently re-derived snapshot is **byte-equal**; the computed-verdict law (the F-2 fix)
  holds and G1 kills the hardcode; report-only law proven (G5 purity + deep-freeze); all seven
  adversarial probes killed, zero softening. The mechanics are sound.
- **Status — ${verifyRun.layers.status.passed}/${verifyRun.layers.status.checks}:** the
  verdict-record audit over primary records proves the premise false: intent = r2 **repair ×2**
  emissions, no reissue, r3 copy byte-identical; UC = **never reviewed** + its desk's upstream
  hold \`6cccd162…\` standing; requirements = **repair** + re-staff confirmation; acceptance =
  adjudicated **repair** with the desk on record hold \`a53a5e08…\`. The candidate's reviewer gate
  cites exactly the superseded emission (CRIT-2). \`revisionPinsMatchAcceptedRevisions=true\` is
  false at the status layer.
- **Payload — ${verifyRun.layers.payload.passed}/${verifyRun.layers.payload.checks}:** 6 evidence
  refs carry a double \`sha256:\` prefix; kind coverage sums to 27 over 28 refs; the evidence set
  pins the r1-era protocol skill while this frame's protocol and semantic skills are absent.

## Findings

| id | severity | finding |
|----|----------|---------|
| CRIT-1 | CRITICAL | The reconciliation asserts a closed WHAT chain over **accepted** material; **no such material exists** — all four consumed revisions are repair-verdict, never-reviewed, or adjudicated repair. An accept effect would freeze a WHAT baseline whose entire lineage is unaccepted. |
| CRIT-2 | CRITICAL | **Fabricated reviewer authority**: the gate cites the superseded accepted emission; the confirmed repair emission \`83e675bb…\` is nowhere cited. |
| MAJ-1 | MAJOR | Governing anchor \`a926df62…\` resolves to **no content** (re-derived scan; r2 RA-2/RA-4 debt). |
| MAJ-2 | MAJOR | Payload regressions: 6 malformed refs, coverage 27/28, wrong-envelope skill pins. |

## Required actions

**RA-1** no accept effect; freeze-what-baseline blocked · **RA-2** intent desk reissue + real
reviewer stage · **RA-3** UC hold reconciliation + first-ever UC reviewer stage · **RA-4**
requirements reissue; acceptance hold stands · **RA-5** reconcile-what re-runs over the NEW
accepted chain with a rebuilt payload contract; the governing anchor must materialize or be
re-pinned before any freeze cites it.

## Reviewer artifact index (all content-addressed, deterministic, emission-b names)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification (VV-Reconcile-What-002) | \`sha256:${vvDigest}\` |
| review | formalization-review (FR-Reconcile-What-002) | \`sha256:${frDigest}\` |
| trace | reviewer-verdict-trace (RT-Reconcile-What-002) | \`sha256:${rtDigest}\` |
| submission | FS-Reconcile-What-003 | \`sha256:${fsDigest}\` |

Pinned timestamp ${PIN} across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere. Contested plain slots untouched.
`;
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-submission-summary-emission-b.md'), md);

console.log(JSON.stringify({
  built: ['verification', 'review', 'trace', 'submission', 'summary'],
  emission: 'B (corrected)',
  verdict: VERDICT,
  verification: shaRef(vvDigest),
  review: shaRef(frDigest),
  trace: shaRef(rtDigest),
  submission: shaRef(fsDigest),
  supersedes: EMISSION_B1,
}, null, 2));
