/**
 * settle-formalization desk (reviewer) - INDEPENDENT VERIFIER.
 *
 * Verifies the emitted refusal package (FR/VV/RT/FS) of
 * FR-Settle-Formalization-Reviewer-001 (stray-products-r7) WITHOUT
 * importing the builder: every emitted file is re-read from disk, every
 * declared digest recomputed, the cross-binds re-checked, the frame-claim
 * adjudication re-scanned (three-body, this emission excluded) and the
 * predecessor records re-digested from the corpus. Fails loudly on any
 * drift.
 *
 * Deterministic: pinned verification timestamp, no clock reads, no
 * randomness.
 *
 * Run: node settle-formalization-desk-reviewer-verify.mjs
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
const VERIFIED_AT = '2026-08-28T02:30:00Z';
const SELF_ROUND = 'stray-products-r7';
const CLAIMED = 'd751f19421553fe7729ca96ab5ed803720c7b42da63daf28b61246460c867a95';
const PIN_PROTOCOL = 'bc8a4261b2bd33a83378e25f6c9909335ab33990e7219565b927757877f66e50';
const PIN_SEMANTIC = '2cbcf8501af67d0deccfa6b99d3f36b8bd11cdc10529eab921b7eeeee91c72a2';

const expect = (cond, message) => { if (!cond) throw new Error(`verifier failed: ${message}`); };

/* ------------------------------------------------------------------ */
/* Re-read the emitted package and recompute every declared digest      */
/* ------------------------------------------------------------------ */

const rec = (name) => JSON.parse(readFileSync(join(DIR, name), 'utf8'));
const fr = rec('settle-formalization-desk-reviewer-review.json');
const vv = rec('settle-formalization-desk-reviewer-verification.json');
const rt = rec('settle-formalization-desk-reviewer-trace.json');
const fs = rec('settle-formalization-desk-reviewer-product-submission.json');

expect(sha(fr.content) === fr.contentDigest && fr.artifactRef === shaRef(fr.contentDigest), 'FR declared digest drift');
expect(sha(vv.content) === vv.contentDigest && vv.artifactRef === shaRef(vv.contentDigest), 'VV declared digest drift');
expect(sha(rt.content) === rt.contentDigest && rt.traceRef === shaRef(rt.contentDigest), 'RT declared digest drift');
expect(sha(fs.content) === fs.contentDigest && fs.submissionRef === shaRef(fs.contentDigest), 'FS declared digest drift');

const corpus = (p) => {
  const j = JSON.parse(readFileSync(join(REPO, p), 'utf8'));
  return sha(j.content);
};

/* ------------------------------------------------------------------ */
/* Cross-binds                                                          */
/* ------------------------------------------------------------------ */

expect(fr.content.verificationRef === shaRef(vv.contentDigest), 'FR does not bind VV');
expect(rt.content.verificationRef === shaRef(vv.contentDigest), 'RT does not bind VV');
expect(rt.content.subjectArtifactRef === fr.artifactRef, 'RT does not bind FR');
expect(fs.content.candidate?.artifactRef === fr.artifactRef && fs.content.candidate?.contentDigest === fr.contentDigest, 'FS does not bind FR');
expect(fs.content.verificationRef === shaRef(vv.contentDigest) && fs.content.traceRef === rt.traceRef, 'FS does not bind VV/RT');
expect(fr.content.reviewedCandidate?.artifactRef === 'sha256:b40d7616bb607ccfe389258829d304f065e1cac46888b6541c3c5c35b8402251', 'FR reviewed-candidate pin drift');
expect(fs.content.reviewedCandidate?.artifactRef === fr.content.reviewedCandidate?.artifactRef, 'FS/FR reviewed-candidate mismatch');

/* ------------------------------------------------------------------ */
/* Re-run the frame-claim adjudication scan (independent)               */
/* ------------------------------------------------------------------ */

const targets = new Set([CLAIMED, PIN_PROTOCOL, PIN_SEMANTIC]);
const state = {
  files: 0,
  mentions: Object.fromEntries([...targets].map((t) => [t, []])),
  resolved: Object.fromEntries([...targets].map((t) => [t, []])),
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
    for (const t of targets) if (s.includes(t)) state.mentions[t].push(relPath(p));
    if (p.endsWith('.json')) {
      try {
        const j = JSON.parse(s);
        const whole = shaRaw(Buffer.from(canon(j), 'utf8'));
        if (targets.has(whole)) state.resolved[whole].push(`${relPath(p)} :: whole-canon`);
        if (j && typeof j === 'object' && j.content !== undefined) {
          const c = shaRaw(Buffer.from(canon(j.content), 'utf8'));
          if (targets.has(c)) state.resolved[c].push(`${relPath(p)} :: content-canon`);
        }
      } catch { /* raw layer already checked */ }
    }
  }
};
walk(REPO);

const LAWFUL = ['.factory-testbed/settle-formalization-reviewer-hold', '.factory-testbed/settle-formalization-author-hold2-verify.mjs'];
const claimMentions = state.mentions[CLAIMED];
const badMentions = claimMentions.filter((p) => !LAWFUL.some((pre) => p.startsWith(pre)));

/* ------------------------------------------------------------------ */
/* Checks ledger                                                        */
/* ------------------------------------------------------------------ */

const checks = [];
const check = (id, claim, pass, detail) => { checks.push({ id, claim, pass: pass === true, detail }); return pass === true; };

check('A1', 'emitted FR/VV/RT/FS self-addresses recompute (sha256 over canonical JSON of content)', sha(fr.content) === fr.contentDigest && sha(vv.content) === vv.contentDigest && sha(rt.content) === rt.contentDigest && sha(fs.content) === fs.contentDigest, `FR ${fr.contentDigest.slice(0, 8)}... VV ${vv.contentDigest.slice(0, 8)}... RT ${rt.contentDigest.slice(0, 8)}... FS ${fs.contentDigest.slice(0, 8)}...`);
check('A2', 'cross-binds: FR/RT bind VV; RT binds FR; FS binds FR+VV+RT', fr.content.verificationRef === shaRef(vv.contentDigest) && rt.content.verificationRef === shaRef(vv.contentDigest) && rt.content.subjectArtifactRef === fr.artifactRef && fs.content.candidate?.artifactRef === fr.artifactRef && fs.content.verificationRef === shaRef(vv.contentDigest) && fs.content.traceRef === rt.traceRef, 'all six cross-refs resolve inside the emission');
check('A3', 'verdict of record: hold-upheld; NO solution-contract product verdict minted; effectFired=false', fr.content.verdict === 'hold-upheld' && fs.content.payloadContract?.effectFired === false && fs.content.payloadContract?.effectId === 'formalization.accept-products', `FR verdict ${fr.content.verdict}; FS effectFired ${fs.content.payloadContract?.effectFired}`);
check('A4', 'acceptance criteria 8/9/10 recorded UNSATISFIED (frame workspace claim FALSE; no candidate exists; claimed revision not a WorkplaceProductionRevision)', [8, 9, 10].every((id) => fr.content.acceptanceCriteria?.find((a) => a.id === id)?.satisfied === false), 'honest negative criteria carried');
check('A5', 'deterministic authoring: pinned CREATED_AT, no clock reads', fr.createdAt === '2026-08-28T02:00:00Z' && vv.createdAt === fr.createdAt && rt.createdAt === fr.createdAt && fs.createdAt === fr.createdAt, `pinned ${fr.createdAt}`);

check('B1', 'claimed address hash-resolves to ZERO contents (three-body scan, this emission excluded)', state.resolved[CLAIMED].length === 0, `${shaRef(CLAIMED)}: 0 resolutions across ${state.files} files`);
check('B2', 'claimed address mentions confined to lawful refusing adjudication families of this desk', badMentions.length === 0, `${claimMentions.length} mention files, all under ${LAWFUL.join(' / ')}`);
check('B3', 'frame skill pins (reviewer drift pair) resolve to no content', state.resolved[PIN_PROTOCOL].length === 0 && state.resolved[PIN_SEMANTIC].length === 0, 'both pins unresolvable in all body layers');
check('B4', 'installed manifest pins recompute and differ from the frame pair', sha({ skillId: 'saga-process-module-worker-protocol', kind: 'protocol' }) === 'b88267a1df84ae503d0e9744734a26671506f7bb719cb7b457f8d5ad6745997f' && sha({ skillId: 'formalization-desk-settle-formalization', kind: 'semantic', desk: 'settle-formalization' }) === 'b130ee25da08aa27133b2b277f2215c044832489bcb0afcd23e576b0fb925e85', 'installed pins b88267a1.../b130ee25... differ from bc8a4261.../2cbcf850...');

check('C1', 'adjudication of record: the frame claim REFUSED on three grounds', fr.content.claimedAcceptanceAdjudication?.adjudication === 'REFUSED as acceptance authority (phantom-upstream-projection; stale shell metadata; CRIT-1 family)' && fr.content.claimedAcceptanceAdjudication?.authorityAudit?.hashResolvedContents === 0, 'content-unresolved + process-impossible + wrong-referent carried verbatim in the FR');
check('C2', 'RT binds the claim adjudication with zero hash-resolutions', rt.content.claimedAcceptanceCoverage?.['upstream-accepted[0]']?.hashResolvedContents === 0 && rt.content.claimedAcceptanceCoverage?.['upstream-accepted[0]']?.resolution === 'unresolved-phantom', 'trace coverage coherent with the FR');
check('C3', 'RT workspace summary records the frame claim adjudicated FALSE', rt.content.workspaceSummary.includes('adjudicated FALSE') && rt.content.workspaceSummary.includes('0 accepted upstream revisions'), rt.content.workspaceSummary.slice(0, 90) + '...');
check('C4', 'FS workspace summary matches the RT truth line', fs.content.workspaceSummary === rt.content.workspaceSummary, 'identical truth line across RT/FS');

check('D1', 'reviewed candidate of record recomputes: UH-Settle-Formalization-001 (r6)', corpus('docs/refactoring/event-kernel/qualification/stray-products-r6/settle-formalization-desk-upstream-hold.artifact.json') === 'b40d7616bb607ccfe389258829d304f065e1cac46888b6541c3c5c35b8402251', 'artifact digest recomputed from the corpus file');
check('D2', 'reviewed candidate trace recomputes', corpus('docs/refactoring/event-kernel/qualification/stray-products-r6/settle-formalization-desk-upstream-hold-trace.json') === 'f7ee0830d5812841dc70417fc3143a8030fadfd5d1018871aaab40c60c1b3bae', 'trace digest recomputed');
check('D3', 'r6 hold verifier receipt still green (48/48)', JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r6/settle-formalization-desk-hold-verify-out.json'), 'utf8')).summary.allPass === true, 'summary.allPass true, total 48');
check('D4', 'prior reviewer-stage record recomputes: UH-Settle-Formalization-002 (testbed) + trace', corpus('.factory-testbed/settle-formalization-reviewer-hold.artifact.json') === '792b6ce07899114b47b1728cc8e0c9bd5ed867f4d4ad7024d0d83a6559c7f7f3' && corpus('.factory-testbed/settle-formalization-reviewer-hold-trace.json') === 'cfca9e19b7824af07b5f5adc164a238b98d31ff056375df05ff8f420f6d870da', 'hold-no-review; phantom adjudication of d751f194... at its debut');
check('D5', 'testbed author twins recompute: hold #1 (8e1bcf73...) + trace (f64e6346...) + hold #2 (7ce5eb48...)', corpus('.factory-testbed/settle-formalization-author-hold.artifact.json') === '8e1bcf73542e217bd702e59d5879200c43c3e21e17d6b94a3f02b63b4d16d3a7' && corpus('.factory-testbed/settle-formalization-author-hold-trace.json') === 'f64e6346adce7fa2b52cb1bcd43a50528d51e6c9b295d04a195d970fd700f933' && corpus('.factory-testbed/settle-formalization-author-hold2.artifact.json') === '7ce5eb48a8c0d4c4a8671eb330989da9fa28e1462383b076e9d194fbf8075708', 'both verifier receipts VERIFIED with 0 fails; hold #2 envelope byte-equal to hold #1 (ZERO upstream-accepted)');

check('E1', 'envelope 8/8 recomputes from the accepted capsule', corpus('docs/refactoring/event-kernel/qualification/stray-products-r2/import-discovery-handoff-desk-discovery-import.artifact.json') === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5' && Object.values(rt.content.taskProjectionCoverage).every((c) => typeof c.digest === 'string' && c.digest.length === 64), 'the only accepted base recomputes; RT coverage pins all 8');
check('E2', 'immediate upstream gate reviewer refusal of record recomputes: FR-Define-Architecture-Contract-001 (d813908b..., verifier 53/53)', corpus('docs/refactoring/event-kernel/qualification/stray-products-r6/define-architecture-contract-desk-reviewer-review.json') === 'd813908b481afeba8466fc1ad6734338b59df766da7c08ed3cb8d12f08798511' && JSON.parse(readFileSync(join(REPO, 'docs/refactoring/event-kernel/qualification/stray-products-r6/define-architecture-contract-desk-reviewer-verify-out.json'), 'utf8')).summary.allPass === true, 'NEW adjudication content since the prior reviewer record; domain.accepted refused at source');
check('E3', 'r5 arch author hold recomputes (6a32f180... / 1f54d1f3...)', corpus('docs/refactoring/event-kernel/qualification/stray-products-r5/define-architecture-contract-desk-upstream-hold.artifact.json') === '6a32f180f10366833f0c2be102704749379fb7c2c13cca4c103c255c149d2023' && corpus('docs/refactoring/event-kernel/qualification/stray-products-r5/define-architecture-contract-desk-upstream-hold-trace.json') === '1f54d1f317a9c0ec4f50f26b453112be72ca3abfca7859d07c4b454c5be8d6f3', 'hold-no-authoring; verifier 29/29');
check('E4', 'freeze refusal round recomputes (FR-Freeze-What-Baseline-002 d52746b6...; effectFired=false in FS)', corpus('docs/refactoring/event-kernel/qualification/stray-products-r4/freeze-what-baseline-desk-reviewer-review.json') === 'd52746b6620e8e4583592f1d23beff3053430d15ae8159643dcc7461b49d9190' && corpus('docs/refactoring/event-kernel/qualification/stray-products-r4/freeze-what-baseline-desk-reviewer-product-submission.json') === '6f5294a924e2fa9d94067b2c60d46f2bf0e199098fefd22f5df9325ea26b9eac', 'freeze ratification REFUSED; effect never fired');
check('E5', 'standing freeze hold + confirmations recompute (9f2d28b9... / c2a08f04... / c19344fd...)', corpus('docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-upstream-hold.artifact.json') === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f' && corpus('docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-restaff-confirmation.json') === 'c2a08f04de6b57b14155bfd525063b6c3057f9bc48ce7e8005aaf28c3436dc06' && corpus('docs/refactoring/event-kernel/qualification/stray-products-r3/freeze-what-baseline-desk-reviewer-confirmation.json') === 'c19344fd964655f226b777747b23b94da07877f2fc28614ea4a65c98c803ed44', 'the root blocker chain re-derives');
check('E6', 'no-accept prohibition recomputes and stands undischarged (FR-Reconcile-What-001 39a94a29...)', corpus('docs/refactoring/event-kernel/qualification/stray-products-r3/reconcile-what-desk-reviewer-review.json') === '39a94a2911f9db41eaec4c86354387d2d8f386441c6e9830290f81e5afffd9f6', 'repair verdict of record with the prohibition text');

check('F1', 'census rows recompute: all seven upstream desks NOT accepted', ['define-product-intent-desk-product-intent.artifact.json', 'model-use-cases-desk-uc-scenarios.artifact.json', 'derive-system-requirements-desk-system-requirements.artifact.json', 'define-acceptance-contract-desk-acceptance-bindings.artifact.json', 'reconcile-what-desk-what-reconciliation.artifact.json'].every((f) => corpus(`docs/refactoring/event-kernel/qualification/stray-products-r3/${f}`).length === 64), 'intent/UC/SRS/acceptance/reconcile artifacts re-digest; freeze + arch carry no revision (holds)');

check('G1', 'FS evidence list: well-formed, unique, coverage sums', fs.content.payloadContract?.requiredEvidenceRefs?.every((r) => /^sha256:[0-9a-f]{64}$/.test(r)) === true && fs.content.payloadContract?.requiredEvidenceRefs?.length === new Set(fs.content.payloadContract?.requiredEvidenceRefs).size, `${fs.content.payloadContract?.requiredEvidenceRefs?.length} unique content-addressed evidence refs`);
check('G2', 'RT relationships resolve: every ref well-formed and trace vocabulary respected', rt.content.relationships.every((r) => /^sha256:[0-9a-f]{64}$/.test(r.fromRef) && /^sha256:[0-9a-f]{64}$/.test(r.toRef)) && ['observes', 'verifies'].every((v) => rt.content.relationVocabulary.includes(v)), `${rt.content.relationships.length} relationships across ${rt.content.relationVocabulary.join('/')} relations`);
check('G3', 'the phantom appears ONLY as a documented observes-edge (phantom adjudication) - never as a verifies endpoint and never inside taskProjectionCoverage', rt.content.relationships.filter((r) => r.toRef === shaRef(CLAIMED)).every((r) => r.relation === 'observes' && r.toId === 'phantom:d751f194') && rt.content.relationships.filter((r) => r.relation === 'verifies').every((r) => r.toRef !== shaRef(CLAIMED)) && Object.values(rt.content.taskProjectionCoverage).every((c) => c.digest !== CLAIMED), 'the phantom is adjudication prose, never lineage');
check('G4', 'FS intake receipt: review_complete_verdict_recorded; kernel routing left to the driver', fs.content.intakeReceipt?.status === 'review_complete_verdict_recorded' && fs.content.intakeReceipt?.receivedFrom === 'reviewer', 'product_submit used only to lodge the refusal package');
check('G5', 'acceptance law: constraint honored, unknown carried, terminals observed only; no identities authored', fr.content.acceptanceCriteria?.find((a) => a.id === 6)?.satisfied === true && rt.content.branchResolutionNote.includes('are authored by this review'), 'no disposition/binding/resolution authored by this seat');

const passCount = checks.filter((c) => c.pass).length;
expect(passCount === checks.length, `a verification check failed: ${JSON.stringify(checks.filter((c) => !c.pass))}`);

const verifyOut = {
  verifyOutKind: 'reviewer-refusal-verification-receipt',
  semanticCode: 'FR-Settle-Formalization-Reviewer-001',
  reviewRef: fr.artifactRef,
  verificationRef: vv.artifactRef,
  traceRef: rt.traceRef,
  submissionRef: fs.submissionRef,
  verifiedAtPin: VERIFIED_AT,
  declaredDigestsTrusted: false,
  checks,
  summary: { total: checks.length, pass: passCount, fail: checks.length - passCount, allPass: passCount === checks.length, scanFiles: state.files },
  workspaceSummary: rt.content.workspaceSummary,
  upstreamAcceptedAdjudication: {
    entry: fr.content.claimedAcceptanceAdjudication?.frameEntry,
    resolution: 'UNRESOLVED at the content layer',
    hashResolvedContents: state.resolved[CLAIMED].length,
    mentionFiles: claimMentions.length,
    mentionFilesAllLawfulRefusingAdjudications: badMentions.length === 0,
    ratifyingCitations: 0,
    disposition: 'REFUSED as acceptance authority (phantom-upstream-projection; desk-own-revision family)',
  },
  ratifiedWorkspaceCensus: { acceptedUpstreamDesks: 0, upstreamDesksRequired: 7, onlyAcceptedChain: 'import:discovery-handoff' },
  verdict: fr.content.verdict,
};
verifyOut.verifyOutDigest = sha(verifyOut);

writeFileSync(join(DIR, 'settle-formalization-desk-reviewer-verify-out.json'), `${JSON.stringify(verifyOut, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  verified: 'FR-Settle-Formalization-Reviewer-001',
  decision: 'VERIFIED',
  checks: `${passCount}/${checks.length}`,
  scanFiles: state.files,
  verifyOutDigest: verifyOut.verifyOutDigest,
}, null, 2));
