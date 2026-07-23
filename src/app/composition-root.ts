import type { BoardProjectionReader } from '../application/ports/board-projection.js';
import type { EngineAdministration } from '../application/ports/engine-administration.js';
import type { Saga2HostRuntime } from '../application/ports/saga2-host-runtime.js';
import type { Saga2RuntimePersistence } from '../application/ports/saga2-runtime-persistence.js';
import type { WorkerExecutorFactory } from '../application/ports/worker-executor.js';
import { createSagaApplication, type SagaApplication } from '../application/saga-application.js';
import { closeDb } from '../db.js';
import { Saga2Engine } from '../engines/saga2-engine.js';
import { Saga3DiscoveryEngine } from '../engines/saga3-discovery-engine.js';
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
 *   SAGA_ORCHESTRATION_MODE=saga2 (or any unrecognised value) -> Saga2Engine
 *   SAGA_ORCHESTRATION_MODE=saga3-discovery                    -> Saga3DiscoveryEngine
 *
 * The tracker, repositories, worker runtime and engine administration never
 * branch on this value themselves — they consume the same OrchestrationEngine
 * regardless of which implementation is wired here.
 *
 * The Saga 3 discovery engine reuses the shared persistence layer read-only in
 * D0 (it reports the current stage truthfully but never mutates it). Product
 * worker, advisor and settlement layers are added in D1–D6; D0 must not build
 * them.
 */
function selectEngine(
  config: SagaRuntimeConfig,
  persistence: Saga2RuntimePersistence,
  workerExecutorFactory: WorkerExecutorFactory,
  host: Saga2HostRuntime,
): OrchestrationEngine {
  if (config.orchestrationMode === 'saga3-discovery') {
    return new Saga3DiscoveryEngine({
      readStage: epicId => persistence.episodes.currentStage(epicId),
    });
  }
  return new Saga2Engine({
    config,
    workerExecutorFactory,
    persistence,
    host,
  });
}
