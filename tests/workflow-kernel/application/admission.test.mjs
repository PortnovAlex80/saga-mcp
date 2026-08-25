/**
 * admission.test.mjs - the ActivityAttempt context-admission CAS command
 * (WP-07, plan phase EK-4): atomic receipt + provider-send obligation +
 * counter update, CAS exclusivity at one context revision, deterministic
 * budget rejection (identical request refused again, no budget consumed),
 * fail-closed limits, and the crash-before-send redrive of the SAME
 * obligation + ordinal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const admission = await import('../../../dist/workflow-kernel/application/admission.js');
const { FaultScheduler } = await import('../../../dist/workflow-kernel/application/faults.js');
const { driveVertical, freshDatabase, LIMITS, envelopeOf, EXTERNAL_INPUTS } = await import('./driver.mjs');

const ATTEMPT = 'activity-attempt:1';

/** Stage a world ending at a chosen vertical step (default: attempt created). */
function stagedAttempt(stopAfter = 'create-attempt-1') {
  const db = freshDatabase('ek-wp07-admit-');
  const session = db.open();
  driveVertical(session, { faults: FaultScheduler.observing(), stopAfter });
  return { db, session };
}

test('admission commits receipt + provider-send obligation + counter update in one transaction', () => {
  const { session } = stagedAttempt();
  try {
    const before = session.counts();
    const result = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: LIMITS,
      idempotencyKey: 'admit:test:1',
    });
    assert.equal(result.status, 'admitted');
    assert.equal(result.replayed, false);
    assert.equal(result.requestOrdinal, 1);

    const counters = session.activityAttempt.loadContextCounters(ATTEMPT);
    assert.deepEqual(counters, { contextRevision: 1, nextRequestOrdinal: 1, cumulativeInputTokens: 5000 }, 'all three counters advanced atomically');
    const receipts = session.db.prepare('SELECT admission, request_ordinal, expected_context_revision, digest FROM activity_attempt_prompt_assembly_receipt').all();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].admission, 'admitted', 'the receipt records admitted - never sent');
    assert.equal(receipts[0].request_ordinal, 1);
    assert.equal(receipts[0].expected_context_revision, 0);
    const send = session.db.prepare("SELECT COUNT (*) AS n FROM transition_obligation WHERE kind = 'obligation:providerSend' AND state = 'open'").get().n;
    assert.equal(send, 1, 'the exact provider-send obligation was created in the same transaction');
    assert.equal(session.counts().events, before.events + 1, 'exactly one event committed');
  } finally {
    session.close();
  }
});

test('two concurrent admissions at one context revision: exactly one passes, the loser never admits a second ordinal', () => {
  const { session } = stagedAttempt();
  try {
    const first = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: LIMITS,
      idempotencyKey: 'admit:race:A',
    });
    assert.equal(first.status, 'admitted');

    const second = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: LIMITS,
      idempotencyKey: 'admit:race:B',
    });
    // The loser is never admitted: while the first send obligation is open,
    // the only lawful answer is to redrive the SAME obligation + ordinal.
    assert.equal(second.status, 'redrive');
    assert.equal(second.requestOrdinal, 1);
    assert.equal(second.providerSendObligationKey, 'admit:race:A#obligation:providerSend');

    const receipts = session.db.prepare('SELECT COUNT (*) AS n FROM activity_attempt_prompt_assembly_receipt').get().n;
    assert.equal(receipts, 1, 'exactly one receipt');
    const counters = session.activityAttempt.loadContextCounters(ATTEMPT);
    assert.deepEqual([counters.contextRevision, counters.nextRequestOrdinal], [1, 1], 'the counters moved exactly once');
  } finally {
    session.close();
  }
});

test('a deterministic budget rejection consumes nothing and the identical request is refused again', () => {
  const { session } = stagedAttempt();
  try {
    const oversized = envelopeOf(ATTEMPT, 150000); // > maxTotalInputTokens (120000)
    const before = session.counts();
    const rejected = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: oversized,
      limits: LIMITS,
      idempotencyKey: 'admit:oversized:1',
    });
    assert.equal(rejected.status, 'refused');
    assert.equal(rejected.reason, 'REQUEST_OVER_TOTAL_LIMIT');
    assert.deepEqual(session.counts(), before, 'the rejection committed nothing');
    assert.deepEqual(session.activityAttempt.loadContextCounters(ATTEMPT), { contextRevision: 0, nextRequestOrdinal: 0, cumulativeInputTokens: 0 }, 'no context consumed');

    // The IDENTICAL request after the deterministic rejection: refused again.
    const identical = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: oversized,
      limits: LIMITS,
      idempotencyKey: 'admit:oversized:2',
    });
    assert.equal(identical.status, 'refused');
    assert.equal(identical.reason, 'REQUEST_OVER_TOTAL_LIMIT');

    // The rejection charged no budget: a lawful envelope still admits at ordinal 1.
    const lawful = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: LIMITS,
      idempotencyKey: 'admit:lawful:1',
    });
    assert.equal(lawful.status, 'admitted');
    assert.equal(lawful.requestOrdinal, 1);
  } finally {
    session.close();
  }
});

test('cumulative session budget and request-ordinal exhaustion are deterministic typed refusals', () => {
  // Stage past the first send so no provider-send obligation is open: the
  // second admission reaches the deterministic budget evaluation.
  const { session } = stagedAttempt('provider-send-1');
  try {
    assert.deepEqual(session.activityAttempt.loadContextCounters(ATTEMPT), { contextRevision: 1, nextRequestOrdinal: 1, cumulativeInputTokens: 5000 });
    const tightLimits = { ...LIMITS, maxCumulativeSessionInputTokens: 6000 };
    const second = admission.admitProviderRequest(session, { attemptInstanceId: ATTEMPT, envelope: envelopeOf(ATTEMPT, 5000), limits: tightLimits, idempotencyKey: 'admit:cu:2' });
    assert.equal(second.status, 'refused');
    assert.equal(second.reason, 'CUMULATIVE_OVER_LIMIT');
    assert.equal(session.activityAttempt.loadContextCounters(ATTEMPT).cumulativeInputTokens, 5000, 'the refused request added nothing');

    const oneShot = { ...LIMITS, maxProviderRequests: 1 };
    const exhausted = admission.admitProviderRequest(session, { attemptInstanceId: ATTEMPT, envelope: envelopeOf(ATTEMPT, 100), limits: oneShot, idempotencyKey: 'admit:ex:2' });
    assert.equal(exhausted.status, 'refused');
    assert.equal(exhausted.reason, 'REQUEST_ORDINAL_EXHAUSTED');
  } finally {
    session.close();
  }
});

test('zero, missing and over-reserved limits fail closed (never unlimited)', () => {
  const { session } = stagedAttempt();
  try {
    const zero = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: { ...LIMITS, maxTotalInputTokens: 0 },
      idempotencyKey: 'admit:zero:1',
    });
    assert.equal(zero.status, 'refused');
    assert.equal(zero.reason, 'LIMITS_INVALID');

    const { maxTotalInputTokens: _missing, ...withoutTotal } = LIMITS;
    const missing = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: withoutTotal,
      idempotencyKey: 'admit:missing:1',
    });
    assert.equal(missing.status, 'refused');
    assert.equal(missing.reason, 'LIMITS_INVALID');

    const overReserved = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: { ...LIMITS, reservedOutputTokens: 190000, providerOverheadReserveTokens: 5000, safetyMarginTokens: 5000 },
      idempotencyKey: 'admit:over:1',
    });
    assert.equal(overReserved.status, 'refused');
    assert.equal(overReserved.reason, 'LIMITS_INVALID');
    assert.deepEqual(session.activityAttempt.loadContextCounters(ATTEMPT), { contextRevision: 0, nextRequestOrdinal: 0, cumulativeInputTokens: 0 });
  } finally {
    session.close();
  }
});

test('crash before send redrives the SAME provider-send obligation and ordinal, never a new admission', () => {
  const { session } = stagedAttempt();
  try {
    const first = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: LIMITS,
      idempotencyKey: 'admit:redrive:1',
    });
    assert.equal(first.status, 'admitted');

    // The process "restarts" and the caller asks to admit again: the open
    // provider-send obligation redrives the SAME ordinal.
    const redrive = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: LIMITS,
      idempotencyKey: 'admit:redrive:2',
    });
    assert.equal(redrive.status, 'redrive');
    assert.equal(redrive.requestOrdinal, 1, 'the SAME ordinal');
    assert.equal(redrive.providerSendObligationKey, 'admit:redrive:1#obligation:providerSend', 'the SAME obligation');

    const receipts = session.db.prepare('SELECT COUNT (*) AS n FROM activity_attempt_prompt_assembly_receipt').get().n;
    assert.equal(receipts, 1, 'no second receipt was committed');
    assert.deepEqual(session.activityAttempt.loadContextCounters(ATTEMPT), { contextRevision: 1, nextRequestOrdinal: 1, cumulativeInputTokens: 5000 });
  } finally {
    session.close();
  }
});

test('a replayed admission key replays the recorded outcome instead of committing twice', () => {
  const { session } = stagedAttempt();
  try {
    const first = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: LIMITS,
      idempotencyKey: 'admit:replay:1',
    });
    assert.equal(first.status, 'admitted');
    assert.equal(first.replayed, false);
    const replay = admission.admitProviderRequest(session, {
      attemptInstanceId: ATTEMPT,
      envelope: envelopeOf(ATTEMPT),
      limits: LIMITS,
      idempotencyKey: 'admit:replay:1',
    });
    // The open provider-send obligation from the first admission makes the
    // identical re-submission a redrive of the same ordinal.
    assert.equal(replay.status, 'redrive');
    assert.equal(session.db.prepare('SELECT COUNT (*) AS n FROM activity_attempt_prompt_assembly_receipt').get().n, 1);
  } finally {
    session.close();
  }
});

test('envelope evaluation is a pure deterministic function (no DB, no clock)', () => {
  const counters = { nextRequestOrdinal: 0, cumulativeInputTokens: 0 };
  assert.deepEqual(admission.evaluateEnvelope(counters, LIMITS, envelopeOf('x', 1000)), { admitted: true });
  assert.equal(admission.evaluateEnvelope(counters, LIMITS, envelopeOf('x', 120001)).admitted, false);
  assert.equal(admission.evaluateEnvelope(counters, { ...LIMITS, providerContextLimitTokens: 20000 }, envelopeOf('x', 3000)).admitted, false);
  assert.equal(admission.effectiveInputLimit(LIMITS), 180000);
  assert.equal(admission.validateLimits(LIMITS), undefined);
});
