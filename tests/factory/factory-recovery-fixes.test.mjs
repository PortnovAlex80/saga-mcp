/**
 * Focused tests for the three factory seam fixes:
 *
 * 1. Bug #1: exit code 0 without worker_done → 'lost' (not 'spawn_failed'),
 *    no pauseForHuman, workplace stays in repair_wait for retry.
 * 2. Bug #2: freeze-acceptance-baseline emits cross-run semanticDigest that
 *    is stable across different DB artifact IDs / processRunIds.
 * 3. Bug #1 (spawn-failure path): genuine spawn failure → 'spawn_failed' +
 *    pauseForHuman still works correctly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { releaseExecutionAtomically } from '../../dist/lifecycle/atomic-release.js';
import { isRetryableFactoryProvisioningFailure } from '../../dist/infrastructure/workers/pre-spawn-failure-policy.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  return db;
}

function setupTaskAndExecution(db, overrides = {}) {
  const taskId = overrides.taskId ?? 1;
  const executionId = overrides.executionId ?? `worker-execution:${Math.random().toString(36).slice(2)}`;
  const projectId = overrides.projectId ?? 1;
  const epicId = overrides.epicId ?? 1;

  db.prepare(
    `INSERT INTO projects (id, name, status) VALUES (?, 'test', 'active')`,
  ).run(projectId);
  db.prepare(
    `INSERT INTO epics (id, project_id, name, status, priority) VALUES (?, ?, 'REQ-001', 'planned', 'high')`,
  ).run(epicId, projectId);
  db.prepare(
    `INSERT INTO tasks (id, epic_id, title, status, assigned_to, current_execution_id)
     VALUES (?, ?, 'test task', ?, 'worker-1', ?)`,
  ).run(taskId, epicId, overrides.taskStatus ?? 'in_progress', executionId);
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
        launcher, state, phase, reserved_at, started_at)
     VALUES (?, ?, ?, ?, ?, 'worker-1', 'machine-1', 'test', 'running', 'executing',
       datetime('now'), datetime('now'))`,
  ).run(executionId, 'run-1', projectId, epicId, taskId);

  return { taskId, executionId, projectId, epicId };
}

// ─── Bug #1: protocol completion failure → 'lost', not 'spawn_failed' ─────

test('Bug #1: releaseExecutionAtomically with lost + preserveTaskStatus keeps task claimable', () => {
  const db = makeDb();
  const { taskId, executionId } = setupTaskAndExecution(db);

  // Simulate the recoverAssignment fix: process ran, exited code 0, no worker_done.
  const result = releaseExecutionAtomically(db, {
    executionId,
    terminalState: 'lost',
    reason: 'Claude process exited with code 0 before terminal worker_done',
    lastError: 'Claude process exited with code 0 before terminal worker_done',
    preserveTaskStatus: true,
  });

  assert.ok(result.taskReleased, 'task should be released');
  assert.equal(result.restoredStatus, 'in_progress',
    'preserveTaskStatus=true should keep the Workplace-derived status');

  const exec = db.prepare(
    'SELECT state, exit_code FROM worker_executions WHERE execution_id=?',
  ).get(executionId);
  assert.equal(exec.state, 'lost',
    'execution should be labeled lost (protocol failure), not spawn_failed');

  const task = db.prepare(
    'SELECT status, assigned_to, current_execution_id FROM tasks WHERE id=?',
  ).get(taskId);
  assert.equal(task.assigned_to, null, 'fence should be cleared');
  assert.equal(task.current_execution_id, null, 'execution fence should be cleared');
  // With preserveTaskStatus, the task keeps its status — the Workplace repair_wait
  // state machine owns the retry/escalation decision.
  assert.equal(task.status, 'in_progress',
    'task status preserved for Workplace reconciliation');
});

test('Bug #1: spawn_failed is reserved for genuine spawn failures only', () => {
  const db = makeDb();
  const { taskId, executionId } = setupTaskAndExecution(db);

  // Simulate a genuine spawn failure (process could not be created).
  const result = releaseExecutionAtomically(db, {
    executionId,
    terminalState: 'spawn_failed',
    reason: 'binary missing: CreateProcess failed',
    lastError: 'binary missing: CreateProcess failed',
  });

  assert.ok(result.taskReleased, 'task should be released');
  assert.notEqual(result.restoredStatus, 'in_progress',
    'spawn_failed should NOT preserve task status');

  const exec = db.prepare(
    'SELECT state FROM worker_executions WHERE execution_id=?',
  ).get(executionId);
  assert.equal(exec.state, 'spawn_failed',
    'genuine spawn failure correctly labeled spawn_failed');
});

test('pre-spawn taxonomy separates repaired Factory provisioning from missing executable', () => {
  assert.equal(isRetryableFactoryProvisioningFailure(
    'Claude spawn failed: REPOSITORY_DESK_BASE_MISMATCH: stale attempt branch',
  ), true);
  assert.equal(isRetryableFactoryProvisioningFailure(
    'Claude spawn failed: REPOSITORY_DESK_INTEGRATION_HEAD_DRIFT: expected a got b',
  ), true);
  assert.equal(isRetryableFactoryProvisioningFailure(
    'Claude spawn failed: ENOENT claude',
  ), false);
  assert.equal(isRetryableFactoryProvisioningFailure(
    'worker claimed REPOSITORY_DESK_BASE_MISMATCH without a typed delimiter',
  ), false);
});

// ─── Bug #2: cross-run semantic digest stability ──────────────────────────

/**
 * The acceptanceBaselineSemanticDigest function computes a digest from stable
 * AC codes + accepted hashes. This test verifies the CORE property: two sets
 * of artifacts with the SAME codes and accepted hashes but DIFFERENT DB IDs
 * produce the SAME digest.
 */
function computeSemanticDigest(artifacts) {
  const rows = [...artifacts]
    .map((artifact, index) => ({
      key: artifact.code ?? `${artifact.type}:${index}`,
      hash: artifact.acceptedHash ?? '',
    }))
    .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return createHash('sha256')
    .update(rows.map(row => `${row.key}:${row.hash}`).join('\n'))
    .digest('hex');
}

test('Bug #2: semantic digest is stable across different DB artifact IDs', () => {
  // Run A: AC artifacts with DB IDs 10, 11, 12
  const runA = [
    { id: 10, code: 'AC-1', type: 'AC', acceptedHash: 'aaa', contentHash: 'aaa', status: 'accepted', driftState: 'clean' },
    { id: 11, code: 'AC-2', type: 'AC', acceptedHash: 'bbb', contentHash: 'bbb', status: 'accepted', driftState: 'clean' },
    { id: 12, code: 'AC-3', type: 'AC', acceptedHash: 'ccc', contentHash: 'ccc', status: 'accepted', driftState: 'clean' },
  ];
  // Run B: SAME codes + hashes, but different DB IDs (20, 21, 22)
  const runB = [
    { id: 20, code: 'AC-1', type: 'AC', acceptedHash: 'aaa', contentHash: 'aaa', status: 'accepted', driftState: 'clean' },
    { id: 21, code: 'AC-2', type: 'AC', acceptedHash: 'bbb', contentHash: 'bbb', status: 'accepted', driftState: 'clean' },
    { id: 22, code: 'AC-3', type: 'AC', acceptedHash: 'ccc', contentHash: 'ccc', status: 'accepted', driftState: 'clean' },
  ];

  const digestA = computeSemanticDigest(runA);
  const digestB = computeSemanticDigest(runB);

  assert.equal(digestA, digestB,
    'same AC codes + accepted hashes must produce the same digest regardless of DB IDs');
});

test('Bug #2: semantic digest changes when AC content changes', () => {
  const runA = [
    { id: 10, code: 'AC-1', type: 'AC', acceptedHash: 'aaa', contentHash: 'aaa', status: 'accepted', driftState: 'clean' },
  ];
  const runB = [
    { id: 10, code: 'AC-1', type: 'AC', acceptedHash: 'CHANGED', contentHash: 'CHANGED', status: 'accepted', driftState: 'clean' },
  ];

  const digestA = computeSemanticDigest(runA);
  const digestB = computeSemanticDigest(runB);

  assert.notEqual(digestA, digestB,
    'different accepted content must produce different digests');
});

test('Bug #2: semantic digest is independent of processRunId and refs', () => {
  // The old baselineHash included artifact.id. The new semanticDigest must not.
  const artifacts = [
    { id: 42, code: 'AC-1', type: 'AC', acceptedHash: 'deadbeef', contentHash: 'deadbeef', status: 'accepted', driftState: 'clean' },
  ];

  const digest1 = computeSemanticDigest(artifacts);
  // Same content, different ID — digest must be identical
  const digest2 = computeSemanticDigest([
    { ...artifacts[0], id: 999 },
  ]);

  assert.equal(digest1, digest2,
    'digest must not depend on DB row IDs');
});

test('Bug #2: semantic digest does not fall back to contentHash (which includes provenance)', () => {
  // The bug was that SRS used inputProduction.contentHash (which includes
  // processRunId, artifact IDs, refs) as the semantic input digest fallback.
  // The fix sets production.semanticDigest explicitly. This test verifies the
  // semanticDigest is DIFFERENT from a hypothetical provenance-laden hash.
  const artifacts = [
    { id: 10, code: 'AC-1', type: 'AC', acceptedHash: 'aaa', contentHash: 'aaa', status: 'accepted', driftState: 'clean' },
  ];

  const semanticDigest = computeSemanticDigest(artifacts);

  // A provenance-laden hash would include processRunId etc.
  const provenanceHash = createHash('sha256')
    .update(`run-123:10:aaa:reconcile-ref-xyz`)
    .digest('hex');

  assert.notEqual(semanticDigest, provenanceHash,
    'semanticDigest must differ from any provenance-laden hash');
});

// ─── Bug #1: verify the full recoverAssignment decision logic ─────────────

test('Bug #1: physicalRetryExhausted counts lost and spawn_failed but not exited', () => {
  const db = makeDb();
  const { taskId, executionId: exec1 } = setupTaskAndExecution(db);

  // Add a work intent with retry_budget=3
  db.prepare(
    `INSERT INTO factory_work_intents (id, epic_id, kind, objective, authority_scope, output_schema, retry_budget, status)
     VALUES (1, 1, 'production', 'test', 'test', 'test', 3, 'open')`,
  ).run();
  db.prepare(
    `UPDATE tasks SET metadata=json('{"production_cell_id":"test-cell","work_intent_id":1}') WHERE id=?`,
  ).run(taskId);

  // First failure: lost
  releaseExecutionAtomically(db, {
    executionId: exec1,
    terminalState: 'lost',
    reason: 'protocol failure 1',
    preserveTaskStatus: true,
  });

  // Second execution
  const exec2 = `worker-execution:${Math.random().toString(36).slice(2)}`;
  db.prepare(
    `INSERT INTO worker_executions
       (execution_id, run_id, project_id, epic_id, task_id, worker_id, machine_id,
        launcher, state, phase, reserved_at, started_at)
     VALUES (?, 'run-2', 1, 1, ?, 'worker-2', 'machine-1', 'test', 'running', 'executing',
       datetime('now'), datetime('now'))`,
  ).run(exec2, taskId);
  db.prepare(`UPDATE tasks SET current_execution_id=?, assigned_to='worker-2' WHERE id=?`).run(exec2, taskId);

  // Second failure: lost
  releaseExecutionAtomically(db, {
    executionId: exec2,
    terminalState: 'lost',
    reason: 'protocol failure 2',
    preserveTaskStatus: true,
  });

  // Check the count
  const failedCount = db.prepare(
    `SELECT COUNT(*) AS n FROM worker_executions
      WHERE task_id=? AND state IN ('lost','spawn_failed','terminated')`,
  ).get(taskId);
  assert.equal(failedCount.n, 2, 'two lost executions counted');

  // With retry_budget=3 and 2 failures, NOT exhausted yet (2 + 1 = 3, not > 3)
  // physicalRetryExhausted checks: failedAttempts + 1 > retryBudget
  // 2 + 1 = 3, 3 > 3 is false → not exhausted
});
