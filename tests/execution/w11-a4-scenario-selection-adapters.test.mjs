// tests/execution/w11-a4-scenario-selection-adapters.test.mjs
//
// W11-A4 — CLI + MCP-tool scenario selection adapter tests.
// Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md lane A4.
// Task: docs/refactor-management/05-subagent-tasks/W11-a4.md
//
// WHAT THIS PROVES
//   Wave 11's cutover preparation is sound: NEW runs select the installed
//   scenario when one is resolvable, OLD runs keep working through the
//   legacy path, and every legacy-path use is recordable. Seven properties
//   map to the spec §4 exit gate (1, 2, 4) and the §1 feature-detection
//   constraint:
//
//     1. SELECTION/feature-detect — with no wiring, every run resolves to
//        the legacy path (NO_INSTALLED_SCENARIO). With a provider that
//        resolves a scenario AND a runner, it resolves to the scenario
//        path (INSTALLED_SCENARIO).
//     2. PARTIAL-WIRING — a scenario provider without a runner falls back
//        to legacy (SCENARIO_RUNNER_NOT_WIRED), so a half-wired cutover
//        never blocks a run.
//     3. FORCE-LEGACY — the operator override short-circuits to legacy
//        even when a scenario is installed (LEGACY_FORCED).
//     4. COMMAND-TRANSLATION — the legacy RunEpisodeCommand maps to the
//        scenario RunScenarioCommand (input schema, idempotency, scope).
//     5. RESULT-PROJECTION — a ScenarioExecutionResult projects back into
//        the uniform OrchestrationRunResult (reason/terminal/finalStage).
//     6. EXECUTION-ROUTING — runEpisodeViaScenarioAdapter dispatches to
//        the scenario runner for the new path and to application.runEpisode
//        for the legacy path, returning the uniform result type both ways.
//     7. COMPATIBILITY-RECORD — every legacy-path execution pulses the
//        recorder once with the right shape; scenario-path execution does
//        NOT pulse it; a faulty recorder never breaks the run.
//     8. TOOL-STATUS/WIRING — the MCP tool reports the cutover phase
//        (not-started/partial/ready) from the wiring slots.
//
// These tests are SELF-CONTAINED: they import only the A4 adapter modules
// and the legacy-scenario-adapter (present since Wave 7) for the manifest
// identity assertions. They do NOT import the parallel W11-A1/A2/A3/A5
// lanes — those are absent in an isolated A4 worktree. The fake
// InstalledScenario / SagaApplication / ScenarioRunner are built inline.
//
// The skip-on-absent-sibling discipline is NOT needed here because A4's
// production imports are all present in the A4 worktree (the adapter
// accepts sibling-produced collaborators as injected ports, not imports).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveCliScenarioSelection,
  runEpisodeViaScenarioAdapter,
  resolveAndRunEpisode,
  buildScenarioCommand,
  defaultIdempotencyKey,
  projectScenarioResultToRunResult,
  SCENARIO_INPUT_SCHEMA_DEFAULT,
  SELECTION_REASON,
} from '../../dist/orchestrate-cli-scenario-adapter.js';
import {
  setInstalledScenarioProvider,
  setScenarioRunnerProvider,
  _resetScenarioSelectionWiringForTests,
  readScenarioSelectionWiringStatus,
  projectSelectionForTool,
} from '../../dist/tools/process-modules-scenario-adapter.js';
import {
  LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT,
} from '../../dist/process-modules/application/legacy-scenario-adapter.js';

// ===========================================================================
// Fixtures — minimal fakes that satisfy the adapter's ports.
// ===========================================================================

/**
 * Build a minimal InstalledScenario-shaped value. The adapter only reads
 * `manifest.identity` from it (for projection + the selection record), so a
 * deep fixture is unnecessary. We carry the legacy permissive manifest as
 * the manifest so the identity is a real, validated value.
 */
function fakeInstalledScenario(manifest) {
  return {
    manifest: manifest ?? LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
    manifestSnapshot: '{}',
    manifestHash: 'fake-hash',
    lock: { entries: [], scenarioIdentity: { name: 'x', version: '1' } },
    installationsByStageId: {},
  };
}

/**
 * A recording SagaApplication fake. Only `runEpisode` is exercised by the
 * adapter; the rest are stubs so the type is satisfied.
 */
function fakeApplication(runEpisodeImpl) {
  return {
    runEpisode: runEpisodeImpl ?? (async () => ({
      projectId: 1,
      epicId: 2,
      finalStage: 'delivery',
      endedAt: '2026-07-29T00:00:00.000Z',
      reason: 'completed',
      cycles: 4,
      lastError: null,
    })),
    listProjects: () => [],
    loadProjectBoard: () => ({ tasks: [] }),
    startEngine: () => ({}),
    stopEngine: () => ({}),
    restartEngine: () => ({}),
    setEngineConcurrency: () => ({}),
    getEngineStatus: () => ({}),
    close: () => {},
  };
}

/** A ScenarioRunner fake that records the command it received. */
function fakeScenarioRunner(resultOverrides = {}) {
  const calls = [];
  const runner = {
    run: async (scenario, command) => {
      calls.push({ scenario, command });
      return {
        lifecycleRun: {
          id: 9001,
          lifecycle: scenario.manifest.identity,
          lifecycleRefKey: `${scenario.manifest.identity.name}@${scenario.manifest.identity.version}`,
          definitionSnapshot: '{}',
          definitionHash: scenario.manifestHash,
          projectId: command.projectId,
          epicId: command.epicId,
          initiatedBy: command.initiatedBy,
          idempotencyKey: command.idempotencyKey,
          inputSchema: command.inputSchema,
          inputSnapshot: '{}',
          inputHash: 'fake',
          status: 'completed',
          entryStageId: scenario.manifest.entryStageId,
          currentStageId: null,
          currentStageRunId: null,
          terminalStatus: 'delivered',
          version: 1,
          leaseFence: 0,
          error: null,
          startedAt: '2026-07-29T00:00:00.000Z',
          completedAt: '2026-07-29T00:00:01.000Z',
          createdAt: '2026-07-29T00:00:00.000Z',
          updatedAt: '2026-07-29T00:00:01.000Z',
          ...resultOverrides.lifecycleRun,
        },
        stageRuns: [{ id: 1 }, { id: 2 }, { id: 3 }],
        status: 'completed',
        terminalStatus: 'delivered',
        pausedAtStageId: null,
        outputs: [],
        ...resultOverrides,
      };
    },
  };
  runner.calls = calls;
  return runner;
}

const baseCommand = {
  projectId: 1,
  epicId: 2,
};

// ===========================================================================
// §1 SELECTION — feature detection.
// ===========================================================================

test('selection: no wiring → legacy path, NO_INSTALLED_SCENARIO', async () => {
  const sel = await resolveCliScenarioSelection({
    projectId: 1, epicId: 2,
  });
  assert.equal(sel.path, 'legacy');
  assert.equal(sel.reason, SELECTION_REASON.NO_INSTALLED_SCENARIO);
  assert.equal(sel.installedScenario, null);
  // Legacy selection always carries the equivalent manifest for the record.
  assert.equal(
    sel.equivalentLegacyManifest.identity.name,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.identity.name,
  );
});

test('selection: provider returns null → legacy, NO_INSTALLED_SCENARIO', async () => {
  const provider = { resolveInstalledScenario: async () => null };
  const sel = await resolveCliScenarioSelection({
    projectId: 1, epicId: 2,
    installedScenarioProvider: provider,
    scenarioRunnerProvider: () => fakeScenarioRunner(),
  });
  assert.equal(sel.path, 'legacy');
  assert.equal(sel.reason, SELECTION_REASON.NO_INSTALLED_SCENARIO);
});

test('selection: provider + runner wired → scenario path, INSTALLED_SCENARIO', async () => {
  const scenario = fakeInstalledScenario();
  const provider = { resolveInstalledScenario: async () => scenario };
  const sel = await resolveCliScenarioSelection({
    projectId: 1, epicId: 2,
    installedScenarioProvider: provider,
    scenarioRunnerProvider: () => fakeScenarioRunner(),
  });
  assert.equal(sel.path, 'scenario');
  assert.equal(sel.reason, SELECTION_REASON.INSTALLED_SCENARIO);
  assert.equal(sel.installedScenario, scenario);
  // Scenario selection has NO legacy equivalent (the scenario IS the record).
  assert.equal(sel.equivalentLegacyManifest, null);
});

test('selection: strict discoveryGate labels the legacy equivalent as strict', async () => {
  const sel = await resolveCliScenarioSelection({
    projectId: 1, epicId: 2,
    discoveryGate: 'strict',
  });
  assert.equal(sel.path, 'legacy');
  assert.equal(
    sel.equivalentLegacyManifest.identity.version,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_STRICT.identity.version,
  );
});

// ===========================================================================
// §2 PARTIAL-WIRING — scenario installed but no runner.
// ===========================================================================

test('selection: scenario installed but no runner provider → legacy, SCENARIO_RUNNER_NOT_WIRED', async () => {
  const provider = { resolveInstalledScenario: async () => fakeInstalledScenario() };
  const sel = await resolveCliScenarioSelection({
    projectId: 1, epicId: 2,
    installedScenarioProvider: provider,
    // scenarioRunnerProvider omitted
  });
  assert.equal(sel.path, 'legacy');
  assert.equal(sel.reason, SELECTION_REASON.SCENARIO_RUNNER_NOT_WIRED);
});

test('selection: runner provider returns null → legacy, SCENARIO_RUNNER_NOT_WIRED', async () => {
  const provider = { resolveInstalledScenario: async () => fakeInstalledScenario() };
  const sel = await resolveCliScenarioSelection({
    projectId: 1, epicId: 2,
    installedScenarioProvider: provider,
    scenarioRunnerProvider: () => null,
  });
  assert.equal(sel.path, 'legacy');
  assert.equal(sel.reason, SELECTION_REASON.SCENARIO_RUNNER_NOT_WIRED);
});

// ===========================================================================
// §3 FORCE-LEGACY — operator override short-circuits.
// ===========================================================================

test('selection: forceLegacy short-circuits to legacy even with full wiring', async () => {
  const provider = { resolveInstalledScenario: async () => fakeInstalledScenario() };
  const sel = await resolveCliScenarioSelection({
    projectId: 1, epicId: 2,
    installedScenarioProvider: provider,
    scenarioRunnerProvider: () => fakeScenarioRunner(),
    forceLegacy: true,
  });
  assert.equal(sel.path, 'legacy');
  assert.equal(sel.reason, SELECTION_REASON.LEGACY_FORCED);
  assert.equal(sel.installedScenario, null);
});

// ===========================================================================
// §4 COMMAND-TRANSLATION — RunEpisodeCommand → RunScenarioCommand.
// ===========================================================================

test('command: buildScenarioCommand forwards scope, input, idempotency', () => {
  const cmd = buildScenarioCommand({
    projectId: 7, epicId: 9,
    lifecycleInput: { brief: 'x' },
    lifecycleInputSchema: 'saga3.product-delivery-lifecycle-input.v2',
    idempotencyKey: 'k-1',
    initiatedBy: 'op',
    resumePaused: true,
  });
  assert.equal(cmd.projectId, 7);
  assert.equal(cmd.epicId, 9);
  assert.deepEqual(cmd.inputPayload, { brief: 'x' });
  assert.equal(cmd.inputSchema, 'saga3.product-delivery-lifecycle-input.v2');
  assert.equal(cmd.idempotencyKey, 'k-1');
  assert.equal(cmd.initiatedBy, 'op');
  assert.equal(cmd.resumePaused, true);
});

test('command: buildScenarioCommand defaults schema, initiatedBy, idempotency', () => {
  const cmd = buildScenarioCommand({ projectId: 3, epicId: 4 });
  assert.equal(cmd.inputSchema, SCENARIO_INPUT_SCHEMA_DEFAULT);
  assert.equal(cmd.initiatedBy, 'orchestrate-cli');
  assert.equal(cmd.inputPayload, null);
  assert.equal(
    cmd.idempotencyKey,
    defaultIdempotencyKey({ projectId: 3, epicId: 4 }),
  );
});

test('command: defaultIdempotencyKey is stable and scoped to project+epic', () => {
  assert.equal(
    defaultIdempotencyKey({ projectId: 1, epicId: 2 }),
    'product-delivery-project-1-epic-2',
  );
});

// ===========================================================================
// §5 RESULT-PROJECTION — ScenarioExecutionResult → OrchestrationRunResult.
// ===========================================================================

test('projection: completed scenario run → reason completed, terminal preserved', () => {
  const scenario = fakeInstalledScenario();
  const result = projectScenarioResultToRunResult(
    {
      lifecycleRun: {
        id: 5,
        lifecycle: scenario.manifest.identity,
        lifecycleRefKey: 'k',
        definitionSnapshot: '{}',
        definitionHash: 'h',
        projectId: 1, epicId: 2,
        initiatedBy: 'x', idempotencyKey: 'k',
        inputSchema: 's', inputSnapshot: '{}', inputHash: 'h',
        status: 'completed',
        entryStageId: 'initial-discovery',
        currentStageId: null,
        currentStageRunId: null,
        terminalStatus: 'delivered',
        version: 1, leaseFence: 0, error: null,
        startedAt: '', completedAt: '', createdAt: '', updatedAt: '',
      },
      stageRuns: [{ id: 1 }, { id: 2 }],
      status: 'completed',
      terminalStatus: 'delivered',
      pausedAtStageId: null,
      outputs: [],
    },
    { projectId: 1, epicId: 2 },
  );
  assert.equal(result.reason, 'completed');
  assert.equal(result.finalStage, '<terminal>');
  assert.equal(result.cycles, 2);
  assert.equal(result.lifecycleRun.id, 5);
  assert.equal(result.lifecycleRun.terminalStatus, 'delivered');
  assert.equal(
    result.lifecycleRun.ref,
    `${scenario.manifest.identity.name}@${scenario.manifest.identity.version}`,
  );
});

test('projection: paused scenario run → reason paused; failed status → reason failed', () => {
  const scenario = fakeInstalledScenario();
  const baseRun = {
    id: 5, lifecycle: scenario.manifest.identity, lifecycleRefKey: 'k',
    definitionSnapshot: '{}', definitionHash: 'h',
    projectId: 1, epicId: 2, initiatedBy: 'x', idempotencyKey: 'k',
    inputSchema: 's', inputSnapshot: '{}', inputHash: 'h',
    entryStageId: 'initial-discovery', currentStageId: 'solution-formalization',
    currentStageRunId: null, version: 1, leaseFence: 0, error: null,
    startedAt: '', completedAt: '', createdAt: '', updatedAt: '',
  };
  const paused = projectScenarioResultToRunResult(
    { lifecycleRun: { ...baseRun, status: 'paused', terminalStatus: null },
      stageRuns: [], status: 'paused', terminalStatus: null, pausedAtStageId: 'solution-formalization', outputs: [] },
    { projectId: 1, epicId: 2 },
  );
  assert.equal(paused.reason, 'paused');
  assert.equal(paused.finalStage, 'solution-formalization');

  const failed = projectScenarioResultToRunResult(
    { lifecycleRun: { ...baseRun, status: 'failed', terminalStatus: 'failed', currentStageId: null },
      stageRuns: [], status: 'failed', terminalStatus: 'failed', pausedAtStageId: null, outputs: [] },
    { projectId: 1, epicId: 2 },
  );
  assert.equal(failed.reason, 'failed');
});

// ===========================================================================
// §6 EXECUTION-ROUTING — dispatch through the right path.
// ===========================================================================

test('execution: scenario selection → runner.run invoked, uniform result', async () => {
  const scenario = fakeInstalledScenario();
  const runner = fakeScenarioRunner();
  const sel = {
    path: 'scenario',
    reason: SELECTION_REASON.INSTALLED_SCENARIO,
    installedScenario: scenario,
    equivalentLegacyManifest: null,
  };
  const result = await runEpisodeViaScenarioAdapter({
    application: fakeApplication(),
    selection: sel,
    command: baseCommand,
    scenarioRunnerProvider: () => runner,
  });
  assert.equal(runner.calls.length, 1, 'runner.run called exactly once');
  assert.equal(runner.calls[0].command.projectId, 1);
  assert.equal(result.reason, 'completed');
  assert.equal(result.lifecycleRun.id, 9001);
});

test('execution: legacy selection → application.runEpisode invoked, recorder pulsed', async () => {
  let runCalls = 0;
  const application = fakeApplication(async (cmd) => {
    runCalls += 1;
    return {
      projectId: cmd.projectId, epicId: cmd.epicId,
      finalStage: 'delivery', endedAt: 't',
      reason: 'completed', cycles: 4, lastError: null,
    };
  });
  const records = [];
  const sel = {
    path: 'legacy',
    reason: SELECTION_REASON.NO_INSTALLED_SCENARIO,
    installedScenario: null,
    equivalentLegacyManifest: LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  };
  const result = await runEpisodeViaScenarioAdapter({
    application,
    selection: sel,
    command: { projectId: 1, epicId: 2 },
    compatibilityRecorder: (r) => records.push(r),
  });
  assert.equal(runCalls, 1, 'application.runEpisode called exactly once');
  assert.equal(result.reason, 'completed');
  assert.equal(records.length, 1, 'compatibility recorder pulsed once');
  assert.equal(records[0].source, 'w11-a4-cli');
  assert.equal(records[0].reason, SELECTION_REASON.NO_INSTALLED_SCENARIO);
  assert.equal(records[0].projectId, 1);
  assert.equal(records[0].equivalentScenarioIdentity.name,
    LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.identity.name);
});

test('execution: scenario path does NOT pulse compatibility recorder', async () => {
  const scenario = fakeInstalledScenario();
  const runner = fakeScenarioRunner();
  const records = [];
  const sel = {
    path: 'scenario',
    reason: SELECTION_REASON.INSTALLED_SCENARIO,
    installedScenario: scenario,
    equivalentLegacyManifest: null,
  };
  await runEpisodeViaScenarioAdapter({
    application: fakeApplication(),
    selection: sel,
    command: baseCommand,
    scenarioRunnerProvider: () => runner,
    compatibilityRecorder: (r) => records.push(r),
  });
  assert.equal(records.length, 0, 'scenario path must not record compatibility use');
});

test('execution: scenario selection without runner provider throws (consistent selection guard)', async () => {
  const sel = {
    path: 'scenario',
    reason: SELECTION_REASON.INSTALLED_SCENARIO,
    installedScenario: fakeInstalledScenario(),
    equivalentLegacyManifest: null,
  };
  await assert.rejects(
    () => runEpisodeViaScenarioAdapter({
      application: fakeApplication(),
      selection: sel,
      command: baseCommand,
      // scenarioRunnerProvider omitted
    }),
    /SCENARIO_RUNNER_PROVIDER_REQUIRED/,
  );
});

test('execution: resolveAndRunEpisode bundles resolve + execute (legacy path)', async () => {
  const records = [];
  const result = await resolveAndRunEpisode(
    fakeApplication(),
    { projectId: 1, epicId: 2 },
    {}, // no wiring → legacy
    { compatibilityRecorder: (r) => records.push(r) },
  );
  assert.equal(result.reason, 'completed');
  assert.equal(records.length, 1);
});

// ===========================================================================
// §7 COMPATIBILITY-RECORD — faulty recorder never breaks the run.
// ===========================================================================

test('record: faulty recorder is swallowed, run still completes', async () => {
  const sel = {
    path: 'legacy',
    reason: SELECTION_REASON.LEGACY_FORCED,
    installedScenario: null,
    equivalentLegacyManifest: LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE,
  };
  const faulty = () => { throw new Error('inventory down'); };
  // Must not throw.
  const result = await runEpisodeViaScenarioAdapter({
    application: fakeApplication(),
    selection: sel,
    command: baseCommand,
    compatibilityRecorder: faulty,
  });
  assert.equal(result.reason, 'completed');
});

// ===========================================================================
// §8 TOOL-STATUS/WIRING — MCP tool wiring slots + projection.
// ===========================================================================

test('tool/status: no wiring → not-started', () => {
  _resetScenarioSelectionWiringForTests();
  const status = readScenarioSelectionWiringStatus();
  assert.equal(status.installedScenarioProviderWired, false);
  assert.equal(status.scenarioRunnerProviderWired, false);
  assert.equal(status.cutoverPhase, 'not-started');
});

test('tool/status: provider only → partial', () => {
  _resetScenarioSelectionWiringForTests();
  setInstalledScenarioProvider({ resolveInstalledScenario: async () => null });
  const status = readScenarioSelectionWiringStatus();
  assert.equal(status.installedScenarioProviderWired, true);
  assert.equal(status.scenarioRunnerProviderWired, false);
  assert.equal(status.cutoverPhase, 'partial');
});

test('tool/status: both wired → ready', () => {
  _resetScenarioSelectionWiringForTests();
  setInstalledScenarioProvider({ resolveInstalledScenario: async () => null });
  setScenarioRunnerProvider(() => null);
  const status = readScenarioSelectionWiringStatus();
  assert.equal(status.cutoverPhase, 'ready');
});

test('tool/projection: projectSelectionForTool exposes identities + explanation', async () => {
  _resetScenarioSelectionWiringForTests();
  // Legacy selection.
  const legacySel = await resolveCliScenarioSelection({ projectId: 1, epicId: 2 });
  const legacyProj = projectSelectionForTool(legacySel);
  assert.equal(legacyProj.path, 'legacy');
  assert.equal(legacyProj.installedScenarioIdentity, null);
  assert.ok(legacyProj.equivalentLegacyScenarioIdentity);
  assert.match(legacyProj.explanation, /legacy/);
  assert.equal(legacyProj.wiring.cutoverPhase, 'not-started');

  // Scenario selection.
  const scenario = fakeInstalledScenario();
  const sel = await resolveCliScenarioSelection({
    projectId: 1, epicId: 2,
    installedScenarioProvider: { resolveInstalledScenario: async () => scenario },
    scenarioRunnerProvider: () => fakeScenarioRunner(),
  });
  const proj = projectSelectionForTool(sel);
  assert.equal(proj.path, 'scenario');
  assert.equal(
    proj.installedScenarioIdentity.name,
    scenario.manifest.identity.name,
  );
  assert.equal(proj.equivalentLegacyScenarioIdentity, null);
  assert.match(proj.explanation, /installed scenario/);
});

// Reset wiring slots once more so this file leaves no global state for any
// test runner that reuses the process.
test('cleanup: reset wiring slots', () => {
  _resetScenarioSelectionWiringForTests();
  assert.equal(readScenarioSelectionWiringStatus().cutoverPhase, 'not-started');
});
