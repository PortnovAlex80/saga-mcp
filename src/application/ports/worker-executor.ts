export interface WorkerExecutorStart {
  projectId: number;
  epicId?: number | null;
  concurrency: number;
}

export interface WorkerModelRoute {
  model: string | null;
  provider: string;
  effort: string | null;
}

export type WorkerModelRouteReader = (
  epicId: number | null,
) => WorkerModelRoute;

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

export interface WorkerExecutorFactoryContext {
  projectId: number;
  epicId: number;
  workspaceRoot: string;
  dbPath: string;
  sagaEntry: string;
  sagaSkillRoot: string;
  claudePath?: string;
  logRoot?: string;
  heartbeatLog?: string;
  lmStudioUrl: string;
}

/**
 * Infrastructure port for Claude CLI, LM Studio-routed CLI, or any future
 * worker process runtime. The orchestration engine does not depend on spawn,
 * JSONL paths, MCP config construction, or provider-specific environment.
 */
export interface WorkerExecutor {
  start(command: WorkerExecutorStart): WorkerRunSnapshot;
  stop(projectId: number): WorkerRunSnapshot | null;
  status(projectId: number): WorkerRunSnapshot | null;
  setConcurrency(projectId: number, concurrency: number): void;
  dispose(): void;
}

export type WorkerExecutorFactory = (
  context: WorkerExecutorFactoryContext,
) => WorkerExecutor;
