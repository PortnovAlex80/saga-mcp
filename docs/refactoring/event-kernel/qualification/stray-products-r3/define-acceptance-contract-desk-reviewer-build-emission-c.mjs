/**
 * define-acceptance-contract desk (reviewer) — emission C builder.
 *
 * Round: stray-products-r3. This emission is the ADJUDICATING reviewer
 * emission: a fresh reviewer dispatch (same task-projection envelope as
 * emissions A and B) that independently re-derived the verdict-determining
 * evidence and resolves the CL-Define-Acceptance-Contract-001 contention.
 *
 * Evidence base (all independently re-derived by this emission — nothing
 * trusted by declaration):
 *   - candidate/upstream artifact content digests recomputed (canonical JSON);
 *   - intent verdict records FR-Define-Product-Intent-001 / -002 read
 *     directly (both verdict repair against artifactRef a06dbc57...);
 *   - requirements verdict record FR-Derive-System-Requirements-001 read
 *     directly (verdict repair against artifactRef 86b00569...);
 *   - UC reviewer stage: corpus-wide scan found zero reviewer artifacts for
 *     the model-use-cases bundle; the r2 upstream hold artifact is on record;
 *   - capsule SC-2 recomputed (bare claim statement) and CERT-1 read
 *     (subject-level go) — no scope-2 exclusion authority exists;
 *   - governingContractRef a926df62...: independent workspace scan, 261
 *     files, 0 content-address hits, 97 textual mentions;
 *   - envelope upstream-accepted projection 32892970...: 0/261 content hits
 *     (phantom; stale shell metadata, r2 RA-5 open);
 *   - the candidate bundle re-seals through the REAL acceptance cell to the
 *     declared product seal 14fda791... (mechanical verifier re-run, E2);
 *   - the corpus mechanical verifier (emission A script, REAL dist/src cell
 *     imports, read-only) re-run by this emission reproduces 99/92/7 with
 *     ZERO per-check verdict differences against the committed out file;
 *   - emission B's verification surface enumerated: 50 checks in 10 groups,
 *     all digest/gate-level, no status-layer counterpart of I4/L2/M2-M5/N1;
 *   - collision record CL-001 self-digest recomputes (102be882...).
 *
 * Verdict of record: REPAIR. Emission B's `accepted` is superseded: it is
 * not evidence-backed against recomputable failures still on disk (CL-001
 * resolution demand 1). Emission A's repair is confirmed.
 *
 * Determinism: pinned timestamp 2026-08-28T00:00:00Z; no clock reads, no
 * randomness. Digest rule: sha256 over canonical JSON of content
 * (recursively key-sorted, compact) per src/workflow-kernel/domain/digest.ts.
 *
 * Run: node define-acceptance-contract-desk-reviewer-build-emission-c.mjs
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const PINNED = '2026-08-28T00:00:00Z';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const ref = (d) => `sha256:${d}`;

/* ------------------------------------------------------------------ */
/* Shared subject refs (all recomputed by this emission)               */
/* ------------------------------------------------------------------ */

const CAND = {
  submissionRef: 'sha256:6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe',
  submissionId: 'FS-Define-Acceptance-Contract-001',
  artifactRef: 'sha256:2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0',
  artifactSemanticCode: 'SR-Define-Acceptance-Contract-001',
  traceRef: 'sha256:2835aea3f7bbf362afabf729ca37a18827bd9579c76f30daad12d8a2272a84e1',
  productKind: 'formalization.acceptance-bindings.v1',
  productSeal: 'sha256:14fda7910eedff5a84f69d13e5b85070fe395f349d75263d145543f781085f51',
};

const CL_RECORD = {
  semanticCode: 'CL-Define-Acceptance-Contract-001',
  ref: 'sha256:102be8821f2a76239dd92b6cccfde764300485c5bf9e163bf2b9f0f7c6a3784e',
};

const EMISSION_A = {
  verification: 'sha256:367a38fcf8d0bd061fa2e023aba4aaab0060a82a71278ca358d6b3415b5602bb',
  review: 'sha256:83e675bb18c575cb0b30e3ededd2cca6b58b88c08cb50be9c08dfb130808c383',
  trace: 'sha256:35c551ac922b2d27c1291c351efa50e32e35f4a931c81c7c8ce2c4c16e33a3d5',
  submission: 'sha256:983ce949d726ce3fbd2bf68a755789c8ca96e6f325b8c41553c1a3d540e73ed6',
};

const EMISSION_B = {
  verification: 'sha256:17eb4d7fe2a9704df2ae45ef572a3905690a0d34ce4fd59d871f88da83850a43',
  review: 'sha256:e5249d786aa3318a7426dde2ba36e111437d4e0ab0e7e6f9e7cda3b9463ce466',
  submission: 'sha256:5ee3d51b62d80fd5feb339ec3549709d0d599d757bf99578c51b6e3763d6a1d0',
};

/* ------------------------------------------------------------------ */
/* 1. Verification record (VV-...-002) — this emission's own evidence  */
/* ------------------------------------------------------------------ */

const verificationContent = {
  verificationId: 'VV-Define-Acceptance-Contract-002',
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; re-seal evidence via the REAL acceptance cell surfaces (dist cells + WP03 seam) through the corpus mechanical verifier re-run by this emission',
  subject: CAND,
  emission: 'C (adjudicating reviewer emission)',
  recomputedChecks: 10,
  passed: 10,
  failed: 0,
  trustedByDeclaration: false,
  results: [
    {
      id: 'C1.chain.selfAddresses',
      ok: true,
      detail: 'candidate artifact 2b01353d... recomputed by this emission (canonical JSON) and equals its declared contentDigest; the consumed upstream artifact digests recompute: intent a06dbc57..., UC 24f0aff2..., requirements 86b00569... (r3 copies hashed directly).',
    },
    {
      id: 'C2.chain.reseals',
      ok: true,
      detail: 'REAL validateAcceptanceBundle re-seal equals the declared product seal sha256:14fda7910eedff5a84f69d13e5b85070fe395f349d75263d145543f781085f51 (mechanical verifier re-run check E2; script imports verified to be the REAL dist acceptance cell, the REAL acceptanceUniverseFrom protocol and the WP03 validateAcBinding seam).',
    },
    {
      id: 'C3.intentVerdicts.repairNoReissue',
      ok: true,
      detail: 'FR-Define-Product-Intent-001 and FR-Define-Product-Intent-002 (reviewer2) read directly by this emission: both verdict repair, both reviewedCandidate.artifactRef = sha256:a06dbc57... (the exact revision the candidate consumes); both CRIT-1 (prd:scope-2 fabricated disposition authority); no intent reissue exists (r2/r3 intent artifacts hash to the same repair-verdict revision).',
    },
    {
      id: 'C4.ucReviewerStage.absent',
      ok: true,
      detail: 'corpus-wide scan by this emission: the only model-use-cases files mentioning a reviewer are the r2/r3 product submissions and the r2 upstream-hold artifact (holdKind=uc-upstream-hold, sha256:6cccd162...); no UC reviewer review/verification artifact exists anywhere. The consumed UC bundle 24f0aff2... never passed a reviewer stage.',
    },
    {
      id: 'C5.requirementsVerdict.repair',
      ok: true,
      detail: 'FR-Derive-System-Requirements-001 read directly by this emission: verdict repair against artifactRef sha256:86b00569... (CRIT-1 unaccepted lineage asserted accepted; CRIT-2 scope-2 ratification; MAJ-1 governing anchor), plus re-staffing confirmation RS-Derive-System-Requirements-001; the r3 requirements copy hashes to the same repair-verdict revision.',
    },
    {
      id: 'C6.scope2.noAuthority',
      ok: true,
      detail: 'capsule SC-2 content read directly (digest cb291aa7...): {claimId: claim:scope-2, statement: "Accepted discovery source claim 2 of the message service subject."} — a bare claim, no decision; CERT-1 read directly: {kind: discovery-certificate, decision: go, subject: message service} — subject-level go. No Discovery exclusion decision for prd:scope-2 exists; three upstream verdict records established the cited authority nonexistent.',
    },
    {
      id: 'C7.governingContract.unresolvable',
      ok: true,
      detail: 'independent workspace scan by this emission: 261 files under qualification/ — 0 content-address hits for sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837 (raw bytes, whole-JSON canonical, .content canonical), 97 textual mentions. UNRESOLVED (MAJ-1 confirmed independently).',
    },
    {
      id: 'C8.envelopeProjection.phantom',
      ok: true,
      detail: 'upstream-accepted[0] sha256:32892970b44cb1d25a5fdce61e4cea43500ccd1cc4cb8fb03e2b268e1758645d resolves to no content workspace-wide (0/261 files; mechanical verifier K2 concurs). Adjudicated UNRESOLVABLE: stale shell metadata for the shell owner (r2 RA-5 open).',
    },
    {
      id: 'C9.emissionB.surfaceGap',
      ok: true,
      detail: 'emission B verification enumerated by this emission: 50 checks in 10 groups (selfAddress, productSeals, gate, reviewerDuties, coverage, terminals, trace, upstream, envelope, reviewerRound) — all digest/gate-level; it contains NO counterpart of I4/L2/M2/M3/M4/M5/N1. Its accepted verdict therefore does not engage — and is contradicted by — the recomputable status-layer failures.',
    },
    {
      id: 'C10.emissionA.reproduces',
      ok: true,
      detail: 'the corpus mechanical verifier re-run by this emission reproduces emission A exactly: 99 recomputations, 92 pass, 7 fail, identical failedCheckIds, ZERO per-check verdict differences against the committed emission-a out file (2 detail-string diffs only: workspace scan-count drift, 254 -> 261 files, expected as the collision artifacts grew the corpus).',
    },
  ],
  contentionAdjudication: {
    contentionId: 'CTN-Define-Acceptance-Contract-001',
    collisionRecord: CL_RECORD,
    resolution: 'VERDICT OF RECORD: repair (emission A confirmed; emission B superseded)',
    grounds: [
      'The seven status-layer failures re-derive under this emission\'s own reads and scans (C3-C7), independent of emission A\'s script.',
      'The candidate chain is digest-clean and re-seals through the REAL cell (C1/C2) — the defects are at the workflow-status layer, which the kernel surface cannot see; the desk review seat exists precisely to adjudicate it.',
      'Emission B\'s accepted verdict is not evidence-backed: its 50-check surface contains no status-layer audit (C9), so acceptance would contradict recomputable evidence still on disk — exactly what collision record CL-001 resolution demand 1 forbids the final gate to consume.',
      'The r2 precedent (CL-Define-Product-Intent-001) resolved the identical defect class the same way: the digest-only accepted emission was WRONG; the status-auditing repair emission was correct.',
    ],
    superseded: {
      emission: 'B',
      review: EMISSION_B.review,
      verification: EMISSION_B.verification,
      submission: EMISSION_B.submission,
      reason: 'accepted verdict without a status-layer audit; superseded by content-addressed evidence, preserved (never erased) under CL-001',
    },
    confirmed: {
      emission: 'A',
      review: EMISSION_A.review,
      verification: EMISSION_A.verification,
      trace: EMISSION_A.trace,
      submission: EMISSION_A.submission,
      note: 'repair verdict confirmed by independent re-derivation; emission A\'s reissued -emission-a artifacts remain the preserved A record',
    },
  },
};

const verificationDigest = sha(verificationContent);

const verification = {
  verificationRef: ref(verificationDigest),
  verificationKind: 'reviewer-verification',
  contentDigest: verificationDigest,
  semanticCode: 'VV-Define-Acceptance-Contract-002',
  createdAt: PINNED,
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: verificationContent,
};

/* ------------------------------------------------------------------ */
/* 2. Review artifact (FR-...-002) — verdict of record                 */
/* ------------------------------------------------------------------ */

const reviewContent = {
  reviewId: 'FR-Define-Acceptance-Contract-002',
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  reviewedRound: 'stray-products-r3',
  emission: 'C (adjudicating reviewer emission; resolves CTN-Define-Acceptance-Contract-001)',
  reviewedCandidate: CAND,
  verificationRef: ref(verificationDigest),
  verificationSummary: {
    recomputedChecks: 10,
    passed: 10,
    failed: 0,
    trustedByDeclaration: false,
    note: 'this emission\'s own adjudication checks C1-C10; the corpus mechanical verifier additionally re-run: 99 recomputations, 92 pass, 7 fail (identical to emission A, zero verdict diffs) — the 7 status-layer failures are the findings below.',
  },
  providerRecheck: {
    route: 'same-provider-recheck (ACCEPTANCE_REVIEWER_ROUTE; one declared provider per desk; a reviewer can never soften a check)',
    providerId: 'frf.acceptance-closure.v1',
    resealedToDeclaredSeal: true,
    declaredSeal: CAND.productSeal,
    note: 'bundle re-seals through the REAL acceptance cell (acceptanceUniverseFrom -> validateAcceptanceBundle, WP03 validateAcBinding seam x5) to the exact declared seal; negative probes (branch-strip, scenario substitution, foreign requirement, uncovered requirement, WHAT-side key) all refuse with typed reasons — confirmed via the re-run mechanical verifier.',
  },
  contentionAdjudication: {
    collisionRecord: CL_RECORD,
    verdictOfRecord: 'repair',
    emissionAConfirmed: EMISSION_A.review,
    emissionBSuperseded: EMISSION_B.review,
    supersessionGrounds: 'emission B\'s accepted verdict rests on a 50-check digest/gate-level surface with no status-layer audit; the seven recomputable status-layer failures (I4, L2, M2, M3, M4, M5, N1) re-derive under this emission\'s own reads and scans. Per CL-001 resolution demand 1 the final gate must not consume an accepted verdict that contradicts recomputable evidence still on disk.',
    namespaceNote: 'canonical filenames remain MIXED across emissions (CL-001 PROCESS-2); every consumer must resolve artifacts by content address, never by filename. This emission writes only its own -emission-c files and touches no contested filename.',
  },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    note: 'all 8 reviewer-envelope task-projection content addresses travel inside the candidate artifact and recompute; the envelope upstream-accepted projection (sha256:32892970...) is adjudicated UNRESOLVABLE under workspaceAdjudication.',
  },
  workspaceAdjudication: {
    envelopeProjection: '1 accepted upstream revisions travel by content address (upstream-accepted[0] sha256:32892970b44cb1d25a5fdce61e4cea43500ccd1cc4cb8fb03e2b268e1758645d :: accepted revision of define-acceptance-contract)',
    scanEvidence: 'this emission\'s scan: 261 workspace files under qualification/ — 0 raw-byte, 0 canonical-JSON, 0 .content canonical hits for the projected address.',
    closure: 'UNRESOLVABLE. No accepted define-acceptance-contract revision exists anywhere: the r1 acceptance records are pseudo-addressed (legacy regime), r2 never ran this desk, and the only r3 revision is the candidate under review. Stale shell metadata, recorded for the shell owner (r2 RA-5 still open).',
  },
  findings: {
    positiveFindings: [
      'The candidate of record is content-integrity-clean at the digest layer: submission, artifact and trace self-addresses recompute; the bundle re-seals through the REAL acceptance cell to the declared product seal 14fda791...; all five criterion seams seal via the REAL WP03 validateAcBinding; upstream pins are byte-exact to the consumed revisions (no fabricated addresses anywhere in the candidate).',
      'The verdict-determining status-layer facts were re-derived by THIS emission from primary records: both intent verdict files read directly (repair x2 against a06dbc57...), the requirements verdict file read directly (repair against 86b00569...), the capsule SC-2 and CERT-1 contents read directly (bare claim; subject-level go), and the UC reviewer-stage absence established by corpus-wide scan.',
      'The governing-contract anchor was re-scanned independently: 261 files, zero content-address hits for sha256:a926df62..., 97 textual mentions (MAJ-1 confirmed).',
      'The collision contention was adjudicated on evidence: emission A\'s mechanical verifier re-runs to exactly 99/92/7 with zero per-check verdict differences; emission B\'s verification surface demonstrably lacks any status-layer counterpart. Repair is the evidence-backed verdict; the r2 precedent (identical defect class) agrees.',
      'constraint:retention-1 honored (deterministic artifacts, pinned timestamps); unknown:browser-matrix-1 carried forward unresolved; both terminal lifecycle claims remain owned upstream with exact support chains.',
    ],
    criticalIssues: [
      {
        issueId: 'CRIT-1',
        severity: 'CRITICAL',
        category: 'unaccepted_lineage_asserted_accepted',
        title: 'The candidate builds its acceptance surface over revisions that are NOT accepted while asserting they are',
        description: 'The candidate\'s material authority, accepted* upstream fields and accepted-* evidence kinds assert accepted intent/UC/requirements revisions. The status audit proves otherwise for three of the four consumed links: intent a06dbc57... carries verdict repair twice (FR-Define-Product-Intent-001, FR-Define-Product-Intent-002; both CRIT-1 prd:scope-2 fabricated disposition authority) with no author reissue; UC 24f0aff2... never passed a reviewer stage and was authored in violation of its own desk\'s upstream hold (sha256:6cccd162...); requirements 86b00569... carries verdict repair (FR-Derive-System-Requirements-001) plus a re-staff confirmation. Only the discovery import chain is genuinely accepted. The acceptance desk\'s whole product is the statement "these exact criteria close the accepted material"; over unaccepted lineage it launders the unaccepted chain one desk before reconcile-what. Independently re-derived by this emission from the verdict records themselves (checks C3-C5).',
        evidence: [
          'C3: intent verdict records read directly; no reissue (r2/r3 intent artifacts hash identically).',
          'C4: corpus-wide scan — zero UC reviewer artifacts; r2 upstream hold on record.',
          'C5: requirements verdict record read directly; r3 copy byte-identical to the repair-verdict revision.',
        ],
        violatedPrinciples: ['CON-1 material authority travels by content AND by verdict records', 'D10 converse: never relabel unaccepted material as accepted', 'r2 FR-Derive-System-Requirements-001 CRIT-1 remediation debt'],
        impact: 'Acceptance would ratify an acceptance contract whose entire binding surface hangs off unaccepted revisions and would wave the chain through to reconcile-what as if settled.',
      },
      {
        issueId: 'CRIT-2',
        severity: 'CRITICAL',
        category: 'fabricated_disposition_authority_ratified',
        title: 'The candidate restates the prd:scope-2 out_of_scope exclusion as settled fact in the acceptance surface',
        description: 'The candidate brief and acceptance self-check 10 restate the prd:scope-2 exclusion as fact, but the capsule material for claim:scope-2 (SC-2, cb291aa7...) is a bare claim statement and CERT-1 is a subject-level go — no exclusion decision exists; three upstream verdict records established the cited authority nonexistent. Keeping zero derivation edges from prd:scope-2 is defensible while contested; restating the exclusion as the acceptance contract\'s own premise makes this desk the third link that launders the fabrication. Re-derived by this emission from the capsule contents themselves (check C6).',
        evidence: ['C6: SC-2 and CERT-1 contents read directly from the import capsule.'],
        violatedPrinciples: ['CON-1 content-address provenance honesty', 'TC-2 accepted material carries accepted content until a real disposition authority exists'],
        impact: 'The acceptance contract would memorialize a fabricated disposition as an accepted premise for every downstream reader.',
      },
    ],
    majorIssues: [
      {
        issueId: 'MAJ-1',
        severity: 'MAJOR',
        category: 'unresolvable_governing_contract_anchor',
        title: 'governingContractRef sha256:a926df62... resolves to no content anywhere in the round workspace',
        description: 'The candidate binds governingContractRef sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837 and lists it in its required evidence. This emission\'s independent scan: 261 files, 0 content-address hits (raw bytes, whole-JSON canonical, .content canonical), 97 textual mentions; the r1 contract-layer claimants all recompute to different digests. The unremediated r2 RA-2/RA-4 debt, now inherited by a fourth desk.',
        evidence: ['C7: independent 261-file scan by this emission.'],
        violatedPrinciples: ['CON-1 content-address transport', 'TC-1 evidence refs must resolve to recomputable content', 'r2 RA-2/RA-4 remediation debt'],
        impact: 'The round governing-contract continuity anchor remains decorative; acceptance would ratify an evidence ref that fails at the first independent recomputation.',
      },
    ],
    advisoryNotes: [
      {
        type: 'stale_envelope_projection',
        note: 'ADV-1. The reviewer frame projects "1 accepted upstream revision of define-acceptance-contract" (sha256:32892970...) which resolves to no content workspace-wide (this emission: 0/261 files). Stale shell metadata; r2 RA-5 remains open. See workspaceAdjudication.',
      },
      {
        type: 'reviewer_collision',
        note: 'ADV-2. Two earlier reviewer emissions collided on the canonical filenames (CL-Define-Acceptance-Contract-001): emission B overwrote emission A in place, leaving a MIXED canonical namespace. Repeat of the r2 ADV-4 defect class. This emission adjudicates the contention and writes only its own -emission-c files.',
      },
      {
        type: 'byte_identical_relabeling_round',
        note: 'ADV-3. The r3 round re-emitted r2 repair-verdict intent/requirements revisions byte-identically, relabeled the chain "accepted" with no state change, and silently overrode the r2 UC upstream hold. A round boundary is not an acceptance event.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed desk artifacts with SHA256 digests over canonical JSON', satisfied: true, evidence: 'this emission\'s artifacts self-seal; C1 chain self-addresses recomputed' },
    { id: 2, description: 'Same-provider recheck through the REAL acceptance cell with adversarial probes killed', satisfied: true, evidence: 'C2 + providerRecheck: re-seal to 14fda791...; probes refuse with typed reasons' },
    { id: 3, description: 'Law ac-1: every criterion binds exact ACCEPTED FR/NFR material', satisfied: false, evidence: 'C3-C5: nothing consumed is accepted (intent repair x2, UC never reviewed, requirements repair) — CRIT-1' },
    { id: 4, description: 'Laws ac-2/ac-3: both citation shapes re-derived from the bound requirements\' derivations', satisfied: true, evidence: 'mechanical re-run rev-1: all scenario-facing citation pairs re-derive' },
    { id: 5, description: 'Law ac-4: closed four-value evidence vocabulary with declared observable terminal results', satisfied: true, evidence: 'mechanical re-run: test/monitoring/audit only, terminal results declared' },
    { id: 6, description: 'Law ac-5 WHAT-side fence: no architecture/module/file decisions', satisfied: true, evidence: 'mechanical re-run: bundle and criterion scans clean; SCOPE_VIOLATION probe refused' },
    { id: 7, description: 'Laws ac-6/ac-7 closure: full requirements/branch coverage, unique criterion ids', satisfied: true, evidence: 'mechanical re-run: 4/4 requirements, 4/4 branches, 5 unique criteria, zero deferrals' },
    { id: 8, description: 'Trace relationships resolve against recomputed digests; coverage blocks are exact projections', satisfied: true, evidence: 'mechanical re-run: 16/16 relationships resolve' },
    { id: 9, description: 'Upstream consumed by the candidate is GENUINELY ACCEPTED (verdict records, not round labels)', satisfied: false, evidence: 'C3-C5: only the import chain is accepted — CRIT-1' },
    { id: 10, description: 'No fabricated disposition ratified into the acceptance surface', satisfied: false, evidence: 'C6: candidate restates the prd:scope-2 exclusion as fact — CRIT-2' },
    { id: 11, description: 'Governing contract evidence ref resolves to recomputable content', satisfied: false, evidence: 'C7: a926df62... unresolvable across 261 files — MAJ-1' },
    { id: 12, description: 'Verdict contention adjudicated on recomputable evidence; both prior emissions preserved by content address', satisfied: true, evidence: 'contentionAdjudication + C9/C10: repair confirmed, accepted superseded, nothing erased' },
    { id: 13, description: 'Workspace law adjudicated honestly; envelope projection resolved or adjudicated UNRESOLVABLE', satisfied: true, evidence: 'C8 + workspaceAdjudication: 0/261 hits, stale shell metadata recorded' },
    { id: 14, description: 'Deterministic authoring: pinned timestamps, no clock reads, no randomness (constraint:retention-1)', satisfied: true, evidence: 'pinned 2026-08-28T00:00:00Z across all emission-c artifacts' },
  ],
  verdict: 'repair',
  verdictVocabulary: ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'],
  finalGate: {
    gateVerdict: 'repair',
    providerId: 'reviewer-verdict',
    issues: ['CRIT-1', 'CRIT-2', 'MAJ-1'],
    note: 'per CL-001 resolution demand 1, the final gate consumes THIS adjudicated verdict — not emission B\'s superseded accepted',
  },
  requiredActions: [
    { actionId: 'RA-1', priority: 'CRITICAL', owner: 'define-acceptance-contract desk (author)', description: 'HOLD the desk until genuinely accepted upstream revisions exist; then reissue against them only', details: 'An acceptance contract over unaccepted lineage has no referent. Issue a hold record (r2 UC upstream-hold precedent) naming the three unaccepted links; strip every accepted-status assertion from interim material; reissue only against verdict-backed accepted revisions.' },
    { actionId: 'RA-2', priority: 'CRITICAL', owner: 'define-product-intent desk (author) + driver/human adjudication', description: 'Settle the intent contention, then restore claim:scope-2 (r2 RA-2 chain, unpaid)', details: 'Remediate FR-Define-Product-Intent-001/002 CRIT-1: reissue prd:scope-2 as carried system-boundary material or cite a genuinely recorded Discovery decision address. Until then no desk may restate the exclusion as fact.' },
    { actionId: 'RA-3', priority: 'MAJOR', owner: 'model-use-cases desk + driver', description: 'Give the UC bundle its never-run reviewer stage; reconcile the hold violation', details: 'The model-use-cases bundle is the only corpus desk product that never passed a reviewer stage, authored in violation of its own desk\'s upstream hold. Execute the reviewer stage and record how the hold was resolved.' },
    { actionId: 'RA-4', priority: 'MAJOR', owner: 'architecture-contract desk + all desks binding the anchor', description: 'Re-seal the contract layer so the governing address resolves (r2 RA-2/RA-4, unpaid)', details: 'Re-seal the architecture-contract artifacts so contentDigest equals sha256(canonical(content)); update governingContractRef across the r3 desks; resubmit evidence sets.' },
    { actionId: 'RA-5', priority: 'PROCESS', owner: 'driver / shell', description: 'Refresh envelope projections (r2 RA-5, unpaid)', details: 'The frame projects a phantom accepted revision (sha256:32892970...). Envelope projections must derive from verdict-record state, not round memory.' },
    { actionId: 'RA-6', priority: 'PROCESS', owner: 'formalization driver / shell', description: 'Single-seat discipline for desk review stages', details: 'Concurrent reviewer emissions into one canonical filename set is the r2 ADV-4 defect class, repeated in r3 (CL-001). One seat, one emission; re-staffing must supersede by content address, never overwrite in place.' },
    { actionId: 'RA-7', priority: 'MINOR', owner: 'define-acceptance-contract desk (author)', description: 'Status-layer honesty for verification flags', details: 'Verification flags must not assert accepted-states that only verdict records can establish; gate status-layer claims on a verdict-record audit.' },
  ],
  evidenceReferences: [
    CAND.submissionRef,
    CAND.artifactRef,
    CAND.traceRef,
    CAND.productSeal,
    'sha256:a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055',
    'sha256:24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b',
    'sha256:86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df',
    'sha256:e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4',
    'sha256:0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc',
    'sha256:d31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0',
    'sha256:1c30d28e8222eaa225195bf33d87f378054b98a01bdf50710fd4900f5339a0a6',
    'sha256:6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7',
    'sha256:b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5',
    'sha256:cfc7b35a5d0b71586e24be6474c5add914ba5f303edbd8bc2789782fd34b4d7b',
    'sha256:f3f98175f061fa289d49f4684f78273022c97b9e12bc535255c4b3d4c6a0534e',
    'sha256:03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21',
    'sha256:b15c35da54dd016492f397d71a59883d38cfb0c5e55aaa51f68c4d3f210d1909',
    'sha256:cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da',
    'sha256:6652762b7d8d26aacbaeb11f1b1e1529b26c2974ecf8ab0a01f0eb2b651d753b',
    'sha256:3d576e96e9c101b4b7187be8ce0d6f4542c161e8b8f9fa7323397329ac4e85b0',
    'sha256:807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be',
    'sha256:38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf',
    'sha256:4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f',
    'sha256:8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988',
    'sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837',
    CL_RECORD.ref,
    EMISSION_A.verification,
    EMISSION_A.review,
    EMISSION_A.trace,
    EMISSION_A.submission,
    EMISSION_B.verification,
    EMISSION_B.review,
    EMISSION_B.submission,
  ],
  conclusion: 'The candidate of record (SR-Define-Acceptance-Contract-001, sha256:2b01353d...) is content-integrity-clean at the digest layer — this emission re-derives the REAL-cell re-seal to the declared product seal and confirms the chain mechanics. It is nonetheless returned as REPAIR on grounds the kernel surface cannot see, each re-derived by this emission from primary records: (CRIT-1) the acceptance surface binds revisions that are NOT accepted — intent repair x2 with no reissue, UC never reviewed and hold-violating, requirements repair + re-staffed — while asserting them accepted, one desk before reconcile-what; (CRIT-2) the candidate restates the prd:scope-2 exclusion as settled fact although the capsule contains no such decision (SC-2 bare claim, CERT-1 subject-level go); (MAJ-1) the governing-contract anchor resolves to no content across 261 files. The reviewer-seat contention (CTN-Define-Acceptance-Contract-001) is adjudicated: emission A\'s repair is CONFIRMED (its mechanical verifier re-runs to exactly 99/92/7 under this emission\'s execution, zero verdict differences); emission B\'s accepted is SUPERSEDED (digest-only surface, no status-layer audit; an acceptance that contradicts evidence still on disk is exactly what CL-001 demand 1 forbids the final gate to consume). The desk holds until genuinely accepted revisions exist, then reissues against them (RA-1..RA-7).',
};

const reviewDigest = sha(reviewContent);

const review = {
  artifactRef: ref(reviewDigest),
  artifactKind: 'formalization-review',
  contentDigest: reviewDigest,
  semanticCode: 'FR-Define-Acceptance-Contract-002',
  createdAt: PINNED,
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: reviewContent,
};

/* ------------------------------------------------------------------ */
/* 3. Trace (RT-...-002)                                               */
/* ------------------------------------------------------------------ */

const traceContent = {
  traceId: 'RT-Define-Acceptance-Contract-002',
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  traceKind: 'reviewer-verdict-trace',
  subjectSemanticCode: 'FR-Define-Acceptance-Contract-002',
  subjectArtifactRef: ref(reviewDigest),
  verdict: 'repair',
  adjudicates: CL_RECORD.ref,
  relationVocabulary: ['reviews', 'derived_from', 'constrained_by', 'resolves', 'supports', 'enforces', 'produces'],
  relationships: [
    {
      fromId: 'FR-Define-Acceptance-Contract-002',
      fromRef: ref(reviewDigest),
      relation: 'reviews',
      toId: 'SR-Define-Acceptance-Contract-001',
      toRef: CAND.artifactRef,
      description: 'Adjudicating review of the acceptance-bindings artifact (verdict repair: CRIT-1, CRIT-2, MAJ-1)',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-002',
      fromRef: ref(reviewDigest),
      relation: 'reviews',
      toId: 'FS-Define-Acceptance-Contract-001',
      toRef: CAND.submissionRef,
      description: 'Adjudicating review of the author product submission',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-002',
      fromRef: ref(reviewDigest),
      relation: 'resolves',
      toId: 'CTN-Define-Acceptance-Contract-001',
      toRef: CL_RECORD.ref,
      description: 'Resolves the reviewer-verdict contention: emission A repair confirmed, emission B accepted superseded (evidence-backed adjudication)',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-002',
      fromRef: ref(reviewDigest),
      relation: 'derived_from',
      toId: 'VV-Define-Acceptance-Contract-002',
      toRef: ref(verificationDigest),
      description: 'The verdict rests on this emission\'s own verification record (checks C1-C10, nothing trusted by declaration)',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-002',
      fromRef: ref(reviewDigest),
      relation: 'enforces',
      toId: 'constraint:retention-1',
      toRef: 'sha256:807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be',
      description: 'Reviewer artifacts are deterministic: pinned timestamp, computed digests only',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-002',
      fromRef: ref(reviewDigest),
      relation: 'supports',
      toId: 'terminal:audited-1',
      toRef: 'sha256:4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f',
      description: 'This adjudicating desk audit is the audited-1 realization at the acceptance desk; the repair loop keeps the audit honest',
    },
    {
      fromId: 'FR-Define-Acceptance-Contract-002',
      fromRef: ref(reviewDigest),
      relation: 'supports',
      toId: 'terminal:delivered-1',
      toRef: 'sha256:8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988',
      description: 'The repair verdict holds the delivered terminal to its evidence standard: the chain reaches reconcile-what only over genuinely accepted revisions under authority that exists',
    },
  ],
  unknownCoverage: {
    unknownId: 'unknown:browser-matrix-1',
    digest: '38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf',
    disposition: 'carried_forward',
    owner: 'discovery',
    note: 'The review confirms the carried-forward disposition; neither the author nor the reviewer resolves or drops the unknown.',
  },
  terminalCoverage: {
    'terminal:audited-1': {
      digest: '4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f',
      supportedBy: ['FR-Define-Acceptance-Contract-002', 'ac:terminal-1-audited'],
    },
    'terminal:delivered-1': {
      digest: '8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988',
      supportedBy: ['FR-Define-Acceptance-Contract-002', 'ac:outcome-1-delivered'],
    },
  },
};

const traceDigest = sha(traceContent);

const trace = {
  traceRef: ref(traceDigest),
  traceKind: 'reviewer-verdict-trace',
  contentDigest: traceDigest,
  semanticCode: 'RT-Define-Acceptance-Contract-002',
  createdAt: PINNED,
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

/* ------------------------------------------------------------------ */
/* 4. Product submission (FS-...-003)                                  */
/* ------------------------------------------------------------------ */

const submissionContent = {
  deskRef: 'define-acceptance-contract',
  deskNodeId: 'define-acceptance-contract',
  role: 'reviewer',
  itemInstanceId: 'formalization-item:define-acceptance-contract',
  token: 'plan:formalization#item:acceptance-contract',
  verdict: 'repair',
  candidate: {
    kind: 'formalization.review-complete.v1',
    artifactRef: ref(reviewDigest),
    contentDigest: reviewDigest,
  },
  payloadContract: {
    productKind: 'formalization.review-complete.v1',
    effectId: 'formalization.accept-products',
    requiredEvidenceRefs: [
      'sha256:f3f98175f061fa289d49f4684f78273022c97b9e12bc535255c4b3d4c6a0534e',
      'sha256:03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21',
      'sha256:b15c35da54dd016492f397d71a59883d38cfb0c5e55aaa51f68c4d3f210d1909',
      'sha256:cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da',
      'sha256:6652762b7d8d26aacbaeb11f1b1e1529b26c2974ecf8ab0a01f0eb2b651d753b',
      'sha256:3d576e96e9c101b4b7187be8ce0d6f4542c161e8b8f9fa7323397329ac4e85b0',
      'sha256:807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be',
      'sha256:38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf',
      'sha256:4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f',
      'sha256:8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988',
      'sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837',
      ref(reviewDigest),
      ref(traceDigest),
      ref(verificationDigest),
      CL_RECORD.ref,
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
      'reviewer-collision-record': 1,
    },
    terminalOutcome: 'success',
  },
  reviewRef: ref(reviewDigest),
  traceRef: ref(traceDigest),
  verificationRef: ref(verificationDigest),
  reviewedCandidateRefs: {
    submissionRef: CAND.submissionRef,
    artifactRef: CAND.artifactRef,
    authorTraceRef: CAND.traceRef,
  },
  adjudication: {
    contentionId: 'CTN-Define-Acceptance-Contract-001',
    collisionRecordRef: CL_RECORD.ref,
    verdictOfRecord: 'repair',
    confirmed: EMISSION_A.review,
    superseded: EMISSION_B.review,
  },
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#define-acceptance-contract:reviewer',
    status: 'review_complete_verdict_recorded',
    receivedFrom: 'reviewer',
    nextStage: 'final-gate',
    note: 'Adjudicated verdict repair returned to the define-acceptance-contract author desk (CRIT-1 unaccepted lineage asserted accepted; CRIT-2 scope-2 exclusion ratified; MAJ-1 unresolvable governing-contract anchor). The reviewer-seat contention CTN-Define-Acceptance-Contract-001 is resolved: emission A repair confirmed, emission B accepted superseded; the final gate consumes this verdict.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Independent recomputation performed by this emission: verdict records read directly, capsule contents read directly, independent 261-file scans, mechanical verifier re-run (99/92/7, zero verdict diffs) — nothing trusted by declaration', satisfied: true },
    { id: 3, description: 'All 8 reviewer-envelope task-projection content addresses resolved; workspace projection 32892970... adjudicated UNRESOLVABLE', satisfied: true },
    { id: 4, description: 'Reviewer-seat contention adjudicated on evidence: repair confirmed, accepted superseded, both emissions preserved by content address, no contested filename touched', satisfied: true },
    { id: 5, description: 'Verdict recorded with findings, evidence, and required actions (CRIT-1, CRIT-2, MAJ-1, ADV-1..3; RA-1..RA-7)', satisfied: true },
    { id: 6, description: 'Reviewer artifacts deterministic: pinned timestamp, no clock reads, no randomness', satisfied: true },
    { id: 7, description: 'constraint:retention-1 honored across the reviewer artifacts', satisfied: true },
    { id: 8, description: 'unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true },
    { id: 9, description: 'Candidate\'s consumed upstream genuinely accepted', satisfied: false, note: 'CRIT-1 recorded honestly: three of four consumed links are repair-verdict or never-reviewed; verdict repair rather than blind acceptance' },
    { id: 10, description: 'No fabricated disposition ratified into the acceptance surface', satisfied: false, note: 'CRIT-2 recorded honestly: the candidate restates the prd:scope-2 exclusion as fact' },
    { id: 11, description: 'Governing contract evidence ref verified before inheritance', satisfied: false, note: 'MAJ-1 recorded honestly: the anchor fails independent recomputation (0/261 files); r2 RA-2/RA-4 debt remains open' },
  ],
};

const submissionDigest = sha(submissionContent);

const submission = {
  submissionRef: ref(submissionDigest),
  submissionId: 'FS-Define-Acceptance-Contract-003',
  contentDigest: submissionDigest,
  createdAt: PINNED,
  deskRef: 'define-acceptance-contract',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: submissionContent,
};

/* ------------------------------------------------------------------ */
/* Write + self-verify (re-read from disk, recompute every digest)     */
/* ------------------------------------------------------------------ */

const artifacts = [
  ['define-acceptance-contract-desk-reviewer-verification-emission-c.json', verification, (j) => j.contentDigest, (j) => sha(j.content)],
  ['define-acceptance-contract-desk-reviewer-review-emission-c.json', review, (j) => j.contentDigest, (j) => sha(j.content)],
  ['define-acceptance-contract-desk-reviewer-trace-emission-c.json', trace, (j) => j.contentDigest, (j) => sha(j.content)],
  ['define-acceptance-contract-desk-reviewer-product-submission-emission-c.json', submission, (j) => j.contentDigest, (j) => sha(j.content)],
];

for (const [name, obj] of artifacts) {
  writeFileSync(join(DIR, name), JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

const report = [];
let failures = 0;
for (const [name, obj, declaredOf, recomputedOf] of artifacts) {
  const back = JSON.parse(readFileSync(join(DIR, name), 'utf8'));
  const declared = declaredOf(back);
  const recomputed = recomputedOf(back);
  const ok = declared === recomputed && declared === obj.contentDigest;
  if (!ok) failures += 1;
  report.push({ file: name, declared, recomputed, ok });
}

console.log(JSON.stringify({
  emission: 'C',
  pinnedTimestamp: PINNED,
  selfCheck: failures === 0 ? 'all artifacts re-read from disk and re-seal' : 'DIGEST FAILURE',
  failures,
  artifacts: report,
  verdict: 'repair',
  adjudication: 'CTN-Define-Acceptance-Contract-001 resolved: emission A repair CONFIRMED, emission B accepted SUPERSEDED',
  refs: {
    verification: verification.contentDigest,
    review: review.contentDigest,
    trace: trace.contentDigest,
    submission: submission.contentDigest,
  },
}, null, 2));
