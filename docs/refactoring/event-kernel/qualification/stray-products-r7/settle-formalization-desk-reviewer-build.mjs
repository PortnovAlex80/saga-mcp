/**
 * settle-formalization desk (reviewer) - REVIEWER REFUSAL builder.
 *
 * Emission: FR-Settle-Formalization-Reviewer-001 (stray-products-r7,
 * reviewer seat). Deterministic authoring.
 *
 * This staffing's desk task frame carries, verbatim: task line "settle-
 * formalization desk (reviewer)"; write authority "write authority: desk
 * artifacts only; allowed=candidate-read,product-read,product-submit"; the
 * tool-schemas layer (artifact_create / artifact_update / trace_add /
 * product_submit / read-file); skill pins protocol bc8a4261... / semantic
 * 2cbcf850... (the reviewer-frame drift pair, byte-equal to the pair the
 * testbed reviewer staffing of this desk recorded); the SAME 8 task-
 * projection content addresses as every r2-r6 frame; upstream-accepted[0]
 * sha256:d751f19421553fe7729ca96ab5ed803720c7b42da63daf28b61246460c867a95
 * :: "accepted revision of settle-formalization"; and the workspace line
 * "workspace: 1 accepted upstream revisions travel by content address".
 *
 * Reviewer-sequence context (all recomputed by this script, nothing
 * trusted):
 * - The desk's prior reviewer-stage record is UH-Settle-Formalization-002
 *   (factory-testbed round, 792b6ce0.../cfca9e19..., hold-no-review,
 *   typedWait external-availability, verifier 34/34): a hold on THIS EXACT
 *   frame, which adjudicated the SAME address (d751f194...) PHANTOM at its
 *   staffing (its first appearance, zero prior mentions). Its disposition
 *   is carried forward unchanged.
 * - NEW adjudication content since that record: (a) the r6 qualification-
 *   round author hold re-emission UH-Settle-Formalization-001
 *   (b40d7616.../f7ee0830..., census 0 of 7, verifier 48/48 green);
 *   (b) the immediate upstream gate now HAS a reviewer refusal of record -
 *   FR-Define-Architecture-Contract-001 (d813908b..., reviewer package,
 *   verifier 53/53), which the prior reviewer record could not see (it
 *   recorded "no reviewer round at the arch hold content address");
 *   (c) the address d751f194... now HAS textual mentions - exactly its own
 *   prior adjudication set - while still hash-resolving to zero contents
 *   in all three body layers; (d) the testbed round's second consecutive
 *   author hold UH-Settle-Formalization-003 (7ce5eb48..., envelope
 *   byte-equal to hold #1: ZERO upstream-accepted entries).
 * - Mechanical result of THIS staffing's workspace-wide three-body scan
 *   (raw bytes, whole-JSON canonical, .content canonical; this round
 *   excluded): d751f194... hash-resolves to ZERO contents. The claim is
 *   refused on three independent grounds: content-unresolved,
 *   process-impossible (the desk of record authors no product; its author
 *   seat's product_submit was never used; no settle gate has ever returned
 *   outcome formalized, so the desk owns no revision that could be
 *   accepted), and wrong-referent (the entry names THIS desk's own
 *   revision, while settlement consumes the frozen whole-WHAT baseline +
 *   the accepted SRS revision + the authored desk inputs; a desk-own
 *   projection supplies no reviewable subject).
 *
 * Verdict: hold-upheld (the r4/r6 reviewer-stage-of-record semantics: the
 * candidate of record at this desk is the author-seat hold, which this
 * seat verifies and upholds). No solution-contract product verdict
 * (accepted/rejected) is minted - none can be, over an absent sealed
 * candidate (the reviewer route binds its verdict to the exact sealed
 * artifact + canonical digest). The terminal-ladder danger recorded by the
 * prior reviewer record stands: a fabricated candidate would not repair -
 * it would terminally fail the flow (complete-failed).
 *
 * Deterministic authoring law: pinned timestamps, no clock reads, no
 * randomness. All addresses are sha256 over canonical JSON (recursively
 * key-sorted, compact, UTF-8) - the frozen kernel rule. Every cited record
 * digest is recomputed from the corpus files in this script.
 *
 * Run: node settle-formalization-desk-reviewer-build.mjs
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
const CREATED_AT = '2026-08-28T02:00:00Z';
const SELF_ROUND = 'stray-products-r7';

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
  address: 'd751f19421553fe7729ca96ab5ed803720c7b42da63daf28b61246460c867a95',
  label: 'accepted revision of settle-formalization',
  workspaceSummary: 'workspace: 1 accepted upstream revisions travel by content address',
  writeAuthority: 'write authority: desk artifacts only; allowed=candidate-read,product-read,product-submit',
};
/* Frame layer skill pins (protocol-skill / semantic-skill) - the reviewer-frame drift pair. */
const SKILL = {
  protocol: 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50',
  semantic: '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2',
};
/* Installed manifest skill digests (kernel rule recomputed below). */
const installedSemanticOf = (desk) => sha({ skillId: `formalization-desk-${desk}`, kind: 'semantic', desk });
const INSTALLED_SKILL = {
  protocol: sha({ skillId: 'saga-process-module-worker-protocol', kind: 'protocol' }),
  semantic: installedSemanticOf('settle-formalization'),
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
/* Recompute the accepted base and the envelope                         */
/* ------------------------------------------------------------------ */

const R6 = 'docs/refactoring/event-kernel/qualification/stray-products-r6';
const R5 = 'docs/refactoring/event-kernel/qualification/stray-products-r5';
const R4 = 'docs/refactoring/event-kernel/qualification/stray-products-r4';
const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';
const R1 = 'docs/refactoring/event-kernel/qualification/stray-products-r1';
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

/* ------------------------------------------------------------------ */
/* THIS desk's own records (author holds of record + the prior reviewer */
/* stage) - all recomputed                                              */
/* ------------------------------------------------------------------ */

/* The r6 qualification-round author hold: the candidate of record. */
const holdArt = record(`${R6}/settle-formalization-desk-upstream-hold.artifact.json`);
const holdTrc = record(`${R6}/settle-formalization-desk-upstream-hold-trace.json`);
expect(holdArt.contentDigest === 'b40d7616bb607ccfe389258829d304f065e1cac46888b6541c3c5c35b8402251', 'r6 author hold artifact drift');
expect(holdTrc.contentDigest === 'f7ee0830d5812841dc70417fc3143a8030fadfd5d1018871aaab40c60c1b3bae', 'r6 author hold trace drift');
expect(holdArt.content.decision === 'hold-no-authoring' && holdArt.content.noProductAuthored === true, 'r6 author hold decision drift');
expect(holdArt.content.chainAcceptanceCensus.acceptedUpstreamDeskCount === 0 && holdArt.content.chainAcceptanceCensus.upstreamDeskCount === 7, 'r6 author hold census drift');
expect(holdArt.content.frameAdjudication.workspaceSummary.claim.startsWith('0 accepted upstream revisions'), 'r6 author frame workspace line drift');
const holdVerifyOut = JSON.parse(readFileSync(join(REPO, `${R6}/settle-formalization-desk-hold-verify-out.json`), 'utf8'));
expect(holdVerifyOut.summary.allPass === true && holdVerifyOut.summary.fail === 0 && holdVerifyOut.summary.total === 48, 'r6 hold verify-out no longer green');
expect(holdVerifyOut.verified === 'UH-Settle-Formalization-001', 'r6 hold verifier identity drift');

/* The testbed round: author holds #1 and #2 (envelope byte-equal pair). */
const tbAuthorHold = record(`${TESTBED}/settle-formalization-author-hold.artifact.json`);
const tbAuthorTrc = record(`${TESTBED}/settle-formalization-author-hold-trace.json`);
expect(tbAuthorHold.contentDigest === '8e1bcf73542e217bd702e59d5879200c43c3e21e17d6b94a3f02b63b4d16d3a7', 'testbed author hold drift');
expect(tbAuthorTrc.contentDigest === 'f64e6346adce7fa2b52cb1bcd43a50528d51e6c9b295d04a195d970fd700f933', 'testbed author hold trace drift');
expect(tbAuthorHold.content.decision === 'hold-no-authoring' && tbAuthorHold.content.noProductAuthored === true, 'testbed author hold decision drift');
const tbAuthorVerifyOut = JSON.parse(readFileSync(join(REPO, `${TESTBED}/settle-formalization-author-hold-verify-out.json`), 'utf8'));
expect(tbAuthorVerifyOut.decision === 'VERIFIED' && tbAuthorVerifyOut.checks.length === 23 && tbAuthorVerifyOut.checks.filter((c) => c.pass === false).length === 0, 'testbed author verify-out drift');
const tbAuthorHold2Raw = JSON.parse(readFileSync(join(REPO, `${TESTBED}/settle-formalization-author-hold2.artifact.json`), 'utf8'));
const tbAuthorHold2 = record(`${TESTBED}/settle-formalization-author-hold2.artifact.json`);
expect(tbAuthorHold2.contentDigest === '7ce5eb48a8c0d4c4a8671eb330989da9fa28e1462383b076e9d194fbf8075708', 'testbed author hold2 drift');
expect(tbAuthorHold2Raw.semanticCode === 'UH-Settle-Formalization-003', 'testbed author hold2 identity drift');
expect(tbAuthorHold2.content.decision === 'hold-no-authoring' && tbAuthorHold2.content.noProductAuthored === true, 'testbed author hold2 decision drift');
expect(JSON.stringify(tbAuthorHold2.content).includes('byte-equivalent'), 'testbed author hold2 envelope-equality note drift');
const tbAuthor2VerifyOut = JSON.parse(readFileSync(join(REPO, `${TESTBED}/settle-formalization-author-hold2-verify-out.json`), 'utf8'));
expect(tbAuthor2VerifyOut.decision === 'VERIFIED' && tbAuthor2VerifyOut.checks.filter((c) => c.pass === false).length === 0, 'testbed author2 verify-out drift');

/* The prior reviewer-stage record on THIS EXACT frame. */
const tbHold = record(`${TESTBED}/settle-formalization-reviewer-hold.artifact.json`);
const tbTrc = record(`${TESTBED}/settle-formalization-reviewer-hold-trace.json`);
expect(tbHold.contentDigest === '792b6ce07899114b47b1728cc8e0c9bd5ed867f4d4ad7024d0d83a6559c7f7f3', 'testbed reviewer hold drift');
expect(tbTrc.contentDigest === 'cfca9e19b7824af07b5f5adc164a238b98d31ff056375df05ff8f420f6d870da', 'testbed reviewer hold trace drift');
expect(tbHold.content.decision === 'hold-no-review' && tbHold.content.noReviewMinted === true && tbHold.content.noProductSubmitted === true, 'testbed reviewer hold decision drift');
expect(tbHold.content.typedWait === 'external-availability', 'testbed reviewer hold typedWait drift');
expect(tbHold.content.upstreamProjectionAudit?.envelopeProjection?.includes(CLAIMED.address) === true, 'prior reviewer record does not cite the claimed address');
expect(tbHold.content.upstreamProjectionAudit?.adjudication?.startsWith('STALE SHELL METADATA - phantom address') === true, 'prior reviewer phantom adjudication drift');
expect(tbHold.content.governingContractRef === shaRef(GOVERNING), 'prior reviewer governing-ref provenance drift');
const tbVerifyOut = JSON.parse(readFileSync(join(REPO, `${TESTBED}/settle-formalization-reviewer-hold-verify-out.json`), 'utf8'));
expect(tbVerifyOut.decision === 'VERIFIED' && tbVerifyOut.checks.length === 34 && tbVerifyOut.checks.filter((c) => c.pass === false).length === 0, 'testbed reviewer verify-out drift');

/* THIS desk's r1 reviewer-seat stray family (raw-bytes addressed). */
const R1_SELF = {
  decision: `${R1}/settle-formalization-reviewer-decision.json`,
  submission: `${R1}/settle-formalization-reviewer-product-submission.json`,
  trace: `${R1}/settle-formalization-reviewer-trace.json`,
};
const selfStrayRawDigests = Object.fromEntries(Object.entries(R1_SELF).map(([k, p]) => [k, shaRaw(readFileSync(join(REPO, p)))]));
expect(selfStrayRawDigests.decision === 'ad698a85b0a76d8c7be5220c9300c2413dea6f70fd28e162b09ab68519f8e2ed', 'r1 self stray decision raw address drift');
expect(selfStrayRawDigests.submission === '0b0c9d2ef98f37c065aa7379764a92625369cd15dad43ea7cbe9ca52eb52ccc6', 'r1 self stray submission raw address drift');
expect(selfStrayRawDigests.trace === 'f3cf410a36f97f0e2a0476e5baf157620dcd907408444ddd5e9745b5f9c22f51', 'r1 self stray trace raw address drift');
let decisionParseError = null;
try { JSON.parse(readFileSync(join(REPO, R1_SELF.decision), 'utf8')); } catch (e) { decisionParseError = String(e.message).split('\n')[0]; }
expect(decisionParseError !== null, 'the r1 self stray decision file unexpectedly parses as JSON');
const selfStraySubmission = JSON.parse(readFileSync(join(REPO, R1_SELF.submission), 'utf8'));
const PHANTOM_CANDIDATE = 'f975e878501cac72035467a6dc197705a8e3680e24c0c2ce9f021587ee57c6e6';
const INVENTED_REFS = [
  'fbe292e862ab174b29de15cbbf85b34e4211b3a0e508fd39245015c9ea12b180',
  'c9bfe922c5891e8bfeaaf07864a75d3beaa5239dd455d6bb889f1eef4b3dd0fc',
  '423be112883976126a9b2718226aa68628fbe5d60253e0c0c849d66925062035',
  'd7ce453b9dbb1aa1cecda1d591779b92dc347220c9f4f19c6db86629f5a18c2b',
  'f7acf9d19953686e3042a10755a867a8f80a7fdb3963bd8e78e725962c792276',
  'c292f69407b0d7752008069ac095dc556522ed5df9f386b9e2ec5bf31909e8f0',
  'f3d0a6a4aea6909d35d8e5368425b21b38799b7f44444d926176083b532c011b',
];
expect(selfStraySubmission.subjectCandidateSetRef === shaRef(PHANTOM_CANDIDATE), 'r1 self stray phantom candidate drift');
expect(selfStraySubmission.productRef === 'sha256:settle-formalization-reviewer-product-2026-08-27', 'r1 self stray productRef label drift');
for (const ref of [...INVENTED_REFS, PHANTOM_CANDIDATE]) {
  expect(!Object.values(ENVELOPE).includes(ref), `invented ref ${ref} collides with the task-projection envelope`);
}

/* ------------------------------------------------------------------ */
/* The immediate upstream gate: the arch desk (hold + NEW reviewer      */
/* refusal of record) and the chain beneath                             */
/* ------------------------------------------------------------------ */

/* The r5 arch author hold + verifier. */
const archHold = record(`${R5}/define-architecture-contract-desk-upstream-hold.artifact.json`);
const archHoldTrc = record(`${R5}/define-architecture-contract-desk-upstream-hold-trace.json`);
expect(archHold.contentDigest === '6a32f180f10366833f0c2be102704749379fb7c2c13cca4c103c255c149d2023', 'r5 arch hold artifact drift');
expect(archHoldTrc.contentDigest === '1f54d1f317a9c0ec4f50f26b453112be72ca3abfca7859d07c4b454c5be8d6f3', 'r5 arch hold trace drift');
expect(archHold.content.decision === 'hold-no-authoring' && archHold.content.noProductAuthored === true, 'r5 arch hold decision drift');
const archHoldVerifyOut = JSON.parse(readFileSync(join(REPO, `${R5}/define-architecture-contract-desk-hold-verify-out.json`), 'utf8'));
expect(archHoldVerifyOut.summary.allPass === true && archHoldVerifyOut.summary.total === 29, 'r5 arch hold verifier no longer green');

/* NEW since the prior reviewer record: the arch gate reviewer refusal. */
const frArch = record(`${R6}/define-architecture-contract-desk-reviewer-review.json`);
const vvArch = record(`${R6}/define-architecture-contract-desk-reviewer-verification.json`);
const rtArch = record(`${R6}/define-architecture-contract-desk-reviewer-trace.json`);
const fsArch = record(`${R6}/define-architecture-contract-desk-reviewer-product-submission.json`);
expect(frArch.contentDigest === 'd813908b481afeba8466fc1ad6734338b59df766da7c08ed3cb8d12f08798511' && frArch.content.verdict === 'hold-upheld', 'FR-Define-Architecture-Contract-001 drift');
expect(vvArch.contentDigest === '63c0ff37ac8eca0c15e747e625fd0ceb77d6e03e602a1b64e67d138b36e086a1', 'VV-Define-Architecture-Contract-002 drift');
expect(rtArch.contentDigest === 'e7965ac30699c394e66936dc3bbf3a6db28fedc7a805edd87f8e68e6d6f3d3a3', 'RT-Define-Architecture-Contract-001 drift');
expect(fsArch.contentDigest === '600a6d4fa2cac4558a446b27194ea68cc95ecb3ea1cc6f5ff15336178596dfda' && fsArch.content.payloadContract?.effectFired === false, 'FS-Define-Architecture-Contract-Reviewer-001 drift');
expect(frArch.content.reviewedCandidate?.artifactRef === shaRef(archHold.contentDigest), 'arch reviewer candidate binding drift');
expect(frArch.content.claimedAcceptanceAdjudication?.adjudication?.startsWith('REFUSED as acceptance authority') === true, 'arch reviewer phantom adjudication drift');
const archVerifyOut = JSON.parse(readFileSync(join(REPO, `${R6}/define-architecture-contract-desk-reviewer-verify-out.json`), 'utf8'));
expect(archVerifyOut.summary.allPass === true && archVerifyOut.summary.total === 53, 'arch reviewer verifier no longer green');

/* The r4 freeze refusal round + the standing r3 hold + confirmations. */
const frFreeze = record(`${R4}/freeze-what-baseline-desk-reviewer-review.json`);
const vvFreeze = record(`${R4}/freeze-what-baseline-desk-reviewer-verification.json`);
const rtFreeze = record(`${R4}/freeze-what-baseline-desk-reviewer-trace.json`);
const fsFreeze = record(`${R4}/freeze-what-baseline-desk-reviewer-product-submission.json`);
expect(frFreeze.contentDigest === 'd52746b6620e8e4583592f1d23beff3053430d15ae8159643dcc7461b49d9190' && frFreeze.content.verdict === 'hold-upheld', 'FR-Freeze-What-Baseline-002 drift');
expect(vvFreeze.contentDigest === '8b04101005452d7906bcc1ca66f8f91d5ef6957518ae5af84f8a47f7e5781c21', 'VV-Freeze-What-Baseline-002 drift');
expect(rtFreeze.contentDigest === '8bf4f283ec152b8e9f9a4d3706227776b1723805c675ea2580ffa59e2259e252', 'RT-Freeze-What-Baseline-002 drift');
expect(fsFreeze.contentDigest === '6f5294a924e2fa9d94067b2c60d46f2bf0e199098fefd22f5df9325ea26b9eac' && fsFreeze.content.payloadContract?.effectFired === false, 'FS-Freeze-What-Baseline-Reviewer-001 drift');
const freezeHold = record(`${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`);
expect(freezeHold.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f', 'UH-Freeze-What-Baseline-001 drift');
const asConf = record(`${R3}/freeze-what-baseline-desk-restaff-confirmation.json`);
expect(asConf.contentDigest === 'c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06', 'AS-Freeze-What-Baseline-001 drift');
const rcConf = record(`${R3}/freeze-what-baseline-desk-reviewer-confirmation.json`);
expect(rcConf.contentDigest === 'c19344fd964655f226b777747b23b94da07877f2fc28614ea4a65c98c803ed44', 'RC-Freeze-What-Baseline-001 drift');

/* The census beneath the gate: 0 of 7 desks accepted (all rows recompute). */
const rwArt = record(`${R3}/reconcile-what-desk-what-reconciliation.artifact.json`);
const frRw = record(`${R3}/reconcile-what-desk-reviewer-review.json`);
const clRw = record(`${R3}/reconcile-what-desk-reviewer-collision-record.json`);
expect(rwArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191', 'reconcile-what artifact drift');
expect(frRw.contentDigest === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6' && frRw.content.verdict === 'repair', 'FR-Reconcile-What-001 drift');
expect(clRw.contentDigest === '841194ce90e5b2598812b72ba058d0d50dcf33a23818e2ed59bfcb9f6393a28d', 'CL-Reconcile-What-001 drift');
expect(frRw.content.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline'), 'gate prohibition text drift');

const intentArt = record(`${R3}/define-product-intent-desk-product-intent.artifact.json`);
const frIntent1 = record(`${R2}/define-product-intent-desk-reviewer-review.json`);
expect(intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055', 'intent artifact drift');
expect(frIntent1.content.verdict === 'repair' && frIntent1.contentDigest === 'e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4', 'intent verdict drift');
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

/* ------------------------------------------------------------------ */
/* The freeze payload contract + the installed settle desk contract     */
/* ------------------------------------------------------------------ */

const schemaBytes = readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json'));
const schemaRawDigest = shaRaw(schemaBytes);
expect(schemaRawDigest === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09', 'what-baseline schema pin drift');

const manifestSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'manifest.ts'), 'utf8');
expect(manifestSrc.includes("id: 'settle-formalization'") && manifestSrc.includes("outputProductKind: 'frf-contracts.solution-contract.v1'") && manifestSrc.includes("checkProviderId: 'formalization.settlement-structure.v1'"), 'installed manifest settle desk row drift');
expect(manifestSrc.includes("{ from: 'define-architecture-contract', to: 'settle-formalization', on: 'domain.accepted' }"), 'installed manifest inbound edge drift');
expect(manifestSrc.includes("{ from: 'settle-formalization', to: 'complete-formalized', on: 'domain.formalized' }") && manifestSrc.includes("{ from: 'settle-formalization', to: 'complete-inconsistent', on: 'domain.inconsistent' }") && manifestSrc.includes("{ from: 'settle-formalization', to: 'complete-failed', on: 'domain.failed' }"), 'installed manifest outbound edges drift');
expect(manifestSrc.includes("{ providerId: 'formalization.settlement-structure.v1', nodeId: 'settle-formalization', productKind: 'frf-contracts.solution-contract.v1', validator: 'settleSolutionContract' }"), 'installed check-provider row drift');
const settlementSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'settlement.mjs'), 'utf8');
expect(settlementSrc.includes("'frozenBaseline',") && settlementSrc.includes("'baselineArtifact',") && settlementSrc.includes("'srs',") && settlementSrc.includes("'repositoryPolicyRefs',") && settlementSrc.includes("'handoff',"), 'settlement input classes drift');
expect(settlementSrc.includes('settlement never discovers authorities'), 'settlement fail-closed law text drift');
expect(settlementSrc.includes('postFreeze.settlement.solutionContractDigest'), 'self-seal surface drift');
const protocolSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'protocol.mjs'), 'utf8');
expect(protocolSrc.includes("MISSING_LINEAGE: 'failed'") && protocolSrc.includes("SETTLE_EFFECT_ID = 'formalization.settle-solution-contract'"), 'settle routing/effect drift');
const reviewerSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'reviewer.mjs'), 'utf8');
expect(reviewerSrc.includes('The reviewer never produces the baseline/contract itself') && reviewerSrc.includes('the verdict is the reviewer'), 'reviewer route law drift');
expect(reviewerSrc.includes('ref, digest, content'), 'reviewer route sealed-artifact binding drift');

/* The installed skill digests, recomputed by the documented canonical rule. */
expect(INSTALLED_SKILL.protocol === 'b88267a1df84ae503d0e9744734a26671506f7bb719cb7b457f8d5ad6745997f', 'installed protocol skill digest drift');
expect(INSTALLED_SKILL.semantic === 'b130ee25da08aa27133b2b277f2215c044832489bcb0afcd23e576b0fb925e85', 'installed settle semantic skill digest drift');
expect(SKILL.protocol !== INSTALLED_SKILL.protocol && SKILL.semantic !== INSTALLED_SKILL.semantic, 'frame pins unexpectedly match the installed manifest');

/* ------------------------------------------------------------------ */
/* Adjudication of the frame's upstream-accepted claim                  */
/* ------------------------------------------------------------------ */

/* A1: the claimed address hash-resolves to ZERO contents (three-body scan). */
const resolvedHits = SCAN.hashResolved[CLAIMED.address];
expect(resolvedHits.length === 0, `claimed address unexpectedly resolves: ${JSON.stringify(resolvedHits)}`);
/* A2: zero RATIFYING textual citations - every mention lives in the
 * phantom-adjudication families of THIS desk (the testbed settle reviewer
 * hold family, which refused the address at its debut, and the testbed
 * second author hold's verifier, which re-adjudicates it as the
 * settle-own-revision phantom in its F1 check), all of which REFUSE it. */
const LAWFUL_CITER_PREFIXES = [
  `${TESTBED}/settle-formalization-reviewer-hold`,
  `${TESTBED}/settle-formalization-author-hold2-verify.mjs`,
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
  processLaw: 'process-impossible: the desk of record authors no product (UH-Settle-Formalization-001, r6 author hold, recomputed; noProductAuthored=true, product_submit unused at the author stage; the testbed twins 8e1bcf73.../7ce5eb48... concur); no settle gate has ever returned outcome formalized, no intake receipt (admitted_for_reviewer_stage), no sealed contract and no reviewer verdict exists anywhere for this desk - an "accepted revision of settle-formalization" cannot exist on this chain',
  wrongReferentLaw: 'decisive even under a resolving reading: the entry names THIS desk\'s own revision, while settlement consumes the frozen whole-WHAT baseline (frf-contracts.what-baseline.v1) + the accepted SRS revision + the authored desk inputs (the twelve-kind handoff values and the post-freeze repository/policy authority refs) over the single inbound edge define-architecture-contract --domain.accepted--> settle-formalization, which has never lawfully fired (the arch desk is on record hold 6a32f180... with its r6 reviewer refusal of record d813908b...); a desk-own projection supplies no reviewable subject and cures neither dispatch refusal',
  textualMentions: {
    count: SCAN.textualMentions[CLAIMED.address],
    files: claimMentions,
    note: 'every mention lives in a phantom-adjudication family of THIS desk: the prior reviewer-stage adjudication set (UH-Settle-Formalization-002, factory-testbed round: the hold, its builder, its summary, its verifier receipt and its verifier script, all refusing the address) plus the testbed second author hold\'s verifier (UH-Settle-Formalization-003 verification, whose byte-equality note records the reviewer staffing\'s "desk-own phantom d751f194 and a projected 1-count" and whose F1 check adjudicates all FOUR phantom addresses resolving to NO content); at its debut staffing the address had ZERO mentions of any kind - the only mentions added since are its own refusal records; zero ratifying citations exist anywhere',
  },
  authorityAudit: {
    isWorkplaceProductionRevisionOfThisChain: false,
    reviewerStageAtThisAddress: false,
    hashResolvedContents: 0,
    ratifyingCitations: 0,
  },
  adjudication: 'REFUSED as acceptance authority (phantom-upstream-projection; stale shell metadata; CRIT-1 family)',
  parallelReviewerRecord: {
    semanticCode: 'UH-Settle-Formalization-002',
    ref: shaRef(tbHold.contentDigest),
    traceRef: shaRef(tbTrc.contentDigest),
    disposition: 'hold-no-review (typedWait external-availability); the SAME address adjudicated PHANTOM at its staffing (content-unresolved, process-impossible, wrong-referent) - the address DEBUTED at that reviewer staffing, the identical shell-projection debut pattern this frame family repeats at every desk',
    deltaAdjudicatedByThisRecord: 'the prior record scanned a staffing in which the address had ZERO prior mentions; THIS staffing\'s workspace-wide re-scan finds the address textually present ONLY inside its own prior adjudication set (the testbed settle reviewer hold family) and still hash-resolving to zero contents in all three body layers. The DISPOSITION is unchanged: both reviewer records refuse the claim. NEW since that record and carried into this package: (a) the r6 qualification-round author hold re-emission (b40d7616..., census 0 of 7, verifier 48/48); (b) the arch-gate reviewer refusal of record FR-Define-Architecture-Contract-001 (d813908b..., verifier 53/53) - the immediate upstream gate is now refused at reviewer stage, not merely held at author stage; (c) the testbed round\'s second consecutive author hold (7ce5eb48..., envelope byte-equal to hold #1 with ZERO upstream-accepted entries).',
  },
  familyHistory: 'the desk-own-revision phantom family (r2 ADV-4): requirements-desk 65fe9a22... ("accepted revision of derive-system-requirements", unresolved across five staffings), acceptance-desk 32892970... (testbed UH-Define-Acceptance-Contract-002), architecture-desk b7f34c48... (testbed UH-Define-Architecture-Contract-002; re-refused by the r6 arch reviewer package), and THIS desk-own d751f194... (testbed UH-Settle-Formalization-002 at its debut; re-adjudicated and refused here) - four desks, each variant debuting at that desk\'s reviewer staffing with a per-stage regenerated address',
  countDeltaLaw: 'the author frames of this desk carry ZERO upstream-accepted entries and the workspace line "0 accepted upstream revisions travel by content address" (r6 author hold frameAdjudication recomputed TRUE at census 0 of 7); the reviewer frame carries ONE entry and the line "1 accepted upstream revisions travel by content address". The count delta (0 -> 1) is stage-relative shell projection, not kernel supply: the lawful recomputed supply remains 0 accepted upstream revisions',
};

/* ------------------------------------------------------------------ */
/* Checks ledger (published through the VV record)                      */
/* ------------------------------------------------------------------ */

const checks = [];
const check = (id, pass, detail) => { checks.push({ id, pass: pass === true, detail }); return pass === true; };

check('A1.claimedAddressUnresolvable', resolvedHits.length === 0, `${shaRef(CLAIMED.address)} hash-resolves to zero contents across ${SCAN.files} files (raw, whole-JSON-canonical and .content-canonical layers; this round excluded)`);
check('A2.noRatifyingCitations', unexpectedMentions.length === 0, `all ${claimMentions.length} mention files live in lawful refusing adjudication families of this desk (the prior reviewer-stage set UH-Settle-Formalization-002; the testbed second author hold's verifier, whose F1 check adjudicates the address the settle-own-revision phantom resolving to NO content); zero ratifying citations`);
check('A3.skillPinsProvenanceOnly', SCAN.hashResolved[SKILL.protocol].length === 0 && SCAN.hashResolved[SKILL.semantic].length === 0, 'protocol/semantic skill digests resolve to no content; recorded verbatim, not ratified');
check('A4.installedPinsDiffer', INSTALLED_SKILL.protocol !== SKILL.protocol && INSTALLED_SKILL.semantic !== SKILL.semantic, `installed pins recompute (${shaRef(INSTALLED_SKILL.protocol)} / ${shaRef(INSTALLED_SKILL.semantic)}) and BOTH differ from the frame drift pair`);
check('A5.governingAnchorStillUnresolvable', SCAN.hashResolved[GOVERNING].length === 0, 'r2-era governing anchor still hash-resolves to zero contents (inherited debt; NOT pinned by this frame - it is the AUTHOR-frame pin carried by prior records as unratified provenance)');
check('B1.envelope8of8', envelopeRecompute.length === 8 && envelopeRecompute.every((e) => e.recomputed), 'all 8 task-projection addresses re-derive from the accepted capsule (9/9 with CERT-1)');
check('B2.importAccepted', importArt.contentDigest === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', 'the accepted discovery import chain recomputes; still the only accepted base');
check('B3.authorHoldByteStable', holdArt.contentDigest === 'b40d7616bb607ccfe389258829d304f065e1cac46888b6541c3c5c35b8402251' && holdTrc.contentDigest === 'f7ee0830d5812841dc70417fc3143a8030fadfd5d1018871aaab40c60c1b3bae', 'UH-Settle-Formalization-001 (r6) artifact/trace re-derive byte-stable; census 0 of 7; frame adjudication of the author frame recomputed TRUE');
check('B4.authorHoldVerifyGreen', holdVerifyOut.summary.allPass === true && holdVerifyOut.summary.total === 48, `r6 hold verifier still green (${holdVerifyOut.summary.pass}/${holdVerifyOut.summary.total})`);
check('B5.candidateOfRecordIdentity', holdArt.content.decision === 'hold-no-authoring' && holdArt.content.noProductAuthored === true && holdArt.content.deskContract.outputProductKind === 'frf-contracts.solution-contract.v1', 'the candidate of record is the r6 author-seat hold (hold-no-authoring, noProductAuthored, desk contract re-pinned)');
check('C1.testbedAuthorTwins', tbAuthorHold.contentDigest === '8e1bcf73542e217bd702e59d5879200c43c3e21e17d6b94a3f02b63b4d16d3a7' && tbAuthorTrc.contentDigest === 'f64e6346adce7fa2b52cb1bcd43a50528d51e6c9b295d04a195d970fd700f933' && tbAuthorHold2.contentDigest === '7ce5eb48a8c0d4c4a8671eb330989da9fa28e1462383b076e9d194fbf8075708', 'the testbed author holds recompute (hold #1 8e1bcf73... with trace f64e6346...; hold #2 UH-Settle-Formalization-003 7ce5eb48..., envelope byte-equal to hold #1 with ZERO upstream-accepted entries); both verifier receipts VERIFIED with 0 fails');
check('C2.priorReviewerRecordRecomputes', tbHold.contentDigest === '792b6ce07899114b47b1728cc8e0c9bd5ed867f4d4ad7024d0d83a6559c7f7f3' && tbTrc.contentDigest === 'cfca9e19b7824af07b5f5adc164a238b98d31ff056375df05ff8f420f6d870da' && tbVerifyOut.decision === 'VERIFIED' && tbVerifyOut.checks.length === 34, 'UH-Settle-Formalization-002 (the prior reviewer-stage record on THIS EXACT frame) recomputes: hold-no-review, phantom adjudication of d751f194..., verifier 34/34');
check('C3.r1SelfStrayFamilyRecomputes', selfStrayRawDigests.decision === 'ad698a85b0a76d8c7be5220c9300c2413dea6f70fd28e162b09ab68519f8e2ed' && selfStrayRawDigests.submission === '0b0c9d2ef98f37c065aa7379764a92625369cd15dad43ea7cbe9ca52eb52ccc6' && selfStrayRawDigests.trace === 'f3cf410a36f97f0e2a0476e5baf157620dcd907408444ddd5e9745b5f9c22f51' && decisionParseError !== null, 'the r1 reviewer-seat stray family recomputes at the raw-bytes layer (decision unparseable; label pseudo-addresses; phantom candidate set f975e878...); retired, never lineage');
check('D1.gateReviewerRefusalNowExists', frArch.contentDigest === 'd813908b481afeba8466fc1ad6734338b59df766da7c08ed3cb8d12f08798511' && frArch.content.verdict === 'hold-upheld' && archVerifyOut.summary.allPass === true && archVerifyOut.summary.total === 53, 'NEW adjudication content: FR-Define-Architecture-Contract-001 (the immediate upstream gate reviewer refusal of record, verifier 53/53) recomputes - the gate is refused at reviewer stage, not merely held at author stage');
check('D2.archHoldByteStable', archHold.contentDigest === '6a32f180f10366833f0c2be102704749379fb7c2c13cca4c103c255c149d2023' && archHoldTrc.contentDigest === '1f54d1f317a9c0ec4f50f26b453112be72ca3abfca7859d07c4b454c5be8d6f3', 'the r5 arch author hold recomputes byte-stable (verifier 29/29); the arch reviewer package binds it as its reviewed candidate');
check('D3.freezeRefusalRecomputes', frFreeze.content.verdict === 'hold-upheld' && fsFreeze.content.payloadContract?.effectFired === false, 'FR-Freeze-What-Baseline-002 recomputes: freeze ratification REFUSED, effect never fired');
check('D4.freezeRoundRecomputes', [vvFreeze, rtFreeze, fsFreeze, freezeHold, asConf, rcConf].every((r) => r.contentDigest.length === 64), 'the freeze reviewer round + standing hold + confirmations recompute');
check('D5.prohibitionUndischarged', frRw.content.nextStage.includes('No domain.accepted may fire from this desk toward freeze-what-baseline') && frRw.content.verdict === 'repair', 'no-accept prohibition recomputes and stands undischarged (FR-Reconcile-What-001, repair)');
check('D6.censusZeroOfSeven', intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055' && frIntent1.content.verdict === 'repair' && ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b' && srArt.contentDigest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df' && frSr1.content.verdict === 'repair' && acArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0' && frAc2.content.verdict === 'repair' && rwArt.contentDigest === '6400a2dd78e9c3e74b7e83d9b7416fd71fc1017146d226a240e85e067ebdf191' && freezeHold.contentDigest === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f', 'all seven upstream-desk rows recompute; census remains 0 of 7 accepted');
check('E1.deskDeclarationRecomputes', manifestSrc.includes("outputProductKind: 'frf-contracts.solution-contract.v1'") && manifestSrc.includes("{ from: 'define-architecture-contract', to: 'settle-formalization', on: 'domain.accepted' }"), 'the installed desk declaration re-derives from the installed manifest source (kernel node, frf-contracts.solution-contract.v1, formalization.settlement-structure.v1/settleSolutionContract, the domain.accepted inbound edge, the three outbound edges)');
check('E2.ladderLawRecomputes', settlementSrc.includes('settlement never discovers authorities') && settlementSrc.includes('postFreeze.settlement.solutionContractDigest') && protocolSrc.includes("MISSING_LINEAGE: 'failed'"), 'the settlement ladder law recomputes from source (R1 pins - never discovers authorities; R2 twelve-kind binding resolution; R3 self-seal; MISSING_LINEAGE -> failed routing)');
check('E3.reviewerRouteLawRecomputes', reviewerSrc.includes('The reviewer never produces the baseline/contract itself') && reviewerSrc.includes('ref, digest, content'), 'the reviewer route law recomputes from source: the verdict is the reviewer\'s only product, bound to the exact sealed artifact + canonical digest - over an absent candidate the verdict vocabulary stays uncomputed');
check('F1.deterministicAuthoring', CREATED_AT === '2026-08-28T02:00:00Z', 'pinned timestamps, no clock reads, no randomness');
check('G1.scanHonest', SCAN.files > 2000 && SCAN.textualMentions[GOVERNING] > 0 && claimMentions.length > 0, `${SCAN.files} workspace files scanned across three body layers; the claimed address now HAS textual mentions (${claimMentions.length} files, all in its own prior adjudication set) while resolving to nothing; the inherited anchor remains textually carried by the corpus (${SCAN.textualMentions[GOVERNING]} files)`);

const passCount = checks.filter((c) => c.pass).length;
expect(passCount === checks.length, `a basis check failed: ${JSON.stringify(checks.filter((c) => !c.pass))}`);

/* ------------------------------------------------------------------ */
/* VV record (built first; cited by the review)                         */
/* ------------------------------------------------------------------ */

const vvContent = {
  verificationId: 'VV-Settle-Formalization-001',
  semanticCode: 'VV-Settle-Formalization-001',
  deskRef: 'settle-formalization',
  role: 'reviewer',
  reviewedRound: SELF_ROUND,
  subject: 'mechanical verification underlying FR-Settle-Formalization-Reviewer-001 (frame authority adjudication + chain state recomputation)',
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
      parallelScanDelta: 'UH-Settle-Formalization-002 scanned the address\'s DEBUT staffing (zero prior mentions); this workspace-wide re-scan finds exactly the prior adjudication set as mentioners and still zero hash-resolutions. Disposition unchanged: refused by both reviewer records.',
    },
    frameSkillPins: {
      protocolSkill: shaRef(SKILL.protocol),
      semanticSkill: shaRef(SKILL.semantic),
      hashResolvedContents: 0,
      installedManifestPins: { protocolSkill: shaRef(INSTALLED_SKILL.protocol), semanticSkill: shaRef(INSTALLED_SKILL.semantic) },
      disposition: 'the reviewer-frame drift pair (byte-equal to the pair the testbed reviewer staffing recorded); envelope provenance recorded verbatim; not ratified by this seat; the installed pins recompute and differ',
    },
    governingAnchor: {
      address: shaRef(GOVERNING),
      hashResolvedContents: 0,
      disposition: 'inherited r2/r3 debt; the AUTHOR-frame pin carried by prior records as unratified provenance; NOT pinned by this round frame; still open',
    },
  },
  deterministicAuthoring: true,
};
const vv = {
  artifactRef: shaRef(sha(vvContent)),
  artifactKind: 'reviewer-verification',
  contentDigest: sha(vvContent),
  semanticCode: 'VV-Settle-Formalization-001',
  createdAt: CREATED_AT,
  deskRef: 'settle-formalization',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: vvContent,
};

/* ------------------------------------------------------------------ */
/* FR review artifact (the reviewer refusal of record)                  */
/* ------------------------------------------------------------------ */

const frContent = {
  reviewId: 'FR-Settle-Formalization-Reviewer-001',
  semanticCode: 'FR-Settle-Formalization-001',
  deskRef: 'settle-formalization',
  role: 'reviewer',
  reviewedRound: SELF_ROUND,
  provenanceNote: 'UH-Settle-Formalization-002 (factory-testbed round, 792b6ce0...) is the review-sequence predecessor at this desk - a hold-no-review on THIS EXACT frame; recorded and carried forward, extended by this package with the new content since (the r6 author hold re-emission, the arch-gate reviewer refusal of record, and the corpus-wide mention re-scan).',
  reviewedCandidate: {
    artifactRef: shaRef(holdArt.contentDigest),
    traceRef: shaRef(holdTrc.contentDigest),
    productKind: 'formalization.upstream-hold.v1',
    declaredDecision: 'hold-no-authoring',
    note: 'the candidate of record at this desk is the r6 author-seat settlement upstream hold (the latest author emission of the qualification series; the testbed twins 8e1bcf73.../7ce5eb48... recompute byte-stable as predecessor evidence, same decision); NO solution-contract candidate exists at this desk (noProductAuthored: true; product_submit unused at the author stage) - none was ever lawfully authorable on this chain',
  },
  verificationRef: shaRef(vv.contentDigest),
  verificationSummary: { recomputedChecks: checks.length, passed: passCount, failed: 0, trustedByDeclaration: false },
  envelopeConsistency: {
    taskProjectionContentAddresses: 8,
    resolved: 8,
    adjudicated: 1,
    note: "All 8 claim/constraint/unknown/terminal addresses match this frame exactly and re-derive from the accepted capsule (9/9 with CERT-1). The frame carries the reviewer drift pair bc8a4261.../2cbcf850... as skill pins (hash-resolve to no content; recorded as provenance), the tool-schemas layer and write authority 'candidate-read,product-read,product-submit' (recorded verbatim), plus upstream-accepted[0] sha256:d751f194... :: 'accepted revision of settle-formalization' and the workspace line 'workspace: 1 accepted upstream revisions travel by content address' - adjudicated below at the content layer. This frame pins NO governingContractRef; the r2-era anchor a926df6284... (the author-frame pin carried by prior records) remains unresolvable workspace-wide. The author frames of this desk carry ZERO upstream-accepted entries; this reviewer frame's count delta (0 -> 1) is stage-relative shell projection, not kernel supply.",
  },
  workspaceLaw: `frame claim, verbatim: "${CLAIMED.workspaceSummary}" (upstream-accepted[0] ${shaRef(CLAIMED.address)} :: ${CLAIMED.label}) - adjudicated FALSE at the status layer: the address hash-resolves to zero workspace contents and is process-impossible and wrong-referent; the truthful recomputed census is 0 of 7 accepted upstream desks; the desk of record holds noProductAuthored=true; the inbound domain.accepted edge has never lawfully fired.`,
  reviewerSequence: {
    first: {
      semanticCode: 'UH-Settle-Formalization-002',
      ref: shaRef(tbHold.contentDigest),
      kind: 'reviewer-seat desk hold (hold-no-review, typedWait external-availability; no FR/VV/RT/FS package minted: no candidate existed to review)',
      disposition: 'hold-no-review; frame address adjudicated PHANTOM at its DEBUT (content-unresolved, process-impossible, wrong-referent)',
    },
    thisRecord: 'FR-Settle-Formalization-Reviewer-001 is the SECOND reviewer-stage record at this desk and mints the desk\'s first content-addressed FR/VV/RT/FS reviewer package. This is NOT a re-emission of identical semantics (the idempotency law is respected): NEW adjudication content exists since the prior record - (a) the r6 qualification-round author hold re-emission UH-Settle-Formalization-001 (b40d7616..., census 0 of 7, verifier 48/48), which supersedes-in-sequence the testbed author holds as the candidate of record; (b) the immediate upstream gate now carries a reviewer refusal of record - FR-Define-Architecture-Contract-001 (d813908b..., verifier 53/53) - which the prior record recorded as absent; (c) the address d751f194... now HAS corpus mentions - exactly its own prior adjudication set - while still resolving to zero contents; (d) the testbed round\'s second consecutive author hold (7ce5eb48...) with the author envelope re-pinned at ZERO upstream-accepted entries. The prior record\'s disposition is carried forward unchanged; its staffing-scoped scan finding is superseded by this workspace-wide three-body re-scan.',
    authorRestaffContext: 'the author seat of record is the r6 hold (hold-no-authoring, census 0 of 7, verifier 48/48); its resume contract R1-R5 is the desk\'s current lawful path',
  },
  claimedAcceptanceAdjudication: adjudication,
  findings: {
    positiveFindings: [
      'The envelope recomputes 8/8 from the accepted capsule (9/9 including CERT-1); the discovery import chain remains the only genuinely accepted base.',
      'The author-seat hold of record (UH-Settle-Formalization-001, r6, b40d7616... / trace f7ee0830...) re-derives byte-stable with its 48/48 verifier green; the testbed author twins (8e1bcf73..., 7ce5eb48...) recompute as consistent predecessor evidence, both verifier receipts VERIFIED with 0 fails.',
      'The claimed accepted revision was adjudicated at the CONTENT layer, not by label: a workspace-wide three-body scan hash-resolves d751f194... to ZERO contents, and every textual mention is the desk\'s own prior refusing adjudication set (the address\'s debut adjudication at UH-Settle-Formalization-002).',
      'Two independent reviewer staffings agree on the disposition: UH-Settle-Formalization-002 (hold-no-review, phantom adjudication at the address\'s debut) and this seat (hold-upheld, claim refused); the reviewer package is minted only because new adjudication content exists since the prior record.',
      'The immediate upstream gate is now refused at REVIEWER stage: FR-Define-Architecture-Contract-001 (d813908b..., verifier 53/53) recomputes and binds the r5 arch hold (6a32f180...) as its reviewed candidate - the single inbound edge define-architecture-contract --domain.accepted--> settle-formalization is refused-at-source, not merely unstaffed upstream.',
      'The freeze gate recomputes exactly: freeze ratification REFUSED by FR-Freeze-What-Baseline-002 (d52746b6..., effect never fired), the standing freeze hold (9f2d28b9...) with AS-001/RC-001 confirmations, and the no-accept prohibition of FR-Reconcile-What-001 (39a94a29..., repair) undischarged.',
      'The census recomputes 0 of 7: intent repair x3, UC never reviewed at its own content address, SRS repair with held reviewer seat, acceptance adjudicated repair on record hold, reconcile-what repair with the prohibition, freeze with no candidate ever authored, architecture on hold with reviewer refusal - none accepted.',
      'The installed desk declaration re-derives from the installed manifest and cell sources (kernel node, frf-contracts.solution-contract.v1, formalization.settlement-structure.v1/settleSolutionContract, the domain.accepted inbound edge, the R1/R2/R3 ladder, MISSING_LINEAGE -> failed routing, and the reviewer route law: the verdict is the reviewer\'s only product, bound to the exact sealed artifact + canonical digest).',
      'The r1 reviewer-seat stray family of this desk recomputes at the raw-bytes layer exactly as retired: decision unparseable (ad698a85...), label pseudo-addresses, phantom candidate set f975e878... plus the 7 invented refs - none collides with this envelope; never lineage.',
    ],
    advisoryNotes: [
      {
        type: 'verdict_semantics',
        note: 'This seat\'s verdict "hold-upheld" follows the r4/r6 reviewer-stage-of-record semantics (the candidate of record is the author-seat hold, verified and upheld). No product verdict (accepted/rejected) is minted - the reviewer verdict vocabulary is a pure function over the exact sealed candidate artifact and stays uncomputed over the absent subject, exactly as the prior record and the installed reviewer route require. The FS package is a review-complete refusal record with effectFired: false; product_submit is used only to lodge it.',
      },
      {
        type: 'frame_family_history',
        note: adjudication.familyHistory,
      },
      {
        type: 'count_delta_law',
        note: adjudication.countDeltaLaw,
      },
    ],
    criticalIssues: [
      {
        id: 'CRIT-1',
        severity: 'CRITICAL',
        title: 'Frame declares an accepted desk-own revision; the address is a phantom - unresolved, process-impossible, wrong-referent',
        detail: `The frame's workspace line ("${CLAIMED.workspaceSummary}") and its upstream-accepted[0] entry assert accepted-chain authority. Mechanical resolution: ${shaRef(CLAIMED.address)} hash-resolves to ZERO workspace contents in all three body layers over ${SCAN.files} files; its ${SCAN.textualMentions[CLAIMED.address]} textual mentions are exactly its own prior adjudication set (the testbed settle reviewer hold family, which refused it at the address's debut). Process-impossible: this desk's author seat of record holds noProductAuthored=true with product_submit unused; no settle gate has ever returned outcome formalized; no intake receipt, sealed contract or reviewer verdict exists anywhere for this desk, so an "accepted revision of settle-formalization" cannot exist. Wrong-referent: even under a resolving reading, the entry names THIS desk's own revision, while settlement consumes the frozen whole-WHAT baseline + the accepted SRS revision + the authored desk inputs over the never-fired domain.accepted edge. A settlement or review ratified over this "upstream" would inherit the fabricated authority permanently.`,
        requiredAction: 'Verdict: refuse the claim as acceptance authority. Lawful path unchanged: resume contract R1-R5 of the r6 author hold (the freeze desk R1-R4 completes first; the arch desk re-staffs against the REAL frozen baseline; authoring precedes any reviewer stage; the holds are never carried as product lineage; the r1 reviewer-seat stray family stays retired).',
      },
      {
        id: 'CRIT-2',
        severity: 'CRITICAL',
        title: 'No sealed candidate exists at this desk to review; the reviewer stage stays closed over products, and the terminal ladder makes fabrication self-destructive',
        detail: 'The reviewer verdict vocabulary (accepted/rejected) is a pure function over the exact sealed candidate artifact + canonical digest (the installed reviewer route, recomputed from source) and cannot be honestly computed over an absent subject: no solution-contract candidate was ever authored (noProductAuthored=true across all four author emissions), no author product submission exists, and no intake receipt (admitted_for_reviewer_stage) was ever issued at this desk. Additionally, per the prior reviewer-stage record (recomputed byte-stable, which re-proved the dispatch behavior live at its staffing): the settlement dispatch on a malformed/fabricated candidate returns verdict terminal-reject with outcome failed - a fabricated candidate would not repair, it would terminally fail the whole formalization flow at complete-failed. Minting an accepted verdict over nothing would be the fabricated-desk-history class this conveyor exists to catch.',
        requiredAction: 'No product verdict is minted. The candidate of record (the r6 author-seat hold) is verified and upheld; product_submit is used only to lodge this review-complete refusal package with effectFired: false.',
      },
      {
        id: 'CRIT-3',
        severity: 'CRITICAL',
        title: 'The inbound edge has never lawfully fired; the immediate upstream gate is now refused at reviewer stage',
        detail: 'The single inbound edge define-architecture-contract --domain.accepted--> settle-formalization has never lawfully fired: the arch desk of record holds noProductAuthored (UH-Define-Architecture-Contract-001, 6a32f180..., verifier 29/29) and - NEW since the prior reviewer record - its reviewer seat has now minted the refusal of record FR-Define-Architecture-Contract-001 (d813908b..., hold-upheld, verifier 53/53, frame claim refused). Beneath it, the freeze ratification stands REFUSED (d52746b6..., effect never fired) and the no-accept prohibition of FR-Reconcile-What-001 (39a94a29...) stands undischarged. Therefore no frozen WHAT baseline exists, no accepted SRS revision exists, and NONE of the five settlement input classes exists: any lawful ladder run refuses at R1 with MISSING_LINEAGE, routed to the outcome failed.',
        requiredAction: 'The prohibition stands. This seat upholds the author hold and refuses any settlement authoring or review on this chain state.',
      },
    ],
    majorIssues: [
      {
        id: 'MAJ-1',
        severity: 'MAJOR',
        title: 'Frame skill digests resolve to no workspace content; the reviewer-frame drift pair is stable across staffings; the anchor debt remains open',
        detail: `The frame pins protocol-skill ${shaRef(SKILL.protocol)} and semantic-skill ${shaRef(SKILL.semantic)}; both hash-resolve to zero workspace contents (mentioned textually ${SCAN.textualMentions[SKILL.protocol]}/${SCAN.textualMentions[SKILL.semantic]} times as standing frame pins). The installed manifest pins recompute (${shaRef(INSTALLED_SKILL.protocol)} / ${shaRef(INSTALLED_SKILL.semantic)}) and BOTH differ. The pin-swap pattern is now stable: AUTHOR frames pin the pair a926df6284.../95fafc847b... (the r2/r3-era anchor debt), REVIEWER frames pin this pair bc8a4261.../2cbcf850... - byte-equal at both settle reviewer staffings (the testbed one and this one). Both pairs are envelope provenance, never ratified. The author-frame anchor a926df6284... also still resolves to zero contents - the anchor debt remains open; this round's frame pins no governingContractRef at all.`,
        requiredAction: 'The frame issuer must materialize the skill/anchor refs as real content-addressed material (or re-pin to what exists) before any future settlement may cite them.',
      },
    ],
  },
  acceptanceCriteria: [
    { id: 1, description: 'Content-addressed reviewer artifacts: every ref is sha256 over canonical JSON of content', satisfied: true, evidence: 'VV/FR/RT/FS self-address and cross-bind; single-dereference evidence list in the submission' },
    { id: 2, description: 'Independent recomputation performed by this seat; nothing trusted by declaration', satisfied: true, evidence: `A-G check groups re-run (${checks.length}/${checks.length} pass); ${SCAN.files} files scanned` },
    { id: 3, description: 'All 8 reviewer-frame task-projection content addresses resolved', satisfied: true, evidence: 'B1: 8/8 exact from the accepted capsule' },
    { id: 4, description: "The frame's upstream-accepted entry adjudicated at the content layer, not by label", satisfied: true, evidence: 'A1-A2: zero hash-resolutions workspace-wide (three body layers); the only mentions are the address\'s own debut adjudication set' },
    { id: 5, description: 'Verdict grounded in re-digested records, not round labels or prior review text', satisfied: true, evidence: 'B3-B5, C1-C3, D1-D6, E1-E3: author holds, the gate reviewer refusal, freeze refusal round, confirmations, all seven census rows, the prior reviewer record, the r1 stray family and the installed desk/reviewer-route law re-digested' },
    { id: 6, description: 'constraint:retention-1 honored; unknown:browser-matrix-1 carried forward, never resolved by the review', satisfied: true, evidence: 'no disposition, binding or resolution authored by this seat; the 8 envelope claims observed as content addresses only' },
    { id: 7, description: 'Reviewer artifacts deterministic: pinned timestamps, no clock reads, no randomness', satisfied: true, evidence: 'pinned CREATED_AT; deterministic builder; no randomness' },
    { id: 8, description: 'Frame workspace summary TRUE of the chain', satisfied: false, note: 'CRIT-1 recorded honestly: the one projected address is a desk-own phantom; census 0 of 7; the count delta from the author frames is shell projection' },
    { id: 9, description: 'A sealed solution-contract candidate exists at this desk to review', satisfied: false, note: 'none ever lawfully authored; the candidate of record is the author-seat hold, which this seat verifies and upholds; no product verdict is minted' },
    { id: 10, description: 'The claimed accepted revision is a chain WorkplaceProductionRevision with a completed reviewer stage', satisfied: false, note: 'CRIT-1 recorded honestly: phantom address, process-impossible, wrong-referent' },
  ],
  verdict: 'hold-upheld',
  decision: 'REFUSE the frame upstream-accepted claim as acceptance authority (phantom-upstream-projection, desk-own-revision family); uphold UH-Settle-Formalization-001 (r6 author hold); mint no solution-contract product verdict over the absent candidate; the desk awaits resume contract R1-R5',
  nextStage: 'HOLD STANDS - no settlement authoring or review may occur at this desk on this chain state. Resume contract R1-R5 of the r6 author hold unchanged: (R1) the freeze desk resume contract R1-R4 completes first - genuinely accepted revisions land for the four upstream desks through completed reviewer stages at their own content addresses, RA-5 re-runs reconcile-what over the NEW accepted chain, its reviewer verdict alone discharges the no-accept prohibition, and the freeze ratifies on five accepted pre-freeze desks; (R2) domain.frozen fires only from the ratified freeze; the define-architecture-contract desk re-staffs against the REAL frozen WHAT-baseline revision, authors a genuine sealed SRS and passes a completed reviewer stage - domain.accepted fires only from that accepted revision (its reviewer refusal of record d813908b... is the current gate state); (R3) this desk re-staffs only with ALL FIVE settlement input classes - never a fixture, never a stray product, never a frame assertion; (R4) settlement runs the ladder exactly (pins -> binding resolution -> seal; A2 fence) before emitting domain.formalized; (R5) this hold, the prior reviewer hold and this refusal are not carried as product lineage; the r1 reviewer-seat stray family stays retired - not resumed, not repaired in place, not re-submitted.',
};
const fr = {
  artifactRef: shaRef(sha(frContent)),
  artifactKind: 'formalization-review',
  contentDigest: sha(frContent),
  semanticCode: 'FR-Settle-Formalization-001',
  createdAt: CREATED_AT,
  deskRef: 'settle-formalization',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: frContent,
};

/* ------------------------------------------------------------------ */
/* RT trace                                                             */
/* ------------------------------------------------------------------ */

const resolveId = (id) => {
  if (ENVELOPE[id] !== undefined) return ENVELOPE[id];
  if (id === 'FR-Settle-Formalization-001') return sha(frContent);
  if (id === 'VV-Settle-Formalization-001') return sha(vvContent);
  if (id === 'UH-Settle-Formalization-001') return holdArt.contentDigest;
  if (id === 'RT-UH-Settle-Formalization-001') return holdTrc.contentDigest;
  if (id === 'UH-Settle-Formalization-001@factory-testbed') return tbAuthorHold.contentDigest;
  if (id === 'RT-UH-Settle-Formalization-001@factory-testbed') return tbAuthorTrc.contentDigest;
  if (id === 'UH-Settle-Formalization-003@factory-testbed') return tbAuthorHold2.contentDigest;
  if (id === 'UH-Settle-Formalization-002@factory-testbed') return tbHold.contentDigest;
  if (id === 'RT-UH-Settle-Formalization-002@factory-testbed') return tbTrc.contentDigest;
  if (id === 'UH-Define-Architecture-Contract-001') return archHold.contentDigest;
  if (id === 'RT-UH-Define-Architecture-Contract-001') return archHoldTrc.contentDigest;
  if (id === 'FR-Define-Architecture-Contract-001') return frArch.contentDigest;
  if (id === 'VV-Define-Architecture-Contract-002') return vvArch.contentDigest;
  if (id === 'RT-Define-Architecture-Contract-001') return rtArch.contentDigest;
  if (id === 'FS-Define-Architecture-Contract-Reviewer-001') return fsArch.contentDigest;
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
  if (id === 'CL-Reconcile-What-001') return clRw.contentDigest;
  if (id === 'link:define-product-intent') return intentArt.contentDigest;
  if (id === 'link:model-use-cases') return ucArt.contentDigest;
  if (id === 'link:derive-system-requirements') return srArt.contentDigest;
  if (id === 'link:define-acceptance-contract') return acArt.contentDigest;
  if (id === 'link:reconcile-what') return rwArt.contentDigest;
  if (id === 'UH-Model-Use-Cases-001') return ucHoldR2.contentDigest;
  if (id === 'UH-Define-Acceptance-Contract-001') return uhAc.contentDigest;
  if (id === 'FR-Define-Acceptance-Contract-002') return frAc2.contentDigest;
  if (id === 'r1selfstray:settle-reviewer-decision') return selfStrayRawDigests.decision;
  if (id === 'r1selfstray:settle-reviewer-submission') return selfStrayRawDigests.submission;
  if (id === 'r1selfstray:settle-reviewer-trace') return selfStrayRawDigests.trace;
  if (id === 'r1selfstray:phantom-candidate-set') return PHANTOM_CANDIDATE;
  if (id === 'phantom:d751f194') return CLAIMED.address;
  if (id === 'schema:what-baseline') return schemaRawDigest;
  if (id === 'framepin:protocol-skill') return SKILL.protocol;
  if (id === 'framepin:semantic-skill') return SKILL.semantic;
  if (id === 'installed:protocol-skill') return INSTALLED_SKILL.protocol;
  if (id === 'installed:semantic-skill') return INSTALLED_SKILL.semantic;
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
const S = 'FR-Settle-Formalization-001';
const relationships = [
  ...Object.keys(ENVELOPE).map((id) => rel(S, 'verifies', id, `This review's envelope projection recomputes ${id} from accepted capsule content; digest matches this desk task projection.`)),
  rel(S, 'verifies', 'UH-Settle-Formalization-001', 'The author-seat hold of record (r6) re-derives byte-stable with its 48/48 verifier green; verdict hold-upheld recorded by this review.'),
  rel(S, 'verifies', 'RT-UH-Settle-Formalization-001', 'The author hold trace of record recomputes.'),
  rel(S, 'observes', 'UH-Settle-Formalization-001@factory-testbed', 'The testbed-round author hold #1 (8e1bcf73..., hold-no-authoring, verifier 23/23); consistent predecessor evidence.'),
  rel(S, 'observes', 'RT-UH-Settle-Formalization-001@factory-testbed', 'The testbed author hold #1 trace (f64e6346...).'),
  rel(S, 'observes', 'UH-Settle-Formalization-003@factory-testbed', 'The testbed-round author hold #2 (7ce5eb48..., envelope byte-equal to hold #1 with ZERO upstream-accepted entries; verifier 28/28) - the author frame count baseline this reviewer frame\'s count delta is measured against.'),
  rel(S, 'observes', 'UH-Settle-Formalization-002@factory-testbed', "The desk's first reviewer-stage record: hold-no-review on THIS EXACT frame; adjudicated d751f194... PHANTOM at the address's debut. Disposition carried forward unchanged."),
  rel(S, 'observes', 'RT-UH-Settle-Formalization-002@factory-testbed', 'The prior reviewer record trace (cfca9e19...).'),
  rel(S, 'observes', 'phantom:d751f194', 'The frame upstream-accepted[0] claim: zero hash-resolutions in all three body layers; process-impossible and wrong-referent (desk-own revision); REFUSED as acceptance authority.'),
  rel(S, 'observes', 'UH-Define-Architecture-Contract-001', 'The immediate upstream candidate of record: the r5 arch author hold (hold-no-authoring); NO SRS candidate exists; the domain.accepted edge into this desk has never lawfully fired.'),
  rel(S, 'observes', 'RT-UH-Define-Architecture-Contract-001', 'The r5 arch author hold trace, byte-stable.'),
  rel(S, 'observes', 'FR-Define-Architecture-Contract-001', 'NEW adjudication content: the immediate upstream gate reviewer refusal of record (d813908b..., hold-upheld, verifier 53/53) - the gate is refused at reviewer stage, not merely held at author stage.'),
  rel(S, 'observes', 'VV-Define-Architecture-Contract-002', 'The arch gate reviewer verification of record (53/53).'),
  rel(S, 'observes', 'RT-Define-Architecture-Contract-001', 'The arch gate reviewer trace of record.'),
  rel(S, 'observes', 'FS-Define-Architecture-Contract-Reviewer-001', 'The arch gate reviewer submission of record; effectFired=false.'),
  rel(S, 'observes', 'import:discovery-handoff', 'The accepted discovery import chain; still the only accepted base on this chain.'),
  rel(S, 'observes', 'cert:discovery-capsule', 'The capsule certificate recomputes (CERT-1).'),
  rel(S, 'observes', 'FR-Freeze-What-Baseline-002', 'The root gate refusal of record: freeze ratification REFUSED; the domain.frozen edge has never lawfully fired.'),
  rel(S, 'observes', 'VV-Freeze-What-Baseline-002', 'The freeze reviewer verification of record (50/50).'),
  rel(S, 'observes', 'RT-Freeze-What-Baseline-002', 'The freeze reviewer trace of record.'),
  rel(S, 'observes', 'FS-Freeze-What-Baseline-Reviewer-001', 'The freeze reviewer submission of record; effectFired=false.'),
  rel(S, 'observes', 'UH-Freeze-What-Baseline-001', 'The standing freeze author hold.'),
  rel(S, 'observes', 'AS-Freeze-What-Baseline-001', 'The freeze author re-staff confirmation: standing hold, 0 new accepted lineage.'),
  rel(S, 'observes', 'RC-Freeze-What-Baseline-001', 'The freeze reviewer confirmation: hold-upheld-no-candidate-to-review.'),
  rel(S, 'observes', 'FR-Reconcile-What-001', 'The gate beneath the freeze: repair verdict of record with the no-accept prohibition toward freeze-what-baseline (undischarged).'),
  rel(S, 'observes', 'CL-Reconcile-What-001', 'The gate collision record: emission A is the reviewer round of record.'),
  rel(S, 'observes', 'link:define-product-intent', 'Upstream desk 1: repair across every emission; NOT accepted.'),
  rel(S, 'observes', 'link:model-use-cases', 'Upstream desk 2: never reviewed at its own content address; NOT accepted.'),
  rel(S, 'observes', 'link:derive-system-requirements', 'Upstream desk 3: repair + held reviewer seat; NOT accepted.'),
  rel(S, 'observes', 'link:define-acceptance-contract', 'Upstream desk 4: adjudicated repair; NOT accepted.'),
  rel(S, 'observes', 'UH-Model-Use-Cases-001', 'The standing r2 upstream hold of the model-use-cases desk.'),
  rel(S, 'observes', 'UH-Define-Acceptance-Contract-001', 'The standing r3 upstream hold of the define-acceptance-contract desk.'),
  rel(S, 'observes', 'FR-Define-Acceptance-Contract-002', 'The adjudicating emission C of the acceptance desk (repair confirmed).'),
  rel(S, 'observes', 'link:reconcile-what', 'Upstream desk 5 (the gate): repair verdict of record; NOT accepted.'),
  rel(S, 'observes', 'r1selfstray:settle-reviewer-decision', 'THIS desk own r1 reviewer-seat stray decision, addressed at the RAW-BYTES layer (not parseable JSON); fabrication provenance, NOT lineage.'),
  rel(S, 'observes', 'r1selfstray:settle-reviewer-submission', 'THIS desk own r1 reviewer-seat stray submission, addressed at the RAW-BYTES layer; label pseudo-addresses + phantom pins inside; fabrication provenance, NOT lineage.'),
  rel(S, 'observes', 'r1selfstray:settle-reviewer-trace', 'THIS desk own r1 reviewer-seat stray trace, addressed at the RAW-BYTES layer; pins the phantom set and the drifted anchor; fabrication provenance, NOT lineage.'),
  rel(S, 'observes', 'r1selfstray:phantom-candidate-set', 'The phantom candidate set f975e878... fabricated by the r1 reviewer-seat family; unresolvable workspace-wide; recorded as provenance, never ratified.'),
  rel(S, 'observes', 'schema:what-baseline', 'The freeze payload contract (raw sha256 ab1b7f5e..., acceptanceRecords minItems 5): the root lawful-authoring blocker of the upstream chain.'),
  rel(S, 'observes', 'framepin:protocol-skill', 'The frame protocol-skill pin (the reviewer drift pair): unresolvable; recorded verbatim; REFUSED as authority.'),
  rel(S, 'observes', 'framepin:semantic-skill', 'The frame semantic-skill pin (the reviewer drift pair): unresolvable; recorded verbatim; REFUSED as authority.'),
  rel(S, 'observes', 'installed:protocol-skill', 'The installed manifest protocol skill digest (recomputed): the only lawful protocol authority; differs from the frame pin.'),
  rel(S, 'observes', 'installed:semantic-skill', 'The installed manifest semantic skill digest for THIS desk (recomputed): the only lawful semantic authority; differs from the frame pin.'),
];

const rtContent = {
  deskRef: 'settle-formalization',
  role: 'reviewer',
  traceKind: 'reviewer-refusal-trace',
  subjectSemanticCode: S,
  subjectArtifactRef: fr.artifactRef,
  verificationRef: shaRef(vv.contentDigest),
  relationVocabulary: ['observes', 'verifies'],
  relationships,
  taskProjectionCoverage: Object.fromEntries(Object.keys(ENVELOPE).map((id) => [id, { digest: ENVELOPE[id], verifiedBy: ['FR-Settle-Formalization-Reviewer-001'] }])),
  claimedAcceptanceCoverage: {
    'upstream-accepted[0]': {
      address: shaRef(CLAIMED.address),
      resolution: 'unresolved-phantom',
      hashResolvedContents: 0,
      adjudication: 'REFUSED as acceptance authority (phantom-upstream-projection; desk-own-revision family; CRIT-1)',
      verifiedBy: ['FR-Settle-Formalization-Reviewer-001'],
    },
  },
  holdCoverage: {
    verdict: 'hold-upheld',
    solutionContractReviewed: false,
    productVerdictMinted: false,
    noProductAuthored: true,
    acceptedUpstreamDesks: 0,
    upstreamDesksRequired: 7,
    unacceptedLinks: ['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements', 'link:define-acceptance-contract', 'link:reconcile-what'],
    upstreamGate: 'define-architecture-contract on author hold (6a32f180...) with its reviewer refusal of record (d813908b...); the domain.accepted edge has never fired',
    freezeState: 'freeze-what-baseline on standing hold; ratification refused (FR-Freeze-What-Baseline-002); the domain.frozen edge has never fired',
    onlyAcceptedChain: 'import:discovery-handoff',
    gateVerdictOfRecord: 'FR-Reconcile-What-001 (repair; no-accept prohibition undischarged)',
    prohibitionDischarged: false,
    projectedLadderOutcomeIfRun: 'failed (MISSING_LINEAGE at R1; SETTLE_OUTCOME_OF_REASON)',
  },
  branchResolutionNote: 'No scenario, surface, realization-entry, requirement, criterion, container, baseline, SRS-revision or solution-contract identities are authored by this review; all observed links resolve at record/artifact granularity.',
  workspaceSummary: `frame claim "${CLAIMED.workspaceSummary}" adjudicated FALSE; recomputed truth: 0 accepted upstream revisions travel by content address on this chain (the one projected address is a desk-own phantom, refused as acceptance authority)`,
};
const rt = {
  traceRef: shaRef(sha(rtContent)),
  traceKind: 'reviewer-refusal-trace',
  contentDigest: sha(rtContent),
  semanticCode: 'RT-Settle-Formalization-001',
  createdAt: CREATED_AT,
  deskRef: 'settle-formalization',
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
  { ref: shaRef(tbAuthorHold.contentDigest), kind: 'upstream-hold-predecessor' },
  { ref: shaRef(tbAuthorTrc.contentDigest), kind: 'upstream-hold-predecessor-trace' },
  { ref: shaRef(tbAuthorHold2.contentDigest), kind: 'upstream-hold-predecessor' },
  { ref: shaRef(tbHold.contentDigest), kind: 'reviewer-hold-predecessor' },
  { ref: shaRef(tbTrc.contentDigest), kind: 'reviewer-hold-predecessor-trace' },
  { ref: shaRef(selfStrayRawDigests.decision), kind: 'retired-stray-family-raw-bytes' },
  { ref: shaRef(selfStrayRawDigests.submission), kind: 'retired-stray-family-raw-bytes' },
  { ref: shaRef(selfStrayRawDigests.trace), kind: 'retired-stray-family-raw-bytes' },
  { ref: shaRef(PHANTOM_CANDIDATE), kind: 'retired-stray-phantom-address' },
  { ref: shaRef(archHold.contentDigest), kind: 'upstream-gate-hold' },
  { ref: shaRef(archHoldTrc.contentDigest), kind: 'upstream-gate-hold-trace' },
  { ref: shaRef(frArch.contentDigest), kind: 'gate-formalization-review' },
  { ref: shaRef(vvArch.contentDigest), kind: 'gate-reviewer-verification' },
  { ref: shaRef(rtArch.contentDigest), kind: 'gate-reviewer-trace' },
  { ref: shaRef(fsArch.contentDigest), kind: 'gate-reviewer-submission' },
  { ref: shaRef(frFreeze.contentDigest), kind: 'root-gate-formalization-review' },
  { ref: shaRef(vvFreeze.contentDigest), kind: 'root-gate-reviewer-verification' },
  { ref: shaRef(rtFreeze.contentDigest), kind: 'root-gate-reviewer-trace' },
  { ref: shaRef(fsFreeze.contentDigest), kind: 'root-gate-reviewer-submission' },
  { ref: shaRef(freezeHold.contentDigest), kind: 'root-gate-hold' },
  { ref: shaRef(asConf.contentDigest), kind: 'author-restaff-confirmation' },
  { ref: shaRef(rcConf.contentDigest), kind: 'reviewer-confirmation' },
  { ref: shaRef(rwArt.contentDigest), kind: 'gate-author-product' },
  { ref: shaRef(frRw.contentDigest), kind: 'gate-formalization-review' },
  { ref: shaRef(clRw.contentDigest), kind: 'gate-collision-record' },
  { ref: shaRef(intentArt.contentDigest), kind: 'consumed-revision-under-repair' },
  { ref: shaRef(ucArt.contentDigest), kind: 'consumed-revision-unaccepted' },
  { ref: shaRef(ucHoldR2.contentDigest), kind: 'upstream-hold' },
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
  deskRef: 'settle-formalization',
  deskNodeId: 'settle-formalization',
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
    receiptRef: 'evidence:DeskIntakeReceipt#settle-formalization:reviewer',
    status: 'review_complete_verdict_recorded',
    receivedFrom: 'reviewer',
    nextStage: 'hold-upheld: no settlement authoring or review on this chain state; the frame upstream-accepted[0] claim is refused (phantom-upstream-projection, desk-own-revision family); resume contract R1-R5 unchanged - the freeze desk R1-R4 completes first, the arch desk re-staffs against the REAL frozen baseline and passes a completed reviewer stage, this desk re-staffs only with ALL FIVE settlement input classes, and only then does this reviewer seat review over an admitted sealed candidate',
    note: 'The r6 author hold re-verifies byte-stable with its 48/48 verifier green; the recomputed census is 0 of 7; the freeze refusal stands (effect never fired) and the arch gate is now refused at reviewer stage (d813908b...). No product verdict is minted over the absent candidate; kernel-side routing is executed by the driver over public commands.',
  },
  acceptanceCriteriaSelfCheck: frContent.acceptanceCriteria.map((a) => ({ id: a.id, description: a.description, satisfied: a.satisfied })),
};
const fsRecord = {
  submissionRef: shaRef(sha(fsContent)),
  submissionId: 'FS-Settle-Formalization-Reviewer-001',
  contentDigest: sha(fsContent),
  createdAt: CREATED_AT,
  deskRef: 'settle-formalization',
  role: 'reviewer',
  digestRule: 'sha256 over canonical JSON of content (recursively key-sorted, compact)',
  content: fsContent,
};

/* ------------------------------------------------------------------ */
/* Write                                                                */
/* ------------------------------------------------------------------ */

const writeJson = (name, value) => writeFileSync(join(DIR, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
writeJson('settle-formalization-desk-reviewer-verification.json', vv);
writeJson('settle-formalization-desk-reviewer-review.json', fr);
writeJson('settle-formalization-desk-reviewer-trace.json', rt);
writeJson('settle-formalization-desk-reviewer-product-submission.json', fsRecord);

console.log(JSON.stringify({
  built: 'settle-formalization desk (reviewer) refusal emission',
  round: SELF_ROUND,
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
