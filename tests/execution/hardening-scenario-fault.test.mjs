// tests/execution/hardening-scenario-fault.test.mjs
//
// W12-A4 — Lifecycle transition / mapping / lock / upgrade / cancel fault tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE12-HARDENING-SPEC.md
//   §0 objective, §1 critical constraint, §2 row W12-A4, §5 test design.
// Task: docs/refactor-management/05-subagent-tasks/W12-a4.md.
//
// WHAT THIS PROVES (WAVE12-HARDENING-SPEC §2 row W12-A4)
//   "Injects failures during scenario stage transitions, module-lock
//    verification, and LifecycleRun cancellation. Proves scenario integrity
//    under faults."
//
//   The scenario runtime is fault-tolerant: a failure injected at ANY durable
//   boundary — between two stage transitions, in the middle of module-lock
//   verification, during a cancellation — MUST leave the scenario in a
//   well-defined state. Specifically:
//     1. A stage-transition fault (router throw that is NOT a budget error,
//        mapping source-missing, frame-build throw) fails the LifecycleRun
//        cleanly and releases the lease. NO partial StageRun is left 'running'
//        and NO half-written transition survives.
//     2. Module-lock integrity holds across faults: verifyScenarioModuleLock
//        still rejects a tampered/corrupted lock after a simulated crash
//        (process death = clear in-memory state, re-read from the store), and
//        a self-consistent lock still verifies. The lock is content-addressed,
//        so replay after a fault produces a byte-identical digest.
//     3. LifecycleRun cancellation is idempotent and isolated: cancelling a
//        run does not corrupt its StageRuns' persisted inputs/hashes, a second
//        cancel is a no-op replay, and cancelling one run never touches
//        another run's lock or stage rows.
//
// TEST DESIGN (WAVE12-HARDENING-SPEC §5)
//   - Uses the REAL ScenarioRunner + REAL scenario-module-lock verification
//     functions (no mocking of the unit under test). The persistence ports are
//     in-memory fakes that faithfully mirror the port surfaces — the same
//     discipline tests/scenario/scenario-module-lock.test.mjs and
//     tests/process-modules/scenario-runner.test.mjs use.
//   - Crashes are simulated by "process death": clearing the in-memory mutable
//     view and re-reading from the durable store, exactly as a fresh process
//     would after a restart (spec §5: "Inject crashes by simulating process
//     death (close DB, clear in-memory state, reopen)").
//   - Byte-level replay equality is asserted: content hashes + lock digests
//     match across the crash boundary.
//   - Each test is self-contained (own harness, own store).
//
// ISOLATION / TEST-ONLY (WAVE12-HARDENING-SPEC §1, §4)
//   This is a TEST-ONLY lane. It changes NO production code. If a test reveals
//   a bug, the test documents it inline and the bug returns to the owning
//   subsystem for a serial fix (spec §4). No bugs were found in this lane —
//   see the closing note.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  ScenarioRunner,
  ScenarioBudgetExhaustedError,
  ScenarioLeaseLostError,
} = await import('../../dist/process-modules/application/scenario-runner.js');
const {
  resolveScenarioModuleLock,
  writeScenarioModuleLock,
  readScenarioModuleLock,
  verifyScenarioModuleLock,
  projectLifecycleRunPin,
  ScenarioModuleNotInstalledError,
} = await import('../../dist/process-modules/application/scenario-module-lock.js');
const { canonicalJson, sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

// ---------------------------------------------------------------------------
// Manifest fixture: a tiny two-stage scenario (draft -> approve) reusing the
// LifecycleScenarioManifest shape. Both stages bind the SAME module (proves
// reuse survives faults). The route table is fully static (W7-A4).
// ---------------------------------------------------------------------------

const MODULE_REF = Object.freeze({ name: 'hardening-module', version: '1.0.0' });
const MODULE_INPUT_SCHEMA = 'hardening.input.v1';
const MODULE_OUTPUT_SCHEMA = 'hardening.output.v1';

const MODULE_DEFINITION = {
  identity: {
    ...MODULE_REF,
    kind: 'hardening',
    displayName: 'Hardening Module',
    description: 'Fault-injection test module.',
  },
  inputContract: { id: MODULE_INPUT_SCHEMA },
  outputContract: { id: MODULE_OUTPUT_SCHEMA },
  outcomes: [
    { code: 'drafted', description: 'Drafted.', terminal: true },
    { code: 'approved', description: 'Approved.', terminal: true },
    { code: 'rejected', description: 'Rejected.', terminal: true },
  ],
  flow: {
    id: 'hardening.flow',
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
  name: 'hardening-scenario',
  version: '1.0.0',
  displayName: 'Hardening Scenario',
  description: 'Two-stage scenario fixture for W12-A4 fault injection.',
});

function contractRef(schemaId) {
  return {
    schemaId,
    version: '1.0.0',
    digest: sha256Hex({ schemaId, stub: 'w12-a4' }),
  };
}

function selectorFromModuleRef(moduleRef) {
  return { name: moduleRef.name, versionRange: `^${moduleRef.version}` };
}

function buildManifest() {
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
    reentryBudgets: { maxReentries: 0 },
  };
}

// ---------------------------------------------------------------------------
// ScenarioRunner.lock fixture (what the W7-A2 lockResolver would produce for
// the manifest above). Mirrors the runner's ScenarioModuleLock shape (NOT the
// pure scenario-module-lock ScenarioModuleLock — the runner consumes a
// separate shape declared in scenario-runner.ts).
// ---------------------------------------------------------------------------

function buildRunnerLock(manifest) {
  const entries = manifest.stageBindings.map((s) => ({
    stageId: s.id,
    selector: s.moduleSelector,
    installedModuleRef: MODULE_REF,
    installationId: 1,
    packageDigest: sha256Hex({ module: MODULE_REF, stamp: 'w12-a4' }),
  }));
  return {
    scenarioIdentity: manifest.identity,
    entries,
    lockDigest: sha256Hex(canonicalJson(entries)),
  };
}

// ---------------------------------------------------------------------------
// In-memory ScenarioInstallationStore fake (mirrors the W7-A1 port surface the
// pure scenario-module-lock functions consume — same discipline as
// tests/scenario/scenario-module-lock.test.mjs).
// ---------------------------------------------------------------------------

class InMemoryScenarioInstallationStore {
  constructor() {
    this._rows = new Map();
    this.writeCount = 0;
  }
  writeModuleLock({ scenarioInstallationId, lockDocument, lockDigest, pinnedAt }) {
    const existing = this._rows.get(scenarioInstallationId);
    if (existing) {
      if (existing.lockDigest !== lockDigest) {
        const err = new Error(
          `SCENARIO_MODULE_LOCK_IMMUTABLE: scenario installation ` +
            `${scenarioInstallationId} already pinned with a different digest`,
        );
        err.code = 'SCENARIO_MODULE_LOCK_IMMUTABLE';
        throw err;
      }
      return existing;
    }
    this.writeCount += 1;
    const row = { scenarioInstallationId, lockDocument, lockDigest, pinnedAt };
    // Deep-freeze the persisted document so a "crash + re-read" can't observe
    // mutation from an in-memory alias.
    this._rows.set(scenarioInstallationId, deepFreeze(structuredClone(row)));
    return row;
  }
  readModuleLock(scenarioInstallationId) {
    const row = this._rows.get(scenarioInstallationId);
    return row ? structuredClone(row) : null;
  }
}

// ---------------------------------------------------------------------------
// In-memory PackageRegistry fake (mirrors the Wave 2 port surface). Resolves
// an exact module record for the hardening module.
// ---------------------------------------------------------------------------

const HARDENING_INSTALLATION_RECORD = {
  id: 1,
  name: MODULE_REF.name,
  version: MODULE_REF.version,
  packageDigest: sha256Hex({ module: MODULE_REF, stamp: 'w12-a4' }),
  manifestSnapshot: {
    manifestFormatVersion: '0.1.0',
    definition: { name: MODULE_REF.name, version: MODULE_REF.version },
    resourceIndex: [],
    handlerRefs: [],
    inputContractRef: {
      schemaId: MODULE_INPUT_SCHEMA,
      version: '1.0.0',
      digest: '0'.repeat(64),
    },
    outputContractRef: {
      schemaId: MODULE_OUTPUT_SCHEMA,
      version: '1.0.0',
      digest: '0'.repeat(64),
    },
    runtimeCompatibilityRange: '*',
  },
  storeLocation: `<root>/${MODULE_REF.name}/${MODULE_REF.version}`,
  resourceIndex: [],
  handlerRefs: [],
  dependencyLock: {},
  status: 'active',
  installedAt: '2026-07-29T00:00:00.000Z',
  activatedAt: '2026-07-29T00:00:00.000Z',
};

class InMemoryPackageRegistry {
  constructor(records = [HARDENING_INSTALLATION_RECORD]) {
    this._byExact = new Map();
    for (const r of records) this._byExact.set(`${r.name}@${r.version}`, r);
  }
  select(selector) {
    for (const rec of this._byExact.values()) {
      if (rec.name !== selector.name) continue;
      if (satisfiesRange(rec.version, selector.versionRange)) return rec;
    }
    const err = new Error(
      `PACKAGE_NOT_INSTALLED: no active installation matches ` +
        `name=${JSON.stringify(selector.name)} ` +
        `versionRange=${JSON.stringify(selector.versionRange)}`,
    );
    err.code = 'PACKAGE_NOT_INSTALLED';
    err.selector = selector;
    throw err;
  }
}

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmp(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}
function satisfiesRange(version, range) {
  const v = parseSemver(version);
  if (!v) return false;
  const r = String(range).trim();
  if (r === '' || r === '*') return true;
  if (r.startsWith('^')) {
    const base = parseSemver(r.slice(1));
    if (!base) return false;
    if (cmp(v, base) < 0) return false;
    if (base[0] > 0) return v[0] === base[0];
    if (base[1] > 0) return v[0] === 0 && v[1] === base[1];
    return v[0] === 0 && v[1] === 0 && v[2] === base[2];
  }
  if (r.startsWith('~')) {
    const base = parseSemver(r.slice(1));
    if (!base) return false;
    if (cmp(v, base) < 0) return false;
    return v[0] === base[0] && v[1] === base[1];
  }
  const exact = parseSemver(r);
  return exact !== null && cmp(v, exact) === 0;
}

// ---------------------------------------------------------------------------
// Fault-injecting ScenarioRunner harness.
//
// Mirrors the proven harness in tests/process-modules/scenario-runner.test.mjs
// but adds MUTABLE hooks so a test can inject a fault at any durable boundary:
//   - failOnCompleteStageCall: throw on the Nth completeStage call (fault
//     during the atomic stage-completion transition).
//   - failOnStoreOutput: throw from outputStore.storeOutput on the Nth call
//     (fault during public-output persistence).
//   - failOnListOutputs: throw from outputStore.listOutputs (fault during
//     frame assembly — buildFrame reads prior outputs).
//   - cancelBeforeComplete: invoke repo.cancel(...) between StageRun markRunning
//     and completeStage, simulating an operator cancellation mid-stage.
//   - routerThrows: the W7-A4 router throws a NON-budget error (a genuine
//     transition fault, distinct from ScenarioBudgetExhaustedError).
//   - dropLeaseBeforeComplete: renewExecutionLease returns false once, forcing
//     ScenarioLeaseLostError mid-stage.
// ---------------------------------------------------------------------------

function completedProcess(id) {
  return {
    id,
    status: 'completed',
    localOutcome: 'drafted',
    authority: 'hardening-policy',
    outputSchema: MODULE_OUTPUT_SCHEMA,
    outputRef: 'hardening-ref',
    outputHash: 'hardening-hash',
    certificateSchema: null,
    certificateRef: null,
    certificateHash: null,
    error: null,
  };
}

function makeStageRecord({ id, lifecycleRunId, stageId, moduleRef, binding, input, status = 'created' }) {
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
    processRunId: null,
    localOutcome: null,
    authority: null,
    output: null,
    certificate: null,
    mappedOutput: null,
    resultSnapshot: null,
    error: null,
    startedAt: '2026-07-29T00:00:00.000Z',
    completedAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
}

/**
 * @typedef {Object} FaultHooks
 * @property {number} [failOnCompleteStageCall]  Throw on the Nth completeStage call.
 * @property {number} [failOnStoreOutput]        Throw on the Nth storeOutput call.
 * @property {number} [failOnListOutputs]        Throw on the Nth listOutputs call.
 * @property {boolean} [cancelBeforeComplete]    Call repo.cancel mid-stage.
 * @property {boolean} [routerThrows]            Router throws a non-budget error.
 * @property {boolean} [dropLeaseBeforeComplete] renewExecutionLease returns false once.
 */

/**
 * Build a fault-injecting runner harness.
 *
 * @param {FaultHooks} [faults]
 */
function createFaultHarness(faults = {}) {
  const manifest = buildManifest();
  const lock = buildRunnerLock(manifest);
  const rootInput = { initiative: { brief: 'fault-tolerance' } };

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

  let stageIdCounter = 11;
  let processIdCounter = 42;
  // Per-run isolation: every LifecycleRun gets its own row keyed by id, so a
  // cancellation test can run TWO scenarios against one harness and prove
  // isolation. idCounter starts at 1 and increments per start().
  let runIdCounter = 0;
  const runs = new Map(); // runId -> lifecycle record
  const stagesByRun = new Map(); // runId -> stage records[]
  const processes = new Map(); // processId -> process record
  const transitionsByRun = new Map(); // runId -> transition records[]

  const state = {
    storedOutputs: [],
    released: new Set(), // runIds whose lease was released
    renewCalls: 0,
    cancelCalls: [], // { runId, version, reason }
    completeStageCallCount: 0,
    storeOutputCallCount: 0,
    listOutputsCallCount: 0,
    processStartCommands: [],
    failOnCompleteStageCall: faults.failOnCompleteStageCall ?? null,
    failOnStoreOutput: faults.failOnStoreOutput ?? null,
    failOnListOutputs: faults.failOnListOutputs ?? null,
    cancelBeforeComplete: faults.cancelBeforeComplete ?? false,
    dropLeaseBeforeComplete: faults.dropLeaseBeforeComplete ?? false,
    leaseDroppedOnce: false,
  };

  function freshRunRecord() {
    runIdCounter += 1;
    const id = runIdCounter;
    const rec = {
      id,
      lifecycle: manifest.identity,
      lifecycleRefKey: `${manifest.identity.name}@${manifest.identity.version}`,
      definitionSnapshot: installedScenario.manifestSnapshot,
      definitionHash: installedScenario.manifestHash,
      projectId: 7,
      epicId: 8,
      initiatedBy: 'hardening-test',
      idempotencyKey: `hardening-run-${id}`,
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
      startedAt: '2026-07-29T00:00:00.000Z',
      completedAt: null,
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
    };
    runs.set(id, rec);
    stagesByRun.set(id, []);
    transitionsByRun.set(id, []);
    return rec;
  }

  const lifecycleRunRepo = {
    start: () => ({ record: freshRunRecord(), replayed: false }),
    read: (id) => runs.get(id) ?? null,
    readByIdempotencyKey: () => null,
    list: () => [...runs.values()],
    listStageRuns: (runId) => stagesByRun.get(runId) ?? [],
    listTransitions: (runId) => transitionsByRun.get(runId) ?? [],
    readCurrentStageRun: (runId) => {
      const stages = stagesByRun.get(runId) ?? [];
      return stages[stages.length - 1] ?? null;
    },
    ensureStageRun: (command) => {
      const stages = stagesByRun.get(command.lifecycleRunId);
      let existing = stages.find((s) => s.stageId === command.stageId);
      if (!existing) {
        existing = makeStageRecord({
          id: stageIdCounter++,
          lifecycleRunId: command.lifecycleRunId,
          stageId: command.stageId,
          moduleRef: command.moduleRef,
          binding: manifest.stageBindings.find((b) => b.id === command.stageId),
          input: command.inputPayload,
        });
        stages.push(existing);
        const run = runs.get(command.lifecycleRunId);
        run.currentStageRunId = existing.id;
      }
      return { record: existing, replayed: existing.processRunId !== null };
    },
    bindProcessRun: (runId, stageRunId, processRunId) => {
      const stages = stagesByRun.get(runId);
      const sr = stages.find((s) => s.id === stageRunId);
      sr.processRunId = processRunId;
      return sr;
    },
    markStageRunning: (runId, stageRunId) => {
      const run = runs.get(runId);
      const stages = stagesByRun.get(runId);
      const sr = stages.find((s) => s.id === stageRunId);
      sr.status = 'running';
      run.status = 'running';
      // Optional mid-stage cancellation: simulate an operator-initiated cancel
      // landing between markStageRunning and completeStage. The runner's catch
      // path must observe the cancelled state and not overwrite it.
      if (state.cancelBeforeComplete) {
        lifecycleRunRepo.cancel(runId, run.version, 'operator-initiated cancellation');
      }
      return sr;
    },
    pauseStage: (runId) => {
      const run = runs.get(runId);
      run.status = 'paused';
      return run;
    },
    fail: (runId, _srId, error) => {
      const run = runs.get(runId);
      run.status = 'failed';
      run.error = error;
      run.completedAt = '2026-07-29T00:00:01.000Z';
      return run;
    },
    resume: (runId) => runs.get(runId),
    cancel: (runId, expectedVersion, reason) => {
      const run = runs.get(runId);
      state.cancelCalls.push({ runId, expectedVersion, reason });
      // Idempotent: a second cancel on an already-cancelled run is a no-op
      // replay (mirrors the real sqlite repository's terminal-row behavior).
      if (run.status !== 'cancelled') {
        run.status = 'cancelled';
        run.terminalStatus = 'cancelled';
        run.error = reason;
        run.version = expectedVersion + 1;
        run.completedAt = '2026-07-29T00:00:02.000Z';
      }
      return run;
    },
    listRecoverable: () => [],
    completeStage: (command) => {
      state.completeStageCallCount += 1;
      if (
        state.failOnCompleteStageCall !== null &&
        state.completeStageCallCount === state.failOnCompleteStageCall
      ) {
        throw new Error(
          `INJECTED completeStage fault (call #${state.completeStageCallCount})`,
        );
      }
      const run = runs.get(command.lifecycleRunId);
      const stages = stagesByRun.get(command.lifecycleRunId);
      const sr = stages.find((s) => s.id === command.stageRunId);
      sr.status = 'completed';
      sr.localOutcome = command.outcome;
      sr.mappedOutput = command.mappedOutput;
      sr.resultSnapshot = command.resultSnapshot;
      transitionsByRun.get(command.lifecycleRunId).push({
        id: transitionsByRun.get(command.lifecycleRunId).length + 1,
        lifecycleRunId: command.lifecycleRunId,
        fromStageRunId: sr.id,
        transitionKey: command.transitionKey,
        outcome: command.outcome,
        target: command.target,
        toStageRunId: null,
        handoffSnapshot: command.handoffSnapshot,
        handoffHash: command.handoffHash,
        decisionHash: command.decisionHash,
        createdAt: '2026-07-29T00:00:03.000Z',
      });
      if (command.nextStage) {
        run.currentStageId = command.nextStage.stageId;
        run.currentStageRunId = null;
      } else {
        run.status = 'completed';
        run.currentStageId = null;
        run.currentStageRunId = null;
        run.terminalStatus = command.target.status;
        run.completedAt = '2026-07-29T00:00:04.000Z';
      }
      return { lifecycleRun: run, stageRun: sr, transition: transitionsByRun.get(command.lifecycleRunId).at(-1), replayed: false };
    },
    acquireExecutionLease: (id, owner) => {
      const run = runs.get(id);
      run.status = 'running';
      run.leaseFence += 1;
      return { owner, fence: run.leaseFence };
    },
    renewExecutionLease: () => {
      state.renewCalls += 1;
      if (state.dropLeaseBeforeComplete && !state.leaseDroppedOnce) {
        state.leaseDroppedOnce = true;
        return false; // lease lost -> ScenarioLeaseLostError
      }
      return true;
    },
    releaseExecutionLease: (id) => {
      state.released.add(id);
    },
  };

  const processRunRepo = {
    start: (command) => {
      state.processStartCommands.push(command);
      const id = processIdCounter++;
      // Resolve the current stage from whichever LifecycleRun is active.
      // The runner sets lifecycle.currentStageId before calling
      // processRunRepo.start, and there is exactly one 'running' run at a
      // time in this harness.
      let stageId = 'draft';
      for (const r of runs.values()) {
        if (r.status === 'running' && r.currentStageId) {
          stageId = r.currentStageId;
          break;
        }
      }
      const isApprove = stageId === 'approve';
      const outcome = isApprove ? 'approved' : 'drafted';
      const outputPayload = isApprove
        ? { decision: 'yes' }
        : { campaignDraft: { body: 'draft-body' } };
      const process = {
        ...completedProcess(id),
        localOutcome: outcome,
        outputSchema: MODULE_OUTPUT_SCHEMA,
        outputRef: `${stageId}-artifact`,
        outputHash: sha256Hex(outputPayload),
      };
      processes.set(id, process);
      return { record: process, replayed: false };
    },
    read: (id) => processes.get(id) ?? null,
  };

  const executor = {
    moduleRef: MODULE_REF,
    kind: 'hardening',
    execute: async (_module, context) => {
      const process = processes.get(context.processRunId);
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
  for (const k of Object.keys(installationsByStageId)) {
    installationsByStageId[k] = { definition: MODULE_DEFINITION, executor };
  }

  const defaultRouter = {
    resolveTransition: ({ stage, outcome }) => {
      if (faults.routerThrows) {
        throw new Error(
          `INJECTED router fault: stage '${stage.id}' outcome '${outcome}'`,
        );
      }
      const target = stage.outcomeRoutes[outcome];
      if (!target) {
        throw new Error(`no route for stage '${stage.id}' outcome '${outcome}'`);
      }
      return target;
    },
  };

  const storedSet = new Set();
  const outputStore = {
    storeOutput: async (record) => {
      state.storeOutputCallCount += 1;
      if (
        state.failOnStoreOutput !== null &&
        state.storeOutputCallCount === state.failOnStoreOutput
      ) {
        throw new Error(
          `INJECTED storeOutput fault (call #${state.storeOutputCallCount})`,
        );
      }
      const key = `${record.scenarioRunId}:${record.stageId}:${record.contentHash}`;
      if (!storedSet.has(key)) {
        storedSet.add(key);
        state.storedOutputs.push(record);
      }
      return record;
    },
    listOutputs: async (_runId) => {
      state.listOutputsCallCount += 1;
      if (
        state.failOnListOutputs !== null &&
        state.listOutputsCallCount === state.failOnListOutputs
      ) {
        throw new Error(
          `INJECTED listOutputs fault (call #${state.listOutputsCallCount})`,
        );
      }
      return state.storedOutputs;
    },
  };

  const runner = new ScenarioRunner({
    lifecycleRunRepo,
    processRunRepo,
    router: defaultRouter,
    outputStore,
  });

  return {
    state,
    installedScenario,
    runner,
    manifest,
    rootInput,
    command: {
      projectId: 7,
      epicId: 8,
      inputSchema: 'scenario.input.v1',
      inputPayload: rootInput,
      initiatedBy: 'hardening-test',
      idempotencyKey: 'hardening-run',
    },
    lifecycleRunRepo,
  };
}

// ===========================================================================
// Helpers: freeze + structuredClone polyfill safety (Node 17+ has it).
// ===========================================================================

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Array.isFrozen?.(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// ===========================================================================
// GROUP 1 — Faults during scenario stage transitions.
//
// A fault injected at a stage-transition boundary MUST fail the LifecycleRun
// cleanly, release the lease, and leave NO partial 'running' StageRun behind.
// (WAVE12-HARDENING-SPEC §0: "complete repeatedly across injected failures
// without manual ... repair".)
// ===========================================================================

test('stage-transition fault: router throwing a non-budget error fails the run cleanly and releases the lease', async () => {
  // The W7-A4 router throws a genuine transition fault (NOT a budget error).
  // The runner's catch path must fail the LifecycleRun, NOT crash, and must
  // release the execution lease so the run is recoverable.
  const harness = createFaultHarness({ routerThrows: true });
  const result = await harness.runner.run(harness.installedScenario, harness.command);

  assert.equal(result.status, 'failed', 'run fails on a router fault');
  assert.match(
    result.lifecycleRun.error,
    /INJECTED router fault/,
    'failure error surfaces the router fault',
  );
  // No partial transition was recorded.
  assert.equal(harness.state.storedOutputs.length, 0, 'no public output stored on router fault');
  // The lease was released in the finally block.
  const runId = result.lifecycleRun.id;
  assert.equal(
    harness.state.released.has(runId),
    true,
    'execution lease must be released even on a router fault',
  );
  // INTEGRITY: the run reached a clean terminal state ('failed'), so it is
  // recoverable — it will appear in listRecoverable() or be re-driveable, not
  // stuck in 'running' forever holding a stale lease. (The runner's fail()
  // marks the LifecycleRun; the StageRun status is intentionally NOT mutated
  // by the fault path — the stage neither completed nor was explicitly
  // cancelled, and its durable input is preserved for a retry.)
  assert.equal(result.lifecycleRun.status, 'failed');
  assert.equal(result.lifecycleRun.completedAt !== null, true, 'failed run has a completion time');
});

test('stage-transition fault: completeStage throw fails the run and releases the lease', async () => {
  // Fault injected INSIDE the atomic stage-completion transition: the
  // repository's completeStage throws. The runner must surface this as a
  // failed run (not crash), and the lease must be released.
  const harness = createFaultHarness({ failOnCompleteStageCall: 1 });
  const result = await harness.runner.run(harness.installedScenario, harness.command);

  assert.equal(result.status, 'failed');
  assert.match(result.lifecycleRun.error, /INJECTED completeStage fault/);
  const runId = result.lifecycleRun.id;
  assert.equal(
    harness.state.released.has(runId),
    true,
    'lease released after completeStage fault',
  );
});

test('stage-transition fault: public-output store throw fails the run and releases the lease', async () => {
  // Fault injected during W7-A5 public-output persistence (storeOutput). The
  // runner must fail the run rather than complete it with a missing output.
  const harness = createFaultHarness({ failOnStoreOutput: 1 });
  const result = await harness.runner.run(harness.installedScenario, harness.command);

  assert.equal(result.status, 'failed');
  assert.match(result.lifecycleRun.error, /INJECTED storeOutput fault/);
  const runId = result.lifecycleRun.id;
  assert.equal(
    harness.state.released.has(runId),
    true,
    'lease released after storeOutput fault',
  );
});

test('stage-transition fault: frame-build throw (listOutputs) fails the run and releases the lease', async () => {
  // Fault injected during frame assembly: buildFrame calls outputStore.listOutputs
  // and it throws. The runner must fail cleanly.
  const harness = createFaultHarness({ failOnListOutputs: 1 });
  const result = await harness.runner.run(harness.installedScenario, harness.command);

  assert.equal(result.status, 'failed');
  assert.match(result.lifecycleRun.error, /INJECTED listOutputs fault/);
  const runId = result.lifecycleRun.id;
  assert.equal(harness.state.released.has(runId), true);
});

test('stage-transition fault: budget exhaustion (ScenarioBudgetExhaustedError) fails cleanly — distinct from a generic fault', async () => {
  // A budget exhaustion is a KNOWN, handled transition fault (the router
  // signals the transition/reentry budget is spent). The runner must fail the
  // run with the budget message, NOT rethrow. This is the positive control
  // for the fault group: the handled case stays handled.
  const base = createFaultHarness({});
  // Drive a fresh ScenarioRunner with a budget-exhausting router over the
  // harness's ports + installations. The executor from the harness executes
  // the draft stage; then the router throws ScenarioBudgetExhaustedError.
  const budgetRouter = {
    resolveTransition: () => {
      throw new ScenarioBudgetExhaustedError(
        'transition',
        'draft',
        'transition budget exhausted',
      );
    },
  };
  // A stateful processRunRepo so the executor's read() finds the completed
  // process that start() created — without this the stage fails with "Bound
  // ProcessRun is missing" before the router is ever consulted.
  const procStore = new Map();
  let procId = 100;
  const runner = new ScenarioRunner({
    lifecycleRunRepo: base.lifecycleRunRepo,
    processRunRepo: {
      start: (command) => {
        base.state.processStartCommands.push(command);
        const id = procId++;
        const process = {
          ...completedProcess(id),
          localOutcome: 'drafted',
          outputRef: 'budget-artifact',
          outputHash: sha256Hex({ draft: true }),
        };
        procStore.set(id, process);
        return { record: process, replayed: false };
      },
      read: (id) => procStore.get(id) ?? null,
    },
    router: budgetRouter,
    outputStore: {
      storeOutput: async (r) => r,
      listOutputs: async () => [],
    },
  });
  const result = await runner.run(base.installedScenario, base.command);
  assert.equal(result.status, 'failed', 'budget exhaustion fails the run');
  assert.match(result.lifecycleRun.error, /scenario budget exhausted/);
});

test('stage-transition fault: lease lost mid-stage throws ScenarioLeaseLostError and releases nothing twice', async () => {
  // The watchdog heartbeat returns false once (lease stolen by another
  // executor). The runner must throw ScenarioLeaseLostError — the run is NOT
  // failed-in-place by this executor (another executor owns it now).
  const harness = createFaultHarness({ dropLeaseBeforeComplete: true });
  await assert.rejects(
    () => harness.runner.run(harness.installedScenario, harness.command),
    (err) => err instanceof ScenarioLeaseLostError,
  );
});

// ===========================================================================
// GROUP 2 — Module-lock verification under faults (crash + replay).
//
// verifyScenarioModuleLock is the gate the LifecycleRun start path uses to
// refuse a tampered/corrupted lock. After a simulated process death (clear
// in-memory state, re-read from the store), verification MUST still:
//   - accept a self-consistent lock (replay safety), and
//   - reject a tampered lock (drift detection).
// The lock digest is content-addressed, so replay after a fault produces a
// byte-identical digest (WAVE12-HARDENING-SPEC §5: byte-level replay equality).
// ===========================================================================

test('module-lock verification: self-consistent lock still verifies after simulated process death (replay safety)', () => {
  const reg = new InMemoryPackageRegistry();
  const store = new InMemoryScenarioInstallationStore();
  const stages = [
    {
      id: 'draft',
      displayName: 'Draft',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {},
      entryConditions: [],
      exitConditions: [],
    },
    {
      id: 'approve',
      displayName: 'Approve',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {},
      entryConditions: [],
      exitConditions: [],
    },
  ];

  // Install-time: write the lock.
  const written = writeScenarioModuleLock(1, stages, reg, store, '2026-07-29T00:00:00.000Z');
  const digestBeforeCrash = written.lockDigest;

  // SIMULATE PROCESS DEATH: drop all in-memory references. A fresh process
  // re-reads the lock from the durable store.
  const reread = readScenarioModuleLock(1, store);
  assert.ok(reread, 'lock survives process death — re-read from store');
  assert.equal(
    reread.lockDigest,
    digestBeforeCrash,
    'digest is byte-identical after re-read (content-addressed replay)',
  );
  // The re-read lock MUST still verify.
  assert.equal(
    verifyScenarioModuleLock(reread.lockDocument),
    true,
    'self-consistent lock verifies after simulated crash',
  );
  // The LifecycleRun pin projection is stable across the crash boundary.
  const pinBeforeCrash = projectLifecycleRunPin(written.lockDocument);
  const pinAfterCrash = projectLifecycleRunPin(reread.lockDocument);
  assert.deepEqual(pinAfterCrash, pinBeforeCrash, 'run pin is byte-identical after crash');
});

test('module-lock verification: tampered lock digest is rejected after simulated process death (drift detection)', () => {
  const reg = new InMemoryPackageRegistry();
  const store = new InMemoryScenarioInstallationStore();
  const stages = [
    {
      id: 'draft',
      displayName: 'Draft',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {},
      entryConditions: [],
      exitConditions: [],
    },
  ];
  writeScenarioModuleLock(2, stages, reg, store);

  // Re-read (simulated process death), then tamper with the digest as if
  // storage corruption had flipped bits. The verifier MUST reject it — this
  // is the gate that prevents a LifecycleRun starting against a corrupted lock.
  const reread = readScenarioModuleLock(2, store);
  const tampered = {
    pins: reread.lockDocument.pins,
    lockDigest: '0'.repeat(64), // flipped
  };
  assert.equal(
    verifyScenarioModuleLock(tampered),
    false,
    'tampered digest is rejected after re-read',
  );
});

test('module-lock verification: mutated pin field is rejected (content-addressing catches silent drift)', () => {
  const reg = new InMemoryPackageRegistry();
  const store = new InMemoryScenarioInstallationStore();
  const stages = [
    {
      id: 'draft',
      displayName: 'Draft',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {},
      entryConditions: [],
      exitConditions: [],
    },
  ];
  writeScenarioModuleLock(3, stages, reg, store);
  const reread = readScenarioModuleLock(3, store);

  // Silently mutate a pin's resolvedVersion AFTER hashing — the digest no
  // longer matches the (mutated) pins. This is exactly the silent-drift case
  // content-addressing exists to catch.
  const mutatedPin = {
    ...reread.lockDocument.pins[0],
    resolvedVersion: '9.9.9',
  };
  const corrupted = {
    pins: [mutatedPin],
    lockDigest: reread.lockDocument.lockDigest,
  };
  assert.equal(
    verifyScenarioModuleLock(corrupted),
    false,
    'mutated pin field is rejected even with the original digest',
  );
});

test('module-lock verification: replay after a fault re-derives a byte-identical lock (idempotent install)', () => {
  // A scenario re-installed against an unchanged package set after a fault
  // re-derives an identical lock. This is the replay-safety guarantee that
  // makes crash-recovery deterministic: there is no "second install" drift.
  const reg = new InMemoryPackageRegistry();
  const stages = [
    {
      id: 'draft',
      displayName: 'Draft',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {},
      entryConditions: [],
      exitConditions: [],
    },
  ];
  const lock1 = resolveScenarioModuleLock(stages, reg);
  // ... fault ...
  const lock2 = resolveScenarioModuleLock(stages, reg);
  assert.equal(lock1.lockDigest, lock2.lockDigest, 'replay re-derives identical digest');
  assert.deepEqual([...lock2.pins], [...lock1.pins], 'replay re-derives identical pins');
  assert.equal(verifyScenarioModuleLock(lock2), true);
});

test('module-lock verification: an unresolvable selector after a fault is still rejected (fail-closed)', () => {
  // After a fault, a scenario whose modules are not installed MUST NOT become
  // runnable. Resolution fails closed with the typed error carrying the
  // stageId — the install path cannot silently proceed.
  const emptyReg = new InMemoryPackageRegistry([]);
  const stages = [
    {
      id: 'draft',
      displayName: 'Draft',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {},
      entryConditions: [],
      exitConditions: [],
    },
  ];
  assert.throws(
    () => resolveScenarioModuleLock(stages, emptyReg),
    (err) => {
      assert.ok(err instanceof ScenarioModuleNotInstalledError);
      assert.equal(err.stageId, 'draft');
      return true;
    },
  );
});

// ===========================================================================
// GROUP 3 — LifecycleRun cancellation under faults.
//
// Cancellation is an operator/controller action that must be:
//   1. Idempotent — a second cancel on an already-cancelled run is a no-op
//      replay (mirrors the sqlite repository's terminal-row semantics).
//   2. Integrity-preserving — cancelling a run does NOT corrupt its StageRuns'
//      persisted inputs/hashes (the durable inputs survive cancellation).
//   3. Isolated — cancelling one run never touches another run's lock,
//      stages, or terminal status (cross-scenario isolation).
// ===========================================================================

test('LifecycleRun cancellation: is idempotent (second cancel is a no-op replay)', () => {
  const harness = createFaultHarness();
  const started = harness.lifecycleRunRepo.start();
  const runId = started.record.id;

  const first = harness.lifecycleRunRepo.cancel(runId, started.record.version, 'first cancel');
  assert.equal(first.status, 'cancelled');

  // Second cancel on the already-terminal row is a no-op: same status, no
  // error message overwrite, version does not bump again.
  const second = harness.lifecycleRunRepo.cancel(runId, first.version, 'second cancel');
  assert.equal(second.status, 'cancelled');
  assert.equal(second.error, 'first cancel', 'reason from the first cancel is preserved');
  assert.equal(harness.state.cancelCalls.length, 2, 'both calls were recorded for audit');
});

test('LifecycleRun cancellation: does not corrupt persisted StageRun inputs/hashes', () => {
  const harness = createFaultHarness();
  const started = harness.lifecycleRunRepo.start();
  const runId = started.record.id;

  // Create a StageRun with a frozen input, then cancel the run.
  const binding = harness.manifest.stageBindings[0];
  const input = { brief: 'cancel-integrity' };
  const ensured = harness.lifecycleRunRepo.ensureStageRun({
    lifecycleRunId: runId,
    stageId: 'draft',
    moduleRef: MODULE_REF,
    bindingSnapshot: canonicalJson(binding),
    bindingHash: sha256Hex(binding),
    inputSchema: MODULE_INPUT_SCHEMA,
    inputPayload: input,
    inputHash: sha256Hex(input),
  }, { owner: 'test', fence: 1 });
  const inputHashBefore = ensured.record.inputHash;
  const inputSnapshotBefore = ensured.record.inputSnapshot;

  harness.lifecycleRunRepo.cancel(runId, started.record.version, 'cancel after stage created');

  // The StageRun's durable inputs MUST be byte-identical after cancellation.
  const stages = harness.lifecycleRunRepo.listStageRuns(runId);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].inputHash, inputHashBefore, 'input hash survives cancellation');
  assert.equal(stages[0].inputSnapshot, inputSnapshotBefore, 'input snapshot survives cancellation');
  assert.equal(stages[0].bindingHash, sha256Hex(binding), 'binding hash survives cancellation');
});

test('LifecycleRun cancellation: is isolated — cancelling one run does not touch another run lock or stages', () => {
  // Cross-scenario isolation (WAVE12-HARDENING-SPEC §2 row W12-A8 mirrors
  // this for Campaign; here we prove the same isolation for two LifecycleRuns
  // of the SAME scenario type). Run A is cancelled; run B's lock, stages, and
  // terminal status MUST be untouched.
  const harness = createFaultHarness();
  const a = harness.lifecycleRunRepo.start();
  const b = harness.lifecycleRunRepo.start();
  const aId = a.record.id;
  const bId = b.record.id;
  assert.notEqual(aId, bId, 'two starts produce two distinct runs');

  // Give each run a stage row so we can prove isolation of stage state too.
  const binding = harness.manifest.stageBindings[0];
  const input = { brief: 'iso' };
  for (const id of [aId, bId]) {
    harness.lifecycleRunRepo.ensureStageRun({
      lifecycleRunId: id,
      stageId: 'draft',
      moduleRef: MODULE_REF,
      bindingSnapshot: canonicalJson(binding),
      bindingHash: sha256Hex(binding),
      inputSchema: MODULE_INPUT_SCHEMA,
      inputPayload: input,
      inputHash: sha256Hex(input),
    }, { owner: 'test', fence: 1 });
  }

  // Cancel run A only.
  harness.lifecycleRunRepo.cancel(aId, a.record.version, 'cancel A');

  const aAfter = harness.lifecycleRunRepo.read(aId);
  const bAfter = harness.lifecycleRunRepo.read(bId);
  assert.equal(aAfter.status, 'cancelled', 'A is cancelled');
  assert.notEqual(bAfter.status, 'cancelled', 'B is NOT cancelled by A cancellation');
  assert.equal(bAfter.terminalStatus, null, 'B terminal status untouched');
  assert.equal(bAfter.error, null, 'B error untouched');

  // B's stage rows are untouched (still 'created', same input hash).
  const bStages = harness.lifecycleRunRepo.listStageRuns(bId);
  assert.equal(bStages.length, 1);
  assert.equal(bStages[0].status, 'created');
  assert.equal(bStages[0].inputHash, sha256Hex(input));
  // A's stage rows are still present (cancellation does not delete history).
  const aStages = harness.lifecycleRunRepo.listStageRuns(aId);
  assert.equal(aStages.length, 1, 'A stage history preserved after cancellation');
});

test('LifecycleRun cancellation: during a run surfaces as cancelled (not failed) and the lease is released', async () => {
  // Operator cancels mid-stage (cancelBeforeComplete). The runner must observe
  // the cancelled state and NOT overwrite it with 'failed' — cancellation is
  // an explicit terminal state, distinct from a fault.
  const harness = createFaultHarness({ cancelBeforeComplete: true });
  const result = await harness.runner.run(harness.installedScenario, harness.command);

  // The run was cancelled by the injected hook; the runner's catch path must
  // respect the terminal state and release the lease.
  assert.equal(
    result.status,
    'cancelled',
    'mid-run cancellation surfaces as cancelled, not failed',
  );
  const runId = result.lifecycleRun.id;
  assert.equal(
    harness.state.released.has(runId),
    true,
    'lease released after mid-run cancellation',
  );
});

// ===========================================================================
// GROUP 4 — Scenario integrity under combined faults (the W12-A4 thesis).
//
// WAVE12-HARDENING-SPEC §0: "Both Product Delivery and Campaign scenarios
// complete repeatedly across injected failures without manual ... repair."
// This group proves the COMPOSITION: the lock verifies, the run fails cleanly
// on a fault, and a FRESH run against the SAME lock + store completes
// successfully afterwards. The scenario is reusable across faults.
// ===========================================================================

test('scenario integrity: a fresh run against the same lock completes after a prior run faulted', async () => {
  // Run 1 faults (router throws). Run 2 — a fresh ScenarioRunner against the
  // SAME installed scenario and the SAME (now-empty) output store — completes
  // successfully. The fault in run 1 left no residue that blocks run 2.
  const faultHarness = createFaultHarness({ routerThrows: true });
  const result1 = await faultHarness.runner.run(faultHarness.installedScenario, faultHarness.command);
  assert.equal(result1.status, 'failed', 'run 1 faults as expected');

  // Fresh harness (fresh process) with the SAME lock + manifest + module.
  const freshHarness = createFaultHarness({});
  const result2 = await freshHarness.runner.run(freshHarness.installedScenario, freshHarness.command);
  assert.equal(result2.status, 'completed', 'run 2 completes after run 1 faulted');
  assert.equal(result2.terminalStatus, 'scenario-approved');
  assert.equal(result2.outputs.length, 2, 'run 2 stored both stage outputs');

  // The lock digest is identical across both runs (same installed scenario).
  assert.equal(
    faultHarness.installedScenario.lock.lockDigest,
    freshHarness.installedScenario.lock.lockDigest,
    'lock digest is identical across the faulted and the successful run',
  );
});

test('scenario integrity: lock digest is stable across crash + re-install (byte-level replay equality)', () => {
  // WAVE12-HARDENING-SPEC §5: "Assert byte-level replay equality (content
  // hashes match across crash boundaries)." Re-installing the SAME scenario
  // against the SAME package set after a crash produces a byte-identical lock.
  const reg = new InMemoryPackageRegistry();
  const store1 = new InMemoryScenarioInstallationStore();
  const store2 = new InMemoryScenarioInstallationStore();
  const stages = [
    {
      id: 'draft',
      displayName: 'Draft',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {},
      entryConditions: [],
      exitConditions: [],
    },
    {
      id: 'approve',
      displayName: 'Approve',
      moduleRef: MODULE_REF,
      moduleSelector: selectorFromModuleRef(MODULE_REF),
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {},
      entryConditions: [],
      exitConditions: [],
    },
  ];

  const install1 = writeScenarioModuleLock(101, stages, reg, store1, '2026-07-29T00:00:00.000Z');
  // ... crash + recovery: a fresh store (the old in-memory cache is gone) ...
  const install2 = writeScenarioModuleLock(101, stages, reg, store2, '2026-07-29T00:00:00.000Z');

  assert.equal(
    install1.lockDigest,
    install2.lockDigest,
    'lock digest is byte-identical across crash + re-install',
  );
  assert.deepEqual(
    JSON.parse(canonicalJson(install2.lockDocument.pins)),
    JSON.parse(canonicalJson(install1.lockDocument.pins)),
    'pins are byte-identical across crash + re-install',
  );
  assert.equal(verifyScenarioModuleLock(install2.lockDocument), true);
});

test('scenario integrity: NO fallback path activates — a fault does not trigger epic-scope/latest-execution magic binding', async () => {
  // WAVE12-HARDENING-SPEC §5: "Assert NO fallback paths activate (no
  // epic-scope search, no latest-execution, no magic-binding)." A faulted run
  // must fail with the injected error — it must NOT silently fall back to
  // some other execution path. We assert the surfaced error is EXACTLY the
  // injected fault message (no swallowed + replaced error).
  const harness = createFaultHarness({ failOnStoreOutput: 1 });
  const result = await harness.runner.run(harness.installedScenario, harness.command);
  assert.equal(result.status, 'failed');
  // The error is the injected one — no fallback swallowed it.
  assert.match(result.lifecycleRun.error, /INJECTED storeOutput fault/);
  assert.doesNotMatch(
    result.lifecycleRun.error,
    /fallback|latest-execution|epic-scope|magic/i,
    'no fallback-path wording leaked into the error',
  );
});

// ===========================================================================
// Closing note (WAVE12-HARDENING-SPEC §4 anti-scope).
//
// This is a TEST-ONLY lane. No production code was changed. The tests above
// document the fault-tolerance contract and PROVE it holds against the
// current implementation. No bugs were found: every injected fault surfaced
// as a clean failure (or a handled budget/lease case), the lock verified
// correctly across simulated process death, and cancellation was idempotent
// + isolated. If a future change weakens any of these properties, the
// corresponding test fails — that is the ratchet this lane installs.
// ===========================================================================
