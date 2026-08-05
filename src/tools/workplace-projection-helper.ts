/**
 * Workplace projection helper — bridge from dispatcher transitions to
 * WorkplaceProjector (Conveyor v4 step 5.2).
 *
 * A thin singleton wrapper so the dispatcher can call one function without
 * importing the projector class directly. When `SAGA_WORKPLACE_WRITE` is not
 * 'on', the helper no-ops (zero overhead).
 */

import type Database from 'better-sqlite3';
import { WorkplaceProjector } from '../infrastructure/projections/workplace-projector.js';

let cachedProjector: WorkplaceProjector | null = null;
let cachedDb: Database.Database | null = null;

/**
 * Project a task status change into the v4_workplaces shadow.
 *
 * Called by the dispatcher after every status transition (worker_next claim,
 * worker_done complete, worker_ask_need park). Safe to call unconditionally —
 * the projector no-ops when the feature-flag is off or when the task has no
 * Process Module metadata.
 */
export function projectTaskStatus(db: Database.Database, snapshot: {
  taskId: number;
  status: string;
  epicId: number;
  projectId: number;
  taskKind: string | null;
  metadata: string;
}): void {
  if (process.env.SAGA_WORKPLACE_WRITE !== 'on') return;
  if (cachedDb !== db) {
    cachedProjector = new WorkplaceProjector(db);
    cachedDb = db;
  }
  cachedProjector!.projectStatusChange(snapshot);
}
