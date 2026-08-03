import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// saga4 cutover: this file characterises the SHARED runtime infrastructure
// (host runtime, persistence repositories, worker factory, model route,
// tracker-view board projection). The pump-characterisation tests
// (src/orchestrate.ts, src/engines/saga2-engine.ts, tests/e2e-pipeline.test.mjs)
// were removed in Phase 3 — the legacy Saga2 engine is gone; saga3 e2e coverage
// lives in tests/execution/* and tests/process-modules/*.

const root = path.resolve(import.meta.dirname, '..', '..');
const read = relativePath => readFileSync(path.join(root, relativePath), 'utf8');

const requiredFiles = [
  'src/index.ts',
  'src/db.ts',
  'src/schema.ts',
  'src/orchestrate-cli.ts',
  'src/tools/dispatcher.ts',
  'src/tools/lifecycle.ts',
  'src/worker-executions.ts',
  'src/application/ports/worker-executor.ts',
  'src/application/ports/saga2-host-runtime.ts',
  'src/application/ports/engine-administration.ts',
  'src/infrastructure/workers/legacy-claude-worker-executor-factory.ts',
  'src/infrastructure/engine/legacy-engine-administration.ts',
  'src/infrastructure/runtime/node-saga2-host-runtime.ts',
  'src/infrastructure/projections/sqlite-board-projection-reader.ts',
  'tracker-view/tracker-view.mjs',
  'tracker-view/claude-runner.mjs',
  'tests/mock-claude.mjs',
  'tests/product-workflow.test.mjs',
];

function assertIncludesAll(text, values, surface) {
  for (const value of values) {
    assert.ok(text.includes(value), `${surface} lost contract anchor: ${value}`);
  }
}

test('Saga 2 package entrypoints remain compatible', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, '2.0.0');
  assert.equal(pkg.main, 'dist/index.js');
  assert.equal(pkg.bin?.['saga-mcp'], 'dist/index.js');
  assert.equal(pkg.scripts.build, 'tsc');
  assert.equal(pkg.scripts.start, 'node dist/index.js');
  assert.equal(pkg.scripts.tracker, 'node tracker-view/tracker-view.mjs');
  assert.equal(pkg.scripts['docs-graph'], 'node tracker-view/docs-graph/server.mjs');
  assert.equal(pkg.scripts.test, 'tsc && node --test');
  assert.equal(
    pkg.scripts['mock:run'],
    'SAGA_CLAUDE_PATH="node tests/mock-claude.mjs" node dist/orchestrate-cli.js',
  );
});

test('Shared runtime files remain present', () => {
  for (const relativePath of requiredFiles) {
    assert.ok(existsSync(path.join(root, relativePath)), `missing stable runtime surface: ${relativePath}`);
  }
});

test('Node host adapter preserves PID, heartbeat and JSONL contracts', () => {
  const source = read('src/infrastructure/runtime/node-saga2-host-runtime.ts');
  // Commit e03d613 (D.4) removed dead scanRateLimitSignals: the RATE_LIMIT_PATTERN
  // (which carried 'error_status":429') and the 'board-runs' logRoot fallback were
  // both deleted from this surface. 'board-runs' is still pinned where it lives —
  // against tracker-view/claude-runner.mjs / tracker-view.mjs (the tracker view's
  // JSONL log root). Only the durable PID/heartbeat/lock anchors remain here.
  assertIncludesAll(source, [
    "flag: 'wx'",
    'process.kill(pid, 0)',
    'engine-heartbeat.log',
    'releaseEngineLock',
  ], 'node-saga2-host-runtime.ts');
});

test('persistence adapters keep the moved SQLite and execution anchors', () => {
  const source = read('src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts');
  // Commit f6c26a5: readWorkerModelRoute now reads model effort from the
  // lifecycle_execution_controls columns (model_name / model_provider /
  // model_effort) instead of the legacy episode_workflows.metadata
  // 'active_model_effort' key. The anchor is the new column name.
  assertIncludesAll(source, [
    'episode_workflows',
    'worker_executions',
    'task_dependencies',
    'createRecoveryTask',
    'reconcileWorkerExecutions',
    'reevaluateDownstream',
    'model_effort',
    'readWorkerModelRoute',
  ], 'sqlite-saga2-runtime-repositories.ts');
});

test('model route remains model-config-driven across the worker boundary', () => {
  const runner = read('tracker-view/claude-runner.mjs');
  const factory = read('src/infrastructure/workers/legacy-claude-worker-executor-factory.ts');
  assertIncludesAll(runner, [
    "const effortArg = isLmstudio ? null : (am.effort || 'high');",
    "args.splice(modelIdx + 2, 0, '--effort', effortArg);",
  ], 'claude-runner.mjs');
  assert.ok(!runner.includes("'--effort', 'xhigh'"), 'xhigh must not be hardcoded');
  assertIncludesAll(factory, [
    'modelRouteReader',
    'getActiveModel: modelRouteReader',
  ], 'legacy-claude-worker-executor-factory.ts');
});

test('worker infrastructure keeps claim, recovery and concrete runner anchors', () => {
  const source = read('src/infrastructure/workers/legacy-claude-worker-executor-factory.ts');
  // Slice 1 (saga4, commit 49ac316) removed the runner's internal claimTask
  // callback — the runner is now a one-card host and the dispatcher pre-assigns
  // the card via WorkAssignmentPort before launch. The old
  // `dispatcherHandlers.worker_next` anchor (which lived inside the deleted
  // claimTask callback) is therefore replaced by `workAssignment`, the new
  // pre-assignment port the factory wires into the runner. `getTask` is also
  // asserted (required by assignmentFromAssignedWork).
  assertIncludesAll(source, [
    'createClaudeBoardRunner',
    'workAssignment',
    'getTask',
    'recoverLegacyAssignment',
    'getActiveModel',
    'lmstudioBaseUrl',
    'ClaudeBoardWorkerExecutor',
  ], 'legacy-claude-worker-executor-factory.ts');
});

test('worker runner keeps the assignment, fencing, provider, logging, and MCP protocol', () => {
  const source = read('tracker-view/claude-runner.mjs');
  assertIncludesAll(source, [
    'task_id=',
    'worker_id=',
    'execution_id=',
    'dispatcher_skill=',
    'task_kind=',
    'workflow_stage=',
    'execution_mode=',
    'worker_done exactly once',
    'verification_record',
    'worker_merge_acquire',
    'worker_merge_release',
    'SAGA_CLAUDE_PATH',
    'SAGA_LMSTUDIO_URL',
    'DB_PATH',
    'TRACKER_AUTOSTART',
    'worker-heartbeat.log',
    'board-runs',
  ], 'tracker-view/claude-runner.mjs');
});

test('tracker keeps the stable board, artifact, workflow, and worker projection', () => {
  // T10 step 7: the board-rendering HTML moved to tracker-view/board-render.mjs.
  // The HTTP core (COLS map, routes, DB_PATH) stays in tracker-view.mjs; the
  // board tokens that live inside the rendered HTML (episode_stage, gate_error,
  // needs_human, evidence_count) moved with the renderers. Assert each set
  // against the file that now owns it.
  const source = read('tracker-view/tracker-view.mjs');
  assertIncludesAll(source, [
    "{ key: 'todo'",
    "{ key: 'in_progress'",
    "{ key: 'review'",
    "{ key: 'review_in_progress'",
    "{ key: 'done'",
    "{ key: 'blocked'",
    'artifact_traces',
    '/api/worker/tail',
    '/api/engine/',
    '/api/model/',
    'DB_PATH',
  ], 'tracker-view/tracker-view.mjs');
  const boardSource = read('tracker-view/board-render.mjs');
  assertIncludesAll(boardSource, [
    'episode_stage',
    'gate_error',
    'needs_human',
    'evidence_count',
    'artifact_traces',
  ], 'tracker-view/board-render.mjs');
});

test('product-workflow characterization suite remains present', () => {
  const workflow = read('tests/product-workflow.test.mjs');
  assert.ok(workflow.length > 1000, 'product workflow characterization suite unexpectedly disappeared');
});
