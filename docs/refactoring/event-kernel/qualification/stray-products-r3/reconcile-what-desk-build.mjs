/**
 * reconcile-what desk (author) - deterministic builder.
 *
 * Continues the stray-products-r3 desk chain (define-product-intent ->
 * model-use-cases -> derive-system-requirements -> define-acceptance-contract
 * -> THIS desk). The task projection envelope, the governing protocol-skill
 * digest, the semantic-skill digest and the workspace summary are identical
 * to the upstream desks' frames; the exact accepted upstream material
 * travels by content address.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. Digests are computed over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule
 * (src/workflow-kernel/domain/digest.ts).
 *
 * The authored product is the REPORT of the REAL installed reconciliation
 * surface: acceptance.reconcileWhat(snapshot) - the report-only cell module
 * whose verdict is COMPUTED from the typed findings (verdict === 'gaps'
 * iff findings.length > 0, 'consistent' iff findings.length === 0; the
 * F-2 fix; reconcileWhat takes no verdict input at all). The snapshot is
 * recomputed from the exact accepted upstream bundles (intent fold, UC
 * seals, requirements seals, WP03 re-seal, acceptance universe re-derivation
 * and acceptance bundle re-seal) - nothing is trusted by declaration. The
 * upstream candidate of record is only consumed after the reviewer's
 * decision artifact is verified to say 'accepted' over exactly the
 * published author refs.
 *
 * Report-only law (cr-12): the reconciler names gaps; it never mutates. A
 * lawful repair is a new immutable revision in the OWNING upstream cell -
 * never here. This desk authors the computed report plus desk projections
 * around it (claim coverage rows over the full accepted mapping, trace,
 * submission).
 *
 * Run: node reconcile-what-desk-build.mjs
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
const accArt = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings.artifact.json'), 'utf8'));
const accTrc = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings-trace.json'), 'utf8'));
const accSub = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-product-submission.json'), 'utf8'));
const accReview = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-review.json'), 'utf8'));

const CREATED_AT = '2026-08-28T00:00:00Z';
const WORKSPACE_SUMMARY = '0 accepted upstream revisions travel by content address';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const SEMANTIC_SKILL = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';

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
expect(sha(accArt.content) === accArt.contentDigest, 'acceptance artifact content digest drift');
expect(sha(ucTrc.content) === ucTrc.contentDigest, 'UC trace content digest drift');
expect(sha(srTrc.content) === srTrc.contentDigest, 'requirements trace content digest drift');
expect(sha(accTrc.content) === accTrc.contentDigest, 'acceptance trace content digest drift');
expect(sha(ucSub.content) === ucSub.contentDigest, 'UC submission content digest drift');
expect(sha(srSub.content) === srSub.contentDigest, 'requirements submission content digest drift');
expect(sha(accSub.content) === accSub.contentDigest, 'acceptance submission content digest drift');
expect(sha(accReview.content) === accReview.contentDigest, 'reviewer decision content digest drift');
expect(srArt.content.governingContractRef === shaRef(GOVERNING), 'requirements governing contract pin drift');
expect(accArt.content.governingContractRef === shaRef(GOVERNING), 'acceptance governing contract pin drift');
expect(srArt.content.workspaceSummary === WORKSPACE_SUMMARY, 'requirements workspace summary drift');
expect(accArt.content.workspaceSummary === WORKSPACE_SUMMARY, 'acceptance workspace summary drift');

/* Reviewer decision: the candidate of record is the AUTHOR's published
   candidate, and the verdict is 'accepted' - only then is it consumed. */
const review = accReview.content;
expect(review.verdict === 'accepted', 'reviewer verdict is not accepted');
expect(review.reviewedCandidate.submissionRef === accSub.submissionRef, 'reviewed submission ref does not match the published author submission');
expect(review.reviewedCandidate.artifactRef === accArt.artifactRef, 'reviewed artifact ref does not match the published author artifact');
expect(review.reviewedCandidate.traceRef === accTrc.traceRef, 'reviewed trace ref does not match the published author trace');
expect(review.reviewedCandidate.productSeal === accArt.content.productSeal.ref, 'reviewed product seal does not match the published acceptance bundle seal');

const SR_PRODUCT = srArt.content.product;
expect(SR_PRODUCT.schemaVersion === 'frf-contracts.requirements-bundle.v1', 'requirements bundle schema drift');
const ACC_PRODUCT = accArt.content.product;
expect(ACC_PRODUCT.schemaVersion === accCell.ACCEPTANCE_BUNDLE_SCHEMA_VERSION, 'acceptance bundle schema drift');

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
const accIntentSet = accArt.content.upstream.acceptedIntentSet;
expect(upFold.set.revisionDigest === accIntentSet.revisionDigest, 'accepted PRD revision pin drift vs acceptance upstream');
expect(JSON.stringify([...upFold.set.prdMemberIds].sort()) === JSON.stringify([...accIntentSet.prdMemberIds].sort()), 'accepted PRD member id set drift');
expect(JSON.stringify([...upFold.set.memberDigests].sort()) === JSON.stringify([...accIntentSet.memberDigests].sort()), 'accepted PRD member digest set drift');
for (const declared of accArt.content.upstream.acceptedIntentSeals) {
  expect(upSeal.get(declared.memberId) === declared.digest, `intent seal drift for ${declared.memberId}`);
}

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
const accUcSet = accArt.content.upstream.acceptedUcSet;
expect(JSON.stringify(acceptedUcSet.scenarioIds) === JSON.stringify(accUcSet.scenarioIds), 'accepted UC scenario id set drift vs acceptance upstream');
for (const declared of accArt.content.upstream.acceptedUcSeals) {
  expect(ucSeal.get(declared.scenarioId) === declared.digest, `UC seal drift for ${declared.scenarioId}`);
}

/* Requirements member seals recomputed over canonical members. */
const requirementSeal = new Map();
for (const r of SR_PRODUCT.requirements) {
  requirementSeal.set(r.requirementId, sha(r));
}
for (const declared of srArt.content.memberSeals) {
  expect(requirementSeal.get(declared.requirementId) === declared.digest, `requirement seal drift for ${declared.requirementId}`);
}
for (const declared of accArt.content.upstream.acceptedRequirementSeals) {
  expect(requirementSeal.get(declared.requirementId) === declared.digest, `requirement seal drift vs acceptance upstream for ${declared.requirementId}`);
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

/* The accepted acceptance bundle must re-seal against the re-derived
   acceptance universe (the same inputs the acceptance gate consumed). */
const accUniverse = accCell.acceptanceUniverseFrom({
  requirementsBundle: SR_PRODUCT,
  useCases: { scenarioIds: acceptedUcSet.scenarioIds, branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
  verifiableStatementIds: accArt.content.deskInput.verifiableStatementIds,
  evidenceBindings: accArt.content.deskInput.evidenceBindings,
});
if (!accUniverse.ok) throw new Error(`acceptance universe refuses: ${accUniverse.reason}: ${accUniverse.detail}`);
const accSealedNow = accCell.validateAcceptanceBundle(ACC_PRODUCT, accUniverse.universe, SR_PRODUCT.requirements);
if (!accSealedNow.ok) throw new Error(`accepted acceptance bundle refuses: ${accSealedNow.reason}: ${accSealedNow.detail}`);
expect(accSealedNow.artifact.ref === accArt.content.productSeal.ref, 'accepted acceptance bundle seal drift');

/* Envelope: every task-projection content address must re-derive from the
   accepted capsule material recorded upstream. */
const envelopeEntries = Object.entries(ENVELOPE);
expect(accArt.content.upstream.verifiedAgainstTaskProjection === true, 'upstream did not declare task-projection verification');
expect(accArt.content.upstream.verifiedSubArtifacts.length === envelopeEntries.length, 'upstream verified-sub-artifact count drift');
for (const { id, digest, ref } of accArt.content.upstream.verifiedSubArtifacts) {
  expect(ENVELOPE[id] === digest && ref === shaRef(digest), `envelope drift for ${id}`);
}

const criterionSeal = new Map(ACC_PRODUCT.criteria.map((c) => [c.criterionId, sha(c)]));
const statementSeal = new Map(accArt.content.verifiableStatements.map((s) => [s.statementId, s.digest]));
for (const declared of accArt.content.memberSeals) {
  expect(criterionSeal.get(declared.criterionId) === declared.digest, `criterion seal drift for ${declared.criterionId}`);
}

/* ------------------------------------------------------------------ */
/* The snapshot (exactly what the kernel dispatch feeds the reconciler) */
/* ------------------------------------------------------------------ */

/* Claim -> intent member mapping, derived from the ACCEPTED members' own
   claim citations (first member in sorted member order wins the row). */
const claimIds = Object.keys(ENVELOPE).filter((id) => id.startsWith('claim:')).sort();
const claimMembers = new Map();
for (const memberId of [...upFold.set.prdMemberIds].sort()) {
  const member = upArt.content.members.find((m) => m.memberId === memberId);
  for (const claimId of member.sourceClaimRefs ?? []) {
    if (!claimIds.includes(claimId)) throw new Error(`accepted member ${memberId} cites non-envelope claim ${claimId}`);
    if (!claimMembers.has(claimId)) claimMembers.set(claimId, []);
    claimMembers.get(claimId).push(memberId);
  }
}
for (const claimId of claimIds) {
  expect(claimMembers.has(claimId), `envelope claim ${claimId} is cited by no accepted intent member`);
}
const claimToMember = Object.fromEntries(claimIds.map((claimId) => [claimId, claimMembers.get(claimId)[0]]));

const snapshot = {
  universe: accUniverse.universe,
  requirements: SR_PRODUCT.requirements,
  acceptance: {
    criteria: ACC_PRODUCT.criteria,
    deferrals: ACC_PRODUCT.deferrals ?? [],
    standaloneEvidenceBindings: ACC_PRODUCT.standaloneEvidenceBindings ?? [],
  },
  prd: {
    memberIds: [...upFold.set.prdMemberIds],
    scenarioRequiredMemberIds: [...upFold.set.scenarioRequiredMemberIds],
  },
  useCases: {
    scenarioIds: [...acceptedUcSet.scenarioIds],
    branchIdsByScenario: { ...acceptedUcSet.branchIdsByScenario },
  },
  sourceClaims: { claimIds, claimToMember },
};

/* ------------------------------------------------------------------ */
/* The computed report (REAL reconcileWhat; verdict never a parameter)  */
/* ------------------------------------------------------------------ */

const report = accCell.reconcileWhat(snapshot);
if (report.verdict !== 'consistent') {
  throw new Error(`reconciliation is not consistent: ${report.findings.length} typed finding(s): ${JSON.stringify(report.gaps)} - a lawful repair belongs in the OWNING upstream cell, not here`);
}
const reportDigest = report.reportDigest;

/* ------------------------------------------------------------------ */
/* Desk projection: full claim coverage over the accepted mapping       */
/* ------------------------------------------------------------------ */

const claimCoverage = claimIds.map((claimId) => {
  const memberRefs = claimMembers.get(claimId);
  const requirementRefs = SR_PRODUCT.requirements
    .filter((r) => (r.derivation?.prdIntentRefs ?? []).some((ref) => memberRefs.includes(ref)))
    .map((r) => r.requirementId)
    .sort();
  const criterionRefs = ACC_PRODUCT.criteria
    .filter((c) => (c.bindsTo?.requirementRefs ?? []).some((ref) => requirementRefs.includes(ref)))
    .map((c) => c.criterionId)
    .sort();
  return {
    claimId,
    digest: ENVELOPE[claimId],
    ref: shaRef(ENVELOPE[claimId]),
    memberRefs,
    rowMemberRef: claimToMember[claimId],
    requirementRefs,
    criterionRefs,
    note: 'memberRefs is the full accepted mapping (a claim may formalize into several members); rowMemberRef is the row mapping the kernel report carries (first member in sorted order).',
  };
});

/* ------------------------------------------------------------------ */
/* Artifact 1: the desk artifact (content-addressed envelope)           */
/* ------------------------------------------------------------------ */

const artifactContent = {
  schemaVersion: accCell.RECONCILIATION_REPORT_KIND,
  deskRef: 'reconcile-what',
  deskNodeId: 'reconcile-what',
  role: 'author',
  itemInstanceId: 'formalization-item:reconcile-what',
  token: 'plan:formalization#item:reconcile-what',
  productKind: 'formalization.what-reconciliation.v1',
  effectId: 'formalization.accept-products',
  checkProviderId: 'formalization.reconciliation-structure.v1',
  deskSkillId: 'formalization-desk-reconcile-what',
  brief: 'Report-only reconciliation of the closed WHAT chain over the exact accepted upstream chain (accepted define-product-intent bundle, accepted model-use-cases scenario bundle, accepted derive-system-requirements bundle, reviewer-accepted define-acceptance-contract bundle): the report is COMPUTED by the REAL installed reconciliation surface acceptance.reconcileWhat over a snapshot recomputed from accepted material only (acceptance universe re-derived through the REAL acceptanceUniverseFrom protocol; requirements re-sealed through the REAL WP03 validator; acceptance bundle re-sealed through the REAL validateAcceptanceBundle). The verdict is never hardcoded, never a parameter, never trusted from input. prd:scope-2 (out_of_scope) carries an honest empty row; unknown:browser-matrix-1 stays carried_forward with owner discovery and derives nothing; constraint:retention-1 is honored through ac:determinism-1 and ac:outcome-1-deterministic-error.',
  product: report,
  reportOnlyLaw: 'the reconciler validates and reports; it adds, deletes and patches nothing; a lawful repair is a new immutable revision in the OWNING upstream cell (plan "#Desk contracts/reconcile-what")',
  snapshotProvenance: {
    universeSource: 'acceptanceUniverseFrom over the accepted requirements bundle, the accepted UC scenario set and the accepted define-acceptance-contract deskInput (verifiable statement ids + standalone evidence bindings)',
    requirementsSource: 'the accepted derive-system-requirements bundle (frf-contracts.requirements-bundle.v1), re-sealed through the REAL WP03 validator',
    prdSource: { memberIds: [...upFold.set.prdMemberIds].sort(), scenarioRequiredMemberIds: [...upFold.set.scenarioRequiredMemberIds].sort() },
    useCasesSource: { scenarioIds: [...acceptedUcSet.scenarioIds].sort(), branchIdsByScenario: acceptedUcSet.branchIdsByScenario },
    sourceClaimsSource: 'claim ids from this desk task projection; claimToMember derived from the ACCEPTED intent members\' own claim citations (first member in sorted order wins the row)',
    claimToMember,
  },
  claimCoverage,
  upstream: {
    materialAuthority: 'the accepted define-product-intent bundle, the accepted model-use-cases scenario bundle, the accepted derive-system-requirements bundle and the reviewer-accepted define-acceptance-contract bundle, traveling by content address',
    acceptedIntentArtifactRef: accArt.content.upstream.acceptedIntentArtifactRef,
    acceptedIntentArtifactDigest: accArt.content.upstream.acceptedIntentArtifactDigest,
    acceptedIntentTraceRef: accArt.content.upstream.acceptedIntentTraceRef,
    acceptedIntentSubmissionRef: accArt.content.upstream.acceptedIntentSubmissionRef,
    acceptedUcArtifactRef: ucArt.artifactRef,
    acceptedUcArtifactDigest: ucArt.contentDigest,
    acceptedUcTraceRef: ucTrc.traceRef,
    acceptedUcSubmissionRef: ucSub.submissionRef,
    acceptedRequirementsArtifactRef: srArt.artifactRef,
    acceptedRequirementsArtifactDigest: srArt.contentDigest,
    acceptedRequirementsTraceRef: srTrc.traceRef,
    acceptedRequirementsSubmissionRef: srSub.submissionRef,
    acceptedAcceptanceArtifactRef: accArt.artifactRef,
    acceptedAcceptanceArtifactDigest: accArt.contentDigest,
    acceptedAcceptanceTraceRef: accTrc.traceRef,
    acceptedAcceptanceSubmissionRef: accSub.submissionRef,
    acceptanceReviewerReviewRef: accReview.artifactRef,
    acceptanceReviewerVerificationRef: review.verificationRef,
    importArtifactRef: accArt.content.upstream.importArtifactRef,
    capsuleRef: accArt.content.upstream.capsuleRef,
    certificateRef: accArt.content.upstream.certificateRef,
    acceptedIntentSet: {
      memberDigests: [...upFold.set.memberDigests].sort(),
      prdMemberIds: [...upFold.set.prdMemberIds].sort(),
      revisionDigest: upFold.set.revisionDigest,
      scenarioRequiredMemberIds: [...upFold.set.scenarioRequiredMemberIds].sort(),
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
    acceptedAcceptanceSeal: { digest: accArt.content.productSeal.digest, ref: accArt.content.productSeal.ref },
    acceptedIntentSeals: [...upSeal.entries()].map(([memberId, digest]) => ({ memberId, digest, ref: shaRef(digest) })),
    acceptedUcSeals: [...ucSeal.entries()].map(([scenarioId, digest]) => ({ scenarioId, digest, ref: shaRef(digest) })),
    acceptedRequirementSeals: [...requirementSeal.entries()].map(([requirementId, digest]) => ({ requirementId, digest, ref: shaRef(digest) })),
    acceptedCriterionSeals: [...criterionSeal.entries()].map(([criterionId, digest]) => ({ criterionId, digest, ref: shaRef(digest) })),
    verifiedSubArtifacts: envelopeEntries.map(([id, digest]) => ({ id, digest, ref: shaRef(digest) })),
    verifiedAgainstTaskProjection: true,
  },
  constraintDispositions: [
    {
      constraintId: 'constraint:retention-1',
      digest: ENVELOPE['constraint:retention-1'],
      disposition: 'honored',
      enforcedBy: ['ac:determinism-1', 'ac:outcome-1-deterministic-error'],
      constrainedCriteria: ['ac:boundary-1', 'ac:outcome-1-delivered', 'ac:outcome-1-deterministic-error', 'ac:terminal-1-audited'],
      note: 'The reconciliation observes the constraint honored through the accepted criteria that enforce it (the determinism NFR binds the constraint directly upstream); the reconciler itself adds no enforcement.',
    },
  ],
  unknownDispositions: [
    {
      unknownId: 'unknown:browser-matrix-1',
      digest: ENVELOPE['unknown:browser-matrix-1'],
      disposition: 'carried_forward',
      owner: 'discovery',
      note: 'No resolution edge is recorded: the reconciler does not resolve the browser support matrix unknown; no criterion, evidence kind, verifiable statement or observable terminal result is derived from it.',
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
    acceptanceBundleResealedAgainstRecomputedUniverse: true,
    claimDigestsMatchedTaskProjection: true,
    computedVerdictNeverHardcoded: true,
    declaredDigestsTrusted: false,
    deterministicAuthoring: true,
    memberSealsRecomputedOverCanonicalMembers: true,
    reportFrozenDeepImmutable: true,
    reportOnlyNoMutations: true,
    reviewerAcceptedCandidateOfRecord: true,
    revisionPinsMatchAcceptedRevisions: true,
    snapshotRecomputedFromAcceptedMaterial: true,
    staleProtocolRefusals: 0,
    upstreamRequirementsBundleReverified: true,
    wp03SeamRefusals: 0,
  },
};

const artifact = {
  artifactRef: shaRef(sha(artifactContent)),
  artifactKind: 'what-reconciliation',
  productKind: 'formalization.what-reconciliation.v1',
  contentDigest: sha(artifactContent),
  semanticCode: 'SR-Reconcile-What-001',
  createdAt: CREATED_AT,
  deskRef: 'reconcile-what',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: artifactContent,
};

/* ------------------------------------------------------------------ */
/* Artifact 2: the trace (relationships resolve to recomputed digests)  */
/* ------------------------------------------------------------------ */

const branchOwner = new Map();
for (const [scenarioId, branchIds] of Object.entries(acceptedUcSet.branchIdsByScenario)) {
  for (const branchId of branchIds) branchOwner.set(branchId, scenarioId);
}
const reportDigestHex = reportDigest.replace(/^sha256:/, '');
const resolveId = (id) => {
  if (id === 'report') return reportDigestHex;
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (criterionSeal.has(id)) return criterionSeal.get(id);
  if (requirementSeal.has(id)) return requirementSeal.get(id);
  if (ucSeal.has(id)) return ucSeal.get(id);
  if (upSeal.has(id)) return upSeal.get(id);
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
  ...ACC_PRODUCT.criteria.map((c) =>
    rel('report', 'reconciles', c.criterionId, `The computed reconciliation report closes the reverse direction through criterion ${c.criterionId} (WP03 seam per criterion; refusals would be named findings).`)),
  ...SR_PRODUCT.requirements.map((r) =>
    rel('report', 'reconciles', r.requirementId, `The computed reconciliation report closes the chain layer of ${r.requirementId} (requirement coverage and terminal-result coverage).`)),
  ...claimIds.flatMap((claimId) =>
    claimMembers.get(claimId).map((memberId) =>
      rel(claimId, 'formalized-as', memberId, `Discovery claim ${claimId} formalizes into accepted intent member ${memberId} (the member's own claim citation; ${claimToMember[claimId] === memberId ? 'this citation is the row mapping' : 'additional citation beyond the row mapping'}).`))),
];

const edgeProjection = (fromId, relation) =>
  relationships.filter((r) => r.fromId === fromId && r.relation === relation).map((r) => r.toId).sort();

const traceContent = {
  deskRef: 'reconcile-what',
  role: 'author',
  traceKind: 'what-reconciliation-trace',
  subjectSemanticCode: 'SR-Reconcile-What-001',
  subjectArtifactRef: artifact.artifactRef,
  relationVocabulary: ['formalized-as', 'reconciles'],
  relationships,
  reportCoverage: {
    digest: reportDigestHex,
    reconciles: edgeProjection('report', 'reconciles'),
  },
  claimCoverage: Object.fromEntries(claimCoverage.map((c) => [c.claimId, {
    digest: c.digest,
    formalizedAs: relationships.filter((r) => r.relation === 'formalized-as' && r.fromId === c.claimId).map((r) => r.toId).sort(),
    rowMemberRef: c.rowMemberRef,
    requirementRefs: c.requirementRefs,
    criterionRefs: c.criterionRefs,
  }])),
  layerAnchors: {
    prdRevision: { digest: upFold.set.revisionDigest, ref: shaRef(upFold.set.revisionDigest) },
    ucRevision: { digest: ucRevisionDigest, ref: shaRef(ucRevisionDigest) },
    acceptanceSeal: { digest: accArt.content.productSeal.digest, ref: accArt.content.productSeal.ref },
    requirementsReseal: { ref: srSealedNow.ref },
  },
  verdictProvenance: {
    verdict: report.verdict,
    findingsCount: report.findings.length,
    computedBy: report.reconciledBy,
    computedVerdictLaw: "verdict === 'gaps' iff findings.length > 0; 'consistent' iff findings.length === 0 (the F-2 fix; the reconciler takes no verdict input)",
  },
  constraintCoverage: {
    constraintId: 'constraint:retention-1',
    digest: ENVELOPE['constraint:retention-1'],
    disposition: 'honored',
    enforcedBy: ['ac:determinism-1', 'ac:outcome-1-deterministic-error'],
  },
  unknownCoverage: {
    unknownId: 'unknown:browser-matrix-1',
    digest: ENVELOPE['unknown:browser-matrix-1'],
    disposition: 'carried_forward',
    owner: 'discovery',
    note: 'No resolution edge is recorded: the unknown travels with the capsule; nothing is derived from it.',
  },
  terminalCoverage: {
    'terminal:audited-1': {
      digest: ENVELOPE['terminal:audited-1'],
      supportedBy: ['ac:terminal-1-audited'],
    },
    'terminal:delivered-1': {
      digest: ENVELOPE['terminal:delivered-1'],
      supportedBy: ['ac:outcome-1-delivered'],
    },
  },
  workspaceSummary: WORKSPACE_SUMMARY,
};

const trace = {
  traceRef: shaRef(sha(traceContent)),
  traceKind: 'what-reconciliation-trace',
  contentDigest: sha(traceContent),
  createdAt: CREATED_AT,
  deskRef: 'reconcile-what',
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
  srArt.contentDigest,
  accArt.contentDigest,
  accArt.content.upstream.importArtifactRef,
  accArt.content.upstream.capsuleRef,
  accArt.content.upstream.certificateRef,
  ...Object.values(ENVELOPE),
  GOVERNING,
  SEMANTIC_SKILL,
  accArt.content.upstream.acceptedIntentTraceRef,
  accArt.content.upstream.acceptedIntentSubmissionRef,
  ucTrc.contentDigest,
  ucSub.contentDigest,
  srTrc.contentDigest,
  srSub.contentDigest,
  accTrc.contentDigest,
  accSub.contentDigest,
  accReview.contentDigest,
  review.verificationRef,
  reportDigestHex,
].map(shaRef);

const submissionContent = {
  deskRef: 'reconcile-what',
  deskNodeId: 'reconcile-what',
  role: 'author',
  itemInstanceId: 'formalization-item:reconcile-what',
  token: 'plan:formalization#item:reconcile-what',
  candidate: {
    kind: 'formalization.what-reconciliation.v1',
    artifactRef: artifact.artifactRef,
    contentDigest: artifact.contentDigest,
  },
  payloadContract: {
    productKind: 'formalization.what-reconciliation.v1',
    effectId: 'formalization.accept-products',
    requiredEvidenceRefs,
    evidenceKindCoverage: {
      'accepted-prd-intent-bundle': 1,
      'accepted-uc-scenarios-bundle': 1,
      'accepted-requirements-bundle': 1,
      'accepted-acceptance-bindings-bundle': 1,
      'accepted-acceptance-trace': 1,
      'accepted-acceptance-submission': 1,
      'acceptance-formalization-review': 1,
      'discovery-import-artifact': 1,
      'discovery-handoff-capsule': 1,
      'discovery-certificate': 1,
      'source-claim': 4,
      constraint: 1,
      unknown: 1,
      'terminal-claim': 2,
      'protocol-skill': 1,
      'semantic-skill': 1,
      'accepted-intent-trace': 1,
      'accepted-intent-submission': 1,
      'accepted-uc-trace': 1,
      'accepted-uc-submission': 1,
      'accepted-requirements-trace': 1,
      'accepted-requirements-submission': 1,
      'computed-reconciliation-report': 1,
    },
    terminalOutcome: 'success',
  },
  traceRef: trace.traceRef,
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#reconcile-what:author',
    status: 'admitted_for_reviewer_stage',
    receivedFrom: 'author',
    nextStage: 'reviewer',
    note: 'The kernel-side product submission (product_submit against the workflow kernel) is executed by the driver over public commands; this receipt records desk-level intake of the authored candidate only.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed desk artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'The product is the COMPUTED report of the REAL installed reconciliation surface acceptance.reconcileWhat over a snapshot recomputed from accepted material; the verdict is never hardcoded, never a parameter, never trusted from input', satisfied: true },
    { id: 3, description: 'Report-only law: the desk adds, deletes and patches no accepted artifact, member or trace; a lawful repair would be a new immutable revision in the OWNING upstream cell', satisfied: true },
    { id: 4, description: 'The snapshot carries every chain layer (universe, requirements, acceptance criteria/deferrals/standalone evidence bindings, prd member ids + scenario-required member ids, UC scenario ids + branch ids) exactly as the kernel dispatch feeds the reconciler', satisfied: true },
    { id: 5, description: 'Chain closure recomputed: forward (every scenario-required member and accepted scenario reaches downstream material) and reverse (every criterion resolves through the WP03 seam against the re-derived universe; all three closure laws re-run) - zero typed findings', satisfied: true },
    { id: 6, description: 'Claim coverage rows keep the installed formalization.what-reconciliation.v1 row shape; prd:scope-2 (out_of_scope) carries an honest empty row and derives nothing', satisfied: true },
    { id: 7, description: 'Upstream re-verified before consumption: artifact/trace/submission digests recomputed, intent/UC/requirement/criterion seals recomputed, revision pins matched through the REAL folds, the accepted requirements bundle re-sealed through WP03 and the accepted acceptance bundle re-sealed through the REAL cell validator against the re-derived universe', satisfied: true },
    { id: 8, description: 'Reviewer gate: the define-acceptance-contract reviewer decision artifact says accepted over exactly the published author candidate (submission/artifact/trace/product seal refs match) - the candidate of record is consumed, nothing else', satisfied: true },
    { id: 9, description: 'constraint:retention-1 observed honored through ac:determinism-1 and ac:outcome-1-deterministic-error; unknown:browser-matrix-1 carried forward with owner discovery and no fabricated resolution edge; terminal claims stay owned upstream (prd:terminal-1, prd:outcome-1)', satisfied: true },
    { id: 10, description: 'Trace relationships all resolve against recomputed digests; coverage blocks are exact projections of the edge set; the report edge anchor resolves to the report digest', satisfied: true },
    { id: 11, description: 'Deterministic authoring: pinned timestamps, no clock reads, no randomness; the report is deep-frozen by the reconciler and the desk mutates no input', satisfied: true },
    { id: 12, description: '0 accepted upstream revisions travel by content address', satisfied: true },
  ],
  workspaceSummary: WORKSPACE_SUMMARY,
};

const submission = {
  submissionRef: shaRef(sha(submissionContent)),
  submissionId: 'FS-Reconcile-What-001',
  contentDigest: sha(submissionContent),
  createdAt: CREATED_AT,
  deskRef: 'reconcile-what',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: submissionContent,
};

/* ------------------------------------------------------------------ */
/* Write the three desk artifacts                                       */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('reconcile-what-desk-what-reconciliation.artifact.json', artifact);
writeJson('reconcile-what-desk-what-reconciliation-trace.json', trace);
writeJson('reconcile-what-desk-product-submission.json', submission);

console.log(JSON.stringify({
  built: 'reconcile-what desk (author) artifacts',
  verdict: report.verdict,
  findings: report.findings.length,
  rows: report.rows.length,
  reportDigest,
  prdRevision: shaRef(upFold.set.revisionDigest),
  ucRevision: shaRef(ucRevisionDigest),
  requirementsReseal: srSealedNow.ref,
  acceptanceReseal: accSealedNow.artifact.ref,
  artifactRef: artifact.artifactRef,
  traceRef: trace.traceRef,
  submissionRef: submission.submissionRef,
}, null, 2));
