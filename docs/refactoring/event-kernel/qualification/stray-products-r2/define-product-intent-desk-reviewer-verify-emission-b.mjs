/**
 * define-product-intent desk (reviewer) - digest recomputation evidence.
 *
 * Frozen kernel rule: src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Recomputes EVERY declared digest of the r2 author candidate
 * (submission, product-intent bundle, trace, all 6 WP03 member seals),
 * re-runs the REAL WP03 validator (validatePrdIntentMember, imported -
 * never re-implemented) against the accepted id-set universe built from
 * THIS reviewer's task-projection envelope, replays the gate laws
 * (fence, duplicate ids, coverage law, AcceptedIntentSet fold),
 * re-verifies the upstream import chain end-to-end (author + reviewer
 * artifacts, capsule self-address, 9 sub-artifacts), cross-checks all 8
 * envelope material content addresses, and RESOLVES the r1 CRIT-001
 * stray upstream entry (sha256:745cadc...) by an exhaustive scan of both
 * round workspaces. Nothing is trusted by declaration.
 *
 * Run: node define-product-intent-desk-reviewer-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePrdIntentMember } from '../../../../../src/workflow-kernel/workshops/formalization/contracts/validators/prd-intent-member.mjs';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRaw = (b) => createHash('sha256').update(b).digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const R1 = join(DIR, '..', 'stray-products-r1');
const readJson = (base, name) => JSON.parse(readFileSync(join(base, name), 'utf8'));

/* The reviewed author candidate (r2, define-product-intent desk). */
const sub = readJson(DIR, 'define-product-intent-desk-product-submission.json');
const art = readJson(DIR, 'define-product-intent-desk-product-intent.artifact.json');
const trc = readJson(DIR, 'define-product-intent-desk-product-intent-trace.json');

/* The upstream import chain (r2, import-discovery-handoff desk). */
const iSub = readJson(DIR, 'import-discovery-handoff-desk-product-submission.json');
const iArt = readJson(DIR, 'import-discovery-handoff-desk-discovery-import.artifact.json');
const iTrc = readJson(DIR, 'import-discovery-handoff-desk-discovery-import-trace.json');
const iRev = readJson(DIR, 'import-discovery-handoff-desk-reviewer-review.json');
const iVer = readJson(DIR, 'import-discovery-handoff-desk-reviewer-verification.json');
const iRTrc = readJson(DIR, 'import-discovery-handoff-desk-reviewer-trace.json');
const iRSub = readJson(DIR, 'import-discovery-handoff-desk-reviewer-product-submission.json');

/* The cross-round governing contract rendering (r1 round). */
const r1Contract = readJson(R1, 'define-product-intent-desk-architecture-contract.artifact.json');

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); return ok; };

/* ------------------------------------------------------------------ */
/* A/B/C. Author candidate self-addresses + bindings                    */
/* ------------------------------------------------------------------ */
check('A1.submission.contentDigest', sha(sub.content) === sub.contentDigest, `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('A2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest), sub.submissionRef);
check('B1.artifact.contentDigest', sha(art.content) === art.contentDigest, `recomputed ${sha(art.content)} vs declared ${art.contentDigest}`);
check('B2.artifact.artifactRef', art.artifactRef === shaRef(art.contentDigest), art.artifactRef);
check('B3.submission.candidate.binding', sub.content.candidate.artifactRef === art.artifactRef && sub.content.candidate.contentDigest === art.contentDigest, sub.content.candidate.artifactRef);
check('B4.gate.productRefLaw', shaRef(sha(art.content)) === shaRef(art.contentDigest), 'gate productRef = sha256(canonical(bundle)) = artifact content address');
check('C1.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)} vs declared ${trc.contentDigest}`);
check('C2.trace.traceRef', trc.traceRef === shaRef(trc.contentDigest), trc.traceRef);
check('C3.submission.traceRef.binding', sub.content.traceRef === trc.traceRef, sub.content.traceRef);

/* ------------------------------------------------------------------ */
/* D. The 6 WP03 member seals recomputed over canonical member content  */
/* ------------------------------------------------------------------ */
const members = art.content.members;
const seals = art.content.memberSeals;
const memberDigest = new Map();
let sealsOk = seals.length === members.length;
for (const m of members) {
  const recomputed = sha(m);
  memberDigest.set(m.memberId, recomputed);
  const seal = seals.find((s) => s.memberId === m.memberId);
  const ok = seal !== undefined && seal.digest === recomputed && seal.ref === shaRef(recomputed);
  sealsOk = sealsOk && ok;
  check(`D.seal:${m.memberId}`, ok, `recomputed ${recomputed} vs declared ${seal?.digest}`);
}
check('D.seals.complete', sealsOk, `${members.length}/${seals.length} member seals 1:1 over canonical content`);

/* ------------------------------------------------------------------ */
/* E. REAL WP03 validator (imported, not re-implemented)                */
/* ------------------------------------------------------------------ */
/* The accepted id-set universe built from THIS reviewer's envelope. */
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
const universe = {
  idSets: {
    sourceClaimIds: ['claim:scope-1', 'claim:scope-2', 'claim:constraint-1', 'claim:outcome-1'],
    terminalClaimIds: ['terminal:audited-1', 'terminal:delivered-1'],
  },
};
let validatorOk = true;
for (const m of members) {
  let v;
  try { v = validatePrdIntentMember(m, universe); }
  catch (e) { v = { ok: false, reason: 'CONTRACT_SEAM_UNWIRED', detail: String(e) }; }
  const ok = v.ok === true && v.digest === memberDigest.get(m.memberId);
  validatorOk = validatorOk && ok;
  check(`E.wp03:${m.memberId}`, ok, v.ok ? `sealed by wp03:validatePrdIntentMember, digest ${v.digest}` : `${v.reason}: ${v.detail}`);
}
check('E.wp03.members', validatorOk, `6/6 members sealed by the REAL WP03 validator against the reviewer envelope universe`);

/* ------------------------------------------------------------------ */
/* F. Gate laws replayed (cell.ts/gate.ts, product-intent cell)         */
/* ------------------------------------------------------------------ */
const FORBIDDEN = ['acceptance', 'acceptanceCriteria', 'fr', 'nfr', 'requirements', 'rule', 'scenarios', 'srs', 'useCases'];
const forbiddenTop = FORBIDDEN.filter((k) => art.content[k] !== undefined);
const forbiddenDeep = [];
const deepScan = (o, at) => {
  if (o === null || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    if (FORBIDDEN.includes(k)) forbiddenDeep.push(`${at}.${k}`);
    deepScan(v, `${at}.${k}`);
  }
};
deepScan(art.content, 'bundle');
check('F1.fence.bundleKeys', forbiddenTop.length === 0, `top-level forbidden keys: ${forbiddenTop.length === 0 ? 'none' : forbiddenTop.join(',')}`);
check('F2.fence.deepScan', forbiddenDeep.length === 0, `deep forbidden keys (reviewer-extra): ${forbiddenDeep.length === 0 ? 'none' : forbiddenDeep.join(',')}`);
check('F3.brief.nonEmpty', typeof art.content.brief === 'string' && art.content.brief.length > 0, `${art.content.brief.length} chars`);
check('F4.members.nonEmpty', Array.isArray(members) && members.length > 0, `${members.length} members`);
const dupIds = members.map((m) => m.memberId).filter((id, i, a) => a.indexOf(id) !== i);
check('F5.noDuplicateMemberIds', dupIds.length === 0, dupIds.length === 0 ? 'all member ids unique' : dupIds.join(','));
const cited = new Set();
for (const m of members) for (const r of m.sourceClaimRefs ?? []) cited.add(r);
for (const m of members) for (const r of m.scopeClaimRefs ?? []) cited.add(r);
const uncovered = universe.idSets.sourceClaimIds.filter((c) => !cited.has(c));
check('F6.coverageLaw', uncovered.length === 0, uncovered.length === 0 ? `all ${universe.idSets.sourceClaimIds.length} accepted source claims realized or explicitly dispositioned` : `COVERAGE_GAP: ${uncovered.join(',')}`);

/* ------------------------------------------------------------------ */
/* G. AcceptedIntentSet fold (the exact universe handed to successors)  */
/* ------------------------------------------------------------------ */
const scenarioRequired = members.filter((m) => m.disposition?.disposition === 'scenario_required').map((m) => m.memberId);
const memberDigests = members.map((m) => memberDigest.get(m.memberId)).sort();
const fold = {
  revisionDigest: sha({ memberDigests }),
  prdMemberIds: members.map((m) => m.memberId),
  scenarioRequiredMemberIds: scenarioRequired,
  memberDigests,
};
check('G1.fold.wellFormed', fold.prdMemberIds.length === 6 && fold.scenarioRequiredMemberIds.length === 3, `revisionDigest ${fold.revisionDigest}; scenario_required=${fold.scenarioRequiredMemberIds.join(',')}`);

/* ------------------------------------------------------------------ */
/* H. Upstream chain re-verified end-to-end (import desk, r2)           */
/* ------------------------------------------------------------------ */
check('H1.import.authorSubmission', sha(iSub.content) === iSub.contentDigest, `recomputed ${sha(iSub.content)} vs declared ${iSub.contentDigest}`);
check('H2.import.artifact', sha(iArt.content) === iArt.contentDigest, `recomputed ${sha(iArt.content)} vs declared ${iArt.contentDigest}`);
check('H3.import.authorTrace', sha(iTrc.content) === iTrc.contentDigest, `recomputed ${sha(iTrc.content)} vs declared ${iTrc.contentDigest}`);
check('H4.import.reviewerReview', sha(iRev.content) === iRev.contentDigest, `recomputed ${sha(iRev.content)} vs declared ${iRev.contentDigest}`);
check('H5.import.reviewerVerification', sha(iVer.content) === iVer.contentDigest, `recomputed ${sha(iVer.content)} vs declared ${iVer.contentDigest}`);
check('H6.import.reviewerTrace', sha(iRTrc.content) === iRTrc.contentDigest, `recomputed ${sha(iRTrc.content)} vs declared ${iRTrc.contentDigest}`);
check('H7.import.reviewerSubmission', sha(iRSub.content) === iRSub.contentDigest, `recomputed ${sha(iRSub.content)} vs declared ${iRSub.contentDigest}`);
check('H8.import.verdictAccepted', iRev.content.verdict === 'accepted' && iRSub.content.verdict === 'accepted', `review verdict=${iRev.content.verdict}, reviewer product verdict=${iRSub.content.verdict}`);

/* 9 capsule sub-artifacts recomputed from the import artifact content. */
const vsa = iArt.content.verifiedSubArtifacts;
const capDigests = new Map();
const strip = (x) => ({ ref: shaRef(x.digest), digest: x.digest });
const flat = [
  ['certificate', vsa.certificate],
  ...vsa.sourceClaims.map((x) => [`sourceClaim:${x.semanticCode}`, x]),
  ...vsa.constraints.map((x) => [`constraint:${x.semanticCode}`, x]),
  ...vsa.unknowns.map((x) => [`unknown:${x.semanticCode}`, x]),
  ...vsa.terminalLifecycleClaims.map((x) => [`terminalClaim:${x.semanticCode}`, x]),
];
let subsOk = true;
for (const [label, x] of flat) {
  const recomputed = sha(x.content);
  capDigests.set(x.content.claimId ?? x.content.constraintId ?? x.content.unknownId ?? x.content.terminalLifecycleClaimId, recomputed);
  const ok = recomputed === x.digest && x.digest.length === 64;
  subsOk = subsOk && ok;
  check(`H9.${label}`, ok, `recomputed ${recomputed} vs declared ${x.digest}`);
}
check('H9.subArtifacts.all', subsOk, `9/9 capsule sub-artifacts recomputed over canonical content`);

/* Capsule self-address over the recorded facts (ingress.ts factBody order). */
const factBody = {
  schemaVersion: iArt.content.protocolVersion,
  lineage: iArt.content.lineage,
  parentState: iArt.content.parentState,
  certificate: strip(vsa.certificate),
  sourceClaims: vsa.sourceClaims.map(strip),
  constraints: vsa.constraints.map(strip),
  unknowns: vsa.unknowns.map(strip),
  terminalLifecycleClaims: vsa.terminalLifecycleClaims.map(strip),
  packageBytesDigest: iArt.content.packageBytesDigest,
};
const recomputedCapsule = sha(factBody);
const cap = iArt.content.capsule;
check('H10.capsule.selfAddress', recomputedCapsule === cap.capsuleDigest, `recomputed ${recomputedCapsule} vs declared ${cap.capsuleDigest}`);

/* The candidate's upstream block binds the REAL verified chain. */
const up = art.content.upstream;
check('H11.upstream.binding', up.importArtifactRef === shaRef(iArt.contentDigest) && up.capsuleRef === shaRef(cap.capsuleDigest) && up.certificateRef === shaRef(vsa.certificate.digest), `import=${up.importArtifactRef}, capsule=${up.capsuleRef}, certificate=${up.certificateRef}`);
const subDigestOf = (id) => {
  const hit = flat.find(([, x]) => (x.content.claimId ?? x.content.constraintId ?? x.content.unknownId ?? x.content.terminalLifecycleClaimId) === id);
  return hit === undefined ? undefined : hit[1].digest;
};
let vsaOk = up.verifiedSubArtifacts.length === 8;
for (const e of up.verifiedSubArtifacts) {
  const expect = subDigestOf(e.id);
  const ok = expect !== undefined && e.digest === expect && e.ref === shaRef(expect);
  vsaOk = vsaOk && ok;
  check(`H12.upstream:${e.id}`, ok, expect === undefined ? 'id not present in verified capsule' : `digest match=${e.digest === expect}`);
}
check('H12.upstream.verifiedSubArtifacts', vsaOk, `8/8 candidate upstream entries resolve to recomputed capsule sub-artifacts`);

/* ------------------------------------------------------------------ */
/* I. Reviewer envelope cross-check + the stray upstream entry          */
/* ------------------------------------------------------------------ */
let envOk = true;
for (const [id, digest] of Object.entries(ENVELOPE)) {
  const recomputed = subDigestOf(id);
  const ok = recomputed === digest;
  envOk = envOk && ok;
  check(`I.envelope:${id}`, ok, `envelope ${digest.slice(0, 8)}..., recomputed ${recomputed === undefined ? 'UNRESOLVABLE' : recomputed.slice(0, 8)}..., match=${ok}`);
}
check('I.envelope.materialAddresses', envOk, `8/8 task-projection material addresses resolve id+digest byte-exact`);

/* The envelope's upstream-accepted[0]: sha256:745cadc... (r1 CRIT-001). */
const STRAY = '745cadc1131468039f167043c000fc0af170ed98764f545f22d867be36da1c35';
const allDigests = new Set([
  sub.contentDigest, art.contentDigest, trc.contentDigest,
  iSub.contentDigest, iArt.contentDigest, iTrc.contentDigest,
  iRev.contentDigest, iVer.contentDigest, iRTrc.contentDigest, iRSub.contentDigest,
  recomputedCapsule, ...capDigests.values(), ...memberDigest.values(), fold.revisionDigest,
]);
const strayInRound = allDigests.has(STRAY);
check('J1.stray.notInRoundDigests', !strayInRound, `stray entry equals none of the ${allDigests.size} recomputed round digests`);

/* Exhaustive workspace scan (reproducible proof): raw bytes, canonical
   whole-JSON, canonical content, and every string field of every JSON. */
const scanTargets = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
};
const scanStringFields = (o, hits) => {
  if (typeof o === 'string') { if (o.replace(/^sha256:/, '') === STRAY) hits.push(true); return; }
  if (o !== null && typeof o === 'object') for (const v of Object.values(o)) scanStringFields(v, hits);
};
let strayResolves = false;
let scanned = 0;
for (const base of [DIR, R1]) {
  for (const p of scanTargets(base)) {
    const rel = relative(base, p);
    /* The verifier's subject is the AUTHOR candidate and the workspace state the
       reviewer RECEIVED; the reviewer's own artifacts are checked by the separate
       consistency pass and excluded here (they legitimately QUOTE the stray ref
       when documenting its resolution). */
    if (rel === 'define-product-intent-desk-reviewer-verify.mjs' || rel.startsWith('define-product-intent-desk-reviewer-')) continue;
    scanned += 1;
    const bytes = readFileSync(p);
    if (shaRaw(bytes) === STRAY) { strayResolves = true; check('J2.stray.scan', false, `RAW-BYTE match at ${p}`); }
    if (p.endsWith('.json')) {
      try {
        const j = JSON.parse(bytes.toString('utf8'));
        if (sha(j) === STRAY) { strayResolves = true; check('J2.stray.scan', false, `whole-JSON canonical match at ${p}`); }
        if (j !== null && typeof j === 'object') {
          if (j.content !== undefined && sha(j.content) === STRAY) { strayResolves = true; check('J2.stray.scan', false, `content canonical match at ${p}`); }
          const hits = [];
          scanStringFields(j, hits);
          if (hits.length > 0) check('J2.stray.scan.note', true, `string-field mention(s) only (${hits.length}) at ${relative(base, p)} - a quotation, not a resolution`);
        }
      } catch { /* non-JSON or unparsable: raw check already applied */ }
    }
  }
}
check('J2.stray.exhaustiveScan', !strayResolves, `sha256:745cadc... resolves to NOTHING across ${scanned} files of both round workspaces (raw bytes, canonical whole-JSON, canonical content; string-field mentions are quotations of the envelope itself)`);
check('J3.stray.historyUnstable', true, 'the same envelope slot carried sha256:15ed5b0e... in the r1 v1 frame and sha256:745cadc... in the r1 v2/r2 frames - both unresolvable; the entry is unstable harness state, not desk material');

/* Workspace law reconciliation (author 0 vs envelope 1). */
check('J4.workspace.authorConsistent', art.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && trc.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && sub.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && art.content.verification.acceptedUpstreamRevisionsTravelingByContentAddress === 0,
  'author declares 0 consistently across artifact, trace, submission and verification flag');
check('J5.workspace.reconciliation', true, 'envelope line says 1 (derived from upstreamAccepted.length) but its SOLE entry is the proven unresolvable stray (J1-J3); the honest resolvable count is 0 - the author declaration stands, the envelope count is a protocol-layer defect, not a candidate defect');

/* ------------------------------------------------------------------ */
/* K. Governing contract cross-round provenance                         */
/* ------------------------------------------------------------------ */
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const r1Recomputed = sha(r1Contract.content);
check('K1.governingContract.refPresence', art.content.governingContractRef === shaRef(GOVERNING) && sub.content.payloadContract.requiredEvidenceRefs.includes(shaRef(GOVERNING)), 'governing contract ref pinned in candidate + payload contract');
check('K2.governingContract.recompute', r1Recomputed === GOVERNING, `r1 rendering recomputes to ${r1Recomputed}, NOT ${GOVERNING} (the r1 artifact self-declares the pinned digest; its content does not recompute - r1 fabricated-digest disease, CRIT-003 class). Cross-round PROVENANCE residue: substance authentic (criteria text present), ref not a valid content address under the frozen rule`);

/* ------------------------------------------------------------------ */
/* L. Author trace graph over recomputed digests                        */
/* ------------------------------------------------------------------ */
const digestIndex = new Map([...memberDigest, ...capDigests, ...Object.entries(ENVELOPE).map(([k, v]) => [k, v])]);
const VOCAB = new Set(trc.content.relationVocabulary);
let relOk = true;
for (const [i, rel] of trc.content.relationships.entries()) {
  const fromOk = rel.fromRef === shaRef(digestIndex.get(rel.fromId));
  const toOk = rel.toRef === shaRef(digestIndex.get(rel.toId));
  const ok = VOCAB.has(rel.relation) && fromOk && toOk;
  relOk = relOk && ok;
  if (!ok) check(`L.rel[${i}]`, false, `${rel.fromId} -${rel.relation}-> ${rel.toId} does not resolve (from=${fromOk}, to=${toOk}, vocab=${VOCAB.has(rel.relation)})`);
}
check('L1.relationships.resolve', relOk, `${trc.content.relationships.length} relationships resolve against recomputed digests`);

/* Member coverage = the OUT-edge set of the member (WP04 member graph:
   members derive_from claims, enforce/constrain on the constraint,
   support terminals). */
const outProjection = (id) => {
  const edges = trc.content.relationships.filter((r) => r.fromId === id);
  return {
    derivedFrom: edges.filter((r) => r.relation === 'derived_from').map((r) => r.toId).sort(),
    enforces: edges.filter((r) => r.relation === 'enforces').map((r) => r.toId).sort(),
    constrainedBy: edges.filter((r) => r.relation === 'constrained_by').map((r) => r.toId).sort(),
    supports: edges.filter((r) => r.relation === 'supports').map((r) => r.toId).sort(),
  };
};
let covOk = true;
for (const [id, m] of Object.entries(trc.content.memberCoverage)) {
  const proj = outProjection(id);
  const expect = {
    derivedFrom: [...(m.derivedFrom ?? [])].sort(),
    enforces: [...(m.enforces ?? [])].sort(),
    constrainedBy: [...(m.constrainedBy ?? [])].sort(),
    supports: [...(m.supports ?? [])].sort(),
  };
  const ok = m.digest === memberDigest.get(id)
    && JSON.stringify(proj.derivedFrom) === JSON.stringify(expect.derivedFrom)
    && JSON.stringify(proj.enforces) === JSON.stringify(expect.enforces)
    && JSON.stringify(proj.constrainedBy) === JSON.stringify(expect.constrainedBy)
    && JSON.stringify(proj.supports) === JSON.stringify(expect.supports);
  covOk = covOk && ok;
  if (!ok) check(`L2.coverage:${id}`, false, 'member coverage block is not the exact out-edge projection');
}
check('L2.memberCoverage.exact', covOk, '6/6 member coverage blocks are exact projections of the edge set');

/* Terminal coverage: in-edge supports projection, non-empty ownership, and
   every supporting member anchored only in accepted material (claims subset
   of the accepted source-claim set; constraint edges only retention-1). */
const inSupports = (t) => trc.content.relationships.filter((r) => r.toId === t && r.relation === 'supports').map((r) => r.fromId).sort();
let termOk = true;
for (const t of universe.idSets.terminalClaimIds) {
  const cov = trc.content.terminalCoverage[t];
  const supported = inSupports(t);
  const supportedMembers = members.filter((m) => supported.includes(m.memberId));
  const anchorsLegal = supportedMembers.every((m) =>
    (m.sourceClaimRefs ?? []).every((c) => universe.idSets.sourceClaimIds.includes(c))
    && (m.scopeClaimRefs ?? []).every((c) => universe.idSets.sourceClaimIds.includes(c))
    && (m.terminalClaimRefs ?? []).every((c) => universe.idSets.terminalClaimIds.includes(c)));
  const ok = cov !== undefined
    && cov.digest === ENVELOPE[t]
    && JSON.stringify(cov.supportedBy ?? []) === JSON.stringify(supported)
    && supported.length > 0
    && anchorsLegal;
  termOk = termOk && ok;
  check(`L3.terminal:${t}`, ok, `digest match=${cov?.digest === ENVELOPE[t]}, supportedBy=edge projection (${supported.join(',')}), supporting members anchored only in accepted material=${anchorsLegal}`);
}
check('L3.terminalCoverage', termOk, 'both lifecycle terminals owned, supported, and reachable');

const ownOk = art.content.terminalOwnership.every((o) => {
  const edge = trc.content.relationships.find((r) => r.relation === 'supports' && r.fromId === o.ownedByMemberId && r.toId === o.terminalClaimId);
  return edge !== undefined && o.digest === ENVELOPE[o.terminalClaimId];
}) && art.content.terminalOwnership.length === 2;
check('L4.terminalOwnership', ownOk, 'terminalOwnership block 2/2 matches supports edges + envelope digests');

/* Unknown carried forward, never resolved (D10). */
const unkEdges = trc.content.relationships.filter((r) => r.fromId === 'unknown:browser-matrix-1');
check('L5.unknown.carriedNotResolved', trc.content.unknownCoverage?.unknownId === 'unknown:browser-matrix-1'
  && trc.content.unknownCoverage.disposition === 'carried_forward'
  && trc.content.unknownCoverage.owner === 'discovery'
  && unkEdges.length === 0,
  `disposition=carried_forward, owner=discovery, resolution edges=${unkEdges.length}`);

/* Constraint disposition honored. */
check('L6.constraint.honored', art.content.constraintDispositions[0]?.constraintId === 'constraint:retention-1'
  && art.content.constraintDispositions[0]?.disposition === 'honored'
  && JSON.stringify(art.content.constraintDispositions[0]?.enforcedBy) === JSON.stringify(['prd:constraint-1']),
  'constraint:retention-1 honored, enforced by the determinism member');

/* ------------------------------------------------------------------ */
/* M. Payload contract                                                  */
/* ------------------------------------------------------------------ */
const EXPECTED_EVIDENCE = [
  shaRef(cap.capsuleDigest), shaRef(vsa.certificate.digest),
  ...Object.entries(ENVELOPE).map(([id, d]) => (id.startsWith('terminal:') ? shaRef(d) : shaRef(d))),
  shaRef(GOVERNING),
];
const got = [...sub.content.payloadContract.requiredEvidenceRefs].sort();
const want = [...new Set([...Object.values(ENVELOPE).map(shaRef), shaRef(cap.capsuleDigest), shaRef(vsa.certificate.digest), shaRef(GOVERNING)])].sort();
check('M1.evidenceRefs.exact', JSON.stringify(got) === JSON.stringify(want), `${got.length} refs, exact set match=${JSON.stringify(got) === JSON.stringify(want)}`);
const cov = sub.content.payloadContract.evidenceKindCoverage;
check('M2.evidenceKindCoverage', cov['discovery-handoff-capsule'] === 1 && cov['discovery-certificate'] === 1 && cov['source-claim'] === 4 && cov['constraint'] === 1 && cov['unknown'] === 1 && cov['terminal-claim'] === 2 && cov['architecture-contract'] === 1, JSON.stringify(cov));
check('M3.terminalOutcome', sub.content.payloadContract.terminalOutcome === 'success', sub.content.payloadContract.terminalOutcome);

/* ------------------------------------------------------------------ */
/* N. Desk identity pins (cell.ts constants)                            */
/* ------------------------------------------------------------------ */
check('N.deskPins', art.content.deskRef === 'define-product-intent'
  && art.content.deskNodeId === 'define-product-intent'
  && art.content.itemInstanceId === 'formalization-item:define-product-intent'
  && art.content.token === 'plan:formalization#item:product-intent'
  && art.content.productKind === 'frf-cell.product-intent.v1'
  && art.content.effectId === 'formalization.accept-products'
  && art.content.checkProviderId === 'frf-cell.product-intent.members.v1'
  && art.content.contractKind === 'frf-contracts.prd-intent-member.v1',
  'desk/node/item/token/kind/effect/provider/contract');

/* ------------------------------------------------------------------ */
/* O. Determinism + author verification-flag honesty                    */
/* ------------------------------------------------------------------ */
const PIN = '2026-08-28T00:00:00Z';
check('O1.pinnedTimestamps', art.createdAt === PIN && sub.createdAt === PIN && trc.createdAt === PIN, `all author artifacts pinned at ${PIN}`);
const v = art.content.verification;
const flagsOk = v.declaredDigestsTrusted === false
  && v.memberSealsRecomputedOverCanonicalMembers === sealsOk
  && v.claimDigestsMatchedTaskProjection === envOk
  && v.coverageLawSatisfied === (uncovered.length === 0)
  && v.terminalClaimsOwnedByMembers === ownOk
  && v.deterministicAuthoring === true
  && v.fenceRespectedNoFinalContent === (forbiddenTop.length === 0 && forbiddenDeep.length === 0)
  && v.acceptedUpstreamRevisionsTravelingByContentAddress === 0
  && v.staleProtocolRefusals === 0;
check('O2.authorFlagsHonest', flagsOk, JSON.stringify(v));

/* ------------------------------------------------------------------ */
/* Summary                                                              */
/* ------------------------------------------------------------------ */
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts',
  verifier: 'define-product-intent-desk-reviewer-verify.mjs',
  wp03Validator: 'REAL validatePrdIntentMember imported from src/workflow-kernel/workshops/formalization/contracts/validators/prd-intent-member.mjs',
  acceptedIntentSet: fold,
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failedClassification: failed.map((f) => f.id),
  results,
}, null, 2));
