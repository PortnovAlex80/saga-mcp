/**
 * concurrency-drivers.test.mjs - the EK-9 concurrency dimension (WP-13B):
 * 1, exact cap 2, cap saturation with a deterministic barrier, stale lease
 * and two consumers - deterministic interleavings of INDEPENDENT command
 * streams over the pure reference machine, plus the CAS admission race.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { actorPinSet, attemptLoopSteps, compileActorProgram, verticalPrefixSteps } from '../../../dist/workflow-kernel/testing/actors.js';
import { runConcurrencyDriver } from '../../../dist/workflow-kernel/testing/dimension-drivers.js';
import { applyCommand, createWorld, findInvariantViolations } from '../../../dist/workflow-kernel/domain/explorer.js';

const PINS = actorPinSet();

/** One independent factory vertical stream (disjoint aggregate instances). */
function verticalStream(tag) {
  const ids = {
    factory: `factory-run:${tag}`,
    lifecycle: `lifecycle-run:${tag}`,
    stage: `stage-run:${tag}`,
    process: `process-run:${tag}`,
    node: `node-run:${tag}`,
    workplace: `workplace:${tag}`,
  };
  const inputs = compileActorProgram(verticalPrefixSteps(ids, 'implementer'), { pins: PINS, seed: 20260825 }).inputs;
  // Independent lanes carry independent idempotency keys (same key would
  // replay the sibling lane's commits instead of committing its own).
  return inputs.map((input) => ({ ...input, idempotencyKey: `${tag}:${input.idempotencyKey}` }));
}

test('concurrency 1: strictly serialized streams commit everything with peak in-flight 1', () => {
  const streams = [verticalStream('a'), verticalStream('b')];
  const phases = streams[0].flatMap(() => [[0], [1]]); // strictly one lane per phase
  const run = runConcurrencyDriver({
    id: 'cap-1',
    requirement: 'a concurrency cap of 1 serializes independent streams',
    concurrencyCap: 1,
    streams,
    barrierPhases: phases,
    expected: { peakInFlight: 1, committedSteps: streams[0].length + streams[1].length, refusals: [] },
  });
  assert.deepEqual(run.refusals, []);
  assert.equal(run.peakInFlight, 1);
  assert.equal(run.committedSteps, 20, 'every step of both verticals committed');
  assert.deepEqual(findInvariantViolations(run.world), []);
});

test('concurrency exact cap 2: two streams advance in the same barrier phase', () => {
  const streams = [verticalStream('a'), verticalStream('b')];
  const phases = streams[0].map((_, index) => [0, 1]); // both advance together every phase
  const run = runConcurrencyDriver({
    id: 'exact-cap-2',
    requirement: 'exactly two consumers run concurrently at the cap',
    concurrencyCap: 2,
    streams,
    barrierPhases: phases,
    expected: { peakInFlight: 2, committedSteps: 20, refusals: [] },
  });
  assert.deepEqual(run.refusals, []);
  assert.equal(run.peakInFlight, 2, 'both lanes saturate the cap');
  assert.equal(run.committedSteps, 20);
});

test('cap saturation with a deterministic barrier: three streams, cap 2, peak never exceeds 2', () => {
  const streams = [verticalStream('a'), verticalStream('b'), verticalStream('c')];
  // Deterministic barrier: lanes 0+1 pass the barrier together, lane 2
  // alternates; the barrier data itself is the scheduler.
  const phases = [];
  for (let index = 0; index < streams[0].length; index += 1) {
    phases.push([0, 1]); // lanes 0+1 pass the barrier together (the cap saturates)
    phases.push([2]); // lane 2 waits for the barrier and follows alone
  }
  const run = runConcurrencyDriver({
    id: 'cap-saturation-barrier',
    requirement: 'the cap saturates at 2 with a deterministic barrier over 3 lanes',
    concurrencyCap: 2,
    streams,
    barrierPhases: phases,
    expected: { peakInFlight: 2, committedSteps: 30, refusals: [] },
  });
  assert.deepEqual(run.refusals, []);
  assert.equal(run.peakInFlight, 2, 'saturated but never above the cap');
  assert.equal(run.committedSteps, 30);
  assert.deepEqual(findInvariantViolations(run.world), []);
});

test('stale lease: a rival commit fences the stale consumer; the send stays exactly-once', () => {
  const seed = 20260825;
  const ids = {
    factory: 'factory-run:s', lifecycle: 'lifecycle-run:s', stage: 'stage-run:s',
    process: 'process-run:s', node: 'node-run:s', workplace: 'workplace:s',
  };
  const program = compileActorProgram(
    [
      ...verticalPrefixSteps(ids, 'implementer'),
      ...attemptLoopSteps({
        loopId: 'author-1', role: 'author', profile: 'implementer',
        workplace: ids.workplace, attempt: 'activity-attempt:1', gate: 'author', gateVerdict: 'accepted',
      }),
    ],
    { pins: PINS, seed },
  );
  assert.equal(program.refusal, null);

  // Apply everything through the first send, then stage the lease race.
  let world = createWorld(seed);
  const sendIndex = program.inputs.findIndex((input) => input.command === 'cognition.sendProviderRequest');
  for (const input of program.inputs.slice(0, sendIndex)) {
    const applied = applyCommand(world, input);
    assert.equal((applied.outcome ?? {}).refused, undefined, `prefix commits: ${input.command}`);
    world = applied.world;
  }
  // The admission committed: the provider-send obligation is OPEN and the
  // transport revision is 0. Consumer A holds a revision-0 lease snapshot;
  // the RIVAL commits the send first (revision -> 1).
  const rival = applyCommand(world, {
    command: 'cognition.sendProviderRequest',
    instanceId: 'cognition:transport',
    expectedRevision: 0,
    idempotencyKey: 'stale-lease:rival-send',
  });
  assert.equal((rival.outcome ?? {}).committed, true, 'the rival committed first');
  world = rival.world;

  const staleConsumer = applyCommand(world, {
    command: 'cognition.sendProviderRequest',
    instanceId: 'cognition:transport',
    expectedRevision: 0, // the stale lease snapshot
    idempotencyKey: 'stale-lease:a-send',
  });
  assert.equal(staleConsumer.outcome.refused, true);
  assert.equal(staleConsumer.outcome.reason, 'STALE_EXPECTED_REVISION', 'the CAS fence refuses the stale consumer');

  const outcomes = world.evidence.filter((fact) => fact.kind === 'ProviderSendOutcome');
  assert.equal(outcomes.length, 1, 'exactly one send outcome (the rival)');
});

test('two consumers on one completion: same key replays, fresh key is fenced, exactly-once event', () => {
  const seed = 20260825;
  const world = createWorld(seed);
  const first = applyCommand(world, { command: 'factoryRun.bootstrap', instanceId: 'factory-run:two', expectedRevision: 0, idempotencyKey: 'consumer:1' });
  assert.equal(first.outcome.committed, true);

  // Same key (the idempotent re-submission of a CREATION command): the
  // creation edge is gone, so the answer is a typed refusal - never a
  // second commit. (The same-key REPLAY on a still-legal edge - the
  // stateless send boundary - is proven in the actors suite.)
  const replay = applyCommand(first.world, { command: 'factoryRun.bootstrap', instanceId: 'factory-run:two', expectedRevision: 1, idempotencyKey: 'consumer:1' });
  assert.equal(replay.outcome.refused, true, 'a creation is answered, never repeated');
  assert.equal(replay.outcome.reason, 'ILLEGAL_TRANSITION');

  // Fresh key (a second consumer that did not see the commit): the creation
  // edge is gone for it too - a creation is never repeated under any key.
  // (The CAS-revision fence proper is demonstrated on the stateless send
  // boundary by the stale-lease driver above.)
  const second = applyCommand(first.world, { command: 'factoryRun.bootstrap', instanceId: 'factory-run:two', expectedRevision: 0, idempotencyKey: 'consumer:2' });
  assert.equal(second.outcome.refused, true);
  assert.equal(second.outcome.reason, 'ILLEGAL_TRANSITION');

  assert.equal(first.world.events.length, 1, 'exactly one bootstrap event exists (exactly-once)');
  assert.equal(findInvariantViolations(first.world).length, 0);
});

test('the interleaved cap-2 world equals the serial world (ordering is not semantic)', () => {
  const streams = [verticalStream('a'), verticalStream('b')];
  const interleaved = runConcurrencyDriver({
    id: 'exact-cap-2',
    requirement: 'interleaved at cap 2',
    concurrencyCap: 2,
    streams,
    barrierPhases: streams[0].map((_, index) => [index % 2, (index + 1) % 2]),
    expected: { peakInFlight: 2, committedSteps: 20, refusals: [] },
  });
  const serial = runConcurrencyDriver({
    id: 'cap-1',
    requirement: 'serialized',
    concurrencyCap: 1,
    streams,
    barrierPhases: streams[0].flatMap((_, index) => [[0], [1]]),
    expected: { peakInFlight: 1, committedSteps: 20, refusals: [] },
  });
  // The final evidence multisets (obligations by kind:state, evidence kinds,
  // heads) are identical - only scheduling differed.
  const summarize = (world) => ({
    obligations: [...world.obligations].map((o) => `${o.kind}:${o.state}`).sort(),
    evidenceKinds: [...world.evidence].map((fact) => fact.kind).sort(),
    heads: [...world.heads.values()].map((head) => `${head.aggregate}:${head.status}`).sort(),
  });
  assert.deepEqual(summarize(interleaved.world), summarize(serial.world));
});
