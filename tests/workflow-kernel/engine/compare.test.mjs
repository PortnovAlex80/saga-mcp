/**
 * compare.test.mjs - the EK-9 model-comparison core (WP-13A):
 *   - green path: the reference model driven from the scenario satisfies
 *     the authored (universe-derived) expectations exactly;
 *   - normalization: idempotency keys, sequence numbers, instance-id
 *     schemes and INDEPENDENT-TASK ORDERING are excluded from the oracle;
 *   - the comparison catches a known divergence at the exact step;
 *   - scheduled input-level faults are materialized (duplicate completion,
 *     evidence omission, stale revision) and scheduler-level faults refuse
 *     loudly instead of being silently skipped.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EngineFaultSchedulerRequiredError,
  FaultAnchorMissingError,
  compareScenarioExpectations,
  compareScenarioRun,
  driveReferenceModel,
  normalizeTrace,
} from './compare.mjs';
import { validateScenario } from './scenario.mjs';
import {
  duplicateCompletionScenario,
  ingressScenario,
  omissionScenario,
  planningScenario,
  staleRevisionScenario,
} from './scenario-fixture.mjs';

/* ---------------- green path ---------------- */

test('green path: the fresh-seed ingress satisfies the authored expectations', () => {
  const scenario = ingressScenario();
  const run = driveReferenceModel(scenario);
  assert.equal(run.refusal, undefined, 'the ingress spine commits cleanly');
  const expectations = compareScenarioExpectations(scenario, run);
  assert.deepEqual(expectations.differences, [], 'declared equals demonstrated');
  assert.deepEqual(run.normalized.events, scenario.expectations.events, 'the normalized event order matches the declaration');
  assert.deepEqual(run.summary.invariantViolations, [], 'no world invariant is violated');
});

test('green path: the scenario comparison is deterministic (rerun equals reference)', () => {
  const scenario = planningScenario();
  const actual = driveReferenceModel(planningScenario());
  const comparison = compareScenarioRun(scenario, actual);
  assert.equal(comparison.equal, true, JSON.stringify(comparison.trace.differences.concat(comparison.summary.differences, comparison.expectations.differences)));
});

test('green path: expectations hold for both independent-step orders', () => {
  for (const order of [['plan', 'cont'], ['cont', 'plan']]) {
    const run = driveReferenceModel(planningScenario(order));
    assert.equal(run.refusal, undefined);
    const expectations = compareScenarioExpectations(planningScenario(order), run);
    assert.deepEqual(expectations.differences, [], `order ${order.join('->')} satisfies the declaration`);
  }
});

/* ---------------- normalization ---------------- */

test('independent-task ordering is normalized: both interleavings compare equal', () => {
  const reference = driveReferenceModel(planningScenario(['plan', 'cont']));
  const actual = driveReferenceModel(planningScenario(['cont', 'plan']));
  // The RAW traces genuinely differ (order of the independent steps):
  const referenceCommands = reference.steps.map((step) => step.input.command);
  const actualCommands = actual.steps.map((step) => step.input.command);
  assert.notDeepEqual(referenceCommands, actualCommands, 'the raw traces differ by scheduling');
  const comparison = compareScenarioRun(planningScenario(['plan', 'cont']), actual);
  assert.equal(comparison.equal, true, 'normalized traces and evidence are equal');
});

test('idempotency keys, sequence numbers and revisions are excluded from the oracle', () => {
  const run = driveReferenceModel(planningScenario());
  const serialized = JSON.stringify(run.normalized.steps);
  assert.ok(!serialized.includes('"ingress:'), 'no derived ingress keys leak into the normalized trace');
  assert.ok(!serialized.includes('"key:'), 'no derived actor keys leak into the normalized trace');
  assert.ok(!serialized.includes('"sequence"'), 'no sequence numbers leak into the normalized trace');
  assert.ok(!serialized.includes('"expectedRevision"'), 'no CAS revisions leak into the normalized trace');
  assert.ok(!serialized.includes('"payloadDigest"'), 'no payload digests leak into the normalized trace');
});

test('instance-id schemes are normalized: renamed ids compare equal', () => {
  const scenario = planningScenario();
  const renamed = structuredClone(scenario);
  const rename = (id) => `${id}$renamed-scheme-9f`;
  for (const step of renamed.seedInput.ingress) step.instanceId = rename(step.instanceId);
  for (const step of renamed.actorProgram) step.instanceId = rename(step.instanceId);
  for (const step of [...renamed.seedInput.ingress, ...renamed.actorProgram]) {
    if (step.idempotencyKey !== undefined) step.idempotencyKey = `${step.idempotencyKey}$other`;
  }
  assert.equal(validateScenario(renamed).valid, true, 'the renamed scenario is still contract-valid');
  const actual = driveReferenceModel(renamed);
  const comparison = compareScenarioRun(scenario, actual);
  assert.equal(comparison.equal, true, 'an id-scheme difference is not a divergence');
});

test('normalizeTrace keeps the terminal refusal as the last normalized step', () => {
  const run = driveReferenceModel(staleRevisionScenario());
  assert.equal(run.refusal.reason, 'STALE_EXPECTED_REVISION');
  const normalized = normalizeTrace(run.steps);
  const last = normalized.steps[normalized.steps.length - 1];
  assert.equal(last.command, 'factoryRun.start');
  assert.equal(last.outcome, 'refused:STALE_EXPECTED_REVISION');
});

/* ---------------- final-evidence comparison ---------------- */

test('final evidence compares by normalized kind multiset (heads/obligations/waits/proofs)', () => {
  const a = driveReferenceModel(planningScenario());
  const b = driveReferenceModel(planningScenario(['cont', 'plan']));
  const comparison = compareScenarioRun(planningScenario(), b);
  assert.deepEqual(comparison.summary.differences, []);
  assert.deepEqual(a.summary.obligations, b.summary.obligations, 'obligation multisets are identical');
  assert.deepEqual(a.summary.evidenceKinds.sort(), b.summary.evidenceKinds.sort(), 'evidence-kind multisets are identical');
});

test('a declared-but-undemonstrated evidence kind is caught', () => {
  const scenario = ingressScenario();
  scenario.expectations.evidence.gate = ['GateDecision:accepted'];
  const run = driveReferenceModel(scenario);
  const expectations = compareScenarioExpectations(scenario, run);
  assert.equal(expectations.equal, false);
  assert.ok(
    expectations.differences.some((d) => d.section === 'evidence.gate' && d.kind === 'missing' && d.detail.includes('GateDecision:accepted')),
    'the missing gate evidence is named',
  );
});

/* ---------------- divergence catch ---------------- */

test('the comparison catches a known divergence at the exact step', () => {
  const scenario = planningScenario();
  const mutated = structuredClone(scenario);
  // The planner step is replaced by an out-of-turn factoryRun.start with a
  // stale expected revision: a refusal where the reference commits.
  mutated.actorProgram = mutated.actorProgram
    .filter((step) => step.command !== 'workItem.planGraph')
    .concat([
      {
        stepId: 'bad-1',
        semanticProfile: 'planner',
        behavior: 'tool-misuse',
        command: 'factoryRun.start',
        instanceId: 'factory-run:1',
        expectedRevision: 1,
        idempotencyKey: 'bad',
      },
    ]);
  const actual = driveReferenceModel(mutated);
  assert.equal(actual.refusal?.reason, 'STALE_EXPECTED_REVISION');
  const comparison = compareScenarioRun(scenario, actual);
  assert.equal(comparison.equal, false, 'the divergence is detected');
  const first = comparison.trace.differences[0];
  assert.equal(first.kind, 'step-mismatch');
  assert.ok(first.detail.includes('workItem.planGraph'), 'the reference step is named');
  assert.ok(first.detail.includes('factoryRun.start'), 'the actual step is named');
  assert.equal(comparison.expectations.equal, false, 'the authored expectations also fail');
});

/* ---------------- scheduled faults ---------------- */

test('duplicate completion is refused - never a second commit', () => {
  const scenario = duplicateCompletionScenario();
  const run = driveReferenceModel(scenario);
  const last = run.normalized.steps[run.normalized.steps.length - 1];
  assert.equal(last.command, 'factoryRun.importCapsule');
  assert.equal(last.outcome, 'refused:ILLEGAL_TRANSITION', 'the re-issue receives a typed refusal');
  // No duplicate event and no duplicate obligation reached the world:
  assert.deepEqual(run.normalized.events, [
    'WorkflowEvent:factoryRun.bootstrapped',
    'WorkflowEvent:factoryRun.capsuleImported',
  ]);
  const expectations = compareScenarioExpectations(scenario, run);
  assert.deepEqual(expectations.differences, [], 'the authored expectations still hold (exactly-once commit)');
  assert.deepEqual(run.appliedFaults.map((f) => f.fault), ['duplicate-idempotency-key']);
});

test('the scheduled stale revision is materialized and caught', () => {
  const run = driveReferenceModel(staleRevisionScenario());
  assert.equal(run.refusal.reason, 'STALE_EXPECTED_REVISION');
  assert.deepEqual(run.appliedFaults.map((f) => f.fault), ['stale-expected-revision']);
});

test('the scheduled evidence omission produces the typed MISSING_EVIDENCE refusal', () => {
  const run = driveReferenceModel(omissionScenario());
  assert.equal(run.refusal.reason, 'MISSING_EVIDENCE');
  assert.equal(run.refusal.detail.includes('workItem.planGraph'), true);
});

test('scheduler-level faults refuse loudly (never a silent skip)', () => {
  const scenario = ingressScenario();
  scenario.faultSchedule = [
    { fault: 'crash-before-commit', anchor: { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1' }, boundary: 'before-obligation' },
  ];
  assert.throws(
    () => driveReferenceModel(scenario),
    (error) => {
      assert.ok(error instanceof EngineFaultSchedulerRequiredError);
      assert.deepEqual(error.faults.map((f) => f.fault), ['crash-before-commit']);
      return true;
    },
  );
});

test('a fault anchored at an absent command application throws', () => {
  const scenario = ingressScenario();
  scenario.faultSchedule = [
    { fault: 'stale-expected-revision', anchor: { command: 'factoryRun.start', instanceId: 'factory-run:1' } },
  ];
  assert.throws(
    () => driveReferenceModel(scenario),
    (error) => {
      assert.ok(error instanceof FaultAnchorMissingError);
      assert.equal(error.fault.anchor.command, 'factoryRun.start');
      return true;
    },
  );
});
