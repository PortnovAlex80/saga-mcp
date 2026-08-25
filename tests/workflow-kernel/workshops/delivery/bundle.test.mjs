/**
 * bundle.test.mjs - WP-11L: the verified Development bundle input product -
 * ingress green path plus every typed ingress refusal class (fail-closed,
 * frozen check order).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVerifiedBundle, freshDatabase, LINEAGE, PACKAGE_BYTES, sha256 } from './support.mjs';

const ingress = await import('../../../../dist/workflow-kernel/workshops/delivery/bundle.js');

const BINDING = { expectedLineageId: LINEAGE.lineageId, expectedParentLifecycleRef: LINEAGE.parentLifecycleRef };

test('the verified bundle imports through the public FactoryRun commands', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const result = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), BINDING);
  assert.equal(result.imported, true, JSON.stringify(result));
  assert.equal(result.verified.certificateDecision, 'verified');
  assert.match(result.ingressReceiptRef, /^evidence:CapsuleIngressReceipt#\d+$/);
  const world = session.hydrateWorld().world;
  assert.equal(world.heads.get('factory-run:1')?.status, 'capsule-imported');
  assert.ok(world.evidence.some((fact) => fact.kind === 'CapsuleIngressReceipt'));
  // The bundle's terminal claims are the kernel planning facts.
  assert.ok(world.evidence.some((fact) => fact.kind === 'TerminalLifecycleClaim'));
  assert.ok(world.evidence.some((fact) => fact.kind === 'ConstructionSurface'));
  session.close();
});

test('a duplicate ingress never commits twice: the kernel refuses the moved head, zero new facts', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const first = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), BINDING);
  assert.equal(first.imported, true);
  // The FactoryRun head moved to capsule-imported; the second import is
  // refused at the kernel's transition fence (the idempotency record alone
  // cannot replay a command whose aggregate moved past its legal statuses).
  const second = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), BINDING);
  assert.equal(second.refused, true, JSON.stringify(second));
  assert.equal(second.reason, 'ILLEGAL_PARENT_STATE');
  assert.match(second.detail, /ILLEGAL_TRANSITION/);
  // Exactly one import fact exists - no duplicate CapsuleIngressReceipt.
  const events = session.hydrateWorld().world.events.filter((event) => event.transition === 'factoryRun.importCapsule');
  assert.equal(events.length, 1);
  const receipts = session.hydrateWorld().world.evidence.filter((fact) => fact.kind === 'CapsuleIngressReceipt');
  assert.equal(receipts.length, 1);
  session.close();
});

test('refusal: STALE_PROTOCOL - an unknown protocol version never imports', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const stale = { ...bundle, schemaVersion: 'ek.verified-development-bundle.OLD.v0' };
  const result = ingress.ingressVerifiedBundle(session, stale, new Uint8Array(PACKAGE_BYTES), BINDING);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'STALE_PROTOCOL');
  assert.equal(session.hydrateWorld().world.heads.has('factory-run:1'), false, 'nothing committed');
  session.close();
});

test('refusal: BYTES_CORRUPT - a tampered artifact digest never imports', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const tampered = {
    ...bundle,
    integratedCandidate: { ...bundle.integratedCandidate, digest: sha256('tampered') },
  };
  const result = ingress.ingressVerifiedBundle(session, tampered, new Uint8Array(PACKAGE_BYTES), BINDING);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'BYTES_CORRUPT');
  session.close();
});

test('refusal: BYTES_CORRUPT - package bytes that do not hash to the pinned digest', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const result = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(Buffer.from('different bytes')), BINDING);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'BYTES_CORRUPT');
  session.close();
});

test('refusal: BYTES_MISSING - absent package bytes are refused, never fabricated', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const result = ingress.ingressVerifiedBundle(session, bundle, undefined, BINDING);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'BYTES_MISSING');
  session.close();
});

test('refusal: UNVERIFIED_CERTIFICATE - an unverified Development output never enters the release stage', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle({ certificateDecision: 'self-declared' });
  const result = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), BINDING);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'UNVERIFIED_CERTIFICATE');
  assert.match(result.detail, /self-declared/);
  session.close();
});

test('refusal: FOREIGN_LINEAGE - a foreign workshop bundle never enters this database', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const result = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), {
    expectedLineageId: 'lineage:a-different-product',
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'FOREIGN_LINEAGE');
  assert.match(result.detail, /a-different-product/);
  session.close();
});

test('refusal: FOREIGN_LINEAGE - a foreign parent lifecycle is refused', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  const result = ingress.ingressVerifiedBundle(session, bundle, new Uint8Array(PACKAGE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: 'sha256:' + sha256('a-foreign-parent'),
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'FOREIGN_LINEAGE');
  session.close();
});

test('refusal: ILLEGAL_PARENT_STATE - a non-terminal Development parent cannot hand off', async () => {
  const session = await (await freshDatabase()).open();
  const bundle = await buildVerifiedBundle();
  // Re-seal with a non-terminal parent state (self-address still verifies).
  const midRun = ingress.buildVerifiedDevelopmentBundle(
    {
      developmentCertificate: bundle.developmentCertificate,
      integratedCandidate: bundle.integratedCandidate,
      verifiedIntegrationBundle: bundle.verifiedIntegrationBundle,
      terminalClaims: bundle.terminalClaims,
      packagingInput: bundle.packagingInput,
    },
    bundle.lineage,
    { status: 'development-in-progress', terminalProofRef: bundle.parentState.terminalProofRef },
    new Uint8Array(PACKAGE_BYTES),
  );
  const result = ingress.ingressVerifiedBundle(session, midRun, new Uint8Array(PACKAGE_BYTES), BINDING);
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'ILLEGAL_PARENT_STATE');
  assert.match(result.detail, /development-terminal/);
  session.close();
});
