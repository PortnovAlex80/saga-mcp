/**
 * import-discovery-handoff desk (reviewer) - digest recomputation evidence.
 *
 * Frozen kernel rule: src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Recomputes EVERY declared digest of the r2 author candidate
 * (submission, discovery-import artifact, trace, all 9 sub-artifacts,
 * the capsule self-address over its recorded facts), cross-checks all
 * 8 reviewer-envelope task-projection content addresses, verifies the
 * trace graph resolves against recomputed digests, and checks the
 * payload contract evidence set. Nothing is trusted by declaration.
 *
 * Run: node import-discovery-handoff-desk-reviewer-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
const sub = JSON.parse(readFileSync(join(DIR, 'import-discovery-handoff-desk-product-submission.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(DIR, 'import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'import-discovery-handoff-desk-discovery-import-trace.json'), 'utf8'));

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); return ok; };

/* A. submission self-address */
check('A1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('A2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);

/* B. artifact self-address + candidate binding */
check('B1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('B2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('B3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest, sub.content.candidate.artifactRef);

/* C. trace self-address + binding */
check('C1.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)} vs declared ${trc.contentDigest}`);
check('C2.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), trc.traceRef);
check('C3.submission.traceRef.binding', sub.content.traceRef === trc.traceRef, sub.content.traceRef);

/* D. every sub-artifact digest recomputed over canonical content */
const vsa = art.content.verifiedSubArtifacts;
const flat = [
  ['certificate', vsa.certificate],
  ...vsa.sourceClaims.map((x) => [`sourceClaim:${x.semanticCode}`, x]),
  ...vsa.constraints.map((x) => [`constraint:${x.semanticCode}`, x]),
  ...vsa.unknowns.map((x) => [`unknown:${x.semanticCode}`, x]),
  ...vsa.terminalLifecycleClaims.map((x) => [`terminalClaim:${x.semanticCode}`, x]),
];
let allSubsOk = true;
for (const [label, x] of flat) {
  const recomputed = sha(x.content);
  const ok = recomputed === x.digest && x.digest.length === 64;
  allSubsOk = allSubsOk && ok;
  check(`D.${label}`, ok, `recomputed ${recomputed} vs declared ${x.digest}`);
}

/* E. envelope task-projection cross-check (reviewer frame, content addresses) */
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
const idOf = { 'sourceClaim:SC-1': 'claim:scope-1', 'sourceClaim:SC-2': 'claim:scope-2', 'sourceClaim:SC-3': 'claim:constraint-1', 'sourceClaim:SC-4': 'claim:outcome-1', 'constraint:CON-1': 'constraint:retention-1', 'unknown:UNK-1': 'unknown:browser-matrix-1', 'terminalClaim:TC-1': 'terminal:audited-1', 'terminalClaim:TC-2': 'terminal:delivered-1' };
for (const [label, x] of flat) {
  const envelopeId = idOf[label];
  if (envelopeId === undefined) continue;
  const key = x.content.claimId ?? x.content.constraintId ?? x.content.unknownId;
  check(`E.${envelopeId}`, key === envelopeId && x.digest === ENVELOPE[envelopeId], `content id ${key}, digest match=${x.digest === ENVELOPE[envelopeId]}`);
}

/* F. capsule self-address recomputed from the recorded facts (ingress.ts factBody) */
const strip = (x) => ({ ref: shaRef(x.digest), digest: x.digest });
const factBody = {
  schemaVersion: art.content.protocolVersion,
  lineage: art.content.lineage,
  parentState: art.content.parentState,
  certificate: strip(vsa.certificate),
  sourceClaims: vsa.sourceClaims.map(strip),
  constraints: vsa.constraints.map(strip),
  unknowns: vsa.unknowns.map(strip),
  terminalLifecycleClaims: vsa.terminalLifecycleClaims.map(strip),
  packageBytesDigest: art.content.packageBytesDigest,
};
const recomputedCapsule = sha(factBody);
const cap = art.content.capsule;
check('F1.capsule.selfAddress', recomputedCapsule === cap.capsuleDigest, `recomputed ${recomputedCapsule} vs declared ${cap.capsuleDigest}`);
check('F2.capsule.refForm', cap.capsuleRef === shaRef(cap.capsuleDigest), cap.capsuleRef);

/* G. protocol version pinned */
check('G.protocolVersion', art.content.protocolVersion === 'ek.discovery-handoff-capsule.ek8-wp11f.v1', art.content.protocolVersion);

/* H. trace graph integrity over recomputed digests */
const digestIndex = new Map([
  ['DI-Import-Discovery-Handoff-001', art.contentDigest],
  ['CERT-1', vsa.certificate.digest],
  ...vsa.sourceClaims.map((x) => [x.semanticCode, x.digest]),
  ...vsa.constraints.map((x) => [x.semanticCode, x.digest]),
  ...vsa.unknowns.map((x) => [x.semanticCode, x.digest]),
  ...vsa.terminalLifecycleClaims.map((x) => [x.semanticCode, x.digest]),
]);
const idIndex = new Map(Object.entries(ENVELOPE));
const idToSemantic = new Map([...idIndex.keys()].map((id) => {
  const hit = flat.find(([, x]) => (x.content.claimId ?? x.content.constraintId ?? x.content.unknownId) === id);
  return [id, hit === undefined ? undefined : hit[0].split(':')[1]];
}));
const VOCAB = new Set(trc.content.relationVocabulary);
let relOk = true;
for (const [i, rel] of trc.content.relationships.entries()) {
  const toDigest = idIndex.get(rel.toId);
  const fromSemantic = idToSemantic.get(rel.fromId);
  const toSemantic = idToSemantic.get(rel.toId);
  const fromRefExpect = idIndex.get(rel.fromId) ?? (rel.fromId === 'DI-Import-Discovery-Handoff-001' ? art.contentDigest : undefined);
  const ok = VOCAB.has(rel.relation)
    && fromRefExpect !== undefined && rel.fromRef === shaRef(fromRefExpect)
    && toDigest !== undefined && rel.toRef === shaRef(toDigest)
    && (fromSemantic === undefined || digestIndex.get(fromSemantic) === fromRefExpect)
    && (toSemantic === undefined || digestIndex.get(toSemantic) === toDigest);
  relOk = relOk && ok;
  if (!ok) check(`H.rel[${i}]`, false, `${rel.fromId} -${rel.relation}-> ${rel.toId} refs do not resolve to recomputed digests`);
}
check('H1.relationships.resolve', relOk, `${trc.content.relationships.length} relationships checked against recomputed digests`);

/* H2. terminal coverage = the edge set, exactly */
const terminals = ['terminal:audited-1', 'terminal:delivered-1'];
for (const t of terminals) {
  const cov = trc.content.terminalCoverage[t];
  const edges = trc.content.relationships.filter((r) => r.toId === t);
  const derivedFrom = edges.filter((r) => r.relation === 'derived_from').map((r) => r.fromId).sort();
  const constrainedBy = edges.filter((r) => r.relation === 'constrained_by').map((r) => r.fromId).sort();
  const supportedBy = edges.filter((r) => r.relation === 'supports').map((r) => r.fromId).sort();
  const ok = cov !== undefined
    && cov.digest === idIndex.get(t)
    && JSON.stringify([...cov.derivedFrom].sort()) === JSON.stringify(derivedFrom)
    && JSON.stringify([...cov.constrainedBy].sort()) === JSON.stringify(constrainedBy)
    && JSON.stringify(cov.supportedBy ?? []) === JSON.stringify(supportedBy);
  check(`H2.coverage.${t}`, ok, `derived=${derivedFrom.join(',')} constrained=${constrainedBy.join(',')} supported=${supportedBy.join(',')}`);
}

/* H3. coverage completeness: every source claim + constraint reaches BOTH terminals; unknown carried, not resolved */
const sources = ['claim:scope-1', 'claim:scope-2', 'claim:constraint-1', 'claim:outcome-1'];
for (const t of terminals) {
  const edges = new Set(trc.content.relationships.filter((r) => r.toId === t && ['derived_from', 'constrained_by'].includes(r.relation)).map((r) => r.fromId));
  check(`H3.complete.${t}`, sources.every((s) => edges.has(s)) && edges.has('constraint:retention-1'), 'terminal reached by all 4 source claims + constraint');
}
const unkResolved = trc.content.relationships.some((r) => r.fromId === 'unknown:browser-matrix-1');
const unkCarried = trc.content.unknownCoverage?.unknownId === 'unknown:browser-matrix-1' && trc.content.unknownCoverage.disposition === 'carried_forward';
check('H4.unknown.carriedNotResolved', unkCarried && !unkResolved, `disposition=carried_forward, owner=${trc.content.unknownCoverage?.owner}, resolution edges=${unkResolved}`);

/* I. payload contract: required evidence refs + kind coverage */
const EXPECTED_EVIDENCE = [
  shaRef(cap.capsuleDigest), shaRef(vsa.certificate.digest),
  ...vsa.sourceClaims.map((x) => shaRef(x.digest)), ...vsa.constraints.map((x) => shaRef(x.digest)),
  ...vsa.unknowns.map((x) => shaRef(x.digest)), ...vsa.terminalLifecycleClaims.map((x) => shaRef(x.digest)),
  art.content.governingContractRef,
];
const got = [...sub.content.payloadContract.requiredEvidenceRefs].sort();
const want = [...EXPECTED_EVIDENCE].sort();
check('I1.evidenceRefs.exact', JSON.stringify(got) === JSON.stringify(want), `${got.length} refs, exact set match=${JSON.stringify(got) === JSON.stringify(want)}`);
const cov = sub.content.payloadContract.evidenceKindCoverage;
check('I2.evidenceKindCoverage', cov['discovery-handoff-capsule'] === 1 && cov['discovery-certificate'] === 1 && cov['source-claim'] === 4 && cov['constraint'] === 1 && cov['unknown'] === 1 && cov['terminal-claim'] === 2 && cov['architecture-contract'] === 1, JSON.stringify(cov));

/* J. parent state + desk identity pins */
check('J1.parentState.legal', art.content.parentState.status === 'discovery-terminal', art.content.parentState.status);
check('J2.parentState.proofRef', /^sha256:[0-9a-f]{64}$/.test(art.content.parentState.terminalProofRef), art.content.parentState.terminalProofRef);
check('J3.deskPins', art.content.deskRef === 'import-discovery-handoff' && art.content.itemInstanceId === 'formalization-item:import-discovery-handoff' && art.content.token === 'plan:discovery-handoff#item:import' && art.content.productKind === 'formalization.discovery-import.v1' && art.content.effectId === 'formalization.accept-products', 'desk/node/item/token/kind/effect');

/* K. workspace law: 0 upstream revisions, consistent across envelope + artifact + submission */
check('K.workspace.zeroUpstream', art.content.workspaceSummary === '0 accepted upstream revisions travel by content address' && art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0, art.content.workspaceSummary);

/* L. declared verification flags honesty (author self-check vs recomputation) */
const v = art.content.verification;
const flagsOk = v.declaredDigestsTrusted === false && v.subArtifactDigestsRecomputedOverCanonicalContent === allSubsOk && v.capsuleSelfAddressVerifies === (recomputedCapsule === cap.capsuleDigest) && v.lineageBindingMatched === true && v.parentStateIsDiscoveryTerminal === true && v.staleProtocolRefusals === 0;
check('L.verificationFlags', flagsOk, JSON.stringify(v));

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}, null, 2));
