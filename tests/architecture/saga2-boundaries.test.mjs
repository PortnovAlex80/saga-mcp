import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const { LegacyEngineAdministration } = await import(
  '../../dist/infrastructure/engine/legacy-engine-administration.js'
);

const fullConfig = (overrides = {}) => ({
  dbPath: '/tmp/saga.db',
  claudePath: '/opt/claude',
  lmStudioUrl: 'http://localhost:1234/v1',
  zaiBaseUrl: 'https://api.z.ai/api/anthropic',
  trackerAutostart: true,
  trackerPort: 4321,
  trackerReloadSec: 5,
  trackerSpawned: false,
  trackerNoBrowser: false,
  orchestrationMode: 'v2',
  ...overrides,
});

test('runtime config preserves Saga 2 defaults and environment precedence', () => {
  const config = loadSagaRuntimeConfig({
    DB_PATH: '/tmp/saga.db',
    SAGA_CLAUDE_PATH: '/opt/claude',
    SAGA_LMSTUDIO_URL: 'http://127.0.0.1:1234/v1',
    SAGA_ZAI_BASE_URL: 'https://zai.example/anthropic',
    TRACKER_AUTOSTART: '0',
    TRACKER_SPAWNED: '1',
    TRACKER_NO_BROWSER: '1',
    PORT: '5000',
    RELOAD_SEC: '7',
    SAGA_ORCHESTRATION_MODE: 'v3',
  });

  assert.deepEqual(config, {
    dbPath: '/tmp/saga.db',
    claudePath: '/opt/claude',
    lmStudioUrl: 'http://127.0.0.1:1234/v1',
    zaiBaseUrl: 'https://zai.example/anthropic',
    trackerAutostart: false,
    trackerPort: 5000,
    trackerReloadSec: 7,
    trackerSpawned: true,
    trackerNoBrowser: true,
    orchestrationMode: 'v3',
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
    config: fullConfig(),
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

test('Saga application coordinates engine, board and administration ports', async () => {
  const commands = [];
  const adminCalls = [];
  let closes = 0;
  let adminDisposes = 0;
  const projects = [{ id: 1, name: 'Stable', status: 'active', total: 1, in_progress: 0, reviewing: 0 }];
  const board = { epics: [], epicById: {}, tasks: [] };
  const engineState = {
    projectId: 1, epicId: 2, running: true, alive: true,
    pid: 123, concurrency: 2, startedAt: '2026-07-23 00:00:00',
  };
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
    engineAdministration: {
      start(command) { adminCalls.push(['start', command]); return engineState; },
      stop(epicId) { adminCalls.push(['stop', epicId]); return { ...engineState, running: false, alive: false }; },
      restart(command) { adminCalls.push(['restart', command]); return engineState; },
      setConcurrency(epicId, concurrency) {
        adminCalls.push(['concurrency', epicId, concurrency]);
        return { ...engineState, concurrency };
      },
      status(epicId) { adminCalls.push(['status', epicId]); return engineState; },
      dispose() { adminDisposes += 1; },
    },
    close: () => { closes += 1; },
  });

  await application.runEpisode({ projectId: 1, epicId: 2, concurrency: 1 });
  assert.deepEqual(commands, [{ projectId: 1, epicId: 2, concurrency: 1 }]);
  assert.equal(application.listProjects(), projects);
  assert.equal(application.loadProjectBoard(1), board);
  assert.equal(application.startEngine({ epicId: 2, concurrency: 2 }), engineState);
  application.getEngineStatus(2);
  application.setEngineConcurrency(2, 3);
  application.stopEngine(2);
  application.restartEngine({ epicId: 2 });
  assert.deepEqual(adminCalls, [
    ['start', { epicId: 2, concurrency: 2 }],
    ['status', 2],
    ['concurrency', 2, 3],
    ['stop', 2],
    ['restart', { epicId: 2 }],
  ]);
  application.close();
  application.close();
  assert.equal(adminDisposes, 1);
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

test('legacy engine administration preserves start/status/concurrency/stop semantics', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-engine-admin-'));
  const dbPath = path.join(temp, 'saga.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE epics (id INTEGER PRIMARY KEY, project_id INTEGER);
      CREATE TABLE episode_workflows (
        epic_id INTEGER PRIMARY KEY,
        metadata TEXT,
        updated_at TEXT
      );
    `);
    db.prepare('INSERT INTO epics VALUES (2, 1)').run();
    db.prepare(`INSERT INTO episode_workflows VALUES (2, '{}', datetime('now'))`).run();
  } finally {
    db.close();
  }

  let alive = false;
  const spawned = [];
  const syncCalls = [];
  const admin = new LegacyEngineAdministration({
    config: fullConfig({ dbPath, orchestrationMode: 'v3' }),
    baseEnv: { KEEP_ME: '1' },
    orchestrateCliPath: '/dist/orchestrate-cli.js',
    platform: 'linux',
    now: () => new Date('2026-07-23T01:02:03.000Z'),
    spawnProcess(command, args, options) {
      spawned.push({ command, args, options });
      alive = true;
      return { pid: 4321, unref() {} };
    },
    spawnProcessSync(command, args) {
      syncCalls.push([command, args]);
      if (command === 'pkill') { alive = false; return { status: 0, stdout: '' }; }
      if (command === 'pgrep') return { status: alive ? 0 : 1, stdout: alive ? '4321' : '' };
      return { status: 0, stdout: '' };
    },
  });

  try {
    const started = admin.start({ epicId: 2, concurrency: 3 });
    assert.equal(started.running, true);
    assert.equal(started.alive, true);
    assert.equal(started.pid, 4321);
    assert.equal(started.concurrency, 3);
    assert.equal(spawned[0].options.env.DB_PATH, dbPath);
    assert.equal(spawned[0].options.env.SAGA_ORCHESTRATION_MODE, 'v3');
    assert.equal(spawned[0].options.env.KEEP_ME, '1');

    const status = admin.status(2);
    assert.equal(status.alive, true);
    assert.equal(status.running, true);

    const changed = admin.setConcurrency(2, 2);
    assert.equal(changed.concurrency, 2);

    const stopped = admin.stop(2);
    assert.equal(stopped.running, false);
    assert.equal(stopped.alive, false);
    assert.ok(syncCalls.some(([command]) => command === 'pkill'));
  } finally {
    admin.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('tracker uses extracted ports and preserves the LM Studio hard rule fix', () => {
  const trackerPath = path.join(process.cwd(), 'tracker-view', 'tracker-view.mjs');
  const source = readFileSync(trackerPath, 'utf8');

  assert.match(source, /createSaga2Application/);
  assert.match(source, /sagaApplication\.listProjects\(\)/);
  assert.match(source, /sagaApplication\.loadProjectBoard/);
  assert.match(source, /sagaApplication\.startEngine/);
  assert.doesNotMatch(source, /function killEngineTree\(/);

  for (const slot of [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ]) {
    assert.match(source, new RegExp(`payload\\.env\\.${slot} = modelId`));
  }
  assert.match(source, /CLAUDE_SETTINGS_LMSTUDIO_TPL/);
});
