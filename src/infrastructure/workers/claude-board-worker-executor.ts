import type {
  WorkerExecutor,
  WorkerExecutorStart,
  WorkerRunSnapshot,
} from '../../application/ports/worker-executor.js';

export interface LegacyClaudeBoardRunner {
  start(command: {
    projectId: number;
    epicId?: number | null;
    concurrency: number;
    claimScope?: {
      taskIds?: number[];
    };
  }): WorkerRunSnapshot;
  stop(projectId: number): WorkerRunSnapshot | null;
  status(projectId: number): WorkerRunSnapshot | null;
  setConcurrency(projectId: number, concurrency: number): void;
  dispose(): void;
}

/**
 * Compatibility adapter over tracker-view/claude-runner.mjs.
 *
 * The current runner remains untouched. A later extraction slice only needs to
 * construct this adapter and inject WorkerExecutor instead of importing the
 * tracker implementation from orchestration code.
 */
export class ClaudeBoardWorkerExecutor implements WorkerExecutor {
  constructor(private readonly runner: LegacyClaudeBoardRunner) {}

  start(command: WorkerExecutorStart): WorkerRunSnapshot {
    return this.runner.start(command);
  }

  stop(projectId: number): WorkerRunSnapshot | null {
    return this.runner.stop(projectId);
  }

  status(projectId: number): WorkerRunSnapshot | null {
    return this.runner.status(projectId);
  }

  setConcurrency(projectId: number, concurrency: number): void {
    this.runner.setConcurrency(projectId, concurrency);
  }

  dispose(): void {
    this.runner.dispose();
  }
}
