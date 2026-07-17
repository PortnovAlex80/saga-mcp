import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import { getDb } from '../db.js';
import { buildUpdate, addTagFilter } from '../helpers/sql-builder.js';
import { logActivity, logEntityUpdate } from '../helpers/activity-logger.js';
import { resolveBranch } from '../helpers/git.js';
import { withImmediateTransaction } from './dispatcher.js';
import type { ToolHandler } from '../types.js';

// REQ-009 / CGAD §11 — RiskClass computation.
// final_risk = max(declared_risk, derived_risk, policy_minimum) by severity
// order low < medium < high < critical. CGAD P15: the agent (Builder) may
// propose declared_risk but cannot self-lower final_risk below derived_risk
// or policy_minimum. Raising is automatic; lowering high/critical requires a
// human gate (not enforced here — enforced at task_update when final_risk is
// explicitly written below the computed max).
const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const RISK_BY_RANK = ['low', 'medium', 'high', 'critical'] as const;

/**
 * Map a risk level (or null/undefined) to its severity rank. null/undefined
 * return -1, so "unset" is treated as below 'low' — this is what makes the
 * P15 monotonicity check raise-on-lower work for tasks whose old value was
 * null (e.g. a plain task being constrained to derived_risk='low' from null
 * is NOT a lowering, but 'high' -> 'low' is).
 */
function riskRank(v: string | null | undefined): number {
  if (v == null) return -1;
  const r = RISK_ORDER[v];
  return typeof r === 'number' ? r : -1;
}

/**
 * Compute final_risk = max(declared, derived, policy_minimum).
 * Null inputs are skipped (treated as not-contributing). Returns null only
 * when all three inputs are null.
 *
 * Deterministic. Pure. Tested.
 */
export function computeFinalRisk(
  declared: string | null | undefined,
  derived: string | null | undefined,
  policyMinimum: string | null | undefined,
): 'low' | 'medium' | 'high' | 'critical' | null {
  const candidates = [declared, derived, policyMinimum]
    .filter((v): v is string => v != null && v in RISK_ORDER);
  if (candidates.length === 0) return null;
  const maxRank = Math.max(...candidates.map(v => RISK_ORDER[v]));
  return RISK_BY_RANK[maxRank];
}

/**
 * CGAD P15 monotonicity guard. The agent (Builder) cannot self-lower
 * `derived_risk` or `policy_minimum` — these are floor-raised by the system
 * (security/data signals, project policy). `declared_risk` is the Builder's
 * own proposal and MAY be lowered freely; `final_risk = max(declared, derived,
 * policy)` is recomputed, so lowering declared alone can never drop final
 * below the derived/policy floor.
 *
 * Throws if the new effective value is strictly below the old persisted value
 * by severity rank (low < medium < high < critical, null = -1). Call BEFORE the
 * risk UPDATE so the throw + transaction ROLLBACK leaves the row untouched.
 */
function enforceP15Monotonicity(
  oldRow: { derived_risk: string | null; policy_minimum: string | null },
  newDerived: string | null,
  newPolicy: string | null,
): void {
  const oldDerivedRank = riskRank(oldRow.derived_risk);
  const newDerivedRank = riskRank(newDerived);
  if (newDerivedRank < oldDerivedRank) {
    throw new Error(
      `CGAD P15 violation: cannot lower derived_risk from '${oldRow.derived_risk}' to '${newDerived}'`,
    );
  }
  const oldPolicyRank = riskRank(oldRow.policy_minimum);
  const newPolicyRank = riskRank(newPolicy);
  if (newPolicyRank < oldPolicyRank) {
    throw new Error(
      `CGAD P15 violation: cannot lower policy_minimum from '${oldRow.policy_minimum}' to '${newPolicy}'`,
    );
  }
}

/**
 * Derive `derived_risk` from the task's touched surface, per CGAD §11 policy:
 *   - tag includes 'security' → critical
 *   - tag includes 'critical' → critical
 *   - tag includes 'data' or 'migration' → high
 *   - public API / contract touched (task_kind includes 'formalization') → high
 *   - otherwise → low (default; no signal)
 *
 * This is a heuristic. The caller MAY override derived_risk explicitly via
 * task_create / task_update; the explicit value wins.
 */
function deriveRiskFromTags(tags: string[], taskKind: string | null): 'low' | 'medium' | 'high' | 'critical' | null {
  const tagsStr = tags.join(' ').toLowerCase();
  if (/\bsecurity\b/.test(tagsStr) || /\bcritical\b/.test(tagsStr)) return 'critical';
  if (/\bdata\b/.test(tagsStr) || /\bmigration\b/.test(tagsStr)) return 'high';
  if (taskKind && /formalization|architecture/.test(taskKind)) return 'high';
  return null; // no signal
}

/**
 * Policy minimum derived from tags + project conventions. Today's policy:
 *   - 'security' or 'critical' tagged → policy_minimum='high'
 *   - public API / contract work → policy_minimum='medium'
 *   - otherwise → null (no policy floor)
 *
 * Future REQ-012 will make policy explicit (per-project config), not inferred.
 */
function derivePolicyMinimum(tags: string[], taskKind: string | null): 'low' | 'medium' | 'high' | 'critical' | null {
  const tagsStr = tags.join(' ').toLowerCase();
  if (/\bsecurity\b/.test(tagsStr) || /\bcritical\b/.test(tagsStr)) return 'high';
  if (taskKind && /formalization|architecture/.test(taskKind)) return 'medium';
  return null;
}


export const definitions: Tool[] = [
  {
    name: 'task_create',
    description: 'Create a task within an epic. Tasks are the primary unit of work.',
    annotations: { title: 'Create Task', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer', description: 'Parent epic ID' },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task description' },
        status: {
          type: 'string',
          enum: ['todo', 'in_progress', 'review', 'review_in_progress', 'done', 'blocked'],
          default: 'todo',
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          default: 'medium',
        },
        declared_risk: {
          // Enum intentionally omits null: user input MUST pick a level.
          // NOTE: the persisted column (and the Task interface in src/types.ts)
          // allows null, because runtime auto-derivation may yield no level
          // (e.g. a plain task with no security/contract surface). The schema's
          // non-null enum constrains what callers may SEND, not what the row
          // may STORE.
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'REQ-009 / CGAD §11 — risk proposed by the change author (Builder). Defaults to legacy `priority` if omitted. The agent cannot lower final_risk below derived_risk or policy_minimum (CGAD P15).',
        },
        derived_risk: {
          // See declared_risk: enum constrains user input; the stored value may
          // be null when auto-derivation (deriveRiskFromTags) returns null.
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'REQ-009 — risk computed from the touched surface (security/data/migration/API). If omitted, auto-derived from tags + task_kind.',
        },
        policy_minimum: {
          // See declared_risk: enum constrains user input; the stored value may
          // be null when auto-derivation returns null.
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'REQ-009 — minimum risk set by project policy. security/critical tagged tasks have policy_minimum=high. If omitted, auto-derived.',
        },
        assigned_to: { type: 'string', description: 'Assignee name' },
        estimated_hours: { type: 'number', description: 'Estimated hours' },
        due_date: { type: 'string', description: 'Due date (YYYY-MM-DD)' },
        source_ref: {
          type: 'object',
          description: 'Link to source code location',
          properties: {
            file: { type: 'string', description: 'File path' },
            line_start: { type: 'integer', description: 'Start line number' },
            line_end: { type: 'integer', description: 'End line number' },
            repo: { type: 'string', description: 'Repository URL or name' },
            commit: { type: 'string', description: 'Commit hash' },
          },
          required: ['file'],
        },
        depends_on: { type: 'array', items: { type: 'integer' }, description: 'Task IDs this task depends on' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' },
        task_kind: { type: 'string', description: 'Semantic work type, e.g. formalization.ac or development.code' },
        workflow_stage: { type: 'string', description: 'Episode stage that owns this task' },
        execution_skill: { type: 'string', description: 'Skill used while the task is todo/in_progress' },
        review_skill: { type: 'string', description: 'Skill used while the task is in review' },
        execution_mode: { type: 'string', enum: ['git_change', 'tracker_only', 'read_only_evidence', 'interactive'], default: 'git_change' },
        project_repository_id: { type: 'integer', description: 'Physical repository binding targeted by this task' },
        generated_from_task_id: { type: 'integer', description: 'Immediate upstream task that generated this task' },
        source_artifact_ids: { type: 'array', items: { type: 'integer' }, description: 'Accepted upstream artifacts proving provenance for typed downstream work' },
        generation_key: { type: 'string', description: 'Stable idempotency key unique within the epic' },
      },
      required: ['epic_id', 'title'],
    },
  },
  {
    name: 'task_list',
    description:
      'List tasks with optional filters. If no epic_id given, lists across ALL epics. Includes subtask counts and dependency info. Pass branch="current" to restrict to tasks whose epic is scoped to the active git branch.',
    annotations: { title: 'List Tasks', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        epic_id: { type: 'integer', description: 'Filter by epic (omit for all tasks)' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'review_in_progress', 'done', 'blocked'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assigned_to: { type: 'string', description: 'Filter by assignee' },
        tag: { type: 'string', description: 'Filter by tag' },
        task_kind: { type: 'string', description: 'Filter by semantic task kind' },
        workflow_stage: { type: 'string', description: 'Filter by workflow stage' },
        project_repository_id: { type: 'integer', description: 'Filter by product repository binding' },
        branch: {
          type: 'string',
          description: 'Filter by the git branch of the task\'s epic. Pass "current" to auto-detect; pass empty string to restrict to branch-agnostic epics. Omit to list all.',
        },
        sort_by: {
          type: 'string',
          enum: ['priority', 'created', 'due_date', 'status'],
          default: 'priority',
          description: 'Sort order: priority (critical first), created (newest first), due_date (earliest first), status (actionable first)',
        },
        limit: { type: 'integer', default: 50, description: 'Max results' },
      },
    },
  },
  {
    name: 'task_get',
    description: 'Get a single task with full details including all subtasks, related notes, comments, and dependencies.',
    annotations: { title: 'Get Task', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Task ID' },
      },
      required: ['id'],
    },
  },
  {
    name: 'task_update',
    description:
      'Update a task. Pass only fields to change. Status transitions are automatically logged in the activity log.',
    annotations: { title: 'Update Task', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Task ID' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'review_in_progress', 'done', 'blocked'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        // NOTE: the enums below omit null on purpose — they constrain what
        // callers may SEND. The persisted columns (and the Task interface in
        // src/types.ts) are nullable, because runtime auto-derivation
        // (deriveRiskFromTags) may yield no level and persist null. See the
        // matching note on task_create's declared_risk field.
        declared_risk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'REQ-009 — see task_create. final_risk is recomputed on update; cannot be self-lowered (P15).' },
        derived_risk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        policy_minimum: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
        assigned_to: { type: 'string' },
        estimated_hours: { type: 'number' },
        actual_hours: { type: 'number' },
        due_date: { type: 'string' },
        source_ref: {
          type: 'object',
          description: 'Link to source code location',
          properties: {
            file: { type: 'string', description: 'File path' },
            line_start: { type: 'integer', description: 'Start line number' },
            line_end: { type: 'integer', description: 'End line number' },
            repo: { type: 'string', description: 'Repository URL or name' },
            commit: { type: 'string', description: 'Commit hash' },
          },
          required: ['file'],
        },
        depends_on: { type: 'array', items: { type: 'integer' }, description: 'Task IDs this task depends on (replaces existing)' },
        sort_order: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' },
        task_kind: { type: 'string' },
        workflow_stage: { type: 'string' },
        execution_skill: { type: 'string' },
        review_skill: { type: 'string' },
        execution_mode: { type: 'string', enum: ['git_change', 'tracker_only', 'read_only_evidence', 'interactive'] },
        project_repository_id: { type: ['integer', 'null'] },
        generated_from_task_id: { type: ['integer', 'null'] },
        generation_key: { type: ['string', 'null'] },
      },
      required: ['id'],
    },
  },
];

// --- Dependency helpers ---

function setDependencies(db: Database.Database, taskId: number, dependsOn: number[]): void {
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
  const insert = db.prepare('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)');
  for (const depId of dependsOn) {
    if (depId === taskId) continue; // prevent self-dependency
    insert.run(taskId, depId);
  }
}

function getUnmetDependencies(db: Database.Database, taskId: number): Array<{ id: number; title: string; status: string }> {
  return db.prepare(
    `SELECT t.id, t.title, t.status FROM task_dependencies d
     JOIN tasks t ON t.id = d.depends_on_task_id
     WHERE d.task_id = ? AND (
       t.status != 'done'
       OR (
         t.task_kind IS NOT NULL
         AND t.execution_mode = 'git_change'
         AND t.integration_state != 'merged'
       )
     )`
  ).all(taskId) as Array<{ id: number; title: string; status: string }>;
}

function evaluateAndUpdateDependencies(db: Database.Database, taskId: number): void {
  const task = db.prepare('SELECT id, status, title FROM tasks WHERE id = ?').get(taskId) as { id: number; status: string; title: string } | undefined;
  if (!task) return;

  const deps = db.prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?').all(taskId) as Array<{ depends_on_task_id: number }>;
  if (deps.length === 0) return;

  const unmet = getUnmetDependencies(db, taskId);

  if (unmet.length > 0 && task.status !== 'blocked' && task.status !== 'done') {
    // Инвариант: blocked ⇒ assigned_to=NULL (см. handleTaskUpdate). Авто-blocked от deps —
    // не исключение: задача не может быть в работе, пока её зависимости не готовы.
    db.prepare("UPDATE tasks SET status = 'blocked', assigned_to = NULL, updated_at = datetime('now') WHERE id = ?").run(taskId);
    logActivity(db, 'task', taskId, 'status_changed', 'status', task.status, 'blocked',
      `Task '${task.title}' auto-blocked: depends on ${unmet.map(u => `#${u.id}`).join(', ')}`);
  } else if (unmet.length === 0 && task.status === 'blocked') {
    // Инвариант: todo ⇒ assigned_to=NULL. Авто-разблокировка возвращает задачу в очередь
    // свободной (кто-то из воркеров её потом заберёт).
    db.prepare("UPDATE tasks SET status = 'todo', assigned_to = NULL, updated_at = datetime('now') WHERE id = ?").run(taskId);
    logActivity(db, 'task', taskId, 'status_changed', 'status', 'blocked', 'todo',
      `Task '${task.title}' auto-unblocked: all dependencies met`);
  }
}

export function reevaluateDownstream(db: Database.Database, completedTaskId: number): void {
  const downstream = db.prepare(
    'SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ?'
  ).all(completedTaskId) as Array<{ task_id: number }>;

  for (const row of downstream) {
    evaluateAndUpdateDependencies(db, row.task_id);
  }
}

// --- Handlers ---

function handleTaskCreate(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number;
  const title = args.title as string;
  const description = (args.description as string) ?? null;
  const status = (args.status as string) ?? 'todo';
  const priority = (args.priority as string) ?? 'medium';
  // Инвариант (см. handleTaskUpdate): todo/done/blocked ⇒ assigned_to всегда NULL.
  // При создании задача либо сразу в работе (in_progress/review + assigned), либо
  // свободна в очереди/завершена/заблокирована — без исполнителя.
  let assignedTo: string | null = (args.assigned_to as string) ?? null;
  if (assignedTo === '') assignedTo = null; // нормализация '' → NULL
  if (status === 'todo' || status === 'review' || status === 'done' || status === 'blocked') {
    assignedTo = null;
  }
  const estimatedHours = (args.estimated_hours as number) ?? null;
  const dueDate = (args.due_date as string) ?? null;
  const sourceRef = args.source_ref ? JSON.stringify(args.source_ref) : null;
  const tags = JSON.stringify((args.tags as string[]) ?? []);
  const metadata = JSON.stringify((args.metadata as Record<string, unknown>) ?? {});
  const dependsOn = (args.depends_on as number[]) ?? [];
  const taskKind = (args.task_kind as string | undefined) ?? null;
  const workflowStage = (args.workflow_stage as string | undefined) ?? null;
  const executionSkill = (args.execution_skill as string | undefined) ?? null;
  const reviewSkill = (args.review_skill as string | undefined) ?? null;
  const executionMode = (args.execution_mode as string | undefined) ?? 'git_change';
  const projectRepositoryId = (args.project_repository_id as number | undefined) ?? null;
  const generatedFromTaskId = (args.generated_from_task_id as number | undefined) ?? null;
  const generationKey = (args.generation_key as string | undefined) ?? null;
  const sourceArtifactIds = (args.source_artifact_ids as number[] | undefined) ?? [];

  // REQ-009 / CGAD §11 — RiskClass. declared_risk defaults to legacy `priority`
  // for backward compatibility. derived_risk and policy_minimum can be passed
  // explicitly or auto-derived from tags + task_kind. final_risk is always
  // computed = max(declared, derived, policy_minimum) — the agent cannot
  // self-lower it (P15).
  const tagsArray = (args.tags as string[]) ?? [];
  const declaredRiskRaw = (args.declared_risk as string | undefined) ?? priority;
  const derivedRisk = (args.derived_risk as string | undefined)
    ?? deriveRiskFromTags(tagsArray, taskKind);
  const policyMinimum = (args.policy_minimum as string | undefined)
    ?? derivePolicyMinimum(tagsArray, taskKind);
  const declaredRisk = declaredRiskRaw || null;
  const finalRisk = computeFinalRisk(declaredRisk, derivedRisk, policyMinimum);

  if (!['git_change', 'tracker_only', 'read_only_evidence', 'interactive'].includes(executionMode)) {
    throw new Error(`execution_mode '${executionMode}' is invalid`);
  }
  const epicProject = db.prepare('SELECT project_id FROM epics WHERE id=?').get(epicId) as { project_id: number } | undefined;
  if (!epicProject) throw new Error(`Epic ${epicId} not found`);
  if (projectRepositoryId != null) {
    const binding = db.prepare('SELECT project_id FROM project_repositories WHERE id=?').get(projectRepositoryId) as { project_id: number } | undefined;
    if (!binding) throw new Error(`Project repository ${projectRepositoryId} not found`);
    if (binding.project_id !== epicProject.project_id) {
      throw new Error(`Project repository ${projectRepositoryId} does not belong to epic ${epicId}'s product`);
    }
  }
  if (generatedFromTaskId != null) {
    const source = db.prepare('SELECT epic_id FROM tasks WHERE id=?').get(generatedFromTaskId) as { epic_id: number } | undefined;
    if (!source || source.epic_id !== epicId) {
      throw new Error(`generated_from_task_id ${generatedFromTaskId} must belong to epic ${epicId}`);
    }
  }
  const episodeInitialized = Boolean(
    db.prepare('SELECT 1 FROM episode_workflows WHERE epic_id=?').get(epicId),
  );
  const provenanceRequired = episodeInitialized
    && ['development', 'verification', 'integration'].includes(workflowStage ?? '');
  // Scaffold is infrastructure that materializes stubs for ALL accepted ACs in the
  // episode — it is not a per-AC implementation, so it is exempt from the per-AC
  // provenance gate. A scaffold CAN still carry source_artifact_ids if the caller
  // provides them (backward compatible), in which case they are validated below.
  const isInfrastructureScaffold = taskKind === 'development.scaffold';
  if (
    provenanceRequired && !isInfrastructureScaffold
    && generatedFromTaskId == null && sourceArtifactIds.length === 0
  ) {
    throw new Error(
      `Typed ${workflowStage} task requires generated_from_task_id or source_artifact_ids`,
    );
  }
  for (const artifactId of sourceArtifactIds) {
    const artifact = db.prepare(
      'SELECT epic_id,status,type FROM artifacts WHERE id=?',
    ).get(artifactId) as { epic_id: number; status: string; type: string } | undefined;
    if (!artifact || artifact.epic_id !== epicId || artifact.status !== 'accepted') {
      throw new Error(`source artifact ${artifactId} must be accepted and belong to epic ${epicId}`);
    }
    if (['development', 'verification'].includes(workflowStage ?? '') && artifact.type !== 'AC') {
      throw new Error(`Typed ${workflowStage} task provenance must reference accepted AC artifacts`);
    }
  }
  if (provenanceRequired && sourceArtifactIds.length === 0 && generatedFromTaskId != null) {
    const source = db.prepare(
      `SELECT workflow_stage,status,execution_mode,integration_state
       FROM tasks WHERE id=?`,
    ).get(generatedFromTaskId) as {
      workflow_stage: string | null; status: string;
      execution_mode: string; integration_state: string;
    };
    const order = ['discovery','formalization','planning','development','verification','integration'];
    const sourceIndex = order.indexOf(source.workflow_stage ?? '');
    const targetIndex = order.indexOf(workflowStage ?? '');
    const ready = source.status === 'done'
      && (source.execution_mode !== 'git_change' || source.integration_state === 'merged');
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex >= targetIndex || !ready) {
      throw new Error(
        `generated_from_task_id ${generatedFromTaskId} must be completed/integrated work from an earlier stage`,
      );
    }
  }

  const task = db
    .prepare(
      `INSERT INTO tasks
        (epic_id,title,description,status,priority,assigned_to,estimated_hours,due_date,source_ref,
         task_kind,workflow_stage,execution_skill,review_skill,execution_mode,
         project_repository_id,generated_from_task_id,generation_key,tags,metadata,
         declared_risk,derived_risk,policy_minimum,final_risk)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`
    )
    .get(
      epicId, title, description, status, priority, assignedTo, estimatedHours, dueDate, sourceRef,
      taskKind, workflowStage, executionSkill, reviewSkill, executionMode,
      projectRepositoryId, generatedFromTaskId, generationKey, tags, metadata,
      declaredRisk, derivedRisk, policyMinimum, finalRisk,
    );

  const row = task as Record<string, unknown>;
  const taskId = row.id as number;
  logActivity(db, 'task', taskId, 'created', null, null, null, `Task '${title}' created`);
  const traceType = workflowStage === 'development' ? 'implements' : 'depends_on';
  for (const artifactId of sourceArtifactIds) {
    db.prepare(
      `INSERT OR IGNORE INTO artifact_traces (source_id,target_type,target_id,link_type)
       VALUES (?,'task',?,?)`,
    ).run(artifactId, taskId, traceType);
  }

  if (dependsOn.length > 0) {
    setDependencies(db, taskId, dependsOn);
    evaluateAndUpdateDependencies(db, taskId);
    // Re-fetch to get potentially updated status
    return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  }

  return task;
}

const PRIORITY_ORDER = "CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END";
const STATUS_ORDER = "CASE t.status WHEN 'blocked' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'review_in_progress' THEN 2 WHEN 'review' THEN 3 WHEN 'todo' THEN 4 WHEN 'done' THEN 5 END";

function getTaskOrderClause(sortBy: string): string {
  switch (sortBy) {
    case 'priority':
      return `${PRIORITY_ORDER}, ${STATUS_ORDER}, t.sort_order, t.created_at`;
    case 'status':
      return `${STATUS_ORDER}, ${PRIORITY_ORDER}, t.sort_order, t.created_at`;
    case 'due_date':
      return `t.due_date IS NULL, t.due_date ASC, ${PRIORITY_ORDER}, t.created_at`;
    case 'created':
      return `t.created_at DESC`;
    default:
      return `${PRIORITY_ORDER}, ${STATUS_ORDER}, t.sort_order, t.created_at`;
  }
}

function handleTaskList(args: Record<string, unknown>) {
  const db = getDb();
  const epicId = args.epic_id as number | undefined;
  const status = args.status as string | undefined;
  const priority = args.priority as string | undefined;
  const assignedTo = args.assigned_to as string | undefined;
  const tag = args.tag as string | undefined;
  const taskKind = args.task_kind as string | undefined;
  const workflowStage = args.workflow_stage as string | undefined;
  const projectRepositoryId = args.project_repository_id as number | undefined;
  const branchFilter = resolveBranch(args.branch);
  const sortBy = (args.sort_by as string) ?? 'priority';
  const limit = (args.limit as number) ?? 50;

  const whereClauses: string[] = [];
  const params: unknown[] = [];

  if (epicId !== undefined) {
    whereClauses.push('t.epic_id = ?');
    params.push(epicId);
  }
  if (status) {
    whereClauses.push('t.status = ?');
    params.push(status);
  }
  if (priority) {
    whereClauses.push('t.priority = ?');
    params.push(priority);
  }
  if (assignedTo) {
    whereClauses.push('t.assigned_to = ?');
    params.push(assignedTo);
  }
  if (tag) {
    addTagFilter(whereClauses, params, tag, 't');
  }
  if (taskKind) {
    whereClauses.push('t.task_kind = ?');
    params.push(taskKind);
  }
  if (workflowStage) {
    whereClauses.push('t.workflow_stage = ?');
    params.push(workflowStage);
  }
  if (projectRepositoryId != null) {
    whereClauses.push('t.project_repository_id = ?');
    params.push(projectRepositoryId);
  }
  if (branchFilter === null) {
    whereClauses.push('e.branch IS NULL');
  } else if (branchFilter !== undefined) {
    whereClauses.push('e.branch = ?');
    params.push(branchFilter);
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const sql = `
    SELECT t.*,
      e.name as epic_name,
      (SELECT r.name FROM project_repositories pr JOIN repositories r ON r.id=pr.repository_id
        WHERE pr.id=t.project_repository_id) as repository_name,
      COUNT(DISTINCT s.id) as subtask_count,
      SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END) as subtask_done_count,
      (SELECT COUNT(*) FROM task_dependencies d
       JOIN tasks dt ON dt.id = d.depends_on_task_id AND dt.status != 'done'
       WHERE d.task_id = t.id) as blocked_by_count
    FROM tasks t
    JOIN epics e ON e.id = t.epic_id
    LEFT JOIN subtasks s ON s.task_id = t.id
    ${whereStr}
    GROUP BY t.id
    ORDER BY ${getTaskOrderClause(sortBy)}
    LIMIT ?
  `;

  params.push(limit);
  return db.prepare(sql).all(...params);
}

function handleTaskGet(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const task = db
    .prepare(
      `SELECT t.*, e.name as epic_name,
        (SELECT r.name FROM project_repositories pr JOIN repositories r ON r.id=pr.repository_id
          WHERE pr.id=t.project_repository_id) as repository_name
       FROM tasks t
       JOIN epics e ON e.id = t.epic_id
       WHERE t.id = ?`
    )
    .get(id);

  if (!task) throw new Error(`Task ${id} not found`);

  const subtasks = db
    .prepare('SELECT * FROM subtasks WHERE task_id = ? ORDER BY sort_order, created_at')
    .all(id);

  const notes = db
    .prepare(
      `SELECT * FROM notes
       WHERE related_entity_type = 'task' AND related_entity_id = ?
       ORDER BY created_at DESC`
    )
    .all(id);

  const comments = db
    .prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at ASC')
    .all(id);

  // Dependencies: what this task depends on
  const dependsOn = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id = d.depends_on_task_id
       WHERE d.task_id = ?`
    )
    .all(id);

  // Dependents: what tasks depend on this task
  const dependents = db
    .prepare(
      `SELECT t.id, t.title, t.status FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_task_id = ?`
    )
    .all(id);

  return { ...(task as object), subtasks, notes, comments, depends_on: dependsOn, dependents };
}

function handleTaskUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const oldRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!oldRow) throw new Error(`Task ${id} not found`);
  if (args.execution_mode !== undefined &&
      !['git_change', 'tracker_only', 'read_only_evidence', 'interactive'].includes(String(args.execution_mode))) {
    throw new Error(`execution_mode '${args.execution_mode}' is invalid`);
  }
  if (args.project_repository_id != null) {
    const binding = db.prepare(`
      SELECT pr.project_id
        FROM project_repositories pr
       WHERE pr.id=?
    `).get(args.project_repository_id) as { project_id: number } | undefined;
    const taskProject = db.prepare(`
      SELECT e.project_id FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE t.id=?
    `).get(id) as { project_id: number };
    if (!binding || binding.project_id !== taskProject.project_id) {
      throw new Error(`Project repository ${args.project_repository_id} does not belong to this task's product`);
    }
  }
  if (args.generated_from_task_id != null) {
    const source = db.prepare('SELECT epic_id FROM tasks WHERE id=?').get(args.generated_from_task_id) as { epic_id: number } | undefined;
    if (!source || source.epic_id !== oldRow.epic_id) {
      throw new Error(`generated_from_task_id ${args.generated_from_task_id} must belong to epic ${oldRow.epic_id}`);
    }
  }

  // Инвариант: задача в todo/done/blocked НИКОГДА не назначена — assigned_to всегда NULL.
  // Assigned имеет смысл только в активной работе (in_progress/review). blocked входит в
  // правило тоже: авто-blocked (deps) и ручной 'ждёт QA' оба освобождают исполнителя;
  // QA-wait трекается через тег stage:qa-wait + комментарий, не через assigned_to.
  // 1) Нормализуем '' → NULL (saga-API принимает пустую строку как "снять исполнителя").
  if (args.assigned_to !== undefined && args.assigned_to === '') {
    args.assigned_to = null;
  }
  // 2) Если статус меняется на todo|done|blocked — форсим assigned_to=NULL, даже если
  //    вызывающий не передавал assigned_to явно (как saga форсит actual_hours при done).
  const targetStatus = args.status as string | undefined;
  if (targetStatus === 'todo' || targetStatus === 'review' || targetStatus === 'done' || targetStatus === 'blocked') {
    args.assigned_to = null;
  }

  // 3) РАЗДЕЛЕНИЕ ЗОН: статус задачи управляет ТОЛЬКО dispatcher (worker_next/worker_done).
  //    task_update не имеет права двигать status — это ловушка (воркер сам перевёл задачу
  //    в review, обойдя worker_done: assigned_to не чистится, result-комментарий не
  //    пишется, цикл рвётся). Поле status молча ОТБРАСЫВАЕМ — задача не двигается.
  //    Другие поля (title/priority/tags/depends_on/...) меняются свободно — агенты могут
  //    редактировать метаданные, но не поток статусов.
  //    dispatcher.ts пишет статусы напрямую через SQL (не через этот handler), так что
  //    запрет его не затрагивает. evaluateAndUpdateDependencies (auto-blocked/todo) тоже
  //    пишет напрямую.
  //    Escape hatch: env SAGA_ALLOW_MANUAL_STATUS=1 — для человека/CI (агенты о нём не знают).
  let statusIgnored = false;
  if (args.status !== undefined && process.env.SAGA_ALLOW_MANUAL_STATUS !== '1') {
    delete args.status;
    statusIgnored = true;
  }

  let newRow: Record<string, unknown>;

  const update = buildUpdate('tasks', id, args, [
    'title', 'description', 'status', 'priority', 'assigned_to',
    'estimated_hours', 'actual_hours', 'due_date', 'source_ref', 'sort_order', 'tags', 'metadata',
    'task_kind', 'workflow_stage', 'execution_skill', 'review_skill', 'execution_mode',
    'project_repository_id', 'generated_from_task_id', 'generation_key',
    'declared_risk', 'derived_risk', 'policy_minimum',
  ]);

  // REQ-009 — recompute final_risk after the column update, using whichever of
  // declared/derived/policy were changed (or the existing row values). The
  // agent cannot write final_risk directly here (it's computed); an explicit
  // `final_risk` arg is ignored with a warning, because P15 forbids
  // self-lowering. To raise final_risk, raise one of declared/derived/policy.
  if (update) {
    // CGAD P15 + RMW atomicity: the read-modify-write sequence
    //   (SELECT oldRow) → UPDATE columns → SELECT fresh → UPDATE risk
    // must be atomic. BEGIN IMMEDIATE takes the DB write-lock up-front so a
    // concurrent writer cannot change the risk columns between our read of
    // oldRow and our UPDATE. The P15 monotonicity check below compares the
    // NEW effective values against the authoritative oldRow fetched inside
    // this transaction; if it throws, ROLLBACK reverts the column UPDATE too,
    // so no partial (lowered) state ever persists.
    newRow = withImmediateTransaction(db, () => {
      // Authoritative pre-update snapshot — fetched UNDER the write-lock, so
      // it is consistent with the UPDATEs below. The outer `oldRow` may be
      // microseconds stale; this one is the source of truth for P15.
      const oldRowTx = db.prepare(
        'SELECT declared_risk, derived_risk, policy_minimum, title FROM tasks WHERE id=?',
      ).get(id) as {
        declared_risk: string | null; derived_risk: string | null;
        policy_minimum: string | null; title: string;
      } | undefined;
      if (!oldRowTx) throw new Error(`Task ${id} not found`);

      // (1) UPDATE the requested columns.
      let r = db.prepare(update.sql).get(...update.params) as Record<string, unknown>;
      // (2) SELECT fresh values post-update to compute final_risk consistently.
      const fresh = db.prepare(
        'SELECT declared_risk, derived_risk, policy_minimum, tags, task_kind FROM tasks WHERE id=?',
      ).get(id) as {
        declared_risk: string | null; derived_risk: string | null;
        policy_minimum: string | null; tags: string; task_kind: string | null;
      };
      // If derived_risk / policy_minimum were not explicitly written, auto-derive
      // them from the (possibly updated) tags + task_kind. declared_risk follows
      // priority when not set, to keep the legacy column authoritative.
      let effectiveDerived = fresh.derived_risk;
      let effectivePolicy = fresh.policy_minimum;
      let effectiveDeclared = fresh.declared_risk;
      const tagsParsed = (() => { try { return JSON.parse(fresh.tags || '[]') as string[]; } catch { return []; } })();
      if (effectiveDerived == null) effectiveDerived = deriveRiskFromTags(tagsParsed, fresh.task_kind);
      if (effectivePolicy == null) effectivePolicy = derivePolicyMinimum(tagsParsed, fresh.task_kind);
      if (effectiveDeclared == null) {
        // Fall back to legacy priority column if declared_risk never set.
        const legacyPriority = db.prepare('SELECT priority FROM tasks WHERE id=?').get(id) as { priority: string };
        effectiveDeclared = legacyPriority.priority || null;
      }
      const computedFinal = computeFinalRisk(effectiveDeclared, effectiveDerived, effectivePolicy);

      // CGAD P15 monotonicity guard (BEFORE the risk UPDATE).
      // derived_risk and policy_minimum are floor-raised by the system; the
      // agent (Builder) cannot self-lower them. declared_risk CAN be lowered
      // (it's the Builder's proposal), but final_risk = max(declared, derived,
      // policy) is computed, so lowering declared alone can never drop final
      // below the derived/policy floor. null ranks -1 (below low): a null old
      // value imposes no floor, so going null -> 'low' is allowed (not a lowering).
      enforceP15Monotonicity(oldRowTx, effectiveDerived, effectivePolicy);

      // If the new computed final differs from the row's current final_risk,
      // OR derived/policy were auto-derived and differ from what's stored, persist.
      const needsUpdate =
        r.final_risk !== computedFinal
        || fresh.derived_risk !== effectiveDerived
        || fresh.policy_minimum !== effectivePolicy
        || fresh.declared_risk !== effectiveDeclared;
      if (needsUpdate) {
        db.prepare(
          `UPDATE tasks SET declared_risk=?, derived_risk=?, policy_minimum=?, final_risk=?,
           updated_at=datetime('now') WHERE id=?`,
        ).run(effectiveDeclared, effectiveDerived, effectivePolicy, computedFinal, id);
        r = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Record<string, unknown>;
      }
      logEntityUpdate(db, 'task', id, r.title as string, oldRow, r, [
        'status', 'priority', 'assigned_to', 'title', 'final_risk',
      ]);
      return r;
    });
  } else if (args.depends_on !== undefined) {
    // Only depends_on changed, no column updates
    newRow = oldRow;
  } else if (statusIgnored) {
    // Агент прислал ТОЛЬКО status (других полей нет) — buildUpdate вернул null.
    // Вместо cryptic "No fields to update" возвращаем задачу как есть + понятное
    // сообщение, что status — зона dispatcher'а.
    return {
      ...(oldRow as object),
      _warning:
        "task_update ignored the 'status' field — only the dispatcher (worker_next / worker_done) may change a task's status. " +
        'No other fields were provided, so nothing changed. ' +
        'To move this task, use worker_done({task_id, worker_id, result}).',
    };
  } else {
    throw new Error('No fields to update');
  }

  // Handle dependency updates
  if (args.depends_on !== undefined) {
    const dependsOn = args.depends_on as number[];
    setDependencies(db, id, dependsOn);
    logActivity(db, 'task', id, 'updated', 'depends_on', null,
      dependsOn.length > 0 ? dependsOn.join(',') : '(none)',
      `Task '${newRow.title}' dependencies updated: [${dependsOn.join(', ')}]`);
    evaluateAndUpdateDependencies(db, id);
    // Re-fetch in case status changed
    newRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown>;
  }

  // Auto time tracking: when status changes to done and actual_hours wasn't manually set
  const statusChanged = args.status && oldRow.status !== args.status;
  if (statusChanged && args.status === 'done' && !args.actual_hours && !newRow.actual_hours) {
    const startEntry = db.prepare(
      `SELECT created_at FROM activity_log
       WHERE entity_type = 'task' AND entity_id = ? AND action = 'status_changed'
         AND field_name = 'status' AND new_value = 'in_progress'
       ORDER BY created_at DESC LIMIT 1`
    ).get(id) as { created_at: string } | undefined;

    if (startEntry) {
      const startMs = new Date(startEntry.created_at + 'Z').getTime();
      const nowMs = Date.now();
      const hours = Math.round(((nowMs - startMs) / 3_600_000) * 10) / 10; // 1 decimal
      if (hours > 0) {
        db.prepare('UPDATE tasks SET actual_hours = ? WHERE id = ?').run(hours, id);
        (newRow as Record<string, unknown>).actual_hours = hours;
        logActivity(db, 'task', id, 'updated', 'actual_hours', null, String(hours),
          `Task '${newRow.title}' auto-tracked: ${hours}h`);
      }
    }
  }

  // Re-evaluate downstream tasks when this task is marked done.
  // (Через task_update это больше недостижимо — status отброшен выше. Остаётся для
  //  случая SAGA_ALLOW_MANUAL_STATUS=1, где человек может двинуть done вручную.)
  if (statusChanged && args.status === 'done') {
    reevaluateDownstream(db, id);
  }

  // Если agent прислал status, но мы его отбросили (зона dispatcher'а) — возвращаем
  // явное сообщение, чтобы это не прошло незамеченным. newRow — реальное состояние.
  if (statusIgnored) {
    return {
      ...newRow,
      _warning:
        "task_update ignored the 'status' field — only the dispatcher (worker_next / worker_done) may change a task's status. " +
        'Other fields were applied. To move this task, use worker_done({task_id, worker_id, result}).',
    };
  }

  return newRow;
}

export const handlers: Record<string, ToolHandler> = {
  task_create: handleTaskCreate,
  task_list: handleTaskList,
  task_get: handleTaskGet,
  task_update: handleTaskUpdate,
};
