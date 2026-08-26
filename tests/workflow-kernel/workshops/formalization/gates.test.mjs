/**
 * gates.test.mjs - the CheckPlans and semantic gates (WP-11F): declared
 * deterministic providers, the refusal-reason -> verdict routing table,
 * and the fail-closed undeclared-provider refusal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthoredChain, buildHandoffCapsule } from './support.mjs';

const gates = () => import('../../../../dist/workflow-kernel/workshops/formalization/gates.js');
const manifest = () => import('../../../../dist/workflow-kernel/workshops/formalization/manifest.js');

async function chainFixture() {
  const capsule = await buildHandoffCapsule();
  const chain = await buildAuthoredChain(capsule.capsuleDigest, capsule.capsuleRef);
  return { chain, capsule };
}

test('every desk gate accepts the authored chain over its declared provider', async () => {
  const g = await gates();
  const m = await manifest();
  const { chain } = await chainFixture();
  const cases = [
    ['define-product-intent', { kind: 'formalization.prd-intent.v1', product: chain.prd.product }, chain.accepted0],
    ['model-use-cases', { kind: 'formalization.uc-scenarios.v1', product: chain.uc.product }, chain.acceptedAt.prd],
    ['derive-system-requirements', { kind: 'formalization.system-requirements.v1', product: chain.requirements.product }, chain.acceptedAt.uc],
    ['define-acceptance-contract', { kind: 'formalization.acceptance-bindings.v1', product: chain.acceptance.product }, chain.acceptedAt.requirements],
    ['reconcile-what', { kind: 'formalization.what-reconciliation.v1', product: chain.reconciliation.product }, chain.acceptedAt.acceptance],
    ['define-architecture-contract', { kind: 'formalization.srs.v1', product: chain.srs.product }, chain.acceptedAt.baseline],
    ['settle-formalization', { kind: 'formalization.solution-contract.v1', product: chain.solution.product }, chain.acceptedAt.srs],
  ];
  for (const [nodeId, candidate, accepted] of cases) {
    const provider = m.checkProviderOfDesk(nodeId);
    assert.equal(provider.ok, true);
    const outcome = g.evaluateProductGate(provider.provider, candidate, accepted);
    assert.equal(outcome.verdict, 'accepted', `${nodeId}: ${JSON.stringify(outcome)}`);
    assert.match(outcome.productRef, /^sha256:[0-9a-f]{64}$/);
  }
});

test('the freeze gate validates the baseline against the exact accepted inputs', async () => {
  const g = await gates();
  const m = await manifest();
  const { chain } = await chainFixture();
  const provider = m.checkProviderOfDesk('freeze-what-baseline');
  assert.equal(provider.ok, true);
  const outcome = g.evaluateProductGate(provider.provider, { kind: 'formalization.what-baseline.v1', product: chain.baseline.product, expected: chain.baseline.expected }, chain.acceptedAt.reconciliation);
  assert.equal(outcome.verdict, 'accepted');
  // A drifted baseline routes to the human-wait verdict (operator clarification).
  const drifted = { ...chain.baseline.product, memberDigests: [...chain.baseline.product.memberDigests, 'e'.repeat(64)] };
  const driftOutcome = g.evaluateProductGate(provider.provider, { kind: 'formalization.what-baseline.v1', product: drifted, expected: chain.baseline.expected }, chain.acceptedAt.reconciliation);
  assert.equal(driftOutcome.verdict, 'human-wait');
  assert.equal(driftOutcome.issues[0].source, 'DRIFT_DETECTED');
});

test('malformed and stale products route to repair (the author desk is re-staffed)', async () => {
  const g = await gates();
  const m = await manifest();
  const { chain } = await chainFixture();
  const provider = m.checkProviderOfDesk('model-use-cases');
  const actorless = { ...chain.uc.product, scenarios: chain.uc.product.scenarios.map((s) => ({ ...s, actorKind: 'robot' })) };
  const malformed = g.evaluateProductGate(provider.provider, { kind: 'formalization.uc-scenarios.v1', product: actorless }, chain.acceptedAt.prd);
  assert.equal(malformed.verdict, 'repair');
  assert.equal(malformed.issues[0].source, 'MALFORMED_PRODUCT');

  const reqProvider = m.checkProviderOfDesk('derive-system-requirements');
  const stale = { ...chain.requirements.product, prdRevisionRef: 'sha256:' + '0'.repeat(64) };
  const staleOutcome = g.evaluateProductGate(reqProvider.provider, { kind: 'formalization.system-requirements.v1', product: stale }, chain.acceptedAt.uc);
  assert.equal(staleOutcome.verdict, 'repair');
  assert.equal(staleOutcome.issues[0].source, 'STALE_LINEAGE');

  const coverageProvider = m.checkProviderOfDesk('derive-system-requirements');
  const pruned = { ...chain.requirements.product, requirements: chain.requirements.product.requirements.filter((r) => r.requirementId !== 'FR-3') };
  const coverageOutcome = g.evaluateProductGate(coverageProvider.provider, { kind: 'formalization.system-requirements.v1', product: pruned }, chain.acceptedAt.uc);
  assert.equal(coverageOutcome.verdict, 'repair');
  assert.equal(coverageOutcome.issues[0].source, 'COVERAGE_GAP');
});

test('FOREIGN lineage routes to upstream-repair (never a silent scope widen)', async () => {
  const g = await gates();
  const m = await manifest();
  const { chain } = await chainFixture();
  const provider = m.checkProviderOfDesk('derive-system-requirements');
  const foreign = { ...chain.requirements.product, requirements: chain.requirements.product.requirements.map((r) => r.requirementId === 'FR-1' ? { ...r, ucScenarioRefs: ['UC-FOREIGN'] } : r) };
  const outcome = g.evaluateProductGate(provider.provider, { kind: 'formalization.system-requirements.v1', product: foreign }, chain.acceptedAt.uc);
  assert.equal(outcome.verdict, 'upstream-repair');
  assert.equal(outcome.issues[0].source, 'FOREIGN_LINEAGE');
});

test('an undeclared provider is a typed fail-closed refusal (never a fallback)', async () => {
  const g = await gates();
  const m = await manifest();
  const { chain } = await chainFixture();
  const installed = m.installedWorkshopManifest();
  const impostor = { ...installed.checkProviders[1], providerId: 'formalization.not-installed.v1', productKind: 'formalization.uc-scenarios.v1' };
  const outcome = g.evaluateProductGate(impostor, { kind: 'formalization.uc-scenarios.v1', product: chain.uc.product }, chain.acceptedAt.prd);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'PROVIDER_NOT_DECLARED');
  // A kind mismatch against the provider declaration is also refused.
  const mismatched = g.evaluateProductGate(installed.checkProviders[1], { kind: 'formalization.prd-intent.v1', product: chain.prd.product }, chain.accepted0);
  assert.equal(mismatched.refused, true);
  assert.equal(mismatched.reason, 'PROVIDER_NOT_DECLARED');
});

test('the CheckPlan evidence fact is the exact gate-guard input (R15)', async () => {
  const g = await gates();
  const m = await manifest();
  const resolved = m.checkProviderOfDesk('define-product-intent');
  const fact = g.checkPlanEvidenceFor(resolved.provider);
  assert.equal(fact.kind, 'CheckPlan');
  assert.equal(fact.producer, 'external-input');
  assert.equal(fact.ref, `evidence:CheckPlan#${resolved.provider.providerId}`);
  assert.match(fact.payloadDigest, /^[0-9a-f]{64}$/);
  // A forged payload digest never equals the recomputed one.
  assert.notEqual('0'.repeat(64), fact.payloadDigest);
});

test('the external evidence set carries every declared provider plus the verifier verdict', async () => {
  const g = await gates();
  const m = await manifest();
  const installed = m.installedWorkshopManifest();
  const facts = g.formalizationExternalEvidence(installed.checkProviders, { ok: true, digest: 'd'.repeat(64) });
  assert.equal(facts.filter((fact) => fact.kind === 'CheckPlan').length, installed.checkProviders.length);
  assert.ok(facts.some((fact) => fact.kind === 'ProductVerificationEvidence'));
  const failing = g.formalizationExternalEvidence(installed.checkProviders, { ok: false, digest: 'd'.repeat(64) });
  assert.ok(failing.some((fact) => fact.kind === 'ProductVerificationFailure'));
});
