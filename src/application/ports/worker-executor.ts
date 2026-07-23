export interface WorkerExecutorStart {
  projectId: number;
  epicId?: number | null;
  concurrency: number;
}

export interface ActiveWorkerProjection {
  task_id: number;
  title?: string;
  worker_id: string;
  pid: number | null;
  started_at?: string;
  log_path?: string;
}

export interface WorkerRunSnapshot {
  id: string;
  project_id: number;
  project_name?: string;
  concurrency: number;
  status: string;
  started_at?: string;
  finished_at?: string | null;
  active: ActiveWorkerProjection[];
  completed: number;
  failed: number;
  claimed: number;
  last_error?: string | null;
}

/**
 * Infrastructure port for Claude CLI, LM Studio-routed CLI, or any future
 * worker process runtime. The orchestration engine must not depend on spawn,
 * JSONL paths, MCP config construction, or provider-specific environment.
 */
export interface WorkerExecutor {
  start(command: WorkerExecutorStart): WorkerRunSnapshot;
  stop(projectId: number): WorkerRunSnapshot | null;
  status(projectId: number): WorkerRunSnapshot | null;
  setConcurrency(projectId: number, concurrency: number): void;
  dispose(): void;
}
