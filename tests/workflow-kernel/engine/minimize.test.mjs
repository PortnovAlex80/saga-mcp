/**
 * minimize.test.mjs - the EK-9 delta-debugging minimizer (WP-13A):
 *   - a failing scenario command stream reduces to its 1-minimal core while
 *     the failure still reproduces;
 *   - the RANDOM SEED and the FAULT SCHEDULE are preserved (fault-anchored
 *     steps are undeletable; the schedule array is carried verbatim);
 *   - anchor protection is unconditional (a predicate that would allow
 *     dropping the anchored step still cannot drop it);
 *   - the ddmin chunk mechanics are exercised in isolation on an abstract
 *     stream (no kernel dependency).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { driveCommandSteps } from './compare.mjs';
import {
  faultSchedulePreserved,
  minimizeFailureRun,
  minimizeScenario,
  protectedStepIndexes,
} from './minimize.mjs';
import { validateScenario } from './scenario.mjs';
import { omissionScenario, staleRevisionScenario } from './scenario-fixture.mjs';

const staleRefusal = (run) => run.refusal?.reason === 'STALE_EXPECTED_REVISION';

/* ---------------- scenario-level minimization ---------------- */

test('a failing scenario minimizes to its 1-minimal core (seed + schedule preserved)', () => {
  const scenario = staleRevisionScenario();
  const result = minimizeScenario(scenario, { predicate: staleRefusal });

  assert.equal(result.minimized, true, 'steps were dropped');
  assert.deepEqual(
    result.scenario.seedInput.ingress.map((step) => step.command),
    ['factoryRun.bootstrap', 'factoryRun.importCapsule'],
    'only the ingress prerequisites survive',
  );
  assert.deepEqual(
    result.scenario.actorProgram.map((step) => step.command),
    ['factoryRun.start'],
    'the failing (fault-anchored) step survives, the junk is gone',
  );
  assert.equal(result.predicateHolds, true, 'the minimized scenario still fails the same way');
  assert.equal(result.schedulePreserved, true, 'every fault anchor is still present');
  assert.equal(result.seedPreserved, true, 'the random seed is untouched');
  assert.equal(result.faultSchedulePreservedVerbatim, true, 'the fault schedule is byte-identical');

  const replay = driveCommandSteps(
    [...result.scenario.seedInput.ingress, ...result.scenario.actorProgram],
    result.scenario.faultSchedule,
    result.scenario.seedInput.seed,
  );
  assert.equal(replay.refusal.reason, 'STALE_EXPECTED_REVISION', 'the failure is reproducible on the minimized stream');
});

test('the minimized scenario is still contract-valid', () => {
  const result = minimizeScenario(staleRevisionScenario(), { predicate: staleRefusal });
  const { valid, errors } = validateScenario(result.scenario);
  assert.deepEqual(errors, []);
  assert.equal(valid, true);
  assert.equal(result.scenario.seedInput.seed, staleRevisionScenario().seedInput.seed);
});

test('the minimized core is 1-minimal: dropping any deletable step breaks the failure', () => {
  const result = minimizeScenario(staleRevisionScenario(), { predicate: staleRefusal });
  const steps = [...result.scenario.seedInput.ingress, ...result.scenario.actorProgram];
  const protectedIndexes = protectedStepIndexes(steps, result.scenario.faultSchedule);
  let checked = 0;
  for (let index = 0; index < steps.length; index += 1) {
    if (protectedIndexes.has(index)) continue; // anchored steps are undeletable by contract
    const candidate = steps.slice(0, index).concat(steps.slice(index + 1));
    const replay = driveCommandSteps(candidate, result.scenario.faultSchedule, result.scenario.seedInput.seed);
    assert.equal(
      staleRefusal(replay),
      false,
      `step ${steps[index].command} is load-bearing: removing it must break the failure reproduction`,
    );
    checked += 1;
  }
  assert.equal(checked, 2, 'both remaining ingress steps were checked as load-bearing');
});

/* ---------------- anchor protection ---------------- */

test('anchor protection is unconditional: a permissive predicate cannot drop the anchored step', () => {
  const scenario = omissionScenario(); // the fault-anchored planner step alone reproduces the failure
  const result = minimizeScenario(scenario, { predicate: () => true });
  assert.deepEqual(
    result.scenario.actorProgram.map((step) => step.command),
    ['workItem.planGraph'],
    'only the fault-anchored step remains',
  );
  assert.deepEqual(result.scenario.seedInput.ingress, [], 'everything deletable was dropped');
  assert.equal(result.schedulePreserved, true);
  assert.equal(result.predicateHolds, true);
});

test('a fault-anchored prerequisite stays protected even when droppable semantically', () => {
  const scenario = staleRevisionScenario();
  // Anchor a SECOND fault at the capsule import: the capsule step becomes
  // protected and must survive even though the stale refusal needs it anyway.
  scenario.faultSchedule.push({
    fault: 'foreign-evidence-ref',
    anchor: { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1' },
  });
  const result = minimizeScenario(scenario, { predicate: staleRefusal });
  assert.ok(
    result.scenario.seedInput.ingress.some((step) => step.command === 'factoryRun.importCapsule'),
    'the doubly-anchored capsule step survives',
  );
  assert.equal(result.schedulePreserved, true);
  assert.equal(result.predicateHolds, true);
});

test('protectedStepIndexes marks exactly the anchored applications (occurrence-aware)', () => {
  const steps = [
    { command: 'a', instanceId: 'i1' },
    { command: 'a', instanceId: 'i1' },
    { command: 'b', instanceId: 'i2' },
  ];
  const schedule = [
    { fault: 'x', anchor: { command: 'a', instanceId: 'i1', occurrence: 2 } },
    { fault: 'y', anchor: { command: 'b', instanceId: 'i2' } },
  ];
  const protectedIndexes = protectedStepIndexes(steps, schedule);
  assert.deepEqual([...protectedIndexes].sort(), [1, 2], 'the SECOND a-application and the b-application are protected');
  assert.equal(faultSchedulePreserved(steps, schedule), true);
  assert.equal(faultSchedulePreserved(steps.slice(0, 1), schedule), false, 'a dropped anchor breaks preservation');
});

/* ---------------- ddmin mechanics (abstract stream) ---------------- */

test('ddmin reduces an abstract stream to the protected core with chunked removals', () => {
  const step = (name) => ({ command: name, instanceId: `${name}:1` });
  const steps = ['j1', 'j2', 'j3', 'j4', 'j5', 'F', 'j6', 'j7'].map(step);
  const faultSchedule = [{ fault: 'stale-expected-revision', anchor: { command: 'F', instanceId: 'F:1' } }];
  // The "failure" reproduces iff the protected F step is present.
  const run = (candidate) => ({ hasF: candidate.some((s) => s.command === 'F'), seedRetained: true });
  const result = minimizeFailureRun({
    steps,
    seed: 42,
    faultSchedule,
    run,
    predicate: (r) => r.hasF && r.seedRetained,
  });
  assert.equal(result.minimized, true);
  assert.deepEqual(result.steps.map((s) => s.command), ['F'], 'everything deletable is gone in few iterations');
  assert.equal(result.iterations < 8, true, `chunked ddmin needs fewer runs than the stream length (${result.iterations})`);
  assert.equal(result.predicateHolds, true);
  assert.equal(result.schedulePreserved, true);
  assert.equal(result.seedPreserved, true);
  assert.equal(result.seed, 42, 'the seed is retained in the result');
});

test('ddmin keeps steps a coarser chunk could not remove when the predicate protects them', () => {
  // The failure needs BOTH F and its true prerequisite P; junk drops.
  const step = (name) => ({ command: name, instanceId: `${name}:1` });
  const steps = [step('P'), step('j1'), step('j2'), step('F')];
  const faultSchedule = [{ fault: 'stale-expected-revision', anchor: { command: 'F', instanceId: 'F:1' } }];
  const run = (candidate) => ({
    hasBoth: candidate.some((s) => s.command === 'P') && candidate.some((s) => s.command === 'F'),
  });
  const result = minimizeFailureRun({
    steps,
    seed: 7,
    faultSchedule,
    run,
    predicate: (r) => r.hasBoth,
  });
  assert.deepEqual(result.steps.map((s) => s.command).sort(), ['F', 'P'], 'the load-bearing pair survives, junk drops');
  assert.equal(result.predicateHolds, true);
  assert.equal(result.schedulePreserved, true);
});

test('minimizeFailureRun requires run and predicate functions', () => {
  assert.throws(() => minimizeFailureRun({ steps: [], seed: 1, predicate: () => true }), TypeError);
  assert.throws(() => minimizeFailureRun({ steps: [], seed: 1, run: () => ({}) }), TypeError);
});
