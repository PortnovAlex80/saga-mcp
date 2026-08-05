/**
 * WorkplaceReadComparator — SAGA_WORKPLACE_READ=both mode (Conveyor v4 step 5.3).
 *
 * Target contract: CONVEYOR-V4-MIGRATION-PLAN.md step 5.3 + FACTORY-DOMAIN-
 * ACCEPTANCE-REGISTRY REG-06 (WorkItem projection rebuild).
 *
 * # What this does
 *
 * When `SAGA_WORKPLACE_READ=both`, every read of a task's lifecycle state goes
 * through BOTH the legacy `tasks` table AND the `v4_workplaces` shadow, and
 * the results are compared. When they agree → return the legacy result (still
 * authoritative). When they drift → log a DRIFT warning (the operator sees it
 * and can investigate before switching to `SAGA_WORKPLACE_READ=new`).
 *
 * This is the safe cutover mechanism: run in `both` mode in production,
 * observe drift for a period, then switch to `new` (read from v4 only) when
 * drift is zero for a sustained period.
 *
 * # What it does NOT do
 *
 * It does NOT change the write path (dual-write from step 5.2 stays). It does
 * NOT make v4_workplaces authoritative (that is `SAGA_WORKPLACE_READ=new`).
 * It does NOT fix drift — it only REPORTS it.
 */

import type Database from 'better-sqlite3';
import { SqliteWorkplaceRepository } from '../workplace/sqlite-workplace-repository.js';
import { asWorkplaceRef, type KanbanPhase } from '../../process-modules/domain/workplace/index.js';

/** The expected v4 kanbanPhase for a given legacy task status. */
export function expectedKanbanPhase(legacyStatus: string): KanbanPhase | null {
  switch (legacyStatus) {
    case 'todo': return 'todo';
    case 'in_progress': return 'in_progress';
    case 'review': return 'review';
    case 'review_in_progress': return 'review_in_progress';
    case 'done':
    case 'pending_verification':
      return 'done';
    case 'blocked': return 'blocked';
    default: return null;
  }
}

/** Result of a `both`-mode comparison. */
export interface ComparisonResult {
  /** The legacy task status (what the dispatcher sees). */
  readonly legacyStatus: string;
  /** The v4 kanbanPhase (what the shadow says), null when no v4 row exists. */
  readonly v4KanbanPhase: KanbanPhase | null;
  /** Do they agree? */
  readonly inSync: boolean;
  /** Human-readable drift description (empty when inSync). */
  readonly driftDetail: string;
}

/**
 * Compare a task's legacy status against its v4_workplaces shadow.
 *
 * Call this from dispatcher reads when `SAGA_WORKPLACE_READ=both`. The
 * caller logs the drift (or surfaces it on the board) but still returns the
 * legacy result — `both` mode is observation, not authority switch.
 */
export function compareTaskStatus(
  db: Database.Database,
  task: {
    id: number;
    status: string;
    task_kind: string | null;
    metadata: string;
  },
): ComparisonResult {
  const expected = expectedKanbanPhase(task.status);

  // Derive the WorkplaceRef from task metadata (same logic as the projector).
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(task.metadata || '{}'); } catch { /* leave empty */ }
  const processRunId = meta['process_run_id'];
  if (!Number.isInteger(processRunId) || (processRunId as number) < 1) {
    // Not a Process Module task — no v4 shadow expected.
    return { legacyStatus: task.status, v4KanbanPhase: null, inSync: true, driftDetail: '' };
  }

  const repo = new SqliteWorkplaceRepository(db);
  const moduleRef = typeof meta['module_ref'] === 'string'
    ? meta['module_ref']
    : typeof task.task_kind === 'string'
      ? `${task.task_kind.split('.')[0]}@1.0.0`
      : 'unknown@1.0.0';
  const productionCellId = typeof meta['process_node_id'] === 'string'
    ? meta['process_node_id']
    : task.task_kind ?? 'default';
  const workKey = typeof meta['work_key'] === 'string' ? meta['work_key'] : `task-${task.id}`;

  try {
    const ref = asWorkplaceRef({
      processRunId: processRunId as number,
      moduleRef,
      productionCellId,
      workKey,
    });
    const v4State = repo.read(ref);
    const v4Phase = v4State?.kanbanPhase ?? null;

    if (expected === null) {
      return {
        legacyStatus: task.status,
        v4KanbanPhase: v4Phase,
        inSync: true,
        driftDetail: '',
      };
    }

    const inSync = v4Phase === expected;
    return {
      legacyStatus: task.status,
      v4KanbanPhase: v4Phase,
      inSync,
      driftDetail: inSync ? '' : `DRIFT: legacy='${task.status}' expects v4='${expected}', got v4='${v4Phase}'`,
    };
  } catch {
    // WorkplaceRef construction failed — treat as no shadow.
    return { legacyStatus: task.status, v4KanbanPhase: null, inSync: true, driftDetail: '' };
  }
}

/**
 * Is the read-cutover feature-flag active?
 *
 *   undefined / 'legacy' → read from tasks-table only (default).
 *   'both'               → read from both + compare (step 5.3).
 *   'new'                → read from v4_workplaces only (step 5.4 — after
 *                          sustained zero-drift in `both` mode).
 */
export function getWorkplaceReadMode(): 'legacy' | 'both' | 'new' {
  const mode = process.env.SAGA_WORKPLACE_READ;
  if (mode === 'both') return 'both';
  if (mode === 'new') return 'new';
  return 'legacy';
}

/**
 * Should the dispatcher log a drift comparison for this read?
 * Only when `SAGA_WORKPLACE_READ=both`.
 */
export function shouldCompareReads(): boolean {
  return getWorkplaceReadMode() === 'both';
}
