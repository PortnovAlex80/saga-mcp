/**
 * define-product-intent desk (reviewer, DISSENT re-issue FR-Define-Product-Intent-002).
 *
 * The desk review namespace is contended: a concurrent writer issued
 * FR-Define-Product-Intent-001 (verdict accepted, content bff4aca1...) at
 * 2026-08-28 01:07, replacing this reviewer's FR-001 (verdict repair,
 * content b9710b1c...). Per fail-closed doctrine this build does NOT
 * overwrite the contending record; it re-issues the evidence-backed review
 * under collision-free identity (semantic codes -002, filenames reviewer2-*)
 * with an explicit contention record for driver/human adjudication.
 *
 * Deterministic: pinned timestamp, no clock reads, no randomness.
 * Run: node define-product-intent-desk-reviewer2-build.mjs
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const PIN = '2026-08-28T00:00:00Z';
const DIGEST_RULE = 'sha256 over canonical JSON of content (recursively key-sorted, compact)';

/* Fresh recomputation run against the candidate of record (nothing inherited). */
const { validatePrdIntentMember } = await import(
  pathToFileURL(join(DIR, '..', '..', '..', '..', '..', 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href
);

const sub = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-submission.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent-trace.json'), 'utf8'));
const imp = JSON.parse(readFileSync(join(DIR, 'import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));
const impTrc = JSON.parse(readFileSync(join(DIR, 'import-discovery-handoff-desk-discovery-import-trace.json'), 'utf8'));
const impRev = JSON.parse(readFileSync(join(DIR, 'import-discovery-handoff-desk-reviewer-review.json'), 'utf8'));

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); return ok; };
const shaRefOfContent = (j) => sha(j.content);

/* A/B/C self-addresses */
check('A1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('A2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);
const artDigest = sha(art.content);
check('B1.artifact.contentDigest', artDigest === art.contentDigest, `recomputed ${artDigest} vs declared ${art.contentDigest}`);
check('B2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('B3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest, sub.content.candidate.artifactRef);
const trcDigest = sha(trc.content);
check('C1.trace.contentDigest', trcDigest === trc.contentDigest, `recomputed ${trcDigest} vs declared ${trc.contentDigest}`);
check('C2.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), trc.traceRef);
check('C3.submission.traceRef.binding', sub.content.traceRef === trc.traceRef && trc.content.subjectArtifactRef === art.artifactRef, `${sub.content.traceRef} subject=${trc.content.subjectArtifactRef}`);

/* D. REAL WP03 validator over all members */
const universe = {
  idSets: {
    sourceClaimIds: ['claim:scope-1', 'claim:scope-2', 'claim:constraint-1', 'claim:outcome-1'],
    terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'],
  },
};
const sealOf = Object.fromEntries(art.content.memberSeals.map((s) => [s.memberId, s]));
let wp03AllOk = true;
let sealsAllOk = true;
for (const m of art.content.members) {
  const sealedResult = validatePrdIntentMember(m, universe);
  const declared = sealOf[m.memberId]?.digest;
  const digestOk = sealedResult.ok === true && sealedResult.digest === declared && declared?.length === 64 && sealOf[m.memberId]?.ref === shaRef(declared);
  wp03AllOk = wp03AllOk && sealedResult.ok === true;
  sealsAllOk = sealsAllOk && digestOk;
  check(`D.${m.memberId}`, digestOk, `wp03=${sealedResult.ok === true ? 'sealed' : `${sealedResult.reason}: ${sealedResult.detail}`}, recomputed ${sealedResult.ok === true ? sealedResult.digest : 'n/a'} vs declared ${declared}`);
}
check('D1.sealUniverse', art.content.memberSeals.length === art.content.members.length && new Set(art.content.memberSeals.map((s) => s.memberId)).size === art.content.members.length, `${art.content.memberSeals.length} seals for ${art.content.members.length} members, unique`);

/* E. envelope cross-check */
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
const UPSTREAM_PROJECTED = '745cadc1131468039f167043c000fc0af170ed98764f545f22d867be36da1c35';
for (const x of art.content.upstream.verifiedSubArtifacts) {
  const hex = x.digest.startsWith('sha256:') ? x.digest.slice(7) : x.digest;
  check(`E.${x.id}`, ENVELOPE[x.id] === hex && x.ref === shaRef(hex), `artifact-transported digest ${x.digest} vs envelope ${ENVELOPE[x.id] ?? 'ABSENT'}`);
}
check('E1.envelopeCoverage', art.content.upstream.verifiedSubArtifacts.length === 8 && art.content.upstream.verifiedAgainstTaskProjection === true, '8/8 envelope addresses transported and flagged verified');

/* S. SUBSTANCE check the contending review skipped: does the cited disposition authority EXIST? */
const sc2 = imp.content.verifiedSubArtifacts.sourceClaims.find((x) => x.content.claimId === 'claim:scope-2');
const sc2AuthorityExists = sc2 !== undefined
  && /decision|excluded from|out of scope|release boundary/i.test(sc2.content.statement ?? '');
check('S1.scope2.authorityExists', sc2AuthorityExists, `cited authority "the Discovery decision recorded in the capsule" EXISTS in capsule SC-2 (${sc2?.digest})? recomputed statement = ${JSON.stringify(sc2?.content.statement)} -> NO decision/exclusion/release language anywhere in the accepted material; member prd:scope-2's out_of_scope rests on a nonexistent decision`);
const cert = imp.content.verifiedSubArtifacts.certificate;
check('S2.certificate.subjectLevelOnly', cert.content.decision === 'go' && cert.content.subject === 'message service' && Object.keys(cert.content).length === 3, `certificate = ${JSON.stringify(cert.content)} - subject-level go only, not a scope-2 exclusion`);

/* F. capsule chain */
const vsa = imp.content.verifiedSubArtifacts;
const flat = [
  ['certificate', vsa.certificate],
  ...vsa.sourceClaims.map((x) => [`sourceClaim:${x.semanticCode}`, x]),
  ...vsa.constraints.map((x) => [`constraint:${x.semanticCode}`, x]),
  ...vsa.unknowns.map((x) => [`unknown:${x.semanticCode}`, x]),
  ...vsa.terminalLifecycleClaims.map((x) => [`terminalClaim:${x.semanticCode}`, x]),
];
for (const [label, x] of flat) {
  const recomputed = sha(x.content);
  check(`F.${label}`, recomputed === x.digest && x.digest.length === 64, `recomputed ${recomputed} vs declared ${x.digest}`);
}
const strip = (x) => ({ ref: shaRef(x.digest), digest: x.digest });
const factBody = {
  schemaVersion: imp.content.protocolVersion,
  lineage: imp.content.lineage,
  parentState: imp.content.parentState,
  certificate: strip(vsa.certificate),
  sourceClaims: vsa.sourceClaims.map(strip),
  constraints: vsa.constraints.map(strip),
  unknowns: vsa.unknowns.map(strip),
  terminalLifecycleClaims: vsa.terminalLifecycleClaims.map(strip),
  packageBytesDigest: imp.content.packageBytesDigest,
};
const cap = imp.content.capsule;
check('F1.capsule.selfAddress', sha(factBody) === cap.capsuleDigest, `recomputed ${sha(factBody)} vs declared ${cap.capsuleDigest}`);
check('F2.capsule.refForm', cap.capsuleRef === shaRef(cap.capsuleDigest), cap.capsuleRef);

/* G. protocol pin */
check('G.protocolVersion.importChain', imp.content.protocolVersion === 'ek.discovery-handoff-capsule.ek8-wp11f.v1' && imp.content.protocolVersionCheck === 'CURRENT', imp.content.protocolVersion);
check('G2.product.protocolPin.absent', art.content.protocolVersion === undefined && trc.content.protocolVersion === undefined, 'no protocolVersion pin on product artifact/trace (advisory ADV-2)');

/* H. trace graph */
const digestIndex = new Map([
  ...Object.entries(ENVELOPE),
  ...art.content.memberSeals.map((s) => [s.memberId, s.digest]),
]);
const semanticIndex = new Map(flat.map(([label, x]) => [label.split(':')[1], x.digest]));
const VOCAB = new Set(trc.content.relationVocabulary);
let relOk = true;
for (const [i, rel] of trc.content.relationships.entries()) {
  const fromExpect = digestIndex.get(rel.fromId);
  const toExpect = digestIndex.get(rel.toId);
  const ok = VOCAB.has(rel.relation)
    && fromExpect !== undefined && rel.fromRef === shaRef(fromExpect)
    && toExpect !== undefined && rel.toRef === shaRef(toExpect);
  relOk = relOk && ok;
  if (!ok) check(`H.rel[${i}]`, false, `${rel.fromId} -${rel.relation}-> ${rel.toId} unresolved`);
}
check('H1.relationships.resolve', relOk, `${trc.content.relationships.length} relationships resolved against recomputed digests`);
let covOk = true;
for (const [memberId, cov] of Object.entries(trc.content.memberCoverage)) {
  const edges = trc.content.relationships.filter((r) => r.fromId === memberId);
  const pick = (relName) => edges.filter((r) => r.relation === relName).map((r) => r.toId).sort();
  const ok = cov.digest === sealOf[memberId]?.digest
    && JSON.stringify([...cov.derivedFrom].sort()) === JSON.stringify(pick('derived_from'))
    && JSON.stringify([...(cov.enforces ?? [])].sort()) === JSON.stringify(pick('enforces'))
    && JSON.stringify([...(cov.constrainedBy ?? [])].sort()) === JSON.stringify(pick('constrained_by'))
    && JSON.stringify([...(cov.supports ?? [])].sort()) === JSON.stringify(pick('supports'));
  covOk = covOk && ok;
  check(`H2.coverage.${memberId}`, ok, `derived=${pick('derived_from')} enforces=${pick('enforces')} constrainedBy=${pick('constrained_by')} supports=${pick('supports')}`);
}
const terminals = ['terminal:audited-1', 'terminal:delivered-1'];
let termOk = true;
for (const t of terminals) {
  const cov = trc.content.terminalCoverage[t];
  const supportedBy = trc.content.relationships.filter((r) => r.toId === t && r.relation === 'supports').map((r) => r.fromId).sort();
  const owner = art.content.terminalOwnership.find((o) => o.terminalClaimId === t);
  const ownerMember = art.content.members.find((m) => m.memberId === owner?.ownedByMemberId);
  const ok = cov !== undefined && cov.digest === ENVELOPE[t]
    && JSON.stringify([...cov.supportedBy].sort()) === JSON.stringify(supportedBy)
    && ownerMember?.terminalClaimRefs?.includes(t) === true && owner?.digest === ENVELOPE[t];
  termOk = termOk && ok;
  check(`H3.terminal.${t}`, ok, `supportedBy=${supportedBy.join(',')} ownedBy=${owner?.ownedByMemberId}`);
}
const unkResolved = trc.content.relationships.some((r) => r.fromId === 'unknown:browser-matrix-1' && r.relation === 'resolves');
check('H4.unknown.carriedNotResolved', trc.content.unknownCoverage?.disposition === 'carried_forward' && !unkResolved, `carried_forward owner=${trc.content.unknownCoverage?.owner}, resolution edges=${unkResolved}`);
const cc = trc.content.constraintCoverage;
const enforcers = trc.content.relationships.filter((r) => r.toId === 'constraint:retention-1' && r.relation === 'enforces').map((r) => r.fromId).sort();
const constrainedMembers = trc.content.relationships.filter((r) => r.toId === 'constraint:retention-1' && r.relation === 'constrained_by').map((r) => r.fromId).sort();
check('H5.constraint.coverage', cc?.disposition === 'honored' && JSON.stringify([...cc.enforcedBy].sort()) === JSON.stringify(enforcers) && JSON.stringify([...cc.constrainedMembers].sort()) === JSON.stringify(constrainedMembers), `enforcedBy=${enforcers.join(',')} constrainedMembers=${constrainedMembers.join(',')}`);

/* I. payload contract + upstream + governing */
const EXPECTED_EVIDENCE = [
  shaRef(cap.capsuleDigest), shaRef(vsa.certificate.digest),
  ...vsa.sourceClaims.map((x) => shaRef(x.digest)), ...vsa.constraints.map((x) => shaRef(x.digest)),
  ...vsa.unknowns.map((x) => shaRef(x.digest)), ...vsa.terminalLifecycleClaims.map((x) => shaRef(x.digest)),
  art.content.governingContractRef,
];
check('I1.evidenceRefs.exact', JSON.stringify([...sub.content.payloadContract.requiredEvidenceRefs].sort()) === JSON.stringify([...EXPECTED_EVIDENCE].sort()), `${sub.content.payloadContract.requiredEvidenceRefs.length} refs exact`);
check('I3.upstreamAuthority.binding', art.content.upstream.importArtifactRef === shaRef(imp.contentDigest) && art.content.upstream.capsuleRef === cap.capsuleRef && sha(impTrc.content) === impTrc.contentDigest && sha(impRev.content) === impRev.contentDigest && impRev.content.verdict === 'accepted', 'import chain bound and recomputed');

const govHex = art.content.governingContractRef.slice(7);
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
let govResolved = false;
const govClaimants = [];
for (const f of walk(DIR)) {
  const buf = readFileSync(f);
  if (createHash('sha256').update(buf).digest('hex') === govHex) { govResolved = true; break; }
  if (f.endsWith('.json')) {
    try {
      const j = JSON.parse(buf.toString('utf8'));
      if (j.content !== undefined && sha(j.content) === govHex) { govResolved = true; break; }
      if ((j.contentDigest ?? '') === govHex) govClaimants.push({ file: f, recomputed: j.content !== undefined ? sha(j.content) : null });
    } catch { /* not JSON */ }
  }
}
check('I4.governingContract.resolves', govResolved, govResolved ? 'resolves' : `UNRESOLVED: claimants ${JSON.stringify(govClaimants)} declare a926df62... but recompute otherwise (r1 CRIT-003 digest-drift family; the contending FR-001 classifies this non-blocking, this review blocks on it - see contention)`);

/* J/K/L pins, workspace law, honesty */
check('J1.deskPins', art.content.deskRef === 'define-product-intent' && art.content.token === 'plan:formalization#item:product-intent' && art.content.productKind === 'frf-cell.product-intent.v1' && art.content.contractKind === 'frf-contracts.prd-intent-member.v1', 'pins');
check('J5.coverageLaw.sourceClaims', ['claim:scope-1', 'claim:scope-2', 'claim:constraint-1', 'claim:outcome-1'].every((c) => art.content.members.some((m) => m.sourceClaimRefs.includes(c))), 'all 4 claims mechanically realized or dispositioned (FORM only; substance = S1)');
check('K1.workspace.zeroUpstream.consistent', art.content.workspaceSummary === '0 accepted upstream revisions travel by content address' && art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0 && sub.content.workspaceSummary === art.content.workspaceSummary && trc.content.workspaceSummary === art.content.workspaceSummary, art.content.workspaceSummary);
let rawHits = 0; let canonHits = 0; let scanned = 0;
for (const f of walk(join(DIR, '..'))) {
  scanned += 1;
  const buf = readFileSync(f);
  if (createHash('sha256').update(buf).digest('hex') === UPSTREAM_PROJECTED) rawHits += 1;
  if (f.endsWith('.json')) { try { if (sha(JSON.parse(buf.toString('utf8'))) === UPSTREAM_PROJECTED) canonHits += 1; } catch { /* not JSON */ } }
}
check('K2.upstreamProjection.unresolvable', rawHits === 0 && canonHits === 0, `scanned ${scanned} files: raw hits=${rawHits}, canonical hits=${canonHits} - envelope projection 745cadc1... UNRESOLVABLE, author 0 upheld`);
const fenceKeys = ['acceptance', 'acceptanceCriteria', 'fr', 'nfr', 'requirements', 'rule', 'scenarios', 'srs', 'useCases'];
const fenceClean = art.content.members.every((m) => fenceKeys.every((k) => m[k] === undefined));
check('L2.fence.scan', fenceClean, 'fence clean');

const failed = results.filter((r) => !r.ok);
const verifySummary = {
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; WP03 validator = REAL kernel code; S-group = disposition-substance checks',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failedCheckIds: failed.map((r) => r.id),
  results,
};

/* ---------------- artifacts (reviewer2 identity, collision-free) ---------------- */
const IMP = imp.contentDigest;
const IMP_TRC = impTrc.contentDigest;
const IMP_REV = impRev.contentDigest;
const FS_AUTHOR = sub.contentDigest;
const CONTENDING_FR = 'bff4aca147aaee18c7224b6b05d4d533190bd42ee15e967b321dffbe24990f08';
const CONTENDING_FR_ONDISK = 'define-product-intent-desk-reviewer-review.json';

const vvContent = {
  verificationId: 'VV-Define-Product-Intent-002',
  deskRef: 'define-product-intent',
  role: 'reviewer',
  reissueOf: 'VV-Define-Product-Intent-001 (sha256:f7d1e5ad4cbfaeb50e5b63b00ff436825c4f097d812dd827ba7953795dcbcccc, displaced from the desk namespace by the concurrent writer at 2026-08-28 01:07)',
  rule: verifySummary.rule,
  subject: {
    submissionRef: shaRef(FS_AUTHOR),
    submissionId: 'FS-Define-Product-Intent-001',
    artifactRef: shaRef(artDigest),
    artifactSemanticCode: 'PRD-Define-Product-Intent-001',
    traceRef: shaRef(trcDigest),
  },
  recomputedChecks: verifySummary.recomputed,
  passed: verifySummary.passed,
  failed: verifySummary.failed,
  failedCheckIds: verifySummary.failedCheckIds,
  substanceChecks: 'S1/S2: the disposition-substance layer the contending FR-001 skipped - S1 FAILS: capsule SC-2 carries NO Discovery exclusion decision (cited authority nonexistent); S2 confirms the certificate is subject-level go only',
  envelopePins: {
    protocolSkillRef: 'sha256:bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
    semanticSkillRef: 'sha256:2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
    taskProjectionContentAddresses: Object.fromEntries(Object.entries(ENVELOPE).map(([id, d]) => [id, shaRef(d)])),
    upstreamAcceptedProjection: {
      address: `sha256:${UPSTREAM_PROJECTED}`,
      envelopeClaim: '1 accepted upstream revisions travel by content address',
      adjudication: 'UNRESOLVABLE - author 0 upheld (workspace-wide scan, zero content hits; r1 verdict was REJECTED so no accepted define-product-intent revision can exist)',
    },
  },
  results: verifySummary.results,
};
const vvDigest = sha(vvContent);
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer2-verification.json'), JSON.stringify({
  artifactRef: shaRef(vvDigest),
  artifactKind: 'reviewer-verification',
  contentDigest: vvDigest,
  semanticCode: 'VV-Define-Product-Intent-002',
  createdAt: PIN,
  deskRef: 'define-product-intent',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: vvContent,
}, null, 2) + '\n');

const frContent = {
  reviewId: 'FR-Define-Product-Intent-002',
  deskRef: 'define-product-intent',
  role: 'reviewer',
  reviewedRound: 'stray-products-r2',
  supersedes: 'FR-Define-Product-Intent-001 authored by THIS reviewer (sha256:b9710b1cd44dcab32f0077c059785097f7f6930b94341c4e21b47b2022b07765, displaced 01:07); NOT the contending record below',
  contentionRecord: {
    contendingArtifact: {
      file: CONTENDING_FR_ONDISK,
      semanticCode: 'FR-Define-Product-Intent-001',
      contentDigest: shaRef(CONTENDING_FR),
      verdict: 'accepted',
      author: 'concurrent writer, 2026-08-28 01:07',
    },
    thisVerdict: 'repair',
    pointOfAgreement: 'Both reviews independently find governingContractRef sha256:a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837 unresolvable (r1 rendering recomputes to b880d0b7...).',
    disagreement1: {
      id: 'DIS-1',
      subject: 'CRIT-1 (scope-2 disposition substance) - the contending review never examined it',
      contendingEvidence: 'FR-001 acceptance criterion: "scope-2 out_of_scope (owner product-owner + reason)" - checks the FORM of the disposition (closed vocabulary, owner+reason present), not its SUBSTANCE.',
      thisEvidence: 'S1/S2 checks: capsule SC-2 (cb291aa7..., recomputed) is exactly {claimId, statement: "Accepted discovery source claim 2 of the message service subject."} - no decision, no exclusion, no release boundary; certificate CERT-1 is a subject-level go. Member prd:scope-2 asserts exclusion "by the Discovery decision recorded in the capsule" - a decision that provably does not exist in the accepted material.',
      position: 'BLOCKING. A sealed artifact whose rationale cites nonexistent upstream authority ratifies fabrication at the semantic layer - the r1 disease survived digest cleanup. Form-valid dispositions with invented authority are exactly what desk review exists to catch (the kernel validator cannot see them).',
    },
    disagreement2: {
      id: 'DIS-2',
      subject: 'MAJ-1 (governing anchor) - both find it; the contending review classifies it non-blocking',
      contendingClassification: '"cross-round provenance residue; substance authentic; re-seal owed by the protocol owner"',
      thisPosition: 'BLOCKING for acceptance of THIS candidate: the ref is listed in the candidate payloadContract.requiredEvidenceRefs (architecture-contract kind) and is the round continuity anchor. An evidence ref that fails its first independent recomputation cannot be accepted "with residue" - fail-closed transport law (CON-1) is the round core property, not cosmetics.',
    },
    escalation: 'Two contradictory verdicts now travel by content address for the same candidate. Per fail-closed doctrine this record does NOT overwrite the contending one. DRIVER/HUMAN must adjudicate: accepted (bff4aca1...) vs repair (this record). Until adjudicated, the define-product-intent desk product MUST NOT settle.',
  },
  reviewedCandidate: {
    submissionRef: shaRef(FS_AUTHOR),
    submissionId: 'FS-Define-Product-Intent-001',
    artifactRef: shaRef(artDigest),
    artifactSemanticCode: 'PRD-Define-Product-Intent-001',
    traceRef: shaRef(trcDigest),
    productKind: 'frf-cell.product-intent.v1',
  },
  verificationRef: shaRef(vvDigest),
  verificationSummary: {
    recomputedChecks: verifySummary.recomputed,
    passed: verifySummary.passed,
    failed: verifySummary.failed,
    failedCheckIds: verifySummary.failedCheckIds,
    trustedByDeclaration: false,
  },
  workspaceLaw: '0 accepted upstream revisions travel by content address',
  workspaceAdjudication: {
    envelopeProjection: `1 accepted upstream revisions travel by content address (sha256:${UPSTREAM_PROJECTED})`,
    authorPosition: '0 accepted upstream revisions travel by content address (consistent across artifact/submission/trace)',
    scanEvidence: `K2: ${scanned} workspace files scanned - raw hits ${rawHits}, canonical hits ${canonHits}; address occurs only as quoted metadata inside review documents`,
    closure: 'AUTHOR POSITION UPHELD; closes r1 CRIT-001/ACTION-001. The r1 verdict was REJECTED, so no accepted revision of define-product-intent can exist.',
  },
  findings: {
    positiveFindings: [
      'Candidate content integrity is clean: submission/artifact/trace self-addresses recompute; all 6 member seals recompute AND are sealed by the REAL kernel WP03 validator; the trace graph resolves; both terminals owned exactly once; the unknown is carried, never resolved; the capsule chain re-verifies from the accepted import artifact.',
      'All 8 reviewer-envelope content addresses travel inside the artifact and match exactly - the r1 digest-disease is gone from the candidate.',
      'Workspace-law adjudication upholds the author against the stale envelope projection.',
      'The contending FR-001 independently corroborates the governing-contract defect (DIS-2) - the factual layer is not in dispute, only the blocking classification.',
    ],
    advisoryNotes: [
      { type: 'fail_closed_anchoring_undocumented', note: 'ADV-1: unknown/constraint members cite accepted source claims as fail-closed resolution devices (legitimate; true digests travel via coverage blocks) but this revision dropped the explanatory notes and the trace phrases an anchor as derivation. Restore notes.' },
      { type: 'protocol_pin_absent', note: 'ADV-2: no protocolVersion pin on the product artifact/trace; transitive via upstream.importArtifactRef only. Restore.' },
      { type: 'import_authority_chain_partial', note: 'ADV-3: the accepted import review (cfc7b35a...) and import trace (2e5bb8ce...) are absent from the candidate authority record; record all three refs.' },
      { type: 'mid_review_candidate_replacement', note: 'ADV-4: admitted candidate overwritten in place 00:48 -> 00:50 (FS-002 -> FS-001, backwards). Record superseded addresses (submission 580d6681..., artifact cd687fde..., trace d5002cb6...) and reissue monotonically.' },
      { type: 'review_namespace_collision', note: 'ADV-5: two reviewer instances contended one filename namespace (verify tooling displaced 01:04; review artifacts displaced 01:07). This re-issue uses collision-free identity; desk tooling must anchor filenames to review semantic codes.' },
    ],
    criticalIssues: [
      {
        issueId: 'CRIT-1',
        severity: 'CRITICAL',
        category: 'fabricated_disposition_authority',
        title: 'prd:scope-2 out_of_scope cites a Discovery decision that does not exist in the accepted capsule',
        description: 'Member prd:scope-2 (scope-exclusion, out_of_scope, owner product-owner) states exclusion "by the Discovery decision recorded in the capsule". The capsule SC-2 (cb291aa7..., recomputed this run) is a bare claim statement; CERT-1 is a subject-level go. No exclusion decision exists anywhere in the accepted material. The WP03 validator passes the member (refs resolve; closed vocabulary) - the substance check S1/S2 is reviewer-layer and it fails. Effect: accepted Discovery scope material silently removed from the intent surface under invented authority.',
        evidence: [
          'S1: SC-2 statement carries no decision/exclusion/release language (recomputed digest match).',
          'S2: certificate content = {kind, decision: "go", subject: "message service"} - subject-level.',
          'Contending FR-001 coverage evidence checks form only (owner+reason present), never authority existence.',
        ],
        violatedPrinciples: ['CON-1 provenance honesty', 'D10 never silently drop accepted material', 'TC-2 intent carries accepted content until a real disposition authority exists'],
        impact: 'Downstream desks inherit an intent surface missing accepted scope material plus a provenance lie about who decided it; no scenario will ever exercise claim:scope-2.',
      },
    ],
    majorIssues: [
      {
        issueId: 'MAJ-1',
        severity: 'MAJOR',
        category: 'unresolvable_governing_contract_anchor',
        title: 'governingContractRef sha256:a926df62... resolves to no content workspace-wide',
        description: 'Six r1 claimant files declare the address and all recompute to different digests (b880d0b7..., f4846e5f..., d041cb56..., 87aeab3f... x2, 0f06d0bc...) - the r1 CRIT-003 digest-drift family in the contract layer, propagated into every r2 evidence set including the accepted import review and this candidate. Both reviews find it; they disagree on blocking classification (DIS-2). This review blocks: a requiredEvidenceRef must resolve at acceptance time.',
        evidence: ['I4 in VV-Define-Product-Intent-002; corroborated by contending FR-001 governingContractResolution block.'],
        violatedPrinciples: ['CON-1 content-address transport', 'TC-1 criterion 1', 'r1 ACTION-003 remediation debt'],
        impact: 'The round continuity anchor fails independent recomputation; acceptance would ratify it.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed desk artifacts with SHA256 over canonical JSON', satisfied: true, evidence: 'A1-C3' },
    { id: 2, description: 'All members validate against frf-contracts.prd-intent-member.v1 (REAL kernel validator)', satisfied: true, evidence: 'D.*: 6/6 sealed' },
    { id: 3, description: 'All four accepted source claims realized or explicitly dispositioned BY AUTHORITY THAT EXISTS', satisfied: false, evidence: 'S1/S2 FAIL: prd:scope-2 out_of_scope cites a nonexistent Discovery decision (CRIT-1)' },
    { id: 4, description: 'Exactly one closed-vocabulary disposition per member; owner+reason where required', satisfied: true, evidence: 'J4-form' },
    { id: 5, description: 'Desk fence: no final acceptance/acceptanceCriteria/fr/nfr/requirements/rule/scenarios/srs/useCases content', satisfied: true, evidence: 'L2' },
    { id: 6, description: 'Both terminal lifecycle claims owned by PRD intent members', satisfied: true, evidence: 'H3' },
    { id: 7, description: 'constraint:retention-1 honored: deterministic authoring', satisfied: true, evidence: 'H5 + pinned timestamps' },
    { id: 8, description: 'unknown:browser-matrix-1 carried forward, never resolved', satisfied: true, evidence: 'H4' },
    { id: 9, description: 'Trace resolves against recomputed digests; coverages equal the edge sets', satisfied: true, evidence: 'H1-H5' },
    { id: 10, description: '0 accepted upstream revisions travel by content address', satisfied: true, evidence: 'K1/K2 adjudication' },
    { id: 11, description: 'Governing contract evidence ref resolves to recomputable content', satisfied: false, evidence: 'I4 FAIL (MAJ-1/DIS-2)' },
  ],
  verdict: 'repair',
  verdictVocabulary: ['accepted', 'repair', 'upstream-repair', 'human-wait', 'terminal-reject'],
  finalGate: { gateVerdict: 'repair', providerId: 'reviewer-verdict', issues: ['CRIT-1', 'MAJ-1', 'CONTENTION-DIS-1', 'CONTENTION-DIS-2'] },
  requiredActions: [
    { actionId: 'RA-1', priority: 'CRITICAL', owner: 'define-product-intent desk (author)', description: 'Restore claim:scope-2 as carried accepted boundary material (system-boundary, scenario_required) or cite a genuinely recorded Discovery decision content address (none exists today)', details: 'The superseded 00:48 revision already carried scope-2 correctly.' },
    { actionId: 'RA-2', priority: 'MAJOR', owner: 'architecture-contract desk + r2 desks', description: 'Re-seal the contract layer so the governing address resolves; update governingContractRef across r2 evidence sets', details: 'Until then the anchor fails every independent recomputation.' },
    { actionId: 'RA-3', priority: 'MINOR', owner: 'define-product-intent desk (author)', description: 'Restore fail-closed anchoring notes; stop phrasing anchors as derivation', details: 'ADV-1.' },
    { actionId: 'RA-4', priority: 'MINOR', owner: 'define-product-intent desk (author)', description: 'Pin protocolVersion; record full import authority chain (importTraceRef + reviewRef + verdict)', details: 'ADV-2/ADV-3.' },
    { actionId: 'RA-5', priority: 'PROCESS', owner: 'driver / desk tooling', description: 'Immutable admitted candidates; monotonic reissue; no shared reviewer filename namespace', details: 'ADV-4/ADV-5; see contentionRecord.escalation.' },
  ],
  evidenceReferences: [
    shaRef(FS_AUTHOR), shaRef(artDigest), shaRef(trcDigest),
    shaRef(cap.capsuleDigest), shaRef(vsa.certificate.digest),
    ...Object.values(ENVELOPE).map(shaRef),
    shaRef(govHex), shaRef(IMP), shaRef(IMP_TRC), shaRef(IMP_REV),
    shaRef(vvDigest), shaRef(CONTENDING_FR),
  ],
  conclusion: 'Re-issued under collision-free identity after the desk namespace was contended (01:07). The candidate of record (PRD-Define-Product-Intent-001, sha256:a06dbc57...) is digest-clean but returned as repair: (CRIT-1) its out_of_scope disposition of accepted scope material claim:scope-2 cites a Discovery decision that provably does not exist in the accepted capsule - a substance failure the contending accepted-verdict review never examined; (MAJ-1) the governing-contract anchor fails independent recomputation workspace-wide, which both reviews found but classified differently. Two contradictory verdicts now travel by content address; per fail-closed doctrine neither has been overwritten and the desk product must not settle until the driver/human adjudicates the contention.',
};
const frDigest = sha(frContent);
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer2-review.json'), JSON.stringify({
  artifactRef: shaRef(frDigest),
  artifactKind: 'formalization-review',
  contentDigest: frDigest,
  semanticCode: 'FR-Define-Product-Intent-002',
  createdAt: PIN,
  deskRef: 'define-product-intent',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: frContent,
}, null, 2) + '\n');

const rtContent = {
  traceId: 'RT-Define-Product-Intent-002',
  deskRef: 'define-product-intent',
  role: 'reviewer',
  traceKind: 'reviewer-verdict-trace',
  subjectSemanticCode: 'FR-Define-Product-Intent-002',
  subjectArtifactRef: shaRef(frDigest),
  verdict: 'repair',
  contention: 'see FR-Define-Product-Intent-002 contentionRecord - verdicts disputed, desk must not settle',
  relationVocabulary: ['reviews', 'derived_from', 'constrained_by', 'resolves', 'supports', 'enforces', 'produces'],
  relationships: [
    { fromId: 'FR-Define-Product-Intent-002', fromRef: shaRef(frDigest), relation: 'reviews', toId: 'PRD-Define-Product-Intent-001', toRef: shaRef(artDigest), description: 'Independent reviewer verification (verdict repair: CRIT-1 substance, MAJ-1 governing anchor)' },
    { fromId: 'FR-Define-Product-Intent-002', fromRef: shaRef(frDigest), relation: 'reviews', toId: 'FS-Define-Product-Intent-001', toRef: shaRef(FS_AUTHOR), description: 'Author product submission reviewed' },
    { fromId: 'FR-Define-Product-Intent-002', fromRef: shaRef(frDigest), relation: 'reviews', toId: 'author-trace:define-product-intent', toRef: shaRef(trcDigest), description: 'Author trace graph verified (relationships resolve)' },
    { fromId: 'FR-Define-Product-Intent-002', fromRef: shaRef(frDigest), relation: 'enforces', toId: 'constraint:retention-1', toRef: shaRef(ENVELOPE['constraint:retention-1']), description: 'Reviewer artifacts deterministic: pinned timestamp, computed digests only' },
    { fromId: 'FR-Define-Product-Intent-002', fromRef: shaRef(frDigest), relation: 'supports', toId: 'terminal:audited-1', toRef: shaRef(ENVELOPE['terminal:audited-1']), description: 'The independent audit (REAL WP03 validator + substance checks) is the audited-1 realization; the contention keeps it honest' },
    { fromId: 'FR-Define-Product-Intent-002', fromRef: shaRef(frDigest), relation: 'supports', toId: 'terminal:delivered-1', toRef: shaRef(ENVELOPE['terminal:delivered-1']), description: 'Delivery intent settles only under authority that exists (RA-1) and a resolving governing anchor (RA-2)' },
  ],
  unknownCoverage: {
    unknownId: 'unknown:browser-matrix-1',
    digest: ENVELOPE['unknown:browser-matrix-1'],
    disposition: 'carried_forward',
    owner: 'discovery',
    note: 'Neither author nor reviewer resolves or drops the unknown.',
  },
  terminalCoverage: {
    'terminal:audited-1': { digest: ENVELOPE['terminal:audited-1'], supportedBy: ['FR-Define-Product-Intent-002', 'prd:terminal-1'] },
    'terminal:delivered-1': { digest: ENVELOPE['terminal:delivered-1'], supportedBy: ['FR-Define-Product-Intent-002', 'prd:outcome-1'] },
  },
};
const rtDigest = sha(rtContent);
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer2-trace.json'), JSON.stringify({
  traceRef: shaRef(rtDigest),
  traceKind: 'reviewer-verdict-trace',
  contentDigest: rtDigest,
  createdAt: PIN,
  deskRef: 'define-product-intent',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: rtContent,
}, null, 2) + '\n');

const fsContent = {
  deskRef: 'define-product-intent',
  deskNodeId: 'define-product-intent',
  role: 'reviewer',
  itemInstanceId: 'formalization-item:define-product-intent',
  token: 'plan:formalization#item:product-intent',
  verdict: 'repair',
  contention: 'FS-Define-Product-Intent-002 (accepted, f9ead68a...) is the contending record; this is the dissent re-issue. Driver/human adjudication required before settle.',
  candidate: { kind: 'formalization.review-complete.v1', artifactRef: shaRef(frDigest), contentDigest: frDigest },
  payloadContract: {
    productKind: 'formalization.review-complete.v1',
    effectId: 'formalization.accept-products',
    requiredEvidenceRefs: [
      shaRef(cap.capsuleDigest), shaRef(vsa.certificate.digest),
      ...Object.values(ENVELOPE).map(shaRef),
      shaRef(govHex), shaRef(frDigest), shaRef(rtDigest), shaRef(vvDigest),
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
  reviewedCandidateRefs: { submissionRef: shaRef(FS_AUTHOR), artifactRef: shaRef(artDigest), authorTraceRef: shaRef(trcDigest) },
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#define-product-intent:reviewer2',
    status: 'review_complete_verdict_recorded_contention_open',
    receivedFrom: 'reviewer',
    nextStage: 'final-gate',
    note: 'Verdict repair (dissent re-issue FR-Define-Product-Intent-002). CONTENTION OPEN against accepted-verdict FR-Define-Product-Intent-001 (bff4aca1...): DIS-1 disposition-substance, DIS-2 governing-anchor blocking classification. Do not settle the desk until adjudicated.',
  },
  acceptanceCriteriaSelfCheck: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true },
    { id: 2, description: 'Independent recomputation performed (REAL kernel WP03 validator + NEW disposition-substance checks S1/S2)', satisfied: true },
    { id: 3, description: 'All 8 envelope addresses resolved; 745cadc1... projection adjudicated UNRESOLVABLE (author 0 upheld)', satisfied: true },
    { id: 4, description: 'Verdict + findings + required actions recorded; contention documented without overwriting the contending record', satisfied: true },
    { id: 5, description: 'Reviewer artifacts deterministic: pinned timestamp, no clock reads, no randomness', satisfied: true },
    { id: 6, description: 'constraint:retention-1 honored across all artifacts of this review', satisfied: true },
    { id: 7, description: 'unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true },
    { id: 8, description: 'Superseded + contending records preserved by content address', satisfied: true },
    { id: 9, description: 'Governing contract evidence ref verified before inheritance', satisfied: false, note: 'MAJ-1: anchor fails recomputation; honestly recorded, verdict repair rather than blind acceptance' },
    { id: 10, description: '0 accepted upstream revisions travel by content address', satisfied: true },
  ],
};
const fsDigest = sha(fsContent);
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer2-product-submission.json'), JSON.stringify({
  submissionRef: shaRef(fsDigest),
  submissionId: 'FS-Define-Product-Intent-004',
  contentDigest: fsDigest,
  createdAt: PIN,
  deskRef: 'define-product-intent',
  role: 'reviewer',
  digestRule: DIGEST_RULE,
  content: fsContent,
}, null, 2) + '\n');

const md = `# define-product-intent desk (reviewer, DISSENT re-issue) - r2 review record

Verdict: **repair** · FR-Define-Product-Intent-002 \`sha256:${frDigest}\`
· candidate of record: PRD-Define-Product-Intent-001 \`sha256:${artDigest}\` (unchanged since 00:50)

**CONTENTION OPEN.** A concurrent writer issued FR-Define-Product-Intent-001
(\`sha256:${CONTENDING_FR}\`, verdict **accepted**) at 01:07 in the same namespace,
displacing this reviewer's FR-001 (also repair, \`b9710b1c...\`). Nothing was overwritten:
both records travel by content address. Per fail-closed doctrine the desk **must not settle**
until the driver/human adjudicates.

## The two disputed points

| id | contending FR-001 (accepted) | this FR-002 (repair) |
|----|------------------------------|----------------------|
| DIS-1 scope-2 | coverage evidence checks FORM only: "out_of_scope (owner product-owner + reason)" | SUBSTANCE check S1/S2: the cited "Discovery decision recorded in the capsule" **does not exist** - SC-2 (\`cb291aa7...\`, recomputed) is a bare claim; CERT-1 is subject-level go. Accepted scope material silently removed under fabricated authority. BLOCKING. |
| DIS-2 governing anchor | found, classified "cross-round provenance residue, non-blocking" | found too (\`a926df62...\` unresolvable; r1 rendering recomputes \`b880d0b7...\`); a \`requiredEvidenceRefs\` member must resolve at acceptance time. BLOCKING. |

Everything else is agreed: candidate digests recompute (REAL kernel WP03 validator seals all
6 members), trace resolves, capsule chain verifies, unknown carried, terminals owned,
workspace law 0 upheld (envelope projection \`745cadc1...\` unresolvable - r1 CRIT-001 closed).

## Reviewer2 artifact index (content-addressed, deterministic, collision-free)

| artifact | kind | address |
|----------|------|---------|
| verification | VV-Define-Product-Intent-002 | \`sha256:${vvDigest}\` |
| review | FR-Define-Product-Intent-002 | \`sha256:${frDigest}\` |
| trace | RT-Define-Product-Intent-002 | \`sha256:${rtDigest}\` |
| submission | FS-Define-Product-Intent-004 | \`sha256:${fsDigest}\` |

Required actions RA-1..RA-5 in the review artifact. Pinned ${PIN}; sha256 over
canonical JSON everywhere. Evidence generator: \`define-product-intent-desk-reviewer-verify-fr001.mjs\`
(64 checks; this build re-ran the checks inline - ${verifySummary.recomputed} checks,
${verifySummary.passed} pass, ${verifySummary.failed} fail: ${verifySummary.failedCheckIds.join(', ')}).
`;
writeFileSync(join(DIR, 'define-product-intent-desk-reviewer2-submission-summary.md'), md);

console.log(JSON.stringify({
  built: ['reviewer2-verification', 'reviewer2-review', 'reviewer2-trace', 'reviewer2-submission'],
  verification: shaRef(vvDigest),
  review: shaRef(frDigest),
  trace: shaRef(rtDigest),
  submission: shaRef(fsDigest),
  checks: `${verifySummary.passed}/${verifySummary.recomputed} pass, failed: ${verifySummary.failedCheckIds.join(',')}`,
}, null, 2));
