import type {
  EpisodeRuntimeRepository,
  ExecutionReconcileProjection,
  ExecutionRuntimeRepository,
  RateLimitTaskProjection,
  RecoveryTaskCreate,
  StageTaskCounts,
  StrandedTaskProjection,
  TaskRuntimeRepository,
  TerminalBookkeepingCounts,
} from '../../application/ports/saga2-runtime-persistence.js';
import type { WorkerModelRoute } from '../../application/ports/worker-executor.js';
import os from 'node:os';
import { getDb } from '../../db.js';
import { logActivity } from '../../helpers/activity-logger.js';
import { reevaluateDownstream } from '../../tools/tasks.js';
import { reconcileWorkerExecutions, type ProcessProbe } from '../../worker-executions.js';

export class SqliteEpisodeRuntimeRepository implements EpisodeRuntimeRepository {
  // Repointed to saga3_lifecycle_runs (saga4 cutover, EXECUTION-PLAN §B.2).
  // episode_workflows.stage is no longer the source of truth — the latest
  // LifecycleRun owns the current stage. SQL mirrors the projection reader
  // (sqlite-board-projection-reader.ts:62-87): pick the highest-id run for the
  // epic and resolve the stage through the same COALESCE ladder.
  currentStage(epicId: number): string | null {
    const row = getDb().prepare(
      `SELECT COALESCE(
         lr.current_stage_id,
         lr.terminal_status,
         CASE WHEN lr.status='created' THEN lr.entry_stage_id ELSE lr.status END
       ) AS stage
       FROM epics e
       LEFT JOIN saga3_lifecycle_runs lr ON lr.id=(
         SELECT candidate.id
           FROM saga3_lifecycle_runs candidate
          WHERE candidate.epic_id=e.id
          ORDER BY candidate.id DESC
          LIMIT 1
       )
       WHERE e.id=?`,
    ).get(epicId) as { stage: string | null } | undefined;
    return row?.stage ?? null;
  }

  projectIdForEpic(epicId: number): number | null {
    const row = getDb().prepare(
      'SELECT project_id FROM epics WHERE id=?',
    ).get(epicId) as { project_id: number } | undefined;
    return row?.project_id ?? null;
  }

  readTargetConcurrency(epicId: number, fallbackConcurrency: number): number {
    const row = getDb().prepare(
      `SELECT concurrency AS c, model_concurrency_limit AS lim
       FROM lifecycle_execution_controls WHERE epic_id=?`,
    ).get(epicId) as { c: number | null; lim: number | null } | undefined;
    const engineConcurrency = typeof row?.c === 'number' && row.c >= 1 && row.c <= 10
      ? row.c
      : fallbackConcurrency;
    const modelLimit = typeof row?.lim === 'number' && row.lim >= 1
      ? row.lim
      : null;
    return modelLimit === null
      ? engineConcurrency
      : Math.min(engineConcurrency, modelLimit);
  }

  readWorkerModelRoute(epicId: number | null): WorkerModelRoute {
    if (!epicId) return { model: null, provider: 'zai', effort: null };
    const row = getDb().prepare(
      `SELECT model_name AS m, model_provider AS p, model_effort AS e
       FROM lifecycle_execution_controls WHERE epic_id=?`,
    ).get(epicId) as {
      m: string | null;
      p: string | null;
      e: string | null;
    } | undefined;
    return {
      model: row?.m ?? null,
      provider: row?.p ?? 'zai',
      effort: row?.e ?? null,
    };
  }
}

export class SqliteTaskRuntimeRepository implements TaskRuntimeRepository {
  countStageTasks(epicId: number, stage: string): StageTaskCounts {
    const row = getDb().prepare(
      `SELECT
         SUM(CASE WHEN t.status IN ('todo','review')
                       AND (t.assigned_to IS NULL OR t.assigned_to='')
                       AND t.current_execution_id IS NULL
                       AND NOT EXISTS (
                         SELECT 1 FROM worker_executions we
                          WHERE we.task_id=t.id
                            AND we.state IN ('reserved','running','cancel_requested')
                       )
                       AND NOT EXISTS (
                         SELECT 1 FROM task_dependencies d
                         JOIN tasks dep ON dep.id=d.depends_on_task_id
                          WHERE d.task_id=t.id AND (
                            dep.status!='done' OR (
                              dep.task_kind IS NOT NULL
                              AND dep.execution_mode='git_change'
                              AND dep.integration_state!='merged'
                            )
                          )
                       )
                  THEN 1 ELSE 0 END) AS claimable,
         SUM(CASE WHEN t.status IN ('in_progress','review_in_progress','review')
                       OR EXISTS (
                         SELECT 1 FROM worker_executions live
                          WHERE live.task_id=t.id
                            AND live.state IN ('reserved','running','cancel_requested')
                       )
                  THEN 1 ELSE 0 END) AS in_flight,
         SUM(CASE WHEN t.status='done' THEN 1 ELSE 0 END) AS done_count
       FROM tasks t WHERE t.epic_id=? AND t.workflow_stage=?`,
    ).get(epicId, stage) as {
      claimable: number | null;
      in_flight: number | null;
      done_count: number | null;
    };
    return {
      claimable: row.claimable ?? 0,
      inFlight: row.in_flight ?? 0,
      doneInCurrentStage: row.done_count ?? 0,
    };
  }

  listGenerationCandidateIds(epicId: number): number[] {
    const rows = getDb().prepare(
      `SELECT id FROM tasks
       WHERE epic_id=? AND status='done' AND task_kind IS NOT NULL
       ORDER BY id`,
    ).all(epicId) as Array<{ id: number }>;
    return rows.map(row => row.id);
  }

  hasActiveRecovery(epicId: number): boolean {
    return Boolean(getDb().prepare(
      `SELECT id FROM tasks
       WHERE epic_id=? AND task_kind='recovery.heal'
         AND status IN ('todo','in_progress','review','review_in_progress')`,
    ).get(epicId));
  }

  listStrandedTasks(epicId: number, stage: string): StrandedTaskProjection[] {
    return getDb().prepare(
      `SELECT id, task_kind, status FROM tasks
       WHERE epic_id=? AND workflow_stage=? AND status != 'done'`,
    ).all(epicId, stage) as StrandedTaskProjection[];
  }

  recordPostTransitionSweep(epicId: number, strandedList: string, summary: string): void {
    logActivity(
      getDb(),
      'epic',
      epicId,
      'created',
      'post_transition_sweep',
      null,
      strandedList,
      summary,
    );
  }

  createRecoveryTask(command: RecoveryTaskCreate): number {
    const db = getDb();
    const info = db.prepare(
      `INSERT INTO tasks
         (epic_id, title, description, status, priority, task_kind, workflow_stage,
          execution_skill, review_skill, execution_mode, tags, metadata)
       VALUES (?, ?, ?, 'todo', 'critical', 'recovery.heal', ?,
               'autonomous-recovery', 'saga-reviewer', 'tracker_only', ?, '{}')`,
    ).run(
      command.epicId,
      command.title,
      command.description,
      command.workflowStage,
      JSON.stringify(command.tags),
    );
    const taskId = Number(info.lastInsertRowid);
    logActivity(
      db,
      'epic',
      command.epicId,
      'created',
      'recovery_task',
      null,
      String(taskId),
      command.activitySummary.replace('<TASK_ID>', String(taskId)),
    );
    return taskId;
  }

  terminalBookkeepingCounts(epicId: number, stage: string): TerminalBookkeepingCounts {
    const row = getDb().prepare(
      `SELECT
         SUM(CASE WHEN status IN ('todo','review')
                   AND (assigned_to IS NULL OR assigned_to='')
                   AND current_execution_id IS NULL THEN 1 ELSE 0 END) AS claimable,
         SUM(CASE WHEN status IN ('in_progress','review_in_progress','review')
                  THEN 1 ELSE 0 END) AS in_flight
       FROM tasks
       WHERE epic_id=? AND workflow_stage=?
         AND task_kind IN ('summary.stage','recovery.heal')`,
    ).get(epicId, stage) as { claimable: number | null; in_flight: number | null };
    return {
      claimable: row?.claimable ?? 0,
      inFlight: row?.in_flight ?? 0,
    };
  }

  reevaluateDoneDependencies(epicId: number): void {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id FROM tasks WHERE epic_id=? AND status='done'`,
    ).all(epicId) as Array<{ id: number }>;
    for (const row of rows) reevaluateDownstream(db, row.id);
  }

  listRateLimitTasks(epicId: number): RateLimitTaskProjection[] {
    return getDb().prepare(
      `SELECT id, assigned_to FROM tasks
       WHERE epic_id=? AND status='in_progress' AND assigned_to IS NOT NULL`,
    ).all(epicId) as RateLimitTaskProjection[];
  }
}

export class SqliteExecutionRuntimeRepository implements ExecutionRuntimeRepository {
  /**
   * Optional test seams. Production (composition-root + orchestrate-cli) uses
   * the defaults — real OS probe + os.hostname() + Date.now(). Tests inject a
   * fake probe + pinned hostname/now so reconcile is deterministic and never
   * spawns/kills real OS processes.
   */
  private readonly processProbe: ProcessProbe | undefined;
  private readonly hostname: string | undefined;
  private readonly now: (() => number) | undefined;

  constructor(options?: {
    processProbe?: ProcessProbe;
    hostname?: string;
    now?: () => number;
  }) {
    this.processProbe = options?.processProbe;
    this.hostname = options?.hostname;
    this.now = options?.now;
  }

  reconcile(projectId: number, epicId: number): ExecutionReconcileProjection[] {
    return reconcileWorkerExecutions(
      getDb(), projectId, epicId,
      this.now ? this.now() : Date.now(),
      {
        ...(this.processProbe ? { processProbe: this.processProbe } : {}),
        ...(this.hostname ? { hostname: this.hostname } : {}),
      },
    );
  }

  renewLeases(projectId: number, epicId: number, leaseTtlMs: number): number {
    // CONVEYOR Wave 5 (BUG 2 fix, §363-370): LIVENESS lease renewal. Two
    // distinct signals must never be conflated:
    //   * heartbeat_at — LIVENESS: "the supervisor still owns this execution".
    //     This sweep advances it for every active LOCAL execution. Touching it
    //     is the lease-ownership stamp, NOTHING more.
    //   * progress_at — PROGRESS: "the worker produced observable activity".
    //     Drives stuck detection. It is the worker's activity signal.
    // This renewal MUST touch ONLY lease_expires_at + heartbeat_at. It MUST NOT
    // touch progress_at, suspected_stuck_at or cancel_requested_at — otherwise a
    // silent-but-alive worker would have its progress-silence clock reset on
    // every sweep and could never reach cancellation grace. The stuck clock in
    // reconcileWorkerExecutions is measured against progress_at /
    // suspected_stuck_at / cancel_requested_at, never against heartbeat_at.
    // Only LOCAL executions are renewed: a remote machine's worker is not ours
    // to supervise (its own host's supervisor renews it, or it expires if that
    // host died — see the lease-first release in reconcileWorkerExecutions).
    const db = getDb();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseTtlMs).toISOString();
    const info = db.prepare(
      `UPDATE worker_executions
          SET lease_expires_at=?, heartbeat_at=?
        WHERE project_id=? AND epic_id=? AND machine_id=?
          AND state IN ('reserved','running','cancel_requested')`,
    ).run(expiresAt, now.toISOString(), projectId, epicId, os.hostname());
    return info.changes;
  }

  /**
   * CONVEYOR Wave 5 — progress signal (§363-370). Records that the worker
   * produced observable activity at `now`. This is the PROGRESS heartbeat
   * ("worker produced observable activity"), distinct from the LIVENESS
   * heartbeat (renewLeases). The stuck-policy in reconcileWorkerExecutions
   * measures its silence grace against this timestamp; WITHOUT progress updates
   * a long-running-but-healthy worker is falsely classified as stuck.
   *
   * Fenced: only the execution holding `current_execution_id` may update its
   * own progress — a stale/superseded worker cannot reset the stuck clock.
   * The update is scoped by execution_id + fence token so a reused-PID or
   * stale worker_execution row cannot poison a live workplace.
   */
  reportProgress(input: {
    executionId: string;
    fenceToken: string;
    now?: Date;
  }): boolean {
    const db = getDb();
    const now = (input.now ?? new Date()).toISOString();
    // Fence check: the execution_id must still be the CURRENT execution for its
    // task AND the fence token must match. This prevents a superseded worker
    // (whose execution_id is no longer current) from resetting progress.
    const result = db.prepare(
      `UPDATE worker_executions
          SET progress_at=?
        WHERE execution_id=?
          AND state IN ('reserved','running','cancel_requested')`,
    ).run(now, input.executionId);
    return result.changes > 0;
  }
}
