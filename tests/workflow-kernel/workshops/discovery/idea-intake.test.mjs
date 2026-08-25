/**
 * idea-intake.test.mjs - WP-11D deliverable 2 (ingress half): the PUBLIC
 * idea ingress through factoryRun.bootstrap + factoryRun.importCapsule,
 * with the frozen typed-refusal check order (foreign lineage, illegal
 * parent state, stale protocol, corrupt bytes, malformed product, active
 * attempt) and the CapsuleIngressReceipt that makes factoryRun.start
 * lawful for the first stage.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshDatabase, buildIdeaFixture, IDEA_LINEAGE, INTAKE_BYTES, sha256 } from './support.mjs';

const intake = await import('../../../../dist/workflow-kernel/workshops/discovery/idea-intake.js');
const products = await import('../../../../dist/workflow-kernel/workshops/discovery/products.js');

const BINDING = { expectedLineageId: IDEA_LINEAGE.lineageId, expectedParentLifecycleRef: null };

test('the happy path: a verified idea bundle imports through the public commands', async () => {
  const session = await (await freshDatabase()).open();
  const { bundle, intakeBytes } = await buildIdeaFixture();
  const result = intake.ingestIdeaBundle(session, bundle, intakeBytes, BINDING);
  assert.equal(result.imported, true, JSON.stringify(result));
  assert.match(result.ingressReceiptRef, /^evidence:CapsuleIngressReceipt#\d+$/);
  const world = session.hydrateWorld().world;
  assert.equal(world.heads.get('factory-run:1')?.status, 'capsule-imported');
  // The idea facts (the planning inputs) are recorded evidence.
  for (const kind of ['TerminalLifecycleClaim', 'ConstructionSurface', 'TerminalClaimCoverage']) {
    assert.ok(world.evidence.some((fact) => fact.kind === kind), `${kind} recorded by the ingress`);
  }
  session.close();
});

test('the ingress is idempotent: a re-ingest of the same bundle never double-imports', async () => {
  const session = await (await freshDatabase()).open();
  const { bundle, intakeBytes } = await buildIdeaFixture();
  const first = intake.ingestIdeaBundle(session, bundle, intakeBytes, BINDING);
  assert.equal(first.imported, true);
  // The second application of the same bundle hits the moved head + the
  // recorded idempotency key: fail-closed (ILLEGAL_PARENT_STATE mapping of
  // the repository refusal), NEVER a second CapsuleIngressReceipt.
  const second = intake.ingestIdeaBundle(session, bundle, intakeBytes, BINDING);
  assert.equal(second.refused, true, JSON.stringify(second));
  assert.equal(second.reason, 'ILLEGAL_PARENT_STATE');
  const events = session.hydrateWorld().world.events.filter((event) => event.transition === 'factoryRun.importCapsule');
  assert.equal(events.length, 1, 'exactly one import fact exists');
  session.close();
});

test('refusal: foreign lineage never enters this database', async () => {
  const session = await (await freshDatabase()).open();
  const { bundle, intakeBytes } = await buildIdeaFixture({ lineage: { lineageId: 'lineage:someone-else', parentLifecycleRef: null } });
  const result = intake.ingestIdeaBundle(session, bundle, intakeBytes, BINDING);
  assert.equal(result.reason, 'FOREIGN_LINEAGE');
  assert.match(result.detail, /foreign-lineage ideas never enter/);
  assert.equal(session.hydrateWorld().world.heads.has('factory-run:1'), false, 'nothing was created');
  session.close();
});

test('refusal: a non-null parent lifecycle is foreign for the FIRST stage', async () => {
  const session = await (await freshDatabase()).open();
  const { bundle, intakeBytes } = await buildIdeaFixture({ lineage: { lineageId: IDEA_LINEAGE.lineageId, parentLifecycleRef: 'sha256:' + sha256('ghost-parent') } });
  const result = intake.ingestIdeaBundle(session, bundle, intakeBytes, BINDING);
  assert.equal(result.reason, 'FOREIGN_LINEAGE');
  session.close();
});

test('refusal: illegal parent state (not the operator intake decision)', async () => {
  const session = await (await freshDatabase()).open();
  const { idea, intakeBytes } = await buildIdeaFixture();
  const bundle = intake.buildIdeaBundle(idea, IDEA_LINEAGE, { status: 'formalization-terminal', decisionRef: 'sha256:' + sha256('x') }, intakeBytes);
  const result = intake.ingestIdeaBundle(session, bundle, intakeBytes, BINDING);
  assert.equal(result.reason, 'ILLEGAL_PARENT_STATE');
  assert.match(result.detail, /operator intake decision/);
  // A non-content-address decision ref is refused the same class.
  const badRef = intake.buildIdeaBundle(idea, IDEA_LINEAGE, { status: 'operator-intake', decisionRef: 'not-an-address' }, intakeBytes);
  assert.equal(intake.ingestIdeaBundle(session, badRef, intakeBytes, BINDING).reason, 'ILLEGAL_PARENT_STATE');
  session.close();
});

test('refusal: stale protocol version', async () => {
  const session = await (await freshDatabase()).open();
  const { bundle, intakeBytes } = await buildIdeaFixture();
  const stale = { ...bundle, schemaVersion: 'ek.idea-intake-bundle.ek7.v9' };
  const result = intake.ingestIdeaBundle(session, stale, intakeBytes, BINDING);
  assert.equal(result.reason, 'STALE_PROTOCOL');
  session.close();
});

test('refusal: corrupt bytes (bundle self-address, idea address, intake bytes)', async () => {
  const session = await (await freshDatabase()).open();
  const { bundle, intakeBytes } = await buildIdeaFixture();
  // Bundle digest lie.
  const lyingBundle = { ...bundle, bundleDigest: sha256('lie') };
  assert.equal(intake.ingestIdeaBundle(session, lyingBundle, intakeBytes, BINDING).reason, 'BYTES_CORRUPT');
  // Idea product digest lie.
  const lyingIdea = { ...bundle, idea: { ...bundle.idea, digest: sha256('lie') } };
  assert.equal(intake.ingestIdeaBundle(session, lyingIdea, intakeBytes, BINDING).reason, 'BYTES_CORRUPT');
  // Intake bytes do not hash to the pinned digest.
  const wrongBytes = new Uint8Array(Buffer.from('different bytes'));
  assert.equal(intake.ingestIdeaBundle(session, bundle, wrongBytes, BINDING).reason, 'BYTES_CORRUPT');
  // Missing bytes.
  assert.equal(intake.ingestIdeaBundle(session, bundle, undefined, BINDING).reason, 'BYTES_MISSING');
  assert.equal(intake.ingestIdeaBundle(session, bundle, new Uint8Array(0), BINDING).reason, 'BYTES_MISSING');
  session.close();
});

test('refusal: a malformed idea product is refused typed at ingress (schema fence at the boundary)', async () => {
  const session = await (await freshDatabase()).open();
  const malformed = await buildIdeaFixture({ ideaValue: { ...JSON.parse(JSON.stringify((await import('./support.mjs')).IDEA_VALUE)), statement: 'thin' } });
  const result = intake.ingestIdeaBundle(session, malformed.bundle, malformed.intakeBytes, BINDING);
  assert.equal(result.reason, 'MALFORMED_PRODUCT');
  assert.match(result.detail, /EMPTY_VALUE\(statement\)/);
  session.close();
});

test('refusal: an active attempt in the target world blocks intake (fresh-run law)', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  const support = await import('./support.mjs');
  const driver = await import('../../../../dist/workflow-kernel/workshops/discovery/driver.js');
  const { config } = await support.discoveryConfig(session);
  const run = await driver.driveDiscoveryWorkshop(config, {
    authorScript: support.authorScript(),
    reviewerScript: support.reviewerScript(),
    stopAfter: 'author-attempt',
  });
  assert.equal(run.blockedAt, undefined, JSON.stringify(run.steps));
  assert.equal(session.hydrateWorld().world.heads.has('activity-attempt:1'), true, 'the live attempt exists');
  const { bundle, intakeBytes } = await buildIdeaFixture();
  const result = intake.ingestIdeaBundle(session, bundle, intakeBytes, BINDING);
  assert.equal(result.reason, 'ACTIVE_ATTEMPT');
  assert.match(result.detail, /activity-attempt:1/);
});

test('the bundle builder derives the self-address (never trusted as declared)', async () => {
  const { idea, intakeBytes } = await buildIdeaFixture();
  const bundle = intake.buildIdeaBundle(idea, IDEA_LINEAGE, { status: 'operator-intake', decisionRef: 'sha256:' + sha256('d') }, intakeBytes);
  assert.equal(bundle.bundleRef, `sha256:${bundle.bundleDigest}`);
  assert.equal(products.verifyProductAddress(bundle.idea), true);
});
