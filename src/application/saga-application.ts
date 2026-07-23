import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from './ports/orchestration-engine.js';

export interface SagaApplication {
  runEpisode(command: RunEpisodeCommand): Promise<OrchestrationRunResult>;
  close(): void;
}

export interface SagaApplicationDependencies {
  engine: OrchestrationEngine;
  close?: () => void;
}

/**
 * Engine-neutral application host.
 *
 * It deliberately contains no SQLite, Claude, LM Studio, filesystem, Git, or
 * frontend code. Those dependencies are assembled by the composition root.
 */
export function createSagaApplication(
  dependencies: SagaApplicationDependencies,
): SagaApplication {
  let closed = false;

  return {
    runEpisode(command) {
      if (closed) throw new Error('Saga application is closed');
      return dependencies.engine.run(command);
    },

    close() {
      if (closed) return;
      closed = true;
      dependencies.close?.();
    },
  };
}
