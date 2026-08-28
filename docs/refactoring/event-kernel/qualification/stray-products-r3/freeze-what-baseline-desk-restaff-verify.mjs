/**
 * freeze-what-baseline desk (author) - RE-STAFF CONFIRMATION mechanical verifier.
 *
 * Re-derives AS-Freeze-What-Baseline-001 from the corpus on disk: every
 * published digest recomputed (own confirmation/trace, the standing hold
 * package, every cited upstream record, capsule envelope, schema pin),
 * the gate prohibition and collision round-of-record recomputed from the
 * verdict records themselves, the movement scan re-run workspace-wide and
 * compared against the published census, the governing anchor resolution-
 * scanned across the scanned trees, trace edges resolved against the
 * recomputed digest space, the no-authoring fence audited, and the
 * determinism + namespacing laws checked on this emission's own sources.
 * Nothing is trusted by declaration. Deterministic: pinned outputs, no
 * clock reads, no randomness.
 *
 * Stability law: point-in-time tree-size counters (filesScanned) are
 * compared only as monotonicity (recomputed >= published); per-desk
 * accepted-record classifications and the benign-set partition are
 * compared exactly.
 *
 * Run: node freeze-what-baseline-desk-restaff-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRaw = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(DIR, '..', '..', '..', '..', '..');
const QUAL = join(REPO, 'docs', 'refactoring', 'event-kernel', 'qualification');
const FB = join(REPO, '.factory-testbed');
const CREATED_AT = '2026-08-28T12:00:00Z';
const WS = '0 accepted upstream revisions travel by content address';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';

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

const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';
const loadRec = (relPath) => JSON.parse(readFileSync(join(REPO, relPath), 'utf8'));
const digestOf = (relPath) => sha(loadRec(relPath).content);

const checks = [];
const check = (id, pass, detail) => { checks.push({ id, pass: pass === true, detail }); return pass === true; };

/* ------------------------------------------------------------------ */
/* C1: own confirmation + trace digests recompute from disk.            */
/* ------------------------------------------------------------------ */

const conf = loadRec(`${R3}/freeze-what-baseline-desk-restaff-confirmation.json`);
const trc = loadRec(`${R3}/freeze-what-baseline-desk-restaff-trace.json`);
check('C1.confirmationDigest', sha(conf.content) === conf.contentDigest && conf.contentDigest === 'c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06',
  `confirmation content digest recomputes to ${sha(conf.content)}`);
check('C1.traceDigest', sha(trc.content) === trc.contentDigest && trc.contentDigest === 'fc4aae420a87ea19f6d970815824be0b2d168c8f8c05628c5d300d062777ba80',
  `trace content digest recomputes to ${sha(trc.content)}`);
check('C1.refs', conf.confirmationRef === shaRef(conf.contentDigest) && trc.traceRef === shaRef(trc.contentDigest) && trc.content.subjectArtifactRef === conf.confirmationRef,
  'trace subject binds the confirmation ref');
check('C1.acyclicBinding', trc.content.confirmationContentDigest === conf.contentDigest && conf.content.trace.file === 'freeze-what-baseline-desk-restaff-trace.json' && conf.content.trace.edgeCount === trc.content.relationships.length,
  `the trace embeds the confirmation by content digest; the confirmation binds the trace by file + edge count (${trc.content.relationships.length}, acyclic)`);
check('C1.pinnedTimestamp', conf.createdAt === CREATED_AT && trc.createdAt === CREATED_AT, `pinned ${CREATED_AT}`);

/* ------------------------------------------------------------------ */
/* C2: envelope identity - 8/8 recompute from the accepted capsule.     */
/* ------------------------------------------------------------------ */

const importArt = loadRec(`${R2}/import-discovery-handoff-desk-discovery-import.artifact.json`);
check('C2.importDigest', sha(importArt.content) === importArt.contentDigest && importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5',
  'accepted import artifact digest recomputes');
const vsa = importArt.content.verifiedSubArtifacts;
const capGroups = [vsa.sourceClaims, vsa.constraints, vsa.unknowns, vsa.terminalLifecycleClaims, [vsa.certificate]];
const capDigests = capGroups.flat().map((s) => ({ s, digest: sha(s.content) }));
check('C2.capsuleSubArtifacts', capDigests.every(({ s, digest }) => digest === s.digest), `all ${capDigests.length} capsule sub-artifact digests recompute`);
check('C2.envelopeProjection', Object.values(ENVELOPE).every((d) => capDigests.some(({ digest }) => digest === d)),
  'envelope 8/8 recompute from accepted capsule content');
check('C2.certificate', capDigests.some(({ digest }) => digest === '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21'), 'CERT-1 recomputes');
const builtRecompute = conf.content.envelopeIdentity.envelopeRecompute;
check('C2.envelopeRecomputeBlock', Array.isArray(builtRecompute) && builtRecompute.filter((e) => e.envelopeMatch).length === 8
  && Object.entries(ENVELOPE).every(([id, d]) => builtRecompute.some((e) => e.envelopeId === id && e.digest === d && e.envelopeMatch)),
  'published envelopeRecompute block carries the exact 8/8 matches');
check('C2.envelopePins', conf.content.envelopePins?.protocolSkillRef === shaRef(GOVERNING)
  && conf.content.envelopePins?.semanticSkillRef === 'sha256:95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd'
  && conf.content.envelopePins?.workspaceSummary === WS
  && Array.isArray(conf.content.envelopePins?.upstreamAccepted) && conf.content.envelopePins.upstreamAccepted.length === 0
  && conf.content.envelopePins?.writeAuthority === 'write authority: desk artifacts only; allowed=artifact-create,trace-add,fs:read,fs:write',
  'envelope pins (skills, 0-upstream workspace, empty upstream-accepted, write authority) recorded verbatim');
check('C2.workspaceSummary', conf.content.workspaceSummary === WS && trc.content.workspaceSummary === WS, 'workspace summary line carried verbatim in confirmation + trace');

/* ------------------------------------------------------------------ */
/* C3: the standing package of record recomputes byte-stable.           */
/* ------------------------------------------------------------------ */

const holdArt = loadRec(`${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`);
const holdTrc = loadRec(`${R3}/freeze-what-baseline-desk-upstream-hold-trace.json`);
check('C3.holdArtifactDigest', sha(holdArt.content) === holdArt.contentDigest && holdArt.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f',
  'standing hold artifact digest recomputes byte-stable');
check('C3.holdTraceDigest', sha(holdTrc.content) === holdTrc.contentDigest && holdTrc.contentDigest === '17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202',
  'standing hold trace digest recomputes byte-stable');
check('C3.holdDecision', holdArt.content.decision === 'hold-no-authoring' && holdArt.content.noProductAuthored === true, 'standing hold decision intact');
check('C3.holdCensus', holdArt.content.chainAcceptanceCensus.acceptedPreFreezeDeskCount === 0 && holdArt.content.chainAcceptanceCensus.requiredByFreezeContract === 5,
  'standing hold census 0/5 intact');
const holdVo = loadRec(`${R3}/freeze-what-baseline-desk-hold-verify-out.json`);
check('C3.holdReceiptSemantics', holdVo.summary?.allPass === true && holdVo.summary?.pass === 33 && holdVo.summary?.fail === 0
  && holdVo.artifactRef === shaRef(holdArt.contentDigest) && holdVo.traceRef === shaRef(holdTrc.contentDigest),
  'standing hold receipt semantics: 33/33 pass, subject binds the hold artifact/trace refs');
check('C3.publishedPackageBlock', conf.content.confirmedPackageOfRecord.holdArtifact.ref === shaRef(holdArt.contentDigest)
  && conf.content.confirmedPackageOfRecord.holdTrace.ref === shaRef(holdTrc.contentDigest)
  && conf.content.confirmedPackageOfRecord.holdTrace.edges === holdTrc.content.relationships.length
  && conf.content.confirmedPackageOfRecord.holdVerifier.checksPassed === 33,
  'published package-of-record block pins exactly the recomputed standing package');
check('C3.envelopeByteEquality', holdArt.content.taskProjection.verifiedSubArtifacts.length === 8
  && Object.entries(ENVELOPE).every(([id, d]) => holdArt.content.taskProjection.verifiedSubArtifacts.some((v) => v.id === id && v.digest === d))
  && holdArt.content.workspaceSummary === WS,
  'this staffing envelope is byte-equal to the standing hold envelope projection + workspace summary');
check('C3.staffingRound', conf.content.staffingRound.includes('byte-identical desk task envelope') && conf.semanticCode === 'AS-Freeze-What-Baseline-001' && conf.artifactKind === 'author-restaff-confirmation',
  'staffing round declared as a byte-identical re-staffing');

/* ------------------------------------------------------------------ */
/* C4: the upstream gate - recomputed, unchanged.                       */
/* ------------------------------------------------------------------ */

const g = {
  rwArt: digestOf(`${R3}/reconcile-what-desk-what-reconciliation.artifact.json`),
  rwTrc: digestOf(`${R3}/reconcile-what-desk-what-reconciliation-trace.json`),
  rwSub: digestOf(`${R3}/reconcile-what-desk-product-submission.json`),
  frRw: digestOf(`${R3}/reconcile-what-desk-reviewer-review.json`),
  vvRw: digestOf(`${R3}/reconcile-what-desk-reviewer-verification.json`),
  rtRw: digestOf(`${R3}/reconcile-what-desk-reviewer-trace.json`),
  fsRw2: digestOf(`${R3}/reconcile-what-desk-reviewer-product-submission.json`),
  clRw: digestOf(`${R3}/reconcile-what-desk-reviewer-collision-record.json`),
};
check('C4.candidateDigests', g.rwArt === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191' && g.rwTrc === '09e800469f38c2d926dc1ef24974ca3b2f01ce72913ffcc5832dde071d6581e0' && g.rwSub === '0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba',
  'reconcile-what author candidate of record (artifact/trace/submission) digests recompute');
check('C4.reviewerRound', g.frRw === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6' && g.vvRw === 'cd7504a69eff07d39f9945f8cf3da3f7cf8c4d8e91932c897dab5f5fbab35cac' && g.rtRw === 'fe108e09db2dedb37dbb151d46e56090128c7bc44da339e44be62a47e7755373' && g.fsRw2 === '9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce',
  'reviewer round of record (review/verification/trace/submission) digests recompute');
const frRwRaw = loadRec(`${R3}/reconcile-what-desk-reviewer-review.json`).content;
check('C4.verdictRepair', frRwRaw.reviewId === 'FR-Reconcile-What-001' && frRwRaw.verdict === 'repair', 'verdict of record: repair');
check('C4.candidateBinding', frRwRaw.reviewedCandidate?.submissionRef === shaRef(g.rwSub) && frRwRaw.reviewedCandidate?.artifactRef === shaRef(g.rwArt),
  'reviewer of record reviewed exactly the author candidate of record');
check('C4.prohibition', frRwRaw.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline')
  && frRwRaw.findings.criticalIssues.some((f) => f.id === 'CRIT-1' && f.requiredAction.includes('No accept effect may fire on this chain')),
  'explicit no-accept prohibition recomputed from the verdict record');
check('C4.collisionRecord', g.clRw === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d'
  && loadRec(`${R3}/reconcile-what-desk-reviewer-collision-record.json`).content.emissionA?.verdict === 'repair',
  'collision record recomputes; emission A (repair) is the round of record');
const gate = conf.content.upstreamStateRecheck.gate;
check('C4.gateBlockPinned', gate.verdictOfRecord.reviewRef === shaRef(g.frRw) && gate.verdictOfRecord.verificationRef === shaRef(g.vvRw)
  && gate.reviewerCollision.recordRef === shaRef(g.clRw) && gate.candidateOfRecord.submissionRef === shaRef(g.rwSub)
  && gate.candidateOfRecord.artifactRef === shaRef(g.rwArt) && gate.prohibitionRecomputed === true
  && gate.explicitProhibition.includes('No domain.accepted may fire from this desk toward freeze-what-baseline'),
  'published gate block pins exactly the recomputed digests + prohibition');

/* ------------------------------------------------------------------ */
/* C5: the census beneath the gate - desk revisions + verdict records.  */
/* ------------------------------------------------------------------ */

const REV = {
  'define-product-intent': digestOf(`${R3}/define-product-intent-desk-product-intent.artifact.json`),
  'model-use-cases': digestOf(`${R3}/model-use-cases-desk-uc-scenarios.artifact.json`),
  'derive-system-requirements': digestOf(`${R3}/derive-system-requirements-desk-system-requirements.artifact.json`),
  'define-acceptance-contract': digestOf(`${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`),
  'reconcile-what': g.rwArt,
};
check('C5.revisionAddresses', REV['define-product-intent'] === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055'
  && REV['model-use-cases'] === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b'
  && REV['derive-system-requirements'] === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df'
  && REV['define-acceptance-contract'] === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0',
  'the five pre-freeze revision addresses recompute');
check('C5.intent', loadRec(`${R2}/define-product-intent-desk-reviewer-review.json`).content.verdict === 'repair'
  && loadRec(`${R2}/define-product-intent-desk-reviewer-review-emission-b.json`).content.verdict === 'repair'
  && loadRec(`${R2}/define-product-intent-desk-reviewer2-review.json`).content.verdict === 'repair',
  'intent revision: repair across every emission record');
const frUc001 = loadRec('.factory-testbed/model-use-cases-reviewer-review.json').content;
check('C5.uc', frUc001.reviewId === 'FR-Model-Use-Cases-001' && frUc001.verdict === 'accepted'
  && frUc001.reviewedCandidate?.artifactRef === 'sha256:c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8'
  && frUc001.reviewedCandidate?.artifactRef !== shaRef(REV['model-use-cases']),
  'UC revision: the only accepted verdict pins a DIFFERENT candidate - never reviewed at its own address');
check('C5.requirements', loadRec(`${R2}/derive-system-requirements-desk-reviewer-review.json`).content.verdict === 'repair'
  && digestOf(`${R2}/derive-system-requirements-desk-reviewer-restaff2-confirmation.json`) === '1c30d28e8222eaa225195bf33d87f378054b98a01bdf50710fd4900f5339a0a6',
  'requirements revision: repair + re-staff confirmation');
check('C5.acceptanceHold', digestOf(`${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`) === 'a53a5e08a9c7f0f6ad550fd5d2db142238683e1d285458eb2ded5330cce39d84',
  'UH-Define-Acceptance-Contract-001 recomputes (desk on record hold)');
const frAc2 = loadRec(`${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`).content;
const fsAc2Raw = loadRec(`${R3}/define-acceptance-contract-desk-reviewer-product-submission-emission-c.json`).content;
check('C5.acceptanceSupersession', frAc2.reviewId === 'FR-Define-Acceptance-Contract-002' && frAc2.verdict === 'repair'
  && frAc2.reviewedCandidate?.artifactRef === shaRef(REV['define-acceptance-contract'])
  && frAc2.contentDigestCheck === undefined
  && JSON.stringify(fsAc2Raw).includes('CTN-Define-Acceptance-Contract-001'),
  'CTN adjudication recomputes: emission C repair supersedes the accepted emission');

/* ------------------------------------------------------------------ */
/* C6: movement scan re-run workspace-wide vs the published census.     */
/* ------------------------------------------------------------------ */

const BENIGN_ACCEPTED_CANDIDATES = new Set([
  '745cadc1131468039f167043c000fc0af170ed98764f545f22d867be36da1c35',
  'c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8',
  'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5',
]);
const REVSET = new Set(Object.values(REV));
const movement = { filesScanned: 0, verdictRecords: 0, acceptedTotal: 0, acceptedAtOwnAddress: {}, acceptedElsewhere: [], unparseable: 0 };
for (const desk of Object.keys(REV)) movement.acceptedAtOwnAddress[desk] = [];
const relQualPath = (p) => p.split('\\').join('/').slice(REPO.split('\\').join('/').length + 1);
const walkTree = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let isDir;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (isDir) { walkTree(p); continue; }
    if (!e.endsWith('.json')) continue;
    movement.filesScanned += 1;
    let obj = null;
    try { obj = JSON.parse(readFileSync(p, 'utf8')); } catch { movement.unparseable += 1; continue; }
    const c = obj?.content;
    if (!c || typeof c !== 'object') continue;
    const verdict = typeof c.verdict === 'string' ? c.verdict : null;
    const candRef = typeof c.reviewedCandidate?.artifactRef === 'string' ? c.reviewedCandidate.artifactRef : null;
    if (!verdict || !candRef) continue;
    movement.verdictRecords += 1;
    if (verdict !== 'accepted') continue;
    movement.acceptedTotal += 1;
    const cand = candRef.startsWith('sha256:') ? candRef.slice(7) : candRef;
    const deskHit = Object.entries(REV).find(([, d]) => d === cand);
    if (deskHit) movement.acceptedAtOwnAddress[deskHit[0]].push({ file: relQualPath(p), reviewId: c.reviewId ?? null, candidateRef: candRef });
    else movement.acceptedElsewhere.push({ file: relQualPath(p), reviewId: c.reviewId ?? null, candidateRef: candRef });
  }
};
walkTree(QUAL);
walkTree(FB);
const publishedMovement = conf.content.upstreamStateRecheck.movementScan;
check('C6.partition', Object.values(movement.acceptedAtOwnAddress).flat().length + movement.acceptedElsewhere.length === movement.acceptedTotal,
  `the accepted-record scan partitions exhaustively (${movement.acceptedTotal} accepted verdict records = ${Object.values(movement.acceptedAtOwnAddress).flat().length} at pre-freeze addresses + ${movement.acceptedElsewhere.length} elsewhere)`);
check('C6.deskCounts', Object.keys(REV).every((desk) => {
  const hits = movement.acceptedAtOwnAddress[desk];
  if (desk === 'define-acceptance-contract') {
    return hits.length === 2 && Boolean(hits.find((h) => h.reviewId === 'FR-Define-Acceptance-Contract-001'))
      && Boolean(hits.find((h) => h.reviewId === null && h.file.endsWith('define-acceptance-contract-desk-reviewer-product-submission.json')));
  }
  return hits.length === 0;
}), 'movement scan: zero accepted records at four pre-freeze addresses; the acceptance desk carries exactly the two superseded plain-slot records');
check('C6.benignPartition', movement.acceptedElsewhere.every((h) => BENIGN_ACCEPTED_CANDIDATES.has(h.candidateRef.startsWith('sha256:') ? h.candidateRef.slice(7) : h.candidateRef)),
  `all ${movement.acceptedElsewhere.length} accepted records outside the five addresses pin known-benign candidates (stale shell 745cadc1 / accepted UC product c6120e86 / accepted import b10bb762)`);
check('C6.publishedDeskCounts', Object.entries(publishedMovement.acceptedAtOwnAddress).every(([desk, block]) => {
  const hits = movement.acceptedAtOwnAddress[desk];
  return block.count === hits.length && (desk !== 'define-acceptance-contract' || canon(block.records) === canon(hits));
}) && publishedMovement.acceptedAtOwnAddress['define-product-intent'].count === 0
  && publishedMovement.acceptedAtOwnAddress['model-use-cases'].count === 0
  && publishedMovement.acceptedAtOwnAddress['derive-system-requirements'].count === 0
  && publishedMovement.acceptedAtOwnAddress['reconcile-what'].count === 0,
  'published per-desk accepted-record blocks match the recomputed scan exactly');
const publishedElsewhere = publishedMovement.acceptedElsewhere.map((h) => `${h.file}|${h.reviewId}|${h.candidateRef}`).sort();
const recomputedElsewhere = movement.acceptedElsewhere.map((h) => `${h.file}|${h.reviewId}|${h.candidateRef}`).sort();
check('C6.publishedElsewhere', publishedElsewhere.every((x) => recomputedElsewhere.includes(x)) && recomputedElsewhere.length >= publishedElsewhere.length,
  `published accepted-elsewhere set (${publishedElsewhere.length}) is contained in the recomputed set (${recomputedElsewhere.length})`);
check('C6.monotonicCounts', publishedMovement.filesScanned === undefined && publishedMovement.verdictRecords === undefined
  && typeof publishedMovement.counterPolicy === 'string' && publishedMovement.counterPolicy.includes('byte-stable'),
  `published movement block carries no tree-size counters (counter policy recorded; receipt counters: files ${movement.filesScanned}, verdict records ${movement.verdictRecords})`);
check('C6.noNewLineage', publishedMovement.newAcceptedLineageSinceHold === 0 && Object.entries(publishedMovement.acceptedAtOwnAddress).every(([desk, b]) => desk === 'define-acceptance-contract' || b.count === 0),
  'published claim holds: no accepted lineage landed at any pre-freeze desk address since the hold (acceptance records superseded)');
check('C6.censusBlock', conf.content.upstreamStateRecheck.census.acceptedPreFreezeDeskCount === 0 && conf.content.upstreamStateRecheck.census.requiredByFreezeContract === 5,
  'published census: 0 of 5');

/* ------------------------------------------------------------------ */
/* C7: the freeze product contract pin.                                 */
/* ------------------------------------------------------------------ */

const schemaBytes = readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json'));
const schema = JSON.parse(schemaBytes.toString('utf8'));
check('C7.schemaPin', shaRaw(schemaBytes) === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09'
  && schema.properties.acceptanceRecords.minItems === 5
  && schema.properties.schemaVersion.const === 'frf-contracts.what-baseline.v1'
  && schema.required.includes('acceptanceRecords'),
  'what-baseline schema recomputes: acceptanceRecords minItems 5 - the direct lawful-authoring blocker');
check('C7.holdDisposition', conf.content.holdDisposition.state === 'STANDING (not discharged; not re-emitted)'
  && conf.content.holdDisposition.basis.includes('acceptanceRecords minItems 5')
  && conf.content.holdDisposition.basis.includes('inherit the fabricated authority permanently')
  && conf.content.holdDisposition.resumeContract.includes('R1-R4'),
  'hold disposition STANDING; resume contract R1-R4 recorded unfulfilled');

/* ------------------------------------------------------------------ */
/* C8: fence + trace edges resolve against the recomputed digest space. */
/* ------------------------------------------------------------------ */

const FORBIDDEN = ['acceptanceRecords', 'caseIdentity', 'containers', 'developmentSurface', 'dispositions', 'evidenceBindings', 'sourceManifests', 'traceSet', 'wholeWhatDigest'];
check('C8.fence', FORBIDDEN.every((k) => !(k in conf.content)) && conf.content.deskOutcome.product === 'none' && conf.content.deskOutcome.productKind === null,
  'no baseline section authored; product none');
const space = new Set([
  ...Object.values(ENVELOPE),
  conf.contentDigest, holdArt.contentDigest, holdTrc.contentDigest, importArt.contentDigest,
  ...Object.values(g),
  ...Object.values(REV),
  ...capDigests.map(({ digest }) => digest),
  digestOf(`${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`),
]);
const rels = trc.content.relationships;
check('C8.traceResolution', rels.length > 0 && rels.every((r) => space.has(r.fromRef.slice(7)) && space.has(r.toRef.slice(7))),
  `all ${rels.length} trace edges resolve at both ends to recomputed digests`);
check('C8.relationVocabulary', rels.every((r) => ['observes', 'verifies', 'confirms'].includes(r.relation)) && canon(trc.content.relationVocabulary) === canon(['observes', 'verifies', 'confirms']),
  'closed relation vocabulary observed/verifies/confirms');
check('C8.coverageProjection', Object.keys(trc.content.taskProjectionCoverage).length === 8
  && Object.entries(trc.content.taskProjectionCoverage).every(([id, v]) => ENVELOPE[id] === v.digest && canon(v.verifiedBy) === canon(['AS-Freeze-What-Baseline-001'])),
  'trace task-projection coverage is the exact 8-entry envelope projection');
check('C8.confirmsEdge', rels.some((r) => r.relation === 'confirms' && r.toRef === shaRef(holdArt.contentDigest)),
  'the confirmation edge binds the standing hold artifact ref');
check('C8.emissionDiscipline', typeof conf.content.emissionDiscipline.noSecondHoldEmission === 'string'
  && conf.content.emissionDiscipline.noSecondHoldEmission.includes('9f2d28b9')
  && conf.content.emissionDiscipline.adv5.includes('restaff-namespaced')
  && conf.content.emissionDiscipline.writeAuthorityExercised.includes('artifact-create'),
  'emission discipline: idempotency, namespacing, write authority recorded');

/* ------------------------------------------------------------------ */
/* C9: governing anchor - resolution-scanned unresolvable.              */
/* ------------------------------------------------------------------ */

const resolutionScan = { filesScanned: 0, contentBlocksHashed: 0, resolutions: 0, textualMentions: 0 };
const walkRes = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    let isDir;
    try { isDir = statSync(p).isDirectory(); } catch { continue; }
    if (isDir) { walkRes(p); continue; }
    if (!e.endsWith('.json') && !e.endsWith('.mjs') && !e.endsWith('.md')) continue;
    resolutionScan.filesScanned += 1;
    const bytes = readFileSync(p);
    if (bytes.toString('utf8').includes(GOVERNING)) resolutionScan.textualMentions += 1;
    if (!e.endsWith('.json')) continue;
    try {
      const j = JSON.parse(bytes.toString('utf8'));
      const blocks = [];
      if (j && typeof j === 'object' && j.content !== undefined) blocks.push(j.content);
      if (Array.isArray(j)) for (const x of j) if (x && typeof x === 'object' && x.content !== undefined) blocks.push(x.content);
      for (const b of blocks) {
        resolutionScan.contentBlocksHashed += 1;
        if (sha(b) === GOVERNING) resolutionScan.resolutions += 1;
      }
    } catch { /* unparseable layers counted by the movement pass */ }
  }
};
walkRes(QUAL);
walkRes(FB);
const publishedRes = conf.content.verification.governingAnchorResolutionScan;
check('C9.unresolvable', resolutionScan.resolutions === 0 && resolutionScan.contentBlocksHashed > 100 && resolutionScan.textualMentions > 0,
  `${resolutionScan.filesScanned} files scanned: ${resolutionScan.contentBlocksHashed} content blocks hashed, 0 resolve to the anchor; ${resolutionScan.textualMentions} textual provenance mentions`);
check('C9.publishedScan', publishedRes.resolutions === 0
  && publishedRes.contentBlocksHashed === undefined && publishedRes.textualMentions === undefined,
  `published resolution-scan block: zero resolutions, no tree-size counters (receipt: ${resolutionScan.contentBlocksHashed} content blocks hashed, ${resolutionScan.textualMentions} textual mentions)`);
check('C9.provenanceOnly', conf.content.governingContractRef === shaRef(GOVERNING)
  && conf.content.governingContractNote.includes('NOT ratified') && conf.content.governingContractNote.includes('0 content blocks'),
  'governing anchor carried as unratified envelope provenance only');

/* ------------------------------------------------------------------ */
/* C10: determinism + namespacing of this emission.                     */
/* ------------------------------------------------------------------ */

for (const f of ['freeze-what-baseline-desk-restaff-build.mjs', 'freeze-what-baseline-desk-restaff-verify.mjs']) {
  const s = readFileSync(join(DIR, f), 'utf8');
  check(`C10.${f}`, !/Date\.now|new Date\(|Math\.random/.test(s), 'no clock reads, no randomness in emission source');
}
const EMISSION_FILES = new Set([
  'freeze-what-baseline-desk-restaff-build.mjs',
  'freeze-what-baseline-desk-restaff-verify.mjs',
  'freeze-what-baseline-desk-restaff-confirmation.json',
  'freeze-what-baseline-desk-restaff-trace.json',
  'freeze-what-baseline-desk-restaff-verify-out.json',
  'freeze-what-baseline-desk-restaff-submission-summary.md',
]);
const r3Files = readdirSync(DIR);
const stray = r3Files.filter((f) => f.startsWith('freeze-what-baseline-desk-restaff') && !EMISSION_FILES.has(f));
check('C10.namespacing', stray.length === 0, `this emission wrote only the 6 restaff-namespaced files (no strays: ${JSON.stringify(stray)})`);
check('C10.terminalClaims', ENVELOPE['terminal:audited-1'] === '4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f'
  && ENVELOPE['terminal:delivered-1'] === '8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988'
  && conf.content.deskOutcome.terminalClaims.includes('never re-minted'),
  'terminal lifecycle claims remain envelope content addresses, never re-minted');

/* ------------------------------------------------------------------ */
/* Emit                                                                 */
/* ------------------------------------------------------------------ */

const passCount = checks.filter((c) => c.pass).length;
const out = {
  verifyOutKind: 'author-restaff-confirmation-verify',
  semanticCode: 'AS-Freeze-What-Baseline-001',
  confirmationRef: conf.confirmationRef,
  traceRef: trc.traceRef,
  createdAt: CREATED_AT,
  declaredDigestsTrusted: false,
  checks,
  summary: {
    total: checks.length,
    pass: passCount,
    fail: checks.length - passCount,
    allPass: passCount === checks.length,
    movementScanFiles: movement.filesScanned,
    movementVerdictRecords: movement.verdictRecords,
    governingAnchorResolutions: resolutionScan.resolutions,
  },
  workspaceSummary: WS,
};
const sortOut = sortKeys(out);
const outWithDigest = {
  ...sortOut,
  verifyOutDigest: shaRaw(Buffer.from(JSON.stringify(sortOut), 'utf8')),
};
writeFileSync(join(DIR, 'freeze-what-baseline-desk-restaff-verify-out.json'), `${JSON.stringify(outWithDigest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ verifyOut: 'freeze-what-baseline-desk-restaff-verify-out.json', ...outWithDigest.summary }, null, 2));
if (outWithDigest.summary.fail > 0) process.exitCode = 1;
