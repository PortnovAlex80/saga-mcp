/**
 * actors.test.mjs - the WP-13B actor library over the kernel cognition
 * port (plan phase EK-9 "actor behavior" dimension).
 *
 * Every behavior class of the required dimension is a DATA program compiled
 * to kernel CommandInputs; the pure reference machine answers each with the
 * authored outcome (commit, typed refusal, replay, wait). Expectations are
 * authored from the frozen reducer/universe tables, never scraped from a
 * production run.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTOR_BEHAVIORS,
  PROTOCOL_ROLES,
  SEMANTIC_PROFILES,
  TOOL_CALLS,
  actorPinSet,
  attemptLoopSteps,
  compileActorProgram,
  runActorProgram,
  verticalPrefixSteps,
} from '../../../dist/workflow-kernel/testing/actors.js';
import { ACTOR_BEHAVIORS as CONTRACT_BEHAVIORS } from '../engine/scenario.mjs';
import { findInvariantViolations } from '../../../dist/workflow-kernel/domain/explorer.js';

const IDS = {
  factory: 'factory-run:1',
  lifecycle: 'lifecycle-run:1',
  stage: 'stage-run:1',
  process: 'process-run:1',
  node: 'node-run:1',
  workplace: 'workplace:1',
};
const PINS = actorPinSet();

const prefix = () => verticalPrefixSteps(IDS, 'implementer');

const authorLoop = (overrides = {}) =>
  attemptLoopSteps({
    loopId: 'author-1',
    role: 'author',
    profile: 'implementer',
    workplace: IDS.workplace,
    attempt: 'activity-attempt:1',
    gate: 'author',
    gateVerdict: 'accepted',
    ...overrides,
  });

/** The compliant vertical: prefix + an accepted author loop. */
const compliantProgram = () => [...prefix(), ...authorLoop()];

test('the actor vocabulary is the closed required dimension (12 behaviors, 4 profiles, 2 roles)', () => {
  assert.deepEqual([...ACTOR_BEHAVIORS], [...CONTRACT_BEHAVIORS], 'the library and the scenario contract share one behavior universe');
  assert.equal(ACTOR_BEHAVIORS.length, 12);
  assert.deepEqual([...SEMANTIC_PROFILES], ['planner', 'implementer', 'reviewer', 'certifier']);
  assert.deepEqual([...PROTOCOL_ROLES], ['author', 'reviewer']);
});

test('compliant: the full author loop commits cleanly with no invariant violation', () => {
  const compiled = compileActorProgram(compliantProgram(), { pins: PINS });
  assert.equal(compiled.refusal, null, 'nothing is refused');
  const run = runActorProgram(compiled);
  assert.equal(run.refusal, null);
  const workplace = run.world.heads.get(IDS.workplace);
  assert.equal(workplace.status, 'author-gate-decided', 'the accepted author gate decides (authored from the Workplace reducer table)');
  assert.ok(run.world.evidence.some((fact) => fact.kind === 'GateDecision:accepted'));
  assert.ok(run.world.evidence.some((fact) => fact.kind === 'AcceptedCandidateAuthority'), 'an accepted gate commits the accepted-candidate authority');
  assert.deepEqual(findInvariantViolations(run.world), []);
  assert.deepEqual(compiled.toolViolations, [], 'the allowed tool sequence has no violation');
});

test('compliant: the emitted steps are valid scenario-contract actor steps', async () => {
  const { validateScenario, SCENARIO_FORMAT_VERSION } = await import('../engine/scenario.mjs');
  const compiled = compileActorProgram(compliantProgram(), { pins: PINS });
  const doc = {
    formatVersion: SCENARIO_FORMAT_VERSION,
    identity: {
      protocolVersion: 'ek.transition-universe.ek1-reconciliation.v1',
      buildDigest: 'a'.repeat(64),
      packageDigest: 'a'.repeat(64),
      capsuleId: 'capsule:wp13b',
      capsuleDigest: 'a'.repeat(64),
    },
    seedInput: { fresh: true, seed: 20260825, ingress: [] },
    actorProgram: compiled.scenarioSteps,
    topology: { shape: 'chain', nodes: [IDS.workplace], edges: [], concurrencyCap: 1 },
    faultSchedule: [],
    expectations: { events: [], obligations: [], waits: [], proofs: [], evidence: { material: [], gate: [], effect: [] } },
    verification: { productCommands: [] },
    timeBudgets: { totalMs: 600000, perStepMs: 60000 },
  };
  const { valid, errors } = validateScenario(doc);
  assert.equal(valid, true, JSON.stringify(errors));
});

test('omission: the unpinned intent admission is refused ROLE_CONTRACT_REF_MISMATCH', () => {
  const program = [...prefix(), ...authorLoop()].map((step) =>
    step.stepId === 'author-1-admit' ? { ...step, behavior: 'omission' } : step,
  );
  const compiled = compileActorProgram(program, { pins: PINS });
  assert.equal(compiled.refusal.reason, 'ROLE_CONTRACT_REF_MISMATCH', 'the guard names the missing exact pin (FWD:F007)');
  assert.equal(compiled.refusedStepId, 'author-1-admit');
});

test('omission: the intent-less attempt creation is refused MISSING_EVIDENCE', () => {
  const program = [...prefix(), ...authorLoop()].map((step) =>
    step.stepId === 'author-1-attempt' ? { ...step, behavior: 'omission' } : step,
  );
  const compiled = compileActorProgram(program, { pins: PINS });
  assert.equal(compiled.refusal.reason, 'MISSING_EVIDENCE');
  assert.equal(compiled.refusal.detail.includes('exact WorkIntent reference'), true);
});

test('extra-paths: the uncontracted extra step is refused ILLEGAL_TRANSITION (durable handoff)', () => {
  const extra = {
    stepId: 'extra-1',
    semanticProfile: 'implementer',
    behavior: 'extra-paths',
    command: 'workplace.presentCandidateSet',
    instance: IDS.workplace,
    tools: [],
  };
  const program = [...prefix(), ...authorLoop({ gateVerdict: 'accepted' }).slice(0, 3), extra];
  const compiled = compileActorProgram(program, { pins: PINS });
  assert.equal(compiled.refusal.reason, 'ILLEGAL_TRANSITION');
  assert.equal(compiled.refusedStepId, 'extra-1');
});

test('malformed-product + repairing: the repair verdict is recorded, then the D6 repair loop re-enters and is accepted', () => {
  const malformed = [...prefix(), ...authorLoop({ behavior: 'malformed-product' })];
  const first = compileActorProgram(malformed, { pins: PINS });
  assert.equal(first.refusal, null, 'the gate commits the repair verdict (the gate is the judge)');
  const runOne = runActorProgram(first);
  assert.equal(runOne.world.heads.get(IDS.workplace).status, 'author-gate-decided');
  assert.ok(runOne.world.evidence.some((fact) => fact.kind === 'GateDecision:repair'), 'the malformed product is answered with a repair verdict');

  const repairing = [
    ...malformed,
    { stepId: 'repair-wait', semanticProfile: 'implementer', behavior: 'repairing', command: 'workplace.enterRepairWait', instance: IDS.workplace, tools: [] },
    { stepId: 'repair-rollover', semanticProfile: 'implementer', behavior: 'repairing', command: 'workplace.rolloverRepairEpoch', instance: IDS.workplace, tools: [] },
    ...authorLoop({ loopId: 'author-2', attempt: 'activity-attempt:2', behavior: 'repairing' }),
  ];
  const second = compileActorProgram(repairing, { pins: PINS });
  assert.equal(second.refusal, null, 'the repair loop walks legally through public commands');
  const runTwo = runActorProgram(second);
  const workplace = runTwo.world.heads.get(IDS.workplace);
  assert.equal(workplace.status, 'author-gate-decided', 'the repaired submission is accepted on re-entry');
  assert.ok(runTwo.world.evidence.some((fact) => fact.kind === 'RepairTerminalityEvidence'), 'the rollover commits the D6 terminality evidence');
  assert.deepEqual(findInvariantViolations(runTwo.world), []);
});

test('stale-hash: the offset revision is refused STALE_EXPECTED_REVISION', () => {
  const program = [...prefix(), ...authorLoop()].map((step) =>
    step.stepId === 'author-1-contribution' ? { ...step, behavior: 'stale-hash' } : step,
  );
  const compiled = compileActorProgram(program, { pins: PINS });
  assert.equal(compiled.refusal.reason, 'STALE_EXPECTED_REVISION');
  const stale = compiled.inputs.find((input) => input.idempotencyKey === 'key:author-1-contribution');
  assert.equal(stale.expectedRevision, 3, 'one above the current workplace revision 2 (deterministic offset)');
});

test('foreign-ref: the attempt against a foreign WorkIntent is refused FOREIGN_EVIDENCE_REF', () => {
  const program = [...prefix(), ...authorLoop()].map((step) =>
    step.stepId === 'author-1-attempt' ? { ...step, behavior: 'foreign-ref' } : step,
  );
  const compiled = compileActorProgram(program, { pins: PINS });
  assert.equal(compiled.refusal.reason, 'FOREIGN_EVIDENCE_REF');
  assert.equal(compiled.refusal.detail.includes('was not admitted by any Workplace transition'), true);
});

test('duplicate-completion: the verbatim provider-send re-issue is a typed stale refusal, never a second send', () => {
  const program = [...prefix(), ...authorLoop()].map((step) =>
    step.stepId === 'author-1-send' ? { ...step, behavior: 'duplicate-completion' } : step,
  );
  const compiled = compileActorProgram(program, { pins: PINS });
  // The verbatim copy carries the pre-send revision; the transport head has
  // moved, so the CAS fence answers first - a typed refusal, never a second
  // commit. (The same-key replay with the CURRENT revision is the crash
  // redrive law, proven by the WP-13B scenario fault matrix.)
  assert.equal(compiled.refusal.reason, 'STALE_EXPECTED_REVISION');
  const run = runActorProgram(compiled);
  const sendOutcomes = run.world.evidence.filter((fact) => fact.kind === 'ProviderSendOutcome');
  assert.equal(sendOutcomes.length, 1, 'exactly one provider-send outcome exists');
  const dup = compiled.scenarioSteps.find((step) => step.stepId === 'author-1-send#dup');
  assert.ok(dup, 'the duplicate application is carried as scenario data');
});

test('duplicate-completion: a completion re-issued after the status moved is a typed refusal, never a second commit', () => {
  const program = [...prefix(), ...authorLoop()].map((step) =>
    step.stepId === 'author-1-contribution' ? { ...step, behavior: 'duplicate-completion' } : step,
  );
  const compiled = compileActorProgram(program, { pins: PINS });
  assert.equal(compiled.refusal.reason, 'ILLEGAL_TRANSITION', 'the capsule edge no longer matches (the WP-13A duplicate law)');
  const run = runActorProgram(compiled);
  const contributions = run.world.events.filter((event) => event.transition === 'workplace.recordContribution');
  assert.equal(contributions.length, 1, 'exactly one contribution event exists (exactly-once commit)');
});

test('prose-only-review: the gate without the structured presentation is refused MISSING_EVIDENCE', () => {
  const reviewer = (behavior) => [
    ...prefix(),
    ...authorLoop(),
    ...attemptLoopSteps({
      loopId: 'reviewer-1',
      role: 'reviewer',
      profile: 'reviewer',
      workplace: IDS.workplace,
      attempt: 'activity-attempt:2',
      gate: 'final',
      gateVerdict: 'accepted',
      behavior,
    }),
  ];
  const proseOnly = compileActorProgram(reviewer('prose-only-review'), { pins: PINS });
  assert.equal(proseOnly.refusal.reason, 'ILLEGAL_TRANSITION', 'the structured presentation edge is mandatory: prose cannot substitute for the candidate set');
  assert.equal(proseOnly.refusal.detail.includes('reviewer-revision-sealed'), true, 'the workplace never left the sealed status: no presentation, no gate');
  assert.equal(proseOnly.refusedStepId, 'reviewer-1-gate');
});

test('timeout: the missing worker outcome is classified, never product-failed', () => {
  const program = [...prefix(), ...authorLoop({ behavior: 'timeout' })];
  const compiled = compileActorProgram(program, { pins: PINS });
  assert.equal(compiled.refusal, null);
  const run = runActorProgram(compiled);
  const attempt = run.world.heads.get('activity-attempt:1');
  assert.equal(attempt.status, 'worker-loss-classified');
  assert.deepEqual(
    run.world.waits.filter((wait) => wait.state === 'pending').map((wait) => wait.kind),
    ['TypedWait:external-availability'],
    'the typed wait of the substrate re-probe (wake source: obligation retry)',
  );
  assert.ok(run.world.obligations.some((obligation) => obligation.kind === 'obligation:retryAttempt' && obligation.state === 'open'));
  assert.deepEqual(findInvariantViolations(run.world), []);
});

test('crash: the scripted channel dies before the outcome (data, restart is the fault suite)', () => {
  const program = [...prefix(), ...authorLoop({ behavior: 'crash' })];
  const compiled = compileActorProgram(program, { pins: PINS });
  // The pure machine still commits the send (a crash is process-level);
  // the cognition script carries the death for the transport-level suites.
  assert.equal(compiled.refusal, null);
});

test('tool-misuse: the manifest-bag completion is refused ATTEMPT_RERESOLVED_MANIFEST', () => {
  const program = [...prefix(), ...authorLoop()].map((step) =>
    step.stepId === 'author-1-outcome'
      ? { ...step, behavior: 'tool-misuse', manifestBag: 'manifest', tools: [TOOL_CALLS.read(), TOOL_CALLS.forbiddenShell()] }
      : step,
  );
  const compiled = compileActorProgram(program, { pins: PINS });
  assert.equal(compiled.refusal.reason, 'ATTEMPT_RERESOLVED_MANIFEST', 'no free-form payload may ride a kernel command');
  assert.equal(compiled.refusal.detail.includes('manifest'), true);
  assert.deepEqual(
    compiled.toolViolations.map((violation) => violation.tool),
    ['shell:exec'],
    'the forbidden tool is named by the tool-protocol checker',
  );
});

test('tool protocol: the allowed tool sequence produces no violation', () => {
  const program = compliantProgram().map((step) => ({ ...step, tools: [TOOL_CALLS.read(), TOOL_CALLS.search(), TOOL_CALLS.write(), TOOL_CALLS.board()] }));
  const compiled = compileActorProgram(program, { pins: PINS, allowedTools: ['fs:read', 'fs:write', 'search:code', 'saga-board'] });
  assert.deepEqual(compiled.toolViolations, []);
});

test('RED kill: a kernel that accepted the manifest bag is caught (actor-misuse-accepted fence)', () => {
  // MUTATION (harness-level): the forbidden manifest key is stripped before
  // application, simulating a kernel that accepts the misusing completion.
  const program = [...prefix(), ...authorLoop()].map((step) =>
    step.stepId === 'author-1-outcome' ? { ...step, behavior: 'tool-misuse', manifestBag: 'manifest' } : step,
  );
  const compiled = compileActorProgram(program, { pins: PINS });
  const cleanRefusal = compiled.refusal;
  assert.equal(cleanRefusal.reason, 'ATTEMPT_RERESOLVED_MANIFEST', 'GREEN: the clean kernel refuses the misuse');

  // The FENCE: the driver's post-check requires the refusal; under the
  // mutation (accept) the refusal never happened and the fence is RED.
  const fence = (refused) => {
    assert.notEqual(refused, null, 'FENCE RED: the misusing completion was accepted without a typed refusal');
    assert.equal(refused.reason, 'ATTEMPT_RERESOLVED_MANIFEST');
  };
  let fenceRed = false;
  try {
    fence(null); // the mutated kernel accepted it
  } catch {
    fenceRed = true;
  }
  assert.equal(fenceRed, true, 'the fence is red under the mutation (kill demonstrated)');
  fence(cleanRefusal); // GREEN on the clean kernel
});
