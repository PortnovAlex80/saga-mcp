/**
 * transport.test.mjs - the cognition transport contract: admission at the
 * EXACT pre-send boundary, EK-12 fail-closed refusals (no network), the
 * output-reservation law and the three crash windows of section 8 incl. the
 * D12 operator-disposition law (WP-18).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  conformingEnvelope,
  envelope,
  testAttemptCounters,
  testPins,
  testProfile,
} from './support.mjs';

/** Recording channel: captures every network call in order. */
function recordingChannel(behavior = () => ({ status: 'delivered', outcomeDigest: 'sha256:outcome' })) {
  const calls = [];
  return {
    calls,
    async send(input) {
      calls.push(input);
      const result = behavior(input, calls.length);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function newTransport(options = {}) {
  const {
    exposesMidLoopRequests = true,
    maxOutputTokens = 4096,
    channel = recordingChannel(),
    profile = testProfile(),
    counters = testAttemptCounters(),
  } = options;
  const store = new envelope.InMemoryAttemptAdmissionStore([counters]);
  const transport = envelope.createAdmittingTransport({
    transportId: 'cognition-transport:test',
    routePin: counters.providerRoutePin,
    maxOutputTokens,
    pins: { profile, limitTable: testPins().limitTable },
    store,
    channel,
    exposesMidLoopRequests,
  });
  return { transport, store, channel };
}

/* ------------------------------------------------------------------ */
/* The exact pre-send boundary                                         */
/* ------------------------------------------------------------------ */

test('happy path: admission at the boundary, then exactly one network call with the counted bytes', async () => {
  const { transport, store, channel } = newTransport();
  const result = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope(),
    idempotencyKey: 'send-1',
  });
  assert.equal(result.kind, 'delivered');
  assert.equal(result.receipt.decision, 'admitted');
  assert.equal(result.obligation.requestOrdinal, 1);
  assert.equal(channel.calls.length, 1);
  // the channel received EXACTLY the canonical serialization the accountant counted
  const ordered = envelope.normalizeEnvelopeLayers(conformingEnvelope().layers);
  assert.equal(channel.calls[0].serialized, envelope.serializeEnvelopeLayers(ordered.ordered));
  assert.equal(channel.calls[0].maxOutputTokens, 4096);
  assert.equal(store.receiptsOf('attempt:test-1').length, 1);
});

test('an oversized hook context is refused by its exact next pre-send receipt WITHOUT reaching the network (EK-12 preflight)', async () => {
  const { transport, channel } = newTransport({ profile: testProfile({ maxDynamicTokens: 20 }) });
  const oversizedHook = conformingEnvelope({ hook: 1 }); // dynamic 21 > 20
  const result = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: oversizedHook,
    idempotencyKey: 'send-1',
  });
  assert.equal(result.kind, 'refused');
  assert.equal(result.refusal.kind, 'ADMISSION_REFUSED');
  assert.equal(result.refusal.receipt.decision, 'refused');
  assert.ok(result.refusal.detail.includes('MAX_DYNAMIC_TOKENS_EXCEEDED'));
  assert.equal(channel.calls.length, 0, 'no byte reached the network');
});

test('an oversized retained tool result is refused pre-send without reaching the network (EK-12 preflight)', async () => {
  const { transport, channel } = newTransport({ profile: testProfile({ maxToolResultTokens: 5 }) });
  const result = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope({ toolResults: 6 }),
    idempotencyKey: 'send-1',
  });
  assert.equal(result.kind, 'refused');
  assert.equal(result.refusal.kind, 'ADMISSION_REFUSED');
  assert.ok(result.refusal.detail.includes('MAX_TOOL_RESULT_TOKENS_EXCEEDED'));
  assert.equal(channel.calls.length, 0);
});

test('an opaque loop that cannot expose every final request fails closed (nonconforming, no middle ground)', async () => {
  const { transport, channel } = newTransport({ exposesMidLoopRequests: false });
  const result = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope(),
    idempotencyKey: 'send-1',
  });
  assert.equal(result.kind, 'refused');
  assert.equal(result.refusal.kind, 'OPAQUE_LOOP_NONCONFORMING');
  assert.equal(channel.calls.length, 0);
});

test('the transport enforces maxOutputTokens <= reservedOutputTokens or refuses the provider/model', async () => {
  const { transport, channel } = newTransport({ maxOutputTokens: 8193 }); // reserved = 8192
  const result = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope(),
    idempotencyKey: 'send-1',
  });
  assert.equal(result.kind, 'refused');
  assert.equal(result.refusal.kind, 'OUTPUT_RESERVATION_EXCEEDED');
  assert.equal(channel.calls.length, 0);
  // the same law holds inside the boundary gate for direct callers
  const { transport: conforming } = newTransport();
  const ordered = envelope.normalizeEnvelopeLayers(conformingEnvelope().layers);
  const serialized = envelope.serializeEnvelopeLayers(ordered.ordered);
  const gate = envelope.enforcePreSendBoundary(testProfile(), {
    decision: 'admitted',
    layerDigests: ordered.ordered.map((l) => envelope.layerDigestOf(l)),
    layerNames: ordered.ordered.map((l) => l.layer),
    serializedRequestBytes: Buffer.byteLength(serialized, 'utf8'),
  }, conformingEnvelope(), serialized, { maxOutputTokens: 8193 });
  assert.equal(gate.ok, false);
  assert.equal(gate.refusal.kind, 'OUTPUT_RESERVATION_EXCEEDED');
});

test('serializeAdmittedEnvelope verifies the admitted receipt digests and byte count (send must carry exactly the admitted bytes)', async () => {
  const { transport } = newTransport();
  const admitted = await transport.admitProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope(),
    idempotencyKey: 'send-1',
  });
  assert.equal(admitted.kind, 'admitted');
  // the admitted envelope serializes cleanly
  const ok = transport.serializeAdmittedEnvelope(conformingEnvelope(), admitted.receipt);
  assert.equal(ok.serialized !== undefined, true);
  // a DIFFERENT envelope cannot ride the same receipt
  const tampered = conformingEnvelope({ task: 11 });
  const refusal = transport.serializeAdmittedEnvelope(tampered, admitted.receipt);
  assert.equal(refusal.refused, true);
  assert.equal(refusal.kind, 'ENVELOPE_DIGEST_MISMATCH');
  // a refused receipt can never authorize serialization
  const { transport: refusing } = newTransport({ profile: testProfile({ maxDynamicTokens: 20 }) });
  const refused = await refusing.admitProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope({ hook: 1 }),
    idempotencyKey: 'send-x',
  });
  assert.equal(refused.kind, 'refused');
  const gate = envelope.enforcePreSendBoundary(testProfile(), refused.receipt, conformingEnvelope({ hook: 1 }), '[]', { maxOutputTokens: 4096 });
  assert.equal(gate.ok, false);
  assert.equal(gate.refusal.kind, 'UNADMITTED_REQUEST');
});

/* ------------------------------------------------------------------ */
/* Crash windows (section 8, exact)                                    */
/* ------------------------------------------------------------------ */

test('crash BEFORE the admission commit: nothing persisted, re-running admission from scratch succeeds', async () => {
  const { transport } = newTransport();
  // nothing was committed yet; a redrive of an unknown obligation fails closed
  const redrive = await transport.redriveProviderSend('never-admitted');
  assert.equal(redrive.kind, 'refused');
  assert.equal(redrive.refusal.kind, 'UNKNOWN_OBLIGATION');
  // re-run from scratch: fresh admission, fresh ordinal 1
  const result = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope(),
    idempotencyKey: 'send-1',
  });
  assert.equal(result.kind, 'delivered');
  assert.equal(result.obligation.requestOrdinal, 1);
});

test('crash AFTER the admission commit, BEFORE send: the SAME obligation + ordinal are redriven; admission is NOT re-run; nothing is re-charged', async () => {
  const crash = new Error('process died before the network send');
  let calls = 0;
  const channel = recordingChannel(() => {
    calls += 1;
    return calls === 1 ? crash : { status: 'delivered', outcomeDigest: 'sha256:redrived' };
  });
  const { transport, store } = newTransport({ channel });
  const first = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope(),
    idempotencyKey: 'send-1',
  });
  assert.equal(first.kind, 'channel-error');
  assert.equal(first.redrive, 'same-obligation-same-ordinal');
  const countersAfterAdmission = store.countersOf('attempt:test-1');
  // the redrive: same obligation key, same ordinal, NO new admission
  const redrived = await transport.redriveProviderSend('send-1');
  assert.equal(redrived.kind, 'delivered');
  assert.equal(redrived.obligation.requestOrdinal, first.obligation.requestOrdinal);
  assert.equal(redrived.obligation.receiptDigest, first.obligation.receiptDigest);
  assert.equal(store.receiptsOf('attempt:test-1').length, 1, 'no new receipt on redrive');
  const countersAfterRedrive = store.countersOf('attempt:test-1');
  assert.deepEqual(countersAfterRedrive, countersAfterAdmission, 'no re-charge: cumulative + ordinal + revision unchanged');
  assert.equal(channel.calls.length, 2, 'the second attempt did reach the network');
});

test('crash AFTER a non-idempotent send with unknown outcome: TypedWait:effect-uncertainty, operator disposition required, duplicate blocked (D12)', async () => {
  const channel = recordingChannel(() => ({ status: 'unknown' }));
  const { transport, channel: recorded } = newTransport({ channel });
  const first = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope(),
    idempotencyKey: 'send-1',
  });
  assert.equal(first.kind, 'effect-uncertainty');
  assert.equal(first.waitKind, 'TypedWait:effect-uncertainty');
  assert.equal(first.disposition, 'operator-disposition-command-required');
  // D12: never an automatic duplicate of a non-idempotent external send
  const duplicate = await transport.redriveProviderSend('send-1');
  assert.equal(duplicate.kind, 'refused');
  assert.equal(duplicate.refusal.kind, 'SEND_UNCERTAIN_DUPLICATE_BLOCKED');
  assert.equal(recorded.calls.length, 1, 'exactly one network send ever happened');
});

test('a stale admission (CAS lost) never reaches the network', async () => {
  const { transport, channel } = newTransport();
  const result = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 9, // the attempt is at revision 0
    envelope: conformingEnvelope(),
    idempotencyKey: 'send-1',
  });
  assert.equal(result.kind, 'refused');
  assert.equal(result.refusal.kind, 'ADMISSION_STALE');
  assert.equal(channel.calls.length, 0);
});

test('an idempotent re-send after delivery replays without a second admission or a second network call', async () => {
  const { transport, store, channel } = newTransport();
  const first = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope(),
    idempotencyKey: 'send-1',
  });
  assert.equal(first.kind, 'delivered');
  const replay = await transport.redriveProviderSend('send-1');
  assert.equal(replay.kind, 'delivered');
  assert.equal(replay.obligation.requestOrdinal, first.obligation.requestOrdinal);
  assert.equal(store.receiptsOf('attempt:test-1').length, 1);
  assert.equal(channel.calls.length, 1);
});

test('the mid-loop continuation after a tool result goes through the SAME boundary: second request, ordinal 2, cumulative accumulates', async () => {
  const { transport, store, channel } = newTransport();
  const firstEnvelope = conformingEnvelope({ toolResults: 0 });
  const first = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: firstEnvelope, idempotencyKey: 'send-1',
  });
  assert.equal(first.kind, 'delivered');
  // mid-loop: the tool result is now retained and carried into the next request
  const secondEnvelope = conformingEnvelope({ toolResults: 5 });
  const second = await transport.sendProviderRequest({
    attemptRef: 'attempt:test-1', expectedContextRevision: 1, envelope: secondEnvelope, idempotencyKey: 'send-2',
  });
  assert.equal(second.kind, 'delivered');
  assert.equal(second.obligation.requestOrdinal, 2);
  assert.equal(second.receipt.cumulativeInputTokensAfter, first.receipt.requestInputTokens + second.receipt.requestInputTokens);
  assert.equal(channel.calls.length, 2);
  const receipts = store.receiptsOf('attempt:test-1');
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every((receipt) => receipt.decision === 'admitted'));
});
