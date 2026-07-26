import assert from 'node:assert/strict';
import test from 'node:test';

const { LifecycleOrchestrator } = await import(
  '../../dist/process-modules/application/lifecycle-orchestrator.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

const moduleDefinition = {
  identity: {
    name: 'test-module',
    version: '1.0.0',
    kind: 'test',
    displayName: 'Test Module',
    description: 'Lifecycle orchestrator test module.',
  },
  inputContract: { id: 'test.input.v1' },
  outputContract: { id: 'test.output.v1' },
  outcomes: [{ code: 'done', description: 'Done.', terminal: true }],
  flow: {
    id: 'test.flow',
    version: '1.0.0',
    entryNodeId: 'finish',
    nodes: [],
    transitions: [],
    terminalNodeIds: [],
  },
  artifacts: [],
  policies: [],
  invariants: [],
  executionProfiles: [],
};

function lifecycleDefinition(inputMapping = { value: '$.value' }) {
  return {
    identity: {
      name: 'test-lifecycle',
      version: '1.0.0',
      displayName: 'Test Lifecycle',
      description: 'One-stage lifecycle.',
    },
    entryStageId: 'stage-one',
    stages: [{
      id: 'stage-one',
      displayName: 'Stage One',
      moduleRef: {
        name: moduleDefinition.identity.name,
        version: moduleDefinition.identity.version,
      },
      inputMapping,
      outputMapping: { observedOutcome: '$.processOutcome.outcome' },
      outcomeRoutes: {
        done: { type: 'terminal', status: 'done' },
      },
      entryConditions: [],
      exitConditions: [],
    }],
  };
}

function completedProcess(id = 42) {
  return {
    id,
    status: 'completed',
    localOutcome: 'done',
    authority: 'test-policy',
    outputSchema: null,
    outputRef: null,
    outputHash: null,
    certificateSchema: null,
    certificateRef: null,
    certificateHash: null,
    error: null,
  };
}

function createHarness({
  definition = lifecycleDefinition(),
  rootInput = { value: 'mapped-value' },
  frozenInput = null,
  process = null,
  execute,
  renew = () => true,
  leaseDurationMs = 120_000,
}) {
  const state = {
    lifecycle: {
      id: 1,
      lifecycle: definition.identity,
      lifecycleRefKey: `${definition.identity.name}@${definition.identity.version}`,
      definitionSnapshot: canonicalJson(definition),
      definitionHash: sha256Hex(definition),
      projectId: 7,
      epicId: 8,
      initiatedBy: 'test',
      idempotencyKey: 'test-run',
      inputSchema: 'test.lifecycle-input.v1',
      inputSnapshot: canonicalJson(rootInput),
      inputHash: sha256Hex(rootInput),
      status: frozenInput === null ? 'created' : 'running',
      entryStageId: definition.entryStageId,
      currentStageId: definition.entryStageId,
      currentStageRunId: frozenInput === null ? null : 11,
      terminalStatus: null,
      version: 0,
      leaseFence: 0,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    stage: frozenInput === null ? null : makeStage(definition, frozenInput, process?.id ?? 42),
    process,
    failCalls: 0,
    renewCalls: 0,
    activeRenewCalls: 0,
    executorActive: false,
    released: false,
    processStartCommand: null,
    ensureStageCommand: null,
    completeStageCommand: null,
  };

  const lifecycleRunRepo = {
    start: () => ({ record: state.lifecycle, replayed: state.lifecycle.status !== 'created' }),
    read: () => state.lifecycle,
    readByIdempotencyKey: () => state.lifecycle,
    listStageRuns: () => state.stage === null ? [] : [state.stage],
    readCurrentStageRun: () => state.stage,
    ensureStageRun: (command) => {
      state.ensureStageCommand = command;
      if (state.stage === null) {
        state.stage = makeStage(definition, command.inputPayload, null);
        state.lifecycle.currentStageRunId = state.stage.id;
      }
      return { record: state.stage, replayed: state.stage.processRunId !== null };
    },
    bindProcessRun: (_lifecycleRunId, _stageRunId, processRunId) => {
      state.stage.processRunId = processRunId;
      return state.stage;
    },
    markStageRunning: () => {
      state.stage.status = 'running';
      state.lifecycle.status = 'running';
      return state.stage;
    },
    pauseStage: () => {
      state.stage.status = 'paused';
      state.lifecycle.status = 'paused';
      return state.lifecycle;
    },
    fail: (_lifecycleRunId, _stageRunId, error) => {
      state.failCalls += 1;
      state.lifecycle.status = 'failed';
      state.lifecycle.error = error;
      return state.lifecycle;
    },
    resume: () => state.lifecycle,
    cancel: () => state.lifecycle,
    listRecoverable: () => [],
    completeStage: (command) => {
      state.completeStageCommand = command;
      state.stage.status = 'completed';
      state.stage.processRunId ??= state.process.id;
      state.stage.localOutcome = command.outcome;
      state.stage.mappedOutput = command.mappedOutput;
      state.stage.resultSnapshot = command.resultSnapshot;
      state.lifecycle.status = 'completed';
      state.lifecycle.currentStageId = null;
      state.lifecycle.currentStageRunId = null;
      state.lifecycle.terminalStatus = command.target.status;
      return {
        lifecycleRun: state.lifecycle,
        stageRun: state.stage,
        transition: {
          id: 1,
          lifecycleRunId: 1,
          fromStageRunId: state.stage.id,
          transitionKey: command.transitionKey,
          outcome: command.outcome,
          target: command.target,
          toStageRunId: null,
          handoffSnapshot: command.handoffSnapshot,
          handoffHash: command.handoffHash,
          decisionHash: command.decisionHash,
          createdAt: new Date().toISOString(),
        },
        replayed: false,
      };
    },
    acquireExecutionLease: (_id, owner) => {
      state.lifecycle.status = 'running';
      return { owner, fence: 1 };
    },
    renewExecutionLease: () => {
      state.renewCalls += 1;
      if (state.executorActive) state.activeRenewCalls += 1;
      return renew(state);
    },
    releaseExecutionLease: () => {
      state.released = true;
    },
  };

  const processRunRepo = {
    start: (command) => {
      state.processStartCommand = command;
      if (state.process === null) {
        state.process = {
          ...completedProcess(42),
          status: 'created',
          localOutcome: null,
          authority: null,
        };
      }
      return { record: state.process, replayed: state.process.status !== 'created' };
    },
    read: () => state.process,
  };

  const executor = {
    moduleRef: {
      name: moduleDefinition.identity.name,
      version: moduleDefinition.identity.version,
    },
    kind: 'test',
    execute: async (...args) => {
      state.executorActive = true;
      try {
        return await execute?.(state, ...args);
      } finally {
        state.executorActive = false;
      }
    },
  };
  const moduleRegistry = {
    get: () => moduleDefinition,
    require: () => moduleDefinition,
  };
  const installationRegistry = {
    require: () => ({ definition: moduleDefinition, executor }),
  };

  return {
    state,
    orchestrator: new LifecycleOrchestrator({
      lifecycleRunRepo,
      processRunRepo,
      moduleRegistry,
      installationRegistry,
      leaseDurationMs,
    }),
    command: {
      projectId: 7,
      epicId: 8,
      inputSchema: 'test.lifecycle-input.v1',
      inputPayload: rootInput,
      initiatedBy: 'test',
      idempotencyKey: 'test-run',
    },
  };
}

function makeStage(definition, input, processRunId) {
  const binding = definition.stages[0];
  return {
    id: 11,
    lifecycleRunId: 1,
    ordinal: 1,
    stageId: binding.id,
    attempt: 1,
    moduleRef: binding.moduleRef,
    bindingSnapshot: canonicalJson(binding),
    bindingHash: sha256Hex(binding),
    inputSchema: moduleDefinition.inputContract.id,
    inputSnapshot: canonicalJson(input),
    inputHash: sha256Hex(input),
    status: 'created',
    processRunId,
    localOutcome: null,
    authority: null,
    output: null,
    certificate: null,
    mappedOutput: null,
    resultSnapshot: null,
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('restart uses the frozen StageRun input and preserves processRunId in the handoff frame', async () => {
  const frozenInput = { frozen: 'authoritative' };
  const definition = lifecycleDefinition({ value: '$.missing-if-remapped' });
  const harness = createHarness({
    definition,
    frozenInput,
    process: completedProcess(),
    execute: () => {
      assert.fail('completed ProcessRun must be replayed without executor dispatch');
    },
  });

  const result = await harness.orchestrator.run(definition, harness.command);

  assert.equal(result.status, 'completed');
  assert.deepEqual(harness.state.ensureStageCommand.inputPayload, frozenInput);
  assert.deepEqual(harness.state.processStartCommand.input.payload, frozenInput);
  assert.equal(
    harness.state.completeStageCommand.handoffSnapshot.stages['stage-one'].processRunId,
    42,
  );
});

test('lease watchdog renews while a module executor is still running', async () => {
  const definition = lifecycleDefinition();
  const harness = createHarness({
    definition,
    leaseDurationMs: 30,
    execute: async (state) => {
      await new Promise(resolve => setTimeout(resolve, 75));
      Object.assign(state.process, completedProcess(state.process.id));
      return {
        outcome: 'done',
        output: null,
        certificate: null,
        authority: 'test-policy',
      };
    },
  });

  const result = await harness.orchestrator.run(definition, harness.command);

  assert.equal(result.status, 'completed');
  assert.ok(
    harness.state.activeRenewCalls >= 2,
    `expected watchdog renewals during execute, got ${harness.state.activeRenewCalls}`,
  );
});

test('watchdog lease loss leaves the LifecycleRun recoverable', async () => {
  const definition = lifecycleDefinition();
  const harness = createHarness({
    definition,
    leaseDurationMs: 18,
    renew: state => !state.executorActive,
    execute: async (state) => {
      await new Promise(resolve => setTimeout(resolve, 40));
      Object.assign(state.process, completedProcess(state.process.id));
      return {
        outcome: 'done',
        output: null,
        certificate: null,
        authority: 'test-policy',
      };
    },
  });

  await assert.rejects(
    () => harness.orchestrator.run(definition, harness.command),
    error => error.name === 'LifecycleLeaseLostError',
  );
  assert.ok(harness.state.activeRenewCalls >= 1);
  assert.equal(harness.state.failCalls, 0);
  assert.equal(harness.state.lifecycle.status, 'running');
});

for (const recoverableErrorName of ['ProcessRunBusyError', 'NodeExecutionLeaseLostError']) {
  test(`${recoverableErrorName} leaves the LifecycleRun recoverable`, async () => {
    const definition = lifecycleDefinition();
    const harness = createHarness({
      definition,
      execute: async () => {
        const error = new Error(recoverableErrorName);
        error.name = recoverableErrorName;
        throw error;
      },
    });

    await assert.rejects(
      () => harness.orchestrator.run(definition, harness.command),
      error => error.name === recoverableErrorName,
    );
    assert.equal(harness.state.failCalls, 0);
    assert.equal(harness.state.lifecycle.status, 'running');
    assert.equal(harness.state.released, true);
  });
}
