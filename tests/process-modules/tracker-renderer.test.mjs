// W5-A3 — TrackerRenderer tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE5-WORKSPACE-TRACKER-SPEC.md
// Task: docs/refactor-management/05-subagent-tasks/W05-a3.md
// Plan: §0.8 (Wave 5) / exit gate §0.8.12 item 2 (C027).
//
// These tests pin the deterministic TrackerRenderer contract:
//   1. C027 — output NEVER contains model-authored Markdown checkboxes
//      (`- [ ]` or `- [x]`). The status is a fixed read-only symbol token.
//   2. Determinism — same inputs produce byte-identical output; step order
//      follows declaration order, not insertion order.
//   3. Latest-attempt-wins projection (highest rank, then highest attempt).
//   4. Evidence summary is computed from durable evidence, never authored.
//   5. Recovery entry steps render in a separate block.
//   6. All five ProtocolStepRunStatus values map to their symbol.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  TrackerRenderer,
  renderTracker,
  symbolForStatus,
} = await import('../../dist/process-modules/application/tracker-renderer.js');

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function makeModule(overrides = {}) {
  return {
    id: 'p-linear',
    version: '1.0.0',
    owningFlowNodeId: 'n1',
    entryStep: 's1',
    steps: [
      {
        id: 's1',
        instructions: 'Do step 1',
        resources: ['docs/x.md'],
        allowedTools: ['task_get', 'read'],
        evidenceRequirements: [
          { category: 'tool-receipt', contractRef: 'c.s1.v1', required: true },
        ],
      },
      {
        id: 's2',
        instructions: 'Do step 2',
        resources: [],
        allowedTools: ['worker_done'],
        evidenceRequirements: [
          { category: 'artifact-reference', contractRef: 'c.s2.v1', required: true },
          { category: 'tool-receipt', contractRef: 'c.s2.tool.v1', required: false },
        ],
      },
    ],
    transitions: [{ from: 's1', to: 's2', kind: 'linear' }],
    nodeCompletionEvidence: [],
    recoveryEntrySteps: [],
    retrySemantics: 'runtime-implemented-linear',
    ...overrides,
  };
}

function makeRun(overrides = {}) {
  const now = '2026-07-29T00:00:00.000Z';
  return {
    id: 42,
    processRunId: 7,
    nodeRunId: null,
    nodeProtocolId: 'p-linear',
    nodeProtocolVersion: '1.0.0',
    entryStep: 's1',
    currentStep: 's1',
    status: 'active',
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    ...overrides,
  };
}

function makeStepRun(stepId, overrides = {}) {
  return {
    id: 100,
    protocolRunId: 42,
    stepId,
    attempt: 1,
    status: 'in_progress',
    evidence: [],
    completedAt: null,
    createdAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// symbolForStatus — total mapping (C027).
// ---------------------------------------------------------------------------

test('symbolForStatus maps every status to its token', () => {
  assert.equal(symbolForStatus('pending'), 'PENDING');
  assert.equal(symbolForStatus('in_progress'), 'DOING');
  assert.equal(symbolForStatus('completed'), 'DONE');
  assert.equal(symbolForStatus('skipped'), 'SKIPPED');
  assert.equal(symbolForStatus('failed'), 'FAILED');
});

test('symbolForStatus throws on an unknown status', () => {
  assert.throws(
    () => symbolForStatus('something-new'),
    /unhandled ProtocolStepRunStatus/,
  );
});

// ---------------------------------------------------------------------------
// C027 — no model-authored checkboxes anywhere.
// ---------------------------------------------------------------------------

test('C027: renderer NEVER emits Markdown checkboxes for an active run', () => {
  const module = makeModule();
  const run = makeRun();
  const stepRuns = [
    makeStepRun('s1', { status: 'in_progress' }),
  ];
  const out = renderTracker(run, stepRuns, module);
  assert.ok(!out.includes('- [ ]'), `unexpected open checkbox:\n${out}`);
  assert.ok(!out.includes('- [x]'), `unexpected checked checkbox:\n${out}`);
  assert.ok(!out.includes('[ ]'), `unexpected bare open checkbox:\n${out}`);
});

test('C027: renderer NEVER emits checkboxes for a completed run', () => {
  const module = makeModule();
  const run = makeRun({ status: 'completed', currentStep: null, completedAt: '2026-07-29T01:00:00.000Z' });
  const stepRuns = [
    makeStepRun('s1', { status: 'completed', completedAt: '2026-07-29T00:30:00.000Z' }),
    makeStepRun('s2', { status: 'completed', completedAt: '2026-07-29T01:00:00.000Z' }),
  ];
  const out = renderTracker(run, stepRuns, module);
  assert.ok(!out.includes('- [ ]'), `unexpected open checkbox:\n${out}`);
  assert.ok(!out.includes('- [x]'), `unexpected checked checkbox:\n${out}`);
});

test('C027: step symbols use fixed tokens, not checkboxes', () => {
  const module = makeModule();
  const run = makeRun();
  const stepRuns = [
    makeStepRun('s1', { status: 'in_progress' }),
    makeStepRun('s2', { status: 'pending', attempt: 1 }),
  ];
  const out = renderTracker(run, stepRuns, module);
  // The symbol appears in a bracketed heading, e.g. "### [DOING] s1".
  assert.match(out, /### \[DOING\] s1/);
  assert.match(out, /### \[PENDING\] s2/);
});

// ---------------------------------------------------------------------------
// Determinism.
// ---------------------------------------------------------------------------

test('determinism: same inputs produce byte-identical output', () => {
  const module = makeModule();
  const run = makeRun();
  const stepRuns = [
    makeStepRun('s1', { status: 'completed' }),
    makeStepRun('s2', { status: 'in_progress', attempt: 1 }),
  ];
  const a = renderTracker(run, stepRuns, module);
  const b = renderTracker(run, [...stepRuns].reverse(), module);
  assert.equal(a, b, 'reordering input stepRuns must not change output');
});

test('determinism: steps render in declaration order, not input order', () => {
  const module = makeModule();
  const run = makeRun({ currentStep: 's2' });
  // Pass s2 first; output must still show s1 before s2.
  const stepRuns = [
    makeStepRun('s2', { status: 'in_progress', attempt: 1 }),
    makeStepRun('s1', { status: 'completed', attempt: 1 }),
  ];
  const out = renderTracker(run, stepRuns, module);
  const s1Pos = out.indexOf('### [DONE] s1');
  const s2Pos = out.indexOf('### [DOING] s2');
  assert.ok(s1Pos > -1 && s2Pos > -1, 'both step headings must be present');
  assert.ok(s1Pos < s2Pos, `s1 must precede s2; got s1@${s1Pos} s2@${s2Pos}`);
});

// ---------------------------------------------------------------------------
// Latest-attempt-wins projection.
// ---------------------------------------------------------------------------

test('projection: highest attempt with progressed status wins', () => {
  const module = makeModule();
  const run = makeRun({ attempt: 3, currentStep: 's1' });
  // Three attempts on s1: attempt 1 failed, attempt 2 in_progress (stale),
  // attempt 3 in_progress (current). Attempt 3 (in_progress) outranks
  // attempt 1 (failed) only because rankStepRun weights all sealed states
  // equally and ties break on attempt. We expect attempt 3 to be shown.
  const stepRuns = [
    makeStepRun('s1', { attempt: 1, status: 'failed' }),
    makeStepRun('s1', { attempt: 2, status: 'in_progress' }),
    makeStepRun('s1', { attempt: 3, status: 'in_progress' }),
  ];
  const out = renderTracker(run, stepRuns, module);
  assert.match(out, /### \[DOING\] s1 \(attempt 3\)/, `expected attempt 3, got:\n${out}`);
});

test('projection: completed attempt beats failed lower attempt on tie-break', () => {
  const module = makeModule();
  const run = makeRun({ attempt: 2, currentStep: 's1' });
  const stepRuns = [
    makeStepRun('s1', { attempt: 1, status: 'failed' }),
    makeStepRun('s1', { attempt: 2, status: 'completed' }),
  ];
  const out = renderTracker(run, stepRuns, module);
  // Both failed and completed are rank 3; tie broken by attempt: 2 wins.
  assert.match(out, /### \[DONE\] s1 \(attempt 2\)/);
});

test('projection: step with no attempts renders PENDING', () => {
  const module = makeModule();
  const run = makeRun({ currentStep: 's1' });
  const out = renderTracker(run, [], module);
  assert.match(out, /### \[PENDING\] s1/);
  assert.match(out, /### \[PENDING\] s2/);
});

// ---------------------------------------------------------------------------
// Header block.
// ---------------------------------------------------------------------------

test('header: emits run identity and status', () => {
  const module = makeModule();
  const run = makeRun({ nodeRunId: 99 });
  const out = renderTracker(run, [], module);
  assert.match(out, /# Protocol Tracker — p-linear@1\.0\.0/);
  assert.match(out, /- protocol_run_id: `42`/);
  assert.match(out, /- process_run_id: `7`/);
  assert.match(out, /- node_run_id: `99`/);
  assert.match(out, /- node_protocol_id: `p-linear`/);
  assert.match(out, /- current_step: `s1`/);
  assert.match(out, /- current_attempt: `1`/);
  assert.match(out, /- run_status: `active`/);
});

test('header: node_run_id renders (none) when null', () => {
  const module = makeModule();
  const run = makeRun({ nodeRunId: null });
  const out = renderTracker(run, [], module);
  assert.match(out, /- node_run_id: \(none\)/);
});

test('header: current_step renders (not started) when null', () => {
  const module = makeModule();
  const run = makeRun({ currentStep: null });
  const out = renderTracker(run, [], module);
  assert.match(out, /- current_step: \(not started\)/);
});

test('header: completed_at only emitted when run completed', () => {
  const module = makeModule();
  const active = renderTracker(makeRun(), [], module);
  assert.ok(!active.includes('completed_at:'));
  const completed = renderTracker(
    makeRun({ status: 'completed', completedAt: '2026-07-29T01:00:00.000Z', currentStep: null }),
    [],
    module,
  );
  assert.match(completed, /- completed_at: `2026-07-29T01:00:00\.000Z`/);
});

// ---------------------------------------------------------------------------
// Evidence summary (computed, not authored).
// ---------------------------------------------------------------------------

test('evidence: (no attempts yet) when step has no step-run', () => {
  const module = makeModule();
  const out = renderTracker(makeRun(), [], module);
  assert.match(out, /- evidence: \(no attempts yet\)/);
});

test('evidence: shows satisfied when all required attached', () => {
  const module = makeModule();
  const run = makeRun();
  const stepRuns = [
    makeStepRun('s1', {
      status: 'completed',
      evidence: [{ category: 'tool-receipt', contractRef: 'c.s1.v1', value: 'rec-1' }],
    }),
  ];
  const out = renderTracker(run, stepRuns, module);
  assert.match(out, /- evidence: 1 attached, 1 required \(satisfied; tool-receipt=1\)/);
});

test('evidence: shows missing contract when required not attached', () => {
  const module = makeModule();
  const run = makeRun();
  const stepRuns = [
    makeStepRun('s1', { status: 'in_progress', evidence: [] }),
  ];
  const out = renderTracker(run, stepRuns, module);
  assert.match(out, /- evidence: 0 attached, 1 required \(missing: tool-receipt:c\.s1\.v1\)/);
});

test('evidence: zero-required step shows 0 required', () => {
  const module = makeModule();
  const run = makeRun({ currentStep: 's2' });
  // s2 has 1 required + 1 optional; make it zero-required for this test.
  const zeroRequiredModule = makeModule({
    steps: [
      module.steps[0],
      {
        id: 's2',
        instructions: 'Do step 2',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [
          { category: 'tool-receipt', contractRef: 'c.s2.tool.v1', required: false },
        ],
      },
    ],
  });
  const stepRuns = [
    makeStepRun('s2', {
      status: 'in_progress',
      evidence: [{ category: 'tool-receipt', contractRef: 'c.s2.tool.v1', value: 'rec' }],
    }),
  ];
  const out = renderTracker(run, stepRuns, zeroRequiredModule);
  assert.match(out, /- evidence: 1 attached, 0 required/);
});

test('evidence: option emitEvidenceSummary:false suppresses evidence lines', () => {
  const module = makeModule();
  const run = makeRun();
  const out = renderTracker(run, [], module, { emitEvidenceSummary: false });
  assert.ok(!out.includes('- evidence:'), `unexpected evidence line:\n${out}`);
});

test('evidence: option emitRunHeader:false suppresses header', () => {
  const module = makeModule();
  const run = makeRun();
  const out = renderTracker(run, [], module, { emitRunHeader: false });
  assert.ok(!out.startsWith('# Protocol Tracker'), `unexpected header:\n${out}`);
  assert.ok(!out.includes('- protocol_run_id:'));
  // Step section still present.
  assert.match(out, /## Step Progress/);
});

// ---------------------------------------------------------------------------
// Recovery entry steps.
// ---------------------------------------------------------------------------

test('recovery: entry steps render in a separate block', () => {
  const module = makeModule({
    recoveryEntrySteps: ['r1'],
    steps: [
      ...makeModule().steps,
      {
        id: 'r1',
        instructions: 'Repair step',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
    ],
  });
  const run = makeRun({ currentStep: 's1' });
  const out = renderTracker(run, [], module);
  assert.match(out, /## Recovery Entry Steps/);
  assert.match(out, /- \[PENDING\] r1 — recovery entry/);
});

test('recovery: no block when module declares none', () => {
  const module = makeModule();
  const out = renderTracker(makeRun(), [], module);
  assert.ok(!out.includes('Recovery Entry Steps'), 'unexpected recovery block');
});

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

test('validation: rejects stepRun from a different protocolRunId', () => {
  const module = makeModule();
  const run = makeRun();
  const foreignStepRun = makeStepRun('s1', { protocolRunId: 999 });
  assert.throws(
    () => renderTracker(run, [foreignStepRun], module),
    /belongs to run 999, not 42/,
  );
});

test('validation: rejects empty nodeProtocolId', () => {
  const module = makeModule();
  const run = makeRun({ nodeProtocolId: '' });
  assert.throws(
    () => renderTracker(run, [], module),
    /nodeProtocolId must be non-empty/,
  );
});

// ---------------------------------------------------------------------------
// Class wrapper parity.
// ---------------------------------------------------------------------------

test('TrackerRenderer class delegates to the free function identically', () => {
  const module = makeModule();
  const run = makeRun();
  const stepRuns = [makeStepRun('s1', { status: 'in_progress' })];
  const renderer = new TrackerRenderer();
  const a = renderTracker(run, stepRuns, module);
  const b = renderer.renderTracker(run, stepRuns, module);
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// All five statuses render.
// ---------------------------------------------------------------------------

test('statuses: every ProtocolStepRunStatus symbol appears for one step each', () => {
  // Build a 5-step module where each step ends in a different status.
  const module = makeModule({
    steps: [
      { id: 'a', instructions: 'a', resources: [], allowedTools: [], evidenceRequirements: [] },
      { id: 'b', instructions: 'b', resources: [], allowedTools: [], evidenceRequirements: [] },
      { id: 'c', instructions: 'c', resources: [], allowedTools: [], evidenceRequirements: [] },
      { id: 'd', instructions: 'd', resources: [], allowedTools: [], evidenceRequirements: [] },
      { id: 'e', instructions: 'e', resources: [], allowedTools: [], evidenceRequirements: [] },
    ],
    transitions: [],
    recoveryEntrySteps: [],
  });
  const run = makeRun({ currentStep: 'a' });
  const stepRuns = [
    makeStepRun('a', { status: 'pending' }),
    makeStepRun('b', { status: 'in_progress' }),
    makeStepRun('c', { status: 'completed' }),
    makeStepRun('d', { status: 'skipped' }),
    makeStepRun('e', { status: 'failed' }),
  ];
  const out = renderTracker(run, stepRuns, module);
  assert.match(out, /### \[PENDING\] a/);
  assert.match(out, /### \[DOING\] b/);
  assert.match(out, /### \[DONE\] c/);
  assert.match(out, /### \[SKIPPED\] d/);
  assert.match(out, /### \[FAILED\] e/);
});
