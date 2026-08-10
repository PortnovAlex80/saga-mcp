// tests/factory-temporal/lib/predicates.mjs
//
// Relational predicates over durable Factory records for the ADR-048 temporal
// probe and liveness explainer.
//
// DESIGN RULES (ADR-048):
//   * Each predicate is one small focused SQL query (1-3 lines).
//   * Every query uses a prepared statement and .get()/.all() — no ad-hoc exec.
//   * Read-only. None of these predicates ever writes to the DB; they are
//     intended to be called against a Database opened with { readonly: true }.
//   * They intentionally do NOT copy production SQL branch-for-branch. They
//     project only the durable columns the probe needs to observe temporal
//     conformance; production repositories hydrate full domain objects.
//
// SCHEMA NOTES (divergences from a naive spec — verified against src/schema.ts
// and src/process-modules/persistence/*):
//   * The final-acceptance table is `factory_cell_final_acceptances` (plural).
//   * The external-effect ledger tables are `factory_external_effect_actions`
//     and `factory_external_effect_events`. There is NO `factory_external_effect_
//     attempts` or `..._receipts` table; durable execution results live inline
//     on the action row (execution_result_snapshot/hash) and the audit trail
//     lives in _events. readExternalEffectReceipts returns the action rows that
//     have produced a durable execution result; countExternalEffectsPending
//     counts non-terminal actions.
//   * ProcessRun and LifecycleRun terminal status values are
//     ('completed','failed','cancelled'). There is NO 'stopped' status in this
//     schema — using it would silently never match. isProcessRunTerminal and
//     isLifecycleRunTerminal therefore use the real values.
//   * worker_executions has no workplace_ref column. The binding path is
//     worker_executions.task_id → tasks.id → tasks.workplace_ref →
//     factory_workplaces.workplace_ref (verified in
//     src/infrastructure/persistence/sqlite-factory-runtime-repositories.ts).

// ---------------------------------------------------------------------------
// Terminal status sets — single source of truth for the boolean predicates.
// ---------------------------------------------------------------------------

const PROCESS_RUN_TERMINAL = ['completed', 'failed', 'cancelled'];
const LIFECYCLE_RUN_TERMINAL = ['completed', 'failed', 'cancelled'];
const WORKER_ACTIVE_STATES = ['reserved', 'running', 'cancel_requested'];
// External-effect action terminal states (see ACTION_STATES +
// isTerminal() in sqlite-external-effect-ledger.ts).
const EXTERNAL_EFFECT_TERMINAL = ['succeeded', 'blocked'];

// ===========================================================================
// Counts and existence checks
// ===========================================================================

/**
 * Count workplaces whose two-channel loop_state equals `loopState`.
 * Covers the full REG-28 loop_state domain:
 *   idle/queued/leased/running/verifying/effect_pending/repair_wait/paused/terminal.
 */
export function countWorkplacesInLoopState(db, loopState) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM factory_workplaces WHERE loop_state=?',
  ).get(loopState).n;
}

/**
 * Count WorkerExecutions in the active set (reserved/running/cancel_requested)
 * for one (project, epic). These are the executions that still own a task.
 */
export function countActiveWorkerExecutions(db, projectId, epicId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM worker_executions
      WHERE project_id=? AND epic_id=?
        AND state IN ('reserved','running','cancel_requested')`,
  ).get(projectId, epicId).n;
}

/**
 * Count sealed CandidateSets for one workplace, optionally filtered by role.
 * `role` may be null/undefined to count both author and reviewer sets.
 */
export function countCandidateSetsForWorkplace(db, workplaceRef, role) {
  if (role === undefined || role === null) {
    return db.prepare(
      'SELECT COUNT(*) AS n FROM factory_candidate_sets WHERE workplace_ref=?',
    ).get(workplaceRef).n;
  }
  return db.prepare(
    'SELECT COUNT(*) AS n FROM factory_candidate_sets WHERE workplace_ref=? AND role=?',
  ).get(workplaceRef, role).n;
}

/**
 * Count immutable GateDecisions for one workplace, optionally filtered by
 * gate_phase ('author' | 'final').
 */
export function countGateDecisionsForWorkplace(db, workplaceRef, phase) {
  if (phase === undefined || phase === null) {
    return db.prepare(
      'SELECT COUNT(*) AS n FROM factory_gate_decisions WHERE workplace_ref=?',
    ).get(workplaceRef).n;
  }
  return db.prepare(
    'SELECT COUNT(*) AS n FROM factory_gate_decisions WHERE workplace_ref=? AND gate_phase=?',
  ).get(workplaceRef, phase).n;
}

/**
 * Count ProcessRuns bound to terminal StageRuns of one stage_run_id's
 * lifecycle that are themselves terminal. Used by the probe to detect
 * "all work for this stage has settled".
 *
 * A "terminal ProcessRun for a stage" = the ProcessRun bound to one of the
 * stage_runs that share this stage_run's lifecycle_run_id AND stage_id (retry
 * siblings) whose status is terminal.
 */
export function countTerminalProcessRunsForStage(db, stageRunId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM factory_process_runs pr
       JOIN factory_stage_runs sr ON sr.process_run_id=pr.id
      WHERE sr.lifecycle_run_id=(
              SELECT lifecycle_run_id FROM factory_stage_runs WHERE id=?)
        AND pr.status IN ('completed','failed','cancelled')`,
  ).get(stageRunId).n;
}

/**
 * Count external-effect actions for one ProcessRun that are NOT in a terminal
 * state (terminal = succeeded/blocked). These are the effects the conveyor
 * still owes a result for — the `effect_pending` loop_state exists precisely
 * to track this obligation.
 */
export function countExternalEffectsPending(db, processRunId) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM factory_external_effect_actions
      WHERE process_run_id=? AND state NOT IN ('succeeded','blocked')`,
  ).get(processRunId).n;
}

// ===========================================================================
// Exact-ref lookups
// ===========================================================================

/**
 * Latest LifecycleRun row for a project (highest id). Returns the raw row or
 * null when the project has no lifecycle run yet.
 */
export function readLifecycleRun(db, projectId) {
  return db.prepare(
    `SELECT * FROM factory_lifecycle_runs
      WHERE project_id=? ORDER BY id DESC LIMIT 1`,
  ).get(projectId) ?? null;
}

/**
 * The StageRun currently pointed at by a LifecycleRun's current_stage_run_id.
 * Returns null when the lifecycle is terminal (current_stage_run_id is NULL)
 * or has not yet bound a stage.
 */
export function readCurrentStageRun(db, lifecycleRunId) {
  return db.prepare(
    `SELECT sr.* FROM factory_lifecycle_runs lr
       JOIN factory_stage_runs sr ON sr.id=lr.current_stage_run_id
      WHERE lr.id=?`,
  ).get(lifecycleRunId) ?? null;
}

/**
 * The ProcessRun bound to a StageRun (factory_stage_runs.process_run_id).
 * Returns null when the stage has not yet bound a ProcessRun.
 */
export function readCurrentProcessRun(db, stageRunId) {
  return db.prepare(
    `SELECT pr.* FROM factory_process_runs pr
       JOIN factory_stage_runs sr ON sr.process_run_id=pr.id
      WHERE sr.id=?`,
  ).get(stageRunId) ?? null;
}

/**
 * Raw factory_workplaces row for a serialized workplace_ref, or null.
 */
export function readWorkplaceByRef(db, workplaceRef) {
  return db.prepare(
    'SELECT * FROM factory_workplaces WHERE workplace_ref=?',
  ).get(workplaceRef) ?? null;
}

/**
 * Raw worker_executions row by execution_id, or null.
 */
export function readWorkerExecution(db, executionId) {
  return db.prepare(
    'SELECT * FROM worker_executions WHERE execution_id=?',
  ).get(executionId) ?? null;
}

/**
 * Most recent GateRun for a workplace (highest created_at, ties broken by
 * gate_run_ref for determinism). Returns null if none exists.
 */
export function readLatestGateRun(db, workplaceRef) {
  return db.prepare(
    `SELECT * FROM factory_gate_runs
      WHERE workplace_ref=?
      ORDER BY created_at DESC, gate_run_ref DESC LIMIT 1`,
  ).get(workplaceRef) ?? null;
}

/**
 * Immutable GateDecisions for a workplace + gate phase, newest-first.
 * Mirrors listDecisionsForWorkplace ordering (decided_at DESC, rowid DESC).
 */
export function readGateDecisions(db, workplaceRef, gatePhase) {
  if (gatePhase === undefined || gatePhase === null) {
    return db.prepare(
      `SELECT * FROM factory_gate_decisions
        WHERE workplace_ref=?
        ORDER BY decided_at DESC, rowid DESC`,
    ).all(workplaceRef);
  }
  return db.prepare(
    `SELECT * FROM factory_gate_decisions
      WHERE workplace_ref=? AND gate_phase=?
      ORDER BY decided_at DESC, rowid DESC`,
  ).all(workplaceRef, gatePhase);
}

/**
 * The final-acceptance row for a workplace (1:1 by workplace_ref UNIQUE), or
 * null. Table name is the PLURAL `factory_cell_final_acceptances`.
 */
export function readCellFinalAcceptance(db, workplaceRef) {
  return db.prepare(
    'SELECT * FROM factory_cell_final_acceptances WHERE workplace_ref=?',
  ).get(workplaceRef) ?? null;
}

/**
 * Durable "receipts" of external-effect execution for one ProcessRun.
 *
 * There is no `factory_external_effect_receipts` table; the durable record of
 * an executed effect lives INLINE on the action row
 * (execution_result_snapshot + execution_result_hash + state reflecting the
 * outcome). This predicate returns the action rows for the ProcessRun that
 * HAVE produced an execution result — i.e. a succeeded/failed/unknown attempt
 * whose execution_result_hash is non-null. Append-only audit events for each
 * action are available separately in factory_external_effect_events.
 */
export function readExternalEffectReceipts(db, processRunId) {
  return db.prepare(
    `SELECT * FROM factory_external_effect_actions
      WHERE process_run_id=?
        AND execution_result_hash IS NOT NULL
      ORDER BY id`,
  ).all(processRunId);
}

// ===========================================================================
// Composite state predicates (boolean)
// ===========================================================================

/**
 * True iff at least one WorkerExecution in the active set (reserved/running/
 * cancel_requested) is bound to this workplace via tasks.workplace_ref.
 *
 * Binding path (verified in sqlite-factory-runtime-repositories.ts reconcile):
 *   worker_executions.task_id → tasks.id → tasks.workplace_ref
 */
export function hasLiveOwner(db, workplaceRef) {
  return db.prepare(
    `SELECT EXISTS (
       SELECT 1 FROM worker_executions we
         JOIN tasks t ON t.id=we.task_id
        WHERE t.workplace_ref=?
          AND we.state IN ('reserved','running','cancel_requested')
     ) AS ok`,
  ).get(workplaceRef).ok === 1;
}

/**
 * True iff the workplace's loop_state is 'terminal'.
 */
export function isWorkplaceTerminal(db, workplaceRef) {
  return db.prepare(
    `SELECT EXISTS (
       SELECT 1 FROM factory_workplaces
        WHERE workplace_ref=? AND loop_state='terminal'
     ) AS ok`,
  ).get(workplaceRef).ok === 1;
}

/**
 * True iff the ProcessRun status is in the terminal set
 * ('completed','failed','cancelled'). NOTE: there is no 'stopped' status in
 * this schema — using it would silently never match.
 */
export function isProcessRunTerminal(db, processRunId) {
  return db.prepare(
    `SELECT EXISTS (
       SELECT 1 FROM factory_process_runs
        WHERE id=? AND status IN ('completed','failed','cancelled')
     ) AS ok`,
  ).get(processRunId).ok === 1;
}

/**
 * True iff the LifecycleRun status is in the terminal set
 * ('completed','failed','cancelled').
 */
export function isLifecycleRunTerminal(db, lifecycleRunId) {
  return db.prepare(
    `SELECT EXISTS (
       SELECT 1 FROM factory_lifecycle_runs
        WHERE id=? AND status IN ('completed','failed','cancelled')
     ) AS ok`,
  ).get(lifecycleRunId).ok === 1;
}

/**
 * True iff the workplace is in the 'verifying' loop_state AND no GateDecision
 * has been recorded for it yet (the gate is in-flight but undecided).
 */
export function hasPendingGateRun(db, workplaceRef) {
  return db.prepare(
    `SELECT EXISTS (
       SELECT 1 FROM factory_workplaces w
        WHERE w.workplace_ref=? AND w.loop_state='verifying'
          AND NOT EXISTS (
            SELECT 1 FROM factory_gate_decisions d
             WHERE d.workplace_ref=w.workplace_ref)
     ) AS ok`,
  ).get(workplaceRef).ok === 1;
}

/**
 * True iff there exists a ProcessRun, bound to a StageRun of this stage's
 * lifecycle+stage_id, that is terminal BUT no factory_process_transitions row
 * has advanced FROM this stage yet — i.e. settlement completed but the
 * lifecycle has not consumed it.
 */
export function hasUnroutedTerminalProcessRun(db, stageRunId) {
  return db.prepare(
    `SELECT EXISTS (
       SELECT 1
         FROM factory_stage_runs this
         JOIN factory_stage_runs sib
           ON sib.lifecycle_run_id=this.lifecycle_run_id
          AND sib.stage_id=this.stage_id
         JOIN factory_process_runs pr ON pr.id=sib.process_run_id
        WHERE this.id=?
          AND pr.status IN ('completed','failed','cancelled')
          AND NOT EXISTS (
            SELECT 1 FROM factory_process_transitions tr
             WHERE tr.from_stage_run_id=sib.id)
     ) AS ok`,
  ).get(stageRunId).ok === 1;
}

/**
 * True iff the engine SHOULD be able to make progress but has nothing driving
 * it: at least one workplace is queued, no active WorkerExecution exists for
 * the epic, and no non-terminal LifecycleRun has a live execution lease.
 */
export function isEngineDeadRunnable(db, epicId) {
  return db.prepare(
    `SELECT EXISTS (
       SELECT 1 FROM factory_workplaces w
         JOIN factory_process_runs pr ON pr.id=w.process_run_id
        WHERE pr.epic_id=?
          AND w.loop_state='queued'
          AND NOT EXISTS (
            SELECT 1 FROM worker_executions we
             WHERE we.epic_id=?
               AND we.state IN ('reserved','running','cancel_requested'))
          AND NOT EXISTS (
            SELECT 1 FROM factory_lifecycle_runs lr
             WHERE lr.epic_id=?
               AND lr.status IN ('created','running','paused')
               AND lr.execution_lease_owner IS NOT NULL)
     ) AS ok`,
  ).get(epicId, epicId, epicId).ok === 1;
}

// ===========================================================================
// Snapshot reader for the probe
// ===========================================================================

/**
 * A stable snapshot of the durable Factory state for one (project, epic).
 * The object is deep-compared by the probe; it changes iff any projected
 * durable column changes. It deliberately captures AGGREGATE counts and
 * per-workplace state tuples rather than timestamps, so it is robust to
 * clock-only churn.
 */
export function readProgressSnapshot(db, projectId, epicId) {
  const lifecycle = readLifecycleRun(db, projectId);
  const lifecycleView = lifecycle
    ? {
      status: lifecycle.status,
      currentStageRunId: lifecycle.current_stage_run_id,
      version: lifecycle.version,
    }
    : null;

  const workplaces = db.prepare(
    `SELECT w.workplace_ref        AS ref,
            w.loop_state           AS loopState,
            w.kanban_phase         AS kanbanPhase,
            w.next_role            AS nextRole,
            w.revision             AS revision
       FROM factory_workplaces w
       JOIN factory_process_runs pr ON pr.id=w.process_run_id
      WHERE pr.project_id=? AND pr.epic_id=?
      ORDER BY w.workplace_ref`,
  ).all(projectId, epicId);

  const counts = {
    activeExecutions: countActiveWorkerExecutions(db, projectId, epicId),
    queuedWorkplaces: db.prepare(
      `SELECT COUNT(*) AS n FROM factory_workplaces w
         JOIN factory_process_runs pr ON pr.id=w.process_run_id
        WHERE pr.project_id=? AND pr.epic_id=? AND w.loop_state='queued'`,
    ).get(projectId, epicId).n,
    verifyingWorkplaces: db.prepare(
      `SELECT COUNT(*) AS n FROM factory_workplaces w
         JOIN factory_process_runs pr ON pr.id=w.process_run_id
        WHERE pr.project_id=? AND pr.epic_id=? AND w.loop_state='verifying'`,
    ).get(projectId, epicId).n,
    terminalWorkplaces: db.prepare(
      `SELECT COUNT(*) AS n FROM factory_workplaces w
         JOIN factory_process_runs pr ON pr.id=w.process_run_id
        WHERE pr.project_id=? AND pr.epic_id=? AND w.loop_state='terminal'`,
    ).get(projectId, epicId).n,
    pendingGateWorkplaces: db.prepare(
      `SELECT COUNT(*) AS n FROM factory_workplaces w
         JOIN factory_process_runs pr ON pr.id=w.process_run_id
        WHERE pr.project_id=? AND pr.epic_id=?
          AND w.loop_state='verifying'
          AND NOT EXISTS (
            SELECT 1 FROM factory_gate_decisions d
             WHERE d.workplace_ref=w.workplace_ref)`,
    ).get(projectId, epicId).n,
  };

  return Object.freeze({
    lifecycle: Object.freeze(lifecycleView),
    workplaces: Object.freeze(workplaces.map(wp => Object.freeze(wp))),
    counts: Object.freeze(counts),
  });
}

// Exported constants for testing/inspection.
export { PROCESS_RUN_TERMINAL, LIFECYCLE_RUN_TERMINAL, WORKER_ACTIVE_STATES, EXTERNAL_EFFECT_TERMINAL };
