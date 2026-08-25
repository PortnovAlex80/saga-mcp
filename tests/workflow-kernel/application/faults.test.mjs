/**
 * faults.test.mjs - the EK-4 crash matrix (WP-07, plan phase EK-4):
 * every fault point, executed with restart, settles to the IDENTICAL
 * normalized logical outcome as the clean run (exactly-once), including the
 * three named crash windows:
 *   - after admission / before send,
 *   - after send / before outcome,
 *   - after outcome / before obligation completion.
 * Restart is modeled truthfully: the crashed session is closed, the SAME
 * database file is reopened read-write through the exact-version open, and
 * the stateless driver re-derives every step from durable rows.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const { FAULT_POINTS, FaultScheduler, FaultCrashError } = await import('../../../dist/workflow-kernel/application/faults.js');
const { driveVertical, freshDatabase, normalizedWorld, EXTERNAL_INPUTS } = await import('./driver.mjs');

/** The clean-run golden snapshot (computed once; deterministic by construction). */
function goldenRun() {
  const db = freshDatabase('ek-wp07-golden-');
  const session = db.open();
  try {
    driveVertical(session, { faults: FaultScheduler.observing() });
    return normalizedWorld(session);
  } finally {
    session.close();
  }
}

/** Count the immutable admitted receipts (exactly-once admission evidence). */
function receiptCount(session) {
  return session.db.prepare('SELECT COUNT (*) AS n FROM activity_attempt_prompt_assembly_receipt').get().n;
}

test('the clean vertical settles: workplace terminal proof, both attempts admitted exactly once', () => {
  const golden = goldenRun();
  assert.equal(golden.sequence, 32, '32 committed command applications');
  const workplace = golden.heads.find((head) => head.instanceId === 'workplace:1');
  assert.equal(workplace.status, 'terminal');
  assert.equal(workplace.terminal, 'TerminalProof:workplace.success');
  assert.deepEqual(
    golden.proofs.map((proof) => proof.id).sort(),
    ['TerminalProof:cell.success', 'TerminalProof:workplace.success'],
    'the exact terminal proof set of the vertical',
  );
  assert.equal(golden.events.filter((event) => event.transition === 'activityAttempt.admitProviderRequest').length, 2);
  assert.equal(golden.events.filter((event) => event.transition === 'cognition.sendProviderRequest').length, 0, 'the transport send is eventless (universe-faithful)');
});

test('every fault point, executed with restart, settles to the identical exactly-once outcome', () => {
  const golden = goldenRun();
  for (const point of FAULT_POINTS) {
    const db = freshDatabase(`ek-wp07-crash-${point.replace(/[^a-z-]/g, '')}-`);
    const session = db.open();
    let crashed = null;
    try {
      try {
        driveVertical(session, { faults: new FaultScheduler(point) });
      } catch (error) {
        crashed = error;
      }
      assert.ok(crashed instanceof FaultCrashError, `${point}: the armed crash fired`);
      assert.equal(crashed.point, point, `${point}: crashed at the armed point`);
    } finally {
      session.close();
    }

    // Restart: reopen the SAME database file and re-drive statelessly.
    const restarted = db.open();
    try {
      driveVertical(restarted, { faults: FaultScheduler.observing() });
      const settled = normalizedWorld(restarted);
      assert.deepEqual(settled, golden, `${point}: the restarted world equals the clean-run world (exactly-once logical outcome)`);
      assert.equal(receiptCount(restarted), 2, `${point}: exactly two admitted receipts (one per attempt)`);
      const completed = restarted.db
        .prepare("SELECT completed_by_key FROM transition_obligation WHERE state = 'completed' ORDER BY id")
        .all()
        .map((row) => row.completed_by_key);
      assert.equal(new Set(completed).size, completed.length, `${point}: no obligation completed twice`);
    } finally {
      restarted.close();
    }
  }
});

test('named crash windows: second admission, second send and second outcome crashes also settle exactly-once', () => {
  const golden = goldenRun();
  const windows = [
    { point: 'after-admission', at: 2 },
    { point: 'after-provider-send', at: 2 },
    { point: 'after-worker-return', at: 2 },
    { point: 'before-admission', at: 2 },
    { point: 'before-provider-send', at: 2 },
    { point: 'before-worker-return', at: 2 },
  ];
  for (const { point, at } of windows) {
    const db = freshDatabase('ek-wp07-window-');
    const session = db.open();
    try {
      let crashed = null;
      try {
        driveVertical(session, { faults: new FaultScheduler(point, at) });
      } catch (error) {
        crashed = error;
      }
      assert.ok(crashed instanceof FaultCrashError, `${point}@${at}: the armed crash fired`);
    } finally {
      session.close();
    }
    const restarted = db.open();
    try {
      driveVertical(restarted, { faults: FaultScheduler.observing() });
      assert.deepEqual(normalizedWorld(restarted), golden, `${point}@${at}: settles to the clean-run world`);
    } finally {
      restarted.close();
    }
  }
});

test('after admission / before send: the SAME provider-send obligation and ordinal are redriven, never a new admission', () => {
  const db = freshDatabase('ek-wp07-window-admission-');
  const session = db.open();
  try {
    let crashed = null;
    try {
      driveVertical(session, { faults: new FaultScheduler('after-admission'), stopAfter: 'admission-1' });
    } catch (error) {
      crashed = error;
    }
    assert.ok(crashed instanceof FaultCrashError);
    const world = session.hydrateWorld({ externalEvidence: EXTERNAL_INPUTS }).world;
    const openSend = world.obligations.filter((obligation) => obligation.kind === 'obligation:providerSend' && obligation.state === 'open');
    assert.equal(openSend.length, 1, 'the exact provider-send obligation is open after the crash');
    assert.equal(receiptCount(session), 1, 'exactly one admitted receipt exists');
    const counters = session.activityAttempt.loadContextCounters('activity-attempt:1');
    assert.equal(counters.nextRequestOrdinal, 1, 'the ordinal advanced exactly once');
  } finally {
    session.close();
  }

  const restarted = db.open();
  try {
    driveVertical(restarted, { faults: FaultScheduler.observing(), stopAfter: 'admission-1' });
    // The re-drive skipped the consumed launch obligation and must NOT have
    // admitted a second request for the same ordinal.
    assert.equal(receiptCount(restarted), 1, 'no second receipt for the redriven ordinal');
    const counters = restarted.activityAttempt.loadContextCounters('activity-attempt:1');
    assert.equal(counters.nextRequestOrdinal, 1, 'the redrive never re-admitted');
  } finally {
    restarted.close();
  }
});

test('after send / before outcome: exactly one ProviderSendOutcome evidence survives the restart', () => {
  const db = freshDatabase('ek-wp07-window-send-');
  const session = db.open();
  try {
    let crashed = null;
    try {
      driveVertical(session, { faults: new FaultScheduler('after-provider-send'), stopAfter: 'provider-send-1' });
    } catch (error) {
      crashed = error;
    }
    assert.ok(crashed instanceof FaultCrashError);
    const world = session.hydrateWorld({ externalEvidence: EXTERNAL_INPUTS }).world;
    assert.equal(world.evidence.filter((fact) => fact.kind === 'ProviderSendOutcome').length, 1);
    assert.equal(world.obligations.filter((obligation) => obligation.kind === 'obligation:providerSend' && obligation.state === 'completed').length, 1);
  } finally {
    session.close();
  }
  const restarted = db.open();
  try {
    driveVertical(restarted, { faults: FaultScheduler.observing(), stopAfter: 'provider-send-1' });
    const world = restarted.hydrateWorld({ externalEvidence: EXTERNAL_INPUTS }).world;
    assert.equal(world.evidence.filter((fact) => fact.kind === 'ProviderSendOutcome').length, 1, 'the crashed send was not duplicated by the redrive');
  } finally {
    restarted.close();
  }
});

test('after outcome / before completion: the contribution obligation completes exactly once after restart', () => {
  const db = freshDatabase('ek-wp07-window-outcome-');
  const session = db.open();
  try {
    let crashed = null;
    try {
      driveVertical(session, { faults: new FaultScheduler('after-worker-return'), stopAfter: 'worker-return-1' });
    } catch (error) {
      crashed = error;
    }
    assert.ok(crashed instanceof FaultCrashError);
    const world = session.hydrateWorld({ externalEvidence: EXTERNAL_INPUTS }).world;
    assert.equal(world.events.filter((event) => event.transition === 'workplace.recordContribution').length, 0, 'the contribution has not committed yet');
    assert.ok(world.obligations.some((obligation) => obligation.kind === 'obligation:submitContribution' && obligation.state === 'open'));
  } finally {
    session.close();
  }
  const restarted = db.open();
  try {
    driveVertical(restarted, { faults: FaultScheduler.observing() });
    const world = restarted.hydrateWorld({ externalEvidence: EXTERNAL_INPUTS }).world;
    assert.equal(world.events.filter((event) => event.transition === 'workplace.recordContribution').length, 2, 'one contribution per attempt, exactly once each');
  } finally {
    restarted.close();
  }
});
