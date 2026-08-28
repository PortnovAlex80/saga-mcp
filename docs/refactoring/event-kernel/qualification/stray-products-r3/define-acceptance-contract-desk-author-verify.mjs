/**
 * define-acceptance-contract desk (author) - digest + contract recomputation
 * evidence.
 *
 * Frozen kernel rule: src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Re-runs the REAL cell validator (validateAcceptanceBundle through the
 * REAL acceptanceUniverseFrom desk protocol, which drives the WP03
 * validateAcBinding seam per criterion), re-folds ALL THREE upstream
 * sets with the REAL validators + REAL cell folds, re-seals the accepted
 * requirements bundle against its recomputed universe BEFORE consuming
 * it, recomputes EVERY declared digest (submission, artifact, trace,
 * five criterion seals, five statement seals), negative-probes the seam
 * and the closure laws (stripped branch citation, foreign scenario,
 * foreign requirement, uncovered requirement, WHAT-side key injection),
 * re-derives the trace coverage projections from the edge set, and
 * cross-checks the task-projection content addresses and the payload
 * contract evidence set. Nothing is trusted by declaration.
 *
 * Run: node define-acceptance-contract-desk-author-verify.mjs
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

const sub = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-product-submission.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings-trace.json'), 'utf8'));
const upArt = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));
const ucArt = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json'), 'utf8'));
const ucTrc = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios-trace.json'), 'utf8'));
const ucSub = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-product-submission.json'), 'utf8'));
const srArt = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-system-requirements.artifact.json'), 'utf8'));
const srTrc = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-system-requirements-trace.json'), 'utf8'));
const srSub = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-product-submission.json'), 'utf8'));

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); return ok; };

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
const CAPSULE = 'f3f98175f061fa289d49f4684f78273022c97b9e12bc535255c4b3d4c6a0534e';
const CERT = '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21';
const IMPORT = 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const WS = '0 accepted upstream revisions travel by content address';
const PINNED_AT = '2026-08-28T00:00:00Z';

/* A. artifact self-address + kind pins */
check('A1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('A2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('A3.artifact.kindPins', art.content.schemaVersion === 'formalization.acceptance-bindings.v1'
  && art.productKind === 'formalization.acceptance-bindings.v1'
  && art.content.productKind === 'formalization.acceptance-bindings.v1'
  && art.content.contractKind === 'frf-contracts.ac-binding.v1'
  && art.content.checkProviderId === 'frf.acceptance-closure.v1'
  && art.content.deskSkillId === 'formalization-desk-define-acceptance-contract'
  && art.deskRef === 'define-acceptance-contract' && art.role === 'author', 'desk product kind + WP03 contract + cell provider pins');
check('A4.artifact.productSeal.declared', art.content.productSeal.ref === shaRef(art.content.productSeal.digest), art.content.productSeal.ref);

/* B. all three upstream folds through the REAL validators + REAL folds */
const upSeal = new Map();
for (const m of upArt.content.members) {
  const v = prd03.validatePrdIntentMember(m, {
    idSets: {
      sourceClaimIds: Object.keys(ENVELOPE).filter((id) => id.startsWith('claim:')),
      terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'],
    },
  });
  const digest = sha(m);
  const declared = upArt.content.memberSeals.find((s) => s.memberId === m.memberId)?.digest;
  check(`B1.upstreamMember.${m.memberId ?? '?'}`, v.ok && digest === declared, v.ok ? `PRD seal recomputed ${digest.slice(0, 16)}…` : `WP03 PRD refusal ${v.reason}: ${v.detail}`);
  upSeal.set(m.memberId, digest);
}
const upFold = upCell.acceptedIntentSetOf(
  { members: upArt.content.members },
  upArt.content.members.map((m) => ({ memberId: m.memberId, digest: upSeal.get(m.memberId) })),
);
check('B2.upstreamIntentFold.ok', upFold.ok && shaRef(upFold.set.revisionDigest) === srArt.content.product.prdRevisionRef, upFold.ok ? `revisionDigest ${upFold.set.revisionDigest.slice(0, 16)}… pins the accepted requirements bundle` : upFold.detail);

const ucSeal = new Map();
for (const s of ucArt.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, { idSets: { prdMemberIds: upFold.set.prdMemberIds } });
  const digest = sha(s);
  const declared = ucArt.content.scenarioSeals.find((x) => x.scenarioId === s.scenarioId)?.digest;
  check(`B3.upstreamScenario.${s.scenarioId ?? '?'}`, v.ok && digest === declared, v.ok ? `UC seal recomputed ${digest.slice(0, 16)}…` : `WP03 UC refusal ${v.reason}: ${v.detail}`);
  ucSeal.set(s.scenarioId, digest);
}
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
check('B4.upstreamUcRevision.pin', shaRef(ucRevisionDigest) === srArt.content.product.ucRevisionRef, `recomputed ${ucRevisionDigest.slice(0, 16)}… pins the accepted requirements bundle`);

const SR_PRODUCT = srArt.content.product;
const requirementSeal = new Map(SR_PRODUCT.requirements.map((r) => [r.requirementId, sha(r)]));
for (const [requirementId, digest] of requirementSeal) {
  const declared = srArt.content.memberSeals.find((x) => x.requirementId === requirementId)?.digest;
  check(`B5.upstreamRequirement.${requirementId}`, digest === declared, `requirement seal recomputed ${digest.slice(0, 16)}…`);
}
const branchIdsByScenario = Object.fromEntries(
  ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)]),
);
const srUniverse = srCell.deriveAcceptedUniverse({
  prd: { revisionDigest: upFold.set.revisionDigest, memberIds: [...upFold.set.prdMemberIds] },
  useCases: { revisionDigest: ucRevisionDigest, scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(), branchIdsByScenario },
  sourceConstraintIds: ['constraint:retention-1'],
  verificationSurfaceIds: srArt.content.deskInput.verificationSurfaceIds,
});
const srSealedNow = srUniverse.ok ? wp03sr.validateRequirementsBundle(SR_PRODUCT, srUniverse.universe) : { ok: false, detail: srUniverse.detail };
check('B6.upstreamRequirementsRevalidated', srUniverse.ok && srSealedNow.ok, srSealedNow.ok ? `accepted requirements bundle re-sealed ${srSealedNow.ref.slice(0, 24)}… against its recomputed universe` : `${srSealedNow.reason ?? ''}: ${srSealedNow.detail ?? ''}`);

/* C. the authored bundle through the REAL cell surface */
const acceptedUcSet = {
  scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(),
  branchIdsByScenario,
};
const universe = accCell.acceptanceUniverseFrom({
  requirementsBundle: SR_PRODUCT,
  useCases: acceptedUcSet,
  verifiableStatementIds: art.content.deskInput.verifiableStatementIds,
  evidenceBindings: art.content.deskInput.evidenceBindings,
});
check('C1.universe.protocol', universe.ok, universe.ok ? `id sets: fr=${universe.universe.idSets.frIds.length} nfr=${universe.universe.idSets.nfrIds.length} scenarios=${universe.universe.idSets.ucScenarioIds.length} branches=${Object.values(branchIdsByScenario).flat().length} stmts=${universe.universe.idSets.verifiableStatementIds.length}` : `${universe.reason}: ${universe.detail}`);
const resealed = universe.ok ? accCell.validateAcceptanceBundle(art.content.product, universe.universe, SR_PRODUCT.requirements) : { ok: false };
check('C2.product.seal', resealed.ok && resealed.artifact.digest === art.content.productSeal.digest, resealed.ok ? `REAL validateAcceptanceBundle re-seal ${resealed.artifact.ref.slice(0, 24)}… matches the declared product seal` : `${resealed.reason ?? ''}: ${resealed.detail ?? ''}`);
for (const criterion of art.content.product.criteria) {
  const v = universe.ok ? accCell.validateAcBinding(criterion, universe.universe) : { ok: false };
  const digest = sha(criterion);
  const declared = art.content.memberSeals.find((x) => x.criterionId === criterion.criterionId)?.digest;
  check(`C3.criterion.${criterion.criterionId}`, v.ok && digest === declared && v.digest === digest, v.ok ? `WP03 seam sealed ${v.ref.slice(0, 24)}…; seal recomputed ${digest.slice(0, 16)}…` : `seam refusal ${v.reason}: ${v.detail}`);
}

/* Statement material + seal resolution */
for (const declared of art.content.verifiableStatements) {
  const digest = sha({ statementId: declared.statementId, statement: declared.statement });
  check(`C4.statement.${declared.statementId}`, digest === declared.digest && art.content.deskInput.verifiableStatementIds.includes(declared.statementId), `statement seal recomputed ${digest.slice(0, 16)}…; resolves in the accepted desk input set`);
}

/* D. closure laws re-run directly + negative probes */
const d1 = accCell.checkRequirementsCoverageClosure(art.content.product.criteria, art.content.product.deferrals ?? [], universe.universe);
check('D1.closure.requirementsCoverage', universe.ok && d1.length === 0, `issues: ${d1.length}`);
const d2 = accCell.checkAcToSourceClosure(art.content.product.criteria, SR_PRODUCT.requirements, universe.universe);
check('D2.closure.acToSource', universe.ok && d2.length === 0, `issues: ${d2.length}`);
const d3 = accCell.checkTerminalResultCoverage(art.content.product.criteria, art.content.product.standaloneEvidenceBindings ?? [], universe.universe);
check('D3.closure.terminalResultCoverage', universe.ok && d3.length === 0, `issues: ${d3.length}`);

const clone = (c, patch) => JSON.parse(JSON.stringify({ ...c, ...patch }));
const stripped = clone(art.content.product.criteria[0]);
delete stripped.bindsTo.ucTerminalBranchRefs;
const strippedRefusal = accCell.validateAcBinding(stripped, universe.universe);
check('D4.probe.strippedBranchCitation', !strippedRefusal.ok && strippedRefusal.reason === 'MISSING_LINEAGE', strippedRefusal.ok ? 'NOT KILLED' : `${strippedRefusal.reason}: ${strippedRefusal.detail.slice(0, 80)}…`);
const foreign = clone(art.content.product.criteria[0], { bindsTo: { ...art.content.product.criteria[0].bindsTo, ucScenarioRefs: ['uc:terminal-1'], ucTerminalBranchRefs: ['branch:terminal-1-main'] } });
const foreignProduct = { ...art.content.product, criteria: [foreign, ...art.content.product.criteria.slice(1)] };
const foreignRefusal = accCell.validateAcceptanceBundle(foreignProduct, universe.universe, SR_PRODUCT.requirements);
check('D5.probe.foreignScenarioSubstitution', !foreignRefusal.ok && foreignRefusal.reason === 'FOREIGN_LINEAGE', foreignRefusal.ok ? 'NOT KILLED' : `${foreignRefusal.reason}: ${foreignRefusal.detail.slice(0, 80)}…`);
const foreignReq = clone(art.content.product.criteria[0], { bindsTo: { requirementRefs: ['fr:foreign-1'], ucScenarioRefs: ['uc:boundary-1'], ucTerminalBranchRefs: ['branch:boundary-1-main'] } });
const foreignReqRefusal = accCell.validateAcBinding(foreignReq, universe.universe);
check('D6.probe.foreignRequirement', !foreignReqRefusal.ok && foreignReqRefusal.reason === 'FOREIGN_LINEAGE', foreignReqRefusal.ok ? 'NOT KILLED' : `${foreignReqRefusal.reason}: ${foreignReqRefusal.detail.slice(0, 80)}…`);
const uncovered = { ...art.content.product, criteria: art.content.product.criteria.filter((c) => c.criterionId !== 'ac:determinism-1') };
const uncoveredRefusal = accCell.validateAcceptanceBundle(uncovered, universe.universe, SR_PRODUCT.requirements);
check('D7.probe.uncoveredRequirement', !uncoveredRefusal.ok && uncoveredRefusal.reason === 'COVERAGE_GAP', uncoveredRefusal.ok ? 'NOT KILLED' : `${uncoveredRefusal.reason}: ${uncoveredRefusal.detail.slice(0, 80)}…`);
const whatSide = { ...art.content.product, files: ['src/any.ts'] };
const whatSideRefusal = accCell.validateAcceptanceBundle(whatSide, universe.universe, SR_PRODUCT.requirements);
check('D8.probe.whatSideKey', !whatSideRefusal.ok && whatSideRefusal.reason === 'SCOPE_VIOLATION', whatSideRefusal.ok ? 'NOT KILLED' : `${whatSideRefusal.reason}: ${whatSideRefusal.detail.slice(0, 80)}…`);

/* E. envelope + authority cross-checks */
for (const [id, digest] of Object.entries(ENVELOPE)) {
  const declared = art.content.upstream.verifiedSubArtifacts.find((x) => x.id === id);
  check(`E1.envelope.${id}`, declared !== undefined && declared.digest === digest, declared ? `digest matched ${digest.slice(0, 16)}…` : 'missing from verifiedSubArtifacts');
}
check('E2.governing.pin', art.content.governingContractRef === shaRef(GOVERNING) && srArt.content.governingContractRef === shaRef(GOVERNING), art.content.governingContractRef);
check('E3.workspace.summary', art.content.workspaceSummary === WS && trc.content.workspaceSummary === WS && sub.content.workspaceSummary === WS, WS);
check('E4.pinned.timestamps', art.createdAt === PINNED_AT && trc.createdAt === PINNED_AT && sub.createdAt === PINNED_AT, `all three pinned at ${PINNED_AT}`);

/* F. trace: resolution + projections re-derived from the edge set */
check('F1.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)} vs declared ${trc.contentDigest}`);
check('F2.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), trc.traceRef);
check('F3.trace.subjectBinding', trc.content.subjectArtifactRef === art.artifactRef && trc.content.subjectSemanticCode === art.semanticCode, trc.content.subjectArtifactRef);
const statementSeal = new Map(art.content.verifiableStatements.map((s) => [s.statementId, sha({ statementId: s.statementId, statement: s.statement })]));
const branchOwner = new Map();
for (const [scenarioId, branchIds] of Object.entries(branchIdsByScenario)) {
  for (const branchId of branchIds) branchOwner.set(branchId, scenarioId);
}
const resolveId = (id) => {
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (statementSeal.has(id)) return statementSeal.get(id);
  if (requirementSeal.has(id)) return requirementSeal.get(id);
  if (ucSeal.has(id)) return ucSeal.get(id);
  if (branchOwner.has(id)) return ucSeal.get(branchOwner.get(id));
  const criterion = art.content.product.criteria.find((c) => c.criterionId === id);
  if (criterion !== undefined) return sha(criterion);
  return undefined;
};
for (const r of trc.content.relationships) {
  const from = resolveId(r.fromId);
  const to = resolveId(r.toId);
  check(`F4.edge.${r.fromId}.${r.relation}.${r.toId}`, from !== undefined && to !== undefined && r.fromRef === shaRef(from) && r.toRef === shaRef(to), r.fromRef === shaRef(from) && r.toRef === shaRef(to) ? 'both ends resolve to recomputed digests' : `from ${r.fromRef} vs ${from && shaRef(from)}; to ${r.toRef} vs ${to && shaRef(to)}`);
}
const closedVocabulary = trc.content.relationVocabulary.slice().sort();
check('F5.trace.vocabularyClosed', JSON.stringify(closedVocabulary) === JSON.stringify(['cites', 'covers', 'supports', 'verifies'])
  && trc.content.relationships.every((r) => trc.content.relationVocabulary.includes(r.relation)), closedVocabulary.join(', '));
const proj = (fromId, relation) => trc.content.relationships.filter((r) => r.fromId === fromId && r.relation === relation).map((r) => r.toId).sort();
for (const [criterionId, block] of Object.entries(trc.content.criterionCoverage)) {
  const ok = JSON.stringify(block.verifies) === JSON.stringify(proj(criterionId, 'verifies'))
    && JSON.stringify(block.covers) === JSON.stringify(proj(criterionId, 'covers'))
    && JSON.stringify(block.cites) === JSON.stringify(proj(criterionId, 'cites'))
    && JSON.stringify(block.supports) === JSON.stringify(proj(criterionId, 'supports'))
    && block.digest === resolveId(criterionId);
  check(`F6.projection.criterion.${criterionId}`, ok, 'exact projection of the edge set + recomputed digest');
}
for (const [requirementId, block] of Object.entries(trc.content.requirementCoverage)) {
  const ok = JSON.stringify(block.verifiedBy) === JSON.stringify(trc.content.relationships.filter((r) => r.relation === 'verifies' && r.toId === requirementId).map((r) => r.fromId).sort())
    && block.digest === resolveId(requirementId);
  check(`F6.projection.requirement.${requirementId}`, ok, 'exact projection of the edge set + recomputed digest');
}
for (const [branchId, block] of Object.entries(trc.content.branchCoverage)) {
  const ok = block.owningScenario === branchOwner.get(branchId)
    && block.digest === ucSeal.get(branchOwner.get(branchId))
    && JSON.stringify(block.coveredBy) === JSON.stringify(trc.content.relationships.filter((r) => r.relation === 'covers' && r.toId === branchId).map((r) => r.fromId).sort());
  check(`F6.projection.branch.${branchId}`, ok, `resolves to owning scenario ${block.owningScenario} seal + exact edge projection`);
}
for (const [terminalId, block] of Object.entries(trc.content.terminalCoverage)) {
  const ok = block.digest === ENVELOPE[terminalId]
    && JSON.stringify(block.supportedBy) === JSON.stringify(trc.content.relationships.filter((r) => r.relation === 'supports' && r.toId === terminalId).map((r) => r.fromId).sort());
  check(`F6.projection.terminal.${terminalId}`, ok, 'exact projection of the edge set + envelope digest');
}

/* G. submission */
check('G1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('G2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);
check('G3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef
  && sub.content.candidate.contentDigest === art.contentDigest
  && sub.content.candidate.kind === 'formalization.acceptance-bindings.v1', sub.content.candidate.artifactRef);
check('G4.submission.traceBinding', sub.content.traceRef === trc.traceRef, sub.content.traceRef);
const expectedRefs = [
  srArt.contentDigest, ucArt.contentDigest, upArt.contentDigest, IMPORT, CAPSULE, CERT,
  ...Object.values(ENVELOPE), GOVERNING,
  '6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9',
  '91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0',
  ucTrc.contentDigest, ucSub.contentDigest, srTrc.contentDigest, srSub.contentDigest,
].sort();
const actualRefs = sub.content.payloadContract.requiredEvidenceRefs.map((r) => r.replace(/^sha256:/, '')).sort();
check('G5.submission.evidenceSet', JSON.stringify(actualRefs) === JSON.stringify([...new Set(expectedRefs)]) && new Set(actualRefs).size === actualRefs.length, `${actualRefs.length} unique evidence refs, envelope + upstream + governing included`);
const coverageSum = Object.values(sub.content.payloadContract.evidenceKindCoverage).reduce((a, b) => a + b, 0);
check('G6.submission.coverageSum', coverageSum === expectedRefs.length, `coverage sums to ${coverageSum} over ${expectedRefs.length} refs`);
check('G7.submission.intakeReceipt', sub.content.intakeReceipt.status === 'admitted_for_reviewer_stage'
  && sub.content.intakeReceipt.receivedFrom === 'author' && sub.content.intakeReceipt.nextStage === 'reviewer', sub.content.intakeReceipt.receiptRef);
check('G8.submission.selfCheck', sub.content.acceptanceCriteriaSelfCheck.every((c) => c.satisfied === true), `${sub.content.acceptanceCriteriaSelfCheck.length} self-check rows all satisfied`);

/* H. fence + deterministic-authoring laws over the authored bytes */
const productText = JSON.stringify(art.content.product);
check('H1.fence.noForbiddenKeys', ['files', 'moduleAllocation', 'participatingModules', 'architecture'].every((k) => !(k in art.content.product))
  && art.content.product.criteria.every((c) => ['files', 'moduleAllocation', 'participatingModules'].every((k) => !(k in c))), 'no WHAT-side allocation keys in the bundle or any criterion');
check('H2.fence.noOutOfScopeDerivation', !productText.includes('prd:scope-2') && !productText.includes('claim:scope-2'), 'out-of-scope intent member prd:scope-2 derives no criterion material');
check('H3.fence.unknownDerivesNothing', !productText.includes('unknown:browser-matrix-1'), 'unknown:browser-matrix-1 is cited in no criterion material');
const noClockOrRandom = (name) => !/Date\.now|new Date\(|Math\.random|process\.hrtime|performance\.now/.test(readFileSync(join(DIR, name), 'utf8'));
check('H4.determinism.noClockOrRandom', noClockOrRandom('define-acceptance-contract-desk-build.mjs') && noClockOrRandom('define-acceptance-contract-desk-author-verify.mjs'), 'builder + verifier read no clock and no randomness');
check('H5.evidence.vocabularyClosed', art.content.product.criteria.every((c) => ['audit', 'independent-agent-review', 'monitoring', 'test'].includes(c.evidence.evidenceKind))
  && art.content.product.criteria.every((c) => typeof c.evidence.observableTerminalResult === 'string' && c.evidence.observableTerminalResult.length > 0), 'closed four-value evidence kinds + declared observable terminal results');
const ids = art.content.product.criteria.map((c) => c.criterionId);
check('H6.identity.criterionIdsUnique', new Set(ids).size === ids.length, ids.sort().join(', '));

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const out = {
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; WP03 validator: real ac-binding.mjs through the REAL cell seam; bundle validator: real validateAcceptanceBundle; universe: real acceptanceUniverseFrom desk protocol; upstream: real PRD/UC/WP03-requirements validators + REAL cell folds',
  recomputed: results.length,
  passed,
  failed,
  results,
};
writeFileSync(join(DIR, 'define-acceptance-contract-desk-author-verify-out.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ recomputed: results.length, passed, failed }, null, 2));
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) console.error(`FAIL ${r.id}: ${r.detail}`);
  process.exitCode = 1;
}
