// End-to-end smoke test of the autonomous orchestration engine using
// mock-claude.mjs as a subprocess replacement for claude.exe.
//
// The test seeds a minimal episode that has already cleared discovery +
// formalization + planning + development. The engine then has to drive it
// through:
//   verification  →  mock worker calls verification_record + worker_done
//   integration   →  mock worker calls worker_merge_acquire + git merge
//                     (empty commit) + worker_merge_release(merged)
//   completed     →  episode_transition passes the final gate
//
// The full discovery→formalization chain is covered by product-workflow.test.mjs.
// This file focuses on the engine pump loop + close-handler + mock-claude
// contract — the surface that cannot be unit-tested with handler calls alone.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import test from 'node:test';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-e2e-'));
process.env.DB_PATH = path.join(temp, 'e2e.db');

// Workspace for the mock project — must be a real git repo because the
// verification/integration tasks are execution_mode='git_change'.
const workspace = path.join(temp, 'workspace');
mkdirSync(workspace);
execFileSync('git', ['init', '-b', 'dev'], { cwd: workspace });
execFileSync('git', ['config', 'user.email', 'e2e@test'], { cwd: workspace });
execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: workspace });
writeFileSync(path.join(workspace, 'README.md'), 'seed\n');
execFileSync('git', ['add', '.'], { cwd: workspace });
execFileSync('git', ['commit', '-m', 'seed'], { cwd: workspace });

const sagaRoot = path.resolve(import.meta.dirname, '..');

// Handlers must be imported AFTER process.env.DB_PATH is set.
const { handlers: projects } = await import('../dist/tools/projects.js');
const { handlers: epics } = await import('../dist/tools/epics.js');
const { handlers: tasks } = await import('../dist/tools/tasks.js');
const { handlers: repositories } = await import('../dist/tools/repositories.js');
const { handlers: artifacts } = await import('../dist/tools/artifacts.js');
const { closeDb, getDb } = await import('../dist/db.js');
const { orchestrate } = await import('../dist/orchestrate.js');
const { createLegacyClaudeWorkerExecutorFactory } = await import(
  '../dist/infrastructure/workers/legacy-claude-worker-executor-factory.js'
);
const {
  SqliteEpisodeRuntimeRepository,
  SqliteExecutionRuntimeRepository,
  SqliteTaskRuntimeRepository,
} = await import('../dist/infrastructure/persistence/sqlite-saga2-runtime-repositories.js');
const { SqliteWorkspaceResolver } = await import(
  '../dist/infrastructure/workspaces/sqlite-workspace-resolver.js'
);
const { NodeSaga2HostRuntime } = await import(
  '../dist/infrastructure/runtime/node-saga2-host-runtime.js'
);

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});

function hashOf(content) {
  return createHash('sha256').update(content).digest('hex');
}

function seedEpisode() {
  const db = getDb();

  const project = projects.project_create({ name: 'E2E Mock Project' });
  const repo = repositories.repository_register({
    project_id: project.id, name: 'mock-repo', local_path: workspace,
    default_branch: 'dev', integration_branch: 'dev',
  });
  repositories.repository_checkout_register({
    project_repository_id: repo.id, machine_id: os.hostname(), local_path: workspace,
  });

  const epic = epics.epic_create({ project_id: project.id, name: 'REQ-e2e-mock' });

  db.prepare(
    `INSERT INTO episode_workflows (epic_id, stage) VALUES (?, 'verification')`,
  ).run(epic.id);

  const acContent = '# AC-1\n\nGiven the mock, When the worker runs, Then it exits 0.\n';
  const acHash = hashOf(acContent);
  writeFileSync(path.join(temp, 'AC.md'), acContent);
  const ac = artifacts.artifact_create({
    project_id: project.id, epic_id: epic.id, type: 'AC', code: 'AC-1',
    title: 'Mock AC-1', path: path.join(temp, 'AC.md'),
    status: 'accepted', content_hash: acHash,
  });
  db.prepare(`UPDATE artifacts SET accepted_hash=? WHERE id=?`).run(acHash, ac.id);

  const verify = tasks.task_create({
    epic_id: epic.id,
    title: 'VERIFY AC-1: mock worker exits 0',
    task_kind: 'verification.ac',
    workflow_stage: 'verification',
    execution_skill: 'saga-verifier',
    execution_mode: 'tracker_only',
    project_repository_id: repo.id,
    priority: 'high',
    source_artifact_ids: [ac.id],
  });
  db.prepare(`UPDATE tasks SET verification_target_artifact_id=? WHERE id=?`).run(ac.id, verify.id);

  const integrate = tasks.task_create({
    epic_id: epic.id,
    title: 'INTEGRATE: merge mock-branch into dev',
    task_kind: 'integration.merge',
    workflow_stage: 'integration',
    execution_skill: 'saga-worker',
    execution_mode: 'tracker_only',
    project_repository_id: repo.id,
    priority: 'high',
    depends_on: [verify.id],
    source_artifact_ids: [ac.id],
  });

  return { project, epic, verify, integrate };
}

test('e2e: engine drives verification → integration → completed with mock-claude', async () => {
  const { project, epic, verify, integrate } = seedEpisode();

  const persistence = {
    episodes: new SqliteEpisodeRuntimeRepository(),
    tasks: new SqliteTaskRuntimeRepository(),
    executions: new SqliteExecutionRuntimeRepository(),
    workspaces: new SqliteWorkspaceResolver(),
  };

  // The mock process is injected through the same WorkerExecutorFactory port
  // used by the composition root, rather than through the orchestration pump.
  const workerExecutorFactory = createLegacyClaudeWorkerExecutorFactory({
    modelRouteReader: epicId => persistence.episodes.readWorkerModelRoute(epicId),
    spawn: (cmd, args, opts) => {
      const mockScript = path.join(sagaRoot, 'tests', 'mock-claude.mjs');
      return nodeSpawn(cmd, [mockScript, ...args], opts);
    },
  });

  const result = await orchestrate({
    projectId: project.id,
    epicId: epic.id,
    concurrency: 1,
    claudePath: process.execPath,
    dbPath: process.env.DB_PATH,
    lmStudioUrl: 'http://localhost:1234/v1',
    workerExecutorFactory,
    persistence,
    host: new NodeSaga2HostRuntime({
      homeDirectory: temp,
      sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 100))),
    }),
  });

  const db = getDb();
  const episode = db.prepare(
    `SELECT stage FROM episode_workflows WHERE epic_id=?`,
  ).get(epic.id);
  assert.equal(episode.stage, 'completed',
    `engine should reach 'completed', got '${episode.stage}' (reason=${result.reason})`);

  const v = db.prepare(`SELECT status, integration_state FROM tasks WHERE id=?`).get(verify.id);
  assert.equal(v.status, 'done',
    `verification task #${verify.id} should be done, got '${v.status}'`);
  const i = db.prepare(`SELECT status, integration_state FROM tasks WHERE id=?`).get(integrate.id);
  assert.equal(i.status, 'done',
    `integration task #${integrate.id} should be done, got '${i.status}'`);

  assert.equal(result.reason, 'completed',
    `orchestrate result.reason should be 'completed', got '${result.reason}'`);
});
