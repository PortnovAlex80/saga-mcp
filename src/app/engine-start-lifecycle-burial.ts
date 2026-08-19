import type Database from 'better-sqlite3';
import { SqliteTransitionObligationLedger } from
  '../process-modules/persistence/sqlite-transition-obligation-ledger.js';
import { recordWorkplaceParkReason } from
  '../infrastructure/workplace/workplace-park-reasons.js';
import { engineLog } from '../runtime/engine-file-logger.js';

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
 * provenance instead — plus the typed failure code of the lifecycle's durable
 * `error` when one exists (BLINDSIGHT F7: the abandon must say WHY the
 * lifecycle died, not only which one), and every released workplace carries
 * an append-only LIFECYCLE_BURIED park-reason row with a live pointer.
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
    /**
     * BLINDSIGHT F7 — the typed failure code of the dead lifecycle (extracted
     * from factory_lifecycle_runs.error), or null when the lifecycle recorded
     * no failure reason. Carried so the boot log and programmatic consumers
     * see WHY, not only which lifecycle died.
     */
    readonly lifecycleFailureCode: string | null;
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

/**
 * BLINDSIGHT F7 — typed identity of a dead lifecycle's failure reason: the
 * first line's CODE prefix before the first colon (the fail-closed vocabulary
 * style; prose after the colon is volatile detail), capped for durable
 * storage. Null when the lifecycle recorded no error.
 */
export function lifecycleFailureCode(error: string | null): string | null {
  if (typeof error !== 'string' || error.trim() === '') return null;
  const firstLine = error.trim().split('\n', 1)[0] ?? '';
  const code = firstLine.split(':', 1)[0] || firstLine;
  return code.slice(0, 120);
}

export function buryDeadLifecycleObligations(
  db: Database.Database,
  opts?: { projectId?: number },
): EngineStartLifecycleBurialResult {
  // Dead lifecycles: terminal_status is the durable terminal fact (status may
  // already be 'completed' — recorded after the terminal decision). The
  // durable failure reason (error) rides along so the burial can carry the
  // typed WHY, not only which lifecycle died (BLINDSIGHT F7).
  const deadLifecycles = db.prepare(
    `SELECT id, error FROM factory_lifecycle_runs
      WHERE terminal_status='failed'
        ${opts?.projectId !== undefined ? 'AND project_id=@projectId' : ''}`,
  ).all({ ...(opts?.projectId !== undefined ? { projectId: opts.projectId } : {}) }) as
    { id: number; error: string | null }[];
  const lifecycleRunIds = deadLifecycles.map((row) => row.id);
  const failureCodeByLifecycleRun = new Map(
    deadLifecycles.map((row) => [row.id, lifecycleFailureCode(row.error)]),
  );
  const failureSnippetByLifecycleRun = new Map(
    deadLifecycles.map((row) => {
      const snippet = (row.error ?? '').trim().split('\n', 1)[0] ?? '';
      return [row.id, snippet.slice(0, 300)];
    }),
  );

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
    details: {
      obligationKey: string;
      lifecycleRunId: number;
      priorState: string;
      lifecycleFailureCode: string | null;
    }[];
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
    `SELECT workplace_ref, loop_state, process_run_id
       FROM factory_workplaces
      WHERE process_run_id IN (SELECT value FROM json_each(@deadPids))
        AND loop_state IN ${RELEASED_LOOP_STATES}
      ORDER BY workplace_ref`,
  ).all({ deadPids }) as
    { workplace_ref: string; loop_state: string; process_run_id: number }[];

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
      // BLINDSIGHT F7 — the abandon reason carries the lifecycle's typed
      // failure identity when the durable error exists, so the WHY survives
      // the burial boundary instead of only the provenance of WHICH lifecycle
      // died. The CODE prefix is the typed identity; the first-line prose
      // after it rides along for the human reader (capped).
      const failureCode = failureCodeByLifecycleRun.get(lifecycleRunId) ?? null;
      const failureSnippet = failureSnippetByLifecycleRun.get(lifecycleRunId) ?? '';
      const reason = failureCode === null
        ? `LIFECYCLE_TERMINAL: lifecycle-run:${lifecycleRunId}`
        : `LIFECYCLE_TERMINAL: lifecycle-run:${lifecycleRunId} `
          + `failure=${failureSnippet}`;
      const abandoned = ledger.abandon(row.obligationKey, reason);
      if (abandoned) {
        result.details.push({
          obligationKey: row.obligationKey,
          lifecycleRunId,
          priorState: row.priorState,
          lifecycleFailureCode: failureCode,
        });
      }
    }
    // BLINDSIGHT F7 — every released workplace gets an append-only burial
    // reason row and a live pointer (the Fix-1 "парк всегда с причиной"
    // pattern applied to the burial: a terminal workplace must not exist
    // without its durable WHY).
    const parkReasonRefByWorkplace = new Map<string, string>();
    for (const workplace of frozenWorkplaces) {
      const lifecycleRunId = pidToLifecycleRun.get(workplace.process_run_id);
      const snippet = lifecycleRunId !== undefined
        ? failureSnippetByLifecycleRun.get(lifecycleRunId) ?? ''
        : '';
      parkReasonRefByWorkplace.set(
        workplace.workplace_ref,
        recordWorkplaceParkReason(db, workplace.workplace_ref, {
          code: 'LIFECYCLE_BURIED',
          message: `lifecycle-run:${lifecycleRunId ?? '?'} terminally failed; `
            + `the burial released this workplace to terminal failed.`
            + (snippet ? ` Lifecycle failure: ${snippet}` : ''),
          evidenceRefs: lifecycleRunId !== undefined
            ? [`lifecycle-run:${lifecycleRunId}`]
            : [],
        }),
      );
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
    const attachReason = db.prepare(
      `UPDATE factory_workplaces
          SET active_recovery_case_ref=@reasonRef,
              updated_at=datetime('now')
        WHERE workplace_ref=@workplaceRef AND loop_state='terminal'`,
    );
    for (const [workplaceRef, reasonRef] of parkReasonRefByWorkplace) {
      attachReason.run({ workplaceRef, reasonRef });
    }
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

  const burialResult = {
    lifecycleRuns: lifecycleRunIds,
    buried: result.details.length,
    workplacesReleased: result.releasedWorkplaces.length,
    tasksCancelled: result.cancelledTasks.length,
    details: result.details,
    releasedWorkplaces: result.releasedWorkplaces,
    cancelledTasks: result.cancelledTasks,
  };
  logEngineStartLifecycleBurial(burialResult);
  return burialResult;
}

/**
 * BLINDSIGHT F7 — one engine-log line per burial pass that actually buried
 * something, carrying the DISTINCT typed failure codes of the dead
 * lifecycles (code:count). The boot log previously showed only counters;
 * the durable WHY lived in factory_lifecycle_runs.error and never reached
 * the log a human reads.
 */
export function logEngineStartLifecycleBurial(
  burial: EngineStartLifecycleBurialResult,
): void {
  if (burial.buried === 0 && burial.workplacesReleased === 0 && burial.tasksCancelled === 0) {
    return;
  }
  const codes = new Map<string, number>();
  for (const detail of burial.details) {
    const code = detail.lifecycleFailureCode ?? '(no failure reason)';
    codes.set(code, (codes.get(code) ?? 0) + 1);
  }
  const codeSummary = [...codes.entries()]
    .map(([code, count]) => `${code}:${count}`)
    .join(' | ');
  engineLog(
    `[lifecycle-burial] buried=${burial.buried} `
    + `released=${burial.workplacesReleased} `
    + `cancelled=${burial.tasksCancelled} `
    + `lifecycles=${burial.lifecycleRuns.join(',') || 'none'} `
    + `failureCodes=${codeSummary || 'none'}`,
  );
}
