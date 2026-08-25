/**
 * capsule-ingress.test.mjs - WP-08 deliverable 1: import one
 * content-addressed Discovery+Formalization capsule through PUBLIC ingress
 * into a fresh database; verify every digest; refuse the five corruption
 * classes with typed reasons.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCapsuleFixture, freshDatabase, driveToWorkplace, LINEAGE, CAPSULE_BYTES, sha256 } from './support.mjs';

const ingress = await import('../../../dist/workflow-kernel/development/capsule.js');

test('a verified capsule imports through public ingress into a fresh database', async () => {
  const db = freshDatabase();
  const session = await db.open();
  const capsule = await buildCapsuleFixture();
  const result = ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.imported, true, `ingress refused: ${JSON.stringify(result)}`);

  // CapsuleIngressReceipt + the D0 planning facts recorded by the kernel.
  const world = session.hydrateWorld().world;
  const kinds = new Set(world.evidence.map((fact) => fact.kind));
  for (const kind of ['CapsuleIngressReceipt', 'TerminalLifecycleClaim', 'TerminalClaimCoverage', 'ConstructionSurface', 'SeamOwnership']) {
    assert.ok(kinds.has(kind), `${kind} recorded by factoryRun.importCapsule`);
  }
  assert.equal(world.heads.get('factory-run:1')?.status, 'capsule-imported');
  assert.ok(result.ingressReceiptRef.startsWith('evidence:CapsuleIngressReceipt#'));
  // Every verified digest is returned to the caller.
  assert.equal(result.verified.capsuleDigest, capsule.capsuleDigest);
  assert.equal(result.verified.modulePackageDigest, capsule.modulePackage.digest);
  assert.equal(result.verified.buildDigest, capsule.buildOutput.digest);
  assert.equal(result.verified.baseRepositoryDigest, capsule.baseRepository.digest);
  assert.equal(result.verified.requirementDigests.length, 3);
  assert.equal(result.verified.terminalClaimDigests.length, 2);
  assert.equal(result.verified.acceptanceCriteriaDigests.length, 3);
  assert.equal(result.verified.packageBytesDigest, capsule.packageBytesDigest);
  session.close();
});

test('refusal: stale protocol', async () => {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  const stale = { ...capsule, schemaVersion: 'ek.discovery-formalization-capsule.OLD.v0' };
  const result = ingress.ingestCapsule(session, stale, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'STALE_PROTOCOL');
  session.close();
});

test('refusal: missing package bytes', async () => {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  const result = ingress.ingestCapsule(session, capsule, undefined, {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'BYTES_MISSING');
  session.close();
});

test('refusal: corrupt package bytes (digest mismatch)', async () => {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  const result = ingress.ingestCapsule(session, capsule, new Uint8Array(Buffer.from('tampered bytes', 'utf8')), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'BYTES_CORRUPT');
  assert.match(result.detail, /package bytes hash/);
  session.close();
});

test('refusal: corrupt sub-artifact digest (certificate content tampered)', async () => {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  const corrupt = {
    ...capsule,
    certificate: { ...capsule.certificate, content: { kind: 'formalization-certificate', decision: 'TAMPERED' } },
  };
  const result = ingress.ingestCapsule(session, corrupt, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'BYTES_CORRUPT');
  assert.match(result.detail, /certificate/);
  session.close();
});

test('refusal: corrupt capsule self-address', async () => {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  const corrupt = { ...capsule, capsuleDigest: sha256('forged') };
  const result = ingress.ingestCapsule(session, corrupt, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'BYTES_CORRUPT');
  session.close();
});

test('refusal: foreign lineage', async () => {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture({
    lineage: { lineageId: 'lineage:OTHER-product', parentLifecycleRef: LINEAGE.parentLifecycleRef },
  });
  const result = ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'FOREIGN_LINEAGE');
  session.close();
});

test('refusal: illegal parent state (formalization not terminal)', async () => {
  const session = await (await freshDatabase()).open();
  // Built with the illegal parent state so every digest verifies: only the
  // parent-state class fires.
  const { buildCapsule, capsuleArtifact } = ingress;
  void capsuleArtifact;
  const capsule = await buildCapsuleFixture();
  const illegal = buildCapsule(
    {
      certificate: capsule.certificate,
      requirements: capsule.requirements,
      terminalClaims: capsule.terminalClaims,
      acceptanceCriteria: capsule.acceptanceCriteria,
      modulePackage: capsule.modulePackage,
      buildOutput: capsule.buildOutput,
      baseRepository: capsule.baseRepository,
    },
    capsule.lineage,
    { status: 'formalization-in-progress', terminalProofRef: capsule.parentState.terminalProofRef },
    new Uint8Array(CAPSULE_BYTES),
  );
  const result = ingress.ingestCapsule(session, illegal, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(result.refused, true);
  assert.equal(result.reason, 'ILLEGAL_PARENT_STATE');
  assert.match(result.detail, /formalization-terminal/);
  session.close();
});

test('refusal: active attempt in the target world', async () => {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  const first = ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(first.imported, true);
  // Lawful path to a LIVE attempt: spine to the workplace, admit an author
  // intent, create the attempt (still nonterminal).
  const workplace = await driveToWorkplace(session);
  session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent',
    instanceId: workplace,
    expectedRevision: 1,
    idempotencyKey: 'intent',
    protocolRole: 'author',
    rolePin: { roleContractRef: `sha256:${sha256('pin')}`, roleContractDigest: sha256('pin-body') },
    evidenceRefs: ['evidence:scope'],
  });
  const intentRef = [...session.hydrateWorld().world.workIntents.keys()][0];
  const attempt = session.activityAttempt.applyCommand({
    command: 'activityAttempt.create',
    instanceId: 'activity-attempt:1',
    expectedRevision: 0,
    idempotencyKey: 'a',
    workIntentRef: intentRef,
    rolePin: { roleContractRef: `sha256:${sha256('pin')}`, roleContractDigest: sha256('pin-body') },
  });
  assert.equal(attempt.refused, undefined, `attempt creation must succeed: ${JSON.stringify(attempt)}`);
  const second = ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(second.refused, true);
  assert.equal(second.reason, 'ACTIVE_ATTEMPT');
  assert.match(second.detail, /activity-attempt:1/);
  session.close();
});

test('the fresh database is untouched by every typed refusal', async () => {
  const db = freshDatabase();
  const session = await db.open();
  const capsule = await buildCapsuleFixture();
  const refused = ingress.ingestCapsule(session, capsule, undefined, {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(refused.refused, true);
  // No WorkflowEvent, no obligations, no head rows: the refusal committed nothing.
  const world = session.hydrateWorld().world;
  assert.equal(world.events.length, 0);
  assert.equal(world.obligations.length, 0);
  assert.equal(world.heads.size, 1); // only the virtual transport singleton
  session.close();
});
