import type Database from 'better-sqlite3';
import { ConveyorRuntime } from '../../application/conveyor-runtime.js';
import { releaseExecutionAtomically } from '../../lifecycle/atomic-release.js';
import { deserializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { SqliteWorkplaceRepository } from '../workplace/sqlite-workplace-repository.js';
import { isRetryableFactoryProvisioningFailure } from './pre-spawn-failure-policy.js';
import { readFinalPresentationCommitmentForExecution } from '../workplace/sqlite-final-presentation-commitment.js';
import { closeCommittedTypedPresentation } from '../../application/final-presentation-closure.js';

export interface ManagedWorkerProcessTerminationInput {
  readonly taskId: number;
  readonly executionId: string;
  readonly exitCode?: number | null;
  readonly reason: string;
  readonly spawnFailure?: boolean;
}

export interface ManagedWorkerProcessTerminationOutcome {
  readonly semanticCompletion: boolean;
  readonly executionState: 'exited' | 'lost' | 'spawn_failed';
  readonly workplaceRepairRequested: boolean;
  readonly taskReleased: boolean;
  readonly blockedReason: string | null;
}

export function hasAcceptedWorkerDone(
  db: Database.Database,
  executionId: string,
): boolean {
  try {
    return Boolean(db.prepare(
      `SELECT 1
         FROM command_receipts
        WHERE execution_id=?
          AND command_kind IN ('worker_done','presentation_close')
          AND accepted=1
        LIMIT 1`,
    ).get(executionId));
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return false;
    throw error;
  }
}

function requestWorkplaceCrashRepair(
  db: Database.Database,
  taskId: number,
  executionId: string,
): boolean {
  const task = db.prepare(
    'SELECT workplace_ref FROM tasks WHERE id=?',
  ).get(taskId) as { workplace_ref: string | null } | undefined;
  if (!task?.workplace_ref) return false;

  const workplaceRef = deserializeWorkplaceRef(task.workplace_ref);
  const workplaceRepo = new SqliteWorkplaceRepository(db);
  const state = workplaceRepo.read(workplaceRef);
  const actors = workplaceRepo.readActiveActors(workplaceRef);
  if (
    !state
    || (state.loopState !== 'leased' && state.loopState !== 'running')
    || actors?.activeReservationRef !== executionId
  ) {
    return false;
  }

  new ConveyorRuntime(db).releaseExecution({
    workplaceRef,
    reservationRef: executionId,
    taskId,
    outcome: 'crashed',
  });
  return true;
}

function pauseSpawnFailure(
  db: Database.Database,
  taskId: number,
): void {
  const task = db.prepare(
    'SELECT workplace_ref FROM tasks WHERE id=?',
  ).get(taskId) as { workplace_ref: string | null } | undefined;
  if (!task?.workplace_ref) return;
  new ConveyorRuntime(db).pauseForHuman({
    workplaceRef: deserializeWorkplaceRef(task.workplace_ref),
    taskId,
  });
}

/**
 * One authoritative interpretation of physical worker-process termination.
 *
 * Semantic completion is determined by the durable accepted worker_done
 * receipt, never by OS exit code alone.
 *
 * - worker_done accepted -> execution exits cleanly; Workplace/Gate state wins.
 * - process existed but ended without worker_done -> execution becomes lost and
 *   the owning Workplace enters normal crash repair (subject to cell budget).
 * - process could not spawn -> spawn_failed + human pause; retrying the same
 *   unavailable executable is an infrastructure problem, not semantic repair.
 */
export function finalizeManagedWorkerProcess(
  db: Database.Database,
  input: ManagedWorkerProcessTerminationInput,
): ManagedWorkerProcessTerminationOutcome {
  // ADR-072: physical termination may redrive an already durable final
  // presentation commitment. It never manufactures commitment from a live or
  // mutable desk. If the close fails deterministic validation, ordinary crash
  // repair remains the fail-closed path below.
  if (!hasAcceptedWorkerDone(db, input.executionId)) {
    const commitment = readFinalPresentationCommitmentForExecution(db, input.executionId);
    if (commitment) {
      try {
        closeCommittedTypedPresentation(db, commitment.commitmentRef);
      } catch {
        // Preserve the original termination classification. The durable
        // obligation remains retryable and carries the exact failure evidence.
      }
    }
  }
  if (hasAcceptedWorkerDone(db, input.executionId)) {
    const release = releaseExecutionAtomically(db, {
      executionId: input.executionId,
      terminalState: 'exited',
      exitCode: input.exitCode ?? 0,
      reason: input.reason,
      preserveTaskStatus: true,
    });
    const task = db.prepare(
      'SELECT current_execution_id FROM tasks WHERE id=?',
    ).get(input.taskId) as { current_execution_id: string | null } | undefined;
    if (task?.current_execution_id === input.executionId) {
      throw new Error(
        `WORKER_EXECUTION_FENCE_STRANDED: task ${input.taskId} still fenced by ${input.executionId}`,
      );
    }
    return {
      semanticCompletion: true,
      executionState: 'exited',
      workplaceRepairRequested: false,
      taskReleased: release.taskReleased,
      blockedReason: release.blockedReason,
    };
  }

  if (input.spawnFailure) {
    const retryableProvisioningFailure = isRetryableFactoryProvisioningFailure(input.reason);
    const workplaceRepairRequested = retryableProvisioningFailure
      ? requestWorkplaceCrashRepair(db, input.taskId, input.executionId)
      : false;
    const release = releaseExecutionAtomically(db, {
      executionId: input.executionId,
      terminalState: 'spawn_failed',
      exitCode: input.exitCode ?? null,
      reason: input.reason,
      lastError: input.reason,
      preserveTaskStatus: retryableProvisioningFailure,
    });
    if (release.taskReleased && !retryableProvisioningFailure) {
      pauseSpawnFailure(db, input.taskId);
    }
    return {
      semanticCompletion: false,
      executionState: 'spawn_failed',
      workplaceRepairRequested,
      taskReleased: release.taskReleased,
      blockedReason: release.blockedReason,
    };
  }

  const workplaceRepairRequested = requestWorkplaceCrashRepair(
    db,
    input.taskId,
    input.executionId,
  );
  const release = releaseExecutionAtomically(db, {
    executionId: input.executionId,
    terminalState: 'lost',
    exitCode: input.exitCode ?? null,
    reason: input.reason,
    lastError: input.reason,
    preserveTaskStatus: true,
  });
  return {
    semanticCompletion: false,
    executionState: 'lost',
    workplaceRepairRequested,
    taskReleased: release.taskReleased,
    blockedReason: release.blockedReason,
  };
}
