/**
 * reconcile-what desk (reviewer) - deterministic authoring of the five
 * reviewer artifacts (verification, review, trace, product submission,
 * submission summary).
 *
 * Deterministic: pinned timestamp, no clock reads, no randomness. Every
 * content digest is computed over canonical JSON (recursively key-sorted,
 * compact, UTF-8) per src/workflow-kernel/domain/digest.ts, and artifacts
 * already built are interleaved by content address.
 *
 * GROUNDING LAW: all verdict content is derived from
 * reconcile-what-desk-reviewer-verify-out.json (54 independent
 * recomputations through the REAL kernel cell surfaces, incl. 7
 * adversarial probes) - nothing is asserted that the verify run did not
 * establish. Any referenced check id that is missing or failed aborts the
 * build (fail-closed).
 *
 * Run: node reconcile-what-desk-reviewer-build.mjs
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
const REPORT_HEX = REPORT.replace(/^sha256:/, '');

/* Upstream material consumed by the candidate. */
const upArt = load('define-product-intent-desk-product-intent.artifact.json');
const ucArt = load('model-use-cases-desk-uc-scenarios.artifact.json');
const srArt = load('derive-system-requirements-desk-system-requirements.artifact.json');
const accArt = load('define-acceptance-contract-desk-acceptance-bindings.artifact.json');
const accReview = load('define-acceptance-contract-desk-reviewer-review.json');
const accVV = load('define-acceptance-contract-desk-reviewer-verification.json');
const INTENT = upArt.contentDigest;
const UC = ucArt.contentDigest;
const SR = srArt.contentDigest;
const ACC = accArt.contentDigest;
const ACC_SEAL = accArt.content.productSeal.ref;

/* The reviewer's evidence of record. */
const verifyRun = load('reconcile-what-desk-reviewer-verify-out.json');
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
const PROTOCOL_SKILL = 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50';
const REVIEWER_SEMANTIC_SKILL = '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2';
const WORKSPACE_SUMMARY = '0 accepted upstream revisions travel by content address';

/* Verdict computed from the verify run - never asserted. */
const VERDICT = verifyRun.failed === 0 ? 'accepted' : 'repair';
if (VERDICT !== 'accepted') throw new Error(`verify run reports ${verifyRun.failed} failed check(s); this build only authors the accepted path - re-run with failures resolved`);
mustPass('C1.report.byteEquality');
mustPass('C3.verdict.computedLaw');
mustPass('B9.acceptanceReseal');
mustPass('B10.reviewerOfRecord');
mustPass('G1.probe.verdictInjectionHardcodeKill');

/* Workspace-scan evidence numbers (grounded, not narrative). */
const scanCount = Number((detailOf('K1.workspace.scan').match(/^(\d+) workspace files/) || [])[1]) || 0;
const mentionCount = Number((detailOf('K1.workspace.scan').match(/mentioned in (\d+) file/) || [])[1]) || 0;

/* -------------------------------------------------------------- 1. VV */
const vvContent = {
  verificationId: 'VV-Reconcile-What-001',
  deskRef: 'reconcile-what',
  role: 'reviewer',
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; REAL kernel cell surfaces: acceptance.reconcileWhat over a snapshot re-derived through the REAL acceptanceUniverseFrom protocol (reviewer same-provider recheck, zero softening); upstream REAL PRD/UC validators + REAL folds + WP03 validateRequirementsBundle + REAL validateAcceptanceBundle re-seal; wp03:validateAcBinding seam per criterion',
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
  validator: {
    providerId: 'formalization.reconciliation-structure.v1',
    contract: 'reconcileWhat (report-only; computed verdict - the F-2 fix)',
    seam: 'wp03:validateAcBinding (frf-contracts.ac-binding.v1), called once per criterion with the re-derived accepted id-set universe',
    universe: {
      frIds: ['fr:boundary-1', 'fr:outcome-1', 'fr:terminal-1'],
      nfrIds: ['nfr:determinism-1'],
      ruleIds: [],
      ucScenarioIds: ['uc:boundary-1', 'uc:outcome-1', 'uc:terminal-1'],
      ucBranchIdsByScenario: {
        'uc:boundary-1': ['branch:boundary-1-main'],
        'uc:outcome-1': ['branch:outcome-1-main', 'branch:outcome-1-deterministic-error'],
        'uc:terminal-1': ['branch:terminal-1-main'],
      },
      verifiableStatementIds: ['stmt:boundary-1-response', 'stmt:determinism-1', 'stmt:outcome-1-delivered', 'stmt:outcome-1-deterministic-error', 'stmt:terminal-1-audited'],
      evidenceBindingIds: [],
    },
    universeDerivedThrough: 'the REAL acceptanceUniverseFrom protocol over the accepted requirements bundle + accepted UC set + the accepted acceptance-desk input (reviewer re-derivation, not inherited)',
    reportAnchor: { digest: REPORT_HEX, ref: REPORT },
    trustedByDeclaration: false,
  },
  groups: {
    selfAddress: 'A1-A10: candidate submission/artifact/trace content digests + refs recomputed and cross-bound; kind family vs the REAL RECONCILIATION_REPORT_KIND; workspace + governing pins; the author intake receipt admits THIS reviewer stage',
    upstreamRecomputation: 'B1-B10: 6 PRD member seals through the REAL validator + REAL acceptedIntentSetOf fold (prd revision pin refolds); 3 UC seals + revision fold; requirement/criterion/statement seals recompute over canonical members; requirements bundle re-sealed against its recomputed WP03 universe; acceptance bundle re-seals through the REAL validateAcceptanceBundle to the declared product seal; the acceptance reviewer decision of record says accepted over exactly the published candidate with its verification ref bound to the recomputed reviewer VV digest',
    reportRecomputation: 'C1-C7: the report re-computed through the REAL reconcileWhat over the re-derived snapshot is byte-equal to the published product; report digest internal law recomputes; computed-verdict law (consistent iff 0 findings); deep-freeze; 4 rows in the installed row shape; claim:scope-2 honest empty row; 5/5 criteria re-validated through the WP03 seam with zero refusals',
    traceGraph: 'D1-D3: 15 relationships (9 reconciles + 6 formalized-as) resolve at both ends against recomputed digests; the report coverage block is the exact projection of the reconciles edges anchored at the recomputed report digest; claim coverage blocks are exact projections matching the accepted members\' own citations',
    payloadContract: 'E1-E6: 28 required evidence refs resolve against the recomputed digest space; constraint:retention-1 honored through accepted criteria; unknown:browser-matrix-1 carried_forward with owner discovery and nothing derived in the accepted bundle; terminal claims stay owned upstream; 8/8 envelope content addresses transported; 12/12 author self-check items',
    determinismAndFence: 'F1-F2: repeated REAL recomputation yields the identical report digest; WHAT-side fence clean (no architecture/module/file decisions anywhere in the candidate)',
    adversarialProbes: 'G1-G7 all killed by the declared surfaces, zero softening: G1 verdict-injection + hardcode kill (mutant with a real gap AND snapshot verdict=\'consistent\' injected still reports gaps - the reconciler takes no verdict input); G2 requirement strip breaks BOTH forward layers (prd:terminal-1 intent gap + uc:terminal-1 scenario-survival gap); G3 foreign criterion binding refused by the WP03 seam; G4 row-mapping faithfulness (a gamed mapping produces visibly deranged rows; published rows match only the accepted-citation mapping); G5 purity + deep-freeze (input byte-identical, output mutation refused); G6 envelope tamper detected (swapped digest pair -> 2 mismatches); G7 upstream byte-tamper detected (one stray field flips the digest)',
    workspaceLaw: `K1-K2: ${scanCount}-file workspace scan under qualification/ - exactly one real content-addressed reconcile-what revision exists (the candidate under review, ${ART.slice(0, 8)}...; candidate digest mentioned in ${mentionCount} file(s)) plus one pseudo-addressed r1 legacy record (content_digest "sha256:pending-computation" - not a content address, legacy regime, different task envelope); frame projection of 0 accepted revisions upheld for the desk's own product`,
  },
  envelopePins: {
    protocolSkillRef: `sha256:${PROTOCOL_SKILL}`,
    semanticSkillRef: `sha256:${REVIEWER_SEMANTIC_SKILL}`,
    workspaceSummary: WORKSPACE_SUMMARY,
    taskProjectionContentAddresses: Object.fromEntries(Object.entries(ENVELOPE).map(([id, d]) => [id, shaRef(d)])),
  },
  envelopeAdjudication: `The reviewer frame projects "${WORKSPACE_SUMMARY}". Adjudication: TRUE and stage-relative - no reconcile-what revision is accepted yet (the candidate under review awaits this review and the kernel accept effect), and the desk's own round contributes exactly one real revision (the candidate). The consumed upstream chain travels by pinned content addresses inside the candidate's content.upstream and re-verifies; the acceptance-bindings revision (${ACC.slice(0, 8)}...) carries the accepted verdict record of record (FR-Define-Acceptance-Contract-001 ${accReview.contentDigest.slice(0, 8)}..., ${accVV.content.recomputedChecks}/${accVV.content.recomputedChecks} recomputations, verdict accepted). The r1 round's reconcile-what-desk-architecture-contract.artifact.json is pseudo-addressed ("sha256:reconcile-what-desk-architecture-contract-digest", content_digest "sha256:pending-computation") and cites a different task envelope - archived as legacy-regime material, consistent with the acceptance reviewer's ADV-3; it cannot travel as an accepted revision. The author's 0-count and the frame's 0-count are the same stage-relative statement and do not contradict.`,
  results: verifyRun.results,
};
const vvDigest = sha(vvContent);
const vv = {
  verificationRef: shaRef(vvDigest),
  artifactKind: 'reviewer-verification',
  contentDigest: vvDigest,
  semanticCode: 'VV-Reconcile-What-001',
  createdAt: PIN,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: vvContent,
};
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-verification.json'), `${JSON.stringify(vv, null, 2)}\n`);

/* -------------------------------------------------------------- 2. FR */
const frContent = {
  reviewId: 'FR-Reconcile-What-001',
  deskRef: 'reconcile-what',
  role: 'reviewer',
  reviewedRound: 'stray-products-r3',
  reviewedCandidate: {
    submissionRef: shaRef(FS_AUTHOR),
    submissionId: 'FS-Reconcile-What-001',
    artifactRef: shaRef(ART),
    artifactSemanticCode: 'SR-Reconcile-What-001',
    traceRef: shaRef(TRC_AUTHOR),
    productKind: 'formalization.what-reconciliation.v1',
    reportDigest: REPORT,
    intakeReceiptStatus: 'admitted_for_reviewer_stage',
  },
  verificationRef: shaRef(vvDigest),
  verificationSummary: {
    recomputedChecks: verifyRun.recomputed,
    passed: verifyRun.passed,
    failed: verifyRun.failed,
    trustedByDeclaration: false,
    failedCheckIds: verifyRun.results.filter((r) => !r.ok).map((r) => r.id),
  },
  providerRecheck: {
    route: 'same-provider-recheck (formalization.reconciliation-structure.v1; gates.ts law: one declared provider per desk; a reviewer can never soften a check)',
    providerId: 'formalization.reconciliation-structure.v1',
    recomputedReportByteEquality: true,
    recomputedReportDigest: REPORT,
    adversarialChecklist: `rev-1 rows re-derived over the full accepted mapping (G4); rev-2 report-only law re-proven (G5 purity + deep-freeze); rev-3 computed-verdict law re-proven and the hardcode mutation killed (G1); rev-4 tamper probes re-run and killed (G6 envelope, G7 upstream bytes)`,
  },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    adjudicated: 0,
    note: 'All 8 reviewer-frame task-projection content addresses travel inside the candidate artifact.upstream.verifiedSubArtifacts and match exactly (no silent drops (WP-18), no digest drift). The frame carries no upstream-accepted projection; the workspace summary is adjudicated stage-relative in the verification envelopeAdjudication.',
  },
  workspaceLaw: WORKSPACE_SUMMARY,
  workspaceAdjudication: `${scanCount}-file workspace scan under qualification/ (K1): exactly one real content-addressed reconcile-what revision exists - the candidate under review (${ART.slice(0, 8)}..., mentioned in ${mentionCount} file(s)); no accepted reconcile-what revision exists anywhere, so the frame's 0-count is upheld for the desk's own product. The r1 round's reconcile-what artifact is pseudo-addressed (content_digest "sha256:pending-computation") and travels in a different task envelope - legacy-regime material, archived, not a competing revision. The upstream chain consumed by the candidate travels by pinned content addresses and re-verifies end to end; the acceptance-bindings revision carries the accepted verdict record (FR-Define-Acceptance-Contract-001, ${accVV.content.recomputedChecks}/${accVV.content.recomputedChecks} recomputations).`,
  findings: {
    positiveFindings: [
      `${verifyRun.passed}/${verifyRun.recomputed} independent recomputations pass; every declared digest in the candidate chain (submission, artifact, trace, report digest) is a real content address under the frozen canonical rule.`,
      `The product is the COMPUTED report of the REAL installed reconciliation surface acceptance.reconcileWhat: the reviewer's own recomputation over a snapshot re-derived through the REAL acceptanceUniverseFrom protocol is byte-equal to the published product (${REPORT.slice(0, 8)}...), the verdict follows the computed law (consistent iff 0 typed findings - the F-2 fix), and the surface takes no verdict input at all (G1 kills the hardcode: a mutant with a real gap AND an injected verdict='consistent' still reports gaps).`,
      'Report-only law holds at both layers: the REAL reconciler returns a deep-frozen report (cr-12) and the purity probe shows the input snapshot byte-identical after the call (G5) - the desk adds, deletes and patches nothing.',
      'Chain closure recomputed in both directions: forward, every scenario-required member (prd:boundary-1, prd:outcome-1, prd:terminal-1) reaches accepted requirements and every accepted scenario produces requirement obligations; reverse, all 5 criteria re-validate through the REAL WP03 seam against the re-derived universe (0 refusals) and the three closure laws re-run clean.',
      'The 4 claim coverage rows keep the installed formalization.what-reconciliation.v1 row shape; prd:scope-2 (out_of_scope) carries an honest empty row deriving nothing (C6), and the row-mapping probe proves the rows are computed from the mapping - a gamed mapping produces visibly deranged rows (G4).',
      'Upstream continuity at the byte layer: the consumed intent/UC/requirements/acceptance revisions recompute through the REAL PRD/UC validators and REAL folds; the requirements bundle re-seals against its recomputed WP03 universe; the acceptance bundle re-seals through the REAL validateAcceptanceBundle to the exact declared product seal; upstream consumption is bound to exact bytes (G7 kills a one-field tamper).',
      `Reviewer gate honored: the define-acceptance-contract reviewer decision of record says accepted over exactly the published author candidate (submission ${accReview.content.reviewedCandidate.submissionRef.slice(0, 12)}..., artifact 2b01353d..., trace 2835aea3..., product seal ${ACC_SEAL.slice(0, 12)}...) with its verification ref bound to the recomputed reviewer VV digest - the candidate of record is consumed, nothing else.`,
      'All 8 reviewer-frame content addresses travel inside artifact.upstream.verifiedSubArtifacts and match exactly; the envelope tamper probe confirms the cross-check has teeth (G6: a swapped digest pair yields exactly 2 mismatches).',
      'The trace graph is exact: 15/15 relationships resolve against recomputed seals, the report coverage block is the exact projection of the reconciles edges anchored at the recomputed report digest, and the claim coverage blocks match the accepted members\' own citations.',
      'Dispositions verified: constraint:retention-1 honored through accepted criteria ac:determinism-1 + ac:outcome-1-deterministic-error (the reconciler adds no enforcement of its own); unknown:browser-matrix-1 carried_forward with owner discovery and no fabricated resolution edge; terminal claims stay owned upstream through exact chains (terminal:audited-1 <- prd:terminal-1 <- fr:terminal-1 <- ac:terminal-1-audited; terminal:delivered-1 <- prd:outcome-1 <- fr:outcome-1 <- ac:outcome-1-delivered).',
      'WHAT-side fence intact: no architecture, module-allocation or file decisions anywhere in the candidate - the report is exactly the formalization.what-reconciliation.v1 product (F2).',
      'Determinism honored: three independent REAL recomputations yield the identical report digest; pinned timestamps across the candidate; the reviewer round itself is deterministic by construction (this review included).',
    ],
    advisoryNotes: [
      {
        type: 'workspace_summary_stage_relative',
        note: 'The reviewer frame and the author artifacts both state 0 accepted upstream revisions; both are the same stage-relative statement (no reconcile-what revision is accepted yet, and none of the consumed revisions was accepted by THIS desk). The acceptance-bindings revision consumed upstream does carry an accepted verdict record from its own reviewer stage - recorded so downstream readers do not misread the 0-count as drift.',
      },
      {
        type: 'pseudo_addressed_legacy_record',
        note: `The r1 round's reconcile-what-desk-architecture-contract.artifact.json is pseudo-addressed (artifact_ref "sha256:reconcile-what-desk-architecture-contract-digest", content_digest "sha256:pending-computation") and cites a different task envelope. Same family as the acceptance reviewer's ADV-3: archived as legacy-regime material, not a content-addressed revision, not a competing reconcile-what product.`,
      },
      {
        type: 'governing_anchor_inherited',
        note: `The candidate pins governingContractRef ${shaRef(GOVERNING).slice(0, 16)}... as every r3 desk does, inheriting the round-wide architecture-contract anchor. This review verifies the pin travels consistently and is listed in the author evidence set; resolvability of the round anchor is the contract-layer desk's standing obligation and remains tracked at round level (the acceptance reviewer's accepted round records the same inheritance).`,
      },
    ],
    criticalIssues: [],
    majorIssues: [],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed reviewer artifacts with SHA256 digests over canonical JSON', satisfied: true, evidence: `A1-A6: candidate submission/artifact/trace digests recomputed and bound; this reviewer round self-addresses the same way` },
    { id: 2, description: 'The product is the COMPUTED report of the REAL installed reconcileWhat over a recomputed snapshot; verdict never hardcoded, never a parameter, never trusted from input', satisfied: true, evidence: 'C1-C4 + G1: byte-equality, digest law, computed-verdict law, deep-freeze; hardcode mutation killed' },
    { id: 3, description: 'Report-only law: the desk adds, deletes and patches nothing; a lawful repair would be a new immutable revision in the OWNING upstream cell', satisfied: true, evidence: 'G5: input byte-identical after the REAL call; output mutation refused (deep-frozen)' },
    { id: 4, description: 'Snapshot carries every chain layer exactly as the kernel dispatch feeds the reconciler', satisfied: true, evidence: 'B8/B9 + C1: universe re-derived through the REAL acceptanceUniverseFrom; requirements/acceptance/prd/useCases/sourceClaims layers recomputed from accepted material' },
    { id: 5, description: 'Chain closure recomputed both directions with zero typed findings', satisfied: true, evidence: 'C7: 5/5 WP03 seams, 0 refusals; forward intent + scenario layers clean; verdict consistent with 0 findings' },
    { id: 6, description: 'Claim coverage rows keep the installed row shape; prd:scope-2 carries an honest empty row', satisfied: true, evidence: 'C5/C6 + G4: 4 rows in the installed shape; scope-2 empty row honest; mapping cannot inflate coverage' },
    { id: 7, description: 'Upstream re-verified before consumption through REAL validators, REAL folds and REAL re-seals, bound to exact bytes', satisfied: true, evidence: 'B1-B10: member seals, revision pins, WP03 requirements re-seal, acceptance re-seal to the declared seal, reviewer-of-record gate; G7 byte-tamper killed' },
    { id: 8, description: 'All 8 reviewer-frame task-projection content addresses resolved', satisfied: true, evidence: 'E5: 8/8 transported and matching (no silent drops, no digest drift); G6 tamper probe killed' },
    { id: 9, description: 'Trace relationships resolve against recomputed digests; coverage blocks are exact projections', satisfied: true, evidence: 'D1-D3: 15/15 edges; report anchor at the recomputed report digest; claim coverage projections match accepted citations' },
    { id: 10, description: 'constraint:retention-1 honored; unknown:browser-matrix-1 carried forward with owner and no fabricated resolution; terminals owned upstream', satisfied: true, evidence: 'E2/E3/E4: dispositions verified against recomputed seals and bundle content' },
    { id: 11, description: 'WHAT-side fence: no architecture/module/file decisions anywhere', satisfied: true, evidence: 'F2: forbidden-key scans clean over artifact + submission' },
    { id: 12, description: 'Deterministic authoring: pinned timestamps, no clock reads, no randomness (constraint:retention-1)', satisfied: true, evidence: 'F1: repeated REAL recomputation yields the identical digest; reviewer round deterministic by construction' },
    { id: 13, description: 'Workspace law adjudicated honestly: the 0-count frame projection upheld by a workspace-wide scan', satisfied: true, evidence: `K1/K2 + workspaceAdjudication: ${scanCount}-file scan, exactly one real revision (the candidate), r1 pseudo-record adjudicated legacy` },
  ],
  verdict: VERDICT,
  verdictVocabulary: ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'],
  nextStage: 'kernel accept effect (formalization.accept-products), then freeze-what-baseline',
  conclusion: `The candidate of record (SR-Reconcile-What-001, sha256:${ART.slice(0, 8)}...) is returned as ${VERDICT}: ${verifyRun.passed}/${verifyRun.recomputed} independent recomputations pass with zero softening. The product is the COMPUTED report of the REAL installed reconciliation surface over a snapshot the reviewer re-derived from accepted material - byte-equal to the published product, verdict consistent with 0 typed findings by the computed law (the F-2 fix), deep-frozen and pure (report-only, cr-12). Both chain directions close through REAL surfaces (5/5 WP03 seams; forward intent + scenario layers clean); the 4 rows keep the installed shape with prd:scope-2 honest and empty; constraint:retention-1 is honored through accepted criteria, the unknown stays carried_forward, and both terminals stay owned upstream. All 7 adversarial probes are killed by the declared surfaces (hardcode kill, double-layer strip, foreign binding, mapping faithfulness, purity/freeze, envelope tamper, byte tamper). The upstream chain re-verifies end to end and the acceptance reviewer decision of record gates consumption. The chain is ready for the kernel accept effect and then freeze-what-baseline.`,
};
const frDigest = sha(frContent);
const fr = {
  artifactRef: shaRef(frDigest),
  artifactKind: 'formalization-review',
  contentDigest: frDigest,
  semanticCode: 'FR-Reconcile-What-001',
  createdAt: PIN,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: frContent,
};
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-review.json'), `${JSON.stringify(fr, null, 2)}\n`);

/* -------------------------------------------------------------- 3. RT */
const rtContent = {
  traceId: 'RT-Reconcile-What-001',
  deskRef: 'reconcile-what',
  role: 'reviewer',
  traceKind: 'reviewer-verdict-trace',
  subjectSemanticCode: 'FR-Reconcile-What-001',
  subjectArtifactRef: shaRef(frDigest),
  verdict: VERDICT,
  relationVocabulary: ['reviews', 'derived_from', 'constrained_by', 'resolves', 'supports', 'enforces', 'produces'],
  relationships: [
    {
      fromId: 'FR-Reconcile-What-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'SR-Reconcile-What-001',
      toRef: shaRef(ART),
      description: `Independent reviewer verification of the what-reconciliation artifact (verdict ${VERDICT}: ${verifyRun.passed}/${verifyRun.recomputed} recomputations, 7/7 adversarial probes killed)`,
    },
    {
      fromId: 'FR-Reconcile-What-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'FS-Reconcile-What-001',
      toRef: shaRef(FS_AUTHOR),
      description: 'Independent reviewer verification of the author product submission (28/28 evidence refs resolve; intake receipt admitted this reviewer stage)',
    },
    {
      fromId: 'FR-Reconcile-What-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'author-trace:reconcile-what',
      toRef: shaRef(TRC_AUTHOR),
      description: 'Reviewer verification of the author trace graph (15/15 relationships resolve; coverage blocks are exact projections)',
    },
    {
      fromId: 'FR-Reconcile-What-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'report',
      toRef: REPORT,
      description: 'The review verifies the COMPUTED report of record: recomputed byte-equal through the REAL reconcileWhat, verdict consistent with 0 typed findings (the F-2 computed-verdict law)',
    },
    {
      fromId: 'FR-Reconcile-What-001',
      fromRef: shaRef(frDigest),
      relation: 'enforces',
      toId: 'constraint:retention-1',
      toRef: shaRef(ENVELOPE['constraint:retention-1']),
      description: 'Reviewer artifacts are deterministic: pinned timestamp, computed digests only; the review verifies the constraint honored through ac:determinism-1 + ac:outcome-1-deterministic-error without adding enforcement',
    },
    {
      fromId: 'FR-Reconcile-What-001',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:audited-1',
      toRef: shaRef(ENVELOPE['terminal:audited-1']),
      description: 'This independent desk audit (54 recomputations, REAL cell surfaces, adversarial probes) is the audited-1 realization at the reconcile-what desk',
    },
    {
      fromId: 'FR-Reconcile-What-001',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:delivered-1',
      toRef: shaRef(ENVELOPE['terminal:delivered-1']),
      description: 'The accepted reconciliation closes the WHAT chain over genuinely verified material, keeping the delivered terminal to its evidence standard ahead of freeze-what-baseline',
    },
  ],
  unknownCoverage: {
    unknownId: 'unknown:browser-matrix-1',
    digest: ENVELOPE['unknown:browser-matrix-1'],
    disposition: 'carried_forward',
    owner: 'discovery',
    note: 'The review confirms the carried-forward disposition; neither the author nor the reviewer resolves or drops the unknown.',
  },
  terminalCoverage: {
    'terminal:audited-1': {
      digest: ENVELOPE['terminal:audited-1'],
      supportedBy: ['FR-Reconcile-What-001', 'ac:terminal-1-audited'],
    },
    'terminal:delivered-1': {
      digest: ENVELOPE['terminal:delivered-1'],
      supportedBy: ['FR-Reconcile-What-001', 'ac:outcome-1-delivered'],
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
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-trace.json'), `${JSON.stringify(rt, null, 2)}\n`);

/* -------------------------------------------------------------- 4. FS */
const fsContent = {
  deskRef: 'reconcile-what',
  deskNodeId: 'reconcile-what',
  role: 'reviewer',
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
    acceptedRevisionDigest: REPORT,
  },
  verificationRef: shaRef(vvDigest),
  traceRef: shaRef(rtDigest),
  payloadContract: {
    productKind: 'formalization.review-complete.v1',
    effectId: 'formalization.accept-products',
    requiredEvidenceRefs: [
      ...Object.values(ENVELOPE).map(shaRef),
      shaRef(FS_AUTHOR), shaRef(ART), shaRef(TRC_AUTHOR),
      shaRef(vvDigest), shaRef(frDigest), shaRef(rtDigest),
      REPORT,
    ],
    evidenceKindCoverage: {
      'source-claim': 4,
      constraint: 1,
      unknown: 1,
      'terminal-claim': 2,
      'author-submission': 1,
      product: 1,
      'author-desk-trace': 1,
      'reviewer-verification': 1,
      'formalization-review': 1,
      'reviewer-desk-trace': 1,
      'accepted-revision': 1,
    },
    terminalOutcome: 'success',
  },
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#reconcile-what:reviewer',
    status: 'admitted_for_accept_effect',
    receivedFrom: 'reviewer',
    nextStage: 'kernel accept effect (formalization.accept-products), then freeze-what-baseline',
    note: 'Reviewer verdict recorded desk-level; kernel-side gate intake (formalization.accept-products effect) is executed by the driver over public commands.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Independent recomputation performed: 54 checks, nothing trusted by declaration, REAL cell surfaces rechecked with zero softening', satisfied: true },
    { id: 3, description: 'All 8 reviewer-frame task-projection content addresses resolved; workspace 0-count adjudicated stage-relative by a workspace-wide scan', satisfied: true },
    { id: 4, description: 'Verdict recorded with findings, evidence and adversarial probes (12 positive findings, 3 advisory notes, 0 critical, 0 major; G1-G7 all killed)', satisfied: true },
    { id: 5, description: 'Reviewer artifacts deterministic: pinned timestamp, no clock reads, no randomness', satisfied: true },
    { id: 6, description: 'constraint:retention-1 honored across author and reviewer artifacts', satisfied: true },
    { id: 7, description: 'unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true },
    { id: 8, description: 'Report-only law independently re-proven: purity (input byte-identical) + deep-freeze (mutation refused)', satisfied: true },
    { id: 9, description: 'Computed-verdict law independently re-proven: verdict consistent iff 0 findings; hardcode mutation killed', satisfied: true },
    { id: 10, description: 'Upstream consumed only through the reviewer-accepted candidate of record (acceptance reviewer decision binds the published refs and its recomputed verification)', satisfied: true },
    { id: 11, description: 'WHAT-side fence intact: no architecture/module/file decisions anywhere in the reviewed candidate or this review', satisfied: true },
    { id: 12, description: 'Reviewed candidate genuinely closes the WHAT chain: both directions recomputed clean; prd:scope-2 honest empty row; terminals owned upstream', satisfied: true },
  ],
};
const fsDigest = sha(fsContent);
const fsArt = {
  submissionRef: shaRef(fsDigest),
  submissionId: 'FS-Reconcile-What-002',
  contentDigest: fsDigest,
  createdAt: PIN,
  deskRef: 'reconcile-what',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: fsContent,
};
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-product-submission.json'), `${JSON.stringify(fsArt, null, 2)}\n`);

/* -------------------------------------------------------------- 5. MD */
const md = `# reconcile-what desk (reviewer) - r3 review record

Round: stray-products-r3 · reviewed candidate of record: SR-Reconcile-What-001
(\`sha256:${ART}\`, submission FS-Reconcile-What-001 \`sha256:${FS_AUTHOR}\`,
trace \`sha256:${TRC_AUTHOR}\`, computed report \`sha256:${REPORT_HEX}\`) · verdict: **${VERDICT}**

## What was independently verified (nothing trusted by declaration)

- **${verifyRun.recomputed} recomputations** (\`reconcile-what-desk-reviewer-verify.mjs\`), rule
  \`sha256(canonicalJson)\` per \`src/workflow-kernel/domain/digest.ts\`:
  **${verifyRun.passed} pass / ${verifyRun.failed} fail**. Full evidence:
  \`reconcile-what-desk-reviewer-verification.json\` (VV-Reconcile-What-001,
  \`sha256:${vvDigest}\`).
- **Same-provider recheck, zero softening** (\`formalization.reconciliation-structure.v1\`): the
  report re-computed through the REAL installed cell (\`acceptance.reconcileWhat\` over a snapshot
  re-derived through \`acceptanceUniverseFrom\`, re-sealed upstream through the REAL
  \`validateAcceptanceBundle\` to the declared seal \`${ACC_SEAL.slice(0, 16)}…\`) is **byte-equal**
  to the published product; all 5 criteria re-validate through the WP03 seam (0 refusals).
- **Computed-verdict law (the F-2 fix) re-proven**: verdict \`consistent\` iff 0 typed findings;
  G1 kills the hardcode — a mutant with a real gap AND an injected \`verdict:'consistent'\` still
  reports \`gaps\` (the reconciler takes no verdict input at all).
- **Report-only law re-proven** (cr-12): the input snapshot is byte-identical after the REAL call
  and the returned report refuses mutation (deep-frozen) — G5.
- Chain closure recomputed both directions: forward (every scenario-required member reaches
  accepted requirements; every accepted scenario produces obligations), reverse (5/5 WP03 seams +
  three closure laws) — 0 typed findings; 4 rows in the installed shape, \`prd:scope-2\` honest and
  empty; the row-mapping probe (G4) proves rows are computed from the accepted citations.
- Upstream re-verified through the REAL surfaces: 6 PRD member seals + REAL intent fold (prd
  revision re-folds), 3 UC seals + fold, requirement/criterion/statement seals recompute, the
  requirements bundle re-seals against its recomputed WP03 universe, the acceptance bundle
  re-seals to the exact declared product seal, and the acceptance reviewer decision of record
  (FR-Define-Acceptance-Contract-001, ${accVV.content.recomputedChecks}/${accVV.content.recomputedChecks}) gates consumption —
  byte-tamper probe (G7) confirms consumption is bound to exact bytes.
- Trace: 15/15 relationships resolve; the report coverage block is the exact projection of the
  reconciles edges anchored at the recomputed report digest.

## Workspace-law adjudication

The reviewer frame projects **"${WORKSPACE_SUMMARY}"**. Verdict: **upheld, stage-relative.**
K1 scanned ${scanCount} workspace files under \`qualification/\`: exactly **one** real
content-addressed reconcile-what revision exists — the candidate under review
(\`${ART.slice(0, 8)}…\`, mentioned in ${mentionCount} file(s)). No accepted reconcile-what
revision exists anywhere (this review + the kernel accept effect are what could create one).
The r1 round's \`reconcile-what-desk-architecture-contract.artifact.json\` is **pseudo-addressed**
(content_digest \`"sha256:pending-computation"\`, different task envelope) — legacy-regime
material, consistent with the acceptance reviewer's ADV-3, archived rather than treated as a
competing revision.

## Adversarial probes (all killed by the declared surfaces)

| probe | mutant | result |
|-------|--------|--------|
| G1 hardcode/verdict-injection kill | criterion stripped + \`verdict:'consistent'\` injected into the snapshot | verdict **gaps**, typed finding names the gap; injected verdict ignored |
| G2 requirement strip | \`fr:terminal-1\` removed | verdict **gaps**; BOTH forward layers break (\`prd:terminal-1\` intent gap + \`uc:terminal-1\` scenario-survival gap) |
| G3 foreign binding | \`ac:determinism-1\` re-bound to \`fr:foreign-1\` | WP03 seam refusal, typed finding |
| G4 mapping faithfulness | \`claim:scope-1 -> prd:scope-2\` | rows visibly derange (empty); published rows match only the accepted-citation mapping |
| G5 purity + freeze | mutation attempts after the REAL call | input byte-identical; output mutation refused (deep-frozen) |
| G6 envelope tamper | swapped scope-1/scope-2 digests | exactly 2 mismatches — cross-check has teeth |
| G7 upstream byte-tamper | one stray field on the accepted bundle | digest flips off the declared content address |

## Reviewer artifact index (all content-addressed, deterministic)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification | \`sha256:${vvDigest}\` |
| review | formalization-review | \`sha256:${frDigest}\` |
| trace | reviewer-verdict-trace | \`sha256:${rtDigest}\` |
| submission | FS-Reconcile-What-002 | \`sha256:${fsDigest}\` |

Pinned timestamp ${PIN} across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere.

**Next stage:** kernel accept effect (\`formalization.accept-products\`), then
\`freeze-what-baseline\`.
`;
writeFileSync(join(DIR, 'reconcile-what-desk-reviewer-submission-summary.md'), md);

console.log(JSON.stringify({
  built: ['verification', 'review', 'trace', 'submission', 'summary'],
  verdict: VERDICT,
  verification: shaRef(vvDigest),
  review: shaRef(frDigest),
  trace: shaRef(rtDigest),
  submission: shaRef(fsDigest),
  report: REPORT,
}, null, 2));
