/**
 * ConveyorRuntime helper — bridge from dispatcher use cases to the
 * ConveyorRuntime (Conveyor v4 step 5.2 cutover authority).
 *
 * A thin singleton wrapper so the dispatcher can call the runtime use cases
 * without constructing it on every transition. The Factory workplace is the
 * sole authority and tasks.status is its reverse projection.
 *
 */

import type Database from 'better-sqlite3';
import { ConveyorRuntime } from '../application/conveyor-runtime.js';
import {
  reduceWorkplaceEvent,
  type ProductionCellEvent,
  type WorkplaceRef,
} from '../process-modules/domain/workplace/index.js';
import { deriveWorkplaceRefFromTaskMetadata } from '../infrastructure/projections/workplace-projector.js';
import { SqliteWorkplaceRepository } from '../infrastructure/workplace/sqlite-workplace-repository.js';

let cachedRuntime: ConveyorRuntime | null = null;
let cachedDb: Database.Database | null = null;

function runtime(db: Database.Database): ConveyorRuntime {
  if (cachedDb !== db) {
    cachedRuntime = new ConveyorRuntime(db);
    cachedDb = db;
  }
  return cachedRuntime!;
}

/** Map the status selected by reviewer worker_done to the domain event. */
export function reviewerCompletionEvent(taskStatus: string): ProductionCellEvent {
  if (taskStatus === 'done') {
    return { kind: 'reviewer-verdict', verdict: 'accepted' };
  }
  if (taskStatus === 'todo') {
    return { kind: 'reviewer-verdict', verdict: 'defect-proven' };
  }
  if (taskStatus === 'blocked') {
    return { kind: 'human-required' };
  }
  return { kind: 'reviewer-verdict', verdict: 'invalid-output' };
}

/**
 * Bind a task to its workplace and reserve it for the given execution.
 *
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
 *   author completed → candidate-sealed (running → verifying), or review/queued
 *     when a reviewer is declared;
 *   reviewer approved/changes_requested → reviewer-verdict from verifying;
 *   crashed/expired → worker-crashed (running → repair_wait).
 */
export function releaseTaskExecution(db: Database.Database, input: {
  taskId: number;
  epicId: number;
  projectId: number;
  taskKind: string | null;
  metadata: string;
  executionId: string;
  outcome: 'completed' | 'crashed' | 'expired' | 'cancelled';
  /** The tasks.status selected by worker_done before this workplace transition. */
  taskStatus: string;
  /** The task's execution_mode — only git_change tasks require merge before
   *  terminal(accepted). tracker_only/not_required can go terminal on done. */
  executionMode?: string;
  /** The task's integration_state — 'merged' means it's safe to terminal. */
  integrationState?: string;
}): void {
  const rt = runtime(db);
  const ref = deriveWorkplaceRefFromTaskMetadata({
    taskId: input.taskId,
    metadata: input.metadata,
    taskKind: input.taskKind,
  });
  if (!ref) return;

  let execId = input.executionId;
  if (!execId || execId === 'undefined') {
    const repo = new SqliteWorkplaceRepository(db);
    const actors = repo.readActiveActors(ref);
    execId = actors?.activeReservationRef ?? input.executionId ?? '';
  }

  try {
    const repo = new SqliteWorkplaceRepository(db);
    const current = repo.read(ref);

    // Reviewer completion is a different domain transition from author
    // completion. The reviewer already works in verifying; sending it through
    // releaseExecution(completed) would emit candidate-sealed and incorrectly
    // require loopState=running.
    if (
      current?.kanbanPhase === 'review_in_progress'
      && current.loopState === 'verifying'
    ) {
      const actors = repo.readActiveActors(ref);
      if (actors?.activeReservationRef !== execId) {
        throw new Error(
          `FENCE_MISMATCH: workplace's active reservation `
            + `'${actors?.activeReservationRef ?? 'null'}' does not match `
            + `'${execId}' (REG-09-AC-04)`,
        );
      }

      const target = reduceWorkplaceEvent(
        current,
        reviewerCompletionEvent(input.taskStatus),
      );
      const applied = repo.applyTransitionInTx({
        workplaceRef: ref,
        expectedRevision: current.revision,
        kanbanPhase: target.kanbanPhase,
        loopState: target.loopState,
        nextRole: target.nextRole,
        terminalReason: target.terminalReason,
        activeReservationRef: null,
      });
      if (!applied.applied) {
        throw new Error(
          `WORKPLACE_CAS_MISS: reviewer completion lost revision ${current.revision}`,
        );
      }
      return;
    }

    if (input.taskStatus === 'review') {
      // Author completed → hand to reviewer. Set workplace directly to
      // review/queued so the next claim resolves review_skill.
      if (current) {
        repo.applyTransitionInTx({
          workplaceRef: ref,
          expectedRevision: current.revision,
          kanbanPhase: 'review',
          loopState: 'queued',
          nextRole: 'reviewer',
          terminalReason: null,
          activeReservationRef: null,
        });
      }
    } else {
      rt.releaseExecution({
        workplaceRef: ref,
        reservationRef: execId,
        taskId: input.taskId,
        outcome: input.outcome,
      });
    }
  } catch (e) {
    throw new Error(
      `FACTORY_RELEASE_FAILED: task=${input.taskId} execution=${execId}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}
