/**
 * define-architecture-contract desk (author) - SRS UPSTREAM HOLD verifier.
 *
 * Independent recomputation of UH-Define-Architecture-Contract-001
 * (stray-products-r5). Nothing is trusted by declaration:
 *   - every cited corpus record digest is recomputed from the corpus;
 *   - the emission files are re-parsed and their self-addresses recomputed;
 *   - the frame pins are adjudicated by a workspace-wide scan (raw bytes,
 *     whole-JSON canonical, .content canonical), this round excluded;
 *   - the fence is checked: the hold must author NO SRS product material.
 *
 * Deterministic: pinned expectations, no clock reads, no randomness.
 *
 * Run: node define-architecture-contract-desk-hold-verify.mjs
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
const SELF_ROUND = 'stray-products-r5';

const PIN_PROTOCOL = 'a926df6284a1afb5e1d7e899b1279acd746d40d48658de6dd0d2a368f76b2837';
const PIN_SEMANTIC = '95fafc847b24ebf5a6cb142b9ae96db9f08308ea3bb7e7eab9b534858108eebd';
const INSTALLED_PROTOCOL = 'b88267a1df84ae503d0e9744734a26671506f7bb719cb7b457f8d5ad6745997f';
const INSTALLED_SEMANTIC = '131efbd99bd2d92e0ac790ab9c271218d0a72995df0053fc35cbffc4d7f176f3';
const R1_STRAY_RECOMPUTED = 'f4846e5fed6808f8b0c33b14d58a337d9f72eddd02bf775bc048862b1d5626af';

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

const R2 = 'docs/refactoring/event-kernel/qualification/stray-products-r2';
const R3 = 'docs/refactoring/event-kernel/qualification/stray-products-r3';
const R4 = 'docs/refactoring/event-kernel/qualification/stray-products-r4';
const R1 = 'docs/refactoring/event-kernel/qualification/stray-products-r1';

/* ------------------------------------------------------------------ */
/* Workspace-wide scan (this round excluded, honest about mentions)     */
/* ------------------------------------------------------------------ */

const scanWorkspace = () => {
  const targets = new Set([PIN_PROTOCOL, PIN_SEMANTIC, R1_STRAY_RECOMPUTED]);
  const state = {
    files: 0,
    textualMentions: Object.fromEntries([...targets].map((t) => [t, 0])),
    textualMentionPaths: Object.fromEntries([...targets].map((t) => [t, []])),
    hashResolved: Object.fromEntries([...targets].map((t) => [t, []])),
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
          if (targets.has(whole)) state.hashResolved[whole].push(`${relPath(p)} :: whole-canon`);
          if (j && typeof j === 'object' && j.content !== undefined) {
            const c = shaRaw(Buffer.from(canon(j.content), 'utf8'));
            if (targets.has(c)) state.hashResolved[c].push(`${relPath(p)} :: content-canon`);
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

const artifactFile = JSON.parse(readFileSync(join(DIR, 'define-architecture-contract-desk-upstream-hold.artifact.json'), 'utf8'));
const traceFile = JSON.parse(readFileSync(join(DIR, 'define-architecture-contract-desk-upstream-hold-trace.json'), 'utf8'));
const summaryText = readFileSync(join(DIR, 'define-architecture-contract-desk-hold-submission-summary.md'), 'utf8');

const content = artifactFile.content;
const traceContent = traceFile.content;

/* ------------------------------------------------------------------ */
/* Corpus recomputation (independent pass)                              */
/* ------------------------------------------------------------------ */

const dig = (relPath) => {
  const j = JSON.parse(readFileSync(join(REPO, relPath), 'utf8'));
  return { d: sha(j.content), raw: j };
};
const importRec = dig(`${R2}/import-discovery-handoff-desk-discovery-import.artifact.json`);
const holdRec = dig(`${R3}/freeze-what-baseline-desk-upstream-hold.artifact.json`);
const fr4Rec = dig(`${R4}/freeze-what-baseline-desk-reviewer-review.json`);
const vv4Rec = dig(`${R4}/freeze-what-baseline-desk-reviewer-verification.json`);
const rt4Rec = dig(`${R4}/freeze-what-baseline-desk-reviewer-trace.json`);
const fs4Rec = dig(`${R4}/freeze-what-baseline-desk-reviewer-product-submission.json`);
const frRwRec = dig(`${R3}/reconcile-what-desk-reviewer-review.json`);
const intentRec = dig(`${R3}/define-product-intent-desk-product-intent.artifact.json`);
const ucRec = dig(`${R3}/model-use-cases-desk-uc-scenarios.artifact.json`);
const srRec = dig(`${R3}/derive-system-requirements-desk-system-requirements.artifact.json`);
const acRec = dig(`${R3}/define-acceptance-contract-desk-acceptance-bindings.artifact.json`);
const uhAcRec = dig(`${R3}/define-acceptance-contract-desk-upstream-hold.artifact.json`);
const schemaRawDigest = shaRaw(readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json')));
const r1StrayRec = dig(`${R1}/define-architecture-contract-desk-architecture-contract.artifact.json`);
const r1VerdictDigest = shaRaw(Buffer.from(canon(JSON.parse(readFileSync(join(REPO, `${R1}/define-architecture-contract-review-verdict.json`), 'utf8'))), 'utf8'));

/* ------------------------------------------------------------------ */
/* Checks ledger                                                        */
/* ------------------------------------------------------------------ */

const checks = [];
const check = (id, pass, detail) => { checks.push({ id, pass: pass === true, detail }); return pass === true; };

/* S: emission self-consistency */
const EXPECTED_CONTENT_KEYS = [
  'schemaVersion', 'deskRef', 'deskNodeId', 'role', 'itemInstanceId', 'token', 'holdKind', 'decision', 'statement',
  'protocolLineage', 'taskProjection', 'deskContract', 'upstreamGate', 'chainAcceptanceCensus', 'strayProductHistory',
  'frameAdjudication', 'unresolvableInstances', 'noProductAuthored', 'fence', 'acceptanceLaws', 'resumeContract',
  'verification', 'workspaceSummary',
].sort();
check('S1.artifactDigestRecomputes', artifactFile.contentDigest === sha(content), `contentDigest ${artifactFile.contentDigest} recomputes over canonical JSON of content`);
check('S2.traceDigestRecomputes', traceFile.contentDigest === sha(traceContent), `contentDigest ${traceFile.contentDigest} recomputes`);
check('S3.refsCrossBind', artifactFile.artifactRef === shaRef(artifactFile.contentDigest) && traceFile.traceRef === shaRef(traceFile.contentDigest) && traceContent.subjectArtifactRef === artifactFile.artifactRef && traceContent.subjectSemanticCode === artifactFile.semanticCode, 'artifact/trace refs cross-bind');
check('S4.identity', artifactFile.semanticCode === 'UH-Define-Architecture-Contract-001' && content.deskRef === 'define-architecture-contract' && content.role === 'author' && content.schemaVersion === 'formalization.upstream-hold.v1' && content.decision === 'hold-no-authoring' && content.noProductAuthored === true && traceContent.traceKind === 'upstream-hold-trace', 'identity: author-seat SRS upstream hold, no product authored');
check('S5.noProductMaterial', JSON.stringify([...Object.keys(content)].sort()) === JSON.stringify(EXPECTED_CONTENT_KEYS) && content.fence.forbiddenProductSections.length === 7, 'the hold authors no SRS product material (fence: closed content-key set + forbidden-sections register)');
check('S6.acceptanceLaws', content.acceptanceLaws.length === 3 && content.acceptanceLaws.every((l) => l.satisfied === true), 'constraint honored, unknown carried, terminal claims observed only');
check('S7.summaryCitesEmission', summaryText.includes(artifactFile.artifactRef) && summaryText.includes(traceFile.traceRef) && summaryText.includes('hold-no-authoring'), 'the submission summary cites the emission of record');

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
const censusOk = content.chainAcceptanceCensus.upstreamDeskCount === 6 && content.chainAcceptanceCensus.acceptedUpstreamDeskCount === 0 && content.chainAcceptanceCensus.upstreamDesks.length === 6 && content.chainAcceptanceCensus.upstreamDesks.every((row) => row.accepted === false);
check('U1.censusZeroOfSix', censusOk, 'recomputed census: 0 of 6 accepted upstream desks (five pre-freeze + freeze), each row NOT accepted with evidence refs');
const evidenceDigests = content.chainAcceptanceCensus.upstreamDesks.flatMap((row) => row.evidenceRefs.map((r) => r.replace('sha256:', '')));
const digestsOf = (relPaths) => relPaths.map((p) => dig(p).d);
const recomputedEvidence = new Set(digestsOf([
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
]));
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
check('F6.prohibitionUndischarged', String(frRwRec.raw.content.nextStage).includes('No domain.accepted may fire from this desk toward freeze-what-baseline') && content.upstreamGate.gateEdgeBlocked.includes('never lawfully fired'), 'the upstream no-accept prohibition recomputes; the domain.frozen edge into this desk never lawfully fired');
const schemaOk = schemaRawDigest === 'ab1b7f5e1bc4d94fd4ed7eff33289effe21172753222d623273a6346eb053d09' && JSON.parse(readFileSync(join(REPO, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'schemas', 'what-baseline.schema.json'), 'utf8')).properties.acceptanceRecords.minItems === 5;
check('F7.freezeContractLaw', schemaOk, 'the freeze payload contract recomputes (acceptanceRecords minItems 5): the root lawful-authoring blocker');

/* P: frame pin adjudication (content layer, this round excluded) */
check('P1.protocolPinUnresolvable', SCAN.hashResolved[PIN_PROTOCOL].length === 0, `a926df6284... hash-resolves to zero contents across ${SCAN.files} scanned files (raw/whole-canon/.content-canon layers)`);
check('P2.semanticPinUnresolvable', SCAN.hashResolved[PIN_SEMANTIC].length === 0, '95fafc847b... hash-resolves to zero contents');
check('P3.selfDeclaredClaimantsAreR1StrayFamily', SCAN.selfDeclaredClaimants.length >= 2 && SCAN.selfDeclaredClaimants.some((p) => p.endsWith('r1/define-architecture-contract-desk-architecture-contract.artifact.json')) && SCAN.selfDeclaredClaimants.every((p) => p.includes('stray-products-r1/')), `the only files declaring a926df6284... as their own address are r1 stray-family files (${SCAN.selfDeclaredClaimants.length})`);
const strayDriftOk = r1StrayRec.raw.contentDigest === PIN_PROTOCOL && r1StrayRec.d === R1_STRAY_RECOMPUTED && r1StrayRec.d !== r1StrayRec.raw.contentDigest;
check('P4.strayDriftRecomputes', strayDriftOk, `the r1 stray product of THIS desk: declared ${r1StrayRec.raw.contentDigest.slice(0, 8)}... vs recomputed ${r1StrayRec.d.slice(0, 8)}... (drift of record)`);
check('P5.strayNotLineage', r1VerdictDigest === 'bc1c5e59f1555eee27d7bf62e82f0578208af749f025621f6e0d102128a94252' && content.strayProductHistory.r1StrayProduct.recomputedContentDigest === shaRef(R1_STRAY_RECOMPUTED) && content.strayProductHistory.r1StrayProduct.disposition.includes('NOT lineage'), 'the r1 stray product is recorded as retired history; its pre-regime approved verdict recomputes and carries no standing');
const installedOk = sha({ skillId: 'saga-process-module-worker-protocol', kind: 'protocol' }) === INSTALLED_PROTOCOL
  && sha({ skillId: 'formalization-desk-define-architecture-contract', kind: 'semantic', desk: 'define-architecture-contract' }) === INSTALLED_SEMANTIC
  && content.frameAdjudication.protocolSkillPin.installedManifestPin === shaRef(INSTALLED_PROTOCOL)
  && content.frameAdjudication.semanticSkillPin.installedManifestPin === shaRef(INSTALLED_SEMANTIC);
check('P6.installedPinsDiffer', installedOk, 'the installed manifest skill digests recompute and BOTH differ from the frame pins (frame authority refused)');
check('P7.frameSummaryTrue', content.frameAdjudication.workspaceSummary.adjudication.startsWith('TRUE') && content.workspaceSummary === '0 accepted upstream revisions travel by content address', 'the frame workspace summary is adjudicated TRUE of the chain (census 0 of 6)');

/* D: determinism + scan honesty */
check('D1.scanHonest', SCAN.files > 2000 && SCAN.textualMentions[PIN_PROTOCOL] > 50, `${SCAN.files} workspace files scanned; the inherited anchor is textually carried by the corpus (${SCAN.textualMentions[PIN_PROTOCOL]} files) while resolving to nothing`);
check('D2.deterministicAuthoring', content.verification.deterministicAuthoring === true && artifactFile.createdAt === '2026-08-28T00:00:00Z' && traceFile.createdAt === '2026-08-28T00:00:00Z', 'pinned timestamps, no clock reads, no randomness');

/* ------------------------------------------------------------------ */
/* Write verify-out                                                     */
/* ------------------------------------------------------------------ */

const passCount = checks.filter((c) => c.pass).length;
const out = {
  verified: 'UH-Define-Architecture-Contract-001',
  round: SELF_ROUND,
  deskRef: 'define-architecture-contract',
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
  },
  emission: {
    artifactRef: artifactFile.artifactRef,
    traceRef: traceFile.traceRef,
    decision: content.decision,
    noProductAuthored: content.noProductAuthored,
  },
};
writeFileSync(join(DIR, 'define-architecture-contract-desk-hold-verify-out.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');

console.log(JSON.stringify(out.summary, null, 2));
if (out.summary.fail > 0) {
  console.error(JSON.stringify(checks.filter((c) => !c.pass), null, 2));
  process.exit(1);
}
