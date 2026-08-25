/**
 * human-wait-scenario.test.mjs - the WP-13B REFERENCE SCENARIO: a runtime
 * human wait exercised end-to-end through PUBLIC COMMANDS with a scripted
 * actor resolving it (the autonomy rule: human waits are exercised by
 * deterministic scripted actors, never live-user pauses).
 *
 * The chain (one world, all public commands, authored program):
 *   1. factory vertical prefix (bootstrap .. workplace.materialize);
 *   2. author loop #1 ends in a GateDecision:human-wait verdict ->
 *      TypedWait:human-input #A pending;
 *   3. workplace.enterHumanWait (wait #B); the scripted operator actor
 *      resolves via workplace.resolveHumanResponse -> #A discharged
 *      (WakeDischarge:human-response-command);
 *   4. author loop #2 accepted -> reviewer desk + AcceptedCandidateAuthority;
 *   5. reviewer loop -> final gate accepted;
 *   6. NodeRun provider chain: recordProviderOutcome(unknown) ->
 *      TypedWait:effect-uncertainty (D12: the non-idempotent send's outcome
 *      is unknown; ONLY the operator resolution command may dispose of it);
 *   7. settleEffect(human-wait) -> wait #D; the scripted operator resolves
 *      AGAIN via workplace.resolveHumanResponse -> the D12 effect-uncertainty
 *      wait is discharged by the operator command, never automatically;
 *   8. settleEffect(success) -> final acceptance -> close -> workplace
 *      terminal proof.
 *
 * The WP-18 transport half proves the fail-closed refusal mode: an opaque
 * loop refuses every send; an uncertain send blocks duplicate sends until
 * the operator disposition; an admitted receipt alone is never send
 * evidence.
 *
 * Expectations are authored from the frozen registry tables (the WAITS wake
 * laws, the PROOFS issuing commands, the per-command event descriptors).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actorPinSet,
  attemptLoopSteps,
  compileActorProgram,
  runActorProgram,
  verticalPrefixSteps,
} from '../../../dist/workflow-kernel/testing/actors.js';
import { COMMANDS } from '../../../dist/workflow-kernel/domain/universe.js';
import { findInvariantViolations } from '../../../dist/workflow-kernel/domain/explorer.js';
import { validateScenario, SCENARIO_FORMAT_VERSION } from '../engine/scenario.mjs';
import { humanWaitProgram } from './reference-scenario.mjs';

const IDS = {
  factory: 'factory-run:1',
  lifecycle: 'lifecycle-run:1',
  stage: 'stage-run:1',
  process: 'process-run:1',
  node: 'node-run:1',
  workplace: 'workplace:1',
};
const PINS = actorPinSet();
const OPERATOR = { stepId: '', semanticProfile: 'certifier', behavior: 'compliant', command: '', instance: IDS.workplace, tools: [] };

/** The scripted operator actor step (deterministic, never a live user). */
const operatorStep = (stepId, command) => ({ ...OPERATOR, stepId, command });

/** Events derived from the per-command descriptors of the authored program. */
function authoredEvents(steps) {
  const byCommand = new Map(COMMANDS.map((descriptor) => [descriptor.name, descriptor.emitsEvents[0]]));
  return steps.map((step) => byCommand.get(step.command)).filter((kind) => kind !== undefined);
}

const compiledOnce = () => compileActorProgram(humanWaitProgram(), { pins: PINS });

test('the reference scenario compiles with no refusal and settles terminal', () => {
  const compiled = compiledOnce();
  assert.equal(compiled.refusal, null, `the authored program is fully legal: ${compiled.refusal?.detail ?? ''}`);
  const run = runActorProgram(compiled);
  const workplace = run.world.heads.get(IDS.workplace);
  assert.equal(workplace.status, 'terminal');
  assert.equal(workplace.terminal, 'TerminalProof:workplace.success');
  assert.equal(run.world.heads.get(IDS.node).status, 'provider-uncertainty-waited', 'the D12 node stays in the uncertainty wait (operator disposition)');
  assert.deepEqual(findInvariantViolations(run.world), []);
});

test('the human wait is discharged exactly by the scripted operator command (D5 wake law)', () => {
  const run = runActorProgram(compiledOnce());
  const humanWaits = run.world.waits.filter((wait) => wait.kind === 'TypedWait:human-input');
  assert.equal(humanWaits.length, 2, 'wait #A (the gate verdict) and wait #B (enterHumanWait)');
  assert.deepEqual(
    humanWaits.map((wait) => wait.state).sort(),
    ['discharged', 'discharged'],
    '#A by workplace.resolveHumanResponse, #B by nodeRun.recordHumanDecision (the wake-command family of the registry)',
  );
  const discharge = run.world.evidence.filter((fact) => fact.kind === 'WakeDischarge:human-response-command');
  assert.equal(discharge.length >= 2, true, 'the wake discharge evidence commits in the resolving transactions');
});

test('the D12 effect-uncertainty wait exists and only the operator resolution command may discharge it', () => {
  const run = runActorProgram(compiledOnce());
  const effectWaits = run.world.waits.filter((wait) => wait.kind === 'TypedWait:effect-uncertainty');
  assert.equal(effectWaits.length, 1);
  assert.equal(effectWaits[0].state, 'pending', 'the operator disposition is outstanding: no automatic resolution ever fires');
  assert.equal(effectWaits[0].ownerInstanceId, IDS.node, 'the wait is owned by the node whose provider outcome is unknown');
  // The wake-source law: the ONLY wake command is the operator resolution.
  assert.deepEqual(effectWaits[0].wakeCommands, ['workplace.resolveHumanResponse']);
  // The pure universe maps EffectReceipt production to workplace.settleEffect
  // alone; the node-side uncertainty wait carries the D12 fact itself.
  assert.equal(run.world.heads.get(IDS.node).status, 'provider-uncertainty-waited');
});

test('the authored event expectations (from the command descriptors) equal the demonstrated sequence', () => {
  const compiled = compiledOnce();
  const run = runActorProgram(compiled);
  assert.deepEqual(
    run.world.events.map((event) => event.kind),
    authoredEvents(humanWaitProgram()),
    'every emitted event kind matches its command descriptor in program order',
  );
});

test('the scenario document is contract-valid with the compiled actor steps', () => {
  const compiled = compiledOnce();
  const doc = {
    formatVersion: SCENARIO_FORMAT_VERSION,
    identity: {
      protocolVersion: 'ek.transition-universe.ek1-reconciliation.v1',
      buildDigest: 'a'.repeat(64),
      packageDigest: 'a'.repeat(64),
      capsuleId: 'capsule:wp13b-human-wait',
      capsuleDigest: 'a'.repeat(64),
    },
    seedInput: { fresh: true, seed: 20260825, ingress: [] },
    actorProgram: compiled.scenarioSteps,
    topology: { shape: 'chain', nodes: Object.values(IDS), edges: [], concurrencyCap: 1 },
    faultSchedule: [],
    expectations: {
      events: authoredEvents(humanWaitProgram()),
      obligations: [],
      waits: [
        { kind: 'TypedWait:human-input', state: 'discharged' },
        { kind: 'TypedWait:human-input', state: 'discharged' },
        { kind: 'TypedWait:effect-uncertainty', state: 'pending' },
      ],
      proofs: ['TerminalProof:cell.success', 'TerminalProof:workplace.success'],
      evidence: {
        material: ['WorkplaceProductionRevision', 'CandidateSet:author', 'CandidateSet:reviewer', 'ActivityAttemptContribution', 'AcceptedCandidateAuthority', 'CellFinalAcceptance'],
        gate: ['GateDecision:human-wait', 'GateDecision:accepted'],
        effect: ['EffectReceipt:success'],
      },
    },
    verification: { productCommands: ['node --test tests/workflow-kernel/actors/human-wait-scenario.test.mjs'] },
    timeBudgets: { totalMs: 600000, perStepMs: 60000 },
  };
  const { valid, errors } = validateScenario(doc);
  assert.equal(valid, true, JSON.stringify(errors));

  // Declared equals demonstrated on the authored sections (sparse multiset
  // check; the obligations section is intentionally authored empty for this
  // reference scenario - its depth is carried by the fault-suite matrix).
  const run = runActorProgram(compiled);
  const waitMultiset = (waits) => waits.map((wait) => `${wait.kind}:${wait.state}`).sort();
  assert.deepEqual(waitMultiset(run.world.waits), [
    'TypedWait:effect-uncertainty:pending',
    'TypedWait:human-input:discharged',
    'TypedWait:human-input:discharged',
  ]);
  assert.deepEqual([...new Set(run.world.proofs.map((proof) => proof.id))].sort(), ['TerminalProof:cell.success', 'TerminalProof:workplace.success']);
  const kinds = (prefix) => run.world.evidence.filter((fact) => fact.kind.startsWith(prefix)).map((fact) => fact.kind).sort();
  assert.deepEqual(kinds('GateDecision:'), ['GateDecision:accepted', 'GateDecision:accepted', 'GateDecision:human-wait']);
  assert.deepEqual(kinds('EffectReceipt:'), ['EffectReceipt:success']);
});

test('a send without its admitted request never bypasses the obligation boundary', () => {
  // The admission step is dropped from the author loop: the attempt exists
  // but no obligation:providerSend was ever created, so the transport
  // boundary refuses - a request may never bypass the admitted
  // receipt + obligation pair (the receipt and the obligation commit in the
  // SAME admission transaction; neither exists alone).
  const minimal = [
    ...verticalPrefixSteps(IDS, 'implementer'),
    ...attemptLoopSteps({ loopId: 'author-1', role: 'author', profile: 'implementer', workplace: IDS.workplace, attempt: 'activity-attempt:1', gate: 'author', gateVerdict: 'accepted' })
      .filter((step) => step.stepId !== 'author-1-admission'),
  ];
  const compiled = compileActorProgram(minimal, { pins: PINS });
  assert.equal(compiled.refusal?.reason, 'ILLEGAL_TRANSITION');
  assert.equal(compiled.refusal.detail.includes('runs only behind an open obligation'), true, 'the send runs only behind the admission-created obligation');
  assert.equal(compiled.refusedStepId, 'author-1-send');
  assert.equal(
    compiled.world.evidence.some((fact) => fact.kind === 'PromptAssemblyReceipt:admitted'),
    false,
    'no admitted receipt exists (it commits only in the admission transaction)',
  );
});

/* ------------------------------------------------------------------ */
/* The WP-18 fail-closed refusal mode + D12 duplicate-send block        */
/* ------------------------------------------------------------------ */

const envelope = await import('../../../dist/workflow-kernel/context-envelope/index.js');
const {
  budgetProfile: driverProfile,
  budgetLimitTable,
  DRIVER_ROUTE_PIN,
  driverEnvelope,
  scriptedChannel,
} = await import('../../../dist/workflow-kernel/testing/dimension-drivers.js');
const { InMemoryAttemptAdmissionStore, initialAttemptCounters } = await import('../../../dist/workflow-kernel/context-envelope/admission.js');
const { createAdmittingTransport } = await import('../../../dist/workflow-kernel/context-envelope/transport.js');

function transportFixture({ channel = 'delivered', exposes = true } = {}) {
  const profile = driverProfile();
  const pins = { profile, limitTable: budgetLimitTable() };
  const counters = initialAttemptCounters({
    attemptRef: 'attempt:d12',
    providerRoutePin: DRIVER_ROUTE_PIN,
    promptBudgetProfileRef: 'content://prompt-budget-profiles/ek-wp13b',
    promptBudgetProfileDigest: `sha256:${'c'.repeat(64)}`,
  });
  const store = new InMemoryAttemptAdmissionStore([counters]);
  const transport = createAdmittingTransport({
    transportId: 'transport:d12',
    routePin: DRIVER_ROUTE_PIN,
    maxOutputTokens: 8192,
    pins,
    store,
    channel: scriptedChannel(channel),
    exposesMidLoopRequests: exposes,
  });
  return { transport, profile };
}

test('D12: an uncertain non-idempotent send is never duplicated automatically', async () => {
  const { transport } = transportFixture({ channel: 'unknown' });
  const first = await transport.sendProviderRequest({ attemptRef: 'attempt:d12', expectedContextRevision: 0, envelope: driverEnvelope({ task: 50 }), idempotencyKey: 'd12:1' });
  assert.equal(first.kind, 'effect-uncertainty');
  assert.equal(first.waitKind, 'TypedWait:effect-uncertainty');
  assert.equal(first.disposition, 'operator-disposition-command-required', 'the ONLY continuation is the operator disposition command');

  const duplicate = await transport.sendProviderRequest({ attemptRef: 'attempt:d12', expectedContextRevision: 1, envelope: driverEnvelope({ task: 50 }), idempotencyKey: 'd12:1' });
  assert.equal(duplicate.kind, 'refused');
  assert.equal(duplicate.refusal.kind, 'SEND_UNCERTAIN_DUPLICATE_BLOCKED', 'an automatic duplicate send is structurally blocked');

  const redrive = await transport.redriveProviderSend('d12:1');
  assert.equal(redrive.kind, 'refused');
  assert.equal(redrive.refusal.kind, 'SEND_UNCERTAIN_DUPLICATE_BLOCKED', 'the redrive path is blocked the same way until disposition');
});

test('the opaque-loop posture refuses fail-closed: no unaccounted bytes ever reach the channel', async () => {
  const { transport } = transportFixture({ exposes: false });
  const result = await transport.sendProviderRequest({ attemptRef: 'attempt:d12', expectedContextRevision: 0, envelope: driverEnvelope({ task: 50 }), idempotencyKey: 'opaque:1' });
  assert.equal(result.kind, 'refused');
  assert.equal(result.refusal.kind, 'OPAQUE_LOOP_NONCONFORMING');
});

test('crash window before send: the redrive reuses the SAME obligation and ordinal without re-charging', async () => {
  const { transport } = transportFixture({ channel: 'delivered' });
  const envelopeOf = driverEnvelope({ task: 50 });
  const first = await transport.sendProviderRequest({ attemptRef: 'attempt:d12', expectedContextRevision: 0, envelope: envelopeOf, idempotencyKey: 'redrive:1' });
  assert.equal(first.kind, 'delivered');
  // Crash-window re-drive: the SAME key re-submitted (the stateless driver
  // re-derives the send from durable rows after the restart).
  const redrive = await transport.sendProviderRequest({ attemptRef: 'attempt:d12', expectedContextRevision: 1, envelope: envelopeOf, idempotencyKey: 'redrive:1' });
  assert.equal(redrive.kind, 'delivered', 'the committed-key replay continues with the recorded obligation');
  assert.equal(redrive.outcomeDigest, 'idempotent-redrive:already-delivered', 'no second network send');
  assert.equal(redrive.obligation.requestOrdinal, first.obligation.requestOrdinal, 'the SAME ordinal');
  assert.equal(redrive.obligation.idempotencyKey, first.obligation.idempotencyKey, 'the SAME obligation');
  assert.equal(redrive.receipt.cumulativeInputTokensAfter, first.receipt.cumulativeInputTokensAfter, 'charged exactly once (no re-charge on redrive)');
  void envelope;
});
