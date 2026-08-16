import type Database from 'better-sqlite3';
import { SqliteTransitionObligationLedger } from
  '../process-modules/persistence/sqlite-transition-obligation-ledger.js';

/**
 * TB-11 engine-start lifecycle burial (death cascade).
 *
 * A lifecycle run that reached terminal_status='failed' is dead, but its open
 * transition obligations are not: `findReady` keeps returning them and the
 * reconciler keeps re-leasing them forever (the live testbed shows one
 * obligation at attempt>1500). Each re-lease re-enters a kernel-owned
 * Workplace transition whose lifecycle will never supply the postcondition,
 * so the Workplace is frozen in `verifying`/`effect_pending` indefinitely.
 * The poison spreads: a NEW lifecycle for the same project (new_start) reuses
 * the same Workplace refs, and its settlement gate then waits on a workplace
 * whose state was killed by the previous, already-dead run.
 *
 * This pass runs once at engine start, after TB-9 adoption. Authority stays
 * in the DB: when the lifecycle that sourced an obligation is terminally
 * failed, no legitimate lease holder for that obligation can ever exist
 * again, so the obligation is abandoned (CAS open→failed, no lease — see
 * `SqliteTransitionObligationLedger.abandon`) and the kernel-owned
 * workplaces of the dead process runs are released to `terminal`.
 *
 * Only kernel-owned loop states (`verifying`, `effect_pending`) are released:
 * their transition is re-driven by the kernel from durable material, and with
 * the obligations dead nobody will ever drive it. Worker-owned states
 * (`leased`, `running`, `repair_wait`, `queued`) and `paused` are NOT touched
 * — the conveyor's own reaper/repair paths own those. terminal_reason uses
 * 'failed' (not a synthetic value) because the factory_workplaces CHECK
 * constrains it to ('accepted','failed','cancelled') and the owning
 * lifecycle's terminal fact IS a failure; the last_error on every abandoned
 * obligation carries the precise `LIFECYCLE_TERMINAL: lifecycle-run:<id>`
 * provenance instead.
 *
 * Open TASK rows of dead lifecycles are cancelled the same way. A task whose
 * workplace belongs to a dead process run can never be dispatched to
 * completion again, but its `in_progress` / `review_in_progress` row keeps
 * showing up in every epic-scoped read (dispatch backstops, W2 progress
 * reports, operator queries) as phantom work. Task→lifecycle linkage is the
 * same pid chain: task.workplace_ref → factory_workplaces.process_run_id →
 * factory_stage_runs.lifecycle_run_id.
 */

export const ENGINE_START_LIFECYCLE_BURIAL_POLICY_REF =
  'factory.engine-start-lifecycle-burial.v1';

/**
 * ALL non-terminal loop states of a DEAD lifecycle are orphans: the lifecycle
 * will never produce another runEpisode, so nobody — not the reaper, not the
 * executor, not the repair path, not the human — will ever drive the next
 * transition. The previous version only released kernel-owned states
 * (verifying/effect_pending) plus repair_wait, leaving queued/leased/running/
 * idle/paused workplaces of dead lifecycles as permanent phantoms that also
 * starved the dispatcher's shouldYieldToKernel check for the entire epic.
 */
const RELEASED_LOOP_STATES = "('idle','queued','leased','running','verifying','effect_pending','repair_wait','paused')";

export interface EngineStartLifecycleBurialResult {
  readonly lifecycleRuns: readonly number[];
  readonly buried: number;
  readonly workplacesReleased: number;
  readonly tasksCancelled: number;
  readonly details: readonly {
    readonly obligationKey: string;
    readonly lifecycleRunId: number;
    readonly priorState: string;
  }[];
  readonly releasedWorkplaces: readonly {
    readonly workplaceRef: string;
    readonly loopState: string;
  }[];
  readonly cancelledTasks: readonly {
    readonly taskId: number;
    readonly priorStatus: string;
    readonly lifecycleRunId: number;
  }[];
}

export function buryDeadLifecycleObligations(
  db: Database.Database,
  opts?: { projectId?: number },
): EngineStartLifecycleBurialResult {
  // Dead lifecycles: terminal_status is the durable terminal fact (status may
  // already be 'completed' — recorded after the terminal decision).
  const deadLifecycles = db.prepare(
    `SELECT id FROM factory_lifecycle_runs
      WHERE terminal_status='failed'
        ${opts?.projectId !== undefined ? 'AND project_id=@projectId' : ''}`,
  ).all({ ...(opts?.projectId !== undefined ? { projectId: opts.projectId } : {}) }) as
    { id: number }[];
  const lifecycleRunIds = deadLifecycles.map((row) => row.id);

  // Obligation→workplace linkage: every durable ref embeds its process run id
  // as the first path segment — 'workplace/<pid>/...', 'candidate-set/<pid>/...'
  // (the workplace path follows the kind), 'process-run:<pid>'. Matching both
  // subject_ref and source_ref with a trailing '/' keeps pid 4 from matching
  // pid 40. A stage run owns exactly one process run (UNIQUE(process_run_id)),
  // so the pid→lifecycle map is unambiguous.
  const stageRows = lifecycleRunIds.length === 0 ? [] : db.prepare(
    `SELECT process_run_id, lifecycle_run_id
       FROM factory_stage_runs
      WHERE lifecycle_run_id IN (${lifecycleRunIds.map(() => '?').join(',')})
        AND process_run_id IS NOT NULL`,
  ).all(...lifecycleRunIds) as { process_run_id: number; lifecycle_run_id: number }[];
  const pidToLifecycleRun = new Map(
    stageRows.map((row) => [row.process_run_id, row.lifecycle_run_id]),
  );
  const deadPids = JSON.stringify(stageRows.map((row) => row.process_run_id));

  const result: {
    details: { obligationKey: string; lifecycleRunId: number; priorState: string }[];
    releasedWorkplaces: { workplaceRef: string; loopState: string }[];
    cancelledTasks: { taskId: number; priorStatus: string; lifecycleRunId: number }[];
  } = { details: [], releasedWorkplaces: [], cancelledTasks: [] };
  if (stageRows.length === 0) {
    return {
      lifecycleRuns: lifecycleRunIds,
      buried: 0,
      workplacesReleased: 0,
      tasksCancelled: 0,
      details: [],
      releasedWorkplaces: [],
      cancelledTasks: [],
    };
  }

  const openObligations = db.prepare(
    `SELECT o.obligation_key AS obligationKey, o.state AS priorState,
            d.process_run_id AS processRunId
       FROM factory_transition_obligations o
       JOIN (SELECT value AS process_run_id FROM json_each(@deadPids)) d
         ON o.subject_ref = 'process-run:' || d.process_run_id
         OR o.subject_ref LIKE 'workplace/' || d.process_run_id || '/%'
         OR o.subject_ref LIKE 'candidate-set/' || d.process_run_id || '/%'
         OR o.source_ref = 'process-run:' || d.process_run_id
         OR o.source_ref LIKE '%workplace/' || d.process_run_id || '/%'
         OR o.source_ref LIKE '%candidate-set/' || d.process_run_id || '/%'
      WHERE o.state IN ('pending','in_progress')
      ORDER BY o.obligation_key`,
  ).all({ deadPids }) as {
    obligationKey: string;
    priorState: string;
    processRunId: number;
  }[];

  const frozenWorkplaces = db.prepare(
    `SELECT workplace_ref, loop_state
       FROM factory_workplaces
      WHERE process_run_id IN (SELECT value FROM json_each(@deadPids))
        AND loop_state IN ${RELEASED_LOOP_STATES}
      ORDER BY workplace_ref`,
  ).all({ deadPids }) as { workplace_ref: string; loop_state: string }[];

  // Open task rows of the dead process runs. Non-open statuses
  // (done/failed/cancelled) keep their historical verdict; only phantom
  // in-flight rows are cancelled.
  const openTasks = db.prepare(
    `SELECT t.id AS taskId, t.status AS priorStatus,
            w.process_run_id AS processRunId
       FROM tasks t
       JOIN factory_workplaces w ON w.workplace_ref = t.workplace_ref
      WHERE w.process_run_id IN (SELECT value FROM json_each(@deadPids))
        AND t.status IN ('todo','in_progress','review','review_in_progress','blocked')
      ORDER BY t.id`,
  ).all({ deadPids }) as {
    taskId: number;
    priorStatus: string;
    processRunId: number;
  }[];

  const ledger = new SqliteTransitionObligationLedger(db);
  db.transaction(() => {
    for (const row of openObligations) {
      const lifecycleRunId = pidToLifecycleRun.get(row.processRunId);
      if (lifecycleRunId === undefined) continue;
      const abandoned = ledger.abandon(
        row.obligationKey,
        `LIFECYCLE_TERMINAL: lifecycle-run:${lifecycleRunId}`,
      );
      if (abandoned) {
        result.details.push({
          obligationKey: row.obligationKey,
          lifecycleRunId,
          priorState: row.priorState,
        });
      }
    }
    const release = db.prepare(
      `UPDATE factory_workplaces
          SET kanban_phase='failed',
              loop_state='terminal',
              terminal_reason='failed',
              active_reservation_ref=NULL,
              revision=revision+1,
              updated_at=datetime('now')
        WHERE process_run_id IN (SELECT value FROM json_each(@deadPids))
          AND loop_state IN ${RELEASED_LOOP_STATES}`,
    );
    release.run({ deadPids });
    for (const workplace of frozenWorkplaces) {
      result.releasedWorkplaces.push({
        workplaceRef: workplace.workplace_ref,
        loopState: workplace.loop_state,
      });
    }
    const cancel = db.prepare(
      `UPDATE tasks
          SET status='cancelled', updated_at=datetime('now')
        WHERE id=@taskId
          AND status IN ('todo','in_progress','review','review_in_progress','blocked')`,
    );
    for (const task of openTasks) {
      const lifecycleRunId = pidToLifecycleRun.get(task.processRunId);
      if (lifecycleRunId === undefined) continue;
      if (cancel.run({ taskId: task.taskId }).changes === 1) {
        result.cancelledTasks.push({
          taskId: task.taskId,
          priorStatus: task.priorStatus,
          lifecycleRunId,
        });
      }
    }
  })();

  return {
    lifecycleRuns: lifecycleRunIds,
    buried: result.details.length,
    workplacesReleased: result.releasedWorkplaces.length,
    tasksCancelled: result.cancelledTasks.length,
    details: result.details,
    releasedWorkplaces: result.releasedWorkplaces,
    cancelledTasks: result.cancelledTasks,
  };
}
