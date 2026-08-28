/**
 * derive-system-requirements desk (author) - digest + contract recomputation
 * evidence (r3).
 *
 * Frozen kernel rule: src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Runs the REAL WP03 validator (validateRequirementsBundle) against the
 * accepted universe derived through the REAL desk protocol
 * (deriveAcceptedUniverse), re-folds BOTH upstream sets with the REAL
 * validators + REAL cell folds, recomputes EVERY declared digest
 * (submission, artifact, trace, four requirement seals), runs the REAL
 * cell gate (gateSystemRequirementsCandidate with the REAL declared
 * provider and the REAL fail-closed seam binder over the REAL docs-tree
 * validator), re-derives the trace coverage projections from the edge
 * set, cross-checks the task-projection content addresses, validates the
 * payload contract evidence set, and negative-probes the gate (foreign
 * lineage, stale pin, coverage gap, missing branch lineage, validator
 * bypass). Nothing is trusted by declaration.
 *
 * Run: node derive-system-requirements-desk-author-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

const sub = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-product-submission.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-system-requirements.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-system-requirements-trace.json'), 'utf8'));
const upArt = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));
const ucArt = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json'), 'utf8'));
const ucTrc = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios-trace.json'), 'utf8'));
const ucSub = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-product-submission.json'), 'utf8'));

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

/* A. artifact self-address + kind pins */
check('A1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('A2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('A3.artifact.kindPins', art.content.schemaVersion === 'formalization.system-requirements.v1'
  && art.productKind === 'formalization.system-requirements.v1'
  && art.content.productKind === 'formalization.system-requirements.v1'
  && art.content.contractKind === 'frf-contracts.requirements-bundle.v1'
  && art.content.checkProviderId === 'formalization.requirements-structure.v1'
  && art.deskRef === 'derive-system-requirements' && art.role === 'author', 'desk product kind + WP03 contract + provider pins');

/* B. both upstream folds through the REAL validators + REAL cell folds */
const upSeal = new Map();
let upOk = true;
for (const m of upArt.content.members) {
  const v = prd03.validatePrdIntentMember(m, {
    idSets: {
      sourceClaimIds: Object.keys(ENVELOPE).filter((id) => id.startsWith('claim:')),
      terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'],
    },
  });
  const digest = sha(m);
  const declared = upArt.content.memberSeals.find((s) => s.memberId === m.memberId)?.digest;
  const ok = v.ok && digest === declared;
  upOk = upOk && ok;
  check(`B1.upstreamMember.${m.memberId ?? '?'}`, ok, v.ok ? `PRD seal recomputed ${digest.slice(0, 16)}…` : `WP03 PRD refusal ${v.reason}: ${v.detail}`);
  upSeal.set(m.memberId, digest);
}
const upFold = upCell.acceptedIntentSetOf(
  { members: upArt.content.members },
  upArt.content.members.map((m) => ({ memberId: m.memberId, digest: upSeal.get(m.memberId) })),
);
check('B2.upstreamFold.ok', upFold.ok === true, upFold.ok ? `revisionDigest ${upFold.set.revisionDigest.slice(0, 16)}…` : upFold.detail);
const ucUniverse = { idSets: { prdMemberIds: upFold.ok ? [...upFold.set.prdMemberIds] : [] } };
const ucSeal = new Map();
let ucOk = true;
for (const s of ucArt.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, ucUniverse);
  const digest = sha(s);
  const declared = ucArt.content.scenarioSeals.find((e) => e.scenarioId === s.scenarioId)?.digest;
  const ok = v.ok && digest === declared;
  ucOk = ucOk && ok;
  check(`B3.upstreamScenario.${s.scenarioId ?? '?'}`, ok, v.ok ? `UC seal recomputed ${digest.slice(0, 16)}…` : `WP03 UC refusal ${v.reason}: ${v.detail}`);
  ucSeal.set(s.scenarioId, digest);
}
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
const boundIntent = art.content.upstream.acceptedIntentSet;
check('B4.upstreamIntentBinding.exact', upFold.ok && JSON.stringify(boundIntent) === JSON.stringify({
  memberDigests: upFold.set.memberDigests,
  prdMemberIds: upFold.set.prdMemberIds,
  revisionDigest: upFold.set.revisionDigest,
  scenarioRequiredMemberIds: upFold.set.scenarioRequiredMemberIds,
}), upFold.ok ? `prd revision ${boundIntent.revisionDigest.slice(0, 16)}… re-folded, not declared` : 'fold failed');
check('B5.upstreamUcBinding.exact', JSON.stringify(art.content.upstream.acceptedUcSet) === JSON.stringify({
  memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort(),
  scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(),
  branchIdsByScenario: Object.fromEntries(ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)])),
  revisionDigest: ucRevisionDigest,
}), `uc revision ${ucRevisionDigest.slice(0, 16)}… re-folded, not declared`);
check('B6.upstream.refs', art.content.upstream.acceptedIntentArtifactDigest === upArt.contentDigest
  && art.content.upstream.acceptedUcArtifactDigest === ucArt.contentDigest
  && art.content.upstream.acceptedUcTraceRef === ucTrc.traceRef
  && art.content.upstream.acceptedUcSubmissionRef === ucSub.submissionRef
  && art.content.upstream.importArtifactRef === shaRef(IMPORT)
  && art.content.upstream.capsuleRef === shaRef(CAPSULE)
  && art.content.upstream.certificateRef === shaRef(CERT), art.content.upstream.acceptedIntentArtifactRef);
let envOk = art.content.upstream.verifiedSubArtifacts.length === Object.keys(ENVELOPE).length;
for (const entry of art.content.upstream.verifiedSubArtifacts) {
  envOk = envOk && ENVELOPE[entry.id] === entry.digest && entry.ref === shaRef(entry.digest);
}
check('B7.upstream.taskProjection', envOk, `${art.content.upstream.verifiedSubArtifacts.length} sub-artifact content addresses match the task-projection envelope`);
check('B8.upstream.seals', JSON.stringify(art.content.upstream.acceptedIntentSeals.map((s) => [s.memberId, s.digest])) === JSON.stringify(upArt.content.memberSeals.map((s) => [s.memberId, s.digest]))
  && JSON.stringify(art.content.upstream.acceptedUcSeals.map((s) => [s.scenarioId, s.digest])) === JSON.stringify(ucArt.content.scenarioSeals.map((s) => [s.scenarioId, s.digest])), 'upstream seals carried by content address');

/* C. candidate fence + the REAL WP03 validator over the authored bundle */
const FORBIDDEN = ['scenarios', 'acceptanceCriteria', 'criteria', 'srs', 'scenarioRealizations', 'solutionContract'];
const product = art.content.product;
const fenceHit = FORBIDDEN.filter((k) => product[k] !== undefined);
check('C1.product.fence', fenceHit.length === 0, fenceHit.length === 0 ? 'no forbidden artifact family in the product' : `forbidden keys present: ${fenceHit.join(', ')}`);
check('C2.product.kindVocabulary', product.requirements.every((m) => ['FR', 'NFR', 'RULE'].includes(m.requirementKind)), product.requirements.map((m) => `${m.requirementId}:${m.requirementKind}`).join(', '));
const requirementSeal = new Map(product.requirements.map((m) => [m.requirementId, sha(m)]));
let sealsOk = art.content.memberSeals.length === product.requirements.length;
for (const s of art.content.memberSeals) {
  sealsOk = sealsOk && requirementSeal.get(s.requirementId) === s.digest && s.ref === shaRef(s.digest);
}
check('C3.memberSeals.recomputed', sealsOk, `${art.content.memberSeals.length} member seals recomputed over canonical members`);
check('C4.product.bundlePins', product.schemaVersion === 'frf-contracts.requirements-bundle.v1'
  && product.prdRevisionRef === shaRef(upFold.set.revisionDigest)
  && product.ucRevisionRef === shaRef(ucRevisionDigest), `prd=${product.prdRevisionRef.slice(0, 22)}… uc=${product.ucRevisionRef.slice(0, 22)}…`);

/* The REAL desk protocol derives the universe from the transition inputs. */
const deskUniverse = srCell.deriveAcceptedUniverse({
  prd: { revisionDigest: upFold.set.revisionDigest, memberIds: [...upFold.set.prdMemberIds] },
  useCases: {
    revisionDigest: ucRevisionDigest,
    scenarioIds: ucArt.content.scenarios.map((s) => s.scenarioId).sort(),
    branchIdsByScenario: Object.fromEntries(ucArt.content.scenarios.map((s) => [s.scenarioId, s.terminalBranches.map((b) => b.branchId)])),
  },
  sourceConstraintIds: ['constraint:retention-1'],
  verificationSurfaceIds: art.content.deskInput.verificationSurfaceIds,
});
check('C5.deskProtocol.universe', deskUniverse.ok === true, deskUniverse.ok ? 'accepted universe derived by the REAL deriveAcceptedUniverse' : deskUniverse.detail);
const wp03Seal = wp03.validateRequirementsBundle(product, deskUniverse.universe);
check('C6.wp03.sealed', wp03Seal.ok === true, wp03Seal.ok ? `WP03 sealed the bundle as ${wp03Seal.ref}` : `${wp03Seal.reason}: ${wp03Seal.detail}`);
check('C7.wp03.sealMatchesSelfAddress', wp03Seal.ok && wp03Seal.ref === shaRef(sha(product)), wp03Seal.ref);

/* D. coverage + lineage projections over the accepted sets */
const coveredScenarios = new Set();
let branchOk = true;
for (const m of product.requirements) {
  for (const r of m.derivation.ucScenarioRefs ?? []) coveredScenarios.add(r);
  const owning = new Set((m.derivation.ucScenarioRefs ?? []).flatMap((sid) => deskUniverse.universe.idSets.ucBranchIdsByScenario[sid] ?? []));
  branchOk = branchOk && (m.derivation.ucTerminalBranchRefs ?? []).every((b) => owning.has(b));
}
const missing = ucArt.content.scenarios.map((s) => s.scenarioId).filter((sid) => !coveredScenarios.has(sid));
check('D1.ucCoverage.closed', missing.length === 0, missing.length === 0 ? `all ${coveredScenarios.size} accepted scenarios produce obligations` : `COVERAGE_GAP: ${missing.join(', ')}`);
check('D2.branchLineage.resolves', branchOk, 'every cited terminal branch resolves within a cited owning scenario');
const intentRefs = new Set(product.requirements.flatMap((m) => m.derivation.prdIntentRefs));
const foreignIntent = [...intentRefs].filter((r) => !upFold.set.prdMemberIds.includes(r));
check('D3.noForeignIntent', foreignIntent.length === 0, foreignIntent.length === 0 ? 'every prdIntentRef inside the exact accepted set' : `foreign: ${foreignIntent.join(', ')}`);
const outOfScopeDerived = product.requirements.some((m) => (m.derivation.prdIntentRefs ?? []).includes('prd:scope-2'));
check('D4.outOfScope.derivesNothing', !outOfScopeDerived, 'prd:scope-2 (out_of_scope at intent freeze) derives no requirement');
const unknownDerived = JSON.stringify(product).includes('unknown:browser-matrix-1');
check('D5.unknown.derivesNothing', !unknownDerived, 'unknown:browser-matrix-1 is cited in no requirement material');
const scenariosCovered = ucArt.content.scenarios.map((s) => s.scenarioId).every((sid) =>
  product.requirements.some((m) => (m.derivation.ucScenarioRefs ?? []).includes(sid)));
check('D6.scenarioRequiredCovered', scenariosCovered, 'every accepted scenario (boundary, outcome, terminal) carries an FR');

/* E. constraint + unknown dispositions honest + determinism pins */
const con = art.content.constraintDispositions.find((c) => c.constraintId === 'constraint:retention-1');
check('E1.constraintHonored', con !== undefined && con.disposition === 'honored' && con.digest === ENVELOPE['constraint:retention-1'], con?.disposition);
const unk = art.content.unknownDispositions.find((u) => u.unknownId === 'unknown:browser-matrix-1');
check('E2.unknownCarried', unk !== undefined && unk.disposition === 'carried_forward' && unk.owner === 'discovery' && unk.digest === ENVELOPE['unknown:browser-matrix-1'], `${unk?.disposition}, owner=${unk?.owner}`);
check('E3.determinism.pinnedTimestamps', art.createdAt === '2026-08-28T00:00:00Z' && trc.createdAt === '2026-08-28T00:00:00Z' && sub.createdAt === '2026-08-28T00:00:00Z', 'pinned timestamps on all three artifacts');

/* F. terminal claims: ownership stays upstream, support recorded per FR */
let termOk = true;
for (const t of art.content.terminalSupport) {
  const digest = ENVELOPE[t.terminalClaimId];
  const owner = upArt.content.members.find((m) => m.memberId === t.ownedByMemberId);
  const ownerSupports = Array.isArray(owner?.terminalClaimRefs) && owner.terminalClaimRefs.includes(t.terminalClaimId);
  const requirement = product.requirements.find((m) => m.requirementId === t.supportedByRequirementId);
  const ok = digest !== undefined && ownerSupports && requirement !== undefined;
  termOk = termOk && ok;
  check(`F1.terminal.${t.terminalClaimId}`, ok, `owned upstream by ${t.ownedByMemberId}, supported by ${t.supportedByRequirementId}`);
}

/* G. trace self-address + every relationship resolves to recomputed digests */
check('G1.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)} vs declared ${trc.contentDigest}`);
check('G2.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), trc.traceRef);
check('G3.submission.traceRef.binding', sub.content.traceRef === trc.traceRef, sub.content.traceRef);
check('G4.trace.subjectBinding', trc.content.subjectArtifactRef === art.artifactRef, trc.content.subjectArtifactRef);
const digestIndex = new Map([
  ...Object.entries(ENVELOPE),
  ...[...upSeal.entries()],
  ...[...ucSeal.entries()],
  ...[...requirementSeal.entries()],
]);
const VOCAB = new Set(trc.content.relationVocabulary);
let relOk = true;
for (const [i, r] of trc.content.relationships.entries()) {
  const fromExpect = digestIndex.get(r.fromId);
  const toExpect = digestIndex.get(r.toId);
  const ok = VOCAB.has(r.relation) && fromExpect !== undefined && toExpect !== undefined
    && r.fromRef === shaRef(fromExpect) && r.toRef === shaRef(toExpect);
  relOk = relOk && ok;
  if (!ok) check(`G5.rel[${i}]`, false, `${r.fromId} -${r.relation}-> ${r.toId} refs do not resolve to recomputed digests`);
}
check('G5.relationships.resolve', relOk, `${trc.content.relationships.length} relationships checked against recomputed digests`);
const unkEdges = trc.content.relationships.filter((r) => r.fromId === 'unknown:browser-matrix-1' || r.toId === 'unknown:browser-matrix-1');
check('G6.unknown.noResolutionEdges', unkEdges.length === 0, `${unkEdges.length} edges touch the unknown`);

/* H. coverage blocks are exact projections of the edge set */
const edgeProjection = (fromId, relation) => trc.content.relationships
  .filter((r) => r.fromId === fromId && r.relation === relation).map((r) => r.toId).sort();
let covOk = true;
for (const [requirementId, cov] of Object.entries(trc.content.requirementCoverage)) {
  const expect = { digest: digestIndex.get(requirementId), derivedFrom: edgeProjection(requirementId, 'derived_from'), enforces: edgeProjection(requirementId, 'enforces'), supports: edgeProjection(requirementId, 'supports') };
  const got = { digest: cov.digest, derivedFrom: [...(cov.derivedFrom ?? [])].sort(), enforces: [...(cov.enforces ?? [])].sort(), supports: [...(cov.supports ?? [])].sort() };
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  covOk = covOk && ok;
  if (!ok) check(`H.requirementCoverage.${requirementId}`, false, `projection mismatch: ${JSON.stringify(got)} vs ${JSON.stringify(expect)}`);
}
check('H1.requirementCoverage.projection', covOk, `${Object.keys(trc.content.requirementCoverage).length} requirement coverage blocks recomputed from the edge set`);
let prdCovOk = Object.keys(trc.content.prdMemberCoverage).length === upFold.set.prdMemberIds.length;
for (const [memberId, cov] of Object.entries(trc.content.prdMemberCoverage)) {
  const expect = {
    digest: digestIndex.get(memberId),
    disposition: upArt.content.members.find((m) => m.memberId === memberId)?.disposition.disposition,
    coveredBy: trc.content.relationships.filter((r) => r.relation === 'derived_from' && r.toId === memberId).map((r) => r.fromId).sort(),
  };
  const got = { digest: cov.digest, disposition: cov.disposition, coveredBy: [...(cov.coveredBy ?? [])].sort() };
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  prdCovOk = prdCovOk && ok;
  if (!ok) check(`H2.prdMemberCoverage.${memberId}`, false, `projection mismatch: ${JSON.stringify(got)} vs ${JSON.stringify(expect)}`);
}
check('H2.prdMemberCoverage.projection', prdCovOk, `${Object.keys(trc.content.prdMemberCoverage).length} PRD member coverage blocks recomputed from the edge set`);
let termCovOk = true;
for (const t of ['terminal:audited-1', 'terminal:delivered-1']) {
  const expect = trc.content.relationships.filter((r) => r.relation === 'supports' && r.toId === t).map((r) => r.fromId).sort();
  const got = trc.content.terminalCoverage[t];
  const ok = got !== undefined && got.digest === ENVELOPE[t] && JSON.stringify([...(got.supportedBy ?? [])].sort()) === JSON.stringify(expect);
  termCovOk = termCovOk && ok;
  check(`H3.terminalCoverage.${t}`, ok, `supportedBy=${(got?.supportedBy ?? []).join(',')}`);
}
const conGot = trc.content.constraintCoverage;
const conEnforcedBy = trc.content.relationships.filter((r) => r.relation === 'enforces' && r.toId === 'constraint:retention-1').map((r) => r.fromId).sort();
check('H4.constraintCoverage.projection', conGot.digest === ENVELOPE['constraint:retention-1']
  && JSON.stringify([...(conGot.enforcedBy ?? [])].sort()) === JSON.stringify(conEnforcedBy)
  && JSON.stringify([...(con.enforcedBy ?? [])].sort()) === JSON.stringify(conEnforcedBy),
  `enforcedBy=${conGot.enforcedBy?.join(',')}`);

/* I. submission self-address + candidate binding + payload contract */
check('I1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('I2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);
check('I3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest && sub.content.candidate.kind === 'formalization.system-requirements.v1', sub.content.candidate.artifactRef);
const EXPECTED_EVIDENCE = [
  shaRef(upArt.contentDigest), shaRef(ucArt.contentDigest), shaRef(IMPORT), shaRef(CAPSULE), shaRef(CERT),
  ...Object.values(ENVELOPE).map(shaRef), shaRef(GOVERNING),
  shaRef('6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9'), shaRef('91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0'),
  shaRef(ucTrc.contentDigest), shaRef(ucSub.contentDigest),
].sort();
const gotEvidence = [...sub.content.payloadContract.requiredEvidenceRefs].sort();
check('I4.evidenceRefs.exact', JSON.stringify(gotEvidence) === JSON.stringify(EXPECTED_EVIDENCE), `${gotEvidence.length} refs, exact set match`);
const cov = sub.content.payloadContract.evidenceKindCoverage;
check('I5.evidenceKindCoverage', cov['accepted-prd-intent-bundle'] === 1 && cov['accepted-uc-scenarios-bundle'] === 1 && cov['discovery-handoff-capsule'] === 1 && cov['discovery-certificate'] === 1 && cov['source-claim'] === 4 && cov['constraint'] === 1 && cov['unknown'] === 1 && cov['terminal-claim'] === 2 && cov['architecture-contract'] === 1, JSON.stringify(cov));
check('I6.selfCheck.allSatisfied', sub.content.acceptanceCriteriaSelfCheck.every((c) => c.satisfied === true), `${sub.content.acceptanceCriteriaSelfCheck.length} criteria`);
check('I7.governingContract', art.content.governingContractRef === shaRef(GOVERNING), art.content.governingContractRef);

/* J. workspace law + verification-flag discipline */
check('J1.workspace.zeroUpstream', art.content.workspaceSummary === WS
  && trc.content.workspaceSummary === WS
  && sub.content.workspaceSummary === WS
  && art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0, art.content.workspaceSummary);
check('J2.verificationFlags', Object.entries(art.content.verification).every(([k, v]) => (k === 'declaredDigestsTrusted' ? v === false : v === true || v === 0)), JSON.stringify(art.content.verification));

/* K. the REAL cell gate: REAL provider + REAL seam binder + REAL protocol universe */
const declared = srCell.declaredSystemRequirementsProvider();
check('K1.provider.declared', declared.ok === true, declared.ok ? `${declared.provider.providerId} digest ${declared.provider.providerDigest.slice(0, 16)}…` : declared.detail);
const docsValidator = await import(pathToFileURL(join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'validators', 'requirements-bundle.mjs')).href);
const seam = srCell.bindWp03RequirementsValidator(docsValidator);
check('K2.seam.boundFailClosed', seam.bound === true, seam.bound ? 'the REAL WP03 validator passed the binder self-test' : `${seam.reason}: ${seam.detail}`);
const candidate = srCell.candidateOf(product);
const gate = srCell.gateSystemRequirementsCandidate(declared.ok ? declared.provider : undefined, candidate, deskUniverse.ok ? deskUniverse.universe : undefined, seam);
check('K3.gateVerdict.accepted', gate.verdict === 'accepted', gate.verdict === 'accepted' ? `rule ${gate.rule.when.checkId}:${gate.rule.when.outcome}` : JSON.stringify({ verdict: gate.verdict, issues: gate.issues, detail: gate.detail }));
check('K4.gateResults.allPass', gate.results?.every((r) => r.outcome === 'pass') === true, gate.results?.map((r) => `${r.checkId}:${r.outcome}`).join(', '));
const protocol = srCell.SYSTEM_REQUIREMENTS_PROTOCOL;
check('K5.cellProtocol', protocol.deskId === 'derive-system-requirements'
  && srCell.SYSTEM_REQUIREMENTS_PRODUCT_KIND === 'formalization.system-requirements.v1'
  && srCell.SYSTEM_REQUIREMENTS_DESK_SKILL_ID === 'formalization-desk-derive-system-requirements'
  && srCell.SYSTEM_REQUIREMENTS_SKILL_DECLARATION.servesDesks.includes('derive-system-requirements'), 'desk protocol + skill declaration pins');

/* L. negative probes: the gate refuses, never the desk silently passes */
const mutated = (fn) => {
  const clone = structuredClone(candidate);
  fn(clone.product);
  return clone;
};
const foreign = srCell.gateSystemRequirementsCandidate(declared.provider, mutated((p) => { p.requirements[0].derivation.prdIntentRefs = ['prd:FOREIGN']; }), deskUniverse.universe, seam);
check('L1.probe.foreignLineage', foreign.verdict === 'upstream-repair', `${foreign.verdict}: ${(foreign.issues ?? []).map((i) => i.source).join(',')}`);
const stale = srCell.gateSystemRequirementsCandidate(declared.provider, mutated((p) => { p.prdRevisionRef = `sha256:${'0'.repeat(64)}`; }), deskUniverse.universe, seam);
check('L2.probe.stalePin', stale.verdict === 'repair', `${stale.verdict}: ${(stale.issues ?? []).map((i) => i.source).join(',')}`);
const gap = srCell.gateSystemRequirementsCandidate(declared.provider, mutated((p) => { p.requirements = p.requirements.filter((m) => m.requirementId !== 'fr:terminal-1'); }), deskUniverse.universe, seam);
check('L3.probe.coverageGap', gap.verdict === 'repair', `${gap.verdict}: ${(gap.issues ?? []).map((i) => i.source).join(',')}`);
const noBranch = srCell.gateSystemRequirementsCandidate(declared.provider, mutated((p) => { delete p.requirements[0].derivation.ucTerminalBranchRefs; }), deskUniverse.universe, seam);
check('L4.probe.missingBranchLineage', noBranch.verdict === 'repair', `${noBranch.verdict}: ${(noBranch.issues ?? []).map((i) => i.source).join(',')}`);
const noUniverse = srCell.gateSystemRequirementsCandidate(declared.provider, candidate, undefined, seam);
check('L5.probe.noUniverse', noUniverse.verdict === 'repair' || noUniverse.verdict === 'upstream-repair' || noUniverse.verdict === 'human-wait' || noUniverse.refused === true, noUniverse.refused === true ? noUniverse.detail : `${noUniverse.verdict} (fail-closed, never accepted)`);
check('L5.probe.noUniverse.neverAccepted', noUniverse.verdict !== 'accepted', 'a gate without an accepted universe never accepts');
const incomplete = srCell.evaluateSystemRequirementsGate(srCell.systemRequirementsGateDeclaration(), gate.results.filter((r) => r.checkId !== 'system-requirements.check.wp03-validation'));
check('L6.probe.validatorBypass', incomplete.refused === true && incomplete.code === 'GATE_CHECK_MISSING', `${incomplete.code}: the wp03-validation row can never be omitted`);
const scopeViolation = srCell.gateSystemRequirementsCandidate(declared.provider, mutated((p) => { p.scenarios = []; }), deskUniverse.universe, seam);
check('L7.probe.scopeViolation', scopeViolation.verdict === 'terminal-reject', `${scopeViolation.verdict}: another desk's artifact family never repairs`);

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; WP03 validator: real requirements-bundle.mjs through the REAL seam binder; gate: real gateSystemRequirementsCandidate (dist system-requirements cell); universe: real deriveAcceptedUniverse desk protocol',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
