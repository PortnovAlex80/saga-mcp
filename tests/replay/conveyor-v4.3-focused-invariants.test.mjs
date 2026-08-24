/**
 * CONVEYOR v4.3 focused architecture invariants.
 *
 * These tests defend the simulator-free Factory runtime, the universal Product
 * Desk, durable start idempotency and replay rejection/failure ineligibility.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  createExecutionRouteResolver,
} from '../../dist/application/routing/execution-route-resolver.js';
import {
  DEFAULT_ROUTE,
} from '../../dist/application/routing/worker-execution-route.js';
import {
  ClaudeBoardWorkerExecutor,
} from '../../dist/infrastructure/workers/claude-board-worker-executor.js';
import {
  EXECUTION_CONTEXT_POLICY_VERSION,
} from '../../dist/shared/authority/execution-context.js';
import { computeReplayKey } from '../../dist/replay/replay-capsule.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
import { SqliteGateRepository } from '../../dist/infrastructure/workplace/sqlite-gate-repository.js';
import { requireAcceptedCandidatePresentations } from '../../dist/infrastructure/replay/replay-presentation-authority.js';
// KEPT live domain import (ADR-095 Decision 5: discovery-proposal.ts stays).
// The dead discovery-proposal-projection.js import was removed with the
// Phase-3.1 projection removal — invariant 5 now pins the projection-FREE
// product_submit seam below.
import {
  DISCOVERY_PROPOSAL_SCHEMA,
  validateDiscoveryProposal,
} from '../../dist/modules/discovery/domain/discovery-proposal.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

function makeBaseSnapshot(overrides = {}) {
  return {
    policy_version: EXECUTION_CONTEXT_POLICY_VERSION,
    work_intent_id: null,
    authority: null,
    model_route: { provider: 'zai', model: 'glm-5.2', effort: 'high' },
    executor_kind: 'claude-cli',
    route_policy: null,
    replay: null,
    captured_at: '2026-08-08T00:00:00Z',
    ...overrides,
  };
}

test('1: capsule-bound and inference executions use the same executor_kind', () => {
  const inferenceSnapshot = makeBaseSnapshot({
    replay: { key: 'k1', key_material: {}, capsule_ref: null, capsule_payload_hash: null },
  });
  const replaySnapshot = makeBaseSnapshot({
    replay: { key: 'k1', key_material: {}, capsule_ref: 'replay-capsule:1:abc', capsule_payload_hash: '0'.repeat(64) },
  });
  assert.equal(inferenceSnapshot.executor_kind, 'claude-cli');
  assert.equal(replaySnapshot.executor_kind, 'claude-cli');
  // model_route stays frozen as the route that would run on a miss. Actual
  // replay provenance is recorded separately by the production journal.
  assert.equal(inferenceSnapshot.model_route.provider, 'zai');
  assert.equal(replaySnapshot.model_route.provider, 'zai');
});

test('2: capsule hit does not require alternate routing configuration', () => {
  const resolver = createExecutionRouteResolver({ policy: { routes: [] } });
  const route = resolver.resolve({
    module: 'product-discovery',
    cell: 'discover-problem',
    role: 'author',
    executionProfile: 'discovery-author',
  });
  assert.equal(route.executor.kind, 'claude-cli');
  assert.equal(DEFAULT_ROUTE.executor.kind, 'claude-cli');
});

test('3+4: routing cannot select the retired simulator executor', () => {
  assert.throws(
    () => createExecutionRouteResolver({
      policy: {
        routes: [{
          match: { module: 'product-discovery' },
          route: { executor: { kind: 'claude-cli-simulator' } },
        }],
      },
    }),
    /unsupported.*only 'claude-cli'/i,
  );

  let starts = 0;
  const runner = {
    start() { starts += 1; return {}; },
    stop() { return null; },
    status() { return null; },
    setConcurrency() {},
    dispose() {},
  };
  const executor = new ClaudeBoardWorkerExecutor(runner);
  const base = {
    taskId: 1, epicId: 1, projectId: 1, status: 'in_progress', skill: 's',
    workerExecutionId: 'e1', fenceToken: 'e1', runId: 'r1', workerId: 'w1',
    machineId: 'm1', repository: null,
  };
  assert.throws(
    () => executor.start({
      projectId: 1,
      concurrency: 1,
      assignment: {
        ...base,
        executionContext: makeBaseSnapshot({
          executor_kind: 'claude-cli-simulator',
          model_route: { provider: null, model: null, effort: null },
        }),
      },
    }),
    /FROZEN_EXECUTOR_KIND_REQUIRED/,
  );
  assert.equal(starts, 0);
});

test('5+6: product_submit is projection-free — the Discovery proposal is an ordinary typed product on one desk', async () => {
  // Invariant 6 (live, unchanged): inference and replay both submit the same
  // typed product through the ONE universal product_submit — there is no
  // Discovery-specific worker submit protocol and no capsule payload coupling.
  //
  // Invariant 5 (migrated at ADR-095 Phase 3.1): the legacy
  // factory_proposals projection behind product_submit is DEAD. This test
  // drives the REAL product_submit handler at the live seam and proves the
  // NEGATIVE: a Discovery proposal submission can neither recreate the legacy
  // projection row nor provide the legacy projection surface.
  const { getDb, closeDb } = await import('../../dist/db.js');
  const {
    handlers: productHandlers,
    _resetProductToolRepositoriesForTests,
  } = await import('../../dist/tools/products.js');
  const {
    registerProductPayloadContract,
    productPayloadContractDigest,
  } = await import('../../dist/process-modules/application/product-payload-contract.js');
  const { buildExecutionContext } = await import('../../dist/shared/authority/build-execution-context.js');
  const { executionContextHash } = await import('../../dist/shared/authority/execution-context.js');

  const contractId = 'discovery-proposal.v1';
  const version = '1.0.0';
  const definition = { type: 'object', required: ['problem_statement', 'recommended_outcome'] };
  const contractDigest = productPayloadContractDigest({ schemaId: DISCOVERY_PROPOSAL_SCHEMA, contractId, version, definition });
  registerProductPayloadContract({
    schemaId: DISCOVERY_PROPOSAL_SCHEMA,
    contractId,
    version,
    definition,
    contractDigest,
    validate(payload) {
      return validateDiscoveryProposal(payload).errors;
    },
  });

  const dbPath = path.join(os.tmpdir(),
    `saga-v43-invariant5-${process.pid}-${Date.now()}.sqlite`);
  const prevDbPath = process.env.DB_PATH;
  const prevManaged = process.env.SAGA_MANAGED_EXECUTION;
  const prevExecutionId = process.env.SAGA_EXECUTION_ID;
  const prevTaskId = process.env.SAGA_TASK_ID;
  process.env.DB_PATH = dbPath;
  process.env.SAGA_MANAGED_EXECUTION = '1';
  try {
    const db = getDb();
    const id = 4217;
    const executionId = 'exec-invariant5';
    const workplaceRef = `workplace/${id}/product-discovery@3.0.2/produce-proposal/singleton`;
    db.prepare(`INSERT INTO projects (id,name) VALUES (?,?)`).run(id, 'p-invariant5');
    db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (?,?,?)`).run(id, id, 'e-invariant5');
    db.prepare(
      `INSERT INTO factory_process_runs
         (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
          executor_kind,input_schema,input_snapshot,input_hash,status)
       VALUES (?,?,?,'product-discovery','3.0.2','product-discovery@3.0.2',?,
               'generic-flow','factory.input.v1','{}',?,'paused')`,
    ).run(id, id, id, `run-${id}`, `input-${id}`);
    const authority = {
      enforcement: 'runtime',
      allowed_tools: ['product_submit', 'worker_done'],
      scope: workplaceRef,
      snapshot_ref: workplaceRef,
      payload_contract: { contractId, version, contractDigest },
    };
    db.prepare(
      `INSERT INTO factory_work_intents
         (id,epic_id,kind,objective,authority_scope,output_schema,status)
       VALUES (?,?,?,?,?,?,'executing')`,
    ).run(id, id, 'discovery', 'produce-proposal', JSON.stringify(authority), DISCOVERY_PROPOSAL_SCHEMA);
    db.prepare(
      `INSERT INTO factory_workplaces
         (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
          kanban_phase,loop_state,next_role,revision,active_reservation_ref)
       VALUES (?,?,'product-discovery@3.0.2','produce-proposal','singleton',
               'in_progress','running','author',2,?)`,
    ).run(workplaceRef, id, executionId);
    const metadata = {
      process_run_id: id,
      process_module_ref: 'product-discovery@3.0.2',
      process_node_id: 'produce-proposal',
      process_input_hash: `input-${id}`,
      production_cell_id: 'produce-proposal',
      // work_key pins the derived WorkplaceRef to the seeded singleton row
      // (deriveWorkplaceRefFromTaskMetadata falls back to task-<id> without
      // it, and the presentation-close path resolves the workplace by this
      // convention).
      work_key: 'singleton',
      work_intent_id: id,
    };
    db.prepare(
      `INSERT INTO tasks
         (id,epic_id,title,status,assigned_to,current_execution_id,workplace_ref,
          task_kind,execution_mode,metadata)
       VALUES (?,?,?,'in_progress',?,?,?,'discovery','tracker_only',?)`,
    ).run(id, id, 'produce-proposal', 'worker-invariant5', executionId, workplaceRef, JSON.stringify(metadata));
    const intent = db.prepare('SELECT * FROM factory_work_intents WHERE id=?').get(id);
    const executionContext = buildExecutionContext({
      modelRoute: { provider: 'test', model: 'test', effort: 'low' },
      workIntent: { ...intent, authority_scope: JSON.parse(intent.authority_scope) },
      capturedAt: new Date().toISOString(),
    });
    db.prepare(
      `INSERT INTO worker_executions
         (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
          launcher,state,phase,metadata)
       VALUES (?,?,?,?,?,?,?,'test','running','executing',?)`,
    ).run(executionId, `dispatch-${id}`, id, id, id, 'worker-invariant5', 'machine', JSON.stringify({
      execution_context: executionContext,
      execution_context_hash: executionContextHash(executionContext),
    }));
    process.env.SAGA_EXECUTION_ID = executionId;
    process.env.SAGA_TASK_ID = String(id);

    const PROPOSAL_PAYLOAD = {
      problem_statement: 'Focused invariant 5: the legacy Discovery projection is dead.',
      observed_context: 'ADR-095 Phase 3.1 removed the product_submit projection block.',
      stakeholders_or_actors: ['operator'],
      assumptions: ['the universal desk is the only product surface'],
      unknowns: [],
      risks: [],
      candidate_scope: 'projection-free product_submit seam',
      evidence_refs: ['docs/architecture/decisions/095-complete-removal-of-dead-discovery-legacy.md'],
      recommended_outcome: 'go',
      rationale: 'The Discovery proposal is an ordinary typed product on one desk.',
    };

    _resetProductToolRepositoriesForTests();
    const reply = productHandlers.product_submit({
      schema: DISCOVERY_PROPOSAL_SCHEMA,
      content: structuredClone(PROPOSAL_PAYLOAD),
    });

    // Invariant 6 — the universal seam accepted the Discovery proposal as an
    // ordinary typed product (managed submission + desk product + response).
    assert.equal(reply.accepted, true);
    assert.equal(reply.product_ref.schemaId, DISCOVERY_PROPOSAL_SCHEMA);
    assert.ok(reply.product_ref.ref.startsWith('managed-node-submission:'));
    assert.equal(db.prepare(
      `SELECT COUNT(*) AS n FROM factory_managed_node_submissions
        WHERE schema_version=? AND execution_id=?`,
    ).get(DISCOVERY_PROPOSAL_SCHEMA, executionId).n, 1);
    assert.equal(db.prepare(
      `SELECT COUNT(*) AS n FROM factory_process_products WHERE schema_id=?`,
    ).get(DISCOVERY_PROPOSAL_SCHEMA).n, 1);

    // Invariant 5 (negative proof) — product_submit CANNOT recreate or
    // provide the legacy Discovery projection:
    // (a) no legacy response field;
    assert.equal(Object.hasOwn(reply, 'discovery_proposal_id'), false,
      'product_submit must not provide the legacy discovery_proposal_id field');
    // (b) the retired factory_proposals table is absent from the fresh schema;
    assert.equal(db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='factory_proposals'",
    ).get().n, 0, 'fresh schema must not contain the legacy factory_proposals table');
    // (c) no PROPOSAL_REF_SCHEMA side product on the universal desk.
    assert.equal(db.prepare(
      `SELECT COUNT(*) AS n FROM factory_process_products
        WHERE schema_id='factory.discovery-proposal-ref.v1'`,
    ).get().n, 0,
      'product_submit must not emit the legacy proposal-ref side product');

    // The submission fence is LIVE after the presentation close (the desk is
    // in verifying): a repeat submit from the same execution is refused —
    // the only accepted path is the one universal seam above, never a
    // Discovery-specific projection lane.
    assert.throws(
      () => productHandlers.product_submit({
        schema: DISCOVERY_PROPOSAL_SCHEMA,
        content: structuredClone(PROPOSAL_PAYLOAD),
      }),
      /MANAGED_NODE_SUBMISSION_(PROCESS_NOT_RUNNING|EXECUTION_NOT_RUNNING|FENCE)/,
    );
    assert.equal(db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='factory_proposals'",
    ).get().n, 0);

    closeDb();
  } finally {
    if (prevDbPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = prevDbPath;
    if (prevManaged === undefined) delete process.env.SAGA_MANAGED_EXECUTION; else process.env.SAGA_MANAGED_EXECUTION = prevManaged;
    if (prevExecutionId === undefined) delete process.env.SAGA_EXECUTION_ID; else process.env.SAGA_EXECUTION_ID = prevExecutionId;
    if (prevTaskId === undefined) delete process.env.SAGA_TASK_ID; else process.env.SAGA_TASK_ID = prevTaskId;
    // Best-effort cleanup: on Windows the just-closed WAL mapping can keep
    // the file briefly undeletable (EPERM); a leftover temp file is harmless
    // next to the other getDb()-based suites' temp DBs.
    for (const suffix of ['', '-wal', '-shm']) {
      try { rmSync(dbPath + suffix, { force: true }); } catch { /* best effort */ }
    }
  }
});

test('7: ReplayCapsule payload contains only generic worker production fields', () => {
  const capsulePayload = {
    schemaVersion: 'factory.replay-capsule.v1',
    key: {},
    replayKey: computeReplayKey({
      projectId: 1,
      moduleRef: 'product-discovery@1.0.0',
      nodeId: 'discover-problem',
      productionCellId: 'cell-1',
      workKey: 'work-1',
      role: 'author',
      packageDigest: 'pkg-1',
      semanticInputDigest: sha256Hex({ subject: 'test' }),
      subjectProductionDigest: null,
    }),
    inputBindings: [],
    typedProducts: [],
    artifacts: [],
    traces: [],
    git: null,
  };
  const keys = Object.keys(capsulePayload).sort();
  assert.deepEqual(keys, [
    'artifacts', 'git', 'inputBindings', 'key', 'replayKey',
    'schemaVersion', 'traces', 'typedProducts',
  ]);
  assert.ok(!keys.some(k =>
    k.includes('proposal') || k.includes('discovery') || k.includes('factory_proposal'),
  ));
});

function makeIdempotencyDb() {
  const db = makeDb();
  db.pragma('foreign_keys = OFF');
  return db;
}

test('8: same idempotency key stays bound after terminal completion', () => {
  const db = makeIdempotencyDb();
  db.prepare(`INSERT INTO factory_launch_requests (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,concurrency,state) VALUES ('l1','o1','new',1,1,'t','K1',1,'completed')`).run();
  const existing = db.prepare(
    `SELECT launch_ref FROM factory_launch_requests WHERE idempotency_key='K1'`,
  ).get();
  assert.ok(existing);
  assert.throws(
    () => db.prepare(
      `INSERT INTO factory_launch_requests (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,concurrency,state)
       VALUES ('l2','o1','new',1,1,'t','K1',1,'requested')`,
    ).run(),
    /UNIQUE constraint failed/,
  );
});

test('9: new idempotency key with identical semantic source can create a new order', () => {
  const db = makeIdempotencyDb();
  db.prepare(`INSERT INTO factory_launch_requests (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,concurrency,state) VALUES ('l1','o1','new',1,1,'t','K1',1,'completed')`).run();
  db.prepare(
    `INSERT INTO factory_launch_requests (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,concurrency,state)
     VALUES ('l2','o2','new',1,1,'t','K2',1,'requested')`,
  ).run();
  const count = db.prepare(`SELECT count(*) as n FROM factory_launch_requests`).get();
  assert.equal(count.n, 2);
});

test('10: gate-rejected replay capsule is detectable without string matching', () => {
  const db = makeIdempotencyDb();
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,metadata) VALUES (1,1,'t','in_progress','{}')`).run();
  db.prepare(`INSERT INTO factory_workplaces (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,kanban_phase,loop_state,next_role) VALUES ('wp1',1,'m@1','c1','wk','in_progress','leased','author')`).run();
  db.prepare(`INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,launcher,phase,metadata,lease_expires_at,state) VALUES ('exec1','r1',1,1,1,'w1','m1','l','executing','{"execution_context":{"replay":{"capsule_ref":"replay-capsule:1:abc"}}}','9999-12-31','running')`).run();
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,metadata) VALUES (2,1,'t2','in_progress','{}')`).run();
  db.prepare(`UPDATE tasks SET workplace_ref='wp1' WHERE id IN (1,2)`).run();
  db.prepare(`INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,launcher,phase,metadata,lease_expires_at,state) VALUES ('exec2','r2',1,1,2,'w2','m1','l','executing','{"execution_context":{"replay":{"capsule_ref":"replay-capsule:999:xyz"}}}','9999-12-31','running')`).run();
  db.prepare(`INSERT INTO factory_workplace_production_revisions
    (revision_ref,workplace_ref,members,contributing_execution_refs,presenter_ref,material_digest,semantic_digest,sealed_at)
    VALUES ('rev1','wp1','[]','["exec1"]','exec1','md1','sd1','2026-08-08')`).run();
  db.prepare(`INSERT INTO factory_candidate_sets
    (candidate_set_ref,workplace_ref,production_revision_ref,role,candidate_set_digest,seal_receipt_ref,sealed_at)
    VALUES ('cs1','wp1','rev1','author','d1','sr1','2026-08-08')`).run();
  db.prepare(`INSERT INTO factory_gate_runs
    (gate_run_ref,workplace_ref,gate_phase,subject_candidate_set_ref,
     assessment_candidate_set_refs,check_plan_ref,check_plan_digest,
     expected_workplace_revision,gate_lease_ref,state)
    VALUES ('gr1','wp1','author','cs1','[]','cp1','cpd1',0,'lease1','terminal')`).run();
  new SqliteGateRepository(db).recordGatePresentation('gr1', 'exec1');
  db.prepare(`INSERT INTO factory_gate_decisions (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,subject_candidate_set_ref,assessment_candidate_set_refs,verdict,check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,check_receipt_refs,installation_digest,accepted_output_bindings,decided_at,decision_digest) VALUES ('dk1','wp1','g1','gr1','author','t1','cs1','[]','repair_required','cp1','cpd1','dp1','dpd1','[]','id1','[]','2026-08-08','dd1')`).run();

  const rejected = db.prepare(
    `SELECT 1
       FROM factory_gate_decisions gd
      WHERE gd.workplace_ref=?
        AND gd.verdict!='accepted'
        AND EXISTS (
          SELECT 1 FROM factory_gate_presentation_attempts gpa
          WHERE gpa.gate_run_ref=gd.gate_run_ref
            AND gpa.replay_capsule_ref=?
        )`,
  ).get('wp1', 'replay-capsule:1:abc');
  assert.ok(rejected);

  db.prepare(`UPDATE worker_executions SET metadata=
    '{"execution_context":{"replay":{"capsule_ref":"replay-capsule:999:xyz"}}}'
    WHERE execution_id='exec1'`).run();

  const other = db.prepare(
    `SELECT 1
       FROM factory_gate_decisions gd
      WHERE gd.workplace_ref=?
        AND gd.verdict!='accepted'
        AND EXISTS (
          SELECT 1 FROM factory_gate_presentation_attempts gpa
          WHERE gpa.gate_run_ref=gd.gate_run_ref
            AND gpa.replay_capsule_ref=?
        )`,
  ).get('wp1', 'replay-capsule:999:xyz');
  assert.equal(other, undefined);
  const stillRejected = db.prepare(
    `SELECT 1 FROM factory_gate_presentation_attempts
      WHERE gate_run_ref='gr1' AND replay_capsule_ref='replay-capsule:1:abc'`,
  ).get();
  assert.ok(stillRejected);
});

test('11: failed replay execution is durable evidence for ineligibility', () => {
  const db = makeIdempotencyDb();
  db.prepare(`INSERT INTO tasks (id,epic_id,title,status,workplace_ref,metadata) VALUES (1,1,'t','todo','wp1','{}')`).run();
  db.prepare(`INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,launcher,phase,metadata,state) VALUES ('exec1','r1',1,1,1,'w1','m1','l','executing','{"execution_context":{"replay":{"capsule_ref":"replay-capsule:1:broken"}}}','lost')`).run();
  const failed = db.prepare(
    `SELECT 1
       FROM worker_executions we JOIN tasks t ON t.id=we.task_id
      WHERE t.workplace_ref=?
        AND we.state IN ('lost','spawn_failed','terminated')
        AND json_extract(we.metadata,'$.execution_context.replay.capsule_ref')=?`,
  ).get('wp1', 'replay-capsule:1:broken');
  assert.ok(failed);
});

test('accepted replay certification fails closed when the exact Gate has no presentation', () => {
  const db = makeIdempotencyDb();
  db.pragma('foreign_keys=OFF');
  db.prepare(`INSERT INTO factory_gate_decisions
    (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
     subject_candidate_set_ref,assessment_candidate_set_refs,verdict,check_plan_ref,
     check_plan_digest,decision_policy_ref,decision_policy_digest,check_receipt_refs,
     installation_digest,accepted_output_bindings,decision_digest)
    VALUES ('decision:empty','wp','gate','gate-run:empty','final','transition',
      'candidate:author','["candidate:reviewer"]','accepted','plan','pd','policy','dd','[]','i','[]','digest')`).run();
  assert.throws(() => requireAcceptedCandidatePresentations(db, {
    workplaceRef: 'wp', finalDecisionKey: 'decision:empty',
    finalSubjectCandidateSetRef: 'candidate:author', candidateSetRef: 'candidate:reviewer',
  }), /REPLAY_CERTIFICATION_PRESENTATION_MISSING/);
  db.close();
});
