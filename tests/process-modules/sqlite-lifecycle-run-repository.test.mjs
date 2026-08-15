import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { SqliteLifecycleRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-lifecycle-run-repository.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-lifecycle-'));
  process.env.DB_PATH = path.join(temp, 'lifecycle.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (2,'P2','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (10,1,'E1')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (11,1,'E2')`).run();
  return {
    temp,
    db,
    lifecycleRepo: new SqliteLifecycleRunRepository(db),
    processRepo: new SqliteProcessRunRepository(db),
  };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

function startCommand({
  idempotencyKey = 'lifecycle-1',
  payload = { initiative: { subject: 'circle' } },
  definition = {
    name: 'product-delivery',
    version: '1.0.0',
    entryStage: 'discovery',
    stages: ['discovery', 'formalization'],
  },
  lifecycleVersion = '1.0.0',
  epicId = 10,
} = {}) {
  const definitionSnapshot = canonicalJson(definition);
  return {
    lifecycle: {
      name: 'product-delivery',
      version: lifecycleVersion,
      displayName: 'Product delivery',
      description: 'Durable product lifecycle',
    },
    definitionSnapshot,
    definitionHash: sha256Hex(definition),
    entryStageId: 'discovery',
    input: {
      schema: 'factory.product-initiative.v1',
      payload,
      contentHash: sha256Hex(payload),
    },
    invocationContext: {
      projectId: 1,
      epicId,
      initiatedBy: 'operator',
      idempotencyKey,
    },
  };
}

function acquire(repo, lifecycleRunId, owner = 'driver-a') {
  const lease = repo.acquireExecutionLease(
    lifecycleRunId,
    owner,
    '2026-07-26T00:00:00.000Z',
    '2099-01-01T00:00:00.000Z',
  );
  assert.ok(lease);
  return lease;
}

function stageCommand(lifecycleRunId, {
  stageId = 'discovery',
  moduleName = 'product-discovery',
  moduleVersion = '3.0.0',
  payload = { subject: 'circle' },
} = {}) {
  const binding = {
    stageId,
    module: `${moduleName}@${moduleVersion}`,
    inputMapping: { subject: '$.initiative.subject' },
  };
  return {
    lifecycleRunId,
    stageId,
    moduleRef: { name: moduleName, version: moduleVersion },
    bindingSnapshot: canonicalJson(binding),
    bindingHash: sha256Hex(binding),
    inputSchema: `factory.${stageId}-case.v1`,
    inputPayload: payload,
    inputHash: sha256Hex(payload),
  };
}

function startProcess(processRepo, stage, {
  idempotencyKey = `stage-${stage.stageId}`,
  payload = stage.inputPayload,
  moduleRef = stage.moduleRef,
  epicId = 10,
} = {}) {
  return processRepo.start({
    moduleRef,
    executorKind: 'generic-flow',
    projectedStage: null,
    input: {
      schema: stage.inputSchema,
      payload,
      contentHash: sha256Hex(payload),
    },
    invocationContext: {
      projectId: 1,
      epicId,
      initiatedBy: 'lifecycle',
      idempotencyKey,
    },
  }).record;
}

function completeProcess(processRepo, processRunId) {
  processRepo.update(processRunId, { status: 'running' });
  const output = {
    schema: 'factory.discovery-output.v1',
    artifactRef: 'artifact:discovery:1',
    contentHash: sha256Hex({ decision: 'advance' }),
  };
  const certificate = {
    schema: 'factory.discovery-certificate.v1',
    certificateRef: 'certificate:discovery:1',
    certificateHash: sha256Hex({ outcome: 'advance' }),
  };
  processRepo.update(processRunId, {
    status: 'completed',
    localOutcome: 'advance',
    authority: 'product-discovery@3.0.0',
    output,
    certificate,
  });
  return { output, certificate };
}

function resultSnapshot(output, certificate) {
  return {
    code: 'advance',
    outcome: 'advance',
    authority: 'product-discovery@3.0.0',
    output,
    certificate,
    outputRef: output.artifactRef,
    outputHash: output.contentHash,
    outputSchema: output.schema,
    certificateRef: certificate.certificateRef,
    certificateHash: certificate.certificateHash,
    certificateSchema: certificate.schema,
    error: null,
  };
}

test('start replay pins exact definition, input, and invocation context', () => {
  const fx = fixture();
  try {
    const command = startCommand();
    const first = fx.lifecycleRepo.start(command);
    const replay = fx.lifecycleRepo.start(command);

    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.id, first.record.id);
    assert.equal(replay.record.definitionSnapshot, canonicalJson(JSON.parse(command.definitionSnapshot)));
    assert.equal(replay.record.inputSnapshot, canonicalJson(command.input.payload));

    const changedInput = startCommand({
      payload: { initiative: { subject: 'ellipse' } },
    });
    assert.throws(
      () => fx.lifecycleRepo.start(changedInput),
      /LIFECYCLE_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT/,
    );

    const changedDefinition = startCommand({
      definition: {
        name: 'product-delivery',
        version: '1.0.0',
        entryStage: 'discovery',
        stages: ['discovery', 'formalization', 'development'],
      },
    });
    assert.throws(
      () => fx.lifecycleRepo.start(changedDefinition),
      /LIFECYCLE_DEFINITION_CHANGED_FOR_REPLAY/,
    );

    assert.throws(
      () => fx.lifecycleRepo.start(startCommand({ epicId: 11 })),
      /LIFECYCLE_REPLAY_CONTEXT_MISMATCH/,
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('only one active lifecycle owns a project/epic/name scope', () => {
  const fx = fixture();
  try {
    const first = fx.lifecycleRepo.start(startCommand()).record;
    assert.throws(
      () => fx.lifecycleRepo.start(startCommand({
        idempotencyKey: 'another-key',
        lifecycleVersion: '2.0.0',
      })),
      /LIFECYCLE_SCOPE_ALREADY_ACTIVE/,
    );

    const cancelled = fx.lifecycleRepo.cancel(first.id, first.version, 'superseded');
    assert.equal(cancelled.status, 'cancelled');
    const replacement = fx.lifecycleRepo.start(startCommand({
      idempotencyKey: 'another-key',
      lifecycleVersion: '2.0.0',
    }));
    assert.equal(replacement.replayed, false);
    assert.notEqual(replacement.record.id, first.id);
  } finally {
    cleanup(fx.temp);
  }
});

test('leases use monotonic fencing and deny stale drivers after takeover', () => {
  const fx = fixture();
  try {
    const run = fx.lifecycleRepo.start(startCommand()).record;
    const first = acquire(fx.lifecycleRepo, run.id, 'driver-a');
    assert.equal(first.fence, 1);
    assert.equal(
      fx.lifecycleRepo.acquireExecutionLease(
        run.id,
        'driver-b',
        '2027-01-01T00:00:00.000Z',
        '2099-01-02T00:00:00.000Z',
      ),
      null,
    );

    const takeover = fx.lifecycleRepo.acquireExecutionLease(
      run.id,
      'driver-b',
      '2100-01-01T00:00:00.000Z',
      '2101-01-01T00:00:00.000Z',
    );
    assert.ok(takeover);
    assert.equal(takeover.fence, 2);

    const stage = stageCommand(run.id);
    assert.throws(
      () => fx.lifecycleRepo.ensureStageRun(stage, first),
      /LIFECYCLE_LEASE_LOST/,
    );
    const ensured = fx.lifecycleRepo.ensureStageRun(stage, takeover);
    assert.equal(ensured.record.stageId, 'discovery');
  } finally {
    cleanup(fx.temp);
  }
});

test('stage replay and ProcessRun binding require the exact module, scope, and input', () => {
  const fx = fixture();
  try {
    const run = fx.lifecycleRepo.start(startCommand()).record;
    const lease = acquire(fx.lifecycleRepo, run.id);
    const command = stageCommand(run.id);
    const first = fx.lifecycleRepo.ensureStageRun(command, lease);
    const replay = fx.lifecycleRepo.ensureStageRun(command, lease);
    assert.equal(replay.replayed, true);
    assert.equal(replay.record.id, first.record.id);

    assert.throws(
      () => fx.lifecycleRepo.ensureStageRun({
        ...command,
        inputPayload: { subject: 'ellipse' },
        inputHash: sha256Hex({ subject: 'ellipse' }),
      }, lease),
      /LIFECYCLE_STAGE_REPLAY_BINDING_MISMATCH/,
    );

    const wrong = startProcess(fx.processRepo, command, {
      idempotencyKey: 'wrong-input',
      payload: { subject: 'ellipse' },
    });
    assert.throws(
      () => fx.lifecycleRepo.bindProcessRun(run.id, first.record.id, wrong.id, lease),
      /LIFECYCLE_PROCESS_RUN_BINDING_MISMATCH/,
    );

    const exact = startProcess(fx.processRepo, command);
    const bound = fx.lifecycleRepo.bindProcessRun(run.id, first.record.id, exact.id, lease);
    assert.equal(bound.processRunId, exact.id);
    assert.equal(
      fx.lifecycleRepo.bindProcessRun(run.id, first.record.id, exact.id, lease).processRunId,
      exact.id,
    );

    const anotherExact = startProcess(fx.processRepo, command, {
      idempotencyKey: 'second-exact',
    });
    assert.throws(
      () => fx.lifecycleRepo.bindProcessRun(run.id, first.record.id, anotherExact.id, lease),
      /LIFECYCLE_STAGE_ALREADY_BOUND_TO_ANOTHER_PROCESS_RUN/,
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('completeStage atomically persists transition, next StageRun, cursor, and exact replay', () => {
  const fx = fixture();
  try {
    const run = fx.lifecycleRepo.start(startCommand()).record;
    const lease = acquire(fx.lifecycleRepo, run.id);
    const currentCommand = stageCommand(run.id);
    const current = fx.lifecycleRepo.ensureStageRun(currentCommand, lease).record;
    const process = startProcess(fx.processRepo, currentCommand);
    fx.lifecycleRepo.bindProcessRun(run.id, current.id, process.id, lease);
    fx.lifecycleRepo.markStageRunning(run.id, current.id, lease);
    const { output, certificate } = completeProcess(fx.processRepo, process.id);

    const next = stageCommand(run.id, {
      stageId: 'formalization',
      moduleName: 'solution-formalization',
      moduleVersion: '1.0.0',
      payload: {
        discoveryCertificateRef: certificate.certificateRef,
        discoveryCertificateHash: certificate.certificateHash,
      },
    });
    const target = { type: 'stage', stageId: 'formalization' };
    const handoffSnapshot = {
      discovery: {
        outputRef: output.artifactRef,
        certificateRef: certificate.certificateRef,
      },
    };
    const handoffHash = sha256Hex(handoffSnapshot);
    const command = {
      lifecycleRunId: run.id,
      stageRunId: current.id,
      expectedStageId: 'discovery',
      transitionKey: `lifecycle:${run.id}:stage:${current.id}`,
      outcome: 'advance',
      authority: 'product-discovery@3.0.0',
      output,
      certificate,
      resultSnapshot: resultSnapshot(output, certificate),
      mappedOutput: {
        decision: 'advance',
        certificateRef: certificate.certificateRef,
        certificateHash: certificate.certificateHash,
      },
      target,
      handoffSnapshot,
      handoffHash,
      decisionHash: sha256Hex({
        lifecycleRunId: run.id,
        stageRunId: current.id,
        outcome: 'advance',
        target,
        handoffHash,
      }),
      nextStage: {
        stageId: next.stageId,
        moduleRef: next.moduleRef,
        bindingSnapshot: next.bindingSnapshot,
        bindingHash: next.bindingHash,
        inputSchema: next.inputSchema,
        inputPayload: next.inputPayload,
        inputHash: next.inputHash,
      },
    };

    const completed = fx.lifecycleRepo.completeStage(command, lease);
    assert.equal(completed.replayed, false);
    assert.equal(completed.stageRun.status, 'completed');
    assert.equal(completed.transition.toStageRunId > 0, true);
    assert.deepEqual(completed.transition.target, target);
    assert.equal(completed.lifecycleRun.currentStageId, 'formalization');
    assert.equal(completed.lifecycleRun.currentStageRunId, completed.transition.toStageRunId);

    const stages = fx.lifecycleRepo.listStageRuns(run.id);
    assert.equal(stages.length, 2);
    assert.equal(stages[1].id, completed.transition.toStageRunId);
    assert.equal(stages[1].ordinal, 2);
    assert.equal(stages[1].inputHash, next.inputHash);
    assert.equal(fx.lifecycleRepo.readCurrentStageRun(run.id).id, stages[1].id);
    assert.equal(
      fx.db.prepare(
        'SELECT COUNT(*) AS n FROM factory_process_transitions WHERE lifecycle_run_id=?',
      ).get(run.id).n,
      1,
    );

    const replay = fx.lifecycleRepo.completeStage(command, { owner: 'stale', fence: 0 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.transition.id, completed.transition.id);
    assert.equal(fx.lifecycleRepo.listStageRuns(run.id).length, 2);

    const changedHandoff = { discovery: { outputRef: 'artifact:changed' } };
    const changedHandoffHash = sha256Hex(changedHandoff);
    assert.throws(
      () => fx.lifecycleRepo.completeStage({
        ...command,
        handoffSnapshot: changedHandoff,
        handoffHash: changedHandoffHash,
        decisionHash: sha256Hex({
          lifecycleRunId: run.id,
          stageRunId: current.id,
          outcome: 'advance',
          target,
          handoffHash: changedHandoffHash,
        }),
      }, lease),
      /LIFECYCLE_TRANSITION_KEY_REUSED_WITH_DIFFERENT_DECISION/,
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('paused runs require explicit resume; recoverable scan excludes pause and cancel', () => {
  const fx = fixture();
  try {
    const run = fx.lifecycleRepo.start(startCommand()).record;
    const lease = acquire(fx.lifecycleRepo, run.id);
    const stage = fx.lifecycleRepo.ensureStageRun(stageCommand(run.id), lease).record;
    const paused = fx.lifecycleRepo.pauseStage(run.id, stage.id, 'operator input', lease);
    assert.equal(paused.status, 'paused');
    assert.equal(
      fx.lifecycleRepo.acquireExecutionLease(
        run.id,
        'driver-b',
        '2100-01-01T00:00:00.000Z',
        '2101-01-01T00:00:00.000Z',
      ),
      null,
    );
    assert.equal(
      fx.lifecycleRepo.listRecoverable('2200-01-01T00:00:00.000Z')
        .some(candidate => candidate.id === run.id),
      false,
    );

    assert.throws(
      () => fx.lifecycleRepo.resume(run.id, paused.version - 1),
      /LIFECYCLE_RESUME_CONFLICT/,
    );
    const resumed = fx.lifecycleRepo.resume(run.id, paused.version);
    assert.equal(resumed.status, 'running');
    const resumedLease = acquire(fx.lifecycleRepo, run.id, 'driver-b');
    assert.equal(resumedLease.fence > lease.fence, true);

    fx.lifecycleRepo.releaseExecutionLease(run.id, resumedLease);
    assert.equal(
      fx.lifecycleRepo.listRecoverable('2200-01-01T00:00:00.000Z')
        .some(candidate => candidate.id === run.id),
      true,
    );
    const beforeCancel = fx.lifecycleRepo.read(run.id);
    const cancelled = fx.lifecycleRepo.cancel(run.id, beforeCancel.version, 'stopped');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(fx.lifecycleRepo.readCurrentStageRun(run.id).status, 'cancelled');
    assert.equal(
      fx.lifecycleRepo.listRecoverable('2200-01-01T00:00:00.000Z')
        .some(candidate => candidate.id === run.id),
      false,
    );
    assert.equal(
      fx.lifecycleRepo.cancel(run.id, cancelled.version, 'again').version,
      cancelled.version,
    );
  } finally {
    cleanup(fx.temp);
  }
});

test('cancel atomically fences the exact ProcessRun bound to the current StageRun', () => {
  const fx = fixture();
  try {
    const run = fx.lifecycleRepo.start(startCommand({
      idempotencyKey: 'cancel-bound-process',
    })).record;
    const lease = acquire(fx.lifecycleRepo, run.id);
    const command = stageCommand(run.id);
    const stage = fx.lifecycleRepo.ensureStageRun(command, lease).record;
    const process = startProcess(fx.processRepo, command, {
      idempotencyKey: 'cancel-bound-process-stage',
    });
    fx.processRepo.update(process.id, { status: 'running' });
    fx.lifecycleRepo.bindProcessRun(run.id, stage.id, process.id, lease);
    fx.lifecycleRepo.markStageRunning(run.id, stage.id, lease);

    const current = fx.lifecycleRepo.read(run.id);
    const cancelled = fx.lifecycleRepo.cancel(
      run.id,
      current.version,
      'operator cancelled lifecycle',
    );

    assert.equal(cancelled.status, 'cancelled');
    assert.equal(fx.lifecycleRepo.readCurrentStageRun(run.id).status, 'cancelled');
    assert.equal(fx.processRepo.read(process.id).status, 'cancelled');
    assert.equal(fx.processRepo.read(process.id).error, 'operator cancelled lifecycle');
    assert.equal(
      fx.processRepo.acquireExecutionLease(
        process.id,
        'stale-worker',
        '2026-07-26T00:00:00.000Z',
        '2099-01-01T00:00:00.000Z',
      ),
      false,
    );
  } finally {
    cleanup(fx.temp);
  }
});
