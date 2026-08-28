/**
 * define-product-intent desk (author) - digest + contract recomputation
 * evidence (r2).
 *
 * Frozen kernel rule: src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Runs the REAL WP03 validator (validatePrdIntentMember) against the
 * accepted id-set universe, recomputes EVERY declared digest (submission,
 * artifact, trace, six member seals), re-derives the trace coverage
 * projections from the relationship edge set, cross-checks the
 * task-projection content addresses, and validates the payload contract
 * evidence set. Nothing is trusted by declaration.
 *
 * Run: node define-product-intent-desk-author-verify.mjs
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
const wp03 = await import(pathToFileURL(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href);

const sub = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-submission.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent-trace.json'), 'utf8'));

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

/* A. artifact self-address */
check('A1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('A2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('A3.artifact.kindPins', art.content.schemaVersion === 'frf-cell.product-intent.v1' && art.productKind === 'frf-cell.product-intent.v1' && art.deskRef === 'define-product-intent' && art.role === 'author', 'bundle kind + desk pins');

/* B. every member through the REAL WP03 validator + seal recomputation */
const universe = { idSets: { sourceClaimIds: Object.keys(ENVELOPE).filter((id) => id.startsWith('claim:')), terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'] } };
const FORBIDDEN = ['acceptance', 'acceptanceCriteria', 'fr', 'nfr', 'requirements', 'rule', 'scenarios', 'srs', 'useCases'];
const fenceHit = FORBIDDEN.filter((k) => art.content[k] !== undefined);
check('B1.bundle.fence', fenceHit.length === 0, fenceHit.length === 0 ? 'no forbidden bundle keys' : `forbidden keys present: ${fenceHit.join(', ')}`);
check('B2.bundle.brief', typeof art.content.brief === 'string' && art.content.brief.length > 0, 'non-empty brief');
check('B3.bundle.members', Array.isArray(art.content.members) && art.content.members.length > 0, `${art.content.members?.length} members`);
const seals = new Map();
let membersOk = true;
const seen = new Set();
const citedClaims = new Set();
for (const m of art.content.members) {
  const v = wp03.validatePrdIntentMember(m, universe);
  const dup = typeof m.memberId === 'string' && !seen.has(m.memberId);
  seen.add(m.memberId);
  const sealOk = v.ok && dup && sha(m) === art.content.memberSeals.find((s) => s.memberId === m.memberId)?.digest;
  membersOk = membersOk && sealOk;
  check(`B4.member.${m.memberId ?? '?'}`, sealOk, v.ok ? `WP03 seal recomputed ${sha(m).slice(0, 16)}…` : `WP03 refusal ${v.reason}: ${v.detail}`);
  for (const r of m.sourceClaimRefs ?? []) citedClaims.add(r);
  for (const r of m.scopeClaimRefs ?? []) citedClaims.add(r);
}
check('B5.noDuplicateMemberIds', seen.size === art.content.members.length, `${seen.size} unique ids`);

/* C. desk coverage law (gate step 7): every accepted source claim cited */
const missing = universe.idSets.sourceClaimIds.filter((c) => !citedClaims.has(c));
check('C1.coverageLaw', missing.length === 0, missing.length === 0 ? `all ${universe.idSets.sourceClaimIds.length} source claims covered` : `COVERAGE_GAP: ${missing.join(', ')}`);

/* D. terminal ownership + dispositions honesty */
const ownership = new Map(art.content.terminalOwnership.map((t) => [t.terminalClaimId, t.ownedByMemberId]));
let termOk = true;
for (const t of universe.idSets.terminalClaimIds) {
  const owner = ownership.get(t);
  const member = art.content.members.find((m) => m.memberId === owner);
  const ok = owner !== undefined && Array.isArray(member?.terminalClaimRefs) && member.terminalClaimRefs.includes(t);
  termOk = termOk && ok;
  check(`D1.terminalOwned.${t}`, ok, `owned by ${owner}`);
}
const dispositions = art.content.members.map((m) => m.disposition.disposition).sort();
check('D2.dispositionsClosed', dispositions.every((d) => ['deferred', 'direct_requirement', 'out_of_scope', 'scenario_required'].includes(d)), dispositions.join(', '));

/* E. constraint + unknown dispositions honest */
const con = art.content.constraintDispositions.find((c) => c.constraintId === 'constraint:retention-1');
check('E1.constraintHonored', con !== undefined && con.disposition === 'honored' && con.digest === ENVELOPE['constraint:retention-1'], con?.disposition);
const unk = art.content.unknownDispositions.find((u) => u.unknownId === 'unknown:browser-matrix-1');
check('E2.unknownCarried', unk !== undefined && unk.disposition === 'carried_forward' && unk.owner === 'discovery' && unk.digest === ENVELOPE['unknown:browser-matrix-1'], `${unk?.disposition}, owner=${unk?.owner}`);

/* F. upstream binding matches the task projection + r2 import product */
let upOk = art.content.upstream.capsuleDigest === CAPSULE && art.content.upstream.importArtifactDigest === IMPORT_ARTIFACT && art.content.upstream.certificateRef === shaRef(CERT);
for (const entry of art.content.upstream.verifiedSubArtifacts) {
  upOk = upOk && ENVELOPE[entry.id] === entry.digest && entry.ref === shaRef(entry.digest);
}
check('F1.upstreamBinding', upOk, `${art.content.upstream.verifiedSubArtifacts.length} sub-artifacts + capsule + import artifact + certificate`);
check('F2.governingContract', art.content.governingContractRef === shaRef(GOVERNING), art.content.governingContractRef);

/* G. trace self-address + every relationship resolves to recomputed digests */
check('G1.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)} vs declared ${trc.contentDigest}`);
check('G2.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), trc.traceRef);
check('G3.submission.traceRef.binding', sub.content.traceRef === trc.traceRef, sub.content.traceRef);
const digestIndex = new Map([
  ...Object.entries(ENVELOPE),
  ...art.content.memberSeals.map((s) => [s.memberId, s.digest]),
]);
const VOCAB = new Set(trc.content.relationVocabulary);
let relOk = true;
for (const [i, rel] of trc.content.relationships.entries()) {
  const fromExpect = digestIndex.get(rel.fromId);
  const toExpect = digestIndex.get(rel.toId);
  const ok = VOCAB.has(rel.relation) && fromExpect !== undefined && toExpect !== undefined
    && rel.fromRef === shaRef(fromExpect) && rel.toRef === shaRef(toExpect);
  relOk = relOk && ok;
  if (!ok) check(`G4.rel[${i}]`, false, `${rel.fromId} -${rel.relation}-> ${rel.toId} refs do not resolve to recomputed digests`);
}
check('G4.relationships.resolve', relOk, `${trc.content.relationships.length} relationships checked against recomputed digests`);

/* G5. the unknown has NO resolution edges (carried, not resolved) */
const unkEdges = trc.content.relationships.filter((r) => r.fromId === 'unknown:browser-matrix-1' || r.toId === 'unknown:browser-matrix-1');
check('G5.unknown.noResolutionEdges', unkEdges.length === 0, `${unkEdges.length} edges touch the unknown`);

/* H. coverage blocks are exact projections of the edge set */
const edgeProjection = (memberId, relation) => trc.content.relationships
  .filter((r) => r.fromId === memberId && r.relation === relation).map((r) => r.toId).sort();
let covOk = true;
for (const [memberId, cov] of Object.entries(trc.content.memberCoverage)) {
  const expect = { digest: digestIndex.get(memberId), derivedFrom: edgeProjection(memberId, 'derived_from'), enforces: edgeProjection(memberId, 'enforces'), constrainedBy: edgeProjection(memberId, 'constrained_by'), supports: edgeProjection(memberId, 'supports') };
  const got = { digest: cov.digest, derivedFrom: [...(cov.derivedFrom ?? [])].sort(), enforces: [...(cov.enforces ?? [])].sort(), constrainedBy: [...(cov.constrainedBy ?? [])].sort(), supports: [...(cov.supports ?? [])].sort() };
  const ok = JSON.stringify(got) === JSON.stringify(expect);
  covOk = covOk && ok;
  if (!ok) check(`H.memberCoverage.${memberId}`, false, `projection mismatch: ${JSON.stringify(got)} vs ${JSON.stringify(expect)}`);
}
check('H1.memberCoverage.projection', covOk, `${Object.keys(trc.content.memberCoverage).length} member coverage blocks recomputed from the edge set`);
let termCovOk = true;
for (const t of universe.idSets.terminalClaimIds) {
  const expect = trc.content.relationships.filter((r) => r.relation === 'supports' && r.toId === t).map((r) => r.fromId).sort();
  const got = trc.content.terminalCoverage[t];
  const ok = got !== undefined && got.digest === ENVELOPE[t] && JSON.stringify([...(got.supportedBy ?? [])].sort()) === JSON.stringify(expect);
  termCovOk = termCovOk && ok;
  check(`H2.terminalCoverage.${t}`, ok, `supportedBy=${(got?.supportedBy ?? []).join(',')}`);
}
const conExpect = {
  enforcedBy: trc.content.relationships.filter((r) => r.relation === 'enforces' && r.toId === 'constraint:retention-1').map((r) => r.fromId).sort(),
  constrainedMembers: trc.content.relationships.filter((r) => r.relation === 'constrained_by' && r.toId === 'constraint:retention-1').map((r) => r.fromId).sort(),
};
const conGot = trc.content.constraintCoverage;
check('H3.constraintCoverage.projection', conGot.digest === ENVELOPE['constraint:retention-1']
  && JSON.stringify([...(conGot.enforcedBy ?? [])].sort()) === JSON.stringify(conExpect.enforcedBy)
  && JSON.stringify([...(conGot.constrainedMembers ?? [])].sort()) === JSON.stringify(conExpect.constrainedMembers),
  `enforcedBy=${conGot.enforcedBy?.join(',')} constrained=${conGot.constrainedMembers?.join(',')}`);

/* I. submission self-address + candidate binding + payload contract */
check('I1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('I2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);
check('I3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest, sub.content.candidate.artifactRef);
const EXPECTED_EVIDENCE = [shaRef(CAPSULE), shaRef(CERT), ...Object.values(ENVELOPE).map(shaRef), shaRef(GOVERNING)].sort();
const gotEvidence = [...sub.content.payloadContract.requiredEvidenceRefs].sort();
check('I4.evidenceRefs.exact', JSON.stringify(gotEvidence) === JSON.stringify(EXPECTED_EVIDENCE), `${gotEvidence.length} refs, exact set match`);
const cov = sub.content.payloadContract.evidenceKindCoverage;
check('I5.evidenceKindCoverage', cov['discovery-handoff-capsule'] === 1 && cov['discovery-certificate'] === 1 && cov['source-claim'] === 4 && cov['constraint'] === 1 && cov['unknown'] === 1 && cov['terminal-claim'] === 2 && cov['architecture-contract'] === 1, JSON.stringify(cov));
check('I6.selfCheck.allSatisfied', sub.content.acceptanceCriteriaSelfCheck.every((c) => c.satisfied === true), `${sub.content.acceptanceCriteriaSelfCheck.length} criteria`);

/* J. workspace law + determinism pins */
check('J1.workspace.zeroUpstream', art.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && trc.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && sub.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0, art.content.workspaceSummary);
check('J2.determinism.pinnedTimestamps', art.createdAt === '2026-08-28T00:00:00Z' && trc.createdAt === '2026-08-28T00:00:00Z' && sub.createdAt === '2026-08-28T00:00:00Z', art.createdAt);
check('J3.verificationFlags', Object.entries(art.content.verification).every(([k, v]) => (k === 'declaredDigestsTrusted' ? v === false : v === true || v === 0)), JSON.stringify(art.content.verification));

/* K. the REAL cell gate (kernel verdict over the presented bundle) */
const cell = await import(pathToFileURL(join(REPO_ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'product-intent', 'index.js')).href);
const validatorBytes = readFileSync(join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs'));
const install = cell.installProductIntentContract({
  contractKind: 'frf-contracts.prd-intent-member.v1',
  validatorDigest: createHash('sha256').update(validatorBytes).digest('hex'),
  validateMember: (m, u) => wp03.validatePrdIntentMember(m, u),
});
check('K1.seamInstall', install.installed === true, 'WP03 seam installed into the cell');
const bundle = { schemaVersion: art.content.schemaVersion, brief: art.content.brief, members: art.content.members };
const gate = cell.evaluateProductIntentGate(cell.declaredProductIntentCheckProvider(), bundle, universe);
check('K2.gateVerdict.accepted', gate.verdict === 'accepted', JSON.stringify(gate.issues));
check('K3.gateProductRef', gate.productRef === shaRef(sha(bundle)), gate.productRef);
check('K4.acceptedSet.memberIds', JSON.stringify(gate.acceptedSet.prdMemberIds) === JSON.stringify(art.content.members.map((m) => m.memberId)), gate.acceptedSet.prdMemberIds.join(', '));

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; WP03 validator: real prd-intent-member.mjs',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
