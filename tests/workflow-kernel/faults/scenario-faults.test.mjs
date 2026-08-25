/**
 * scenario-faults.test.mjs - the WP-13B scenario fault layer: the WP-07
 * 16-point crash registry driven from SCENARIO DATA through public commands.
 *
 * Laws proven here:
 *   - the clean scenario vertical settles (the golden normalized world);
 *   - a crash armed at EVERY registry point (all 16), executed with restart,
 *     settles to the IDENTICAL normalized world as the clean run
 *     (scenario-level exactly-once, generalizing the WP-07 crash matrix);
 *   - the three NAMED crash windows (after-admission/before-send,
 *     after-send/before-outcome, after-outcome/before-completion) stage and
 *     settle: the SAME provider-send obligation/ordinal, exactly one
 *     admitted receipt per attempt, no obligation completed twice;
 *   - worker-loss as scenario data (classification, never product failure);
 *   - projection-wipe: every derived projection rehydrates from durable
 *     rows; projection-stale-write: the CAS fence refuses stale writes;
 *   - RED kill: a mutated restart that double-commits the crash-window step
 *     is caught by the normalized-world fence.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAULT_POINTS,
  FaultCrashError,
  FaultScheduler,
  SCENARIO_BOUNDARIES,
  SCENARIO_BOUNDARY_POINTS,
  NAMED_CRASH_WINDOWS,
  ScenarioFaultError,
  armRegistryFromScenario,
  crashAnchorOf,
  driveScenarioOnSession,
  openScenarioSession,
  scenarioDatabasePath,
  scenarioAdmission,
  scenarioExternalEvidence,
  scenarioNormalizedWorld,
  validateScenarioFaults,
} from '../../../dist/workflow-kernel/testing/scenario-faults.js';
import {
  actorPinSet,
  attemptLoopSteps,
  compileActorProgram,
  verticalPrefixSteps,
} from '../../../dist/workflow-kernel/testing/actors.js';
import { humanWaitProgram } from '../actors/reference-scenario.mjs';

const PINS = actorPinSet();
const EXTERNAL = scenarioExternalEvidence();
const ADMISSION = scenarioAdmission();
const IDS = {
  factory: 'factory-run:1',
  lifecycle: 'lifecycle-run:1',
  stage: 'stage-run:1',
  process: 'process-run:1',
  node: 'node-run:1',
  workplace: 'workplace:1',
};

/** The full scenario vertical as kernel inputs (deterministic compile). */
function scenarioInputs() {
  return compileActorProgram(humanWaitProgram(), { pins: PINS }).inputs;
}

/** The clean-run golden snapshot (computed once per call; deterministic). */
function goldenRun(inputs = scenarioInputs()) {
  const session = openScenarioSession(scenarioDatabasePath('ek-wp13b-golden'));
  try {
    const drive = driveScenarioOnSession(session, inputs, { externalEvidence: EXTERNAL, admission: ADMISSION });
    assert.equal(drive.refusedAt, null, 'the clean vertical commits fully');
    return scenarioNormalizedWorld(session, EXTERNAL);
  } finally {
    session.close();
  }
}

test('the clean scenario vertical settles: workplace terminal, both attempts admitted, no violations', () => {
  const golden = goldenRun();
  assert.equal(golden.heads.find((head) => head.instanceId === IDS.workplace)?.terminal, 'TerminalProof:workplace.success');
  // Each admission appends the kernel fact AND the persisted receipt row
  // under the SAME sequence ref: unique refs == admissions.
  const admitted = new Set(golden.evidence.filter((ref) => ref.startsWith('evidence:PromptAssemblyReceipt:admitted#'))).size;
  assert.equal(admitted, 3, 'exactly one admitted receipt per attempt (author x2 + reviewer)');
  assert.equal(golden.evidence.filter((ref) => ref.startsWith('evidence:ProviderSendOutcome#')).length, 3, 'three eventless sends, three outcome facts');
  assert.deepEqual(golden.invariantViolations, []);
});

/** Point -> (anchor command, occurrence) for the crash matrix. */
const MATRIX_ANCHORS = new Map([
  ['before-durable-write', { command: 'workplace.recordContribution', instanceId: IDS.workplace }],
  ['after-durable-write', { command: 'workplace.recordContribution', instanceId: IDS.workplace }],
  ['before-obligation-completion', { command: 'factoryRun.start', instanceId: IDS.factory }],
  ['after-obligation-completion', { command: 'factoryRun.start', instanceId: IDS.factory }],
  ['before-admission', { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1' }],
  ['after-admission', { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1' }],
  ['before-provider-send', { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport' }],
  ['after-provider-send', { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport' }],
  ['before-worker-spawn', { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport' }],
  ['after-worker-spawn', { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport' }],
  ['before-worker-return', { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:1' }],
  ['after-worker-return', { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:1' }],
  ['before-gate', { command: 'workplace.runAuthorGate', instanceId: IDS.workplace }],
  ['after-gate', { command: 'workplace.runAuthorGate', instanceId: IDS.workplace }],
  ['before-effect', { command: 'workplace.settleEffect', instanceId: IDS.workplace }],
  ['after-effect', { command: 'workplace.settleEffect', instanceId: IDS.workplace }],
]);

test('a crash armed at EVERY registry point, executed with restart, settles to the identical exactly-once world', () => {
  const golden = goldenRun();
  const inputs = scenarioInputs();
  for (const point of FAULT_POINTS) {
    const anchor = MATRIX_ANCHORS.get(point);
    assert.ok(anchor, `matrix anchor for ${point}`);
    const path = scenarioDatabasePath(`ek-wp13b-crash-${point}`);
    const session = openScenarioSession(path);
    let crashed = null;
    try {
      try {
        driveScenarioOnSession(session, inputs, {
          externalEvidence: EXTERNAL, admission: ADMISSION,
          faults: new FaultScheduler(point, 1),
          scenarioFaults: [{ fault: 'crash-before-commit', anchor }],
        });
      } catch (error) {
        crashed = error;
      }
      assert.ok(crashed instanceof FaultCrashError, `${point}: the armed crash fired`);
      assert.equal(crashed.point, point, `${point}: crashed at the armed point`);
    } finally {
      session.close();
    }

    // Restart: reopen the SAME database file and re-drive statelessly.
    const restarted = openScenarioSession(path);
    try {
      const drive = driveScenarioOnSession(restarted, inputs, { externalEvidence: EXTERNAL, admission: ADMISSION });
      assert.equal(drive.refusedAt, null, `${point}: the restart completes the vertical`);
      const settled = scenarioNormalizedWorld(restarted, EXTERNAL);
      assert.deepEqual(settled, golden, `${point}: the restarted world equals the clean-run world (exactly-once logical outcome)`);
    } finally {
      restarted.close();
    }
  }
});

test('the scenario boundary map covers every boundary and every reachable registry point', () => {
  assert.equal(SCENARIO_BOUNDARIES.length, 14);
  const mapped = new Set(SCENARIO_BOUNDARIES.flatMap((boundary) => SCENARIO_BOUNDARY_POINTS[boundary]));
  for (const point of mapped) assert.ok(FAULT_POINTS.includes(point), `${point} is a registry point`);
  // The gate/effect/worker seams are first-class; the commit seams fold into
  // the durable-write pair (they physically live inside that transaction).
  for (const point of ['before-gate', 'after-gate', 'before-effect', 'after-effect', 'before-worker-spawn', 'after-worker-spawn', 'before-durable-write', 'after-durable-write']) {
    assert.ok(mapped.has(point), `${point} is mapped from a scenario boundary`);
  }
  assert.equal(NAMED_CRASH_WINDOWS.length, 3, 'the three named crash windows of the EK-4 law');
});

test('named window after-admission/before-send: the SAME obligation and ordinal redrive, never a second admission', () => {
  const inputs = scenarioInputs();
  const path = scenarioDatabasePath('ek-wp13b-window-admission');
  const session = openScenarioSession(path);
  try {
    let crashed = null;
    try {
      driveScenarioOnSession(session, inputs, {
        externalEvidence: EXTERNAL, admission: ADMISSION,
        faults: new FaultScheduler('after-admission', 1),
        scenarioFaults: [{ fault: 'crash-after-event', anchor: MATRIX_ANCHORS.get('after-admission') }],
        stopAfter: { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1' },
      });
    } catch (error) {
      crashed = error;
    }
    assert.ok(crashed instanceof FaultCrashError);
    const world = scenarioNormalizedWorld(session, EXTERNAL);
    const admitted = new Set(world.evidence.filter((ref) => ref.startsWith('evidence:PromptAssemblyReceipt:admitted#'))).size;
    assert.equal(admitted, 1, 'exactly one admitted receipt survived the crash');
  } finally {
    session.close();
  }
  const restarted = openScenarioSession(path);
  try {
    const drive = driveScenarioOnSession(restarted, inputs, { externalEvidence: EXTERNAL, admission: ADMISSION });
    assert.equal(drive.refusedAt, null);
    const settled = scenarioNormalizedWorld(restarted, EXTERNAL);
    assert.deepEqual(settled, goldenRun(), 'the window settles to the clean-run world');
    const admitted = new Set(settled.evidence.filter((ref) => ref.startsWith('evidence:PromptAssemblyReceipt:admitted#'))).size;
    assert.equal(admitted, 3, 'no second receipt for the redriven ordinal (one per attempt)');
    const completed = settled.obligations.filter((obligation) => obligation.state === 'completed').map((obligation) => obligation.key);
    assert.equal(new Set(completed).size, completed.length, 'no obligation completed twice');
  } finally {
    restarted.close();
  }
});

test('named window after-send/before-outcome: exactly one ProviderSendOutcome survives the restart', () => {
  const inputs = scenarioInputs();
  const path = scenarioDatabasePath('ek-wp13b-window-send');
  const session = openScenarioSession(path);
  try {
    let crashed = null;
    try {
      driveScenarioOnSession(session, inputs, {
        externalEvidence: EXTERNAL, admission: ADMISSION,
        faults: new FaultScheduler('after-provider-send', 1),
        scenarioFaults: [{ fault: 'crash-after-event', anchor: MATRIX_ANCHORS.get('after-provider-send') }],
        stopAfter: { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport' },
      });
    } catch (error) {
      crashed = error;
    }
    assert.ok(crashed instanceof FaultCrashError);
    const world = scenarioNormalizedWorld(session, EXTERNAL);
    assert.equal(world.evidence.filter((ref) => ref.startsWith('evidence:ProviderSendOutcome#')).length, 1);
  } finally {
    session.close();
  }
  const restarted = openScenarioSession(path);
  try {
    driveScenarioOnSession(restarted, inputs, { externalEvidence: EXTERNAL, admission: ADMISSION });
    const settled = scenarioNormalizedWorld(restarted, EXTERNAL);
    assert.deepEqual(settled, goldenRun(), 'the crashed send was not duplicated by the redrive');
  } finally {
    restarted.close();
  }
});

test('named window after-outcome/before-completion: the contribution completes exactly once after restart', () => {
  const inputs = scenarioInputs();
  const path = scenarioDatabasePath('ek-wp13b-window-outcome');
  const session = openScenarioSession(path);
  try {
    let crashed = null;
    try {
      driveScenarioOnSession(session, inputs, {
        externalEvidence: EXTERNAL, admission: ADMISSION,
        faults: new FaultScheduler('after-worker-return', 1),
        scenarioFaults: [{ fault: 'crash-after-event', anchor: MATRIX_ANCHORS.get('after-worker-return') }],
        stopAfter: { command: 'activityAttempt.recordOutcome', instanceId: 'activity-attempt:1' },
      });
    } catch (error) {
      crashed = error;
    }
    assert.ok(crashed instanceof FaultCrashError);
    const world = scenarioNormalizedWorld(session, EXTERNAL);
    assert.equal(world.events.filter((event) => event.transition === 'workplace.recordContribution').length, 0, 'the contribution has not committed yet');
  } finally {
    session.close();
  }
  const restarted = openScenarioSession(path);
  try {
    driveScenarioOnSession(restarted, inputs, { externalEvidence: EXTERNAL, admission: ADMISSION });
    const settled = scenarioNormalizedWorld(restarted, EXTERNAL);
    assert.equal(settled.events.filter((event) => event.transition === 'workplace.recordContribution').length, 3, 'one contribution per attempt, exactly once each');
  } finally {
    restarted.close();
  }
});

test('worker-loss as scenario data: the attempt is classified, never product-failed', () => {
  const program = [
    ...verticalPrefixSteps(IDS, 'implementer'),
    ...attemptLoopSteps({ loopId: 'author-1', role: 'author', profile: 'implementer', workplace: IDS.workplace, attempt: 'activity-attempt:1', gate: 'author', gateVerdict: 'accepted', behavior: 'timeout' }),
  ];
  const inputs = compileActorProgram(program, { pins: PINS }).inputs;
  const session = openScenarioSession(scenarioDatabasePath('ek-wp13b-worker-loss'));
  try {
    const drive = driveScenarioOnSession(session, inputs, {
      externalEvidence: EXTERNAL, admission: ADMISSION,
      scenarioFaults: [{ fault: 'worker-loss', anchor: { command: 'cognition.sendProviderRequest', instanceId: 'cognition:transport' } }],
    });
    assert.equal(drive.refusedAt, null, 'the classification path commits fully');
    const world = scenarioNormalizedWorld(session, EXTERNAL);
    const attempt = world.heads.find((head) => head.instanceId === 'activity-attempt:1');
    assert.equal(attempt.status, 'worker-loss-classified');
    assert.deepEqual(world.waits, [{ kind: 'TypedWait:external-availability', owner: 'activity-attempt:1', state: 'pending' }]);
    assert.ok(world.obligations.some((obligation) => obligation.kind === 'obligation:retryAttempt' && obligation.state === 'open'));
    assert.deepEqual(world.invariantViolations, []);
  } finally {
    session.close();
  }
});

test('projection-wipe: every derived projection rehydrates from the durable ledger rows', () => {
  const inputs = scenarioInputs();
  const path = scenarioDatabasePath('ek-wp13b-projection-wipe');
  const first = openScenarioSession(path);
  try {
    const drive = driveScenarioOnSession(first, inputs, { externalEvidence: EXTERNAL, admission: ADMISSION });
    assert.equal(drive.refusedAt, null);
  } finally {
    first.close();
  }
  // "Wipe": a brand-new session hydrates from rows alone - no cached
  // projection, no in-memory state. The normalized world must be identical.
  const golden = goldenRun();
  const second = openScenarioSession(path);
  try {
    assert.deepEqual(scenarioNormalizedWorld(second, EXTERNAL), golden, 'the rehydrated projection equals the clean-run world');
    assert.deepEqual(scenarioNormalizedWorld(second, EXTERNAL), scenarioNormalizedWorld(second, EXTERNAL), 'hydration is deterministic');
  } finally {
    second.close();
  }
});

test('projection-stale-write: a stale-revision write against the ledger is refused and changes nothing', () => {
  const inputs = scenarioInputs();
  const path = scenarioDatabasePath('ek-wp13b-stale-write');
  const session = openScenarioSession(path);
  try {
    // Stage the world mid-flight: the first admission committed (its
    // provider-send obligation is OPEN, so a send is lawful) and the
    // transport head revision is 0. A stale projection of that head
    // (revision 1) attempts the write under a fresh key.
    const staged = driveScenarioOnSession(session, inputs, {
      externalEvidence: EXTERNAL,
      admission: ADMISSION,
      stopAfter: { command: 'activityAttempt.admitProviderRequest', instanceId: 'activity-attempt:1' },
    });
    assert.equal(staged.refusedAt, null);
    const before = scenarioNormalizedWorld(session, EXTERNAL);
    const stale = {
      command: 'cognition.sendProviderRequest',
      instanceId: 'cognition:transport',
      expectedRevision: 1,
      idempotencyKey: 'stale-projection-write',
    };
    const outcome = driveScenarioOnSession(session, [stale], { externalEvidence: EXTERNAL, admission: ADMISSION });
    assert.equal(outcome.outcomes[0].status, 'refused');
    assert.equal(outcome.outcomes[0].refusal.reason, 'STALE_EXPECTED_REVISION', 'the CAS fence refuses the stale projection write');
    assert.deepEqual(scenarioNormalizedWorld(session, EXTERNAL), before, 'the stale write changed nothing');
  } finally {
    session.close();
  }
});

test('the fault vocabulary is closed: unknown classes and boundaries are refused', () => {
  assert.throws(
    () => validateScenarioFaults([{ fault: 'silent-skip', anchor: { command: 'factoryRun.bootstrap', instanceId: IDS.factory } }]),
    (error) => error instanceof ScenarioFaultError && error.message.includes('unknown scenario fault class'),
  );
  assert.throws(
    () => validateScenarioFaults([{ fault: 'crash-before-commit', anchor: { command: 'factoryRun.bootstrap', instanceId: IDS.factory }, boundary: 'mid-flight' }]),
    (error) => error instanceof ScenarioFaultError && error.message.includes('unknown scenario boundary'),
  );
  assert.throws(
    () => validateScenarioFaults([{ fault: 'crash-before-commit', anchor: { command: 'factoryRun.notACommand', instanceId: IDS.factory } }]),
    (error) => error instanceof ScenarioFaultError && error.message.includes('not in the frozen universe'),
  );
  assert.throws(
    () => armRegistryFromScenario([
      { fault: 'crash-before-commit', anchor: { command: 'factoryRun.bootstrap', instanceId: IDS.factory } },
      { fault: 'crash-after-event', anchor: { command: 'factoryRun.importCapsule', instanceId: IDS.factory } },
    ]),
    (error) => error instanceof ScenarioFaultError && error.message.includes('one process dies once'),
  );
  // crashAnchorOf picks the single armed crash entry.
  const entry = { fault: 'crash-before-commit', anchor: { command: 'factoryRun.start', instanceId: IDS.factory } };
  assert.deepEqual(crashAnchorOf([entry, { fault: 'worker-loss', anchor: entry.anchor }]), entry.anchor);
});

test('RED kill: a redrive that re-keys the crash-window send diverges from the golden world (fault-window fence)', () => {
  const inputs = scenarioInputs();
  const anchor = MATRIX_ANCHORS.get('before-provider-send');
  const golden = goldenRun();

  /** Crash one fresh database exactly at the pre-send window. */
  const crashFreshDatabase = () => {
    const path = scenarioDatabasePath('ek-wp13b-red-rekey');
    const session = openScenarioSession(path);
    try {
      let crashed = null;
      try {
        driveScenarioOnSession(session, inputs, {
          externalEvidence: EXTERNAL,
          admission: ADMISSION,
          faults: new FaultScheduler('before-provider-send', 1),
          scenarioFaults: [{ fault: 'crash-before-commit', anchor }],
        });
      } catch (error) {
        crashed = error;
      }
      assert.ok(crashed instanceof FaultCrashError, 'GREEN: the clean schedule crashes exactly at the pre-send window');
    } finally {
      session.close();
    }
    return path;
  };

  // GREEN: the honest restart re-drives the SAME key and settles equal.
  const honestPath = crashFreshDatabase();
  const honest = openScenarioSession(honestPath);
  try {
    const drive = driveScenarioOnSession(honest, inputs, { externalEvidence: EXTERNAL, admission: ADMISSION });
    assert.equal(drive.refusedAt, null);
    assert.deepEqual(scenarioNormalizedWorld(honest, EXTERNAL), golden, 'GREEN: same-key redrive settles to the golden world');
  } finally {
    honest.close();
  }

  // MUTATION: the restarted driver re-keys the redriven send (a fresh
  // idempotency key at the crash window). The send is still lawful (the
  // obligation is open, the revision matches), so it COMMITS - and the
  // original-key step then fences, leaving a divergent world. The
  // normalized-world fence must be RED: the redrive contract (SAME
  // obligation, SAME ordinal, SAME key) is load-bearing.
  const mutated = openScenarioSession(crashFreshDatabase());
  try {
    const anchored = inputs.find((input) => input.command === anchor.command && input.instanceId === anchor.instanceId);
    const reKeyed = { ...anchored, idempotencyKey: `${anchored.idempotencyKey}:mutation-rekey` };
    driveScenarioOnSession(mutated, [reKeyed], { externalEvidence: EXTERNAL, admission: ADMISSION });
    const afterRekey = driveScenarioOnSession(mutated, inputs, { externalEvidence: EXTERNAL, admission: ADMISSION });
    assert.notEqual(afterRekey.refusedAt, null, 'the abandoned original key can no longer commit (the fence)');
    const mutatedWorld = scenarioNormalizedWorld(mutated, EXTERNAL);
    let fenceRed = false;
    try {
      assert.deepEqual(mutatedWorld, golden);
    } catch {
      fenceRed = true;
    }
    assert.equal(fenceRed, true, 'RED: the re-keyed crash-window send is caught by the normalized-world fence');
  } finally {
    mutated.close();
  }
});
