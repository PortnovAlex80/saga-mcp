/**
 * define-acceptance-contract desk (author) - deterministic builder.
 *
 * Continues the stray-products-r3 desk chain (define-product-intent ->
 * model-use-cases -> derive-system-requirements -> THIS desk). The task
 * projection envelope, the governing protocol-skill digest and the
 * workspace summary are identical to the upstream desks' frames; the
 * exact accepted upstream material travels by content address.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. Digests are computed over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule
 * (src/workflow-kernel/domain/digest.ts).
 *
 * The authored bundle is built and SEALED by the REAL installed cell
 * surface: the universe comes from the cell's acceptanceUniverseFrom
 * protocol and the bundle is validated+sealed by the cell's
 * validateAcceptanceBundle (which runs the WP03 validateAcBinding seam
 * once per criterion - refusals propagate verbatim). Upstream seals are
 * recomputed through the REAL validators and REAL fold formulas; the
 * accepted requirements bundle itself is re-verified against its
 * recomputed universe BEFORE it is consumed. Nothing is trusted by
 * declaration.
 *
 * Run: node define-acceptance-contract-desk-build.mjs
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
const accCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'acceptance', 'index.mjs')).href);
const upCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'product-intent', 'index.js')).href);
const srCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'system-requirements', 'index.js')).href);
const wp03sr = await import(pathToFileURL(join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'validators', 'requirements-bundle.mjs')).href);
const prd03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href);
const uc03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'uc-scenario-member.mjs')).href);

const upArt = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));
const ucArt = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json'), 'utf8'));
const ucTrc = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios-trace.json'), 'utf8'));
const ucSub = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-product-submission.json'), 'utf8'));
const srArt = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-system-requirements.artifact.json'), 'utf8'));
const srTrc = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-system-requirements-trace.json'), 'utf8'));
const srSub = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-product-submission.json'), 'utf8'));

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
/* Upstream re-verification: nothing is trusted by declaration          */
/* ------------------------------------------------------------------ */

const expect = (cond, message) => { if (!cond) throw new Error(`upstream verification failed: ${message}`); };
expect(sha(upArt.content) === upArt.contentDigest, 'intent artifact content digest drift');
expect(sha(ucArt.content) === ucArt.contentDigest, 'UC artifact content digest drift');
expect(sha(srArt.content) === srArt.contentDigest, 'requirements artifact content digest drift');
expect(sha(ucTrc.content) === ucTrc.contentDigest, 'UC trace content digest drift');
expect(sha(srTrc.content) === srTrc.contentDigest, 'requirements trace content digest drift');
expect(sha(ucSub.content) === ucSub.contentDigest, 'UC submission content digest drift');
expect(sha(srSub.content) === srSub.contentDigest, 'requirements submission content digest drift');
expect(srArt.content.governingContractRef === shaRef(GOVERNING), 'governing contract pin drift');
expect(srArt.content.workspaceSummary === WORKSPACE_SUMMARY, 'workspace summary drift');

const SR_PRODUCT = srArt.content.product;
expect(SR_PRODUCT.schemaVersion === 'frf-contracts.requirements-bundle.v1', 'requirements bundle schema drift');

/* Intent fold + member seals (REAL validators + REAL fold). */
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
expect(shaRef(upFold.set.revisionDigest) === SR_PRODUCT.prdRevisionRef, 'accepted PRD revision pin does not match the recomputed fold');

/* UC seals + revision (REAL validator + fold formula). */
const ucSeal = new Map();
for (const s of ucArt.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, { idSets: { prdMemberIds: upFold.set.prdMemberIds } });
  if (!v.ok) throw new Error(`upstream scenario ${s.scenarioId} refuses: ${v.reason}`);
  ucSeal.set(s.scenarioId, sha(s));
}
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
expect(shaRef(ucRevisionDigest) === SR_PRODUCT.ucRevisionRef, 'accepted UC revision pin does not match the recomputed fold');

const acceptedUcSet = {
  memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort(),
  scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(),
  branchIdsByScenario: Object.fromEntries(
    ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)]),
  ),
  revisionDigest: ucRevisionDigest,
};

/* Requirements member seals recomputed over canonical members. */
const requirementSeal = new Map();
for (const r of SR_PRODUCT.requirements) {
  requirementSeal.set(r.requirementId, sha(r));
}
for (const declared of srArt.content.memberSeals) {
  expect(requirementSeal.get(declared.requirementId) === declared.digest, `requirement seal drift for ${declared.requirementId}`);
}

/* The accepted requirements bundle must re-seal against its recomputed universe. */
const srUniverse = srCell.deriveAcceptedUniverse({
  prd: { revisionDigest: upFold.set.revisionDigest, memberIds: [...upFold.set.prdMemberIds] },
  useCases: { revisionDigest: ucRevisionDigest, scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  sourceConstraintIds: ['constraint:retention-1'],
  verificationSurfaceIds: srArt.content.deskInput.verificationSurfaceIds,
});
if (!srUniverse.ok) throw new Error(`requirements universe refuses: ${srUniverse.detail}`);
const srSealedNow = wp03sr.validateRequirementsBundle(SR_PRODUCT, srUniverse.universe);
if (!srSealedNow.ok) throw new Error(`accepted requirements bundle refuses: ${srSealedNow.reason}: ${srSealedNow.detail}`);

/* ------------------------------------------------------------------ */
/* The authored acceptance contract (exact accepted lineage only)       */
/* ------------------------------------------------------------------ */

const VERIFIABLE_STATEMENTS = [
  {
    statementId: 'stmt:boundary-1-response',
    statement: 'Given the user submitted a message inside the accepted system boundary, when the message service completes the interaction, then the user has received the deterministic service response inside the accepted boundary.',
  },
  {
    statementId: 'stmt:outcome-1-delivered',
    statement: 'Given the user submitted a message requesting the service outcome, when the message service completes the interaction, then the accepted Discovery outcome is delivered to the user (terminal:delivered-1).',
  },
  {
    statementId: 'stmt:outcome-1-deterministic-error',
    statement: 'Given the message service cannot produce a response for a submitted message, when the interaction completes, then the user has received a deterministic error response and no nondeterministic content was invented.',
  },
  {
    statementId: 'stmt:terminal-1-audited',
    statement: 'Given the delivered outcome and its audit record are complete, when terminal triage closes the run, then the subject is triaged go with recorded strengths in the audit record (terminal:audited-1).',
  },
  {
    statementId: 'stmt:determinism-1',
    statement: 'For every response the message service produces, the response is deterministic and invents no nondeterministic content.',
  },
];
const statementSeal = new Map(VERIFIABLE_STATEMENTS.map((s) => [s.statementId, sha(s)]));

/* The desk input the desk itself authors (the accepted verifiable-statement
   id set criteria cite; no accepted standalone evidence bindings - every
   required terminal result is covered by an end-to-end criterion). */
const DESK_INPUT = {
  verifiableStatementIds: VERIFIABLE_STATEMENTS.map((s) => s.statementId).sort(),
  evidenceBindings: [],
};

const CRITERIA = [
  {
    schemaVersion: 'frf-contracts.ac-binding.v1',
    criterionId: 'ac:boundary-1',
    bindsTo: {
      requirementRefs: ['fr:boundary-1'],
      ucScenarioRefs: ['uc:boundary-1'],
      ucTerminalBranchRefs: ['branch:boundary-1-main'],
    },
    evidence: {
      evidenceKind: 'test',
      observableTerminalResult: 'The user receives the deterministic service response and the interaction has closed inside the accepted system boundary (branch:boundary-1-main).',
    },
    verifiableStatementRefs: ['stmt:boundary-1-response'],
  },
  {
    schemaVersion: 'frf-contracts.ac-binding.v1',
    criterionId: 'ac:outcome-1-delivered',
    bindsTo: {
      requirementRefs: ['fr:outcome-1'],
      ucScenarioRefs: ['uc:outcome-1'],
      ucTerminalBranchRefs: ['branch:outcome-1-main'],
    },
    evidence: {
      evidenceKind: 'test',
      observableTerminalResult: 'The accepted Discovery outcome is delivered to the user and the delivery is recorded, closing terminal lifecycle claim terminal:delivered-1 (branch:outcome-1-main).',
    },
    verifiableStatementRefs: ['stmt:outcome-1-delivered'],
  },
  {
    schemaVersion: 'frf-contracts.ac-binding.v1',
    criterionId: 'ac:outcome-1-deterministic-error',
    bindsTo: {
      requirementRefs: ['fr:outcome-1'],
      ucScenarioRefs: ['uc:outcome-1'],
      ucTerminalBranchRefs: ['branch:outcome-1-deterministic-error'],
    },
    evidence: {
      evidenceKind: 'monitoring',
      observableTerminalResult: 'When the service cannot produce a response, the user receives a deterministic error response and no nondeterministic content is produced (branch:outcome-1-deterministic-error).',
    },
    verifiableStatementRefs: ['stmt:outcome-1-deterministic-error'],
  },
  {
    schemaVersion: 'frf-contracts.ac-binding.v1',
    criterionId: 'ac:terminal-1-audited',
    bindsTo: {
      requirementRefs: ['fr:terminal-1'],
      ucScenarioRefs: ['uc:terminal-1'],
      ucTerminalBranchRefs: ['branch:terminal-1-main'],
    },
    evidence: {
      evidenceKind: 'audit',
      observableTerminalResult: 'The subject is triaged go with recorded strengths in the audit record and the run terminal state is closed audited (terminal:audited-1, branch:terminal-1-main).',
    },
    verifiableStatementRefs: ['stmt:terminal-1-audited'],
  },
  {
    schemaVersion: 'frf-contracts.ac-binding.v1',
    criterionId: 'ac:determinism-1',
    bindsTo: {
      requirementRefs: ['nfr:determinism-1'],
    },
    evidence: {
      evidenceKind: 'test',
      observableTerminalResult: 'Every observed response of the message service is deterministic; no response contains invented nondeterministic content.',
    },
    verifiableStatementRefs: ['stmt:determinism-1'],
  },
];

/* The bundle wrapper (the desk's product; ACCEPTANCE_BUNDLE_TEMPLATE shape). */
const PRODUCT = {
  schemaVersion: accCell.ACCEPTANCE_BUNDLE_SCHEMA_VERSION,
  criteria: CRITERIA,
  deferrals: [],
  standaloneEvidenceBindings: [],
};

/* Universe through the REAL cell protocol; seal through the REAL validator. */
const universe = accCell.acceptanceUniverseFrom({
  requirementsBundle: SR_PRODUCT,
  useCases: { scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  verifiableStatementIds: DESK_INPUT.verifiableStatementIds,
  evidenceBindings: DESK_INPUT.evidenceBindings,
});
if (!universe.ok) throw new Error(`acceptance universe refuses: ${universe.reason}: ${universe.detail}`);
const sealedNow = accCell.validateAcceptanceBundle(PRODUCT, universe.universe, SR_PRODUCT.requirements);
if (!sealedNow.ok) throw new Error(`acceptance bundle refuses: ${sealedNow.reason}: ${sealedNow.detail}`);
const PRODUCT_SEAL = sealedNow.artifact;

const criterionSeal = new Map(PRODUCT.criteria.map((c) => [c.criterionId, sha(c)]));
if (criterionSeal.size !== CRITERIA.length) throw new Error('criterion seal set drift');

/* ------------------------------------------------------------------ */
/* Artifact 1: the desk artifact (content-addressed envelope)           */
/* ------------------------------------------------------------------ */

const artifactContent = {
  schemaVersion: 'formalization.acceptance-bindings.v1',
  deskRef: 'define-acceptance-contract',
  deskNodeId: 'define-acceptance-contract',
  role: 'author',
  itemInstanceId: 'formalization-item:define-acceptance-contract',
  token: 'plan:formalization#item:acceptance-contract',
  productKind: 'formalization.acceptance-bindings.v1',
  effectId: 'formalization.accept-products',
  checkProviderId: 'frf.acceptance-closure.v1',
  contractKind: 'frf-contracts.ac-binding.v1',
  deskSkillId: 'formalization-desk-define-acceptance-contract',
  brief: 'Acceptance contract over the exact accepted derive-system-requirements bundle and the accepted model-use-cases scenario set: five atomic frf-contracts.ac-binding.v1 criteria - one per accepted UC terminal branch (boundary main, delivered outcome main, deterministic error, audited terminal) plus the cross-cutting determinism NFR - each binding exact FR/NFR material with BOTH UC citation shapes, a closed-vocabulary evidence kind and a declared observable terminal result. Every accepted FR/NFR is covered by a criterion (no deferrals); every required UC terminal branch is covered by an end-to-end criterion (no standalone evidence bindings needed). The out-of-scope intent member prd:scope-2 and the discovery-owned unknown:browser-matrix-1 derive no criterion.',
  product: PRODUCT,
  deskInput: DESK_INPUT,
  verifiableStatements: VERIFIABLE_STATEMENTS.map((s) => ({ statementId: s.statementId, statement: s.statement, digest: statementSeal.get(s.statementId), ref: shaRef(statementSeal.get(s.statementId)) })),
  productSeal: { digest: PRODUCT_SEAL.digest, ref: PRODUCT_SEAL.ref },
  memberSeals: [...criterionSeal.entries()].map(([criterionId, digest]) => ({ criterionId, digest, ref: shaRef(digest) })),
  upstream: {
    materialAuthority: 'the accepted define-product-intent bundle, the accepted model-use-cases scenario bundle and the accepted derive-system-requirements bundle, traveling by content address',
    acceptedIntentArtifactRef: ucArt.content.upstream.acceptedIntentArtifactRef,
    acceptedIntentArtifactDigest: ucArt.content.upstream.acceptedIntentArtifactDigest,
    acceptedIntentTraceRef: ucArt.content.upstream.acceptedIntentTraceRef,
    acceptedIntentSubmissionRef: ucArt.content.upstream.acceptedIntentSubmissionRef,
    acceptedUcArtifactRef: ucArt.artifactRef,
    acceptedUcArtifactDigest: ucArt.contentDigest,
    acceptedUcTraceRef: ucTrc.traceRef,
    acceptedUcSubmissionRef: ucSub.submissionRef,
    acceptedRequirementsArtifactRef: srArt.artifactRef,
    acceptedRequirementsArtifactDigest: srArt.contentDigest,
    acceptedRequirementsTraceRef: srTrc.traceRef,
    acceptedRequirementsSubmissionRef: srSub.submissionRef,
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
    acceptedRequirementsSet: {
      memberDigests: SR_PRODUCT.requirements.map((r) => requirementSeal.get(r.requirementId)).sort(),
      requirementIds: SR_PRODUCT.requirements.map((r) => r.requirementId).sort(),
      frIds: SR_PRODUCT.requirements.filter((r) => r.requirementKind === 'FR').map((r) => r.requirementId).sort(),
      nfrIds: SR_PRODUCT.requirements.filter((r) => r.requirementKind === 'NFR').map((r) => r.requirementId).sort(),
      ruleIds: [],
      prdRevisionDigest: SR_PRODUCT.prdRevisionRef,
      ucRevisionDigest: SR_PRODUCT.ucRevisionRef,
      branchIdsByScenario: acceptedUcSet.branchIdsByScenario,
    },
    acceptedIntentSeals: [...upSeal.entries()].map(([memberId, digest]) => ({ memberId, digest, ref: shaRef(digest) })),
    acceptedUcSeals: [...ucSeal.entries()].map(([scenarioId, digest]) => ({ scenarioId, digest, ref: shaRef(digest) })),
    acceptedRequirementSeals: [...requirementSeal.entries()].map(([requirementId, digest]) => ({ requirementId, digest, ref: shaRef(digest) })),
    verifiedSubArtifacts: Object.entries(ENVELOPE).map(([id, digest]) => ({ id, digest, ref: shaRef(digest) })),
    verifiedAgainstTaskProjection: true,
  },
  constraintDispositions: [
    {
      constraintId: 'constraint:retention-1',
      digest: ENVELOPE['constraint:retention-1'],
      disposition: 'honored',
      enforcedBy: ['ac:determinism-1', 'ac:outcome-1-deterministic-error'],
      constrainedCriteria: ['ac:boundary-1', 'ac:outcome-1-delivered', 'ac:outcome-1-deterministic-error', 'ac:terminal-1-audited'],
      note: 'The determinism constraint is verified at this desk through the NFR criterion ac:determinism-1 (the NFR binds the constraint directly upstream) and through the deterministic-error branch criterion ac:outcome-1-deterministic-error; every scenario-facing criterion verifies deterministic scenario content only. Enforcement upstream (nfr:determinism-1, prd:constraint-1) travels by content address.',
    },
  ],
  unknownDispositions: [
    {
      unknownId: 'unknown:browser-matrix-1',
      digest: ENVELOPE['unknown:browser-matrix-1'],
      disposition: 'carried_forward',
      owner: 'discovery',
      note: 'No resolution edge is recorded: the acceptance desk does not resolve the browser support matrix unknown; no criterion, evidence kind, verifiable statement or observable terminal result is derived from it.',
    },
  ],
  terminalSupport: [
    {
      terminalClaimId: 'terminal:audited-1',
      digest: ENVELOPE['terminal:audited-1'],
      ownedByMemberId: 'prd:terminal-1',
      supportedByRequirementId: 'fr:terminal-1',
      verifiedByCriterionId: 'ac:terminal-1-audited',
    },
    {
      terminalClaimId: 'terminal:delivered-1',
      digest: ENVELOPE['terminal:delivered-1'],
      ownedByMemberId: 'prd:outcome-1',
      supportedByRequirementId: 'fr:outcome-1',
      verifiedByCriterionId: 'ac:outcome-1-delivered',
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
    evidenceKindsClosedVocabulary: true,
    fenceRespectedNoForbiddenArtifactFamily: true,
    foreignLineageCitations: 0,
    memberSealsRecomputedOverCanonicalMembers: true,
    revisionPinsMatchAcceptedRevisions: true,
    staleProtocolRefusals: 0,
    terminalClaimsSupportedByCriteria: true,
    upstreamRequirementsBundleReverified: true,
    verifiableStatementsResolvable: true,
    wp03SeamRefusals: 0,
    wp03ValidationSealed: true,
  },
};

const artifact = {
  artifactRef: shaRef(sha(artifactContent)),
  artifactKind: 'acceptance-bindings',
  productKind: 'formalization.acceptance-bindings.v1',
  contentDigest: sha(artifactContent),
  semanticCode: 'SR-Define-Acceptance-Contract-001',
  createdAt: CREATED_AT,
  deskRef: 'define-acceptance-contract',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: artifactContent,
};

/* ------------------------------------------------------------------ */
/* Artifact 2: the trace (relationships resolve to recomputed digests)  */
/* ------------------------------------------------------------------ */

/* Branch identities travel inside their owning frozen scenario member;
   a branch resolves to the scenario member's seal digest. */
const branchOwner = new Map();
for (const [scenarioId, branchIds] of Object.entries(acceptedUcSet.branchIdsByScenario)) {
  for (const branchId of branchIds) branchOwner.set(branchId, scenarioId);
}
const resolveId = (id) => {
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (criterionSeal.has(id)) return criterionSeal.get(id);
  if (requirementSeal.has(id)) return requirementSeal.get(id);
  if (ucSeal.has(id)) return ucSeal.get(id);
  if (statementSeal.has(id)) return statementSeal.get(id);
  if (branchOwner.has(id)) return ucSeal.get(branchOwner.get(id));
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
  rel('ac:boundary-1', 'verifies', 'fr:boundary-1', 'The boundary criterion verifies the boundary FR end to end through the accepted test surface.'),
  rel('ac:boundary-1', 'covers', 'branch:boundary-1-main', 'The boundary criterion covers the main terminal result of uc:boundary-1 (cr-05).'),
  rel('ac:boundary-1', 'cites', 'stmt:boundary-1-response', 'The boundary criterion cites its accepted verifiable statement.'),
  rel('ac:outcome-1-delivered', 'verifies', 'fr:outcome-1', 'The delivered-outcome criterion verifies the delivery FR main branch end to end.'),
  rel('ac:outcome-1-delivered', 'covers', 'branch:outcome-1-main', 'The delivered-outcome criterion covers the main terminal result of uc:outcome-1 (cr-05).'),
  rel('ac:outcome-1-delivered', 'cites', 'stmt:outcome-1-delivered', 'The delivered-outcome criterion cites its accepted verifiable statement.'),
  rel('ac:outcome-1-delivered', 'supports', 'terminal:delivered-1', 'The delivered-outcome criterion realizes the delivered terminal lifecycle claim through fr:outcome-1.'),
  rel('ac:outcome-1-deterministic-error', 'verifies', 'fr:outcome-1', 'The deterministic-error criterion verifies the delivery FR error branch end to end.'),
  rel('ac:outcome-1-deterministic-error', 'covers', 'branch:outcome-1-deterministic-error', 'The deterministic-error criterion covers the deterministic error terminal result of uc:outcome-1 (cr-05).'),
  rel('ac:outcome-1-deterministic-error', 'cites', 'stmt:outcome-1-deterministic-error', 'The deterministic-error criterion cites its accepted verifiable statement.'),
  rel('ac:terminal-1-audited', 'verifies', 'fr:terminal-1', 'The audited-terminal criterion verifies the terminal FR end to end through the accepted audit surface.'),
  rel('ac:terminal-1-audited', 'covers', 'branch:terminal-1-main', 'The audited-terminal criterion covers the main terminal result of uc:terminal-1 (cr-05).'),
  rel('ac:terminal-1-audited', 'cites', 'stmt:terminal-1-audited', 'The audited-terminal criterion cites its accepted verifiable statement.'),
  rel('ac:terminal-1-audited', 'supports', 'terminal:audited-1', 'The audited-terminal criterion realizes the audited terminal lifecycle claim through fr:terminal-1.'),
  rel('ac:determinism-1', 'verifies', 'nfr:determinism-1', 'The determinism criterion verifies the cross-cutting determinism NFR; the NFR is not scenario-derived, so the criterion carries no UC citation.'),
  rel('ac:determinism-1', 'cites', 'stmt:determinism-1', 'The determinism criterion cites its accepted verifiable statement.'),
];

const edgeProjection = (fromId, relation) =>
  relationships.filter((r) => r.fromId === fromId && r.relation === relation).map((r) => r.toId).sort();

const criterionCoverage = Object.fromEntries(
  PRODUCT.criteria.map((c) => [c.criterionId, {
    digest: criterionSeal.get(c.criterionId),
    verifies: edgeProjection(c.criterionId, 'verifies'),
    covers: edgeProjection(c.criterionId, 'covers'),
    cites: edgeProjection(c.criterionId, 'cites'),
    supports: edgeProjection(c.criterionId, 'supports'),
  }]),
);

const requirementCoverage = Object.fromEntries(
  SR_PRODUCT.requirements.map((r) => [r.requirementId, {
    digest: requirementSeal.get(r.requirementId),
    verifiedBy: relationships.filter((x) => x.relation === 'verifies' && x.toId === r.requirementId).map((x) => x.fromId).sort(),
  }]),
);

const branchCoverage = Object.fromEntries(
  [...branchOwner.entries()].map(([branchId, scenarioId]) => [branchId, {
    owningScenario: scenarioId,
    digest: ucSeal.get(scenarioId),
    coveredBy: relationships.filter((x) => x.relation === 'covers' && x.toId === branchId).map((x) => x.fromId).sort(),
  }]),
);

const traceContent = {
  deskRef: 'define-acceptance-contract',
  role: 'author',
  traceKind: 'acceptance-bindings-trace',
  subjectSemanticCode: 'SR-Define-Acceptance-Contract-001',
  subjectArtifactRef: artifact.artifactRef,
  relationVocabulary: ['cites', 'covers', 'supports', 'verifies'],
  relationships,
  criterionCoverage,
  requirementCoverage,
  branchCoverage,
  branchResolutionNote: 'A terminal-branch identity travels inside its owning frozen scenario member; a branch ref resolves to the scenario member seal digest (branch ids carry no separate content address).',
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
    enforcedBy: ['ac:determinism-1', 'ac:outcome-1-deterministic-error'],
    constrainedCriteria: ['ac:boundary-1', 'ac:outcome-1-delivered', 'ac:outcome-1-deterministic-error', 'ac:terminal-1-audited'],
  },
  unknownCoverage: {
    unknownId: 'unknown:browser-matrix-1',
    digest: ENVELOPE['unknown:browser-matrix-1'],
    disposition: 'carried_forward',
    owner: 'discovery',
    note: 'No resolution edge is recorded: the unknown travels with the capsule; no criterion, evidence kind, verifiable statement or observable terminal result is derived from it.',
  },
  workspaceSummary: WORKSPACE_SUMMARY,
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'acceptance-bindings-trace',
  contentDigest: sha(traceContent),
  createdAt: CREATED_AT,
  deskRef: 'define-acceptance-contract',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: traceContent,
};

/* ------------------------------------------------------------------ */
/* Artifact 3: the product submission                                   */
/* ------------------------------------------------------------------ */

const requiredEvidenceRefs = [
  srArt.contentDigest,
  ucArt.contentDigest,
  upArt.contentDigest,
  'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5',
  'f3f98175f061fa289d49f4684f78273022c97b9e12bc535255c4b3d4c6a0534e',
  '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21',
  ...Object.values(ENVELOPE),
  GOVERNING,
  '6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9',
  '91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0',
  ucTrc.contentDigest,
  ucSub.contentDigest,
  srTrc.contentDigest,
  srSub.contentDigest,
].map(shaRef);

const submissionContent = {
  deskRef: 'define-acceptance-contract',
  deskNodeId: 'define-acceptance-contract',
  role: 'author',
  itemInstanceId: 'formalization-item:define-acceptance-contract',
  token: 'plan:formalization#item:acceptance-contract',
  candidate: {
    kind: 'formalization.acceptance-bindings.v1',
    artifactRef: artifact.artifactRef,
    contentDigest: artifact.contentDigest,
  },
  payloadContract: {
    productKind: 'formalization.acceptance-bindings.v1',
    effectId: 'formalization.accept-products',
    requiredEvidenceRefs,
    evidenceKindCoverage: {
      'accepted-prd-intent-bundle': 1,
      'accepted-uc-scenarios-bundle': 1,
      'accepted-requirements-bundle': 1,
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
      'accepted-requirements-trace': 1,
      'accepted-requirements-submission': 1,
    },
    terminalOutcome: 'success',
  },
  traceRef: trace.traceRef,
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#define-acceptance-contract:author',
    status: 'admitted_for_reviewer_stage',
    receivedFrom: 'author',
    nextStage: 'reviewer',
    note: 'The kernel-side product submission (product_submit against the workflow kernel) is executed by the driver over public commands; this receipt records desk-level intake of the authored candidate only.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed desk artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Bundle schemaVersion formalization.acceptance-bindings.v1 and it is SEALED by the REAL cell validator validateAcceptanceBundle against the universe derived through the REAL acceptanceUniverseFrom protocol', satisfied: true },
    { id: 3, description: 'Law ac-1 exact lineage: every criterion binds exact accepted FR/NFR material; RULE is not bound (not AC-bindable)', satisfied: true },
    { id: 4, description: 'Laws ac-2/ac-3 BOTH citation shapes: every scenario-facing criterion cites its UC scenario AND terminal branch, and every citation is supported by the bound requirements\' own derivation', satisfied: true },
    { id: 5, description: 'Law ac-4 evidence kinds from the closed four-value vocabulary with declared observable terminal results', satisfied: true },
    { id: 6, description: 'Law ac-5 WHAT-side fence: no architecture, module allocation or file decisions anywhere in the bundle', satisfied: true },
    { id: 7, description: 'Law ac-6 closure: every accepted FR/NFR covered by >=1 criterion (no deferrals needed); every required UC terminal branch covered by an end-to-end criterion (no standalone evidence bindings needed)', satisfied: true },
    { id: 8, description: 'Law ac-7 atomic identity: criterion ids stable and unique across the bundle', satisfied: true },
    { id: 9, description: 'Upstream re-verified before consumption: intent/UC/requirements artifact digests recomputed, member seals recomputed, revision pins matched through the REAL folds, and the accepted requirements bundle re-sealed against its recomputed WP03 universe', satisfied: true },
    { id: 10, description: 'constraint:retention-1 honored (deterministic authoring, pinned timestamps, no clock/random reads; determinism verified through ac:determinism-1 and the deterministic-error criterion); unknown:browser-matrix-1 carried forward with owner discovery and no fabricated resolution edge; prd:scope-2 (out_of_scope) derives no criterion', satisfied: true },
    { id: 11, description: 'Trace relationships all resolve against recomputed digests; coverage blocks are exact projections of the edge set; terminal claims stay owned upstream (prd:outcome-1, prd:terminal-1)', satisfied: true },
    { id: 12, description: '0 accepted upstream revisions travel by content address', satisfied: true },
  ],
  workspaceSummary: WORKSPACE_SUMMARY,
};

const submission = {
  submissionRef: shaRef(sha(submissionContent)),
  submissionId: 'FS-Define-Acceptance-Contract-001',
  contentDigest: sha(submissionContent),
  createdAt: CREATED_AT,
  deskRef: 'define-acceptance-contract',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: submissionContent,
};

/* ------------------------------------------------------------------ */
/* Write the three desk artifacts                                       */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('define-acceptance-contract-desk-acceptance-bindings.artifact.json', artifact);
writeJson('define-acceptance-contract-desk-acceptance-bindings-trace.json', trace);
writeJson('define-acceptance-contract-desk-product-submission.json', submission);

console.log(JSON.stringify({
  built: 'define-acceptance-contract desk (author) artifacts',
  prdRevision: SR_PRODUCT.prdRevisionRef,
  ucRevision: ucRevisionDigest,
  requirementsRevalidated: srSealedNow.ref,
  acceptanceSeal: PRODUCT_SEAL.ref,
  artifactRef: artifact.artifactRef,
  traceRef: trace.traceRef,
  submissionRef: submission.submissionRef,
}, null, 2));
