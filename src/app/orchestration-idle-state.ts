import type Database from 'better-sqlite3';
import {
  classifyFactoryProgress,
} from '../application/progress/sqlite-progress-reader.js';
import type {
  ProgressExplanation,
} from '../application/progress/progress-classification.js';

export interface CurrentStageWorkplaceState {
  readonly kernelProgressCount: number;
  readonly humanPausedCount: number;
  readonly otherNonTerminalCount: number;
  readonly states: Readonly<Record<string, number>>;
  readonly progress: readonly ProgressExplanation[];
  readonly stalledCount: number;
  readonly inconsistentStateCount: number;
  readonly runnableCommandCount: number;
  readonly transitionDueCount: number;
  readonly liveOwnerCount: number;
  readonly typedWaitCount: number;
}

export type EmptyDispatchDecision =
  | 'stop-unhealthy'
  | 'stop-human-paused'
  | 'resume-runnable'
  | 'wait-proven'
  | 'resume-empty';

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

  const stage = db.prepare(
    `SELECT sr.process_run_id AS processRunId
       FROM factory_lifecycle_runs lr
       JOIN factory_stage_runs sr
         ON sr.id=lr.current_stage_run_id
        AND sr.lifecycle_run_id=lr.id
      WHERE lr.id=?`,
  ).get(lifecycleRunId) as { processRunId: number | null } | undefined;
  const progress = stage?.processRunId
    ? classifyFactoryProgress(db, { processRunId: stage.processRunId })
    : [];
  const progressCount = (classification: ProgressExplanation['classification']): number =>
    progress.filter(explanation => explanation.classification === classification).length;

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
    progress,
    stalledCount: progressCount('stalled'),
    inconsistentStateCount: progressCount('inconsistent_state'),
    runnableCommandCount: progressCount('runnable_command'),
    transitionDueCount: progressCount('transition_due'),
    liveOwnerCount: progressCount('live_owner'),
    typedWaitCount: progressCount('typed_wait'),
  };
}

/**
 * Decide an empty-dispatch cycle only from typed, durable progress evidence.
 * Merely having a nonterminal Workplace is never a reason to wait: it may be
 * blocked on a terminal predecessor and therefore have no possible wake-up.
 */
export function decideEmptyDispatch(
  state: CurrentStageWorkplaceState,
): EmptyDispatchDecision {
  if (state.stalledCount > 0 || state.inconsistentStateCount > 0) {
    return 'stop-unhealthy';
  }
  if (state.humanPausedCount > 0) return 'stop-human-paused';
  if (state.runnableCommandCount > 0 || state.transitionDueCount > 0) {
    return 'resume-runnable';
  }
  if (state.liveOwnerCount > 0 || state.typedWaitCount > 0) {
    return 'wait-proven';
  }
  return 'resume-empty';
}

function emptyState(): CurrentStageWorkplaceState {
  return {
    kernelProgressCount: 0,
    humanPausedCount: 0,
    otherNonTerminalCount: 0,
    states: {},
    progress: [],
    stalledCount: 0,
    inconsistentStateCount: 0,
    runnableCommandCount: 0,
    transitionDueCount: 0,
    liveOwnerCount: 0,
    typedWaitCount: 0,
  };
}
