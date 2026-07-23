import assert from 'node:assert/strict';
import test from 'node:test';

const {
  loadSagaRuntimeConfig,
} = await import('../../dist/runtime/saga-runtime-config.js');
const { Saga2Engine } = await import('../../dist/engines/saga2-engine.js');
const {
  createSagaApplication,
} = await import('../../dist/application/saga-application.js');
const {
  ClaudeBoardWorkerExecutor,
} = await import('../../dist/infrastructure/workers/claude-board-worker-executor.js');
const {
  LegacyBoardProjectionAdapter,
} = await import('../../dist/infrastructure/projections/legacy-board-projection.js');

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

  assert.throws(
    () => loadSagaRuntimeConfig({}),
    /DB_PATH env var is required/,
  );
});

test('Saga2Engine delegates to the proven pump through the engine-neutral contract', async () => {
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
    runLegacy: async options => {
      calls.push(options);
      return expected;
    },
  });

  const result = await engine.run({ projectId: 11, epicId: 22, concurrency: 3 });
  assert.deepEqual(result, expected);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    projectId: 11,
    epicId: 22,
    concurrency: 3,
    claudePath: '/opt/claude',
  });
});

test('Saga application host is engine-neutral and closes once', async () => {
  const commands = [];
  let closes = 0;
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
    close: () => { closes += 1; },
  });

  await application.runEpisode({ projectId: 1, epicId: 2, concurrency: 1 });
  assert.deepEqual(commands, [{ projectId: 1, epicId: 2, concurrency: 1 }]);
  application.close();
  application.close();
  assert.equal(closes, 1);
  assert.throws(
    () => application.runEpisode({ projectId: 1, epicId: 2 }),
    /Saga application is closed/,
  );
});

test('worker adapter preserves the existing board runner protocol', () => {
  const calls = [];
  const snapshot = {
    id: 'run-1',
    project_id: 1,
    concurrency: 2,
    status: 'running',
    active: [],
    completed: 0,
    failed: 0,
    claimed: 0,
  };
  const runner = {
    start(command) { calls.push(['start', command]); return snapshot; },
    stop(projectId) { calls.push(['stop', projectId]); return snapshot; },
    status(projectId) { calls.push(['status', projectId]); return snapshot; },
    setConcurrency(projectId, concurrency) {
      calls.push(['setConcurrency', projectId, concurrency]);
    },
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

test('frontend projection adapter preserves legacy board rows unchanged', () => {
  const projects = [{
    id: 1,
    name: 'Stable',
    status: 'active',
    total: 3,
    in_progress: 1,
    reviewing: 0,
  }];
  const board = {
    empty: false,
    epics: [],
    tasks: [],
  };
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
