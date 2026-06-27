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

export const handlers: Record<string, ToolHandler> = {
  project_create: handleProjectCreate,
  project_list: handleProjectList,
  project_update: handleProjectUpdate,
  project_resolve_by_name: handleProjectResolveByName,
};
