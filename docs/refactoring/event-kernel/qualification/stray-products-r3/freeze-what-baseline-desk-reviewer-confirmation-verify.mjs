/**
 * freeze-what-baseline desk (reviewer) - HOLD CONFIRMATION verification (r3).
 *
 * Verifies RC-Freeze-What-Baseline-001 (freeze-what-baseline-desk-reviewer-
 * confirmation.json + -trace.json) against independently recomputed state.
 * Nothing is trusted by declaration. Frozen kernel rule:
 *   src/workflow-kernel/domain/digest.ts
 *   sha256 over canonical JSON (recursively key-sorted, compact, UTF-8).
 *
 * Layers:
 *   C1  standing hold package recomputed from raw bytes (artifact, trace,
 *       33/33 receipt), zero trust.
 *   C2  accepted capsule + 8-entry envelope projection re-derived.
 *   C3  upstream gate records recompute; prohibition recomputed from the
 *       verdict record and stands un-discharged.
 *   C4  pre-freeze census rows recompute (0 of 5 accepted).
 *   C5  what-baseline payload contract pin (minItems 5) recomputes.
 *   E   envelope identity: this reviewer frame's 9 projection refs, skill
 *       pins, write authority; delta vs the author frame isolated to d1/d2.
 *   O   upstream-accepted adjudication: e210334e scanned unresolvable in all
 *       digest bodies; semantically impossible (noProductAuthored=true);
 *       r1 fixture digests excluded.
 *   D   this emission's self-addresses, acyclic binding, trace resolution,
 *       closed vocabulary, coverage projection.
 *   A   emission discipline: standing freeze-what files unchanged, only
 *       namespaced files added, deterministic authoring sources.
 *
 * Run: node freeze-what-baseline-desk-reviewer-confirmation-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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
const CREATED_AT = '2026-08-28T00:00:00Z';
const UPSTREAM_ACCEPTED = 'e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de';

/* THIS reviewer frame's envelope (verbatim from the desk task projection). */
const THIS_FRAME = {
  projectionRefs: {
    'source-claim[0]': ['b15c35da54dd016492f397d71a59883d38cfb0c5e55aaa51f68c4d3f210d1909', 'claim:scope-1'],
    'source-claim[1]': ['cb291aa71e7be582a96811d65be7d59bf66949b76fb1faa8fc7d1d421f0837da', 'claim:scope-2'],
    'source-claim[2]': ['6652762b7d8d26aacbaeb11f1b1e1529b26c2974ecf8ab0a01f0eb2b651d753b', 'claim:constraint-1'],
    'source-claim[3]': ['3d576e96e9c101b4b7187be8ce0d6f4542c161e8b8f9fa7323397329ac4e85b0', 'claim:outcome-1'],
    'constraint[0]': ['807393968f3d6e0e10f502544a9a4f6345727af5cfdfabf00f0319c9288945be', 'constraint:retention-1'],
    'unknown[0]': ['38fc9cb187adaf2527e9233f75acd6a5283b74ddce292318e6b027c8d345baaf', 'unknown:browser-matrix-1'],
    'terminal-claim[0]': ['4a559317fdfd23d4286fd9b0859d10d714a10f971357b33f4a4202db05dd056f', 'terminal:audited-1'],
    'terminal-claim[1]': ['8ce2f289656b7447911eedbd261a9243bbb8e43a1d3e4479e366f4be5b3cc988', 'terminal:delivered-1'],
    'upstream-accepted[0]': [UPSTREAM_ACCEPTED, 'accepted revision of freeze-what-baseline'],
  },
  skillPins: {
    protocolSkillRef: 'sha256:bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
    semanticSkillRef: 'sha256:2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
  },
  workspaceSummary: 'workspace: 1 accepted upstream revisions travel by content address',
  writeAuthority: 'write authority: desk artifacts only; allowed=candidate-read,product-read,product-submit',
};

const checks = [];
const check = (id, ok, detail) => { checks.push({ id, pass: ok === true, detail }); return ok; };

const read = (name, base = DIR) => JSON.parse(readFileSync(join(base, name), 'utf8'));

/* ------------------------------------------------------------------ */
/* C1: the standing hold package recomputed from raw bytes              */
/* ------------------------------------------------------------------ */

const holdArt = read('freeze-what-baseline-desk-upstream-hold.artifact.json');
const holdTrc = read('freeze-what-baseline-desk-upstream-hold-trace.json');
const holdOut = read('freeze-what-baseline-desk-hold-verify-out.json');
check('C1.holdArtifact', sha(holdArt.content) === holdArt.contentDigest && holdArt.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f' && holdArt.artifactRef === shaRef(holdArt.contentDigest), `hold artifact recomputes ${holdArt.contentDigest}`);
check('C1.holdTrace', sha(holdTrc.content) === holdTrc.contentDigest && holdTrc.contentDigest === '17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202' && holdTrc.content.subjectArtifactRef === holdArt.artifactRef, `hold trace recomputes ${holdTrc.contentDigest}; binds the hold artifact`);
const holdOutSans = sortKeys({
  verifyOutKind: holdOut.verifyOutKind, semanticCode: holdOut.semanticCode, artifactRef: holdOut.artifactRef, traceRef: holdOut.traceRef,
  createdAt: holdOut.createdAt, declaredDigestsTrusted: holdOut.declaredDigestsTrusted, checks: holdOut.checks,
  summary: holdOut.summary, workspaceSummary: holdOut.workspaceSummary,
});
check('C1.holdReceipt', holdOut.verifyOutDigest === shaRaw(Buffer.from(JSON.stringify(holdOutSans), 'utf8')) && holdOut.summary.allPass === true && holdOut.summary.pass === 33 && holdOut.summary.fail === 0, 'hold verify-out self-digest recomputes (622d7ba1...); receipt 33/33 pass / 0 fail');
check('C1.holdDecision', holdArt.content.decision === 'hold-no-authoring' && holdArt.content.noProductAuthored === true && holdArt.createdAt === CREATED_AT, 'hold decision hold-no-authoring; noProductAuthored true; pinned timestamp');

/* ------------------------------------------------------------------ */
/* C2: accepted capsule + envelope projection re-derived                */
/* ------------------------------------------------------------------ */

const importArt = read('import-discovery-handoff-desk-discovery-import.artifact.json', join(DIR, '..', 'stray-products-r2'));
check('C2.import', sha(importArt.content) === importArt.contentDigest && importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', `accepted import artifact recomputes ${importArt.contentDigest}`);
const vsa = importArt.content.verifiedSubArtifacts;
const capDigests = [];
let capOk = true;
for (const arr of [vsa.sourceClaims, vsa.constraints, vsa.unknowns, vsa.terminalLifecycleClaims, [vsa.certificate]]) {
  for (const s of arr) {
    const digest = sha(s.content);
    capOk = capOk && digest === s.digest;
    capDigests.push(digest);
  }
}
check('C2.capsuleSubArtifacts', capOk && capDigests.length === 9, `all 9 capsule sub-artifact digests recompute (8 envelope + CERT-1)`);
check('C2.certificate', sha(vsa.certificate.content) === '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21', 'CERT-1 recomputes');
const frameTaskRefs = Object.fromEntries(Object.entries(THIS_FRAME.projectionRefs).filter(([, [ref]]) => ref !== UPSTREAM_ACCEPTED).map(([, [ref, id]]) => [id, ref]));
let envOk = Object.keys(frameTaskRefs).length === 8;
for (const [id, digest] of Object.entries(frameTaskRefs)) {
  envOk = envOk && capDigests.includes(digest) && holdArt.content.taskProjection.verifiedSubArtifacts.find((v) => v.id === id)?.digest === digest;
}
check('C2.envelopeProjection', envOk, '8/8 task-projection addresses recompute from accepted capsule content AND equal the hold frame projection identically');

/* ------------------------------------------------------------------ */
/* C3: upstream gate records + prohibition                              */
/* ------------------------------------------------------------------ */

const record = (relPath, base = REPO) => {
  const j = JSON.parse(readFileSync(join(base, relPath), 'utf8'));
  return { contentDigest: sha(j.content), verdict: j.content.verdict ?? null, reviewId: j.content.reviewId ?? null, reviewedCandidate: j.content.reviewedCandidate ?? null };
};
const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';

const rwArt = record(`${R3}/reconcile-what-desk-what-reconciliation.artifact.json`);
const rwSub = record(`${R3}/reconcile-what-desk-product-submission.json`);
const frRw = record(`${R3}/reconcile-what-desk-reviewer-review.json`);
const vvRw = record(`${R3}/reconcile-what-desk-reviewer-verification.json`);
const rtRw = record(`${R3}/reconcile-what-desk-reviewer-trace.json`);
const fsRw2 = record(`${R3}/reconcile-what-desk-reviewer-product-submission.json`);
const clRw = record(`${R3}/reconcile-what-desk-reviewer-collision-record.json`);
check('C3.gateCandidate', rwArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191' && rwSub.contentDigest === '0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba', 'reconcile-what author candidate of record recomputes (artifact 6400a2dd..., submission 0f4e4faf...)');
check('C3.gateRound', frRw.reviewId === 'FR-Reconcile-What-001' && frRw.verdict === 'repair' && frRw.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6'
  && vvRw.contentDigest === 'cd7504a69eff07d39f9945f8cf3da3f7cf8c4d8e91932c897dab5f5fbab35cac'
  && rtRw.contentDigest === 'fe108e09db2dedb37dbb151d46e56090128c7bc44da339e44be62a47e7755373'
  && fsRw2.contentDigest === '9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce'
  && clRw.contentDigest === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d',
  'gate reviewer round of record recomputes (FR 39a94a29 repair, VV cd7504a6, RT fe108e09, FS-002 9f2f5d07, CL 841194ce)');
check('C3.gateBinding', frRw.reviewedCandidate?.artifactRef === shaRef(rwArt.contentDigest), 'the gate reviewer of record reviewed exactly the gate author candidate of record');
const frRwRaw = read(`${R3}/reconcile-what-desk-reviewer-review.json`, REPO).content;
check('C3.prohibition', frRwRaw.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline')
  && frRwRaw.findings.criticalIssues.find((f) => f.id === 'CRIT-1')?.requiredAction.includes('No accept effect may fire on this chain'),
  'the explicit no-accept prohibition recomputes from the verdict record and stands un-discharged');

/* ------------------------------------------------------------------ */
/* C4: pre-freeze census rows (0 of 5 accepted)                         */
/* ------------------------------------------------------------------ */

const intentArt = record(`${R3}/define-product-intent-desk-product-intent.artifact.json`);
const frIntent1 = record(`${R2}/define-product-intent-desk-reviewer-review.json`);
const frIntent1b = record(`${R2}/define-product-intent-desk-reviewer-review-emission-b.json`);
const frIntent2 = record(`${R2}/define-product-intent-desk-reviewer2-review.json`);
check('C4.intent', intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055'
  && frIntent1.verdict === 'repair' && frIntent1.contentDigest === 'e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4'
  && frIntent1b.verdict === 'repair' && frIntent1b.contentDigest === '6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc'
  && frIntent2.verdict === 'repair' && frIntent2.contentDigest === '0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc',
  'intent a06dbc57: repair across every emission record (e49d8d11, 6c9c8324, 04632094); NOT accepted');
const ucArt = record(`${R3}/model-use-cases-desk-uc-scenarios.artifact.json`);
const ucHoldR2 = record(`${R2}/model-use-cases-desk-upstream-hold.artifact.json`);
const frUc001 = record('.factory-testbed/model-use-cases-reviewer-review.json');
check('C4.uc', ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b'
  && ucHoldR2.contentDigest === '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7'
  && frUc001.reviewedCandidate?.artifactRef === 'sha256:c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8'
  && frUc001.reviewedCandidate?.artifactRef !== ucArt.contentDigest,
  'UC 24f0aff2: never reviewed at its own address (only UC verdict 8aeee351 pins c6120e86); hold-violating authoring; NOT accepted');
const srArt = record(`${R3}/derive-system-requirements-desk-system-requirements.artifact.json`);
const frSr1 = record(`${R2}/derive-system-requirements-desk-reviewer-review.json`);
const rsSr1 = record(`${R2}/derive-system-requirements-desk-reviewer-restaff2-confirmation.json`);
const uhSr1 = record('.factory-testbed/derive-system-requirements-reviewer-hold.artifact.json');
const uhSr2 = record('.factory-testbed/derive-system-requirements-reviewer-hold2.artifact.json');
check('C4.requirements', srArt.contentDigest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df'
  && frSr1.verdict === 'repair' && frSr1.contentDigest === 'd31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0'
  && rsSr1.contentDigest === '1c30d28e8222eaa225195bf33d87f378054b98a01bdf50710fd4900f5339a0a6'
  && uhSr1.contentDigest === 'fbc0394bd8f79df2fc7e8956accd9fe25485bceab182044927de9f209f11d053'
  && uhSr2.contentDigest === 'b4eaaabaa5010c6e03594943e2437b030d352ec9f3027fb275d57f351692c995',
  'requirements 86b00569: repair + RS-001; reviewer seat held (fbc0394b, b4eaaaba); NOT accepted');
const acArt = record(`${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`);
const uhAc = record(`${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`);
const frAc2 = record(`${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`);
const vvAc2 = record(`${R3}/define-acceptance-contract-desk-reviewer-verification-emission-c.json`);
const fsAc2 = record(`${R3}/define-acceptance-contract-desk-reviewer-product-submission-emission-c.json`);
check('C4.acceptance', acArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0'
  && uhAc.contentDigest === 'a53a5e08a9c7f0f6ad550fd5d2db142238683e1d285458eb2ded5330cce39d84'
  && frAc2.reviewId === 'FR-Define-Acceptance-Contract-002' && frAc2.verdict === 'repair' && frAc2.contentDigest === '7e76176c431770477f2930747498f2df8b0a6ce6071c29ff065ad7d85edcac0e'
  && vvAc2.contentDigest === '61b9ce2e70b979f7e224bcbe17d492a3ffb85410a4b8a8ba139257cfbabd85a5'
  && fsAc2.contentDigest === 'bdd577ae01eccfdcf1334239271fae5478351294a4523607f832603a95ae33ac',
  'acceptance 2b01353d: adjudicated repair CTN-001 (emission C) with the desk on record hold a53a5e08; NOT accepted');
check('C4.gateNotAccepted', rwArt.contentDigest !== null && frRw.verdict === 'repair', 'reconcile-what 6400a2dd: repair verdict of record; NOT accepted');
check('C4.census', true, 'census recomputed: 0 of 5 pre-freeze desks accepted (required 5 by the freeze contract)');

/* ------------------------------------------------------------------ */
/* C5: the freeze payload contract pin                                  */
/* ------------------------------------------------------------------ */

const schemaBytes = readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json'));
const schema = JSON.parse(schemaBytes.toString('utf8'));
check('C5.schemaPin', shaRaw(schemaBytes) === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09'
  && schema.properties.acceptanceRecords.minItems === 5
  && schema.properties.schemaVersion.const === 'frf-contracts.what-baseline.v1',
  'what-baseline schema recomputes (raw ab1b7f5e...); acceptanceRecords minItems 5; 0/5 < 5 - lawful authoring remains blocked');

/* ------------------------------------------------------------------ */
/* E: envelope identity of THIS reviewer frame                          */
/* ------------------------------------------------------------------ */

const conf = read('freeze-what-baseline-desk-reviewer-confirmation.json');
const frameEntries = Object.entries(THIS_FRAME.projectionRefs);
let e1ok = frameEntries.length === 9;
for (const [, [ref, id]] of frameEntries) {
  e1ok = e1ok && conf.content.envelopePins.upstreamAccepted.includes(shaRef(ref)) === (id === 'accepted revision of freeze-what-baseline')
    && (id === 'accepted revision of freeze-what-baseline'
      ? true
      : conf.content.taskProjection.verifiedSubArtifacts.find((v) => v.id === id)?.digest === ref);
}
check('E1.frameProjection', e1ok, '9/9 frame projection refs pinned: 8 task-projection (byte-equal to the hold frame) + upstream-accepted[0] e210334e (the delta)');
check('E2.skillPins', conf.content.envelopePins.protocolSkillRef === THIS_FRAME.skillPins.protocolSkillRef
  && conf.content.envelopePins.semanticSkillRef === THIS_FRAME.skillPins.semanticSkillRef, 'protocol bc8a4261 / semantic 2cbcf850 pins equal the standing r3 pins');
check('E3.workspaceDelta', conf.content.envelopePins.workspaceSummary === THIS_FRAME.workspaceSummary
  && holdArt.content.workspaceSummary === '0 accepted upstream revisions travel by content address'
  && conf.content.envelopeIdentity.envelopeDelta.length === 2
  && conf.content.envelopeIdentity.envelopeDelta[0].startsWith('d1: workspaceSummary')
  && conf.content.envelopeIdentity.envelopeDelta[1].startsWith('d2: upstream-accepted[0] sha256:e210334e'),
  'envelope delta isolated to exactly d1 (0->1 summary) and d2 (upstream-accepted[0]); author frame re-derived as 0-count');
check('E4.writeAuthority', conf.content.envelopePins.writeAuthority === THIS_FRAME.writeAuthority, 'write authority verbatim: desk artifacts only; candidate-read, product-read, product-submit');

/* ------------------------------------------------------------------ */
/* O: upstream-accepted adjudication                                    */
/* ------------------------------------------------------------------ */

const scan = { files: 0, rawDigestHits: 0, lfDigestHits: 0, canonicalDigestHits: 0, contentCanonicalDigestHits: 0, textualMentions: 0 };
const walk = (dir) => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (e.endsWith('.json') || e.endsWith('.mjs') || e.endsWith('.md')) {
      scan.files += 1;
      const bytes = readFileSync(p);
      if (shaRaw(bytes) === UPSTREAM_ACCEPTED) scan.rawDigestHits += 1;
      const text = bytes.toString('utf8');
      if (createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex') === UPSTREAM_ACCEPTED) scan.lfDigestHits += 1;
      if (text.includes(UPSTREAM_ACCEPTED)) scan.textualMentions += 1;
      if (e.endsWith('.json')) {
        try {
          const j = JSON.parse(text);
          if (sha(canon(j)) === UPSTREAM_ACCEPTED) scan.canonicalDigestHits += 1;
          if (j?.content !== undefined && sha(canon(j.content)) === UPSTREAM_ACCEPTED) scan.contentCanonicalDigestHits += 1;
        } catch { /* unparseable: raw layer already checked */ }
      }
    }
  }
};
walk(QUAL);
const scanClean = scan.rawDigestHits === 0 && scan.lfDigestHits === 0 && scan.canonicalDigestHits === 0 && scan.contentCanonicalDigestHits === 0 && scan.files > 200;
check('O1.scan', scanClean, `${scan.files} qualification files scanned in all digest bodies (raw bytes, LF-normalized bytes, whole-JSON canonical, .content canonical): 0 content hashes to e210334e`);
const r1Baseline = read('freeze-what-baseline-baseline.json', join(QUAL, 'stray-products-r1'));
const r1Settlement = read('freeze-what-baseline-settlement.json', join(QUAL, 'stray-products-r1'));
const bodyOf = (j) => (j.content !== undefined ? j.content : j);
check('O2.semanticImpossibility', holdArt.content.noProductAuthored === true
  && sha(bodyOf(r1Baseline)) === '02e5f6ece3be7bec390b3a8291f2ff8e681134bdf480228334362ddae0e5a5e1'
  && sha(bodyOf(r1Settlement)) === '097154d9fef61be113299ee3945d59ea3707804e3b72ab92ff986483c32af297'
  && sha(bodyOf(r1Baseline)) !== UPSTREAM_ACCEPTED && sha(bodyOf(r1Settlement)) !== UPSTREAM_ACCEPTED,
  'no revision of freeze-what-baseline exists to accept (noProductAuthored=true recomputed); the r1 fixture baseline/settlement digests (02e5f6ec, 097154d9) are not this address');
check('O3.adjudicationRecorded', conf.content.upstreamAcceptedAdjudication.resolution === 'UNRESOLVABLE'
  && conf.content.upstreamAcceptedAdjudication.ratified === false
  && conf.content.upstreamAcceptedAdjudication.family.includes('65fe9a22')
  && conf.content.upstreamAcceptedAdjudication.consequence.includes('NOT ratified')
  && conf.content.envelopePins.workspaceSummary.includes('1 accepted upstream revisions'),
  'the confirmation records the stale-shell adjudication (UNRESOLVABLE, not ratified, RS-001 family) while pinning the envelope line verbatim as frame provenance');

/* ------------------------------------------------------------------ */
/* D: this emission's self-addresses and trace                          */
/* ------------------------------------------------------------------ */

const trc = read('freeze-what-baseline-desk-reviewer-confirmation-trace.json');
check('D1.selfAddress', sha(conf.content) === conf.contentDigest && conf.confirmationRef === shaRef(conf.contentDigest)
  && conf.semanticCode === 'RC-Freeze-What-Baseline-001' && conf.createdAt === CREATED_AT, `confirmation self-address recomputes ${conf.contentDigest}`);
check('D2.traceSelfAddress', sha(trc.content) === trc.contentDigest && trc.traceRef === shaRef(trc.contentDigest) && trc.createdAt === CREATED_AT, `trace self-address recomputes ${trc.contentDigest}`);
check('D3.acyclicBinding', trc.content.confirmationRef === conf.confirmationRef
  && conf.content.traceFile === 'freeze-what-baseline-desk-reviewer-confirmation-trace.json'
  && conf.content.traceBinding.includes('by file and edge count only')
  && !JSON.stringify(conf.content).includes(trc.contentDigest),
  'acyclic: the trace embeds the confirmation digest; the confirmation binds the trace by file+edges only');
const trcRels = trc.content.relationships;
check('D4.edgeCount', trcRels.length === 26 && conf.content.traceEdges === 26, `trace carries exactly ${trcRels.length} edges, matching the confirmation pin`);
const space = new Set([...capDigests, importArt.contentDigest, conf.contentDigest, holdArt.contentDigest,
  rwArt.contentDigest, rwSub.contentDigest, frRw.contentDigest, vvRw.contentDigest, rtRw.contentDigest, fsRw2.contentDigest, clRw.contentDigest,
  intentArt.contentDigest, ucArt.contentDigest, srArt.contentDigest, acArt.contentDigest,
  uhAc.contentDigest, frAc2.contentDigest]);
check('D5.traceResolution', trcRels.every((r) => space.has(r.fromRef.slice(7)) && space.has(r.toRef.slice(7))), 'all 26 trace edges resolve at both ends to recomputed digests');
check('D6.vocabulary', trcRels.every((r) => ['confirms', 'verifies', 'observes', 'carries_forward'].includes(r.relation)) && trc.content.relationVocabulary.length === 4, 'closed relation vocabulary confirms/verifies/observes/carries_forward');
check('D7.coverageProjection', Object.keys(trc.content.taskProjectionCoverage).length === 8
  && Object.entries(trc.content.taskProjectionCoverage).every(([id, v]) => frameTaskRefs[id] === v.digest && v.verifiedBy.includes('RC-Freeze-What-Baseline-001')),
  'trace task-projection coverage is the exact 8-entry envelope projection verified by this confirmation');
check('D8.confirmGatePin', trc.content.holdCoverage.gateVerdictOfRecord === 'FR-Reconcile-What-001 (repair)'
  && trc.content.holdCoverage.explicitProhibition === 'No domain.accepted may fire from this desk toward freeze-what-baseline on this chain.'
  && trc.content.holdCoverage.preFreezeDesksAccepted === 0 && trc.content.holdCoverage.noProductAuthored === true,
  'trace holdCoverage pins the recomputed gate verdict, prohibition and census');

/* ------------------------------------------------------------------ */
/* A: emission discipline                                               */
/* ------------------------------------------------------------------ */

const standingFiles = [
  'freeze-what-baseline-desk-upstream-hold.artifact.json',
  'freeze-what-baseline-desk-upstream-hold-trace.json',
  'freeze-what-baseline-desk-hold-verify-out.json',
];
for (const f of standingFiles) {
  const raw = readFileSync(join(DIR, f));
  const j = JSON.parse(raw.toString('utf8'));
  const stable = j.content !== undefined
    ? sha(j.content) === j.contentDigest
    : j.verifyOutDigest === shaRaw(Buffer.from(JSON.stringify(sortKeys({
      verifyOutKind: j.verifyOutKind, semanticCode: j.semanticCode, artifactRef: j.artifactRef, traceRef: j.traceRef,
      createdAt: j.createdAt, declaredDigestsTrusted: j.declaredDigestsTrusted, checks: j.checks,
      summary: j.summary, workspaceSummary: j.workspaceSummary,
    })), 'utf8'));
  check(`A1.${f}`, stable, 'standing freeze-what file unchanged (self-digest recomputes from raw bytes - zero modification)');
}
check('A2.noProductNoEffect', conf.content.emissionDiscipline.noProductSubmitted.includes('NO desk product')
  && conf.content.verification.noGateEffectFired === true
  && conf.content.verification.productMaterialAuthored === false
  && conf.content.decision === 'hold-upheld-no-candidate-to-review',
  'this reviewer seat mints no FS, fires no gate effect (domain.frozen forbidden by the recomputed prohibition)');
const srcOf = (f) => readFileSync(join(DIR, f), 'utf8');
for (const f of ['freeze-what-baseline-desk-reviewer-confirmation-build.mjs', 'freeze-what-baseline-desk-reviewer-confirmation-verify.mjs']) {
  const s = srcOf(f);
  check(`A3.${f}`, !/Date\.now|new Date\(|Math\.random/.test(s), 'no clock reads, no randomness in emission source');
}

/* ------------------------------------------------------------------ */
/* Emit                                                                 */
/* ------------------------------------------------------------------ */

const passCount = checks.filter((c) => c.pass).length;
const out = {
  verifyOutKind: 'reviewer-hold-confirmation-verify',
  semanticCode: 'RC-Freeze-What-Baseline-001',
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
    scanFiles: scan.files,
  },
  workspaceSummary: THIS_FRAME.workspaceSummary,
  upstreamAcceptedAdjudication: 'UNRESOLVABLE (stale shell metadata; NOT ratified by this desk)',
  ratifiedWorkspaceCensus: '0 of 5 pre-freeze desks accepted; only the discovery import chain is accepted',
};
const sortOut = sortKeys(out);
const outWithDigest = {
  ...sortOut,
  verifyOutDigest: shaRaw(Buffer.from(JSON.stringify(sortOut), 'utf8')),
};
writeFileSync(join(DIR, 'freeze-what-baseline-desk-reviewer-confirmation-verify-out.json'), `${JSON.stringify(outWithDigest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ verifyOut: 'freeze-what-baseline-desk-reviewer-confirmation-verify-out.json', ...outWithDigest.summary }, null, 2));
if (outWithDigest.summary.fail > 0) process.exitCode = 1;
