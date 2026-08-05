/**
 * WorkerLauncherPort — the pure process-launch surface (Conveyor v4 step 2.4).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-21 (Мастер, вахтёр
 * и табель — supervision) + Conveyor Mental Model v4 §«Required outbound
 * ports»: "Launch / stop a model worker — WorkerLauncherPort".
 *
 * # Why a separate launch port
 *
 * Today two surfaces are conflated in `WorkerExecutor`:
 *   - PROCESS LAUNCH (spawn the claude CLI, get a PID, attach close callbacks)
 *   - RUN MANAGEMENT (status polling, concurrency control, disposal)
 *
 * v4 separates them. `WorkerLauncherPort` owns ONLY the launch/stop of one
 * worker process from a committed `ExecutionReservation`. It does NOT own
 * concurrency budget (that is the dispatcher's job — REG-10-AC-05) and does
 * NOT own status polling (that is `WorkerSupervisionPort`). This separation
 * lets the `ProductionCellCoordinator` (step 2.2 reducer's infrastructure
 * twin) consume one launch surface without pulling in board-management code.
 *
 * # Relationship to the existing WorkerExecutor
 *
 * `WorkerExecutor` (application/ports/worker-executor.ts) remains the
 * backwards-compatible surface for the current dispatch-loop path. The new
 * `WorkerLauncherPort` is a NARROWER contract that `ClaudeBoardWorkerExecutor`
 * will delegate to. During the migration both coexist; step 5 retires
 * `WorkerExecutor` in favour of `WorkerLauncherPort` + `WorkerSupervisionPort`.
 *
 * # Pure port
 *
 * Imports only pure-domain/SPI types. The concrete launcher lives in
 * infrastructure (wrapping tracker-view/claude-runner.mjs or a future
 * driver-neutral runner).
 */

/**
 * The committed reservation the launcher consumes. Sourced from
 * Conveyor Runtime's atomic `queued → leased` transition (REG-09-AC-02:
 * "the process does not launch until the reservation is durably committed").
 */
export interface LaunchRequest {
  /** The ExecutionReservation ref (REG-09). */
  readonly reservationRef: string;
  /** The workplace this worker will staff. */
  readonly workplaceRef: unknown;
  /** The role: author or reviewer. */
  readonly role: 'author' | 'reviewer';
  /** The fence token this execution will hold (becomes current_execution_id). */
  readonly fenceToken: string;
  /** The skill/profile the worker should load. */
  readonly skillRef: string;
  /** Capability preset the platform resolves to allowed tools. */
  readonly capabilityPreset: string;
  /** The workspace path (desk) the worker runs in. */
  readonly workspacePath: string;
  /** Stable run identity for log grouping. */
  readonly runId: string;
  /** Worker identity for the timesheet (REG-21). */
  readonly workerId: string;
  /** Machine identity (host). */
  readonly machineId: string;
}

/**
 * The result of a successful launch. The launcher returns the process
 * identity so the supervisor (REG-21 watchman) can reconcile it later.
 */
export interface LaunchResult {
  /** The launched process PID (null when the launcher is in-process/mock). */
  readonly pid: number | null;
  /** A birth token for PID-reuse protection (REG-21-AC-02). */
  readonly processBirthToken: string | null;
  /** Path to the execution's log file (observability — REG-21). */
  readonly logPath: string | null;
  /** ISO timestamp the process started. */
  readonly startedAt: string;
}

/**
 * The pure launch/stop surface for one worker process.
 *
 * REG-21. The launcher:
 *   - spawns the worker process from a committed reservation;
 *   - records start, PID and birth token for the supervisor;
 *   - handles normal close/error events (the "foreman" role);
 *   - does NOT decide concurrency, does NOT poll status, does NOT choose
 *     which workplace to staff (that is the dispatcher's job).
 *
 * The launcher is idempotent on `reservationRef` (REG-09-AC-03): a launch
 * retry for the same reservation returns the existing process identity
 * rather than spawning a second live execution.
 */
export interface WorkerLauncherPort {
  /**
   * Launch one worker process from a committed reservation.
   *
   * REG-09-AC-02: the caller (dispatcher/coordinator) MUST have committed the
   * reservation BEFORE calling this. The launcher trusts the caller's
   * reservationRef and does not re-check the queue.
   *
   * Returns the process identity. Throws on spawn failure (the caller
   * releases the reservation via `releaseAssignment` — see dispatch-loop.ts).
   */
  launch(request: LaunchRequest): LaunchResult;

  /**
   * Stop a worker process. Used by the foreman on normal close and by the
   * reaper on verified termination (REG-21-AC-03). Idempotent: a second call
   * for an already-stopped process is a no-op.
   */
  stop(fenceToken: string): void;

  /**
   * Dispose of all launcher resources (child processes, file handles).
   * Called once on shutdown.
   */
  dispose(): void;
}
