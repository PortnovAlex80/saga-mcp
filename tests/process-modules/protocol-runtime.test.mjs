// W4-A2 — ProtocolRuntime state machine tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md
// Task: docs/refactor-management/05-subagent-tasks/W04-a2.md
//
// These tests exercise the pure transition state machine using an in-memory
// fake ProtocolRunRepository. No DB, no modules — just the state machine.
// W4-A7 will add cross-module integration tests; W4-A1 will provide the
// SQLite adapter. This file owns the state-machine contract.

import assert from 'node:assert/strict';
import test from 'node:test';

const {
  ProtocolRuntime,
  ProtocolRuntimeError,
  checkStepEvidence,
} = await import('../../dist/process-modules/application/protocol-runtime.js');

// ---------------------------------------------------------------------------
// In-memory fake ProtocolRunRepository.
// ---------------------------------------------------------------------------

function makeFakeRepo() {
  let runCounter = 100;
  let stepCounter = 200;
  const runs = new Map();
  const steps = new Map(); // key: `${runId}:${stepId}:${attempt}`

  function key(runId, stepId, attempt) {
    return `${runId}:${stepId}:${attempt}`;
  }

  function seedRun(overrides = {}) {
    const id = ++runCounter;
    const now = '2026-01-01T00:00:00.000Z';
    const run = {
      id,
      processRunId: 1,
      nodeRunId: null,
      nodeProtocolId: 'test-protocol',
      nodeProtocolVersion: '1.0.0',
      entryStep: 's1',
      currentStep: null,
      status: 'active',
      attempt: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      ...overrides,
    };
    runs.set(id, run);
    return run;
  }

  return {
    runs,
    steps,
    seedRun,
    read(runId) {
      const r = runs.get(runId);
      return r ? { ...r } : null;
    },
    transition(runId, input) {
      const r = runs.get(runId);
      if (!r) throw new Error(`RUN_NOT_FOUND ${runId}`);
      if (input.status !== undefined) r.status = input.status;
      if (input.currentStep !== undefined) r.currentStep = input.currentStep;
      if (input.attempt !== undefined) r.attempt = input.attempt;
      if (input.completedAt !== undefined) r.completedAt = input.completedAt;
      r.updatedAt = '2026-01-02T00:00:00.000Z';
      return { ...r };
    },
    upsertStep(runId, stepId, attempt, input) {
      const k = key(runId, stepId, attempt);
      let s = steps.get(k);
      if (!s) {
        s = {
          id: ++stepCounter,
          protocolRunId: runId,
          stepId,
          attempt,
          status: input.status,
          evidence: input.evidence ?? [],
          completedAt: input.completedAt ?? null,
          createdAt: '2026-01-01T00:00:00.000Z',
        };
      } else {
        s.status = input.status;
        if (input.evidence !== undefined) s.evidence = [...input.evidence];
        if (input.completedAt !== undefined) s.completedAt = input.completedAt;
      }
      steps.set(k, s);
      return { ...s, evidence: [...s.evidence] };
    },
    readStep(runId, stepId, attempt) {
      const s = steps.get(key(runId, stepId, attempt));
      return s ? { ...s, evidence: [...s.evidence] } : null;
    },
    listStepAttempts(runId, stepId) {
      const out = [];
      for (const s of steps.values()) {
        if (s.protocolRunId === runId && s.stepId === stepId) out.push({ ...s, evidence: [...s.evidence] });
      }
      out.sort((a, b) => a.attempt - b.attempt);
      return out;
    },
    listSteps(runId) {
      const out = [];
      for (const s of steps.values()) {
        if (s.protocolRunId === runId) out.push({ ...s, evidence: [...s.evidence] });
      }
      out.sort((a, b) => a.id - b.id);
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Protocol definitions (NodeProtocolDefinition shapes — pure data).
// ---------------------------------------------------------------------------

function linearProtocol() {
  return {
    id: 'p-linear',
    version: '1.0.0',
    owningFlowNodeId: 'n1',
    entryStep: 's1',
    steps: [
      {
        id: 's1',
        instructions: 'do s1',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [
          { category: 'tool-receipt', contractRef: 'c.s1.v1', required: true },
        ],
      },
      {
        id: 's2',
        instructions: 'do s2',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [
          { category: 'artifact-reference', contractRef: 'c.s2.v1', required: true },
        ],
      },
    ],
    transitions: [{ from: 's1', to: 's2', kind: 'linear' }],
    nodeCompletionEvidence: [],
    recoveryEntrySteps: [],
    retrySemantics: 'runtime-implemented-linear',
  };
}

function terminalProtocol() {
  // s1 has NO outgoing transition → completing it ends the run.
  return {
    id: 'p-terminal',
    version: '1.0.0',
    owningFlowNodeId: 'n1',
    entryStep: 's1',
    steps: [
      {
        id: 's1',
        instructions: 'do s1',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
    ],
    transitions: [],
    nodeCompletionEvidence: [],
    recoveryEntrySteps: [],
    retrySemantics: 'runtime-implemented-linear',
  };
}

function repeatProtocol() {
  return {
    id: 'p-repeat',
    version: '1.0.0',
    owningFlowNodeId: 'n1',
    entryStep: 's1',
    steps: [
      {
        id: 's1',
        instructions: 'do s1',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
      {
        id: 's2',
        instructions: 'do s2',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
    ],
    // s1 loops to itself (repeat), then a linear exit to s2.
    transitions: [
      { from: 's1', to: 's1', kind: 'repeat' },
    ],
    nodeCompletionEvidence: [],
    recoveryEntrySteps: [],
    retrySemantics: 'runtime-implemented-linear',
  };
}

function recoveryProtocol() {
  return {
    id: 'p-recovery',
    version: '1.0.0',
    owningFlowNodeId: 'n1',
    entryStep: 's1',
    steps: [
      {
        id: 's1',
        instructions: 'do s1',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
      {
        id: 'r1',
        instructions: 'repair',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
    ],
    transitions: [],
    nodeCompletionEvidence: [],
    recoveryEntrySteps: ['r1'],
    retrySemantics: 'runtime-implemented-linear',
  };
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

function makeRuntime() {
  const repo = makeFakeRepo();
  let clock = 0;
  const rt = new ProtocolRuntime({
    repository: repo,
    now: () => `2026-01-01T00:00:${String(clock++).padStart(2, '0')}.000Z`,
  });
  return { repo, rt };
}

function evidenceOf(category, contractRef, value = 'v') {
  return { category, contractRef, value };
}

test('startStep: opens the entry step on a fresh run and pins the cursor', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: null });
  const res = rt.startStep(linearProtocol(), run.id);
  assert.equal(res.ok, true);
  assert.equal(res.step.stepId, 's1');
  assert.equal(res.step.attempt, 1);
  assert.equal(res.step.status, 'in_progress');
  // Cursor was pinned to the entry step.
  assert.equal(res.run.currentStep, 's1');
});

test('startStep: is idempotent on an already in_progress step attempt', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  const first = rt.startStep(linearProtocol(), run.id);
  const second = rt.startStep(linearProtocol(), run.id);
  assert.equal(second.step.id, first.step.id);
  assert.equal(second.step.status, 'in_progress');
});

test('startStep: refuses on a paused run with RUN_PAUSED', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', status: 'paused' });
  assert.throws(
    () => rt.startStep(linearProtocol(), run.id),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'RUN_PAUSED',
  );
});

test('startStep: refuses on a terminal run with RUN_TERMINAL', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', status: 'completed' });
  assert.throws(
    () => rt.startStep(linearProtocol(), run.id),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'RUN_TERMINAL',
  );
});

test('startStep: refuses on a missing run with RUN_NOT_FOUND', () => {
  const { rt } = makeRuntime();
  assert.throws(
    () => rt.startStep(linearProtocol(), 99999),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'RUN_NOT_FOUND',
  );
});

test('checkEvidence: returns missing required requirements', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(linearProtocol(), run.id);
  const check = rt.checkEvidence(linearProtocol(), run.id);
  assert.equal(check.satisfied, false);
  assert.equal(check.missing.length, 1);
  assert.equal(check.missing[0].category, 'tool-receipt');
});

test('checkEvidence: satisfied when required evidence is attached via upsertStep', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(linearProtocol(), run.id);
  repo.upsertStep(run.id, 's1', 1, {
    status: 'in_progress',
    evidence: [evidenceOf('tool-receipt', 'c.s1.v1')],
  });
  const check = rt.checkEvidence(linearProtocol(), run.id);
  assert.equal(check.satisfied, true);
  assert.equal(check.missing.length, 0);
});

test('checkStepEvidence (pure helper): optional requirements never block', () => {
  const step = {
    id: 's',
    instructions: '',
    resources: [],
    allowedTools: [],
    evidenceRequirements: [
      { category: 'tool-receipt', contractRef: 'c.v1', required: false },
    ],
  };
  const check = checkStepEvidence(step, []);
  assert.equal(check.satisfied, true);
});

test('completeStep: refuses when required evidence is missing (C026)', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(linearProtocol(), run.id);
  assert.throws(
    () => rt.completeStep(linearProtocol(), run.id),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'EVIDENCE_REQUIRED_MISSING',
  );
  // Run did NOT advance.
  assert.equal(repo.read(run.id).currentStep, 's1');
});

test('completeStep: accepts evidence inline and advances the cursor (linear)', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(linearProtocol(), run.id);
  const res = rt.completeStep(linearProtocol(), run.id, [
    evidenceOf('tool-receipt', 'c.s1.v1'),
  ]);
  assert.equal(res.run.currentStep, 's2');
  assert.equal(res.run.attempt, 1);
  assert.equal(res.step.status, 'completed');
});

test('completeStep: terminal step (no outgoing transition) completes the run', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(terminalProtocol(), run.id);
  const res = rt.completeStep(terminalProtocol(), run.id);
  assert.equal(res.run.status, 'completed');
  assert.equal(res.run.completedAt !== null, true);
});

test('completeStep: refuses when step is not in_progress', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  // Did NOT call startStep → no in_progress step run.
  assert.throws(
    () => rt.completeStep(linearProtocol(), run.id, [
      evidenceOf('tool-receipt', 'c.s1.v1'),
    ]),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'STEP_NOT_IN_PROGRESS',
  );
});

test('completeStep: refuses when step is already completed', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(linearProtocol(), run.id);
  rt.completeStep(linearProtocol(), run.id, [evidenceOf('tool-receipt', 'c.s1.v1')]);
  // Now the cursor is on s2; rewinding the cursor back to s1 (simulating a
  // manual edit) and trying to complete s1 attempt 1 again should fail.
  repo.transition(run.id, { currentStep: 's1', attempt: 1 });
  assert.throws(
    () => rt.startStep(linearProtocol(), run.id),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'STEP_ALREADY_COMPLETED',
  );
});

test('retryStep: bumps attempt and reopens the current step', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(linearProtocol(), run.id);
  const res = rt.retryStep(linearProtocol(), run.id);
  assert.equal(res.run.attempt, 2);
  assert.equal(res.step.attempt, 2);
  assert.equal(res.step.status, 'in_progress');
});

test('retryStep: respects maxAttempts and refuses with ATTEMPT_EXHAUSTED', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', attempt: 3 });
  assert.throws(
    () => rt.retryStep(linearProtocol(), run.id, { maxAttempts: 3 }),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'ATTEMPT_EXHAUSTED',
  );
});

test('pauseProtocol: moves active → paused, preserves cursor+attempt', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', attempt: 2 });
  const res = rt.pauseProtocol(linearProtocol(), run.id);
  assert.equal(res.run.status, 'paused');
  assert.equal(res.run.currentStep, 's1');
  assert.equal(res.run.attempt, 2);
});

test('pauseProtocol: idempotent on an already-paused run', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', status: 'paused' });
  const res = rt.pauseProtocol(linearProtocol(), run.id);
  assert.equal(res.run.status, 'paused');
});

test('pauseProtocol: refuses on a terminal run', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', status: 'completed' });
  assert.throws(
    () => rt.pauseProtocol(linearProtocol(), run.id),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'RUN_TERMINAL',
  );
});

test('resumeProtocol: paused → active and reopens the recorded step', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', attempt: 2, status: 'paused' });
  const res = rt.resumeProtocol(linearProtocol(), run.id);
  assert.equal(res.run.status, 'active');
  assert.equal(res.run.currentStep, 's1');
  assert.equal(res.run.attempt, 2);
  assert.equal(res.step.stepId, 's1');
  assert.equal(res.step.attempt, 2);
  assert.equal(res.step.status, 'in_progress');
});

test('resumeProtocol: refuses on an active run (RUN_NOT_PAUSED)', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', status: 'active' });
  assert.throws(
    () => rt.resumeProtocol(linearProtocol(), run.id),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'RUN_NOT_PAUSED',
  );
});

test('crash-resume: protocol resumes at exact last incomplete step (§0.7.11)', () => {
  // Simulate: start s1, pause, "crash" (drop runtime), resume in a fresh
  // runtime, complete s1 with evidence, advance to s2.
  const { repo, rt: rt1 } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: null });
  rt1.startStep(linearProtocol(), run.id); // pins cursor to s1
  rt1.pauseProtocol(linearProtocol(), run.id);

  // New runtime instance (simulates a restart that re-reads durable state).
  const rt2 = new ProtocolRuntime({ repository: repo });
  const resumed = rt2.resumeProtocol(linearProtocol(), run.id);
  assert.equal(resumed.run.currentStep, 's1');
  assert.equal(resumed.step.stepId, 's1');
  // Now complete s1.
  const completed = rt2.completeStep(linearProtocol(), run.id, [
    evidenceOf('tool-receipt', 'c.s1.v1'),
  ]);
  assert.equal(completed.run.currentStep, 's2');
});

test('handleRecovery: retry-current-node bumps attempt', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(linearProtocol(), run.id);
  const res = rt.handleRecovery(linearProtocol(), run.id, 'retry-current-node');
  assert.equal(res.run.attempt, 2);
  assert.equal(res.step.status, 'in_progress');
});

test('handleRecovery: enter-recovery-node jumps to a declared recovery entry', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  const res = rt.handleRecovery(recoveryProtocol(), run.id, 'enter-recovery-node');
  assert.equal(res.run.currentStep, 'r1');
  assert.equal(res.run.attempt, 1);
  assert.equal(res.step.stepId, 'r1');
});

test('handleRecovery: enter-recovery-node refuses unknown recovery step', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  assert.throws(
    () => rt.handleRecovery(recoveryProtocol(), run.id, 'enter-recovery-node', {
      recoveryStep: 's1', // s1 exists but is NOT a recoveryEntryStep
    }),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'RECOVERY_ENTRY_UNKNOWN',
  );
});

test('handleRecovery: enter-recovery-node refuses when no recovery entry declared', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  assert.throws(
    () => rt.handleRecovery(linearProtocol(), run.id, 'enter-recovery-node'),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'RECOVERY_ENTRY_UNKNOWN',
  );
});

test('handleRecovery: request-human pauses the run', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  const res = rt.handleRecovery(linearProtocol(), run.id, 'request-human');
  assert.equal(res.run.status, 'paused');
});

test('handleRecovery: pause-external pauses the run', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  const res = rt.handleRecovery(linearProtocol(), run.id, 'pause-external');
  assert.equal(res.run.status, 'paused');
});

test('handleRecovery: return-to-producer pauses (routing deferred to executor)', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  const res = rt.handleRecovery(linearProtocol(), run.id, 'return-to-producer');
  assert.equal(res.run.status, 'paused');
});

test('handleRecovery: escalate abandons the run', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  const res = rt.handleRecovery(linearProtocol(), run.id, 'escalate');
  assert.equal(res.run.status, 'abandoned');
  assert.equal(res.run.completedAt !== null, true);
});

test('handleRecovery: terminate fails the run', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  const res = rt.handleRecovery(linearProtocol(), run.id, 'terminate');
  assert.equal(res.run.status, 'failed');
  assert.equal(res.run.completedAt !== null, true);
});

test('handleRecovery: refuses on a terminal run', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', status: 'completed' });
  assert.throws(
    () => rt.handleRecovery(linearProtocol(), run.id, 'terminate'),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'RUN_TERMINAL',
  );
});

test('handleRecovery: enter-recovery-node resumes from paused first', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1', status: 'paused' });
  const res = rt.handleRecovery(recoveryProtocol(), run.id, 'enter-recovery-node', {
    recoveryStep: 'r1',
  });
  assert.equal(res.run.status, 'active');
  assert.equal(res.run.currentStep, 'r1');
});

test('repeat transition: completing s1 (loop to itself) keeps cursor on s1', () => {
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(repeatProtocol(), run.id);
  const res = rt.completeStep(repeatProtocol(), run.id);
  // Repeat-to-self: cursor does not advance; attempt unchanged.
  assert.equal(res.run.currentStep, 's1');
  assert.equal(res.run.attempt, 1);
});

test('illegal multi-target branch: refuses at runtime (Wave 1 ratchet forbids conditions)', () => {
  // Use no-evidence steps so the evidence gate does not fire first; we want
  // to reach the transition resolver to prove it rejects the branch.
  const branchyProtocol = {
    id: 'p-branch',
    version: '1.0.0',
    owningFlowNodeId: 'n1',
    entryStep: 's1',
    steps: [
      { id: 's1', instructions: '', resources: [], allowedTools: [], evidenceRequirements: [] },
      { id: 's2', instructions: '', resources: [], allowedTools: [], evidenceRequirements: [] },
    ],
    transitions: [
      { from: 's1', to: 's2', kind: 'linear' },
      { from: 's1', to: 's1', kind: 'repeat' }, // a SECOND unconditional s1 → ... is non-deterministic
    ],
    nodeCompletionEvidence: [],
    recoveryEntrySteps: [],
    retrySemantics: 'runtime-implemented-linear',
  };
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(branchyProtocol, run.id);
  assert.throws(
    () => rt.completeStep(branchyProtocol, run.id),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'ILLEGAL_TRANSITION',
  );
});

test('all seven RecoveryActions are handled (exhaustive)', () => {
  const actions = [
    'retry-current-node',
    'return-to-producer',
    'enter-recovery-node',
    'request-human',
    'pause-external',
    'escalate',
    'terminate',
  ];
  for (const action of actions) {
    const { repo, rt } = makeRuntime();
    const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
    // Should NOT throw an ILLEGAL_RECOVERY_ACTION for any of the seven.
    const res = rt.handleRecovery(recoveryProtocol(), run.id, action);
    assert.equal(res.ok, true, `action ${action} should succeed`);
  }
});

test('required evidence CANNOT be skipped even with attached optional evidence', () => {
  const proto = {
    ...linearProtocol(),
    steps: [
      {
        id: 's1',
        instructions: '',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [
          { category: 'tool-receipt', contractRef: 'c.req.v1', required: true },
          { category: 'human-receipt', contractRef: 'c.opt.v1', required: false },
        ],
      },
      {
        id: 's2',
        instructions: '',
        resources: [],
        allowedTools: [],
        evidenceRequirements: [],
      },
    ],
  };
  const { repo, rt } = makeRuntime();
  const run = repo.seedRun({ entryStep: 's1', currentStep: 's1' });
  rt.startStep(proto, run.id);
  // Attach ONLY the optional one.
  assert.throws(
    () => rt.completeStep(proto, run.id, [evidenceOf('human-receipt', 'c.opt.v1')]),
    (e) => e instanceof ProtocolRuntimeError && e.code === 'EVIDENCE_REQUIRED_MISSING',
  );
});
