import type {
  AssignedWork,
  WorkerExecutor,
  WorkerExecutorStart,
  WorkerRunSnapshot,
} from '../../application/ports/worker-executor.js';
import { EXECUTION_CONTEXT_POLICY_VERSION } from '../../shared/authority/execution-context.js';

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
 * In-process replay function type. When non-null on an assignment's frozen
 * execution context, the executor runs this instead of spawning the CLI. This
 * is the normal WorkerExecution production source for replay — NOT a separate
 * executor mode. The same executor abstraction serves inference and replay.
 */
export type InProcessReplayFn = (input: {
  assignment: AssignedWork;
}) => void;

/**
 * Infrastructure adapter over tracker-view/claude-runner.mjs.
 *
 * The factory cutover requires every managed spawn to arrive with a frozen v2
 * execution route. The tracker runner still contains defensive legacy fallbacks
 * for direct characterization tests, but those fallbacks are intentionally not
 * reachable through this production WorkerExecutor boundary.
 *
 * CONVEYOR v4.3 PART 1-2: replay is an internal production source. When the
 * frozen execution_context.replay.capsule_ref is non-null, start() runs the
 * in-process replay adapter (same product_submit/artifact/trace/worker_done
 * surface) instead of spawning the selected inference model. The executor_kind
 * and model_route are NEVER mutated by replay; the decision to replay is
 * resolved internally from the frozen capsule_ref.
 */
export class ClaudeBoardWorkerExecutor implements WorkerExecutor {
  constructor(
    private readonly runner: ClaudeBoardRunner,
    private readonly replayRunner?: InProcessReplayFn,
  ) {}

  start(command: WorkerExecutorStart): WorkerRunSnapshot {
    assertFrozenExecutionRoute(command.assignment);
    // Replay-first: a frozen capsule_ref selects in-process replay production.
    // This is NOT a simulator route; the normal executor_kind remains the real
    // CLI. The replay adapter publishes through the SAME MCP surface and the
    // current GateRun decides acceptance — exactly as if inference ran.
    if (this.replayRunner && hasFrozenCapsule(command.assignment)) {
      this.replayRunner({ assignment: command.assignment });
      // The replay completed synchronously through worker_done. Synthesize a
      // terminal snapshot so the dispatcher's status() poll observes completion
      // exactly as it would for a real CLI run that called worker_done.
      return synthesizeTerminalSnapshot(command);
    }
    return this.runner.start(command);
  }

  stop(projectId: number): WorkerRunSnapshot | null {
    return this.runner.stop(projectId);
  }

  status(projectId: number): WorkerRunSnapshot | null {
    return this.runner.status(projectId);
  }

  setConcurrency(projectId: number, concurrency: number): void {
    this.runner.setConcurrency(projectId, concurrency);
  }

  dispose(): void {
    this.runner.dispose();
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

function synthesizeTerminalSnapshot(command: WorkerExecutorStart): WorkerRunSnapshot {
  return {
    id: `replay-${command.projectId}-${Date.now()}`,
    project_id: command.projectId,
    concurrency: command.concurrency,
    status: 'completed',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    active: [],
    completed: 1,
    failed: 0,
    claimed: 1,
    last_error: null,
  };
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
  // CONVEYOR v4.3 PART 1: only the real CLI executor_kind is supported on the
  // normal runtime path. 'claude-cli-simulator' is no longer a runtime route;
  // replay is resolved internally from execution_context.replay.capsule_ref.
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
