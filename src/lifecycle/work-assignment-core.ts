/**
 * Work-assignment core — the atomic card-selection + fence-creation logic.
 *
 * CONVEYOR-MENTAL-MODEL §"Adapter rules": "SQLite adapters implement
 * repositories and atomic assignment transactions." This module IS that atomic
 * assignment transaction, kept infrastructure-side (lifecycle/), away from the
 * MCP/tool layer. Two adapters consume it as equals:
 *   - SqliteWorkAssignmentAdapter (the WorkAssignmentPort for the dispatch loop)
 *   - handleWorkerNext (the worker_next MCP handler, legacy/MCP-direct path)
 *
 * Both MUST execute the identical SELECT + conditional UPDATE + INSERT inside
 * one IMMEDIATE transaction. Keeping the logic here (not in tools/dispatcher.ts)
 * means the outbound adapter no longer depends on the MCP/tool layer — the
 * dependency direction stays inward.
 */

import type Database from 'better-sqlite3';
import type { Task } from '../types.js';
import type { AssignedWork } from '../application/ports/worker-executor.js';
import type { AuthorityScope, WorkIntent } from '../saga3/domain/work-intent.js';
import { buildExecutionContext } from '../saga3/authority/build-execution-context.js';
import { executionContextHash } from '../saga3/domain/execution-context.js';

export const PRIORITY_ORDER = "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END";

// Верхняя граница попыток claim в findNextClaimable. Под IMMEDIATE-локом retry
// срабатывает крайне редко (мы держим эксклюзивный lock), но лимит страховает
// от livelock и от удержания глобального write-lock'а сколь угодно долго.
export const MAX_CLAIM_ATTEMPTS = 10;

// CONVEYOR Wave 5: worker lease TTL. The supervisor renews lease_expires_at
// while the execution is alive; once it passes (and the supervisor has not
// renewed it) the execution loses authority to mutate. Long enough that a
// legitimate long inference does not expire mid-run; short enough that a dead
// worker is recovered promptly. See CONVEYOR-MENTAL-MODEL §"Safe automatic
// recovery" and WorkerSupervisionPort.renewLease.
export const WORKER_LEASE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// better-sqlite3 db.transaction(fn) всегда DEFERRED и не принимает mode (типы
// @types/better-sqlite3 в форке: transaction<F>(fn: F): Transaction<F>). Нам же
// нужен BEGIN IMMEDIATE — write-lock всей БД с старта транзакции (аналог
// SELECT FOR UPDATE, которого нет в SQLite), чтобы сериализовать писателей.
// Поэтому оборачиваем логику в явные BEGIN IMMEDIATE / COMMIT / ROLLBACK.
// Exported so other handlers (e.g. task_update RMW sequence) can wrap their
// own read-modify-write critical sections in the same atomic boundary.
export function withImmediateTransaction<T>(db: Database.Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore — tx could not be active */
    }
    throw err;
  }
}

export type WorkerSkill = string;

/** Central workflow routing with a strict legacy fallback. */
export function skillForTask(task: Task, sourceStatus: string): WorkerSkill {
  const review = sourceStatus === 'review' || sourceStatus === 'review_in_progress';
  if (review && task.review_skill) return task.review_skill;
  if (!review && task.execution_skill) return task.execution_skill;

  let tags: string[] = [];
  try {
    const parsed = JSON.parse(task.tags || '[]');
    if (Array.isArray(parsed)) tags = parsed.filter((value): value is string => typeof value === 'string');
  } catch { /* malformed legacy tags: use status fallback */ }
  const explicit = tags.find(tag => tag.startsWith(review ? 'review-skill:' : 'skill:'));
  if (explicit) return explicit.slice(explicit.indexOf(':') + 1);
  if (!review) {
    const role = tags.find(tag => tag.startsWith('role:'))?.slice('role:'.length);
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
  ).get(epicId) as { m: string | null; p: string | null; e: string | null } | undefined;
  return { model: row?.m ?? null, provider: row?.p ?? 'zai', effort: row?.e ?? null };
}

export function strictAuthorityScope(raw: unknown): AuthorityScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('AUTHORITY_BINDING_INVALID: authority_scope must be an object');
  }
  const scope = raw as Record<string, unknown>;
  if (typeof scope.snapshot_ref !== 'string' || scope.snapshot_ref.trim() === '') {
    throw new Error('AUTHORITY_BINDING_INVALID: authority_scope.snapshot_ref is required');
  }
  if (typeof scope.scope !== 'string' || scope.scope.trim() === '') {
    throw new Error('AUTHORITY_BINDING_INVALID: authority_scope.scope is required');
  }
  if (!Array.isArray(scope.allowed_tools)
      || !scope.allowed_tools.every(x => typeof x === 'string' && x.trim() !== '')
      || new Set(scope.allowed_tools).size !== scope.allowed_tools.length) {
    throw new Error('AUTHORITY_BINDING_INVALID: authority_scope.allowed_tools must be a unique string array');
  }
  if (scope.enforcement !== 'runtime' && scope.enforcement !== 'advisory') {
    throw new Error('AUTHORITY_BINDING_INVALID: authority_scope.enforcement must be advisory|runtime');
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

export function claimRowToIntent(row: WorkIntentClaimRow, authorityScope?: AuthorityScope): WorkIntent {
  return {
    id: row.id,
    epic_id: row.epic_id,
    kind: row.kind,
    objective: row.objective,
    authority_scope: authorityScope ?? strictAuthorityScope(JSON.parse(row.authority_scope)),
    output_schema: row.output_schema,
    token_budget: row.token_budget,
    retry_budget: row.retry_budget,
    projected_task_id: row.projected_task_id,
    status: row.status as WorkIntent['status'],
    created_at: row.created_at,
  };
}

/**
 * Read the WorkIntent bound to a task for the authority snapshot, or null for a
 * legacy Saga 2 task (no work_intent_id).
 */
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
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch {
      // fall through — intentId lookup below will detect a missing binding.
    }
  }
  let intentId = Number.isInteger(metadata.work_intent_id) ? metadata.work_intent_id as number : null;
  if (intentId == null) {
    const row = db.prepare(
      `SELECT json_extract(metadata, '$.work_intent_id') AS intent_id FROM tasks WHERE id=?`,
    ).get(task.id) as { intent_id: number | null } | undefined;
    intentId = row?.intent_id ?? null;
  }
  if (intentId == null) {
    return null;
  }
  const row = db.prepare('SELECT * FROM saga3_work_intents WHERE id=?').get(intentId) as WorkIntentClaimRow | undefined;
  if (!row) throw new Error(`AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} referenced by task ${task.id} does not exist`);
  if (row.epic_id !== task.epic_id) {
    throw new Error(`AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} epic ${row.epic_id} != task epic ${task.epic_id}`);
  }
  if (row.projected_task_id !== task.id) {
    throw new Error(`AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} projected_task_id ${row.projected_task_id} != task ${task.id}`);
  }
  if (row.status !== 'open' && row.status !== 'executing') {
    throw new Error(`AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} status '${row.status}' is not claimable`);
  }
  let rawAuthority: unknown;
  try { rawAuthority = JSON.parse(row.authority_scope); }
  catch { throw new Error(`AUTHORITY_BINDING_INVALID: WorkIntent ${intentId} authority_scope is malformed JSON`); }
  const authority = strictAuthorityScope(rawAuthority);
  return claimRowToIntent(row, authority);
}

import { logActivity } from '../helpers/activity-logger.js';

/**
 * Atomic claim core — the single source of truth for card assignment. See
 * module header. Returns the claimed Task (status flipped + fence set), or
 * null when no card is claimable. Runs inside a caller-supplied IMMEDIATE
 * transaction.
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
  const roleClause = role ? `AND EXISTS (SELECT 1 FROM json_each(t.tags) WHERE json_each.value = ?)` : '';
  const epicClause = epicId !== undefined ? 'AND t.epic_id = ?' : '';
  const taskIdsClause = taskIds && taskIds.length > 0
    ? `AND t.id IN (${taskIds.map(() => '?').join(',')})`
    : '';
  const selectSql = `
    SELECT t.* FROM tasks t
    WHERE t.status IN ('todo', 'review')
      AND (t.assigned_to IS NULL OR t.assigned_to = '')
      AND t.epic_id IN (SELECT id FROM epics WHERE project_id = ?)
      ${epicClause}
      ${taskIdsClause}
      AND (json_extract(t.metadata, '$.process_run_id') IS NOT NULL)
      ${excludeClause}
      ${roleClause}
      AND t.current_execution_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM worker_executions we
        WHERE we.task_id=t.id AND we.state IN ('reserved','running','cancel_requested')
      )
      AND NOT EXISTS (
        SELECT 1 FROM human_requests hr
        WHERE hr.task_id = t.id AND hr.state = 'open'
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies d
        JOIN tasks dep ON dep.id = d.depends_on_task_id
        WHERE d.task_id = t.id AND (
          dep.status != 'done'
          OR (dep.task_kind IS NOT NULL AND dep.execution_mode = 'git_change' AND dep.integration_state != 'merged')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM tasks other
        JOIN task_conflict_keys k1 ON k1.task_id = t.id
        JOIN task_conflict_keys k2 ON k2.key_type = k1.key_type AND k2.key_value = k1.key_value
        WHERE other.id = k2.task_id
          AND other.id != t.id
          AND json_extract(other.metadata, '$.process_run_id') = json_extract(t.metadata, '$.process_run_id')
          AND other.execution_mode = 'git_change'
          AND other.integration_state IN ('pending', 'conflict')
      )
    ORDER BY
      CASE WHEN t.status = 'review' THEN 0 ELSE 1 END,
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

  let info: Database.RunResult;
  if (task.status === 'todo') {
    info = db.prepare(
      `UPDATE tasks SET status='in_progress', assigned_to=?, current_execution_id=?, updated_at=datetime('now')
       WHERE id=? AND status='todo' AND (assigned_to IS NULL OR assigned_to = '')`,
    ).run(workerId, reservation?.executionId ?? null, task.id);
  } else {
    info = db.prepare(
      `UPDATE tasks SET status='review_in_progress', assigned_to=?, current_execution_id=?, updated_at=datetime('now')
       WHERE id=? AND status='review' AND (assigned_to IS NULL OR assigned_to = '')`,
    ).run(workerId, reservation?.executionId ?? null, task.id);
  }
  if (info.changes !== 1) {
    return findNextClaimable(db, workerId, projectId, excludeTaskId, attempt + 1, role, epicId, reservation, taskIds);
  }

  if (reservation) {
    const modelRoute = readModelRouteAtClaim(db, task.epic_id);
    const workIntent = readWorkIntentForTaskClaim(db, task);
    const executionContext = buildExecutionContext({ modelRoute, workIntent, capturedAt: new Date().toISOString() });
    const metadataJson = JSON.stringify({
      execution_context: executionContext,
      execution_context_hash: executionContextHash(executionContext),
    });
    db.prepare(
      `INSERT INTO worker_executions
        (execution_id,run_id,project_id,epic_id,task_id,worker_id,machine_id,phase,metadata,
         lease_expires_at, heartbeat_at, progress_at, stuck_state)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      reservation.executionId, reservation.runId, projectId, task.epic_id, task.id, workerId, reservation.machineId,
      task.status === 'review' ? 'reviewing' : 'executing', metadataJson,
      new Date(Date.now() + WORKER_LEASE_TTL_MS).toISOString(), new Date().toISOString(), new Date().toISOString(), 'active',
    );
  }

  const newClaimedStatus = task.status === 'todo' ? 'in_progress' : 'review_in_progress';
  logActivity(db, 'task', task.id, 'status_changed', 'status', task.status, newClaimedStatus,
    `Task '${task.title}' claimed by ${workerId} (from ${task.status} to ${newClaimedStatus})`);
  return task;
}

/**
 * Build an AssignedWork snapshot from a freshly-claimed task. Shared by the
 * worker_next MCP path and the WorkAssignmentPort. Called AFTER the IMMEDIATE
 * transaction commits.
 */
export function buildAssignedWorkFromClaim(args: {
  db: Database.Database;
  task: Task;
  projectId: number;
  workerExecutionId: string;
  runId: string;
  workerId: string;
  machineId: string | null;
}): AssignedWork {
  const { db, task, projectId, workerExecutionId, runId, workerId, machineId } = args;
  const repository = task.project_repository_id == null ? null : db.prepare(`
    SELECT pr.id, pr.repository_id, r.name,
           COALESCE(rc.local_path,pr.local_path) AS local_path, pr.role,
           pr.integration_branch, r.default_branch
      FROM project_repositories pr
      JOIN repositories r ON r.id=pr.repository_id
      LEFT JOIN repository_checkouts rc
        ON rc.project_repository_id=pr.id AND rc.machine_id=? AND rc.status='active'
     WHERE pr.id=? AND pr.project_id=?
  `).get(machineId ?? null, task.project_repository_id, projectId) as {
    id: number; repository_id: number; name: string; local_path: string | null;
    role: string; integration_branch: string; default_branch: string;
  } | undefined;
  if (task.project_repository_id != null && !repository) {
    throw new Error(`Task ${task.id} targets missing or foreign project_repository_id=${task.project_repository_id}`);
  }
  let executionContext: unknown = undefined;
  const execRow = db.prepare('SELECT metadata FROM worker_executions WHERE execution_id=?')
    .get(workerExecutionId) as { metadata: string } | undefined;
  if (execRow?.metadata) {
    try { executionContext = (JSON.parse(execRow.metadata) as { execution_context?: unknown }).execution_context; }
    catch { executionContext = undefined; }
  }
  return {
    taskId: task.id, epicId: task.epic_id, projectId,
    status: task.status === 'review' ? 'review_in_progress' : 'in_progress',
    skill: skillForTask(task, task.status),
    workerExecutionId, fenceToken: workerExecutionId, runId, workerId,
    machineId: machineId ?? 'unknown', repository: repository ?? null, executionContext,
  };
}
