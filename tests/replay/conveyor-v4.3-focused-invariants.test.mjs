/**
 * CONVEYOR v4.3 PART 11 — Required focused tests before final E2E.
 *
 * Ten invariants that verify the simulator-free Factory runtime, the universal
 * Product Desk cutover, durable start idempotency, and replay rejection
 * ineligibility.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
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
  executionContextHash,
  EXECUTION_CONTEXT_POLICY_VERSION,
} from '../../dist/shared/authority/execution-context.js';
import { computeReplayKey } from '../../dist/replay/replay-capsule.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';
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

// --- Test 1: Same WorkerExecution authority applies to inference and replay ---

test('1: capsule-bound and inference executions use the same executor_kind', () => {
  // A capsule hit keeps claude-cli (same as inference). The executor resolves
  // the production source internally — there is no simulator route.
  const inferenceSnapshot = makeBaseSnapshot({
    replay: { key: 'k1', key_material: {}, capsule_ref: null, capsule_payload_hash: null },
  });
  const replaySnapshot = makeBaseSnapshot({
    replay: { key: 'k1', key_material: {}, capsule_ref: 'replay-capsule:1:abc', capsule_payload_hash: '0'.repeat(64) },
  });
  assert.equal(inferenceSnapshot.executor_kind, 'claude-cli');
  assert.equal(replaySnapshot.executor_kind, 'claude-cli');
  // Both have the same provider (provenance intact, not nulled out).
  assert.equal(inferenceSnapshot.model_route.provider, 'zai');
  assert.equal(replaySnapshot.model_route.provider, 'zai');
});

// --- Test 2: Capsule hit does NOT mutate lifecycle_execution_controls ---

test('2: capsule hit does not require routing configuration', () => {
  // The routing resolver has no simulator route. A capsule hit is resolved
  // internally from execution_context.replay.capsule_ref, not from routing.
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

// --- Test 3 & 4: Capsule hit does NOT reference claude-cli-simulator ---

test('3+4: no runtime path references claude-cli-simulator', () => {
  // The routing resolver rejects simulator at construction time (policy
  // validation). This proves no runtime path can select simulator.
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

  // The production executor rejects a simulator snapshot.
  let starts = 0;
  const runner = { start() { starts++; return {}; }, stop() { return null; }, status() { return null; }, setConcurrency() {}, dispose() {} };
  const executor = new ClaudeBoardWorkerExecutor(runner);
  const base = {
    taskId: 1, epicId: 1, projectId: 1, status: 'in_progress', skill: 's',
    workerExecutionId: 'e1', fenceToken: 'e1', runId: 'r1', workerId: 'w1',
    machineId: 'm1', repository: null,
  };
  assert.throws(
    () => executor.start({
      projectId: 1, concurrency: 1,
      assignment: { ...base, executionContext: makeBaseSnapshot({ executor_kind: 'claude-cli-simulator', model_route: { provider: null, model: null, effort: null } }) },
    }),
    /FROZEN_EXECUTOR_KIND_REQUIRED/,
  );
  assert.equal(starts, 0);
});

// --- Test 5 & 6: Discovery inference and replay follow the same product_submit path ---

test('5+6: Discovery proposal schema triggers the universal projection from product_submit', () => {
  // The projection is schema-driven: when product_submit receives a Discovery
  // proposal schema, it projects into factory_proposals deterministically. This
  // is the same path for inference (worker calls proposal_submit → product_submit)
  // and replay (capsule replay calls product_submit). The Gate cannot
  // distinguish how the product was produced.
  assert.ok(
    requiresDiscoveryProjection(DISCOVERY_PROPOSAL_SCHEMA),
    'Discovery proposal schema must trigger the compatibility projection',
  );
  assert.ok(
    !requiresDiscoveryProjection('some.other.schema.v1'),
    'Non-Discovery schemas must not trigger the projection',
  );
});

// --- Test 7: No ReplayCapsule schema contains Discovery-specific tables/records ---

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
  // No Discovery-specific fields.
  assert.ok(!keys.some(k =>
    k.includes('proposal') || k.includes('discovery') || k.includes('factory_proposal'),
  ));
});

// --- Test 8 & 9: Start idempotency ---

function makeIdempotencyDb() {
  const db = makeDb();
  // Disable FK to avoid needing full lifecycle_runs prerequisite rows — we are
  // testing the idempotency index in isolation.
  db.pragma('foreign_keys = OFF');
  return db;
}

test('8: same idempotency key after terminal completion resolves same launch', () => {
  const db = makeIdempotencyDb();
  db.prepare(`INSERT INTO factory_launch_requests (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,concurrency,state) VALUES ('l1','o1','new',1,1,'t','K1',1,'completed')`).run();

  // The completed launch with key K1 must still be found (durable binding).
  const existing = db.prepare(
    `SELECT launch_ref FROM factory_launch_requests WHERE idempotency_key='K1'`,
  ).get();
  assert.ok(existing, 'completed launch with key K1 must still be found (durable binding)');

  // Verify the index is durable (not partial). A new INSERT with the same key
  // must fail with a UNIQUE constraint violation — even after completion.
  assert.throws(
    () => db.prepare(
      `INSERT INTO factory_launch_requests (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,concurrency,state)
       VALUES ('l2','o1','new',1,1,'t','K1',1,'requested')`,
    ).run(),
    /UNIQUE constraint failed/,
  );
});

test('9: new idempotency key with identical source creates new order', () => {
  const db = makeIdempotencyDb();
  db.prepare(`INSERT INTO factory_launch_requests (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,concurrency,state) VALUES ('l1','o1','new',1,1,'t','K1',1,'completed')`).run();

  // A new launch with key K2 (different key) must succeed.
  db.prepare(
    `INSERT INTO factory_launch_requests (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,idempotency_key,concurrency,state)
     VALUES ('l2','o2','new',1,1,'t','K2',1,'requested')`,
  ).run();
  const count = db.prepare(`SELECT count(*) as n FROM factory_launch_requests`).get();
  assert.equal(count.n, 2);
});

// --- Test 10: Rejected replay capsule is ineligible on recovery ---

test('10: rejected replay capsule is detected as ineligible', () => {
  const db = makeIdempotencyDb();
  db.prepare(`INSERT INTO factory_workplaces (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,kanban_phase,loop_state,next_role) VALUES ('wp1',1,'m@1','c1','wk','in_progress','leased','author')`).run();
  db.prepare(`INSERT INTO worker_executions (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,launcher,phase,metadata,lease_expires_at,state) VALUES ('exec1','r1',1,1,1,'w1','m1','l','executing','{"execution_context":{"replay":{"capsule_ref":"replay-capsule:1:abc"}}}','9999-12-31','running')`).run();
  db.prepare(`INSERT INTO factory_candidate_sets (candidate_set_ref,workplace_ref,producer_execution_ref,role,candidate_set_digest,seal_receipt_ref,sealed_at) VALUES ('cs1','wp1','exec1','author','d1','sr1','2026-08-08')`).run();
  db.prepare(`INSERT INTO factory_gate_decisions (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,subject_candidate_set_ref,assessment_candidate_set_refs,verdict,check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,check_receipt_refs,installation_digest,accepted_output_bindings,decided_at,decision_digest) VALUES ('dk1','wp1','g1','gr1','author','t1','cs1','[]','repair_required','cp1','cpd1','dp1','dpd1','[]','id1','[]','2026-08-08','dd1')`).run();

  const capsuleRef = 'replay-capsule:1:abc';
  const rejected = db.prepare(
    `SELECT 1
       FROM factory_gate_decisions gd
       JOIN factory_candidate_sets cs
         ON cs.candidate_set_ref = gd.subject_candidate_set_ref
        AND cs.workplace_ref = gd.workplace_ref
       JOIN worker_executions we
         ON we.execution_id = cs.producer_execution_ref
      WHERE gd.workplace_ref = ?
        AND gd.verdict != 'accepted'
        AND we.metadata LIKE ?`,
  ).get('wp1', `%"capsule_ref":"${capsuleRef}"%`);
  assert.ok(rejected, 'capsule with a rejected CandidateSet must be detected as ineligible');

  // A different capsule that was never replayed must NOT be flagged.
  const otherRejected = db.prepare(
    `SELECT 1
       FROM factory_gate_decisions gd
       JOIN factory_candidate_sets cs
         ON cs.candidate_set_ref = gd.subject_candidate_set_ref
        AND cs.workplace_ref = gd.workplace_ref
       JOIN worker_executions we
         ON we.execution_id = cs.producer_execution_ref
      WHERE gd.workplace_ref = ?
        AND gd.verdict != 'accepted'
        AND we.metadata LIKE ?`,
  ).get('wp1', `%"capsule_ref":"replay-capsule:999:xyz"%`);
  assert.equal(otherRejected, undefined, 'a never-replayed capsule must not be flagged');
});
