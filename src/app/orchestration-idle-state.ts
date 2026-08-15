import type Database from 'better-sqlite3';

export interface CurrentStageWorkplaceState {
  readonly kernelProgressCount: number;
  readonly humanPausedCount: number;
  readonly otherNonTerminalCount: number;
  readonly states: Readonly<Record<string, number>>;
}

const KERNEL_PROGRESS_STATES = new Set([
  'repair_wait',
  'verifying',
  'effect_pending',
]);

/**
 * Read the exact Workplace states owned by the LifecycleRun's CURRENT StageRun.
 *
 * LifecycleRun.current_stage_run_id is a StageRun id, not a ProcessRun id.
 * Always cross the explicit StageRun.process_run_id binding before touching
 * factory_workplaces. Integer id equality across those tables is accidental
 * and must never be used as lineage.
 */
export function readCurrentStageWorkplaceState(
  db: Database.Database,
  lifecycleRunId: number,
): CurrentStageWorkplaceState {
  if (!Number.isSafeInteger(lifecycleRunId) || lifecycleRunId < 1) {
    return emptyState();
  }
  const rows = db.prepare(
    `SELECT w.loop_state AS loopState, COUNT(*) AS n
       FROM factory_lifecycle_runs lr
       JOIN factory_stage_runs sr
         ON sr.id=lr.current_stage_run_id
        AND sr.lifecycle_run_id=lr.id
       JOIN factory_workplaces w ON w.process_run_id=sr.process_run_id
      WHERE lr.id=? AND w.loop_state<>'terminal'
      GROUP BY w.loop_state
      ORDER BY w.loop_state`,
  ).all(lifecycleRunId) as Array<{ loopState: string; n: number }>;

  const states: Record<string, number> = {};
  let kernelProgressCount = 0;
  let humanPausedCount = 0;
  let otherNonTerminalCount = 0;
  for (const row of rows) {
    states[row.loopState] = row.n;
    if (KERNEL_PROGRESS_STATES.has(row.loopState)) {
      kernelProgressCount += row.n;
    } else if (row.loopState === 'paused') {
      humanPausedCount += row.n;
    } else {
      otherNonTerminalCount += row.n;
    }
  }
  return {
    kernelProgressCount,
    humanPausedCount,
    otherNonTerminalCount,
    states,
  };
}

function emptyState(): CurrentStageWorkplaceState {
  return {
    kernelProgressCount: 0,
    humanPausedCount: 0,
    otherNonTerminalCount: 0,
    states: {},
  };
}
