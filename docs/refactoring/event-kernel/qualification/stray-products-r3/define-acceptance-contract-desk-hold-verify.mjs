/**
 * define-acceptance-contract desk (author) - upstream hold verification.
 *
 * Recomputes the emitted hold artifact + trace digests, re-derives the
 * envelope projection from the accepted capsule, re-checks every cited
 * record digest and verdict pin, re-verifies the two unresolvable
 * instances, runs the fence + determinism laws, and re-pins the
 * candidate-of-record addresses. Nothing is trusted by declaration.
 *
 * Run: node define-acceptance-contract-desk-hold-verify.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v));
const sha = (v) => createHash('sha256').update(canon(v), 'utf8').digest('hex');
const shaRef = (d) => `sha256:${d}`;

const DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(DIR, '..', '..', '..', '..', '..');

const results = [];
const check = (id, ok, detail) => { results.push({ id, ok, detail }); return ok; };

const hold = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-upstream-hold.artifact.json'), 'utf8'));
const trc = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-upstream-hold-trace.json'), 'utf8'));

/* A. self-address + pins */
check('A1.hold.contentDigest', sha(hold.content) === hold.contentDigest, `recomputed ${sha(hold.content)}`);
check('A2.hold.artifactRef', hold.artifactRef === shaRef(hold.contentDigest), hold.artifactRef);
check('A3.hold.pins', hold.semanticCode === 'UH-Define-Acceptance-Contract-001'
  && hold.artifactKind === 'upstream-hold'
  && hold.content.holdKind === 'acceptance-upstream-hold'
  && hold.content.decision === 'hold-no-authoring'
  && hold.content.noProductAuthored === true
  && hold.deskRef === 'define-acceptance-contract' && hold.role === 'author', 'hold kind + no-authoring pins');
check('A4.hold.pinnedTimestamp', hold.createdAt === '2026-08-28T00:00:00Z' && trc.createdAt === '2026-08-28T00:00:00Z', hold.createdAt);

/* B. envelope projection re-derived from the accepted capsule */
const importArt = JSON.parse(readFileSync(join(DIR, '..', 'stray-products-r2', 'import-discovery-handoff-desk-discovery-import.artifact.json'), 'utf8'));
check('B1.import.digest', sha(importArt.content) === importArt.contentDigest, importArt.contentDigest.slice(0, 16) + '…');
const vsa = importArt.content.verifiedSubArtifacts;
const groups = [vsa.sourceClaims, vsa.constraints, vsa.unknowns, vsa.terminalLifecycleClaims, [vsa.certificate]];
const recomputed = new Map();
let subOk = true;
for (const arr of groups) for (const s of arr) { const d = sha(s.content); if (d !== s.digest) subOk = false; recomputed.set(d, s.semanticCode); }
check('B2.capsule.subArtifacts', subOk && recomputed.size === 9, '9/9 sub-artifact digests recompute');
const envOk = hold.content.taskProjection.verifiedSubArtifacts.every((v) => recomputed.has(v.digest));
check('B3.envelope.projection', envOk && hold.content.taskProjection.verifiedSubArtifacts.length === 8, '8/8 envelope entries resolve to recomputed capsule sub-artifacts');

/* C. cited records re-pinned */
const record = (relPath) => {
  const j = JSON.parse(readFileSync(join(REPO_ROOT, relPath), 'utf8'));
  return { digest: sha(j.content), verdict: j.content.verdict ?? j.content.decision ?? j.content.holdKind ?? null, reviewedCandidate: j.content.reviewedCandidate ?? null };
};
const citations = [
  ['FR-Define-Product-Intent-001', 'docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-review.json', 'e49d8d11aadae74a79d0d5d37c67d2e5ecb630139c71f9416a5d6b180d058ac4', 'repair'],
  ['FR-Define-Product-Intent-001-b', 'docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer-review-emission-b.json', '6c9c8324d2cb32ac05f9e5dbc97c8b97f9b5fb7e6bea723bbb08df0f362fd7dc', 'repair'],
  ['FR-Define-Product-Intent-002', 'docs/refactoring/event-kernel/qualification/stray-products-r2/define-product-intent-desk-reviewer2-review.json', '0463209429b6cf9b3460d7a32c0ed3c20a234b60fa8774f596ec7833aa3611fc', 'repair'],
  ['UH-Model-Use-Cases-001', 'docs/refactoring/event-kernel/qualification/stray-products-r2/model-use-cases-desk-upstream-hold.artifact.json', '6cccd16245eafd18b27dcc075eaa34306370786ae2429aac00b16da75d9d1ae7', 'hold-no-authoring'],
  ['FR-Model-Use-Cases-001', '.factory-testbed/model-use-cases-reviewer-review.json', '8aeee3511c5c31509fb956fef5c1d132544ea7d14fa83d9c76d54776eaf35bb7', 'accepted'],
  ['FR-Derive-System-Requirements-001', 'docs/refactoring/event-kernel/qualification/stray-products-r2/derive-system-requirements-desk-reviewer-review.json', 'd31b044c9530773ac05a25bd9b4cb503164bcf31b4694547011aba43c19816d0', 'repair'],
  ['RS-Derive-System-Requirements-001', 'docs/refactoring/event-kernel/qualification/stray-products-r2/derive-system-requirements-desk-reviewer-restaff2-confirmation.json', '1c30d28e8222eaa225195bf33d87f378054b98a01bdf50710fd4900f5339a0a6', null],
  ['UH-Derive-System-Requirements-001', '.factory-testbed/derive-system-requirements-reviewer-hold.artifact.json', 'fbc0394bd8f79df2fc7e8956accd9fe25485bceab182044927de9f209f11d053', 'hold-no-review'],
  ['UH-Derive-System-Requirements-002', '.factory-testbed/derive-system-requirements-reviewer-hold2.artifact.json', 'b4eaaabaa5010c6e03594943e2437b030d352ec9f3027fb275d57f351692c995', 'hold-no-review'],
  ['FR-Define-Acceptance-Contract-001-a', 'docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-review-emission-a.json', '83e675bb18c575cb0b30e3ededd2cca6b58b88c08cb50be9c08dfb130808c383', 'repair'],
  ['VV-Define-Acceptance-Contract-001-a', 'docs/refactoring/event-kernel/qualification/stray-products-r3/define-acceptance-contract-desk-reviewer-verification-emission-a.json', '367a38fcf8d0bd061fa2e023aba4aaab0060a82a71278ca358d6b3415b5602bb', null],
];
for (const [name, relPath, digest, verdict] of citations) {
  const r = record(relPath);
  check(`C1.record.${name}`, r.digest === digest && (verdict === null || r.verdict === verdict), `${r.digest.slice(0, 16)}… verdict=${r.verdict ?? 'n/a'}`);
}
const frUc = record('.factory-testbed/model-use-cases-reviewer-review.json');
check('C2.ucVerdict.differentCandidate', frUc.reviewedCandidate?.artifactRef === 'sha256:c6120e86dfbba73fba5153fbb64a6a5d528d489df6411b29e0a928c97bc264c8'
  && frUc.reviewedCandidate?.artifactRef !== 'sha256:24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b', 'the only UC accepted verdict pins c6120e86…, not the consumed 24f0aff2…');

/* D. unresolvable instances stay unresolvable */
const files = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.json')) files.push(p); } };
walk(join(REPO_ROOT, 'docs', 'refactoring', 'event-kernel', 'qualification'));
walk(join(REPO_ROOT, '.factory-testbed'));
const index = new Map();
for (const f of files) { try { const j = JSON.parse(readFileSync(f, 'utf8')); if (j && typeof j === 'object' && j.content !== undefined) index.set(sha(j.content), f); } catch {} }
for (const u of hold.content.upstreamObservations.unresolvableInstances) {
  const d = u.address.replace(/^sha256:/, '');
  check(`D1.unresolvable.${d.slice(0, 8)}`, !index.has(d), `${u.id}: no content in the workspace hashes to this address`);
}

/* E. fence + status-layer honesty */
const holdText = JSON.stringify(hold.content);
check('E1.fence.noProductMaterial', !['criteria', 'verifiableStatements'].some((k) => k in hold.content)
  && !holdText.includes('ac:boundary-1') && !holdText.includes('stmt:'), 'no acceptance-bundle material authored');
check('E2.fence.scope2NotRestated', !('scopeDispositions' in hold.content) && !('constraintDispositions' in hold.content)
  && !holdText.includes('derives no criterion') && !holdText.includes('is out of scope'), 'prd:scope-2 disposition referenced only as a defect under adjudication, never ratified as fact');
check('E3.status.noAcceptedStateAsserted', hold.content.verification.noAcceptedStateAsserted === true
  && hold.content.verification.acceptedStateClaimsGatedOnVerdictRecords === true
  && hold.content.verification.productMaterialAuthored === false, 'status-layer flags assert digest-layer facts only');

/* F. trace */
check('F1.trace.contentDigest', sha(trc.content) === trc.contentDigest, `recomputed ${sha(trc.content)}`);
check('F2.trace.subjectBinding', trc.content.subjectArtifactRef === hold.artifactRef && trc.content.subjectSemanticCode === hold.semanticCode, trc.content.subjectArtifactRef);
const envelopeIds = new Map(hold.content.taskProjection.verifiedSubArtifacts.map((v) => [v.id, v.digest]));
const resolveId = (id) => {
  if (envelopeIds.has(id)) return envelopeIds.get(id);
  if (id === 'UH-Define-Acceptance-Contract-001') return hold.contentDigest;
  if (id === 'SR-Define-Acceptance-Contract-001') return '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0';
  if (id === 'FS-Define-Acceptance-Contract-001') return '6e19d3cb452d020eb4dc80eb40e9bacd98da74aa61008c38c6f894d8364704fe';
  if (id === 'import:discovery-handoff') return importArt.contentDigest;
  if (id === 'cert:discovery-capsule') return '03972527d7062f851af75688f054537ceac6ecf2ddd5e3af8bde34ecd627cb21';
  if (id === 'link:define-product-intent') return 'a06dbc57ba63eb8541c6478e3aba1012af52c8084de0e2fb7719256ffde1e055';
  if (id === 'link:model-use-cases') return '24f0aff29b3fc3a3e021c79c771e798cd46cc490ff0bda02d7e25133fbbf8a4b';
  if (id === 'link:derive-system-requirements') return '86b00569cf719318f2d366e6708c01f8abbeecf9b5795132e41da48c14fc97df';
  return undefined;
};
for (const r of trc.content.relationships) {
  const from = resolveId(r.fromId);
  const to = resolveId(r.toId);
  check(`F3.edge.${r.relation}.${r.toId}`, from !== undefined && to !== undefined && r.fromRef === shaRef(from) && r.toRef === shaRef(to), 'both ends resolve to recomputed digests');
}
check('F4.trace.vocabularyClosed', JSON.stringify([...trc.content.relationVocabulary].sort()) === JSON.stringify(['observes', 'verifies'])
  && trc.content.relationships.every((r) => trc.content.relationVocabulary.includes(r.relation)), trc.content.relationVocabulary.join(', '));
check('F5.holdCoverage', JSON.stringify(trc.content.holdCoverage.unacceptedLinks) === JSON.stringify(['link:define-product-intent', 'link:model-use-cases', 'link:derive-system-requirements'])
  && trc.content.holdCoverage.noProductAuthored === true, 'exact projection of the hold');

/* G. determinism law over the emitted bytes' producers */
const noClockOrRandom = (name) => !/Date\.now|new Date\(|Math\.random|process\.hrtime|performance\.now/.test(readFileSync(join(DIR, name), 'utf8'));
check('G1.determinism.noClockOrRandom', noClockOrRandom('define-acceptance-contract-desk-hold-build.mjs') && noClockOrRandom('define-acceptance-contract-desk-hold-verify.mjs'), 'builder + verifier read no clock and no randomness');

/* H. candidate of record unchanged */
const candArt = JSON.parse(readFileSync(join(DIR, 'define-acceptance-contract-desk-acceptance-bindings.artifact.json'), 'utf8'));
check('H1.candidateOfRecord.unchanged', sha(candArt.content) === candArt.contentDigest
  && candArt.contentDigest === '2b01353dadc2e2b682b353afc54a5fbf4c9abf6f0f6f0fb8a5eada8029b733f0', 'byte-unchanged since 03:00:50 pin');

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
const out = {
  rule: 'sha256(canonicalJson) per src/workflow-kernel/domain/digest.ts; envelope re-derived from the accepted capsule; every cited record digest recomputed; unresolvable instances re-proved',
  subject: hold.artifactRef,
  recomputed: results.length,
  passed,
  failed,
  results,
};
writeFileSync(join(DIR, 'define-acceptance-contract-desk-hold-verify-out.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ recomputed: results.length, passed, failed }, null, 2));
if (failed > 0) {
  for (const r of results.filter((x) => !x.ok)) console.error(`FAIL ${r.id}: ${r.detail}`);
  process.exitCode = 1;
}
