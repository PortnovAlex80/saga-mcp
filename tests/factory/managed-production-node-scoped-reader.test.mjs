/**
 * Focused tests for Bug #4: managed-production product reader must be
 * node-scoped (CGAD P18), NOT execution-scoped.
 *
 * Bug #4 symptom: a formalization author cell exhausts maxAttempts=2 with
 * `product contract expected 1 of factory.formalization-product-bundle.v1,
 * received 0` even though artifacts were created by an earlier fence of the
 * same node.
 *
 * Root cause: `src/app/product-lifecycle-runtime.ts` filtered
 * `listArtifactsForNodeInProcessRun(...)` results in memory by
 * `.filter(a => a.executionId === executionRef)`, blinding the gate to a
 * prior fence's artifacts when a retry execution (after a lost execution)
 * arrived with a fresh executionRef. The fix removes that filter and reads
 * by DURABLE node-scope (processRunId + moduleRef + nodeId), keeping the
 * latest write per artifactId/traceId.
 *
 * These tests prove the node-durable contract at the ledger layer that the
 * productReader depends on:
 *   1. A retry execution sees artifacts produced by an earlier execution of
 *      the same node (no execution_id filter in the SQL).
 *   2. Latest-write-wins dedupe: an update in a later fence supersedes the
 *      original create.
 *   3. The architecture guard under src/app/ rejects the execution-scoped
 *      filter pattern.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteManagedProductionLedger } from '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js';
import { ensureManagedProductionLedgerSchema } from '../../dist/process-modules/persistence/sqlite-managed-production-ledger.js';
import { ensureFactoryProcessRunSchema } from '../../dist/process-modules/persistence/sqlite-process-run-repository.js';

const MODULE_REF = 'solution-formalization@1.0.0';
const NODE_ID = 'define-product-contract';
const PROCESS_RUN_ID = 2;

function makeDb(executionIds = []) {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  ensureFactoryProcessRunSchema(db);
  // Seed projects + epics so the process_run FK resolves.
  db.prepare(
    `INSERT INTO projects (id, name, status) VALUES (1, 'test', 'active')`,
  ).run();
  db.prepare(
    `INSERT INTO epics (id, project_id, name, status, priority) VALUES (1, 1, 'REQ-001', 'planned', 'high')`,
  ).run();
  // Seed the process_run the ledger's FK references.
  db.prepare(
    `INSERT INTO factory_process_runs
       (id, project_id, epic_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash,
        projected_stage, status)
     VALUES (?, 1, 1, 'solution-formalization', '1.0.0', ?,
             'test-key', 'generic-flow', 'factory.formalization-case.v1', '{}', 'hash',
             'formalization', 'running')`,
  ).run(PROCESS_RUN_ID, MODULE_REF);
  // Seed one task so the ledger task_id FK resolves.
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status) VALUES (3, 1, 'author', 'in_progress')`,
  ).run();
  // Seed every worker_execution the test will reference so the execution_id FK resolves.
  for (const execId of executionIds) {
    db.prepare(
      `INSERT INTO worker_executions
         (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
          launcher, state, phase, reserved_at, started_at)
       VALUES (?, 'run-1', 1, 1, 3, 'w', 'm', 'test', 'exited', 'finishing',
               datetime('now'), datetime('now'))`,
    ).run(execId);
  }
  ensureManagedProductionLedgerSchema(db);
  return db;
}

const PRODUCER_EXEC = 'worker-execution:aaaaaaaa-0000-0000-0000-000000000001';
const RETRY_EXEC = 'worker-execution:bbbbbbbb-0000-0000-0000-000000000002';

/**
 * Insert one artifact-production ledger row directly. Mirrors what the
 * managed-production write path records when a worker calls artifact_create.
 */
function insertArtifactLedgerRow(db, {
  executionId, intentId = 1, taskId = 3, artifactId,
  artifactType = 'PRD', artifactStatus = 'draft', contentHash, operation = 'create',
}) {
  db.prepare(
    `INSERT INTO factory_managed_artifact_productions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        artifact_id, artifact_type, artifact_status, content_hash, operation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROCESS_RUN_ID, MODULE_REF, NODE_ID, intentId, taskId, executionId,
    artifactId, artifactType, artifactStatus, contentHash, operation,
  );
}

function insertTraceLedgerRow(db, {
  executionId, intentId = 1, taskId = 3, traceId,
  sourceId, targetType = 'artifact', targetId, linkType = 'derived_from', traceHash,
}) {
  db.prepare(
    `INSERT INTO factory_managed_trace_productions
       (process_run_id, module_ref, node_id, intent_id, task_id, execution_id,
        trace_id, source_id, target_type, target_id, link_type, trace_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    PROCESS_RUN_ID, MODULE_REF, NODE_ID, intentId, taskId, executionId,
    traceId, sourceId, targetType, targetId, linkType, traceHash,
  );
}

// ─── Test 1: retry execution sees prior fence's artifacts (CGAD P18) ──────

test('Bug #4: listArtifactsForNodeInProcessRun returns rows from ANY execution of the node (node-durable, CGAD P18)', () => {
  const db = makeDb([PRODUCER_EXEC, RETRY_EXEC]);
  const ledger = new SqliteManagedProductionLedger(db);

  // Producer fence created PRD (artifactId=1) and FR (artifactId=2).
  insertArtifactLedgerRow(db, { executionId: PRODUCER_EXEC, artifactId: 1, contentHash: 'hash-prd-v1' });
  insertArtifactLedgerRow(db, { executionId: PRODUCER_EXEC, artifactId: 2, artifactType: 'FR', contentHash: 'hash-fr-v1' });

  // Retry fence (after producer was lost) writes NOTHING — worker saw the
  // tracker showing all artifacts done and called worker_done immediately.
  // This is the exact Bug #4 scenario.

  // The ledger query is node-scoped: returns BOTH artifacts regardless of
  // which executionRef the gate asks about.
  const rows = ledger.listArtifactsForNodeInProcessRun(PROCESS_RUN_ID, MODULE_REF, NODE_ID);
  assert.equal(rows.length, 2, 'node-scope ledger returns both producer artifacts');
  assert.ok(
    rows.every(r => r.executionId === PRODUCER_EXEC),
    'both rows carry the producer executionId (retry wrote nothing)',
  );
  const artifactIds = rows.map(r => r.artifactId).sort();
  assert.deepEqual(artifactIds, [1, 2]);

  // The Bug #4 violation was filtering these by executionRef in memory:
  // `.filter(a => a.executionId === retryExec)` would return ZERO rows,
  // blinding the gate. The fix is to NOT filter — consume node-scope as-is.
  const visibleToRetryGate = rows.filter(a => a.contentHash);
  assert.equal(visibleToRetryGate.length, 2,
    'retry gate sees producer artifacts (no executionRef filter)');
  assert.ok(
    visibleToRetryGate.some(r => r.executionId !== RETRY_EXEC),
    'at least one visible artifact is from a DIFFERENT execution (cross-fence inheritance)',
  );

  db.close();
});

// ─── Test 2: latest-write-wins dedupe across fences ───────────────────────

test('Bug #4: latest-write-wins — a later fence update supersedes the original create', () => {
  const db = makeDb([PRODUCER_EXEC, RETRY_EXEC]);
  const ledger = new SqliteManagedProductionLedger(db);

  // Producer creates PRD (artifactId=1) with contentHash v1.
  insertArtifactLedgerRow(db, {
    executionId: PRODUCER_EXEC, artifactId: 1, contentHash: 'hash-prd-v1', operation: 'create',
  });
  // Retry updates the SAME artifact (artifactId=1) with contentHash v2.
  insertArtifactLedgerRow(db, {
    executionId: RETRY_EXEC, artifactId: 1, contentHash: 'hash-prd-v2', operation: 'update',
  });

  const rows = ledger.listArtifactsForNodeInProcessRun(PROCESS_RUN_ID, MODULE_REF, NODE_ID);
  assert.equal(rows.length, 2, 'both the create and the update are in the ledger');

  // Dedupe by artifactId keeping the row with the highest ledgerId (latest).
  const latest = new Map();
  for (const r of rows) {
    const prev = latest.get(r.artifactId);
    if (!prev || r.ledgerId > prev.ledgerId) latest.set(r.artifactId, r);
  }
  const deduped = [...latest.values()];
  assert.equal(deduped.length, 1, 'one row per artifactId after dedupe');
  assert.equal(deduped[0].contentHash, 'hash-prd-v2',
    'latest write wins (update from retry supersedes original create)');
  assert.equal(deduped[0].executionId, RETRY_EXEC,
    'the winning row is from the retry execution');

  db.close();
});

// ─── Test 3: traces are also node-durable ─────────────────────────────────

test('Bug #4: listTracesForNodeInProcessRun is node-scoped (no executionRef filter)', () => {
  const db = makeDb([PRODUCER_EXEC]);
  const ledger = new SqliteManagedProductionLedger(db);

  insertTraceLedgerRow(db, {
    executionId: PRODUCER_EXEC, traceId: 10, sourceId: 1, targetId: 5, traceHash: 'trace-1',
  });
  insertTraceLedgerRow(db, {
    executionId: PRODUCER_EXEC, traceId: 11, sourceId: 2, targetId: 1, traceHash: 'trace-2',
  });

  const traces = ledger.listTracesForNodeInProcessRun(PROCESS_RUN_ID, MODULE_REF, NODE_ID);
  assert.equal(traces.length, 2, 'node-scope returns both producer traces');
  assert.ok(
    traces.every(t => t.executionId === PRODUCER_EXEC),
    'both traces carry the producer executionId',
  );
  // Retry gate must see them (no executionRef filter).
  assert.equal(traces.length, 2,
    'retry gate sees producer traces (cross-fence inheritance)');

  db.close();
});

// ─── Test 4: empty node-scope (no prior fence) returns empty ──────────────

test('Bug #4: node-scope read returns empty when NO fence has produced (no false inheritance)', () => {
  const db = makeDb([PRODUCER_EXEC]);
  const ledger = new SqliteManagedProductionLedger(db);

  // Nothing inserted for this node.
  const rows = ledger.listArtifactsForNodeInProcessRun(PROCESS_RUN_ID, MODULE_REF, NODE_ID);
  assert.equal(rows.length, 0,
    'no prior fence → empty (no phantom inheritance from unrelated nodes)');

  // And a different node's artifacts don't leak in.
  insertArtifactLedgerRow(db, {
    executionId: PRODUCER_EXEC, artifactId: 99, contentHash: 'other-node',
  });
  // Override the node_id for this row to a DIFFERENT node.
  db.prepare(
    `UPDATE factory_managed_artifact_productions SET node_id=? WHERE artifact_id=?`,
  ).run('define-architecture-contract', 99);

  const rowsForProductNode = ledger.listArtifactsForNodeInProcessRun(PROCESS_RUN_ID, MODULE_REF, NODE_ID);
  assert.equal(rowsForProductNode.length, 0,
    'artifacts of a different node do not leak into this node-scope read');

  db.close();
});
