import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const {
  RECOVERY_FEEDBACK_SCHEMA,
  RECOVERY_ISSUE_SCHEMA,
} = await import('../../dist/process-modules/domain/recovery.js');
const {
  GenericFlowExecutor,
  RecoveryFatalError,
  ProcessRunPausedError,
} = await import(
  '../../dist/process-modules/application/generic-flow-executor.js'
);
const { SqliteNodeRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteProcessOutcomeCertificateRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js'
);
const { SqliteRecoveryCaseRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js'
);
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-feedback-recovery-'));
  process.env.DB_PATH = path.join(temp, 'feedback-recovery.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (70,1,'Recovery')`).run();
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function syntheticModule({
  maxAttempts = 2,
  onExhausted = 'pause',
} = {}) {
  return {
    identity: {
      name: 'feedback-recovery-test',
      version: '1.0.0',
      kind: 'synthetic',
      displayName: 'Feedback recovery test',
      description: 'A module-neutral fixture for the semantic repair loop.',
    },
    inputContract: { id: 'synthetic.recovery-input.v1' },
    outputContract: { id: 'synthetic.recovery-output.v1' },
    outcomes: [
      { code: 'accepted', description: 'The repaired result passed.', terminal: true },
    ],
    flow: {
      id: 'synthetic.feedback-recovery',
      version: '1.0.0',
      entryNodeId: 'author-result',
      nodes: [
        {
          id: 'author-result',
          label: 'Author result',
          kind: 'lm',
          description: 'Creates or repairs the same result.',
          executionProfile: 'author',
        },
        {
          id: 'verify-result',
          label: 'Verify result',
          kind: 'kernel',
          description: 'Applies a module-owned policy.',
          handler: 'synthetic-verifier',
        },
        {
          id: 'complete',
          label: 'Complete',
          kind: 'kernel',
          description: 'Completes the synthetic module.',
          handler: 'synthetic-complete',
          emitsOutcome: 'accepted',
        },
      ],
      transitions: [
        { from: 'author-result', to: 'verify-result', on: 'runtime.completed' },
        { from: 'verify-result', to: 'complete', on: 'domain.accepted' },
        { from: 'verify-result', to: 'author-result', on: 'domain.needs-repair' },
      ],
      recovery: [
        {
          id: 'repair-invalid-result',
          verifyNodeId: 'verify-result',
          repairNodeId: 'author-result',
          triggerEvents: ['domain.needs-repair'],
          resolvedEvents: ['domain.accepted'],
          maxAttempts,
          onExhausted,
        },
      ],
      terminalNodeIds: ['complete'],
    },
    artifacts: [],
    policies: [],
    invariants: [],
    executionProfiles: [
      {
        id: 'author',
        workIntentKind: 'synthetic.author',
        workIntentSchema: { id: 'synthetic.author-intent.v1' },
        taskKind: 'synthetic.author',
        executionSkill: 'synthetic-author',
        protocolSkill: 'process-module-worker',
        semanticSkill: 'synthetic-author',
        executionMode: 'workspace',
        allowedTools: [],
        trackerTemplate: null,
        workspaceTemplates: [],
        callTemplates: [],
        checklists: [],
        outputSchema: { id: 'synthetic.authored-result.v1' },
        retryPolicy: { maxAttempts: 2, retryOn: [], backoff: 'none' },
        recoveryPolicy: {
          resumeFromCheckpoint: true,
          reuseWorkIntent: false,
          reuseAcceptedOutput: false,
          onExhausted: 'pause',
        },
      },
    ],
  };
}

function issue(reasonCode) {
  return {
    schemaVersion: RECOVERY_ISSUE_SCHEMA,
    policyId: 'repair-invalid-result',
    disposition: 'repair',
    reasonCode,
    summary: 'The authored result does not satisfy its contract.',
    findings: [
      {
        code: 'TRACE_MISSING',
        severity: 'error',
        message: 'Requirement R-1 has no exact implementation trace.',
        path: '$.traces.R-1',
        expected: 'one exact implementation reference',
        actual: null,
      },
    ],
    subjectRefs: [
      {
        kind: 'artifact',
        ref: 'artifact:synthetic:7',
        contentHash: 'before-repair-hash',
      },
    ],
    acceptanceCriteria: [
      'R-1 has one exact implementation trace.',
      'The authored artifact hash matches the verified snapshot.',
    ],
    allowedChanges: ['artifact:synthetic:7'],
    context: {
      gate: 'verify-result',
      contractVersion: 'v1',
    },
  };
}

function sourceProduction(reasonCode) {
  return {
    schema: 'synthetic.invalid-result.v1',
    artifactRef: 'artifact:synthetic:7',
    contentHash: 'before-repair-hash',
    bindings: {
      reasonCode,
      artifactId: 7,
      sourceExecutionId: 'execution-1',
    },
  };
}

function startRun(processRunRepo, module, idempotencyKey) {
  const inputPayload = {
    projectId: 1,
    epicId: 70,
    objective: 'author a contract-compliant result',
  };
  const inputHash = sha256Hex(inputPayload);
  const { record } = processRunRepo.start({
    moduleRef: module.identity,
    input: {
      schema: module.inputContract.id,
      payload: inputPayload,
      contentHash: inputHash,
    },
    executorKind: 'generic-flow',
    projectedStage: 'synthetic',
    invocationContext: {
      projectId: 1,
      epicId: 70,
      initiatedBy: 'feedback-recovery-test',
      idempotencyKey,
    },
  });
  return { record, inputPayload, inputHash };
}

function executionContext(started) {
  return {
    projectId: 1,
    epicId: 70,
    processRunId: started.record.id,
    inputPayload: started.inputPayload,
    inputHash: started.inputHash,
    initiatedBy: 'feedback-recovery-test',
  };
}

function buildHarness(db, module, {
  reasonCode = 'SYNTHETIC_CONTRACT_BROKEN',
  alwaysReject = false,
  disposition = 'repair',
} = {}) {
  const processRunRepo = new SqliteProcessRunRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);
  const recoveryCaseRepo = new SqliteRecoveryCaseRepository(db);
  const calls = {
    author: [],
    verifier: [],
  };
  const emittedIssue = { ...issue(reasonCode), disposition };
  const rejectedProduction = sourceProduction(reasonCode);
  let rejectEveryVerification = alwaysReject;

  const nodeExecutors = new Map([
    ['lm', {
      kind: 'lm',
      async execute(ctx) {
        calls.author.push(ctx);
        const call = calls.author.length;
        return {
          runtimeEvent: 'completed',
          receipt: {
            kind: 'task-execution',
            executorKind: 'lm',
            intentId: 100 + call,
            taskId: 200 + call,
            executionId: `author-execution-${call}`,
            runtimeStatus: 'completed',
            replayed: false,
          },
        };
      },
    }],
    ['kernel', {
      kind: 'kernel',
      async execute(ctx) {
        if (ctx.node.id === 'complete') {
          // WAVE 8 HIGH 3 — terminal completion is mandatory. The recovery
          // feedback tests exercise the verify→repair loop, not the
          // certificate channel; emit a minimal certificate-free completion.
          return {
            runtimeEvent: 'completed',
            domainEvent: 'outcome:accepted',
            completion: {
              outcome: 'accepted',
              terminal: true,
              outputEnvelope: { outcome: 'accepted', productions: [] },
            },
          };
        }
        calls.verifier.push(ctx);
        const reject = rejectEveryVerification || calls.verifier.length === 1;
        if (reject) {
          return {
            runtimeEvent: 'completed',
            domainEvent: 'needs-repair',
            production: rejectedProduction,
            recoveryIssue: emittedIssue,
          };
        }
        return {
          runtimeEvent: 'completed',
          domainEvent: 'accepted',
          production: {
            schema: 'synthetic.valid-result.v1',
            artifactRef: 'artifact:synthetic:7',
            contentHash: 'after-repair-hash',
            bindings: { artifactId: 7, verified: true },
          },
        };
      },
    }],
  ]);

  const executor = new GenericFlowExecutor({
    moduleRef: module.identity,
    processRunRepo,
    nodeRunRepo,
    recoveryCaseRepo,
    certificateRepo: new SqliteProcessOutcomeCertificateRepository(db),
    nodeExecutors,
  });

  return {
    calls,
    emittedIssue,
    executor,
    nodeRunRepo,
    processRunRepo,
    recoveryCaseRepo,
    rejectedProduction,
    setAlwaysReject(value) {
      rejectEveryVerification = value;
    },
  };
}

test('a recovery issue routes back to the same LM node with exact durable feedback', async () => {
  const fx = fixture();
  try {
    const module = syntheticModule();
    const harness = buildHarness(fx.db, module);
    const started = startRun(
      harness.processRunRepo,
      module,
      'feedback-success',
    );

    const result = await harness.executor.execute(
      module,
      executionContext(started),
    );

    assert.equal(result.outcome, 'accepted');
    assert.equal(harness.calls.author.length, 2);
    assert.equal(harness.calls.verifier.length, 2);

    const feedbackProduction = harness.calls.author[1].input;
    assert.equal(feedbackProduction.schema, RECOVERY_FEEDBACK_SCHEMA);
    assert.match(
      feedbackProduction.artifactRef,
      /^recovery-case:\d+:attempt:1$/,
    );
    const feedback = feedbackProduction.bindings.recoveryFeedback;
    assert.equal(feedback.schemaVersion, RECOVERY_FEEDBACK_SCHEMA);
    assert.equal(feedback.processRunId, started.record.id);
    assert.equal(feedback.moduleRef.name, module.identity.name);
    assert.equal(feedback.moduleRef.version, module.identity.version);
    assert.equal(feedback.verifyNodeId, 'verify-result');
    assert.equal(feedback.repairNodeId, 'author-result');
    assert.equal(feedback.attempt, 1);
    assert.equal(feedback.maxAttempts, 2);
    assert.ok(Number.isInteger(feedback.caseId) && feedback.caseId > 0);
    assert.ok(Number.isInteger(feedback.sourceNodeRunId) && feedback.sourceNodeRunId > 0);
    assert.equal(feedback.issueRef, feedbackProduction.artifactRef);
    assert.equal(feedback.issueHash, sha256Hex(harness.emittedIssue));
    assert.deepEqual(feedback.issue, harness.emittedIssue);
    assert.deepEqual(feedback.sourceProduction, harness.rejectedProduction);
    assert.equal(feedbackProduction.contentHash, sha256Hex(feedback));

    const nodeRuns = harness.nodeRunRepo.list(started.record.id);
    assert.deepEqual(
      nodeRuns.map(row => [row.nodeId, row.attempt, row.event]),
      [
        ['author-result', 1, 'runtime.completed'],
        ['verify-result', 1, 'domain.needs-repair'],
        ['author-result', 2, 'runtime.completed'],
        ['verify-result', 2, 'domain.accepted'],
        ['complete', 1, 'domain.outcome:accepted'],
      ],
    );

    const cases = harness.recoveryCaseRepo.listForProcessRun(started.record.id);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].status, 'resolved');
    assert.equal(cases[0].policyId, 'repair-invalid-result');
    assert.equal(cases[0].lastReasonCode, 'SYNTHETIC_CONTRACT_BROKEN');
    assert.equal(cases[0].attemptCount, 1);
    assert.deepEqual(
      harness.recoveryCaseRepo.listAttempts(cases[0].id).map(attempt => ({
        attempt: attempt.attempt,
        issue: attempt.issue,
        feedback: attempt.feedback,
      })),
      [{
        attempt: 1,
        issue: harness.emittedIssue,
        feedback,
      }],
    );
    assert.equal(
      harness.recoveryCaseRepo.readActive(
        started.record.id,
        'repair-invalid-result',
      ),
      null,
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('exhausting the semantic repair budget pauses at a durable checkpoint', async () => {
  const fx = fixture();
  try {
    const module = syntheticModule({ maxAttempts: 1, onExhausted: 'pause' });
    const harness = buildHarness(fx.db, module, {
      reasonCode: 'STILL_INVALID',
      alwaysReject: true,
    });
    const started = startRun(
      harness.processRunRepo,
      module,
      'feedback-exhausted',
    );

    await assert.rejects(
      harness.executor.execute(module, executionContext(started)),
      error => (
        error instanceof ProcessRunPausedError
        && error.processRunId === started.record.id
        && error.nodeId === 'verify-result'
      ),
    );

    assert.equal(harness.calls.author.length, 2);
    assert.equal(harness.calls.verifier.length, 2);
    assert.equal(harness.processRunRepo.read(started.record.id).status, 'paused');

    const nodeRuns = harness.nodeRunRepo.list(started.record.id);
    assert.deepEqual(
      nodeRuns.filter(row => row.nodeId === 'author-result').map(row => row.attempt),
      [1, 2],
    );
    assert.deepEqual(
      nodeRuns.filter(row => row.nodeId === 'verify-result').map(row => row.attempt),
      [1, 2],
    );
    assert.equal(
      harness.calls.author[1].input.bindings.recoveryFeedback.attempt,
      1,
    );

    const cases = harness.recoveryCaseRepo.listForProcessRun(started.record.id);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].status, 'exhausted');
    assert.equal(cases[0].lastReasonCode, 'STILL_INVALID');
    assert.equal(cases[0].attemptCount, 2);
    assert.deepEqual(
      harness.recoveryCaseRepo.listAttempts(cases[0].id)
        .map(attempt => attempt.attempt),
      [1, 2],
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('manual resume rechecks an exhausted verifier instead of replaying the pause', async () => {
  const fx = fixture();
  try {
    const module = syntheticModule({ maxAttempts: 1, onExhausted: 'pause' });
    const harness = buildHarness(fx.db, module, {
      reasonCode: 'MANUAL_FIX_REQUIRED',
      alwaysReject: true,
    });
    const started = startRun(
      harness.processRunRepo,
      module,
      'feedback-manual-resume',
    );
    await assert.rejects(
      harness.executor.execute(module, executionContext(started)),
      error => error instanceof ProcessRunPausedError,
    );

    // Represents an operator fixing the canonical subject and explicitly
    // resuming the ProcessRun. No extra LM repair round is granted implicitly.
    harness.setAlwaysReject(false);
    harness.processRunRepo.update(started.record.id, { status: 'running' });
    const result = await harness.executor.execute(
      module,
      executionContext(started),
    );

    assert.equal(result.outcome, 'accepted');
    assert.equal(harness.calls.author.length, 2);
    assert.equal(harness.calls.verifier.length, 3);
    const cases = harness.recoveryCaseRepo.listForProcessRun(started.record.id);
    assert.equal(cases.length, 1);
    assert.equal(cases[0].status, 'resolved');
    assert.equal(
      harness.processRunRepo.read(started.record.id).activeIssue,
      null,
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('manual resume rechecks a human gate after the external decision', async () => {
  const fx = fixture();
  try {
    const module = syntheticModule();
    const harness = buildHarness(fx.db, module, {
      reasonCode: 'HUMAN_APPROVAL_REQUIRED',
      alwaysReject: true,
      disposition: 'human',
    });
    const started = startRun(
      harness.processRunRepo,
      module,
      'feedback-human-resume',
    );
    await assert.rejects(
      harness.executor.execute(module, executionContext(started)),
      error => error instanceof ProcessRunPausedError,
    );
    assert.equal(harness.calls.author.length, 1);
    assert.equal(harness.calls.verifier.length, 1);

    harness.setAlwaysReject(false);
    harness.processRunRepo.update(started.record.id, { status: 'running' });
    const result = await harness.executor.execute(
      module,
      executionContext(started),
    );

    assert.equal(result.outcome, 'accepted');
    assert.equal(harness.calls.author.length, 1);
    assert.equal(harness.calls.verifier.length, 2);
    assert.equal(
      harness.recoveryCaseRepo.listForProcessRun(started.record.id)[0].status,
      'resolved',
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('reason codes stay opaque: one runtime repairs unrelated module failures identically', async () => {
  for (const reasonCode of ['SRS_NOT_ACCEPTED', 'DEPENDENCY_GRAPH_INCOMPLETE']) {
    const fx = fixture();
    try {
      const module = syntheticModule();
      const harness = buildHarness(fx.db, module, { reasonCode });
      const started = startRun(
        harness.processRunRepo,
        module,
        `opaque-${reasonCode}`,
      );

      const result = await harness.executor.execute(
        module,
        executionContext(started),
      );

      assert.equal(result.outcome, 'accepted');
      assert.equal(harness.calls.author.length, 2);
      assert.equal(harness.calls.verifier.length, 2);
      assert.equal(
        harness.calls.author[1].input.bindings.recoveryFeedback.issue.reasonCode,
        reasonCode,
      );
      const cases = harness.recoveryCaseRepo.listForProcessRun(started.record.id);
      assert.equal(cases.length, 1);
      assert.equal(cases[0].status, 'resolved');
      assert.equal(cases[0].lastReasonCode, reasonCode);
    } finally {
      cleanup(fx.temp);
    }
  }
});

test('a fatal issue fails the run without entering the repair route', async () => {
  const fx = fixture();
  try {
    const module = syntheticModule();
    const harness = buildHarness(fx.db, module, {
      reasonCode: 'CANONICAL_STATE_CORRUPTED',
      alwaysReject: true,
      disposition: 'fatal',
    });
    const started = startRun(
      harness.processRunRepo,
      module,
      'feedback-fatal',
    );

    await assert.rejects(
      harness.executor.execute(module, executionContext(started)),
      error => (
        error instanceof RecoveryFatalError
        && error.processRunId === started.record.id
        && error.nodeId === 'verify-result'
        && error.reasonCode === 'CANONICAL_STATE_CORRUPTED'
      ),
    );

    assert.equal(harness.calls.author.length, 1);
    assert.equal(harness.calls.verifier.length, 1);
    assert.equal(harness.processRunRepo.read(started.record.id).status, 'failed');
    assert.equal(
      harness.recoveryCaseRepo.listForProcessRun(started.record.id).length,
      0,
    );
    const verifierRun = harness.nodeRunRepo.list(started.record.id)
      .find(row => row.nodeId === 'verify-result');
    assert.equal(
      verifierRun.recoveryIssue.reasonCode,
      'CANONICAL_STATE_CORRUPTED',
    );
  } finally {
    cleanup(fx.temp);
  }
});
