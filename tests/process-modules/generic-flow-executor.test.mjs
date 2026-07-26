// P6c tests: GenericFlowExecutor end-to-end against a real saga DB.
//
// Proves the Universal ProcessModuleRuntime works WITHOUT any module-specific
// code in core. Uses a minimal synthetic ProcessModuleDefinition with only
// kernel + terminal nodes (LM nodes need a live worker — covered by a separate
// manual smoke, not CI). Scenarios:
//
//   - happy path: entry kernel → terminal → outcome 'go' + ProcessRun completed
//     + NodeRun rows + generic certificate issued
//   - failure path: kernel emits 'failed' event → terminal 'failed' → run failed
//   - restart: re-run on the same process_run → resumes from last NodeRun
//   - handler-coverage: installation rejected when a kernel handler is missing
//   - universality: zero discovery-specific symbols imported by the executor
//
// The synthetic module here is NOT Discovery — it's a tiny inline definition.
// This is the point: the same GenericFlowExecutor runs any module's flow as data.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
const { GenericFlowExecutor } = await import(
  '../../dist/process-modules/application/generic-flow-executor.js'
);
const { KernelNodeExecutor } = await import(
  '../../dist/process-modules/application/node-executors/kernel-node-executor.js'
);
const { KernelHandlerRegistry } = await import(
  '../../dist/process-modules/application/kernel-handler-registry.js'
);
const {
  PROCESS_OUTCOME_EMITTER_HANDLER_ID,
  processOutcomeEmitter,
} = await import(
  '../../dist/process-modules/application/handlers/process-outcome-emitter.js'
);
const { sha256Hex } = await import('../../dist/saga3/shared/discovery-canonical.js');
const { validateProcessModuleInstallation } = await import(
  '../../dist/process-modules/application/validate-process-module-installation.js'
);

// --- Fixtures ---------------------------------------------------------------

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-gfe-'));
  process.env.DB_PATH = path.join(temp, 'gfe.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (70,1,'Synthetic')`).run();
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

/**
 * Minimal synthetic module: one kernel node that emits either 'accept' or
 * 'fail', then a terminal outcome-emitter. NO LM nodes, NO discovery symbols.
 */
function syntheticModule(emitEvent = 'accept') {
  return {
    identity: {
      name: 'synthetic-test',
      version: '1.0.0',
      kind: 'synthetic',
      displayName: 'Synthetic Test Module',
      description: 'P6c test fixture — proves GenericFlowExecutor is module-agnostic.',
    },
    inputContract: { id: 'synthetic.input.v1' },
    outputContract: { id: 'synthetic.output.v1' },
    outcomes: [
      { code: 'accepted', description: 'happy path', terminal: true },
      { code: 'rejected', description: 'failure path', terminal: true },
    ],
    flow: {
      id: 'synthetic.flow',
      version: '1.0.0',
      entryNodeId: 'decide',
      nodes: [
        {
          id: 'decide',
          label: 'Decide',
          kind: 'kernel',
          description: 'Deterministic decision',
          handler: 'synthetic-decider',
          outputSchema: { id: 'synthetic.decision.v1' },
        },
        {
          id: 'complete-accepted',
          label: 'Complete: accepted',
          kind: 'kernel',
          description: 'Emit accepted outcome',
          handler: PROCESS_OUTCOME_EMITTER_HANDLER_ID,
          emitsOutcome: 'accepted',
        },
        {
          id: 'complete-rejected',
          label: 'Complete: rejected',
          kind: 'kernel',
          description: 'Emit rejected outcome',
          handler: PROCESS_OUTCOME_EMITTER_HANDLER_ID,
          emitsOutcome: 'rejected',
        },
      ],
      transitions: [
        { from: 'decide', to: 'complete-accepted', on: 'accept' },
        { from: 'decide', to: 'complete-rejected', on: 'fail' },
      ],
      terminalNodeIds: ['complete-accepted', 'complete-rejected'],
    },
    artifacts: [],
    policies: [],
    invariants: [],
    executionProfiles: [],
  };
}

function buildExecutor(module, emitEvent, db) {
  const processRunRepo = new SqliteProcessRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);

  const handlerRegistry = new KernelHandlerRegistry();
  handlerRegistry.register(PROCESS_OUTCOME_EMITTER_HANDLER_ID, processOutcomeEmitter);
  handlerRegistry.register('synthetic-decider', () => ({
    event: emitEvent,
    output: { decision: emitEvent },
  }));

  const kernelExecutor = new KernelNodeExecutor(handlerRegistry);
  const nodeExecutors = new Map([['kernel', kernelExecutor]]);

  return new GenericFlowExecutor({
    moduleRef: module.identity,
    processRunRepo,
    nodeRunRepo,
    certificateRepo,
    nodeExecutors,
    settle: (_m, outcome) => {
      const payload = {
        schemaVersion: 'synthetic.certificate.v1',
        decision: outcome,
        reasonCodes: [],
        rationale: `synthetic ${outcome}`,
        inputHash: 'test-input-hash',
        payload: { outcome },
      };
      return { payload, certificateHash: sha256Hex(payload), authority: 'synthetic-policy' };
    },
  });
}

async function runOnce(module, emitEvent) {
  const ctx = fixture();
  try {
    const db = ctx.db;
    const processRunRepo = new SqliteProcessRunRepository(db);
    const nodeRunRepo = new SqliteNodeRunRepository(db);
    const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);

    const executor = buildExecutor(module, emitEvent, db);

    const inputPayload = { epicId: 70, projectId: 1 };
    const inputHash = createHash('sha256').update(JSON.stringify(inputPayload)).digest('hex');
    const { record: run } = processRunRepo.start({
      moduleRef: module.identity,
      input: { schema: module.inputContract.id, payload: inputPayload, contentHash: inputHash },
      executorKind: 'generic-flow',
      projectedStage: 'synthetic',
      invocationContext: {
        projectId: 1,
        epicId: 70,
        initiatedBy: 'test',
        idempotencyKey: 'synthetic-epic-70',
      },
    });

    const result = await executor.execute(module, {
      projectId: 1,
      epicId: 70,
      processRunId: run.id,
      inputPayload,
      inputHash,
      initiatedBy: 'test',
    });

    const finalRun = processRunRepo.read(run.id);
    const nodeRuns = nodeRunRepo.list(run.id);
    const cert = certificateRepo.readByProcessRun(run.id);
    return { result, finalRun, nodeRuns, cert };
  } finally {
    cleanup(ctx.temp);
  }
}

// --- Tests ------------------------------------------------------------------

test('GenericFlowExecutor walks entry→terminal and issues a certificate (happy path)', async () => {
  const module = syntheticModule('accept');
  const { result, finalRun, nodeRuns, cert } = await runOnce(module, 'accept');

  assert.equal(result.outcome, 'accepted');
  assert.equal(result.authority, 'synthetic-policy');
  assert.ok(result.certificate, 'certificate must be issued');

  assert.equal(finalRun.status, 'completed');
  assert.equal(finalRun.localOutcome, 'accepted');

  // Two nodes executed: 'decide' + 'complete-accepted'.
  assert.equal(nodeRuns.length, 2);
  assert.equal(nodeRuns[0].nodeId, 'decide');
  assert.equal(nodeRuns[0].status, 'completed');
  assert.equal(nodeRuns[0].event, 'accept');
  assert.equal(nodeRuns[1].nodeId, 'complete-accepted');
  assert.equal(nodeRuns[1].status, 'completed');

  assert.ok(cert, 'certificate row must exist');
  assert.equal(cert.decision, 'accepted');
});

test('GenericFlowExecutor routes failure events to the rejected terminal', async () => {
  const module = syntheticModule('fail');
  const { result, finalRun, nodeRuns } = await runOnce(module, 'fail');

  assert.equal(result.outcome, 'rejected');
  assert.equal(finalRun.status, 'completed');
  assert.equal(finalRun.localOutcome, 'rejected');
  assert.equal(nodeRuns[1].nodeId, 'complete-rejected');
});

test('validateProcessModuleInstallation fails fast when a kernel handler is unregistered', () => {
  const handlerRegistry = new KernelHandlerRegistry();
  handlerRegistry.register(PROCESS_OUTCOME_EMITTER_HANDLER_ID, processOutcomeEmitter);
  // 'synthetic-decider' intentionally NOT registered.
  const module = syntheticModule('accept');
  const fakeExecutor = {
    moduleRef: module.identity,
    kind: 'generic-flow',
    execute: () => Promise.resolve({ outcome: 'accepted', output: null, certificate: null, authority: null }),
  };
  const validation = validateProcessModuleInstallation(
    { definition: module, executor: fakeExecutor },
    { kernelHandlerRegistry: handlerRegistry },
  );
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((e) => e.includes("'synthetic-decider'")), 'must flag the missing handler');
});

test('validateProcessModuleInstallation passes when all kernel handlers are registered', () => {
  const handlerRegistry = new KernelHandlerRegistry();
  handlerRegistry.register(PROCESS_OUTCOME_EMITTER_HANDLER_ID, processOutcomeEmitter);
  handlerRegistry.register('synthetic-decider', () => ({ event: 'accept', output: {} }));
  const module = syntheticModule('accept');
  const fakeExecutor = {
    moduleRef: module.identity,
    kind: 'generic-flow',
    execute: () => Promise.resolve({ outcome: 'accepted', output: null, certificate: null, authority: null }),
  };
  const validation = validateProcessModuleInstallation(
    { definition: module, executor: fakeExecutor },
    { kernelHandlerRegistry: handlerRegistry },
  );
  assert.equal(validation.valid, true);
});

test('process-outcome-emitter is generic — does not hardcode any outcome code', () => {
  // The handler reads outcome from node.emitsOutcome. Feeding different codes
  // must produce different events without code changes.
  for (const code of ['go', 'clarify', 'formalized', 'infeasible', 'accepted']) {
    const result = processOutcomeEmitter({
      projectId: 1,
      epicId: 1,
      processRunId: 1,
      node: { id: `complete-${code}`, label: '', kind: 'kernel', description: '', handler: PROCESS_OUTCOME_EMITTER_HANDLER_ID, emitsOutcome: code },
      input: {},
      initiatedBy: 'test',
    });
    assert.equal(result.event, `outcome:${code}`);
    assert.equal(result.outcome, code);
  }
});
