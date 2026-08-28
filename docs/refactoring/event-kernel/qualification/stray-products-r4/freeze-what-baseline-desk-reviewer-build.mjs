/**
 * freeze-what-baseline desk (reviewer) - REVIEWER REFUSAL builder.
 *
 * Emission: FR-Freeze-What-Baseline-Reviewer-002 (stray-products-r4,
 * reviewer seat). Deterministic authoring.
 *
 * This round's desk task frame, for the first time since r3, carries an
 * envelope-layer authority claim: upstream-accepted[0]
 * sha256:e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de
 * :: "accepted revision of freeze-what-baseline" with the workspace
 * summary "1 accepted upstream revisions travel by content address".
 * The r3 verified state (UH-Freeze-What-Baseline-001) recorded 0 accepted
 * upstream revisions, verdict-of-record repair at the reconcile-what gate,
 * and an explicit no-accept prohibition toward this desk.
 *
 * This seat adjudicates the frame claim at the CONTENT layer (a textual
 * scan finds the address cited only inside adjudication records - the
 * claim is only decidable by hashing). Mechanical result: the address
 * hash-resolves to EXACTLY one workspace content, the contract suite's
 * green-path payload-contract fixture
 * docs/refactoring/formalization-frf/contracts/fixtures/green/what-baseline.json.
 * That fixture is not a WorkplaceProductionRevision of this chain, carries
 * no reviewer stage at its own address, cites placeholder acceptance
 * triples (all 15 hash-resolve to zero contents), and is itself a
 * what-baseline - THIS desk's product kind - so it cannot constitute this
 * desk's upstream revision. Adjudication: REFUSED as acceptance authority.
 *
 * Reviewer-sequence context (this staffing ingests both, recomputed):
 * AS-Freeze-What-Baseline-001 (c2a08f04..., author re-staff confirmation)
 * re-verified the standing hold with a workspace-wide movement scan - 0
 * new accepted lineage since the hold; RC-Freeze-What-Baseline-001
 * (c19344fd..., the desk's first reviewer-stage record) adjudicated this
 * same frame delta as UNRESOLVABLE under a QUALIFICATION-TREE-SCOPED scan
 * (317 files). This record's WORKSPACE-WIDE scan (all files outside this
 * round) RESOLVES the address to the green fixture - a refinement of the
 * resolution FACT, not of the disposition: both reviewer records refuse
 * the claim; this emission supersedes the scope-limited finding by
 * content address and carries the confirmation's disposition forward.
 * The recomputed census remains 0 of 5; the freeze contract
 * (acceptanceRecords minItems 5) remains unsatisfiable; the hold stands
 * and freeze ratification is refused.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. All addresses are sha256 over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule. Every cited
 * record digest is recomputed from the corpus files in this script;
 * nothing is trusted by declaration.
 *
 * Run: node freeze-what-baseline-desk-reviewer-build.mjs
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const relPath = (p) => relative(REPO, p).split('\\').join('/');

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : (v !== null && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRaw = (bytes) => createHash('sha256').update(bytes).digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(DIR, '..', '..', '..', '..', '..');
const CREATED_AT = '2026-08-28T00:00:00Z';
const SELF_ROUND = 'stray-products-r4';

/* The desk-task envelope (content addresses of this desk task). */
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

/* The frame's authority claim, verbatim. */
const CLAIMED = {
  address: 'e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de',
  label: 'accepted revision of freeze-what-baseline',
  workspaceSummary: '1 accepted upstream revisions travel by content address',
};
/* Frame layer skill pins (protocol-skill / semantic-skill). */
const SKILL = {
  protocol: 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
  semantic: '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
};
/* r2-era governing anchor (inherited debt; NOT pinned by this round's frame). */
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
/* The green fixture the claimed address resolves to. */
const FIXTURE_REL = 'docs/refactoring/formalization-frf/contracts/fixtures/green/what-baseline.json';
const FIXTURE_TRIPLES = [
  '472073e531c4fcdd57ce3507653240c9f49fe93142d6ae176211afe37dbe9075',
  '2c4f598ac1087bb43db9e71d6fbd67cea725745e8dc96834e60cf75fc8de7b01',
  '028d838b7f233b1e9a7dd46c56d1067a6e8d2a9dfb3c1090788bf09e1dcd405a',
  'e111ac9880949488cceb478197e1d59f47677f34eb00d0d245e41d5086fa0014',
  '12d0a4297fcfa2e09c17d32dde934bf3c2f9d400c1c87af268537913f376876b',
  '6d1981c45ff85db8ac88b9c66536cde8c32aa4bc9e72b815d24c2385646cbd92',
  '5f151227af0c7749ceb50396168e560e858e97442c7a2ec984d12dc38990e17f',
  'bb57253d7c1a64b20fad333b8430b62412b06d99a33815f4a4b12fd076195453',
  '97cc689f541a9ef547bc8bd05d7af166219a950d548517d0dbc96f620f59a44b',
  'e8b6358bf770fda2c7246aa965eb6bfa5a84bd5f53dcc156e4bb29dc53a9bef2',
  '77f71d55b35bfac27fa504c90fccfdb3e33f0be488244e533289676786bace52',
  '259b2802ada943b3039ad4b08f73d11dda27ba66ac3b0c594383f2a01cd808c3',
  'c0777682bb7754f11db924e3f99aea3a3721381a93fd3b8a798d810165822edd',
  'bdb247e158e9c8be3be60bdfdaf307522f0c7910f71c5218bdad41e03ccc7473',
  'dd835fe83c7180246fb65ed542cecccc207bfd5a5ce34fc7c5a46d6fd84ae12b',
];
const FIXTURE_WHOLE_WHAT = '68e50e0c3aca739c6b17fcf548983965f8f9161c8f8c971dbeb8f9cded8b8891';

const expect = (cond, message) => { if (!cond) throw new Error(`reviewer basis failed: ${message}`); };

/* ------------------------------------------------------------------ */
/* Shared mechanical scans (workspace-wide, honest about mentions)      */
/* ------------------------------------------------------------------ */

const scanWorkspace = () => {
  const targets = new Set([
    CLAIMED.address, ...Object.values(SKILL), GOVERNING,
    ...FIXTURE_TRIPLES, FIXTURE_WHOLE_WHAT,
  ]);
  const state = {
    files: 0,
    textualMentions: Object.fromEntries([...targets].map((t) => [t, 0])),
    textualMentionPaths: Object.fromEntries([...targets].map((t) => [t, []])),
    hashResolved: Object.fromEntries([...targets].map((t) => [t, []])),
  };
  const walk = (dir) => {
    for (const e of readdirSync(dir)) {
      if (e === '.git' || e === 'node_modules' || e === SELF_ROUND) continue;
      const p = join(dir, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      state.files += 1;
      let bytes;
      try { bytes = readFileSync(p); } catch { continue; }
      const s = bytes.toString('utf8');
      for (const t of targets) if (s.includes(t)) { state.textualMentions[t] += 1; state.textualMentionPaths[t].push(relPath(p)); }
      if (p.endsWith('.json')) {
        try {
          const j = JSON.parse(s);
          const whole = shaRaw(Buffer.from(canon(j), 'utf8'));
          if (targets.has(whole)) state.hashResolved[whole].push(`${relPath(p)} :: whole-canon`);
          if (j && typeof j === 'object' && j.content !== undefined) {
            const c = shaRaw(Buffer.from(canon(j.content), 'utf8'));
            if (targets.has(c)) state.hashResolved[c].push(`${relPath(p)} :: content-canon`);
          }
        } catch { /* unparseable: raw layer already checked */ }
      }
    }
  };
  walk(REPO);
  return state;
};
const SCAN = scanWorkspace();

/* ------------------------------------------------------------------ */
/* Recompute the accepted base, the gate records and the census         */
/* ------------------------------------------------------------------ */

const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';
const record = (relPath) => {
  const j = JSON.parse(readFileSync(join(REPO, relPath), 'utf8'));
  return { contentDigest: sha(j.content), content: j.content };
};

/* Accepted discovery import chain (the only accepted base). */
const importArt = record(`${R2}/import-discovery-handoff-desk-discovery-import.artifact.json`);
expect(importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', 'import artifact address drift');
const vsa = importArt.content.verifiedSubArtifacts;
const capGroups = [vsa.sourceClaims, vsa.constraints, vsa.unknowns, vsa.terminalLifecycleClaims, [vsa.certificate]];
const capDigests = capGroups.flat().map((s) => ({ s, digest: sha(s.content) }));
expect(capDigests.every(({ s, digest }) => digest === s.digest), 'capsule sub-artifact digest drift');
const envelopeRecompute = Object.entries(ENVELOPE).map(([id, digest]) => {
  const hit = capDigests.find(({ digest: d }) => d === digest);
  expect(hit, `envelope id ${id} does not recompute from the accepted capsule`);
  return { id, digest, ref: shaRef(digest), recomputed: true };
});
const certDigest = sha(vsa.certificate.content);
expect(certDigest === '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21', 'capsule certificate drift');

/* The desk candidate of record: the r3 author-seat upstream hold, byte-stable. */
const holdArt = record(`${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`);
const holdTrc = record(`${R3}/freeze-what-baseline-desk-upstream-hold-trace.json`);
expect(holdArt.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f', 'author hold artifact drift');
expect(holdTrc.contentDigest === '17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202', 'author hold trace drift');
expect(holdArt.content.decision === 'hold-no-authoring' && holdArt.content.noProductAuthored === true, 'author hold decision drift');
expect(holdArt.content.chainAcceptanceCensus.acceptedPreFreezeDeskCount === 0, 'author hold census drift');
/* The r3 mechanical verification of the hold recomputes green. */
const holdVerifyOut = JSON.parse(readFileSync(join(REPO, `${R3}/freeze-what-baseline-desk-hold-verify-out.json`), 'utf8'));
expect(holdVerifyOut.summary.allPass === true && holdVerifyOut.summary.fail === 0, 'r3 hold verify-out no longer green');

/* The r3 re-staff and reviewer confirmations (parallel reviewer-sequence records). */
const asConf = record(`${R3}/freeze-what-baseline-desk-restaff-confirmation.json`);
expect(asConf.contentDigest === 'c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06', 'AS-Freeze-What-Baseline-001 drift');
expect(asConf.content.holdDisposition?.state === 'STANDING (not discharged; not re-emitted)' && asConf.content.upstreamStateRecheck?.movementScan?.newAcceptedLineageSinceHold === 0, 'AS-001 disposition drift');
const rcConf = record(`${R3}/freeze-what-baseline-desk-reviewer-confirmation.json`);
expect(rcConf.contentDigest === 'c19344fd964655f226b777747b23b94da07877f2fc28614ea4a65c98c803ed44', 'RC-Freeze-What-Baseline-001 drift');
expect(rcConf.content.decision === 'hold-upheld-no-candidate-to-review' && rcConf.content.upstreamAcceptedAdjudication?.resolution === 'UNRESOLVABLE' && rcConf.content.upstreamAcceptedAdjudication?.ratified === false, 'RC-001 adjudication drift');
const rcTrc = record(`${R3}/freeze-what-baseline-desk-reviewer-confirmation-trace.json`);
expect(rcTrc.contentDigest === '38192e08e601f35302e80650e8a7d8f84f7e9b6334d18f6cd092092e3c9e1b5d' && rcTrc.content.subjectArtifactRef === shaRef(rcConf.contentDigest), 'RC-001 trace drift');
const rcVerifyOut = JSON.parse(readFileSync(join(REPO, `${R3}/freeze-what-baseline-desk-reviewer-confirmation-verify-out.json`), 'utf8'));
expect(rcVerifyOut.summary.allPass === true && rcVerifyOut.summary.fail === 0, 'RC-001 verify-out no longer green');

/* The upstream gate: reconcile-what reviewer rounds of record. */
const rwArt = record(`${R3}/reconcile-what-desk-what-reconciliation.artifact.json`);
const rwTrc = record(`${R3}/reconcile-what-desk-what-reconciliation-trace.json`);
const rwSub = record(`${R3}/reconcile-what-desk-product-submission.json`);
const frRw = record(`${R3}/reconcile-what-desk-reviewer-review.json`);
const vvRw = record(`${R3}/reconcile-what-desk-reviewer-verification.json`);
const rtRw = record(`${R3}/reconcile-what-desk-reviewer-trace.json`);
const fsRw2 = record(`${R3}/reconcile-what-desk-reviewer-product-submission.json`);
const clRw = record(`${R3}/reconcile-what-desk-reviewer-collision-record.json`);
expect(rwArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191', 'reconcile-what artifact drift');
expect(rwTrc.contentDigest === '09e800469f38c2d926dc1ef24974ca3b2f01ce72913ffcc5832dde071d6581e0', 'reconcile-what trace drift');
expect(rwSub.contentDigest === '0f4e4fafac2e9f5eebd9216345f08577d332ee72839f569b3bb58b1a08dd53ba', 'reconcile-what submission drift');
expect(frRw.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6' && frRw.content.verdict === 'repair', 'FR-Reconcile-What-001 drift');
expect(vvRw.contentDigest === 'cd7504a69eff07d39f9945f8cf3da3f7cf8c4d8e91932c897dab5f5fbab35cac', 'VV-Reconcile-What-001 drift');
expect(rtRw.contentDigest === 'fe108e09db2dedb37dbb151d46e56090128c7bc44da339e44be62a47e7755373', 'RT-Reconcile-What-001 drift');
expect(fsRw2.contentDigest === '9f2f5d073647ad88d73cf21c9a3dab2ae898df9f3f4ed3b67d9e4db8962b64ce', 'FS-Reconcile-What-002 drift');
expect(clRw.contentDigest === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d', 'CL-Reconcile-What-001 drift');
expect(frRw.content.reviewedCandidate?.submissionRef === shaRef(rwSub.contentDigest) && frRw.content.reviewedCandidate?.artifactRef === shaRef(rwArt.contentDigest), 'gate reviewer candidate binding drift');
expect(frRw.content.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline'), 'gate prohibition text drift');
const crit1 = frRw.content.findings.criticalIssues.find((f) => f.id === 'CRIT-1');
expect(Boolean(crit1) && crit1.requiredAction.includes('No accept effect may fire on this chain'), 'gate CRIT-1 prohibition drift');
expect(JSON.stringify(frRw.content).includes('the freeze would inherit the fabricated authority permanently'), 'gate CRIT-1 permanence drift');
/* No reconcile-what reviewer verdict anywhere departs from repair. */
const frRwB = record(`${R3}/reconcile-what-desk-reviewer-review-emission-b.json`);
const rwReviews = [frRw.content, frRwB.content];
expect(rwReviews.every((c) => c.deskRef === 'reconcile-what' && c.verdict === 'repair'), 'a non-repair reconcile-what reviewer verdict exists');

/* The chain beneath the gate: 0 of 5 pre-freeze desks accepted. */
const intentArt = record(`${R3}/define-product-intent-desk-product-intent.artifact.json`);
const frIntent1 = record(`${R2}/define-product-intent-desk-reviewer-review.json`);
const frIntent1b = record(`${R2}/define-product-intent-desk-reviewer-review-emission-b.json`);
const frIntent2 = record(`${R2}/define-product-intent-desk-reviewer2-review.json`);
expect(intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055', 'intent artifact drift');
expect([frIntent1, frIntent1b, frIntent2].every((r) => r.content.verdict === 'repair'), 'intent verdict drift');
const ucArt = record(`${R3}/model-use-cases-desk-uc-scenarios.artifact.json`);
const ucHoldR2 = record(`${R2}/model-use-cases-desk-upstream-hold.artifact.json`);
const frUc001 = record('.factory-testbed/model-use-cases-reviewer-review.json');
expect(ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b', 'UC artifact drift');
expect(ucHoldR2.contentDigest === '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7', 'UC hold drift');
expect(frUc001.content.reviewedCandidate?.artifactRef === 'sha256:c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8', 'UC verdict candidate pin drift');
expect(frUc001.content.reviewedCandidate?.artifactRef !== shaRef(ucArt.contentDigest), 'UC verdict unexpectedly pins the corpus bundle');
const srArt = record(`${R3}/derive-system-requirements-desk-system-requirements.artifact.json`);
const frSr1 = record(`${R2}/derive-system-requirements-desk-reviewer-review.json`);
const uhSr1 = record('.factory-testbed/derive-system-requirements-reviewer-hold.artifact.json');
const uhSr2 = record('.factory-testbed/derive-system-requirements-reviewer-hold2.artifact.json');
expect(srArt.contentDigest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df', 'requirements artifact drift');
expect(frSr1.content.verdict === 'repair' && frSr1.contentDigest === 'd31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0', 'requirements verdict drift');
expect(uhSr1.contentDigest === 'fbc0394bd8f79df2fc7e8956accd9fe25485bceab182044927de9f209f11d053', 'requirements hold1 drift');
expect(uhSr2.contentDigest === 'b4eaaabaa5010c6e03594943e2437b030d352ec9f3027fb275d57f351692c995', 'requirements hold2 drift');
const acArt = record(`${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`);
const uhAc = record(`${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`);
const frAc2 = record(`${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`);
expect(acArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0', 'acceptance artifact drift');
expect(uhAc.contentDigest === 'a53a5e08a9c7f0f6ad550fd5d2db142238683e1d285458eb2ded5330cce39d84', 'acceptance hold drift');
expect(frAc2.content.verdict === 'repair' && frAc2.contentDigest === '7e76176c431770477f2930747498f2df8b0a6ce6071c29ff065ad7d85edcac0e', 'adjudicating acceptance review drift');

/* The freeze product contract itself. */
const schemaBytes = readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json'));
const schemaRawDigest = shaRaw(schemaBytes);
expect(schemaRawDigest === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09', 'what-baseline schema pin drift');
const schema = JSON.parse(schemaBytes.toString('utf8'));
expect(schema.properties.acceptanceRecords.minItems === 5 && schema.properties.schemaVersion.const === 'frf-contracts.what-baseline.v1', 'freeze contract law drift');

/* ------------------------------------------------------------------ */
/* Adjudication of the frame's upstream-accepted claim                  */
/* ------------------------------------------------------------------ */

/* A1: the claimed address hash-resolves to EXACTLY the green fixture (whole-JSON canonical). */
const resolvedHits = SCAN.hashResolved[CLAIMED.address];
expect(resolvedHits.length === 1 && resolvedHits[0].startsWith(`${FIXTURE_REL} :: whole-canon`), `claimed address resolves unexpectedly: ${JSON.stringify(resolvedHits)}`);
/* A2: the fixture bytes re-derive that address. */
const fixtureParsed = JSON.parse(readFileSync(join(REPO, FIXTURE_REL), 'utf8'));
expect(shaRaw(Buffer.from(canon(fixtureParsed), 'utf8')) === CLAIMED.address, 'fixture whole-canon digest drift');
/* A3: zero RATIFYING textual citations - every mention of the address outside
 * this round lives in the r3 reviewer-confirmation set (RC-001-namespaced
 * files: record, trace, build/verify scripts, summary), which adjudicates the
 * claim (UNRESOLVABLE at its scan scope, ratified: false). No corpus record
 * cites the address as acceptance authority. */
const CONFIRMATION_SET_PREFIX = `${R3}/freeze-what-baseline-desk-reviewer-confirmation`;
const claimMentions = SCAN.textualMentionPaths[CLAIMED.address];
expect(claimMentions.every((p) => p.startsWith(CONFIRMATION_SET_PREFIX)), `unexpected citers of the claimed address: ${JSON.stringify(claimMentions.filter((p) => !p.startsWith(CONFIRMATION_SET_PREFIX)))}`);
expect(claimMentions.length >= 2, 'the r3 reviewer-confirmation set should cite the adjudicated address');
/* A4: fixture acceptance triples + wholeWhatDigest are placeholders (0 hash-resolutions). */
expect(FIXTURE_TRIPLES.every((t) => SCAN.hashResolved[t].length === 0), 'a fixture acceptance triple hash-resolves to real content');
expect(SCAN.hashResolved[FIXTURE_WHOLE_WHAT].length === 0, 'fixture wholeWhatDigest hash-resolves to real content');
/* A5: fixture identity markers are placeholders, not chain objects. */
expect(fixtureParsed.caseIdentity?.formalizationCaseRef === 'case:form-1' && fixtureParsed.caseIdentity?.discoveryCertificateRef === 'cert:disc-1', 'fixture caseIdentity drift');
expect(fixtureParsed.schemaVersion === 'frf-contracts.what-baseline.v1' && fixtureParsed.acceptanceRecords.length === 5, 'fixture shape drift');
/* A6: the frame skill pins resolve to no content (provenance, not ratified). */
expect(SCAN.hashResolved[SKILL.protocol].length === 0 && SCAN.hashResolved[SKILL.semantic].length === 0, 'a frame skill pin hash-resolves');
expect(SCAN.textualMentions[SKILL.protocol] > 0 && SCAN.textualMentions[SKILL.semantic] > 0, 'frame skill pins absent from the corpus');
/* A7: inherited governing anchor still resolves to no content. */
expect(SCAN.hashResolved[GOVERNING].length === 0, 'governing anchor unexpectedly resolves');

const adjudication = {
  frameEntry: `upstream-accepted[0] ${shaRef(CLAIMED.address)} :: ${CLAIMED.label}`,
  frameWorkspaceSummary: CLAIMED.workspaceSummary,
  resolution: 'RESOLVED at the content layer: the address is the whole-JSON canonical sha256 of exactly one workspace content',
  resolvedContent: {
    path: FIXTURE_REL,
    role: 'green-path payload-contract fixture of frf-contracts.what-baseline.v1 (contract-suite test example)',
    lawfulConsumers: [
      'tests/workflow-kernel/workshops/formalization/cells/what-freeze/support.mjs',
      'tools/frf-corpus/lib/material.mjs',
      'docs/refactoring/formalization-frf/contracts/run-proof.mjs',
    ],
    acceptanceTriples: '5 placeholder triples (15 digests), all hash-resolving to zero workspace contents',
    caseIdentityRefs: 'fixture placeholders (case:form-1, cert:disc-1), not chain objects',
  },
  authorityAudit: {
    isWorkplaceProductionRevisionOfThisChain: false,
    reviewerStageAtThisAddress: false,
    citedByAnyQualificationRecord: false,
    textualMentionsOutsideThisRound: SCAN.textualMentions[CLAIMED.address],
    selfReference: "the resolved content is itself a what-baseline - THIS desk's own product kind - so it cannot constitute this desk's upstream revision; the desk's upstream gate is reconcile-what",
  },
  adjudication: 'REFUSED as acceptance authority (fixture-misdeclared-as-accepted-revision; CRIT-1 family)',
  parallelReviewerRecord: {
    semanticCode: 'RC-Freeze-What-Baseline-001',
    ref: shaRef(rcConf.contentDigest),
    traceRef: shaRef(rcTrc.contentDigest),
    disposition: 'hold-upheld-no-candidate-to-review; claim adjudicated UNRESOLVABLE under a qualification-tree-scoped scan (317 files) and NOT ratified',
    deltaAdjudicatedByThisRecord: 'the scope-limited UNRESOLVABLE finding is superseded at the content layer: a WORKSPACE-WIDE scan (raw, whole-JSON-canonical and .content-canonical bodies over every file outside this round) hash-resolves the address to exactly one content - the green fixture. The DISPOSITION is unchanged: both reviewer records refuse the claim as acceptance authority.',
    authorRestaffContext: 'AS-Freeze-What-Baseline-001 (c2a08f04...) re-verified the standing hold workspace-wide with 0 new accepted lineage since the hold; consistent with this adjudication.',
  },
  historicalNote: 'same frame family as r1 (upstream-accepted[0] sha256:745cadc1131468039f167043c000fc0af170ed98764f545f22d867be36da1c35 :: accepted revision of define-product-intent, flagged unresolved by r1 RC-003); this variant is strictly weaker: r1 named a chain product (itself stale shell metadata per the AS-001 movement-scan known-benign law), this frame names a contract-suite fixture',
};

/* ------------------------------------------------------------------ */
/* Checks ledger (published through the VV record)                      */
/* ------------------------------------------------------------------ */

const checks = [];
const check = (id, pass, detail) => { checks.push({ id, pass: pass === true, detail }); return pass === true; };

check('A1.claimedAddressResolvesToFixture', resolvedHits.length === 1 && resolvedHits[0].startsWith(`${FIXTURE_REL} :: whole-canon`), `hash-resolved: ${resolvedHits.join('; ')}`);
check('A2.fixtureDigestRecomputes', shaRaw(Buffer.from(canon(fixtureParsed), 'utf8')) === CLAIMED.address, 'whole-JSON canonical sha256 of the fixture recomputes to the claimed address');
check('A3.noRatifyingCitations', claimMentions.every((p) => p.startsWith(CONFIRMATION_SET_PREFIX)) && rcConf.content.upstreamAcceptedAdjudication?.ratified === false, `the address is cited only by the r3 RC-001-namespaced confirmation set (adjudication, ratified:false), never as acceptance authority (${claimMentions.length} mention files)`);
check('A4.triplesArePlaceholders', FIXTURE_TRIPLES.every((t) => SCAN.hashResolved[t].length === 0) && SCAN.hashResolved[FIXTURE_WHOLE_WHAT].length === 0, 'all 15 acceptance-triple digests and the wholeWhatDigest resolve to zero contents');
check('A5.fixtureIdentityPlaceholders', fixtureParsed.caseIdentity?.formalizationCaseRef === 'case:form-1' && fixtureParsed.caseIdentity?.discoveryCertificateRef === 'cert:disc-1', 'fixture caseIdentity placeholders confirm fixture status');
check('A6.skillPinsProvenanceOnly', SCAN.hashResolved[SKILL.protocol].length === 0 && SCAN.hashResolved[SKILL.semantic].length === 0, 'protocol/semantic skill digests resolve to no content; recorded verbatim, not ratified');
check('A7.governingAnchorStillUnresolvable', SCAN.hashResolved[GOVERNING].length === 0, 'r2-era governing anchor still hash-resolves to zero contents (inherited debt, not pinned by this frame)');
check('B1.envelope8of8', envelopeRecompute.length === 8 && envelopeRecompute.every((e) => e.recomputed), 'all 8 task-projection addresses re-derive from the accepted capsule (9/9 with CERT-1)');
check('B2.importAccepted', importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', 'the accepted discovery import chain recomputes; still the only accepted base');
check('B3.holdByteStable', holdArt.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f' && holdTrc.contentDigest === '17c09566fa7fa82d23b7ecffefdac9d6ba919c430de2f8387ccdc8d3cd4df202', 'UH-Freeze-What-Baseline-001 artifact/trace re-derive byte-stable');
check('B4.holdVerifyGreen', holdVerifyOut.summary.allPass === true, `r3 hold verifier still green (${holdVerifyOut.summary.pass}/${holdVerifyOut.summary.total})`);
check('C1.gateVerdictRepair', frRw.content.verdict === 'repair' && frRw.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6', 'gate verdict of record recomputes: repair');
check('C2.gateRoundRecomputes', [vvRw, rtRw, fsRw2, clRw].every((r) => r.contentDigest.length === 64), 'gate reviewer round + collision record digests recompute');
check('C3.prohibitionUndischarged', frRw.content.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline') && rwReviews.every((c) => c.verdict === 'repair'), 'no-accept prohibition recomputes and no reconcile-what reviewer verdict anywhere departs from repair');
check('C4.parallelReviewerAgreement', rcConf.content.decision === 'hold-upheld-no-candidate-to-review' && asConf.content.holdDisposition?.state === 'STANDING (not discharged; not re-emitted)', 'RC-001 (hold-upheld) and AS-001 (standing hold, 0 new accepted lineage) recompute; both agree with this refusal');
check('D1.censusZeroOfFive', [frIntent1, frIntent1b, frIntent2, frSr1, frAc2].every((r) => r.content.verdict === 'repair') && frUc001.content.reviewedCandidate?.artifactRef !== shaRef(ucArt.contentDigest), 'all pre-freeze verdict records recompute; census remains 0 of 5 accepted');
check('D2.freezeContractUnsatisfiable', schema.properties.acceptanceRecords.minItems === 5 && schemaRawDigest === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09', 'frf-contracts.what-baseline.v1 demands 5 accepted acceptanceRecords; schema pin recomputes');
check('E1.deterministicScan', SCAN.files > 2000, `${SCAN.files} workspace files scanned across raw, whole-JSON-canonical and .content-canonical layers`);

const passCount = checks.filter((c) => c.pass).length;
expect(passCount === checks.length, `a basis check failed: ${JSON.stringify(checks.filter((c) => !c.pass))}`);

/* ------------------------------------------------------------------ */
/* VV record (built first; cited by the review)                         */
/* ------------------------------------------------------------------ */

const vvContent = {
  verificationId: 'VV-Freeze-What-Baseline-002',
  semanticCode: 'VV-Freeze-What-Baseline-002',
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  reviewedRound: SELF_ROUND,
  subject: 'mechanical verification underlying FR-Freeze-What-Baseline-Reviewer-002 (frame authority adjudication + chain state recomputation)',
  trustedByDeclaration: false,
  checks,
  checksSummary: { total: checks.length, pass: passCount, fail: checks.length - passCount },
  resolutionScan: {
    filesScanned: SCAN.files,
    layers: ['raw bytes', 'whole-JSON canonical', '.content canonical', 'hash-resolution (sha256 over canonical forms)'],
    excludedFromScan: ['.git', 'node_modules', `${SELF_ROUND} (this emission)`],
    claimedAcceptedAddress: {
      address: shaRef(CLAIMED.address),
      textualMentionsOutsideThisRound: SCAN.textualMentions[CLAIMED.address],
      mentionFilesOutsideThisRound: claimMentions,
      hashResolvedContents: resolvedHits,
      parallelScanDelta: 'RC-Freeze-What-Baseline-001 scanned the qualification tree only (317 files) and recorded UNRESOLVABLE; this scan is workspace-wide and RESOLVES the address to the green fixture. Disposition unchanged: refused by both reviewer records.',
    },
    frameSkillPins: {
      protocolSkill: shaRef(SKILL.protocol),
      semanticSkill: shaRef(SKILL.semantic),
      hashResolvedContents: 0,
      disposition: 'envelope provenance recorded verbatim; not ratified by this seat',
    },
    governingAnchor: {
      address: shaRef(GOVERNING),
      hashResolvedContents: 0,
      disposition: 'inherited r2/r3 debt; NOT pinned by this round frame; still open',
    },
    fixtureInternals: {
      acceptanceTripleDigestsResolved: 0,
      wholeWhatDigestResolved: 0,
    },
  },
  deterministicAuthoring: true,
};
const vv = {
  artifactRef: shaRef(sha(vvContent)),
  artifactKind: 'reviewer-verification',
  contentDigest: sha(vvContent),
  semanticCode: 'VV-Freeze-What-Baseline-002',
  createdAt: CREATED_AT,
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: vvContent,
};

/* ------------------------------------------------------------------ */
/* FR review artifact (the reviewer refusal of record)                  */
/* ------------------------------------------------------------------ */

const frContent = {
  reviewId: 'FR-Freeze-What-Baseline-Reviewer-002',
  semanticCode: 'FR-Freeze-What-Baseline-002',
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  reviewedRound: SELF_ROUND,
  provenanceNote: 'FR-Freeze-What-Baseline-Reviewer-001 (r1 assessment, pre-content-addressed corpus) is the review-sequence predecessor; recorded as history, not pinned.',
  reviewedCandidate: {
    artifactRef: shaRef(holdArt.contentDigest),
    traceRef: shaRef(holdTrc.contentDigest),
    productKind: 'formalization.upstream-hold.v1',
    declaredDecision: 'hold-no-authoring',
    note: 'the candidate of record at this desk is the r3 author-seat upstream hold; NO WHAT-baseline candidate exists at this desk (none was ever lawfully authorable on this chain)',
  },
  verificationRef: shaRef(vv.contentDigest),
  verificationSummary: { recomputedChecks: checks.length, passed: passCount, failed: 0, trustedByDeclaration: false },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    adjudicated: 1,
    note: "All 8 claim/constraint/unknown/terminal addresses match this frame exactly and re-derive from the accepted capsule. THE DELTA VS R3: this frame, for the first time, carries an upstream-accepted ref (upstream-accepted[0] sha256:e210334e...) plus the workspace summary \"1 accepted upstream revisions travel by content address\" - adjudicated below at the content layer. The frame also pins protocol-skill bc8a4261... and semantic-skill 2cbcf850..., which hash-resolve to no workspace content (recorded as provenance). This round's frame pins NO governingContractRef; the r2-era anchor a926df6284... remains unresolvable workspace-wide.",
  },
  workspaceLaw: `frame claim, verbatim: "${CLAIMED.workspaceSummary}" (upstream-accepted[0] ${shaRef(CLAIMED.address)} :: ${CLAIMED.label}) - adjudicated FALSE at the status layer: the address resolves to the contract-suite green fixture, not an accepted chain revision; the recomputed census is 0 of 5 accepted pre-freeze desks; the gate verdict of record is repair with the no-accept prohibition undischarged.`,
  reviewerSequence: {
    first: {
      semanticCode: 'RC-Freeze-What-Baseline-001',
      ref: shaRef(rcConf.contentDigest),
      kind: 'reviewer-hold-confirmation (no FR/VV/FS package minted: no candidate existed to review)',
      disposition: 'hold-upheld-no-candidate-to-review',
    },
    thisRecord: 'FR-Freeze-What-Baseline-Reviewer-002 is the SECOND reviewer-stage record and mints the desk\'s first content-addressed FR/VV/FS reviewer package. This is NOT a re-emission of identical semantics (the idempotency law is respected): the workspace-wide resolution of the frame claim - the green fixture - is NEW adjudication content that the scope-limited RC-001 scan could not see. The confirmation\'s disposition is carried forward unchanged; its resolution finding is superseded by content address.',
    authorRestaff: {
      semanticCode: 'AS-Freeze-What-Baseline-001',
      ref: shaRef(asConf.contentDigest),
      disposition: 'hold carried, 0 new accepted lineage (workspace-wide movement scan)',
    },
  },
  claimedAcceptanceAdjudication: adjudication,
  findings: {
    positiveFindings: [
      'The envelope recomputes 8/8 from the accepted capsule (9/9 including CERT-1); the discovery import chain remains the only genuinely accepted base.',
      'The author-seat hold of record (UH-Freeze-What-Baseline-001 9f2d28b9... / trace 17c09566...) re-derives byte-stable; its 33/33 r3 verification and the 40/40 RC-001 verification both recompute green.',
      'The claimed accepted revision was adjudicated at the CONTENT layer, not by label: the address is cited in the corpus only inside the r3 reviewer-confirmation set (which refuses it), and a workspace-wide three-body scan hash-resolves it to exactly one content.',
      'Two independent reviewer staffings agree on the disposition: RC-Freeze-What-Baseline-001 (hold-upheld, claim not ratified) and this seat (hold-upheld, claim refused); the author re-staff AS-Freeze-What-Baseline-001 independently confirms the standing hold with 0 new accepted lineage.',
      'The gate records recompute exactly: author candidate of record (0f4e4faf/6400a2dd/09e80046), reviewer round of record FR-Reconcile-What-001 39a94a29 (repair) with the explicit prohibition, collision record 841194ce (emission A the round of record); BOTH reconcile-what reviewer emissions (FR-...-001, FR-...-002) recompute to repair.',
      'The census recomputes 0 of 5 per row (intent repair x3; UC never reviewed at its own address; requirements repair + held reviewer seat; acceptance adjudicated repair CTN-001; reconcile-what repair), and the freeze contract itself (schema raw ab1b7f5e..., acceptanceRecords minItems 5) recomputes as the direct lawful-authoring blocker.',
    ],
    advisoryNotes: [
      {
        type: 'fixture_role_preserved',
        note: 'This adjudication refuses the fixture as ACCEPTANCE AUTHORITY; it does not disparage the fixture. Its lawful role - the green-path payload-contract example of frf-contracts.what-baseline.v1 - is untouched. The misdeclaration inverted the fixture role from "example of what a lawful freeze requires" to "proof that one exists".',
      },
      {
        type: 'frame_family_history',
        note: adjudication.historicalNote,
      },
    ],
    criticalIssues: [
      {
        id: 'CRIT-1',
        severity: 'CRITICAL',
        title: 'Frame declares an accepted upstream revision; the address resolves to a contract-suite fixture, not a chain revision',
        detail: `The frame's workspace summary ("${CLAIMED.workspaceSummary}") and its upstream-accepted[0] entry assert accepted-chain authority. Mechanical resolution: ${shaRef(CLAIMED.address)} is the whole-JSON canonical sha256 of exactly one workspace content - ${FIXTURE_REL}, the green-path test fixture of the payload contract. That fixture is not a WorkplaceProductionRevision of this chain: no submission, no desk, no reviewer stage exists for it anywhere in the corpus (its only citers are the r3 reviewer-confirmation set, which refuses it); its 5 acceptanceRecords are placeholder triples (all 15 digests hash-resolve to zero contents); its caseIdentity refs are fixture placeholders. The truthful recomputed census remains 0 of 5 accepted pre-freeze desks. RC-Freeze-What-Baseline-001 adjudicated the same claim UNRESOLVABLE under its qualification-tree-scoped scan (317 files); this seat's workspace-wide scan sharpens that finding - the address DOES resolve, to a fixture - while the disposition is unchanged. A freeze ratified over this "upstream" would inherit the fabricated authority permanently.`,
        requiredAction: 'Verdict: refuse the claim as acceptance authority. The freeze contract remains unsatisfiable on this chain. Lawful path unchanged: RA-1..RA-4 land genuinely accepted revisions through completed reviewer stages at their own content addresses; RA-5 re-runs reconcile-what over the NEW accepted chain; this desk re-staffs only afterwards (resume contract R1-R4 of the author hold).',
      },
      {
        id: 'CRIT-2',
        severity: 'CRITICAL',
        title: "Self-referential upstream: the resolved content is a what-baseline - this desk's own product kind",
        detail: `Even if the fixture had chain standing, a what-baseline cannot be the upstream revision OF the freeze-what-baseline desk: the desk would be consuming its own product as its acceptance. The desk's only lawful upstream gate is reconcile-what, whose verdict of record is repair. The frame's label ("${CLAIMED.label}") is therefore structurally self-referential - an acceptance of this desk asserted with no reviewer stage at any content address, the exact CRIT-2 failure class this chain adjudicated at r3.`,
        requiredAction: 'The frame entry must be withdrawn by the frame issuer. This desk records the refusal and does not ratify any freeze.',
      },
      {
        id: 'CRIT-3',
        severity: 'CRITICAL',
        title: 'The explicit no-accept prohibition toward this desk stands undischarged',
        detail: 'FR-Reconcile-What-001 (39a94a29..., emission A, round of record per CL-Reconcile-What-001 841194ce...) recomputes with "No domain.accepted may fire from this desk toward freeze-what-baseline on this chain"; CRIT-1 requiredAction carries "No accept effect may fire on this chain"; emission B (FR-Reconcile-What-002) also recomputes to repair. No re-run reconcile-what round exists anywhere in the corpus, so no verdict of record has discharged the prohibition. Per the discharge law (R2), only a future reconcile-what reviewer verdict of record on a re-run over genuinely accepted revisions can discharge it - never this desk, and never a frame assertion.',
        requiredAction: 'The prohibition stands. This seat records verdict hold-upheld on the author hold and refuses freeze ratification.',
      },
    ],
    majorIssues: [
      {
        id: 'MAJ-1',
        severity: 'MAJOR',
        title: 'Frame skill digests resolve to no workspace content; the inherited governing anchor remains unresolvable',
        detail: `The frame pins protocol-skill ${shaRef(SKILL.protocol)} and semantic-skill ${shaRef(SKILL.semantic)}; both hash-resolve to zero workspace contents (they are mentioned textually ${SCAN.textualMentions[SKILL.protocol]}/${SCAN.textualMentions[SKILL.semantic]} times as frame pins). Recorded as envelope provenance, not ratified. The r2-era governing anchor ${shaRef(GOVERNING)} also still resolves to zero contents - the anchor debt (r2 RA-2/RA-4, r3 MAJ-1) remains open; this round's frame pins no governingContractRef at all.`,
        requiredAction: 'The frame issuer must materialize the skill/anchor refs as real content-addressed material (or re-pin to what exists) before any future settlement may cite them.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true, evidence: 'VV/FR/RT/FS self-address and cross-bind; single-dereference evidence list in the submission' },
    { id: 2, description: 'Independent recomputation performed by this seat; nothing trusted by declaration', satisfied: true, evidence: `A-G check groups re-run (${checks.length}/${checks.length} pass); ${SCAN.files} files scanned` },
    { id: 3, description: 'All 8 reviewer-frame task-projection content addresses resolved', satisfied: true, evidence: 'B1: 8/8 exact from the accepted capsule' },
    { id: 4, description: "The frame's upstream-accepted entry adjudicated at the content layer, not by label", satisfied: true, evidence: 'A1-A5: exactly one content hash-resolves (workspace-wide); fixture internals proven placeholder; the only citers are the r3 confirmation set refusing the claim' },
    { id: 5, description: 'Verdict grounded in re-digested records, not round labels or prior review text', satisfied: true, evidence: 'C1-C3, D1: gate round, collision record, both reconcile-what emissions, all four pre-freeze verdict records re-digested' },
    { id: 6, description: 'constraint:retention-1 honored; unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true, evidence: 'no disposition, binding or resolution authored by this seat; the 8 envelope claims observed as content addresses only' },
    { id: 7, description: 'Reviewer artifacts deterministic: pinned timestamps, no clock reads, no randomness', satisfied: true, evidence: 'pinned CREATED_AT; verifier source hygiene probes' },
    { id: 8, description: 'Frame workspace summary TRUE of the chain', satisfied: false, note: 'CRIT-1 recorded honestly: the one resolving address is a contract-suite fixture; census 0 of 5' },
    { id: 9, description: 'A WHAT-baseline candidate exists at this desk to review', satisfied: false, note: 'none ever lawfully authored; the candidate of record is the author-seat upstream hold, which this seat verifies and upholds' },
    { id: 10, description: 'The claimed accepted revision is a chain WorkplaceProductionRevision with a completed reviewer stage', satisfied: false, note: 'CRIT-2 recorded honestly: fixture, no reviewer stage, self-referential label' },
  ],
  verdict: 'hold-upheld',
  decision: 'REFUSE freeze ratification; adjudicate the frame upstream-accepted claim as REFUSED (fixture-misdeclared-as-accepted-revision); uphold UH-Freeze-What-Baseline-001',
  nextStage: 'HOLD STANDS - no freeze effect may fire from this desk on this chain. Resume contract R1-R4 of the author hold unchanged: (R1) genuinely accepted revisions land for the four upstream desks through completed reviewer stages at their own content addresses, then RA-5 re-runs reconcile-what over the NEW accepted chain; (R2) the re-run reviewer verdict of record alone discharges the no-accept prohibition - never this desk, never a frame assertion; (R3) on five accepted pre-freeze desks this desk re-staffs and authors the whole-WHAT baseline strictly against the accepted triples and frf-contracts.what-baseline.v1 (acceptanceRecords minItems 5); (R4) the hold and this refusal are not carried as product lineage; the baseline cites only accepted revisions.',
};
const fr = {
  artifactRef: shaRef(sha(frContent)),
  artifactKind: 'formalization-review',
  contentDigest: sha(frContent),
  semanticCode: 'FR-Freeze-What-Baseline-002',
  createdAt: CREATED_AT,
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: frContent,
};

/* ------------------------------------------------------------------ */
/* RT trace                                                             */
/* ------------------------------------------------------------------ */

const resolveId = (id) => {
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (id === 'FR-Freeze-What-Baseline-Reviewer-002') return sha(frContent);
  if (id === 'VV-Freeze-What-Baseline-002') return sha(vvContent);
  if (id === 'UH-Freeze-What-Baseline-001') return holdArt.contentDigest;
  if (id === 'RC-Freeze-What-Baseline-001') return rcConf.contentDigest;
  if (id === 'RT-RC-Freeze-What-Baseline-001') return rcTrc.contentDigest;
  if (id === 'AS-Freeze-What-Baseline-001') return asConf.contentDigest;
  if (id === 'import:discovery-handoff') return importArt.contentDigest;
  if (id === 'cert:discovery-capsule') return certDigest;
  if (id === 'FR-Reconcile-What-001') return frRw.contentDigest;
  if (id === 'FR-Reconcile-What-002') return frRwB.contentDigest;
  if (id === 'VV-Reconcile-What-001') return vvRw.contentDigest;
  if (id === 'RT-Reconcile-What-001') return rtRw.contentDigest;
  if (id === 'FS-Reconcile-What-002') return fsRw2.contentDigest;
  if (id === 'CL-Reconcile-What-001') return clRw.contentDigest;
  if (id === 'FS-Reconcile-What-001') return rwSub.contentDigest;
  if (id === 'link:define-product-intent') return intentArt.contentDigest;
  if (id === 'link:model-use-cases') return ucArt.contentDigest;
  if (id === 'link:derive-system-requirements') return srArt.contentDigest;
  if (id === 'link:define-acceptance-contract') return acArt.contentDigest;
  if (id === 'link:reconcile-what') return rwArt.contentDigest;
  if (id === 'UH-Define-Acceptance-Contract-001') return uhAc.contentDigest;
  if (id === 'FR-Define-Acceptance-Contract-002') return frAc2.contentDigest;
  if (id === 'fixture:what-baseline-green') return CLAIMED.address;
  if (id === 'schema:what-baseline') return schemaRawDigest;
  throw new Error(`trace id ${id} does not resolve to a recomputed digest`);
};
const rel = (fromId, relation, toId, description) => ({
  fromId,
  relation,
  toId,
  description,
  fromRef: shaRef(resolveId(fromId)),
  toRef: shaRef(resolveId(toId)),
});
const S = 'FR-Freeze-What-Baseline-Reviewer-002';
const relationships = [
  ...Object.keys(ENVELOPE).map((id) => rel(S, 'verifies', id, `This review's envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection.`)),
  rel(S, 'verifies', 'UH-Freeze-What-Baseline-001', 'The author-seat hold of record re-derives byte-stable; verdict hold-upheld recorded by this review.'),
  rel(S, 'observes', 'RC-Freeze-What-Baseline-001', "The desk's first reviewer-stage record: hold-upheld-no-candidate-to-review; adjudicated the frame claim UNRESOLVABLE at qualification-tree scope and NOT ratified. Disposition carried forward; its resolution finding is superseded by this workspace-wide scan."),
  rel(S, 'observes', 'RT-RC-Freeze-What-Baseline-001', 'The confirmation trace (26 edges, 4-term vocabulary incl. confirms/carries_forward).'),
  rel(S, 'observes', 'AS-Freeze-What-Baseline-001', 'The author re-staff confirmation: standing hold carried, workspace-wide movement scan found 0 new accepted lineage.'),
  rel(S, 'observes', 'import:discovery-handoff', 'The accepted discovery import chain; still the only accepted base on this chain.'),
  rel(S, 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel(S, 'observes', 'fixture:what-baseline-green', 'The frame upstream-accepted[0] claim resolves here and is REFUSED as acceptance authority (contract-suite green fixture; CRIT-1/CRIT-2).'),
  rel(S, 'observes', 'schema:what-baseline', 'The freeze payload contract (raw sha256 ab1b7f5e...): acceptanceRecords minItems 5 - the direct lawful-authoring blocker.'),
  rel(S, 'observes', 'FR-Reconcile-What-001', 'The gate verdict of record: repair, with the explicit no-accept prohibition toward this desk.'),
  rel(S, 'observes', 'FR-Reconcile-What-002', 'The gate emission-B review; also recomputes to repair.'),
  rel(S, 'observes', 'VV-Reconcile-What-001', 'The gate reviewer verification of record.'),
  rel(S, 'observes', 'RT-Reconcile-What-001', 'The gate reviewer trace of record.'),
  rel(S, 'observes', 'FS-Reconcile-What-002', 'The gate reviewer submission of record (RA-1..RA-5 routing).'),
  rel(S, 'observes', 'CL-Reconcile-What-001', 'The gate collision record: emission A is the round of record.'),
  rel(S, 'observes', 'FS-Reconcile-What-001', 'The gate author candidate of record; NOT settled.'),
  rel(S, 'observes', 'link:define-product-intent', 'Pre-freeze desk 1: repair x3, no reissue; NOT accepted.'),
  rel(S, 'observes', 'link:model-use-cases', 'Pre-freeze desk 2: never reviewed at its own content address; NOT accepted.'),
  rel(S, 'observes', 'link:derive-system-requirements', 'Pre-freeze desk 3: repair + held reviewer seat; NOT accepted.'),
  rel(S, 'observes', 'link:define-acceptance-contract', 'Pre-freeze desk 4: adjudicated repair (CTN-001); NOT accepted.'),
  rel(S, 'observes', 'link:reconcile-what', 'Pre-freeze desk 5 (the gate): repair verdict of record; NOT accepted.'),
  rel(S, 'observes', 'UH-Define-Acceptance-Contract-001', 'The standing upstream hold of the acceptance desk.'),
  rel(S, 'observes', 'FR-Define-Acceptance-Contract-002', 'The adjudicating emission C of the acceptance desk (repair confirmed).'),
];
const rtContent = {
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  traceKind: 'reviewer-refusal-trace',
  subjectSemanticCode: 'FR-Freeze-What-Baseline-002',
  subjectArtifactRef: fr.artifactRef,
  verificationRef: shaRef(vv.contentDigest),
  relationVocabulary: ['observes', 'verifies'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: ['FR-Freeze-What-Baseline-Reviewer-002'] }])),
  claimedAcceptanceCoverage: {
    'upstream-accepted[0]': {
      address: shaRef(CLAIMED.address),
      resolution: 'resolved-to-fixture',
      resolvedPath: FIXTURE_REL,
      adjudication: 'REFUSED as acceptance authority (CRIT-1/CRIT-2)',
      verifiedBy: ['FR-Freeze-What-Baseline-Reviewer-002'],
    },
  },
  holdCoverage: {
    verdict: 'hold-upheld',
    freezeRatified: false,
    noProductAuthored: true,
    preFreezeDesksAccepted: 0,
    preFreezeDesksRequired: 5,
    unacceptedLinks: ['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements', 'link:define-acceptance-contract', 'link:reconcile-what'],
    onlyAcceptedChain: 'import:discovery-handoff',
    gateVerdictOfRecord: 'FR-Reconcile-What-001 (repair)',
    explicitProhibition: 'No domain.accepted may fire from this desk toward freeze-what-baseline on this chain.',
    prohibitionDischarged: false,
  },
  branchResolutionNote: 'No scenario, branch, requirement, criterion, container or baseline identities are authored by this review; all observed links resolve at record/artifact granularity.',
  workspaceSummary: `frame claim "${CLAIMED.workspaceSummary}" adjudicated FALSE; recomputed truth: 0 accepted upstream revisions travel by content address on this chain (the one resolving address is a contract-suite fixture, refused as acceptance authority)`,
};
const rt = {
  traceRef: shaRef(sha(rtContent)),
  traceKind: 'reviewer-refusal-trace',
  contentDigest: sha(rtContent),
  semanticCode: 'RT-Freeze-What-Baseline-002',
  createdAt: CREATED_AT,
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: rtContent,
};

/* ------------------------------------------------------------------ */
/* FS product submission (product_submit; intake receipt)               */
/* ------------------------------------------------------------------ */

const evidence = [
  ...Object.entries(ENVELOPE).map(([id, d]) => ({
    ref: shaRef(d),
    kind: id.startsWith('claim:') ? 'source-claim' : id.startsWith('constraint:') ? 'constraint' : id.startsWith('unknown:') ? 'unknown' : 'terminal-claim',
  })),
  { ref: shaRef(importArt.contentDigest), kind: 'accepted-import' },
  { ref: shaRef(certDigest), kind: 'discovery-certificate' },
  { ref: shaRef(holdArt.contentDigest), kind: 'upstream-hold' },
  { ref: shaRef(holdTrc.contentDigest), kind: 'upstream-hold-trace' },
  { ref: shaRef(rwArt.contentDigest), kind: 'gate-author-product' },
  { ref: shaRef(rwTrc.contentDigest), kind: 'gate-author-trace' },
  { ref: shaRef(rwSub.contentDigest), kind: 'gate-author-submission' },
  { ref: shaRef(frRw.contentDigest), kind: 'gate-formalization-review' },
  { ref: shaRef(frRwB.contentDigest), kind: 'gate-formalization-review-emission-b' },
  { ref: shaRef(vvRw.contentDigest), kind: 'gate-reviewer-verification' },
  { ref: shaRef(rtRw.contentDigest), kind: 'gate-reviewer-trace' },
  { ref: shaRef(fsRw2.contentDigest), kind: 'gate-reviewer-submission' },
  { ref: shaRef(clRw.contentDigest), kind: 'gate-reviewer-collision-record' },
  { ref: shaRef(intentArt.contentDigest), kind: 'consumed-revision-under-repair' },
  { ref: shaRef(ucArt.contentDigest), kind: 'consumed-revision-unaccepted' },
  { ref: shaRef(srArt.contentDigest), kind: 'consumed-revision-under-repair' },
  { ref: shaRef(acArt.contentDigest), kind: 'consumed-revision-under-repair' },
  { ref: shaRef(uhAc.contentDigest), kind: 'upstream-hold' },
  { ref: shaRef(frAc2.contentDigest), kind: 'confirmed-repair-review' },
  { ref: shaRef(schemaRawDigest), kind: 'payload-contract-schema' },
  { ref: shaRef(CLAIMED.address), kind: 'adjudicated-claim-content' },
  { ref: shaRef(rcConf.contentDigest), kind: 'reviewer-confirmation' },
  { ref: shaRef(rcTrc.contentDigest), kind: 'reviewer-confirmation-trace' },
  { ref: shaRef(asConf.contentDigest), kind: 'author-restaff-confirmation' },
  { ref: fr.artifactRef, kind: 'formalization-review-of-record' },
  { ref: rt.traceRef, kind: 'reviewer-refusal-trace-of-record' },
  { ref: shaRef(vv.contentDigest), kind: 'reviewer-verification' },
];
const coverage = {};
for (const e of evidence) coverage[e.kind] = (coverage[e.kind] || 0) + 1;
expect(Object.values(coverage).reduce((a, b) => a + b, 0) === evidence.length, 'evidence coverage sum drift');
expect(evidence.every((e) => /^sha256:[0-9a-f]{64}$/.test(e.ref)), 'an evidence ref is not a well-formed sha256 content address');
expect(evidence.length === new Set(evidence.map((e) => e.ref)).size, 'an evidence ref is duplicated');

const fsContent = {
  deskRef: 'freeze-what-baseline',
  deskNodeId: 'freeze-what-baseline',
  role: 'reviewer',
  reviewedRound: SELF_ROUND,
  workspaceSummary: rtContent.workspaceSummary,
  verdict: 'hold-upheld',
  candidate: {
    kind: 'formalization.review-complete.v1',
    artifactRef: fr.artifactRef,
    contentDigest: fr.contentDigest,
  },
  reviewedCandidate: {
    artifactRef: shaRef(holdArt.contentDigest),
    traceRef: shaRef(holdTrc.contentDigest),
    productKind: 'formalization.upstream-hold.v1',
    declaredDecision: 'hold-no-authoring',
  },
  verificationRef: shaRef(vv.contentDigest),
  traceRef: rt.traceRef,
  payloadContract: {
    productKind: 'formalization.review-complete.v1',
    effectId: 'formalization.freeze-what-baseline',
    effectFired: false,
    requiredEvidenceRefs: evidence.map((e) => e.ref),
    evidenceKindCoverage: coverage,
    terminalOutcome: 'hold-ratified-freeze-refused',
  },
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#freeze-what-baseline:reviewer',
    status: 'review_complete_verdict_recorded',
    receivedFrom: 'reviewer',
    nextStage: 'hold-upheld: no freeze effect on this chain; the frame upstream-accepted[0] claim is refused (fixture-misdeclared-as-accepted-revision); resume contract R1-R4 unchanged and the RA-5 re-run reviewer verdict of record alone can discharge the no-accept prohibition',
    note: 'The r3 author hold re-verifies byte-stable; the recomputed census is 0 of 5 and the freeze contract remains unsatisfiable. Kernel-side routing is executed by the driver over public commands.',
  },
  acceptanceCriteriaSelfCheck: frContent.acceptanceCriteria.map((a) => ({ id: a.id, description: a.description, satisfied: a.satisfied })),
};
const fsRecord = {
  submissionRef: shaRef(sha(fsContent)),
  submissionId: 'FS-Freeze-What-Baseline-Reviewer-001',
  contentDigest: sha(fsContent),
  createdAt: CREATED_AT,
  deskRef: 'freeze-what-baseline',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: fsContent,
};

/* ------------------------------------------------------------------ */
/* Write                                                                */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('freeze-what-baseline-desk-reviewer-verification.json', vv);
writeJson('freeze-what-baseline-desk-reviewer-review.json', fr);
writeJson('freeze-what-baseline-desk-reviewer-trace.json', rt);
writeJson('freeze-what-baseline-desk-reviewer-product-submission.json', fsRecord);

console.log(JSON.stringify({
  built: 'freeze-what-baseline desk (reviewer) refusal emission',
  reviewRef: fr.artifactRef,
  verificationRef: vv.artifactRef,
  traceRef: rt.traceRef,
  submissionRef: fsRecord.submissionRef,
  verdict: frContent.verdict,
  claimedAddressResolvedTo: FIXTURE_REL,
  checks: `${passCount}/${checks.length}`,
  scanFiles: SCAN.files,
}, null, 2));
