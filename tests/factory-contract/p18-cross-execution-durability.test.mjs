// tests/factory-contract/p18-cross-execution-durability.test.mjs
//
// CGAD P18 / Conveyor v4.3 — durable managed production belongs to the exact
// Workplace. WorkerExecution is transient provenance; Flow node is too broad.

import { test } from 'node:test';
import assert from 'node:assert';
import Database from 'better-sqlite3';
import { SqliteWorkplaceProductionResolver } from '../../dist/infrastructure/workplace/sqlite-workplace-production-resolver.js';
import { buildWorkplaceProductionSnapshot } from '../../dist/process-modules/shared/workplace-production-snapshot.js';
import { SqliteProcessProductRepositoryV2 } from '../../dist/process-modules/persistence/sqlite-process-product-repository-v2.js';
import { SqliteWorkplaceProductAdapter } from '../../dist/process-modules/persistence/sqlite-workplace-product-adapter.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const processRunId = 1;
const moduleRef = 'solution-development@1.0.0';
const nodeId = 'implement-work-items';
const workplaceA = { processRunId, moduleRef, productionCellId: 'development-implementation', workKey: 'AC-1' };
const workplaceB = { processRunId, moduleRef, productionCellId: 'development-implementation', workKey: 'AC-2' };
const serializedA = `workplace/${processRunId}/${moduleRef}/development-implementation/AC-1`;
const serializedB = `workplace/${processRunId}/${moduleRef}/development-implementation/AC-2`;

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id INTEGER PRIMARY KEY);
    INSERT INTO projects(id) VALUES (1);
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      workplace_ref TEXT
    );
    CREATE TABLE factory_managed_artifact_productions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL,
      module_ref TEXT NOT NULL,
      node_id TEXT NOT NULL,
      intent_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      execution_id TEXT NOT NULL,
      artifact_id INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      artifact_status TEXT NOT NULL,
      content_hash TEXT,
      operation TEXT NOT NULL,
      recorded_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE factory_managed_trace_productions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL,
      module_ref TEXT NOT NULL,
      node_id TEXT NOT NULL,
      intent_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      execution_id TEXT NOT NULL,
      trace_id INTEGER NOT NULL,
      source_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      link_type TEXT NOT NULL,
      trace_hash TEXT NOT NULL,
      recorded_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY,
      workplace_ref TEXT NOT NULL,
      production_revision_ref TEXT,
      role TEXT NOT NULL,
      subject_candidate_set_ref TEXT,
      candidate_set_digest TEXT NOT NULL,
      seal_receipt_ref TEXT,
      sealed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE factory_candidate_set_members (
      candidate_set_ref TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      product_schema TEXT NOT NULL,
      product_ref TEXT NOT NULL,
      product_digest TEXT NOT NULL,
      origin TEXT,
      source_candidate_set_ref TEXT,
      PRIMARY KEY (candidate_set_ref, ordinal)
    );
  `);
  const productRepo = new SqliteProcessProductRepositoryV2(db);
  db.prepare(`INSERT INTO factory_process_runs
    (id,project_id,module_name,module_version,module_ref_key,idempotency_key,
     executor_kind,input_schema,input_snapshot,input_hash)
    VALUES (1,1,'solution-development','1.0.0',?,'p18','generic-flow','test.input','{}','input-hash')`)
    .run(moduleRef);
  return { db, productRepo };
}

function addArtifact(db, { taskId, executionId, artifactId, type, hash, operation = 'create' }) {
  db.prepare(`INSERT INTO factory_managed_artifact_productions
    (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
     artifact_id,artifact_type,artifact_status,content_hash,operation)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(processRunId, moduleRef, nodeId, taskId, taskId, executionId,
      artifactId, type, 'draft', hash, operation);
}

function addTrace(db, { taskId, executionId, traceId, sourceId, targetId }) {
  db.prepare(`INSERT INTO factory_managed_trace_productions
    (process_run_id,module_ref,node_id,intent_id,task_id,execution_id,
     trace_id,source_id,target_type,target_id,link_type,trace_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(processRunId, moduleRef, nodeId, taskId, taskId, executionId,
      traceId, sourceId, 'artifact', targetId, 'derived_from', `trace-${traceId}`);
}

test('P18-AC-1: replacement execution inherits all production from SAME Workplace', () => {
  const { db } = createDb();
  db.prepare('INSERT INTO tasks (id,workplace_ref) VALUES (?,?)').run(10, serializedA);
  db.prepare('INSERT INTO tasks (id,workplace_ref) VALUES (?,?)').run(11, serializedA);
  addArtifact(db, { taskId: 10, executionId: 'exec-A', artifactId: 1, type: 'PRD', hash: 'hash-prd' });
  addArtifact(db, { taskId: 10, executionId: 'exec-A', artifactId: 2, type: 'FR', hash: 'hash-fr' });
  addArtifact(db, { taskId: 11, executionId: 'exec-B', artifactId: 3, type: 'NFR', hash: 'hash-nfr' });
  addTrace(db, { taskId: 10, executionId: 'exec-A', traceId: 1, sourceId: 2, targetId: 1 });

  const production = new SqliteWorkplaceProductionResolver(db).read(workplaceA);
  assert.deepEqual(production.artifacts.map(a => a.artifactId), [1, 2, 3]);
  assert.deepEqual(production.traces.map(t => t.traceId), [1]);

  const snapshot = buildWorkplaceProductionSnapshot({
    workplaceRef: serializedA,
    expectedSchemaRef: 'factory.formalization-product-contract.v1',
    artifacts: production.artifacts,
    traces: production.traces,
  });
  assert.equal(Object.hasOwn(snapshot, `presenter${'ExecutionRef'}`), false);
  assert.equal(Object.hasOwn(snapshot, 'contributingExecutionRefs'), false);
  assert.equal(Object.hasOwn(snapshot.artifacts[0], `lastProducer${'ExecutionRef'}`), false);
});

test('ADR-053 B-3: snapshot material hash is invariant to contributing execution identity', () => {
  const base = {
    artifactId: 1,
    artifactType: 'PRD',
    artifactStatus: 'draft',
    contentHash: 'a'.repeat(64),
    operation: 'update',
  };
  const make = executionId => buildWorkplaceProductionSnapshot({
    workplaceRef: serializedA,
    expectedSchemaRef: 'factory.formalization-product-contract.v1',
    artifacts: [{ ...base, executionId }],
    traces: [],
  });
  assert.equal(sha256Hex(make('exec-A')), sha256Hex(make('exec-B')));
});

test('P18-AC-2: sibling Workplaces under SAME node are strictly isolated', () => {
  const { db } = createDb();
  db.prepare('INSERT INTO tasks (id,workplace_ref) VALUES (?,?)').run(10, serializedA);
  db.prepare('INSERT INTO tasks (id,workplace_ref) VALUES (?,?)').run(20, serializedB);
  addArtifact(db, { taskId: 10, executionId: 'exec-A', artifactId: 1, type: 'FR', hash: 'hash-A' });
  addArtifact(db, { taskId: 20, executionId: 'exec-C', artifactId: 2, type: 'FR', hash: 'hash-B' });

  const resolver = new SqliteWorkplaceProductionResolver(db);
  assert.deepEqual(resolver.read(workplaceA).artifacts.map(a => a.artifactId), [1]);
  assert.deepEqual(resolver.read(workplaceB).artifacts.map(a => a.artifactId), [2]);
});

test('P18-AC-3: latest write wins only inside the same Workplace', () => {
  const { db } = createDb();
  db.prepare('INSERT INTO tasks (id,workplace_ref) VALUES (?,?)').run(10, serializedA);
  db.prepare('INSERT INTO tasks (id,workplace_ref) VALUES (?,?)').run(11, serializedA);
  addArtifact(db, { taskId: 10, executionId: 'exec-A', artifactId: 1, type: 'FR', hash: 'old-hash' });
  addArtifact(db, { taskId: 11, executionId: 'exec-B', artifactId: 1, type: 'FR', hash: 'new-hash', operation: 'update' });

  const production = new SqliteWorkplaceProductionResolver(db).read(workplaceA);
  assert.equal(production.artifacts.length, 1);
  assert.equal(production.artifacts[0].contentHash, 'new-hash');
  assert.equal(production.artifacts[0].executionId, 'exec-B');
});

test('P18-AC-4: CandidateSet freezes readable snapshot and fanout products coexist', () => {
  const { db, productRepo } = createDb();
  db.prepare('INSERT INTO tasks (id,workplace_ref) VALUES (?,?)').run(10, serializedA);
  db.prepare('INSERT INTO tasks (id,workplace_ref) VALUES (?,?)').run(20, serializedB);
  addArtifact(db, { taskId: 10, executionId: 'exec-A', artifactId: 1, type: 'FR', hash: 'hash-A' });
  addArtifact(db, { taskId: 20, executionId: 'exec-C', artifactId: 2, type: 'FR', hash: 'hash-B' });

  const resolver = new SqliteWorkplaceProductionResolver(db);
  const productPort = new SqliteWorkplaceProductAdapter(db, productRepo);
  const persistSnapshot = (workplace, serialized, presenter) => {
    const production = resolver.read(workplace);
    const snapshot = buildWorkplaceProductionSnapshot({
      workplaceRef: serialized,
      expectedSchemaRef: 'factory.test-bundle.v1',
      artifacts: production.artifacts,
      traces: production.traces,
    });
    return productPort.submitProduct({
      processRunId,
      nodeId,
      moduleRef,
      schema: 'factory.test-bundle.v1',
      content: snapshot,
      contentHash: sha256Hex(snapshot),
      executionRef: presenter,
    }).productRef;
  };

  const refA = persistSnapshot(workplaceA, serializedA, 'exec-A');
  const refB = persistSnapshot(workplaceB, serializedB, 'exec-C');
  assert.notEqual(refA.ref, refB.ref, 'same-schema fanout products have distinct exact refs');
  assert.equal(productPort.readNodeProducts(processRunId, nodeId).length, 2, 'both same-schema fanout snapshots coexist');

  const candidateRepo = new SqliteCandidateSetRepository(db);
  const sealed = candidateRepo.seal({
    workplaceRef: workplaceA,
    productionRevisionRef: 'rev-test-p18',
    role: 'author',
    subjectCandidateSetRef: null,
    members: [{ productRef: refA, origin: 'produced', sourceCandidateSetRef: null }],
    sealReceiptRef: 'seal:exec-B:author',
    candidateSetDigest: sha256Hex({ refA }),
    sealedAt: '2026-08-08T00:00:00.000Z',
  }).set;

  // Live desk changes after seal.
  db.prepare('INSERT INTO tasks (id,workplace_ref) VALUES (?,?)').run(11, serializedA);
  addArtifact(db, { taskId: 11, executionId: 'exec-D', artifactId: 3, type: 'NFR', hash: 'hash-D' });
  assert.equal(resolver.read(workplaceA).artifacts.length, 2);

  // Sealed exact ProductRef still resolves to original one-artifact snapshot.
  const stored = productPort.readProduct(sealed.members[0].productRef);
  assert.ok(stored);
  assert.equal(stored.content.artifacts.length, 1);
  assert.equal(stored.content.artifacts[0].artifactId, 1);
});
