/**
 * define-product-intent desk (reviewer, FR-Define-Product-Intent-001) -
 * digest recomputation evidence. Collision-free copy of the reviewer
 * verify tooling: the canonical filename was overwritten at 2026-08-28
 * 01:04 by a concurrent writer; this -fr001 copy preserves the evidence
 * generator that produced VV-Define-Product-Intent-001
 * (sha256:f7d1e5ad4cbfaeb50e5b63b00ff436825c4f097d812dd827ba7953795dcbcccc)
 * and FR-Define-Product-Intent-001
 * (sha256:b9710b1cd44dcab32f0077c059785097f7f6930b94341c4e21b47b2022b07765).
 *
 * Frozen kernel rule: src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Recomputes EVERY declared digest of the r2 define-product-intent author
 * candidate of record (submission FS-Define-Product-Intent-001, artifact
 * PRD-Define-Product-Intent-001 sha256:a06dbc57..., trace sha256:6e35f34c...),
 * runs all 6 PRD intent members through the REAL kernel WP03 validator
 * (frf-contracts.prd-intent-member.v1) with the exact accepted id-set
 * universe, re-verifies the upstream capsule chain from the accepted import
 * artifact (9 sub-artifacts + capsule self-address), cross-checks all
 * 8 reviewer-envelope task-projection content addresses, checks the payload
 * contract evidence set, adjudicates the envelope's upstream-accepted
 * projection (sha256:745cadc1...) by a workspace-wide resolvability scan,
 * and verifies the trace graph resolves against recomputed digests.
 * Nothing is trusted by declaration.
 *
 * Run: node define-product-intent-desk-reviewer-verify-fr001.mjs
 * Expected (candidate of record, unchanged since 2026-08-28 00:50):
 *   64 recomputations, 63 pass, 1 fail (I4.governingContract.resolves).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
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
const ROOT = join(DIR, '..', '..', '..', '..', '..');
const QUAL = join(DIR, '..');

const sub = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-submission.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'define-product-intent-desk-product-intent-trace.json'), 'utf8'));
const imp = JSON.parse(readFileSync(join(DIR, 'import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));
const impTrc = JSON.parse(readFileSync(join(DIR, 'import-discovery-handoff-desk-discovery-import-trace.json'), 'utf8'));
const impRev = JSON.parse(readFileSync(join(DIR, 'import-discovery-handoff-desk-reviewer-review.json'), 'utf8'));

/* The REAL kernel WP03 validator - the same code the driver executes. */
const { validatePrdIntentMember } = await import(
  pathToFileURL(join(ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'prd-intent-member.mjs')).href
);

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); return ok; };

/* A. submission self-address */
check('A1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('A2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);

/* B. artifact self-address + candidate binding */
const artDigest = sha(art.content);
check('B1.artifact.contentDigest', artDigest === art.contentDigest, `recomputed ${artDigest} vs declared ${art.contentDigest}`);
check('B2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('B3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest, sub.content.candidate.artifactRef);

/* C. trace self-address + binding */
const trcDigest = sha(trc.content);
check('C1.trace.contentDigest', trcDigest === trc.contentDigest, `recomputed ${trcDigest} vs declared ${trc.contentDigest}`);
check('C2.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), trc.traceRef);
check('C3.submission.traceRef.binding', sub.content.traceRef === trc.traceRef && trc.content.subjectArtifactRef === art.artifactRef, `${sub.content.traceRef} subject=${trc.content.subjectArtifactRef}`);

/* D. every PRD intent member recomputed AND validated by the REAL kernel WP03 validator */
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
const UPSTREAM_PROJECTED = '745cadc1131468039f167043c000fc0af170ed98764f545f22d867be36da1c35';
for (const x of art.content.upstream.verifiedSubArtifacts) {
  const hex = x.digest.startsWith('sha256:') ? x.digest.slice(7) : x.digest;
  check(`E.${x.id}`, ENVELOPE[x.id] === hex && x.ref === shaRef(hex), `artifact-transported digest ${x.digest} vs envelope ${ENVELOPE[x.id] ?? 'ABSENT'}`);
}
check('E1.envelopeCoverage', art.content.upstream.verifiedSubArtifacts.length === 8 && art.content.upstream.verifiedAgainstTaskProjection === true, `8/8 reviewer-frame content addresses transported in artifact.upstream and flagged verified`);

/* F. upstream capsule chain re-verified from the accepted import artifact (not by declaration) */
const vsa = imp.content.verifiedSubArtifacts;
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
  check(`F.${label}`, ok, `recomputed ${recomputed} vs declared ${x.digest}`);
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
const recomputedCapsule = sha(factBody);
const cap = imp.content.capsule;
check('F1.capsule.selfAddress', recomputedCapsule === cap.capsuleDigest, `recomputed ${recomputedCapsule} vs declared ${cap.capsuleDigest}`);
check('F2.capsule.refForm', cap.capsuleRef === shaRef(cap.capsuleDigest), cap.capsuleRef);

/* G. capsule protocol version pin (import chain) + transitive binding from the product */
check('G.protocolVersion.importChain', imp.content.protocolVersion === 'ek.discovery-handoff-capsule.ek8-wp11f.v1' && imp.content.protocolVersionCheck === 'CURRENT', imp.content.protocolVersion);
check('G2.product.protocolPin.absent', art.content.protocolVersion === undefined && trc.content.protocolVersion === undefined, 'product artifact + trace carry no protocolVersion pin; capsule protocol binds transitively via upstream.importArtifactRef (advisory recorded in review)');

/* H. trace graph integrity over recomputed digests (member -> material direction) */
const digestIndex = new Map([
  ...Object.entries(ENVELOPE),
  ...art.content.memberSeals.map((s) => [s.memberId, s.digest]),
]);
const idToSemantic = new Map(Object.entries(ENVELOPE).map(([id]) => {
  const hit = flat.find(([, x]) => (x.content.claimId ?? x.content.constraintId ?? x.content.unknownId) === id);
  return [id, hit === undefined ? undefined : hit[0].split(':')[1]];
}));
const semanticIndex = new Map(flat.map(([label, x]) => [label.split(':')[1], x.digest]));
const VOCAB = new Set(trc.content.relationVocabulary);
let relOk = true;
for (const [i, rel] of trc.content.relationships.entries()) {
  const fromExpect = digestIndex.get(rel.fromId);
  const toExpect = digestIndex.get(rel.toId);
  const fromSemantic = idToSemantic.get(rel.fromId) ?? (semanticIndex.has(rel.fromId) ? rel.fromId : undefined);
  const toSemantic = idToSemantic.get(rel.toId) ?? (semanticIndex.has(rel.toId) ? rel.toId : undefined);
  const ok = VOCAB.has(rel.relation)
    && fromExpect !== undefined && rel.fromRef === shaRef(fromExpect)
    && toExpect !== undefined && rel.toRef === shaRef(toExpect)
    && (fromSemantic === undefined || semanticIndex.get(fromSemantic) === fromExpect)
    && (toSemantic === undefined || semanticIndex.get(toSemantic) === toExpect);
  relOk = relOk && ok;
  if (!ok) check(`H.rel[${i}]`, false, `${rel.fromId} -${rel.relation}-> ${rel.toId} refs do not resolve to recomputed digests`);
}
check('H1.relationships.resolve', relOk, `${trc.content.relationships.length} relationships checked against recomputed digests`);

/* H2. memberCoverage = the edge set, exactly */
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
check('H2.memberCoverage.universe', Object.keys(trc.content.memberCoverage).length === art.content.members.length, `${Object.keys(trc.content.memberCoverage).length} coverage records for ${art.content.members.length} members`);

/* H3. terminal ownership: both terminals owned, coverage = supports edges, terminalOwnership exact */
const terminals = ['terminal:audited-1', 'terminal:delivered-1'];
let termOk = true;
for (const t of terminals) {
  const cov = trc.content.terminalCoverage[t];
  const supportedBy = trc.content.relationships.filter((r) => r.toId === t && r.relation === 'supports').map((r) => r.fromId).sort();
  const owner = art.content.terminalOwnership.find((o) => o.terminalClaimId === t);
  const ownerMember = art.content.members.find((m) => m.memberId === owner?.ownedByMemberId);
  const ok = cov !== undefined
    && cov.digest === ENVELOPE[t]
    && JSON.stringify([...cov.supportedBy].sort()) === JSON.stringify(supportedBy)
    && ownerMember !== undefined
    && ownerMember.terminalClaimRefs?.includes(t) === true
    && owner.digest === ENVELOPE[t];
  termOk = termOk && ok;
  check(`H3.terminal.${t}`, ok, `supportedBy=${supportedBy.join(',')} ownedBy=${owner?.ownedByMemberId} memberCitesTerminal=${ownerMember?.terminalClaimRefs?.includes(t) === true}`);
}
check('H3.terminalOwnership.exact', art.content.terminalOwnership.length === 2 && new Set(art.content.terminalOwnership.map((o) => o.ownedByMemberId)).size === 2, 'each terminal owned by exactly one distinct member');

/* H4. unknown carried, not resolved */
const unkResolved = trc.content.relationships.some((r) => r.fromId === 'unknown:browser-matrix-1' && r.relation === 'resolves');
const unkCarried = trc.content.unknownCoverage?.unknownId === 'unknown:browser-matrix-1' && trc.content.unknownCoverage.disposition === 'carried_forward' && trc.content.unknownCoverage.digest === ENVELOPE['unknown:browser-matrix-1'];
check('H4.unknown.carriedNotResolved', unkCarried && !unkResolved, `disposition=carried_forward, owner=${trc.content.unknownCoverage?.owner}, resolution edges=${unkResolved}`);

/* H5. constraint coverage: enforcedBy + constrainedMembers = the edge set */
const cc = trc.content.constraintCoverage;
const enforcers = trc.content.relationships.filter((r) => r.toId === 'constraint:retention-1' && r.relation === 'enforces').map((r) => r.fromId).sort();
const constrainedMembers = trc.content.relationships.filter((r) => r.toId === 'constraint:retention-1' && r.relation === 'constrained_by').map((r) => r.fromId).sort();
check('H5.constraint.coverage', cc?.digest === ENVELOPE['constraint:retention-1'] && cc?.disposition === 'honored' && JSON.stringify([...cc.enforcedBy].sort()) === JSON.stringify(enforcers) && JSON.stringify([...cc.constrainedMembers].sort()) === JSON.stringify(constrainedMembers), `enforcedBy=${enforcers.join(',')} constrainedMembers=${constrainedMembers.join(',')}`);

/* I. payload contract: required evidence refs + kind coverage + upstream resolution */
const EXPECTED_EVIDENCE = [
  shaRef(cap.capsuleDigest), shaRef(vsa.certificate.digest),
  ...vsa.sourceClaims.map((x) => shaRef(x.digest)), ...vsa.constraints.map((x) => shaRef(x.digest)),
  ...vsa.unknowns.map((x) => shaRef(x.digest)), ...vsa.terminalLifecycleClaims.map((x) => shaRef(x.digest)),
  art.content.governingContractRef,
];
const gotEv = [...sub.content.payloadContract.requiredEvidenceRefs].sort();
const wantEv = [...EXPECTED_EVIDENCE].sort();
check('I1.evidenceRefs.exact', JSON.stringify(gotEv) === JSON.stringify(wantEv), `${gotEv.length} refs, exact set match=${JSON.stringify(gotEv) === JSON.stringify(wantEv)}`);
const covKinds = sub.content.payloadContract.evidenceKindCoverage;
check('I2.evidenceKindCoverage', covKinds['discovery-handoff-capsule'] === 1 && covKinds['discovery-certificate'] === 1 && covKinds['source-claim'] === 4 && covKinds['constraint'] === 1 && covKinds['unknown'] === 1 && covKinds['terminal-claim'] === 2 && covKinds['architecture-contract'] === 1, JSON.stringify(covKinds));
check('I3.upstreamAuthority.binding', art.content.upstream.importArtifactRef === shaRef(imp.contentDigest) && imp.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5' && art.content.upstream.capsuleRef === cap.capsuleRef && art.content.upstream.certificateRef === shaRef(vsa.certificate.digest) && sha(impTrc.content) === impTrc.contentDigest && sha(impRev.content) === impRev.contentDigest && impRev.content.verdict === 'accepted', `product binds import artifact ${art.content.upstream.importArtifactRef}; import trace ${impTrc.contentDigest}; accepted import review ${impRev.contentDigest}`);

/* I4. governing contract continuity: workspace-wide resolution of the governing address */
const govHex = art.content.governingContractRef.slice(7);
function* walkQual(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkQual(p);
    else yield p;
  }
}
let govRawHit = null;
let govContentHit = null;
const govClaimants = [];
for (const f of walkQual(QUAL)) {
  const buf = readFileSync(f);
  if (createHash('sha256').update(buf).digest('hex') === govHex) govRawHit = f;
  if (f.endsWith('.json')) {
    try {
      const j = JSON.parse(buf.toString('utf8'));
      if (j.content !== undefined && sha(j.content) === govHex) govContentHit = f;
      if ((j.artifactRef ?? '').includes(govHex) || (j.contentDigest ?? '') === govHex) {
        govClaimants.push({ file: f.split('stray-products').pop(), declared: j.contentDigest, recomputed: j.content !== undefined ? sha(j.content) : null });
      }
    } catch { /* not JSON */ }
  }
}
check('I4.governingContract.resolves', govRawHit !== null || govContentHit !== null, govRawHit !== null || govContentHit !== null
  ? `governing address resolves (${govContentHit ?? govRawHit})`
  : `UNRESOLVED: no content in r1/r2 hashes to sha256:${govHex}; claimant files ${JSON.stringify(govClaimants)} declare it but recompute otherwise (r1 CRIT-003 digest-drift family in the contract layer)`);

/* J. desk identity pins, member id universe, coverage law */
check('J1.deskPins', art.content.deskRef === 'define-product-intent' && art.content.deskNodeId === 'define-product-intent' && art.content.itemInstanceId === 'formalization-item:define-product-intent' && art.content.token === 'plan:formalization#item:product-intent' && art.content.productKind === 'frf-cell.product-intent.v1' && art.content.effectId === 'formalization.accept-products' && art.content.contractKind === 'frf-contracts.prd-intent-member.v1' && art.content.schemaVersion === 'frf-cell.product-intent.v1', 'desk/node/item/token/kind/effect/contract/schema');
check('J2.submission.pins', sub.content.token === art.content.token && sub.content.itemInstanceId === art.content.itemInstanceId && sub.content.deskNodeId === art.content.deskNodeId, 'submission pins match artifact pins');
const memberIds = art.content.members.map((m) => m.memberId);
check('J3.memberUniverse', memberIds.length === 6 && new Set(memberIds).size === 6, memberIds.join(','));
const dispositions = art.content.members.map((m) => m.disposition.disposition);
check('J4.dispositionLaw', art.content.members.every((m) => ['scenario_required', 'direct_requirement', 'deferred', 'out_of_scope'].includes(m.disposition.disposition)), dispositions.join(','));
const realizedOrDispositioned = new Set(art.content.members.flatMap((m) => m.sourceClaimRefs));
check('J5.coverageLaw.sourceClaims', ['claim:scope-1', 'claim:scope-2', 'claim:constraint-1', 'claim:outcome-1'].every((c) => realizedOrDispositioned.has(c)), `all 4 accepted source claims realized or explicitly dispositioned: ${[...realizedOrDispositioned].sort().join(',')}`);
const pinnedTs = '2026-08-28T00:00:00Z';
check('J6.deterministic.pinnedTimestamp', sub.createdAt === pinnedTs && art.createdAt === pinnedTs && trc.createdAt === pinnedTs, `pinned ${pinnedTs} across submission/artifact/trace`);

/* K. workspace law + envelope adjudication */
check('K1.workspace.zeroUpstream.consistent', art.content.workspaceSummary === '0 accepted upstream revisions travel by content address' && art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0 && sub.content.workspaceSummary === art.content.workspaceSummary && trc.content.workspaceSummary === art.content.workspaceSummary, art.content.workspaceSummary);

/* K2. the envelope's upstream-accepted projection (sha256:745cadc1...) - workspace-wide resolvability scan */
function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}
let rawHits = 0;
let canonHits = 0;
const textHits = [];
let scanned = 0;
for (const f of walk(QUAL)) {
  scanned += 1;
  const buf = readFileSync(f);
  const text = buf.toString('utf8');
  if (text.includes(UPSTREAM_PROJECTED)) textHits.push(f.split('stray-products').pop());
  if (createHash('sha256').update(buf).digest('hex') === UPSTREAM_PROJECTED) rawHits += 1;
  if (f.endsWith('.json')) {
    try { if (sha(JSON.parse(text)) === UPSTREAM_PROJECTED) canonHits += 1; } catch { /* not JSON */ }
  }
}
check('K2.upstreamProjection.unresolvable', rawHits === 0 && canonHits === 0, `scanned ${scanned} workspace files under qualification/: raw-bytes sha256 hits=${rawHits}, canonical-JSON content hits=${canonHits}, textual mentions=${textHits.length} (quoted protocol metadata in review documents only: ${textHits.join(' | ')})`);

/* L. declared verification flags honesty (author self-check vs recomputation) */
const fenceKeys = ['acceptance', 'acceptanceCriteria', 'fr', 'nfr', 'requirements', 'rule', 'scenarios', 'srs', 'useCases'];
const fenceClean = art.content.members.every((m) => fenceKeys.every((k) => m[k] === undefined));
const v = art.content.verification;
const flagsOk = v.declaredDigestsTrusted === false
  && v.memberSealsRecomputedOverCanonicalMembers === sealsAllOk
  && v.claimDigestsMatchedTaskProjection === true
  && v.coverageLawSatisfied === true
  && v.terminalClaimsOwnedByMembers === termOk
  && v.fenceRespectedNoFinalContent === fenceClean
  && v.deterministicAuthoring === true
  && v.acceptedUpstreamRevisionsTravelingByContentAddress === 0
  && v.staleProtocolRefusals === 0;
check('L.verificationFlags', flagsOk, JSON.stringify(v));
check('L2.fence.scan', fenceClean, 'no member carries the nine forbidden final-content keys (WP03 SCOPE_VIOLATION surface)');

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; WP03 validator = REAL kernel code',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  results,
}, null, 2));
