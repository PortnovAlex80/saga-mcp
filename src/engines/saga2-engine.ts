import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../application/ports/orchestration-engine.js';
import type { Saga2HostRuntime } from '../application/ports/saga2-host-runtime.js';
import type { Saga2RuntimePersistence } from '../application/ports/saga2-runtime-persistence.js';
import type { WorkerExecutorFactory } from '../application/ports/worker-executor.js';
import { orchestrate } from '../orchestrate.js';
import type { SagaRuntimeConfig } from '../runtime/saga-runtime-config.js';

export interface Saga2EngineDependencies {
  config: SagaRuntimeConfig;
  workerExecutorFactory: WorkerExecutorFactory;
  persistence: Saga2RuntimePersistence;
  host: Saga2HostRuntime;
}

/**
 * Stable Saga 2 orchestration engine.
 *
 * The engine owns orchestration decisions and receives every external effect
 * through explicit ports. Replacing it with Saga3Engine does not change CLI,
 * tracker, SQLite adapters, worker runtime or engine administration.
 */
export class Saga2Engine implements OrchestrationEngine {
  private readonly dependencies: Saga2EngineDependencies;

  constructor(dependencies: Saga2EngineDependencies) {
    this.dependencies = dependencies;
  }

  async run(command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    const { config, workerExecutorFactory, persistence, host } = this.dependencies;
    return orchestrate({
      projectId: command.projectId,
      epicId: command.epicId,
      concurrency: command.concurrency,
      claudePath: config.claudePath,
      dbPath: config.dbPath,
      lmStudioUrl: config.lmStudioUrl,
      workerExecutorFactory,
      persistence,
      host,
    });
  }
}
