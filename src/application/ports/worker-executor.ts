/**
 * Immutable snapshot of a card assigned to one worker execution. Built by the
 * infrastructure (WorkAssignmentPort.assignTask) BEFORE the worker process is
 * spawned. The worker receives this read-only — it never searches the queue.
 *
 * CONVEYOR-MENTAL-MODEL: this is the "card" handed to the worker at the
 * workplace. The dispatcher selected it, flipped its status, set the fence
 * (current_execution_id), and froze the execution context — all in one atomic
 * transaction before hiring the worker.
 */
export interface AssignedWork {
  taskId: number;
  epicId: number;
  projectId: number;
  /** Post-assignment status: the claim already flipped todo→in_progress or
   *  review→review_in_progress before this object was built. */
  status: 'in_progress' | 'review_in_progress';
  /** Execution or review skill resolved for this card. */
  skill: string;
  /** Worker execution id — equals the fence token stamped on
   *  tasks.current_execution_id and the worker_executions row. */
  workerExecutionId: string;
  /** Fence token (same value as workerExecutionId). The worker must present it
   *  on every mutating call (worker_done / worker_merge_*). */
  fenceToken: string;
  runId: string;
  workerId: string;
  machineId: string;
  repository: {
    id: number;
    repository_id: number;
    name: string;
    local_path: string | null;
    role: string;
    integration_branch: string;
    default_branch: string;
  } | null;
  /** Frozen execution-context snapshot (model route + authority) captured at
   *  claim. Spawn + provenance read this single value — no re-read. */
  executionContext: unknown;
}

/**
 * Input to WorkAssignmentPort.assignTask. The caller (dispatcher) generates the
 * fence token (workerExecutionId) and worker identity BEFORE calling assignTask,
 * so the assignment and the fence creation happen in the same transaction.
 */
export interface AssignTaskInput {
  projectId: number;
  epicId?: number;
  workerId: string;
  /** Caller-generated fence token. Becomes tasks.current_execution_id and
   *  worker_executions.execution_id. */
  workerExecutionId: string;
  runId: string;
  machineId: string;
  /** Scope restrict to one specific card (the dispatcher preselected it).
   *  When unset, any claimable card in the project/epic may be assigned. */
  taskIds?: number[];
  /** Tag filter (requirements project: role:product / role:analyst / …). */
  role?: string;
}

/**
 * Infrastructure port for atomic work assignment. Assigns a card to a worker
 * execution BEFORE the worker process is spawned — claim + status flip + fence
 * creation in one transaction. This is the conveyor-physics seam: the factory
 * operator (infrastructure) hands the worker a card, the worker never claims.
 *
 * The SQLite adapter extracts the proven-correct claim SQL from
 * findNextClaimable (src/tools/dispatcher.ts) so worker_next and the dispatcher
 * share ONE assignment code path.
 */
export interface WorkAssignmentPort {
  /**
   * Atomically: (1) select one claimable card matching the scope, (2) verify
   * dependencies + process_run_id authority + conflict-key serialization +
   * fence-free, (3) flip status (todo→in_progress | review→review_in_progress),
   * (4) set assigned_to + current_execution_id, (5) INSERT worker_executions
   * with frozen execution_context. All in ONE IMMEDIATE transaction.
   * Returns null when no card is claimable under the scope.
   */
  assignTask(input: AssignTaskInput): AssignedWork | null;

  /**
   * Count claimable cards for a project. This is a BATCH-PLANNING signal, not
   * an authority: it tells the dispatch loop whether hiring more workers is
   * worthwhile. The authoritative claim (with all gates) happens in assignTask.
   * A non-zero count does NOT guarantee a card is assignable (dependencies or
   * a fence may block it at claim time); a zero count reliably means the queue
   * is empty for this project.
   */
  countClaimable(projectId: number): number;

  /**
   * Release a card back to the queue if the worker never started (spawn
   * failure). Flips status back to todo/review, clears assigned_to and the
   * fence, marks the worker_executions row terminal. Idempotent — a no-op if
   * the card is already released or owned by a different execution.
   */
  releaseAssignment(input: {
    taskId: number;
    workerExecutionId: string;
    reason: string;
  }): void;
}

export interface WorkerExecutorStart {
  projectId: number;
  epicId?: number | null;
  concurrency: number;
  /**
   * Pre-assigned card (conveyor model). The runner SKIPS the in-process claim
   * and launches the worker directly on this card — the assignment + fence
   * already happened atomically before start() was called. This is the only
   * assignment path: infrastructure assigns, worker receives.
   *
   * REQUIRED as of Slice 1 Zones 1-4 of the conveyor refactor (the
   * node-breaker): every caller must pre-assign via the WorkAssignmentPort
   * before launching a worker. The legacy `claimScope` self-claim path is
   * removed.
   */
  assignment: AssignedWork;
}

export interface WorkerModelRoute {
  model: string | null;
  provider: string;
  effort: string | null;
}

export type WorkerModelRouteReader = (
  epicId: number | null,
) => WorkerModelRoute;

export interface ActiveWorkerProjection {
  task_id: number;
  title?: string;
  worker_id: string;
  pid: number | null;
  started_at?: string;
  log_path?: string;
}

export interface WorkerRunSnapshot {
  id: string;
  project_id: number;
  project_name?: string;
  concurrency: number;
  status: string;
  started_at?: string;
  finished_at?: string | null;
  active: ActiveWorkerProjection[];
  completed: number;
  failed: number;
  claimed: number;
  last_error?: string | null;
}

export interface WorkerExecutorFactoryContext {
  projectId: number;
  epicId: number;
  workspaceRoot: string;
  dbPath: string;
  sagaEntry: string;
  sagaSkillRoot: string;
  claudePath?: string;
  logRoot?: string;
  heartbeatLog?: string;
  lmStudioUrl: string;
}

/**
 * Infrastructure port for Claude CLI, LM Studio-routed CLI, or any future
 * worker process runtime. The orchestration engine does not depend on spawn,
 * JSONL paths, MCP config construction, or provider-specific environment.
 */
export interface WorkerExecutor {
  start(command: WorkerExecutorStart): WorkerRunSnapshot;
  stop(projectId: number): WorkerRunSnapshot | null;
  status(projectId: number): WorkerRunSnapshot | null;
  setConcurrency(projectId: number, concurrency: number): void;
  dispose(): void;
}

export type WorkerExecutorFactory = (
  context: WorkerExecutorFactoryContext,
) => WorkerExecutor;
