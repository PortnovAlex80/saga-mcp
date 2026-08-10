import type { WorkerModelRoute } from './worker-executor.js';

export interface StageTaskCounts {
  claimable: number;
  inFlight: number;
  doneInCurrentStage: number;
}

export interface TerminalBookkeepingCounts {
  claimable: number;
  inFlight: number;
}

export interface StrandedTaskProjection {
  id: number;
  task_kind: string;
  status: string;
}

export interface RateLimitTaskProjection {
  id: number;
  assigned_to: string;
}

export interface RecoveryTaskCreate {
  epicId: number;
  title: string;
  description: string;
  workflowStage: string;
  tags: string[];
  activitySummary: string;
}

export interface ExecutionReconcileProjection {
  executionId: string;
  taskId: number;
  action: 'kept' | 'lost' | 'terminated' | 'remote_unknown';
  released: boolean;
  reason: string;
}

export interface ConcurrencyAdmissionSnapshot {
  operatorConcurrency: number;
  modelConcurrencyLimit: number;
  effectiveConcurrency: number;
  activeExecutions: number;
}

/**
 * Persistence boundary for episode workflow state and metadata.
 *
 * (`ensureWorkflow`, `pause`, `clearNeedsHuman`, `isNeedsHuman`, `patchMetadata`,
 * `readLatestBriefDecision`, `readHealMetadata`) were removed. Lifecycle pause
 * owns needs-human (LifecycleRun.status='paused'), brief decisions live on the
 * brief artifact, and heal metadata lives on the recovery task.
 */
export interface EpisodeRuntimeRepository {
  currentStage(epicId: number): string | null;
  projectIdForEpic(epicId: number): number | null;
  /** Fail-closed durable capacity view used immediately before worker claim. */
  readConcurrencyAdmission(epicId: number): ConcurrencyAdmissionSnapshot;
  readWorkerModelRoute(epicId: number | null): WorkerModelRoute;
}

/** Persistence boundary for orchestration-visible task state. */
export interface TaskRuntimeRepository {
  countStageTasks(epicId: number, stage: string): StageTaskCounts;
  listGenerationCandidateIds(epicId: number): number[];
  hasActiveRecovery(epicId: number): boolean;
  listStrandedTasks(epicId: number, stage: string): StrandedTaskProjection[];
  recordPostTransitionSweep(epicId: number, strandedList: string, summary: string): void;
  createRecoveryTask(command: RecoveryTaskCreate): number;
  terminalBookkeepingCounts(epicId: number, stage: string): TerminalBookkeepingCounts;
  reevaluateDoneDependencies(epicId: number): void;
  listRateLimitTasks(epicId: number): RateLimitTaskProjection[];
}

/** Persistence/process boundary for durable worker execution reconciliation. */
export interface ExecutionRuntimeRepository {
  reconcile(projectId: number, epicId: number): ExecutionReconcileProjection[];
  /**
   * CONVEYOR Wave 5: renew the liveness lease for every active execution on
   * this machine for the given project/epic. The supervisor calls this on each
   * sweep so lease_expires_at + heartbeat_at advance while the worker process
   * is alive — independent of model behaviour. This is the "liveness heartbeat"
   * that does NOT depend on the language model remembering to call a tool.
   * Returns the count of leases renewed.
   */
  renewLeases(projectId: number, epicId: number, leaseTtlMs: number): number;
  /**
   * CONVEYOR Wave 5 — progress signal (§363-370). Records that the worker
   * produced observable activity. This is the PROGRESS heartbeat, distinct
   * from renewLeases (liveness). The stuck-policy measures silence against
   * this timestamp; WITHOUT progress updates a long-running-but-healthy
   * worker is falsely classified as stuck.
   */
  reportProgress(input: {
    executionId: string;
    fenceToken: string;
    now?: Date;
  }): boolean;
}

export interface WorkspaceResolution {
  projectExists: boolean;
  workspaceRoot: string | null;
}

/** Resolves the registered checkout used by worker processes. */
export interface WorkspaceResolver {
  resolve(projectId: number): WorkspaceResolution;
}

export interface FactoryRuntimePersistence {
  episodes: EpisodeRuntimeRepository;
  tasks: TaskRuntimeRepository;
  executions: ExecutionRuntimeRepository;
  workspaces: WorkspaceResolver;
}
