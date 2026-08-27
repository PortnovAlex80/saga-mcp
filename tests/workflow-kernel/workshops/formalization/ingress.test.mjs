/**
 * ingress.test.mjs - the Discovery handoff capsule ingress (WP-11F):
 * content-addressed verification, typed fail-closed refusals in the frozen
 * check order, import through the FactoryRun sole-writer repository, and
 * idempotent re-ingress.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshDatabase, buildHandoffCapsule, HANDOFF_BINDING, HANDOFF_BYTES, LINEAGE, sha256 } from './support.mjs';

const ingressModule = () => import('../../../../dist/workflow-kernel/workshops/formalization/ingress.js');

test('a fully-verified handoff imports through the public ingress', async () => {
  const ingress = await ingressModule();
  const db = await freshDatabase();
  const session = await db.open();
  const capsule = await buildHandoffCapsule();
  const result = ingress.ingestDiscoveryHandoff(session, capsule, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  assert.equal(result.imported, true);
  assert.match(result.capsuleRef, /^sha256:[0-9a-f]{64}$/);
  // Four accepted source claims (the frozen WP03 fixture universe: scope-1,
  // scope-2, constraint-1, outcome-1 - re-pinned at the FRF-WP11 cutover).
  assert.equal(result.verified.sourceClaimDigests.length, 4);
  assert.equal(result.verified.terminalClaimDigests.length, 2);
  assert.match(result.ingressReceiptRef, /^evidence:CapsuleIngressReceipt#\d+$/);
  // The kernel committed the capsule planning facts (the WorkItem inputs).
  const world = session.hydrateWorld().world;
  assert.ok(world.evidence.some((fact) => fact.kind === 'CapsuleIngressReceipt'));
  assert.ok(world.evidence.some((fact) => fact.kind === 'TerminalLifecycleClaim'));
  assert.ok(world.evidence.some((fact) => fact.kind === 'ConstructionSurface'));
  assert.ok(world.evidence.some((fact) => fact.kind === 'TerminalClaimCoverage'));
});

test('STALE_PROTOCOL: a wrong protocol version is refused first', async () => {
  const ingress = await ingressModule();
  const db = await freshDatabase();
  const session = await db.open();
  const capsule = await buildHandoffCapsule();
  const stale = { ...capsule, schemaVersion: 'ek.discovery-handoff-capsule.old.v0' };
  const result = ingress.ingestDiscoveryHandoff(session, stale, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  assert.equal(result.reason, 'STALE_PROTOCOL');
});

test('BYTES_CORRUPT: a tampered sub-artifact digest is refused (recomputed, never trusted)', async () => {
  const ingress = await ingressModule();
  const db = await freshDatabase();
  const session = await db.open();
  const capsule = await buildHandoffCapsule();
  const tampered = {
    ...capsule,
    sourceClaims: capsule.sourceClaims.map((artifact, index) => index === 0 ? { ...artifact, content: { tampered: true } } : artifact),
  };
  const result = ingress.ingestDiscoveryHandoff(session, tampered, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  assert.equal(result.reason, 'BYTES_CORRUPT');
  // A broken capsule self-address is refused too.
  const broken = { ...capsule, capsuleDigest: '0'.repeat(64) };
  const selfAddress = ingress.ingestDiscoveryHandoff(session, broken, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  assert.equal(selfAddress.reason, 'BYTES_CORRUPT');
});

test('BYTES_MISSING: absent package bytes are refused, never fabricated', async () => {
  const ingress = await ingressModule();
  const db = await freshDatabase();
  const session = await db.open();
  const capsule = await buildHandoffCapsule();
  const result = ingress.ingestDiscoveryHandoff(session, capsule, undefined, HANDOFF_BINDING);
  assert.equal(result.reason, 'BYTES_MISSING');
  const empty = ingress.ingestDiscoveryHandoff(session, capsule, new Uint8Array(0), HANDOFF_BINDING);
  assert.equal(empty.reason, 'BYTES_MISSING');
});

test('FOREIGN_LINEAGE: a foreign lineage never enters this database', async () => {
  const ingress = await ingressModule();
  const db = await freshDatabase();
  const session = await db.open();
  const capsule = await buildHandoffCapsule({ lineage: { ...LINEAGE, lineageId: 'lineage:another-product' } });
  const result = ingress.ingestDiscoveryHandoff(session, capsule, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  assert.equal(result.reason, 'FOREIGN_LINEAGE');
  const foreignParent = await buildHandoffCapsule({ lineage: { ...LINEAGE, parentLifecycleRef: 'sha256:' + sha256('foreign-parent') } });
  const parent = ingress.ingestDiscoveryHandoff(session, foreignParent, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  assert.equal(parent.reason, 'FOREIGN_LINEAGE');
});

test('ILLEGAL_PARENT_STATE: a non-terminal Discovery parent cannot hand off', async () => {
  const ingress = await ingressModule();
  const db = await freshDatabase();
  const session = await db.open();
  // The capsule is REBUILT with the illegal parent state so its
  // self-address verifies (the digest checks pass; only the state is illegal).
  const running = await buildHandoffCapsule({ parentStatus: 'discovery-running' });
  const result = ingress.ingestDiscoveryHandoff(session, running, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  assert.equal(result.reason, 'ILLEGAL_PARENT_STATE');
});

test('the one legal parent state is discovery-terminal (a formalization-terminal handoff is refused here)', async () => {
  const ingress = await ingressModule();
  assert.deepEqual(ingress.HANDOFF_LEGAL_PARENT_STATES, ['discovery-terminal']);
});

test('ingress is fail-closed idempotent: a second ingress of the same capsule refuses and never double-imports', async () => {
  const ingress = await ingressModule();
  const db = await freshDatabase();
  const session = await db.open();
  const capsule = await buildHandoffCapsule();
  const first = ingress.ingestDiscoveryHandoff(session, capsule, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  assert.equal(first.imported, true);
  const eventsAfterFirst = session.hydrateWorld().world.events.length;
  const second = ingress.ingestDiscoveryHandoff(session, capsule, new Uint8Array(HANDOFF_BYTES), HANDOFF_BINDING);
  // The factory already moved past capsule-imported: the one-shot ingress
  // transition refuses typed (fail-closed), never a second import.
  assert.equal(second.refused, true);
  const eventsAfterSecond = session.hydrateWorld().world.events.length;
  assert.equal(eventsAfterSecond, eventsAfterFirst, 'no second import event');
});

test('the handoff facts JSON is a stable canonical oracle', async () => {
  const ingress = await ingressModule();
  const capsule = await buildHandoffCapsule();
  const first = ingress.handoffFactsJson(capsule);
  const again = ingress.handoffFactsJson(await buildHandoffCapsule());
  assert.equal(first, again);
});
