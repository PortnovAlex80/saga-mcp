/**
 * ConveyorRuntime helper — bridge from dispatcher use cases to the
 * ConveyorRuntime (Conveyor v4 step 5.2 cutover authority).
 *
 * A thin singleton wrapper so the dispatcher can call the runtime use cases
 * without constructing it on every transition. When `SAGA_WORKPLACE_READ` is
 * not 'new' (the cutover mode), the cutover path is not active and the
 * dispatcher continues to use the legacy claim/release + forward shadow-write
 * (`SAGA_WORKPLACE_WRITE=on`).
 *
 * # When this is active
 *
 *   SAGA_WORKPLACE_READ=new  → the runtime IS the authority. The dispatcher
 *                              routes claim/release through these helpers.
 *                              tasks.status is a reverse projection.
 *
 *   SAGA_WORKPLACE_READ=both|legacy (or unset) → legacy path. The forward
 *                              shadow-write (`SAGA_WORKPLACE_WRITE=on`) may
 *                              still run; the runtime helpers are not called.
 */

import type Database from 'better-sqlite3';
import { ConveyorRuntime } from '../application/conveyor-runtime.js';
import type { WorkplaceRef } from '../process-modules/domain/workplace/index.js';
import { deriveWorkplaceRefFromTaskMetadata } from '../infrastructure/projections/workplace-projector.js';

let cachedRuntime: ConveyorRuntime | null = null;
let cachedDb: Database.Database | null = null;

/** Is the cutover authority active (SAGA_WORKPLACE_READ=new)? */
export function cutoverActive(): boolean {
  return true;
}

function runtime(db: Database.Database): ConveyorRuntime {
  if (cachedDb !== db) {
    cachedRuntime = new ConveyorRuntime(db);
    cachedDb = db;
  }
  return cachedRuntime!;
}

/**
 * Bind a task to its workplace and reserve it for the given execution.
 *
 * Called by the dispatcher's `worker_next` after a legacy claim succeeds.
 * Returns the workplace ref (for context) or null when the task is not a
 * Process Module task (no process_run_id in metadata).
 */
export function reserveTaskExecution(db: Database.Database, input: {
  taskId: number;
  epicId: number;
  projectId: number;
  taskKind: string | null;
  metadata: string;
  executionId: string;
  preClaimStatus?: string;
}): WorkplaceRef | null {
  if (!cutoverActive()) return null;
  const rt = runtime(db);
  const ref = rt.bindTaskToWorkplace({
    taskId: input.taskId,
    epicId: input.epicId,
    projectId: input.projectId,
    taskKind: input.taskKind,
    metadata: input.metadata,
    preClaimStatus: input.preClaimStatus,
  });
  if (!ref) return null;
  rt.reserveWorkplace({
    workplaceRef: ref,
    reservationRef: input.executionId,
    taskId: input.taskId,
  });
  return ref;
}

/**
 * Release the execution. Called by the dispatcher's `worker_done` /
 * `worker_ask_need` / crash-recovery. The outcome maps to the loop transition:
 *
 *   done (final accepted) → releaseExecution(completed) → loop advances toward
 *     terminal. NOTE: without a separate gate run, the dispatcher treats
 *     worker_done on a final-author cell as the de-facto gate accept, so we
 *     apply gate-author-accepted-final (loop → terminal(accepted)) directly.
 *   review/parked → releaseExecution(completed) (loop → verifying, gate later).
 *   crashed/expired → releaseExecution(crashed) (loop → repair_wait).
 */
export function releaseTaskExecution(db: Database.Database, input: {
  taskId: number;
  epicId: number;
  projectId: number;
  taskKind: string | null;
  metadata: string;
  executionId: string;
  outcome: 'completed' | 'crashed' | 'expired' | 'cancelled';
  /** The current tasks.status (read before release) — used to bind the ref. */
  taskStatus: string;
  /** The task's execution_mode — only git_change tasks require merge before
   *  terminal(accepted). tracker_only/not_required can go terminal on done. */
  executionMode?: string;
  /** The task's integration_state — 'merged' means it's safe to terminal. */
  integrationState?: string;
}): void {
  if (!cutoverActive()) return;
  const rt = runtime(db);
  // Re-derive the ref from metadata (the task is already bound).
  const ref = deriveWorkplaceRefFromTaskMetadata({
    taskId: input.taskId,
    metadata: input.metadata,
    taskKind: input.taskKind,
  });
  if (!ref) return;
  try {
    // When the dispatcher moves a task to 'done', decide terminal vs verifying:
    //   - tracker_only / artifact_change / read_only → terminal(accepted) on done
    //     (no merge step — the gate IS the worker_done approval)
    //   - git_change → terminal(accepted) ONLY if integration_state='merged';
    //     otherwise stay in verifying (merge hasn't happened yet, downstream
    //     must NOT fire until merge_release)
    const isGitChange = input.executionMode === 'git_change';
    const isMerged = input.integrationState === 'merged' || input.integrationState === 'not_required';
    const canTerminal = !isGitChange || isMerged;
    if (input.taskStatus === 'done' && canTerminal) {
      rt.acceptFinal({
        workplaceRef: ref,
        reservationRef: input.executionId,
        taskId: input.taskId,
      });
    } else {
      rt.releaseExecution({
        workplaceRef: ref,
        reservationRef: input.executionId,
        taskId: input.taskId,
        outcome: input.outcome,
      });
    }
  } catch {
    // FENCE_MISMATCH or WORKPLACE_NOT_FOUND — the task may have been recovered
    // or the workplace not yet bound. In cutover mode this is a consistency
    // gap; fall through (the legacy tasks.status write still happened).
  }
}
