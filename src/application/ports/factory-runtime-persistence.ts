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
  action: 'kept' | 'lost' | 'terminated' | 'exited' | 'remote_unknown';
  released: boolean;
  reason: string;
  /**
   * FIX 1 (2026-08-16 incident): released because the PID was dead or reused
   * by a foreign process (drives the sweep line's lost_dead_pid=N counter).
   */
  lostViaDeadPid?: boolean;
  /**
   * FIX 1: alive-but-foreign PID with a still-fresh heartbeat — the sweep
   * keeps the execution but must NOT renew its lease (renewLeases skips it)
   * so the heartbeat ages toward the stale gate.
   */
  withholdRenewal?: boolean;
  /**
   * FIX 1: PID liveness/identity could not be determined (tooling error);
   * the sweep keeps + renews per the OLD behavior and logs the degradation.
   */
  pidIdentityUnverifiable?: boolean;
  /**
   * ADR-087 physical-tail truthfulness: whether the OS PID was STILL ALIVE
   * when this sweep classified the row (false after a verified kill; null
   * when no liveness fact applies). Rides reaped projections so the
   * worker.exit observation can state it — `state='exited'` is semantic
   * protocol completion, never proof of physical process death.
   */
  pidAlive?: boolean | null;
}

export interface ConcurrencyAdmissionSnapshot {
  operatorConcurrency: number;
  modelConcurrencyLimit: number;
  effectiveConcurrency: number;
  activeExecutions: number;
  /**
   * C-4 (stage-11 PREVENTIVE-HUNT Layer 6): the model the NEXT claim would
   * freeze (the live controls model_name — the same value the claim
   * transaction freezes into execution_context.model_route.model).
   */
  requestedModel: string | null;
  /**
   * C-4: active in-flight executions grouped by their FROZEN model
   * (worker_executions.metadata.execution_context.model_route.model).
   * Executions without an execution context land in the '(unfrozen)' bucket.
   */
  activeByModel: Readonly<Record<string, number>>;
  /**
   * C-4: catalog limit of `requestedModel`; null when the model is unknown to
   * the factory catalog (fail-open — the controls ceiling then binds).
   */
  requestedModelLimit: number | null;
  /**
   * C-4: would ONE more claim of `requestedModel` stay within the per-model
   * frozen-limit aggregation? Admission must require BOTH this AND the live
   * epic-wide ceiling (activeExecutions < effectiveConcurrency).
   */
  modelSlotsAvailable: boolean;
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
   *
   * FIX 1 (2026-08-16 incident): `excludeExecutionIds` lists executions whose
   * PID is alive-but-foreign — their renewal is WITHHELD so heartbeat_at ages
   * toward the supervision stale gate instead of being refreshed forever.
   */
  renewLeases(
    projectId: number,
    epicId: number,
    leaseTtlMs: number,
    excludeExecutionIds?: readonly string[],
  ): number;
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
