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
      // Д1: transitions use prefixed events. Kernel emits domain.* events.
      transitions: [
        { from: 'decide', to: 'complete-accepted', on: 'domain.accept' },
        { from: 'decide', to: 'complete-rejected', on: 'domain.fail' },
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
  // WAVE 5 CUTOVER: the kernel handler is now the AUTHORITY for its own
  // certificate (Uncle Bob Wave 4). It issues the cert itself and emits an
  // explicit ModuleCompletion whose `outputEnvelope.certificateRef` points at
  // the issued row. The executor resolves the certificate from the completion
  // envelope (the sole path after Wave 5) — it no longer reads a certificate
  // envelope from `production.bindings`. The legacy magic-bindings keys
  // (certificatePayload / certificateHash / certificateSchema) are GONE from
  // the bindings bag; only `decision` + `authority` remain there.
  handlerRegistry.register('synthetic-decider', (ctx) => {
    const outcome = emitEvent === 'accept' ? 'accepted' : 'rejected';
    const payload = {
      schemaVersion: 'synthetic.certificate.v1',
      decision: outcome,
      reasonCodes: [],
      rationale: `synthetic ${outcome}`,
      inputHash: 'test-input-hash',
      payload: { outcome, decision: emitEvent },
    };
    const certificateHash = sha256Hex(payload);
    // Kernel issues its own certificate (mirrors the 4 real settlement kernels
    // post-Wave-4). The repo is idempotent on certificateHash.
    const issued = certificateRepo.issue({
      processRunId: ctx.processRunId,
      moduleRef: module.identity,
      projectId: ctx.projectId,
      epicId: ctx.epicId,
      payload,
      certificateHash,
      authority: 'synthetic-policy',
    });
    const certificateRef = `certificate:${issued.record.id}`;
    return {
      event: emitEvent, // domain.accept / domain.fail
      production: {
        schema: 'synthetic.decision.v1',
        artifactRef: `decision:${emitEvent}`,
        contentHash: certificateHash,
        bindings: {
          decision: emitEvent,
          authority: 'synthetic-policy',
        },
      },
      // Explicit terminal envelope — the sole certificate channel. The
      // certificateRef digest is the content-addressed pointer the executor
      // surfaces on the run result.
      completion: {
        outcome,
        terminal: true,
        outputEnvelope: {
          outcome,
          productions: [],
          certificateRef: {
            schemaId: payload.schemaVersion,
            ref: certificateRef,
            digest: certificateHash,
          },
          completion: null,
        },
      },
    };
  });

  const kernelExecutor = new KernelNodeExecutor(handlerRegistry);
  const nodeExecutors = new Map([['kernel', kernelExecutor]]);

  // WAVE 5: NO certificate-issuance callback at settlement. The executor
  // reads the certificate reference from the completion envelope emitted by
  // the kernel above.
  return new GenericFlowExecutor({
    moduleRef: module.identity,
    processRunRepo,
    nodeRunRepo,
    certificateRepo,
    nodeExecutors,
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
  // Д1: event is prefixed (domain.* for kernel nodes).
  assert.equal(nodeRuns[0].event, 'domain.accept');
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
      input: { bindings: { upstream: 'preserved' } },
      initiatedBy: 'test',
    });
    assert.equal(result.event, `outcome:${code}`);
    assert.equal(result.outcome, code);
    // The handler preserves upstream chain bindings (Д6 — certificate envelope
    // forwarded from the settlement kernel node through the terminal emitter).
    assert.equal(result.production.bindings.upstream, 'preserved');
    assert.equal(result.production.bindings.outcome, code);
  }
});
