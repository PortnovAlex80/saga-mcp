import type {
  BoardProjectSummary,
  BoardProjectionReader,
  ProjectBoardProjection,
} from './ports/board-projection.js';
import type {
  EngineAdministration,
  EngineStartCommand,
  EngineStateSnapshot,
} from './ports/engine-administration.js';
import type {
  OrchestrationEngine,
  OrchestrationRunResult,
  RunEpisodeCommand,
} from './ports/orchestration-engine.js';

export interface SagaApplication {
  runEpisode(command: RunEpisodeCommand): Promise<OrchestrationRunResult>;
  listProjects(): BoardProjectSummary[];
  loadProjectBoard(projectId: number): ProjectBoardProjection;
  startEngine(command: EngineStartCommand): EngineStateSnapshot;
  stopEngine(epicId: number): EngineStateSnapshot;
  restartEngine(command: EngineStartCommand): EngineStateSnapshot;
  setEngineConcurrency(epicId: number, concurrency: number): EngineStateSnapshot;
  getEngineStatus(epicId: number): EngineStateSnapshot;
  close(): void;
}

export interface SagaApplicationDependencies {
  engine: OrchestrationEngine;
  board: BoardProjectionReader;
  engineAdministration: EngineAdministration;
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

    startEngine(command) {
      assertOpen();
      return dependencies.engineAdministration.start(command);
    },

    stopEngine(epicId) {
      assertOpen();
      return dependencies.engineAdministration.stop(epicId);
    },

    restartEngine(command) {
      assertOpen();
      return dependencies.engineAdministration.restart(command);
    },

    setEngineConcurrency(epicId, concurrency) {
      assertOpen();
      return dependencies.engineAdministration.setConcurrency(epicId, concurrency);
    },

    getEngineStatus(epicId) {
      assertOpen();
      return dependencies.engineAdministration.status(epicId);
    },

    close() {
      if (closed) return;
      closed = true;
      try {
        dependencies.engineAdministration.dispose();
      } finally {
        dependencies.close?.();
      }
    },
  };
}
