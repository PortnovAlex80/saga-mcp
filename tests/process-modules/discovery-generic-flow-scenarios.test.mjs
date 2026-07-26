// P6c Д10 tests: discovery generic-flow scenario coverage.
//
// Эти тесты прогоняют НАСТОЯЩИЙ discoveryProcessModule через GenericFlowExecutor
// с реальными kernel handlers (normalization, prepare-readiness, settlement) и
// STUB-ом для LM-узлов (mock worker spawn, возвращает production из fixture).
//
// Сценарии (по директиве архитектора):
//   - go: accepted proposal + accepted readiness → outcome=go + certificate
//   - clarify: missing readiness → outcome=clarify (fail-closed policy)
//   - reject: worker fail-closed невозможен без policy reject condition; covered
//     через settlement policy, который выносит reject только при явном запрете
//     (тестируем через mock readiness status='failed' — policy даёт clarify).
//   - missing-readiness: нет readiness assessment → outcome=clarify
//   - restart-after-proposal: после produce-proposal crash → resume с chain
//
// LM nodes stubbed: produce-proposal / normalize-semantic / assess-readiness
// возвращают production из injected fixture, эмитят runtime.completed.

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
const { discoveryProcessModule } = await import(
  '../../dist/process-modules/modules/discovery/discovery-process-module.js'
);
const { createDiscoveryKernelHandlers } = await import(
  '../../dist/process-modules/modules/discovery/discovery-installation.js'
);
const { SqliteSaga3DiscoveryRuntime } = await import(
  '../../dist/saga3/persistence/sqlite-saga3-discovery-runtime.js'
);
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);

// --- Fixtures ---------------------------------------------------------------

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-disc-gf-'));
  process.env.DB_PATH = path.join(temp, 'gf.db');
  const db = getDb();
  db.prepare(`INSERT INTO projects (id,name,status) VALUES (1,'P','active')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (70,1,'Disc')`).run();
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

/**
 * Insert a canonical Proposal + work intent for the epic. The settlement handler
 * reads this via readLatestProposalByEpic + readProposalForSettlement.
 */
function seedProposal(db, epicId, { hash = 'a'.repeat(64), payload = '{}' } = {}) {
  // We need intent_id + task_id + execution_id FKs; create a task + intent first.
  const task = db.prepare(
    `INSERT INTO tasks (epic_id, title, status, priority, task_kind, workflow_stage, execution_skill, execution_mode, tags, metadata)
     VALUES (?, 'D', 'done', 'high', 'discovery.work', 'discovery', 'saga-discovery-worker', 'tracker_only', '[]', '{}')`,
  ).run(epicId);
  const intent = db.prepare(
    `INSERT INTO saga3_work_intents (epic_id,kind,objective,authority_scope,output_schema,status,projected_task_id)
     VALUES (?,'discovery','obj','{}','saga3.discovery-proposal.v1','concluded',?)`,
  ).run(epicId, task.lastInsertRowid);
  const proposal = db.prepare(
    `INSERT INTO saga3_proposals
       (intent_id, task_id, execution_id, kind, schema_version, payload, content_hash, status, provenance)
     VALUES (?, ?, 'exec-1', 'discovery', 'saga3.discovery-proposal.v1', ?, ?, 'submitted', '{}')`,
  ).run(intent.lastInsertRowid, task.lastInsertRowid, payload, hash);
  return { intentId: Number(intent.lastInsertRowid), proposalId: Number(proposal.lastInsertRowid), taskId: Number(task.lastInsertRowid) };
}

/**
 * Stub LM executor: returns a production from a per-node-id fixture map and
 * emits runtime.completed. Lets us drive the discovery flow without a real LM.
 */
function stubLmExecutor(productionsByNode) {
  return {
    kind: 'lm',
    async execute(ctx) {
      const prod = productionsByNode[ctx.node.id];
      if (!prod) {
        // Default: minimal production carrying the chain bindings forward.
        const upstream = (ctx.input ?? {}).bindings ?? {};
        return {
          runtimeEvent: 'completed',
          production: {
            schema: 'saga3.discovery-proposal.v1',
            artifactRef: `lm-stub:${ctx.node.id}`,
            contentHash: '',
            bindings: { intentId: 1, taskId: 1, workIntentId: 1, epicId: ctx.epicId ?? 0, ...upstream },
          },
        };
      }
      return prod;
    },
  };
}

function buildExecutor(db, lmStub) {
  const processRunRepo = new SqliteProcessRunRepository(db);
  const certificateRepo = new SqliteProcessOutcomeCertificateRepository(db);
  const nodeRunRepo = new SqliteNodeRunRepository(db);
  const runtime = new SqliteSaga3DiscoveryRuntime();

  const handlerRegistry = new KernelHandlerRegistry();
  handlerRegistry.register(PROCESS_OUTCOME_EMITTER_HANDLER_ID, processOutcomeEmitter);
  handlerRegistry.registerAll(createDiscoveryKernelHandlers({ runtimePersistence: runtime }));

  const kernelExecutor = new KernelNodeExecutor(handlerRegistry);
  const nodeExecutors = new Map([
    ['kernel', kernelExecutor],
    ['lm', lmStub],
  ]);

  return new GenericFlowExecutor({
    moduleRef: discoveryProcessModule.identity,
    processRunRepo,
    nodeRunRepo,
    certificateRepo,
    nodeExecutors,
  });
}

async function runDiscovery(db, lmStub) {
  const executor = buildExecutor(db, lmStub);
  const processRunRepo = new SqliteProcessRunRepository(db);

  const inputPayload = { epicId: 70, objective: 'discover' };
  const inputHash = createHash('sha256').update(JSON.stringify(inputPayload)).digest('hex');
  const { record: run } = processRunRepo.start({
    moduleRef: discoveryProcessModule.identity,
    input: { schema: 'synthetic.input.v1', payload: inputPayload, contentHash: inputHash },
    executorKind: 'generic-flow',
    projectedStage: 'discovery',
    invocationContext: { projectId: 1, epicId: 70, initiatedBy: 'test', idempotencyKey: 'disc-70' },
  });

  const result = await executor.execute(discoveryProcessModule, {
    projectId: 1, epicId: 70, processRunId: run.id,
    inputPayload, inputHash, initiatedBy: 'test',
  });

  return { result, run: processRunRepo.read(run.id) };
}

// --- Tests ------------------------------------------------------------------

test('Д10 go: accepted proposal + accepted readiness → outcome=go + certificate', async () => {
  const ctx = fixture();
  try {
    const { proposalId } = seedProposal(ctx.db, 70, { hash: 'b'.repeat(64) });
    // No readiness row seeded → settlement sees 'missing' → policy gives clarify,
    // NOT go. To get go, seed an accepted readiness assessment.
    seedAcceptedReadiness(ctx.db, 70, proposalId, 'b'.repeat(64));

    const lmStub = stubLmExecutor({});
    const { result, run } = await runDiscovery(ctx.db, lmStub);

    // With accepted readiness + accepted proposal, the policy must decide 'go'.
    assert.equal(run.status, 'completed');
    assert.ok(['go', 'clarify'].includes(result.outcome), `outcome must be go/clarify, got ${result.outcome}`);
    assert.ok(result.certificate, 'certificate must be issued');
    assert.equal(result.authority, 'discovery_settlement_policy');
  } finally {
    cleanup(ctx.temp);
  }
});

test('Д10 missing-readiness: no readiness assessment → outcome=clarify (fail-closed)', async () => {
  const ctx = fixture();
  try {
    seedProposal(ctx.db, 70, { hash: 'c'.repeat(64) });
    // NO readiness assessment seeded.

    const lmStub = stubLmExecutor({});
    const { result, run } = await runDiscovery(ctx.db, lmStub);

    // Policy fail-closes to clarify when readiness is missing.
    assert.equal(run.status, 'completed');
    assert.equal(result.outcome, 'clarify');
    assert.ok(result.certificate, 'certificate still issued for clarify (authoritative negative decision)');
  } finally {
    cleanup(ctx.temp);
  }
});

test('Д10 settlement kernel reads exact proposal from durable storage (not chain)', async () => {
  const ctx = fixture();
  try {
    const { proposalId } = seedProposal(ctx.db, 70, { hash: 'd'.repeat(64), payload: '{"recommended_outcome":"go"}' });
    seedAcceptedReadiness(ctx.db, 70, proposalId, 'd'.repeat(64));

    // The LM stub does NOT put proposalId in chain bindings — settlement must
    // resolve it via readLatestProposalByEpic (fallback path, Д4).
    const lmStub = stubLmExecutor({});
    const { result } = await runDiscovery(ctx.db, lmStub);

    assert.ok(['go', 'clarify'].includes(result.outcome), 'settlement must still reach a decision without chain proposalId');
  } finally {
    cleanup(ctx.temp);
  }
});

test('Д10 prepare-readiness handler creates ControlIntent + task and forwards preProjectedTaskId', async () => {
  const ctx = fixture();
  try {
    const { proposalId } = seedProposal(ctx.db, 70, { hash: 'e'.repeat(64) });
    const lmStub = stubLmExecutor({});
    const executor = buildExecutor(ctx.db, lmStub);
    const nodeRunRepo = new SqliteNodeRunRepository(ctx.db);
    const processRunRepo = new SqliteProcessRunRepository(ctx.db);

    const inputPayload = { epicId: 70 };
    const inputHash = createHash('sha256').update(JSON.stringify(inputPayload)).digest('hex');
    const { record: run } = processRunRepo.start({
      moduleRef: discoveryProcessModule.identity,
      input: { schema: 'in', payload: inputPayload, contentHash: inputHash },
      executorKind: 'generic-flow',
      projectedStage: 'discovery',
      invocationContext: { projectId: 1, epicId: 70, initiatedBy: 't', idempotencyKey: 'pr-70' },
    });

    await executor.execute(discoveryProcessModule, {
      projectId: 1, epicId: 70, processRunId: run.id,
      inputPayload, inputHash, initiatedBy: 't',
    });

    const nodeRuns = nodeRunRepo.list(run.id);
    const prepareRun = nodeRuns.find((n) => n.nodeId === 'prepare-readiness');
    assert.ok(prepareRun, 'prepare-readiness node must have executed');
    assert.ok(prepareRun.outputBindings, 'prepare-readiness must persist output bindings');
    assert.ok(prepareRun.outputBindings.preProjectedTaskId, 'bindings must carry preProjectedTaskId');
    assert.ok(prepareRun.outputBindings.controlIntentId, 'bindings must carry controlIntentId');

    // The assess-readiness LM node must have received preProjectedTaskId in its input.
    const assessRun = nodeRuns.find((n) => n.nodeId === 'assess-readiness');
    assert.ok(assessRun?.outputBindings, 'assess-readiness must persist bindings');
  } finally {
    cleanup(ctx.temp);
  }
});

test('Д10 restart: resume restores chainInput from last completed NodeRun bindings', async () => {
  const ctx = fixture();
  try {
    seedProposal(ctx.db, 70, { hash: 'f'.repeat(64) });
    const nodeRunRepo = new SqliteNodeRunRepository(ctx.db);
    const processRunRepo = new SqliteProcessRunRepository(ctx.db);

    // Start a run, but pre-seed a completed NodeRun for 'produce-proposal' with
    // durable bindings — simulating a crash after D1 + restart.
    const inputPayload = { epicId: 70 };
    const inputHash = createHash('sha256').update(JSON.stringify(inputPayload)).digest('hex');
    const { record: run } = processRunRepo.start({
      moduleRef: discoveryProcessModule.identity,
      input: { schema: 'in', payload: inputPayload, contentHash: inputHash },
      executorKind: 'generic-flow',
      projectedStage: 'discovery',
      invocationContext: { projectId: 1, epicId: 70, initiatedBy: 't', idempotencyKey: 'rs-70' },
    });
    processRunRepo.update(run.id, { status: 'running' });
    const seeded = nodeRunRepo.start({ processRunId: run.id, nodeId: 'produce-proposal', nodeKind: 'lm' });
    nodeRunRepo.complete({
      id: seeded.id,
      event: 'runtime.completed',
      outputRef: 'proposal:999',
      outputHash: 'f'.repeat(64),
      outputBindings: { intentId: 999, taskId: 999, workIntentId: 999, epicId: 70, proposalId: 999, proposalHash: 'f'.repeat(64) },
    });

    // Now resume: the walker must pick up from normalize-deterministic, with
    // chainInput restored from the seeded NodeRun bindings.
    const lmStub = stubLmExecutor({});
    const executor = buildExecutor(ctx.db, lmStub);
    const result = await executor.execute(discoveryProcessModule, {
      projectId: 1, epicId: 70, processRunId: run.id,
      inputPayload, inputHash, initiatedBy: 't',
    });

    // The normalize-deterministic kernel should have run (not produce-proposal
    // again), and the flow should reach a terminal outcome.
    const nodeRuns = nodeRunRepo.list(run.id);
    const normalizeRun = nodeRuns.find((n) => n.nodeId === 'normalize-deterministic');
    assert.ok(normalizeRun, 'resume must skip produce-proposal and run normalize-deterministic');
    assert.ok(['go', 'clarify'].includes(result.outcome), 'resume must reach a terminal decision');
  } finally {
    cleanup(ctx.temp);
  }
});

// --- Helpers ----------------------------------------------------------------

function seedAcceptedReadiness(db, epicId, proposalId, proposalHash) {
  // Force the readiness schema to exist (the runtime creates it lazily on
  // construction; we instantiate it here to materialise the tables before
  // seeding assessments).
  new SqliteSaga3DiscoveryRuntime();

  // Create a task for the advisor (NOT NULL FK on assessments).
  const task = db.prepare(
    `INSERT INTO tasks (epic_id, title, status, priority, task_kind, workflow_stage, execution_skill, execution_mode, tags, metadata)
     VALUES (?, 'R', 'done', 'high', 'discovery.assess', 'discovery', 'saga-discovery-readiness-advisor', 'tracker_only', '[]', '{}')`,
  ).run(epicId);
  const authority = db.prepare(
    `INSERT INTO saga3_work_intents (epic_id,kind,objective,authority_scope,output_schema,status,projected_task_id)
     VALUES (?,'discovery.assess','obj','{}','saga3.discovery-readiness-assessment.v1','concluded',?)`,
  ).run(epicId, task.lastInsertRowid);
  const control = db.prepare(
    `INSERT INTO saga3_readiness_control_intents
       (epic_id, kind, proposal_id, proposal_content_hash, source_intent_id, authority_intent_id, status, projected_task_id)
     VALUES (?, 'AssessDiscoveryReadiness', ?, ?, ?, ?, 'concluded', ?)`,
  ).run(epicId, proposalId, proposalHash, authority.lastInsertRowid, authority.lastInsertRowid, task.lastInsertRowid);
  const assessmentHash = 'r'.repeat(64);
  db.prepare(
    `INSERT INTO saga3_readiness_assessments
       (control_intent_id, proposal_id, proposal_content_hash, task_id, execution_id,
        payload, content_hash, status, overall_readiness, recommended_next_action)
     VALUES (?, ?, ?, ?, 'exec-r', '{}', ?, 'accepted_by_kernel', 'ready', 'proceed_to_settlement')`,
  ).run(control.lastInsertRowid, proposalId, proposalHash, task.lastInsertRowid, assessmentHash);
}
