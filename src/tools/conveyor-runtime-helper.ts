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
import { SqliteWorkplaceRepository } from '../infrastructure/workplace/sqlite-workplace-repository.js';

let cachedRuntime: ConveyorRuntime | null = null;
let cachedDb: Database.Database | null = null;

/** Is the cutover authority active (SAGA_WORKPLACE_READ=new)? */

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
  const rt = runtime(db);
  // Re-derive the ref from metadata (the task is already bound).
  const ref = deriveWorkplaceRefFromTaskMetadata({
    taskId: input.taskId,
    metadata: input.metadata,
    taskKind: input.taskKind,
  });
  if (!ref) return;
  // If no executionId was passed, read the active reservation from the
  // workplace (the fence that the claim set). This handles the engine path
  // where worker_done may not carry the execution_id.
  let execId = input.executionId;
  if (!execId || execId === 'undefined') {
    const repo = new SqliteWorkplaceRepository(db);
    const actors = repo.readActiveActors(ref);
    execId = actors?.activeReservationRef ?? input.executionId ?? '';
  }
  try {
    // Decide workplace transition from the dispatcher's new task status:
    //
    //   review              → workplace 'review/queued' (reviewer must be hired next)
    //   done (final)        → workplace 'done/terminal(accepted)'
    //   done (git_change, not merged) → workplace 'verifying' (awaiting merge)
    //   anything else       → releaseExecution(completed) → verifying
    if (input.taskStatus === 'review') {
      // Author completed → hand to reviewer. Set workplace directly to
      // review/queued so the next claim resolves review_skill.
      const cur = rt['repo'].read(ref);
      if (cur) {
        rt['repo'].applyTransitionInTx({
          workplaceRef: ref,
          expectedRevision: cur.revision,
          kanbanPhase: 'review',
          loopState: 'queued',
          nextRole: 'reviewer',
          terminalReason: null,
          activeReservationRef: null,
        });
      }
    } else {
    const isGitChange = input.executionMode === 'git_change';
    const isMerged = input.integrationState === 'merged' || input.integrationState === 'not_required';
    const canTerminal = !isGitChange || isMerged;
    if (input.taskStatus === 'done' && canTerminal) {
      rt.acceptFinal({
        workplaceRef: ref,
        reservationRef: execId,
        taskId: input.taskId,
      });
    } else {
      rt.releaseExecution({
        workplaceRef: ref,
        reservationRef: execId,
        taskId: input.taskId,
        outcome: input.outcome,
      });
    }
    } // end else (not review)
  } catch (e) {
    console.error(`[v4-release] task=${input.taskId} execId=${execId} status=${input.taskStatus}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
