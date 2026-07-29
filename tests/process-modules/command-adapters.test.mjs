// tests/process-modules/command-adapters.test.mjs
//
// W11-A3 — Generic application command + result adapters.
//
// Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md lane A3.
// Plan §13.22: "Current generic application commands and results still contain
// mandatory project, epic, and Discovery-oriented fields. These require outer
// compatibility adapters around a generic scenario command and result."
//
// These tests cover the adapter contract:
//   - resolveGenericScope: optional scope → concrete (projectId/epicId/initiatedBy).
//   - adaptCommandToLegacy / adaptCommandToScenario: generic command → concrete
//     RunLifecycleCommand / RunScenarioCommand (project/epic optional on input,
//     mandatory on output).
//   - adaptLegacyResult / adaptScenarioResult: typed result → generic result,
//     stamped with `source` and a stable `outputs` field.
//   - runLifecycleGeneric / runScenarioGeneric: end-to-end wrappers delegate to
//     the projection adapters and normalize the typed result.
//
// Run: `node --test tests/process-modules/command-adapters.test.mjs`
// (after `npm run build`).

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  resolveGenericScope,
  adaptCommandToLegacy,
  adaptCommandToScenario,
  adaptLegacyResult,
  adaptScenarioResult,
  runLifecycleGeneric,
  runScenarioGeneric,
} = await import('../../dist/process-modules/application/command-adapters.js');

// ---------------------------------------------------------------------------
// Fixture builders for the typed records the result adapters consume. We build
// minimal records that satisfy the LifecycleRunRecord / LifecycleStageRunRecord
// / ScenarioStageOutputRecord shapes; the adapters are pure projections over
// these fields, so we only populate what the adapter reads.
// ---------------------------------------------------------------------------

function lifecycleRunRecord(overrides = {}) {
  return {
    id: 42,
    lifecycle: { name: 'l', version: '1.0.0' },
    lifecycleRefKey: 'l@1.0.0',
    definitionSnapshot: '{}',
    definitionHash: 'h',
    projectId: 7,
    epicId: 9,
    initiatedBy: 'tester',
    idempotencyKey: 'k-1',
    inputSchema: 'in.v1',
    inputSnapshot: '{}',
    inputHash: 'ih',
    status: 'completed',
    entryStageId: 'discovery',
    currentStageId: 'delivery',
    currentStageRunId: 5,
    terminalStatus: 'delivered',
    version: 3,
    leaseFence: 1,
    error: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    ...overrides,
  };
}

function stageRunRecord(overrides = {}) {
  return {
    id: 5,
    lifecycleRunId: 42,
    stageId: 'delivery',
    moduleRef: { name: 'delivery', version: '1.0.0' },
    bindingSnapshot: '{}',
    bindingHash: 'bh',
    processRunId: 100,
    inputSchema: 'in.v1',
    inputPayload: '{}',
    inputSnapshot: '{}',
    inputHash: 'ih',
    status: 'completed',
    localOutcome: 'delivered',
    authority: 'test',
    outputRef: 'out-ref',
    outputSchema: 'out.v1',
    outputHash: 'oh',
    certificateRef: null,
    certificateSchema: null,
    certificateHash: null,
    resultSnapshot: { code: 'delivered' },
    mappedOutput: {},
    handoffSnapshot: '{}',
    handoffHash: 'hh',
    decisionHash: 'dh',
    transitionKey: 't',
    nextStageId: null,
    error: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:05:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:05:00.000Z',
    ...overrides,
  };
}

function scenarioOutputRecord(overrides = {}) {
  return {
    scenarioRunId: 42,
    stageId: 'delivery',
    outputSchema: 'out.v1',
    artifactRef: 'out-ref',
    contentHash: 'oh',
    payload: { delivered: true },
    ...overrides,
  };
}

// ===========================================================================
// resolveGenericScope (§13.22 — project/epic become optional adapter fields).
// ===========================================================================

test('resolveGenericScope: undefined scope defaults to projectId=0 / epicId=null / generic', () => {
  const resolved = resolveGenericScope(undefined);
  assert.equal(resolved.projectId, 0);
  assert.equal(resolved.epicId, null);
  assert.equal(resolved.initiatedBy, 'generic');
});

test('resolveGenericScope: empty scope object defaults identically', () => {
  const resolved = resolveGenericScope({});
  assert.equal(resolved.projectId, 0);
  assert.equal(resolved.epicId, null);
  assert.equal(resolved.initiatedBy, 'generic');
});

test('resolveGenericScope: supplied projectId/initiatedBy pass through', () => {
  const resolved = resolveGenericScope({ projectId: 7, initiatedBy: 'ops' });
  assert.equal(resolved.projectId, 7);
  // epicId omitted → null (distinct from an explicit null, which also → null).
  assert.equal(resolved.epicId, null);
  assert.equal(resolved.initiatedBy, 'ops');
});

test('resolveGenericScope: explicit null epicId preserved as null (project-wide run)', () => {
  const resolved = resolveGenericScope({ projectId: 7, epicId: null });
  assert.equal(resolved.projectId, 7);
  assert.equal(resolved.epicId, null);
});

test('resolveGenericScope: explicit epicId preserved', () => {
  const resolved = resolveGenericScope({ projectId: 7, epicId: 9 });
  assert.equal(resolved.projectId, 7);
  assert.equal(resolved.epicId, 9);
});

// ===========================================================================
// adaptCommandToLegacy — generic command → legacy RunLifecycleCommand.
// ===========================================================================

test('adaptCommandToLegacy: missing scope resolves mandatory project/epic fields', () => {
  const legacy = adaptCommandToLegacy({
    inputSchema: 'in.v1',
    inputPayload: { x: 1 },
    idempotencyKey: 'k-1',
  });
  // §13.22: project/epic are mandatory on the legacy command.
  assert.equal(legacy.projectId, 0);
  assert.equal(legacy.epicId, null);
  assert.equal(legacy.initiatedBy, 'generic');
  assert.equal(legacy.inputSchema, 'in.v1');
  assert.deepEqual(legacy.inputPayload, { x: 1 });
  assert.equal(legacy.idempotencyKey, 'k-1');
  assert.equal('resumePaused' in legacy, false);
});

test('adaptCommandToLegacy: scope flows through to mandatory fields', () => {
  const legacy = adaptCommandToLegacy({
    inputSchema: 'in.v1',
    inputPayload: {},
    idempotencyKey: 'k-2',
    scope: { projectId: 7, epicId: 9, initiatedBy: 'ops' },
  });
  assert.equal(legacy.projectId, 7);
  assert.equal(legacy.epicId, 9);
  assert.equal(legacy.initiatedBy, 'ops');
});

test('adaptCommandToLegacy: resumePaused true is forwarded', () => {
  const legacy = adaptCommandToLegacy({
    inputSchema: 'in.v1',
    inputPayload: {},
    idempotencyKey: 'k-3',
    resumePaused: true,
  });
  assert.equal(legacy.resumePaused, true);
});

test('adaptCommandToLegacy: resumePaused false is forwarded (explicit, distinct from absent)', () => {
  const legacy = adaptCommandToLegacy({
    inputSchema: 'in.v1',
    inputPayload: {},
    idempotencyKey: 'k-4',
    resumePaused: false,
  });
  assert.equal(legacy.resumePaused, false);
});

// ===========================================================================
// adaptCommandToScenario — generic command → scenario RunScenarioCommand.
// ===========================================================================

test('adaptCommandToScenario: mirrors adaptCommandToLegacy scope resolution', () => {
  const scenario = adaptCommandToScenario({
    inputSchema: 'in.v2',
    inputPayload: { y: 2 },
    idempotencyKey: 'k-5',
    scope: { projectId: 11, initiatedBy: 'svc' },
  });
  assert.equal(scenario.projectId, 11);
  assert.equal(scenario.epicId, null);
  assert.equal(scenario.initiatedBy, 'svc');
  assert.equal(scenario.inputSchema, 'in.v2');
  assert.deepEqual(scenario.inputPayload, { y: 2 });
  assert.equal(scenario.idempotencyKey, 'k-5');
  assert.equal('resumePaused' in scenario, false);
});

test('adaptCommandToScenario: resumePaused forwarded', () => {
  const scenario = adaptCommandToScenario({
    inputSchema: 'in.v2',
    inputPayload: {},
    idempotencyKey: 'k-6',
    resumePaused: true,
  });
  assert.equal(scenario.resumePaused, true);
});

test('adaptCommandToLegacy and adaptCommandToScenario agree on scope resolution', () => {
  // The two underlying commands share the same invocation-context shape by
  // design (scenario-runner.ts built RunScenarioCommand to mirror
  // RunLifecycleCommand). The generic adapter must produce identical scope
  // projections for both.
  const generic = {
    inputSchema: 'in.v1',
    inputPayload: { z: 3 },
    idempotencyKey: 'k-shared',
    scope: { projectId: 5, epicId: 6, initiatedBy: 'bot' },
  };
  const legacy = adaptCommandToLegacy(generic);
  const scenario = adaptCommandToScenario(generic);
  assert.equal(legacy.projectId, scenario.projectId);
  assert.equal(legacy.epicId, scenario.epicId);
  assert.equal(legacy.initiatedBy, scenario.initiatedBy);
  assert.equal(legacy.inputSchema, scenario.inputSchema);
  assert.deepEqual(legacy.inputPayload, scenario.inputPayload);
  assert.equal(legacy.idempotencyKey, scenario.idempotencyKey);
});

// ===========================================================================
// adaptLegacyResult — legacy LifecycleExecutionResult → generic result.
// ===========================================================================

test('adaptLegacyResult: stamps source=legacy-orchestrator and empty outputs', () => {
  const run = lifecycleRunRecord({ status: 'paused', currentStageId: 'discovery', terminalStatus: null });
  const stage = stageRunRecord({ stageId: 'discovery', status: 'paused' });
  const generic = adaptLegacyResult({
    lifecycleRun: run,
    stageRuns: [stage],
    status: 'paused',
    terminalStatus: null,
    pausedAtStageId: 'discovery',
  });
  assert.equal(generic.source, 'legacy-orchestrator');
  assert.equal(generic.lifecycleRun, run);
  assert.equal(generic.stageRuns.length, 1);
  assert.equal(generic.stageRuns[0], stage);
  assert.equal(generic.status, 'paused');
  assert.equal(generic.terminalStatus, null);
  assert.equal(generic.pausedAtStageId, 'discovery');
  // Legacy orchestrator has no public-output store → empty.
  assert.deepEqual(generic.outputs, []);
});

test('adaptLegacyResult: completed run carries terminal status', () => {
  const generic = adaptLegacyResult({
    lifecycleRun: lifecycleRunRecord(),
    stageRuns: [stageRunRecord()],
    status: 'completed',
    terminalStatus: 'delivered',
    pausedAtStageId: null,
  });
  assert.equal(generic.status, 'completed');
  assert.equal(generic.terminalStatus, 'delivered');
  assert.equal(generic.pausedAtStageId, null);
  assert.equal(generic.outputs.length, 0);
});

// ===========================================================================
// adaptScenarioResult — scenario ScenarioExecutionResult → generic result.
// ===========================================================================

test('adaptScenarioResult: stamps source=scenario-runner and passes outputs through', () => {
  const run = lifecycleRunRecord({ status: 'completed' });
  const stage = stageRunRecord();
  const outputs = [scenarioOutputRecord()];
  const generic = adaptScenarioResult({
    lifecycleRun: run,
    stageRuns: [stage],
    status: 'completed',
    terminalStatus: 'delivered',
    pausedAtStageId: null,
    outputs,
  });
  assert.equal(generic.source, 'scenario-runner');
  assert.equal(generic.lifecycleRun, run);
  assert.equal(generic.stageRuns[0], stage);
  assert.equal(generic.status, 'completed');
  assert.equal(generic.terminalStatus, 'delivered');
  // Outputs passed through verbatim (same reference).
  assert.equal(generic.outputs, outputs);
});

test('adaptScenarioResult: paused scenario run keeps pausedAtStageId', () => {
  const generic = adaptScenarioResult({
    lifecycleRun: lifecycleRunRecord({ status: 'paused', currentStageId: 'formalization' }),
    stageRuns: [],
    status: 'paused',
    terminalStatus: null,
    pausedAtStageId: 'formalization',
    outputs: [],
  });
  assert.equal(generic.status, 'paused');
  assert.equal(generic.pausedAtStageId, 'formalization');
});

// ===========================================================================
// High-level wrappers (runLifecycleGeneric / runScenarioGeneric).
// ===========================================================================

test('runLifecycleGeneric: delegates to orchestrator.run with projected legacy command', async () => {
  const recorded = { definition: null, command: null };
  const orchestrator = {
    async run(definition, command) {
      recorded.definition = definition;
      recorded.command = command;
      return {
        lifecycleRun: lifecycleRunRecord({ projectId: command.projectId, epicId: command.epicId }),
        stageRuns: [stageRunRecord()],
        status: 'completed',
        terminalStatus: 'delivered',
        pausedAtStageId: null,
      };
    },
  };
  const definition = { identity: { name: 'pd', version: '1.0.0' } };

  const generic = await runLifecycleGeneric(orchestrator, definition, {
    inputSchema: 'in.v1',
    inputPayload: { brief: 'b' },
    idempotencyKey: 'k-run',
    scope: { projectId: 7, epicId: 9, initiatedBy: 'ops' },
  });

  // The orchestrator received the definition verbatim and a projected legacy
  // command carrying the resolved mandatory scope fields.
  assert.equal(recorded.definition, definition);
  assert.equal(recorded.command.projectId, 7);
  assert.equal(recorded.command.epicId, 9);
  assert.equal(recorded.command.initiatedBy, 'ops');
  assert.equal(recorded.command.idempotencyKey, 'k-run');

  // And the generic result is normalized from the typed result.
  assert.equal(generic.source, 'legacy-orchestrator');
  assert.equal(generic.lifecycleRun.projectId, 7);
  assert.equal(generic.status, 'completed');
  assert.deepEqual(generic.outputs, []);
});

test('runLifecycleGeneric: generic command without scope still produces a valid legacy command', async () => {
  const orchestrator = {
    async run(_definition, command) {
      // Mandatory fields are present (resolved to defaults).
      assert.equal(command.projectId, 0);
      assert.equal(command.epicId, null);
      assert.equal(command.initiatedBy, 'generic');
      return {
        lifecycleRun: lifecycleRunRecord(),
        stageRuns: [],
        status: 'completed',
        terminalStatus: 'delivered',
        pausedAtStageId: null,
      };
    },
  };
  const generic = await runLifecycleGeneric(orchestrator, {}, {
    inputSchema: 'in.v1',
    inputPayload: {},
    idempotencyKey: 'k-noscope',
  });
  assert.equal(generic.source, 'legacy-orchestrator');
});

test('runScenarioGeneric: delegates to runner.run with projected scenario command', async () => {
  const recorded = { scenario: null, command: null };
  const runner = {
    async run(scenario, command) {
      recorded.scenario = scenario;
      recorded.command = command;
      return {
        lifecycleRun: lifecycleRunRecord(),
        stageRuns: [stageRunRecord()],
        status: 'completed',
        terminalStatus: 'scenario-approved',
        pausedAtStageId: null,
        outputs: [scenarioOutputRecord()],
      };
    },
  };
  const scenario = { manifest: { identity: { name: 's', version: '1.0.0' } } };

  const generic = await runScenarioGeneric(runner, scenario, {
    inputSchema: 'in.v2',
    inputPayload: { campaign: 'c' },
    idempotencyKey: 'k-sc',
    scope: { projectId: 3, epicId: null, initiatedBy: 'svc' },
  });

  assert.equal(recorded.scenario, scenario);
  assert.equal(recorded.command.projectId, 3);
  assert.equal(recorded.command.epicId, null);
  assert.equal(recorded.command.initiatedBy, 'svc');

  assert.equal(generic.source, 'scenario-runner');
  assert.equal(generic.terminalStatus, 'scenario-approved');
  assert.equal(generic.outputs.length, 1);
});

// ===========================================================================
// Determinism / purity: projection adapters are pure.
// ===========================================================================

test('projection adapters are pure: calling twice yields equal results', () => {
  const generic = {
    inputSchema: 'in.v1',
    inputPayload: { a: 1 },
    idempotencyKey: 'k-pure',
    scope: { projectId: 2, epicId: 4, initiatedBy: 'p' },
    resumePaused: true,
  };
  const l1 = adaptCommandToLegacy(generic);
  const l2 = adaptCommandToLegacy(generic);
  assert.deepEqual(l1, l2);
  const s1 = adaptCommandToScenario(generic);
  const s2 = adaptCommandToScenario(generic);
  assert.deepEqual(s1, s2);
});

test('adaptCommandToLegacy does not mutate the input generic command', () => {
  const generic = {
    inputSchema: 'in.v1',
    inputPayload: {},
    idempotencyKey: 'k-imm',
    scope: { projectId: 1, epicId: 2, initiatedBy: 'i' },
  };
  const snapshot = JSON.parse(JSON.stringify(generic));
  adaptCommandToLegacy(generic);
  assert.deepEqual(generic, snapshot);
});
