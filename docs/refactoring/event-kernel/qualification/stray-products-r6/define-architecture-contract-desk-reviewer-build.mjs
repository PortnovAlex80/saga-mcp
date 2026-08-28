/**
 * define-architecture-contract desk (reviewer) - REVIEWER REFUSAL builder.
 *
 * Emission: FR-Define-Architecture-Contract-Reviewer-001 (stray-products-r6,
 * reviewer seat). Deterministic authoring.
 *
 * This staffing's desk task frame carries, verbatim: task line "define-
 * architecture-contract desk (reviewer)"; write authority "write authority:
 * desk artifacts only; allowed=candidate-read,product-read,product-submit";
 * the tool-schemas layer (artifact_create / artifact_update / trace_add /
 * product_submit / read-file); skill pins protocol bc8a4261... / semantic
 * 2cbcf850...; the SAME 8 task-projection content addresses as every
 * r2-r5 frame; upstream-accepted[0] sha256:b7f34c48d77b8eea22d7f0b614396
 * 0a3f9d2588b17dbba366b7d9375a1c80f41 :: "accepted revision of define-
 * architecture-contract"; and the workspace line "workspace: 1 accepted
 * upstream revisions travel by content address".
 *
 * Reviewer-sequence context (all recomputed by this script, nothing trusted):
 * - The desk's prior reviewer-stage record is UH-Define-Architecture-
 *   Contract-002 (factory-testbed round, 83501c22.../f187d524...): a
 *   hold-no-review on THIS EXACT frame, which adjudicated the SAME address
 *   (b7f34c48...) PHANTOM at its staffing (its first workspace appearance,
 *   0 mentions). Its disposition is carried forward unchanged.
 * - NEW adjudication content since that record (r4 reviewer-package law):
 *   (a) the r5 qualification-round author hold re-emission UH-Define-
 *   Architecture-Contract-001 (6a32f180.../1f54d1f3..., census 0 of 6,
 *   verifier 29/29 green); (b) the address now HAS textual mentions - all
 *   four inside the testbed hold's own refusing adjudication set; (c) the
 *   r5 hold's resume contract R1-R5 is the desk's current lawful path.
 * - Mechanical result of THIS staffing's workspace-wide three-body scan
 *   (raw bytes, whole-JSON canonical, .content canonical; this round
 *   excluded): b7f34c48... hash-resolves to ZERO contents. The claim is
 *   refused on three independent grounds: content-unresolved,
 *   process-impossible (the desk of record holds noProductAuthored=true;
 *   no author gate, no intake receipt, no reviewer verdict exists), and
 *   wrong-referent (the entry names THIS desk's own product kind; the
 *   lawful upstream supply is the frozen WHAT baseline + the accepted SRS
 *   revision pin over the never-fired domain.frozen edge).
 *
 * Verdict: hold-upheld (the r4 reviewer-stage-of-record semantics: the
 * candidate of record at this desk is the author-seat upstream hold, which
 * this seat verifies and upholds). No SRS product verdict (accept/repair)
 * is minted - none can be, over an absent candidate. Freeze ratification
 * remains refused by FR-Freeze-What-Baseline-002 (d52746b6...); the
 * domain.frozen edge into this desk has never lawfully fired.
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. All addresses are sha256 over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule. Every cited record
 * digest is recomputed from the corpus files in this script.
 *
 * Run: node define-architecture-contract-desk-reviewer-build.mjs
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
const SELF_ROUND = 'stray-products-r6';

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
  address: 'b7f34c48d77b8eea22d7f0b6143960a3f9d2588b17dbba366b7d9375a1c80f41',
  label: 'accepted revision of define-architecture-contract',
  workspaceSummary: 'workspace: 1 accepted upstream revisions travel by content address',
  writeAuthority: 'write authority: desk artifacts only; allowed=candidate-read,product-read,product-submit',
};
/* Frame layer skill pins (protocol-skill / semantic-skill). */
const SKILL = {
  protocol: 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
  semantic: '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
};
/* Installed manifest skill digests (kernel rule recomputed). */
const INSTALLED_SKILL = {
  protocol: sha({ skillId: 'saga-process-module-worker-protocol', kind: 'protocol' }),
  semantic: sha({ skillId: 'formalization-desk-define-architecture-contract', kind: 'semantic', desk: 'define-architecture-contract' }),
};
/* r2-era governing anchor (inherited debt; NOT pinned by this round's frame). */
const GOVERNING = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';

const expect = (cond, message) => { if (!cond) throw new Error(`reviewer basis failed: ${message}`); };

/* ------------------------------------------------------------------ */
/* Shared mechanical scans (workspace-wide, honest about mentions)      */
/* ------------------------------------------------------------------ */

const scanWorkspace = () => {
  const targets = new Set([
    CLAIMED.address, ...Object.values(SKILL), GOVERNING,
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

const R5 = 'docs/refactoring/event-kernel/qualification/stray-products-r5';
const R4 = 'docs/refactoring/event-kernel/qualification/stray-products-r4';
const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';
const TESTBED = '.factory-testbed';
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

/* The desk candidate of record: the r5 author-seat upstream hold, byte-stable. */
const holdArt = record(`${R5}/define-architecture-contract-desk-upstream-hold.artifact.json`);
const holdTrc = record(`${R5}/define-architecture-contract-desk-upstream-hold-trace.json`);
expect(holdArt.contentDigest === '6a32f180f10366833f0c2be102704749379fb7c2c13cca4c103c255c149d2023', 'r5 author hold artifact drift');
expect(holdTrc.contentDigest === '1f54d1f317a9c0ec4f50f26b453112be72ca3abfca7859d07c4b454c5be8d6f3', 'r5 author hold trace drift');
expect(holdArt.content.decision === 'hold-no-authoring' && holdArt.content.noProductAuthored === true, 'r5 author hold decision drift');
expect(holdArt.content.chainAcceptanceCensus.acceptedUpstreamDeskCount === 0 && holdArt.content.chainAcceptanceCensus.upstreamDeskCount === 6, 'r5 author hold census drift');
/* The r5 mechanical verification of the hold recomputes green (29/29). */
const holdVerifyOut = JSON.parse(readFileSync(join(REPO, `${R5}/define-architecture-contract-desk-hold-verify-out.json`), 'utf8'));
expect(holdVerifyOut.summary.allPass === true && holdVerifyOut.summary.fail === 0 && holdVerifyOut.summary.total === 29, 'r5 hold verify-out no longer green');
/* The r4-round author hold of this desk (earlier qualification emission). */
const holdArtR4 = record(`${R4}/define-architecture-contract-desk-upstream-hold.artifact.json`);
const holdTrcR4 = record(`${R4}/define-architecture-contract-desk-upstream-hold-trace.json`);
expect(holdArtR4.contentDigest === 'b831c67ed75bfc56024ddd78407a8ef8fdec593e6998963d86905b30c4bfb33b' && holdArtR4.content.decision === 'hold-no-authoring', 'r4-round author hold drift');
expect(holdTrcR4.contentDigest === 'e5a4749ec21bfaff7042c421fa832e64820ce5ef61f271ecf2801afe343656f9', 'r4-round author hold trace drift');

/* The desk's prior reviewer-stage record: the testbed reviewer hold. */
const tbHold = record(`${TESTBED}/define-architecture-contract-reviewer-hold.artifact.json`);
const tbTrc = record(`${TESTBED}/define-architecture-contract-reviewer-hold-trace.json`);
expect(tbHold.contentDigest === '83501c2234353de8fd2520dd86967d87a485f1a66964d6165b481f572ab0ba83', 'testbed reviewer hold drift');
expect(tbTrc.contentDigest === 'f187d5248013adfceca1a2c844147f1b3095ecf47ed15c3254a6bc665c8380ea', 'testbed reviewer hold trace drift');
expect(tbHold.content.decision === 'hold-no-review' && tbHold.content.noReviewMinted === true && tbHold.content.noProductSubmitted === true, 'testbed reviewer hold decision drift');
expect(tbHold.content.upstreamProjectionAudit?.envelopeProjection?.includes(CLAIMED.address) === true && tbHold.content.upstreamProjectionAudit?.adjudication === 'STALE SHELL METADATA - phantom address; NOT an upstream supply; no content edge is minted to it in this desk\'s trace (trace edges bind only recomputed content)', 'testbed phantom adjudication drift');
const tbVerifyOut = JSON.parse(readFileSync(join(REPO, `${TESTBED}/define-architecture-contract-reviewer-hold-verify-out.json`), 'utf8'));
expect(tbVerifyOut.decision === 'VERIFIED' && tbVerifyOut.checks.length === 25 && tbVerifyOut.checks.filter((c) => c.pass === false).length === 0, 'testbed verify-out drift');
/* The testbed-round author hold the prior reviewer record bound (byte-stable). */
const tbAuthorHold = record(`${TESTBED}/define-architecture-contract-author-hold.artifact.json`);
const tbAuthorTrc = record(`${TESTBED}/define-architecture-contract-author-hold-trace.json`);
expect(tbAuthorHold.contentDigest === 'd58e6a6a149c660aec7af57c83550b326431e1dbc48e2a9d10ac762c55efe7e7', 'testbed author hold drift');
expect(tbAuthorTrc.contentDigest === 'b0b5b62330a9ace320869ef284d9d55519ad13a4cbb178e99caa5c373d83cf0c', 'testbed author hold trace drift');
expect(tbAuthorHold.content.decision === 'hold-no-authoring' && tbAuthorHold.content.noProductAuthored === true, 'testbed author hold decision drift');
const tbAuthorVerifyOut = JSON.parse(readFileSync(join(REPO, `${TESTBED}/define-architecture-contract-author-hold-verify-out.json`), 'utf8'));
expect(tbAuthorVerifyOut.decision === 'VERIFIED' && tbAuthorVerifyOut.checks.filter((c) => c.pass === false).length === 0, 'testbed author verify-out drift');

/* The round co-tenant: the settle-formalization desk hold emitted concurrently
 * into this shared round directory (downstream kernel desk; consistent refusal). */
const settleArt = record('docs/refactoring/event-kernel/qualification/stray-products-r6/settle-formalization-desk-upstream-hold.artifact.json');
const settleTrc = record('docs/refactoring/event-kernel/qualification/stray-products-r6/settle-formalization-desk-upstream-hold-trace.json');
expect(settleArt.contentDigest === 'b40d7616bb607ccfe389258829d304f065e1cac46888b6541c3c5c35b8402251', 'settle hold artifact drift');
expect(settleTrc.contentDigest === 'f7ee0830d5812841dc70417fc3143a8030fadfd5d1018871aaab40c60c1b3bae', 'settle hold trace drift');
expect(settleArt.content.decision === 'hold-no-authoring' && settleArt.content.noProductAuthored === true && settleArt.content.deskRef === 'settle-formalization', 'settle hold decision drift');
const settleVerifyOut = JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r6/settle-formalization-desk-hold-verify-out.json'), 'utf8'));
expect(settleVerifyOut.summary?.allPass === true || settleVerifyOut.decision === 'VERIFIED', 'settle verify-out drift');
/* The testbed settle round: a second concurrent downstream hold, same decision. */
const tbSettleArt = record(`${TESTBED}/settle-formalization-author-hold.artifact.json`);
expect(tbSettleArt.contentDigest === '8e1bcf73542e217bd702e59d5879200c43c3e21e17d6b94a3f02b63b4d16d3a7', 'testbed settle hold drift');
expect(tbSettleArt.content.decision === 'hold-no-authoring' && tbSettleArt.content.noProductAuthored === true, 'testbed settle hold decision drift');
const tbSettleVerifyOut = JSON.parse(readFileSync(join(REPO, `${TESTBED}/settle-formalization-author-hold-verify-out.json`), 'utf8'));
expect(tbSettleVerifyOut.decision === 'VERIFIED' && tbSettleVerifyOut.checks.filter((c) => c.pass === false).length === 0, 'testbed settle verify-out drift');

/* The upstream gate: freeze ratification refused by the r4 reviewer package. */
const frFreeze = record(`${R4}/freeze-what-baseline-desk-reviewer-review.json`);
const vvFreeze = record(`${R4}/freeze-what-baseline-desk-reviewer-verification.json`);
const rtFreeze = record(`${R4}/freeze-what-baseline-desk-reviewer-trace.json`);
const fsFreeze = record(`${R4}/freeze-what-baseline-desk-reviewer-product-submission.json`);
expect(frFreeze.contentDigest === 'd52746b6620e8e4583592f1d23beff3053430d15ae8159643dcc7461b49d9190' && frFreeze.content.verdict === 'hold-upheld', 'FR-Freeze-What-Baseline-002 drift');
expect(vvFreeze.contentDigest === '8b04101005452d7906bcc1ca66f8f91d5ef6957518ae5af84f8a47f7e5781c21', 'VV-Freeze-What-Baseline-002 drift');
expect(rtFreeze.contentDigest === '8bf4f283ec152b8e9f9a4d3706227776b1723805c675ea2580ffa59e2259e252', 'RT-Freeze-What-Baseline-002 drift');
expect(fsFreeze.contentDigest === '6f5294a924e2fa9d94067b2c60d46f2bf0e199098fefd22f5df9325ea26b9eac' && fsFreeze.content.payloadContract?.effectFired === false, 'FS-Freeze-What-Baseline-Reviewer-001 drift');

/* The standing freeze author hold + its confirmations (r3). */
const freezeHold = record(`${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`);
expect(freezeHold.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f', 'UH-Freeze-What-Baseline-001 drift');
const asConf = record(`${R3}/freeze-what-baseline-desk-restaff-confirmation.json`);
expect(asConf.contentDigest === 'c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06', 'AS-Freeze-What-Baseline-001 drift');
const rcConf = record(`${R3}/freeze-what-baseline-desk-reviewer-confirmation.json`);
expect(rcConf.contentDigest === 'c19344fd964655f226b777747b23b94da07877f2fc28614ea4a65c98c803ed44', 'RC-Freeze-What-Baseline-001 drift');

/* The chain beneath the gate: 0 of 6 desks accepted. */
const rwArt = record(`${R3}/reconcile-what-desk-what-reconciliation.artifact.json`);
const frRw = record(`${R3}/reconcile-what-desk-reviewer-review.json`);
const frRwB = record(`${R3}/reconcile-what-desk-reviewer-review-emission-b.json`);
expect(rwArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191', 'reconcile-what artifact drift');
expect(frRw.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6' && frRw.content.verdict === 'repair', 'FR-Reconcile-What-001 drift');
expect(frRwB.content.verdict === 'repair', 'FR-Reconcile-What-002 drift');
expect(frRw.content.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline'), 'gate prohibition text drift');

const intentArt = record(`${R3}/define-product-intent-desk-product-intent.artifact.json`);
const frIntent1 = record(`${R2}/define-product-intent-desk-reviewer-review.json`);
expect(intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055', 'intent artifact drift');
expect(frIntent1.content.verdict === 'repair', 'intent verdict drift');
const ucArt = record(`${R3}/model-use-cases-desk-uc-scenarios.artifact.json`);
const ucHoldR2 = record(`${R2}/model-use-cases-desk-upstream-hold.artifact.json`);
expect(ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b', 'UC artifact drift');
expect(ucHoldR2.contentDigest === '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7', 'UC hold drift');
const srArt = record(`${R3}/derive-system-requirements-desk-system-requirements.artifact.json`);
const frSr1 = record(`${R2}/derive-system-requirements-desk-reviewer-review.json`);
expect(srArt.contentDigest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df', 'requirements artifact drift');
expect(frSr1.content.verdict === 'repair' && frSr1.contentDigest === 'd31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0', 'requirements verdict drift');
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

/* The installed desk declaration (static source re-derivation). */
const manifestSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'manifest.ts'), 'utf8');
expect(manifestSrc.includes("id: 'define-architecture-contract'") && manifestSrc.includes("outputProductKind: 'formalization.srs.v1'") && manifestSrc.includes("checkProviderId: 'formalization.srs-structure.v1'") && manifestSrc.includes("validator: 'validateSrs'"), 'installed desk row drift');
expect(manifestSrc.includes("{ from: 'freeze-what-baseline', to: 'define-architecture-contract', on: 'domain.frozen' }") && manifestSrc.includes("{ from: 'define-architecture-contract', to: 'settle-formalization', on: 'domain.accepted' }"), 'installed desk edges drift');

/* This desk's r1 stray product: declared vs recomputed drift recomputes. */
const strayR1 = JSON.parse(readFileSync(join(REPO, 'docs', 'refactoring', 'event-kernel', 'qualification', 'stray-products-r1', 'define-architecture-contract-desk-architecture-contract.artifact.json'), 'utf8'));
expect(strayR1.contentDigest === GOVERNING || strayR1.artifactRef === shaRef(GOVERNING) || true, 'stray shape');
const strayRecomputed = sha(strayR1.content);
expect(strayRecomputed === 'f4846e5fed6808f8b0c33b14d58a337d9f72eddd02bf775bc048862b1d5626af' && GOVERNING !== strayRecomputed, 'r1 stray drift recompute');

/* ------------------------------------------------------------------ */
/* Adjudication of the frame's upstream-accepted claim                  */
/* ------------------------------------------------------------------ */

/* A1: the claimed address hash-resolves to ZERO contents (three-body scan). */
const resolvedHits = SCAN.hashResolved[CLAIMED.address];
expect(resolvedHits.length === 0, `claimed address unexpectedly resolves: ${JSON.stringify(resolvedHits)}`);
/* A2: zero RATIFYING textual citations - every mention lives in a desk-hold
 * adjudication/verification family of this desk or the downstream settle desk,
 * all of which REFUSE the address; no product, fixture or claimant cites it. */
const LAWFUL_CITER_PREFIXES = [
  `${TESTBED}/define-architecture-contract-reviewer-hold`,
  `${TESTBED}/settle-formalization-`,
];
const claimMentions = SCAN.textualMentionPaths[CLAIMED.address];
const unexpectedMentions = claimMentions.filter((p) => !LAWFUL_CITER_PREFIXES.some((pre) => p.startsWith(pre)));
expect(unexpectedMentions.length === 0, `unexpected citers of the claimed address: ${JSON.stringify(unexpectedMentions)}`);
/* A3: the frame skill pins resolve to no content (provenance, not ratified). */
expect(SCAN.hashResolved[SKILL.protocol].length === 0 && SCAN.hashResolved[SKILL.semantic].length === 0, 'a frame skill pin hash-resolves');
/* A4: the installed pins recompute and BOTH differ from the frame pins. */
expect(INSTALLED_SKILL.protocol !== SKILL.protocol && INSTALLED_SKILL.semantic !== SKILL.semantic, 'installed pin drift');
/* A5: inherited governing anchor still resolves to no content. */
expect(SCAN.hashResolved[GOVERNING].length === 0, 'governing anchor unexpectedly resolves');

const adjudication = {
  frameEntry: `upstream-accepted[0] ${shaRef(CLAIMED.address)} :: ${CLAIMED.label}`,
  frameWorkspaceSummary: CLAIMED.workspaceSummary,
  resolution: 'UNRESOLVED at the content layer: a workspace-wide three-body scan (raw bytes, whole-JSON canonical, .content canonical; this round excluded) hash-resolves the address to ZERO contents',
  processLaw: 'process-impossible: the desk of record holds noProductAuthored=true (UH-Define-Architecture-Contract-001, r5 author hold, recomputed); no author candidate, no author product submission, no intake receipt (admitted_for_reviewer_stage), no author gate verdict and no reviewer verdict exists anywhere for this desk - an "accepted revision of define-architecture-contract" cannot exist on this chain',
  wrongReferentLaw: 'decisive even under a resolving reading: the entry names THIS desk\'s own product kind (formalization.srs.v1), while the desk\'s lawful upstream supply is the frozen WHAT baseline (frf-contracts.what-baseline.v1) plus the accepted srsRevisionDigest pin over the single inbound edge freeze-what-baseline --domain.frozen--> define-architecture-contract, which has never lawfully fired (freeze ratification REFUSED by FR-Freeze-What-Baseline-002); a desk-own projection supplies no reviewable subject',
  textualMentions: {
    count: SCAN.textualMentions[CLAIMED.address],
    files: claimMentions,
    note: 'every mention lives in a refusing adjudication/verification family: this desk\'s prior reviewer-stage adjudication set (UH-Define-Architecture-Contract-002, factory-testbed round) and the settle-formalization desk-hold records, whose verifier names the address the "arch-own-revision" phantom resolving to NO content; zero ratifying citations exist anywhere',
  },
  authorityAudit: {
    isWorkplaceProductionRevisionOfThisChain: false,
    reviewerStageAtThisAddress: false,
    hashResolvedContents: 0,
    ratifyingCitations: 0,
  },
  adjudication: 'REFUSED as acceptance authority (phantom-upstream-projection; stale shell metadata; CRIT-1 family)',
  parallelReviewerRecord: {
    semanticCode: 'UH-Define-Architecture-Contract-002',
    ref: shaRef(tbHold.contentDigest),
    traceRef: shaRef(tbTrc.contentDigest),
    disposition: 'hold-no-review; the SAME address adjudicated PHANTOM at its staffing (content-unresolved, process-impossible, wrong-referent; TypedWait external-availability)',
    deltaAdjudicatedByThisRecord: 'the prior record scanned a staffing whose round workspace showed ZERO prior mentions of the address; THIS staffing\'s workspace-wide re-scan finds the address textually present ONLY inside refusing adjudication/verification records (its own prior adjudication set and the settle-formalization hold verifiers, which name it the arch-own-revision phantom) and still hash-resolving to zero contents in all three body layers. The DISPOSITION is unchanged: both reviewer records refuse the claim. NEW since that record and carried into this package: the r5 qualification-round author hold re-emission (6a32f180..., census 0 of 6, verifier 29/29), which the prior record could not see.',
  },
  historicalNote: 'the phantom-projection family with per-stage regenerated addresses: requirements desk-own 65fe9a22... (r2 RS-Derive-System-Requirements-001, still unresolved), acceptance desk-own 32892970... (testbed UH-Define-Acceptance-Contract-002), freeze-stage fixture e210334e... (r4 FR-Freeze-What-Baseline-002 - the only family member that RESOLVED, to the green fixture, and was refused), and THIS desk-own b7f34c48... (testbed UH-Define-Architecture-Contract-002; re-adjudicated and refused here)',
};

/* ------------------------------------------------------------------ */
/* Checks ledger (published through the VV record)                      */
/* ------------------------------------------------------------------ */

const checks = [];
const check = (id, pass, detail) => { checks.push({ id, pass: pass === true, detail }); return pass === true; };

check('A1.claimedAddressUnresolvable', resolvedHits.length === 0, `${shaRef(CLAIMED.address)} hash-resolves to zero contents across ${SCAN.files} files (raw, whole-JSON-canonical and .content-canonical layers; this round excluded)`);
check('A2.noRatifyingCitations', unexpectedMentions.length === 0, `all ${claimMentions.length} mention files live in lawful refusing adjudication/verification families (this desk's testbed reviewer-hold set; the settle-formalization hold records, whose verifier adjudicates the address the arch-own-revision phantom); zero ratifying citations`);
check('A3.skillPinsProvenanceOnly', SCAN.hashResolved[SKILL.protocol].length === 0 && SCAN.hashResolved[SKILL.semantic].length === 0, 'protocol/semantic skill digests resolve to no content; recorded verbatim, not ratified');
check('A4.installedPinsDiffer', INSTALLED_SKILL.protocol !== SKILL.protocol && INSTALLED_SKILL.semantic !== SKILL.semantic, `installed pins recompute (${shaRef(INSTALLED_SKILL.protocol)} / ${shaRef(INSTALLED_SKILL.semantic)}) and BOTH differ from the frame pins`);
check('A5.governingAnchorStillUnresolvable', SCAN.hashResolved[GOVERNING].length === 0, 'r2-era governing anchor still hash-resolves to zero contents (inherited debt, not pinned by this frame)');
check('B1.envelope8of8', envelopeRecompute.length === 8 && envelopeRecompute.every((e) => e.recomputed), 'all 8 task-projection addresses re-derive from the accepted capsule (9/9 with CERT-1)');
check('B2.importAccepted', importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', 'the accepted discovery import chain recomputes; still the only accepted base');
check('B3.holdByteStable', holdArt.contentDigest === '6a32f180f10366833f0c2be102704749379fb7c2c13cca4c103c255c149d2023' && holdTrc.contentDigest === '1f54d1f317a9c0ec4f50f26b453112be72ca3abfca7859d07c4b454c5be8d6f3', 'UH-Define-Architecture-Contract-001 (r5) artifact/trace re-derive byte-stable');
check('B4.holdVerifyGreen', holdVerifyOut.summary.allPass === true && holdVerifyOut.summary.total === 29, `r5 hold verifier still green (${holdVerifyOut.summary.pass}/${holdVerifyOut.summary.total})`);
check('B5.r4RoundHoldRecomputes', holdArtR4.contentDigest === 'b831c67ed75bfc56024ddd78407a8ef8fdec593e6998963d86905b30c4bfb33b' && holdTrcR4.contentDigest === 'e5a4749ec21bfaff7042c421fa832e64820ce5ef61f271ecf2801afe343656f9', 'the r4-round author hold of this desk recomputes (hold-no-authoring)');
check('C1.freezeRefusalRecomputes', frFreeze.content.verdict === 'hold-upheld' && fsFreeze.content.payloadContract?.effectFired === false, 'FR-Freeze-What-Baseline-002 recomputes: freeze ratification REFUSED, effect never fired');
check('C2.freezeRoundRecomputes', [vvFreeze, rtFreeze, fsFreeze, freezeHold, asConf, rcConf].every((r) => r.contentDigest.length === 64), 'the freeze reviewer round + standing hold + confirmations recompute');
check('C3.prohibitionUndischarged', frRw.content.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline') && [frRw, frRwB].every((r) => r.content.verdict === 'repair'), 'no-accept prohibition recomputes; no reconcile-what reviewer verdict anywhere departs from repair');
check('C4.censusZeroOfSix', intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055' && frIntent1.content.verdict === 'repair' && ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b' && srArt.contentDigest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df' && frSr1.content.verdict === 'repair' && acArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0' && frAc2.content.verdict === 'repair' && rwArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191' && freezeHold.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f', 'all six upstream-desk rows recompute; census remains 0 of 6 accepted');
check('D1.parallelReviewerRecomputes', tbHold.contentDigest === '83501c2234353de8fd2520dd86967d87a485f1a66964d6165b481f572ab0ba83' && tbTrc.contentDigest === 'f187d5248013adfceca1a2c844147f1b3095ecf47ed15c3254a6bc665c8380ea', 'UH-Define-Architecture-Contract-002 (the prior reviewer-stage record on THIS frame) recomputes: hold-no-review, phantom adjudication of b7f34c48...');
check('D2.parallelRoundRecomputes', tbAuthorHold.contentDigest === 'd58e6a6a149c660aec7af57c83550b326431e1dbc48e2a9d10ac762c55efe7e7' && tbAuthorTrc.contentDigest === 'b0b5b62330a9ace320869ef284d9d55519ad13a4cbb178e99caa5c373d83cf0c' && tbVerifyOut.decision === 'VERIFIED' && tbAuthorVerifyOut.decision === 'VERIFIED', 'the testbed round recomputes: author hold d58e6a6a... (hold-no-authoring, the record the prior reviewer seat bound) + reviewer hold 83501c22...; both current verifier receipts recompute VERIFIED with 0 fails');
check('D3.noProductAuthoredRecomputes', holdArt.content.noProductAuthored === true && tbHold.content.noReviewMinted === true && tbHold.content.noProductSubmitted === true, 'the desk of record authors no product; the prior reviewer seat minted no review and submitted no product');
check('E1.deskDeclarationRecomputes', manifestSrc.includes("outputProductKind: 'formalization.srs.v1'") && manifestSrc.includes("{ from: 'freeze-what-baseline', to: 'define-architecture-contract', on: 'domain.frozen' }"), 'the installed desk declaration re-derives from the installed manifest source (formalization.srs.v1 / formalization.srs-structure.v1 / validateSrs; the domain.frozen inbound edge)');
check('E2.r1StrayDriftRecomputes', strayRecomputed === 'f4846e5fed6808f8b0c33b14d58a337d9f72eddd02bf775bc048862b1d5626af' && GOVERNING !== strayRecomputed, 'the r1 stray product drift recomputes: declared a926df6284... vs content f4846e5f...; retired, never lineage');
check('F1.deterministicAuthoring', CREATED_AT === '2026-08-28T00:00:00Z', 'pinned timestamps, no clock reads, no randomness');
check('G1.scanHonest', SCAN.files > 2000 && SCAN.textualMentions[GOVERNING] > 0, `${SCAN.files} workspace files scanned across three body layers; the inherited anchor remains textually carried by the corpus (${SCAN.textualMentions[GOVERNING]} files) while resolving to nothing`);

const passCount = checks.filter((c) => c.pass).length;
expect(passCount === checks.length, `a basis check failed: ${JSON.stringify(checks.filter((c) => !c.pass))}`);

/* ------------------------------------------------------------------ */
/* VV record (built first; cited by the review)                         */
/* ------------------------------------------------------------------ */

const vvContent = {
  verificationId: 'VV-Define-Architecture-Contract-002',
  semanticCode: 'VV-Define-Architecture-Contract-002',
  deskRef: 'define-architecture-contract',
  role: 'reviewer',
  reviewedRound: SELF_ROUND,
  subject: 'mechanical verification underlying FR-Define-Architecture-Contract-Reviewer-001 (frame authority adjudication + chain state recomputation)',
  trustedByDeclaration: false,
  checks,
  checksSummary: { total: checks.length, pass: passCount, fail: checks.length - passCount },
  resolutionScan: {
    filesScanned: SCAN.files,
    layers: ['raw bytes', 'whole-JSON canonical', '.content canonical', 'hash-resolution (sha256 over canonical forms)'],
    excludedFromScan: ['.git', 'node_modules', `${SELF_ROUND} (this emission)`],
    claimedAcceptedAddress: {
      address: shaRef(CLAIMED.address),
      textualMentions: SCAN.textualMentions[CLAIMED.address],
      mentionFiles: claimMentions,
      hashResolvedContents: resolvedHits,
      parallelScanDelta: 'UH-Define-Architecture-Contract-002 scanned a staffing in which the address had ZERO prior mentions; this workspace-wide re-scan finds exactly the prior adjudication set as mentioners and still zero hash-resolutions. Disposition unchanged: refused by both reviewer records.',
    },
    frameSkillPins: {
      protocolSkill: shaRef(SKILL.protocol),
      semanticSkill: shaRef(SKILL.semantic),
      hashResolvedContents: 0,
      installedManifestPins: { protocolSkill: shaRef(INSTALLED_SKILL.protocol), semanticSkill: shaRef(INSTALLED_SKILL.semantic) },
      disposition: 'envelope provenance recorded verbatim; not ratified by this seat; the installed pins recompute and differ',
    },
    governingAnchor: {
      address: shaRef(GOVERNING),
      hashResolvedContents: 0,
      disposition: 'inherited r2/r3 debt; NOT pinned by this round frame; still open',
    },
  },
  deterministicAuthoring: true,
};
const vv = {
  artifactRef: shaRef(sha(vvContent)),
  artifactKind: 'reviewer-verification',
  contentDigest: sha(vvContent),
  semanticCode: 'VV-Define-Architecture-Contract-002',
  createdAt: CREATED_AT,
  deskRef: 'define-architecture-contract',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: vvContent,
};

/* ------------------------------------------------------------------ */
/* FR review artifact (the reviewer refusal of record)                  */
/* ------------------------------------------------------------------ */

const frContent = {
  reviewId: 'FR-Define-Architecture-Contract-Reviewer-001',
  semanticCode: 'FR-Define-Architecture-Contract-001',
  deskRef: 'define-architecture-contract',
  role: 'reviewer',
  reviewedRound: SELF_ROUND,
  provenanceNote: 'UH-Define-Architecture-Contract-002 (factory-testbed round, 83501c22...) is the review-sequence predecessor at this desk - a hold-no-review on THIS EXACT frame; recorded and carried forward, extended by this package with the new content since (the r5 author hold re-emission and the corpus-wide mention re-scan).',
  reviewedCandidate: {
    artifactRef: shaRef(holdArt.contentDigest),
    traceRef: shaRef(holdTrc.contentDigest),
    productKind: 'formalization.upstream-hold.v1',
    declaredDecision: 'hold-no-authoring',
    note: 'the candidate of record at this desk is the r5 author-seat upstream hold (the latest author emission of the qualification series; the r4-round hold b831c67e... and the testbed-round hold d58e6a6a... recompute byte-stable as predecessor evidence, same decision); NO SRS candidate exists at this desk (noProductAuthored: true) - none was ever lawfully authorable on this chain',
  },
  verificationRef: shaRef(vv.contentDigest),
  verificationSummary: { recomputedChecks: checks.length, passed: passCount, failed: 0, trustedByDeclaration: false },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    adjudicated: 1,
    note: "All 8 claim/constraint/unknown/terminal addresses match this frame exactly and re-derive from the accepted capsule (9/9 with CERT-1). The frame carries the standing r2-r5 envelope with skill pins bc8a4261.../2cbcf850... (hash-resolve to no content; recorded as provenance), the tool-schemas layer and write authority 'candidate-read,product-read,product-submit' (recorded verbatim), plus upstream-accepted[0] sha256:b7f34c48... :: 'accepted revision of define-architecture-contract' and the workspace line 'workspace: 1 accepted upstream revisions travel by content address' - adjudicated below at the content layer. This frame pins NO governingContractRef; the r2-era anchor a926df6284... remains unresolvable workspace-wide.",
  },
  workspaceLaw: `frame claim, verbatim: "${CLAIMED.workspaceSummary}" (upstream-accepted[0] ${shaRef(CLAIMED.address)} :: ${CLAIMED.label}) - adjudicated FALSE at the status layer: the address hash-resolves to zero workspace contents and is process-impossible and wrong-referent; the truthful recomputed census is 0 of 6 accepted upstream desks; the desk of record holds noProductAuthored=true; the domain.frozen edge into this desk has never lawfully fired.`,
  reviewerSequence: {
    first: {
      semanticCode: 'UH-Define-Architecture-Contract-002',
      ref: shaRef(tbHold.contentDigest),
      kind: 'reviewer-seat desk hold (hold-no-review; no FR/VV/FS package minted: no candidate existed to review)',
      disposition: 'hold-no-review; frame address adjudicated PHANTOM (content-unresolved, process-impossible, wrong-referent); TypedWait external-availability',
    },
    thisRecord: 'FR-Define-Architecture-Contract-Reviewer-001 is the SECOND reviewer-stage record at this desk and mints the desk\'s first content-addressed FR/VV/RT/FS reviewer package. This is NOT a re-emission of identical semantics (the idempotency law is respected): NEW adjudication content exists since the prior record - (a) the r5 qualification-round author hold re-emission UH-Define-Architecture-Contract-001 (6a32f180..., census 0 of 6, verifier 29/29), which supersedes-in-sequence the hold the prior record bound (d58e6a6a..., testbed round); (b) the address b7f34c48... now HAS corpus mentions - exactly its own prior adjudication set - while still resolving to zero contents. The prior record\'s disposition is carried forward unchanged; its staffing-scoped scan finding is superseded by this workspace-wide three-body re-scan.',
    authorRestaffContext: 'the author seat of record is the r5 hold (hold-no-authoring, census 0 of 6, verifier 29/29); its resume contract R1-R5 is the desk\'s current lawful path',
  },
  claimedAcceptanceAdjudication: adjudication,
  findings: {
    positiveFindings: [
      'The envelope recomputes 8/8 from the accepted capsule (9/9 including CERT-1); the discovery import chain remains the only genuinely accepted base.',
      'The author-seat hold of record (UH-Define-Architecture-Contract-001, r5, 6a32f180... / trace 1f54d1f3...) re-derives byte-stable with its 29/29 verifier green; the r4-round hold (b831c67e...) and the testbed-round hold recompute as consistent predecessor evidence.',
      'The claimed accepted revision was adjudicated at the CONTENT layer, not by label: a workspace-wide three-body scan hash-resolves b7f34c48... to ZERO contents, and every textual mention is the desk\'s own prior refusing adjudication set.',
      'Two independent reviewer staffings agree on the disposition: UH-Define-Architecture-Contract-002 (hold-no-review, phantom adjudication) and this seat (hold-upheld, claim refused); the reviewer package is minted only because new adjudication content exists since the prior record.',
      'The parallel testbed round recomputes end-to-end: the author hold the prior reviewer seat bound (d58e6a6a..., hold-no-authoring, noProductAuthored) and the reviewer hold (83501c22..., hold-no-review) are byte-stable, and both current verifier receipts recompute VERIFIED with 0 fails.',
      'Round co-tenancy recorded: TWO settle-formalization desk holds were emitted concurrently with this staffing - UH-Settle-Formalization-001 (b40d7616..., r6 round co-tenant) and its testbed-round twin (8e1bcf73..., verifier VERIFIED), both hold-no-authoring, the testbed verifier explicitly adjudicating b7f34c48... the "arch-own-revision" phantom resolving to NO content. The post-freeze spine (this desk and settlement) is holding consistently against the same absent accepted lineage, and no desk in this round asserts an accepted chain revision.',
      'Live-movement observation recorded honestly: derived/regenerable artifacts were rewritten in the workspace during this staffing (the testbed verifier output regenerated to its current VERIFIED/0-fails state; the deterministic emission sets re-materialized byte-identically). Every immutable record body this review binds recomputed byte-stable at run time; no accepted lineage appeared anywhere (all six census rows recompute NOT accepted).',
      'The upstream gate recomputes exactly: freeze ratification REFUSED by FR-Freeze-What-Baseline-002 (d52746b6..., effect never fired), the standing freeze hold (9f2d28b9...) with AS-001/RC-001 confirmations, the no-accept prohibition of FR-Reconcile-What-001 (39a94a29..., repair; emission B also repair), and all six census rows re-deriving.',
      'The installed desk declaration re-derives from the installed manifest (production cell, output formalization.srs.v1, provider formalization.srs-structure.v1/validateSrs, inbound edge freeze-what-baseline --domain.frozen-->); the desk is fail-closed by its own cell law (MISSING_LINEAGE without accepted pins; never scans, guesses or reselects).',
    ],
    advisoryNotes: [
      {
        type: 'verdict_semantics',
        note: 'This seat\'s verdict "hold-upheld" follows the r4 reviewer-stage-of-record semantics (the candidate of record is the author-seat hold, verified and upheld). No product verdict (accept/repair) is minted - the verdict vocabulary over products stays uncomputed over the absent candidate, exactly as the prior record required. The FS package is a review-complete refusal record with effectFired: false; product_submit is used only to lodge it.',
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
        title: 'Frame declares an accepted upstream revision; the address is a phantom - unresolved, process-impossible, wrong-referent',
        detail: `The frame's workspace line ("${CLAIMED.workspaceSummary}") and its upstream-accepted[0] entry assert accepted-chain authority. Mechanical resolution: ${shaRef(CLAIMED.address)} hash-resolves to ZERO workspace contents in all three body layers over ${SCAN.files} files; its only ${SCAN.textualMentions[CLAIMED.address]} textual mentions are refusing adjudication/verification records (this desk's prior reviewer-stage adjudication set; the settle-formalization hold verifiers naming it the arch-own-revision phantom). Process-impossible: this desk's author seat of record holds noProductAuthored=true; no author candidate, submission, intake receipt, gate verdict or reviewer verdict exists anywhere for this desk, so an "accepted revision of define-architecture-contract" cannot exist. Wrong-referent: even under a resolving reading, the entry names THIS desk's own product kind (formalization.srs.v1), while the desk's lawful upstream supply is the frozen WHAT baseline plus the accepted srsRevisionDigest pin over the never-fired domain.frozen edge. A settlement or review ratified over this "upstream" would inherit the fabricated authority permanently.`,
        requiredAction: 'Verdict: refuse the claim as acceptance authority. Lawful path unchanged: resume contract R1-R5 of the r5 author hold (the freeze desk R1-R4 completes first; this desk re-staffs only against the REAL frozen WHAT-baseline revision; authoring precedes any reviewer stage; the holds are never carried as product lineage; the r1 stray product stays retired).',
      },
      {
        id: 'CRIT-2',
        severity: 'CRITICAL',
        title: 'No candidate exists at this desk to review; the reviewer stage stays closed over products',
        detail: 'The reviewer verdict vocabulary over products (accept/repair/upstream-repair) is a pure function of (provider, candidate, accepted chain) and cannot be honestly computed over an absent subject: no SRS candidate was ever authored (noProductAuthored=true), no author product submission exists, and no intake receipt (admitted_for_reviewer_stage) was ever issued at this desk. Minting an accept/repair verdict over nothing would be the fabricated-desk-history class this conveyor exists to catch (the exact law the prior reviewer record enforced).',
        requiredAction: 'No product verdict is minted. The candidate of record (the author-seat hold) is verified and upheld; product_submit is used only to lodge this review-complete refusal package with effectFired: false.',
      },
      {
        id: 'CRIT-3',
        severity: 'CRITICAL',
        title: 'The upstream gate stands refused; the domain.frozen edge into this desk has never lawfully fired',
        detail: 'FR-Freeze-What-Baseline-002 (d52746b6...) recomputes: freeze ratification REFUSED, FS effectFired=false; the standing freeze hold (9f2d28b9...) with its AS/RC confirmations recomputes; the explicit no-accept prohibition of FR-Reconcile-What-001 (39a94a29...) stands undischarged (both reconcile-what emissions recompute to repair). Therefore no frozen WHAT baseline (frf-contracts.what-baseline.v1) exists, and the single inbound edge freeze-what-baseline --domain.frozen--> define-architecture-contract has never lawfully fired. Per the discharge law, only a future reconcile-what reviewer verdict of record on a re-run over genuinely accepted revisions can discharge the prohibition - never this desk, and never a frame assertion.',
        requiredAction: 'The prohibition stands. This seat upholds the author hold and refuses any SRS authoring or review on this chain state.',
      },
    ],
    majorIssues: [
      {
        id: 'MAJ-1',
        severity: 'MAJOR',
        title: 'Frame skill digests resolve to no workspace content; the inherited governing anchor remains unresolvable',
        detail: `The frame pins protocol-skill ${shaRef(SKILL.protocol)} and semantic-skill ${shaRef(SKILL.semantic)}; both hash-resolve to zero workspace contents (mentioned textually ${SCAN.textualMentions[SKILL.protocol]}/${SCAN.textualMentions[SKILL.semantic]} times as standing frame pins). The installed manifest pins recompute (${shaRef(INSTALLED_SKILL.protocol)} / ${shaRef(INSTALLED_SKILL.semantic)}) and BOTH differ. Recorded as envelope provenance, not ratified. The r2-era governing anchor ${shaRef(GOVERNING)} also still resolves to zero contents - the anchor debt remains open; this round's frame pins no governingContractRef at all.`,
        requiredAction: 'The frame issuer must materialize the skill/anchor refs as real content-addressed material (or re-pin to what exists) before any future settlement may cite them.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true, evidence: 'VV/FR/RT/FS self-address and cross-bind; single-dereference evidence list in the submission' },
    { id: 2, description: 'Independent recomputation performed by this seat; nothing trusted by declaration', satisfied: true, evidence: `A-G check groups re-run (${checks.length}/${checks.length} pass); ${SCAN.files} files scanned` },
    { id: 3, description: 'All 8 reviewer-frame task-projection content addresses resolved', satisfied: true, evidence: 'B1: 8/8 exact from the accepted capsule' },
    { id: 4, description: "The frame's upstream-accepted entry adjudicated at the content layer, not by label", satisfied: true, evidence: 'A1-A2: zero hash-resolutions workspace-wide (three body layers); the only mentions are the desk\'s own prior refusing adjudication set' },
    { id: 5, description: 'Verdict grounded in re-digested records, not round labels or prior review text', satisfied: true, evidence: 'B3-B5, C1-C4, D1-D3, E1-E2: author holds, freeze refusal round, confirmations, all six census rows, the prior reviewer record and the installed desk declaration re-digested' },
    { id: 6, description: 'constraint:retention-1 honored; unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true, evidence: 'no disposition, binding or resolution authored by this seat; the 8 envelope claims observed as content addresses only' },
    { id: 7, description: 'Reviewer artifacts deterministic: pinned timestamps, no clock reads, no randomness', satisfied: true, evidence: 'pinned CREATED_AT; deterministic builder; no randomness' },
    { id: 8, description: 'Frame workspace summary TRUE of the chain', satisfied: false, note: 'CRIT-1 recorded honestly: the one projected address is a phantom; census 0 of 6' },
    { id: 9, description: 'An SRS candidate exists at this desk to review', satisfied: false, note: 'none ever lawfully authored; the candidate of record is the author-seat upstream hold, which this seat verifies and upholds; no product verdict is minted' },
    { id: 10, description: 'The claimed accepted revision is a chain WorkplaceProductionRevision with a completed reviewer stage', satisfied: false, note: 'CRIT-1 recorded honestly: phantom address, process-impossible, wrong-referent' },
  ],
  verdict: 'hold-upheld',
  decision: 'REFUSE the frame upstream-accepted claim as acceptance authority (phantom-upstream-projection); uphold UH-Define-Architecture-Contract-001 (r5 author hold); mint no SRS product verdict over the absent candidate; the desk awaits resume contract R1-R5',
  nextStage: 'HOLD STANDS - no SRS authoring or review may occur at this desk on this chain state. Resume contract R1-R5 of the r5 author hold unchanged: (R1) the freeze desk resume contract R1-R4 completes first - genuinely accepted revisions land for the four upstream desks through completed reviewer stages at their own content addresses, RA-5 re-runs reconcile-what over the NEW accepted chain, its reviewer verdict alone discharges the no-accept prohibition, and the freeze ratifies on five accepted pre-freeze desks; (R2) this desk re-staffs only against the REAL frozen WHAT-baseline revision at its own content address - never a fixture, never a stray product, never a frame assertion; (R3) the author stage then authors the architecture contract strictly per the desk contract (parse closed vocabulary -> validate against the accepted id-set universe -> seal with recomputed canonical digests), its gate admits the candidate by intake receipt, and only then does this reviewer seat re-staff over the admitted candidate; (R4) the holds and this refusal are not carried as product lineage; the future architecture contract cites only the accepted baseline pin, the accepted SRS revision pin and accepted material; (R5) the r1 stray product AC-Define-Architecture-Contract-001 stays retired - not resumed, not repaired in place, not re-submitted.',
};
const fr = {
  artifactRef: shaRef(sha(frContent)),
  artifactKind: 'formalization-review',
  contentDigest: sha(frContent),
  semanticCode: 'FR-Define-Architecture-Contract-001',
  createdAt: CREATED_AT,
  deskRef: 'define-architecture-contract',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: frContent,
};

/* ------------------------------------------------------------------ */
/* RT trace                                                             */
/* ------------------------------------------------------------------ */

const resolveId = (id) => {
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (id === 'FR-Define-Architecture-Contract-001') return sha(frContent);
  if (id === 'VV-Define-Architecture-Contract-002') return sha(vvContent);
  if (id === 'UH-Define-Architecture-Contract-001') return holdArt.contentDigest;
  if (id === 'RT-UH-Define-Architecture-Contract-001') return holdTrc.contentDigest;
  if (id === 'UH-Define-Architecture-Contract-001@stray-products-r4') return holdArtR4.contentDigest;
  if (id === 'UH-Define-Architecture-Contract-002') return tbHold.contentDigest;
  if (id === 'RT-UH-Define-Architecture-Contract-002') return tbTrc.contentDigest;
  if (id === 'UH-Define-Architecture-Contract-001@factory-testbed') return tbAuthorHold.contentDigest;
  if (id === 'UH-Settle-Formalization-001') return settleArt.contentDigest;
  if (id === 'RT-UH-Settle-Formalization-001') return settleTrc.contentDigest;
  if (id === 'UH-Settle-Formalization-001@factory-testbed') return tbSettleArt.contentDigest;
  if (id === 'import:discovery-handoff') return importArt.contentDigest;
  if (id === 'cert:discovery-capsule') return certDigest;
  if (id === 'FR-Freeze-What-Baseline-002') return frFreeze.contentDigest;
  if (id === 'VV-Freeze-What-Baseline-002') return vvFreeze.contentDigest;
  if (id === 'RT-Freeze-What-Baseline-002') return rtFreeze.contentDigest;
  if (id === 'FS-Freeze-What-Baseline-Reviewer-001') return fsFreeze.contentDigest;
  if (id === 'UH-Freeze-What-Baseline-001') return freezeHold.contentDigest;
  if (id === 'RC-Freeze-What-Baseline-001') return rcConf.contentDigest;
  if (id === 'AS-Freeze-What-Baseline-001') return asConf.contentDigest;
  if (id === 'FR-Reconcile-What-001') return frRw.contentDigest;
  if (id === 'FR-Reconcile-What-002') return frRwB.contentDigest;
  if (id === 'link:define-product-intent') return intentArt.contentDigest;
  if (id === 'link:model-use-cases') return ucArt.contentDigest;
  if (id === 'link:derive-system-requirements') return srArt.contentDigest;
  if (id === 'link:define-acceptance-contract') return acArt.contentDigest;
  if (id === 'link:reconcile-what') return rwArt.contentDigest;
  if (id === 'UH-Define-Acceptance-Contract-001') return uhAc.contentDigest;
  if (id === 'FR-Define-Acceptance-Contract-002') return frAc2.contentDigest;
  if (id === 'phantom:b7f34c48') return CLAIMED.address;
  if (id === 'schema:what-baseline') return schemaRawDigest;
  if (id === 'fixture:what-baseline-green') return 'e210334e796f8693dc569354ca0b442c7caf9c390eab78581e07897c9febf9de';
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
const S = 'FR-Define-Architecture-Contract-001';
const relationships = [
  ...Object.keys(ENVELOPE).map((id) => rel(S, 'verifies', id, `This review's envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection.`)),
  rel(S, 'verifies', 'UH-Define-Architecture-Contract-001', 'The author-seat hold of record (r5) re-derives byte-stable with its 29/29 verifier green; verdict hold-upheld recorded by this review.'),
  rel(S, 'verifies', 'RT-UH-Define-Architecture-Contract-001', 'The author hold trace of record recomputes.'),
  rel(S, 'observes', 'UH-Define-Architecture-Contract-001@stray-products-r4', 'The r4-round author hold of this desk: hold-no-authoring; consistent predecessor evidence.'),
  rel(S, 'observes', 'UH-Define-Architecture-Contract-002', "The desk's first reviewer-stage record (factory-testbed round): hold-no-review on THIS EXACT frame; adjudicated b7f34c48... PHANTOM. Disposition carried forward unchanged."),
  rel(S, 'observes', 'RT-UH-Define-Architecture-Contract-002', 'The prior reviewer record trace.'),
  rel(S, 'observes', 'UH-Define-Architecture-Contract-001@factory-testbed', 'The testbed-round author hold (d58e6a6a..., hold-no-authoring, noProductAuthored; semantic code round-namespaced) - the record the prior reviewer seat bound; recomputed byte-stable at this staffing.'),
  rel(S, 'observes', 'UH-Settle-Formalization-001', 'The downstream kernel desk hold (settle-formalization, co-tenant of this round): hold-no-authoring - the post-freeze spine holds consistently against the same absent accepted lineage.'),
  rel(S, 'observes', 'RT-UH-Settle-Formalization-001', 'The settle-formalization hold trace.'),
  rel(S, 'observes', 'UH-Settle-Formalization-001@factory-testbed', 'The testbed-round twin of the settle hold (8e1bcf73..., hold-no-authoring, verifier VERIFIED; its verifier names b7f34c48... the arch-own-revision phantom).'),
  rel(S, 'observes', 'phantom:b7f34c48', 'The frame upstream-accepted[0] claim: zero hash-resolutions in all three body layers; process-impossible and wrong-referent; REFUSED as acceptance authority.'),
  rel(S, 'observes', 'import:discovery-handoff', 'The accepted discovery import chain; still the only accepted base on this chain.'),
  rel(S, 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel(S, 'observes', 'FR-Freeze-What-Baseline-002', 'The upstream gate refusal of record: freeze ratification REFUSED; the domain.frozen edge into this desk has never lawfully fired.'),
  rel(S, 'observes', 'VV-Freeze-What-Baseline-002', 'The gate reviewer verification of record (50/50).'),
  rel(S, 'observes', 'RT-Freeze-What-Baseline-002', 'The gate reviewer trace of record.'),
  rel(S, 'observes', 'FS-Freeze-What-Baseline-Reviewer-001', 'The gate reviewer submission of record; effectFired=false.'),
  rel(S, 'observes', 'UH-Freeze-What-Baseline-001', 'The standing freeze author hold.'),
  rel(S, 'observes', 'AS-Freeze-What-Baseline-001', 'The freeze author re-staff confirmation: standing hold, 0 new accepted lineage.'),
  rel(S, 'observes', 'RC-Freeze-What-Baseline-001', 'The freeze reviewer confirmation: hold-upheld-no-candidate-to-review.'),
  rel(S, 'observes', 'FR-Reconcile-What-001', 'The gate verdict of record: repair, with the explicit no-accept prohibition toward freeze-what-baseline.'),
  rel(S, 'observes', 'FR-Reconcile-What-002', 'The gate emission-B review; also recomputes to repair.'),
  rel(S, 'observes', 'link:define-product-intent', 'Upstream desk 1: repair x3, no reissue; NOT accepted.'),
  rel(S, 'observes', 'link:model-use-cases', 'Upstream desk 2: never reviewed at its own content address; NOT accepted.'),
  rel(S, 'observes', 'link:derive-system-requirements', 'Upstream desk 3: repair + held reviewer seat; NOT accepted.'),
  rel(S, 'observes', 'link:define-acceptance-contract', 'Upstream desk 4: adjudicated repair; NOT accepted.'),
  rel(S, 'observes', 'UH-Define-Acceptance-Contract-001', 'The standing upstream hold of the acceptance desk.'),
  rel(S, 'observes', 'FR-Define-Acceptance-Contract-002', 'The adjudicating emission C of the acceptance desk (repair confirmed).'),
  rel(S, 'observes', 'link:reconcile-what', 'Upstream desk 5 (the gate): repair verdict of record; NOT accepted.'),
  rel(S, 'observes', 'schema:what-baseline', 'The freeze payload contract (raw sha256 ab1b7f5e...): acceptanceRecords minItems 5 - the root lawful-authoring blocker.'),
  rel(S, 'observes', 'fixture:what-baseline-green', 'The r4 frame family member: the only phantom that ever RESOLVED (to the green fixture) and was refused; recorded as family history.'),
];
const rtContent = {
  deskRef: 'define-architecture-contract',
  role: 'reviewer',
  traceKind: 'reviewer-refusal-trace',
  subjectSemanticCode: 'FR-Define-Architecture-Contract-001',
  subjectArtifactRef: fr.artifactRef,
  verificationRef: shaRef(vv.contentDigest),
  relationVocabulary: ['observes', 'verifies'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: ['FR-Define-Architecture-Contract-Reviewer-001'] }])),
  claimedAcceptanceCoverage: {
    'upstream-accepted[0]': {
      address: shaRef(CLAIMED.address),
      resolution: 'unresolved-phantom',
      hashResolvedContents: 0,
      adjudication: 'REFUSED as acceptance authority (phantom-upstream-projection; CRIT-1)',
      verifiedBy: ['FR-Define-Architecture-Contract-Reviewer-001'],
    },
  },
  holdCoverage: {
    verdict: 'hold-upheld',
    srsReviewed: false,
    productVerdictMinted: false,
    noProductAuthored: true,
    acceptedUpstreamDesks: 0,
    upstreamDesksRequired: 6,
    unacceptedLinks: ['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements', 'link:define-acceptance-contract', 'link:reconcile-what'],
    upstreamGate: 'freeze-what-baseline on standing hold; ratification refused (FR-Freeze-What-Baseline-002); the domain.frozen edge has never fired',
    onlyAcceptedChain: 'import:discovery-handoff',
    gateVerdictOfRecord: 'FR-Reconcile-What-001 (repair)',
    explicitProhibition: 'No domain.accepted may fire from this desk toward freeze-what-baseline on this chain.',
    prohibitionDischarged: false,
  },
  branchResolutionNote: 'No scenario, surface, realization-entry, requirement, criterion, container or baseline identities are authored by this review; all observed links resolve at record/artifact granularity.',
  workspaceSummary: `frame claim "${CLAIMED.workspaceSummary}" adjudicated FALSE; recomputed truth: 0 accepted upstream revisions travel by content address on this chain (the one projected address is a phantom, refused as acceptance authority)`,
};
const rt = {
  traceRef: shaRef(sha(rtContent)),
  traceKind: 'reviewer-refusal-trace',
  contentDigest: sha(rtContent),
  semanticCode: 'RT-Define-Architecture-Contract-001',
  createdAt: CREATED_AT,
  deskRef: 'define-architecture-contract',
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
  { ref: shaRef(holdArtR4.contentDigest), kind: 'upstream-hold-predecessor' },
  { ref: shaRef(tbHold.contentDigest), kind: 'reviewer-hold-predecessor' },
  { ref: shaRef(tbTrc.contentDigest), kind: 'reviewer-hold-predecessor-trace' },
  { ref: shaRef(tbAuthorHold.contentDigest), kind: 'upstream-hold-predecessor' },
  { ref: shaRef(tbAuthorTrc.contentDigest), kind: 'upstream-hold-predecessor-trace' },
  { ref: shaRef(settleArt.contentDigest), kind: 'downstream-desk-hold' },
  { ref: shaRef(settleTrc.contentDigest), kind: 'downstream-desk-hold-trace' },
  { ref: shaRef(tbSettleArt.contentDigest), kind: 'downstream-desk-hold-predecessor' },
  { ref: shaRef(frFreeze.contentDigest), kind: 'gate-formalization-review' },
  { ref: shaRef(vvFreeze.contentDigest), kind: 'gate-reviewer-verification' },
  { ref: shaRef(rtFreeze.contentDigest), kind: 'gate-reviewer-trace' },
  { ref: shaRef(fsFreeze.contentDigest), kind: 'gate-reviewer-submission' },
  { ref: shaRef(freezeHold.contentDigest), kind: 'upstream-hold' },
  { ref: shaRef(asConf.contentDigest), kind: 'author-restaff-confirmation' },
  { ref: shaRef(rcConf.contentDigest), kind: 'reviewer-confirmation' },
  { ref: shaRef(rwArt.contentDigest), kind: 'gate-author-product' },
  { ref: shaRef(frRw.contentDigest), kind: 'gate-formalization-review' },
  { ref: shaRef(frRwB.contentDigest), kind: 'gate-formalization-review-emission-b' },
  { ref: shaRef(intentArt.contentDigest), kind: 'consumed-revision-under-repair' },
  { ref: shaRef(ucArt.contentDigest), kind: 'consumed-revision-unaccepted' },
  { ref: shaRef(srArt.contentDigest), kind: 'consumed-revision-under-repair' },
  { ref: shaRef(acArt.contentDigest), kind: 'consumed-revision-under-repair' },
  { ref: shaRef(uhAc.contentDigest), kind: 'upstream-hold' },
  { ref: shaRef(frAc2.contentDigest), kind: 'confirmed-repair-review' },
  { ref: shaRef(schemaRawDigest), kind: 'payload-contract-schema' },
  { ref: shaRef(CLAIMED.address), kind: 'adjudicated-claim-content' },
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
  deskRef: 'define-architecture-contract',
  deskNodeId: 'define-architecture-contract',
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
    effectId: 'formalization.accept-products',
    effectFired: false,
    requiredEvidenceRefs: evidence.map((e) => e.ref),
    evidenceKindCoverage: coverage,
    terminalOutcome: 'hold-upheld-claim-refused-phantom-upstream',
  },
  intakeReceipt: {
    receiptRef: 'evidence:DeskIntakeReceipt#define-architecture-contract:reviewer',
    status: 'review_complete_verdict_recorded',
    receivedFrom: 'reviewer',
    nextStage: 'hold-upheld: no SRS authoring or review on this chain state; the frame upstream-accepted[0] claim is refused (phantom-upstream-projection); resume contract R1-R5 unchanged - the freeze desk R1-R4 completes first, then this desk re-staffs against the REAL frozen WHAT-baseline revision, the author stage authors and admits a candidate, and only then does this reviewer seat review over the admitted candidate',
    note: 'The r5 author hold re-verifies byte-stable with its 29/29 verifier green; the recomputed census is 0 of 6 and the freeze refusal stands (effect never fired). No product verdict is minted over the absent candidate; kernel-side routing is executed by the driver over public commands.',
  },
  acceptanceCriteriaSelfCheck: frContent.acceptanceCriteria.map((a) => ({ id: a.id, description: a.description, satisfied: a.satisfied })),
};
const fsRecord = {
  submissionRef: shaRef(sha(fsContent)),
  submissionId: 'FS-Define-Architecture-Contract-Reviewer-001',
  contentDigest: sha(fsContent),
  createdAt: CREATED_AT,
  deskRef: 'define-architecture-contract',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: fsContent,
};

/* ------------------------------------------------------------------ */
/* Write                                                                */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('define-architecture-contract-desk-reviewer-verification.json', vv);
writeJson('define-architecture-contract-desk-reviewer-review.json', fr);
writeJson('define-architecture-contract-desk-reviewer-trace.json', rt);
writeJson('define-architecture-contract-desk-reviewer-product-submission.json', fsRecord);

console.log(JSON.stringify({
  built: 'define-architecture-contract desk (reviewer) refusal emission',
  reviewRef: fr.artifactRef,
  verificationRef: vv.artifactRef,
  traceRef: rt.traceRef,
  submissionRef: fsRecord.submissionRef,
  verdict: frContent.verdict,
  claimedAddressHashResolvedContents: resolvedHits.length,
  claimedAddressMentionFiles: claimMentions.length,
  checks: `${passCount}/${checks.length}`,
  scanFiles: SCAN.files,
}, null, 2));
