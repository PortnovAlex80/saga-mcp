/**
 * ProcessRunRepository — the persistence port for ProcessRun records.
 *
 * This port isolates the application/runtime layer from the concrete SQLite
 * implementation, mirroring the factory-discovery persistence boundary
 * (FactoryDiscoveryRuntimePersistence). Tests inject a fake; production wires
 * the SQLite implementation from saga3/persistence/.
 *
 * The contract is intentionally narrow: idempotent start, atomic transition,
 * terminal write-once, and three read shapes (by id, by input key, by
 * project/epic). No module-specific knowledge lives here.
 */

import type {
  ProcessRunRecord,
  ProcessRunStatus,
  StartProcessModuleCommand,
  UpdateProcessRunInput,
} from './process-run.js';

export interface ProcessRunRepository {
  /**
   * Idempotent start. The idempotency_key is unique within (project, module).
   * Same key + same input_hash → returns the existing row with replayed=true.
   * Same key + different input_hash → throws
   * IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT. Different key → inserts a new
   * row in status 'created' and returns it with replayed=false.
   *
   * The caller is responsible for transitioning `created → preparing →
   * running`; this method only reserves the row.
   */
  start(command: StartProcessModuleCommand): { record: ProcessRunRecord; replayed: boolean };

  /** Read one run by id. Returns null if no such row. */
  read(id: number): ProcessRunRecord | null;

  /**
   * Read the run by its idempotency key, scoped to (project, module).
   * The idempotency_key is unique within (project_id, module_name,
   * module_version); input_hash is NOT part of the lookup key (it is the
   * value the run was started with). Returns null if absent.
   */
  readByIdempotencyKey(
    projectId: number,
    moduleRefKey: string,
    idempotencyKey: string,
  ): ProcessRunRecord | null;

  /**
   * List runs for one (project, epic). Epic may be null (project-wide).
   * Ordered by id DESC so the most recent run is first.
   */
  list(projectId: number, epicId: number | null): readonly ProcessRunRecord[];

  /**
   * Atomic transition + write-once terminal update. Throws if the row is
   * missing, if the transition is not allowed by the current status, or if a
   * terminal field (outcome/output/certificate) is being mutated on an
   * already-terminal row.
   */
  update(id: number, input: UpdateProcessRunInput): ProcessRunRecord;

  /**
   * Acquire a renewable single-driver lease for a ProcessRun. Returns false
   * when another unexpired owner is already executing the run.
   */
  acquireExecutionLease(
    id: number,
    owner: string,
    nowIso: string,
    expiresAtIso: string,
  ): boolean;

  /** Renew a lease only while the same owner still holds it. */
  renewExecutionLease(id: number, owner: string, expiresAtIso: string): boolean;

  /** Best-effort release; a stale owner can never release a newer lease. */
  releaseExecutionLease(id: number, owner: string): void;
}

/** Allowed status transitions (from → set of allowed next statuses). */
export const ALLOWED_TRANSITIONS: Readonly<Record<ProcessRunStatus, readonly ProcessRunStatus[]>> = {
  created: ['preparing', 'running', 'paused', 'failed', 'cancelled'],
  preparing: ['running', 'paused', 'failed', 'cancelled'],
  running: ['paused', 'settling', 'completed', 'failed', 'cancelled'],
  paused: ['preparing', 'running', 'failed', 'cancelled'],
  settling: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isTerminalStatus(status: ProcessRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/**
 * Validate that a status transition is allowed. Throws with a clear message if
 * not. Terminal statuses have no outgoing transitions — they are write-once.
 */
export function assertTransitionAllowed(from: ProcessRunStatus, to: ProcessRunStatus): void {
  if (from === to) return;
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new Error(
      `ProcessRun: transition '${from}' -> '${to}' is not allowed (allowed: [${allowed.join(', ')}])`,
    );
  }
}
