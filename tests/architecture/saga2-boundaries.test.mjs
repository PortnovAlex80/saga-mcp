import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

const { loadSagaRuntimeConfig } = await import(
  '../../dist/runtime/saga-runtime-config.js'
);
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
  orchestrationLogRoot: undefined,
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

test('runtime config preserves defaults and environment precedence', () => {
  const config = loadSagaRuntimeConfig({
    DB_PATH: '/tmp/saga.db',
    SAGA_ORCHESTRATION_LOG: '/tmp/saga-worker-logs',
    SAGA_CLAUDE_PATH: '/opt/claude',
    SAGA_LMSTUDIO_URL: 'http://127.0.0.1:1234/v1',
    SAGA_ZAI_BASE_URL: 'https://zai.example/anthropic',
    TRACKER_AUTOSTART: '0',
    TRACKER_SPAWNED: '1',
    TRACKER_NO_BROWSER: '1',
    PORT: '5000',
    RELOAD_SEC: '7',
    SAGA_ORCHESTRATION_MODE: 'saga3-lifecycle',
  });

  assert.deepEqual(config, {
    dbPath: '/tmp/saga.db',
    orchestrationLogRoot: '/tmp/saga-worker-logs',
    claudePath: '/opt/claude',
    lmStudioUrl: 'http://127.0.0.1:1234/v1',
    zaiBaseUrl: 'https://zai.example/anthropic',
    trackerAutostart: false,
    trackerPort: 5000,
    trackerReloadSec: 7,
    trackerSpawned: true,
    trackerNoBrowser: true,
    orchestrationMode: 'saga3-lifecycle',
  });

  assert.throws(() => loadSagaRuntimeConfig({}), /DB_PATH env var is required/);
});

test('Node Saga2 host runtime owns lock and heartbeat', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-host-runtime-'));
  const context = { projectId: 1, epicId: 2 };
  const cliRoot = path.join(temp, '.zcode', 'cli');
  const lockPath = path.join(cliRoot, 'engine-1-2.pid');
  // The host runtime treats the lock dir as pre-existing (the real CLI creates
  // ~/.zcode/cli on install). mkdtempSync does not create nested subdirs, so
  // materialize the parent before seeding the stale-lock fixture.
  mkdirSync(cliRoot, { recursive: true });
  writeFileSync(lockPath, '999', 'utf8');

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
      CREATE TABLE saga3_lifecycle_runs (
        id INTEGER PRIMARY KEY, project_id INTEGER, epic_id INTEGER,
        status TEXT, entry_stage_id TEXT, current_stage_id TEXT,
        terminal_status TEXT, error TEXT
      );
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
      CREATE TABLE task_dependencies (task_id, depends_on_task_id INTEGER);
    `);
    db.prepare(`INSERT INTO projects VALUES (1, 'Stable', 'active')`).run();
    db.prepare(`INSERT INTO epics VALUES (10, 'REQ-10', 1)`).run();
    // saga4: board reads stage from saga3_lifecycle_runs, not episode_workflows.
    db.prepare(`INSERT INTO saga3_lifecycle_runs VALUES (1, 1, 10, 'running', 'initial-discovery', 'solution-development', NULL, NULL)`).run();
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
    assert.equal(projection.epics[0].episode_stage, 'solution-development');
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
      -- saga4: LegacyEngineAdministration now reads per-epic engine state from
      -- lifecycle_execution_controls (migrated out of episode_workflows.metadata).
      CREATE TABLE lifecycle_execution_controls (
        epic_id INTEGER PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE,
        engine_state TEXT NOT NULL DEFAULT 'stopped'
          CHECK (engine_state IN ('running','stopped','unknown')),
        engine_pid INTEGER,
        concurrency INTEGER,
        started_at TEXT,
        stopped_at TEXT,
        concurrency_changed_at TEXT,
        model_provider TEXT,
        model_name TEXT,
        model_effort TEXT,
        model_concurrency_limit INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    // Inject the liveness probe so the test does not depend on a real OS
    // process matching the spawned mock PID 4321. While `alive` is true the
    // probe reports the engine PID as live; pkill flips alive to false.
    isProcessAlive: pid => alive && pid === 4321,
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
    const started = admin.start({
      epicId: 2,
      concurrency: 3,
      lifecycleInputPath: '/cases/product.json',
      idempotencyKey: 'product-2',
      resumePaused: true,
    });
    assert.equal(started.running, true);
    assert.equal(started.alive, true);
    assert.equal(started.pid, 4321);
    assert.equal(started.concurrency, 3);
    assert.equal(spawned[0].options.env.DB_PATH, dbPath);
    assert.equal(spawned[0].options.env.SAGA_ORCHESTRATION_MODE, 'v3');
    assert.equal(spawned[0].options.env.KEEP_ME, '1');
    assert.deepEqual(spawned[0].args.slice(-3), [
      '--lifecycle-input=/cases/product.json',
      '--idempotency-key=product-2',
      '--resume',
    ]);

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

test('engine spawn propagates config.orchestrationMode (no hardcoded mode)', () => {
  // D0 spawn-path fix: spawned orchestrate-cli env MUST equal config.orchestrationMode,
  // not a hardcoded 'v3'. After the saga4 cutover there is exactly ONE mode
  // ('saga3-lifecycle'); the spawned env must still equal config.orchestrationMode.
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-spawn-mode-'));
  const dbPath = path.join(temp, 'saga.db');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE epics (id INTEGER PRIMARY KEY, project_id INTEGER);
      CREATE TABLE episode_workflows (epic_id INTEGER PRIMARY KEY, metadata TEXT, updated_at TEXT);
      CREATE TABLE lifecycle_execution_controls (
        epic_id INTEGER PRIMARY KEY REFERENCES epics(id) ON DELETE CASCADE,
        engine_state TEXT NOT NULL DEFAULT 'stopped'
          CHECK (engine_state IN ('running','stopped','unknown')),
        engine_pid INTEGER,
        concurrency INTEGER,
        started_at TEXT,
        stopped_at TEXT,
        concurrency_changed_at TEXT,
        model_provider TEXT,
        model_name TEXT,
        model_effort TEXT,
        model_concurrency_limit INTEGER,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare('INSERT INTO epics VALUES (2, 1)').run();
    db.prepare(`INSERT INTO episode_workflows VALUES (2, '{}', datetime('now'))`).run();
  } finally {
    db.close();
  }

  for (const mode of ['saga3-lifecycle']) {
    const spawned = [];
    const admin = new LegacyEngineAdministration({
      config: fullConfig({ dbPath, orchestrationMode: mode }),
      baseEnv: {},
      orchestrateCliPath: '/dist/orchestrate-cli.js',
      platform: 'linux',
      spawnProcess(command, args, options) {
        spawned.push(options.env);
        return { pid: 100, unref() {} };
      },
      spawnProcessSync: () => ({ status: 0, stdout: '' }),
    });
    try {
      admin.start({ epicId: 2, concurrency: 1 });
      assert.equal(spawned[0].SAGA_ORCHESTRATION_MODE, mode,
        `spawned env SAGA_ORCHESTRATION_MODE must equal config.orchestrationMode='${mode}' (no hardcoded v3)`);
    } finally {
      admin.dispose();
    }
  }
  rmSync(temp, { recursive: true, force: true });
});

test('runtime config defaults orchestration mode to the product lifecycle engine', () => {
  // saga4 cutover: the Product Lifecycle runtime is the unconditional default.
  // The legacy 'v2'/'v3'/'saga2' modes have been removed from the union.
  const config = loadSagaRuntimeConfig({ DB_PATH: '/tmp/saga.db' });
  assert.equal(config.orchestrationMode, 'saga3-lifecycle',
    'default orchestration mode must be the product lifecycle runtime');
});

test('orchestration mode parser rejects unknown values instead of silent fallback', async () => {
  const { parseOrchestrationMode, requiresBackgroundEngine } = await import(
    '../../dist/runtime/orchestration-mode.js'
  );
  // The sole recognised mode parses (case/whitespace normalised).
  for (const [raw, expected] of [
    [undefined, 'saga3-lifecycle'],
    ['', 'saga3-lifecycle'],
    ['saga3-lifecycle', 'saga3-lifecycle'],
    [' Saga3-Lifecycle ', 'saga3-lifecycle'],
  ]) {
    assert.equal(parseOrchestrationMode(raw), expected,
      `parseOrchestrationMode('${raw}') === '${expected}'`);
  }
  // Removed legacy modes are now unknown and must throw — never a silent fallback.
  assert.throws(() => parseOrchestrationMode('v2'), /Unknown SAGA_ORCHESTRATION_MODE/);
  assert.throws(() => parseOrchestrationMode('v3'), /Unknown SAGA_ORCHESTRATION_MODE/);
  assert.throws(() => parseOrchestrationMode('saga2'), /Unknown SAGA_ORCHESTRATION_MODE/);
  assert.throws(() => parseOrchestrationMode('saga3-discovry'), /Unknown SAGA_ORCHESTRATION_MODE/);
  assert.throws(() => parseOrchestrationMode('v4'), /Unknown SAGA_ORCHESTRATION_MODE/);
  // The saga3-discovery / discovery-generic / formalization modes were removed
  // from the union; they must now throw (dead configuration collapsed).
  assert.throws(() => parseOrchestrationMode('saga3-discovery'), /Unknown SAGA_ORCHESTRATION_MODE/);
  assert.throws(() => parseOrchestrationMode('saga3-discovery-generic'), /Unknown SAGA_ORCHESTRATION_MODE/);
  assert.throws(() => parseOrchestrationMode('saga3-formalization'), /Unknown SAGA_ORCHESTRATION_MODE/);

  // requiresBackgroundEngine is the single source of truth for spawning.
  assert.equal(requiresBackgroundEngine('saga3-lifecycle'), true, 'saga3-lifecycle spawns background engine');
});

test('tracker uses extracted ports and preserves the LM Studio hard rule fix', () => {
  const trackerPath = path.join(process.cwd(), 'tracker-view', 'tracker-view.mjs');
  const source = readFileSync(trackerPath, 'utf8');

  // Core application wiring stays in tracker-view.mjs.
  assert.match(source, /createSagaControlApplication/);
  assert.match(source, /sagaApplication\.listProjects\(\)/);
  assert.match(source, /sagaApplication\.loadProjectBoard/);
  assert.match(source, /sagaApplication\.startEngine/);
  assert.doesNotMatch(source, /function killEngineTree\(/);

  // T10 step 3: the model-management code (LM Studio hard rule + settings.json
  // templates) was extracted into tracker-view/model-management.mjs. The
  // `payload.env.<SLOT> = modelId` assignments and CLAUDE_SETTINGS_LMSTUDIO_TPL
  // now live there; assert against the extracted module instead of the core file.
  const modelMgmtPath = path.join(process.cwd(), 'tracker-view', 'model-management.mjs');
  const modelMgmt = readFileSync(modelMgmtPath, 'utf8');

  for (const slot of [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ]) {
    assert.match(modelMgmt, new RegExp(`payload\\.env\\.${slot} = modelId`));
  }
  assert.match(modelMgmt, /CLAUDE_SETTINGS_LMSTUDIO_TPL/);
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

test('composition root selects the lifecycle engine unconditionally', () => {
  // saga4 cutover structural guard: selectEngine returns ONLY the Product
  // Lifecycle runtime. The legacy Saga2Engine / Saga3DiscoveryEngine /
  // Saga3FormalizationEngine branches are gone from the composition root.
  // (Engine-selection behaviour is proven by the lifecycle runEpisode test
  // below; this locks the source structure against regression.)
  const compositionSrc = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'src', 'app', 'composition-root.ts'),
    'utf8',
  );

  assert.match(compositionSrc, /createProductLifecycleRuntime/);
  assert.doesNotMatch(compositionSrc, /new Saga2Engine/);
  assert.doesNotMatch(compositionSrc, /new Saga3DiscoveryEngine/);
  assert.doesNotMatch(compositionSrc, /new Saga3FormalizationEngine/);
  // No parallel engine construction in selectEngine — the lifecycle runtime
  // is the only path.
  assert.doesNotMatch(compositionSrc, /isSaga3DiscoveryGenericMode/);
  assert.doesNotMatch(compositionSrc, /isSaga3FormalizationMode/);
});

test('D1: saga3-discovery engine reuses worker substrate without duplicating Saga 2 pump logic', () => {
  // D1 boundary: the engine legitimately imports WorkerExecutorFactory +
  // persistence (it dispatches one discovery worker through the existing
  // ClaudeBoardRunner substrate — that is the whole point of reusing infra).
  // But it must NOT carry Saga 2 product-orchestrator concerns: no stage
  // transition logic, no recovery tree, no advisor, no settlement policy. Those
  // belong to later D-slices. This test guards the engine against silently
  // becoming a second Saga 2 pump.
  const engineSrc = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'src', 'engines', 'saga3-discovery-engine.ts'),
    'utf8',
  );
  // Reuses the existing worker-execution substrate (roadmap §8.D1).
  assert.match(engineSrc, /WorkerExecutorFactory/);
  assert.match(engineSrc, /workerExecutorFactory/);
  assert.match(engineSrc, /concurrency: 1/);
  // Must NOT import Saga 2 product-policy modules.
  assert.doesNotMatch(engineSrc, /from\s+['"][^'"]*orchestrate(\.js)?['"]/);
  assert.doesNotMatch(engineSrc, /generateNextForCompletedTask|workflow_generate_next/);
  assert.doesNotMatch(engineSrc, /episode_transition|tryAdvanceStage/);
  // D2/D3/D4/D5 concerns are explicitly deferred (no advisor/settlement/normalize).
  assert.doesNotMatch(engineSrc, /AssessDiscoveryReadiness|DiscoveryOutcomeCertificate|SettlementPolicy/);
  // It implements the shared port, not a parallel one.
  assert.match(engineSrc, /implements OrchestrationEngine/);
  assert.match(engineSrc, /discovery_only/);
});

test('D1: saga3-discovery engine is pure — no direct SQLite / getDb / concrete repository', () => {
  // Phase B pure-engine boundary, restored by the D1 correction. The engine
  // must consume the Saga3DiscoveryRuntimePersistence PORT only — no getDb,
  // no .prepare, no concrete Saga3ProposalRepository construction. This guard
  // fails the moment someone reintroduces inline SQL into the engine.
  const engineSrc = readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'src', 'engines', 'saga3-discovery-engine.ts'),
    'utf8',
  );
  assert.doesNotMatch(engineSrc, /\bgetDb\b/);
  assert.doesNotMatch(engineSrc, /\.prepare\s*\(/);
  assert.doesNotMatch(engineSrc, /new Saga3ProposalRepository/);
  // The port is the only persistence surface the engine is allowed.
  assert.match(engineSrc, /runtimePersistence/);
  assert.match(engineSrc, /Saga3DiscoveryRuntimePersistence/);
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

test('composition root selects the engine through the real wiring, not a source regex (saga3-discovery)', async () => {
  // Real selection test: build the application with an explicit mode and run an
  // episode. This catches wiring errors a source-regex test cannot. We inject
  // fakes so no real process/worker/DB is touched.
  const { Saga3DiscoveryEngine } = await import('../../dist/engines/saga3-discovery-engine.js');
  const { createSagaApplication } = await import(
    '../../dist/application/saga-application.js'
  );

  let workerFactoryCalls = 0;
  const heartbeats = [];
  // D1 Saga3DiscoveryEngine: observable through its OWN distinct behaviour — the
  // duplicate-lock exit path. This proves the engine was selected and its run()
  // executed (not just that the source contains the right string). A duplicate
  // lock makes the engine exit before touching the worker substrate, so the
  // worker factory is never constructed.
  const app = createSagaApplication({
    engine: new Saga3DiscoveryEngine({
      config: fullConfig(),
      workerExecutorFactory: () => { workerFactoryCalls += 1; throw new Error('must not build worker on duplicate lock'); },
      persistence: {
        episodes: { currentStage: () => 'discovery', readOpenIntentByEpic: () => null },
        tasks: {}, executions: {}, workspaces: {},
      },
      host: {
        processId: 7,
        workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s' },
        now: () => 0,
        sleep: async () => {},
        heartbeat: (_ctx, event, msg) => heartbeats.push([event, msg]),
        acquireEngineLock: () => ({ status: 'duplicate', ownerPid: 888 }),
        releaseEngineLock: () => { throw new Error('duplicate run must not release another owner lock'); },
      },
      // Conveyor deps (Slice 1 Zones 5-7): required by the engine deps
      // interface even though the duplicate-lock path never reaches assignTask.
      workAssignment: { assignTask: () => null, releaseAssignment: () => {}, countClaimable: () => 0 },
      idGenerator: { newId: () => 'id', newTypedId: (p) => `${p}:1` },
      machineId: 'test-host',
    }),
    board: { listProjects: () => [], loadProjectBoard: () => ({ epics: [], epicById: {}, tasks: [] }) },
    engineAdministration: {
      start() { return { projectId: 1, epicId: 2, running: true, alive: true, pid: 1, concurrency: 1, startedAt: 'x' }; },
      stop() { return { projectId: 1, epicId: 2, running: false, alive: false, pid: null, concurrency: null, startedAt: null }; },
      restart() { return { projectId: 1, epicId: 2, running: true, alive: true, pid: 1, concurrency: 1, startedAt: 'x' }; },
      setConcurrency() {}, status() { return { projectId: 1, epicId: 2, running: false, alive: false, pid: null, concurrency: null, startedAt: null }; },
      dispose() {},
    },
    close: () => {},
  });

  const result = await app.runEpisode({ projectId: 1, epicId: 2, concurrency: 1 });
  // D1 engine owns its own lock check — the DUPLICATE_EXIT heartbeat is its
  // signature, distinct from Saga 2's identical-path but proving selection.
  assert.equal(result.reason, 'failed');
  assert.match(result.lastError, /PID 888/);
  assert.equal(workerFactoryCalls, 0, 'duplicate lock must short-circuit before worker substrate');
  assert.equal(heartbeats.some(([e]) => e === 'DUPLICATE_EXIT'), true, 'D1 engine emitted its DUPLICATE_EXIT heartbeat');
});

test('composition root throws PRODUCT_LIFECYCLE_DEPENDENCIES_REQUIRED without productLifecycle override', async () => {
  // saga4 cutover: there is no Saga2Engine fall-through anymore. The lifecycle
  // runtime is the only engine, so calling the application factory without the
  // productLifecycle override must fail-loud instead of silently selecting a
  // legacy engine.
  const { createSaga2Application } = await import(
    '../../dist/app/composition-root.js'
  );
  assert.throws(
    () => createSaga2Application(
      { DB_PATH: '/tmp/saga.db' },
      {
        config: fullConfig(),
        host: {
          processId: 7,
          workerPaths: { sagaEntry: '/e', sagaSkillRoot: '/s' },
          now: () => 0,
          sleep: async () => {},
          heartbeat: () => {},
          acquireEngineLock: () => ({ status: 'acquired', ownerPid: 7 }),
          releaseEngineLock: () => {},
        },
        persistence: {
          episodes: {}, tasks: {}, executions: {}, workspaces: {},
        },
        workerExecutorFactory: () => { throw new Error('must not build a worker'); },
      },
    ),
    /PRODUCT_LIFECYCLE_DEPENDENCIES_REQUIRED/,
  );
});
