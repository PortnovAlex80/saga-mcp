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
import { getDb } from '../../db.js';
import { logActivity } from '../../helpers/activity-logger.js';
import { reevaluateDownstream } from '../../tools/tasks.js';
import { reconcileWorkerExecutions } from '../../worker-executions.js';

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
  reconcile(projectId: number, epicId: number): ExecutionReconcileProjection[] {
    return reconcileWorkerExecutions(getDb(), projectId, epicId);
  }
}
