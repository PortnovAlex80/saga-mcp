/**
 * consumer.test.mjs - the stateless obligation consumer protocol (WP-07,
 * plan phase EK-4): frontier claim discipline, CAS lease exclusivity, fence
 * loss, typed unresolvability, idempotent re-drive, empty-queue idleness and
 * the no-busy-spin bound.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const consumer = await import('../../../dist/workflow-kernel/application/obligation-consumer.js');
const { FaultScheduler } = await import('../../../dist/workflow-kernel/application/faults.js');
const { driveVertical, freshDatabase, normalizedWorld, EXTERNAL_INPUTS, LIMITS, envelopeOf } = await import('./driver.mjs');

const configOf = (faults) => ({ externalEvidence: EXTERNAL_INPUTS, faults });

test('obligations complete only in the transaction of their target result: completed_by_key binds one consume key to one event', () => {
  const db = freshDatabase('ek-wp07-consume-');
  const session = db.open();
  try {
    driveVertical(session, { faults: FaultScheduler.observing() });
    const rows = session.db
      .prepare(
        "SELECT o.kind, o.target, o.state, o.completed_by_key, o.completed_at_sequence, e.transition AS event_transition, e.sequence AS event_sequence" +
          " FROM transition_obligation o LEFT JOIN workflow_event e ON e.sequence = o.completed_at_sequence WHERE o.state = 'completed' ORDER BY o.id",
      )
      .all();
    assert.ok(rows.length >= 18, `the vertical completed its obligations (${rows.length})`);
    for (const row of rows) {
      assert.ok(row.completed_by_key.startsWith('consume:'), `${row.kind}: completed by a consumer key`);
      // The eventless transport send has no event row; every other completion
      // shares its sequence with the exact target-command event.
      if (row.event_transition !== null) {
        assert.equal(row.event_transition, row.target, `${row.kind}: the completion sequence IS the target command's event`);
      } else {
        assert.equal(row.target, 'cognition.sendProviderRequest', `${row.kind}: only the eventless transport boundary completes without an event`);
      }
    }
  } finally {
    session.close();
  }
});

test('two consumers cannot both own one obligation: the rival commit wins, the loser is refused, exactly one fact commits', () => {
  const db = freshDatabase('ek-wp07-race-');
  const sessionA = db.open();
  const sessionB = db.open();
  try {
    driveVertical(sessionA, { faults: FaultScheduler.observing(), stopAfter: 'worker-return-1' });
    // Both consumers claim the same open submitContribution obligation.
    const claimA = consumer.openFrontier(sessionA).find((entry) => entry.kind === 'obligation:submitContribution');
    const claimB = consumer.openFrontier(sessionB).find((entry) => entry.kind === 'obligation:submitContribution');
    assert.ok(claimA?.claim && claimB?.claim, 'both sessions see the one open obligation');

    // Consumer B commits first (wins the CAS lease transactionally).
    const byB = consumer.consumeClaim(sessionB, claimB.claim, {}, configOf());
    assert.equal(byB.status, 'committed');

    // Consumer A's stale claim cannot complete: the fence is lost.
    const byA = consumer.consumeClaim(sessionA, claimA.claim, {}, configOf());
    assert.equal(byA.status, 'refused', 'the stale consumer is refused');
    assert.ok(byA.fenceLost === true || byA.refusal.reason === 'ILLEGAL_TRANSITION', `typed refusal (${byA.refusal.reason}: ${byA.refusal.detail})`);

    const world = sessionA.hydrateWorld({ externalEvidence: EXTERNAL_INPUTS }).world;
    assert.equal(world.events.filter((event) => event.transition === 'workplace.recordContribution').length, 1, 'exactly one contribution fact');
    const completed = world.obligations.filter((obligation) => obligation.kind === 'obligation:submitContribution' && obligation.state === 'completed');
    assert.equal(completed.length, 1, 'the obligation completed exactly once');
  } finally {
    sessionA.close();
    sessionB.close();
  }
});

test('a stale consumer cannot complete after its fence is lost (admission window)', () => {
  const db = freshDatabase('ek-wp07-stale-');
  const sessionA = db.open();
  const sessionB = db.open();
  try {
    driveVertical(sessionA, { faults: FaultScheduler.observing(), stopAfter: 'create-attempt-1' });
    const claimA = consumer.openFrontier(sessionA).find((entry) => entry.kind === 'obligation:launchAdmission');
    assert.ok(claimA?.claim, 'the launch admission obligation is claimable');

    // The rival consumer admits first: the attempt head and counters move.
    const byB = consumer.consumeClaim(
      sessionB,
      consumer.openFrontier(sessionB).find((entry) => entry.kind === 'obligation:launchAdmission').claim,
      { admission: { envelope: envelopeOf('activity-attempt:1'), limits: LIMITS } },
      configOf(),
    );
    assert.equal(byB.status, 'committed');

    // The stale consumer cannot admit or complete a second time.
    const byA = consumer.consumeClaim(sessionA, claimA.claim, { admission: { envelope: envelopeOf('activity-attempt:1'), limits: LIMITS } }, configOf());
    assert.equal(byA.status, 'refused');
    assert.equal(byA.fenceLost, true, 'the fence loss is reported');
    assert.equal(byA.refusal.reason, 'STALE_EXPECTED_REVISION');

    const receipts = sessionA.db.prepare('SELECT COUNT (*) AS n FROM activity_attempt_prompt_assembly_receipt').get().n;
    assert.equal(receipts, 1, 'exactly one admitted receipt exists');
    const counters = sessionA.activityAttempt.loadContextCounters('activity-attempt:1');
    assert.equal(counters.nextRequestOrdinal, 1);
    assert.equal(counters.contextRevision, 1);
  } finally {
    sessionA.close();
    sessionB.close();
  }
});

test('an obligation without a durable target-instance binding is typed-unresolvable, never guessed', () => {
  const db = freshDatabase('ek-wp07-unresolvable-');
  const session = db.open();
  try {
    driveVertical(session, { faults: FaultScheduler.observing() });
    const frontier = consumer.openFrontier(session);
    const cross = frontier.find((entry) => entry.kind === 'obligation:completeCellNode');
    assert.ok(cross !== undefined, 'the cross-aggregate cell completion obligation is on the frontier');
    assert.ok(cross.refusal !== undefined, 'it has no claim');
    assert.equal(cross.refusal.reason, 'MISSING_EVIDENCE');
    assert.match(cross.refusal.detail, /no durable target-instance binding/);
  } finally {
    session.close();
  }
});

test('empty queue is idle: no progress, no proof, nothing written', () => {
  const db = freshDatabase('ek-wp07-idle-');
  const session = db.open();
  try {
    const before = session.counts();
    const result = consumer.runUntilIdle(session, configOf());
    assert.equal(result.status, 'idle');
    assert.equal(result.consumed, 0);
    assert.deepEqual(session.counts(), before, 'an empty frontier wrote nothing');
    assert.equal(session.db.prepare('SELECT COUNT (*) AS n FROM terminal_proof').get().n, 0, 'an empty queue is never a proof');
    assert.deepEqual(consumer.claimNextObligation(session), { idle: true, openCount: 0 });
  } finally {
    session.close();
  }
});

test('no busy-spin: a blocked lane attempts each refusing obligation once per round and stops typed', () => {
  const db = freshDatabase('ek-wp07-spin-');
  const session = db.open();
  try {
    driveVertical(session, { faults: FaultScheduler.observing() });
    const observing = FaultScheduler.observing();
    const result = consumer.runUntilIdle(session, configOf(observing));
    assert.equal(result.status, 'blocked', 'the dead obligations block the lane');
    assert.equal(result.consumed, 0, 'nothing new committed');
    // Exactly one consume attempt per refusing frontier obligation - the
    // bound against busy-spin (no timers, no repeated retries).
    assert.equal(observing.count('before-durable-write'), 3, 'three refusing obligations, three attempts, then the run stops');
    assert.ok(result.refusals.length === 3, 'the typed refusals are reported');
    assert.ok(result.unresolved.some((entry) => entry.kind === 'obligation:completeCellNode'), 'the unresolvable obligation is reported');
    // A second identical run performs the same bounded attempts, nothing more.
    const second = FaultScheduler.observing();
    const again = consumer.runUntilIdle(session, configOf(second));
    assert.equal(again.status, 'blocked');
    assert.equal(second.count('before-durable-write'), 3, 'the second run is equally bounded (idempotent quiet)');
  } finally {
    session.close();
  }
});

test('the driver is idempotent over a settled world: a full re-drive changes nothing', () => {
  const db = freshDatabase('ek-wp07-redrive-');
  const session = db.open();
  try {
    driveVertical(session, { faults: FaultScheduler.observing() });
    const settled = normalizedWorld(session);
    driveVertical(session, { faults: FaultScheduler.observing() });
    assert.deepEqual(normalizedWorld(session), settled, 'the second full drive is a no-op (stateless over durable facts)');
  } finally {
    session.close();
  }
});
