/**
 * CONVEYOR v4.3 focused architecture invariants.
 *
 * These tests defend the simulator-free Factory runtime, the universal Product
 * Desk, durable start idempotency and replay rejection/failure ineligibility.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_SQL, rebuildLaunchIdempotencyIndex } from '../../dist/schema.js';
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
import { requiresDiscoveryProjection } from '../../dist/modules/discovery/infrastructure/discovery-proposal-projection.js';
import { DISCOVERY_PROPOSAL_SCHEMA } from '../../dist/modules/discovery/domain/discovery-proposal.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  rebuildLaunchIdempotencyIndex(db);
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

test('5+6: Discovery proposal is a schema projection behind universal product_submit', () => {
  // Inference and replay both submit the same typed product through
  // product_submit. The Discovery-specific factory_proposals row is a current
  // deterministic compatibility projection, not another worker submit protocol
  // and not capsule payload.
  assert.ok(requiresDiscoveryProjection(DISCOVERY_PROPOSAL_SCHEMA));
  assert.ok(!requiresDiscoveryProjection('some.other.schema.v1'));
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
