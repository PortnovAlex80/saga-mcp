// Type shim for tracker-view/claude-runner.mjs — a .mjs CommonJS module that
// tsc's strict mode refuses to import as `any`. The runtime module exports
// `createClaudeBoardRunner` and the `ClaudeBoardRunner` class; we re-declare
// the surface the engine (src/orchestrate.ts) consumes. Keep this in sync
// with claude-runner.mjs if you change the constructor options or methods.
import type { spawn as nodeSpawnType } from 'node:child_process';

export interface RunnerAssignment {
  task: {
    id: number;
    title: string;
    status: string;
    epic_id?: number | null;
    task_kind: string | null;
    metadata?: string | Record<string, unknown> | null;
    execution_mode?: string | null;
    project_repository_id?: number | null;
    tags?: string;
    execution_skill?: string | null;
    review_skill?: string | null;
    workflow_stage?: string | null;
  };
  skill: string | null;
  execution_id?: string;
  repository?: {
    id: number;
    name: string;
    local_path: string | null;
    integration_branch: string;
    default_branch: string;
  } | null;
}

export interface RunnerRunSnapshot {
  id: string;
  project_id: number;
  project_name: string;
  concurrency: number;
  status: 'running' | 'stopping' | 'completed' | 'stopped' | 'failed';
  started_at: string;
  finished_at: string | null;
  active: Array<{
    task_id: number;
    title: string;
    worker_id: string;
    pid: number | null;
    started_at: string;
    log_path: string;
  }>;
  completed: number;
  failed: number;
  claimed: number;
  last_error: string | null;
}

export interface ClaudeBoardRunnerOptions {
  /** @deprecated Slice 1 Zones 1-4: the runner is strictly one-card and no
   *  longer calls back to claimTask. Kept optional for type compatibility with
   *  runners that still carry a no-op callback; the pump path never invokes it. */
  claimTask?: (args: { worker_id: string; project_id: number; machine_id?: string; epic_id?: number; execution_id?: string; run_id?: string }) => RunnerAssignment | null;
  getProject: (projectId: number) => unknown;
  getTaskState: (taskId: number) => unknown;
  /** Read the full task row. Used by the pre-assigned-card path to rebuild the
   *  launch()-shaped assignment from an AssignedWork without an in-process claim. */
  getTask?: (taskId: number) => unknown;
  recoverAssignment: (args: {
    taskId: number;
    workerId: string;
    originalStatus: string;
    executionId?: string | null;
    reason: string;
    /** true = launch() threw (process never started) → spawn_failed + human pause.
     *  false/absent = process started but ended without worker_done → lost + repair_wait. */
    spawnFailure?: boolean;
  }) => boolean;
  resolveWorkspace: (project: unknown) => string | null;
  spawn?: typeof nodeSpawnType;
  claudePath?: string;
  /** Routing cutover: explicit real-claude CLI path (executor_kind=claude-cli). */
  realClaudePath?: string;
  /** Routing cutover: explicit simulator path (executor_kind=claude-cli-simulator). */
  simulatorPath?: string;
  dbPath: string;
  sagaEntry: string;
  sagaSkillRoot: string;
  logRoot?: string;
  heartbeatLog?: string;
  // Provider routing: read { model, provider, effort } from episode metadata so
  // the runner can redirect this worker's claude to LM Studio (provider='lmstudio')
  // via spawn env, or keep it on z.ai (default). Optional for test runners.
  // `effort` is the model-config-derived reasoning effort to pass as `--effort`
  // (e.g. 'high' for z.ai cloud). Absent for LM Studio models → the runner
  // omits `--effort` entirely so the local chat template picks its own default
  // (LM Studio rejects effort='xhigh'/'high' for qwen models; see model catalog).
  getActiveModel?: (epicId: number | null) => { model: string | null; provider: string; effort?: string | null };
  lmstudioBaseUrl?: string;
}

export interface ClaudeBoardRunner {
  start(args: { projectId: number; epicId?: number; concurrency: number; assignment: unknown }): RunnerRunSnapshot;
  stop(projectId: number): RunnerRunSnapshot | null;
  status(projectId: number): RunnerRunSnapshot | null;
  setConcurrency(projectId: number, concurrency: number): void;
  dispose(): void;
}

export declare function createClaudeBoardRunner(options: ClaudeBoardRunnerOptions): ClaudeBoardRunner;
