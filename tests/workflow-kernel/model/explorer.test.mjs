/**
 * explorer.test.mjs - the reference state explorer: every declared command
 * has a generated positive trace, traces are deterministic under the
 * retained seed, illegal traces refuse with typed reasons, and a failing
 * trace minimizes while preserving the seed (WP-05).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const explorer = await import('../../../dist/workflow-kernel/domain/explorer.js');
const { COMMAND_NAMES } = await import('../../../dist/workflow-kernel/domain/universe.js');

const SEED = 20260825;

test('every declared transition has a generated positive trace (53/53)', () => {
  const traces = explorer.generateAllLegalTraces(SEED);
  const missing = COMMAND_NAMES.filter((name) => !traces.get(name)?.reached);
  assert.deepEqual(missing, [], `commands without a positive trace: ${missing.join(', ')}`);
  for (const [name, trace] of traces) {
    assert.ok(trace.steps.length > 0, `${name} has a nonempty trace`);
    assert.equal(trace.steps[trace.steps.length - 1].input.command, name, `${name} trace ends with its own application`);
    assert.equal(trace.seed, SEED, `${name} trace retains the seed`);
  }
});

test('positive traces are committed histories: replaying every step reproduces the outcome', () => {
  const traces = explorer.generateAllLegalTraces(SEED);
  for (const [name, trace] of traces) {
    const run = explorer.runSteps(trace.steps.map((s) => s.input), SEED);
    assert.equal(run.refusal, undefined, `${name} trace replays without refusal`);
    assert.equal(run.steps.length, trace.steps.length, `${name} replay is complete`);
  }
});

test('trace generation is deterministic for a fixed seed', () => {
  const a = explorer.generateLegalTrace('workplace.runFinalGate', SEED);
  const b = explorer.generateLegalTrace('workplace.runFinalGate', SEED);
  assert.deepEqual(a.steps.map((s) => s.input), b.steps.map((s) => s.input));
  assert.equal(a.reached, true);
});

test('the static ancestor graph is derived from the frozen universe', () => {
  const ancestors = explorer.staticAncestors('factoryRun.recordRunTerminalProof');
  assert.ok(ancestors.includes('factoryRun.bootstrap'));
  assert.ok(ancestors.includes('workplace.runFinalGate'));
  assert.ok(ancestors.includes('processRun.settle'));
  assert.ok(!ancestors.includes('factoryRun.recordRunTerminalProof'), 'the target is not its own ancestor');
});

/* ---------------- illegal traces ---------------- */

function legalPrefixThrough(command) {
  const traces = explorer.generateAllLegalTraces(SEED);
  for (const trace of traces.values()) {
    const index = trace.steps.findIndex((s) => s.input.command === command);
    if (index >= 0) return trace.steps.slice(0, index + 1).map((s) => s.input);
  }
  return undefined;
}

test('illegal trace: stale expected revision (mutation e class)', () => {
  const prefix = legalPrefixThrough('factoryRun.bootstrap');
  const world0 = explorer.runSteps(prefix, SEED).world;
  const head = [...world0.heads.values()].find((h) => h.aggregate === 'FactoryRun');
  const run = explorer.runSteps([...prefix, { command: 'factoryRun.importCapsule', instanceId: head.instanceId, expectedRevision: head.revision + 3, idempotencyKey: 'x' }], SEED);
  assert.equal(run.refusal.reason, 'STALE_EXPECTED_REVISION');
});

test('illegal trace: illegal transition (wrong status)', () => {
  const prefix = legalPrefixThrough('factoryRun.bootstrap');
  const run = explorer.runSteps([...prefix, { command: 'factoryRun.start', instanceId: 'factory-run:1', expectedRevision: 1, idempotencyKey: 'x' }], SEED);
  assert.equal(run.refusal.reason, 'ILLEGAL_TRANSITION');
});

test('illegal trace: unknown command', () => {
  const run = explorer.runSteps([{ command: 'workplace.magic', instanceId: 'w', expectedRevision: 0, idempotencyKey: 'x' }], SEED);
  assert.equal(run.refusal.reason, 'UNKNOWN_COMMAND');
});

test('illegal trace: missing evidence terminalization', () => {
  const prefix = [
    { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'a' },
    { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', expectedRevision: 1, idempotencyKey: 'b' },
    { command: 'factoryRun.start', instanceId: 'factory-run:1', expectedRevision: 2, idempotencyKey: 'c' },
    { command: 'factoryRun.recordRunTerminalProof', instanceId: 'factory-run:1', expectedRevision: 3, idempotencyKey: 'd', terminalOutcome: 'success' },
  ];
  const run = explorer.runSteps(prefix, SEED);
  assert.equal(run.refusal.reason, 'MISSING_EVIDENCE');
});

test('illegal trace: the closed input shape refuses foreign keys', () => {
  const run = explorer.runSteps([{ command: 'factoryRun.bootstrap', instanceId: 'f', expectedRevision: 0, idempotencyKey: 'x', someFreeFormPayload: 1 }], SEED);
  assert.equal(run.refusal.reason, 'ATTEMPT_RERESOLVED_MANIFEST');
});

test('a failing trace minimizes while preserving the failure (delta debugging, seed retained)', () => {
  // start refuses (capsule not imported on that run); the continuation steps are droppable junk.
  const failing = [
    { command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'a' },
    { command: 'lifecycleRun.createContinuation', instanceId: 'lifecycle-run:1', expectedRevision: 0, idempotencyKey: 'b' },
    { command: 'lifecycleRun.createContinuation', instanceId: 'lifecycle-run:2', expectedRevision: 0, idempotencyKey: 'b2' },
    { command: 'factoryRun.start', instanceId: 'factory-run:1', expectedRevision: 1, idempotencyKey: 'c' },
  ];
  const predicate = (run) => run.refusal?.reason === 'ILLEGAL_TRANSITION';
  const original = explorer.runSteps(failing, SEED);
  assert.equal(original.refusal?.reason, 'ILLEGAL_TRANSITION');
  const { steps, minimized } = explorer.minimizeTrace(failing, predicate, SEED);
  assert.ok(minimized, 'the trace was minimized');
  assert.ok(steps.length < failing.length, 'steps were dropped');
  const run = explorer.runSteps(steps, SEED);
  assert.equal(run.refusal.reason, 'ILLEGAL_TRANSITION', 'the minimized trace still fails the same way');
  assert.equal(steps[steps.length - 1].command, 'factoryRun.start', 'the failing step is retained');
});

test('the mulberry32 PRNG is deterministic for a fixed seed', () => {
  const a = explorer.mulberry32(42);
  const b = explorer.mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
});
