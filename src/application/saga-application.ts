import type {
  BoardProjectSummary,
  BoardProjectionReader,
  ProjectBoardProjection,
} from './ports/board-projection.js';
import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from './ports/orchestration-engine.js';

export interface SagaApplication {
  runEpisode(command: RunEpisodeCommand): Promise<OrchestrationRunResult>;
  listProjects(): BoardProjectSummary[];
  loadProjectBoard(projectId: number): ProjectBoardProjection;
  close(): void;
}

export interface SagaApplicationDependencies {
  engine: OrchestrationEngine;
  board: BoardProjectionReader;
  close?: () => void;
}

/**
 * Engine-neutral application host.
 *
 * It coordinates stable ports only. SQLite, Claude, LM Studio, filesystem,
 * Git, HTTP, and concrete engine code are selected by the composition root.
 */
export function createSagaApplication(
  dependencies: SagaApplicationDependencies,
): SagaApplication {
  let closed = false;

  const assertOpen = () => {
    if (closed) throw new Error('Saga application is closed');
  };

  return {
    runEpisode(command) {
      assertOpen();
      return dependencies.engine.run(command);
    },

    listProjects() {
      assertOpen();
      return dependencies.board.listProjects();
    },

    loadProjectBoard(projectId) {
      assertOpen();
      return dependencies.board.loadProjectBoard(projectId);
    },

    close() {
      if (closed) return;
      closed = true;
      dependencies.close?.();
    },
  };
}
