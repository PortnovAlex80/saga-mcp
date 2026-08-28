/**
 * define-product-intent desk (reviewer) - artifact authoring.
 *
 * Deterministic: pinned timestamp, no clock reads, no randomness.
 * Builds the four reviewer artifacts in dependency order, computing each
 * content digest over canonical JSON (recursively key-sorted, compact) and
 * interleaving the content addresses of already-built artifacts.
 *
 * Run: node define-product-intent-desk-reviewer-build.mjs
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
const IMP = 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5';
const IMP_TRC = '2e5bb8ce3f26de726729c107760d43d5c81350b1a412f5c504d95352a0ef8274';
const IMP_REV = 'cfc7b35a5d0b71586e24be6474c5add914ba5f303edbd8bc2789782fd34b4d7b';
const FS_AUTHOR = '91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0';
const ART = 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055';
const TRC_AUTHOR = '6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9';

const verifyRun = JSON.parse(readFileSync(join(DIR, 'verify-out.json'), 'utf8'));
const k2Row = (verifyRun.results || []).find((r) => r.id === 'K2.upstreamProjection.unresolvable');
const scanCount = k2Row ? (Number((String(k2Row.detail).match(/scanned (\d+) workspace files/) || [])[1]) || 0) : 0;

/* -------------------------------------------------------------- 1. VV */
const vvContent = {
  verificationId: 'VV-Define-Product-Intent-001',
  deskRef: 'define-product-intent',
  role: 'reviewer',
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; WP03 validation via the REAL kernel validator (src/workflow-kernel/workshops/formalization/contracts/validators/prd-intent-member.mjs)',
  subject: {
    submissionRef: shaRef(FS_AUTHOR),
    submissionId: 'FS-Define-Product-Intent-001',
    artifactRef: shaRef(ART),
    artifactSemanticCode: 'PRD-Define-Product-Intent-001',
    traceRef: shaRef(TRC_AUTHOR),
  },
  recomputedChecks: verifyRun.recomputed,
  passed: verifyRun.passed,
  failed: verifyRun.failed,
  groups: {
    selfAddress: 'A1-C3: submission/artifact/trace content digests + refs recomputed and cross-bound',
    memberSeals: 'D.*: 6/6 member seals recomputed AND sealed by the REAL kernel WP03 validator with the exact accepted id-set universe',
    envelopeCrossCheck: 'E.*: 8/8 reviewer task-projection content addresses transported in artifact.upstream and matching the envelope',
    capsuleChain: 'F.*: 9/9 capsule sub-artifact digests + capsule self-address recomputed from the accepted import artifact (ingress.ts factBody)',
    protocolVersion: 'G: capsule protocol pinned ek.discovery-handoff-capsule.ek8-wp11f.v1 on the import chain; product artifact/trace carry no own pin (advisory)',
    traceGraph: 'H1-H5: 12 relationships resolve against recomputed digests; memberCoverage/terminalCoverage/constraintCoverage/unknownCoverage equal the edge sets',
    payloadContract: 'I1-I3: 11 required evidence refs exact; kind coverage exact; import-desk authority chain (artifact/trace/accepted review) recomputed',
    governingContract: 'I4: FAILED - governing address unresolvable workspace-wide; six r1 claimant files recompute otherwise (digest drift)',
    parentStateAndPins: 'J1-J6: desk/node/item/token/kind/effect/contract pins; 6-member universe; disposition and coverage law; pinned timestamp',
    workspaceLaw: `K1-K3: 0 accepted upstream revisions consistent across the author artifact/submission/trace; envelope projection sha256:745cadc1... UNRESOLVABLE (${scanCount}-file workspace scan, K2 evidence detail); import authority bound by content address`,
    authorFlagsHonesty: 'L: author verification flags agree with independent recomputation; fence scan clean',
  },
  envelopePins: {
    protocolSkillRef: 'sha256:bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
    semanticSkillRef: 'sha256:2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
    taskProjectionContentAddresses: Object.fromEntries(Object.entries(ENVELOPE).map(([id, d]) => [id, shaRef(d)])),
    upstreamAcceptedProjection: {
      address: 'sha256:745cadc1131468039f167043c000fc0af170ed98764f545f22d867be36da1c35',
      envelopeClaim: '1 accepted upstream revisions travel by content address',
      adjudication: 'UNRESOLVABLE - upheld the author workspaceSummary of 0 (K2: 176 workspace files scanned; zero raw-byte and zero canonical-JSON hits; the address occurs only as quoted protocol metadata inside r1/r2 review documents; the r1 reviewer verdict was REJECTED, so no accepted define-product-intent revision can exist)',
    },
  },
  results: verifyRun.results,
};
const vvDigest = sha(vvContent);
const vv = {
  artifactRef: shaRef(vvDigest),
  artifactKind: 'reviewer-verification',
  contentDigest: vvDigest,
  semanticCode: 'VV-Define-Product-Intent-001',
  createdAt: PIN,
  deskRef: 'define-product-intent',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: vvContent,
};
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer-verification.json'), JSON.stringify(vv, null, 2) + '\n');

/* -------------------------------------------------------------- 2. FR */
const frContent = {
  reviewId: 'FR-Define-Product-Intent-001',
  deskRef: 'define-product-intent',
  role: 'reviewer',
  reviewedRound: 'stray-products-r2',
  reviewedCandidate: {
    submissionRef: shaRef(FS_AUTHOR),
    submissionId: 'FS-Define-Product-Intent-001',
    artifactRef: shaRef(ART),
    artifactSemanticCode: 'PRD-Define-Product-Intent-001',
    traceRef: shaRef(TRC_AUTHOR),
    productKind: 'frf-cell.product-intent.v1',
  },
  supersededCandidateObserved: {
    note: 'The candidate was replaced in place mid-review. The 00:48 revision (submission FS-Define-Product-Intent-002, artifact PI-Define-Product-Intent-001, trace) was superseded at 00:50 by the candidate of record reviewed here. The superseded revision travels by content address only through this review record.',
    submissionRef: 'sha256:580d66818347c173bb76d9c5dd7f4cd02c10c4004d4b06d7f690329451034c3b',
    artifactRef: 'sha256:cd687fde9ac0635538a61fe9ef8106b0a3d7d014e8d666e31f25fc5546cc97c2',
    artifactSemanticCode: 'PI-Define-Product-Intent-001',
    traceRef: 'sha256:d5002cb6f3415b3ab08c8abacde28effc9476878074d8c33566978ebd9db3d1d',
    processNote: 'Advisory ADV-4: candidates admitted for reviewer stage must not be overwritten; reissue under a monotonic submission id and record superseded addresses.',
  },
  verificationRef: shaRef(vvDigest),
  verificationSummary: {
    recomputedChecks: verifyRun.recomputed,
    passed: verifyRun.passed,
    failed: verifyRun.failed,
    trustedByDeclaration: false,
    failedCheckIds: verifyRun.results.filter((r) => !r.ok).map((r) => r.id),
  },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    note: 'All 8 envelope content addresses are transported inside artifact.upstream.verifiedSubArtifacts and match exactly (no silent drops, no digest drift on capsule material). The envelope upstream-accepted projection is adjudicated under workspaceAdjudication.',
  },
  capsuleVerification: {
    capsuleRef: shaRef(CAPSULE),
    selfAddressRecomputed: true,
    protocolVersion: 'ek.discovery-handoff-capsule.ek8-wp11f.v1',
    lineage: { lineageId: 'lineage:message-service-2026-08' },
    parentState: { status: 'discovery-terminal' },
    note: 'Re-verified at this desk from the accepted import artifact (9/9 sub-artifacts + factBody self-address recompute); the product binds the chain via upstream.importArtifactRef/capsuleRef/certificateRef.',
  },
  workspaceLaw: '0 accepted upstream revisions travel by content address',
  workspaceAdjudication: {
    envelopeProjection: '1 accepted upstream revisions travel by content address (upstream-accepted[0] sha256:745cadc1131468039f167043c000fc0af170ed98764f545f22d867be36da1c35 :: accepted revision of define-product-intent)',
    authorPosition: '0 accepted upstream revisions travel by content address (artifact, submission, trace consistent; verification.acceptedUpstreamRevisionsTravelingByContentAddress = 0)',
    scanEvidence: 'K2: 176 workspace files under qualification/ scanned - raw-bytes sha256 hits 0, canonical-JSON content hits 0, textual mentions 2 (quoted protocol metadata inside r1/r2 review documents only)',
    closure: 'The r1 reviewer verdict was REJECTED, so no accepted revision of define-product-intent exists; the projected address resolves to no content. AUTHOR POSITION UPHELD. This closes r1 CRIT-001/ACTION-001 (which demanded locating the referenced revision): located - nowhere. The envelope count is stale shell metadata, recorded for the shell owner.',
  },
  findings: {
    positiveFindings: [
      '63/64 independent recomputations pass; the candidate of record is content-integrity-clean: submission, artifact and trace self-addresses recompute; all 6 member seals recompute and are sealed by the REAL kernel WP03 validator with the exact accepted id-set universe (no FOREIGN_LINEAGE, no COVERAGE_GAP, no SCOPE_VIOLATION).',
      'All 8 reviewer-envelope task-projection content addresses travel inside the artifact and match exactly - the r1 CRIT-002/CRIT-003 failure modes (wrong claim digests, fabricated digests) are absent from the candidate.',
      'Trace graph resolves against recomputed digests: 12 relationships, memberCoverage/terminalCoverage/constraintCoverage/unknownCoverage equal the edge sets exactly; both terminal lifecycle claims are owned by exactly one member each with supports edges; the unknown is carried forward (owner discovery), never resolved.',
      'Upstream continuity: the accepted import chain (artifact b10bb762..., trace 2e5bb8ce..., accepted review cfc7b35a...) recomputes and the product binds it by content address; capsule self-address re-verifies from the imported facts.',
      'Determinism honored: pinned timestamp 2026-08-28T00:00:00Z across submission/artifact/trace; no clock reads or randomness in any desk artifact; the reviewer round is deterministic by construction (this review included).',
      'Workspace law: author 0-count upheld against the envelope projection by a workspace-wide resolvability scan - the honest adjudication r1 ACTION-001 demanded.',
    ],
    advisoryNotes: [
      {
        type: 'fail_closed_anchoring_undocumented',
        note: 'ADV-1. prd:unknown-1 cites claim:constraint-1 as its accepted source lineage and prd:constraint-1 quotes the constraint:retention-1 text verbatim under the SC-3 (claim:constraint-1) lineage. Both are fail-closed resolution devices (WP03 requires every member to cite accepted source claims; the unknown/constraint items are not source claims), and the true digests travel intact via unknownCoverage/constraintCoverage. But this revision dropped the explanatory notes the superseded revision carried, and the trace description asserts the anchor as derivation ("The carried unknown is anchored to accepted Discovery source claim 3"). Restore explicit anchoring notes so provenance devices are not mistaken for derivation.',
      },
      {
        type: 'protocol_pin_absent',
        note: 'ADV-2. The product artifact and trace carry no protocolVersion pin; the capsule protocol binds only transitively via upstream.importArtifactRef. Restore the explicit pin for belt-and-braces protocol hygiene.',
      },
      {
        type: 'import_authority_chain_partial',
        note: 'ADV-3. The candidate records upstream.importArtifactRef/capsuleRef/certificateRef but omits the accepted import review (cfc7b35a..., verdict accepted) and the import trace (2e5bb8ce...) from its authority record and evidence set. The shell-stage material authority is an ACCEPTED review chain, not just an artifact; record all three refs.',
      },
      {
        type: 'mid_review_candidate_replacement',
        note: 'ADV-4. The admitted candidate was overwritten in place during review (00:48 revision superseded at 00:50; submission id sequence moved backwards, 002 then 001). Content addressing was never broken (both revisions self-verify as observed), but desk process hygiene requires monotonic reissue with superseded addresses recorded. Recorded in supersededCandidateObserved.',
      },
    ],
    criticalIssues: [
      {
        issueId: 'CRIT-1',
        severity: 'CRITICAL',
        category: 'fabricated_disposition_authority',
        title: 'prd:scope-2 out_of_scope disposition cites a Discovery decision that does not exist in the accepted material',
        description: 'Member prd:scope-2 (memberKind scope-exclusion, disposition out_of_scope, owner product-owner) states that accepted Discovery source claim 2 is "explicitly dispositioned out of scope at intent freeze ... by the Discovery decision recorded in the capsule". The accepted capsule material for claim:scope-2 (SC-2, digest cb291aa7...) is exactly {claimId, statement: "Accepted discovery source claim 2 of the message service subject."} - no decision, no release boundary, no exclusion. The certificate records a subject-level go decision only. The cited authority is fabricated; the WP03 validator cannot see it because refs resolve and the disposition is in the closed vocabulary. Net effect: accepted Discovery scope material is silently removed from the intent surface (no scenario route will ever exercise claim:scope-2) under an invented upstream justification. This is the r1 finding family (content states that do not exist being asserted) resurfacing at the semantic layer after the digest layer was cleaned.',
        evidence: [
          'Capsule SC-2 content (recomputed, digest cb291aa7e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da): bare claim statement, no decision.',
          'Capsule certificate CERT-1 (03972527...): {kind, decision: "go", subject: "message service"} - subject-level, not a scope-2 exclusion.',
          'Member prd:scope-2 disposition.reason and statement attribute the exclusion to "the Discovery decision recorded in the capsule".',
          'Check D.prd:scope-2 passes mechanically (wp03=sealed) - the kernel surface cannot catch semantic fabrication, which is precisely the desk-review authority.',
        ],
        violatedPrinciples: ['CON-1 content-address provenance honesty', 'D10 never silently resolve or drop accepted material', 'TC-2 intent material must carry accepted content until a real disposition authority exists', 'conveyor rule: material authority travels by content, never by invented narrative'],
        impact: 'Downstream desks inherit an intent surface missing accepted scope material and a provenance lie about who decided it. Any scenario model built on this intent will not cover claim:scope-2 and will cite a Discovery decision that cannot be produced.',
      },
    ],
    majorIssues: [
      {
        issueId: 'MAJ-1',
        severity: 'MAJOR',
        category: 'unresolvable_governing_contract_anchor',
        title: 'governingContractRef sha256:a926df62... resolves to no content anywhere in the round workspace',
        description: 'The candidate binds governingContractRef sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837 and lists it in requiredEvidenceRefs (architecture-contract kind). Workspace-wide recomputation finds no content - raw bytes, whole-JSON canonical, or .content canonical - hashing to that address in r1 or r2. Six r1 files DECLARE the address and all six recompute to different digests (f4846e5f..., b880d0b7..., d041cb56..., 87aeab3f... twice, 0f06d0bc...) - the r1 CRIT-003 digest-drift family survives intact in the contract layer and propagates into every r2 desk that binds the anchor, including the accepted import review, whose positive finding "governingContractRef ... resolves to the r1-round desk contract material" was itself not recomputation-backed and is false as stated.',
        evidence: [
          'Check I4: UNRESOLVED - claimant files declare a926df62... but recompute otherwise (full list in verification results I4).',
          'The r1 reviewer decision (REJECTED) already demanded recomputation of all artifact digests (ACTION-003); the contract artifacts were never re-sealed.',
        ],
        violatedPrinciples: ['CON-1 content-address transport', 'TC-1 acceptance criterion 1 (artifacts content-addressed with correct digests)', 'r1 ACTION-003 remediation debt'],
        impact: 'The round governing-contract continuity anchor is decorative: it cannot be resolved to content by any downstream consumer. Acceptance would ratify an evidence ref that fails at the first independent recomputation.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed desk artifacts with SHA256 digests over canonical JSON', satisfied: true, evidence: 'A1-C3: submission/artifact/trace self-addresses recomputed and bound' },
    { id: 2, description: 'All members validate against frf-contracts.prd-intent-member.v1 (REAL kernel WP03 validator)', satisfied: true, evidence: 'D.*: 6/6 sealed with the exact accepted id-set universe; D1 seal universe exact' },
    { id: 3, description: 'All four accepted source claims realized or explicitly dispositioned BY AUTHORITY THAT EXISTS', satisfied: false, evidence: 'J5 passes mechanically, but prd:scope-2 out_of_scope rests on a Discovery decision absent from the capsule (CRIT-1)' },
    { id: 4, description: 'Exactly one closed-vocabulary disposition per member; owner+reason where required', satisfied: true, evidence: 'J4: scenario_required x3, direct_requirement +reason, out_of_scope owner+reason, deferred owner+reason' },
    { id: 5, description: 'Desk fence: no final acceptance/acceptanceCriteria/fr/nfr/requirements/rule/scenarios/srs/useCases content', satisfied: true, evidence: 'L2 scan + WP03 FORBIDDEN_KEYS surface clean' },
    { id: 6, description: 'Both terminal lifecycle claims owned by PRD intent members', satisfied: true, evidence: 'H3: terminal:audited-1 -> prd:terminal-1, terminal:delivered-1 -> prd:outcome-1, supports edges exact' },
    { id: 7, description: 'constraint:retention-1 honored: deterministic authoring', satisfied: true, evidence: 'J6 pinned timestamp; H5 constraint coverage exact; reviewer round deterministic' },
    { id: 8, description: 'unknown:browser-matrix-1 carried forward with owner discovery; no fabricated resolution edge', satisfied: true, evidence: 'H4: carried_forward, owner discovery, zero resolution edges' },
    { id: 9, description: 'Trace relationships resolve against recomputed digests; coverages equal the edge sets', satisfied: true, evidence: 'H1-H5: 12/12 relationships, member/terminal/constraint/unknown coverage exact' },
    { id: 10, description: '0 accepted upstream revisions travel by content address', satisfied: true, evidence: 'K1/K2: consistent 0-count upheld; envelope 745cadc1... projection adjudicated UNRESOLVABLE (workspaceAdjudication)' },
    { id: 11, description: 'Governing contract evidence ref resolves to recomputable content', satisfied: false, evidence: 'I4 FAILED: a926df62... unresolvable workspace-wide; six r1 claimants recompute otherwise (MAJ-1)' },
  ],
  verdict: 'repair',
  verdictVocabulary: ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'],
  finalGate: {
    gateVerdict: 'repair',
    providerId: 'reviewer-verdict',
    issues: ['CRIT-1', 'MAJ-1'],
  },
  requiredActions: [
    {
      actionId: 'RA-1',
      priority: 'CRITICAL',
      owner: 'define-product-intent desk (author)',
      description: 'Restore claim:scope-2 as carried accepted boundary material',
      details: 'Reissue prd:scope-2 as a system-boundary member with disposition scenario_required (the superseded 00:48 revision already did this correctly), or - only if Discovery genuinely records a new decision - cite that decision\'s content address. The capsule as accepted contains no exclusion decision; any out_of_scope disposition of accepted scope material is unsupported until such an address exists.',
    },
    {
      actionId: 'RA-2',
      priority: 'MAJOR',
      owner: 'architecture-contract desk + all r2 desks binding the anchor',
      description: 'Re-seal the contract layer so the governing address resolves',
      details: 'Re-seal the architecture-contract artifacts (and the contract-desk artifacts that declare a926df62...) so their contentDigest equals sha256(canonical(content)); then update governingContractRef across r2 desk artifacts and resubmit evidence sets. Until then every binding of a926df62... is an evidence ref that fails independent recomputation.',
    },
    {
      actionId: 'RA-3',
      priority: 'MINOR',
      owner: 'define-product-intent desk (author)',
      description: 'Restore fail-closed anchoring notes',
      details: 'Document (as the superseded revision did) that unknown/constraint members cite accepted source claims as fail-closed resolution devices while the true item digests travel via unknownCoverage/constraintCoverage; reword the trace description so the anchoring is not presented as derivation.',
    },
    {
      actionId: 'RA-4',
      priority: 'MINOR',
      owner: 'define-product-intent desk (author)',
      description: 'Restore protocol pin and full import authority chain',
      details: 'Pin protocolVersion ek.discovery-handoff-capsule.ek8-wp11f.v1 on the product artifact and trace; add importTraceRef (2e5bb8ce...) and reviewRef (cfc7b35a..., verdict accepted) beside upstream.importArtifactRef.',
    },
    {
      actionId: 'RA-5',
      priority: 'PROCESS',
      owner: 'driver / desk tooling',
      description: 'No in-place replacement of admitted candidates',
      details: 'A candidate admitted for reviewer stage must be immutable at its content address on disk; revisions reissue under a monotonic submission id with superseded addresses recorded. The 00:48 -> 00:50 in-place overwrite (FS-...-002 -> FS-...-001) is recorded here as the precedent to prevent.',
    },
  ],
  evidenceReferences: [
    shaRef(FS_AUTHOR), shaRef(ART), shaRef(TRC_AUTHOR),
    shaRef(CAPSULE), shaRef(CERT),
    ...Object.values(ENVELOPE).map(shaRef),
    shaRef(GOV), shaRef(IMP), shaRef(IMP_TRC), shaRef(IMP_REV),
    shaRef(vvDigest),
  ],
  conclusion: 'The candidate of record (PRD-Define-Product-Intent-001, sha256:a06dbc57...) is content-integrity-clean at the digest layer - 63/64 recomputations pass, all six members are sealed by the REAL kernel WP03 validator, the trace resolves, the capsule chain re-verifies, and the workspace-law adjudication upholds the author where r1 could not. It is nonetheless returned as repair on two grounds the kernel cannot see: (CRIT-1) the out_of_scope disposition of accepted scope material claim:scope-2 cites a Discovery decision that does not exist in the accepted capsule - a semantic fabrication that would silently remove accepted material from the intent surface; (MAJ-1) the governing-contract continuity anchor sha256:a926df62... resolves to no content in the round workspace, the surviving r1 CRIT-003 digest-drift family in the contract layer. Repair per RA-1..RA-5 and resubmit; the intent desk may not settle until the intent surface carries every accepted source claim under authority that exists.',
};
const frDigest = sha(frContent);
const fr = {
  artifactRef: shaRef(frDigest),
  artifactKind: 'formalization-review',
  contentDigest: frDigest,
  semanticCode: 'FR-Define-Product-Intent-001',
  createdAt: PIN,
  deskRef: 'define-product-intent',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: frContent,
};
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer-review.json'), JSON.stringify(fr, null, 2) + '\n');

/* -------------------------------------------------------------- 3. RT */
const rtContent = {
  traceId: 'RT-Define-Product-Intent-001',
  deskRef: 'define-product-intent',
  role: 'reviewer',
  traceKind: 'reviewer-verdict-trace',
  subjectSemanticCode: 'FR-Define-Product-Intent-001',
  subjectArtifactRef: shaRef(frDigest),
  verdict: 'repair',
  relationVocabulary: ['reviews', 'derived_from', 'constrained_by', 'resolves', 'supports', 'enforces', 'produces'],
  relationships: [
    {
      fromId: 'FR-Define-Product-Intent-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'PRD-Define-Product-Intent-001',
      toRef: shaRef(ART),
      description: 'Independent reviewer verification of the product-intent artifact (verdict repair: CRIT-1, MAJ-1)',
    },
    {
      fromId: 'FR-Define-Product-Intent-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'FS-Define-Product-Intent-001',
      toRef: shaRef(FS_AUTHOR),
      description: 'Independent reviewer verification of the author product submission',
    },
    {
      fromId: 'FR-Define-Product-Intent-001',
      fromRef: shaRef(frDigest),
      relation: 'reviews',
      toId: 'author-trace:define-product-intent',
      toRef: shaRef(TRC_AUTHOR),
      description: 'Reviewer verification of the author trace graph (12/12 relationships resolve)',
    },
    {
      fromId: 'FR-Define-Product-Intent-001',
      fromRef: shaRef(frDigest),
      relation: 'enforces',
      toId: 'constraint:retention-1',
      toRef: shaRef(ENVELOPE['constraint:retention-1']),
      description: 'Reviewer artifacts are deterministic: pinned timestamp, computed digests only',
    },
    {
      fromId: 'FR-Define-Product-Intent-001',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:audited-1',
      toRef: shaRef(ENVELOPE['terminal:audited-1']),
      description: 'This independent desk audit (64 recomputations, REAL WP03 validator) is the audited-1 realization at the intent desk; the repair loop keeps the audit honest',
    },
    {
      fromId: 'FR-Define-Product-Intent-001',
      fromRef: shaRef(frDigest),
      relation: 'supports',
      toId: 'terminal:delivered-1',
      toRef: shaRef(ENVELOPE['terminal:delivered-1']),
      description: 'The repair verdict holds the delivered terminal to its evidence standard: delivery intent settles only when the intent surface carries every accepted source claim under authority that exists (RA-1) and the governing anchor resolves (RA-2)',
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
      supportedBy: ['FR-Define-Product-Intent-001', 'prd:terminal-1'],
    },
    'terminal:delivered-1': {
      digest: ENVELOPE['terminal:delivered-1'],
      supportedBy: ['FR-Define-Product-Intent-001', 'prd:outcome-1'],
    },
  },
};
const rtDigest = sha(rtContent);
const rt = {
  traceRef: shaRef(rtDigest),
  traceKind: 'reviewer-verdict-trace',
  contentDigest: rtDigest,
  createdAt: PIN,
  deskRef: 'define-product-intent',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: rtContent,
};
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer-trace.json'), JSON.stringify(rt, null, 2) + '\n');

/* -------------------------------------------------------------- 4. FS */
const fsContent = {
  deskRef: 'define-product-intent',
  deskNodeId: 'define-product-intent',
  role: 'reviewer',
  itemInstanceId: 'formalization-item:define-product-intent',
  token: 'plan:formalization#item:product-intent',
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
    receiptRef: 'evidence:DeskIntakeReceipt#define-product-intent:reviewer',
    status: 'review_complete_verdict_recorded',
    receivedFrom: 'reviewer',
    nextStage: 'final-gate',
    note: 'Verdict repair returned to the define-product-intent author desk (CRIT-1 scope-2 fabricated disposition authority; MAJ-1 unresolvable governing-contract anchor). The final gate consumes the reviewer verdict per the driver contract.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Independent recomputation performed: 64 checks, nothing trusted by declaration, REAL kernel WP03 validator executed', satisfied: true },
    { id: 3, description: 'All 8 reviewer-envelope task-projection content addresses resolved; workspace projection 745cadc1... adjudicated UNRESOLVABLE (author 0 upheld)', satisfied: true },
    { id: 4, description: 'Verdict recorded with findings, evidence, and required actions (CRIT-1, MAJ-1, ADV-1..4; RA-1..RA-5)', satisfied: true },
    { id: 5, description: 'Reviewer artifacts deterministic: pinned timestamp, no clock reads, no randomness', satisfied: true },
    { id: 6, description: 'constraint:retention-1 honored across author and reviewer artifacts', satisfied: true },
    { id: 7, description: 'unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true },
    { id: 8, description: 'Superseded mid-review candidate recorded by content address (provenance honesty)', satisfied: true },
    { id: 9, description: 'Governing contract evidence ref verified before inheritance', satisfied: false, note: 'MAJ-1 recorded honestly: the anchor fails independent recomputation workspace-wide; verdict repair rather than blind acceptance of the inherited ref' },
    { id: 10, description: '0 accepted upstream revisions travel by content address', satisfied: true },
  ],
};
const fsDigest = sha(fsContent);
const fsArt = {
  submissionRef: shaRef(fsDigest),
  submissionId: 'FS-Define-Product-Intent-003',
  contentDigest: fsDigest,
  createdAt: PIN,
  deskRef: 'define-product-intent',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: fsContent,
};
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer-product-submission.json'), JSON.stringify(fsArt, null, 2) + '\n');

/* -------------------------------------------------------------- 5. MD */
const md = `# define-product-intent desk (reviewer) - r2 review record

Round: stray-products-r2 · reviewed candidate of record: PRD-Define-Product-Intent-001
(\`sha256:${ART}\`, submission FS-Define-Product-Intent-001 \`sha256:${FS_AUTHOR}\`,
trace \`sha256:${TRC_AUTHOR}\`) · verdict: **repair**

## What was independently verified (nothing trusted by declaration)

- **64 recomputations** (\`define-product-intent-desk-reviewer-verify.mjs\`), rule
  \`sha256(canonicalJson)\` per \`src/workflow-kernel/domain/digest.ts\`:
  **63 pass / 1 fails**. Full evidence:
  \`define-product-intent-desk-reviewer-verification.json\` (VV-Define-Product-Intent-001,
  \`sha256:${vvDigest}\`).
- All **6 member seals** recompute **and** are sealed by the **real kernel WP03 validator**
  (\`contracts/validators/prd-intent-member.mjs\`) with the exact accepted id-set universe.
- The candidate transports all **8 reviewer-envelope content addresses** and they match exactly.
- The capsule chain re-verifies from the accepted import artifact (9/9 sub-artifacts +
  factBody self-address); the import-desk authority (artifact \`sha256:${IMP}\`,
  trace \`sha256:${IMP_TRC}\`, accepted review \`sha256:${IMP_REV}\`) recomputes.
- Trace graph: 12/12 relationships resolve; member/terminal/constraint/unknown coverages
  equal the edge sets; both terminals owned exactly once; unknown carried forward (owner
  discovery), never resolved.

## Workspace-law adjudication (closes r1 CRIT-001/ACTION-001)

The reviewer frame projects **"1 accepted upstream revision"** (\`sha256:745cadc1...\`).
Verdict: **UNRESOLVABLE - author 0 upheld.** K2 scanned 176 workspace files: zero raw-byte
hits, zero canonical-JSON hits; the address occurs only as quoted protocol metadata inside
review documents. The r1 verdict was REJECTED, so no accepted define-product-intent revision
can exist. The r1 formalization was wrong on digest grounds; this r2 author is right.

## Why repair (not accepted)

| id | severity | finding |
|----|----------|---------|
| CRIT-1 | CRITICAL | \`prd:scope-2\` \`out_of_scope\` cites "the Discovery decision recorded in the capsule" - **no such decision exists** in the accepted capsule (SC-2 \`cb291aa7...\` is a bare claim; CERT-1 is a subject-level go). Accepted scope material silently removed from the intent surface under a fabricated authority. The WP03 validator cannot see it (refs resolve, closed vocabulary) - this is desk-review territory. |
| MAJ-1 | MAJOR | \`governingContractRef\` \`sha256:${GOV}\` **resolves to no content** workspace-wide; six r1 files declare it and all recompute to different digests (r1 CRIT-003 digest-drift family alive in the contract layer; also falsifies the accepted import review's "resolves" positive finding, which was never recomputation-backed). |
| ADV-1..4 | advisory | Undocumented fail-closed anchoring devices; absent protocol pin; partial import authority chain; mid-review in-place candidate replacement (00:48 → 00:50, id sequence 002→001) recorded in the review. |

Required actions RA-1..RA-5 are in the review artifact
(FR-Define-Product-Intent-001, \`sha256:${frDigest}\`); the headline pair:
**RA-1** reissue \`prd:scope-2\` as a carried system-boundary (\`scenario_required\`) or cite a
genuinely recorded Discovery decision address; **RA-2** re-seal the contract layer so the
governing address resolves, then update it across r2.

## Reviewer artifact index (all content-addressed, deterministic)

| artifact | kind | address |
|----------|------|---------|
| verification | reviewer-verification | \`sha256:${vvDigest}\` |
| review | formalization-review | \`sha256:${frDigest}\` |
| trace | reviewer-verdict-trace | \`sha256:${rtDigest}\` |
| submission | FS-Define-Product-Intent-003 | \`sha256:${fsDigest}\` |

Pinned timestamp ${PIN} across all reviewer artifacts; sha256 over canonical JSON
(recursively key-sorted, compact) everywhere.
`;
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer-submission-summary.md'), md);

console.log(JSON.stringify({
  built: ['verification', 'review', 'trace', 'submission'],
  verification: shaRef(vvDigest),
  review: shaRef(frDigest),
  trace: shaRef(rtDigest),
  submission: shaRef(fsDigest),
}, null, 2));
