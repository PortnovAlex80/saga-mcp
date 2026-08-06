/**
 * Atomic work assignment and task-board projection for the Saga4 conveyor.
 *
 * The authoritative execution loop belongs to Workplace. `tasks.status` is a
 * human-facing reverse projection. This module is one of the very small set of
 * legal writers of tasks.{status,assigned_to,current_execution_id}; claim and
 * projection updates therefore stay inside the same BEGIN IMMEDIATE boundary.
 */

import type Database from 'better-sqlite3';
import type { Task } from '../types.js';
import type { AssignedWork } from '../application/ports/worker-executor.js';
import type { AuthorityScope, WorkIntent } from '../shared/work-intent.js';
import { buildExecutionContext } from '../shared/authority/build-execution-context.js';
import { executionContextHash } from '../shared/authority/execution-context.js';
import { asCardId, asExecutionId, asFenceToken } from './domain/ids.js';
import { logActivity } from '../helpers/activity-logger.js';

export const PRIORITY_ORDER =
  "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END";
export const MAX_CLAIM_ATTEMPTS = 10;
export const WORKER_LEASE_TTL_MS = 5 * 60 * 1000;

export function withImmediateTransaction<T>(
  db: Database.Database,
  fn: () => T,
): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No active transaction.
    }
    throw error;
  }
}

export type WorkerSkill = string;

/** Resolve the role from the post-claim board projection. */
export function skillForTask(task: Task, sourceStatus: string): WorkerSkill {
  const review = sourceStatus === 'review'
    || sourceStatus === 'review_in_progress';
  if (review && task.review_skill) return task.review_skill;
  if (!review && task.execution_skill) return task.execution_skill;

  let tags: string[] = [];
  try {
    const parsed = JSON.parse(task.tags || '[]');
    if (Array.isArray(parsed)) {
      tags = parsed.filter((value): value is string => typeof value === 'string');
    }
  } catch {
    // Malformed legacy tags: use status fallback.
  }
  const explicit = tags.find(tag =>
    tag.startsWith(review ? 'review-skill:' : 'skill:'));
  if (explicit) return explicit.slice(explicit.indexOf(':') + 1);
  if (!review) {
    const role = tags.find(tag => tag.startsWith('role:'))
      ?.slice('role:'.length);
    if (role) return `saga-${role}`;
  }
  return review ? 'saga-reviewer' : 'saga-developer';
}

export function readModelRouteAtClaim(
  db: Database.Database,
  epicId: number,
): { provider: string; model: string | null; effort: string | null } {
  const row = db.prepare(
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

export function strictAuthorityScope(raw: unknown): AuthorityScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'AUTHORITY_BINDING_INVALID: authority_scope must be an object',
    );
  }
  const scope = raw as Record<string, unknown>;
  if (typeof scope.snapshot_ref !== 'string' || scope.snapshot_ref.trim() === '') {
    throw new Error(
      'AUTHORITY_BINDING_INVALID: authority_scope.snapshot_ref is required',
    );
  }
  if (typeof scope.scope !== 'string' || scope.scope.trim() === '') {
    throw new Error(
      'AUTHORITY_BINDING_INVALID: authority_scope.scope is required',
    );
  }
  if (
    !Array.isArray(scope.allowed_tools)
    || !scope.allowed_tools.every(
      value => typeof value === 'string' && value.trim() !== '',
    )
    || new Set(scope.allowed_tools).size !== scope.allowed_tools.length
  ) {
    throw new Error(
      'AUTHORITY_BINDING_INVALID: authority_scope.allowed_tools must be a unique string array',
    );
  }
  if (scope.enforcement !== 'runtime' && scope.enforcement !== 'advisory') {
    throw new Error(
      'AUTHORITY_BINDING_INVALID: authority_scope.enforcement must be advisory|runtime',
    );
  }
  return {
    snapshot_ref: scope.snapshot_ref,
    scope: scope.scope,
    allowed_tools: [...scope.allowed_tools] as string[],
    enforcement: scope.enforcement,
  };
}

export interface WorkIntentClaimRow {
  id: number;
  epic_id: number;
  kind: string;
  objective: string;
  authority_scope: string;
  output_schema: string;
  token_budget: number;
  retry_budget: number;
  projected_task_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export function claimRowToIntent(
  row: WorkIntentClaimRow,
  authorityScope?: AuthorityScope,
): WorkIntent {
  return {
    id: row.id,
    epic_id: row.epic_id,
    kind: row.kind,
    objective: row.objective,
    authority_scope:
      authorityScope ?? strictAuthorityScope(JSON.parse(row.authority_scope)),
    output_schema: row.output_schema,
    token_budget: row.token_budget,
    retry_budget: row.retry_budget,
    projected_task_id: row.projected_task_id,
    status: row.status as WorkIntent['status'],
    created_at: row.created_at,
  };
}

export function readWorkIntentForTaskClaim(
  db: Database.Database,
  task: Task,
): WorkIntent | null {
  let metadata: Record<string, unknown> = {};
  if (task.metadata && typeof task.metadata === 'object') {
    metadata = task.metadata as Record<string, unknown>;
  } else if (typeof task.metadata === 'string') {
    try {
      const parsed = JSON.parse(task.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // The explicit DB lookup below remains authoritative.
    }
  }

  let intentId = Number.isInteger(metadata.work_intent_id)
    ? metadata.work_intent_id as number
    : null;
  if (intentId === null) {
    const projected = db.prepare(
      `SELECT json_extract(metadata, '$.work_intent_id') AS intent_id
         FROM tasks WHERE id=?`,
    ).get(task.id) as { intent_id: number | null } | undefined;
    intentId = projected?.intent_id ?? null;
  }
  if (intentId === null) return null;

  const row = db.prepare(
    'SELECT * FROM factory_work_intents WHERE id=?',
  ).get(intentId) as WorkIntentClaimRow | undefined;
  if (!row) {
    throw new Error(
      `AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} referenced by task ${task.id} does not exist`,
    );
  }
  if (row.epic_id !== task.epic_id) {
    throw new Error(
      `AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} epic ${row.epic_id} != task epic ${task.epic_id}`,
    );
  }
  if (row.projected_task_id !== task.id) {
    throw new Error(
      `AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} projected_task_id ${row.projected_task_id} != task ${task.id}`,
    );
  }
  const claimable = row.status === 'open'
    || row.status === 'executing'
    || (
      row.status === 'paused'
      && (task.status === 'review' || task.status === 'todo')
    );
  if (!claimable) {
    throw new Error(
      `AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} status '${row.status}' is not claimable (task status='${task.status}')`,
    );
  }

  let rawAuthority: unknown;
  try {
    rawAuthority = JSON.parse(row.authority_scope);
  } catch {
    throw new Error(
      `AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} authority_scope is malformed JSON`,
    );
  }
  return claimRowToIntent(row, strictAuthorityScope(rawAuthority));
}

type ClaimedTaskStatus = 'in_progress' | 'review_in_progress';

function claimedStatusFor(
  db: Database.Database,
  task: Task,
): ClaimedTaskStatus {
  if (task.workplace_ref) {
    const workplace = db.prepare(
      `SELECT kanban_phase
         FROM factory_workplaces
        WHERE workplace_ref=?`,
    ).get(task.workplace_ref) as { kanban_phase: string } | undefined;
    if (
      workplace?.kanban_phase === 'review'
      || workplace?.kanban_phase === 'review_in_progress'
    ) {
      return 'review_in_progress';
    }
  }
  return task.status === 'review'
    ? 'review_in_progress'
    : 'in_progress';
}

/**
 * Select, fence and project exactly one Workplace card.
 *
 * Workplace loop state decides eligibility. The returned Task is the
 * post-claim projection, so downstream skill/phase selection can never use a
 * stale pre-claim status.
 */
export function findNextClaimable(
  db: Database.Database,
  workerId: string,
  projectId: number,
  excludeTaskId?: number,
  attempt: number = 0,
  role?: string,
  epicId?: number,
  reservation?: {
    executionId: string;
    runId: string;
    machineId: string;
  },
  taskIds?: number[],
): Task | null {
  if (attempt >= MAX_CLAIM_ATTEMPTS) return null;

  const excludeClause = excludeTaskId !== undefined ? 'AND t.id != ?' : '';
  const roleClause = role
    ? `AND EXISTS (
         SELECT 1 FROM json_each(t.tags)
          WHERE json_each.value = ?
       )`
    : '';
  const epicClause = epicId !== undefined ? 'AND t.epic_id = ?' : '';
  const taskIdsClause = taskIds && taskIds.length > 0
    ? `AND t.id IN (${taskIds.map(() => '?').join(',')})`
    : '';

  const selectSql = `
    SELECT t.*
      FROM tasks t
     WHERE (t.assigned_to IS NULL OR t.assigned_to='')
       AND t.current_execution_id IS NULL
       AND t.epic_id IN (SELECT id FROM epics WHERE project_id=?)
       ${epicClause}
       ${taskIdsClause}
       ${excludeClause}
       ${roleClause}
       AND json_extract(t.metadata, '$.process_run_id') IS NOT NULL
       AND (
         (t.workplace_ref IS NOT NULL
           AND t.status IN ('todo','review')
           AND EXISTS (
             SELECT 1
               FROM factory_workplaces w
              WHERE w.workplace_ref=t.workplace_ref
                AND (
                  w.loop_state IN ('idle','queued')
                  OR (
                    w.loop_state IN ('leased','running','verifying')
                    AND NOT EXISTS (
                      SELECT 1
                        FROM worker_executions we
                       WHERE we.execution_id=w.active_reservation_ref
                         AND we.state IN ('reserved','running','cancel_requested')
                    )
                  )
                )
           ))
         OR
         (t.workplace_ref IS NULL AND t.status IN ('todo','review'))
       )
       AND NOT EXISTS (
         SELECT 1
           FROM worker_executions we
          WHERE we.task_id=t.id
            AND we.state IN ('reserved','running','cancel_requested')
       )
       AND NOT EXISTS (
         SELECT 1 FROM human_requests hr
          WHERE hr.task_id=t.id AND hr.state='open'
       )
       AND NOT EXISTS (
         SELECT 1
           FROM task_dependencies d
           JOIN tasks dep ON dep.id=d.depends_on_task_id
          WHERE d.task_id=t.id
            AND (
              dep.status!='done'
              OR (
                dep.task_kind IS NOT NULL
                AND dep.execution_mode='git_change'
                AND dep.integration_state!='merged'
              )
            )
       )
       AND NOT EXISTS (
         SELECT 1
           FROM tasks other
           JOIN task_conflict_keys k1 ON k1.task_id=t.id
           JOIN task_conflict_keys k2
             ON k2.key_type=k1.key_type AND k2.key_value=k1.key_value
          WHERE other.id=k2.task_id
            AND other.id!=t.id
            AND json_extract(other.metadata, '$.process_run_id')=
                json_extract(t.metadata, '$.process_run_id')
            AND other.execution_mode='git_change'
            AND other.integration_state IN ('pending','conflict')
       )
     ORDER BY
       CASE WHEN t.status='review' THEN 0 ELSE 1 END,
       ${PRIORITY_ORDER},
       t.created_at
     LIMIT 1
  `;

  const params: unknown[] = [projectId];
  if (epicId !== undefined) params.push(epicId);
  if (taskIds && taskIds.length > 0) params.push(...taskIds);
  if (excludeTaskId !== undefined) params.push(excludeTaskId);
  if (role) params.push(`role:${role}`);

  const task = db.prepare(selectSql).get(...params) as Task | undefined;
  if (!task) return null;

  const claimedStatus = claimedStatusFor(db, task);
  const info = db.prepare(
    `UPDATE tasks
        SET status=?, assigned_to=?, current_execution_id=?,
            updated_at=datetime('now')
      WHERE id=?
        AND status IN ('todo','review')
        AND (assigned_to IS NULL OR assigned_to='')
        AND current_execution_id IS NULL`,
  ).run(
    claimedStatus,
    workerId,
    reservation?.executionId ?? null,
    task.id,
  );
  if (info.changes !== 1) {
    return findNextClaimable(
      db,
      workerId,
      projectId,
      excludeTaskId,
      attempt + 1,
      role,
      epicId,
      reservation,
      taskIds,
    );
  }

  const claimedTask = {
    ...task,
    status: claimedStatus,
    assigned_to: workerId,
    current_execution_id: reservation?.executionId ?? null,
  } as Task;

  if (reservation) {
    const modelRoute = readModelRouteAtClaim(db, task.epic_id);
    const workIntent = readWorkIntentForTaskClaim(db, task);
    const executionContext = buildExecutionContext({
      modelRoute,
      workIntent,
      capturedAt: new Date().toISOString(),
    });
    const metadataJson = JSON.stringify({
      execution_context: executionContext,
      execution_context_hash: executionContextHash(executionContext),
    });
    db.prepare(
      `INSERT INTO worker_executions
        (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,
         phase,metadata,lease_expires_at,heartbeat_at,progress_at,stuck_state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      reservation.executionId,
      reservation.runId,
      projectId,
      task.epic_id,
      task.id,
      workerId,
      reservation.machineId,
      claimedStatus === 'review_in_progress' ? 'reviewing' : 'executing',
      metadataJson,
      new Date(Date.now() + WORKER_LEASE_TTL_MS).toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      'active',
    );
  }

  logActivity(
    db,
    'task',
    task.id,
    'status_changed',
    'status',
    task.status,
    claimedStatus,
    `Task '${task.title}' claimed by ${workerId} (${task.status} → ${claimedStatus})`,
  );
  return claimedTask;
}

/** Requeue the same stable Workplace card for a semantic repair worker. */
export function transitionTaskToInRepair(
  db: Database.Database,
  taskId: number,
): boolean {
  const changed = db.prepare(
    `UPDATE tasks
        SET status='todo', assigned_to=NULL, current_execution_id=NULL,
            integration_state=CASE
              WHEN execution_mode='git_change' THEN 'not_required'
              ELSE integration_state
            END,
            integrated_at=NULL, integrated_commit=NULL,
            updated_at=datetime('now')
      WHERE id=? AND status='done' AND current_execution_id IS NULL`,
  ).run(taskId);
  return changed.changes === 1;
}

/**
 * Reverse-project an accepted kernel gate onto the human board.
 *
 * The function is idempotent. It accepts every non-terminal working projection
 * plus an already-done replay; impossible historical statuses are deliberately
 * absent. For code-changing work, `done + pending` means quality accepted and
 * waiting for deterministic integration. Dependencies open only after the
 * integration state becomes `merged`.
 */
export function promoteTaskToDone(
  db: Database.Database,
  taskId: number,
): void {
  const task = db.prepare(
    `SELECT task_kind, execution_mode, current_execution_id
       FROM tasks WHERE id=?`,
  ).get(taskId) as {
    task_kind: string | null;
    execution_mode: string;
    current_execution_id: string | null;
  } | undefined;
  if (!task || task.current_execution_id !== null) return;

  if (task.task_kind && task.execution_mode === 'git_change') {
    db.prepare(
      `UPDATE tasks
          SET status='done', assigned_to=NULL, current_execution_id=NULL,
              integration_state=CASE
                WHEN integration_state='merged' THEN 'merged'
                ELSE 'pending'
              END,
              integrated_at=CASE
                WHEN integration_state='merged' THEN integrated_at
                ELSE NULL
              END,
              integrated_commit=CASE
                WHEN integration_state='merged' THEN integrated_commit
                ELSE NULL
              END,
              updated_at=datetime('now')
        WHERE id=?
          AND current_execution_id IS NULL
          AND status IN ('todo','in_progress','review','review_in_progress','done')`,
    ).run(taskId);
    return;
  }

  db.prepare(
    `UPDATE tasks
        SET status='done', assigned_to=NULL, current_execution_id=NULL,
            integration_state='not_required', updated_at=datetime('now')
      WHERE id=?
        AND current_execution_id IS NULL
        AND status IN ('todo','in_progress','review','review_in_progress','done')`,
  ).run(taskId);
}

/** Build the immutable AssignedWork snapshot after the claim transaction. */
export interface ProjectedTaskPreparationCommand {
  taskId: number;
  currentStatus: string;
  assignedTo: string | null;
  currentExecutionId: string | null;
}

/** Atomically publish the one claimable task card for a Production Cell role. */
export function activateProductionCellRoleTask(
  db: Database.Database,
  input: {
    taskId: number;
    intentId: number;
    workplaceRef: string;
    role: 'author' | 'reviewer';
    executionProfileId: string;
  },
): void {
  withImmediateTransaction(db, () => {
    const row = db.prepare('SELECT metadata FROM tasks WHERE id=?').get(input.taskId) as
      | { metadata: string }
      | undefined;
    if (!row) throw new Error(`PROJECTED_TASK_NOT_FOUND: ${input.taskId}`);
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; }
    catch { throw new Error(`PROJECTED_TASK_METADATA_INVALID: ${input.taskId}`); }
    metadata.work_intent_id = input.intentId;
    metadata.process_execution_profile_id = input.executionProfileId;
    metadata.workplace_ref = input.workplaceRef;
    metadata.role = input.role;
    db.prepare(
      `UPDATE tasks SET status='done',assigned_to=NULL,current_execution_id=NULL,
              updated_at=datetime('now') WHERE workplace_ref=? AND id<>?`,
    ).run(input.workplaceRef, input.taskId);
    db.prepare(
      `UPDATE tasks SET workplace_ref=?,status=?,assigned_to=NULL,
              current_execution_id=NULL,metadata=?,updated_at=datetime('now') WHERE id=?`,
    ).run(
      input.workplaceRef,
      input.role === 'reviewer' ? 'review' : 'todo',
      JSON.stringify(metadata),
      input.taskId,
    );
  });
}

/** Mark every disposable card projection of a terminal Workplace complete. */
export function completeProductionCellTaskProjections(
  db: Database.Database,
  workplaceRef: string,
): void {
  db.prepare(
    `UPDATE tasks SET status='done',assigned_to=NULL,current_execution_id=NULL,
            updated_at=datetime('now') WHERE workplace_ref=?`,
  ).run(workplaceRef);
}

/** Prepare a projected task for a new fenced execution. */
export function prepareFactoryProjectedTaskForExecution(
  db: Database.Database,
  command: ProjectedTaskPreparationCommand,
): string {
  const restoredStatus = command.currentStatus === 'review_in_progress'
    ? 'review'
    : command.currentStatus === 'in_progress'
      ? 'todo'
      : command.currentStatus;
  if (command.assignedTo || command.currentExecutionId || restoredStatus !== command.currentStatus) {
    db.prepare(
      `UPDATE tasks SET status=?, assigned_to=NULL, current_execution_id=NULL,
                        updated_at=datetime('now') WHERE id=?`,
    ).run(restoredStatus, command.taskId);
  }
  return restoredStatus;
}

export function buildAssignedWorkFromClaim(args: {
  db: Database.Database;
  task: Task;
  projectId: number;
  workerExecutionId: string;
  runId: string;
  workerId: string;
  machineId: string | null;
}): AssignedWork {
  const {
    db,
    task,
    projectId,
    workerExecutionId,
    runId,
    workerId,
    machineId,
  } = args;
  const repository = task.project_repository_id === null
    ? null
    : db.prepare(`
        SELECT pr.id, pr.repository_id, r.name,
               COALESCE(rc.local_path,pr.local_path) AS local_path,
               pr.role, pr.integration_branch, r.default_branch
          FROM project_repositories pr
          JOIN repositories r ON r.id=pr.repository_id
          LEFT JOIN repository_checkouts rc
            ON rc.project_repository_id=pr.id
           AND rc.machine_id=? AND rc.status='active'
         WHERE pr.id=? AND pr.project_id=?
      `).get(
        machineId ?? null,
        task.project_repository_id,
        projectId,
      ) as {
        id: number;
        repository_id: number;
        name: string;
        local_path: string | null;
        role: string;
        integration_branch: string;
        default_branch: string;
      } | undefined;

  if (task.project_repository_id !== null && !repository) {
    throw new Error(
      `Task ${task.id} targets missing or foreign project_repository_id=${task.project_repository_id}`,
    );
  }

  let executionContext: unknown = undefined;
  const execution = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get(workerExecutionId) as { metadata: string } | undefined;
  if (execution?.metadata) {
    try {
      executionContext = (JSON.parse(execution.metadata) as {
        execution_context?: unknown;
      }).execution_context;
    } catch {
      executionContext = undefined;
    }
  }

  const status = task.status === 'review'
    || task.status === 'review_in_progress'
    ? 'review_in_progress'
    : 'in_progress';
  return {
    taskId: asCardId(task.id),
    epicId: task.epic_id,
    projectId,
    status,
    skill: skillForTask(task, status),
    workerExecutionId: asExecutionId(workerExecutionId),
    fenceToken: asFenceToken(workerExecutionId),
    runId,
    workerId,
    machineId: machineId ?? 'unknown',
    repository: repository ?? null,
    executionContext,
  };
}
