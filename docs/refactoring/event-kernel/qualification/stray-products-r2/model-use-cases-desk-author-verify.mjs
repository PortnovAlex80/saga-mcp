/**
 * model-use-cases desk (author) - digest + contract recomputation
 * evidence (r2).
 *
 * Frozen kernel rule: src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Runs the REAL WP03 validator (validateUcScenarioMember) against the
 * exact accepted upstream intent set, recomputes EVERY declared digest
 * (submission, artifact, trace, three scenario seals), re-derives the
 * upstream accepted-intent fold with the REAL product-intent cell fold
 * (acceptedIntentSetOf) over seals recomputed through the REAL
 * validatePrdIntentMember, re-derives the trace coverage projections
 * from the relationship edge set, cross-checks the task-projection
 * content addresses, validates the payload contract evidence set, runs
 * the REAL model-use-cases cell gate (evaluateUcGate over the presented
 * bundle), and negative-probes the validator (foreign lineage, scope
 * violation, actorless). Nothing is trusted by declaration.
 *
 * Run: node model-use-cases-desk-author-verify.mjs
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
const uc03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'uc-scenario-member.mjs')).href);
const prd03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href);
const upCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'product-intent', 'index.js')).href);
const ucCell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'use-cases', 'index.js')).href);

const sub = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-product-submission.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios-trace.json'), 'utf8'));
const upArt = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));

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
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const IMPORT_ARTIFACT = 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5';
const UPSTREAM_TRACE = '6e35f34ccb5a74cb18e2b0c8a7302587018a6e4a11baa787c1a5815926eb35d9';
const UPSTREAM_SUBMISSION = '91878e07e14b01789737d9a7bd49075c01a9691f7c751b339bd2d34727ba50e0';

/* A. artifact self-address */
check('A1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('A2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('A3.artifact.kindPins', art.content.schemaVersion === 'frf-cell.uc-scenarios.v1' && art.productKind === 'frf-cell.uc-scenarios.v1' && art.deskRef === 'model-use-cases' && art.role === 'author', 'bundle kind + desk pins');

/* B. the REAL upstream fold: upstream members through the REAL WP03 PRD
      validator, seals recomputed, accepted-intent set re-folded by the
      REAL product-intent cell fold (declared upstream never trusted). */
const upSeal = new Map();
let upOk = true;
const seenUp = new Set();
for (const m of upArt.content.members) {
  const v = prd03.validatePrdIntentMember(m, { idSets: { sourceClaimIds: Object.keys(ENVELOPE).filter((id) => id.startsWith('claim:')), terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'] } });
  const digest = sha(m);
  const declared = upArt.content.memberSeals.find((s) => s.memberId === m.memberId)?.digest;
  const ok = v.ok && !seenUp.has(m.memberId) && digest === declared;
  seenUp.add(m.memberId);
  upOk = upOk && ok;
  check(`B1.upstreamMember.${m.memberId ?? '?'}`, ok, v.ok ? `PRD seal recomputed ${digest.slice(0, 16)}…` : `WP03 PRD refusal ${v.reason}: ${v.detail}`);
  upSeal.set(m.memberId, digest);
}
const upFold = upCell.acceptedIntentSetOf(
  { members: upArt.content.members },
  upArt.content.members.map((m) => ({ memberId: m.memberId, digest: upSeal.get(m.memberId) })),
);
check('B2.upstreamFold.ok', upFold.ok === true, upFold.ok ? `revisionDigest ${upFold.set.revisionDigest.slice(0, 16)}…` : upFold.detail);
const universe = { idSets: { prdMemberIds: upFold.ok ? [...upFold.set.prdMemberIds] : [] } };
const upBound = art.content.upstream.acceptedIntentSet;
check('B3.upstreamBinding.exact', upFold.ok && JSON.stringify(upBound) === JSON.stringify({
  memberDigests: upFold.set.memberDigests,
  prdMemberIds: upFold.set.prdMemberIds,
  revisionDigest: upFold.set.revisionDigest,
  scenarioRequiredMemberIds: upFold.set.scenarioRequiredMemberIds,
}), upFold.ok ? `scenarioRequired=${upFold.set.scenarioRequiredMemberIds.join(', ')}` : 'fold failed');
check('B4.upstream.artifactRef', art.content.upstream.acceptedIntentArtifactDigest === upArt.contentDigest
  && art.content.upstream.acceptedIntentTraceRef === shaRef(UPSTREAM_TRACE)
  && art.content.upstream.acceptedIntentSubmissionRef === shaRef(UPSTREAM_SUBMISSION)
  && art.content.upstream.importArtifactRef === shaRef(IMPORT_ARTIFACT)
  && art.content.upstream.capsuleRef === shaRef(CAPSULE)
  && art.content.upstream.certificateRef === shaRef(CERT), art.content.upstream.acceptedIntentArtifactRef);
let envOk = art.content.upstream.verifiedSubArtifacts.length === Object.keys(ENVELOPE).length;
for (const entry of art.content.upstream.verifiedSubArtifacts) {
  envOk = envOk && ENVELOPE[entry.id] === entry.digest && entry.ref === shaRef(entry.digest);
}
check('B5.upstream.taskProjection', envOk, `${art.content.upstream.verifiedSubArtifacts.length} sub-artifact content addresses match the task-projection envelope`);
check('B6.upstream.seals', JSON.stringify(art.content.upstream.acceptedIntentSeals.map((s) => [s.memberId, s.digest])) === JSON.stringify(upArt.content.memberSeals.map((s) => [s.memberId, s.digest])), `${art.content.upstream.acceptedIntentSeals.length} upstream seals carried by content address`);

/* C. every authored scenario through the REAL WP03 validator + seal recomputation */
const FORBIDDEN = ['acceptance', 'acceptanceCriteria', 'frRefs', 'nfrRefs', 'requirementRefs', 'requirements', 'ruleRefs'];
const fenceHit = FORBIDDEN.filter((k) => art.content[k] !== undefined);
check('C1.bundle.fence', fenceHit.length === 0, fenceHit.length === 0 ? 'no forbidden bundle keys' : `forbidden keys present: ${fenceHit.join(', ')}`);
check('C2.bundle.brief', typeof art.content.brief === 'string' && art.content.brief.length > 0, 'non-empty brief');
check('C3.bundle.scenarios', Array.isArray(art.content.scenarios) && art.content.scenarios.length > 0, `${art.content.scenarios?.length} scenarios`);
const seals = new Map();
let scenariosOk = true;
const seen = new Set();
const coveredMembers = new Set();
for (const s of art.content.scenarios) {
  const v = uc03.validateUcScenarioMember(s, universe);
  const noDup = typeof s.scenarioId === 'string' && !seen.has(s.scenarioId);
  seen.add(s.scenarioId);
  const sealOk = v.ok && noDup && sha(s) === art.content.scenarioSeals.find((e) => e.scenarioId === s.scenarioId)?.digest;
  scenariosOk = scenariosOk && sealOk;
  check(`C4.scenario.${s.scenarioId ?? '?'}`, sealOk, v.ok ? `WP03 seal recomputed ${sha(s).slice(0, 16)}…` : `WP03 refusal ${v.reason}: ${v.detail}`);
  for (const r of s.prdIntentRefs ?? []) coveredMembers.add(r);
}
check('C5.noDuplicateScenarioIds', seen.size === art.content.scenarios.length, `${seen.size} unique ids`);
check('C6.scenarioSeals.exact', art.content.scenarioSeals.length === art.content.scenarios.length, `${art.content.scenarioSeals.length} seals`);

/* D. the UC coverage fence (gate step 8) over the REAL upstream fold */
const missing = upFold.ok ? upFold.set.scenarioRequiredMemberIds.filter((m) => !coveredMembers.has(m)) : ['<fold-failed>'];
check('D1.coverageFence', missing.length === 0, missing.length === 0 ? `all ${upFold.set.scenarioRequiredMemberIds.length} scenario_required members covered` : `COVERAGE_GAP: ${missing.join(', ')}`);
const foreignCover = [...coveredMembers].filter((m) => !upFold.set.prdMemberIds.includes(m));
check('D2.noForeignCoverage', foreignCover.length === 0, foreignCover.length === 0 ? 'no covered member outside the accepted set' : `foreign: ${foreignCover.join(', ')}`);
const outOfScopeCovered = coveredMembers.has('prd:scope-2');
check('D3.outOfScopeNotCovered', !outOfScopeCovered, 'prd:scope-2 (out_of_scope at intent freeze) derives no scenario');

/* E. constraint + unknown dispositions honest */
const con = art.content.constraintDispositions.find((c) => c.constraintId === 'constraint:retention-1');
check('E1.constraintHonored', con !== undefined && con.disposition === 'honored' && con.digest === ENVELOPE['constraint:retention-1'], con?.disposition);
const unk = art.content.unknownDispositions.find((u) => u.unknownId === 'unknown:browser-matrix-1');
check('E2.unknownCarried', unk !== undefined && unk.disposition === 'carried_forward' && unk.owner === 'discovery' && unk.digest === ENVELOPE['unknown:browser-matrix-1'], `${unk?.disposition}, owner=${unk?.owner}`);
check('E3.determinism.noClockNoRandom', art.createdAt === '2026-08-28T00:00:00Z' && !/created(new)?(At)?\s*[:=]\s*(new Date|Date\.now|Math\.random)/i.test(JSON.stringify(art.content)), 'pinned timestamps, no clock/random reads in authored content');

/* F. terminal claims: ownership stays upstream, support recorded per scenario */
let termOk = true;
for (const t of art.content.terminalOwnership) {
  const digest = ENVELOPE[t.terminalClaimId];
  const owner = upArt.content.members.find((m) => m.memberId === t.ownedByMemberId);
  const ownerSupports = Array.isArray(owner?.terminalClaimRefs) && owner.terminalClaimRefs.includes(t.terminalClaimId);
  const scenario = art.content.scenarios.find((s) => s.scenarioId === t.supportedByScenarioId);
  const ok = digest !== undefined && ownerSupports && scenario !== undefined;
  termOk = termOk && ok;
  check(`F1.terminal.${t.terminalClaimId}`, ok, `owned upstream by ${t.ownedByMemberId}, supported by ${t.supportedByScenarioId}`);
}

/* G. trace self-address + every relationship resolves to recomputed digests */
check('G1.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)} vs declared ${trc.contentDigest}`);
check('G2.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), trc.traceRef);
check('G3.submission.traceRef.binding', sub.content.traceRef === trc.traceRef, sub.content.traceRef);
check('G4.trace.subjectBinding', trc.content.subjectArtifactRef === art.artifactRef, trc.content.subjectArtifactRef);
const digestIndex = new Map([
  ...Object.entries(ENVELOPE),
  ...[...upSeal.entries()],
  ...art.content.scenarioSeals.map((s) => [s.scenarioId, s.digest]),
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
for (const [scenarioId, cov] of Object.entries(trc.content.scenarioCoverage)) {
  const expect = { digest: digestIndex.get(scenarioId), derivedFrom: edgeProjection(scenarioId, 'derived_from'), enforces: edgeProjection(scenarioId, 'enforces'), supports: edgeProjection(scenarioId, 'supports') };
  const got = { digest: cov.digest, derivedFrom: [...(cov.derivedFrom ?? [])].sort(), enforces: [...(cov.enforces ?? [])].sort(), supports: [...(cov.supports ?? [])].sort() };
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  covOk = covOk && ok;
  if (!ok) check(`H.scenarioCoverage.${scenarioId}`, false, `projection mismatch: ${JSON.stringify(got)} vs ${JSON.stringify(expect)}`);
}
check('H1.scenarioCoverage.projection', covOk, `${Object.keys(trc.content.scenarioCoverage).length} scenario coverage blocks recomputed from the edge set`);
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
const conConstrained = trc.content.relationships.filter((r) => r.relation === 'constrained_by' && r.toId === 'constraint:retention-1').map((r) => r.fromId).sort();
check('H4.constraintCoverage.projection', conGot.digest === ENVELOPE['constraint:retention-1']
  && JSON.stringify([...(conGot.enforcedBy ?? [])].sort()) === JSON.stringify(conEnforcedBy)
  && JSON.stringify([...(conGot.constrainedMembers ?? [])].sort()) === JSON.stringify(conConstrained)
  && JSON.stringify([...(con.enforcedBy ?? [])].sort()) === JSON.stringify(conEnforcedBy),
  `enforcedBy=${conGot.enforcedBy?.join(',')} constrained=${conGot.constrainedMembers?.join(',')}`);

/* I. submission self-address + candidate binding + payload contract */
check('I1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('I2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);
check('I3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest && sub.content.candidate.kind === 'frf-cell.uc-scenarios.v1', sub.content.candidate.artifactRef);
const EXPECTED_EVIDENCE = [shaRef(upArt.contentDigest), shaRef(CAPSULE), shaRef(CERT), ...Object.values(ENVELOPE).map(shaRef), shaRef(GOVERNING)].sort();
const gotEvidence = [...sub.content.payloadContract.requiredEvidenceRefs].sort();
check('I4.evidenceRefs.exact', JSON.stringify(gotEvidence) === JSON.stringify(EXPECTED_EVIDENCE), `${gotEvidence.length} refs, exact set match`);
const cov = sub.content.payloadContract.evidenceKindCoverage;
check('I5.evidenceKindCoverage', cov['accepted-prd-intent-bundle'] === 1 && cov['discovery-handoff-capsule'] === 1 && cov['discovery-certificate'] === 1 && cov['source-claim'] === 4 && cov['constraint'] === 1 && cov['unknown'] === 1 && cov['terminal-claim'] === 2 && cov['architecture-contract'] === 1, JSON.stringify(cov));
check('I6.selfCheck.allSatisfied', sub.content.acceptanceCriteriaSelfCheck.every((c) => c.satisfied === true), `${sub.content.acceptanceCriteriaSelfCheck.length} criteria`);
check('I7.governingContract', art.content.governingContractRef === shaRef(GOVERNING), art.content.governingContractRef);

/* J. workspace law + determinism pins */
check('J1.workspace.zeroUpstream', art.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && trc.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && sub.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0, art.content.workspaceSummary);
check('J2.determinism.pinnedTimestamps', art.createdAt === '2026-08-28T00:00:00Z' && trc.createdAt === '2026-08-28T00:00:00Z' && sub.createdAt === '2026-08-28T00:00:00Z', art.createdAt);
check('J3.verificationFlags', Object.entries(art.content.verification).every(([k, v]) => (k === 'declaredDigestsTrusted' ? v === false : v === true || v === 0)), JSON.stringify(art.content.verification));

/* K. the REAL cell gate (kernel verdict over the presented bundle) */
const provider = ucCell.declaredUcCheckProvider();
const bundle = { schemaVersion: art.content.schemaVersion, scenarios: art.content.scenarios };
const gate = ucCell.evaluateUcGate(provider, bundle, upFold.ok ? upFold.set : undefined);
check('K1.gateVerdict.accepted', gate.verdict === 'accepted', JSON.stringify(gate.issues));
check('K2.gateProductRef', gate.productRef === shaRef(sha(bundle)), gate.productRef);
check('K3.acceptedSet.scenarioIds', JSON.stringify(gate.acceptedSet?.scenarioIds) === JSON.stringify(art.content.scenarios.map((s) => s.scenarioId)), (gate.acceptedSet?.scenarioIds ?? []).join(', '));
const expectedBranches = {};
for (const s of art.content.scenarios) expectedBranches[s.scenarioId] = s.terminalBranches.map((b) => b.branchId);
check('K4.acceptedSet.branchIdsByScenario', JSON.stringify(gate.acceptedSet?.branchIdsByScenario) === JSON.stringify(expectedBranches), JSON.stringify(gate.acceptedSet?.branchIdsByScenario));
check('K5.acceptedSet.coveredPrdMemberIds', JSON.stringify(gate.acceptedSet?.coveredPrdMemberIds) === JSON.stringify([...coveredMembers].sort()), (gate.acceptedSet?.coveredPrdMemberIds ?? []).join(', '));
check('K6.acceptedSet.revisionDigest', gate.acceptedSet?.revisionDigest === sha({ memberDigests: art.content.scenarioSeals.map((s) => s.digest).sort() }), gate.acceptedSet?.revisionDigest);
const protocol = ucCell.ucCellProtocol();
check('K7.cellProtocol', protocol.nodeId === 'model-use-cases' && protocol.productKind === 'frf-cell.uc-scenarios.v1' && protocol.output.memberField === 'scenarios' && protocol.declaredTransitions.some((t) => t.on === 'domain.accepted' && t.to === 'derive-system-requirements'), 'desk protocol pins + successor');
const drafts = ucCell.scenarioDraftsOfAcceptedIntents(upFold.set).map((d) => d.scenarioId);
check('K8.seededDraftIds', JSON.stringify(drafts) === JSON.stringify(art.content.scenarios.map((s) => s.scenarioId)), drafts.join(', '));

/* L. negative probes on mutated copies (the validator refuses, never the desk) */
const foreignProbe = uc03.validateUcScenarioMember(
  { ...structuredClone(art.content.scenarios[0]), scenarioId: 'uc:foreign-probe', prdIntentRefs: ['prd:foreign-member'] },
  universe,
);
check('L1.probe.foreignLineage', foreignProbe.ok === false && foreignProbe.reason === 'FOREIGN_LINEAGE', `${foreignProbe.reason}: ${foreignProbe.detail.slice(0, 80)}…`);
const scopeProbe = uc03.validateUcScenarioMember(
  { ...structuredClone(art.content.scenarios[0]), scenarioId: 'uc:scope-probe', requirementRefs: ['fr:pre-existing'] },
  universe,
);
check('L2.probe.scopeViolation', scopeProbe.ok === false && scopeProbe.reason === 'SCOPE_VIOLATION', `${scopeProbe.reason}: ${scopeProbe.detail.slice(0, 80)}…`);
const actorlessProbe = uc03.validateUcScenarioMember(
  { ...structuredClone(art.content.scenarios[0]), scenarioId: 'uc:actorless-probe', actorKind: undefined },
  universe,
);
check('L3.probe.actorless', actorlessProbe.ok === false && actorlessProbe.reason === 'MALFORMED_PRODUCT', `${actorlessProbe.reason}: ${actorlessProbe.detail.slice(0, 80)}…`);
const gateForeign = ucCell.evaluateUcGate(provider, bundle, { ...upFold.set, prdMemberIds: ['prd:only-someone-elses-run'] });
check('L4.probe.gateForeignLineage', gateForeign.verdict === 'upstream-repair', `${gateForeign.verdict}: ${(gateForeign.issues ?? []).map((i) => i.source).join(',')}`);
const gateNoUpstream = ucCell.evaluateUcGate(provider, bundle, undefined);
check('L5.probe.gateNoUpstream', gateNoUpstream.refused === true && gateNoUpstream.reason === 'UPSTREAM_NOT_SUPPLIED', `${gateNoUpstream.reason}: ${gateNoUpstream.detail.slice(0, 80)}…`);

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; WP03 validator: real uc-scenario-member.mjs; gate: real evaluateUcGate (dist use-cases cell)',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
