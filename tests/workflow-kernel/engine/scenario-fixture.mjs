/**
 * tests/workflow-kernel/engine/scenario-fixture.mjs - hand-authored EK-9
 * scenario fixtures (WP-13A engine tests).
 *
 * Every expected event/obligation/wait/proof/evidence kind below is
 * authored from the frozen EK-1 transition universe
 * (src/workflow-kernel/domain/universe.ts descriptors), NOT copied from
 * production output: factoryRun.bootstrap emits only
 * WorkflowEvent:factoryRun.bootstrapped and creates no obligations;
 * factoryRun.importCapsule emits WorkflowEvent:factoryRun.capsuleImported
 * and creates obligation:ingestCapsuleFacts (completed only by
 * factoryRun.start, absent here); workItem.planGraph emits
 * WorkflowEvent:workItem.graphPlanned and creates
 * obligation:instantiateDependantWorkplaces + obligation:openUnknownObligation;
 * lifecycleRun.createContinuation emits
 * WorkflowEvent:lifecycleRun.continuationCreated and creates
 * obligation:enterStage.continuation. None of them enters a terminal proof
 * or a typed wait, and no material/gate/effect evidence class is produced.
 */

import { SCENARIO_FORMAT_VERSION } from './scenario.mjs';

const HEX64 = 'a'.repeat(64);
const PLANNING_REFS = ['evidence:TerminalLifecycleClaim#external-planning', 'evidence:input'];

export const SEED = 20260825;

const baseShape = (over = {}) => ({
  formatVersion: SCENARIO_FORMAT_VERSION,
  identity: {
    protocolVersion: 'ek.transition-universe.ek1-reconciliation.v1',
    buildDigest: HEX64,
    packageDigest: HEX64,
    capsuleId: 'capsule:ek9-demo',
    capsuleDigest: HEX64,
  },
  seedInput: { fresh: true, seed: SEED, ingress: [] },
  actorProgram: [],
  topology: { shape: 'none', nodes: [], edges: [], concurrencyCap: 1 },
  faultSchedule: [],
  expectations: {
    events: [],
    obligations: [],
    waits: [],
    proofs: [],
    evidence: { material: [], gate: [], effect: [] },
  },
  verification: { productCommands: [] },
  timeBudgets: { totalMs: 600000, perStepMs: 60000 },
  ...over,
});

const bootstrapStep = () => ({ command: 'factoryRun.bootstrap', instanceId: 'factory-run:1', expectedRevision: 0, idempotencyKey: 'boot' });
const capsuleStep = () => ({ command: 'factoryRun.importCapsule', instanceId: 'factory-run:1', expectedRevision: 1, idempotencyKey: 'capsule' });
const ingressPair = () => [bootstrapStep(), capsuleStep()];

/**
 * Scenario 1: the minimal fresh-seed ingress (bootstrap + capsule import).
 * Authored expectations: two events, one open obligation, nothing else.
 */
export function ingressScenario() {
  return baseShape({
    seedInput: { fresh: true, seed: SEED, ingress: ingressPair() },
    topology: { shape: 'none', nodes: ['factory-run:1'], edges: [], concurrencyCap: 1 },
    expectations: {
      events: ['WorkflowEvent:factoryRun.bootstrapped', 'WorkflowEvent:factoryRun.capsuleImported'],
      obligations: [{ kind: 'obligation:ingestCapsuleFacts', state: 'open' }],
      waits: [],
      proofs: [],
      evidence: { material: [], gate: [], effect: [] },
    },
  });
}

/** The planner actor step (workItem.planGraph; independent of the continuation). */
export function planGraphStep() {
  return {
    stepId: 'plan-1',
    semanticProfile: 'planner',
    behavior: 'compliant',
    command: 'workItem.planGraph',
    instanceId: 'work-item:1',
    expectedRevision: 0,
    idempotencyKey: 'plan',
    evidenceRefs: [...PLANNING_REFS],
  };
}

/** The continuation actor step (lifecycleRun.createContinuation; independent of planning). */
export function continuationStep() {
  return {
    stepId: 'cont-1',
    semanticProfile: 'planner',
    behavior: 'compliant',
    command: 'lifecycleRun.createContinuation',
    instanceId: 'lifecycle-run:1',
    expectedRevision: 0,
    idempotencyKey: 'cont',
  };
}

/**
 * Scenario 2: fresh ingress plus two INDEPENDENT planner steps (planning and
 * a lifecycle continuation - no static dependency edge between them, so the
 * production scheduler may interleave them freely). Expected normalized
 * events are in the canonicalized independent-window order.
 */
export function planningScenario(actorOrder = ['plan', 'cont']) {
  const actors = actorOrder[0] === 'plan' ? [planGraphStep(), continuationStep()] : [continuationStep(), planGraphStep()];
  return baseShape({
    seedInput: { fresh: true, seed: SEED, ingress: ingressPair() },
    actorProgram: actors,
    topology: {
      shape: 'fan-out',
      nodes: ['factory-run:1', 'work-item:1', 'lifecycle-run:1'],
      edges: [['factory-run:1', 'work-item:1'], ['factory-run:1', 'lifecycle-run:1']],
      concurrencyCap: 2,
    },
    expectations: {
      events: [
        'WorkflowEvent:factoryRun.bootstrapped',
        'WorkflowEvent:factoryRun.capsuleImported',
        'WorkflowEvent:lifecycleRun.continuationCreated',
        'WorkflowEvent:workItem.graphPlanned',
      ],
      obligations: [
        { kind: 'obligation:enterStage.continuation', state: 'open' },
        { kind: 'obligation:ingestCapsuleFacts', state: 'open' },
        { kind: 'obligation:instantiateDependantWorkplaces', state: 'open' },
        { kind: 'obligation:openUnknownObligation', state: 'open' },
      ],
      waits: [],
      proofs: [],
      evidence: { material: [], gate: [], effect: [] },
    },
  });
}

/**
 * Scenario 1 + a duplicate-completion fault: the capsule import is re-issued
 * verbatim (same idempotency key) after the aggregate has moved on. The
 * kernel must answer with a TYPED refusal (ILLEGAL_TRANSITION: the capsule
 * edge no longer matches) - never a second commit: the normalized trace
 * carries the refusal step, no extra event, no extra obligation, and the
 * authored expectations still hold. (The idempotent REPLAY path itself -
 * same key, still-legal edge - is proven by the kernel model tests.)
 */
export function duplicateCompletionScenario() {
  const scenario = ingressScenario();
  scenario.faultSchedule = [
    { fault: 'duplicate-idempotency-key', anchor: { command: 'factoryRun.importCapsule', instanceId: 'factory-run:1' } },
  ];
  return scenario;
}

/**
 * The minimizer scenario: fresh ingress, three droppable junk steps, then a
 * factoryRun.start whose expected revision is stale (materialized by the
 * scheduled fault). The failure is the typed STALE_EXPECTED_REVISION refusal.
 */
export function staleRevisionScenario() {
  return baseShape({
    seedInput: { fresh: true, seed: SEED, ingress: ingressPair() },
    actorProgram: [
      {
        stepId: 'junk-1',
        semanticProfile: 'planner',
        behavior: 'extra-paths',
        command: 'lifecycleRun.createContinuation',
        instanceId: 'lifecycle-run:1',
        expectedRevision: 0,
        idempotencyKey: 'j1',
      },
      {
        stepId: 'junk-2',
        semanticProfile: 'planner',
        behavior: 'extra-paths',
        command: 'lifecycleRun.createContinuation',
        instanceId: 'lifecycle-run:2',
        expectedRevision: 0,
        idempotencyKey: 'j2',
      },
      {
        stepId: 'junk-3',
        semanticProfile: 'planner',
        behavior: 'extra-paths',
        command: 'workItem.planGraph',
        instanceId: 'work-item:1',
        expectedRevision: 0,
        idempotencyKey: 'j3',
        evidenceRefs: [...PLANNING_REFS],
      },
      {
        stepId: 'start-1',
        semanticProfile: 'planner',
        behavior: 'stale-hash',
        command: 'factoryRun.start',
        instanceId: 'factory-run:1',
        expectedRevision: 2,
        idempotencyKey: 'start',
      },
    ],
    topology: { shape: 'chain', nodes: ['factory-run:1', 'lifecycle-run:1', 'lifecycle-run:2', 'work-item:1'], edges: [], concurrencyCap: 1 },
    faultSchedule: [
      { fault: 'stale-expected-revision', anchor: { command: 'factoryRun.start', instanceId: 'factory-run:1' } },
    ],
    timeBudgets: { totalMs: 300000, perStepMs: 30000 },
  });
}

/**
 * The omission scenario: the scheduled evidence-omission fault strips the
 * planner step's evidence refs, and the kernel refuses the step with a typed
 * MISSING_EVIDENCE. Everything except the fault-anchored step is droppable
 * (the failure reproduces on the anchored step alone), which makes this the
 * anchor-protection witness for the minimizer tests.
 */
export function omissionScenario() {
  return baseShape({
    seedInput: { fresh: true, seed: SEED, ingress: ingressPair() },
    actorProgram: [
      {
        stepId: 'junk-1',
        semanticProfile: 'planner',
        behavior: 'extra-paths',
        command: 'lifecycleRun.createContinuation',
        instanceId: 'lifecycle-run:1',
        expectedRevision: 0,
        idempotencyKey: 'j1',
      },
      planGraphStep(),
    ],
    topology: { shape: 'chain', nodes: ['factory-run:1', 'lifecycle-run:1', 'work-item:1'], edges: [], concurrencyCap: 1 },
    faultSchedule: [
      { fault: 'evidence-omission', anchor: { command: 'workItem.planGraph', instanceId: 'work-item:1' } },
    ],
    timeBudgets: { totalMs: 300000, perStepMs: 30000 },
  });
}
