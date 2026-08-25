/**
 * waits.test.mjs - typed waits with exact durable wake sources and
 * idempotent wake/redrive (WP-07, plan phase EK-4). Frozen decisions
 * exercised: D5 (obligation-completion discharge in the same transaction),
 * D7 (dead-wake conversion reporting), D9 (watchdog observes and commands
 * only), D12 (effect uncertainty wakes only on an operator disposition).
 * No read ever touches Kanban or an inferred task status.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const waits = await import('../../../dist/workflow-kernel/application/waits.js');
const consumer = await import('../../../dist/workflow-kernel/application/obligation-consumer.js');
const { FaultScheduler } = await import('../../../dist/workflow-kernel/application/faults.js');
const { driveVertical, freshDatabase, EXTERNAL_INPUTS, FACTORY, WORKPLACE } = await import('./driver.mjs');

const configOf = (faults) => ({ externalEvidence: EXTERNAL_INPUTS, faults });

function staged(stopAfter) {
  const db = freshDatabase('ek-wp07-waits-');
  const session = db.open();
  driveVertical(session, { faults: FaultScheduler.observing(), stopAfter });
  return { db, session };
}

/** Apply one driver-style command directly through the owning repository. */
function applyDirect(session, { aggregate, command, instanceId, key, fields = {} }) {
  const head = session.hydrateWorld().world.heads.get(instanceId);
  return consumer.repositoryOf(session, aggregate).applyCommand(
    { command, instanceId, expectedRevision: head === undefined ? 0 : head.revision, idempotencyKey: key, ...fields },
    { externalEvidence: EXTERNAL_INPUTS },
  );
}

/** Consume the open frontier obligation of one kind with a typed invocation. */
function consumeKind(session, kind, invocation = {}) {
  const entry = consumer.openFrontier(session).find((candidate) => candidate.kind === kind);
  if (entry === undefined) return { skipped: true };
  return consumer.consumeClaim(session, entry.claim, invocation, configOf());
}

test('policy-quota: operator stop persists the wait, operator resume discharges it atomically, re-wake is typed', () => {
  const { session } = staged('consume-start');
  try {
    const stop = applyDirect(session, { aggregate: 'FactoryRun', command: 'factoryRun.requestStop', instanceId: FACTORY, key: 'wait:stop:1' });
    assert.equal(stop.committed, true);

    const pending = waits.pendingWaits(session);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'TypedWait:policy-quota');
    assert.deepEqual([...pending[0].wakeCommands], ['factoryRun.resume'], 'the exact durable wake source');
    assert.deepEqual(waits.wakeLivenessReport(session), [], 'the wait keeps a live wake source');

    // A command that is not a declared wake source of this wait is refused.
    const foreign = waits.wakeByCommand(session, pending[0].rowId, { command: 'factoryRun.bootstrap', idempotencyKey: 'wait:wake:foreign' });
    assert.equal(foreign.status, 'refused');
    assert.equal(foreign.refusal.reason, 'WAIT_WITHOUT_WAKE_SOURCE');

    const wake = waits.wakeByCommand(session, pending[0].rowId, { command: 'factoryRun.resume', idempotencyKey: 'wait:resume:1' });
    assert.equal(wake.status, 'discharged', 'the operator resume command discharges the wait');
    assert.ok(wake.dischargeEvidenceRef.length > 0, 'the discharge receipt is durable');
    assert.equal(session.hydrateWorld().world.heads.get(FACTORY).status, 'resumed');

    // Idempotent re-wake: the wait is no longer pending - typed refusal, no second effect.
    const again = waits.wakeByCommand(session, pending[0].rowId, { command: 'factoryRun.resume', idempotencyKey: 'wait:resume:2' });
    assert.equal(again.status, 'refused');
    assert.equal(waits.pendingWaits(session).length, 0);
  } finally {
    session.close();
  }
});

test('human-input: a human-wait gate verdict persists the wait and resolveHumanResponse discharges it with runnable successors', () => {
  const { session } = staged('present-1');
  try {
    const gate = consumeKind(session, 'obligation:runGate.author', { gateVerdict: 'human-wait' });
    assert.equal(gate.status, 'committed');
    const pending = waits.pendingWaits(session);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'TypedWait:human-input');
    assert.ok([...pending[0].wakeCommands].includes('workplace.resolveHumanResponse'), 'the exact durable wake source');

    // The human wait is entered from the decided gate (the wait's owner path).
    const enter = applyDirect(session, { aggregate: 'Workplace', command: 'workplace.enterHumanWait', instanceId: WORKPLACE, key: 'wait:enter-human:1' });
    assert.equal(enter.committed, true);

    const wake = waits.wakeByCommand(session, pending[0].rowId, { command: 'workplace.resolveHumanResponse', idempotencyKey: 'wait:human:1' });
    assert.equal(wake.status, 'discharged');
    const open = session.hydrateWorld().world.obligations.filter((obligation) => obligation.state === 'open').map((obligation) => obligation.kind);
    assert.ok(open.includes('obligation:requeueAfterHumanResolution'), 'the repair requeue obligation is runnable');
    assert.ok(open.includes('obligation:resumeEffect'), 'the effect resume obligation is runnable');

    const again = waits.wakeByCommand(session, pending[0].rowId, { command: 'workplace.resolveHumanResponse', idempotencyKey: 'wait:human:2' });
    assert.equal(again.status, 'refused', 'the discharged wait cannot wake twice');
  } finally {
    session.close();
  }
});

test('D12 effect uncertainty: an automatic wake is refused; only an operator disposition may attempt the wake', () => {
  const { session } = staged('final-gate');
  try {
    const settle = consumeKind(session, 'obligation:runEffects', { effectOutcome: 'unknown' });
    assert.equal(settle.status, 'committed');
    const pending = waits.pendingWaits(session);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'TypedWait:effect-uncertainty');

    // Automatic redrive of an uncertain non-idempotent external effect: refused.
    const automatic = waits.wakeByCommand(session, pending[0].rowId, { command: 'workplace.resolveHumanResponse', idempotencyKey: 'wait:uncertain:auto' });
    assert.equal(automatic.status, 'refused');
    assert.equal(automatic.refusal.reason, 'WAIT_WITHOUT_WAKE_SOURCE');
    assert.match(automatic.refusal.detail, /D12/, 'the refusal cites the frozen decision');

    // With an operator disposition receipt the wake commits through the
    // frozen command boundary (D12 convergence, 2026-08-26: the reducer edge
    // from effect-uncertainty-waited + the guard's uncertainty arm now match
    // the WAITS registry, which always declared resolveHumanResponse as this
    // wait's wake source). The disposition discharges the wait EXACTLY ONCE;
    // the re-settle after the wake is the legal D2 ladder, never a duplicate
    // send (the transport's SEND_UNCERTAIN_DUPLICATE_BLOCKED fence owns that).
    const attempted = waits.wakeByCommand(session, pending[0].rowId, {
      command: 'workplace.resolveHumanResponse',
      idempotencyKey: 'wait:uncertain:operator',
      operatorDispositionRef: 'operator-disposition:receipt:1',
    });
    assert.equal(attempted.status, 'discharged');
    assert.equal(waits.pendingWaits(session).length, 0, 'the uncertainty wait discharged exactly once, nothing duplicated');
    // The same disposition replayed never discharges twice.
    const replay = waits.wakeByCommand(session, pending[0].rowId, {
      command: 'workplace.resolveHumanResponse',
      idempotencyKey: 'wait:uncertain:operator',
      operatorDispositionRef: 'operator-disposition:receipt:1',
    });
    assert.notEqual(replay.status, 'discharged', 'a replayed disposition never discharges twice');
  } finally {
    session.close();
  }
});

test('D5 external availability: the retryAttempt obligation completion discharges the wait in the SAME transaction', () => {
  const { session } = staged('provider-send-1');
  try {
    const loss = applyDirect(session, {
      aggregate: 'ActivityAttempt',
      command: 'activityAttempt.classifyWorkerLoss',
      instanceId: 'activity-attempt:1',
      key: 'wait:worker-loss:1',
    });
    assert.equal(loss.committed, true);
    const pending = waits.pendingWaits(session);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'TypedWait:external-availability');
    assert.deepEqual([...pending[0].wakeObligationKinds], ['obligation:retryAttempt'], 'the exact D5 wake-source obligation kind');
    assert.deepEqual([...pending[0].liveWakeObligationKinds], ['obligation:retryAttempt'], 'the wake source is live (open)');

    // The consumer completes the retry obligation: the fresh attempt commits
    // AND the wait discharges atomically (one transaction, one sequence).
    const retry = consumeKind(session, 'obligation:retryAttempt');
    assert.equal(retry.status, 'committed');
    const world = session.hydrateWorld().world;
    assert.equal(world.heads.get('activity-attempt:2') !== undefined, true, 'the retry attempt was created');
    assert.equal(waits.pendingWaits(session).length, 0, 'the wait discharged with the obligation completion (D5)');
    const discharged = waits.durableWaits(session).find((wait) => wait.kind === 'TypedWait:external-availability');
    assert.equal(discharged.state, 'discharged');
    assert.ok(discharged.dischargeEvidenceRef.length > 0, 'the discharge receipt is durable');
    const completedAt = session.db
      .prepare("SELECT completed_at_sequence FROM transition_obligation WHERE kind = 'obligation:retryAttempt' AND state = 'completed'")
      .get().completed_at_sequence;
    assert.equal(world.waits.find((wait) => wait.kind === 'TypedWait:external-availability').dischargeEvidenceRef.includes(`${completedAt}`), true, 'the discharge shares the completion transaction sequence');

    // The retry attempt pinned the SAME WorkIntent role contract (never re-resolved).
    const failedPin = session.activityAttempt.loadRoleContractPin('activity-attempt:1');
    const retryPin = session.activityAttempt.loadRoleContractPin('activity-attempt:2');
    assert.deepEqual({ ref: retryPin.roleContractRef, digest: retryPin.roleContractDigest, intent: retryPin.workIntentRef }, {
      ref: failedPin.roleContractRef,
      digest: failedPin.roleContractDigest,
      intent: failedPin.workIntentRef,
    });
  } finally {
    session.close();
  }
});

test('D9 watchdog: observeWatchdog is a command producing evidence + a restart obligation; recovery runs through the consumer', () => {
  const { session } = staged('consume-start');
  try {
    applyDirect(session, { aggregate: 'FactoryRun', command: 'factoryRun.requestStop', instanceId: FACTORY, key: 'watchdog:stop:1' });
    const observation = applyDirect(session, { aggregate: 'FactoryRun', command: 'factoryRun.observeWatchdog', instanceId: FACTORY, key: 'watchdog:observe:1' });
    assert.equal(observation.committed, true, 'the watchdog observes through the owning aggregate command');

    const world = session.hydrateWorld().world;
    assert.ok(world.evidence.some((fact) => fact.kind === 'WatchdogObservation'), 'durable WatchdogObservation evidence');
    const restart = world.obligations.find((obligation) => obligation.kind === 'obligation:watchdogRestart' && obligation.state === 'open');
    assert.ok(restart !== undefined, 'the watchdog issued a typed restart obligation');

    // Recovery is obligation-driven (never SQL repair): the consumer resumes the run.
    const result = consumer.runUntilIdle(session, configOf());
    assert.ok(result.consumed >= 1, 'the consumer executed the watchdog restart obligation');
    assert.equal(session.hydrateWorld().world.heads.get(FACTORY).status, 'resumed');
    assert.equal(waits.pendingWaits(session).length, 0, 'the policy-quota wait discharged with the resume transaction');
  } finally {
    session.close();
  }
});

test('wake payloads are idempotent by key: the same wake key replays instead of committing twice', () => {
  const { session } = staged('consume-start');
  try {
    applyDirect(session, { aggregate: 'FactoryRun', command: 'factoryRun.requestStop', instanceId: FACTORY, key: 'idem:stop:1' });
    const rowId = waits.pendingWaits(session)[0].rowId;
    const first = waits.wakeByCommand(session, rowId, { command: 'factoryRun.resume', idempotencyKey: 'idem:resume:1' });
    assert.equal(first.status, 'discharged');
    const second = waits.wakeByCommand(session, rowId, { command: 'factoryRun.resume', idempotencyKey: 'idem:resume:1' });
    assert.equal(second.status, 'refused', 'the wait is discharged; the identical key cannot commit anything new');
    const events = session.hydrateWorld().world.events.filter((event) => event.transition === 'factoryRun.resume');
    assert.equal(events.length, 1);
  } finally {
    session.close();
  }
});
