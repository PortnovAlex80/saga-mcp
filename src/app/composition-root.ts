import type { BoardProjectionReader } from '../application/ports/board-projection.js';
import type { EngineAdministration } from '../application/ports/engine-administration.js';
import type { LegacySaga2Runner } from '../application/ports/legacy-saga2-runtime.js';
import type { Saga2RuntimePersistence } from '../application/ports/saga2-runtime-persistence.js';
import type { WorkerExecutorFactory } from '../application/ports/worker-executor.js';
import { createSagaApplication, type SagaApplication } from '../application/saga-application.js';
import { closeDb } from '../db.js';
import { Saga2Engine } from '../engines/saga2-engine.js';
import { LegacyEngineAdministration } from '../infrastructure/engine/legacy-engine-administration.js';
import {
  SqliteEpisodeRuntimeRepository,
  SqliteExecutionRuntimeRepository,
  SqliteTaskRuntimeRepository,
} from '../infrastructure/persistence/sqlite-saga2-runtime-repositories.js';
import { SqliteBoardProjectionReader } from '../infrastructure/projections/sqlite-board-projection-reader.js';
import { createLegacySaga2Runner } from '../infrastructure/runtime/legacy-saga2-runner.js';
import { createLegacyClaudeWorkerExecutorFactory } from '../infrastructure/workers/legacy-claude-worker-executor-factory.js';
import { SqliteWorkspaceResolver } from '../infrastructure/workspaces/sqlite-workspace-resolver.js';
import {
  loadSagaRuntimeConfig,
  type SagaRuntimeConfig,
} from '../runtime/saga-runtime-config.js';

export interface Saga2CompositionOverrides {
  config?: SagaRuntimeConfig;
  runLegacy?: LegacySaga2Runner;
  workerExecutorFactory?: WorkerExecutorFactory;
  persistence?: Saga2RuntimePersistence;
  board?: BoardProjectionReader;
  engineAdministration?: EngineAdministration;
  close?: () => void;
}

/**
 * The only place that selects concrete Saga 2 runtime implementations.
 *
 * CLI and HTTP hosts consume SagaApplication and do not import the pump,
 * ClaudeBoardRunner, SQLite projection SQL, process control, or environment.
 */
export function createSaga2Application(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Saga2CompositionOverrides = {},
): SagaApplication {
  const config = overrides.config ?? loadSagaRuntimeConfig(env);
  const workerExecutorFactory = overrides.workerExecutorFactory
    ?? createLegacyClaudeWorkerExecutorFactory();
  const persistence = overrides.persistence ?? {
    episodes: new SqliteEpisodeRuntimeRepository(),
    tasks: new SqliteTaskRuntimeRepository(),
    executions: new SqliteExecutionRuntimeRepository(),
    workspaces: new SqliteWorkspaceResolver(),
  };
  const runLegacy = overrides.runLegacy ?? createLegacySaga2Runner({
    dbPath: config.dbPath,
    lmStudioUrl: config.lmStudioUrl,
    workerExecutorFactory,
    persistence,
  });
  const engine = new Saga2Engine({ config, runLegacy });
  const board = overrides.board ?? new SqliteBoardProjectionReader(config.dbPath);
  const engineAdministration = overrides.engineAdministration
    ?? new LegacyEngineAdministration({ config, baseEnv: env });

  return createSagaApplication({
    engine,
    board,
    engineAdministration,
    close: overrides.close ?? closeDb,
  });
}
