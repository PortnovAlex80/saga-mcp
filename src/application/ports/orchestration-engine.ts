export interface RunEpisodeCommand {
  projectId: number;
  epicId: number;
  concurrency?: number;
}

export interface OrchestrationRunResult {
  projectId: number;
  epicId: number;
  finalStage: string;
  endedAt: string;
  reason: 'completed' | 'failed' | 'paused_timeout' | 'stopped';
  cycles: number;
  lastError: string | null;
}

/**
 * Stable application-facing boundary for any orchestration engine.
 *
 * The host, CLI, frontend controls, worker process infrastructure, SQLite
 * schema, and artifact subsystem must not depend on a concrete engine class.
 */
export interface OrchestrationEngine {
  run(command: RunEpisodeCommand): Promise<OrchestrationRunResult>;
}
