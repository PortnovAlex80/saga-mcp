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
 * Infrastructure adapter over tracker-view/claude-runner.mjs.
 *
 * The factory cutover requires every managed spawn to arrive with a frozen v2
 * execution route. The tracker runner still contains defensive legacy fallbacks
 * for direct characterization tests, but those fallbacks are intentionally not
 * reachable through this production WorkerExecutor boundary.
 */
export class ClaudeBoardWorkerExecutor implements WorkerExecutor {
  constructor(private readonly runner: ClaudeBoardRunner) {}

  start(command: WorkerExecutorStart): WorkerRunSnapshot {
    assertFrozenExecutionRoute(command.assignment);
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
  if (kind !== 'claude-cli' && kind !== 'claude-cli-simulator') {
    throw new Error(`FROZEN_EXECUTOR_KIND_REQUIRED: got ${String(kind)}`);
  }
  const route = context.model_route;
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    throw new Error('FROZEN_MODEL_ROUTE_REQUIRED');
  }
  const modelRoute = route as Record<string, unknown>;
  if (kind === 'claude-cli-simulator') {
    if (modelRoute.provider !== null || modelRoute.model !== null || modelRoute.effort !== null) {
      throw new Error(
        'SIMULATOR_ROUTE_INVALID: provider, model and effort must all be null',
      );
    }
    return;
  }
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
