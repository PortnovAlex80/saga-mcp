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
import { Saga3DiscoveryNormalizationService } from '../saga3/application/discovery-normalization-service.js';
import { Saga3DiscoveryReadinessService } from '../saga3/application/discovery-readiness-service.js';
import { Saga3DiscoverySettlementService } from '../saga3/application/discovery-settlement-service.js';
import { Saga3DiscoveryDiagnosisService } from '../saga3/application/discovery-diagnosis-service.js';
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
import {
  ExistingOrchestrationEngineAdapter,
  ProcessModuleRuntimeEngine,
} from '../process-modules/application/process-module-runtime-engine.js';
import { createBuiltInProcessModuleRegistry } from '../process-modules/modules/catalog.js';
import { DISCOVERY_PROCESS_MODULE_REF } from '../process-modules/modules/discovery/discovery-process-module.js';

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
 *   SAGA_ORCHESTRATION_MODE=saga3-discovery -> ProcessModuleRuntimeEngine
 *                                                -> Product Discovery module
 *                                                -> Saga3DiscoveryEngine adapter
 *   SAGA_ORCHESTRATION_MODE=v2|v3|saga2     -> Saga2Engine
 *
 * The Discovery-specific engine is now an execution adapter behind the generic
 * Process Module boundary. Its proven D1-D5 flow is preserved while module
 * identity, contracts, profiles and local outcome projection are supplied by
 * the Process Module registry. New modules can be registered without extending
 * the application-facing OrchestrationEngine contract.
 */
function selectEngine(
  config: SagaRuntimeConfig,
  persistence: Saga2RuntimePersistence,
  workerExecutorFactory: WorkerExecutorFactory,
  host: Saga2HostRuntime,
): OrchestrationEngine {
  if (isSaga3DiscoveryMode(config.orchestrationMode)) {
    const runtimePersistence = new SqliteSaga3DiscoveryRuntime();
    const normalizationService = new Saga3DiscoveryNormalizationService({
      config,
      workerExecutorFactory,
      host,
      runtimePersistence,
    });
    const readinessService = new Saga3DiscoveryReadinessService({
      config,
      workerExecutorFactory,
      host,
      runtimePersistence,
    });
    // D4: kernel-only settlement service — no worker executor, no LM client.
    const settlementService = new Saga3DiscoverySettlementService({
      runtimePersistence,
    });
    // D5: advisory diagnosis service. Mirrors the readiness/settlement service
    // wiring: a bounded worker lifecycle over the runtime persistence port. The
    // diagnosis is ADVISORY ONLY — it never changes the D4 authoritative result.
    const diagnosisService = new Saga3DiscoveryDiagnosisService({
      config,
      workerExecutorFactory,
      host,
      runtimePersistence,
    });
    const discoveryEngine = new Saga3DiscoveryEngine({
      config,
      workerExecutorFactory,
      persistence,
      host,
      runtimePersistence,
      normalizationService,
      readinessService,
      settlementService,
      diagnosisService,
    });

    const registry = createBuiltInProcessModuleRegistry();
    return new ProcessModuleRuntimeEngine(
      registry,
      DISCOVERY_PROCESS_MODULE_REF,
      new ExistingOrchestrationEngineAdapter(
        DISCOVERY_PROCESS_MODULE_REF,
        discoveryEngine,
        (_module, result) => {
          const certificateId = result.settlement?.certificateId;
          const proposalId = result.proposalId;
          return {
            code: result.outcome ?? result.reason,
            authority: result.outcomeAuthority ?? null,
            outputRef: certificateId !== undefined && certificateId !== null
              ? `certificate:${certificateId}`
              : proposalId !== undefined && proposalId !== null
                ? `proposal:${proposalId}`
                : null,
          };
        },
      ),
    );
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
