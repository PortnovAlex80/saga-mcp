import type { BoardProjectionReader } from '../application/ports/board-projection.js';
import type { EngineAdministration } from '../application/ports/engine-administration.js';
import type { Saga2HostRuntime } from '../application/ports/saga2-host-runtime.js';
import type { Saga2RuntimePersistence } from '../application/ports/saga2-runtime-persistence.js';
import type { WorkerExecutorFactory } from '../application/ports/worker-executor.js';
import { createSagaApplication, type SagaApplication } from '../application/saga-application.js';
import { closeDb } from '../db.js';
import { Saga2Engine } from '../engines/saga2-engine.js';
import { Saga3DiscoveryEngine } from '../engines/saga3-discovery-engine.js';
import { SqliteSaga3DiscoveryRuntime } from '../saga3/persistence/sqlite-saga3-discovery-runtime.js';
import type { OrchestrationEngine } from '../application/ports/orchestration-engine.js';
import { LegacyEngineAdministration } from '../infrastructure/engine/legacy-engine-administration.js';
import {
  SqliteEpisodeRuntimeRepository,
  SqliteExecutionRuntimeRepository,
  SqliteTaskRuntimeRepository,
} from '../infrastructure/persistence/sqlite-saga2-runtime-repositories.js';
import { SqliteBoardProjectionReader } from '../infrastructure/projections/sqlite-board-projection-reader.js';
import { NodeSaga2HostRuntime } from '../infrastructure/runtime/node-saga2-host-runtime.js';
import { createLegacyClaudeWorkerExecutorFactory } from '../infrastructure/workers/legacy-claude-worker-executor-factory.js';
import { SqliteWorkspaceResolver } from '../infrastructure/workspaces/sqlite-workspace-resolver.js';
import {
  loadSagaRuntimeConfig,
  type SagaRuntimeConfig,
} from '../runtime/saga-runtime-config.js';
import { isSaga3DiscoveryMode } from '../runtime/orchestration-mode.js';

export interface Saga2CompositionOverrides {
  config?: SagaRuntimeConfig;
  workerExecutorFactory?: WorkerExecutorFactory;
  persistence?: Saga2RuntimePersistence;
  host?: Saga2HostRuntime;
  board?: BoardProjectionReader;
  engineAdministration?: EngineAdministration;
  close?: () => void;
}

/**
 * The only place that selects concrete Saga 2 runtime implementations.
 *
 * CLI and HTTP hosts consume SagaApplication and do not import the pump,
 * ClaudeBoardRunner, SQLite projection SQL, process control or environment.
 */
export function createSaga2Application(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Saga2CompositionOverrides = {},
): SagaApplication {
  const config = overrides.config ?? loadSagaRuntimeConfig(env);
  const persistence = overrides.persistence ?? {
    episodes: new SqliteEpisodeRuntimeRepository(),
    tasks: new SqliteTaskRuntimeRepository(),
    executions: new SqliteExecutionRuntimeRepository(),
    workspaces: new SqliteWorkspaceResolver(),
  };
  const workerExecutorFactory = overrides.workerExecutorFactory
    ?? createLegacyClaudeWorkerExecutorFactory({
      modelRouteReader: epicId => persistence.episodes.readWorkerModelRoute(epicId),
    });
  const host = overrides.host ?? new NodeSaga2HostRuntime();
  const engine = selectEngine(config, persistence, workerExecutorFactory, host);
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

/**
 * Selects the concrete orchestration engine behind the OrchestrationEngine port.
 *
 * This is the single composition-root switch (roadmap §5.2):
 *
 *   SAGA_ORCHESTRATION_MODE=saga3-discovery -> Saga3DiscoveryEngine
 *   SAGA_ORCHESTRATION_MODE=v2|v3|saga2     -> Saga2Engine
 *
 * An unknown mode never reaches here — parseOrchestrationMode (runtime/
 * orchestration-mode.ts) rejects it at config-load time, so there is no silent
 * fallback to the wrong engine. isSaga3DiscoveryMode is the one condition that
 * decides engine selection; requiresBackgroundEngine is the one condition that
 * decides whether the tracker spawns a background process. Both live in the
 * same module so the two decisions can never disagree.
 *
 * The Saga 3 discovery engine reuses the shared persistence/worker layer.
 * Product worker, advisor and settlement layers are added in D1–D6.
 */
function selectEngine(
  config: SagaRuntimeConfig,
  persistence: Saga2RuntimePersistence,
  workerExecutorFactory: WorkerExecutorFactory,
  host: Saga2HostRuntime,
): OrchestrationEngine {
  if (isSaga3DiscoveryMode(config.orchestrationMode)) {
    return new Saga3DiscoveryEngine({
      config,
      workerExecutorFactory,
      persistence,
      host,
      runtimePersistence: new SqliteSaga3DiscoveryRuntime(),
    });
  }
  // Every other recognised mode (v2 / v3 / saga2) selects Saga2Engine. An
  // unknown mode never reaches here — parseOrchestrationMode rejects it at
  // config-load time, so there is no silent fallback to the wrong engine.
  return new Saga2Engine({
    config,
    workerExecutorFactory,
    persistence,
    host,
  });
}
