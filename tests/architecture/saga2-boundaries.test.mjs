import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const { loadSagaRuntimeConfig } = await import(
  '../../dist/runtime/saga-runtime-config.js'
);
const { Saga2Engine } = await import('../../dist/engines/saga2-engine.js');
const { createSagaApplication } = await import(
  '../../dist/application/saga-application.js'
);
const { ClaudeBoardWorkerExecutor } = await import(
  '../../dist/infrastructure/workers/claude-board-worker-executor.js'
);
const { LegacyBoardProjectionAdapter } = await import(
  '../../dist/infrastructure/projections/legacy-board-projection.js'
);
const { SqliteBoardProjectionReader } = await import(
  '../../dist/infrastructure/projections/sqlite-board-projection-reader.js'
);

test('runtime config preserves Saga 2 defaults and environment precedence', () => {
  const config = loadSagaRuntimeConfig({
    DB_PATH: '/tmp/saga.db',
    SAGA_CLAUDE_PATH: '/opt/claude',
    SAGA_LMSTUDIO_URL: 'http://127.0.0.1:1234/v1',
    TRACKER_AUTOSTART: '0',
    PORT: '5000',
    RELOAD_SEC: '7',
    SAGA_ORCHESTRATION_MODE: 'v2',
  });

  assert.deepEqual(config, {
    dbPath: '/tmp/saga.db',
    claudePath: '/opt/claude',
    lmStudioUrl: 'http://127.0.0.1:1234/v1',
    trackerAutostart: false,
    trackerPort: 5000,
    trackerReloadSec: 7,
    orchestrationMode: 'v2',
  });

  assert.throws(() => loadSagaRuntimeConfig({}), /DB_PATH env var is required/);
});

test('Saga2Engine delegates through the legacy runtime port', async () => {
  const calls = [];
  const expected = {
    projectId: 11,
    epicId: 22,
    finalStage: 'completed',
    endedAt: '2026-07-23T00:00:00.000Z',
    reason: 'completed',
    cycles: 9,
    lastError: null,
  };

  const engine = new Saga2Engine({
    config: {
      dbPath: '/tmp/saga.db',
      claudePath: '/opt/claude',
      lmStudioUrl: 'http://localhost:1234/v1',
      trackerAutostart: true,
      trackerPort: 4321,
      trackerReloadSec: 5,
      orchestrationMode: 'v2',
    },
    runLegacy: async invocation => {
      calls.push(invocation);
      return expected;
    },
  });

  const result = await engine.run({ projectId: 11, epicId: 22, concurrency: 3 });
  assert.deepEqual(result, expected);
  assert.deepEqual(calls, [{
    projectId: 11,
    epicId: 22,
    concurrency: 3,
    claudePath: '/opt/claude',
  }]);
});

test('Saga application host coordinates engine and board ports and closes once', async () => {
  const commands = [];
  let closes = 0;
  const projects = [{ id: 1, name: 'Stable', status: 'active', total: 1, in_progress: 0, reviewing: 0 }];
  const board = { epics: [], epicById: {}, tasks: [] };
  const application = createSagaApplication({
    engine: {
      async run(command) {
        commands.push(command);
        return {
          projectId: command.projectId,
          epicId: command.epicId,
          finalStage: 'completed',
          endedAt: '2026-07-23T00:00:00.000Z',
          reason: 'completed',
          cycles: 1,
          lastError: null,
        };
      },
    },
    board: {
      listProjects: () => projects,
      loadProjectBoard: projectId => {
        assert.equal(projectId, 1);
        return board;
      },
    },
    close: () => { closes += 1; },
  });

  await application.runEpisode({ projectId: 1, epicId: 2, concurrency: 1 });
  assert.deepEqual(commands, [{ projectId: 1, epicId: 2, concurrency: 1 }]);
  assert.equal(application.listProjects(), projects);
  assert.equal(application.loadProjectBoard(1), board);
  application.close();
  application.close();
  assert.equal(closes, 1);
  assert.throws(() => application.runEpisode({ projectId: 1, epicId: 2 }), /Saga application is closed/);
  assert.throws(() => application.listProjects(), /Saga application is closed/);
});

test('worker adapter preserves the existing board runner protocol', () => {
  const calls = [];
  const snapshot = {
    id: 'run-1', project_id: 1, concurrency: 2, status: 'running',
    active: [], completed: 0, failed: 0, claimed: 0,
  };
  const runner = {
    start(command) { calls.push(['start', command]); return snapshot; },
    stop(projectId) { calls.push(['stop', projectId]); return snapshot; },
    status(projectId) { calls.push(['status', projectId]); return snapshot; },
    setConcurrency(projectId, concurrency) { calls.push(['setConcurrency', projectId, concurrency]); },
    dispose() { calls.push(['dispose']); },
  };

  const executor = new ClaudeBoardWorkerExecutor(runner);
  assert.equal(executor.start({ projectId: 1, epicId: 2, concurrency: 2 }), snapshot);
  assert.equal(executor.status(1), snapshot);
  executor.setConcurrency(1, 3);
  assert.equal(executor.stop(1), snapshot);
  executor.dispose();
  assert.deepEqual(calls, [
    ['start', { projectId: 1, epicId: 2, concurrency: 2 }],
    ['status', 1],
    ['setConcurrency', 1, 3],
    ['stop', 1],
    ['dispose'],
  ]);
});

test('frontend projection adapter preserves legacy rows unchanged', () => {
  const projects = [{ id: 1, name: 'Stable', status: 'active', total: 3, in_progress: 1, reviewing: 0 }];
  const board = { epics: [], epicById: {}, tasks: [] };
  const adapter = new LegacyBoardProjectionAdapter({
    listProjects: () => projects,
    loadProjectBoard: projectId => {
      assert.equal(projectId, 1);
      return board;
    },
  });
  assert.equal(adapter.listProjects(), projects);
  assert.equal(adapter.loadProjectBoard(1), board);
});

test('SQLite board reader preserves the tracker project and board projection', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-board-projection-'));
  const dbPath = path.join(temp, 'saga.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, status TEXT);
      CREATE TABLE epics (id INTEGER PRIMARY KEY, name TEXT, project_id INTEGER);
      CREATE TABLE episode_workflows (epic_id INTEGER, stage TEXT, metadata TEXT);
      CREATE TABLE artifacts (id INTEGER PRIMARY KEY, epic_id INTEGER, status TEXT, drift_state TEXT);
      CREATE TABLE verification_evidence (id INTEGER PRIMARY KEY, artifact_id INTEGER, outcome TEXT);
      CREATE TABLE repositories (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE project_repositories (id INTEGER PRIMARY KEY, project_id INTEGER, repository_id INTEGER);
      CREATE TABLE tasks (
        id INTEGER PRIMARY KEY, epic_id INTEGER, title TEXT, status TEXT,
        task_kind TEXT, workflow_stage TEXT, execution_skill TEXT,
        execution_mode TEXT, assigned_to TEXT, integration_state TEXT,
        sort_order INTEGER, project_repository_id INTEGER
      );
      CREATE TABLE task_dependencies (task_id INTEGER, depends_on_task_id INTEGER);
    `);
    db.prepare(`INSERT INTO projects VALUES (1, 'Stable', 'active')`).run();
    db.prepare(`INSERT INTO epics VALUES (10, 'REQ-10', 1)`).run();
    db.prepare(`INSERT INTO episode_workflows VALUES (10, 'development', '{}')`).run();
    db.prepare(`INSERT INTO repositories VALUES (20, 'product')`).run();
    db.prepare(`INSERT INTO project_repositories VALUES (30, 1, 20)`).run();
    db.prepare(`INSERT INTO tasks VALUES (40, 10, 'Build', 'in_progress', 'development.code', 'development', 'saga-worker', 'git_change', 'worker-1', 'pending', 1, 30)`).run();
  } finally {
    db.close();
  }

  try {
    const reader = new SqliteBoardProjectionReader(dbPath);
    const projects = reader.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].name, 'Stable');
    assert.equal(projects[0].total, 1);
    assert.equal(projects[0].in_progress, 1);
    assert.match(projects[0].color, /^#/);

    const projection = reader.loadProjectBoard(1);
    assert.equal(projection.epics.length, 1);
    assert.equal(projection.epics[0].episode_stage, 'development');
    assert.equal(projection.tasks.length, 1);
    assert.equal(projection.tasks[0].task_kind, 'development.code');
    assert.equal(projection.tasks[0].repository_name, 'product');
    assert.equal(projection.epicById[10].name, 'REQ-10');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
