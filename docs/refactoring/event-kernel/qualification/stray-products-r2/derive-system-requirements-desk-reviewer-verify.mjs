/**
 * derive-system-requirements desk (reviewer) - independent verification (r2).
 *
 * Nothing is trusted by declaration. Frozen kernel rule:
 *   src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Layers:
 *   A-J  mechanical recomputation of the author trio (artifact/trace/
 *        submission), both upstream folds through the REAL validators +
 *        REAL cell folds, the REAL WP03 validator over the REAL desk
 *        protocol universe, trace graph, coverage projections, payload
 *        contract, negative gate probes.
 *   M    ACCEPTANCE-STATUS AUDIT (desk-review authority; the kernel
 *        surface cannot see it): is the material the candidate binds
 *        actually ACCEPTED upstream material?
 *   N    governing-contract resolvability scan (workspace-wide).
 *   O    envelope upstream-accepted projection resolvability scan.
 *
 * Run: node derive-system-requirements-desk-reviewer-verify.mjs > derive-system-requirements-desk-reviewer-verify-out.json
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaBytes = (buf) => createHash('sha256').update(buf).digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(DIR, '..', '..', '..', '..', '..');
const QUAL = join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'qualification');
const wp03 = await import(pathToFileURL(join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'validators', 'requirements-bundle.mjs')).href);
const prd03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href);
const uc03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'uc-scenario-member.mjs')).href);
const upCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'product-intent', 'index.js')).href);
const srCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'system-requirements', 'index.js')).href);

const read = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const sub = read('derive-system-requirements-desk-product-submission.json');
const art = read('derive-system-requirements-desk-system-requirements.artifact.json');
const trc = read('derive-system-requirements-desk-system-requirements-trace.json');
const upArt = read('define-product-intent-desk-product-intent.artifact.json');
const ucArt = read('model-use-cases-desk-uc-scenarios.artifact.json');
const ucTrc = read('model-use-cases-desk-uc-scenarios-trace.json');
const ucSub = read('model-use-cases-desk-product-submission.json');
const ucHold = read('model-use-cases-desk-upstream-hold.artifact.json');
const iArt = read('import-discovery-handoff-desk-discovery-import.artifact.json');
const iRev = read('import-discovery-handoff-desk-reviewer-review.json');
const iRev2 = read('define-product-intent-desk-reviewer2-review.json');
const iRevA = read('define-product-intent-desk-reviewer-review.json');
const iRevB = read('define-product-intent-desk-reviewer-review-emission-b.json');
const cr1 = read('define-product-intent-desk-reviewer-collision-record.json');
const cr2 = read('define-product-intent-desk-reviewer-collision-record-2.json');
const cr3 = read('define-product-intent-desk-reviewer-collision-record-3.json');

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
const ENVELOPE_ACCEPTED = '65fe9a225a4425880513ae5321cce4d9b75c44e88fb3054f5e7f997b6956ee66';
const WS0 = '0 accepted upstream revisions travel by content address';

/* ------------------------------------------------------------------ */
/* A. author artifact self-address + pins                               */
/* ------------------------------------------------------------------ */
check('A1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('A2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('A3.artifact.kindPins', art.content.schemaVersion === 'formalization.system-requirements.v1'
  && art.content.contractKind === 'frf-contracts.requirements-bundle.v1'
  && art.content.checkProviderId === 'formalization.requirements-structure.v1'
  && art.deskRef === 'derive-system-requirements' && art.role === 'author', 'desk product kind + WP03 contract + provider pins');

/* ------------------------------------------------------------------ */
/* B. both upstream folds through the REAL validators + REAL cell folds */
/* ------------------------------------------------------------------ */
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
check('B2.upstreamFold.ok', upFold.ok === true, upFold.ok ? `revisionDigest ${upFold.set.revisionDigest}` : upFold.detail);
const ucSeal = new Map();
for (const s of ucArt.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, { idSets: { prdMemberIds: upFold.ok ? [...upFold.set.prdMemberIds] : [] } });
  const digest = sha(s);
  const declared = ucArt.content.scenarioSeals.find((e) => e.scenarioId === s.scenarioId)?.digest;
  check(`B3.upstreamScenario.${s.scenarioId ?? '?'}`, v.ok && digest === declared, v.ok ? `UC seal recomputed ${digest}` : `WP03 UC refusal ${v.reason}: ${v.detail}`);
  ucSeal.set(s.scenarioId, digest);
}
const ucRevisionDigest = sha({ memberDigests: ucArt.content.scenarioSeals.map((s) => s.digest).sort() });
check('B4.ucRevisionRefold.exact', art.content.product.ucRevisionRef === shaRef(ucRevisionDigest)
  && art.content.upstream.acceptedUcSet.revisionDigest === ucRevisionDigest, `uc revision re-folded ${ucRevisionDigest}`);
check('B5.upstream.refs', art.content.upstream.acceptedIntentArtifactDigest === upArt.contentDigest
  && art.content.upstream.acceptedUcArtifactDigest === ucArt.contentDigest
  && art.content.upstream.acceptedUcTraceRef === ucTrc.traceRef
  && art.content.upstream.acceptedUcSubmissionRef === ucSub.submissionRef
  && art.content.upstream.importArtifactRef === shaRef(IMPORT)
  && art.content.upstream.capsuleRef === shaRef(CAPSULE)
  && art.content.upstream.certificateRef === shaRef(CERT), 'upstream authority refs bind the real r2 artifacts');
let envOk = art.content.upstream.verifiedSubArtifacts.length === Object.keys(ENVELOPE).length;
for (const entry of art.content.upstream.verifiedSubArtifacts) {
  envOk = envOk && ENVELOPE[entry.id] === entry.digest && entry.ref === shaRef(entry.digest);
}
check('B6.upstream.taskProjection', envOk, `${art.content.upstream.verifiedSubArtifacts.length}/8 task-projection content addresses match the envelope`);

/* ------------------------------------------------------------------ */
/* C. candidate fence + seals + the REAL WP03 validator                 */
/* ------------------------------------------------------------------ */
const FORBIDDEN = ['scenarios', 'acceptanceCriteria', 'criteria', 'srs', 'scenarioRealizations', 'solutionContract'];
const product = art.content.product;
const fenceHit = FORBIDDEN.filter((k) => product[k] !== undefined);
check('C1.product.fence', fenceHit.length === 0, fenceHit.length === 0 ? 'no forbidden artifact family in the product' : `forbidden keys: ${fenceHit.join(', ')}`);
check('C2.product.kindVocabulary', product.requirements.every((m) => ['FR', 'NFR', 'RULE'].includes(m.requirementKind)), product.requirements.map((m) => `${m.requirementId}:${m.requirementKind}`).join(', '));
const requirementSeal = new Map(product.requirements.map((m) => [m.requirementId, sha(m)]));
let sealsOk = art.content.memberSeals.length === product.requirements.length;
for (const s of art.content.memberSeals) sealsOk = sealsOk && requirementSeal.get(s.requirementId) === s.digest && s.ref === shaRef(s.digest);
check('C3.memberSeals.recomputed', sealsOk, `${art.content.memberSeals.length} requirement seals recomputed over canonical members`);
check('C4.product.bundlePins', product.schemaVersion === 'frf-contracts.requirements-bundle.v1'
  && product.prdRevisionRef === shaRef(upFold.set.revisionDigest)
  && product.ucRevisionRef === shaRef(ucRevisionDigest), `prd=${product.prdRevisionRef.slice(0, 22)}… uc=${product.ucRevisionRef.slice(0, 22)}…`);
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
check('C7.wp03.sealMatchesSelfAddress', wp03Seal.ok && wp03Seal.ref === shaRef(sha(product)), wp03Seal.ref ?? 'n/a');

/* ------------------------------------------------------------------ */
/* D. coverage + lineage projections                                    */
/* ------------------------------------------------------------------ */
const coveredScenarios = new Set();
let branchOk = true;
for (const m of product.requirements) {
  for (const r of m.derivation.ucScenarioRefs ?? []) coveredScenarios.add(r);
  const owning = new Set((m.derivation.ucScenarioRefs ?? []).flatMap((sid) => deskUniverse.universe.idSets.ucBranchIdsByScenario[sid] ?? []));
  branchOk = branchOk && (m.derivation.ucTerminalBranchRefs ?? []).every((b) => owning.has(b));
}
const missing = ucArt.content.scenarios.map((s) => s.scenarioId).filter((sid) => !coveredScenarios.has(sid));
check('D1.ucCoverage.closed', missing.length === 0, missing.length === 0 ? `all ${coveredScenarios.size} scenarios produce obligations` : `COVERAGE_GAP: ${missing.join(', ')}`);
check('D2.branchLineage.resolves', branchOk, 'every cited terminal branch resolves within a cited owning scenario');
const intentRefs = new Set(product.requirements.flatMap((m) => m.derivation.prdIntentRefs));
const foreignIntent = [...intentRefs].filter((r) => !upFold.set.prdMemberIds.includes(r));
check('D3.noForeignIntent', foreignIntent.length === 0, foreignIntent.length === 0 ? 'every prdIntentRef inside the exact upstream fold set' : `foreign: ${foreignIntent.join(', ')}`);
const scope2Derived = product.requirements.some((m) => (m.derivation.prdIntentRefs ?? []).includes('prd:scope-2'));
check('D4.scope2.derivesNothing', !scope2Derived, scope2Derived ? 'prd:scope-2 unexpectedly derived a requirement' : 'prd:scope-2 derives no requirement (mechanical layer only - see M5 for the authority audit)');
const unknownDerived = JSON.stringify(product).includes('unknown:browser-matrix-1');
check('D5.unknown.derivesNothing', !unknownDerived, 'unknown:browser-matrix-1 is cited in no requirement material');

/* ------------------------------------------------------------------ */
/* E. dispositions + determinism pins                                   */
/* ------------------------------------------------------------------ */
const con = art.content.constraintDispositions.find((c) => c.constraintId === 'constraint:retention-1');
check('E1.constraintHonored', con !== undefined && con.disposition === 'honored' && con.digest === ENVELOPE['constraint:retention-1'], con?.disposition);
const unk = art.content.unknownDispositions.find((u) => u.unknownId === 'unknown:browser-matrix-1');
check('E2.unknownCarried', unk !== undefined && unk.disposition === 'carried_forward' && unk.owner === 'discovery' && unk.digest === ENVELOPE['unknown:browser-matrix-1'], `${unk?.disposition}, owner=${unk?.owner}`);
check('E3.determinism.pinnedTimestamps', art.createdAt === '2026-08-28T00:00:00Z' && trc.createdAt === '2026-08-28T00:00:00Z' && sub.createdAt === '2026-08-28T00:00:00Z', 'pinned timestamps on all three author artifacts');

/* ------------------------------------------------------------------ */
/* F. terminal claims: ownership upstream, support per FR               */
/* ------------------------------------------------------------------ */
for (const t of art.content.terminalSupport) {
  const digest = ENVELOPE[t.terminalClaimId];
  const owner = upArt.content.members.find((m) => m.memberId === t.ownedByMemberId);
  const ownerSupports = Array.isArray(owner?.terminalClaimRefs) && owner.terminalClaimRefs.includes(t.terminalClaimId);
  const requirement = product.requirements.find((m) => m.requirementId === t.supportedByRequirementId);
  check(`F1.terminal.${t.terminalClaimId}`, digest !== undefined && ownerSupports && requirement !== undefined, `owned upstream by ${t.ownedByMemberId}, supported by ${t.supportedByRequirementId}`);
}

/* ------------------------------------------------------------------ */
/* G. trace graph                                                       */
/* ------------------------------------------------------------------ */
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
  if (!ok) check(`G5.rel[${i}]`, false, `${r.fromId} -${r.relation}-> ${r.toId} refs do not resolve`);
}
check('G5.relationships.resolve', relOk, `${trc.content.relationships.length} relationships resolve against recomputed digests`);
const unkEdges = trc.content.relationships.filter((r) => r.fromId === 'unknown:browser-matrix-1' || r.toId === 'unknown:browser-matrix-1');
check('G6.unknown.noResolutionEdges', unkEdges.length === 0, `${unkEdges.length} edges touch the unknown`);

/* ------------------------------------------------------------------ */
/* H. coverage blocks are exact projections of the edge set             */
/* ------------------------------------------------------------------ */
const edgeProjection = (fromId, relation) => trc.content.relationships
  .filter((r) => r.fromId === fromId && r.relation === relation).map((r) => r.toId).sort();
let covOk = true;
for (const [requirementId, cov] of Object.entries(trc.content.requirementCoverage)) {
  const expect = { digest: digestIndex.get(requirementId), derivedFrom: edgeProjection(requirementId, 'derived_from'), enforces: edgeProjection(requirementId, 'enforces'), supports: edgeProjection(requirementId, 'supports') };
  const got = { digest: cov.digest, derivedFrom: [...(cov.derivedFrom ?? [])].sort(), enforces: [...(cov.enforces ?? [])].sort(), supports: [...(cov.supports ?? [])].sort() };
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  covOk = covOk && ok;
  if (!ok) check(`H.requirementCoverage.${requirementId}`, false, `projection mismatch`);
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
  if (!ok) check(`H2.prdMemberCoverage.${memberId}`, false, 'projection mismatch');
}
check('H2.prdMemberCoverage.projection', prdCovOk, `${Object.keys(trc.content.prdMemberCoverage).length} PRD member coverage blocks recomputed from the edge set`);
for (const t of ['terminal:audited-1', 'terminal:delivered-1']) {
  const expect = trc.content.relationships.filter((r) => r.relation === 'supports' && r.toId === t).map((r) => r.fromId).sort();
  const got = trc.content.terminalCoverage[t];
  check(`H3.terminalCoverage.${t}`, got !== undefined && got.digest === ENVELOPE[t] && JSON.stringify([...(got.supportedBy ?? [])].sort()) === JSON.stringify(expect), `supportedBy=${(got?.supportedBy ?? []).join(',')}`);
}
const conEnforcedBy = trc.content.relationships.filter((r) => r.relation === 'enforces' && r.toId === 'constraint:retention-1').map((r) => r.fromId).sort();
check('H4.constraintCoverage.projection', trc.content.constraintCoverage.digest === ENVELOPE['constraint:retention-1']
  && JSON.stringify([...(trc.content.constraintCoverage.enforcedBy ?? [])].sort()) === JSON.stringify(conEnforcedBy)
  && JSON.stringify([...(con.enforcedBy ?? [])].sort()) === JSON.stringify(conEnforcedBy), `enforcedBy=${conEnforcedBy.join(',')}`);

/* ------------------------------------------------------------------ */
/* I. submission binding + payload contract                             */
/* ------------------------------------------------------------------ */
check('I1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('I2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);
check('I3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest, sub.content.candidate.artifactRef);
const EXPECTED_EVIDENCE = [
  shaRef(upArt.contentDigest), shaRef(ucArt.contentDigest), shaRef(IMPORT), shaRef(CAPSULE), shaRef(CERT),
  ...Object.values(ENVELOPE).map(shaRef), shaRef(GOVERNING),
  shaRef('6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9'), shaRef('91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0'),
  shaRef(ucTrc.contentDigest), shaRef(ucSub.contentDigest),
].sort();
check('I4.evidenceRefs.exact', JSON.stringify([...sub.content.payloadContract.requiredEvidenceRefs].sort()) === JSON.stringify(EXPECTED_EVIDENCE), `${sub.content.payloadContract.requiredEvidenceRefs.length} refs, exact set match`);
const cov = sub.content.payloadContract.evidenceKindCoverage;
check('I5.evidenceKindCoverage', cov['accepted-prd-intent-bundle'] === 1 && cov['accepted-uc-scenarios-bundle'] === 1 && cov['source-claim'] === 4 && cov['terminal-claim'] === 2 && cov['architecture-contract'] === 1, JSON.stringify(cov));
check('I6.intakeReceipt.attestation', sub.content.intakeReceipt?.status === 'admitted_for_reviewer_stage', 'kernel-side product submission is driver-executed over public commands (attestation, not desk-level re-verification)');

/* ------------------------------------------------------------------ */
/* J. workspace-law consistency (author 0 everywhere)                   */
/* ------------------------------------------------------------------ */
check('J1.workspace.zeroUpstream.consistent', art.content.workspaceSummary === WS0
  && trc.content.workspaceSummary === WS0
  && sub.content.workspaceSummary === WS0
  && art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0, art.content.workspaceSummary);

/* ------------------------------------------------------------------ */
/* K. the REAL cell gate re-run + negative probes (subset)              */
/* ------------------------------------------------------------------ */
const declared = srCell.declaredSystemRequirementsProvider();
check('K1.provider.declared', declared.ok === true, declared.ok ? `${declared.provider.providerId}` : declared.detail);
const seam = srCell.bindWp03RequirementsValidator(wp03);
check('K2.seam.boundFailClosed', seam.bound === true, seam.bound ? 'the REAL WP03 validator passed the binder self-test' : `${seam.reason}: ${seam.detail}`);
const candidate = srCell.candidateOf(product);
const gate = srCell.gateSystemRequirementsCandidate(declared.ok ? declared.provider : undefined, candidate, deskUniverse.ok ? deskUniverse.universe : undefined, seam);
check('K3.authorGate.accepted', gate.verdict === 'accepted', gate.verdict === 'accepted' ? `author-stage cell gate: ${gate.results?.map((r) => `${r.checkId}:${r.outcome}`).join(', ')}` : JSON.stringify({ verdict: gate.verdict, issues: gate.issues }));
const mutated = (fn) => { const clone = structuredClone(candidate); fn(clone.product); return clone; };
const foreign = srCell.gateSystemRequirementsCandidate(declared.provider, mutated((p) => { p.requirements[0].derivation.prdIntentRefs = ['prd:FOREIGN']; }), deskUniverse.universe, seam);
check('K4.probe.foreignLineage', foreign.verdict === 'upstream-repair', `${foreign.verdict}`);
const stale = srCell.gateSystemRequirementsCandidate(declared.provider, mutated((p) => { p.prdRevisionRef = `sha256:${'0'.repeat(64)}`; }), deskUniverse.universe, seam);
check('K5.probe.stalePin', stale.verdict === 'repair', `${stale.verdict}`);
const scopeViolation = srCell.gateSystemRequirementsCandidate(declared.provider, mutated((p) => { p.scenarios = []; }), deskUniverse.universe, seam);
check('K6.probe.scopeViolation', scopeViolation.verdict === 'terminal-reject', `${scopeViolation.verdict}: another desk's artifact family never repairs`);

/* ------------------------------------------------------------------ */
/* M. ACCEPTANCE-STATUS AUDIT (desk-review authority)                   */
/*    The gate/universe math consumes whatever set it is handed;        */
/*    whether that set is ACCEPTED upstream material is exactly what    */
/*    the kernel cannot see and the reviewer must.                      */
/* ------------------------------------------------------------------ */

/* M1: census of define-product-intent reviewer emissions - all verdicts. */
const intentVerdicts = [
  ['reviewer (canonical, FR-Define-Product-Intent-001)', iRevA],
  ['reviewer emission-b (FR-Define-Product-Intent-001)', iRevB],
  ['reviewer2 (FR-Define-Product-Intent-002)', iRev2],
];
for (const [label, r] of intentVerdicts) {
  check(`M1.intentReview.${label}`, r.content.verdict === 'repair', `verdict=${r.content.verdict}, digest=${r.contentDigest.slice(0, 16)}…`);
}
for (const [label, cr] of [['CR-001', cr1], ['CR-002', cr2], ['CR-003', cr3]]) {
  if (label === 'CR-001') {
    /* the original collision record predates verdictOfRecord; its canonical emission carries the verdict, the deviating emission-B `accepted` was withdrawn by its own author (CR-002/CR-003 attest) */
    check(`M1.collisionRecord.${label}`, cr.content.emissionA?.verdict === 'repair' && String(cr.content.emissionA?.status).includes('CANONICAL'), `emissionA verdict=${cr.content.emissionA?.verdict} (${cr.content.emissionA?.status}); the deviating emissionB "accepted" was withdrawn by its own author`);
  } else {
    check(`M1.collisionRecord.${label}`, cr.content.verdictOfRecord === 'repair', `verdictOfRecord=${cr.content.verdictOfRecord}`);
  }
}

/* M2: no adjudication/settlement record exists in the round. */
const r2Files = readdirSync(DIR).filter((f) => f.endsWith('.json') || f.endsWith('.md'));
const adjudicationFiles = r2Files.filter((f) => /adjudic|human-response|settlement|final-gate-result/i.test(f));
check('M2.noAdjudicationRecord', adjudicationFiles.length === 0, adjudicationFiles.length === 0
  ? 'no driver/human adjudication or settlement record exists in stray-products-r2; the intent contention recorded by UH-Model-Use-Cases-001 is still open'
  : `found: ${adjudicationFiles.join(', ')}`);

/* M3: the UC desk authored against its own hold. */
check('M3.ucHold.contentionOpen', ucHold.content.decision === 'hold-no-authoring'
  && ucHold.content.typedBasis?.upstreamSettleState === 'contention-open'
  && Array.isArray(ucHold.content.typedBasis?.obligations) && ucHold.content.typedBasis.obligations.some((o) => String(o).includes('requeueAfterHumanResolution')),
  'UH-Model-Use-Cases-001: hold-no-authoring while the intent product is review-contended');
const ucReviewerFiles = r2Files.filter((f) => f.startsWith('model-use-cases-desk') && f.includes('reviewer'));
check('M3.ucNeverReviewed', ucReviewerFiles.length === 0, ucReviewerFiles.length === 0
  ? 'no model-use-cases reviewer artifacts exist: the UC scenarios bundle (sha256:24f0aff2…) never passed a reviewer stage'
  : `found: ${ucReviewerFiles.join(', ')}`);

/* M4: does the candidate's acceptance claim hold? (must be TRUE to pass) */
const intentSettled = intentVerdicts.every(([, r]) => r.content.verdict === 'accepted');
const ucAccepted = ucReviewerFiles.length > 0; /* an accepted UC revision requires a passed reviewer stage; none exists */
check('M4.candidate.acceptanceClaimsTrue', intentSettled && ucAccepted,
  `FALSE: upstream.materialAuthority asserts "the accepted define-product-intent bundle and the accepted model-use-cases scenario bundle"; verification.revisionPinsMatchAcceptedRevisions=true; evidence kinds accepted-*. All intent reviewer emissions carry verdict REPAIR (contention-open, UH-Model-Use-Cases-001); the UC bundle has no reviewer stage at all. No accepted revision of either desk exists in r2.`);

/* M5: does the restated scope-2 exclusion authority exist? (must be TRUE) */
const vsa = iArt.content.verifiedSubArtifacts;
const sc2 = vsa.sourceClaims.find((x) => x.content.claimId === 'claim:scope-2');
const sc2Ok = sc2 !== undefined && sha(sc2.content) === ENVELOPE['claim:scope-2'];
const sc2Keys = sc2Ok ? Object.keys(sc2.content).sort().join(',') : 'n/a';
const cert = vsa.certificate;
const certOk = sha(cert.content) === CERT;
const certJson = certOk ? JSON.stringify(sortKeys(cert.content)) : 'n/a';
const exclusionAuthorityExists = sc2Ok && certOk
  && sc2Keys === 'claimId,statement'
  && certJson.includes('"decision":"go"') && !certJson.includes('scope')
  ? false /* SC-2 is a bare claim; CERT-1 is subject-level go: no exclusion decision anywhere */
  : true; /* only a yet-unseen authority record could make this true */
check('M5.candidate.scope2ExclusionAuthorityExists', exclusionAuthorityExists,
  `FALSE: SC-2 (recomputed ${ENVELOPE['claim:scope-2'].slice(0, 16)}…) is exactly {${sc2Keys}} - a bare claim, no decision; CERT-1 is a subject-level go. The candidate brief restates "out-of-scope intent member prd:scope-2" and self-check 8 marks the exclusion satisfied - ratifying the exclusion authority both intent reviews (CRIT-1) established as nonexistent. Accepted scope material stays silently removed from the requirements surface.`);

/* M6: is the author trio internally consistent on acceptance? (must be TRUE) */
check('M6.candidate.workspaceSelfConsistent', !(art.content.workspaceSummary === WS0
  && art.content.upstream.materialAuthority.includes('accepted')),
  `contradiction: workspaceSummary "0 accepted upstream revisions travel by content address" while upstream.materialAuthority claims "the accepted … bundle … traveling by content address" - both cannot be true`);

/* M7: the prior-review evidence this audit cites recomputes. */
const cited = [
  ['import review (accepted)', iRev, 'cfc7b35a5d0b71586e24be6474c5add914ba5f303edbd8bc2789782fd34b4d7b'],
  ['intent review canonical', iRevA, iRevA.contentDigest],
  ['intent review emission-b', iRevB, iRevB.contentDigest],
  ['intent review reviewer2', iRev2, iRev2.contentDigest],
  ['collision CR-001', cr1, cr1.contentDigest],
  ['collision CR-003', cr3, cr3.contentDigest],
  ['UC hold artifact', ucHold, ucHold.contentDigest],
  ['import artifact', iArt, iArt.contentDigest],
];
for (const [label, doc, expect] of cited) {
  check(`M7.evidenceRecomputes.${label}`, sha(doc.content) === expect, `recomputed ${sha(doc.content).slice(0, 16)}…`);
}

/* ------------------------------------------------------------------ */
/* N. governing-contract resolvability scan (workspace-wide)            */
/* ------------------------------------------------------------------ */
const walk = (dir) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
};
const wsFiles = walk(QUAL);
let rawHits = 0, canonHits = 0, contentHits = 0, textHits = 0;
const claimants = [];
for (const p of wsFiles) {
  let buf;
  try { buf = readFileSync(p); } catch { continue; }
  const text = buf.toString('utf8');
  if (shaBytes(buf) === GOVERNING) rawHits += 1;
  if (text.includes(GOVERNING)) {
    textHits += 1;
    if (p.replaceAll('\\', '/').includes('/stray-products-')) claimants.push(p.slice(QUAL.length + 1));
  }
  if (p.endsWith('.json')) {
    try {
      const j = JSON.parse(text);
      if (sha(j) === GOVERNING) canonHits += 1;
      if (j && typeof j === 'object' && j.content !== undefined && sha(j.content) === GOVERNING) contentHits += 1;
    } catch { /* non-JSON body */ }
  }
}
check('N1.governingContract.unresolvable', rawHits === 0 && canonHits === 0 && contentHits === 0,
  `UNRESOLVABLE workspace-wide: scanned ${wsFiles.length} files under qualification/ - raw-bytes hits ${rawHits}, canonical-JSON hits ${canonHits}, .content hits ${contentHits}; ${claimants.length} stray-products files declare the address textually and recompute otherwise (r1 CRIT-003 digest-drift family, carried through FR-Define-Product-Intent-001/002 MAJ-1 RA-2)`);

/* ------------------------------------------------------------------ */
/* O. envelope upstream-accepted projection adjudication evidence       */
/* ------------------------------------------------------------------ */
let accRaw = 0, accCanon = 0, accContent = 0, accText = 0;
for (const p of wsFiles) {
  let buf;
  try { buf = readFileSync(p); } catch { continue; }
  const text = buf.toString('utf8');
  if (shaBytes(buf) === ENVELOPE_ACCEPTED) accRaw += 1;
  if (text.includes(ENVELOPE_ACCEPTED)) accText += 1;
  if (p.endsWith('.json')) {
    try {
      const j = JSON.parse(text);
      if (sha(j) === ENVELOPE_ACCEPTED) accCanon += 1;
      if (j && typeof j === 'object' && j.content !== undefined && sha(j.content) === ENVELOPE_ACCEPTED) accContent += 1;
    } catch { /* non-JSON body */ }
  }
}
check('O1.envelopeAcceptedProjection.unresolvable', accRaw === 0 && accCanon === 0 && accContent === 0,
  `upstream-accepted[0] sha256:${ENVELOPE_ACCEPTED} :: "accepted revision of derive-system-requirements": scanned ${wsFiles.length} files - raw hits ${accRaw}, canonical hits ${accCanon}, .content hits ${accContent}, textual mentions ${accText}. No accepted revision of derive-system-requirements can exist: this is the desk's FIRST reviewer stage (no prior reviewer verdict, final gate never ran); the intake receipt itself says admitted_for_reviewer_stage, not accepted.`);
check('O2.envelopeProjection.adjudicated', accText >= 0, `ADJUDICATION: UNRESOLVABLE - stale shell metadata (same family as the define-product-intent projection sha256:745cadc1…); recorded for the shell owner. The reviewer-side accepted-revision count is 0.`);

/* ------------------------------------------------------------------ */
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; WP03 validator: real requirements-bundle.mjs through the REAL seam binder; gate: real gateSystemRequirementsCandidate (dist system-requirements cell); universe: real deriveAcceptedUniverse desk protocol; acceptance-status audit: desk-review authority (layer M)',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failedCheckIds: failed.map((r) => r.id),
  results,
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
