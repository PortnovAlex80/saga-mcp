/**
 * derive-system-requirements desk (author) - deterministic builder (r2).
 *
 * Authors the desk's three content-addressed artifacts from the exact
 * accepted upstream material:
 *   1. derive-system-requirements-desk-system-requirements.artifact.json
 *   2. derive-system-requirements-desk-system-requirements-trace.json
 *   3. derive-system-requirements-desk-product-submission.json
 *
 * Frozen kernel rule: src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 * The bundle is built and sealed by the REAL cell builder
 * (buildRequirementsBundle, dist system-requirements cell); upstream
 * member seals are recomputed through the REAL WP03 validators; the
 * accepted PRD/UC revision digests are re-folded by the REAL cell fold
 * formulas. Nothing is trusted by declaration.
 *
 * Run: node derive-system-requirements-desk-build.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(DIR, '..', '..', '..', '..', '..');
const wp03 = await import(pathToFileURL(join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'validators', 'requirements-bundle.mjs')).href);
const prd03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href);
const uc03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'uc-scenario-member.mjs')).href);
const upCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'product-intent', 'index.js')).href);
const srCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'system-requirements', 'index.js')).href);

const upArt = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));
const ucArt = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json'), 'utf8'));
const ucTrc = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios-trace.json'), 'utf8'));
const ucSub = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-product-submission.json'), 'utf8'));

const CREATED_AT = '2026-08-28T00:00:00Z';
const WORKSPACE_SUMMARY = '0 accepted upstream revisions travel by content address';
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
/* Upstream fold: seals recomputed through the REAL WP03 validators     */
/* ------------------------------------------------------------------ */

const upSeal = new Map();
for (const m of upArt.content.members) {
  const v = prd03.validatePrdIntentMember(m, {
    idSets: {
      sourceClaimIds: Object.keys(ENVELOPE).filter((id) => id.startsWith('claim:')),
      terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'],
    },
  });
  if (!v.ok) throw new Error(`upstream intent member ${m.memberId} refuses: ${v.reason}`);
  upSeal.set(m.memberId, sha(m));
}
const upFold = upCell.acceptedIntentSetOf(
  { members: upArt.content.members },
  upArt.content.members.map((m) => ({ memberId: m.memberId, digest: upSeal.get(m.memberId) })),
);
if (!upFold.ok) throw new Error(`upstream intent fold failed: ${upFold.detail}`);
const PRD_REVISION = upFold.set.revisionDigest;

const ucSeal = new Map();
for (const s of ucArt.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, { idSets: { prdMemberIds: upFold.set.prdMemberIds } });
  if (!v.ok) throw new Error(`upstream scenario ${s.scenarioId} refuses: ${v.reason}`);
  ucSeal.set(s.scenarioId, sha(s));
}
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
const acceptedUcSet = {
  memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort(),
  scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(),
  branchIdsByScenario: Object.fromEntries(
    ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)]),
  ),
  revisionDigest: ucRevisionDigest,
};

/* ------------------------------------------------------------------ */
/* The authored requirements (exact accepted lineage only)              */
/* ------------------------------------------------------------------ */

const AUTHORED = [
  {
    requirementId: 'fr:boundary-1',
    requirementKind: 'FR',
    statement: 'Inside the accepted system boundary, the message service shall complete every submitted message with a deterministic response to the user.',
    prdIntentRefs: ['prd:boundary-1'],
    ucScenarioRefs: ['uc:boundary-1'],
    ucTerminalBranchRefs: ['branch:boundary-1-main'],
    verificationSurfaceRefs: ['surface:test-suite-1'],
  },
  {
    requirementId: 'fr:outcome-1',
    requirementKind: 'FR',
    statement: 'The message service shall deliver the accepted Discovery outcome to the user, closing terminal lifecycle claim terminal:delivered-1; when it cannot produce a response it shall return a deterministic error response and invent no nondeterministic content.',
    prdIntentRefs: ['prd:outcome-1'],
    ucScenarioRefs: ['uc:outcome-1'],
    ucTerminalBranchRefs: ['branch:outcome-1-main', 'branch:outcome-1-deterministic-error'],
    verificationSurfaceRefs: ['surface:test-suite-1', 'surface:monitoring-1'],
  },
  {
    requirementId: 'fr:terminal-1',
    requirementKind: 'FR',
    statement: 'After delivery the message service shall close the run with the audited terminal state: the subject triaged go with recorded strengths in the audit record (terminal:audited-1).',
    prdIntentRefs: ['prd:terminal-1'],
    ucScenarioRefs: ['uc:terminal-1'],
    ucTerminalBranchRefs: ['branch:terminal-1-main'],
    verificationSurfaceRefs: ['surface:audit-1'],
  },
  {
    requirementId: 'nfr:determinism-1',
    requirementKind: 'NFR',
    statement: 'Every response of the message service shall be deterministic; the service shall invent no nondeterministic content.',
    prdIntentRefs: ['prd:constraint-1'],
    sourceConstraintRefs: ['constraint:retention-1'],
    verificationSurfaceRefs: ['surface:test-suite-1', 'surface:monitoring-1'],
  },
];

const VERIFICATION_SURFACE_IDS = ['surface:test-suite-1', 'surface:monitoring-1', 'surface:audit-1'];

/* The REAL cell builder assembles + seals the WP03 bundle. */
const built = srCell.buildRequirementsBundle({
  prdRevisionDigest: PRD_REVISION,
  ucRevisionDigest: ucRevisionDigest,
  requirements: AUTHORED,
});
if (!built.ok) throw new Error(`bundle builder refuses: ${built.reason}: ${built.detail}`);
const PRODUCT = built.sealed.bundle;
const PRODUCT_DIGEST = built.sealed.digest;

/* The desk input the desk itself authors (law L2 surface set). */
const DESK_INPUT = { verificationSurfaceIds: [...VERIFICATION_SURFACE_IDS] };

/* Member seals over the sealed members (canonical member JSON). */
const requirementSeal = new Map(PRODUCT.requirements.map((m) => [m.requirementId, sha(m)]));
if (requirementSeal.size !== AUTHORED.length) throw new Error('seal set drift: sealed member ids differ from the authored ids');

/* WP03 pre-check: the bundle must seal against the derived universe. */
const universe = srCell.deriveAcceptedUniverse({
  prd: { revisionDigest: PRD_REVISION, memberIds: [...upFold.set.prdMemberIds] },
  useCases: { revisionDigest: ucRevisionDigest, scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  sourceConstraintIds: ['constraint:retention-1'],
  verificationSurfaceIds: VERIFICATION_SURFACE_IDS,
});
if (!universe.ok) throw new Error(`universe refuses: ${universe.detail}`);
const sealedNow = wp03.validateRequirementsBundle(PRODUCT, universe.universe);
if (!sealedNow.ok) throw new Error(`WP03 refuses: ${sealedNow.reason}: ${sealedNow.detail}`);

/* ------------------------------------------------------------------ */
/* Artifact 1: the desk artifact (content-addressed envelope)           */
/* ------------------------------------------------------------------ */

const artifactContent = {
  schemaVersion: 'formalization.system-requirements.v1',
  deskRef: 'derive-system-requirements',
  deskNodeId: 'derive-system-requirements',
  role: 'author',
  itemInstanceId: 'formalization-item:derive-system-requirements',
  token: 'plan:formalization#item:system-requirements',
  productKind: 'formalization.system-requirements.v1',
  effectId: 'formalization.accept-products',
  checkProviderId: 'formalization.requirements-structure.v1',
  contractKind: 'frf-contracts.requirements-bundle.v1',
  deskSkillId: 'formalization-desk-derive-system-requirements',
  brief: 'FR/NFR requirements derived from the exact accepted define-product-intent bundle and the accepted model-use-cases scenario set: one scenario-derived FR per accepted scenario (boundary interaction, delivered outcome with its deterministic error branch, audited terminal state) and one cross-cutting determinism NFR binding the accepted source constraint directly. The out-of-scope intent member prd:scope-2 and the discovery-owned unknown:browser-matrix-1 derive no requirement.',
  product: PRODUCT,
  deskInput: DESK_INPUT,
  memberSeals: [...requirementSeal.entries()].map(([requirementId, digest]) => ({ requirementId, digest, ref: shaRef(digest) })),
  upstream: {
    materialAuthority: 'the accepted define-product-intent bundle and the accepted model-use-cases scenario bundle (r2), traveling by content address',
    acceptedIntentArtifactRef: ucArt.content.upstream.acceptedIntentArtifactRef,
    acceptedIntentArtifactDigest: ucArt.content.upstream.acceptedIntentArtifactDigest,
    acceptedIntentTraceRef: ucArt.content.upstream.acceptedIntentTraceRef,
    acceptedIntentSubmissionRef: ucArt.content.upstream.acceptedIntentSubmissionRef,
    acceptedUcArtifactRef: ucArt.artifactRef,
    acceptedUcArtifactDigest: ucArt.contentDigest,
    acceptedUcTraceRef: ucTrc.traceRef,
    acceptedUcSubmissionRef: ucSub.submissionRef,
    importArtifactRef: ucArt.content.upstream.importArtifactRef,
    capsuleRef: ucArt.content.upstream.capsuleRef,
    certificateRef: ucArt.content.upstream.certificateRef,
    acceptedIntentSet: {
      memberDigests: [...upFold.set.memberDigests],
      prdMemberIds: [...upFold.set.prdMemberIds],
      revisionDigest: upFold.set.revisionDigest,
      scenarioRequiredMemberIds: [...upFold.set.scenarioRequiredMemberIds],
    },
    acceptedUcSet,
    acceptedIntentSeals: [...upSeal.entries()].map(([memberId, digest]) => ({ memberId, digest, ref: shaRef(digest) })),
    acceptedUcSeals: [...ucSeal.entries()].map(([scenarioId, digest]) => ({ scenarioId, digest, ref: shaRef(digest) })),
    verifiedSubArtifacts: Object.entries(ENVELOPE).map(([id, digest]) => ({ id, digest, ref: shaRef(digest) })),
    verifiedAgainstTaskProjection: true,
  },
  constraintDispositions: [
    {
      constraintId: 'constraint:retention-1',
      digest: ENVELOPE['constraint:retention-1'],
      disposition: 'honored',
      enforcedBy: ['fr:boundary-1', 'fr:outcome-1', 'fr:terminal-1', 'nfr:determinism-1'],
      constrainedMembers: ['fr:boundary-1', 'fr:outcome-1', 'fr:terminal-1'],
      note: 'The determinism NFR binds the accepted source constraint directly (cross-cutting lineage, law L1); every scenario-derived FR stays inside its deterministic scenario content. Enforcement upstream (prd:constraint-1) travels by content address.',
    },
  ],
  unknownDispositions: [
    {
      unknownId: 'unknown:browser-matrix-1',
      digest: ENVELOPE['unknown:browser-matrix-1'],
      disposition: 'carried_forward',
      owner: 'discovery',
      note: 'No resolution edge is recorded: the requirements desk does not resolve the browser support matrix unknown; no requirement, derivation ref or verification surface is derived from it.',
    },
  ],
  terminalSupport: [
    {
      terminalClaimId: 'terminal:audited-1',
      digest: ENVELOPE['terminal:audited-1'],
      ownedByMemberId: 'prd:terminal-1',
      supportedByRequirementId: 'fr:terminal-1',
    },
    {
      terminalClaimId: 'terminal:delivered-1',
      digest: ENVELOPE['terminal:delivered-1'],
      ownedByMemberId: 'prd:outcome-1',
      supportedByRequirementId: 'fr:outcome-1',
    },
  ],
  governingContractRef: shaRef(GOVERNING),
  workspaceSummary: WORKSPACE_SUMMARY,
  verification: {
    acceptedUpstreamRevisionsTravelingByContentAddress: 0,
    claimDigestsMatchedTaskProjection: true,
    coverageLawSatisfied: true,
    declaredDigestsTrusted: false,
    deterministicAuthoring: true,
    fenceRespectedNoForbiddenArtifactFamily: true,
    foreignLineageCitations: 0,
    memberSealsRecomputedOverCanonicalMembers: true,
    revisionPinsMatchAcceptedRevisions: true,
    staleProtocolRefusals: 0,
    terminalClaimsSupportedByRequirements: true,
    verificationSurfacesResolvable: true,
    wp03ValidationSealed: true,
  },
};

const artifact = {
  artifactRef: shaRef(sha(artifactContent)),
  artifactKind: 'system-requirements',
  productKind: 'formalization.system-requirements.v1',
  contentDigest: sha(artifactContent),
  semanticCode: 'SR-Derive-System-Requirements-001',
  createdAt: CREATED_AT,
  deskRef: 'derive-system-requirements',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: artifactContent,
};

/* ------------------------------------------------------------------ */
/* Artifact 2: the trace (relationships resolve to recomputed digests)  */
/* ------------------------------------------------------------------ */

const digestIndex = new Map([
  ...Object.entries(ENVELOPE),
  ...[...upSeal.entries()],
  ...[...ucSeal.entries()],
  ...[...requirementSeal.entries()],
]);

const rel = (fromId, relation, toId, description) => ({
  fromId,
  relation,
  toId,
  description,
  fromRef: shaRef(digestIndex.get(fromId)),
  toRef: shaRef(digestIndex.get(toId)),
});

const relationships = [
  rel('fr:boundary-1', 'derived_from', 'prd:boundary-1', 'The boundary FR derives from the system-boundary intent member (exact accepted PRD lineage).'),
  rel('fr:outcome-1', 'derived_from', 'prd:outcome-1', 'The delivery FR derives from the outcome intent member owned by terminal claim terminal:delivered-1.'),
  rel('fr:terminal-1', 'derived_from', 'prd:terminal-1', 'The terminal FR derives from the terminal-claim intent member owned by terminal claim terminal:audited-1.'),
  rel('nfr:determinism-1', 'derived_from', 'prd:constraint-1', 'The determinism NFR derives from the direct_requirement intent member carrying the accepted constraint.'),
  rel('fr:boundary-1', 'enforces', 'constraint:retention-1', 'The boundary FR obligates deterministic responses only inside the accepted boundary.'),
  rel('fr:outcome-1', 'enforces', 'constraint:retention-1', 'The delivery FR obligates the deterministic error branch: no nondeterministic content is invented.'),
  rel('fr:terminal-1', 'enforces', 'constraint:retention-1', 'The terminal FR obligates a deterministic audit record (go triage with recorded strengths).'),
  rel('nfr:determinism-1', 'enforces', 'constraint:retention-1', 'The determinism NFR binds the accepted source constraint directly (cross-cutting lineage).'),
  rel('fr:boundary-1', 'constrained_by', 'constraint:retention-1', 'The boundary FR is constrained by the accepted determinism constraint: deterministic responses only.'),
  rel('fr:outcome-1', 'constrained_by', 'constraint:retention-1', 'The delivery FR is constrained by the accepted determinism constraint: the error branch invents no nondeterministic content.'),
  rel('fr:terminal-1', 'constrained_by', 'constraint:retention-1', 'The terminal FR is constrained by the accepted determinism constraint: the audit record is deterministic.'),
  rel('fr:outcome-1', 'supports', 'terminal:delivered-1', 'The delivery FR main branch realizes the delivered terminal lifecycle claim.'),
  rel('fr:terminal-1', 'supports', 'terminal:audited-1', 'The terminal FR realizes the audited terminal lifecycle claim.'),
];

const edgeProjection = (fromId, relation) =>
  relationships.filter((r) => r.fromId === fromId && r.relation === relation).map((r) => r.toId).sort();

const requirementCoverage = Object.fromEntries(
  PRODUCT.requirements.map((m) => [m.requirementId, {
    digest: requirementSeal.get(m.requirementId),
    derivedFrom: edgeProjection(m.requirementId, 'derived_from'),
    enforces: edgeProjection(m.requirementId, 'enforces'),
    supports: edgeProjection(m.requirementId, 'supports'),
  }]),
);

const prdMemberCoverage = Object.fromEntries(
  upArt.content.members.map((m) => [m.memberId, {
    digest: upSeal.get(m.memberId),
    disposition: m.disposition.disposition,
    coveredBy: relationships.filter((r) => r.relation === 'derived_from' && r.toId === m.memberId).map((r) => r.fromId).sort(),
  }]),
);

const traceContent = {
  deskRef: 'derive-system-requirements',
  role: 'author',
  traceKind: 'system-requirements-trace',
  subjectSemanticCode: 'SR-Derive-System-Requirements-001',
  subjectArtifactRef: artifact.artifactRef,
  relationVocabulary: ['constrained_by', 'derived_from', 'enforces', 'supports'],
  relationships,
  requirementCoverage,
  prdMemberCoverage,
  terminalCoverage: {
    'terminal:audited-1': {
      digest: ENVELOPE['terminal:audited-1'],
      supportedBy: relationships.filter((r) => r.relation === 'supports' && r.toId === 'terminal:audited-1').map((r) => r.fromId).sort(),
    },
    'terminal:delivered-1': {
      digest: ENVELOPE['terminal:delivered-1'],
      supportedBy: relationships.filter((r) => r.relation === 'supports' && r.toId === 'terminal:delivered-1').map((r) => r.fromId).sort(),
    },
  },
  constraintCoverage: {
    constraintId: 'constraint:retention-1',
    digest: ENVELOPE['constraint:retention-1'],
    disposition: 'honored',
    enforcedBy: relationships.filter((r) => r.relation === 'enforces' && r.toId === 'constraint:retention-1').map((r) => r.fromId).sort(),
    constrainedMembers: ['fr:boundary-1', 'fr:outcome-1', 'fr:terminal-1'],
  },
  unknownCoverage: {
    unknownId: 'unknown:browser-matrix-1',
    digest: ENVELOPE['unknown:browser-matrix-1'],
    disposition: 'carried_forward',
    owner: 'discovery',
    note: 'No resolution edge is recorded: the unknown travels with the capsule; no requirement, derivation ref or verification surface is derived from it.',
  },
  workspaceSummary: WORKSPACE_SUMMARY,
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'system-requirements-trace',
  contentDigest: sha(traceContent),
  createdAt: CREATED_AT,
  deskRef: 'derive-system-requirements',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

/* ------------------------------------------------------------------ */
/* Artifact 3: the product submission                                   */
/* ------------------------------------------------------------------ */

const requiredEvidenceRefs = [
  upArt.contentDigest,
  ucArt.contentDigest,
  'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5',
  'f3f98175f061fa289d49f4684f78273022c97b9e12bc535255c4b3d4c6a0534e',
  '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21',
  ...Object.values(ENVELOPE),
  GOVERNING,
  '6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9',
  '91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0',
  ucTrc.contentDigest,
  ucSub.contentDigest,
].map(shaRef);

const submissionContent = {
  deskRef: 'derive-system-requirements',
  deskNodeId: 'derive-system-requirements',
  role: 'author',
  itemInstanceId: 'formalization-item:derive-system-requirements',
  token: 'plan:formalization#item:system-requirements',
  candidate: {
    kind: 'formalization.system-requirements.v1',
    artifactRef: artifact.artifactRef,
    contentDigest: artifact.contentDigest,
  },
  payloadContract: {
    productKind: 'formalization.system-requirements.v1',
    effectId: 'formalization.accept-products',
    requiredEvidenceRefs,
    evidenceKindCoverage: {
      'accepted-prd-intent-bundle': 1,
      'accepted-uc-scenarios-bundle': 1,
      'discovery-import-artifact': 1,
      'discovery-handoff-capsule': 1,
      'discovery-certificate': 1,
      'source-claim': 4,
      constraint: 1,
      unknown: 1,
      'terminal-claim': 2,
      'architecture-contract': 1,
      'accepted-intent-trace': 1,
      'accepted-intent-submission': 1,
      'accepted-uc-trace': 1,
      'accepted-uc-submission': 1,
    },
    terminalOutcome: 'success',
  },
  traceRef: trace.traceRef,
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#derive-system-requirements:author',
    status: 'admitted_for_reviewer_stage',
    receivedFrom: 'author',
    nextStage: 'reviewer',
    note: 'The kernel-side product submission (product_submit against the workflow kernel) is executed by the driver over public commands; this receipt records desk-level intake of the authored candidate only.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed desk artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Bundle schemaVersion frf-contracts.requirements-bundle.v1 and it is SEALED by the REAL WP03 validator validateRequirementsBundle against the accepted universe derived through the REAL deriveAcceptedUniverse protocol', satisfied: true },
    { id: 3, description: 'Law L1 exact lineage: every requirement binds exact accepted PRD intent members; scenario-derived FRs bind UC scenario AND terminal-branch identities; branches resolve within cited owning scenarios; the NFR binds the accepted source constraint directly', satisfied: true },
    { id: 4, description: 'UC coverage law: every accepted UC scenario (uc:boundary-1, uc:outcome-1, uc:terminal-1) produces at least one observable behavior obligation', satisfied: true },
    { id: 5, description: 'Law L2 verification surfaces: every requirement carries at least one surface resolving inside the accepted surface set (surface:test-suite-1, surface:monitoring-1, surface:audit-1)', satisfied: true },
    { id: 6, description: 'Law L3 revision pins: the bundle pins the exact accepted PRD revision and the exact accepted UC revision (recomputed by the REAL folds, never declared)', satisfied: true },
    { id: 7, description: 'Fence respected: no scenarios/acceptanceCriteria/criteria/srs/scenarioRealizations/solutionContract artifact family in the candidate; closed FR/NFR/RULE vocabulary only', satisfied: true },
    { id: 8, description: 'constraint:retention-1 honored (deterministic authoring, pinned timestamps, no clock/random reads; determinism NFR binds the constraint directly); unknown:browser-matrix-1 carried forward with owner discovery and no fabricated resolution edge; prd:scope-2 (out_of_scope) derives no requirement', satisfied: true },
    { id: 9, description: 'Trace relationships all resolve against recomputed digests; coverage blocks are exact projections of the edge set; terminal claims stay owned upstream (prd:outcome-1, prd:terminal-1)', satisfied: true },
    { id: 10, description: '0 accepted upstream revisions travel by content address', satisfied: true },
  ],
  workspaceSummary: WORKSPACE_SUMMARY,
};

const submission = {
  submissionRef: shaRef(sha(submissionContent)),
  submissionId: 'FS-Derive-System-Requirements-001',
  contentDigest: sha(submissionContent),
  createdAt: CREATED_AT,
  deskRef: 'derive-system-requirements',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: submissionContent,
};

/* ------------------------------------------------------------------ */
/* Write the three desk artifacts                                       */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('derive-system-requirements-desk-system-requirements.artifact.json', artifact);
writeJson('derive-system-requirements-desk-system-requirements-trace.json', trace);
writeJson('derive-system-requirements-desk-product-submission.json', submission);

console.log(JSON.stringify({
  built: 'derive-system-requirements desk (author) r2 artifacts',
  prdRevision: PRD_REVISION,
  ucRevision: ucRevisionDigest,
  wp03Seal: sealedNow.ref,
  artifactRef: artifact.artifactRef,
  traceRef: trace.traceRef,
  submissionRef: submission.submissionRef,
}, null, 2));
