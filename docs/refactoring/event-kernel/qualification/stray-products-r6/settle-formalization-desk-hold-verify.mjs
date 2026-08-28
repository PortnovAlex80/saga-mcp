/**
 * settle-formalization desk (author) - SETTLEMENT UPSTREAM HOLD verifier.
 *
 * Independent recomputation of UH-Settle-Formalization-001
 * (stray-products-r6). Nothing is trusted by declaration:
 *   - every cited corpus record digest is recomputed from the corpus;
 *   - the emission files are re-parsed and their self-addresses recomputed;
 *   - the frame pins AND the 8 phantom addresses of this desk's r1
 *     reviewer-seat stray family are adjudicated by a workspace-wide scan
 *     (raw bytes, whole-JSON canonical, .content canonical), this round
 *     excluded;
 *   - the fence is checked: the hold must author NO solution-contract
 *     material;
 *   - the ladder projection is recomputed against the installed cell
 *     sources (settlement.mjs / protocol.mjs / manifest.ts).
 *
 * Deterministic: pinned expectations, no clock reads, no randomness.
 *
 * Run: node settle-formalization-desk-hold-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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
const relPath = (p) => relative(REPO, p).split('\\').join('/');
const SELF_ROUND = 'stray-products-r6';

const PIN_PROTOCOL = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const PIN_SEMANTIC = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';
const INSTALLED_PROTOCOL = 'b88267a1df84ae503d0e9744734a26671506f7bb719cb7b457f8d5ad6745997f';
const INSTALLED_SEMANTIC = sha({ skillId: 'formalization-desk-settle-formalization', kind: 'semantic', desk: 'settle-formalization' });
const R1_UPSTREAM_STRAY_RECOMPUTED = 'f4846e5fed6808f8b0c33b14d58a337d9f72eddd02bf775bc048862b1d5626af';

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
const PHANTOMS = [...INVENTED_REFS, PHANTOM_CANDIDATE];

const R1 = 'docs/refactoring/event-kernel/qualification/stray-products-r1';
const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';
const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R4 = 'docs/refactoring/event-kernel/qualification/stray-products-r4';
const R5 = 'docs/refactoring/event-kernel/qualification/stray-products-r5';

/* ------------------------------------------------------------------ */
/* Workspace-wide scan (this round excluded, honest about mentions)     */
/* ------------------------------------------------------------------ */

const scanWorkspace = () => {
  const targets = [PIN_PROTOCOL, PIN_SEMANTIC, ...PHANTOMS];
  const state = {
    files: 0,
    textualMentions: Object.fromEntries(targets.map((t) => [t, 0])),
    textualMentionPaths: Object.fromEntries(targets.map((t) => [t, []])),
    hashResolved: Object.fromEntries(targets.map((t) => [t, []])),
    selfDeclaredClaimants: [],
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
          if (targets.includes(whole)) state.hashResolved[whole].push(`${relPath(p)} :: whole-canon`);
          if (j && typeof j === 'object' && j.content !== undefined) {
            const c = shaRaw(Buffer.from(canon(j.content), 'utf8'));
            if (targets.includes(c)) state.hashResolved[c].push(`${relPath(p)} :: content-canon`);
          }
          if (j && typeof j === 'object' && (j.contentDigest === PIN_PROTOCOL || j.traceDigest === PIN_PROTOCOL)) {
            state.selfDeclaredClaimants.push(relPath(p));
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
/* The emission under verification                                      */
/* ------------------------------------------------------------------ */

const artifactFile = JSON.parse(readFileSync(join(DIR, 'settle-formalization-desk-upstream-hold.artifact.json'), 'utf8'));
const traceFile = JSON.parse(readFileSync(join(DIR, 'settle-formalization-desk-upstream-hold-trace.json'), 'utf8'));
const summaryText = readFileSync(join(DIR, 'settle-formalization-desk-hold-submission-summary.md'), 'utf8');

const content = artifactFile.content;
const traceContent = traceFile.content;

/* ------------------------------------------------------------------ */
/* Corpus recomputation (independent pass)                              */
/* ------------------------------------------------------------------ */

const dig = (p) => {
  const j = JSON.parse(readFileSync(join(REPO, p), 'utf8'));
  return { d: sha(j.content), raw: j };
};
const importRec = dig(`${R2}/import-discovery-handoff-desk-discovery-import.artifact.json`);
const holdRec = dig(`${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`);
const fr4Rec = dig(`${R4}/freeze-what-baseline-desk-reviewer-review.json`);
const vv4Rec = dig(`${R4}/freeze-what-baseline-desk-reviewer-verification.json`);
const rt4Rec = dig(`${R4}/freeze-what-baseline-desk-reviewer-trace.json`);
const fs4Rec = dig(`${R4}/freeze-what-baseline-desk-reviewer-product-submission.json`);
const frRwRec = dig(`${R3}/reconcile-what-desk-reviewer-review.json`);
const clRwRec = dig(`${R3}/reconcile-what-desk-reviewer-collision-record.json`);
const rwSubRec = dig(`${R3}/reconcile-what-desk-product-submission.json`);
const intentRec = dig(`${R3}/define-product-intent-desk-product-intent.artifact.json`);
const ucRec = dig(`${R3}/model-use-cases-desk-uc-scenarios.artifact.json`);
const srRec = dig(`${R3}/derive-system-requirements-desk-system-requirements.artifact.json`);
const acRec = dig(`${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`);
const uhAcRec = dig(`${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`);
const acHoldRec = dig(`${R5}/define-architecture-contract-desk-upstream-hold.artifact.json`);
const acHoldTrcRec = dig(`${R5}/define-architecture-contract-desk-upstream-hold-trace.json`);
const schemaRawDigest = shaRaw(readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json')));
const r1StrayRec = dig(`${R1}/define-architecture-contract-desk-architecture-contract.artifact.json`);
const r1VerdictDigest = shaRaw(Buffer.from(canon(JSON.parse(readFileSync(join(REPO, `${R1}/define-architecture-contract-review-verdict.json`), 'utf8'))), 'utf8'));

/* THIS desk's r1 reviewer-seat stray family (raw-bytes layer). */
const selfStrayBytes = {
  decision: readFileSync(join(REPO, `${R1}/settle-formalization-reviewer-decision.json`)),
  submission: readFileSync(join(REPO, `${R1}/settle-formalization-reviewer-product-submission.json`)),
  trace: readFileSync(join(REPO, `${R1}/settle-formalization-reviewer-trace.json`)),
};
const selfStrayRawDigests = Object.fromEntries(Object.entries(selfStrayBytes).map(([k, b]) => [k, shaRaw(b)]));
let decisionParseError = null;
try { JSON.parse(selfStrayBytes.decision.toString('utf8')); } catch (e) { decisionParseError = String(e.message).split('\n')[0]; }
const selfStraySubmission = JSON.parse(selfStrayBytes.submission.toString('utf8'));
const selfStrayTrace = JSON.parse(selfStrayBytes.trace.toString('utf8'));

/* ------------------------------------------------------------------ */
/* Installed-cell source recomputation (the ladder projection basis)    */
/* ------------------------------------------------------------------ */

const settlementSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'settlement.mjs'), 'utf8');
const protocolSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', 'protocol.mjs'), 'utf8');
const manifestSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'manifest.ts'), 'utf8');
const whatBaselineSrc = readFileSync(join(REPO, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators', 'what-baseline.mjs'), 'utf8');
const srcKindsMatch = whatBaselineSrc.match(/export const HANDOFF_BINDING_KINDS = Object\.freeze\(\[([\s\S]*?)\]\);/);
const srcHandoffKinds = srcKindsMatch === null ? [] : srcKindsMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s.length > 0);

/* ------------------------------------------------------------------ */
/* The known-digest universe (every ref the trace may legitimately      */
/* carry, recomputed by THIS independent pass)                          */
/* ------------------------------------------------------------------ */

const KNOWN_DIGESTS = new Set([
  ...Object.values(ENVELOPE),
  ...[
    `${R2}/import-discovery-handoff-desk-discovery-import.artifact.json`,
    `${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`,
    `${R3}/freeze-what-baseline-desk-upstream-hold-trace.json`,
    `${R3}/freeze-what-baseline-desk-restaff-confirmation.json`,
    `${R3}/freeze-what-baseline-desk-reviewer-confirmation.json`,
    `${R3}/freeze-what-baseline-desk-reviewer-confirmation-trace.json`,
    `${R4}/freeze-what-baseline-desk-reviewer-review.json`,
    `${R4}/freeze-what-baseline-desk-reviewer-verification.json`,
    `${R4}/freeze-what-baseline-desk-reviewer-trace.json`,
    `${R4}/freeze-what-baseline-desk-reviewer-product-submission.json`,
    `${R3}/reconcile-what-desk-reviewer-review.json`,
    `${R3}/reconcile-what-desk-reviewer-collision-record.json`,
    `${R3}/reconcile-what-desk-product-submission.json`,
    `${R3}/reconcile-what-desk-what-reconciliation.artifact.json`,
    `${R3}/define-product-intent-desk-product-intent.artifact.json`,
    `${R3}/model-use-cases-desk-uc-scenarios.artifact.json`,
    `${R2}/model-use-cases-desk-upstream-hold.artifact.json`,
    `${R3}/derive-system-requirements-desk-system-requirements.artifact.json`,
    `${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`,
    `${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`,
    `${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`,
    `${R2}/define-product-intent-desk-reviewer-verification.json`,
    `${R5}/define-architecture-contract-desk-upstream-hold.artifact.json`,
    `${R5}/define-architecture-contract-desk-upstream-hold-trace.json`,
  ].map((p) => dig(p).d),
  sha(importRec.raw.content.verifiedSubArtifacts.certificate.content),
  schemaRawDigest,
  R1_UPSTREAM_STRAY_RECOMPUTED,
  r1VerdictDigest,
  selfStrayRawDigests.decision,
  selfStrayRawDigests.submission,
  selfStrayRawDigests.trace,
  PHANTOM_CANDIDATE,
  PIN_PROTOCOL,
  PIN_SEMANTIC,
  INSTALLED_PROTOCOL,
  INSTALLED_SEMANTIC,
  artifactFile.contentDigest,
  traceFile.contentDigest,
]);

/* ------------------------------------------------------------------ */
/* Checks ledger                                                        */
/* ------------------------------------------------------------------ */

const checks = [];
const check = (id, pass, detail) => { checks.push({ id, pass: pass === true, detail }); return pass === true; };

/* S: emission self-consistency */
const EXPECTED_CONTENT_KEYS = [
  'schemaVersion', 'deskRef', 'deskNodeId', 'role', 'itemInstanceId', 'token', 'holdKind', 'decision', 'statement',
  'protocolLineage', 'taskProjection', 'deskContract', 'upstreamGate', 'chainAcceptanceCensus', 'ladderProjection',
  'selfStrayProductHistory', 'frameAdjudication', 'unresolvableInstances', 'noProductAuthored', 'fence',
  'acceptanceLaws', 'resumeContract', 'verification', 'workspaceSummary',
].sort();
check('S1.artifactDigestRecomputes', artifactFile.contentDigest === sha(content), `contentDigest ${artifactFile.contentDigest} recomputes over canonical JSON of content`);
check('S2.traceDigestRecomputes', traceFile.contentDigest === sha(traceContent), `contentDigest ${traceFile.contentDigest} recomputes`);
check('S3.refsCrossBind', artifactFile.artifactRef === shaRef(artifactFile.contentDigest) && traceFile.traceRef === shaRef(traceFile.contentDigest) && traceContent.subjectArtifactRef === artifactFile.artifactRef && traceContent.subjectSemanticCode === artifactFile.semanticCode, 'artifact/trace refs cross-bind');
check('S4.identity', artifactFile.semanticCode === 'UH-Settle-Formalization-001' && content.deskRef === 'settle-formalization' && content.role === 'author' && content.schemaVersion === 'formalization.upstream-hold.v1' && content.decision === 'hold-no-authoring' && content.noProductAuthored === true && traceContent.traceKind === 'upstream-hold-trace', 'identity: author-seat settlement upstream hold, no product authored');
check('S5.noProductMaterial', JSON.stringify([...Object.keys(content)].sort()) === JSON.stringify(EXPECTED_CONTENT_KEYS) && content.fence.forbiddenProductSections.length === 6, 'the hold authors no solution-contract material (fence: closed content-key set + forbidden-sections register)');
check('S6.acceptanceLaws', content.acceptanceLaws.length === 4 && content.acceptanceLaws.every((l) => l.satisfied === true), 'constraint honored, unknown carried, terminal claims observed only, noProductAuthored');
check('S7.summaryCitesEmission', summaryText.includes(artifactFile.artifactRef) && summaryText.includes(traceFile.traceRef) && summaryText.includes('hold-no-authoring'), 'the submission summary cites the emission of record');
check('S8.traceRefsResolve', traceContent.relationships.every((r) => KNOWN_DIGESTS.has(r.fromRef.replace('sha256:', '')) && KNOWN_DIGESTS.has(r.toRef.replace('sha256:', ''))), `every trace ref resolves to a digest recomputed by this verifier's independent pass (${traceContent.relationships.length} relationships)`);

/* E: envelope recompute from the accepted capsule */
const vsa = importRec.raw.content.verifiedSubArtifacts;
const capGroups = [vsa.sourceClaims, vsa.constraints, vsa.unknowns, vsa.terminalLifecycleClaims, [vsa.certificate]];
const capDigests = capGroups.flat().map((s) => ({ s, digest: sha(s.content) }));
const allCapsuleOk = capDigests.every(({ s, digest }) => digest === s.digest);
const envelopeMatched = Object.entries(ENVELOPE).every(([id, digest]) => capDigests.some(({ digest: d }) => d === digest) && content.taskProjection.verifiedSubArtifacts.some((v) => v.id === id && v.digest === digest));
const traceCovers = Object.keys(ENVELOPE).every((id) => traceContent.taskProjectionCoverage[id]?.digest === ENVELOPE[id]);
const certOk = capDigests.some(({ s, digest }) => digest === sha(vsa.certificate.content) && digest === '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21');
check('E1.capsuleRecomputes', allCapsuleOk && importRec.d === 'b10bb762b652fe89be23eaf3073c619a448ab52559eabba24d2715374e357dd5', 'the accepted import chain recomputes; every capsule sub-artifact digest recomputes');
check('E2.envelope8of8', envelopeMatched, 'all 8 task-projection addresses recompute from the capsule and are carried by the hold (9/9 with CERT-1)');
check('E3.traceCoverage', traceCovers, 'the trace carries the full task-projection coverage');
check('E4.certificate', certOk, 'CERT-1 recomputes');

/* U: upstream census */
const censusOk = content.chainAcceptanceCensus.upstreamDeskCount === 7 && content.chainAcceptanceCensus.acceptedUpstreamDeskCount === 0 && content.chainAcceptanceCensus.upstreamDesks.length === 7 && content.chainAcceptanceCensus.upstreamDesks.every((row) => row.accepted === false);
check('U1.censusZeroOfSeven', censusOk, 'recomputed census: 0 of 7 accepted upstream desks (five pre-freeze + freeze + SRS desk), each row NOT accepted with evidence refs');
const evidenceDigests = content.chainAcceptanceCensus.upstreamDesks.flatMap((row) => row.evidenceRefs.map((r) => r.replace('sha256:', '')));
const recomputedEvidence = new Set([
  ...[
    `${R2}/define-product-intent-desk-reviewer-review.json`,
    `${R2}/define-product-intent-desk-reviewer-review-emission-b.json`,
    `${R2}/define-product-intent-desk-reviewer2-review.json`,
    `${R2}/derive-system-requirements-desk-reviewer-review.json`,
    `${R2}/derive-system-requirements-desk-reviewer-restaff2-confirmation.json`,
    `${R2}/model-use-cases-desk-upstream-hold.artifact.json`,
    '.factory-testbed/derive-system-requirements-reviewer-hold.artifact.json',
    '.factory-testbed/derive-system-requirements-reviewer-hold2.artifact.json',
    '.factory-testbed/model-use-cases-reviewer-review.json',
    `${R3}/define-acceptance-contract-desk-reviewer-review-emission-c.json`,
    `${R3}/reconcile-what-desk-reviewer-review.json`,
    `${R3}/reconcile-what-desk-reviewer-collision-record.json`,
    `${R3}/freeze-what-baseline-desk-restaff-confirmation.json`,
    `${R3}/freeze-what-baseline-desk-reviewer-confirmation.json`,
    `${R3}/freeze-what-baseline-desk-reviewer-confirmation-trace.json`,
    `${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`,
    `${R3}/freeze-what-baseline-desk-upstream-hold-trace.json`,
    `${R3}/define-product-intent-desk-product-intent.artifact.json`,
    `${R3}/model-use-cases-desk-uc-scenarios.artifact.json`,
    `${R3}/derive-system-requirements-desk-system-requirements.artifact.json`,
    `${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`,
    `${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`,
    `${R3}/reconcile-what-desk-what-reconciliation.artifact.json`,
    `${R4}/freeze-what-baseline-desk-reviewer-review.json`,
    `${R5}/define-architecture-contract-desk-upstream-hold.artifact.json`,
    `${R5}/define-architecture-contract-desk-upstream-hold-trace.json`,
  ].map((p) => dig(p).d),
  R1_UPSTREAM_STRAY_RECOMPUTED,
]);
const unexplained = evidenceDigests.filter((d) => !recomputedEvidence.has(d));
check('U2.evidenceDigestsRecompute', unexplained.length === 0, unexplained.length === 0
  ? `every census evidence ref recomputes from the corpus (independent pass; ${evidenceDigests.length} refs)`
  : `unexplained evidence refs: ${JSON.stringify(unexplained)}`);

/* F: the freeze desk state + the r4 reviewer refusal */
check('F1.holdByteStable', holdRec.d === '9f2d28b9f84b79f64069559b7de49f3e4a8689e2bc46afa396df59fc08c9be0f' && holdRec.raw.content.decision === 'hold-no-authoring', 'UH-Freeze-What-Baseline-001 recomputes byte-stable (hold-no-authoring)');
check('F2.r4Verdict', fr4Rec.d === 'd52746b6620e8e4583592f1d23beff3053430d15ae8159643dcc7461b49d9190' && fr4Rec.raw.content.verdict === 'hold-upheld' && fr4Rec.raw.content.reviewedCandidate?.artifactRef === shaRef(holdRec.d), 'FR-Freeze-What-Baseline-002 recomputes: hold-upheld over the author hold');
check('F3.r4Round', vv4Rec.d === '8b04101005452d7906bcc1ca66f8f91d5ef6957518ae5af84f8a47f7e5781c21' && rt4Rec.d === '8bf4f283ec152b8e9f9a4d3706227776b1723805c675ea2580ffa59e2259e252' && fs4Rec.d === '6f5294a924e2fa9d94067b2c60d46f2bf0e199098fefd22f5df9325ea26b9eac', 'the r4 verification/trace/submission records recompute');
check('F4.r4RefusalText', String(fr4Rec.raw.content.decision).includes('REFUSE freeze ratification') && String(fr4Rec.raw.content.claimedAcceptanceAdjudication?.adjudication).startsWith('REFUSED as acceptance authority') && fs4Rec.raw.content.payloadContract?.terminalOutcome === 'hold-ratified-freeze-refused', 'the freeze refusal + frame-claim refusal recomputes from the verdict/submission records themselves');
const r4VerifyOut = JSON.parse(readFileSync(join(REPO, `${R4}/freeze-what-baseline-desk-reviewer-verify-out.json`), 'utf8'));
check('F5.r4VerifierGreen', r4VerifyOut.summary?.allPass === true && r4VerifyOut.summary?.fail === 0, `the r4 reviewer verifier is green (${r4VerifyOut.summary?.pass}/${r4VerifyOut.summary?.total})`);
check('F6.prohibitionUndischarged', String(frRwRec.raw.content.nextStage).includes('No domain.accepted may fire from this desk toward freeze-what-baseline') && content.upstreamGate.gateEdgeBlocked.includes('never lawfully fired'), 'the upstream no-accept prohibition recomputes; the inbound domain.accepted edge of THIS desk never lawfully fired');
check('F7.freezeContractLaw', schemaRawDigest === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09' && JSON.parse(readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json'), 'utf8')).properties.acceptanceRecords.minItems === 5, 'the freeze payload contract recomputes (acceptanceRecords minItems 5): the root lawful-authoring blocker');

/* A: the immediate upstream (r5 SRS hold) */
check('A1.r5HoldByteStable', acHoldRec.d === '6a32f180f10366833f0c2be102704749379fb7c2c13cca4c103c255c149d2023' && acHoldRec.raw.content.decision === 'hold-no-authoring' && acHoldRec.raw.content.noProductAuthored === true, 'UH-Define-Architecture-Contract-001 recomputes byte-stable (hold-no-authoring; NO SRS candidate exists)');
check('A2.r5TraceByteStable', acHoldTrcRec.d === '1f54d1f317a9c0ec4f50f26b453112be72ca3abfca7859d07c4b454c5be8d6f3' && acHoldTrcRec.raw.content.subjectArtifactRef === shaRef(acHoldRec.d), 'the r5 hold trace recomputes and cross-binds');
const r5VerifyOut = JSON.parse(readFileSync(join(REPO, `${R5}/define-architecture-contract-desk-hold-verify-out.json`), 'utf8'));
check('A3.r5VerifierGreen', r5VerifyOut.summary?.allPass === true && r5VerifyOut.summary?.fail === 0 && r5VerifyOut.verified === 'UH-Define-Architecture-Contract-001', `the r5 hold verifier is green (${r5VerifyOut.summary?.pass}/${r5VerifyOut.summary?.total}) and verifies the upstream hold`);

/* R: THIS desk's r1 reviewer-seat stray family */
check('R1.decisionUnparseable', decisionParseError !== null && decisionParseError.includes("Expected ',' or '}'"), 'the r1 decision file is not parseable JSON (raw JS expression where a value belongs); no canonical content address can exist for it');
check('R2.decisionRawAddress', selfStrayRawDigests.decision === 'ad698a85b0a76d8c7be5220c9300c2413dea6f70fd28e162b09ab68519f8e2ed', 'the decision file raw-bytes address recomputes (the honest file-layer identity)');
check('R3.submissionFabrication', selfStraySubmission.productRef === 'sha256:settle-formalization-reviewer-product-2026-08-27' && !/^sha256:[0-9a-f]{64}$/.test(selfStraySubmission.productRef) && selfStraySubmission.subjectCandidateSetRef === shaRef(PHANTOM_CANDIDATE) && selfStraySubmission.candidate.upstreamAcceptedRevision === shaRef(PHANTOM_CANDIDATE) && selfStraySubmission.reviewVerdict?.decision === 'ACCEPTED', 'the r1 submission: label pseudo-address + phantom candidate set + ACCEPTED verdict - fabrication, not lineage');
check('R4.wrongProductKind', selfStrayBytes.decision.toString('utf8').includes('formalization.solution-contract.v1') && !selfStrayBytes.decision.toString('utf8').includes('frf-contracts.solution-contract.v1') && !JSON.stringify(selfStraySubmission).includes('frf-contracts.solution-contract.v1') && !selfStrayBytes.trace.toString('utf8').includes('frf-contracts.solution-contract.v1'), 'the r1 family "accepted" formalization.solution-contract.v1 (decision file, raw text) - not even the installed product kind (frf-contracts.solution-contract.v1 appears nowhere in the family)');
check('R5.tracePins', selfStrayTrace.traceRelationship.participants.some((p) => p.digest === shaRef(PHANTOM_CANDIDATE)) && selfStrayTrace.traceRelationship.participants.some((p) => p.digest === shaRef(PIN_PROTOCOL)) && selfStrayTrace.traceRelationship.workspaceContext.acceptedUpstreamRevisions === 1, 'the r1 trace pins the phantom set (material-authority) and the drifted anchor (relationship-structure); acceptedUpstreamRevisions=1 against this frame 0');
check('R6.phantomsUnresolvable', PHANTOMS.every((t) => SCAN.hashResolved[t].length === 0) && PHANTOMS.every((t) => SCAN.textualMentions[t] > 0), `all 8 phantom addresses hash-resolve to NOTHING workspace-wide while being carried textually by the r1 family files (${PHANTOMS.map((t) => SCAN.textualMentionPaths[t].length).join('/')})`);
check('R7.noEnvelopeCollision', PHANTOMS.every((p) => !Object.values(ENVELOPE).includes(p)), 'no phantom address collides with this task-projection envelope (the fabricated universe is disjoint from the real one)');
check('R8.dispositionRecorded', content.selfStrayProductHistory.disposition.includes('NOT lineage') && content.selfStrayProductHistory.decision.parseable === false && content.selfStrayProductHistory.phantomAddressCensus.inventedArtifactRefs.length === 7, 'the hold records the r1 family as retired fabrication provenance (unparseable decision; 7 invented refs + phantom candidate set)');

/* L: the ladder projection + the installed settle desk contract */
check('L1.inputClassesAbsent', JSON.stringify(content.ladderProjection.inputClassPresence.map((e) => e.inputClass)) === JSON.stringify(['frozenBaseline', 'baselineArtifact', 'srs', 'repositoryPolicyRefs', 'handoff']) && content.ladderProjection.inputClassPresence.every((e) => e.presence === 'absent' && e.reason.length > 20), 'all five settlement input classes recorded absent, each with its recomputed reason');
check('L2.refusalLawRecomputes', settlementSrc.includes('settlement never discovers authorities') && settlementSrc.includes('settlement was given no') && content.ladderProjection.projectedFirstRefusal.reason === 'MISSING_LINEAGE' && content.ladderProjection.projectedFirstRefusal.rung.startsWith('R1'), 'the projected R1 refusal recomputes against the installed settlement source law text');
check('L3.routingTableRecomputes', protocolSrc.includes("MISSING_LINEAGE: 'failed'") && content.ladderProjection.routedOutcome === 'failed' && content.ladderProjection.domainProjection.includes('NOT fired by this author seat'), 'MISSING_LINEAGE routes to failed in the installed frozen table; the domain edge is kernel-owned and NOT fired by this seat');
check('L4.handoffKindsRecompute', srcHandoffKinds.length === 12 && JSON.stringify(content.deskContract.handoffBindingKinds) === JSON.stringify(srcHandoffKinds), 'the twelve handoff binding kinds in the hold recompute exactly from the frozen validator vocabulary');
check('L5.deskContractRecomputes', manifestSrc.includes("id: 'settle-formalization'") && manifestSrc.includes("outputProductKind: 'frf-contracts.solution-contract.v1'") && manifestSrc.includes("checkProviderId: 'formalization.settlement-structure.v1'") && manifestSrc.includes("effectId: 'formalization.settle-solution-contract', operatorStaffed: true") && manifestSrc.includes("{ from: 'define-architecture-contract', to: 'settle-formalization', on: 'domain.accepted' }") && manifestSrc.includes("{ from: 'settle-formalization', to: 'complete-formalized', on: 'domain.formalized' }"), 'the installed settle desk row + inbound/outbound edges recompute from the manifest');
check('L6.fabricationFence', typeof content.ladderProjection.fabricationFence === 'string' && content.ladderProjection.fabricationFence.includes('DRIFT_DETECTED') && content.ladderProjection.fabricationFence.includes('FOREIGN_LINEAGE') && content.fence.forbiddenProductSections.includes('canonicalDigest') && settlementSrc.includes('sha256OfCanonical(inputs.frozenBaseline)'), 'the fabrication fence is recorded against the installed R1 recomputation law (a forged pin dies at DRIFT_DETECTED)');
check('L7.selfSealSurface', settlementSrc.includes('postFreeze.settlement.solutionContractDigest') && content.deskContract.selfSealSurface === 'postFreeze.settlement.solutionContractDigest', 'the self-seal surface name recomputes from the installed cell');

/* P: frame pin adjudication (content layer, this round excluded) */
check('P1.protocolPinUnresolvable', SCAN.hashResolved[PIN_PROTOCOL].length === 0, `a926df6284... hash-resolves to zero contents across ${SCAN.files} scanned files (raw/whole-canon/.content-canon layers)`);
check('P2.semanticPinUnresolvable', SCAN.hashResolved[PIN_SEMANTIC].length === 0, '95fafc847b... hash-resolves to zero contents');
check('P3.selfDeclaredClaimantsAreR1StrayFamily', SCAN.selfDeclaredClaimants.length >= 2 && SCAN.selfDeclaredClaimants.some((p) => p.endsWith('r1/define-architecture-contract-desk-architecture-contract.artifact.json')) && SCAN.selfDeclaredClaimants.every((p) => p.includes('stray-products-r1/')), `the only files declaring a926df6284... as their own address are r1 stray-family files (${SCAN.selfDeclaredClaimants.length})`);
check('P4.upstreamStrayDriftRecomputes', r1StrayRec.raw.contentDigest === PIN_PROTOCOL && r1StrayRec.d === R1_UPSTREAM_STRAY_RECOMPUTED && r1StrayRec.d !== r1StrayRec.raw.contentDigest, `the upstream desk's r1 stray product: declared ${r1StrayRec.raw.contentDigest.slice(0, 8)}... vs recomputed ${r1StrayRec.d.slice(0, 8)}... (drift of record)`);
check('P5.strayNotLineage', r1VerdictDigest === 'bc1c5e59f1555eee27d7bf62e82f0578208af749f025621f6e0d102128a94252' && content.frameAdjudication.protocolSkillPin.extraIdentity.includes('r1'), 'the r1 stray history is recorded as retired; the pre-regime approved verdict recomputes and carries no standing');
check('P6.installedPinsDiffer', INSTALLED_PROTOCOL === sha({ skillId: 'saga-process-module-worker-protocol', kind: 'protocol' }) && INSTALLED_SEMANTIC === sha({ skillId: 'formalization-desk-settle-formalization', kind: 'semantic', desk: 'settle-formalization' }) && content.frameAdjudication.protocolSkillPin.installedManifestPin === shaRef(INSTALLED_PROTOCOL) && content.frameAdjudication.semanticSkillPin.installedManifestPin === shaRef(INSTALLED_SEMANTIC) && PIN_PROTOCOL !== INSTALLED_PROTOCOL && PIN_SEMANTIC !== INSTALLED_SEMANTIC, 'the installed manifest skill digests recompute (protocol + THIS desk semantic) and BOTH differ from the frame pins (frame authority refused)');
check('P7.frameSummaryTrue', content.frameAdjudication.workspaceSummary.adjudication.startsWith('TRUE') && content.workspaceSummary === '0 accepted upstream revisions travel by content address', 'the frame workspace summary is adjudicated TRUE of the chain (census 0 of 7)');

/* D: determinism + scan honesty */
check('D1.scanHonest', SCAN.files > 2000 && SCAN.textualMentions[PIN_PROTOCOL] > 50, `${SCAN.files} workspace files scanned; the inherited anchor is textually carried by the corpus (${SCAN.textualMentions[PIN_PROTOCOL]} files) while resolving to nothing`);
check('D2.deterministicAuthoring', content.verification.deterministicAuthoring === true && artifactFile.createdAt === '2026-08-28T00:00:00Z' && traceFile.createdAt === '2026-08-28T00:00:00Z', 'pinned timestamps, no clock reads, no randomness');

/* ------------------------------------------------------------------ */
/* Write verify-out                                                     */
/* ------------------------------------------------------------------ */

const passCount = checks.filter((c) => c.pass).length;
const out = {
  verified: 'UH-Settle-Formalization-001',
  round: SELF_ROUND,
  deskRef: 'settle-formalization',
  role: 'author',
  checks,
  summary: { total: checks.length, pass: passCount, fail: checks.length - passCount, allPass: passCount === checks.length },
  scan: {
    filesScanned: SCAN.files,
    layers: ['raw bytes', 'whole-JSON canonical', '.content canonical'],
    excludedFromScan: ['.git', 'node_modules', `${SELF_ROUND} (this emission)`],
    framePins: {
      protocolSkill: { address: shaRef(PIN_PROTOCOL), hashResolvedContents: SCAN.hashResolved[PIN_PROTOCOL].length, textualMentionFiles: SCAN.textualMentions[PIN_PROTOCOL], selfDeclaredClaimants: SCAN.selfDeclaredClaimants },
      semanticSkill: { address: shaRef(PIN_SEMANTIC), hashResolvedContents: SCAN.hashResolved[PIN_SEMANTIC].length, textualMentionFiles: SCAN.textualMentions[PIN_SEMANTIC] },
    },
    phantomAddresses: PHANTOMS.map((t) => ({ address: shaRef(t), hashResolvedContents: SCAN.hashResolved[t].length, textualMentionFiles: SCAN.textualMentions[t] })),
  },
  emission: {
    artifactRef: artifactFile.artifactRef,
    traceRef: traceFile.traceRef,
    decision: content.decision,
    noProductAuthored: true,
    projectedLadderOutcomeIfRun: content.ladderProjection.routedOutcome,
  },
};
writeFileSync(join(DIR, 'settle-formalization-desk-hold-verify-out.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');

console.log(JSON.stringify(out.summary, null, 2));
if (out.summary.fail > 0) {
  console.error(JSON.stringify(checks.filter((c) => !c.pass), null, 2));
  process.exit(1);
}
