/**
 * checkplans.test.mjs - WP-11D deliverable 4: the CheckPlans + semantic
 * gates of the Discovery products - declared providers only, deterministic
 * evaluation, fail-closed on undeclared providers, and the declared
 * verdict mapping including the decision fork.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIdeaFixture, buildProductFixtures } from './support.mjs';

const checkplans = await import('../../../../dist/workflow-kernel/workshops/discovery/checkplans.js');
const manifestModule = await import('../../../../dist/workflow-kernel/workshops/discovery/installed-manifest.js');
const products = await import('../../../../dist/workflow-kernel/workshops/discovery/products.js');

const manifest = manifestModule.installedWorkshopManifest();

async function fixtures() {
  const { idea } = await buildIdeaFixture();
  const { brief, intent } = await buildProductFixtures(idea);
  return { idea, brief, intent };
}

test('the providers are DECLARED data pinned by the installed manifest', () => {
  assert.deepEqual(
    manifest.checkProviders.map((provider) => provider.providerId).sort(),
    ['brief-completeness.provider', 'idea-conservation.provider', 'intent-decision.provider', 'lineage.provider'],
  );
  for (const provider of manifest.checkProviders) {
    assert.match(provider.productContractRef, /^sha256:[0-9a-f]{64}$/, 'each provider pins a product contract address');
  }
});

test('fence: an undeclared provider is a typed fail-closed refusal', () => {
  const plan = { ...checkplans.AUTHOR_BRIEF_CHECK_PLAN, providers: ['undeclared.provider'] };
  const run = checkplans.runCheckPlan(plan, manifest.checkProviders, { brief: { ref: 'sha256:x', digest: 'x', schemaVersion: '', value: {} } });
  assert.equal(run.refused, true);
  assert.equal(run.reason, 'DECLARED_PROVIDER_REQUIRED');
  assert.match(run.detail, /fail-closed/);
});

test('fence: a plan with no products to check is refused (an empty check is never a pass)', () => {
  const run = checkplans.runCheckPlan(checkplans.AUTHOR_BRIEF_CHECK_PLAN, manifest.checkProviders, {});
  assert.equal(run.reason, 'PRODUCTS_MISSING');
});

test('deterministic evaluation: identical inputs yield identical results (twice, deep-equal)', async () => {
  const { idea, brief, intent } = await fixtures();
  const first = checkplans.runCheckPlan(checkplans.FINAL_INTENT_CHECK_PLAN, manifest.checkProviders, { idea, brief, intent });
  const second = checkplans.runCheckPlan(checkplans.FINAL_INTENT_CHECK_PLAN, manifest.checkProviders, { idea, brief, intent });
  assert.deepEqual(first, second);
  assert.equal(first.ok, true, JSON.stringify(first));
});

test('the author plan gates brief completeness + idea conservation', async () => {
  const { idea, brief } = await fixtures();
  const run = checkplans.runCheckPlan(checkplans.AUTHOR_BRIEF_CHECK_PLAN, manifest.checkProviders, { idea, brief });
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.deepEqual(run.results.map((result) => result.passed), [true, true]);
});

test('D10: a dropped idea unknown fails idea-conservation naming it', async () => {
  const { idea, brief } = await fixtures();
  const lossy = products.sealProduct({ ...brief.value, openQuestions: brief.value.openQuestions.slice(0, 1) });
  assert.notEqual(lossy.ref, brief.ref);
  const run = checkplans.runCheckPlan(checkplans.AUTHOR_BRIEF_CHECK_PLAN, manifest.checkProviders, { idea, brief: lossy });
  assert.equal(run.ok, true);
  const conservation = run.results.find((result) => result.providerId === 'idea-conservation.provider');
  assert.equal(conservation.passed, false);
  assert.match(conservation.detail, /retention window unknown/);
});

test('the verdict mapping: all pass -> accepted; a failed check -> repair; needs-human -> the decision fork', async () => {
  const { idea, brief, intent } = await fixtures();
  const passing = checkplans.runCheckPlan(checkplans.FINAL_INTENT_CHECK_PLAN, manifest.checkProviders, { idea, brief, intent });
  assert.equal(checkplans.gateVerdictOf(passing, { idea, brief, intent }), 'accepted');
  const lossy = products.sealProduct({ ...brief.value, openQuestions: [] });
  const failing = checkplans.runCheckPlan(checkplans.FINAL_INTENT_CHECK_PLAN, manifest.checkProviders, { idea, brief: lossy, intent });
  assert.equal(checkplans.gateVerdictOf(failing, { idea, brief: lossy, intent }), 'repair');
  const fork = products.sealProduct({ ...intent.value, decision: 'needs-human' });
  assert.equal(checkplans.gateVerdictOf(passing, { idea, brief, intent: fork }), 'human-wait', 'the decision fork routes to the typed human wait');
});

test('the lineage provider binds idea -> brief -> intent exactly', async () => {
  const { idea, brief, intent } = await fixtures();
  const run = checkplans.runCheckPlan(checkplans.FINAL_INTENT_CHECK_PLAN, manifest.checkProviders, { idea, brief, intent });
  const lineage = run.results.find((result) => result.providerId === 'lineage.provider');
  assert.equal(lineage.passed, true);
  // A brief pinned to a different idea fails lineage.
  const otherIdea = products.sealProduct({ ...idea.value, ideaId: 'idea-other' });
  const foreign = checkplans.runCheckPlan(checkplans.FINAL_INTENT_CHECK_PLAN, manifest.checkProviders, { idea: otherIdea, brief, intent });
  assert.equal(foreign.results.find((result) => result.providerId === 'lineage.provider').passed, false);
});

test('the CheckPlan evidence facts are the external Input authority (R15)', async () => {
  const driver = await import('../../../../dist/workflow-kernel/workshops/discovery/driver.js');
  const facts = driver.discoveryCheckPlanEvidence(manifest);
  assert.equal(facts.length, 2);
  for (const fact of facts) {
    assert.equal(fact.kind, 'CheckPlan');
    assert.equal(fact.producer, 'external-input');
    assert.match(fact.ref, /^evidence:CheckPlan#(author-brief-gate|final-intent-gate)$/);
    assert.match(fact.payloadDigest, /^[0-9a-f]{64}$/);
  }
});
