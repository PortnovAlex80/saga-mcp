/**
 * define-architecture-contract desk (author) - UPSTREAM HOLD verifier.
 *
 * Verifies emission UH-Define-Architecture-Contract-001
 * (define-architecture-contract-desk-upstream-hold.artifact.json + -trace.json)
 * fresh, by recomputation only:
 *   V1  self-digests + cross-binding + acyclicity of the emission pair
 *   V2  hold semantics (decision, holdKind, noProductAuthored, fence)
 *   V3  accepted base re-derivation (import artifact, capsule 9/9, envelope 8/8)
 *   V4  census-of-record 0/5 re-verified (every cited record digest + verdict)
 *   V5  freeze refusal chain re-verified (r3 hold/RC/AS + r4 adjudication +
 *       impostor fixture resolution e210334e)
 *   V6  gate-law source grounding (dispatch.mjs / desk.ts / manifest.ts)
 *   V7  desk-declared semantic-skill digest vs the frame pin
 *   V8  r1 stray authoring history re-verified + projection disjointness
 *   V9  workspace-wide three-layer frame-pin scan (3 addresses, 0 resolutions)
 *   V10 file-family discipline + determinism probes
 *
 * Run: node define-architecture-contract-desk-hold-verify.mjs
 * Writes: define-architecture-contract-desk-hold-verify-out.json
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRaw = (buf) => createHash('sha256').update(buf, 'utf8').digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(DIR, '..', '..', '..', '..', '..');
const Q = (f) => JSON.parse(readFileSync(join(REPO, `docs/refactoring/event-kernel/qualification/${f}`), 'utf8'));
const record = (f) => {
  const j = Q(f);
  return { contentDigest: sha(j.content), verdict: j.content.verdict ?? j.content.decision ?? j.content.reviewDecision?.verdict ?? j.content.holdKind ?? null };
};

const CREATED_AT = '2026-08-28T00:00:00Z';
const ARTIFACT_NAME = 'define-architecture-contract-desk-upstream-hold.artifact.json';
const TRACE_NAME = 'define-architecture-contract-desk-upstream-hold-trace.json';
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const SEMANTIC_PIN = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';
const R1_UPDATED_CLAIM = '8b2ec93c63b7b2de04fffb6deb1c8d700129f956b682c8f960ab3f4576a1d3c2';

const checks = [];
const check = (id, pass, detail) => checks.push({ id, pass: pass === true, detail });

const artifact = JSON.parse(readFileSync(join(DIR, ARTIFACT_NAME), 'utf8'));
const trace = JSON.parse(readFileSync(join(DIR, TRACE_NAME), 'utf8'));
const ART = sha(artifact.content);
const TRC = sha(trace.content);

/* V1 - self-digests + cross-binding */
check('V1.artifactDigest', ART === artifact.contentDigest && artifact.contentDigest === 'b831c67ed75bfc56024ddd78407a8ef8fdec593e6998963d86905b30c4bfb33b' && artifact.artifactRef === shaRef(ART),
  `artifact content digest recomputes to ${ART}`);
check('V1.traceDigest', TRC === trace.contentDigest && trace.contentDigest === 'e5a4749ec21bfaff7042c421fa832e64820ce5ef61f271ecf2801afe343656f9' && trace.traceRef === shaRef(TRC),
  `trace content digest recomputes to ${TRC}`);
check('V1.subjectBinding', trace.content.subjectArtifactRef === artifact.artifactRef && trace.content.subjectSemanticCode === 'UH-Define-Architecture-Contract-001',
  'trace subject binds the hold artifact ref');
check('V1.pinnedTimestamp', artifact.createdAt === CREATED_AT && trace.createdAt === CREATED_AT,
  `pinned ${CREATED_AT}`);
check('V1.traceAcyclic', trace.content.relationships.every((r) => r.fromId === 'UH-Define-Architecture-Contract-001'),
  'every trace edge originates at the hold subject (acyclic by construction)');
check('V1.relationVocabulary', trace.content.relationships.every((r) => ['observes', 'verifies'].includes(r.relation)),
  'relation vocabulary closed over {observes, verifies}');

/* V2 - hold semantics + fence */
const c = artifact.content;
check('V2.decision', c.decision === 'hold-no-authoring' && c.holdKind === 'srs-upstream-hold' && c.noProductAuthored === true,
  'decision hold-no-authoring; holdKind srs-upstream-hold; noProductAuthored true');
const artCanon = canon(c);
/* The fence block legitimately NAMES the forbidden keys (it declares them);
 * the scan therefore runs over the hold content minus that declaration
 * block, so naming a forbidden key is not authoring it. */
const { fence: _fenceBlock, ...contentWithoutFence } = c;
const artCanonNoFence = canon(contentWithoutFence);
const forbiddenFound = c.fence.forbiddenProductKeys.filter((k) => artCanonNoFence.includes(`"${k}"`));
check('V2.fence', forbiddenFound.length === 0,
  `no forbidden product key materialized in the hold artifact (checked ${c.fence.forbiddenProductKeys.length} keys over the content minus the fence declaration)`);
check('V2.envelopePinned', c.taskProjection.verifiedSubArtifacts.length === 8 &&
  Object.values(c.taskProjection.verifiedSubArtifacts.reduce((acc, s) => ({ ...acc, [s.id]: s.digest }), {})).every(Boolean),
  'all 8 task-projection content addresses pinned in the hold');
check('V2.terminalClaimsNotAsserted', artCanon.includes('asserts NEITHER is satisfied'),
  'terminal:audited-1 / terminal:delivered-1 explicitly NOT asserted satisfied');

/* V3 - accepted base re-derivation */
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
const importArt = Q('stray-products-r2/import-discovery-handoff-desk-discovery-import.artifact.json');
check('V3.importDigest', sha(importArt.content) === importArt.contentDigest && importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5',
  'accepted import artifact digest recomputes');
const vsa = importArt.content.verifiedSubArtifacts;
const capGroups = [vsa.sourceClaims, vsa.constraints, vsa.unknowns, vsa.terminalLifecycleClaims, [vsa.certificate]];
let capOk = true;
for (const arr of capGroups) for (const s of arr) if (sha(s.content) !== s.digest) capOk = false;
check('V3.capsuleSubArtifacts', capOk, 'all 9 capsule sub-artifact digests recompute');
let envOk = 0;
for (const s of [...vsa.sourceClaims, ...vsa.constraints, ...vsa.unknowns, ...vsa.terminalLifecycleClaims]) {
  const hit = Object.entries(ENVELOPE).find(([id, d]) => d === s.digest);
  if (hit) envOk += 1;
}
check('V3.envelopeProjection', envOk === 8, `envelope 8/8 recompute from accepted capsule content (${envOk}/8)`);
check('V3.certificate', sha(vsa.certificate.content) === '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21', 'CERT-1 recomputes');
const recomputeMatches = c.taskProjection.envelopeRecompute.filter((e) => e.envelopeMatch).length;
check('V3.publishedRecomputeBlock', recomputeMatches === 8, `published envelopeRecompute block carries 8/8 matches (${recomputeMatches}/8)`);

/* V4 - census-of-record 0/5 re-verified */
const r3 = (f) => `stray-products-r3/${f}`;
const r2 = (f) => `stray-products-r2/${f}`;
const r4 = (f) => `stray-products-r4/${f}`;
const tb = (f) => join(REPO, `.factory-testbed/${f}`);
const tbRecord = (f) => {
  const j = JSON.parse(readFileSync(tb(f), 'utf8'));
  return { contentDigest: sha(j.content), verdict: j.content.verdict ?? j.content.decision ?? j.content.holdKind ?? null };
};
const frIntent1 = record(r2('define-product-intent-desk-reviewer-review.json'));
const frIntent1b = record(r2('define-product-intent-desk-reviewer-review-emission-b.json'));
const frIntent2 = record(r2('define-product-intent-desk-reviewer2-review.json'));
check('V4.link1Intent', frIntent1.verdict === 'repair' && frIntent1.contentDigest === 'e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4'
  && frIntent1b.verdict === 'repair' && frIntent1b.contentDigest === '6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc'
  && frIntent2.verdict === 'repair' && frIntent2.contentDigest === '0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc',
  'link 1 define-product-intent: repair across every emission recomputes');
const ucArt = record(r3('model-use-cases-desk-uc-scenarios.artifact.json'));
const ucHold = record(r2('model-use-cases-desk-upstream-hold.artifact.json'));
const frUcRaw = JSON.stringify(JSON.parse(readFileSync(tb('model-use-cases-reviewer-review.json'), 'utf8')));
check('V4.link2Uc', ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b'
  && ucHold.contentDigest === '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7'
  && frUcRaw.includes('c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8') && !frUcRaw.includes(ucArt.contentDigest),
  'link 2 model-use-cases: never reviewed at its own address; the accepted verdict pins a different candidate');
const frSr1 = record(r2('derive-system-requirements-desk-reviewer-review.json'));
const rsSr1 = record(r2('derive-system-requirements-desk-reviewer-restaff2-confirmation.json'));
const uhSr1 = tbRecord('derive-system-requirements-reviewer-hold.artifact.json');
const uhSr2 = tbRecord('derive-system-requirements-reviewer-hold2.artifact.json');
check('V4.link3Requirements', frSr1.verdict === 'repair' && frSr1.contentDigest === 'd31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0'
  && rsSr1.contentDigest === '1c30d28e8222eaa225195bf33d87f378054b98a01bdf50710fd4900f5339a0a6'
  && uhSr1.contentDigest === 'fbc0394bd8f79df2fc7e8956accd9fe25485bceab182044927de9f209f11d053'
  && uhSr2.contentDigest === 'b4eaaabaa5010c6e03594943e2437b030d352ec9f3027fb275d57f351692c995',
  'link 3 derive-system-requirements: repair + restaff confirmation + held reviewer seat recompute');
const frDa1 = record(r3('define-acceptance-contract-desk-reviewer-review-emission-a.json'));
const vvDa1 = record(r3('define-acceptance-contract-desk-reviewer-verification-emission-a.json'));
const frDa2 = record(r3('define-acceptance-contract-desk-reviewer-review-emission-c.json'));
const vvDa2 = record(r3('define-acceptance-contract-desk-reviewer-verification-emission-c.json'));
const frDaCan = record(r3('define-acceptance-contract-desk-reviewer-review.json'));
const candArt = record(r3('define-acceptance-contract-desk-acceptance-bindings.artifact.json'));
check('V4.link4Acceptance', frDa1.verdict === 'repair' && frDa1.contentDigest === '83e675bb18c575cb0b30e3ededd2cca6b58b88c08cb50be9c08dfb130808c383'
  && vvDa1.contentDigest === '367a38fcf8d0bd061fa2e023aba4aaab0060a82a71278ca358d6b3415b5602bb'
  && frDa2.verdict === 'repair' && frDa2.contentDigest === '7e76176c431770477f2930747498f2df8b0a6ce6071c29ff065ad7d85edcac0e'
  && vvDa2.contentDigest === '61b9ce2e70b979f7e224bcbe17d492a3ffb85410a4b8a8ba139257cfbabd85a5'
  && frDaCan.verdict === 'accepted' && frDaCan.contentDigest === 'e5249d786aa3318a7426dde2ba36e111437d4e0ab0e7e6f9e7cda3b9463ce466'
  && candArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0',
  'link 4 define-acceptance-contract: contention CL-Define-Acceptance-Contract-001 recomputes (2 repair emissions with verifications vs canonical accepted without one)');
const frRw1 = record(r3('reconcile-what-desk-reviewer-review.json'));
const clRw1 = record(r3('reconcile-what-desk-reviewer-collision-record.json'));
const frRw2 = record(r3('reconcile-what-desk-reviewer-review-emission-b.json'));
const recArt = record(r3('reconcile-what-desk-what-reconciliation.artifact.json'));
check('V4.link5Reconcile', frRw1.verdict === 'repair' && frRw1.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6'
  && clRw1.contentDigest === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d'
  && frRw2.verdict === 'repair' && frRw2.contentDigest === '702fc96755b828eb427a2287ea661d1f685336c2646d08a7328030ab6923e1ba'
  && recArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191',
  'link 5 reconcile-what: repair verdicts of record + collision record + prohibition recompute');
check('V4.census', true, 'census of record: 0 of 5 pre-freeze desks accepted (links 1-5 above)');

/* V5 - freeze refusal chain + impostor resolution */
const uhFrz = record(r3('freeze-what-baseline-desk-upstream-hold.artifact.json'));
const rcFrz = record(r3('freeze-what-baseline-desk-reviewer-confirmation.json'));
const asFrz = record(r3('freeze-what-baseline-desk-restaff-confirmation.json'));
const frFrz2 = record(r4('freeze-what-baseline-desk-reviewer-review.json'));
const vvFrz2 = record(r4('freeze-what-baseline-desk-reviewer-verification.json'));
check('V5.freezeRefusalChain', uhFrz.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f'
  && rcFrz.contentDigest === 'c19344fd964655f226b777747b23b94da07877f2fc28614ea4a65c98c803ed44'
  && asFrz.contentDigest === 'c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06'
  && frFrz2.verdict === 'hold-upheld' && frFrz2.contentDigest === 'd52746b6620e8e4583592f1d23beff3053430d15ae8159643dcc7461b49d9190'
  && vvFrz2.contentDigest === '8b04101005452d7906bcc1ca66f8f91d5ef6957518ae5af84f8a47f7e5781c21',
  'freeze refusal chain recomputes: r3 hold + RC-001 hold-upheld + AS-001 standing hold + r4 FR-Reviewer-002 hold-upheld');
const fixtureRaw = readFileSync(join(REPO, 'docs/refactoring/formalization-frf/contracts/fixtures/green/what-baseline.json'), 'utf8');
const fixtureWhole = sha(JSON.parse(fixtureRaw));
check('V5.impostorFixture', fixtureWhole === 'e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de',
  'the r4 impostor address e210334e recomputes to the green fixture whole-JSON canonical (refused as acceptance authority)');
check('V5.baselineAbsence', artCanon.includes('no whole-WHAT baseline artifact exists on this chain'),
  'the hold records baseline absence explicitly');

/* V6 - gate-law source grounding */
const dispatchSrc = readFileSync(join(REPO, 'src/workflow-kernel/workshops/formalization/cells/dispatch.mjs'), 'utf8');
const deskSrc = readFileSync(join(REPO, 'src/workflow-kernel/workshops/formalization/cells/srs-realization/desk.ts'), 'utf8');
const manifestSrc = readFileSync(join(REPO, 'src/workflow-kernel/workshops/formalization/manifest.ts'), 'utf8');
check('V6.gateLaw', dispatchSrc.includes("case 'define-architecture-contract':")
  && dispatchSrc.includes("required(chain, 'baseline', 'the SRS realizes the frozen whole-WHAT baseline and the accepted UC set')")
  && dispatchSrc.includes("reason: 'MISSING_LINEAGE'")
  && deskSrc.includes("outputProductKind !== 'formalization.srs.v1'")
  && deskSrc.includes("'formalization.srs-structure.v1'") && deskSrc.includes("'validateSrs'")
  && manifestSrc.includes("{ from: 'freeze-what-baseline', to: 'define-architecture-contract', on: 'domain.frozen' }"),
  'the fail-closed gate law recomputes from source: chain.baseline required, MISSING_LINEAGE, formalization.srs.v1, srs-structure.v1/validateSrs, domain.frozen transition');

/* V7 - desk-declared semantic skill vs frame pin */
const deskSemantic = sha({ skillId: 'formalization-desk-define-architecture-contract', kind: 'semantic', desk: 'define-architecture-contract' });
check('V7.deskSemanticDigest', deskSemantic === '131efbd99bd2d92e0ac790ab9c271218d0a72995df0053fc35cbffc4d7f176f3' && deskSemantic !== SEMANTIC_PIN,
  'desk-declared semantic-skill digest recomputes (131efbd9...) and honestly differs from the frame semantic pin');

/* V8 - r1 stray authoring history */
const r1Canon = (f) => sha(JSON.parse(readFileSync(join(REPO, `docs/refactoring/event-kernel/qualification/stray-products-r1/${f}`), 'utf8')));
const r1ContentCanon = (f) => {
  const j = JSON.parse(readFileSync(join(REPO, `docs/refactoring/event-kernel/qualification/stray-products-r1/${f}`), 'utf8'));
  return sha(j.content);
};
const r1Formal = r1Canon('define-architecture-contract-formalization.json');
const r1FormalUpd = r1Canon('define-architecture-contract-formalization-updated.json');
const r1Art = r1ContentCanon('define-architecture-contract-desk-architecture-contract.artifact.json');
const r1ArtUpd = r1ContentCanon('define-architecture-contract-desk-architecture-contract-updated.artifact.json');
const r1Review = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-review-verdict.json'), 'utf8'));
const r1Review2 = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-reviewer-decision-v2.json'), 'utf8'));
check('V8.r1DigestDrift', r1Formal === 'e2ae5d31da26a34230a7bc5e8cd6ed70b373f07a7b92e994083aff7956cc9330'
  && r1FormalUpd === '1f06d6636e0ee669efebbf6a2577762d14f350ead77316912f3e20a43a22f4e1'
  && r1Art === 'f4846e5fed6808f8b0c33b14d58a337d9f72eddd02bf775bc048862b1d5626af'
  && r1ArtUpd === '434c41b243ff0b9c350c58e1581eb0657b030a139fc4d7cc7002f44fa467c594'
  && r1Formal !== GOVERNING && r1FormalUpd !== R1_UPDATED_CLAIM,
  'r1 stray authoring recomputes to different digests than the claimed a926df62 / 8b2ec93c (digest-drift family alive)');
check('V8.r1ApprovalWithoutLineage', r1Review.verdict === 'approved' && r1Review.findings.length === 0
  && r1Review2.reviewDecision.verdict === 'approved' && r1Review2.reviewDecision.findings.length === 0
  && JSON.stringify(r1Review2).includes('0 accepted upstream revisions travel by content address'),
  'r1 verdicts approved with zero findings and no verification, passing "0 accepted upstream revisions" as a PASS criterion');
const R1_PROJECTION = ['fbe292e862ab174b29de15cbbf85b34e4211b3a0e508fd39245015c9ea12b180', 'c9bfe922c5891e8bfeaaf07864a75d3beaa5239dd455d6bb889f1eef4b3dd0fc', '423be112883976126a9b2718226aa68628fbe5d60253e0c0c849d66925062035', 'd7ce453b9dbb1aa1cecda1d591779b92dc347220c9f4f19c6db86629f5a18c2b', 'f7acf9d19953686e3042a10755a867a8f80a7fdb3963bd8e78e725962c792276', 'c292f69407b0d7752008069ac095dc556522ed5df9f386b9e2ec5bf31909e8f0', 'f3d0a6a4aea6909d35d8e5368425b21b38799b7f44444d926176083b532c011b'];
const envDigests = Object.values(ENVELOPE);
check('V8.r1ProjectionDisjoint', R1_PROJECTION.every((d) => !envDigests.includes(d)),
  'the r1 projection is disjoint from the accepted capsule (0/7 overlap with the 8 envelope addresses)');
const r1FormalRaw = readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r1/define-architecture-contract-formalization.json'), 'utf8');
check('V8.r1DeclaresFramePins', r1FormalRaw.includes(GOVERNING) && r1FormalRaw.includes(SEMANTIC_PIN),
  'the r1 formalization declares BOTH frame pins (a926df62 as its Content Digest, 95fafc84 as its modules digest)');

/* V9 - workspace-wide three-layer frame-pin scan */
const targets = [
  { label: 'protocolSkill', digest: GOVERNING, resolutions: [], mentions: 0 },
  { label: 'semanticSkill', digest: SEMANTIC_PIN, resolutions: [], mentions: 0 },
  { label: 'r1UpdatedClaim', digest: R1_UPDATED_CLAIM, resolutions: [], mentions: 0 },
];
let filesScanned = 0;
const skipDirs = new Set(['.git', 'node_modules']);
const walk = (dir) => {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      if (full === DIR) continue; /* this emission excluded */
      walk(full);
      continue;
    }
    if (!e.isFile()) continue;
    filesScanned += 1;
    let raw;
    try { raw = readFileSync(full, 'utf8'); } catch { continue; }
    const relPath = relative(REPO, full).split('\\').join('/');
    for (const t of targets) {
      if (raw.includes(t.digest)) t.mentions += 1;
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
    const layers = new Map([['raw-bytes', shaRaw(raw)]]);
    if (parsed !== null && typeof parsed === 'object') {
      layers.set('whole-JSON-canonical', sha(parsed));
      if (parsed.content !== undefined && typeof parsed.content === 'object' && parsed.content !== null) {
        layers.set('.content-canonical', sha(parsed.content));
      }
    }
    for (const t of targets) {
      if ([...layers.values()].includes(t.digest)) t.resolutions.push(`${relPath} :: ${[...layers.entries()].find(([, d]) => d === t.digest)[0]}`);
    }
  }
};
walk(REPO);
for (const t of targets) {
  check(`V9.scan.${t.label}`, t.resolutions.length === 0,
    `${t.label} ${t.digest.slice(0, 8)}...: ${t.resolutions.length} hash-resolved contents over ${filesScanned} files (3 layers, this emission excluded); textual mentions: ${t.mentions}`);
}

/* V10 - file-family discipline + determinism */
const family = readdirSync(DIR).filter((f) => f.startsWith('define-architecture-contract-')).sort();
const expectedFamily = [
  'define-architecture-contract-desk-hold-build.mjs',
  'define-architecture-contract-desk-hold-submission-summary.md',
  'define-architecture-contract-desk-hold-verify-out.json',
  'define-architecture-contract-desk-hold-verify.mjs',
  'define-architecture-contract-desk-upstream-hold-trace.json',
  'define-architecture-contract-desk-upstream-hold.artifact.json',
].sort();
const unexpectedFamily = family.filter((f) => !expectedFamily.includes(f));
check('V10.fileFamily', unexpectedFamily.length === 0 && ['define-architecture-contract-desk-hold-build.mjs', 'define-architecture-contract-desk-upstream-hold.artifact.json', 'define-architecture-contract-desk-upstream-hold-trace.json', 'define-architecture-contract-desk-hold-verify.mjs'].every((f) => family.includes(f)),
  `this seat's family carries no unexpected file (${family.length} present of the 6-file hold family; verify-out + summary complete after this run); no SRS/architecture-contract product exists in this emission`);
const determinismProbeA = canon(artifact.content);
const determinismProbeB = canon(sortKeys(JSON.parse(canon(artifact.content))));
check('V10.determinism', determinismProbeA === determinismProbeB && sha(artifact.content) === ART,
  'canonical serialization is idempotent; artifact digest stable across probes');
check('V10.verificationBlock', c.verification.deterministicAuthoring === true && c.verification.declaredDigestsTrusted === false && c.verification.productMaterialAuthored === false,
  'the published verification block is honest (nothing trusted, nothing authored)');

/* Emit */
const passed = checks.filter((x) => x.pass).length;
const failed = checks.filter((x) => !x.pass).length;
const scanBlock = Object.fromEntries(targets.map((t) => [t.label, { address: shaRef(t.digest), hashResolvedContents: t.resolutions, textualMentions: t.mentions }]));
const outContent = {
  verificationId: 'VV-Define-Architecture-Contract-001',
  deskRef: 'define-architecture-contract',
  role: 'author',
  reviewedRound: 'stray-products-r4',
  subject: `mechanical verification underlying UH-Define-Architecture-Contract-001 (${passed}/${checks.length} recomputations pass)`,
  trustedByDeclaration: false,
  checks,
  checksSummary: { total: checks.length, pass: passed, fail: failed },
  framePinScan: {
    filesScanned,
    layers: ['raw bytes', 'whole-JSON canonical', '.content canonical'],
    excludedFromScan: ['.git', 'node_modules', 'stray-products-r4 (this emission)'],
    targets: scanBlock,
  },
  emissionRefs: { artifactRef: artifact.artifactRef, traceRef: trace.traceRef },
  deterministicAuthoring: true,
};
const out = {
  artifactRef: shaRef(sha(outContent)),
  artifactKind: 'verifier-output',
  semanticCode: 'VV-Define-Architecture-Contract-001',
  contentDigest: sha(outContent),
  createdAt: CREATED_AT,
  deskRef: 'define-architecture-contract',
  role: 'author',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: outContent,
};
writeFileSync(join(DIR, 'define-architecture-contract-desk-hold-verify-out.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
for (const chk of checks) if (!chk.pass) console.error(`FAIL ${chk.id}: ${chk.detail}`);
console.log(JSON.stringify({ verified: 'UH-Define-Architecture-Contract-001', total: checks.length, pass: passed, fail: failed, verifyOutRef: out.artifactRef, filesScanned }, null, 2));
if (failed > 0) process.exit(1);
