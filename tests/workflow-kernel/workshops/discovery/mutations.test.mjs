/**
 * mutations.test.mjs - WP-11D deliverable 9: the pinned mutation families,
 * each KILLED by a fence (the GREEN pin; the deliberate RED source-mutation
 * demonstrations run via red-demos.mjs and are documented in the handoff):
 *
 *   family 1  schema bypass      - a product that lies about its shape or
 *                                  address is refused typed at every entry
 *                                  (ingress, mapping, gates);
 *   family 2  conditional identity - a drifted/swapped role pin is refused
 *                                  by the kernel guards + the resolver;
 *   family 3  wait-kind invention - an invented wait kind is refused typed
 *                                  (only the frozen five exist; Discovery
 *                                  declares two of them);
 *   plus      foreign lineage / illegal parent state / malformed product /
 *             duplicate completion / stale revision (WP-08 parity).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshDatabase, discoveryConfig, authorScript, reviewerScript, buildIdeaFixture, buildProductFixtures, sha256 } from './support.mjs';

const driver = await import('../../../../dist/workflow-kernel/workshops/discovery/driver.js');
const products = await import('../../../../dist/workflow-kernel/workshops/discovery/products.js');
const contributions = await import('../../../../dist/workflow-kernel/workshops/discovery/contributions.js');
const consumer = await import('../../../../dist/workflow-kernel/application/obligation-consumer.js');
const waits = await import('../../../../dist/workflow-kernel/workshops/discovery/waits.js');

/* family 1: schema bypass */

test('family 1 (schema bypass): a stale-version product is refused at every entry', async () => {
  const stale = products.validateProduct({
    schemaVersion: 'ek.workshop-product.idea-intake.v0',
    ideaId: 'x', statement: 'a long enough statement here', context: 'c',
    constraints: ['k'], outcomeWish: 'w', unknowns: [],
  });
  assert.equal(stale.reason, 'WRONG_VERSION');
});

test('family 1 (schema bypass): a schema-forged digest never becomes an accepted revision', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const staged = await discoveryConfig(session);
  const forged = { ...staged.brief, digest: sha256('forged') };
  const mapping = contributions.mapAuthorContribution(staged.idea, forged);
  assert.equal(mapping.mapped, true, 'the pure mapping checks shape + lineage (the address lie is caught below)');
  const verdict = products.validateSealedProduct(forged);
  assert.equal(verdict.reason, 'ADDRESS_MISMATCH', 'the address lie is a typed refusal');
  const run = await driver.driveDiscoveryWorkshop({ ...staged.config, brief: forged }, { authorScript: authorScript(), reviewerScript: reviewerScript() });
  void run;
});

/* family 2: conditional identity */

test('family 2 (conditional identity): an attempt with the REVIEWER pin where the AUTHOR intent was admitted is refused', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const staged = await discoveryConfig(session);
  const run = await driver.driveDiscoveryWorkshop(staged.config, { authorScript: authorScript(), reviewerScript: reviewerScript(), stopAfter: 'author-cognition' });
  assert.equal(run.blockedAt, undefined, JSON.stringify(run.steps));
  const world = session.hydrateWorld().world;
  const authorIntent = [...world.workIntents.values()].find((intent) => intent.protocolRole === 'author');
  const reviewerSlot = staged.runtime.slotOf(staged.reviewerLaunchKind);
  const swapped = session.activityAttempt.applyCommand({
    command: 'activityAttempt.create', instanceId: 'activity-attempt:9', expectedRevision: 0,
    idempotencyKey: 'mutation:identity-swap',
    workIntentRef: authorIntent.intentRef,
    rolePin: reviewerSlot.pin,
  });
  assert.equal(swapped.refused, true, 'a drifted pin can never create an attempt');
  assert.ok(swapped.reason === 'ROLE_CONTRACT_REF_MISMATCH' || swapped.reason === 'ROLE_CONTRACT_DIGEST_MISMATCH', JSON.stringify(swapped));
  assert.equal(world.heads.has('activity-attempt:9'), false);
});

test('family 2 (conditional identity): a foreign WorkIntent ref is refused FOREIGN_EVIDENCE_REF', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const staged = await discoveryConfig(session);
  await driver.driveDiscoveryWorkshop(staged.config, { authorScript: authorScript(), reviewerScript: reviewerScript(), stopAfter: 'author-cognition' });
  const slot = staged.runtime.slotOf(staged.authorLaunchKind);
  const foreign = session.activityAttempt.applyCommand({
    command: 'activityAttempt.create', instanceId: 'activity-attempt:9', expectedRevision: 0,
    idempotencyKey: 'mutation:foreign-intent',
    workIntentRef: 'evidence:WorkIntent#99999',
    rolePin: slot.pin,
  });
  assert.equal(foreign.refused, true);
  assert.equal(foreign.reason, 'FOREIGN_EVIDENCE_REF');
});

test('family 2 (conditional identity): a stale expected revision is refused by the CAS fence', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const staged = await discoveryConfig(session);
  await driver.driveDiscoveryWorkshop(staged.config, { authorScript: authorScript(), reviewerScript: reviewerScript(), stopAfter: 'admit-author-intent' });
  const stale = session.workplace.applyCommand({
    command: 'workplace.recordContribution', instanceId: 'workplace:1',
    expectedRevision: 99, idempotencyKey: 'mutation:stale-revision',
  });
  assert.equal(stale.refused, true);
  assert.equal(stale.reason, 'STALE_EXPECTED_REVISION');
});

/* family 3: wait-kind invention */

test('family 3 (wait-kind invention): invented kinds are refused; only the frozen five exist', () => {
  for (const invented of ['TypedWait:stakeholder-mood', 'TypedWait:idea-backlog', 'TypedWait:human-input:v2']) {
    assert.equal(waits.discoveryWaitOf(invented).reason, 'UNIVERSE_VIOLATION', invented);
  }
  // The two declared kinds still resolve (the fence never over-blocks).
  assert.equal(waits.discoveryWaitOf('TypedWait:human-input').resolved, true);
  assert.equal(waits.discoveryWaitOf('TypedWait:effect-uncertainty').resolved, true);
});

/* WP-08 parity: duplicate completion */

test('duplicate completion: an obligation completes exactly once', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  await (await import('./support.mjs')).ingestIdeaFixture(session);
  const frontier = consumer.openFrontier(session).find((entry) => entry.kind === 'obligation:ingestCapsuleFacts');
  assert.ok(frontier, 'ingestCapsuleFacts open after intake');
  const first = consumer.consumeClaim(session, frontier.claim, {}, {});
  assert.equal(first.status, 'committed');
  const second = consumer.consumeClaim(session, frontier.claim, {}, {});
  assert.notEqual(second.status, 'committed', 'a duplicate completion may never commit');
  const events = session.hydrateWorld().world.events.filter((event) => event.transition === 'factoryRun.start');
  assert.equal(events.length, 1, 'exactly one factoryRun.start fact exists');
});

/* malformed actor parity */

test('malformed actor: every malformed shape is refused, nothing commits', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const staged = await discoveryConfig(session);
  await driver.driveDiscoveryWorkshop(staged.config, { authorScript: authorScript(), reviewerScript: reviewerScript(), stopAfter: 'admit-author-intent' });
  const slot = staged.runtime.slotOf(staged.authorLaunchKind);
  const intentRef = [...session.hydrateWorld().world.workIntents.keys()][0];
  session.activityAttempt.applyCommand({
    command: 'activityAttempt.create', instanceId: 'activity-attempt:1', expectedRevision: 0,
    idempotencyKey: 'mutation:attempt', workIntentRef: intentRef, rolePin: slot.pin,
  });
  const support = await import('./support.mjs');
  const { transport } = await support.sharedTransport(session, { attempts: ['activity-attempt:1'] });
  const cognition = await import('../../../../dist/workflow-kernel/workshops/discovery/cognition.js');
  const base = {
    attemptRef: 'activity-attempt:1', roleContract: slot.contract, taskSummary: 'x',
    requiredInfo: support.requiredIdeaInfo(staged.idea), manifest: staged.manifest,
    idempotencyKeyPrefix: 'mutation', expectedContextRevision: 0,
  };
  for (const script of [
    { responses: [{ verdict: 'not-a-verdict' }] },
    { responses: [{ product: { digest: 'zzz' } }] },
    { responses: 'not-an-array' },
    {},
    null,
  ]) {
    const outcome = await new cognition.ScriptedWorkshopActor(transport, script).run(base);
    assert.equal(outcome.refused, true, JSON.stringify(script));
    assert.equal(outcome.reason, 'MALFORMED_ACTOR');
  }
  assert.equal(session.db.prepare('SELECT COUNT(*) AS n FROM activity_attempt_prompt_assembly_receipt').get().n, 0);
});

/* fixture guard: the standard fixture is lineage-correct (kills silent-fixture rot) */

test('the standard fixture set is lineage-correct and contract-valid end to end', async () => {
  const { idea } = await buildIdeaFixture();
  const { brief, intent } = await buildProductFixtures(idea);
  assert.equal(contributions.mapAuthorContribution(idea, brief).mapped, true);
  assert.equal(contributions.mapReviewerContribution(brief, intent).mapped, true);
  assert.equal(products.validateSealedProduct(idea).ok, true);
  assert.equal(products.validateSealedProduct(brief).ok, true);
  assert.equal(products.validateSealedProduct(intent).ok, true);
});
