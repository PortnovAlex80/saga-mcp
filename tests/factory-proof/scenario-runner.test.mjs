// tests/factory-proof/scenario-runner.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REFERENCE_SCENARIO } from './scenario-dsl.mjs';
import {
  KERNEL_SCENARIO_SCHEMA_VERSION,
  validateRunnableScenario,
  runScenario,
} from './scenario-runner.mjs';

const POSITIVE = Object.freeze({
  schemaVersion: KERNEL_SCENARIO_SCHEMA_VERSION,
  id: 'kernel/happy-path',
  kind: 'positive',
  proves: [],
  coverageItems: ['path:discovery>formalization>development'],
});

function bootstrap() {
  return {
    dbPath: '/tmp/fake.db',
    repoPath: '/tmp/repo',
    sagaRepoRoot: '/tmp/saga',
    cleanAssertions: 0,
    assertNoAuthorityWritesYet() { this.cleanAssertions += 1; },
  };
}

function fakeObserver() {
  return {
    getInvocationCount: () => 3,
    getReplayCount: () => 1,
    getMaxConcurrency: () => 1,
    getActive: () => 0,
    getOutcomes: () => [{ kind: 'done' }],
  };
}

function dependencies({ progressOk = true } = {}) {
  return {
    canonical: {
      createScriptedObserver: fakeObserver,
      buildCanonicalProofComposition: opts => ({ testComposition: true, observer: opts.observer }),
      driveCanonicalProof: async ({ composition }) => ({
        result: {
          reachedTerminal: true,
          terminalReason: 'accepted',
          cycles: 7,
          stoppedByCycleBound: false,
          strandedActiveExecutions: 0,
          effectiveConcurrency: 1,
          scriptedInvocationCount: 3,
          composition,
        },
        identity: {
          lifecycle: { id: 'product-delivery@1.0.0', stages: [{ stageId: 'development' }] },
          modules: [{ name: 'development', version: '1.0.0', packageDigest: 'a'.repeat(64) }],
          providers: [],
        },
        fingerprint: {
          fingerprint: 'b'.repeat(64),
          overlayKeys: ['workerExecutorFactory'],
          sections: { lifecycle: 'c'.repeat(64) },
        },
      }),
    },
    traceApi: {
      observeDurableTrace: () => ({
        observedAt: '2026-08-21T00:00:00.000Z',
        lifecycleRuns: [], processRuns: [], workIntents: [],
        workplaces: [], candidateSets: [], gateDecisions: [], checkReceipts: [],
        finalAcceptances: [], acceptedAuthorityHeads: [], effectReceipts: [],
        transitionObligations: [], recoveryEpochs: [], workerExecutions: [],
      }),
      classifyPostDrainProgress: () => ({
        ok: progressOk,
        rows: [],
        stalls: progressOk ? [] : [{ workplace: 'wp:stalled', classification: 'ANONYMOUS-STALL' }],
      }),
    },
  };
}

test('runner accepts both the common positive envelope and the strict causal DSL', () => {
  assert.deepEqual(validateRunnableScenario(POSITIVE), []);
  assert.deepEqual(validateRunnableScenario(REFERENCE_SCENARIO), []);
});

test('one generic runner produces the canonical evidence bundle', async () => {
  const boot = bootstrap();
  const evidence = await runScenario({
    scenario: POSITIVE,
    proofModes: ['CanonicalFast'],
    bootstrap: boot,
    handlers: { '*': () => ({ kind: 'noop' }) },
    driveOptions: { maxCycles: 20, pollMs: 1 },
    oracles: [{
      id: 'happy.reached-terminal',
      evaluate: ({ result }) => ({
        passed: result.reachedTerminal === true,
        evidenceRefs: ['terminal:accepted'],
      }),
    }],
  }, dependencies());

  assert.equal(boot.cleanAssertions, 1);
  assert.equal(evidence.verdict, 'pass');
  assert.equal(evidence.scenario.id, POSITIVE.id);
  assert.deepEqual(evidence.proofModes, ['CanonicalFast']);
  assert.equal(evidence.actorEvidence[0].invocationCount, 3);
  assert.equal(evidence.actorEvidence[0].replayCount, 1);
  assert.equal(evidence.oracleResults.length, 2, 'progress + scenario oracle');
  assert.match(evidence.bundleDigest, /^[0-9a-f]{64}$/);
});

test('anonymous stall fails the evidence even when the scenario oracle passes', async () => {
  const evidence = await runScenario({
    scenario: POSITIVE,
    proofModes: ['CanonicalFast'],
    bootstrap: bootstrap(),
    oracles: [{ id: 'terminal', evaluate: () => true }],
  }, dependencies({ progressOk: false }));
  assert.equal(evidence.verdict, 'fail');
  assert.equal(evidence.oracleResults[0].id, 'kernel.post-drain-progress');
  assert.equal(evidence.oracleResults[0].passed, false);
});

test('oracle exceptions are evidence failures, not invisible runner crashes', async () => {
  const evidence = await runScenario({
    scenario: POSITIVE,
    proofModes: ['CanonicalFast'],
    bootstrap: bootstrap(),
    oracles: [{ id: 'broken-oracle', evaluate: () => { throw new Error('oracle exploded'); } }],
  }, dependencies());
  assert.equal(evidence.verdict, 'fail');
  assert.match(evidence.oracleResults[1].details.oracleError, /oracle exploded/);
});

test('proof-mode seam mismatch and premature FaultSchedule claims fail before drive', async () => {
  await assert.rejects(
    runScenario({ scenario: POSITIVE, proofModes: ['CanonicalSpawn'], bootstrap: bootstrap() }, dependencies()),
    /CanonicalSpawn requires workerSpawn/,
  );
  await assert.rejects(
    runScenario({ scenario: POSITIVE, proofModes: ['CanonicalFast', 'FaultSchedule'], bootstrap: bootstrap() }, dependencies()),
    /FAULT_SCHEDULER_NOT_LANDED/,
  );
  await assert.rejects(
    runScenario({
      scenario: POSITIVE,
      proofModes: ['CanonicalFast'],
      bootstrap: bootstrap(),
      driveOptions: { composition: {} },
    }, dependencies()),
    /RESERVED_DRIVE_KEY/,
  );
});
