/**
 * contributions.test.mjs - WP-11D deliverable 2 (mapping half): the PURE
 * contribution mappings input products -> contributions -> production
 * revisions; Workplace production revision is the accepted-material
 * authority (ADR-053), so the mappings validate products and lineage
 * BEFORE anything reaches the kernel.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIdeaFixture, buildProductFixtures, sha256 } from './support.mjs';

const contributions = await import('../../../../dist/workflow-kernel/workshops/discovery/contributions.js');
const products = await import('../../../../dist/workflow-kernel/workshops/discovery/products.js');

test('the pure idea -> brief derivation carries every constraint and unknown (D10)', async () => {
  const { idea } = await buildIdeaFixture();
  const draft = contributions.draftBriefFromIdea(idea);
  assert.equal(draft.ideaRef, idea.ref, 'lineage binds the exact idea address');
  assert.deepEqual(draft.constraints, idea.value.constraints);
  assert.deepEqual(draft.openQuestions, idea.value.unknowns, 'unknowns survive as open questions');
  const sealed = products.sealProduct(draft);
  assert.equal(products.validateSealedProduct(sealed).ok, true, 'the derived draft satisfies the brief contract');
});

test('the pure brief -> intent derivation binds the sealed brief and the next stage route', async () => {
  const { idea } = await buildIdeaFixture();
  const { brief } = await buildProductFixtures(idea);
  const draft = contributions.draftIntentFromBrief(brief, 'go', 'Constraints and unknowns accounted for; proceed.');
  assert.equal(draft.briefRef, brief.ref);
  assert.equal(draft.decision, 'go');
  assert.equal(draft.targetStageRoute, 'solution-formalization');
  assert.equal(products.validateSealedProduct(products.sealProduct(draft)).ok, true);
});

test('mapAuthorContribution maps the brief over the admitted idea (pure, typed)', async () => {
  const { idea } = await buildIdeaFixture();
  const { brief } = await buildProductFixtures(idea);
  const mapping = contributions.mapAuthorContribution(idea, brief);
  assert.equal(mapping.mapped, true, JSON.stringify(mapping));
  assert.deepEqual([...mapping.contribution.productRefs], [idea.ref, brief.ref]);
  assert.equal(mapping.contribution.payloadDigest, brief.digest, 'the revision binds the brief material');
  assert.match(mapping.contribution.contributionRef, /^sha256:[0-9a-f]{64}$/);
  // Determinism: the same inputs map to the same contribution ref.
  assert.equal(contributions.mapAuthorContribution(idea, brief).contribution.contributionRef, mapping.contribution.contributionRef);
});

test('mapReviewerContribution maps the intent over the SEALED brief revision', async () => {
  const { idea } = await buildIdeaFixture();
  const { brief, intent } = await buildProductFixtures(idea);
  const mapping = contributions.mapReviewerContribution(brief, intent);
  assert.equal(mapping.mapped, true, JSON.stringify(mapping));
  assert.deepEqual([...mapping.contribution.productRefs], [brief.ref, intent.ref]);
  assert.equal(mapping.contribution.payloadDigest, intent.digest);
});

test('fence: a malformed product is refused MALFORMED_PRODUCT naming the field', async () => {
  const { idea } = await buildIdeaFixture();
  const malformedBrief = products.sealProduct({
    schemaVersion: 'ek.workshop-product.brief.v1',
    briefId: 'b-1',
    problem: 'thin',
    outcome: 'o',
    constraints: ['c'],
    openQuestions: [],
    ideaRef: idea.ref,
  });
  const mapping = contributions.mapAuthorContribution(idea, malformedBrief);
  assert.equal(mapping.refused, true);
  assert.equal(mapping.reason, 'MALFORMED_PRODUCT');
  assert.match(mapping.detail, /EMPTY_VALUE\(problem\)/);
});

test('fence: a lineage break is refused LINEAGE_BREAK (never an implicit bind)', async () => {
  const { idea } = await buildIdeaFixture();
  const foreignIdea = products.sealProduct({ ...idea.value, ideaId: 'idea-someone-else' });
  const { brief } = await buildProductFixtures(idea);
  // The brief binds OUR idea; mapping it over the FOREIGN idea is a break.
  const mapping = contributions.mapAuthorContribution(foreignIdea, brief);
  assert.equal(mapping.refused, true);
  assert.equal(mapping.reason, 'LINEAGE_BREAK');
  assert.match(mapping.detail, /pins idea/);
  // Reviewer side: the intent binding a foreign brief address.
  const { intent } = await buildProductFixtures(idea);
  const foreignIntent = products.sealProduct({ ...intent.value, briefRef: 'sha256:' + sha256('foreign-brief') });
  const reviewer = contributions.mapReviewerContribution(brief, foreignIntent);
  assert.equal(reviewer.reason, 'LINEAGE_BREAK');
});

test('fence: a product claiming the wrong contract is refused CONTRACT_MISMATCH', async () => {
  const { idea } = await buildIdeaFixture();
  const { brief } = await buildProductFixtures(idea);
  // Feed the brief where the intent belongs.
  const mapping = contributions.mapReviewerContribution(brief, brief);
  assert.equal(mapping.refused, true);
  assert.equal(mapping.reason, 'CONTRACT_MISMATCH');
});

test('sealDraftedProduct is the throw-on-invalid oracle (never a silent fix-up)', async () => {
  const { idea } = await buildIdeaFixture();
  const good = contributions.draftBriefFromIdea(idea);
  assert.equal(contributions.sealDraftedProduct(good).value.briefId, good.briefId);
  assert.throws(() => contributions.sealDraftedProduct({ ...good, problem: 'thin' }), /EMPTY_VALUE\(problem\)/);
});
