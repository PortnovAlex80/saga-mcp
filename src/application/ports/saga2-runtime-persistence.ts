import type { WorkerModelRoute } from './worker-executor.js';

export type BriefDecision = 'go' | 'fast-track' | 'clarify' | 'reject';

export interface EpisodeHealMetadata {
  lastHealError: string | null;
  lastHealAttempt: string | null;
}

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

/** Persistence boundary for episode workflow state and metadata. */
export interface EpisodeRuntimeRepository {
  ensureWorkflow(epicId: number): void;
  currentStage(epicId: number): string | null;
  projectIdForEpic(epicId: number): number | null;
  pause(epicId: number, reason: string): void;
  clearNeedsHuman(epicId: number): void;
  isNeedsHuman(epicId: number): boolean;
  readLatestBriefDecision(epicId: number): BriefDecision | null;
  readHealMetadata(epicId: number): EpisodeHealMetadata;
  readTargetConcurrency(epicId: number, fallbackConcurrency: number): number;
  readWorkerModelRoute(epicId: number | null): WorkerModelRoute;
  patchMetadata(epicId: number, patch: Record<string, unknown>): void;
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
}

export interface WorkspaceResolution {
  projectExists: boolean;
  workspaceRoot: string | null;
}

/** Resolves the registered checkout used by worker processes. */
export interface WorkspaceResolver {
  resolve(projectId: number): WorkspaceResolution;
}

export interface Saga2RuntimePersistence {
  episodes: EpisodeRuntimeRepository;
  tasks: TaskRuntimeRepository;
  executions: ExecutionRuntimeRepository;
  workspaces: WorkspaceResolver;
}
