/**
 * gates.test.mjs - the CheckPlans and semantic gates (FRF-WP11 cutover
 * shape): declared deterministic providers over the installed FRF cells,
 * the refusal-reason -> verdict routing, and the fail-closed
 * undeclared-provider refusal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthoredChain, SOURCE_CLAIM_IDS, CONSTRAINT_IDS, TERMINAL_CLAIM_IDS } from './support.mjs';

const gates = () => import('../../../../dist/workflow-kernel/workshops/formalization/gates.js');
const manifest = () => import('../../../../dist/workflow-kernel/workshops/formalization/manifest.js');
const dispatch = () => import('../../../../dist/workflow-kernel/workshops/formalization/cells/dispatch.mjs');

async function chainFixture() {
  const chain = await buildAuthoredChain();
  const d = await dispatch();
  const accepted = d.acceptedChainOfHandoff({
    digest: 'd'.repeat(64),
    sourceClaimIds: SOURCE_CLAIM_IDS,
    constraintIds: CONSTRAINT_IDS,
    terminalClaimIds: TERMINAL_CLAIM_IDS,
  });
  return { chain, accepted };
}

test('every desk gate accepts the authored chain over its declared provider', async () => {
  const g = await gates();
  const m = await manifest();
  const d = await dispatch();
  const { chain } = await chainFixture();
  const seeded = await chainFixture();
  let accepted = seeded.accepted;
  // Drive the desks in flow order, folding each accepted set so every desk
  // validates against the exact chain state at its entry.
  for (const nodeId of m.deskNodeIds()) {
    const provider = m.checkProviderOfDesk(nodeId);
    assert.equal(provider.ok, true, `${nodeId} provider`);
    const outcome = g.evaluateProductGate(provider.provider, chain.authored[nodeId].candidate, accepted);
    assert.equal(outcome.verdict, 'accepted', `${nodeId}: ${JSON.stringify(outcome)}`);
    if (nodeId !== 'reconcile-what') {
      assert.match(outcome.productRef, /^sha256:[0-9a-f]{64}$/);
    }
    accepted = d.foldDeskAcceptance(accepted, nodeId, outcome.fold);
  }
});

test('the freeze gate freezes the exact accepted surfaces (a drifted surface set routes human-wait)', async () => {
  const g = await gates();
  const m = await manifest();
  const d = await dispatch();
  const { chain, accepted } = await chainFixture();
  let state = accepted;
  for (const desk of ['define-product-intent', 'model-use-cases', 'derive-system-requirements', 'define-acceptance-contract']) {
    const provider = m.checkProviderOfDesk(desk);
    const prior = g.evaluateProductGate(provider.provider, chain.authored[desk].candidate, state);
    state = d.foldDeskAcceptance(state, desk, prior.fold);
  }
  const provider = m.checkProviderOfDesk('freeze-what-baseline');
  const green = g.evaluateProductGate(provider.provider, chain.authored['freeze-what-baseline'].candidate, state);
  assert.equal(green.verdict, 'accepted');
  // A substituted member digest routes to the human-wait verdict (operator clarification; D12 drift).
  const drifted = structuredClone(chain.authored['freeze-what-baseline'].candidate);
  const members = drifted.surfaces.containers.uc.members;
  members[0] = { ...members[0], digest: members[members.length - 1].digest };
  const driftOutcome = g.evaluateProductGate(provider.provider, drifted, state);
  assert.equal(driftOutcome.verdict, 'human-wait');
  assert.equal(driftOutcome.issues[0].source, 'DRIFT_DETECTED');
});

test('malformed and stale products route to repair (the author desk is re-staffed)', async () => {
  const g = await gates();
  const m = await manifest();
  const d = await dispatch();
  const { chain, accepted } = await chainFixture();
  // Fold the PRD and UC accepted sets (the requirements desk's exact upstream).
  let afterPrd = accepted;
  for (const desk of ['define-product-intent', 'model-use-cases']) {
    const provider = m.checkProviderOfDesk(desk);
    const prior = g.evaluateProductGate(provider.provider, chain.authored[desk].candidate, afterPrd);
    assert.equal(prior.verdict, 'accepted', `${desk} prerequisite`);
    afterPrd = d.foldDeskAcceptance(afterPrd, desk, prior.fold);
  }

  const ucProvider = m.checkProviderOfDesk('model-use-cases');
  const actorless = structuredClone(chain.authored['model-use-cases'].candidate);
  actorless.product.scenarios[0].actorKind = 'robot';
  const malformed = g.evaluateProductGate(ucProvider.provider, actorless, afterPrd);
  assert.equal(malformed.verdict, 'repair');
  assert.equal(malformed.issues[0].source, 'MALFORMED_PRODUCT');

  const reqProvider = m.checkProviderOfDesk('derive-system-requirements');
  const stale = structuredClone(chain.authored['derive-system-requirements'].candidate);
  stale.product[0].prdIntentRefs = [];
  const staleOutcome = g.evaluateProductGate(reqProvider.provider, stale, afterPrd);
  assert.equal(staleOutcome.verdict, 'repair');
  assert.equal(staleOutcome.issues[0].source, 'MISSING_LINEAGE');

  const pruned = structuredClone(chain.authored['derive-system-requirements'].candidate);
  pruned.product = pruned.product.filter((r) => r.requirementId !== 'fr:batch-1');
  const coverageOutcome = g.evaluateProductGate(reqProvider.provider, pruned, afterPrd);
  assert.equal(coverageOutcome.verdict, 'repair');
  assert.match(`${coverageOutcome.issues[0].source}: ${coverageOutcome.issues[0].detail}`, /COVERAGE_GAP|MISSING_LINEAGE/);
});

test('FOREIGN lineage routes to upstream-repair (never a silent scope widen)', async () => {
  const g = await gates();
  const m = await manifest();
  const d = await dispatch();
  const { chain, accepted } = await chainFixture();
  const prdProvider = m.checkProviderOfDesk('define-product-intent');
  const prdFold = g.evaluateProductGate(prdProvider.provider, chain.authored['define-product-intent'].candidate, accepted);
  const afterPrd = d.foldDeskAcceptance(accepted, 'define-product-intent', prdFold.fold);
  const provider = m.checkProviderOfDesk('model-use-cases');
  const foreign = structuredClone(chain.authored['model-use-cases'].candidate);
  foreign.product.scenarios[0].prdIntentRefs = ['prd:FOREIGN'];
  const outcome = g.evaluateProductGate(provider.provider, foreign, afterPrd);
  assert.equal(outcome.verdict, 'upstream-repair');
  assert.equal(outcome.issues[0].source, 'FOREIGN_LINEAGE');
});

test('an undeclared provider is a typed fail-closed refusal (never a fallback)', async () => {
  const g = await gates();
  const m = await manifest();
  const { chain, accepted } = await chainFixture();
  const installed = m.installedWorkshopManifest();
  const impostor = { ...installed.checkProviders[1], providerId: 'frf-cell.not-installed.v1', productKind: 'frf-cell.uc-scenarios.v1' };
  const outcome = g.evaluateProductGate(impostor, chain.authored['model-use-cases'].candidate, accepted);
  assert.equal(outcome.refused, true);
  assert.equal(outcome.reason, 'PROVIDER_NOT_DECLARED');
  // A kind mismatch against the provider declaration is also refused.
  const mismatched = g.evaluateProductGate(installed.checkProviders[1], chain.authored['define-product-intent'].candidate, accepted);
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
