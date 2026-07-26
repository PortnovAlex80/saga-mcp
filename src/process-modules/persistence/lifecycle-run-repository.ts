import type {
  CompleteLifecycleStageCommand,
  EnsureLifecycleStageRunCommand,
  LifecycleRunRecord,
  LifecycleExecutionLease,
  LifecycleStageRunRecord,
  LifecycleTransitionRecord,
  StartLifecycleCommand,
} from './lifecycle-run.js';

export interface CompleteLifecycleStageResult {
  lifecycleRun: LifecycleRunRecord;
  stageRun: LifecycleStageRunRecord;
  transition: LifecycleTransitionRecord;
  replayed: boolean;
}

export interface LifecycleRunRepository {
  start(command: StartLifecycleCommand): {
    record: LifecycleRunRecord;
    replayed: boolean;
  };

  read(id: number): LifecycleRunRecord | null;

  readByIdempotencyKey(
    projectId: number,
    lifecycleRefKey: string,
    idempotencyKey: string,
  ): LifecycleRunRecord | null;

  listStageRuns(lifecycleRunId: number): readonly LifecycleStageRunRecord[];

  readCurrentStageRun(lifecycleRunId: number): LifecycleStageRunRecord | null;

  ensureStageRun(
    command: EnsureLifecycleStageRunCommand,
    lease: LifecycleExecutionLease,
  ): {
    record: LifecycleStageRunRecord;
    replayed: boolean;
  };

  bindProcessRun(
    lifecycleRunId: number,
    stageRunId: number,
    processRunId: number,
    lease: LifecycleExecutionLease,
  ): LifecycleStageRunRecord;

  markStageRunning(
    lifecycleRunId: number,
    stageRunId: number,
    lease: LifecycleExecutionLease,
  ): LifecycleStageRunRecord;

  pauseStage(
    lifecycleRunId: number,
    stageRunId: number,
    error: string,
    lease: LifecycleExecutionLease,
  ): LifecycleRunRecord;

  fail(
    lifecycleRunId: number,
    stageRunId: number | null,
    error: string,
    lease: LifecycleExecutionLease,
  ): LifecycleRunRecord;

  /** Explicit operator/controller resume. Merely acquiring a lease never resumes. */
  resume(lifecycleRunId: number, expectedVersion: number): LifecycleRunRecord;

  cancel(
    lifecycleRunId: number,
    expectedVersion: number,
    reason: string,
  ): LifecycleRunRecord;

  /** Running runs whose lease is absent or expired; paused runs are excluded. */
  listRecoverable(expiredBeforeIso: string): readonly LifecycleRunRecord[];

  completeStage(
    command: CompleteLifecycleStageCommand,
    lease: LifecycleExecutionLease,
  ): CompleteLifecycleStageResult;

  acquireExecutionLease(
    lifecycleRunId: number,
    owner: string,
    nowIso: string,
    expiresAtIso: string,
  ): LifecycleExecutionLease | null;

  renewExecutionLease(
    lifecycleRunId: number,
    lease: LifecycleExecutionLease,
    expiresAtIso: string,
  ): boolean;

  releaseExecutionLease(lifecycleRunId: number, lease: LifecycleExecutionLease): void;
}
