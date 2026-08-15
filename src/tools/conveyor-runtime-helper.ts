/**
 * Bridge from worker protocol commands to the authoritative ConveyorRuntime.
 * Worker protocol completion owns physical execution facts only. Semantic
 * author/reviewer outcomes are owned exclusively by the Production Cell Gate.
 */
import type Database from 'better-sqlite3';
import { ConveyorRuntime } from '../application/conveyor-runtime.js';
import type { WorkplaceRef } from '../process-modules/domain/workplace/index.js';
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

export function releaseTaskExecution(db: Database.Database, input: {
  taskId: number;
  epicId: number;
  projectId: number;
  taskKind: string | null;
  metadata: string;
  executionId: string;
  outcome: 'completed' | 'crashed' | 'expired' | 'cancelled';
  taskStatus: string;
  executionMode?: string;
  integrationState?: string;
}): void {
  const rt = runtime(db);
  const ref = deriveWorkplaceRefFromTaskMetadata({
    taskId: input.taskId,
    metadata: input.metadata,
    taskKind: input.taskKind,
  });
  if (!ref) return;

  let executionRef = input.executionId;
  if (!executionRef || executionRef === 'undefined') {
    const actors = new SqliteWorkplaceRepository(db).readActiveActors(ref);
    executionRef = actors?.activeReservationRef ?? input.executionId ?? '';
  }

  try {
    rt.releaseExecution({
      workplaceRef: ref,
      reservationRef: executionRef,
      taskId: input.taskId,
      outcome: input.outcome,
    });
  } catch (error) {
    throw new Error(
      `FACTORY_RELEASE_FAILED: task=${input.taskId} execution=${executionRef}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
