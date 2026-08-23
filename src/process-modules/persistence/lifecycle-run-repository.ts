import type {
  CompleteLifecycleStageCommand,
  EnsureLifecycleStageRunCommand,
  LifecycleRunRecord,
  LifecycleRunStatus,
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

/**
 * CC-GAP-4 — the durable verdict of a `run.terminal` emission claim.
 *
 * `claimed: true` means THIS caller is the single effective emitter for the
 * terminalized scope (exactly one `run.terminal` journal event may be
 * appended). `claimed: false` means a prior caller already claimed the
 * terminal fact for the same lifecycle run and the event must NOT be
 * emitted again. `null` means the durable run is missing or not terminal —
 * fail-closed: no authority fact, no claim, no event.
 */
export interface RunTerminalEventClaim {
  claimed: boolean;
  status: LifecycleRunStatus;
  terminalStatus: string | null;
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

  list(
    projectId: number,
    epicId?: number,
  ): readonly LifecycleRunRecord[];

  listStageRuns(lifecycleRunId: number): readonly LifecycleStageRunRecord[];

  listTransitions(
    lifecycleRunId: number,
  ): readonly LifecycleTransitionRecord[];

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

  /**
   * CC-GAP-4 — deterministic idempotent claim of the `run.terminal` journal
   * boundary, one claim per terminalized scope (the lifecycle run).
   *
   * Two competing paths drive the same lifecycle to (or back through) its
   * terminal result — the dispatch loop and the transition-obligation
   * re-drive — and both re-enter the engine adapter, which replays the
   * durable terminal record. The adapter must therefore learn from the
   * AUTHORITY whether this terminalization has already been journalled, not
   * from its own in-memory state (a second engine process must reach the
   * same verdict). The claim is a single atomic insert keyed by the
   * lifecycle run id; SQLite serializes concurrent claimants, so exactly
   * one caller ever receives `claimed: true`, deterministically,
   * independent of process count, restarts, or interleaving.
   *
   * Claiming against a non-terminal row returns `null` WITHOUT burning the
   * claim, so a premature probe cannot suppress the real terminalization's
   * event. The journal stays a pure projection: a claim lost to a crash
   * between claim and append loses one projection line, never a production
   * fact (run-journal.ts discipline). Callers on the engine path must treat
   * the claim as observation (N1): the adapter boundary invokes it
   * fail-silent, so a post-commit storage error here costs at most one
   * projection line (the honest 0..1 envelope per scope) and never engine
   * behavior.
   */
  claimRunTerminalEvent(lifecycleRunId: number): RunTerminalEventClaim | null;
}
