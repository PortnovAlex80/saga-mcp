import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteProcessOutcomeCertificateRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js'
);
const { SqliteNodeRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);
const {
  GenericFlowExecutor,
  ProcessRunBusyError,
  ProcessRunPausedError,
} = await import(
  '../../dist/process-modules/application/generic-flow-executor.js'
);
const { GenericFlowEngineAdapter } = await import(
  '../../dist/process-modules/application/generic-flow-engine-adapter.js'
);
const { LmNodeExecutor } = await import(
  '../../dist/process-modules/application/node-executors/lm-node-executor.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-gfe-recovery-'));
  process.env.DB_PATH = path.join(temp, 'recovery.db');
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

function moduleWithFlow(flow, executionProfiles = []) {
  return {
    identity: {
      name: 'recovery-test',
      version: '1.0.0',
      kind: 'recovery',
      displayName: 'Recovery Test',
      description: 'Synthetic module for runtime recovery invariants.',
    },
    inputContract: { id: 'recovery.input.v1' },
    outputContract: { id: 'recovery.output.v1' },
    outcomes: [
      { code: 'accepted', description: 'completed without a required artifact', terminal: true },
    ],
    flow,
    artifacts: [],
    policies: [],
    invariants: [],
    executionProfiles,
  };
}

function startRun(repo, module, key) {
  const inputPayload = { projectId: 1, epicId: 70, objective: 'recover exactly once' };
  const inputHash = sha256Hex(inputPayload);
  const { record } = repo.start({
    moduleRef: module.identity,
    input: {
      schema: module.inputContract.id,
      payload: inputPayload,
      contentHash: inputHash,
    },
    executorKind: 'generic-flow',
    projectedStage: 'recovery',
    invocationContext: {
      projectId: 1,
      epicId: 70,
      initiatedBy: 'recovery-test',
      idempotencyKey: key,
    },
  });
  return { record, inputPayload, inputHash };
}

function buildExecutor(db, module, nodeExecutors, options = {}) {
  const opts = {
    moduleRef: module.identity,
    processRunRepo: new SqliteProcessRunRepository(db),
    nodeRunRepo: new SqliteNodeRunRepository(db),
    certificateRepo: new SqliteProcessOutcomeCertificateRepository(db),
    nodeExecutors,
  };
  // v1 dead-path deletion — v2 wiring is now MANDATORY (the v1 frame/
  // completion path is deleted). When the caller does not supply a
  // productRepo, default to the NodeRun-row bridge (the pattern in
  // v2-production-completion-roundtrip.test.mjs) so settlement productions
  // resolve without the content-addressed product store. The bridge also
  // resolves recovery-feedback products from factory_recovery_attempts
  // (content-addressed control-plane products persisted in the recovery
  // tables). Callers that need a custom bridge still pass
  // `{ v2: { productRepo } }`.
  if (options.v2) {
    opts.v2 = { productRepo: options.v2.productRepo };
  } else {
    opts.v2 = { productRepo: buildBridgeProductRepo(db) };
  }
  return new GenericFlowExecutor(opts);
}

/**
 * Build the bridge productRepo for v2 wiring: resolves content-addressed
 * products from NodeRun output rows (settlement productions) AND from
 * factory_recovery_attempts (recovery-feedback control-plane products). Mirrors
 * the production assemblerProductRepo fallback in product-lifecycle-runtime.ts
 * plus the recovery-feedback table that production resolves via the same
 * exact-(schema,ref,digest) match.
 */
function buildBridgeProductRepo(db) {
  const lookupProduction = db.prepare(
    `SELECT output_schema AS schema, output_ref AS ref, output_hash AS hash,
            output_bindings AS bindingsText
       FROM factory_node_runs
      WHERE output_schema=? AND output_ref=? AND output_hash=?
        AND status='completed'
      LIMIT 1`,
  );
  // Lazy + defensive: factory_recovery_attempts only exists when a
  // SqliteRecoveryCaseRepository was constructed (its migration creates the
  // table). Tests that never exercise recovery would otherwise throw
  // SQLITE_ERROR at prepare time. We prepare on first use and tolerate a
  // missing table by treating it as "no recovery-feedback product found".
  let lookupRecoveryFeedback = null;
  const getRecoveryFeedbackLookup = () => {
    if (lookupRecoveryFeedback === null) {
      try {
        lookupRecoveryFeedback = db.prepare(
          `SELECT issue_ref AS ref, feedback_hash AS hash, feedback_snapshot AS snapshot
             FROM factory_recovery_attempts
            WHERE issue_ref=? AND feedback_hash=?
            LIMIT 1`,
        );
      } catch {
        lookupRecoveryFeedback = false;
      }
    }
    return lookupRecoveryFeedback || null;
  };
  return {
    getByProductRef(ref) {
      const nr = lookupProduction.get(ref.schemaId, ref.ref, ref.digest);
      if (nr !== undefined && nr.schema !== null && nr.ref !== null && nr.hash !== null) {
        const bindings = nr.bindingsText ? JSON.parse(nr.bindingsText) : {};
        return {
          productRef: { schemaId: nr.schema, ref: nr.ref, digest: nr.hash },
          payload: { schema: nr.schema, artifactRef: nr.ref, contentHash: nr.hash, bindings },
        };
      }
      const feedbackLookup = getRecoveryFeedbackLookup();
      if (feedbackLookup) {
        const rf = feedbackLookup.get(ref.ref, ref.digest);
        if (rf !== undefined && rf.ref !== null && rf.hash !== null) {
          const feedback = JSON.parse(rf.snapshot);
          return {
            productRef: { schemaId: ref.schemaId, ref: rf.ref, digest: rf.hash },
            payload: {
              schema: ref.schemaId,
              artifactRef: rf.ref,
              contentHash: rf.hash,
              bindings: { recoveryFeedback: feedback },
            },
          };
        }
      }
      return null;
    },
  };
}

function executionContext(started) {
  return {
    projectId: 1,
    epicId: 70,
    processRunId: started.record.id,
    inputPayload: started.inputPayload,
    inputHash: started.inputHash,
    initiatedBy: 'recovery-test',
  };
}

/**
 * WAVE 8 HIGH 3 — terminal completion is MANDATORY. These recovery tests
 * exercise the runtime pause/lease/resume mechanics, not the certificate
 * channel; their synthetic kernel executors emit the minimal terminal
 * completion (no certificateRef) so the executor's SETTLEMENT_COMPLETION_MISSING
 * guard does not trip. The completion is intentionally certificate-free — the
 * tests assert on lease/across-restart invariants, never on `result.certificate`.
 */
function terminalCompletion(outcome = 'accepted') {
  return {
    outcome,
    terminal: true,
    outputEnvelope: { outcome, productions: [] },
  };
}

test('ProcessRun lease rejects a concurrent driver before a second node dispatch', async () => {
  const ctx = fixture();
  try {
    const module = moduleWithFlow({
      id: 'lease.flow',
      version: '1',
      entryNodeId: 'complete',
      nodes: [{
        id: 'complete',
        label: 'Complete',
        kind: 'kernel',
        description: '',
        emitsOutcome: 'accepted',
      }],
      transitions: [],
      terminalNodeIds: ['complete'],
    });
    const repo = new SqliteProcessRunRepository(ctx.db);
    const started = startRun(repo, module, 'lease');
    let dispatches = 0;
    let entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const executor = buildExecutor(ctx.db, module, new Map([
      ['kernel', {
        kind: 'kernel',
        async execute() {
          dispatches += 1;
          entered();
          await gate;
          return { runtimeEvent: 'completed', completion: terminalCompletion() };
        },
      }],
    ]));

    const first = executor.execute(module, executionContext(started));
    await enteredPromise;
    await assert.rejects(
      executor.execute(module, executionContext(started)),
      error => error instanceof ProcessRunBusyError,
    );
    assert.equal(dispatches, 1, 'the losing driver must not dispatch the node');
    release();
    await first;
    assert.equal(repo.read(started.record.id).status, 'completed');
  } finally {
    cleanup(ctx.temp);
  }
});

test('runtime pause is a resumable checkpoint and repeats the same LM node once', async () => {
  const ctx = fixture();
  try {
    const module = moduleWithFlow({
      id: 'pause.flow',
      version: '1',
      entryNodeId: 'work',
      nodes: [
        {
          id: 'work',
          label: 'Work',
          kind: 'lm',
          description: '',
          executionProfile: 'worker',
        },
        {
          id: 'complete',
          label: 'Complete',
          kind: 'kernel',
          description: '',
          emitsOutcome: 'accepted',
        },
      ],
      transitions: [
        { from: 'work', to: 'complete', on: 'runtime.completed' },
      ],
      terminalNodeIds: ['complete'],
    }, [{
      id: 'worker',
      workIntentKind: 'test.work',
      workIntentSchema: { id: 'test.work-intent.v1' },
      taskKind: 'test.work',
      executionSkill: 'test-worker',
      semanticSkill: 'test-work',
      allowedTools: [],
      outputSchema: { id: 'test.output.v1' },
      executionMode: 'workspace',
      retryPolicy: { maxAttempts: 2 },
    }]);
    const repo = new SqliteProcessRunRepository(ctx.db);
    const nodeRepo = new SqliteNodeRunRepository(ctx.db);
    const started = startRun(repo, module, 'pause-resume');
    let lmCalls = 0;
    let terminalCalls = 0;
    const executor = buildExecutor(ctx.db, module, new Map([
      ['lm', {
        kind: 'lm',
        async execute() {
          lmCalls += 1;
          const paused = lmCalls === 1;
          return {
            runtimeEvent: paused ? 'paused' : 'completed',
            receipt: {
              kind: 'task-execution',
              executorKind: 'lm',
              intentId: 10,
              taskId: 20,
              executionId: `execution-${lmCalls}`,
              runtimeStatus: paused ? 'paused' : 'completed',
              replayed: false,
            },
          };
        },
      }],
      ['kernel', {
        kind: 'kernel',
        async execute() {
          terminalCalls += 1;
          return { runtimeEvent: 'completed', completion: terminalCompletion() };
        },
      }],
    ]));

    await assert.rejects(
      executor.execute(module, executionContext(started)),
      error => error instanceof ProcessRunPausedError,
    );
    assert.equal(repo.read(started.record.id).status, 'paused');
    assert.equal(nodeRepo.readLastCompleted(started.record.id), null);

    const result = await executor.execute(module, executionContext(started));
    assert.equal(result.outcome, 'accepted');
    assert.equal(repo.read(started.record.id).status, 'completed');
    assert.equal(lmCalls, 2);
    assert.equal(terminalCalls, 1);
    const attempts = nodeRepo.list(started.record.id);
    assert.deepEqual(
      attempts.map(run => [run.nodeId, run.attempt, run.event]),
      [
        ['work', 1, 'runtime.paused'],
        ['work', 2, 'runtime.completed'],
        ['complete', 1, 'runtime.completed'],
      ],
    );
  } finally {
    cleanup(ctx.temp);
  }
});

test('settling restart replays the durable terminal NodeRun and finalizes once', async () => {
  const ctx = fixture();
  try {
    const module = moduleWithFlow({
      id: 'settling.flow',
      version: '1',
      entryNodeId: 'complete',
      nodes: [{
        id: 'complete',
        label: 'Complete',
        kind: 'kernel',
        description: '',
        emitsOutcome: 'accepted',
      }],
      transitions: [],
      terminalNodeIds: ['complete'],
    });
    const repo = new SqliteProcessRunRepository(ctx.db);
    const nodeRepo = new SqliteNodeRunRepository(ctx.db);
    const started = startRun(repo, module, 'settling-restart');
    repo.update(started.record.id, { status: 'preparing' });
    repo.update(started.record.id, { status: 'running' });
    repo.update(started.record.id, { status: 'settling' });
    // WAVE 8 HIGH 3 — terminal completion is mandatory, so the durable
    // terminal NodeRun must carry one (via completeV2). The legacy `complete`
    // path does not write `completion`; using it here would make the resumed
    // run throw SETTLEMENT_COMPLETION_MISSING.
    const terminal = nodeRepo.startV2({
      processRunId: started.record.id,
      nodeId: 'complete',
      nodeKind: 'kernel',
    });
    nodeRepo.completeV2({
      id: terminal.id,
      event: 'runtime.completed',
      outputRef: 'terminal:accepted',
      outputSchema: 'terminal.v1',
      outputHash: 'durable-terminal-hash',
      outputBindings: { authority: 'recovery-policy' },
      completion: terminalCompletion(),
    });
    let unexpectedDispatches = 0;
    // WAVE 8 HIGH 3 — v2 wiring is required so the resume read
    // (readLastCompletedV2) surfaces the persisted `completion` column. The
    // productRepo bridge falls back to NodeRun rows for settlement productions
    // not in the content-addressed product store (mirrors
    // v2-production-completion-roundtrip.test.mjs).
    const executor = buildExecutor(ctx.db, module, new Map([
      ['kernel', {
        kind: 'kernel',
        async execute() {
          unexpectedDispatches += 1;
          throw new Error('terminal node must be replayed, not dispatched');
        },
      }],
    ]), { v2: { productRepo: buildBridgeProductRepo(ctx.db) } });

    const result = await executor.execute(module, executionContext(started));
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.authority, 'recovery-policy');
    assert.equal(unexpectedDispatches, 0);
    const finalized = repo.read(started.record.id);
    assert.equal(finalized.status, 'completed');
    assert.equal(finalized.authority, 'recovery-policy');
    assert.equal(nodeRepo.list(started.record.id).length, 1);
  } finally {
    cleanup(ctx.temp);
  }
});

test('terminal adapter replay preserves the live authority exactly', async () => {
  const ctx = fixture();
  try {
    const module = moduleWithFlow({
      id: 'authority.flow',
      version: '1',
      entryNodeId: 'complete',
      nodes: [{
        id: 'complete',
        label: 'Complete',
        kind: 'kernel',
        description: '',
        emitsOutcome: 'accepted',
      }],
      transitions: [],
      terminalNodeIds: ['complete'],
    });
    const repo = new SqliteProcessRunRepository(ctx.db);
    const executor = buildExecutor(ctx.db, module, new Map([
      ['kernel', {
        kind: 'kernel',
        async execute() {
          return {
            runtimeEvent: 'completed',
            production: {
              schema: 'terminal.v1',
              artifactRef: 'terminal:accepted',
              contentHash: 'terminal-hash',
              bindings: { authority: 'stable-policy' },
            },
            completion: terminalCompletion(),
          };
        },
      }],
    ]));
    const adapter = new GenericFlowEngineAdapter({
      moduleRef: module.identity,
      executor,
      processRunRepo: repo,
      resolveInputPayload: command => ({
        projectId: command.projectId,
        epicId: command.epicId,
        objective: 'stable replay',
      }),
      resolveIdempotencyKey: () => 'authority-replay',
      finalStage: 'recovery',
      installation: {
        id: 41,
        packageDigest: 'a'.repeat(64),
      },
    });

    const live = await adapter.run(module, { projectId: 1, epicId: 70 });
    const pinnedRun = repo.list(1, 70)[0];
    assert.equal(pinnedRun.installationId, 41);
    assert.equal(pinnedRun.packageDigest, 'a'.repeat(64));
    const replay = await adapter.run(module, { projectId: 1, epicId: 70 });
    assert.equal(live.processOutcome.authority, 'stable-policy');
    assert.equal(replay.processOutcome.authority, 'stable-policy');
    assert.equal(live.outcomeAuthority, 'stable-policy');
    assert.equal(replay.outcomeAuthority, 'stable-policy');
    assert.equal(replay.cycles, 0);
    assert.equal(replay.endedAt, repo.list(1, 70)[0].completedAt);
  } finally {
    cleanup(ctx.temp);
  }
});

test('LM active execution pauses without constructing or starting another worker', async () => {
  let factoryCalls = 0;
  let statusTransitions = 0;
  let projectedPlan = null;
  const module = moduleWithFlow({
    id: 'lm-active.flow',
    version: '1',
    entryNodeId: 'work',
    nodes: [{
      id: 'work',
      label: 'Work',
      kind: 'lm',
      description: 'work',
      executionProfile: 'worker',
    }],
    transitions: [],
    terminalNodeIds: [],
  }, [{
    id: 'worker',
    workIntentKind: 'test.work',
    workIntentSchema: { id: 'test.work-intent.v1' },
    taskKind: 'test.work',
    executionSkill: 'test-worker',
    reviewSkill: 'test-reviewer',
    semanticSkill: 'test-work',
    allowedTools: ['task_get'],
    outputSchema: { id: 'test.output.v1' },
    executionMode: 'workspace',
    retryPolicy: { maxAttempts: 2 },
  }]);
  const persistence = {
    ensureExecutionPlan(input) {
      projectedPlan = input;
      return { intentId: 10, taskId: 20, replayed: true };
    },
    createIntent() {
      throw new Error('not used');
    },
    ensureProjectedTask() {
      throw new Error('not used');
    },
    setProjectedTask() {
      throw new Error('not used');
    },
    setIntentStatus() {
      statusTransitions += 1;
      return true;
    },
    prepareIntentForExecution() {
      return { status: 'active', intentStatus: 'executing' };
    },
    readTaskState() {
      return 'in_progress';
    },
    readCurrentExecutionId() {
      return 'execution-active';
    },
    readLatestExecutionId() {
      return 'execution-old';
    },
    readTaskProjectRepositoryId() {
      return null;
    },
    transitionToInRepair() {
      return false;
    },
  };
  const executor = new LmNodeExecutor({
    persistence,
    workerExecutorFactory() {
      factoryCalls += 1;
      throw new Error('must not construct a competing worker');
    },
    resolveWorkerContext() {
      return {
        projectId: 1,
        epicId: 70,
        workspaceRoot: '.',
        dbPath: 'test.db',
        sagaEntry: 'test',
        sagaSkillRoot: 'test',
        lmStudioUrl: 'http://127.0.0.1',
      };
    },
  });
  const result = await executor.execute({
    projectId: 1,
    epicId: 70,
    processRunId: 1,
    module,
    node: module.flow.nodes[0],
    input: {
      schema: 'factory.recovery-feedback.v1',
      bindings: {
        recoveryFeedback: {
          schemaVersion: 'factory.recovery-feedback.v1',
          caseId: 9,
          attempt: 1,
          maxAttempts: 2,
          issueRef: 'recovery-issue:9',
          issueHash: 'a'.repeat(64),
          issue: {
            summary: 'remove the invalid trace',
            requiredTools: ['trace_delete'],
          },
        },
      },
    },
    frame: { runInput: {}, productions: {}, receipts: {} },
    heartbeat() {},
    initiatedBy: 'test',
  });

  assert.equal(result.runtimeEvent, 'paused');
  assert.equal(result.receipt.executionId, 'execution-active');
  assert.equal(projectedPlan.task.reviewSkill, 'test-reviewer');
  assert.deepEqual(
    projectedPlan.intent.authorityScope.allowed_tools,
    ['task_get', 'trace_delete'],
    'recovery-only capabilities must be added to the frozen attempt authority',
  );
  assert.equal(factoryCalls, 0);
  assert.equal(statusTransitions, 0);
});

test('LM done replay returns the producer fence, not the later reviewer execution', async () => {
  let factoryCalls = 0;
  const module = moduleWithFlow({
    id: 'lm-done-replay.flow',
    version: '1',
    entryNodeId: 'produce',
    nodes: [{
      id: 'produce',
      label: 'Produce',
      kind: 'lm',
      description: 'produce',
      executionProfile: 'worker',
    }],
    transitions: [],
    terminalNodeIds: [],
  }, [{
    id: 'worker',
    workIntentKind: 'test.produce',
    workIntentSchema: { id: 'test.produce-intent.v1' },
    taskKind: 'test.produce',
    executionSkill: 'test-worker',
    semanticSkill: 'test-produce',
    allowedTools: [],
    outputSchema: { id: 'test.output.v1' },
    executionMode: 'workspace',
    retryPolicy: { maxAttempts: 2 },
  }]);
  const persistence = {
    ensureExecutionPlan() {
      return { intentId: 10, taskId: 20, replayed: true };
    },
    createIntent() {
      throw new Error('not used');
    },
    ensureProjectedTask() {
      throw new Error('not used');
    },
    setProjectedTask() {},
    setIntentStatus() {
      return true;
    },
    prepareIntentForExecution() {
      return { status: 'done', intentStatus: 'executing' };
    },
    readTaskState() {
      return 'done';
    },
    readCurrentExecutionId() {
      return null;
    },
    readLatestExecutionId() {
      return 'reviewer-execution';
    },
    readLatestManagedProductionExecutionId(taskId, processRunId, nodeId) {
      assert.equal(taskId, 20);
      assert.equal(processRunId, 77);
      assert.equal(nodeId, 'produce');
      return 'producer-execution';
    },
    readTaskProjectRepositoryId() {
      return null;
    },
    transitionToInRepair() {
      return false;
    },
  };
  const executor = new LmNodeExecutor({
    persistence,
    workerExecutorFactory() {
      factoryCalls += 1;
      throw new Error('must not construct a worker on replay');
    },
    resolveWorkerContext() {
      throw new Error('must not resolve worker context on replay');
    },
  });
  const result = await executor.execute({
    projectId: 1,
    epicId: 70,
    processRunId: 77,
    module,
    node: module.flow.nodes[0],
    input: { objective: 'produce' },
    frame: { runInput: {}, productions: {}, receipts: {} },
    heartbeat() {},
    initiatedBy: 'test',
  });

  assert.equal(result.runtimeEvent, 'completed');
  assert.equal(result.receipt.executionId, 'producer-execution');
  assert.equal(result.receipt.replayed, true);
  assert.equal(factoryCalls, 0);
});
