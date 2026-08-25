/**
 * actors.test.mjs - WP-08 deliverable 5: scripted, replay and real actors
 * implement the SAME cognition port (the WP-18 CognitionTransportContract),
 * admit through the same cumulative context accountant and persist the same
 * PromptAssemblyReceipt schema. A scripted actor may not write factory
 * tables, fabricate receipts or skip ingress. Human-wait scenarios run
 * through the public command path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { freshDatabase, roleRuntime, sharedTransport, taskManifest, buildCapsuleFixture, driveToWorkplace, LINEAGE, CAPSULE_BYTES, sha256, admissionPins, ROUTE_PIN_GLM47 } from './support.mjs';

const actors = await import('../../../dist/workflow-kernel/development/actors.js');
const envelope = await import('../../../dist/workflow-kernel/context-envelope/index.js');
const ingress = await import('../../../dist/workflow-kernel/development/capsule.js');

const ATTEMPT = 'activity-attempt:1';

test('all three actors persist the SAME PromptAssemblyReceipt schema through the SAME accountant', async (t) => {
  const session = await (await freshDatabase()).open();
  t.after(() => session.close());
  // Lawful world: capsule ingress -> spine -> workplace -> ONE author intent.
  const capsule = await buildCapsuleFixture();
  const imported = ingress.ingestCapsule(session, capsule, new Uint8Array(CAPSULE_BYTES), {
    expectedLineageId: LINEAGE.lineageId,
    expectedParentLifecycleRef: LINEAGE.parentLifecycleRef,
  });
  assert.equal(imported.imported, true);
  const workplace = await driveToWorkplace(session);

  const { runtime, authorLaunchKind } = await roleRuntime();
  const authorSlot = runtime.resolveOnce(authorLaunchKind);
  assert.equal(authorSlot.resolved, true);
  session.workplace.applyCommand({
    command: 'workplace.admitWorkIntent',
    instanceId: workplace,
    expectedRevision: 1,
    idempotencyKey: 'actor-test:author-intent',
    protocolRole: 'author',
    rolePin: authorSlot.slot.pin,
    evidenceRefs: ['work-item:1', 'evidence:scope'],
  });
  const intentRef = [...session.hydrateWorld().world.workIntents.keys()][0];
  const attempts = ['activity-attempt:1', 'activity-attempt:2', 'activity-attempt:3'];
  for (const [index, attemptId] of attempts.entries()) {
    const outcome = session.activityAttempt.applyCommand({
      command: 'activityAttempt.create',
      instanceId: attemptId,
      expectedRevision: 0,
      idempotencyKey: `actor-test:attempt-${index + 1}`,
      workIntentRef: intentRef,
      rolePin: authorSlot.slot.pin,
    });
    assert.equal(outcome.refused, undefined, `attempt ${attemptId}: ${JSON.stringify(outcome)}`);
  }

  const task = await taskManifest();
  const { transport } = await sharedTransport(session, { attempts });
  const launchBase = {
    roleContract: authorSlot.slot.contract,
    taskSummary: 'simple-server development',
    requiredInfo: task,
    expectedContextRevision: 0,
  };

  // 1. Scripted actor: ordinary tool calls/text/product through the shared port.
  const scripted = await new actors.ScriptedActor(transport, {
    responses: [{ toolCalls: [{ name: 'read-file', args: ['x'] }], text: 'ordinary text', product: { digest: sha256('p1'), description: 'product one' } }],
  }).run({ ...launchBase, attemptRef: attempts[0], idempotencyKeyPrefix: 'test:actor' });
  assert.equal(scripted.ran, true, JSON.stringify(scripted));
  assert.equal(scripted.result.receipts.length, 1);
  assert.equal(scripted.result.receipts[0].decision, 'admitted');
  assert.equal(scripted.result.receipts[0].providerRoutePin.model, ROUTE_PIN_GLM47.model);

  // 2. Replay actor: same port, same accountant, same receipt schema.
  const replay = await new actors.ReplayActor(transport, [
    { envelopeDigest: 'unused', requestOrdinal: 1, outcomeDigest: 'unused' },
  ]).run({ ...launchBase, attemptRef: attempts[1], idempotencyKeyPrefix: 'test:replay' });
  assert.equal(replay.ran, true, JSON.stringify(replay));
  assert.equal(replay.result.receipts[0].decision, 'admitted');

  // 3. Real actor over a REAL loopback HTTP channel (an actual socket send).
  const loopback = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((resolve) => loopback.listen(0, '127.0.0.1', resolve));
  t.after(() => loopback.close());
  const port = loopback.address().port;
  const { pins } = await admissionPins();
  const { store } = await sharedTransport(session, { attempts });
  const realChannel = new actors.LoopbackHttpChannel({ url: `http://127.0.0.1:${port}/` });
  const realTransport = envelope.createAdmittingTransport({
    transportId: 'real-loopback',
    routePin: ROUTE_PIN_GLM47,
    maxOutputTokens: 4096,
    pins,
    store,
    channel: realChannel,
    exposesMidLoopRequests: true,
  });
  const real = await new actors.RealActor(realTransport).run(
    { ...launchBase, attemptRef: attempts[2], idempotencyKeyPrefix: 'test:real' },
    { responses: [{ text: 'real cognition over a real socket' }] },
  );
  assert.equal(real.ran, true, JSON.stringify(real));
  assert.equal(real.result.receipts[0].decision, 'admitted');
  assert.equal(realChannel.sentSerializations.length, 1, 'the real channel carried exactly one send');

  // SAME receipt schema across all three actors: decision vocabulary, ordinals, digests.
  for (const receipt of [scripted.result.receipts[0], replay.result.receipts[0], real.result.receipts[0]]) {
    assert.ok(receipt.decision === 'admitted' || receipt.decision === 'refused');
    assert.equal(typeof receipt.digest, 'string');
    assert.equal(typeof receipt.requestInputTokens, 'number');
    assert.ok(Array.isArray(receipt.limitChecks));
    assert.ok(receipt.receiptRef.startsWith('sha256:'));
  }
  // The receipts are durably persisted in the SAME kernel table, one per attempt.
  const rows = session.db.prepare('SELECT activity_attempt_instance_id, admission, request_ordinal FROM activity_attempt_prompt_assembly_receipt ORDER BY created_sequence').all();
  assert.deepEqual(rows, attempts.map((attemptRef) => ({ activity_attempt_instance_id: attemptRef, admission: 'admitted', request_ordinal: 1 })));
  // The CAS counters advanced exactly once per attempt (durable, never receipt-derived).
  for (const attemptRef of attempts) {
    assert.deepEqual(session.activityAttempt.loadContextCounters(attemptRef), { contextRevision: 1, nextRequestOrdinal: 1, cumulativeInputTokens: scripted.result.receipts[0].requestInputTokens });
  }
});

test('a scripted actor that would skip ingress is impossible: no transport call, no receipt', async () => {
  // The actor receives ONLY the transport; without calling it there is no
  // receipt, no obligation, no factory fact (structural proof is in
  // structure.test.mjs; here we prove the runtime behavior).
  const channel = new actors.ScriptedChannel();
  const session = await (await freshDatabase()).open();
  const { transport } = await sharedTransport(session, { channel, attempts: [ATTEMPT] });
  const malformed = await new actors.ScriptedActor(transport, { responses: [] }).run({
    attemptRef: ATTEMPT, roleContract: { protocolSkillRef: 'x' }, taskSummary: 'x', requiredInfo: { scope: [], unknowns: [], terminalClaims: [] },
    idempotencyKeyPrefix: 'x', expectedContextRevision: 0,
  });
  assert.equal(malformed.refused, true);
  assert.equal(malformed.reason, 'MALFORMED_ACTOR');
  assert.equal(channel.sentSerializations.length, 0);
  session.close();
});

test('malformed actor scripts are refused typed (mutation: malformed-actor)', async () => {
  const session = await (await freshDatabase()).open();
  const { transport } = await sharedTransport(session, { attempts: [ATTEMPT] });
  const base = { attemptRef: ATTEMPT, roleContract: { protocolSkillRef: 'x' }, taskSummary: 'x', requiredInfo: { scope: [], unknowns: [], terminalClaims: [] }, idempotencyKeyPrefix: 'x', expectedContextRevision: 0 };
  const cases = [
    { responses: [] },
    { responses: [{ product: { digest: 'not-hex' } }] },
    { responses: [{ verdict: 'made-up-verdict' }] },
    { responses: [{ toolCalls: [{ args: ['x'] }] }] },
    {},
  ];
  for (const script of cases) {
    const outcome = await new actors.ScriptedActor(transport, script).run(base);
    assert.equal(outcome.refused, true, JSON.stringify(script));
    assert.equal(outcome.reason, 'MALFORMED_ACTOR', JSON.stringify(script));
  }
  const replay = await new actors.ReplayActor(transport, []).run(base);
  assert.equal(replay.refused, true);
  assert.equal(replay.reason, 'MALFORMED_ACTOR');
  session.close();
});

test('a multi-response script admits each request: mid-loop continuation over the in-memory store', async () => {
  // The frozen universe pins one admitted request per launch obligation in
  // the durable kernel; the transport-level mid-loop continuation (tool
  // results feeding the next request) is proven here with the WP-18
  // in-memory store - the SAME accountant, same receipt grammar.
  const { pins } = await admissionPins();
  const store = new envelope.InMemoryAttemptAdmissionStore([
    {
      attemptRef: ATTEMPT,
      contextRevision: 0,
      nextRequestOrdinal: 1,
      cumulativeInputTokens: 0,
      providerRoutePin: ROUTE_PIN_GLM47,
      promptBudgetProfileRef: 'content://prompt-budget-profiles/test',
      promptBudgetProfileDigest: 'sha256:' + sha256('profile'),
    },
  ]);
  const channel = new actors.ScriptedChannel();
  const transport = envelope.createAdmittingTransport({
    transportId: 'midloop',
    routePin: ROUTE_PIN_GLM47,
    maxOutputTokens: 4096,
    pins,
    store,
    channel,
    exposesMidLoopRequests: true,
  });
  const { runtime, authorLaunchKind } = await roleRuntime();
  const task = await taskManifest();
  const slot = runtime.resolveOnce(authorLaunchKind);
  const run = await new actors.ScriptedActor(transport, {
    responses: [
      { toolCalls: [{ name: 'run-command', args: ['npm run build'] }], nextRequestToolResults: ['exit=0 stdout=build-ok'] },
      { product: { digest: sha256('p'), description: 'built product' } },
    ],
  }).run({
    attemptRef: ATTEMPT,
    roleContract: slot.slot.contract,
    taskSummary: 'mid-loop',
    requiredInfo: task,
    idempotencyKeyPrefix: 'midloop',
    expectedContextRevision: 0,
  });
  assert.equal(run.ran, true, JSON.stringify(run));
  assert.equal(run.result.requestCount, 2, 'both requests admitted');
  assert.equal(run.result.receipts[0].requestOrdinal, 1);
  assert.equal(run.result.receipts[1].requestOrdinal, 2);
  assert.equal(channel.sentSerializations.length, 2);
  // The second request carried the tool results (the mid-loop shape).
  assert.match(channel.sentSerializations[1], /build-ok/);
  assert.ok(!channel.sentSerializations[0].includes('build-ok'));
});

test('an opaque transport (no mid-loop exposure) refuses fail-closed - EK-12', async () => {
  const { pins } = await admissionPins();
  const store = new envelope.InMemoryAttemptAdmissionStore([
    { attemptRef: ATTEMPT, contextRevision: 0, nextRequestOrdinal: 1, cumulativeInputTokens: 0, providerRoutePin: ROUTE_PIN_GLM47, promptBudgetProfileRef: 'content://x', promptBudgetProfileDigest: 'sha256:' + sha256('x') },
  ]);
  const channel = new actors.ScriptedChannel();
  const transport = envelope.createAdmittingTransport({
    transportId: 'opaque', routePin: ROUTE_PIN_GLM47, maxOutputTokens: 4096, pins, store, channel,
    exposesMidLoopRequests: false,
  });
  const { runtime, authorLaunchKind } = await roleRuntime();
  const slot = runtime.resolveOnce(authorLaunchKind);
  const outcome = await new actors.ScriptedActor(transport, { responses: [{ text: 'x' }] }).run({
    attemptRef: ATTEMPT, roleContract: slot.slot.contract, taskSummary: 'x',
    requiredInfo: await taskManifest(), idempotencyKeyPrefix: 'opaque', expectedContextRevision: 0,
  });
  assert.equal(outcome.refused, true);
  assert.match(outcome.detail, /OPAQUE_LOOP_NONCONFORMING/);
  assert.equal(channel.sentSerializations.length, 0, 'no unaccounted bytes reached the network');
});
