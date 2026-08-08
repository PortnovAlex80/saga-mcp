import type {
  AssignedWork,
  WorkerExecutor,
  WorkerExecutorStart,
  WorkerRunSnapshot,
} from '../../application/ports/worker-executor.js';
import { EXECUTION_CONTEXT_POLICY_VERSION } from '../../shared/authority/execution-context.js';
import { getDb } from '../../db.js';
import { releaseExecutionAtomically } from '../../lifecycle/atomic-release.js';
import { ConveyorRuntime } from '../../application/conveyor-runtime.js';
import { SqliteWorkplaceRepository } from '../workplace/sqlite-workplace-repository.js';
import { deserializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

export interface ClaudeBoardRunner {
  start(command: {
    projectId: number;
    epicId?: number | null;
    concurrency: number;
    assignment: AssignedWork;
  }): WorkerRunSnapshot;
  stop(projectId: number): WorkerRunSnapshot | null;
  status(projectId: number): WorkerRunSnapshot | null;
  setConcurrency(projectId: number, concurrency: number): void;
  dispose(): void;
}

/**
 * In-process replay function type. Replay is an internal production source of
 * the normal WorkerExecution abstraction, not another executor/factory mode.
 */
export type InProcessReplayFn = (input: {
  assignment: AssignedWork;
}) => void;

export class ClaudeBoardWorkerExecutor implements WorkerExecutor {
  private readonly replayRuns = new Map<number, {
    runId: string;
    assignment: AssignedWork;
    completed: boolean;
    snapshot: WorkerRunSnapshot;
  }>();

  constructor(
    private readonly runner: ClaudeBoardRunner,
    private readonly replayRunner?: InProcessReplayFn,
  ) {}

  start(command: WorkerExecutorStart): WorkerRunSnapshot {
    assertFrozenExecutionRoute(command.assignment);
    if (this.replayRunner && hasFrozenCapsule(command.assignment)) {
      const runId = `replay-${String(command.assignment.workerExecutionId)}`;
      const startedAt = new Date().toISOString();
      const initialSnapshot: WorkerRunSnapshot = {
        id: runId,
        project_id: command.projectId,
        concurrency: command.concurrency,
        status: 'running',
        started_at: startedAt,
        finished_at: null,
        active: [{
          task_id: Number(command.assignment.taskId),
          title: '',
          worker_id: command.assignment.workerId,
          pid: null,
          started_at: startedAt,
          log_path: undefined,
        }],
        completed: 0,
        failed: 0,
        claimed: 1,
        last_error: null,
      };
      const replayRun = {
        runId,
        assignment: command.assignment,
        completed: false,
        snapshot: initialSnapshot,
      };
      this.replayRuns.set(command.projectId, replayRun);

      // Same asynchronous host contract as a spawned worker: start() returns
      // running, then the execution becomes terminal and status() observes it.
      queueMicrotask(() => {
        try {
          this.replayRunner!({ assignment: command.assignment });
          finalizeReplaySuccess(command.assignment);
          replayRun.completed = true;
          replayRun.snapshot = {
            ...replayRun.snapshot,
            status: 'completed',
            finished_at: new Date().toISOString(),
            active: [],
            completed: 1,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try {
            // If worker_done was durably accepted before a later physical-close
            // error, semantic completion wins. Reconcile the fence instead of
            // falsely turning accepted work into a crash repair.
            if (hasAcceptedWorkerDone(String(command.assignment.workerExecutionId))) {
              finalizeReplaySuccess(command.assignment);
              replayRun.completed = true;
              replayRun.snapshot = {
                ...replayRun.snapshot,
                status: 'completed',
                finished_at: new Date().toISOString(),
                active: [],
                completed: 1,
                last_error: null,
              };
              return;
            }
            recoverReplayFailure(command.assignment, message);
          } catch (recoveryError) {
            const recoveryMessage = recoveryError instanceof Error
              ? recoveryError.message
              : String(recoveryError);
            replayRun.snapshot = {
              ...replayRun.snapshot,
              status: 'failed',
              finished_at: new Date().toISOString(),
              active: [],
              failed: 1,
              last_error: `${message}; replay recovery failed: ${recoveryMessage}`,
            };
            return;
          }
          replayRun.snapshot = {
            ...replayRun.snapshot,
            status: 'failed',
            finished_at: new Date().toISOString(),
            active: [],
            failed: 1,
            last_error: message,
          };
        }
      });
      return { ...replayRun.snapshot };
    }
    return this.runner.start(command);
  }

  stop(projectId: number): WorkerRunSnapshot | null {
    const replay = this.replayRuns.get(projectId);
    if (replay) {
      this.replayRuns.delete(projectId);
      return {
        ...replay.snapshot,
        status: 'stopped',
        finished_at: new Date().toISOString(),
        active: [],
      };
    }
    return this.runner.stop(projectId);
  }

  status(projectId: number): WorkerRunSnapshot | null {
    const replay = this.replayRuns.get(projectId);
    if (replay) {
      const snap = { ...replay.snapshot };
      if (replay.completed || snap.status === 'failed' || snap.status === 'stopped') {
        this.replayRuns.delete(projectId);
      }
      return snap;
    }
    return this.runner.status(projectId);
  }

  setConcurrency(projectId: number, concurrency: number): void {
    this.runner.setConcurrency(projectId, concurrency);
  }

  dispose(): void {
    this.replayRuns.clear();
    this.runner.dispose();
  }
}

function finalizeReplaySuccess(assignment: AssignedWork): void {
  const executionId = String(assignment.workerExecutionId);
  const db = getDb();
  const outcome = releaseExecutionAtomically(db, {
    executionId,
    terminalState: 'exited',
    exitCode: 0,
    reason: 'in-process replay completed after durable worker_done',
    preserveTaskStatus: true,
  });
  const task = db.prepare(
    'SELECT current_execution_id FROM tasks WHERE id=?',
  ).get(Number(assignment.taskId)) as { current_execution_id: string | null } | undefined;
  if (task?.current_execution_id === executionId) {
    throw new Error(
      `REPLAY_EXECUTION_FENCE_STRANDED: task ${String(assignment.taskId)} `
      + `still fenced by ${executionId} after successful replay`,
    );
  }
  if (!outcome.terminalized && !outcome.taskReleased) {
    const row = db.prepare(
      'SELECT state FROM worker_executions WHERE execution_id=?',
    ).get(executionId) as { state: string } | undefined;
    if (!row || !['exited', 'terminated'].includes(row.state)) {
      throw new Error(
        `REPLAY_EXECUTION_FINALIZE_FAILED: execution ${executionId} `
        + `was not terminalized (${outcome.blockedReason})`,
      );
    }
  }
}

function recoverReplayFailure(assignment: AssignedWork, reason: string): void {
  const executionId = String(assignment.workerExecutionId);
  const taskId = Number(assignment.taskId);
  const db = getDb();
  const task = db.prepare(
    'SELECT workplace_ref FROM tasks WHERE id=?',
  ).get(taskId) as { workplace_ref: string | null } | undefined;

  if (task?.workplace_ref) {
    const workplaceRef = deserializeWorkplaceRef(task.workplace_ref);
    const workplaceRepo = new SqliteWorkplaceRepository(db);
    const state = workplaceRepo.read(workplaceRef);
    const actors = workplaceRepo.readActiveActors(workplaceRef);
    if (
      state
      && (state.loopState === 'leased' || state.loopState === 'running')
      && actors?.activeReservationRef === executionId
    ) {
      new ConveyorRuntime(db).releaseExecution({
        workplaceRef,
        reservationRef: executionId,
        taskId,
        outcome: 'crashed',
      });
    }
  }

  // Keep the current Workplace-derived Kanban phase. Production Cell recovery
  // owns requeue/repair; physical failure must only clear this execution fence.
  releaseExecutionAtomically(db, {
    executionId,
    terminalState: 'lost',
    reason: `capsule replay failed: ${reason}`,
    lastError: reason,
    preserveTaskStatus: true,
  });
}

function hasAcceptedWorkerDone(executionId: string): boolean {
  try {
    return Boolean(getDb().prepare(
      `SELECT 1 FROM command_receipts
        WHERE execution_id=? AND command_kind='worker_done' AND accepted=1
        LIMIT 1`,
    ).get(executionId));
  } catch {
    return false;
  }
}

function hasFrozenCapsule(assignment: AssignedWork): boolean {
  const ctx = assignment.executionContext as
    | { replay?: { capsule_ref?: string | null } }
    | null
    | undefined;
  return typeof ctx?.replay?.capsule_ref === 'string'
    && ctx.replay.capsule_ref.length > 0;
}

function assertFrozenExecutionRoute(assignment: AssignedWork): void {
  const raw = assignment.executionContext;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('FROZEN_EXECUTION_CONTEXT_REQUIRED: assigned work has no execution context');
  }
  const context = raw as Record<string, unknown>;
  if (context.policy_version !== EXECUTION_CONTEXT_POLICY_VERSION) {
    throw new Error(
      `FROZEN_EXECUTION_CONTEXT_VERSION_REQUIRED: expected ${EXECUTION_CONTEXT_POLICY_VERSION}, got ${String(context.policy_version)}`,
    );
  }
  const kind = context.executor_kind;
  if (kind !== 'claude-cli') {
    throw new Error(
      `FROZEN_EXECUTOR_KIND_REQUIRED: expected 'claude-cli', got ${String(kind)}`,
    );
  }
  const route = context.model_route;
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw new Error('FROZEN_MODEL_ROUTE_REQUIRED');
  }
  const modelRoute = route as Record<string, unknown>;
  if (typeof modelRoute.provider !== 'string' || modelRoute.provider.trim() === '') {
    throw new Error('MODEL_PROVIDER_REQUIRED: claude-cli route requires provider');
  }
  if (!(modelRoute.model === null || typeof modelRoute.model === 'string')) {
    throw new Error('MODEL_ROUTE_INVALID: model must be string|null');
  }
  if (!(modelRoute.effort === null || typeof modelRoute.effort === 'string')) {
    throw new Error('MODEL_ROUTE_INVALID: effort must be string|null');
  }
}
