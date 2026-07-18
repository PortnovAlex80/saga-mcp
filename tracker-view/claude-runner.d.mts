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
    task_kind: string | null;
    execution_mode?: string | null;
    project_repository_id?: number | null;
    tags?: string;
    execution_skill?: string | null;
    review_skill?: string | null;
    workflow_stage?: string | null;
  };
  skill: string | null;
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
  claimTask: (args: { worker_id: string; project_id: number; machine_id?: string }) => RunnerAssignment | null;
  getProject: (projectId: number) => unknown;
  getTaskState: (taskId: number) => unknown;
  recoverAssignment: (args: {
    taskId: number;
    workerId: string;
    originalStatus: string;
    reason: string;
  }) => boolean;
  resolveWorkspace: (project: unknown) => string | null;
  spawn?: typeof nodeSpawnType;
  claudePath?: string;
  dbPath: string;
  sagaEntry: string;
  sagaSkillRoot: string;
  logRoot?: string;
  heartbeatLog?: string;
}

export interface ClaudeBoardRunner {
  start(args: { projectId: number; concurrency: number }): RunnerRunSnapshot;
  stop(projectId: number): RunnerRunSnapshot | null;
  status(projectId: number): RunnerRunSnapshot | null;
  setConcurrency(projectId: number, concurrency: number): void;
  dispose(): void;
}

export declare function createClaudeBoardRunner(options: ClaudeBoardRunnerOptions): ClaudeBoardRunner;
