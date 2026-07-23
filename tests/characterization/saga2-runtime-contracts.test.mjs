import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = relativePath => readFileSync(path.join(root, relativePath), 'utf8');

const requiredFiles = [
  'src/index.ts',
  'src/db.ts',
  'src/schema.ts',
  'src/orchestrate.ts',
  'src/orchestrate-cli.ts',
  'src/tools/dispatcher.ts',
  'src/tools/lifecycle.ts',
  'src/tools/workflow.ts',
  'src/worker-executions.ts',
  'src/application/ports/worker-executor.ts',
  'src/application/ports/engine-administration.ts',
  'src/infrastructure/workers/legacy-claude-worker-executor-factory.ts',
  'src/infrastructure/engine/legacy-engine-administration.ts',
  'src/infrastructure/projections/sqlite-board-projection-reader.ts',
  'tracker-view/tracker-view.mjs',
  'tracker-view/claude-runner.mjs',
  'tests/mock-claude.mjs',
  'tests/product-workflow.test.mjs',
  'tests/e2e-pipeline.test.mjs',
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
  assert.equal(pkg.scripts['test:e2e'], 'tsc && node --test tests/e2e-pipeline.test.mjs');
  assert.equal(
    pkg.scripts['mock:run'],
    'SAGA_CLAUDE_PATH="node tests/mock-claude.mjs" node dist/orchestrate-cli.js',
  );
});

test('Saga 2 cross-process runtime files remain present', () => {
  for (const relativePath of requiredFiles) {
    assert.ok(existsSync(path.join(root, relativePath)), `missing stable runtime surface: ${relativePath}`);
  }
});

test('orchestration keeps its stable decision and lifecycle anchors', () => {
  const source = read('src/orchestrate.ts');
  assertIncludesAll(source, [
    'workerExecutorFactory',
    'persistence',
    'generateNextForCompletedTask',
    'lifecycleHandlers',
    "discovery: 'formalization'",
    "formalization: 'planning'",
    "planning: 'development'",
    "development: 'verification'",
    "verification: 'integration'",
    "integration: 'completed'",
  ], 'src/orchestrate.ts');
});

test('persistence adapters keep the moved SQLite and execution anchors', () => {
  const source = read('src/infrastructure/persistence/sqlite-saga2-runtime-repositories.ts');
  assertIncludesAll(source, [
    'episode_workflows',
    'worker_executions',
    'task_dependencies',
    'createRecoveryTask',
    'reconcileWorkerExecutions',
    'reevaluateDownstream',
    'active_model_effort',
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
  assertIncludesAll(source, [
    'createClaudeBoardRunner',
    'dispatcherHandlers.worker_next',
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
  const source = read('tracker-view/tracker-view.mjs');
  assertIncludesAll(source, [
    "{ key: 'todo'",
    "{ key: 'in_progress'",
    "{ key: 'review'",
    "{ key: 'review_in_progress'",
    "{ key: 'done'",
    "{ key: 'blocked'",
    'episode_stage',
    'gate_error',
    'needs_human',
    'evidence_count',
    'artifact_traces',
    '/api/worker/tail',
    '/api/engine/',
    '/api/model/',
    'DB_PATH',
  ], 'tracker-view/tracker-view.mjs');
});

test('existing behavioral suites remain part of the Phase A safety net', () => {
  const e2e = read('tests/e2e-pipeline.test.mjs');
  assertIncludesAll(e2e, [
    'verification',
    'integration',
    "assert.equal(episode.stage, 'completed'",
    "assert.equal(v.status, 'done'",
    "assert.equal(i.status, 'done'",
  ], 'tests/e2e-pipeline.test.mjs');

  const workflow = read('tests/product-workflow.test.mjs');
  assert.ok(workflow.length > 1000, 'product workflow characterization suite unexpectedly disappeared');
});
