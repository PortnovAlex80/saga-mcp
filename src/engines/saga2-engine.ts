import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from '../application/ports/orchestration-engine.js';
import type { SagaRuntimeConfig } from '../runtime/saga-runtime-config.js';
import {
  orchestrate,
  type OrchestrateOptions,
  type OrchestrateResult,
} from '../orchestrate.js';

export type LegacySaga2Runner = (
  options: OrchestrateOptions,
) => Promise<OrchestrateResult>;

export interface Saga2EngineDependencies {
  config: SagaRuntimeConfig;
  runLegacy?: LegacySaga2Runner;
}

/**
 * Compatibility adapter around the proven Saga 2 pump.
 *
 * No orchestration behavior is changed here. The class only presents the
 * stable engine-neutral contract to the application host. Future engines can
 * implement OrchestrationEngine without changing CLI/front/worker contracts.
 */
export class Saga2Engine implements OrchestrationEngine {
  private readonly config: SagaRuntimeConfig;
  private readonly runLegacy: LegacySaga2Runner;

  constructor(dependencies: Saga2EngineDependencies) {
    this.config = dependencies.config;
    this.runLegacy = dependencies.runLegacy ?? orchestrate;
  }

  async run(command: RunEpisodeCommand): Promise<OrchestrationRunResult> {
    const result = await this.runLegacy({
      projectId: command.projectId,
      epicId: command.epicId,
      concurrency: command.concurrency,
      claudePath: this.config.claudePath,
    });

    return result;
  }
}
