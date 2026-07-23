import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
const { NodeSaga2HostRuntime } = await import(
  '../../dist/infrastructure/runtime/node-saga2-host-runtime.js'
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

test('Saga2Engine owns the pump and consumes only injected runtime ports', async () => {
  const heartbeats = [];
  const patches = [];
  let workerFactoryCalls = 0;
  const host = {
    processId: 77,
    workerPaths: { sagaEntry: '/dist/index.js', sagaSkillRoot: '/skills' },
    now: () => Date.parse('2026-07-23T00:00:00.000Z'),
    sleep: async () => {},
    heartbeat(context, event, message) { heartbeats.push([context, event, message]); },
    acquireEngineLock: () => ({ status: 'duplicate', ownerPid: 123 }),
    releaseEngineLock: () => { throw new Error('duplicate run must not release another owner lock'); },
    scanRateLimitSignals: () => 0,
  };
  const persistence = {
    episodes: {
      readTargetConcurrency: (_epicId, fallback) => fallback,
      patchMetadata: (epicId, patch) => patches.push([epicId, patch]),
      currentStage: () => 'development',
    },
    tasks: {},
    executions: {},
    workspaces: {},
  };
  const engine = new Saga2Engine({
    config: fullConfig(),
    host,
    persistence,
    workerExecutorFactory: () => {
      workerFactoryCalls += 1;
      throw new Error('duplicate engine must not construct worker runtime');
    },
  });

  const result = await engine.run({ projectId: 11, epicId: 22, concurrency: 3 });
  assert.equal(result.reason, 'failed');
  assert.equal(result.finalStage, 'development');
  assert.match(result.lastError, /PID 123/);
  assert.equal(workerFactoryCalls, 0);
  assert.equal(heartbeats[0][1], 'DUPLICATE_EXIT');
  assert.equal(patches[0][0], 22);
  assert.equal(patches[0][1].engine_rejected, true);
});

test('Node Saga2 host runtime owns lock, heartbeat and rate-limit telemetry', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-host-runtime-'));
  const context = { projectId: 1, epicId: 2 };
  const cliRoot = path.join(temp, '.zcode', 'cli');
  const lockPath = path.join(cliRoot, 'engine-1-2.pid');
  const runDir = path.join(cliRoot, 'board-runs', 'board-1-100');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(lockPath, '999', 'utf8');
  writeFileSync(
    path.join(runDir, 'task-7-worker-1.jsonl'),
    JSON.stringify({ type: 'api_retry', error_status: 429, error: 'rate_limit' }) + '\n',
    'utf8',
  );

  try {
    const host = new NodeSaga2HostRuntime({
      processId: 4242,
      homeDirectory: temp,
      now: () => Date.parse('2026-07-23T01:02:03.000Z'),
      isProcessAlive: pid => pid === 999,
    });
    assert.deepEqual(host.acquireEngineLock(context), { status: 'duplicate', ownerPid: 999 });

    unlinkSync(lockPath);
    assert.deepEqual(host.acquireEngineLock(context), { status: 'acquired', ownerPid: 4242 });
    assert.equal(readFileSync(lockPath, 'utf8'), '4242');

    host.heartbeat(context, 'CYCLE', 'stage=development');
    const heartbeat = readFileSync(path.join(cliRoot, 'engine-heartbeat.log'), 'utf8');
    assert.match(heartbeat, /2026-07-23T01:02:03.000Z engine project=1 epic=2 CYCLE stage=development/);

    assert.equal(host.scanRateLimitSignals(context, [{ id: 7, assigned_to: 'worker-1' }]), 1);
    host.releaseEngineLock(context);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
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


test('orchestration pump has no direct persistence access after Phase B item 5', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'orchestrate.ts'), 'utf8');
  assert.doesNotMatch(source, /\bgetDb\b/);
  assert.doesNotMatch(source, /\.prepare\s*\(/);
  assert.doesNotMatch(source, /reconcileWorkerExecutions/);
  assert.match(source, /Saga2RuntimePersistence/);
  assert.match(source, /persistence\.episodes/);
  assert.match(source, /persistence\.tasks/);
  assert.match(source, /persistence\.executions/);
  assert.match(source, /persistence\.workspaces/);
});

test('worker model route preserves provider and effort from episode persistence', () => {
  const port = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'application', 'ports', 'worker-executor.ts'), 'utf8');
  const composition = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'app', 'composition-root.ts'), 'utf8');
  const runner = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'tracker-view', 'claude-runner.mjs'), 'utf8');
  assert.match(port, /WorkerModelRoute/);
  assert.match(port, /effort: string \| null/);
  assert.match(composition, /readWorkerModelRoute/);
  assert.match(runner, /isLmstudio \? null : \(am\.effort \|\| 'high'\)/);
  assert.doesNotMatch(runner, /'--effort', 'xhigh'/);
});

// ---------------------------------------------------------------------------
// D0 — Saga 3 Discovery Edition engine shell.
//
// Roadmap §8.D0: prove that the Phase B infrastructure isolation can host a
// second engine behind the existing OrchestrationEngine port WITHOUT
// duplicating tracker, repositories, worker runtime or engine administration,
// and WITHOUT altering Saga 2 behaviour.
// ---------------------------------------------------------------------------

test('D0: composition root selects engine by orchestration mode without branching infrastructure', async () => {
  const { Saga3DiscoveryEngine } = await import(
    '../../dist/engines/saga3-discovery-engine.js'
  );
  const compositionSrc = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'src', 'app', 'composition-root.ts'),
    'utf8',
  );

  // Single composition-root switch selects the concrete engine (roadmap §5.2).
  assert.match(compositionSrc, /saga3-discovery/);
  assert.match(compositionSrc, /Saga3DiscoveryEngine/);
  assert.match(compositionSrc, /Saga2Engine/);
  // The engine is constructed in exactly one place (single switch).
  assert.equal(
    (compositionSrc.match(/new Saga3DiscoveryEngine/g) || []).length, 1,
    'Saga3DiscoveryEngine is constructed in exactly one place',
  );

  // The shared persistence wiring is reused — no second worker factory, no
  // second board reader, no second engine administration.
  assert.doesNotMatch(
    compositionSrc,
    /new SqliteBoardProjectionReader[\s\S]*saga3-discovery[\s\S]*new SqliteBoardProjectionReader/,
    'D0 must NOT add a second board reader for Saga 3',
  );

  // The engine behind the port is selected purely by config: a Saga3 discovery
  // engine is reachable through the same SagaApplication boundary.
  const engine = new Saga3DiscoveryEngine({
    readStage: () => 'discovery',
    now: () => new Date('2026-07-23T00:00:00.000Z'),
  });
  const result = await engine.run({ projectId: 1, epicId: 2, concurrency: 1 });
  assert.equal(result.reason, 'discovery_not_implemented');
  assert.equal(result.pipelineScope, 'discovery_only');
  assert.equal(result.scopeCompleted, false);
  assert.equal(result.outcome, 'discovery_not_implemented');
});

test('D0: saga3 discovery shell is inert — no stage mutation, no worker spawn, honest result', async () => {
  const { Saga3DiscoveryEngine } = await import(
    '../../dist/engines/saga3-discovery-engine.js'
  );

  // Inert: even when no stage reader is wired, the engine reports the discovery
  // entry stage rather than inventing a later one.
  const reads = [];
  const engine = new Saga3DiscoveryEngine({
    readStage: epicId => { reads.push(epicId); return 'discovery'; },
    now: () => new Date('2026-07-23T00:00:00.000Z'),
  });

  const result = await engine.run({ projectId: 5, epicId: 7, concurrency: 2 });

  // Honest partial-pipeline result (roadmap §5.3, §8.D0 exit gates).
  assert.equal(result.projectId, 5);
  assert.equal(result.epicId, 7);
  assert.equal(result.finalStage, 'discovery');
  assert.equal(result.endedAt, '2026-07-23T00:00:00.000Z');
  assert.equal(result.reason, 'discovery_not_implemented');
  assert.equal(result.cycles, 0);
  assert.equal(result.lastError, null);
  assert.equal(result.pipelineScope, 'discovery_only');
  assert.equal(result.scopeCompleted, false);
  assert.equal(result.outcome, 'discovery_not_implemented');

  // The stage was READ exactly once (reported truthfully) and never written.
  assert.deepEqual(reads, [7]);
});

test('D0: saga3-discovery engine has no worker, recovery, advisor or new-table dependencies', () => {
  const engineSrc = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'src', 'engines', 'saga3-discovery-engine.ts'),
    'utf8',
  );
  // D0 must NOT import product worker, advisor, normalization, settlement or
  // persistence adapters. The shell consumes the narrow readStage port only.
  assert.doesNotMatch(engineSrc, /from\s+['"][^'"]*worker/i);
  assert.doesNotMatch(engineSrc, /WorkerExecutorFactory/);
  assert.doesNotMatch(engineSrc, /import\s+[^;]*persistence/i);
  assert.doesNotMatch(engineSrc, /better-sqlite3/);
  assert.doesNotMatch(engineSrc, /getDb|\.prepare\(/);
  // It implements the shared port, not a parallel one.
  assert.match(engineSrc, /implements OrchestrationEngine/);
  assert.match(engineSrc, /discovery_only/);
  assert.match(engineSrc, /discovery_not_implemented/);
});

test('D0: OrchestrationRunResult contract is extended backward-compatibly for partial-pipeline runs', () => {
  const portSrc = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'src', 'application', 'ports', 'orchestration-engine.ts'),
    'utf8',
  );
  // The four Saga 2 reasons remain valid; discovery_not_implemented is added.
  for (const reason of ['completed', 'failed', 'paused_timeout', 'stopped', 'discovery_not_implemented']) {
    assert.match(portSrc, new RegExp(`'${reason}'`), `reason '${reason}' present in the union`);
  }
  // Partial-pipeline fields are optional so Saga 2 results need not populate them.
  assert.match(portSrc, /pipelineScope\?/);
  assert.match(portSrc, /scopeCompleted\?/);
  assert.match(portSrc, /outcome\?/);
});

test('D0: Saga 2 remains the default engine and stays unchanged in selection', async () => {
  const compositionSrc = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'src', 'app', 'composition-root.ts'),
    'utf8',
  );
  // The Saga 2 engine is still constructed and is the fall-through default —
  // any unrecognised mode keeps Saga 2 behaviour (roadmap §8.D0 gate:
  // "saga2 mode — Saga 2 works unchanged").
  const selectBlock = compositionSrc.match(
    /function selectEngine[\s\S]*?return new Saga2Engine[\s\S]*?\}/,
  );
  assert.ok(selectBlock, 'selectEngine falls through to Saga2Engine');
  assert.match(selectBlock[0], /orchestrationMode === 'saga3-discovery'/);
  assert.match(selectBlock[0], /return new Saga2Engine/);
});
