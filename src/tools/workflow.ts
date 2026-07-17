import type Database from 'better-sqlite3';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { Task, ToolHandler } from '../types.js';

type GeneratedResult = {
  transition: string;
  source_task_id: number;
  created: number[];
  reused: number[];
  tasks: Task[];
};

type TaskSpec = {
  key: string;
  title: string;
  kind: string;
  stage: string;
  executionSkill: string;
  reviewSkill: string;
  mode: Task['execution_mode'];
  repositoryId: number | null;
  sourceTaskId: number;
  dependencies: number[];
};

function insertGeneratedTask(db: Database.Database, epicId: number, spec: TaskSpec): { task: Task; created: boolean } {
  const existing = db.prepare(
    'SELECT * FROM tasks WHERE epic_id=? AND generation_key=?',
  ).get(epicId, spec.key) as Task | undefined;
  if (existing) return { task: existing, created: false };

  const unmet = spec.dependencies.some(id => {
    const dep = db.prepare('SELECT status FROM tasks WHERE id=? AND epic_id=?').get(id, epicId) as { status: string } | undefined;
    if (!dep) throw new Error(`Dependency task ${id} is missing from epic ${epicId}`);
    return dep.status !== 'done';
  });
  const status = unmet ? 'blocked' : 'todo';
  const task = db.prepare(`
    INSERT INTO tasks
      (epic_id,title,description,status,priority,task_kind,workflow_stage,
       execution_skill,review_skill,execution_mode,project_repository_id,
       generated_from_task_id,generation_key,tags,metadata)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    RETURNING *
  `).get(
    epicId,
    spec.title,
    `Generated from task #${spec.sourceTaskId}. generation_key=${spec.key}`,
    status,
    'high',
    spec.kind,
    spec.stage,
    spec.executionSkill,
    spec.reviewSkill,
    spec.mode,
    spec.repositoryId,
    spec.sourceTaskId,
    spec.key,
    JSON.stringify([`stage:${spec.stage}`, `kind:${spec.kind}`]),
    JSON.stringify({ generated: true, source_task_id: spec.sourceTaskId }),
  ) as Task;
  const depInsert = db.prepare(
    'INSERT OR IGNORE INTO task_dependencies (task_id,depends_on_task_id) VALUES (?,?)',
  );
  for (const dependency of spec.dependencies) depInsert.run(task.id, dependency);
  logActivity(db, 'task', task.id, 'created', 'generation_key', null, spec.key,
    `Workflow generated '${task.title}' from task ${spec.sourceTaskId}`);
  return { task, created: true };
}

function sibling(db: Database.Database, epicId: number, sourceParentId: number | null, kind: string): Task | undefined {
  if (sourceParentId == null) return undefined;
  return db.prepare(`
    SELECT * FROM tasks
     WHERE epic_id=? AND generated_from_task_id=? AND task_kind=?
     ORDER BY id LIMIT 1
  `).get(epicId, sourceParentId, kind) as Task | undefined;
}

function specsForTransition(db: Database.Database, source: Task, transition: string): TaskSpec[] {
  const repo = source.project_repository_id;
  if (transition === 'prd_accepted') {
    if (source.task_kind !== 'formalization.prd') {
      throw new Error(`Transition prd_accepted requires task_kind=formalization.prd, got '${source.task_kind}'`);
    }
    return [
      {
        key: `prd:${source.id}:srs`, title: `SRS: ${source.title}`, kind: 'formalization.srs',
        stage: 'formalization', executionSkill: 'saga-architect', reviewSkill: 'saga-architecture-reviewer',
        mode: 'git_change', repositoryId: repo, sourceTaskId: source.id, dependencies: [source.id],
      },
      {
        key: `prd:${source.id}:uc`, title: `UC: ${source.title}`, kind: 'formalization.uc',
        stage: 'formalization', executionSkill: 'saga-analyst', reviewSkill: 'saga-requirements-reviewer',
        mode: 'git_change', repositoryId: repo, sourceTaskId: source.id, dependencies: [source.id],
      },
    ];
  }

  if (transition === 'srs_accepted' || transition === 'uc_accepted') {
    const expected = transition === 'srs_accepted' ? 'formalization.srs' : 'formalization.uc';
    const counterpartKind = transition === 'srs_accepted' ? 'formalization.uc' : 'formalization.srs';
    if (source.task_kind !== expected) {
      throw new Error(`Transition ${transition} requires task_kind=${expected}, got '${source.task_kind}'`);
    }
    const counterpart = sibling(db, source.epic_id, source.generated_from_task_id, counterpartKind);
    if (!counterpart) {
      throw new Error(`Cannot generate reconciliation: matching ${counterpartKind} task was not found`);
    }
    const prdId = source.generated_from_task_id as number;
    return [{
      key: `prd:${prdId}:reconciliation`,
      title: `Reconcile SRS + UC for PRD task #${prdId}`,
      kind: 'formalization.reconciliation',
      stage: 'formalization',
      executionSkill: 'saga-reconciler',
      reviewSkill: 'saga-requirements-reviewer',
      mode: 'git_change',
      repositoryId: repo ?? counterpart.project_repository_id,
      sourceTaskId: source.id,
      dependencies: [source.id, counterpart.id],
    }];
  }

  if (transition === 'baseline_accepted') {
    if (source.task_kind !== 'formalization.reconciliation') {
      throw new Error(`Transition baseline_accepted requires task_kind=formalization.reconciliation, got '${source.task_kind}'`);
    }
    return [{
      key: `reconciliation:${source.id}:planning`,
      title: `Decompose accepted baseline from task #${source.id}`,
      kind: 'planning.decomposition',
      stage: 'planning',
      executionSkill: 'saga-planner',
      reviewSkill: 'saga-planning-reviewer',
      mode: 'tracker_only',
      repositoryId: null,
      sourceTaskId: source.id,
      dependencies: [source.id],
    }];
  }

  throw new Error(`Unknown workflow transition '${transition}'`);
}

function handleWorkflowGenerateNext(args: Record<string, unknown>): GeneratedResult {
  const db = getDb();
  const sourceId = args.source_task_id as number;
  const epicId = args.epic_id as number;
  const transition = String(args.transition ?? '');
  const source = db.prepare('SELECT * FROM tasks WHERE id=?').get(sourceId) as Task | undefined;
  if (!source) throw new Error(`Source task ${sourceId} not found`);
  if (source.epic_id !== epicId) throw new Error(`Source task ${sourceId} does not belong to epic ${epicId}`);
  if (source.status !== 'done') {
    throw new Error(`Source task ${sourceId} must be done before downstream generation (status=${source.status})`);
  }
  if (!source.task_kind) throw new Error(`Source task ${sourceId} is legacy/untyped and cannot auto-generate downstream work`);

  return db.transaction(() => {
    const specs = specsForTransition(db, source, transition);
    const result: GeneratedResult = {
      transition, source_task_id: sourceId, created: [], reused: [], tasks: [],
    };
    for (const spec of specs) {
      const inserted = insertGeneratedTask(db, epicId, spec);
      result.tasks.push(inserted.task);
      (inserted.created ? result.created : result.reused).push(inserted.task.id);
    }
    return result;
  })();
}

export function generateNextForCompletedTask(taskId: number): GeneratedResult | null {
  const db = getDb();
  const task = db.prepare('SELECT id,epic_id,task_kind,status FROM tasks WHERE id=?').get(taskId) as
    | { id: number; epic_id: number; task_kind: string | null; status: string }
    | undefined;
  if (!task || task.status !== 'done') return null;
  const transition = task.task_kind === 'formalization.prd' ? 'prd_accepted'
    : task.task_kind === 'formalization.srs' ? 'srs_accepted'
    : task.task_kind === 'formalization.uc' ? 'uc_accepted'
    : task.task_kind === 'formalization.reconciliation' ? 'baseline_accepted'
    : null;
  if (!transition) return null;
  return handleWorkflowGenerateNext({
    epic_id: task.epic_id,
    source_task_id: task.id,
    transition,
  });
}

export const definitions: Tool[] = [{
  name: 'workflow_generate_next',
  description: 'Idempotently generate the next typed workflow tasks from one completed upstream task. Supported foundation transitions: prd_accepted, srs_accepted, uc_accepted, baseline_accepted.',
  annotations: { title: 'Workflow: Generate Next', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      epic_id: { type: 'integer' },
      source_task_id: { type: 'integer' },
      transition: { type: 'string', enum: ['prd_accepted', 'srs_accepted', 'uc_accepted', 'baseline_accepted'] },
    },
    required: ['epic_id', 'source_task_id', 'transition'],
  },
}];

export const handlers: Record<string, ToolHandler> = {
  workflow_generate_next: handleWorkflowGenerateNext,
};
