import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const {
  ExactCandidateAcceptanceRejected,
} = await import(
  '../../dist/process-modules/application/exact-candidate-acceptance.js'
);
const { KernelHandlerRegistry } = await import(
  '../../dist/process-modules/application/kernel-handler-registry.js'
);
const { KernelNodeExecutor } = await import(
  '../../dist/process-modules/application/node-executors/kernel-node-executor.js'
);
const { NodeExecutionError } = await import(
  '../../dist/process-modules/application/node-executor.js'
);
const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { SqliteNodeRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

const HASH = 'a'.repeat(64);

function directive() {
  return {
    command: {
      idempotencyKey: 'run:1:gate:verify:candidates:a',
      lineage: {
        processRunId: 1,
        moduleRef: 'test-module@1.0.0',
        nodeId: 'produce',
        intentId: 2,
        taskId: 3,
        executionId: 'producer-execution',
        projectId: 4,
        epicId: 5,
      },
      candidates: [{
        artifactId: 6,
        artifactType: 'SRS',
        contentHash: HASH,
      }],
      requireApprovedReview: true,
      authority: 'test-gate@1',
      reasonCode: 'TEST_VALID',
      context: { semanticProductionHash: HASH },
    },
    rejection: {
      event: 'acceptance-blocked',
      policyId: 'repair-contract',
      disposition: 'repair',
      summary: 'Exact contract commit failed',
      acceptanceCriteria: ['candidate is reviewed and exact'],
      allowedChanges: ['artifact:6'],
      subjectRefs: [{
        kind: 'artifact',
        ref: 'artifact:6',
        schema: 'SRS',
        contentHash: HASH,
      }],
    },
  };
}

function handlerResult() {
  return {
    event: 'completed',
    production: {
      schema: 'test.contract.v1',
      artifactRef: 'contract:6',
      contentHash: HASH,
      bindings: { artifactIds: [6] },
    },
    exactCandidateAcceptance: directive(),
  };
}

function context() {
  return {
    projectId: 4,
    epicId: 5,
    processRunId: 1,
    module: {
      identity: {
        name: 'test-module',
        version: '1.0.0',
        kind: 'test',
        displayName: 'Test',
        description: 'Test',
      },
    },
    node: {
      id: 'verify',
      label: 'Verify',
      kind: 'kernel',
      description: 'Verify',
      handler: 'verify-handler',
    },
    input: {},
    frame: { runInput: {}, productions: {}, receipts: {} },
    heartbeat() {},
    initiatedBy: 'test',
  };
}

function executor(acceptance) {
  const registry = new KernelHandlerRegistry();
  registry.register('verify-handler', () => handlerResult());
  return new KernelNodeExecutor(registry, acceptance);
}

function decision(command) {
  return {
    schemaVersion: 'saga3.exact-candidate-acceptance.v2',
    decisionId: 9,
    idempotencyKey: command.idempotencyKey,
    requestHash: 'b'.repeat(64),
    candidateSetHash: 'c'.repeat(64),
    decisionHash: 'd'.repeat(64),
    lineage: command.lineage,
    requireApprovedReview: true,
    producerCompletionReceiptCommandId: 'producer:approved',
    producerCompletionReceiptHash: 'f'.repeat(64),
    approvedReviewReceiptCommandId: 'review:approved',
    approvedReviewReceiptHash: 'e'.repeat(64),
    authority: command.authority,
    reasonCode: command.reasonCode,
    items: [],
    decidedAt: '2026-01-01T00:00:00.000Z',
    replayed: false,
  };
}

test('kernel executor commits a directive and returns durable decision evidence', async () => {
  const calls = [];
  const acceptance = {
    accept(command) {
      calls.push(command);
      return decision(command);
    },
    findByIdempotencyKey() {
      return null;
    },
    isAcceptedExact() {
      return true;
    },
  };
  const result = await executor(acceptance).execute(context());
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].context, {
    semanticProductionHash: HASH,
    gateNodeId: 'verify',
    semanticProductionRef: 'contract:6',
  });
  assert.equal(result.domainEvent, 'completed');
  assert.deepEqual(result.acceptanceReceipt, {
    schemaVersion: 'saga3.exact-candidate-acceptance.v2',
    decisionRef: 'exact-acceptance:9',
    decisionHash: 'd'.repeat(64),
    candidateSetHash: 'c'.repeat(64),
    idempotencyKey: 'run:1:gate:verify:candidates:a',
    replayed: false,
  });
});

test('kernel executor refuses a valid command for another ProcessRun', async () => {
  const acceptance = {
    accept() {
      assert.fail('cross-run command must be rejected before the port call');
    },
    findByIdempotencyKey() {
      return null;
    },
    isAcceptedExact() {
      return false;
    },
  };
  const registry = new KernelHandlerRegistry();
  registry.register('verify-handler', () => {
    const returned = handlerResult();
    returned.exactCandidateAcceptance.command.lineage = {
      ...returned.exactCandidateAcceptance.command.lineage,
      processRunId: 99,
    };
    return returned;
  });
  await assert.rejects(
    new KernelNodeExecutor(registry, acceptance).execute(context()),
    error =>
      error instanceof NodeExecutionError
      && /not bound to the current execution/.test(error.message),
  );
});

test('repairable gate rejection becomes opaque recovery feedback', async () => {
  const acceptance = {
    accept() {
      throw new ExactCandidateAcceptanceRejected(
        'EXACT_ACCEPTANCE_ARTIFACT_HASH_DRIFT',
        'candidate changed',
        { artifactId: 6 },
      );
    },
    findByIdempotencyKey() {
      return null;
    },
    isAcceptedExact() {
      return false;
    },
  };
  const result = await executor(acceptance).execute(context());
  assert.equal(result.domainEvent, 'acceptance-blocked');
  assert.equal(result.acceptanceReceipt, undefined);
  assert.equal(
    result.recoveryIssue.reasonCode,
    'EXACT_ACCEPTANCE_ARTIFACT_HASH_DRIFT',
  );
  assert.equal(result.recoveryIssue.policyId, 'repair-contract');
  assert.deepEqual(result.recoveryIssue.subjectRefs, directive().rejection.subjectRefs);
  assert.deepEqual(
    result.recoveryIssue.context.candidateSet,
    directive().command.candidates,
  );
});

test('missing review is escalated to a human instead of redoing valid author work', async () => {
  const acceptance = {
    accept() {
      throw new ExactCandidateAcceptanceRejected(
        'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED',
        'review is not complete',
        { taskId: 3 },
      );
    },
    findByIdempotencyKey() {
      return null;
    },
    isAcceptedExact() {
      return false;
    },
  };
  const result = await executor(acceptance).execute(context());
  assert.equal(result.domainEvent, 'acceptance-blocked');
  assert.equal(result.recoveryIssue.disposition, 'human');
  assert.equal(
    result.recoveryIssue.reasonCode,
    'EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED',
  );
});

test('lineage/configuration rejection fails closed instead of dispatching repair', async () => {
  const acceptance = {
    accept() {
      throw new ExactCandidateAcceptanceRejected(
        'EXACT_ACCEPTANCE_LINEAGE_MISMATCH',
        'wrong ProcessRun',
      );
    },
    findByIdempotencyKey() {
      return null;
    },
    isAcceptedExact() {
      return false;
    },
  };
  await assert.rejects(
    executor(acceptance).execute(context()),
    error =>
      error instanceof NodeExecutionError
      && error.cause?.code === 'EXACT_ACCEPTANCE_LINEAGE_MISMATCH',
  );
});

test('a directive without a configured acceptance port fails fast', async () => {
  await assert.rejects(
    executor(undefined).execute(context()),
    /no ExactCandidateAcceptance port is configured/,
  );
});

test('NodeRun persists the exact acceptance receipt across restart', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-node-acceptance-'));
  process.env.DB_PATH = path.join(temp, 'node-run.db');
  try {
    const db = getDb();
    db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'E')`).run();
    const payload = { test: true };
    const { record: processRun } = new SqliteProcessRunRepository(db).start({
      moduleRef: { name: 'test-module', version: '1.0.0' },
      executorKind: 'generic-flow',
      input: {
        schema: 'test.input.v1',
        payload,
        contentHash: sha256Hex(payload),
      },
      projectedStage: 'test',
      invocationContext: {
        projectId: 1,
        epicId: 1,
        initiatedBy: 'test',
        idempotencyKey: 'node-acceptance-run',
      },
    });
    const repository = new SqliteNodeRunRepository(db);
    const started = repository.start({
      processRunId: processRun.id,
      nodeId: 'verify',
      nodeKind: 'kernel',
    });
    const receipt = {
      schemaVersion: 'saga3.exact-candidate-acceptance.v2',
      decisionRef: 'exact-acceptance:9',
      decisionHash: 'd'.repeat(64),
      candidateSetHash: 'c'.repeat(64),
      idempotencyKey: 'run:1:gate:verify:candidates:a',
      replayed: false,
    };
    repository.complete({
      id: started.id,
      event: 'domain.completed',
      outputRef: 'contract:6',
      outputSchema: 'test.contract.v1',
      outputHash: HASH,
      acceptanceReceipt: receipt,
    });
    assert.deepEqual(
      new SqliteNodeRunRepository(db).readLatest(processRun.id, 'verify')
        .acceptanceReceipt,
      receipt,
    );
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});
