import type {
  AssignedWork,
  WorkerExecutor,
  WorkerExecutorStart,
  WorkerRunSnapshot,
} from '../../application/ports/worker-executor.js';
import { EXECUTION_CONTEXT_POLICY_VERSION } from '../../shared/authority/execution-context.js';
import { getDb } from '../../db.js';
import {
  finalizeManagedWorkerProcess,
  hasAcceptedWorkerDone,
} from './worker-process-termination.js';

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
            // A durable worker_done is semantic completion. A later physical
            // close/replay error must never turn accepted work into repair.
            if (hasAcceptedWorkerDone(
              getDb(),
              String(command.assignment.workerExecutionId),
            )) {
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
  const outcome = finalizeManagedWorkerProcess(getDb(), {
    taskId: Number(assignment.taskId),
    executionId: String(assignment.workerExecutionId),
    exitCode: 0,
    reason: 'in-process replay completed after durable worker_done',
  });
  if (!outcome.semanticCompletion) {
    throw new Error(
      `REPLAY_EXECUTION_FINALIZE_FAILED: execution ${String(assignment.workerExecutionId)} `
      + 'has no accepted worker_done receipt',
    );
  }
}

function recoverReplayFailure(assignment: AssignedWork, reason: string): void {
  finalizeManagedWorkerProcess(getDb(), {
    taskId: Number(assignment.taskId),
    executionId: String(assignment.workerExecutionId),
    reason: `capsule replay failed: ${reason}`,
  });
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
  // C-1: endpoint coordinates are optional (pre-C-1 snapshots predate them),
  // but a PRESENT endpoint must be well-formed — spawn derives the child's
  // backend env from it, so a malformed marker must fail closed here.
  const endpoint = modelRoute.endpoint;
  if (endpoint !== undefined && endpoint !== null) {
    const backend = (endpoint as { backend?: unknown }).backend;
    const baseUrl = (endpoint as { base_url?: unknown }).base_url;
    const backendValid = backend === 'agent-proxy'
      || backend === 'lmstudio'
      || backend === 'claude-cli';
    const baseUrlValid = baseUrl === null || baseUrl === undefined
      || (typeof baseUrl === 'string' && baseUrl.length > 0);
    if (typeof endpoint !== 'object' || !backendValid || !baseUrlValid) {
      throw new Error('MODEL_ROUTE_INVALID: endpoint must be {backend, base_url}');
    }
  }
}