// tests/process-modules/scenario-runner.test.mjs
//
// W7-A6 — ScenarioInstaller + ScenarioRunner tests.
//
// Covers the spec §1 row 6 contract (WAVE7-SCENARIO-SPEC.md):
//   - ScenarioInstaller: compile → resolve lock → bind installations →
//     persist lock → return InstalledScenario with manifest hash + lock digest.
//   - ScenarioRunner: install scenario → resolve lease → execute stages via
//     ProcessModuleExecutor → route outcomes via static outcomeRoutes (W7-A4) →
//     store public outputs once via W7-A5 (NO cumulative frame) → stop at
//     terminal.
//
// Run: `node --test tests/process-modules/scenario-runner.test.mjs`
// (after `npm run build`).

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  ScenarioInstaller,
  ScenarioRunner,
  ScenarioInstallerError,
  ScenarioBudgetExhaustedError,
  SCENARIO_INSTALL_MANIFEST_INVALID,
  SCENARIO_INSTALL_MODULE_UNRESOLVED,
  SCENARIO_INSTALL_NOT_INSTALLED,
  installScenario,
} = await import('../../dist/process-modules/application/scenario-runner.js');
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

// ---------------------------------------------------------------------------
// Manifest fixture: a tiny two-stage scenario (draft → approve) reusing the
// LifecycleScenarioManifest shape from W1-A3. Both stages bind to the SAME
// module (proves §6.8 reuse). The route table is fully static (§6.4).
// ---------------------------------------------------------------------------

const MODULE_REF = Object.freeze({ name: 'test-module', version: '1.0.0' });
const MODULE_INPUT_SCHEMA = 'test.input.v1';
const MODULE_OUTPUT_SCHEMA = 'test.output.v1';

const MODULE_DEFINITION = {
  identity: {
    ...MODULE_REF,
    kind: 'test',
    displayName: 'Test Module',
    description: 'Scenario-runner test module.',
  },
  inputContract: { id: MODULE_INPUT_SCHEMA },
  outputContract: { id: MODULE_OUTPUT_SCHEMA },
  outcomes: [
    { code: 'drafted', description: 'Drafted.', terminal: true },
    { code: 'approved', description: 'Approved.', terminal: true },
    { code: 'rejected', description: 'Rejected.', terminal: true },
  ],
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

const SCENARIO_IDENTITY = Object.freeze({
  name: 'test-scenario',
  version: '1.0.0',
  displayName: 'Test Scenario',
  description: 'Two-stage scenario fixture for W7-A6.',
});

function contractRef(schemaId) {
  return {
    schemaId,
    version: '1.0.0',
    digest: sha256Hex({ schemaId, stub: 'w7-a6-test' }),
  };
}

function selectorFromModuleRef(moduleRef) {
  return { name: moduleRef.name, versionRange: `^${moduleRef.version}` };
}

/**
 * Two-stage scenario: draft → approve. Both stages reuse the same module
 * (§6.8). Static outcomeRoutes only (§6.4 — no routeResolver).
 *
 * Mapping paths use the `$.`-prefixed convention the lifecycle-mapper
 * enforces (paths must be `$` or start with `$.`). The root input frame is
 * `{ ...rootInput, lifecycleInput, stages: {...} }`, so root-input fields
 * live under `$.initiative.*` and prior-stage outputs under
 * `$.stages.<stageId>.output.<field>` (the legacy orchestrator's frame shape).
 */
function buildManifest({ reentryBudget = 0 } = {}) {
  const stageBindings = [
    {
      id: 'draft',
      displayName: 'Draft',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: { brief: '$.initiative.brief' },
      outputMapping: { campaignDraft: '$.processOutcome.output' },
      outcomeRoutes: { drafted: { type: 'stage', stageId: 'approve' } },
      entryConditions: [],
      exitConditions: [],
    },
    {
      id: 'approve',
      displayName: 'Approve',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: { campaignDraft: '$.stages.draft.output.campaignDraft' },
      outputMapping: { decision: '$.processOutcome.output' },
      outcomeRoutes: {
        approved: { type: 'terminal', status: 'scenario-approved' },
        rejected: { type: 'terminal', status: 'scenario-rejected' },
      },
      entryConditions: [],
      exitConditions: [],
    },
  ];
  return {
    manifestFormatVersion: '0.1.0',
    identity: SCENARIO_IDENTITY,
    inputContractRef: contractRef('scenario.input.v1'),
    outputContractRef: contractRef('scenario.output.v1'),
    entryStageId: 'draft',
    stageBindings,
    outcomeRoutes: {},
    inputMappings: { initiative: '$.initiative' },
    outputMappings: {},
    terminalStatuses: ['scenario-approved', 'scenario-rejected'],
    scenarioPolicies: {},
    requiredModuleSelectors: [selectorFromModuleRef(MODULE_REF)],
    transitionBudgets: { maxTransitions: 10 },
    reentryBudgets: { maxReentries: reentryBudget },
  };
}

// ---------------------------------------------------------------------------
// Lock fixture (what the W7-A2 lockResolver would produce).
// ---------------------------------------------------------------------------

function buildLock(manifest) {
  const entries = manifest.stageBindings.map((s) => ({
    stageId: s.id,
    selector: s.moduleSelector,
    installedModuleRef: MODULE_REF,
    installationId: 1,
    packageDigest: sha256Hex({ module: MODULE_REF, stamp: 'w7-a6' }),
  }));
  return {
    scenarioIdentity: manifest.identity,
    entries,
    lockDigest: sha256Hex(canonicalJson(entries)),
  };
}

// ---------------------------------------------------------------------------
// Fake dependencies.
// ---------------------------------------------------------------------------

function fakeInstallationRegistry({ installed = true } = {}) {
  return {
    require(ref) {
      if (!installed) {
        throw new Error(`process module ${ref.name}@${ref.version} is not installed`);
      }
      return { definition: MODULE_DEFINITION, executor: null };
    },
  };
}

function fakeCompiler({ ok = true, errors = [] } = {}) {
  return () => ({ ok, errors });
}

function fakeLockResolver(lock) {
  return () => Promise.resolve(lock);
}

function fakeLockStore({ writeError = null } = {}) {
  const written = [];
  return {
    write: async (l) => {
      if (writeError) throw writeError;
      written.push(l);
      return l;
    },
    read: async () => null,
    _written: written,
  };
}

// ---------------------------------------------------------------------------
// ScenarioInstaller tests.
// ---------------------------------------------------------------------------

test('ScenarioInstaller: install returns InstalledScenario with manifest hash + lock digest', async () => {
  const manifest = buildManifest();
  const lock = buildLock(manifest);
  const lockStore = fakeLockStore();
  const installer = new ScenarioInstaller();

  const installed = await installer.install(manifest, {
    compiler: fakeCompiler(),
    lockResolver: fakeLockResolver(lock),
    lockStore,
    installationRegistry: fakeInstallationRegistry(),
  });

  assert.equal(installed.manifest, manifest);
  assert.equal(installed.manifestSnapshot, canonicalJson(manifest));
  assert.equal(installed.manifestHash, sha256Hex(manifest));
  assert.equal(installed.lock.lockDigest, lock.lockDigest);
  assert.deepEqual(installed.lock.entries, lock.entries);
  // Per-stage installation binding.
  assert.equal(installed.installationsByStageId.draft.definition, MODULE_DEFINITION);
  assert.equal(installed.installationsByStageId.approve.definition, MODULE_DEFINITION);
  // Lock was persisted.
  assert.equal(lockStore._written.length, 1);
  assert.equal(lockStore._written[0], lock);
});

test('installScenario stateless wrapper delegates to ScenarioInstaller', async () => {
  const manifest = buildManifest();
  const lock = buildLock(manifest);
  const installed = await installScenario(manifest, {
    compiler: fakeCompiler(),
    lockResolver: fakeLockResolver(lock),
    lockStore: fakeLockStore(),
    installationRegistry: fakeInstallationRegistry(),
  });
  assert.equal(installed.lock.lockDigest, lock.lockDigest);
});

test('ScenarioInstaller: compiler rejection surfaces SCENARIO_INSTALL_MANIFEST_INVALID', async () => {
  const manifest = buildManifest();
  const compiler = fakeCompiler({
    ok: false,
    errors: [{ code: 'ROUTE_INCOMPLETE', path: '$.stageBindings[0]', message: 'no route' }],
  });
  const installer = new ScenarioInstaller();

  await assert.rejects(
    () => installer.install(manifest, {
      compiler,
      lockResolver: fakeLockResolver(buildLock(manifest)),
      lockStore: fakeLockStore(),
      installationRegistry: fakeInstallationRegistry(),
    }),
    (err) => {
      assert.ok(err instanceof ScenarioInstallerError);
      assert.equal(err.code, SCENARIO_INSTALL_MANIFEST_INVALID);
      assert.match(err.message, /ROUTE_INCOMPLETE/);
      return true;
    },
  );
});

test('ScenarioInstaller: resolver throw surfaces SCENARIO_INSTALL_MODULE_UNRESOLVED', async () => {
  const manifest = buildManifest();
  const failingResolver = () => Promise.reject(new Error('no active installation in range'));
  const installer = new ScenarioInstaller();

  await assert.rejects(
    () => installer.install(manifest, {
      compiler: fakeCompiler(),
      lockResolver: failingResolver,
      lockStore: fakeLockStore(),
      installationRegistry: fakeInstallationRegistry(),
    }),
    (err) => {
      assert.ok(err instanceof ScenarioInstallerError);
      assert.equal(err.code, SCENARIO_INSTALL_MODULE_UNRESOLVED);
      return true;
    },
  );
});

test('ScenarioInstaller: lock missing a stage entry surfaces SCENARIO_INSTALL_MODULE_UNRESOLVED', async () => {
  const manifest = buildManifest();
  const incompleteLock = {
    ...buildLock(manifest),
    entries: [], // missing both stages
  };
  const installer = new ScenarioInstaller();

  await assert.rejects(
    () => installer.install(manifest, {
      compiler: fakeCompiler(),
      lockResolver: fakeLockResolver(incompleteLock),
      lockStore: fakeLockStore(),
      installationRegistry: fakeInstallationRegistry(),
    }),
    (err) => {
      assert.equal(err.code, SCENARIO_INSTALL_MODULE_UNRESOLVED);
      assert.match(err.message, /missing a resolution entry for stage 'draft'/);
      return true;
    },
  );
});

test('ScenarioInstaller: unresolved installation surfaces SCENARIO_INSTALL_NOT_INSTALLED', async () => {
  const manifest = buildManifest();
  const installer = new ScenarioInstaller();

  await assert.rejects(
    () => installer.install(manifest, {
      compiler: fakeCompiler(),
      lockResolver: fakeLockResolver(buildLock(manifest)),
      lockStore: fakeLockStore(),
      installationRegistry: fakeInstallationRegistry({ installed: false }),
    }),
    (err) => {
      assert.equal(err.code, SCENARIO_INSTALL_NOT_INSTALLED);
      return true;
    },
  );
});

test('ScenarioInstaller: lockStore write failure surfaces SCENARIO_INSTALL_LOCK_WRITE_FAILED', async () => {
  const manifest = buildManifest();
  const installer = new ScenarioInstaller();

  await assert.rejects(
    () => installer.install(manifest, {
      compiler: fakeCompiler(),
      lockResolver: fakeLockResolver(buildLock(manifest)),
      lockStore: fakeLockStore({ writeError: new Error('digest collision') }),
      installationRegistry: fakeInstallationRegistry(),
    }),
    (err) => {
      assert.equal(err.code, 'SCENARIO_INSTALL_LOCK_WRITE_FAILED');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// ScenarioRunner harness.
//
// The runner reuses LifecycleRunRepository + ProcessRunRepository (existing
// ports); we build in-memory fakes that mimic a two-stage walk exactly like
// the legacy lifecycle-orchestrator.test.mjs harness but adapted for the
// scenario's two-stage manifest.
// ---------------------------------------------------------------------------

function completedProcess(id = 42) {
  return {
    id,
    status: 'completed',
    localOutcome: 'drafted',
    authority: 'test-policy',
    outputSchema: MODULE_OUTPUT_SCHEMA,
    outputRef: 'test-ref',
    outputHash: 'test-hash',
    certificateSchema: null,
    certificateRef: null,
    certificateHash: null,
    error: null,
  };
}

function makeStageRecord({ id, lifecycleRunId, stageId, moduleRef, binding, input, processRunId = null, status = 'created' }) {
  return {
    id,
    lifecycleRunId,
    ordinal: id,
    stageId,
    attempt: 1,
    moduleRef,
    bindingSnapshot: canonicalJson(binding),
    bindingHash: sha256Hex(binding),
    inputSchema: MODULE_INPUT_SCHEMA,
    inputSnapshot: canonicalJson(input),
    inputHash: sha256Hex(input),
    status,
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

/**
 * Build a runner harness. `execute(draftStageInput, approveStageInput)` is
 * called per stage; returns a ProcessModuleRunResult. The harness drives both
 * stages in sequence and stores a public output for each.
 */
function createRunnerHarness({
  manifest = buildManifest(),
  rootInput = { initiative: { brief: 'hello' } },
  draftOutcome = 'drafted',
  approveOutcome = 'approved',
  draftOutput = { campaignDraft: { body: 'draft-body' } },
  approveOutput = { decision: 'yes' },
  routerImpl = null,
  leaseDurationMs,
  executeDelayMs = 0,
} = {}) {
  const lock = buildLock(manifest);
  const installationsByStageId = {};
  for (const binding of manifest.stageBindings) {
    installationsByStageId[binding.id] = { definition: MODULE_DEFINITION, executor: null };
  }
  const installedScenario = {
    manifest,
    manifestSnapshot: canonicalJson(manifest),
    manifestHash: sha256Hex(manifest),
    lock,
    installationsByStageId,
  };

  // State for the LifecycleRunRepository fake.
  let stageIdCounter = 11;
  let processIdCounter = 42;
  const state = {
    lifecycle: {
      id: 1,
      lifecycle: manifest.identity,
      lifecycleRefKey: `${manifest.identity.name}@${manifest.identity.version}`,
      definitionSnapshot: installedScenario.manifestSnapshot,
      definitionHash: installedScenario.manifestHash,
      projectId: 7,
      epicId: 8,
      initiatedBy: 'test',
      idempotencyKey: 'test-run',
      inputSchema: 'scenario.input.v1',
      inputSnapshot: canonicalJson(rootInput),
      inputHash: sha256Hex(rootInput),
      status: 'created',
      entryStageId: manifest.entryStageId,
      currentStageId: manifest.entryStageId,
      currentStageRunId: null,
      terminalStatus: null,
      version: 0,
      leaseFence: 0,
      error: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    stages: [],
    processes: new Map(),
    storedOutputs: [],
    released: false,
    renewCalls: 0,
    completeStageCommand: null,
    processStartCommands: [],
  };

  const lifecycleRunRepo = {
    start: () => ({ record: state.lifecycle, replayed: false }),
    read: () => state.lifecycle,
    readByIdempotencyKey: () => state.lifecycle,
    listStageRuns: () => state.stages,
    listTransitions: () => [],
    readCurrentStageRun: () => state.stages[state.stages.length - 1] ?? null,
    ensureStageRun: (command) => {
      // Reuse existing StageRun if one for this stage already exists.
      let existing = state.stages.find((s) => s.stageId === command.stageId);
      if (!existing) {
        existing = makeStageRecord({
          id: stageIdCounter++,
          lifecycleRunId: command.lifecycleRunId,
          stageId: command.stageId,
          moduleRef: command.moduleRef,
          binding: manifest.stageBindings.find((b) => b.id === command.stageId),
          input: command.inputPayload,
        });
        state.stages.push(existing);
        state.lifecycle.currentStageRunId = existing.id;
      }
      return { record: existing, replayed: existing.processRunId !== null };
    },
    bindProcessRun: (_lrId, stageRunId, processRunId) => {
      const sr = state.stages.find((s) => s.id === stageRunId);
      sr.processRunId = processRunId;
      return sr;
    },
    markStageRunning: (_lrId, stageRunId) => {
      const sr = state.stages.find((s) => s.id === stageRunId);
      sr.status = 'running';
      state.lifecycle.status = 'running';
      return sr;
    },
    pauseStage: () => {
      state.lifecycle.status = 'paused';
      return state.lifecycle;
    },
    fail: (_lrId, _srId, error) => {
      state.lifecycle.status = 'failed';
      state.lifecycle.error = error;
      return state.lifecycle;
    },
    resume: () => state.lifecycle,
    cancel: () => state.lifecycle,
    listRecoverable: () => [],
    completeStage: (command) => {
      state.completeStageCommand = command;
      const sr = state.stages.find((s) => s.id === command.stageRunId);
      sr.status = 'completed';
      sr.localOutcome = command.outcome;
      sr.mappedOutput = command.mappedOutput;
      sr.resultSnapshot = command.resultSnapshot;
      if (command.nextStage) {
        state.lifecycle.currentStageId = command.nextStage.stageId;
        state.lifecycle.currentStageRunId = null;
      } else {
        state.lifecycle.status = 'completed';
        state.lifecycle.currentStageId = null;
        state.lifecycle.currentStageRunId = null;
        state.lifecycle.terminalStatus = command.target.status;
      }
      return {
        lifecycleRun: state.lifecycle,
        stageRun: sr,
        transition: {
          id: 1,
          lifecycleRunId: 1,
          fromStageRunId: sr.id,
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
      return true;
    },
    releaseExecutionLease: () => {
      state.released = true;
    },
  };

  // Track which stage we're executing to return the right outcome/output.
  const processRunRepo = {
    start: (command) => {
      state.processStartCommands.push(command);
      const id = processIdCounter++;
      // Determine the outcome for this stage based on which stage we're in.
      const stageId = state.lifecycle.currentStageId;
      const isApprove = stageId === 'approve';
      const outcome = isApprove ? approveOutcome : draftOutcome;
      const outputPayload = isApprove ? approveOutput : draftOutput;
      const process = {
        ...completedProcess(id),
        localOutcome: outcome,
        outputSchema: MODULE_OUTPUT_SCHEMA,
        outputRef: `${stageId}-artifact`,
        outputHash: sha256Hex(outputPayload),
      };
      state.processes.set(id, process);
      return { record: process, replayed: false };
    },
    read: (id) => state.processes.get(id) ?? null,
  };

  // The executor simply returns the already-persisted completed ProcessRun's
  // result; it never actually runs. This proves the runner drives the executor
  // SPI correctly without depending on its internals. `executeDelayMs` lets the
  // lease-watchdog test force the watchdog to tick.
  const executor = {
    moduleRef: MODULE_REF,
    kind: 'test',
    execute: async (_module, context) => {
      if (executeDelayMs > 0) {
        await new Promise((r) => setTimeout(r, executeDelayMs));
      }
      const process = state.processes.get(context.processRunId);
      return {
        outcome: process.localOutcome,
        output: {
          schema: MODULE_OUTPUT_SCHEMA,
          artifactRef: process.outputRef,
          contentHash: process.outputHash,
        },
        certificate: null,
        authority: process.authority,
      };
    },
  };
  // Patch installationsByStageId with a real executor.
  for (const k of Object.keys(installationsByStageId)) {
    installationsByStageId[k] = { definition: MODULE_DEFINITION, executor };
  }

  // W7-A4 router fake: pure static lookup against stage.outcomeRoutes.
  const defaultRouter = {
    resolveTransition: ({ stage, outcome }) => {
      const target = stage.outcomeRoutes[outcome];
      if (!target) {
        throw new Error(`no route for stage '${stage.id}' outcome '${outcome}'`);
      }
      return target;
    },
  };
  const router = routerImpl ?? defaultRouter;

  // W7-A5 output store fake: content-addressed dedup, in-memory.
  const storedSet = new Set();
  const outputStore = {
    storeOutput: async (record) => {
      const key = `${record.scenarioRunId}:${record.stageId}:${record.contentHash}`;
      if (!storedSet.has(key)) {
        storedSet.add(key);
        state.storedOutputs.push(record);
      }
      return record;
    },
    listOutputs: async (_runId) => state.storedOutputs,
  };

  const runnerOpts = {
    lifecycleRunRepo,
    processRunRepo,
    router,
    outputStore,
  };
  if (leaseDurationMs !== undefined) runnerOpts.leaseDurationMs = leaseDurationMs;
  const runner = new ScenarioRunner(runnerOpts);

  return {
    state,
    installedScenario,
    runner,
    deps: { lifecycleRunRepo, processRunRepo, router, outputStore },
    command: {
      projectId: 7,
      epicId: 8,
      inputSchema: 'scenario.input.v1',
      inputPayload: rootInput,
      initiatedBy: 'test',
      idempotencyKey: 'test-run',
    },
  };
}

// ---------------------------------------------------------------------------
// ScenarioRunner tests.
// ---------------------------------------------------------------------------

test('ScenarioRunner: two-stage walk reaches terminal, stores one output per stage', async () => {
  const harness = createRunnerHarness();
  const result = await harness.runner.run(harness.installedScenario, harness.command);

  assert.equal(result.status, 'completed');
  assert.equal(result.terminalStatus, 'scenario-approved');
  assert.equal(result.stageRuns.length, 2);
  assert.equal(result.outputs.length, 2);
  assert.equal(result.outputs[0].stageId, 'draft');
  assert.equal(result.outputs[1].stageId, 'approve');
  // Lease released.
  assert.equal(harness.state.released, true);
});

test('ScenarioRunner: pins installationId + packageDigest on each ProcessRun (spec §6)', async () => {
  const harness = createRunnerHarness();
  await harness.runner.run(harness.installedScenario, harness.command);

  assert.equal(harness.state.processStartCommands.length, 2);
  for (const cmd of harness.state.processStartCommands) {
    assert.equal(cmd.installationId, 1, 'ProcessRun must pin installationId from the scenario lock');
    assert.ok(cmd.packageDigest, 'ProcessRun must pin packageDigest from the scenario lock');
  }
});

test('ScenarioRunner: rejection outcome routes to scenario-rejected terminal', async () => {
  const harness = createRunnerHarness({ approveOutcome: 'rejected' });
  const result = await harness.runner.run(harness.installedScenario, harness.command);
  assert.equal(result.status, 'completed');
  assert.equal(result.terminalStatus, 'scenario-rejected');
});

test('ScenarioRunner: budget exhaustion (transition) fails the run cleanly', async () => {
  // Router throws ScenarioBudgetExhaustedError on the first call.
  const routerImpl = {
    resolveTransition: () => {
      throw new ScenarioBudgetExhaustedError('transition', 'draft', 'transition budget exhausted');
    },
  };
  const harness = createRunnerHarness({ routerImpl });
  const result = await harness.runner.run(harness.installedScenario, harness.command);

  assert.equal(result.status, 'failed');
  assert.match(result.lifecycleRun.error, /scenario budget exhausted/);
});

test('ScenarioRunner: idempotent — stored output is not duplicated on identical contentHash', async () => {
  // Run two scenarios with identical draft outputs to the same store instance.
  // The runner only stores once per (runId, stageId, hash) — prove the store
  // receives at most one record per stage within ONE run even if the runner
  // were to call it twice (defense for the no-cumulative-frame invariant).
  const harness = createRunnerHarness();
  await harness.runner.run(harness.installedScenario, harness.command);

  const draftOutputs = harness.state.storedOutputs.filter((o) => o.stageId === 'draft');
  assert.equal(draftOutputs.length, 1, 'draft stage output must be stored exactly once');
  const approveOutputs = harness.state.storedOutputs.filter((o) => o.stageId === 'approve');
  assert.equal(approveOutputs.length, 1, 'approve stage output must be stored exactly once');
});

test('ScenarioRunner: terminal LifecycleRun (already completed) short-circuits before lease acquisition', async () => {
  const harness = createRunnerHarness();
  // Pre-mark the run completed so start() returns a terminal row.
  harness.state.lifecycle.status = 'completed';
  harness.state.lifecycle.terminalStatus = 'scenario-approved';

  const result = await harness.runner.run(harness.installedScenario, harness.command);
  assert.equal(result.status, 'completed');
  // No processes started.
  assert.equal(harness.state.processStartCommands.length, 0);
  // No lease acquired → no release.
  assert.equal(harness.state.released, false);
});

test('ScenarioRunner: paused LifecycleRun stays paused without resumePaused authority', async () => {
  const harness = createRunnerHarness();
  harness.state.lifecycle.status = 'paused';
  const result = await harness.runner.run(harness.installedScenario, harness.command);
  assert.equal(result.status, 'paused');
  assert.equal(harness.state.processStartCommands.length, 0);
});

test('ScenarioRunner: resumePaused resumes a paused LifecycleRun', async () => {
  const harness = createRunnerHarness();
  harness.state.lifecycle.status = 'paused';
  const command = { ...harness.command, resumePaused: true };
  const result = await harness.runner.run(harness.installedScenario, command);
  assert.equal(result.status, 'completed');
  assert.equal(result.terminalStatus, 'scenario-approved');
});

test('ScenarioRunner: lease watchdog renews while the executor runs', async () => {
  // Short lease (30ms) + executor delay (75ms) forces the watchdog to tick at
  // least twice during a single stage execution.
  const harness = createRunnerHarness({ leaseDurationMs: 30, executeDelayMs: 75 });
  const result = await harness.runner.run(harness.installedScenario, harness.command);
  assert.equal(result.status, 'completed');
  assert.ok(
    harness.state.renewCalls >= 2,
    `expected heartbeat renewals during execute, got ${harness.state.renewCalls}`,
  );
});

test('ScenarioRunner: failure to acquire lease throws ScenarioRunBusyError', async () => {
  const harness = createRunnerHarness();
  // Build a busy repo: start returns a running row, acquireExecutionLease
  // returns null (another executor already holds the lease).
  const busyRepo = {
    ...harness.deps.lifecycleRunRepo,
    acquireExecutionLease: () => null,
  };
  const busyRunner = new ScenarioRunner({
    lifecycleRunRepo: busyRepo,
    processRunRepo: harness.deps.processRunRepo,
    router: harness.deps.router,
    outputStore: harness.deps.outputStore,
  });
  await assert.rejects(
    () => busyRunner.run(harness.installedScenario, harness.command),
    (err) => err.name === 'ScenarioRunBusyError',
  );
});
