/**
 * C-1 (stage-11 PREVENTIVE-HUNT Layer 6) — the endpoint contract is frozen into
 * the execution context at claim time.
 *
 * The claim transaction must resolve the worker's backend coordinates ONCE and
 * persist them inside worker_executions.metadata.execution_context.model_route:
 *
 *   - provider 'zai' via the agent-proxy shim → endpoint { backend:
 *     'agent-proxy' } — the shim owns routing; settings.json is never consulted;
 *   - provider 'lmstudio' → endpoint { backend: 'lmstudio', base_url:
 *     <SAGA_LMSTUDIO_URL at claim> };
 *   - plain claude-cli → endpoint { backend: 'claude-cli' } (auth contract
 *     stays in ~/.claude/settings.json, but the choice is recorded as
 *     provenance).
 *
 * Additive-field discipline: `endpoint` is OPTIONAL on ExecutionModelRoute so
 * pre-existing frozen snapshots stay byte-identical and hash-valid. The strict
 * gateway (readExecutionContextStrict) must pass the field through so the
 * recomputed execution_context_hash still matches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-endpoint-freeze-'));
process.env.DB_PATH = path.join(temp, 'endpoint-freeze.db');
const repoPath = path.join(temp, 'repo');
mkdirSync(repoPath);

const { closeDb, getDb } = await import('../../dist/db.js');
const { handlers: projects } = await import('../../dist/tools/projects.js');
const { handlers: epics } = await import('../../dist/tools/epics.js');
const { handlers: repositories } = await import('../../dist/tools/repositories.js');
const { handlers: tasks } = await import('../../dist/tools/tasks.js');
const { SqliteWorkAssignmentAdapter } = await import('../../dist/infrastructure/work/sqlite-work-assignment-adapter.js');
const { readExecutionContextStrict } = await import('../../dist/shared/authority/authorize-tool-call.js');
const { executionContextHash } = await import('../../dist/shared/authority/execution-context.js');

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

function stampProcessRun(taskId, processRunId = 1) {
  const db = getDb();
  const row = db.prepare(
    `SELECT t.metadata,t.epic_id,e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?`,
  ).get(taskId);
  db.prepare(
    `INSERT OR IGNORE INTO factory_process_runs
      (id,project_id,epic_id,module_name,module_version,module_ref_key,idempotency_key,
       executor_kind,input_schema,input_snapshot,input_hash,status)
     VALUES (?,?,?,'test-module','1.0.0','test-module@1.0.0',?,
             'generic-flow','test.input.v1','{}',?,'running')`,
  ).run(processRunId, row.project_id, row.epic_id, `test-process:${processRunId}`, 'a'.repeat(64));
  let meta = {};
  try { meta = JSON.parse(row.metadata || '{}'); } catch { meta = {}; }
  meta.process_run_id = processRunId;
  db.prepare('UPDATE tasks SET metadata=? WHERE id=?').run(JSON.stringify(meta), taskId);
}

function setupEpic(controls) {
  const p = projects.project_create({ name: `endpoint-freeze-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
  repositories.repository_register({ project_id: p.id, name: 'r', local_path: repoPath });
  const e = epics.epic_create({ project_id: p.id, name: 'E' });
  if (controls) {
    getDb().prepare(
      `INSERT INTO lifecycle_execution_controls
         (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
       VALUES (?,?,?,?,?,?)`,
    ).run(e.id, controls.concurrency ?? 2, controls.provider ?? 'zai', controls.model ?? null,
      controls.effort ?? null, controls.limit ?? 2);
  }
  return { projectId: p.id, epicId: e.id };
}

function frozenRouteFor(executionId) {
  const row = getDb().prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get(executionId);
  assert.ok(row, `worker_executions row for ${executionId}`);
  const envelope = JSON.parse(row.metadata);
  return { envelope, route: envelope.execution_context.model_route };
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('claim freezes the LM Studio endpoint coordinates into model_route.endpoint', () => {
  const { projectId, epicId } = setupEpic({
    provider: 'lmstudio', model: 'qwen3.6-35b', effort: null, limit: 4,
  });
  const task = tasks.task_create({ epic_id: epicId, title: 'lmstudio freeze' });
  stampProcessRun(task.id);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());

  const work = withEnv({ SAGA_LMSTUDIO_URL: 'http://frozen-lm:1234/v1' }, () =>
    adapter.assignTask({
      projectId, epicId, workerId: 'w-lm', workerExecutionId: 'exec-lm-1',
      runId: 'r1', machineId: 'm1',
    }));

  assert.notEqual(work, null);
  const { route } = frozenRouteFor('exec-lm-1');
  assert.deepEqual(route.endpoint, {
    backend: 'lmstudio', base_url: 'http://frozen-lm:1234/v1',
  }, 'the LM Studio URL must be frozen at claim, never re-read at spawn');
});

test('claim freezes the agent-proxy shim marker when the engine runs workers through the shim', () => {
  const { projectId, epicId } = setupEpic({
    provider: 'zai', model: 'glm-4.7', effort: 'high', limit: 2,
  });
  const task = tasks.task_create({ epic_id: epicId, title: 'shim freeze' });
  stampProcessRun(task.id, 2);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());

  const work = withEnv({
    SAGA_REAL_CLAUDE_PATH: 'node D:/tools/agent-proxy/claude-shim.mjs',
  }, () => adapter.assignTask({
    projectId, epicId, workerId: 'w-shim', workerExecutionId: 'exec-shim-1',
    runId: 'r1', machineId: 'm1',
  }));

  assert.notEqual(work, null);
  const { route } = frozenRouteFor('exec-shim-1');
  assert.deepEqual(route.endpoint, {
    backend: 'agent-proxy', base_url: null,
  }, 'the shim route marker must be frozen at claim');
});

test('claim freezes the plain claude-cli backend marker when no shim and no lmstudio provider', () => {
  const { projectId, epicId } = setupEpic({
    provider: 'zai', model: 'glm-4.7', effort: 'high', limit: 2,
  });
  const task = tasks.task_create({ epic_id: epicId, title: 'plain freeze' });
  stampProcessRun(task.id, 3);
  const adapter = new SqliteWorkAssignmentAdapter(getDb());

  const work = adapter.assignTask({
    projectId, epicId, workerId: 'w-plain', workerExecutionId: 'exec-plain-1',
    runId: 'r1', machineId: 'm1',
  });

  assert.notEqual(work, null);
  const { route } = frozenRouteFor('exec-plain-1');
  assert.deepEqual(route.endpoint, {
    backend: 'claude-cli', base_url: null,
  }, 'the plain claude backend must be recorded as provenance');
});

test('strict gateway accepts a frozen context carrying model_route.endpoint (hash passthrough)', () => {
  const { projectId, epicId } = setupEpic(null);
  const task = tasks.task_create({ epic_id: epicId, title: 'gateway passthrough' });
  stampProcessRun(task.id, 4);

  // Seed exactly what a post-fix claim produces: a full execution context whose
  // model_route carries endpoint coordinates, hashed with executionContextHash.
  const context = {
    policy_version: 'factory.execution.v2',
    work_intent_id: null,
    authority: null,
    model_route: {
      provider: 'lmstudio', model: 'qwen3.6-35b', effort: null,
      endpoint: { backend: 'lmstudio', base_url: 'http://gateway-lm:1234/v1' },
    },
    executor_kind: 'claude-cli',
    route_policy: null,
    replay: null,
    captured_at: new Date().toISOString(),
  };
  getDb().prepare(
    `UPDATE tasks SET status='in_progress', current_execution_id='exec-gateway-1' WHERE id=?`,
  ).run(task.id);
  getDb().prepare(
    `INSERT INTO worker_executions
       (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,state,phase,metadata)
     VALUES ('exec-gateway-1','r',?,?,?,?,?,'reserved','executing',?)`,
  ).run(projectId, epicId, task.id, 'w-gateway', 'm1', JSON.stringify({
    execution_context: context,
    execution_context_hash: executionContextHash(context),
  }));

  const strict = readExecutionContextStrict(getDb(), 'exec-gateway-1');
  assert.equal(strict.ok, true,
    `the strict gateway must pass endpoint-bearing routes through the hash check: ${strict.ok ? '' : strict.reason}`);
  assert.deepEqual(strict.ok && strict.snapshot.model_route.endpoint, {
    backend: 'lmstudio', base_url: 'http://gateway-lm:1234/v1',
  });
});
