// Tests for the lifecycle-agnostic pipeline projection.
//
// Covers:
//   - golden case (real run-26 data) -> exact PipelineView contract
//   - terminal outcome route -> terminal block set, later stages skipped
//   - rework (two StageRuns same stageId) -> attempt count = 2
//   - null fallback for the query service when no run exists
//
// The projection is PURE: these tests never touch SQLite. They build record
// fixtures inline and assert against the frozen PipelineView contract.

import assert from 'node:assert/strict';
import test from 'node:test';

const { canonicalJson } = await import(
  '../../dist/shared/canonical-json.js'
);
const { projectPipeline } = await import(
  '../../dist/process-modules/application/lifecycle-pipeline-projection.js'
);
const { buildPipelineView } = await import(
  '../../dist/process-modules/application/lifecycle-pipeline-query.js'
);

// ---------------------------------------------------------------------------
// Canonical definition snapshot for the product-delivery lifecycle.
// Built with the same canonicalJson the orchestrator pins at start time, so the
// projection parses exactly what a real run stores.
// ---------------------------------------------------------------------------

const productDeliveryDefinition = {
  identity: {
    name: 'product-delivery',
    version: '1.0.0',
    displayName: 'Product Delivery',
    description:
      'Moves one product initiative through Discovery, Formalization, Development and Delivery/Release.',
  },
  entryStageId: 'initial-discovery',
  stages: [
    {
      id: 'initial-discovery',
      displayName: 'Initial Discovery',
      moduleRef: { name: 'product-discovery', version: '3.0.2' },
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {
        go: { type: 'stage', stageId: 'solution-formalization' },
        clarify: { type: 'stage', stageId: 'solution-formalization' },
        reject: { type: 'stage', stageId: 'solution-formalization' },
        defer: { type: 'stage', stageId: 'solution-formalization' },
        inconclusive: { type: 'stage', stageId: 'solution-formalization' },
        failed: { type: 'stage', stageId: 'solution-formalization' },
      },
      entryConditions: ['initiative.subject exists'],
      exitConditions: [
        'Discovery has an immutable local outcome and certificate lineage',
      ],
    },
    {
      id: 'solution-formalization',
      displayName: 'Solution Formalization',
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {
        formalized: { type: 'stage', stageId: 'solution-development' },
        'clarification-required': {
          type: 'terminal',
          status: 'clarification-required',
        },
        inconsistent: { type: 'terminal', status: 'formalization-inconsistent' },
        infeasible: { type: 'terminal', status: 'infeasible' },
        failed: { type: 'terminal', status: 'failed' },
      },
      entryConditions: ['Discovery certificate ref and hash exist'],
      exitConditions: [
        'Formalization has a frozen content-addressed Solution Contract',
      ],
    },
    {
      id: 'solution-development',
      displayName: 'Solution Development',
      moduleRef: { name: 'solution-development', version: '1.0.0' },
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {
        verified: { type: 'stage', stageId: 'delivery-release' },
        'rework-required': {
          type: 'terminal',
          status: 'development-rework-required',
        },
        'clarification-required': {
          type: 'terminal',
          status: 'clarification-required',
        },
        blocked: { type: 'terminal', status: 'development-blocked' },
        failed: { type: 'terminal', status: 'failed' },
      },
      entryConditions: ['Formalization outcome is formalized'],
      exitConditions: [
        'Development has verified an immutable integrated candidate',
      ],
    },
    {
      id: 'delivery-release',
      displayName: 'Delivery and Release',
      moduleRef: { name: 'delivery-release', version: '1.0.0' },
      inputMapping: {},
      outputMapping: {},
      outcomeRoutes: {
        released: { type: 'terminal', status: 'released' },
        'approval-required': { type: 'terminal', status: 'approval-required' },
        blocked: { type: 'terminal', status: 'delivery-blocked' },
        failed: { type: 'terminal', status: 'failed' },
      },
      entryConditions: ['Development outcome is verified'],
      exitConditions: [
        'Every required external action has authoritative observed state',
      ],
    },
  ],
};

const definitionSnapshot = canonicalJson(productDeliveryDefinition);

// ---------------------------------------------------------------------------
// Record builders — only the fields the projection reads; everything else
// defaulted. This mirrors LifecycleRunRecord / LifecycleStageRunRecord /
// LifecycleTransitionRecord from persistence/lifecycle-run.ts.
// ---------------------------------------------------------------------------

function baseRun(overrides = {}) {
  return {
    id: 26,
    lifecycle: {
      name: 'product-delivery',
      version: '1.0.0',
      displayName: 'Product Delivery',
      description:
        'Moves one product initiative through Discovery, Formalization, Development and Delivery/Release.',
    },
    lifecycleRefKey: 'product-delivery@1.0.0',
    definitionSnapshot,
    definitionHash: 'deadbeef',
    projectId: 1,
    epicId: 1,
    initiatedBy: 'operator',
    idempotencyKey: 'idem-26',
    inputSchema: 'factory.product-delivery-lifecycle-input.v2',
    inputSnapshot: '{}',
    inputHash: 'cafebabe',
    status: 'running',
    entryStageId: 'initial-discovery',
    currentStageId: 'solution-formalization',
    currentStageRunId: 53,
    terminalStatus: null,
    version: 7,
    leaseFence: 0,
    error: null,
    startedAt: '2026-07-30 05:25:20',
    completedAt: null,
    createdAt: '2026-07-30 05:25:20',
    updatedAt: '2026-07-30 05:38:57',
    ...overrides,
  };
}

function baseStageRun(overrides = {}) {
  return {
    id: 52,
    lifecycleRunId: 26,
    ordinal: 1,
    stageId: 'initial-discovery',
    attempt: 1,
    moduleRef: { name: 'product-discovery', version: '3.0.2' },
    bindingSnapshot: '{}',
    bindingHash: 'a',
    inputSchema: 's',
    inputSnapshot: '{}',
    inputHash: 'h',
    status: 'completed',
    processRunId: 100,
    localOutcome: 'go',
    authority: 'operator',
    output: null,
    certificate: null,
    mappedOutput: null,
    resultSnapshot: null,
    error: null,
    startedAt: '2026-07-30 05:25:20',
    completedAt: '2026-07-30 05:28:17',
    createdAt: '2026-07-30 05:25:20',
    updatedAt: '2026-07-30 05:28:17',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('golden: run-26 produces the exact frozen PipelineView contract', () => {
  const run = baseRun();
  const stageRuns = [
    baseStageRun({
      id: 52,
      ordinal: 1,
      stageId: 'initial-discovery',
      attempt: 1,
      moduleRef: { name: 'product-discovery', version: '3.0.2' },
      status: 'completed',
      localOutcome: 'go',
      startedAt: '2026-07-30 05:25:20',
      completedAt: '2026-07-30 05:28:17',
    }),
    baseStageRun({
      id: 53,
      ordinal: 2,
      stageId: 'solution-formalization',
      attempt: 1,
      moduleRef: { name: 'solution-formalization', version: '1.0.0' },
      status: 'running',
      localOutcome: null,
      startedAt: '2026-07-30 05:28:17',
      completedAt: null,
    }),
  ];
  const view = projectPipeline(run, stageRuns);

  const expected = {
    lifecycle: {
      name: 'product-delivery',
      version: '1.0.0',
      displayName: 'Product Delivery',
      description:
        'Moves one product initiative through Discovery, Formalization, Development and Delivery/Release.',
    },
    run: {
      id: 26,
      status: 'running',
      terminalStatus: null,
      startedAt: '2026-07-30T05:25:20Z',
      updatedAt: '2026-07-30T05:38:57Z',
      error: null,
    },
    stages: [
      {
        stageId: 'initial-discovery',
        ordinal: 1,
        displayName: 'Initial Discovery',
        module: { name: 'product-discovery', version: '3.0.2' },
        status: 'completed',
        localOutcome: 'go',
        attempt: 1,
        startedAt: '2026-07-30T05:25:20Z',
        completedAt: '2026-07-30T05:28:17Z',
        durationS: 177,
        isLive: false,
      },
      {
        stageId: 'solution-formalization',
        ordinal: 2,
        displayName: 'Solution Formalization',
        module: { name: 'solution-formalization', version: '1.0.0' },
        status: 'in_progress',
        localOutcome: null,
        attempt: 1,
        startedAt: '2026-07-30T05:28:17Z',
        completedAt: null,
        durationS: null,
        isLive: true,
      },
      {
        stageId: 'solution-development',
        ordinal: 3,
        displayName: 'Solution Development',
        module: { name: 'solution-development', version: '1.0.0' },
        status: 'pending',
        localOutcome: null,
        attempt: 0,
        startedAt: null,
        completedAt: null,
        durationS: null,
        isLive: false,
      },
      {
        stageId: 'delivery-release',
        ordinal: 4,
        displayName: 'Delivery and Release',
        module: { name: 'delivery-release', version: '1.0.0' },
        status: 'pending',
        localOutcome: null,
        attempt: 0,
        startedAt: null,
        completedAt: null,
        durationS: null,
        isLive: false,
      },
    ],
    terminal: null,
  };

  assert.deepEqual(view, expected);
});

test('durationS is the integer second delta, only when completedAt present', () => {
  const run = baseRun();
  const stageRuns = [
    baseStageRun({
      id: 52,
      ordinal: 1,
      stageId: 'initial-discovery',
      status: 'completed',
      localOutcome: 'go',
      startedAt: '2026-07-30 05:25:20',
      completedAt: '2026-07-30 05:25:50', // 30s
    }),
  ];
  const view = projectPipeline(run, stageRuns, []);
  assert.equal(view.stages[0].durationS, 30);
});

test('terminal outcome route sets terminal block and skips later stages', () => {
  // Formalization resolves to `infeasible` -> terminal route. Run is completed.
  const run = baseRun({
    currentStageId: 'solution-formalization',
    status: 'completed',
    terminalStatus: 'infeasible',
    completedAt: '2026-07-30 05:40:00',
  });
  const stageRuns = [
    baseStageRun({
      id: 52,
      ordinal: 1,
      stageId: 'initial-discovery',
      status: 'completed',
      localOutcome: 'go',
      startedAt: '2026-07-30 05:25:20',
      completedAt: '2026-07-30 05:28:17',
    }),
    baseStageRun({
      id: 53,
      ordinal: 2,
      stageId: 'solution-formalization',
      status: 'completed',
      localOutcome: 'infeasible',
      startedAt: '2026-07-30 05:28:17',
      completedAt: '2026-07-30 05:35:00',
    }),
  ];

  const view = projectPipeline(run, stageRuns, []);

  assert.deepEqual(view.terminal, {
    status: 'infeasible',
    atStageId: 'solution-formalization',
    outcome: 'infeasible',
  });
  assert.equal(view.run.terminalStatus, 'infeasible');

  const statuses = view.stages.map(s => s.status);
  // Up to and including the terminal stage keep real status; later are skipped.
  assert.deepEqual(statuses, ['completed', 'completed', 'skipped', 'skipped']);
});

test('rework: latest durable attempt is shown even when history is sparse', () => {
  const run = baseRun({ currentStageId: 'solution-development' });
  const stageRuns = [
    baseStageRun({
      id: 52,
      ordinal: 1,
      stageId: 'initial-discovery',
      status: 'completed',
      localOutcome: 'go',
      startedAt: '2026-07-30 05:25:20',
      completedAt: '2026-07-30 05:28:17',
    }),
    // Formalization attempt 1 completed with a non-terminal "formalized".
    baseStageRun({
      id: 53,
      ordinal: 2,
      stageId: 'solution-formalization',
      attempt: 1,
      status: 'completed',
      localOutcome: 'formalized',
      startedAt: '2026-07-30 05:28:17',
      completedAt: '2026-07-30 05:30:00',
    }),
    // Sparse history: the projection must show durable attempt #5, not infer
    // attempt #2 from the number of rows returned by the repository.
    baseStageRun({
      id: 60,
      ordinal: 3,
      stageId: 'solution-development',
      attempt: 2,
      status: 'failed',
      localOutcome: 'failed',
      startedAt: '2026-07-30 05:30:00',
      completedAt: '2026-07-30 05:32:00',
    }),
    baseStageRun({
      id: 61,
      ordinal: 4,
      stageId: 'solution-development',
      attempt: 5,
      status: 'running',
      localOutcome: null,
      startedAt: '2026-07-30 05:33:00',
      completedAt: null,
    }),
  ];

  const view = projectPipeline(run, stageRuns, []);

  const dev = view.stages.find(s => s.stageId === 'solution-development');
  assert.equal(dev.attempt, 5);
  // highest attempt (5) is the bar -> running -> in_progress + live
  assert.equal(dev.status, 'in_progress');
  assert.equal(dev.isLive, true);
  assert.equal(dev.durationS, null);
});

test('paused stage is not live and does not tick elapsed time', () => {
  const run = baseRun({ status: 'paused' });
  const stageRuns = [
    baseStageRun({
      stageId: 'initial-discovery',
      status: 'paused',
      localOutcome: null,
      startedAt: '2026-07-30 05:25:20',
      completedAt: null,
    }),
  ];

  const view = projectPipeline(run, stageRuns, []);
  assert.equal(view.stages[0].status, 'paused');
  assert.equal(view.stages[0].isLive, false);
  assert.equal(view.stages[0].durationS, null);
});

test('buildPipelineView returns null when no run exists for the epic', () => {
  const repo = {
    list: () => [],
  };
  const view = buildPipelineView(1, 1, repo);
  assert.equal(view, null);
});

test('buildPipelineView delegates to projectPipeline for the most recent run', () => {
  const run = baseRun();
  const stageRuns = [
    baseStageRun({ status: 'completed', localOutcome: 'go' }),
  ];
  const repo = {
    list: () => [run], // ORDER BY id DESC — first is most recent
    read: id => (id === run.id ? run : null),
    listStageRuns: () => stageRuns,
    listTransitions: () => [],
  };

  const view = buildPipelineView(1, 1, repo);
  assert.ok(view);
  assert.equal(view.run.id, 26);
  assert.equal(view.stages.length, 4);
  assert.equal(view.terminal, null);
});

test('buildPipelineView picks the most recent run when several exist', () => {
  const older = baseRun({ id: 10 });
  const newer = baseRun({ id: 99 });
  const repo = {
    list: () => [newer, older], // newest first
    read: id => (id === 99 ? newer : older),
    listStageRuns: () => [],
    listTransitions: () => [],
  };

  const view = buildPipelineView(1, 1, repo);
  assert.equal(view.run.id, 99);
});
