/**
 * derive-system-requirements desk (reviewer) - artifact authoring (r2).
 *
 * Deterministic: pinned timestamp, no clock reads, no randomness.
 * Builds the five reviewer artifacts in dependency order, computing each
 * content digest over canonical JSON (recursively key-sorted, compact)
 * and interleaving the content addresses of already-built artifacts.
 * Verdict evidence comes from the independent verification run
 * (derive-system-requirements-desk-reviewer-verify-out.json, 80 checks).
 *
 * Run: node derive-system-requirements-desk-reviewer-build.mjs
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

const verifyRun = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-reviewer-verify-out.json'), 'utf8'));

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
const CAPSULE = 'f3f98175f061fa289d49f4684f78273022c97b9e12bc535255c4b3d4c6a0534e';
const CERT = '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21';
const GOV = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const IMPORT = 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5';
const IMP_REV = 'cfc7b35a5d0b71586e24be6474c5add914ba5f303edbd8bc2789782fd34b4d7b';
const SR_ART = '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df';
const SR_TRC = 'fd0b0b1f7470cd7825a0c83082b96b503ef3dabdcf70a92369050418a8706e26';
const SR_SUB = '05e713efdd1847bf18fc21ed335a981db1963020417e0a2078eef62fe2e824aa';
const PRD_ART = 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055';
const UC_ART = '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b';
const INTENT_REV_A = 'e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4';
const INTENT_REV_B = '6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc';
const INTENT_REV_2 = '0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc';
const CR3 = '6d0dc6a2c3671d24513e3c7269d0f5a8cf9e45a926051b1c2053e8d490575bd5';
const UC_HOLD = '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7';
const ENVELOPE_ACCEPTED = '65fe9a225a4425880513ae5321cce4d9b75c44e88fb3054f5e7f997b6956ee66';
const SCAN_NOTE = '213 files under qualification/ scanned (raw-bytes, canonical-JSON and .content bodies)';

/* -------------------------------------------------------------- 1. VV */
const vvContent = {
  verificationId: 'VV-Derive-System-Requirements-001',
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  rule: verifyRun.rule,
  subject: {
    submissionRef: shaRef(SR_SUB),
    submissionId: 'FS-Derive-System-Requirements-001',
    artifactRef: shaRef(SR_ART),
    artifactSemanticCode: 'SR-Derive-System-Requirements-001',
    traceRef: shaRef(SR_TRC),
  },
  recomputedChecks: verifyRun.recomputed,
  passed: verifyRun.passed,
  failed: verifyRun.failed,
  failedCheckIds: verifyRun.failedCheckIds,
  groups: {
    selfAddress: 'A1-A3: author artifact content digest + ref + kind pins recomputed and bound',
    upstreamFolds: 'B1-B6: 6/6 PRD member seals + 3/3 UC scenario seals recomputed through the REAL kernel WP03 validators; both revisions re-folded by the REAL cell folds (prd a30229a7…, uc 184981e5…); upstream authority refs and 8/8 envelope addresses bind the real r2 artifacts',
    productAndWp03: 'C1-C7: fence clean, closed FR/NFR vocabulary, 4/4 requirement seals recomputed, bundle pins exact, universe derived by the REAL deriveAcceptedUniverse, bundle SEALED by the REAL validateRequirementsBundle (sha256:60083eb4a2ba553d0924c9b9ffe12ad9e703f9adc2f7da6bd5584a1747620690)',
    coverageAndLineage: 'D1-D5: 3/3 scenario coverage, branch lineage resolves, no foreign intent, prd:scope-2 and the unknown derive nothing (mechanical layer)',
    dispositions: 'E1-E3: constraint honored, unknown carried (owner discovery), pinned timestamps on all three author artifacts',
    traceGraph: 'G1-H4: 13/13 relationships resolve against recomputed digests; requirement/PRD-member/terminal/constraint coverage blocks are exact projections of the edge set; 0 edges touch the unknown',
    payloadContract: 'I1-I6: submission self-address + candidate binding, 18 evidence refs exact, kind coverage, intake receipt recorded as driver-executed attestation',
    gateProbes: 'K1-K6: REAL provider + REAL seam binder re-bound; author-stage cell gate re-runs to accepted; negative probes confirm refusals (foreign lineage -> upstream-repair, stale pin -> repair, scope violation -> terminal-reject)',
    acceptanceStatusAudit: 'M1-M7 (desk-review authority): ALL intent reviewer emissions carry verdict repair (FR-001 canonical e49d8d11…, emission-b 6c9c8324… whose deviating "accepted" was withdrawn by its own author, FR-002 04632094…; collision records CR-001..003); no adjudication/settlement record exists; the UC desk authored against its own hold (UH-Model-Use-Cases-001, contention-open) and never passed a reviewer stage; the cited audit evidence recomputes',
    governingContract: `N1: UNRESOLVABLE - ${SCAN_NOTE}; 0 raw, 0 canonical, 0 content hits; 71 stray-products files declare the address textually and recompute otherwise (r1 CRIT-003 digest-drift family; FR-Define-Product-Intent-001/002 MAJ-1 RA-2 still open)`,
    envelopeAdjudication: `O1-O2: upstream-accepted[0] sha256:${ENVELOPE_ACCEPTED} :: "accepted revision of derive-system-requirements" - UNRESOLVABLE (${SCAN_NOTE}; the single textual mention is this verification's own evidence record). This is the desk's FIRST reviewer stage: no prior reviewer verdict exists and the final gate never ran, so no accepted revision of derive-system-requirements can exist.`,
  },
  envelopePins: {
    protocolSkillRef: 'sha256:bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
    semanticSkillRef: 'sha256:2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
    taskProjectionContentAddresses: Object.fromEntries(Object.entries(ENVELOPE).map(([id, d]) => [id, shaRef(d)])),
    upstreamAcceptedProjection: {
      address: shaRef(ENVELOPE_ACCEPTED),
      envelopeClaim: '1 accepted upstream revisions travel by content address',
      adjudication: 'UNRESOLVABLE - author 0 upheld at the desk layer; stale shell metadata (same family as the define-product-intent projection sha256:745cadc1…), recorded for the shell owner. The candidate-under-review is admitted_for_reviewer_stage, not accepted.',
    },
  },
  results: verifyRun.results,
};
const vvDigest = sha(vvContent);
const vv = {
  artifactRef: shaRef(vvDigest),
  artifactKind: 'reviewer-verification',
  contentDigest: vvDigest,
  semanticCode: 'VV-Derive-System-Requirements-001',
  createdAt: PIN,
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: vvContent,
};
writeFileSync(join(DIR, 'derive-system-requirements-desk-reviewer-verification.json'), JSON.stringify(vv, null, 2) + '\n');

/* -------------------------------------------------------------- 2. FR */
const frContent = {
  reviewId: 'FR-Derive-System-Requirements-001',
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  reviewedRound: 'stray-products-r2',
  reviewedCandidate: {
    submissionRef: shaRef(SR_SUB),
    submissionId: 'FS-Derive-System-Requirements-001',
    artifactRef: shaRef(SR_ART),
    artifactSemanticCode: 'SR-Derive-System-Requirements-001',
    traceRef: shaRef(SR_TRC),
    productKind: 'formalization.system-requirements.v1',
  },
  verificationRef: shaRef(vvDigest),
  verificationSummary: {
    recomputedChecks: verifyRun.recomputed,
    passed: verifyRun.passed,
    failed: verifyRun.failed,
    trustedByDeclaration: false,
    failedCheckIds: verifyRun.failedCheckIds,
  },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    note: 'All 8 envelope content addresses are transported inside artifact.upstream.verifiedSubArtifacts and match exactly (no silent drops, no digest drift on capsule material). The envelope upstream-accepted projection is adjudicated under workspaceAdjudication.',
  },
  upstreamAcceptanceAudit: {
    authority: 'desk-review layer: the WP03 validators and cell folds consume whatever set they are handed; whether that set is ACCEPTED upstream material is exactly what the kernel cannot see and this review must',
    intentDesk: 'candidate of record a06dbc57… carries verdict REPAIR across every reviewer emission (FR-Define-Product-Intent-001 canonical e49d8d11…, emission-b 6c9c8324… - its deviating "accepted" verdict was withdrawn by its own author per CR-001..003, verdictOfRecord repair, FR-Define-Product-Intent-002 04632094…); no driver/human adjudication record exists in the round; contention is OPEN',
    useCasesDesk: 'the scenarios bundle 24f0aff2… was authored in violation of the desk\'s own hold (UH-Model-Use-Cases-001: hold-no-authoring, upstreamSettleState contention-open, TypedWait:human-input, obligation requeueAfterHumanResolution) and has NEVER passed a reviewer stage (no reviewer artifacts exist)',
    candidateClaims: 'upstream.materialAuthority asserts "the accepted define-product-intent bundle and the accepted model-use-cases scenario bundle"; verification.revisionPinsMatchAcceptedRevisions = true; evidence kinds accepted-prd-intent-bundle / accepted-uc-scenarios-bundle / accepted-intent-trace / accepted-intent-submission / accepted-uc-trace / accepted-uc-submission',
    adjudication: 'ALL FALSE. No accepted revision of define-product-intent exists (verdict repair, contention-open). No accepted revision of model-use-cases exists (never reviewed). The pins are byte-exact to UNACCEPTED revisions. This is the fabricated cross-desk lineage class UH-Model-Use-Cases-001 itself warned about: "Authoring scenarios from the unsettled candidate would fabricate cross-desk lineage (the stray-product class this round exists to catch)."',
  },
  workspaceAdjudication: {
    envelopeProjection: `1 accepted upstream revisions travel by content address (upstream-accepted[0] ${shaRef(ENVELOPE_ACCEPTED)} :: accepted revision of derive-system-requirements)`,
    authorPosition: '0 accepted upstream revisions travel by content address (artifact, trace, submission consistent; verification.acceptedUpstreamRevisionsTravelingByContentAddress = 0)',
    scanEvidence: `O1: ${SCAN_NOTE} - raw hits 0, canonical hits 0, content hits 0; the single textual mention is this verification's own evidence record`,
    closure: 'UNRESOLVABLE - author 0 upheld at the desk layer. This is the derive-system-requirements desk\'s FIRST reviewer stage: no prior reviewer verdict exists and the final gate never ran, so no accepted revision of derive-system-requirements can exist. Stale shell metadata, recorded for the shell owner (same family as sha256:745cadc1…).',
  },
  findings: {
    positiveFindings: [
      '77/80 independent recomputations pass; the candidate is content-integrity-clean at the digest layer: author trio self-addresses recompute; all 4 requirement seals recompute and the bundle is SEALED by the REAL kernel WP03 validator (validateRequirementsBundle, seal sha256:60083eb4a2ba553d0924c9b9ffe12ad9e703f9adc2f7da6bd5584a1747620690) against the universe derived by the REAL deriveAcceptedUniverse.',
      'Both upstream folds re-derive independently through the REAL validators + REAL cell folds (prd revision a30229a7…, uc revision 184981e5…) and the bundle pins match exactly - the pins are honest to the material they bind; what fails is the material\'s acceptance status, not the pin math.',
      'Trace graph resolves against recomputed digests: 13/13 relationships, requirement/PRD-member/terminal/constraint coverage blocks equal the edge sets exactly; 0 edges touch the carried unknown.',
      'All 8 reviewer-envelope task-projection content addresses travel inside the artifact and match exactly - no digest drift on capsule material (the r1 CRIT-002/CRIT-003 failure modes are absent from the candidate at the digest layer).',
      'The REAL cell gate re-runs to accepted with the declared provider and the fail-closed seam binder, and the negative probes confirm it refuses (foreign lineage -> upstream-repair, stale pin -> repair, scope violation -> terminal-reject): the author-stage gate is real, not rubber-stamped.',
      'UC coverage law holds mechanically: 3/3 scenarios produce obligations; every cited terminal branch resolves inside its owning scenario; the unknown is never cited.',
    ],
    advisoryNotes: [
      {
        type: 'kernel_submission_attestation',
        note: 'ADV-1. The kernel-side product submission (product_submit against the workflow kernel) is driver-executed over public commands; the desk intake receipt records desk-level intake only. Attestation, not desk-level re-verification - same treatment as the import review\'s package-bytes advisory.',
      },
      {
        type: 'verification_surfaces_are_pins',
        note: 'ADV-2. surface:test-suite-1 / surface:monitoring-1 / surface:audit-1 are desk-authored pins (law L2 surface set, deskInput). They route obligations; they are not realized suites. The acceptance-contract desk must realize them; until then "verification surface" means an unfulfilled routing promise.',
      },
      {
        type: 'terminal_wording_template_quirk',
        note: 'ADV-3. fr:terminal-1 restates the terminal:audited-1 template wording ("triaged go with recorded strengths") inherited from the capsule terminals - the TC-2 wording quirk already flagged to the discovery owner in the import review. Forwarded again; content addresses honest.',
      },
      {
        type: 'envelope_projection_stale',
        note: 'ADV-4. The envelope upstream-accepted projection (65fe9a22…, count 1) is stale shell metadata - UNRESOLVABLE workspace-wide; author 0 upheld. Textual-mention counts for such addresses grow as review documents quote them (the 745cadc1… precedent); shell owner should refresh projections per stage.',
      },
      {
        type: 'namespace_single_seat',
        note: 'ADV-5. The intent-desk reviewer namespace suffered double/triple emission collisions (CR-001..003). Single-seat enforcement belongs to the driver (carries FR-Define-Product-Intent-002 RA-5). This desk\'s reviewer namespace was single-writer.',
      },
    ],
    criticalIssues: [
      {
        issueId: 'CRIT-1',
        severity: 'CRITICAL',
        category: 'fabricated_upstream_acceptance_status',
        title: 'The candidate derives its entire requirement surface from revisions that are NOT accepted, while asserting they are',
        description: 'The candidate\'s material authority, verification flags and evidence kinds assert accepted define-product-intent and model-use-cases revisions. Both assertions are false at the process layer: the intent candidate of record (a06dbc57…) carries verdict repair across every reviewer emission with contention open and no adjudication record; the UC scenarios bundle (24f0aff2…) was authored in violation of its own desk\'s hold and has never passed a reviewer stage. The revision pins are byte-exact to UNACCEPTED revisions; revisionPinsMatchAcceptedRevisions=true is therefore false; the workspaceSummary "0 accepted upstream revisions" and the materialAuthority "the accepted … bundle(s) … traveling by content address" are self-contradictory - both cannot be true. The requirements surface (fr:boundary-1, fr:outcome-1, fr:terminal-1, nfr:determinism-1) inherits its entire derivation lineage from this fabricated acceptance. Mechanical checks (B/C/D layers) all pass because the kernel consumes the set it is handed; acceptance status is desk-review authority (M layer).',
        evidence: [
          'M1: all three intent review emissions carry verdict repair (e49d8d11…, 6c9c8324…, 04632094…); collision records CR-001..003 record verdictOfRecord repair.',
          'M2: no driver/human adjudication or settlement record exists anywhere in stray-products-r2.',
          'M3: UH-Model-Use-Cases-001 (hold-no-authoring, contention-open, TypedWait:human-input) vs the existing model-use-cases-desk-uc-scenarios artifacts; zero model-use-cases reviewer artifacts.',
          'M4: materialAuthority / revisionPinsMatchAcceptedRevisions / accepted-* evidence kinds - all assert acceptance that does not exist.',
          'M6: workspaceSummary 0-count vs materialAuthority "accepted" - internal contradiction.',
        ],
        violatedPrinciples: ['CON-1 content-address provenance honesty', 'ADR-053: material authority is the ACCEPTED revision, traveling by content address', 'D10 never assert authority that does not exist', 'conveyor rule: a desk consumes accepted upstream revisions or holds - it never renames a contended candidate into acceptance'],
        impact: 'Every downstream consumer (acceptance contract, architecture, SRS, handoff) would inherit a requirements surface whose entire lineage rests on review-contended and never-reviewed material. The final gate, if fed this candidate on the strength of the mechanical layers alone, would settle fabricated lineage into the shell stage.',
      },
      {
        issueId: 'CRIT-2',
        severity: 'CRITICAL',
        category: 'inherited_fabricated_disposition',
        title: 'The candidate ratifies the prd:scope-2 exclusion whose authority both intent reviews established as nonexistent',
        description: 'The candidate brief restates "The out-of-scope intent member prd:scope-2 … derive[s] no requirement" and acceptance self-check 8 asserts "prd:scope-2 (out_of_scope at intent freeze) derives no requirement: satisfied". Recomputed capsule material: SC-2 (cb291aa7…) is exactly {claimId, statement} - a bare claim, no decision; CERT-1 (03972527…) is a subject-level go. No Discovery exclusion decision exists (CRIT-1 of FR-Define-Product-Intent-001 and FR-Define-Product-Intent-002). Keeping zero derivation edges from prd:scope-2 is defensible while its disposition is contested; restating the exclusion as settled fact is not. The requirements desk converts the upstream fabrication into its own accepted-criteria claim.',
        evidence: [
          'M5: SC-2 recomputed bare; CERT-1 subject-level go; brief + self-check 8 restate the exclusion.',
          'D4 passes mechanically (no requirement cites prd:scope-2) - the kernel surface cannot see the authority question.',
        ],
        violatedPrinciples: ['D10 never silently resolve or drop accepted material', 'TC-2 accepted material carries until a real disposition authority exists', 'CON-1 provenance honesty'],
        impact: 'claim:scope-2 stays silently removed from the intent AND requirements surfaces under an invented upstream justification; no scenario route and no requirement will ever exercise it, and the exclusion now travels under two desks\' authority instead of one.',
      },
    ],
    majorIssues: [
      {
        issueId: 'MAJ-1',
        severity: 'MAJOR',
        category: 'unresolvable_governing_contract_anchor',
        title: 'governingContractRef sha256:a926df62… resolves to no content anywhere in the round workspace',
        description: `The candidate binds governingContractRef ${shaRef(GOV)} and lists it in requiredEvidenceRefs (architecture-contract kind). Workspace-wide recomputation finds no content - raw bytes, whole-JSON canonical, or .content canonical - hashing to that address (${SCAN_NOTE}). Seventy-one stray-products files declare the address textually and recompute otherwise - the r1 CRIT-003 digest-drift family in the contract layer, carried through FR-Define-Product-Intent-001/002 MAJ-1 whose RA-2 remains open. This desk bound the anchor anyway.`,
        evidence: [
          'N1: UNRESOLVABLE - 0 raw, 0 canonical, 0 content hits across 213 files; 71 textual claimants.',
          'The intent reviews already demanded re-sealing (RA-2); the contract layer was never re-sealed.',
        ],
        violatedPrinciples: ['CON-1 content-address transport', 'TC-1 acceptance criterion 1 (artifacts content-addressed with correct digests)', 'r1 ACTION-003 / FR-002 RA-2 remediation debt'],
        impact: 'The governing-contract continuity anchor is decorative: it cannot be resolved to content by any downstream consumer. Acceptance would ratify an evidence ref that fails at the first independent recomputation.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed desk artifacts with SHA256 digests over canonical JSON', satisfied: true, evidence: 'A1-A3, G1-G2, I1-I3: author trio self-addresses recomputed and bound' },
    { id: 2, description: 'Bundle sealed by the REAL kernel WP03 validator against the REAL derived universe', satisfied: true, evidence: 'C5-C7: universe via deriveAcceptedUniverse; seal sha256:60083eb4… matches the self-address' },
    { id: 3, description: 'Law L1 exact lineage: exact upstream member/scenario/branch/constraint identities', satisfied: true, evidence: 'B1-B6, D2-D3: seals recompute through the REAL validators; folds re-derive; no foreign lineage' },
    { id: 4, description: 'UC coverage law: every scenario produces at least one obligation', satisfied: true, evidence: 'D1: 3/3 scenarios covered' },
    { id: 5, description: 'Law L2 verification surfaces resolvable inside the desk surface set', satisfied: true, evidence: 'C5 + K3: surfaces resolvable in the derived universe; ADV-2 records they are pins, not realized suites' },
    { id: 6, description: 'Law L3 revision pins bind ACCEPTED upstream revisions', satisfied: false, evidence: 'M4: pins are byte-exact to UNACCEPTED revisions - intent verdict repair (contention-open), UC never reviewed; revisionPinsMatchAcceptedRevisions=true is false (CRIT-1)' },
    { id: 7, description: 'Desk fence: no forbidden artifact family in the candidate', satisfied: true, evidence: 'C1 + K6: fence scan clean; scope-violation probe terminal-reject' },
    { id: 8, description: 'constraint honored, unknown carried, deterministic authoring', satisfied: true, evidence: 'E1-E3: honored / carried_forward owner discovery / pinned timestamps' },
    { id: 9, description: 'Trace relationships resolve; coverage blocks equal the edge sets', satisfied: true, evidence: 'G1-H4: 13/13 relationships; exact projections; 0 unknown edges' },
    { id: 10, description: 'prd:scope-2 disposition restated only by authority that exists', satisfied: false, evidence: 'M5: SC-2 bare claim, CERT-1 subject-level go - no exclusion decision exists; brief + self-check 8 restate it as fact (CRIT-2)' },
    { id: 11, description: 'Governing contract evidence ref resolves to recomputable content', satisfied: false, evidence: 'N1: a926df62… unresolvable workspace-wide; 71 claimants recompute otherwise (MAJ-1)' },
    { id: 12, description: 'Workspace-law statement internally consistent', satisfied: false, evidence: 'M6: "0 accepted upstream revisions" vs materialAuthority "the accepted … bundle" - contradiction (CRIT-1)' },
  ],
  verdict: 'repair',
  verdictVocabulary: ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'],
  verdictRationale: 'repair rather than upstream-repair because the candidate\'s own artifacts make the false acceptance claims (materialAuthority wording, revisionPinsMatchAcceptedRevisions flag, accepted-* evidence kinds, self-check 8): the author desk could and should have held like UH-Model-Use-Cases-001 did. The upstream defects are real and are routed explicitly (RA-2, RA-3), but the candidate is not a faithful transport of accepted material - it is a faithful transport of UNACCEPTED material mislabeled as accepted.',
  finalGate: {
    gateVerdict: 'repair',
    providerId: 'reviewer-verdict',
    issues: ['CRIT-1', 'CRIT-2', 'MAJ-1'],
  },
  requiredActions: [
    {
      actionId: 'RA-1',
      priority: 'CRITICAL',
      owner: 'derive-system-requirements desk (author)',
      description: 'Reissue against genuinely accepted revisions only - or hold until they exist',
      details: 'Until the intent desk settles and the UC bundle passes its reviewer stage, either hold authoring (the UH-Model-Use-Cases-001 pattern) or reissue with honest contention status: materialAuthority must name content addresses WITHOUT the word "accepted"; revisionPinsMatchAcceptedRevisions must be removed or false; accepted-* evidence kinds must be renamed (upstream-candidate-*); the brief and self-checks must not restate the prd:scope-2 exclusion as fact; keep zero derivation edges from prd:scope-2 and record it as upstream-contested carried material.',
    },
    {
      actionId: 'RA-2',
      priority: 'CRITICAL',
      owner: 'define-product-intent desk (author) + driver/human adjudication',
      description: 'Settle the intent contention, then restore claim:scope-2',
      details: 'Execute FR-Define-Product-Intent-001/002 RA-1: reissue prd:scope-2 as carried system-boundary material (scenario_required) or cite a genuinely recorded Discovery decision content address (none exists today). Settlement requires the driver/human adjudication UH-Model-Use-Cases-001 is waiting on (workplace.resolveHumanResponse).',
    },
    {
      actionId: 'RA-3',
      priority: 'MAJOR',
      owner: 'model-use-cases desk + driver',
      description: 'Reconcile the UC hold violation and give the UC bundle a reviewer stage',
      details: 'Either record the adjudication that released UH-Model-Use-Cases-001 (none exists in r2) or withdraw/supersede the scenarios bundle and reauthor after the intent settles; then run the model-use-cases reviewer stage. No downstream desk may consume the UC bundle until it carries an accepted review.',
    },
    {
      actionId: 'RA-4',
      priority: 'MAJOR',
      owner: 'architecture-contract desk + all r2 desks binding the anchor',
      description: 'Re-seal the contract layer so the governing address resolves',
      details: 'Re-seal the architecture-contract artifacts so their contentDigest equals sha256(canonical(content)); update governingContractRef across r2 evidence sets. Carries FR-Define-Product-Intent-001/002 RA-2, still open.',
    },
    {
      actionId: 'RA-5',
      priority: 'PROCESS',
      owner: 'driver / shell',
      description: 'Single-seat desk namespaces; refresh envelope projections',
      details: 'Enforce single-writer desk namespaces (CR-001..003 precedent); envelope upstream-accepted projections (745cadc1…, 65fe9a22…) are stale shell metadata - regenerate per stage or mark as informational.',
    },
  ],
  evidenceReferences: [
    shaRef(SR_ART), shaRef(SR_TRC), shaRef(SR_SUB),
    shaRef(PRD_ART), shaRef(UC_ART),
    shaRef(CAPSULE), shaRef(CERT), shaRef(IMPORT), shaRef(IMP_REV),
    ...Object.values(ENVELOPE).map(shaRef),
    shaRef(GOV),
    shaRef(INTENT_REV_A), shaRef(INTENT_REV_B), shaRef(INTENT_REV_2), shaRef(CR3), shaRef(UC_HOLD),
    shaRef(vvDigest),
  ],
  conclusion: 'The candidate of record (SR-Derive-System-Requirements-001, sha256:86b00569…) is content-integrity-clean at the digest layer - 77/80 recomputations pass, the bundle is sealed by the REAL kernel WP03 validator over the REAL derived universe, both upstream folds re-derive through the REAL validators and cell folds, the trace resolves, the author-stage gate is real, and the workspace projection is honestly adjudicated (author 0 upheld). It is nonetheless returned as repair on grounds the kernel cannot see: (CRIT-1) the entire requirement surface derives from revisions that are NOT accepted - the intent candidate of record carries verdict repair with contention open, the UC bundle was authored against its own desk\'s hold and never reviewed - while the candidate asserts "accepted" material authority, revisionPinsMatchAcceptedRevisions=true and accepted-* evidence kinds, contradicting its own 0-count workspace law; (CRIT-2) the candidate ratifies the prd:scope-2 exclusion whose fabricated authority both intent reviews already established; (MAJ-1) the governing-contract anchor sha256:a926df62… resolves to no content workspace-wide. Repair per RA-1..RA-5: this desk holds or reissues against genuinely accepted revisions; the intent desk settles under adjudication and restores claim:scope-2; the UC desk reconciles its hold and passes review; the contract layer re-seals. The requirements desk may not settle until its lineage is accepted material under authority that exists.',
};
const frDigest = sha(frContent);
const fr = {
  artifactRef: shaRef(frDigest),
  artifactKind: 'formalization-review',
  contentDigest: frDigest,
  semanticCode: 'FR-Derive-System-Requirements-001',
  createdAt: PIN,
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: frContent,
};
writeFileSync(join(DIR, 'derive-system-requirements-desk-reviewer-review.json'), JSON.stringify(fr, null, 2) + '\n');

/* -------------------------------------------------------------- 3. RT */
const rtContent = {
  traceId: 'RT-Derive-System-Requirements-001',
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  traceKind: 'reviewer-verdict-trace',
  subjectSemanticCode: 'FR-Derive-System-Requirements-001',
  subjectArtifactRef: shaRef(frDigest),
  verdict: 'repair',
  relationVocabulary: ['reviews', 'derived_from', 'constrained_by', 'resolves', 'supports', 'enforces', 'produces'],
  relationships: [
    {
      fromId: 'FR-Derive-System-Requirements-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'SR-Derive-System-Requirements-001',
      toRef: shaRef(SR_ART),
      description: 'Independent reviewer verification of the system-requirements artifact (verdict repair: CRIT-1, CRIT-2, MAJ-1)',
    },
    {
      fromId: 'FR-Derive-System-Requirements-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'FS-Derive-System-Requirements-001',
      toRef: shaRef(SR_SUB),
      description: 'Independent reviewer verification of the author product submission',
    },
    {
      fromId: 'FR-Derive-System-Requirements-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'author-trace:derive-system-requirements',
      toRef: shaRef(SR_TRC),
      description: 'Reviewer verification of the author trace graph (13/13 relationships resolve)',
    },
    {
      fromId: 'FR-Derive-System-Requirements-001',
      fromRef: shaRef(frDigest),
      relation: 'enforces',
      toId: 'constraint:retention-1',
      toRef: shaRef(ENVELOPE['constraint:retention-1']),
      description: 'Reviewer artifacts are deterministic: pinned timestamp, computed digests only',
    },
    {
      fromId: 'FR-Derive-System-Requirements-001',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:audited-1',
      toRef: shaRef(ENVELOPE['terminal:audited-1']),
      description: 'This independent desk audit (80 recomputations, REAL WP03 validator + acceptance-status audit) is the audited-1 realization at the requirements desk; the repair loop keeps the audit honest',
    },
    {
      fromId: 'FR-Derive-System-Requirements-001',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:delivered-1',
      toRef: shaRef(ENVELOPE['terminal:delivered-1']),
      description: 'The repair verdict holds the delivered terminal to its evidence standard: requirements settle only when their entire lineage is accepted material under authority that exists (RA-1..RA-4)',
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
      supportedBy: ['FR-Derive-System-Requirements-001', 'fr:terminal-1'],
    },
    'terminal:delivered-1': {
      digest: ENVELOPE['terminal:delivered-1'],
      supportedBy: ['FR-Derive-System-Requirements-001', 'fr:outcome-1'],
    },
  },
};
const rtDigest = sha(rtContent);
const rt = {
  traceRef: shaRef(rtDigest),
  traceKind: 'reviewer-verdict-trace',
  contentDigest: rtDigest,
  createdAt: PIN,
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: rtContent,
};
writeFileSync(join(DIR, 'derive-system-requirements-desk-reviewer-trace.json'), JSON.stringify(rt, null, 2) + '\n');

/* -------------------------------------------------------------- 4. FS */
const fsContent = {
  deskRef: 'derive-system-requirements',
  deskNodeId: 'derive-system-requirements',
  role: 'reviewer',
  itemInstanceId: 'formalization-item:derive-system-requirements',
  token: 'plan:formalization#item:system-requirements',
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
      shaRef(CAPSULE), shaRef(CERT), shaRef(IMPORT), shaRef(IMP_REV),
      ...Object.values(ENVELOPE).map(shaRef),
      shaRef(GOV),
      shaRef(SR_ART), shaRef(SR_TRC), shaRef(SR_SUB),
      shaRef(PRD_ART), shaRef(UC_ART),
      shaRef(INTENT_REV_A), shaRef(INTENT_REV_2), shaRef(CR3), shaRef(UC_HOLD),
      shaRef(frDigest), shaRef(rtDigest), shaRef(vvDigest),
    ],
    evidenceKindCoverage: {
      'discovery-handoff-capsule': 1,
      'discovery-certificate': 1,
      'discovery-import-artifact': 1,
      'accepted-import-review': 1,
      'source-claim': 4,
      constraint: 1,
      unknown: 1,
      'terminal-claim': 2,
      'architecture-contract': 1,
      'system-requirements-artifact': 1,
      'system-requirements-trace': 1,
      'system-requirements-submission': 1,
      'intent-candidate-artifact': 1,
      'uc-candidate-artifact': 1,
      'intent-review-repair': 3,
      'collision-record': 1,
      'upstream-hold-artifact': 1,
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
    submissionRef: shaRef(SR_SUB),
    artifactRef: shaRef(SR_ART),
    authorTraceRef: shaRef(SR_TRC),
  },
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#derive-system-requirements:reviewer',
    status: 'review_complete_verdict_recorded',
    receivedFrom: 'reviewer',
    nextStage: 'final-gate',
    note: 'Verdict repair returned to the derive-system-requirements author desk (CRIT-1 fabricated upstream acceptance status; CRIT-2 inherited prd:scope-2 exclusion; MAJ-1 unresolvable governing-contract anchor). Upstream repair routed: RA-2 to define-product-intent (under driver/human adjudication), RA-3 to model-use-cases. The final gate consumes the reviewer verdict per the driver contract.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Independent recomputation performed: 80 checks, nothing trusted by declaration, REAL kernel WP03 validator + cell folds + gate executed', satisfied: true },
    { id: 3, description: 'All 8 reviewer-envelope task-projection content addresses resolved; workspace projection 65fe9a22… adjudicated UNRESOLVABLE (author 0 upheld)', satisfied: true },
    { id: 4, description: 'Verdict recorded with findings, evidence, and required actions (CRIT-1, CRIT-2, MAJ-1, ADV-1..5; RA-1..RA-5)', satisfied: true },
    { id: 5, description: 'Reviewer artifacts deterministic: pinned timestamp, no clock reads, no randomness', satisfied: true },
    { id: 6, description: 'constraint:retention-1 honored across author and reviewer artifacts', satisfied: true },
    { id: 7, description: 'unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true },
    { id: 8, description: 'Candidate acceptance-status claims verified against the round\'s review records', satisfied: false, note: 'CRIT-1 recorded honestly: the "accepted" claims are false (intent verdict repair, contention-open; UC never reviewed); verdict repair rather than blind acceptance of the pins\' byte-exactness' },
    { id: 9, description: 'Governing contract evidence ref verified before inheritance', satisfied: false, note: 'MAJ-1 recorded honestly: the anchor fails independent recomputation workspace-wide (213-file scan)' },
    { id: 10, description: 'Reviewer artifacts stay inside desk-artifact write authority (candidate-read, product-read, product-submit)', satisfied: true },
  ],
  workspaceSummary: '0 accepted upstream revisions travel by content address',
};
const fsDigest = sha(fsContent);
const fsArt = {
  submissionRef: shaRef(fsDigest),
  submissionId: 'FS-Derive-System-Requirements-002',
  contentDigest: fsDigest,
  createdAt: PIN,
  deskRef: 'derive-system-requirements',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: fsContent,
};
writeFileSync(join(DIR, 'derive-system-requirements-desk-reviewer-product-submission.json'), JSON.stringify(fsArt, null, 2) + '\n');

/* -------------------------------------------------------------- 5. MD */
const md = `# derive-system-requirements desk (reviewer) — r2 review record

Round: stray-products-r2 · reviewed candidate of record: SR-Derive-System-Requirements-001
(\`sha256:${SR_ART}\`, submission FS-Derive-System-Requirements-001 \`sha256:${SR_SUB}\`,
trace \`sha256:${SR_TRC}\`) · verdict: **repair**

## What was independently verified (nothing trusted by declaration)

- **80 recomputations** (\`derive-system-requirements-desk-reviewer-verify.mjs\`), rule
  \`sha256(canonicalJson)\` per \`src/workflow-kernel/domain/digest.ts\`:
  **77 pass / 3 fail**. Full evidence:
  \`derive-system-requirements-desk-reviewer-verification.json\` (VV-Derive-System-Requirements-001,
  \`sha256:${vvDigest}\`).
- The candidate is **content-integrity-clean at the digest layer**: the author trio
  self-addresses recompute; all **4 requirement seals** recompute and the bundle is
  **SEALED by the real kernel WP03 validator** (\`validateRequirementsBundle\`, seal
  \`sha256:60083eb4…\`) against the universe derived by the **real** \`deriveAcceptedUniverse\`.
- Both upstream folds **re-derive independently** through the real validators + real cell
  folds (prd \`a30229a7…\`, uc \`184981e5…\`) — the pins are byte-exact to the material they bind.
- Trace graph: 13/13 relationships resolve; requirement/PRD-member/terminal/constraint
  coverage blocks equal the edge sets; 0 edges touch the carried unknown.
- The real cell gate re-runs to **accepted** and the negative probes confirm it refuses
  (foreign lineage → upstream-repair, stale pin → repair, scope violation → terminal-reject).
- All **8 reviewer-envelope content addresses** travel inside the artifact and match exactly.

## Workspace-law adjudication

The reviewer frame projects **"1 accepted upstream revision"** (\`${shaRef(ENVELOPE_ACCEPTED)}\`).
Verdict: **UNRESOLVABLE — author 0 upheld at the desk layer.** 213 workspace files scanned:
zero raw-byte, zero canonical-JSON, zero \`.content\` hits (the single textual mention is the
verification evidence itself). This is the desk's **first** reviewer stage — no prior reviewer
verdict exists and the final gate never ran, so no accepted revision of
derive-system-requirements can exist. Stale shell metadata (same family as \`745cadc1…\`),
recorded for the shell owner.

## Why repair (not accepted, not upstream-repair)

The kernel cannot see acceptance status: the WP03 validators and cell folds consume whatever
set they are handed. Whether that set is **accepted** material is desk-review authority —
and it fails:

| id | severity | finding |
|----|----------|---------|
| CRIT-1 | CRITICAL | **Fabricated upstream acceptance status.** \`materialAuthority\` asserts "the accepted define-product-intent bundle and the accepted model-use-cases scenario bundle"; \`revisionPinsMatchAcceptedRevisions=true\`; evidence kinds \`accepted-*\`. All false: the intent candidate of record (\`${PRD_ART.slice(0, 8)}…\`) carries verdict **repair** across every reviewer emission (\`e49d8d11…\`, \`6c9c8324…\` — its deviating "accepted" was withdrawn by its own author — \`04632094…\`; CR-001..003 verdictOfRecord repair) with **no adjudication record in the round**; the UC bundle (\`${UC_ART.slice(0, 8)}…\`) was authored **in violation of its own desk's hold** (UH-Model-Use-Cases-001: contention-open, hold-no-authoring) and has **never passed a reviewer stage**. The pins are byte-exact to UNACCEPTED revisions — and the author trio contradicts itself ("0 accepted upstream revisions" vs "the accepted … bundle"). The exact stray-product class the UC hold warned about, one desk further down. |
| CRIT-2 | CRITICAL | **Inherited fabricated disposition.** The brief and self-check 8 restate "prd:scope-2 out_of_scope at intent freeze" as fact. Recomputed capsule material: SC-2 (\`cb291aa7…\`) is a bare claim; CERT-1 (\`03972527…\`) is a subject-level go — **no exclusion decision exists** (CRIT-1 of both intent reviews). Zero derivation edges from prd:scope-2 are defensible while contested; ratifying the exclusion as settled is not. |
| MAJ-1 | MAJOR | \`governingContractRef\` \`${shaRef(GOV)}\` **resolves to no content** workspace-wide (213-file scan; 71 textual claimants recompute otherwise — the r1 CRIT-003 digest-drift family; FR-002 RA-2 still open). This desk bound the anchor anyway. |
| ADV-1..5 | advisory | Kernel submission is driver-executed (attestation); verification surfaces are desk-authored pins, not realized suites; terminal wording template quirk (discovery owner); stale envelope projections; single-seat namespace enforcement (driver). |

Not \`upstream-repair\` because the false claims live in **this candidate's own artifacts** — the
author desk could and should have held (the UH-Model-Use-Cases-001 pattern) instead of renaming
contended material into acceptance. Upstream defects are routed explicitly: RA-2 →
define-product-intent, RA-3 → model-use-cases.

## Required actions (RA-1..RA-5 in FR-Derive-System-Requirements-001, \`sha256:${frDigest}\`)

1. **RA-1 (CRITICAL, this desk's author):** hold, or reissue against genuinely accepted
   revisions with honest contention status (no "accepted" wording, no \`accepted-*\` evidence
   kinds, \`revisionPinsMatchAcceptedRevisions\` false, scope-2 recorded as upstream-contested).
2. **RA-2 (CRITICAL, define-product-intent):** settle under driver/human adjudication
   (\`workplace.resolveHumanResponse\`), then restore claim:scope-2 as carried boundary material
   or cite a genuinely recorded decision address.
3. **RA-3 (MAJOR, model-use-cases + driver):** reconcile the hold violation (record the
   adjudication or withdraw/supersede the bundle) and run the UC reviewer stage.
4. **RA-4 (MAJOR, contract layer):** re-seal so \`${shaRef(GOV)}\` resolves; update it across r2.
5. **RA-5 (PROCESS, driver/shell):** single-seat namespaces; refresh envelope projections.

## Reviewer artifact index (all content-addressed, deterministic)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification | \`sha256:${vvDigest}\` |
| review | formalization-review | \`sha256:${frDigest}\` |
| trace | reviewer-verdict-trace | \`sha256:${rtDigest}\` |
| submission | FS-Derive-System-Requirements-002 | \`sha256:${fsDigest}\` |
| reproducible verifier | — | \`derive-system-requirements-desk-reviewer-verify.mjs\` (plain \`node\`, no deps) |

Pinned timestamp ${PIN} across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere. Verifier evidence:
\`derive-system-requirements-desk-reviewer-verify-out.json\` (80 checks, 77 pass / 3 fail).
`;
writeFileSync(join(DIR, 'derive-system-requirements-desk-reviewer-submission-summary.md'), md);

console.log(JSON.stringify({
  built: ['verification', 'review', 'trace', 'submission', 'summary'],
  verification: shaRef(vvDigest),
  review: shaRef(frDigest),
  trace: shaRef(rtDigest),
  submission: shaRef(fsDigest),
}, null, 2));
