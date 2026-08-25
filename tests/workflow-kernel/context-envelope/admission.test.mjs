/**
 * admission.test.mjs - the CAS-fenced admission policy: advance-on-admit,
 * consume-nothing-on-refuse, stale-revision fences, exactly-one-CAS-success
 * under concurrency, idempotent replay and receipts-are-not-authority
 * (WP-18).
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

function newStore() {
  return new envelope.InMemoryAttemptAdmissionStore([testAttemptCounters()]);
}

/* ------------------------------------------------------------------ */
/* Admission: advance ordinal + cumulative, append receipt, obligate    */
/* ------------------------------------------------------------------ */

test('on admission: ordinal + cumulative + revision advance, an admitted receipt is appended and exactly one providerSend obligation is created', async () => {
  const store = newStore();
  const before = store.countersOf('attempt:test-1');
  const outcome = await envelope.admitProviderRequest(testPins(), store, {
    attemptRef: 'attempt:test-1',
    expectedContextRevision: 0,
    envelope: conformingEnvelope(),
    idempotencyKey: 'k-1',
  });
  assert.equal(outcome.kind, 'admitted');
  const { receipt, obligation, nextCounters } = outcome;
  assert.equal(receipt.decision, 'admitted');
  assert.equal(receipt.requestOrdinal, 1, 'the first admitted request gets ordinal 1');
  assert.equal(receipt.cumulativeInputTokensAfter, receipt.requestInputTokens);
  assert.ok(receipt.limitChecks.every((check) => check.pass));
  assert.deepEqual(receipt.omissions, [
    'recovery-history',
    'hook-context',
    'tool-results',
    'large-product-refs',
    'desk-reference',
    'patch-pointer',
  ]);
  // obligation:providerSend names the receipt digest and the ordinal
  assert.equal(obligation.kind, 'obligation:providerSend');
  assert.equal(obligation.requestOrdinal, 1);
  assert.equal(obligation.receiptDigest, receipt.digest);
  assert.equal(obligation.idempotencyKey, 'k-1');
  assert.match(obligation.envelopeDigest, /^sha256:[0-9a-f]{64}$/);
  // counters advanced exactly once
  assert.equal(nextCounters.contextRevision, before.contextRevision + 1);
  assert.equal(nextCounters.nextRequestOrdinal, 2);
  assert.equal(nextCounters.cumulativeInputTokens, receipt.requestInputTokens);
  assert.deepEqual(store.receiptsOf('attempt:test-1'), [receipt]);
});

test('a second admission at the advanced revision gets ordinal 2 and accumulates the session budget', async () => {
  const store = newStore();
  const first = await envelope.admitProviderRequest(testPins(), store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: conformingEnvelope(), idempotencyKey: 'k-1',
  });
  assert.equal(first.kind, 'admitted');
  const second = await envelope.admitProviderRequest(testPins(), store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 1, envelope: conformingEnvelope(), idempotencyKey: 'k-2',
  });
  assert.equal(second.kind, 'admitted');
  assert.equal(second.receipt.requestOrdinal, 2);
  assert.equal(second.receipt.cumulativeInputTokensAfter, first.receipt.requestInputTokens + second.receipt.requestInputTokens);
  assert.equal(store.countersOf('attempt:test-1').cumulativeInputTokens, second.receipt.cumulativeInputTokensAfter);
});

/* ------------------------------------------------------------------ */
/* Refusal: consume nothing, ever                                      */
/* ------------------------------------------------------------------ */

test('on refusal: the refused receipt persists the rejected-envelope digest + typed violation; counters do not advance; NO obligation exists', async () => {
  const store = newStore();
  const oversized = conformingEnvelope({ staticEach: 3, task: 10, workspace: 10, hook: 1 });
  const profile = testProfile({ maxDynamicTokens: 20 });
  const outcome = await envelope.admitProviderRequest({ profile, limitTable: testPins().limitTable }, store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: oversized, idempotencyKey: 'k-1',
  });
  assert.equal(outcome.kind, 'refused');
  const { receipt, violation, nextCounters } = outcome;
  assert.equal(violation, 'MAX_DYNAMIC_TOKENS_EXCEEDED');
  assert.equal(receipt.decision, 'refused');
  assert.equal(receipt.violation, 'MAX_DYNAMIC_TOKENS_EXCEEDED');
  assert.match(receipt.rejectedEnvelopeDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(receipt.cumulativeInputTokensAfter, 0, 'refusal consumes no cumulative budget');
  assert.equal(nextCounters.contextRevision, 0);
  assert.equal(nextCounters.nextRequestOrdinal, 1);
  // no provider-send obligation can exist for a refused envelope
  const record = await store.findAdmissionByIdempotencyKey('k-1');
  assert.ok(record);
  assert.equal(record.obligation, undefined);
  // the identical reissue yields the identical refusal (Elite-3 structural law)
  const again = await envelope.admitProviderRequest({ profile, limitTable: testPins().limitTable }, store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: oversized, idempotencyKey: 'k-again',
  });
  assert.equal(again.kind, 'refused');
  assert.equal(again.receipt.digest, receipt.digest);
  // and after the refusal, a conforming envelope at the SAME revision admits:
  // the deterministic refusal consumed no revision, no ordinal, no budget
  const after = await envelope.admitProviderRequest({ profile, limitTable: testPins().limitTable }, store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: conformingEnvelope(), idempotencyKey: 'k-2',
  });
  assert.equal(after.kind, 'admitted');
  assert.equal(after.receipt.requestOrdinal, 1);
});

test('the ordinal exhaustion refusal consumes nothing (no retry routing: the refusal is deterministic)', async () => {
  const store = newStore();
  const profile = testProfile({ maxProviderRequests: 1 });
  const first = await envelope.admitProviderRequest({ profile, limitTable: testPins().limitTable }, store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: conformingEnvelope(), idempotencyKey: 'k-1',
  });
  assert.equal(first.kind, 'admitted');
  const second = await envelope.admitProviderRequest({ profile, limitTable: testPins().limitTable }, store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 1, envelope: conformingEnvelope(), idempotencyKey: 'k-2',
  });
  assert.equal(second.kind, 'refused');
  assert.equal(second.violation, 'MAX_PROVIDER_REQUESTS_EXCEEDED');
  assert.equal(store.countersOf('attempt:test-1').nextRequestOrdinal, 2);
  assert.equal(store.countersOf('attempt:test-1').cumulativeInputTokens, first.receipt.requestInputTokens);
});

/* ------------------------------------------------------------------ */
/* CAS fences                                                          */
/* ------------------------------------------------------------------ */

test('a stale expectedContextRevision fails the command, consuming nothing (no receipt, no counter move)', async () => {
  const store = newStore();
  const stale = await envelope.admitProviderRequest(testPins(), store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 7, envelope: conformingEnvelope(), idempotencyKey: 'k-1',
  });
  assert.equal(stale.kind, 'stale-revision');
  assert.equal(stale.reason, 'STALE_EXPECTED_REVISION');
  assert.equal(stale.currentContextRevision, 0);
  assert.deepEqual(store.receiptsOf('attempt:test-1'), []);
  assert.equal(store.countersOf('attempt:test-1').contextRevision, 0);
});

test('two concurrent admissions at the same revision: EXACTLY one CAS success', async () => {
  const store = newStore();
  const run = (key) => envelope.admitProviderRequest(testPins(), store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: conformingEnvelope(), idempotencyKey: key,
  });
  // both commands interleave (the store is async): both read revision 0,
  // both decide, but the conditional commit serializes them.
  const [a, b] = await Promise.all([run('k-a'), run('k-b')]);
  const kinds = [a.kind, b.kind].sort();
  assert.deepEqual(kinds, ['admitted', 'stale-revision'], `exactly one wins, got ${kinds.join(',')}`);
  const admitted = a.kind === 'admitted' ? a : b;
  const stale = a.kind === 'admitted' ? b : a;
  assert.equal(stale.reason, 'STALE_EXPECTED_REVISION');
  // one admitted receipt, one ordinal, one cumulative charge
  const receipts = store.receiptsOf('attempt:test-1');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].decision, 'admitted');
  assert.equal(receipts[0].requestOrdinal, 1);
  const counters = store.countersOf('attempt:test-1');
  assert.equal(counters.contextRevision, 1);
  assert.equal(counters.nextRequestOrdinal, 2);
  assert.equal(counters.cumulativeInputTokens, admitted.receipt.requestInputTokens);
});

test('a concurrent admission racing a refusal still advances nothing twice', async () => {
  const store = newStore();
  const profile = testProfile({ maxDynamicTokens: 20 });
  const refusedRun = envelope.admitProviderRequest({ profile, limitTable: testPins().limitTable }, store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: conformingEnvelope({ hook: 1 }), idempotencyKey: 'k-ref',
  });
  const admittedRun = envelope.admitProviderRequest({ profile, limitTable: testPins().limitTable }, store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: conformingEnvelope(), idempotencyKey: 'k-adm',
  });
  const [refused, admitted] = await Promise.all([refusedRun, admittedRun]);
  // the admission wins the revision advance; the refusal either lands
  // before it (same revision, evidence-only) or loses the CAS - but no
  // counter ever moves twice and no refused outcome consumes anything.
  assert.equal(admitted.kind === 'admitted' || refused.kind === 'admitted', true);
  const counters = store.countersOf('attempt:test-1');
  assert.ok(counters.nextRequestOrdinal <= 2);
  assert.ok(counters.cumulativeInputTokens <= Math.max(
    admitted.kind === 'admitted' ? admitted.receipt.requestInputTokens : 0,
    refused.kind === 'admitted' ? refused.receipt.requestInputTokens : 0,
  ));
  for (const receipt of store.receiptsOf('attempt:test-1')) {
    if (receipt.decision === 'refused') {
      assert.equal(receipt.cumulativeInputTokensAfter, 0);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Idempotency (crash-window semantics, section 8 row 1)                */
/* ------------------------------------------------------------------ */

test('the same idempotency key replays the recorded outcome and never double-charges', async () => {
  const store = newStore();
  const first = await envelope.admitProviderRequest(testPins(), store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: conformingEnvelope(), idempotencyKey: 'same-key',
  });
  assert.equal(first.kind, 'admitted');
  const replay = await envelope.admitProviderRequest(testPins(), store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 1, envelope: conformingEnvelope(), idempotencyKey: 'same-key',
  });
  assert.equal(replay.kind, 'replayed');
  assert.equal(replay.receipt.digest, first.receipt.digest);
  assert.equal(replay.obligation?.requestOrdinal, 1);
  assert.equal(store.receiptsOf('attempt:test-1').length, 1);
  assert.equal(store.countersOf('attempt:test-1').cumulativeInputTokens, first.receipt.requestInputTokens);
});

test('a refused key replays the same refused receipt (the identical envelope cannot be reissued)', async () => {
  const store = newStore();
  const profile = testProfile({ maxDynamicTokens: 20 });
  const oversized = conformingEnvelope({ hook: 1 });
  const first = await envelope.admitProviderRequest({ profile, limitTable: testPins().limitTable }, store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: oversized, idempotencyKey: 'same-key',
  });
  assert.equal(first.kind, 'refused');
  const replay = await envelope.admitProviderRequest({ profile, limitTable: testPins().limitTable }, store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: oversized, idempotencyKey: 'same-key',
  });
  assert.equal(replay.kind, 'replayed');
  assert.equal(replay.receipt.decision, 'refused');
  assert.equal(replay.obligation, undefined);
});

/* ------------------------------------------------------------------ */
/* Receipts are evidence, never counter authority                      */
/* ------------------------------------------------------------------ */

test('counters come from the CAS-fenced attempt state, never from receipt sums', async () => {
  const store = newStore();
  const first = await envelope.admitProviderRequest(testPins(), store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 0, envelope: conformingEnvelope(), idempotencyKey: 'k-1',
  });
  assert.equal(first.kind, 'admitted');
  // tamper the evidence log directly (bypassing the sole writer): a fake
  // admitted receipt must not move any counter nor the next admission math
  const fake = envelope.sealReceipt({
    ...first.receipt,
    decision: 'admitted',
    requestInputTokens: 999999,
    cumulativeInputTokensAfter: 999999,
    violation: undefined,
    violationDetail: undefined,
    rejectedEnvelopeDigest: undefined,
  });
  store.receiptsOf('attempt:test-1').push(fake);
  const countersBefore = store.countersOf('attempt:test-1');
  assert.notEqual(countersBefore.cumulativeInputTokens, 999999);
  const second = await envelope.admitProviderRequest(testPins(), store, {
    attemptRef: 'attempt:test-1', expectedContextRevision: 1, envelope: conformingEnvelope(), idempotencyKey: 'k-2',
  });
  assert.equal(second.kind, 'admitted');
  assert.equal(second.receipt.cumulativeInputTokensAfter, countersBefore.cumulativeInputTokens + second.receipt.requestInputTokens);
  assert.equal(store.countersOf('attempt:test-1').cumulativeInputTokens, second.receipt.cumulativeInputTokensAfter);
});
