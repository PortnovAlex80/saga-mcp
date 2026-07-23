import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../application/ports/orchestration-engine.js';
import type { LegacySaga2Runner } from '../application/ports/legacy-saga2-runtime.js';
import type { SagaRuntimeConfig } from '../runtime/saga-runtime-config.js';

export interface Saga2EngineDependencies {
  config: SagaRuntimeConfig;
  runLegacy: LegacySaga2Runner;
}

/**
 * Compatibility adapter around the proven Saga 2 pump.
 *
 * The class contains no SQLite, child-process, tracker, MCP, or concrete pump
 * imports. The composition root supplies the infrastructure implementation.
 */
export class Saga2Engine implements OrchestrationEngine {
  private readonly config: SagaRuntimeConfig;
  private readonly runLegacy: LegacySaga2Runner;

  constructor(dependencies: Saga2EngineDependencies) {
    this.config = dependencies.config;
    this.runLegacy = dependencies.runLegacy;
  }

  async run(command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    return this.runLegacy({
      projectId: command.projectId,
      epicId: command.epicId,
      concurrency: command.concurrency,
      claudePath: this.config.claudePath,
    });
  }
}

export type { LegacySaga2Runner } from '../application/ports/legacy-saga2-runtime.js';
