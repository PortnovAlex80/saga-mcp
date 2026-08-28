/**
 * define-acceptance-contract desk (reviewer) - artifact authoring.
 *
 * Deterministic: pinned timestamp, no clock reads, no randomness.
 * Builds the five reviewer artifacts in dependency order, computing each
 * content digest over canonical JSON (recursively key-sorted, compact)
 * and interleaving the content addresses of already-built artifacts.
 * All verdict content is grounded in
 * define-acceptance-contract-desk-reviewer-verify-out.json (99 independent
 * recomputations through the REAL kernel cell surfaces) - nothing is
 * asserted that the verify run did not establish.
 *
 * Run: node define-acceptance-contract-desk-reviewer-build.mjs
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
const fileSha = (p) => JSON.parse(readFileSync(p, 'utf8'));

const DIR = dirname(fileURLToPath(import.meta.url));
const R2 = join(DIR, '..', 'stray-products-r2');
const PIN = '2026-08-28T00:00:00Z';
const DIGEST_RULE = 'sha256 over canonical JSON of content (recursively key-sorted, compact)';

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
const UPSTREAM_PROJECTED = '32892970b44cb1d25a5fdce61e4cea43500ccd1cc4cb8fb03e2b268e1758645d';
const GOV = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const CAPSULE = 'f3f98175f061fa289d49f4684f78273022c97b9e12bc535255c4b3d4c6a0534e';
const CERT = '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21';
const IMP = 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5';
const IMP_TRC = '2e5bb8ce3f26de726729c107760d43d5c81350b1a412f5c504d95352a0ef8274';
const IMP_REV = 'cfc7b35a5d0b71586e24be6474c5add914ba5f303edbd8bc2789782fd34b4d7b';

/* The candidate of record (author artifacts). */
const FS_AUTHOR = '6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe';
const ART = '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0';
const TRC_AUTHOR = '2835aea3f7bbf362afabf729ca37a18827bd9579c76f30daad12d8a2272a84e1';

/* Upstream revisions consumed by the candidate (r3 copies). */
const INTENT = fileSha(join(DIR, 'define-product-intent-desk-product-intent.artifact.json')).contentDigest;
const UC = fileSha(join(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json')).contentDigest;
const SR = fileSha(join(DIR, 'derive-system-requirements-desk-system-requirements.artifact.json')).contentDigest;

/* The reviewer's evidence of record. */
const verifyRun = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-verify-out.json'), 'utf8'));
const intentRev1 = fileSha(join(R2, 'define-product-intent-desk-reviewer-review.json'));
const intentRev2 = fileSha(join(R2, 'define-product-intent-desk-reviewer2-review.json'));
const srRev = fileSha(join(R2, 'derive-system-requirements-desk-reviewer-review.json'));
const srRestaff = fileSha(join(R2, 'derive-system-requirements-desk-reviewer-restaff2-confirmation.json'));
const ucHold = fileSha(join(R2, 'model-use-cases-desk-upstream-hold.artifact.json'));
const impRev = fileSha(join(R2, 'import-discovery-handoff-desk-reviewer-review.json'));

const detailOf = (id) => verifyRun.results.find((r) => r.id === id)?.detail ?? '';
const scanCount = Number((String(detailOf('K2.upstreamProjection.unresolvable')).match(/scanned (\d+) workspace files/) || [])[1]) || 0;
const govMentions = Number((String(detailOf('I4.governingContract.resolves')).match(/across (\d+) mentioning files/) || [])[1]) || 0;

/* -------------------------------------------------------------- 1. VV */
const vvContent = {
  verificationId: 'VV-Define-Acceptance-Contract-001',
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; REAL kernel cell surfaces: acceptanceUniverseFrom + validateAcceptanceBundle + the WP03 validateAcBinding seam (reviewer route same-provider-recheck, zero softening); upstream REAL validators + REAL folds; workflow-status audit over recomputed verdict records',
  subject: {
    submissionRef: shaRef(FS_AUTHOR),
    submissionId: 'FS-Define-Acceptance-Contract-001',
    artifactRef: shaRef(ART),
    artifactSemanticCode: 'SR-Define-Acceptance-Contract-001',
    traceRef: shaRef(TRC_AUTHOR),
  },
  recomputedChecks: verifyRun.recomputed,
  passed: verifyRun.passed,
  failed: verifyRun.failed,
  groups: {
    selfAddress: 'A1-C3: submission/artifact/trace content digests + refs recomputed and cross-bound',
    upstreamRecomputation: 'D.*: 6 PRD member seals + REAL acceptedIntentSetOf fold + 3 UC seals + REAL revision fold + 4 requirement seals + requirements bundle re-sealed against its recomputed WP03 universe; all accepted-* upstream refs bind recomputed digests',
    providerRecheck: 'E1-E5: universe through the REAL acceptanceUniverseFrom protocol; bundle re-seals through the REAL validateAcceptanceBundle to the declared product seal; 5 criterion seams sealed; 5 statement seals recompute; evidence kinds in the closed vocabulary',
    envelopeCrossCheck: 'F.*: 8/8 reviewer task-projection content addresses transported in artifact.upstream and matching the envelope',
    negativeProbes: 'G1-G5: stripped branch citation -> MISSING_LINEAGE; foreign scenario substitution -> FOREIGN_LINEAGE; foreign requirement -> FOREIGN_LINEAGE; uncovered requirement -> COVERAGE_GAP; WHAT-side key -> SCOPE_VIOLATION (all killed by the same declared provider)',
    traceGraph: 'H1-H9: 16 relationships resolve against recomputed digests; criterion/requirement/branch/terminal/constraint/unknown coverage blocks are exact projections of the edge sets; rev-1 duty: every scenario-facing citation pair re-derived from the bound requirement derivation',
    payloadContract: 'I1-I3: 21 required evidence refs exact; kind coverage consistent; import-desk authority chain (artifact/trace/accepted review) recomputed',
    governingContract: 'I4: FAILED - governing address unresolvable workspace-wide across 91 mentioning files; r1 claimants recompute otherwise (digest drift)',
    deskLaws: 'J1-J6: desk/node/item/token/kind/effect/contract pins; 5-criterion universe; zero deferrals/standalone bindings; pinned timestamps; closure laws exact',
    workspaceLaw: `K1-K2: 0 accepted upstream revisions consistent across author artifact/submission/trace; envelope projection sha256:32892970... UNRESOLVABLE (${scanCount}-file workspace scan; zero raw-byte, zero canonical-JSON, zero .content hits)`,
    honestyAndFence: 'L1-L2: WHAT-side fence clean; verification-flag honesty FAILED on revisionPinsMatchAcceptedRevisions (status layer)',
    acceptanceStateAudit: 'M1-M5: the one genuinely accepted link is the import chain; the consumed intent revision is verdict-repair x2 rounds with no reissue; NO reviewer stage exists for the UC bundle anywhere in the corpus; the consumed requirements revision is verdict-repair + re-staff confirmation; the candidate asserts accepted-states that do not exist',
    scope2Ratification: 'N1: FAILED - the candidate restates the prd:scope-2 exclusion as settled fact while the exclusion authority is established as nonexistent by three upstream verdict records',
  },
  envelopePins: {
    protocolSkillRef: 'sha256:bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
    semanticSkillRef: 'sha256:2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
    taskProjectionContentAddresses: Object.fromEntries(Object.entries(ENVELOPE).map(([id, d]) => [id, shaRef(d)])),
    upstreamAcceptedProjection: {
      address: shaRef(UPSTREAM_PROJECTED),
      envelopeClaim: '1 accepted upstream revisions travel by content address',
      adjudication: `UNRESOLVABLE - upheld the author workspaceSummary of 0 for the desk's own revisions (${scanCount}-file workspace scan under qualification/: zero raw-byte, zero canonical-JSON, zero .content hits; the sole textual mention is this reviewer's own verify script). No accepted define-acceptance-contract revision exists anywhere: the r1 acceptance records are pseudo-addressed ("sha256:define-acceptance-contract-formalization-2026-08-27" is not a content address), r2 never ran the desk, and the only r3 revision is the candidate under review. Recorded as stale shell metadata (r2 RA-5 still open).`,
    },
  },
  results: verifyRun.results,
};
const vvDigest = sha(vvContent);
const vv = {
  artifactRef: shaRef(vvDigest),
  artifactKind: 'reviewer-verification',
  contentDigest: vvDigest,
  semanticCode: 'VV-Define-Acceptance-Contract-001',
  createdAt: PIN,
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: vvContent,
};
writeFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-verification.json'), JSON.stringify(vv, null, 2) + '\n');

/* -------------------------------------------------------------- 2. FR */
const frContent = {
  reviewId: 'FR-Define-Acceptance-Contract-001',
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  reviewedRound: 'stray-products-r3',
  reviewedCandidate: {
    submissionRef: shaRef(FS_AUTHOR),
    submissionId: 'FS-Define-Acceptance-Contract-001',
    artifactRef: shaRef(ART),
    artifactSemanticCode: 'SR-Define-Acceptance-Contract-001',
    traceRef: shaRef(TRC_AUTHOR),
    productKind: 'formalization.acceptance-bindings.v1',
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
    route: 'same-provider-recheck (ACCEPTANCE_REVIEWER_ROUTE; gates.ts law: one declared provider per desk; a reviewer can never soften a check)',
    providerId: 'frf.acceptance-closure.v1',
    resealedToDeclaredSeal: true,
    declaredSeal: 'sha256:14fda7910eedff5a84f69d13e5b85070fe395f349d75263d145543f781085f51',
    adversarialChecklist: 'rev-1 citation pairs re-derived (H9); rev-2 zero deferrals verified lawful under full end-to-end coverage (J4); rev-3 FOREIGN_LINEAGE escalation honored - this review routes the unaccepted-lineage and contract-anchor defects to their owning desks without widening any scope; rev-4 scenario-strip probe re-run and killed (G1)',
  },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    note: 'All 8 reviewer-envelope task-projection content addresses travel inside artifact.upstream.verifiedSubArtifacts and match exactly (no silent drops, no digest drift). The envelope upstream-accepted projection is adjudicated under workspaceAdjudication.',
  },
  workspaceLaw: '0 accepted upstream revisions travel by content address',
  workspaceAdjudication: {
    envelopeProjection: `1 accepted upstream revisions travel by content address (upstream-accepted[0] ${shaRef(UPSTREAM_PROJECTED)} :: accepted revision of define-acceptance-contract)`,
    authorPosition: '0 accepted upstream revisions travel by content address (artifact, submission, trace consistent; verification.acceptedUpstreamRevisionsTravelingByContentAddress = 0)',
    scanEvidence: `K2: ${scanCount} workspace files under qualification/ scanned - raw-bytes hits 0, canonical-JSON hits 0, .content canonical hits 0, textual mentions 1 (this reviewer's own verify script)`,
    closure: 'AUTHOR POSITION UPHELD. No accepted define-acceptance-contract revision exists anywhere: the r1 acceptance records are pseudo-addressed (not content addresses, and that material predates the content-addressed regime with digest drift later established for the r1 contract layer), r2 never ran this desk, and the only r3 revision is the candidate under review. The projected address resolves to no content. The envelope count is stale shell metadata, recorded for the shell owner (r2 RA-5 still open).',
  },
  findings: {
    positiveFindings: [
      '92/99 independent recomputations pass; the candidate of record is content-integrity-clean at the digest layer: submission, artifact and trace self-addresses recompute; the bundle re-seals through the REAL acceptance cell (acceptanceUniverseFrom -> validateAcceptanceBundle) to the exact declared product seal; all 5 criterion seams seal via the REAL WP03 validateAcBinding; all 5 verifiable-statement seals recompute.',
      'Upstream continuity at the byte layer: the consumed intent/UC/requirements revisions recompute through the REAL PRD/UC validators and REAL folds; the requirements bundle re-seals against its recomputed WP03 universe before consumption; every accepted-* ref binds the recomputed digest (no fabricated addresses anywhere in the candidate).',
      'All 8 reviewer-envelope content addresses travel inside the artifact and match exactly; the trace graph resolves end to end (16 relationships; criterion/requirement/branch/terminal/constraint/unknown coverage blocks are exact projections of the edge sets; branch refs resolve to their owning frozen scenario member seals).',
      'rev-1 duty discharged: every scenario-facing criterion citation pair re-derives from the bound requirement\'s own derivation; the NFR-only criterion lawfully carries no UC citation; zero deferrals and zero standalone evidence bindings are lawful because all 4 required branches are covered end to end (cr-05).',
      'Negative probes all killed by the same declared provider (no softening): stripped branch citation, foreign scenario substitution, foreign requirement, uncovered requirement, WHAT-side key injection.',
      'Determinism honored: pinned timestamp 2026-08-28T00:00:00Z across submission/artifact/trace; the reviewer round is deterministic by construction (this review included).',
      'Workspace law: author 0-count upheld against the envelope projection by a workspace-wide resolvability scan - the honest adjudication recorded in workspaceAdjudication.',
    ],
    advisoryNotes: [
      {
        type: 'stale_envelope_projection',
        note: 'ADV-1. The reviewer frame projects "1 accepted upstream revision of define-acceptance-contract" (sha256:32892970...) which resolves to no content workspace-wide; the only historical accept for this desk is the r1 pseudo-addressed record. Stale shell metadata; r2 RA-5 (refresh envelope projections) remains open. Recorded in workspaceAdjudication.',
      },
      {
        type: 'byte_identical_relabeling_round',
        note: 'ADV-2. The r3 round re-emitted the r2 repair-verdict intent/requirements revisions byte-identically and relabeled the chain "accepted" without any state change, remediation record, or adjudication. The r2 UC desk\'s upstream hold (sha256:' + ucHold.contentDigest + ') was silently overridden the same way. Desk process hygiene: a round boundary is not an acceptance event; verdict records travel by content address and bind until remediated or adjudicated.',
      },
      {
        type: 'pseudo_addressed_legacy_accept',
        note: 'ADV-3. The r1 reviewer decision records ("sha256:define-acceptance-contract-formalization-2026-08-27") use non-digest pseudo-addresses; they cannot serve as content-addressed acceptance evidence and are the likely origin of the envelope\'s phantom accepted-revision projection. Archived as legacy-regime records, not as a traveling accepted revision.',
      },
    ],
    criticalIssues: [
      {
        issueId: 'CRIT-1',
        severity: 'CRITICAL',
        category: 'unaccepted_lineage_asserted_accepted',
        title: 'The candidate builds its acceptance surface over revisions that are NOT accepted while asserting they are',
        description: 'The candidate\'s material authority ("the accepted define-product-intent bundle, the accepted model-use-cases scenario bundle and the accepted derive-system-requirements bundle, traveling by content address"), its accepted* upstream field family and its six accepted-* evidence kinds assert accepted upstream revisions. The status audit (M-group) proves otherwise for three of the four consumed links: (a) the intent revision ' + INTENT.slice(0, 8) + '... carries verdict repair across every reviewer emission (FR-Define-Product-Intent-001 ' + intentRev1.contentDigest.slice(0, 8) + '..., FR-Define-Product-Intent-002 ' + intentRev2.contentDigest.slice(0, 8) + '...; both CRIT-1: prd:scope-2 fabricated disposition authority; both MAJ-1: governing anchor) with no author reissue anywhere in r1/r2/r3; (b) the UC scenarios bundle ' + UC.slice(0, 8) + '... has NEVER passed a reviewer stage - no reviewer artifact exists in the corpus - and was authored in violation of its own desk\'s upstream hold; (c) the requirements revision ' + SR.slice(0, 8) + '... carries verdict repair (FR-Derive-System-Requirements-001 ' + srRev.contentDigest.slice(0, 8) + '...: CRIT-1 unaccepted lineage asserted accepted, CRIT-2 scope-2 ratification) plus a re-staffing confirmation (' + srRestaff.semanticCode + ' ' + srRestaff.contentDigest.slice(0, 8) + '...) that confirms the verdict, not an acceptance. Only the discovery import chain is genuinely accepted. The candidate\'s verification flags assert the same false state (revisionPinsMatchAcceptedRevisions=true - the pins are byte-exact to UNACCEPTED revisions). The WP03/closure surface cannot see workflow status - precisely the desk-review authority. This is the r2 derive-desk CRIT-1 defect family propagated one desk downstream: acceptance-contract is the desk whose whole product IS the statement "these exact criteria close the accepted material", so building it over unaccepted lineage launders the entire unaccepted chain one step from reconcile-what.',
        evidence: [
          'Check M2: intent verdicts repair x2 (recomputed from the verdict records\' own content digests); no intent author reissue exists (all intent artifact files in the corpus digest to the same repair-verdict revision).',
          'Check M3: zero model-use-cases reviewer artifacts in r1/r2/r3; UC hold artifact sha256:' + ucHold.contentDigest + ' recomputes (holdKind=' + ucHold.content.holdKind + ').',
          'Check M4: requirements verdict repair + restaff confirmation ' + srRestaff.semanticCode + ' recomputes; the r3 requirements copy is byte-identical to the repair-verdict revision.',
          'Check M5 + L2: materialAuthority/accepted* fields/accepted-* evidence kinds/self-check 9 assert accepted-states; revisionPinsMatchAcceptedRevisions=true is false at the status layer.',
          'Check M1: the import chain (artifact ' + IMP.slice(0, 8) + '..., accepted review ' + IMP_REV.slice(0, 8) + '...) is the only genuinely accepted link.',
        ],
        violatedPrinciples: ['CON-1 material authority travels by content AND by verdict records', 'D10 never silently resolve or drop accepted material - its converse: never relabel unaccepted material as accepted', 'gates.ts law: acceptance states change only through verdict records, not round boundaries', 'r2 FR-Derive-System-Requirements-001 CRIT-1/RA-1 remediation debt'],
        impact: 'Acceptance would ratify an acceptance contract whose entire binding surface (fr:*, nfr:*, uc:*, branch:*, stmt:*) hangs off unaccepted revisions, letting the unaccepted chain reach reconcile-what as if settled, and ratifying the intent contention (CRIT-2 of both intent reviews) as a side effect.',
      },
      {
        issueId: 'CRIT-2',
        severity: 'CRITICAL',
        category: 'fabricated_disposition_authority_ratified',
        title: 'The candidate restates the prd:scope-2 out_of_scope exclusion as settled fact in the acceptance surface',
        description: 'The candidate brief states "The out-of-scope intent member prd:scope-2 and the discovery-owned unknown:browser-matrix-1 derive no criterion" and acceptance self-check 10 asserts "prd:scope-2 (out_of_scope) derives no criterion" - converting the contested exclusion into the acceptance contract\'s own premise. The recomputed capsule material for claim:scope-2 (SC-2, digest cb291aa7...) is a bare claim statement - no decision; the certificate (CERT-1, ' + CERT.slice(0, 8) + '...) is a subject-level go; the exclusion\'s cited authority ("the Discovery decision recorded in the capsule") was established as nonexistent by FR-Define-Product-Intent-001 CRIT-1, FR-Define-Product-Intent-002 CRIT-1 and FR-Derive-System-Requirements-001 CRIT-2. Keeping zero derivation edges from prd:scope-2 is defensible while the disposition is contested; restating the exclusion as fact inside the acceptance contract converts this desk into the third link that launders the fabrication. Net effect: accepted Discovery scope material would end the round with no acceptance surface at all, under an exclusion nobody can produce authority for.',
        evidence: [
          'Check N1: brief + self-check 10 restatements found verbatim in the candidate content.',
          'Capsule SC-2 content recomputed (digest cb291aa7...): bare claim statement, no decision; CERT-1: subject-level go.',
          'The consumed intent member prd:scope-2 still cites "the Discovery decision recorded in the capsule" (reason field, recomputed).',
        ],
        violatedPrinciples: ['CON-1 content-address provenance honesty', 'TC-2 accepted material carries accepted content until a real disposition authority exists', 'conveyor rule: material authority travels by content, never by invented narrative'],
        impact: 'The acceptance contract would memorialize a fabricated disposition as an accepted premise; every downstream reader inherits the exclusion as settled without any authority existing.',
      },
    ],
    majorIssues: [
      {
        issueId: 'MAJ-1',
        severity: 'MAJOR',
        category: 'unresolvable_governing_contract_anchor',
        title: 'governingContractRef sha256:a926df62... resolves to no content anywhere in the round workspace',
        description: `The candidate binds governingContractRef sha256:${GOV} and lists it in requiredEvidenceRefs (architecture-contract kind), as every r3 desk does. Workspace-wide recomputation finds no content - raw bytes, whole-JSON canonical, or .content canonical - hashing to that address across ${govMentions} mentioning files under qualification/. The r1 contract-layer claimants still declare the address and all recompute to different digests. This is the r2 MAJ-1 family (FR-Define-Product-Intent-001 MAJ-1, FR-Derive-System-Requirements-001 MAJ-1; r2 RA-2/RA-4) still unremediated, now inherited by a fourth desk.`,
        evidence: [
          `Check I4: UNRESOLVED - ${govMentions} files mention the address; zero content hits; r1 claimants recompute otherwise.`,
          'r2 RA-2 (intent review) and RA-4 (derive review) demanded the contract layer be re-sealed; no re-seal exists in r3.',
        ],
        violatedPrinciples: ['CON-1 content-address transport', 'TC-1 acceptance criterion: evidence refs must resolve to recomputable content', 'r2 RA-2/RA-4 remediation debt'],
        impact: 'The round governing-contract continuity anchor remains decorative: acceptance would ratify an evidence ref that fails at the first independent recomputation.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed desk artifacts with SHA256 digests over canonical JSON', satisfied: true, evidence: 'A1-C3: submission/artifact/trace self-addresses recomputed and bound' },
    { id: 2, description: 'Same-provider recheck through the REAL acceptance cell (no softening) with adversarial probes killed', satisfied: true, evidence: 'E1-E5 re-seal to the declared seal; G1-G5 all refused with the expected typed reasons' },
    { id: 3, description: 'Law ac-1: every criterion binds exact ACCEPTED FR/NFR material', satisfied: false, evidence: 'M2-M5: nothing consumed is accepted (intent repair x2, UC never reviewed, requirements repair); the criteria bind honest digests of unaccepted revisions (CRIT-1)' },
    { id: 4, description: 'Laws ac-2/ac-3: both citation shapes, re-derived from the bound requirements\' derivations (rev-1)', satisfied: true, evidence: 'H9: all scenario-facing citation pairs re-derive; NFR-only criterion lawfully uncited' },
    { id: 5, description: 'Law ac-4: closed four-value evidence vocabulary with declared observable terminal results', satisfied: true, evidence: 'E5: test/monitoring/audit only; every criterion declares an observable terminal result' },
    { id: 6, description: 'Law ac-5 WHAT-side fence: no architecture/module/file decisions anywhere in the bundle', satisfied: true, evidence: 'L1 scan + G5 SCOPE_VIOLATION probe' },
    { id: 7, description: 'Law ac-6/ac-7 closure: every FR/NFR covered; every required branch covered end to end; unique criterion ids; zero deferrals needed', satisfied: true, evidence: 'H2-H4 + J3/J4: 4/4 requirements, 4/4 branches, 5 unique criteria, zero deferrals/standalone bindings' },
    { id: 8, description: 'Trace relationships resolve against recomputed digests; coverages equal the edge sets; terminals/constraint/unknown covered exactly', satisfied: true, evidence: 'H1-H8: 16/16 relationships, all coverage blocks exact projections' },
    { id: 9, description: 'Upstream consumed by the candidate is GENUINELY ACCEPTED (verdict records, not round labels)', satisfied: false, evidence: 'M1-M4: only the import chain is accepted; intent/UC/requirements are repair-verdict or never-reviewed (CRIT-1)' },
    { id: 10, description: 'No fabricated disposition ratified into the acceptance surface', satisfied: false, evidence: 'N1: brief + self-check 10 restate the prd:scope-2 exclusion as fact (CRIT-2)' },
    { id: 11, description: 'Governing contract evidence ref resolves to recomputable content', satisfied: false, evidence: 'I4 FAILED: a926df62... unresolvable across 91 mentioning files (MAJ-1)' },
    { id: 12, description: 'Workspace law adjudicated honestly: author 0-count upheld; envelope projection resolved or adjudicated UNRESOLVABLE', satisfied: true, evidence: 'K1/K2 + workspaceAdjudication: 246-file scan, zero content hits, stale shell metadata recorded' },
    { id: 13, description: 'Deterministic authoring: pinned timestamps, no clock reads, no randomness (constraint:retention-1)', satisfied: true, evidence: 'J5 pinned 2026-08-28T00:00:00Z; reviewer round deterministic by construction' },
  ],
  verdict: 'repair',
  verdictVocabulary: ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'],
  finalGate: {
    gateVerdict: 'repair',
    providerId: 'reviewer-verdict',
    issues: ['CRIT-1', 'CRIT-2', 'MAJ-1'],
  },
  requiredActions: [
    {
      actionId: 'RA-1',
      priority: 'CRITICAL',
      owner: 'define-acceptance-contract desk (author)',
      description: 'HOLD the desk until genuinely accepted upstream revisions exist; then reissue against them only',
      details: 'An acceptance contract is a statement ABOUT accepted material; over unaccepted lineage it has no referent. Issue a hold record (the r2 UC upstream-hold precedent, by content address) naming the three unaccepted links, and strip every accepted-status assertion (materialAuthority wording, accepted* field names, accepted-* evidence kinds, self-check 9) from any interim material. Reissue only when the consumed revisions carry accepted verdict records.',
    },
    {
      actionId: 'RA-2',
      priority: 'CRITICAL',
      owner: 'define-product-intent desk (author) + driver/human adjudication',
      description: 'Settle the intent contention, then restore claim:scope-2 (r2 RA-2 chain, unpaid)',
      details: 'Remediate FR-Define-Product-Intent-001/002 CRIT-1: reissue prd:scope-2 as carried system-boundary material (scenario_required) or cite a genuinely recorded Discovery decision address. Until then the exclusion has no authority and no desk may restate it as fact (this review\'s CRIT-2).',
    },
    {
      actionId: 'RA-3',
      priority: 'MAJOR',
      owner: 'model-use-cases desk + driver',
      description: 'Give the UC bundle its never-run reviewer stage; reconcile the hold violation (r2 derive RA-3, unpaid)',
      details: 'The model-use-cases bundle is the only desk product in the corpus that has never passed a reviewer stage, and it was authored in violation of its own desk\'s upstream hold. Execute the reviewer stage and record how the hold was resolved.',
    },
    {
      actionId: 'RA-4',
      priority: 'MAJOR',
      owner: 'architecture-contract desk + all desks binding the anchor',
      description: 'Re-seal the contract layer so the governing address resolves (r2 RA-2/RA-4, unpaid)',
      details: `Re-seal the architecture-contract artifacts so their contentDigest equals sha256(canonical(content)); then update governingContractRef (${GOV.slice(0, 8)}...) across the r3 desks and resubmit evidence sets. Until then every binding is an evidence ref that fails independent recomputation.`,
    },
    {
      actionId: 'RA-5',
      priority: 'PROCESS',
      owner: 'driver / shell',
      description: 'Refresh envelope projections (r2 RA-5, unpaid)',
      details: `This frame projects "1 accepted upstream revision of define-acceptance-contract" (${shaRef(UPSTREAM_PROJECTED)}) which resolves to no content; the likely source is the r1 pseudo-addressed acceptance record. Envelope projections must be derived from verdict-record state, not round memory.`,
    },
    {
      actionId: 'RA-6',
      priority: 'MINOR',
      owner: 'define-acceptance-contract desk (author)',
      description: 'Status-layer honesty for verification flags',
      details: 'Verification flags must not assert accepted-states (revisionPinsMatchAcceptedRevisions) that only verdict records can establish. Restate digest-layer facts as digest-layer facts, and gate status-layer claims on a verdict-record audit.',
    },
  ],
  evidenceReferences: [
    shaRef(FS_AUTHOR), shaRef(ART), shaRef(TRC_AUTHOR),
    shaRef(INTENT), shaRef(UC), shaRef(SR),
    shaRef(CAPSULE), shaRef(CERT),
    ...Object.values(ENVELOPE).map(shaRef),
    shaRef(GOV), shaRef(IMP), shaRef(IMP_TRC), shaRef(IMP_REV),
    intentRev1.contentDigest, intentRev2.contentDigest,
    srRev.contentDigest, srRestaff.contentDigest, ucHold.contentDigest,
    shaRef(vvDigest),
  ].map((x) => (x.startsWith('sha256:') ? x : shaRef(x))),
  conclusion: 'The candidate of record (SR-Define-Acceptance-Contract-001, sha256:' + ART.slice(0, 8) + '...) is content-integrity-clean at the digest layer - 92/99 recomputations pass, the bundle re-seals through the REAL acceptance cell to the declared seal, all five criterion seams seal, the trace resolves exactly, the envelope transports intact, and the workspace-law adjudication upholds the author where the envelope could not. It is nonetheless returned as repair on grounds the kernel surface cannot see: (CRIT-1) the entire acceptance surface binds revisions that are NOT accepted - intent repair x2 rounds with no reissue, UC never reviewed and hold-violating, requirements repair + re-staffed - while the candidate asserts them accepted, one desk before reconcile-what; (CRIT-2) the candidate restates the prd:scope-2 exclusion as settled fact although its authority was established as nonexistent by three upstream verdict records; (MAJ-1) the governing-contract anchor still resolves to no content, the unremediated r2 debt. Repair per RA-1..RA-6: the desk holds until genuinely accepted revisions exist, then reissues against them. The acceptance desk may not settle - and the chain may not reach reconcile-what - on relabeled lineage.',
};
const frDigest = sha(frContent);
const fr = {
  artifactRef: shaRef(frDigest),
  artifactKind: 'formalization-review',
  contentDigest: frDigest,
  semanticCode: 'FR-Define-Acceptance-Contract-001',
  createdAt: PIN,
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: frContent,
};
writeFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-review.json'), JSON.stringify(fr, null, 2) + '\n');

/* -------------------------------------------------------------- 3. RT */
const rtContent = {
  traceId: 'RT-Define-Acceptance-Contract-001',
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  traceKind: 'reviewer-verdict-trace',
  subjectSemanticCode: 'FR-Define-Acceptance-Contract-001',
  subjectArtifactRef: shaRef(frDigest),
  verdict: 'repair',
  relationVocabulary: ['reviews', 'derived_from', 'constrained_by', 'resolves', 'supports', 'enforces', 'produces'],
  relationships: [
    {
      fromId: 'FR-Define-Acceptance-Contract-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'SR-Define-Acceptance-Contract-001',
      toRef: shaRef(ART),
      description: 'Independent reviewer verification of the acceptance-bindings artifact (verdict repair: CRIT-1, CRIT-2, MAJ-1)',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'FS-Define-Acceptance-Contract-001',
      toRef: shaRef(FS_AUTHOR),
      description: 'Independent reviewer verification of the author product submission',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'author-trace:define-acceptance-contract',
      toRef: shaRef(TRC_AUTHOR),
      description: 'Reviewer verification of the author trace graph (16/16 relationships resolve)',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-001',
      fromRef: shaRef(frDigest),
      relation: 'enforces',
      toId: 'constraint:retention-1',
      toRef: shaRef(ENVELOPE['constraint:retention-1']),
      description: 'Reviewer artifacts are deterministic: pinned timestamp, computed digests only',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-001',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:audited-1',
      toRef: shaRef(ENVELOPE['terminal:audited-1']),
      description: 'This independent desk audit (99 recomputations, REAL cell provider recheck, status-layer audit) is the audited-1 realization at the acceptance desk; the repair loop keeps the audit honest',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-001',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:delivered-1',
      toRef: shaRef(ENVELOPE['terminal:delivered-1']),
      description: 'The repair verdict holds the delivered terminal to its evidence standard: the chain reaches reconcile-what only over genuinely accepted revisions under authority that exists (RA-1..RA-4)',
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
      supportedBy: ['FR-Define-Acceptance-Contract-001', 'ac:terminal-1-audited'],
    },
    'terminal:delivered-1': {
      digest: ENVELOPE['terminal:delivered-1'],
      supportedBy: ['FR-Define-Acceptance-Contract-001', 'ac:outcome-1-delivered'],
    },
  },
};
const rtDigest = sha(rtContent);
const rt = {
  traceRef: shaRef(rtDigest),
  traceKind: 'reviewer-verdict-trace',
  contentDigest: rtDigest,
  createdAt: PIN,
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: rtContent,
};
writeFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-trace.json'), JSON.stringify(rt, null, 2) + '\n');

/* -------------------------------------------------------------- 4. FS */
const fsContent = {
  deskRef: 'define-acceptance-contract',
  deskNodeId: 'define-acceptance-contract',
  role: 'reviewer',
  itemInstanceId: 'formalization-item:define-acceptance-contract',
  token: 'plan:formalization#item:acceptance-contract',
  verdict: 'repair',
  candidate: {
    kind: 'formalization.review-complete.v1',
    artifactRef: shaRef(frDigest),
    contentDigest: frDigest,
  },
  payloadContract: {
    productKind: 'formalization.review-complete.v1',
    effectId: 'formalization.accept-products',
    requiredEvidenceRefs: [
      shaRef(CAPSULE), shaRef(CERT),
      ...Object.values(ENVELOPE).map(shaRef),
      shaRef(GOV), shaRef(frDigest), shaRef(rtDigest), shaRef(vvDigest),
    ],
    evidenceKindCoverage: {
      'discovery-handoff-capsule': 1,
      'discovery-certificate': 1,
      'source-claim': 4,
      constraint: 1,
      unknown: 1,
      'terminal-claim': 2,
      'architecture-contract': 1,
      'formalization-review': 1,
      'reviewer-verdict-trace': 1,
      'reviewer-verification': 1,
    },
    terminalOutcome: 'success',
  },
  reviewRef: shaRef(frDigest),
  traceRef: shaRef(rtDigest),
  verificationRef: shaRef(vvDigest),
  reviewedCandidateRefs: {
    submissionRef: shaRef(FS_AUTHOR),
    artifactRef: shaRef(ART),
    authorTraceRef: shaRef(TRC_AUTHOR),
  },
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#define-acceptance-contract:reviewer',
    status: 'review_complete_verdict_recorded',
    receivedFrom: 'reviewer',
    nextStage: 'final-gate',
    note: 'Verdict repair returned to the define-acceptance-contract author desk (CRIT-1 unaccepted lineage asserted accepted; CRIT-2 scope-2 exclusion ratified; MAJ-1 unresolvable governing-contract anchor). The final gate consumes the reviewer verdict per the driver contract.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Independent recomputation performed: 99 checks, nothing trusted by declaration, REAL cell provider rechecked with zero softening', satisfied: true },
    { id: 3, description: 'All 8 reviewer-envelope task-projection content addresses resolved; workspace projection 32892970... adjudicated UNRESOLVABLE (author 0 upheld)', satisfied: true },
    { id: 4, description: 'Verdict recorded with findings, evidence, and required actions (CRIT-1, CRIT-2, MAJ-1, ADV-1..3; RA-1..RA-6)', satisfied: true },
    { id: 5, description: 'Reviewer artifacts deterministic: pinned timestamp, no clock reads, no randomness', satisfied: true },
    { id: 6, description: 'constraint:retention-1 honored across author and reviewer artifacts', satisfied: true },
    { id: 7, description: 'unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true },
    { id: 8, description: 'Upstream ACCEPTANCE STATE independently audited from verdict records, not round labels (M1-M5)', satisfied: true },
    { id: 9, description: 'Candidate\'s consumed upstream genuinely accepted', satisfied: false, note: 'CRIT-1 recorded honestly: three of four consumed links are repair-verdict or never-reviewed; verdict repair rather than blind acceptance' },
    { id: 10, description: 'No fabricated disposition ratified into the acceptance surface', satisfied: false, note: 'CRIT-2 recorded honestly: the candidate restates the prd:scope-2 exclusion as fact' },
    { id: 11, description: 'Governing contract evidence ref verified before inheritance', satisfied: false, note: 'MAJ-1 recorded honestly: the anchor fails independent recomputation workspace-wide; r2 RA-2/RA-4 debt remains open' },
  ],
};
const fsDigest = sha(fsContent);
const fsArt = {
  submissionRef: shaRef(fsDigest),
  submissionId: 'FS-Define-Acceptance-Contract-002',
  contentDigest: fsDigest,
  createdAt: PIN,
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: fsContent,
};
writeFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-product-submission.json'), JSON.stringify(fsArt, null, 2) + '\n');

/* -------------------------------------------------------------- 5. MD */
const md = `# define-acceptance-contract desk (reviewer) - r3 review record

Round: stray-products-r3 · reviewed candidate of record: SR-Define-Acceptance-Contract-001
(\`sha256:${ART}\`, submission FS-Define-Acceptance-Contract-001 \`sha256:${FS_AUTHOR}\`,
trace \`sha256:${TRC_AUTHOR}\`) · verdict: **repair**

## What was independently verified (nothing trusted by declaration)

- **99 recomputations** (\`define-acceptance-contract-desk-reviewer-verify.mjs\`), rule
  \`sha256(canonicalJson)\` per \`src/workflow-kernel/domain/digest.ts\`:
  **92 pass / 7 fail**. Full evidence:
  \`define-acceptance-contract-desk-reviewer-verification.json\` (VV-Define-Acceptance-Contract-001,
  \`sha256:${vvDigest}\`).
- **Same-provider recheck, zero softening** (\`ACCEPTANCE_REVIEWER_ROUTE\`): the bundle re-seals
  through the REAL installed cell (\`acceptanceUniverseFrom\` → \`validateAcceptanceBundle\` →
  the WP03 \`validateAcBinding\` seam ×5) to the exact declared product seal
  \`sha256:14fda7910eedff5a…\`; all 5 verifiable-statement seals recompute.
- Upstream re-verified through the REAL surfaces: 6 PRD member seals + REAL intent fold, 3 UC
  seals + REAL fold, 4 requirement seals, requirements bundle re-sealed against its recomputed
  WP03 universe — every \`accepted-*\` ref binds the recomputed digest.
- rev-1 duty: every scenario-facing citation pair re-derives from the bound requirement's own
  derivation; zero deferrals/standalone bindings verified lawful under full end-to-end coverage.
- Negative probes all killed: stripped branch citation → \`MISSING_LINEAGE\`; foreign scenario →
  \`FOREIGN_LINEAGE\`; foreign requirement → \`FOREIGN_LINEAGE\`; uncovered requirement →
  \`COVERAGE_GAP\`; WHAT-side key → \`SCOPE_VIOLATION\`.
- Trace: 16/16 relationships resolve; all coverage blocks are exact projections of the edge set.

## Workspace-law adjudication

The reviewer frame projects **"1 accepted upstream revision"** of define-acceptance-contract
(\`sha256:${UPSTREAM_PROJECTED.slice(0, 8)}…\`). Verdict: **UNRESOLVABLE — author 0 upheld.**
K2 scanned ${scanCount} workspace files under \`qualification/\`: zero raw-byte, zero
canonical-JSON, zero \`.content\` hits (the sole textual mention is this reviewer's own verify
script). No accepted revision of this desk exists anywhere: the r1 acceptance records are
**pseudo-addressed** (\`sha256:define-acceptance-contract-formalization-2026-08-27\` is not a
content address), r2 never ran the desk, and the only r3 revision is the candidate under review.
Stale shell metadata recorded for the shell owner (r2 RA-5 still open).

## Why repair (not accepted)

| id | severity | finding |
|----|----------|---------|
| CRIT-1 | CRITICAL | The acceptance surface binds revisions that are **NOT accepted** while asserting they are: intent \`${INTENT.slice(0, 8)}…\` = verdict **repair ×2 rounds** (FR-…-001, FR-…-002; scope-2 fabricated authority) with **no reissue anywhere**; UC \`${UC.slice(0, 8)}…\` = **never reviewed** (no reviewer artifact exists in the corpus) and authored in violation of its own desk's upstream hold \`${ucHold.contentDigest.slice(0, 8)}…\`; requirements \`${SR.slice(0, 8)}…\` = verdict **repair** + re-staff confirmation. Only the import chain is genuinely accepted. \`revisionPinsMatchAcceptedRevisions=true\` is false at the status layer. |
| CRIT-2 | CRITICAL | The candidate restates the \`prd:scope-2\` \`out_of_scope\` exclusion **as settled fact** (brief + self-check 10) — but SC-2 \`${ENVELOPE['claim:scope-2'].slice(0, 8)}…\` is a bare claim, CERT-1 a subject-level go, and the exclusion's authority was established as nonexistent by **three** upstream verdict records. Zero derivation edges are lawful under contest; restating the exclusion as the acceptance contract's premise launders the fabrication a third time. |
| MAJ-1 | MAJOR | \`governingContractRef\` \`sha256:${GOV.slice(0, 8)}…\` **resolves to no content** workspace-wide (${govMentions} mentioning files; r1 contract claimants all recompute otherwise) — the r2 RA-2/RA-4 debt, now inherited by a fourth desk. |
| ADV-1..3 | advisory | Stale envelope projection (phantom accepted revision); byte-identical relabeling round (repair-verdict material re-emitted and relabeled "accepted" with no state change; the UC hold silently overridden); pseudo-addressed legacy r1 acceptance records. |

Required actions RA-1..RA-6 are in the review artifact
(FR-Define-Acceptance-Contract-001, \`sha256:${frDigest}\`). The headline: **RA-1** this desk
HOLDS until genuinely accepted revisions exist — an acceptance contract over unaccepted lineage
has no referent — then reissues against verdict-backed revisions only; **RA-2** settle the intent
contention and restore \`claim:scope-2\`; **RA-3** give the UC bundle its never-run reviewer stage.

## Reviewer artifact index (all content-addressed, deterministic)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification | \`sha256:${vvDigest}\` |
| review | formalization-review | \`sha256:${frDigest}\` |
| trace | reviewer-verdict-trace | \`sha256:${rtDigest}\` |
| submission | FS-Define-Acceptance-Contract-002 | \`sha256:${fsDigest}\` |

Pinned timestamp ${PIN} across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere.
`;
writeFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-submission-summary.md'), md);

console.log(JSON.stringify({
  built: ['verification', 'review', 'trace', 'submission', 'summary'],
  verification: shaRef(vvDigest),
  review: shaRef(frDigest),
  trace: shaRef(rtDigest),
  submission: shaRef(fsDigest),
}, null, 2));
