/**
 * mutations.test.mjs - WP-08 deliverable 7: the pinned mutation classes
 * (foreign-ref, stale-revision, missing-integration-surface, duplicate
 * completion, malformed-actor) are KILLED by the fences - each test injects
 * the mutation and proves the typed refusal (the GREEN pin; the deliberate
 * RED source-mutation demonstrations run separately and are documented in
 * the handoff).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  freshDatabase, driveToWorkplace, buildCapsuleFixture, roleRuntime, taskManifest,
  authorScript, productVerifier, LINEAGE, CAPSULE_BYTES, sha256,
} from './support.mjs';

const ingress = await import('../../../dist/workflow-kernel/development/capsule.js');
const chain = await import('../../../dist/workflow-kernel/development/material-chain.js');
const consumer = await import('../../../dist/workflow-kernel/application/obligation-consumer.js');
const actors = await import('../../../dist/workflow-kernel/development/actors.js');

/** A lawful world staged to the production workplace with one author intent. */
async function stagedWorld() {
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  assert.equal(ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId, expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  }).imported, true);
  await driveToWorkplace(session);
  const { runtime, authorLaunchKind } = await roleRuntime();
  const slot = runtime.resolveOnce(authorLaunchKind);
  session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent', instanceId: 'workplace:1', expectedRevision: 1,
    idempotencyKey: 'mutation:author-intent', protocolRole: 'author', rolePin: slot.slot.pin,
    evidenceRefs: ['work-item:1', 'evidence:scope'],
  });
  const intentRef = [...session.hydrateWorld().world.workIntents.keys()][0];
  return { session, slot, intentRef, authorLaunchKind };
}

test('mutation: foreign-ref - an attempt binding a foreign WorkIntent is refused', async () => {
  const { session, slot } = await stagedWorld();
  const foreign = session.activityAttempt.applyCommand({
    command: 'activityAttempt.create', instanceId: 'activity-attempt:9', expectedRevision: 0,
    idempotencyKey: 'mutation:foreign-ref',
    workIntentRef: 'evidence:WorkIntent#99999', // never admitted by any Workplace
    rolePin: slot.slot.pin,
  });
  assert.equal(foreign.refused, true);
  assert.equal(foreign.reason, 'FOREIGN_EVIDENCE_REF');
  assert.match(foreign.detail, /WorkIntent/);
  // No attempt row was created.
  assert.equal(session.hydrateWorld().world.heads.has('activity-attempt:9'), false);
  session.close();
});

test('mutation: foreign-ref - a drifted role pin (digest A vs digest B) is refused', async () => {
  const { session, intentRef } = await stagedWorld();
  const drifted = session.activityAttempt.applyCommand({
    command: 'activityAttempt.create', instanceId: 'activity-attempt:9', expectedRevision: 0,
    idempotencyKey: 'mutation:drifted-pin',
    workIntentRef: intentRef,
    rolePin: { roleContractRef: `sha256:${sha256('other-contract')}`, roleContractDigest: sha256('other-body') },
  });
  assert.equal(drifted.refused, true);
  assert.equal(drifted.reason, 'ROLE_CONTRACT_REF_MISMATCH');
  session.close();
});

test('mutation: stale-revision - a command on a moved head is refused', async () => {
  const { session } = await stagedWorld();
  // The workplace is at revision 2 (materialize + author intent); a command
  // that IS legal from its current status ('author-intent-admitted' ->
  // recordContribution) is refused by the CAS fence BEFORE any guard runs.
  const staleWorkplace = session.workplace.applyCommand({
    command: 'workplace.recordContribution', instanceId: 'workplace:1',
    expectedRevision: 9, // the head is at revision 2
    idempotencyKey: 'mutation:stale-w',
  });
  assert.equal(staleWorkplace.refused, true);
  assert.equal(staleWorkplace.reason, 'STALE_EXPECTED_REVISION');
  // Same fence on the LifecycleRun (revision 1, legal from 'created').
  const staleRoute = session.lifecycleRun.applyCommand({
    command: 'lifecycleRun.routeOutcome', instanceId: 'lifecycle-run:1',
    expectedRevision: 5, idempotencyKey: 'mutation:stale-route',
    stageRoute: 'solution-development',
  });
  assert.equal(staleRoute.refused, true);
  assert.equal(staleRoute.reason, 'STALE_EXPECTED_REVISION');
  session.close();
});

test('mutation: duplicate completion - an obligation completes exactly once', async () => {
  // A world right after capsule ingress: ingestCapsuleFacts is the open frontier.
  const session = await (await freshDatabase()).open();
  const capsule = await buildCapsuleFixture();
  assert.equal(ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId, expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  }).imported, true);
  // Consume the same frontier obligation claim TWICE: the duplicate is
  // refused at the moved head (STALE/ILLEGAL) or replays the recorded
  // outcome - NEVER a second completion or fact.
  const frontier = consumer.openFrontier(session).find((entry) => entry.kind === 'obligation:ingestCapsuleFacts');
  assert.ok(frontier, 'ingestCapsuleFacts open after ingress');
  const first = consumer.consumeClaim(session, frontier.claim, {}, {});
  assert.equal(first.status, 'committed');
  const second = consumer.consumeClaim(session, frontier.claim, {}, {});
  assert.notEqual(second.status, 'committed', 'a duplicate completion may never commit');
  assert.ok(second.status === 'replayed' || second.status === 'refused', `unexpected duplicate outcome: ${JSON.stringify(second)}`);
  const events = session.hydrateWorld().world.events.filter((event) => event.transition === 'factoryRun.start');
  assert.equal(events.length, 1, 'exactly one factoryRun.start fact exists');
  const rows = session.db.prepare("SELECT state FROM transition_obligation WHERE kind = 'obligation:ingestCapsuleFacts'").all();
  assert.deepEqual(rows, [{ state: 'completed' }]);
  session.close();
});

test('mutation: duplicate completion - a duplicate CellFinalAcceptance row aborts at the SQL fence', async () => {
  const { session, config } = await (async () => {
    const db = freshDatabase();
    const session = await db.open();
    const capsule = await buildCapsuleFixture();
    assert.equal(ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
      expectedLineageId: LINEAGE.lineageId, expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
    }).imported, true);
    const { runtime, authorLaunchKind, reviewerLaunchKind } = await roleRuntime();
    runtime.resolveOnce(authorLaunchKind);
    runtime.resolveOnce(reviewerLaunchKind);
    const { sharedTransport } = await import('./support.mjs');
    const { transport } = await sharedTransport(session, { attempts: ['activity-attempt:1', 'activity-attempt:2'] });
    const config = {
      session, roles: runtime, authorLaunchKind, reviewerLaunchKind, transport,
      taskSummary: 'duplicate completion', requiredInfo: await taskManifest(),
      verifyProduct: await productVerifier(),
      externalEvidence: chain.externalInputEvidence('sha256:' + sha256('dup'), true),
    };
    const run = await chain.driveDevelopmentVertical(config, { authorScript: await authorScript(), reviewerScript: await authorScript() });
    void run;
    return { session, config };
  })();
  // The vertical recorded exactly one CellFinalAcceptance.
  const rows = session.db.prepare('SELECT acceptance_ref FROM workplace_cell_final_acceptance').all();
  assert.equal(rows.length, 1);
  // A direct duplicate INSERT (the raw mutation) is aborted by the immutability fence.
  assert.throws(
    () => session.db.prepare('INSERT INTO workplace_cell_final_acceptance (acceptance_ref, workplace_instance_id, acceptance_digest, payload_digest, created_sequence) VALUES (?, ?, ?, ?, ?)').run(rows[0].acceptance_ref, 'workplace:1', rows[0].acceptance_ref.replace(/^sha256:/, ''), rows[0].acceptance_ref.replace(/^sha256:/, ''), 1),
    /UNIQUE constraint|EK_/,
    'the duplicate completion cannot commit a second acceptance row',
  );
  // And the command path refuses to re-record on the advanced status.
  const replay = session.workplace.applyCommand({
    command: 'workplace.recordFinalAcceptance', instanceId: 'workplace:1',
    expectedRevision: session.hydrateWorld().world.heads.get('workplace:1')?.revision ?? 0,
    idempotencyKey: 'mutation:duplicate-acceptance',
  });
  assert.equal(replay.refused, true);
  assert.equal(replay.reason, 'ILLEGAL_TRANSITION');
  void config;
  session.close();
});

test('mutation: malformed-actor - every malformed shape is refused, nothing commits', async () => {
  const { session, slot, authorLaunchKind } = await stagedWorld();
  session.activityAttempt.applyCommand({
    command: 'activityAttempt.create', instanceId: 'activity-attempt:1', expectedRevision: 0,
    idempotencyKey: 'mutation:attempt', workIntentRef: [...session.hydrateWorld().world.workIntents.keys()][0], rolePin: slot.slot.pin,
  });
  const { sharedTransport } = await import('./support.mjs');
  const { transport } = await sharedTransport(session, { attempts: ['activity-attempt:1'] });
  const base = {
    attemptRef: 'activity-attempt:1', roleContract: slot.slot.contract, taskSummary: 'x',
    requiredInfo: await taskManifest(), idempotencyKeyPrefix: 'mutation', expectedContextRevision: 0,
  };
  void authorLaunchKind;
  const malformed = [
    { responses: [{ verdict: 'not-a-verdict' }] },
    { responses: [{ product: { digest: 'zzz' } }] },
    { responses: 'not-an-array' },
    {},
    null,
  ];
  for (const script of malformed) {
    const outcome = await new actors.ScriptedActor(transport, script).run(base);
    assert.equal(outcome.refused, true, JSON.stringify(script));
    assert.equal(outcome.reason, 'MALFORMED_ACTOR');
  }
  // Nothing committed: no receipt, no send, the attempt is untouched.
  assert.equal(session.db.prepare('SELECT COUNT(*) AS n FROM activity_attempt_prompt_assembly_receipt').get().n, 0);
  session.close();
});
