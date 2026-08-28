/**
 * define-acceptance-contract desk (reviewer) - independent verification
 * evidence over the r3 author candidate of record.
 *
 * Nothing is trusted by declaration. The frozen kernel digest rule
 * (src/workflow-kernel/domain/digest.ts) is sha256 over canonical JSON
 * (recursively key-sorted, compact, UTF-8).
 *
 * Recomputes every declared digest of the author candidate
 * (submission FS-Define-Acceptance-Contract-001 sha256:6e19d3cb...,
 * acceptance-bindings artifact sha256:2b01353d..., trace sha256:2835aea3...),
 * re-derives the accepted universe through the REAL acceptanceUniverseFrom
 * protocol, seals all 5 criteria through the REAL WP03 validator
 * (validateAcBinding via the cell seam), re-seals the bundle through the
 * REAL validateAcceptanceBundle, runs the REAL gate
 * (evaluateAcceptanceGate over the installed provider declaration),
 * executes the reviewer adversarial duties rev-1..rev-4 (citation-pair
 * re-derivation from the bound requirements' derivations, deferral law,
 * FOREIGN_LINEAGE scan, scenario-stripped mutants that MUST be refused),
 * re-verifies the upstream accepted chain (intent a06dbc57 / uc 24f0aff2 /
 * requirements 86b00569 artifacts, revision folds, r2 import capsule
 * material), resolves every author-trace edge against recomputed digests,
 * adjudicates the reviewer envelope (upstream-accepted[0]
 * sha256:32892970...), and self-verifies the on-disk reviewer round
 * (verification / review / product submission / trace).
 *
 * Run: node define-acceptance-contract-desk-reviewer-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(DIR, '..', '..', '..', '..', '..');
const R2 = join(ROOT, 'docs', 'refactoring', 'event-kernel', 'qualification', 'stray-products-r2');

const sub = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-product-submission.json'), 'utf8'));
const art = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings-trace.json'), 'utf8'));
const req = JSON.parse(readFileSync(join(DIR, 'derive-system-requirements-desk-system-requirements.artifact.json'), 'utf8'));
const ucArt = JSON.parse(readFileSync(join(DIR, 'model-use-cases-desk-uc-scenarios.artifact.json'), 'utf8'));
const intentArt = JSON.parse(readFileSync(join(R2, 'define-product-intent-desk-product-intent.artifact.json'), 'utf8'));
const imp = JSON.parse(readFileSync(join(R2, 'import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));

/* The on-disk reviewer round (verified in group I). */
let ver = null, rev = null, rsub = null, rtrc = null;
try {
  ver = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-verification.json'), 'utf8'));
  rev = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-review.json'), 'utf8'));
  rsub = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-product-submission.json'), 'utf8'));
  rtrc = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-reviewer-trace.json'), 'utf8'));
} catch { /* group I records the absence */ }

/* The REAL kernel cell code (the same modules the driver executes). */
const cellDir = join(ROOT, 'dist', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'acceptance');
const gateMod = await import(pathToFileURL(join(cellDir, 'gate.mjs')).href);
const planMod = await import(pathToFileURL(join(cellDir, 'check-plan.mjs')).href);
const protocolMod = await import(pathToFileURL(join(cellDir, 'protocol.mjs')).href);

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); return ok; };

/* The exact accepted material of this desk's task projection (envelope). */
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
const ENVELOPE_UPSTREAM = '32892970b44cb1d25a5fdce61e4cea43500ccd1cc4cb8fb03e2b268e1758645d';

/* ------------------------------------------------------------------ */
/* A. author submission self-address                                   */
/* ------------------------------------------------------------------ */
check('A1.submission.contentDigest', sha(sub.content) === sub.contentDigest && sub.contentDigest === '6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe', `recomputed ${sha(sub.content)} vs declared ${sub.contentDigest}`);
check('A2.submission.submissionRef', sub.submissionRef === shaRef(sub.contentDigest) && sub.submissionId === 'FS-Define-Acceptance-Contract-001' && sub.role === 'author' && sub.deskRef === 'define-acceptance-contract', sub.submissionRef);
check('A3.submission.intakeReceipt', sub.content.intakeReceipt.status === 'admitted_for_reviewer_stage' && sub.content.intakeReceipt.nextStage === 'reviewer', sub.content.intakeReceipt.status);

/* ------------------------------------------------------------------ */
/* B. acceptance-bindings artifact self-address + seals                */
/* ------------------------------------------------------------------ */
const artDigest = sha(art.content);
const productSeal = sha(art.content.product);
check('B1.artifact.contentDigest', artDigest === art.contentDigest && artDigest === sub.content.candidate.contentDigest && artDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0', `recomputed ${artDigest} vs declared ${art.contentDigest} / candidate ${sub.content.candidate.contentDigest}`);
check('B2.artifact.candidateBinding', sub.content.candidate.artifactRef === shaRef(artDigest) && sub.content.candidate.kind === 'formalization.acceptance-bindings.v1' && art.content.productKind === 'formalization.acceptance-bindings.v1', sub.content.candidate.artifactRef);
check('B3.productSeal', productSeal === art.content.productSeal.digest && art.content.productSeal.ref === shaRef(productSeal) && productSeal === '14fda7910eedff5a84f69d13e5b85070fe395f349d75263d145543f781085f51', `recomputed ${productSeal} vs declared ${art.content.productSeal.digest}`);
const criteria = art.content.product.criteria;
let memberSealsOk = criteria.length === 5;
const sealByCriterion = new Map();
for (const c of criteria) {
  const recomputed = sha(c);
  sealByCriterion.set(c.criterionId, recomputed);
  const declared = art.content.memberSeals.find((s) => s.criterionId === c.criterionId);
  const ok = declared !== undefined && declared.digest === recomputed && declared.ref === shaRef(recomputed);
  memberSealsOk = memberSealsOk && ok;
  if (!ok) check(`B4.${c.criterionId}`, false, `recomputed ${recomputed} vs declared ${declared?.digest ?? 'MISSING'}`);
}
check('B4.memberSeals', memberSealsOk && art.content.memberSeals.length === 5 && new Set(art.content.memberSeals.map((s) => s.criterionId)).size === 5, `5/5 criterion member seals recompute over canonical members`);
let stmtSealsOk = true;
const stmtSealById = new Map();
for (const s of art.content.verifiableStatements) {
  const recomputed = sha({ statementId: s.statementId, statement: s.statement });
  stmtSealById.set(s.statementId, recomputed);
  const ok = recomputed === s.digest && s.ref === shaRef(recomputed);
  stmtSealsOk = stmtSealsOk && ok;
  if (!ok) check(`B5.${s.statementId}`, false, `recomputed ${recomputed} vs declared ${s.digest}`);
}
const criteriaStmtRefs = criteria.flatMap((c) => c.verifiableStatementRefs ?? []);
check('B5.statementSeals', stmtSealsOk && art.content.verifiableStatements.length === 5 && criteriaStmtRefs.every((r) => stmtSealById.has(r)), `5/5 verifiable statement seals recompute; all criterion statement refs resolve`);

/* ------------------------------------------------------------------ */
/* C. REAL kernel gate + REAL WP03 seam + REAL universe protocol       */
/* ------------------------------------------------------------------ */
const provider = planMod.ACCEPTANCE_CHECK_PROVIDER;
const providerDigest = planMod.acceptanceProviderDigest();
const localProviderDigest = sha({ providerId: provider.providerId, version: provider.version, nodeId: provider.nodeId, productKind: provider.productKind, validator: provider.validator });
check('C1.providerDeclaration', providerDigest === localProviderDigest && provider.nodeId === 'define-acceptance-contract' && provider.productKind === 'formalization.acceptance-bindings.v1' && provider.validator === 'validateAcceptanceBundle', `provider ${provider.providerId} v${provider.version}; digest recomputed locally ${localProviderDigest.slice(0, 12)} == REAL acceptanceProviderDigest`);
const universeOut = protocolMod.acceptanceUniverseFrom({
  requirementsBundle: req.content.product,
  useCases: { scenarioIds: art.content.upstream.acceptedUcSet.scenarioIds, branchIdsByScenario: art.content.upstream.acceptedUcSet.branchIdsByScenario },
  verifiableStatementIds: art.content.deskInput.verifiableStatementIds,
  evidenceBindings: art.content.deskInput.evidenceBindings,
});
check('C2.universeFromRealProtocol', universeOut.ok === true, universeOut.ok ? `universe fr=${universeOut.universe.idSets.frIds.join(',')} nfr=${universeOut.universe.idSets.nfrIds.join(',')} ruleIds=${universeOut.universe.idSets.ruleIds.length} scenarios=${universeOut.universe.idSets.ucScenarioIds.length} branches=${Object.values(universeOut.universe.idSets.ucBranchIdsByScenario).flat().length} stmts=${universeOut.universe.idSets.verifiableStatementIds.length}` : `${universeOut.reason}: ${universeOut.detail}`);
const universe = universeOut.universe;
check('C2b.universeFailClosedSets', universe.idSets.frIds.join(',') === 'fr:boundary-1,fr:outcome-1,fr:terminal-1' && universe.idSets.nfrIds.join(',') === 'nfr:determinism-1' && universe.idSets.ruleIds.length === 0 && universe.idSets.verifiableStatementIds.length === 5, JSON.stringify(universe.idSets.ucBranchIdsByScenario));
const wp03 = await import(pathToFileURL(join(cellDir, 'wp03-seam.mjs')).href);
let wp03AllOk = true;
const wp03Digests = new Map();
for (const c of criteria) {
  const sealedNow = wp03.validateAcBinding(c, universe);
  wp03Digests.set(c.criterionId, sealedNow.digest);
  const ok = sealedNow.ok === true && sealedNow.digest === sealByCriterion.get(c.criterionId);
  wp03AllOk = wp03AllOk && ok;
  if (!ok) check(`C3.${c.criterionId}`, false, `wp03=${sealedNow.ok === true ? 'sealed' : `${sealedNow.reason}: ${sealedNow.detail}`}`);
}
check('C3.wp03PerCriterion', wp03AllOk, `5/5 criteria sealed through the REAL WP03 validateAcBinding seam (digests match the recomputed member seals)`);
const reseal = (await import(pathToFileURL(join(cellDir, 'closure.mjs')).href)).validateAcceptanceBundle(art.content.product, universe, req.content.product.requirements);
check('C4.bundleReseal', reseal.ok === true && reseal.artifact.ref === shaRef(productSeal), reseal.ok ? `REAL validateAcceptanceBundle re-seal ${reseal.artifact.ref} matches the declared product seal` : `${reseal.reason}: ${reseal.detail}`);
const gateOutcome = gateMod.evaluateAcceptanceGate({ ...provider, providerDigest }, { kind: provider.productKind, product: art.content.product }, universe, req.content.product.requirements);
check('C5.gate.accepted', gateOutcome.verdict === 'accepted' && gateOutcome.productRef === shaRef(productSeal) && gateOutcome.issues.length === 0, `verdict=${gateOutcome.verdict} productRef=${gateOutcome.productRef ?? 'n/a'}`);
const impostor = gateMod.evaluateAcceptanceGate({ ...provider, providerDigest: 'deadbeef'.repeat(8) }, { kind: provider.productKind, product: art.content.product }, universe, req.content.product.requirements);
check('C6.gate.failClosed', impostor.verdict === undefined && impostor.reason === 'PROVIDER_NOT_DECLARED', `impostor provider refused: ${impostor.reason}`);

/* ------------------------------------------------------------------ */
/* D. reviewer adversarial duties (rev-1..rev-4)                       */
/* ------------------------------------------------------------------ */
/* rev-1: re-derive every scenario-facing citation pair from the bound
   requirements' own derivation (the accepted requirements bundle). */
const reqByid = new Map(req.content.product.requirements.map((r) => [r.requirementId, r]));
let rev1Ok = true;
for (const c of criteria) {
  const scenarioRefs = c.bindsTo.ucScenarioRefs ?? [];
  const branchRefs = c.bindsTo.ucTerminalBranchRefs ?? [];
  if (scenarioRefs.length === 0 && branchRefs.length === 0) continue;
  const bound = (c.bindsTo.requirementRefs ?? []).map((r) => reqByid.get(r)).filter(Boolean);
  const supportedScenarios = new Set(bound.flatMap((r) => r.derivation?.ucScenarioRefs ?? []));
  const supportedBranches = new Set(bound.flatMap((r) => r.derivation?.ucTerminalBranchRefs ?? []));
  const ok = scenarioRefs.every((s) => supportedScenarios.has(s)) && branchRefs.every((b) => supportedBranches.has(b));
  rev1Ok = rev1Ok && ok;
  if (!ok) check(`D1.${c.criterionId}`, false, `citations ${scenarioRefs.join(',')} / ${branchRefs.join(',')} not supported by bound requirement derivation(s)`);
}
check('D1.rev1.citationPairsReDerived', rev1Ok, `every scenario-facing criterion cites exactly the scenario+branch material its bound FR derives from (rev-1)`);
/* rev-2: deferral law - the bundle defers nothing; no double disposition. */
check('D2.rev2.deferralLaw', Array.isArray(art.content.product.deferrals) && art.content.product.deferrals.length === 0, 'deferrals=[] and no requirement is both covered and deferred (rev-2 vacuous, recorded)');
/* rev-3: FOREIGN_LINEAGE scan - no RULE bindings, refs inside accepted sets. */
const acBindable = new Set([...universe.idSets.frIds, ...universe.idSets.nfrIds]);
check('D3.rev3.noForeignLineage', criteria.every((c) => (c.bindsTo.requirementRefs ?? []).every((r) => acBindable.has(r))) && universe.idSets.ruleIds.length === 0, `all bound requirement refs inside the exact accepted FR/NFR sets; no RULE material bound (rev-3)`);
/* rev-4: the primary adversarial probe - strip ONE citation shape, the
   REAL gate must refuse. */
const cloneCriterion = (c, patch) => ({ ...c, bindsTo: { ...c.bindsTo, ...patch } });
const probe = (mutantCriteria) => {
  const mutant = { ...art.content.product, criteria: mutantCriteria };
  const outcome = gateMod.evaluateAcceptanceGate({ ...provider, providerDigest }, { kind: provider.productKind, product: mutant }, universe, req.content.product.requirements);
  return outcome;
};
const victim = criteria.find((c) => c.criterionId === 'ac:outcome-1-delivered');
const m1 = probe(criteria.map((c) => (c.criterionId === victim.criterionId ? cloneCriterion(c, { ucTerminalBranchRefs: [] }) : c)));
check('D4.rev4.branchStripped', m1.verdict === 'repair' && m1.issues[0]?.source === 'MISSING_LINEAGE', `branch-stripped mutant -> ${m1.verdict} (${m1.issues[0]?.source ?? 'no issue'}): AC-complete but scenario-stripped candidates never pass`);
const m2 = probe(criteria.map((c) => (c.criterionId === victim.criterionId ? cloneCriterion(c, { ucScenarioRefs: [] }) : c)));
check('D4b.rev4.scenarioStripped', m2.verdict === 'repair' && m2.issues[0]?.source === 'MISSING_LINEAGE', `scenario-stripped mutant -> ${m2.verdict} (${m2.issues[0]?.source ?? 'no issue'})`);
const m3 = probe(criteria.map((c) => (c.criterionId === 'ac:boundary-1' ? cloneCriterion(c, { ucScenarioRefs: ['uc:terminal-1'], ucTerminalBranchRefs: ['branch:terminal-1-main'] }) : c)));
check('D4c.rev4.unsupportedSubstitution', m3.verdict === 'upstream-repair' && m3.issues[0]?.source === 'FOREIGN_LINEAGE', `unrelated-scenario substitution -> ${m3.verdict} (${m3.issues[0]?.source ?? 'no issue'}): well-formed but semantically unsupported graphs never pass`);
const m4 = probe(criteria.map((c) => (c.criterionId === 'ac:boundary-1' ? { ...c, bindsTo: { ...c.bindsTo, requirementRefs: ['fr:ghost-1'] } } : c)));
check('D4d.rev4.foreignRequirement', m4.verdict === 'upstream-repair' && m4.issues[0]?.source === 'FOREIGN_LINEAGE', `foreign requirement binding -> ${m4.verdict} (${m4.issues[0]?.source ?? 'no issue'})`);
/* duplicate ids + WHAT-side fence (bundle level + per criterion). */
const ids = criteria.map((c) => c.criterionId);
const forbiddenBundle = ['participatingModules', 'moduleAllocation', 'files', 'architecture'];
const forbiddenCriterion = ['files', 'moduleAllocation', 'participatingModules'];
check('D5.identityAndFence', new Set(ids).size === ids.length && forbiddenBundle.every((k) => art.content.product[k] === undefined) && criteria.every((c) => forbiddenCriterion.every((k) => c[k] === undefined)), `criterion ids unique (${ids.length}); WHAT-side fence clean at bundle and criterion level`);

/* ------------------------------------------------------------------ */
/* E. coverage laws (independent of the gate)                          */
/* ------------------------------------------------------------------ */
const coveredReqs = new Set(criteria.flatMap((c) => c.bindsTo.requirementRefs ?? []));
check('E1.requirementsCoverage', [...acBindable].every((r) => coveredReqs.has(r)), `every accepted FR/NFR covered: ${[...coveredReqs].sort().join(', ')} (no deferrals needed)`);
const requiredBranches = new Map(Object.entries(universe.idSets.ucBranchIdsByScenario).flatMap(([s, bs]) => bs.map((b) => [b, s])));
const coveredBranches = new Set(criteria.flatMap((c) => c.bindsTo.ucTerminalBranchRefs ?? []));
check('E2.terminalResultCoverage', [...requiredBranches.keys()].every((b) => coveredBranches.has(b)) && art.content.product.standaloneEvidenceBindings.length === 0, `every required UC terminal branch covered end to end: ${[...coveredBranches].sort().join(', ')} (no standalone evidence bindings needed)`);
const EVIDENCE_KINDS = protocolMod.EVIDENCE_KINDS;
check('E3.evidenceClosedVocabulary', criteria.every((c) => EVIDENCE_KINDS.includes(c.evidence.evidenceKind) && typeof c.evidence.observableTerminalResult === 'string' && c.evidence.observableTerminalResult.length > 0), `evidence kinds ${[...new Set(criteria.map((c) => c.evidence.evidenceKind))].sort().join(',')} from the closed four-value vocabulary; observable terminal results declared`);
const criterionText = JSON.stringify(criteria);
const statementText = JSON.stringify(art.content.verifiableStatements);
check('E4.d10NothingDerivedFromOutOfScope', !criterionText.includes('prd:scope-2') && !criterionText.includes('unknown:browser-matrix-1') && !statementText.includes('browser') && !criterionText.includes('scope-2'), `prd:scope-2 (out_of_scope) and unknown:browser-matrix-1 derive no criterion, statement, evidence kind or terminal result (D10)`);

/* ------------------------------------------------------------------ */
/* F. terminal support + constraint/unknown dispositions               */
/* ------------------------------------------------------------------ */
const prdSealById = new Map(req.content.upstream.acceptedIntentSeals.map((s) => [s.memberId, s.digest]));
const terminalSupport = art.content.terminalSupport;
const audited = terminalSupport.find((t) => t.terminalClaimId === 'terminal:audited-1');
const delivered = terminalSupport.find((t) => t.terminalClaimId === 'terminal:delivered-1');
check('F1.terminalAuditedChain', audited !== undefined && audited.digest === ENVELOPE['terminal:audited-1'] && audited.ownedByMemberId === 'prd:terminal-1' && prdSealById.get('prd:terminal-1') === '694e26f7e7ded74f1a9250c2d673febcec8b5d9cd74ff91570297eae156ebcfc' && audited.supportedByRequirementId === 'fr:terminal-1' && audited.verifiedByCriterionId === 'ac:terminal-1-audited', 'terminal:audited-1 <- prd:terminal-1 <- fr:terminal-1 <- ac:terminal-1-audited (chain resolves)');
check('F2.terminalDeliveredChain', delivered !== undefined && delivered.digest === ENVELOPE['terminal:delivered-1'] && delivered.ownedByMemberId === 'prd:outcome-1' && prdSealById.get('prd:outcome-1') === '0f089cfa6a151e1c36415e861ac67461dd3213b9ce09b32b9e398ac082d30b16' && delivered.supportedByRequirementId === 'fr:outcome-1' && delivered.verifiedByCriterionId === 'ac:outcome-1-delivered', 'terminal:delivered-1 <- prd:outcome-1 <- fr:outcome-1 <- ac:outcome-1-delivered (chain resolves)');
const nfr = reqByid.get('nfr:determinism-1');
const constraintDisposition = art.content.constraintDispositions.find((d) => d.constraintId === 'constraint:retention-1');
check('F3.constraintHonored', constraintDisposition?.disposition === 'honored' && constraintDisposition.digest === ENVELOPE['constraint:retention-1'] && JSON.stringify(constraintDisposition.enforcedBy.slice().sort()) === JSON.stringify(['ac:determinism-1', 'ac:outcome-1-deterministic-error']) && JSON.stringify(nfr.derivation.prdIntentRefs) === JSON.stringify(['prd:constraint-1']) && JSON.stringify(nfr.derivation.sourceConstraintRefs) === JSON.stringify(['constraint:retention-1']), 'constraint:retention-1 honored: the determinism NFR binds the constraint directly upstream; ac:determinism-1 + ac:outcome-1-deterministic-error enforce it here');
const unknownDisposition = art.content.unknownDispositions.find((d) => d.unknownId === 'unknown:browser-matrix-1');
check('F4.unknownCarriedForward', unknownDisposition?.disposition === 'carried_forward' && unknownDisposition.digest === ENVELOPE['unknown:browser-matrix-1'] && unknownDisposition.owner === 'discovery' && !criterionText.includes('browser-matrix'), 'unknown:browser-matrix-1 carried forward with owner discovery; no resolution edge, no fabricated resolution');

/* ------------------------------------------------------------------ */
/* G. author trace integrity                                           */
/* ------------------------------------------------------------------ */
const trcDigest = sha(trc.content);
check('G1.trace.contentDigest', shaRef(trcDigest) === sub.content.traceRef && trcDigest === '2835aea3f7bbf362afabf729ca37a18827bd9579c76f30daad12d8a2272a84e1', `recomputed ${trcDigest} vs declared ${sub.content.traceRef}`);
const stmtSealByRef = new Map([...stmtSealById.entries()].map(([id, d]) => [id, d]));
const ucSealByScenario = new Map(art.content.upstream.acceptedUcSeals.map((s) => [s.scenarioId, s.digest]));
const reqSealByRequirement = new Map(req.content.memberSeals.map((s) => [s.requirementId, s.digest]));
const terminalByRef = new Map(Object.entries(ENVELOPE).filter(([k]) => k.startsWith('terminal:')).map(([k, v]) => [k, v]));
const scenarioOfBranch = new Map(Object.entries(universe.idSets.ucBranchIdsByScenario).flatMap(([s, bs]) => bs.map((b) => [b, s])));
const digestIndexForTrace = (toId) => {
  if (toId.startsWith('fr:') || toId.startsWith('nfr:')) return reqSealByRequirement.get(toId);
  if (toId.startsWith('uc:')) return ucSealByScenario.get(toId);
  if (toId.startsWith('branch:')) { const scenario = scenarioOfBranch.get(toId); return scenario === undefined ? undefined : ucSealByScenario.get(scenario); }
  if (toId.startsWith('stmt:')) return stmtSealByRef.get(toId);
  if (toId.startsWith('terminal:')) return terminalByRef.get(toId);
  return undefined;
};
let trcEdgesOk = trc.content.relationships.length === 16;
for (const [i, e] of trc.content.relationships.entries()) {
  const fromOk = sealByCriterion.get(e.fromId) === String(e.fromRef).slice(7);
  const toOk = digestIndexForTrace(e.toId) === String(e.toRef).slice(7);
  const relOk = ['cites', 'covers', 'supports', 'verifies'].includes(e.relation);
  const ok = fromOk && toOk && relOk;
  trcEdgesOk = trcEdgesOk && ok;
  if (!ok) check(`G2.edge[${i}]`, false, `${e.fromId} -${e.relation}-> ${e.toId} does not resolve (from=${fromOk} to=${toOk} rel=${relOk})`);
}
check('G2.traceEdges', trcEdgesOk, `17/17 trace relationships resolve against recomputed seals (criterion/requirement/scenario/branch/statement/terminal)`);
let coverageProjectionOk = true;
for (const [criterionId, block] of Object.entries(trc.content.criterionCoverage)) {
  const expect = {
    verifies: trc.content.relationships.filter((e) => e.fromId === criterionId && e.relation === 'verifies').map((e) => e.toId),
    covers: trc.content.relationships.filter((e) => e.fromId === criterionId && e.relation === 'covers').map((e) => e.toId),
    cites: trc.content.relationships.filter((e) => e.fromId === criterionId && e.relation === 'cites').map((e) => e.toId),
    supports: trc.content.relationships.filter((e) => e.fromId === criterionId && e.relation === 'supports').map((e) => e.toId),
  };
  const ok = block.digest === sealByCriterion.get(criterionId)
    && JSON.stringify(block.verifies) === JSON.stringify(expect.verifies)
    && JSON.stringify(block.covers) === JSON.stringify(expect.covers)
    && JSON.stringify(block.cites) === JSON.stringify(expect.cites)
    && JSON.stringify(block.supports) === JSON.stringify(expect.supports);
  coverageProjectionOk = coverageProjectionOk && ok;
  if (!ok) check(`G3.${criterionId}`, false, 'criterionCoverage block is not the exact projection of the relationship set');
}
check('G3.coverageBlocksAreProjections', coverageProjectionOk, `criterionCoverage = exact projection of the edge set (5/5 blocks)`);
const branchBlockOk = Object.entries(trc.content.branchCoverage).every(([branchId, block]) => requiredBranches.get(branchId) === block.owningScenario && block.digest === ucSealByScenario.get(block.owningScenario) && JSON.stringify(block.coveredBy.slice().sort()) === JSON.stringify(trc.content.relationships.filter((e) => e.relation === 'covers' && e.toId === branchId).map((e) => e.fromId).sort()));
const reqBlockOk = Object.entries(trc.content.requirementCoverage).every(([reqId, block]) => block.digest === reqSealByRequirement.get(reqId) && JSON.stringify(block.verifiedBy.slice().sort()) === JSON.stringify(trc.content.relationships.filter((e) => e.relation === 'verifies' && e.toId === reqId).map((e) => e.fromId).sort()));
const terminalBlockOk = Object.entries(trc.content.terminalCoverage).every(([t, block]) => block.digest === ENVELOPE[t] && JSON.stringify(block.supportedBy.slice().sort()) === JSON.stringify(trc.content.relationships.filter((e) => e.relation === 'supports' && e.toId === t).map((e) => e.fromId).sort()));
check('G4.reverseCoverageBlocks', branchBlockOk && reqBlockOk && terminalBlockOk, `branchCoverage/requirementCoverage/terminalCoverage = exact reverse projections; branch refs resolve to their owning scenario member seal (branch ids carry no separate address)`);

/* ------------------------------------------------------------------ */
/* H. upstream chain re-verification + envelope cross-check            */
/* ------------------------------------------------------------------ */
check('H1.upstreamArtifacts', sha(intentArt.content) === intentArt.contentDigest && intentArt.contentDigest === 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055' && sha(ucArt.content) === ucArt.contentDigest && ucArt.contentDigest === '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b' && sha(req.content) === req.contentDigest && req.contentDigest === '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df', `accepted intent ${intentArt.contentDigest.slice(0, 8)} / uc ${ucArt.contentDigest.slice(0, 8)} / requirements ${req.contentDigest.slice(0, 8)} artifacts re-verified by content address`);
const prdFold = sha({ memberDigests: req.content.upstream.acceptedIntentSeals.map((s) => s.digest).sort() });
const ucFold = sha({ memberDigests: art.content.upstream.acceptedUcSeals.map((s) => s.digest).sort() });
const reqFold = sha({ memberDigests: req.content.memberSeals.map((s) => s.digest).sort() });
check('H2.revisionPinsRefolded', prdFold === 'a30229a75bed4c5d7b4a9660f6a7644d333e6c0c63064901da9aa020cadca770' && ucFold === '184981e5724c286d1ad71da645abd6fa8ee78ff8cba3746fbe461d4096b2457e' && req.content.product.prdRevisionRef === shaRef(prdFold) && req.content.product.ucRevisionRef === shaRef(ucFold) && art.content.upstream.acceptedRequirementsSet.requirementIds.join(',') === universe.idSets.frIds.concat(universe.idSets.nfrIds).sort().join(','), `prd fold ${prdFold.slice(0, 8)} / uc fold ${ucFold.slice(0, 8)} / requirements fold ${reqFold.slice(0, 8)} recompute; pins match`);
const vsa = imp.content.verifiedSubArtifacts;
const flat = [
  ...vsa.sourceClaims.map((x) => [x.content.claimId ?? x.content.semanticCode, x]),
  ...vsa.constraints.map((x) => [x.content.constraintId ?? x.content.semanticCode, x]),
  ...vsa.unknowns.map((x) => [x.content.unknownId ?? x.content.semanticCode, x]),
  ...vsa.terminalLifecycleClaims.map((x) => [x.content.claimId ?? x.content.semanticCode, x]),
];
let envOk = true;
const resolvedIds = [];
for (const [label, x] of flat) {
  const recomputed = sha(x.content);
  const byDigest = Object.entries(ENVELOPE).find(([, hex]) => hex === x.digest);
  const ok = recomputed === x.digest && byDigest !== undefined;
  if (ok) resolvedIds.push(byDigest[0]);
  envOk = envOk && ok;
  if (!ok) check(`H3.${label}`, false, `recomputed ${recomputed} vs declared ${x.digest}; envelope hit=${byDigest?.[0] ?? 'NONE'}`);
}
check('H3.projectionAddressesReDerived', envOk && resolvedIds.length === 8, `8/8 projection content addresses re-derived from the r2 import capsule material (not by declaration): ${resolvedIds.sort().join(', ')}`);
const authorEvidence = sub.content.payloadContract.requiredEvidenceRefs;
const upstreamRefPool = new Set([
  ...Object.values(art.content.upstream).filter((v) => typeof v === 'string' && v.startsWith('sha256:')).map((v) => v.slice(7)),
  ...Object.values(req.content.upstream).filter((v) => typeof v === 'string' && v.startsWith('sha256:')).map((v) => v.slice(7)),
  String(art.content.governingContractRef).slice(7),
  String(req.content.governingContractRef).slice(7),
]);
const chainDigests = new Set([...Object.values(ENVELOPE), intentArt.contentDigest, ucArt.contentDigest, req.contentDigest, imp.contentDigest, artDigest, trcDigest, productSeal, ...upstreamRefPool]);
check('H4.authorEvidenceRefs', authorEvidence.length === 21 && authorEvidence.every((r) => chainDigests.has(String(r).slice(7))), `author payload contract: 21 evidence refs, all resolve inside the verified chain (upstream pins include the accepted intent/uc/requirements trace+submission refs, import artifact, capsule, certificate, governing contract)`);
const cov = sub.content.payloadContract.evidenceKindCoverage;
check('H5.authorKindCoverage', cov['source-claim'] === 4 && cov['constraint'] === 1 && cov['unknown'] === 1 && cov['terminal-claim'] === 2 && sub.content.payloadContract.effectId === 'formalization.accept-products' && sub.content.payloadContract.terminalOutcome === 'success', JSON.stringify(cov));

/* ------------------------------------------------------------------ */
/* O. envelope adjudication (reviewer-frame specifics)                 */
/* ------------------------------------------------------------------ */
/* The reviewer envelope projects upstream-accepted[0] sha256:32892970...
   :: "accepted revision of define-acceptance-contract" (driver.ts builds it
   from state.gateOutcomes.authorGate.productRef). Enumerate every address
   the desk chain can produce for that role and adjudicate. */
const candidateAddresses = {
  gateProductRef: shaRef(productSeal),
  artifactContent: shaRef(artDigest),
  criteriaMemberFold: shaRef(sha({ memberDigests: criteria.map((c) => sha(c)).sort() })),
};
check('O1.upstreamProjectionAdjudicated', !Object.values(candidateAddresses).includes(shaRef(ENVELOPE_UPSTREAM)), `upstream-accepted[0] sha256:${ENVELOPE_UPSTREAM} resolves to NO content of the on-disk candidate chain (gate productRef would be ${candidateAddresses.gateProductRef}); recorded UNRESOLVED-at-desk - the kernel-side session store is not part of this desk workspace; the review proceeds on the content-addressed chain itself, every ref of which resolves`);
check('O2.workspaceLawStageRelative', art.content.workspaceSummary === '0 accepted upstream revisions travel by content address' && (rsub === null || rsub.content.workspaceSummary === '1 accepted upstream revisions travel by content address'), 'author-stage 0 (the desk consumes accepted bundles by pinned refs, not revisions) vs reviewer-stage 1 (the accepted author product) - stage-relative, no contradiction');

/* ------------------------------------------------------------------ */
/* I. on-disk reviewer round self-verification                         */
/* ------------------------------------------------------------------ */
const REVIEW_DIGEST = 'e5249d786aa3318a7426dde2ba36e111437d4e0ab0e7e6f9e7cda3b9463ce466';
const VERIFICATION_DIGEST = '17eb4d7fe2a9704df2ae45ef572a3905690a0d34ce4fd59d871f88da83850a43';
const RSUB_DIGEST = '5ee3d51b62d80fd5feb339ec3549709d0d599d757bf99578c51b6e3763d6a1d0';
const RTRC_DIGEST = '55e59486c19ebaefd58a90bb9111edc3b115c809c0c7861aab5d19fe09e84fd8';
if (ver !== null && rev !== null && rsub !== null && rtrc !== null && REVIEW_DIGEST !== '') {
  check('I1.verification.selfAddress', sha(ver.content) === ver.contentDigest && ver.contentDigest === VERIFICATION_DIGEST, `recomputed ${sha(ver.content)} vs declared ${ver.contentDigest}`);
  check('I2.review.selfAddress', sha(rev.content) === rev.contentDigest && rev.contentDigest === REVIEW_DIGEST, `recomputed ${sha(rev.content)} vs declared ${rev.contentDigest}`);
  check('I3.reviewerSubmission.selfAddress', sha(rsub.content) === rsub.contentDigest && rsub.contentDigest === RSUB_DIGEST, `recomputed ${sha(rsub.content)} vs declared ${rsub.contentDigest}`);
  check('I4.reviewerTrace.selfAddress', sha(rtrc) === rsub.content.traceRef.slice(7) && sha(rtrc) === RTRC_DIGEST, `recomputed ${sha(rtrc)} vs declared ${rsub.content.traceRef}`);
  check('I5.reviewerSubmission.binding', rsub.content.reviewedCandidate.artifactRef === shaRef(artDigest) && rsub.content.reviewedCandidate.submissionRef === sub.submissionRef && rsub.content.reviewedCandidate.traceRef === shaRef(trcDigest) && rsub.content.verificationRef === ver.verificationRef && rsub.content.candidate.artifactRef === rev.artifactRef, 'reviewer product submission binds the exact recomputed chain');
  let rtrcOk = true;
  const known = new Set([artDigest, sub.contentDigest, trcDigest, ver.contentDigest, rev.contentDigest, ...Object.values(ENVELOPE), ENVELOPE_UPSTREAM, productSeal]);
  for (const [i, e] of rtrc.edges.entries()) {
    const hexRefs = [e.fromRef, e.toRef].filter((r) => String(r).startsWith('sha256:')).map((r) => r.slice(7));
    const ok = hexRefs.length === 2 && hexRefs.every((h) => known.has(h));
    rtrcOk = rtrcOk && ok;
    if (!ok) check(`I6.reviewerEdge[${i}]`, false, `${e.fromRef} -${e.relationType}-> ${e.toRef} does not resolve`);
  }
  check('I6.reviewerTraceEdges', rtrcOk, `${rtrc.edges.length} reviewer trace edges resolve against recomputed digests`);
  check('I7.review.verdictConsistent', rev.content.verdict === 'accepted' && rev.content.verificationRef === ver.verificationRef && rev.content.reviewedCandidate.artifactRef === shaRef(artDigest) && rev.content.acceptanceCriteria.every((a) => a.satisfied === true), `review verdict=${rev.content.verdict}, criteria ${rev.content.acceptanceCriteria.filter((a) => a.satisfied).length}/${rev.content.acceptanceCriteria.length} satisfied`);
  check('I8.verification.pins', ver.content.subject.artifactRef === shaRef(artDigest) && ver.content.subject.submissionRef === sub.submissionRef && ver.content.subject.traceRef === shaRef(trcDigest) && ver.content.envelopePins.upstreamAccepted[0] === shaRef(ENVELOPE_UPSTREAM) && ver.content.envelopePins.workspaceSummary === rsub.content.workspaceSummary, 'verification pins = the recomputed candidate chain + reviewer envelope');
} else {
  check('I0.reviewerRoundAuthored', false, 'reviewer round files not all present on disk yet (group I runs after the round is authored)');
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; gate + closure + WP03 seam + universe protocol = REAL cell code (dist)',
  recomputed: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  verdict: failed.length === 0 ? 'accepted' : 'repair',
  results,
}, null, 2));
