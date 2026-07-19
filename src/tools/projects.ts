import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type Database from 'better-sqlite3';
import { getDb } from '../db.js';
import { buildUpdate } from '../helpers/sql-builder.js';
import { logActivity, logEntityUpdate } from '../helpers/activity-logger.js';
import type { ToolHandler } from '../types.js';

export const definitions: Tool[] = [
  {
    name: 'project_create',
    description: 'Create a new project. Projects are the top-level container for all work.',
    annotations: { title: 'Create Project', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name' },
        description: { type: 'string', description: 'Project description' },
        status: {
          type: 'string',
          enum: ['active', 'on_hold', 'completed', 'archived'],
          default: 'active',
          description: 'Project status',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'project_list',
    description:
      'List all projects with epic/task counts and completion percentages. Optionally filter by status.',
    annotations: { title: 'List Projects', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'on_hold', 'completed', 'archived'],
          description: 'Filter by status',
        },
      },
    },
  },
  {
    name: 'project_update',
    description:
      'Update a project. Pass only the fields you want to change. Set status to "archived" to soft-delete.',
    annotations: { title: 'Update Project', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Project ID' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['active', 'on_hold', 'completed', 'archived'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'project_resolve_by_name',
    description:
      'Get-or-create a project by its exact name, atomically. Returns {project_id, created, project}. created:true if a new project was inserted, false if an existing name matched. Use this when a worker needs a stable project_id from a project name (e.g. read from ./projectname.txt) — guarantees no duplicate projects are created when multiple agents start cold at once (name is not unique in saga, so the atomic lookup-or-insert under a write lock is what prevents duplicates).',
    annotations: { title: 'Resolve Project by Name', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact project name to resolve (matches an existing name, or creates a project with that name).',
        },
        description: {
          type: 'string',
          description: 'Description to set IF creating (ignored if a project with this name already exists).',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'project_delete',
    description:
      'Hard-delete a project and cascade-clean all epics, tasks, artifacts, traces, worker_executions, episode_workflows, and repository bindings. Admin escape hatch — VIOLATES CGAD P2 ("status change, not destruction"). Prefer project_update({status:"archived"}) for soft-delete. Safety: rejects if any engine is running for an epic in this project. Leaves intact: repositories rows (resource, P17), activity_log (audit trail, P12), command_receipts (idempotency ledger), on-disk .md artifact files. Returns deregistered_checkouts so the operator can clean disk separately.',
    annotations: { title: 'Delete Project (hard)', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Project ID to hard-delete' },
      },
      required: ['project_id'],
    },
  },
];

function handleProjectCreate(args: Record<string, unknown>) {
  const db = getDb();
  const name = args.name as string;
  const description = (args.description as string) ?? null;
  const status = (args.status as string) ?? 'active';
  const tags = JSON.stringify((args.tags as string[]) ?? []);

  const project = db
    .prepare(
      'INSERT INTO projects (name, description, status, tags) VALUES (?, ?, ?, ?) RETURNING *'
    )
    .get(name, description, status, tags);

  const row = project as Record<string, unknown>;
  logActivity(db, 'project', row.id as number, 'created', null, null, null, `Project '${name}' created`);

  return project;
}

function handleProjectList(args: Record<string, unknown>) {
  const db = getDb();
  const status = args.status as string | undefined;

  let sql = `
    SELECT p.*,
      COUNT(DISTINCT e.id) as epic_count,
      COUNT(DISTINCT t.id) as task_count,
      SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done_count,
      CASE WHEN COUNT(DISTINCT t.id) > 0
        THEN ROUND(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100.0 / COUNT(DISTINCT t.id), 1)
        ELSE 0 END as completion_pct
    FROM projects p
    LEFT JOIN epics e ON e.project_id = p.id
    LEFT JOIN tasks t ON t.epic_id = e.id
  `;

  const params: unknown[] = [];
  if (status) {
    sql += ' WHERE p.status = ?';
    params.push(status);
  }

  sql += ' GROUP BY p.id ORDER BY p.created_at DESC';

  return db.prepare(sql).all(...params);
}

function handleProjectUpdate(args: Record<string, unknown>) {
  const db = getDb();
  const id = args.id as number;

  const oldRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!oldRow) throw new Error(`Project ${id} not found`);

  const update = buildUpdate('projects', id, args, ['name', 'description', 'status', 'tags']);
  if (!update) throw new Error('No fields to update');

  const newRow = db.prepare(update.sql).get(...update.params) as Record<string, unknown>;
  logEntityUpdate(db, 'project', id, newRow.name as string, oldRow, newRow, ['name', 'status']);

  return newRow;
}

function handleProjectResolveByName(args: Record<string, unknown>): {
  project_id: number;
  created: boolean;
  project: Record<string, unknown>;
} {
  const db = getDb();
  const name = args.name as string;
  const description = (args.description as string) ?? null;

  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('name is required and must be a non-empty string');
  }

  // BEGIN IMMEDIATE — сериализация писателей. Имя проекта НЕ unique в saga,
  // поэтому lookup-or-create под одним локом — единственный способ избежать
  // гонки «3 холодных агента одновременно создают 3 дубликата».
  // db.transaction(fn) тут только DEFERRED (см. @types/better-sqlite3),
  // поэтому оборачиваем явно в BEGIN IMMEDIATE / COMMIT / ROLLBACK.
  const run = (db: Database.Database) => {
    const found = db
      .prepare('SELECT * FROM projects WHERE name = ?')
      .get(name) as Record<string, unknown> | undefined;
    if (found) {
      return { project_id: found.id as number, created: false, project: found };
    }
    const created = db
      .prepare(
        'INSERT INTO projects (name, description, status, tags) VALUES (?, ?, ?, ?) RETURNING *',
      )
      .get(name, description, 'active', '[]') as Record<string, unknown>;
    const createdId = created.id as number;
    logActivity(
      db,
      'project',
      createdId,
      'created',
      null,
      null,
      null,
      `Project '${name}' auto-created by project_resolve_by_name`,
    );
    return { project_id: createdId, created: true, project: created };
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run(db);
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

// Hard-delete a project and cascade-clean every descendant.
//
// CGAD carve-out: this is the only cascading-delete tool in saga-mcp. It
// violates P2 ("status change, not destruction") by design — it exists as
// an admin/operator escape hatch for test-fixture cleanup and right-to-
// erasure scenarios. Workers should never call this; soft-delete via
// project_update({status:'archived'}) is the supported path.
//
// Cascade: every ON DELETE CASCADE edge in schema.ts fires automatically
// once DELETE FROM projects runs. The only table we must clean manually
// is worker_executions — it has bare-integer columns (project_id, epic_id,
// task_id) with no FK declaration, deliberately kept as an audit trail
// (schema.ts:142-144). We delete the project-scoped slice because those
// rows are no longer meaningful once the project is gone, and leaving
// them produces dangling pointers in worker_health / dashboards.
//
// NOT touched (intentionally):
//   - repositories rows (project-agnostic resource — P17; deleted via
//     project_repositories CASCADE only if no other project binds them)
//   - activity_log (audit trail, polymorphic, no FK — P12)
//   - command_receipts (idempotency ledger; bare task_id, no FK)
//   - on-disk .md artifact files (no transactional coupling to DB rows;
//     see deregistered_checkouts in the return value for disk cleanup)
function handleProjectDelete(args: Record<string, unknown>): {
  project_id: number;
  deleted: boolean;
  deregistered_checkouts: Array<{ machine_id: string; local_path: string }>;
} {
  const db = getDb();
  const projectId = args.project_id as number;
  if (!Number.isInteger(projectId) || projectId <= 0) {
    throw new Error('project_id must be a positive integer');
  }

  // Safety guard: reject if any engine is running for an epic in this
  // project. Killing a running engine via DB delete would orphan claude.exe
  // worker processes. The user must stop engines explicitly first.
  const runningEpics = db.prepare(
    `SELECT ew.epic_id FROM episode_workflows ew
      JOIN epics e ON e.id = ew.epic_id
      WHERE e.project_id = ?
        AND json_extract(ew.metadata, '$.engine_running') = 1`,
  ).all(projectId) as Array<{ epic_id: number }>;
  if (runningEpics.length > 0) {
    const ids = runningEpics.map((r) => r.epic_id).join(', ');
    throw new Error(
      `Cannot delete project ${projectId}: engine is running for epic(s) ${ids}. ` +
      `Stop engine(s) first via worker tools or /api/engine/stop.`,
    );
  }

  // Capture machine checkouts before delete — the operator may want to
  // manually rm these directories afterwards. We do NOT delete files from
  // disk: DB transactions have no business touching the filesystem, and
  // these paths may live on remote worker machines.
  const checkouts = db.prepare(
    `SELECT rc.machine_id, rc.local_path
       FROM repository_checkouts rc
       JOIN project_repositories pr ON pr.id = rc.project_repository_id
      WHERE pr.project_id = ?`,
  ).all(projectId) as Array<{ machine_id: string; local_path: string }>;

  // Capture name for audit before delete (logActivity still fires after).
  const row = db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as
    | { name: string }
    | undefined;
  if (!row) throw new Error(`Project ${projectId} not found`);
  const projectName = row.name;

  db.exec('BEGIN IMMEDIATE');
  try {
    // worker_executions has no FK on project_id — must clean manually.
    db.prepare('DELETE FROM worker_executions WHERE project_id = ?').run(projectId);
    // DELETE FROM projects triggers every other CASCADE (schema.ts):
    //   epics → tasks → (subtasks, task_dependencies, comments,
    //                    task_conflict_keys, verification_evidence,
    //                    task_work_items → work_attempts,
    //                    human_requests, integration_intents)
    //   epics → artifacts → artifact_traces
    //   epics → episode_workflows
    //   epics → runtime_observations
    //   artifacts (direct project_id) — also cascaded
    //   project_repositories → repository_checkouts
    //   trusted_providers (project-scoped rows; NULL = global survives)
    const info = db.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
    if (info.changes === 0) {
      throw new Error(`Project ${projectId} not found (already deleted?)`);
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* tx may not be active */ }
    throw err;
  }

  // activity_log has no FK, so the audit entry survives even though the
  // project row is gone — this is by design (P12: audit is not state).
  logActivity(
    db,
    'project',
    projectId,
    'deleted',
    null,
    null,
    null,
    `Project '${projectName}' (id=${projectId}) hard-deleted via project_delete tool`,
  );

  return { project_id: projectId, deleted: true, deregistered_checkouts: checkouts };
}

export const handlers: Record<string, ToolHandler> = {
  project_create: handleProjectCreate,
  project_list: handleProjectList,
  project_update: handleProjectUpdate,
  project_resolve_by_name: handleProjectResolveByName,
  project_delete: handleProjectDelete,
};
