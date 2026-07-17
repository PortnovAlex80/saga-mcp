import path from 'node:path';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { ProjectRepository, Repository, ToolHandler } from '../types.js';

type RepositoryBinding = ProjectRepository & {
  name: string;
  remote_url: string | null;
  default_branch: string;
};

const STATUS = ['planned', 'active', 'on_hold', 'archived'] as const;

function normalizeLocalPath(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error('local_path must be a string or null');
  return path.resolve(value);
}

function bindingById(id: number): RepositoryBinding {
  const row = getDb().prepare(`
    SELECT pr.*, r.name, r.remote_url, r.default_branch
      FROM project_repositories pr
      JOIN repositories r ON r.id=pr.repository_id
     WHERE pr.id=?
  `).get(id) as RepositoryBinding | undefined;
  if (!row) throw new Error(`Project repository ${id} not found`);
  return row;
}

function handleRepositoryRegister(args: Record<string, unknown>): RepositoryBinding & { created: boolean } {
  const db = getDb();
  const projectId = args.project_id as number;
  const name = String(args.name ?? '').trim();
  if (!name) throw new Error('name is required');
  if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) {
    throw new Error(`Project ${projectId} not found`);
  }

  const status = String(args.status ?? 'active') as typeof STATUS[number];
  if (!STATUS.includes(status)) throw new Error(`status must be one of ${STATUS.join(', ')}`);
  const localPath = normalizeLocalPath(args.local_path);
  const remoteUrl = args.remote_url == null ? null : String(args.remote_url);
  const defaultBranch = String(args.default_branch ?? 'main');
  const role = String(args.role ?? 'component');
  const integrationBranch = String(args.integration_branch ?? 'dev');
  const docsRoot = args.docs_root == null ? null : String(args.docs_root);

  const existing = db.prepare(`
    SELECT pr.id
      FROM project_repositories pr
      JOIN repositories r ON r.id=pr.repository_id
     WHERE pr.project_id=? AND r.name=?
     LIMIT 1
  `).get(projectId, name) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE project_repositories
         SET role=?, local_path=COALESCE(?,local_path), integration_branch=?,
             docs_root=COALESCE(?,docs_root), status=?, updated_at=datetime('now')
       WHERE id=?
    `).run(role, localPath, integrationBranch, docsRoot, status, existing.id);
    if (remoteUrl != null || args.default_branch != null) {
      db.prepare(`
        UPDATE repositories
           SET remote_url=COALESCE(?,remote_url), default_branch=?, updated_at=datetime('now')
         WHERE id=(SELECT repository_id FROM project_repositories WHERE id=?)
      `).run(remoteUrl, defaultBranch, existing.id);
    }
    return { ...bindingById(existing.id), created: false };
  }

  const create = db.transaction(() => {
    const repo = db.prepare(`
      INSERT INTO repositories (name,remote_url,default_branch)
      VALUES (?,?,?)
      RETURNING *
    `).get(name, remoteUrl, defaultBranch) as Repository;
    const binding = db.prepare(`
      INSERT INTO project_repositories
        (project_id,repository_id,role,local_path,integration_branch,docs_root,status)
      VALUES (?,?,?,?,?,?,?)
      RETURNING *
    `).get(projectId, repo.id, role, localPath, integrationBranch, docsRoot, status) as ProjectRepository;
    return binding.id;
  })();
  logActivity(db, 'project', projectId, 'updated', 'repository', null, String(create),
    `Repository '${name}' registered for product project ${projectId}`);
  return { ...bindingById(create), created: true };
}

function handleRepositoryList(args: Record<string, unknown>): { repositories: RepositoryBinding[]; count: number } {
  const projectId = args.project_id as number;
  const rows = getDb().prepare(`
    SELECT pr.*, r.name, r.remote_url, r.default_branch
      FROM project_repositories pr
      JOIN repositories r ON r.id=pr.repository_id
     WHERE pr.project_id=?
       AND (? IS NULL OR pr.status=?)
     ORDER BY pr.role, r.name
  `).all(projectId, args.status ?? null, args.status ?? null) as RepositoryBinding[];
  return { repositories: rows, count: rows.length };
}

function handleRepositoryGet(args: Record<string, unknown>): RepositoryBinding {
  return bindingById(args.id as number);
}

function handleRepositoryUpdate(args: Record<string, unknown>): RepositoryBinding {
  const db = getDb();
  const id = args.id as number;
  const existing = bindingById(id);
  const fields: string[] = [];
  const params: unknown[] = [];
  for (const field of ['role', 'integration_branch', 'docs_root'] as const) {
    if (args[field] !== undefined) { fields.push(`${field}=?`); params.push(args[field]); }
  }
  if (args.local_path !== undefined) {
    fields.push('local_path=?');
    params.push(normalizeLocalPath(args.local_path));
  }
  if (args.status !== undefined) {
    const status = String(args.status) as typeof STATUS[number];
    if (!STATUS.includes(status)) throw new Error(`status must be one of ${STATUS.join(', ')}`);
    fields.push('status=?'); params.push(status);
  }
  if (fields.length) {
    fields.push("updated_at=datetime('now')");
    params.push(id);
    db.prepare(`UPDATE project_repositories SET ${fields.join(',')} WHERE id=?`).run(...params);
  }
  if (args.name !== undefined || args.remote_url !== undefined || args.default_branch !== undefined) {
    db.prepare(`
      UPDATE repositories
         SET name=?, remote_url=?, default_branch=?, updated_at=datetime('now')
       WHERE id=?
    `).run(
      args.name ?? existing.name,
      args.remote_url !== undefined ? args.remote_url : existing.remote_url,
      args.default_branch ?? existing.default_branch,
      existing.repository_id,
    );
  }
  return bindingById(id);
}

function handleCheckoutRegister(args: Record<string, unknown>) {
  const db = getDb();
  const bindingId = args.project_repository_id as number;
  bindingById(bindingId);
  const machineId = String(args.machine_id ?? '').trim();
  const localPath = normalizeLocalPath(args.local_path);
  if (!machineId || !localPath) throw new Error('machine_id and local_path are required');
  const status = String(args.status ?? 'active');
  if (!['active', 'missing', 'on_hold'].includes(status)) throw new Error(`Invalid checkout status '${status}'`);
  db.prepare(
    `INSERT INTO repository_checkouts
       (project_repository_id,machine_id,local_path,status,metadata)
     VALUES (?,?,?,?,?)
     ON CONFLICT(project_repository_id,machine_id) DO UPDATE SET
       local_path=excluded.local_path,status=excluded.status,metadata=excluded.metadata,
       last_seen_at=datetime('now'),updated_at=datetime('now')`,
  ).run(bindingId, machineId, localPath, status, JSON.stringify(args.metadata ?? {}));
  return db.prepare(
    'SELECT * FROM repository_checkouts WHERE project_repository_id=? AND machine_id=?',
  ).get(bindingId, machineId);
}

function handleCheckoutList(args: Record<string, unknown>) {
  const rows = getDb().prepare(
    `SELECT rc.*,r.name AS repository_name
     FROM repository_checkouts rc
     JOIN project_repositories pr ON pr.id=rc.project_repository_id
     JOIN repositories r ON r.id=pr.repository_id
     WHERE (? IS NULL OR pr.project_id=?) AND (? IS NULL OR rc.machine_id=?)
     ORDER BY r.name,rc.machine_id`,
  ).all(args.project_id ?? null, args.project_id ?? null, args.machine_id ?? null, args.machine_id ?? null);
  return { checkouts: rows, count: rows.length };
}

function handleCheckoutBootstrap(args: Record<string, unknown>) {
  const binding = bindingById(args.project_repository_id as number);
  const machineId = String(args.machine_id ?? '').trim();
  const localPath = normalizeLocalPath(args.local_path);
  if (!machineId || !localPath) throw new Error('machine_id and local_path are required');
  if (!binding.remote_url) throw new Error(`Repository '${binding.name}' has no remote_url`);
  if (existsSync(localPath) && readdirSync(localPath).length > 0) {
    throw new Error(`Checkout destination is not empty: ${localPath}`);
  }
  mkdirSync(path.dirname(localPath), { recursive: true });
  execFileSync('git', ['clone', '--branch', binding.default_branch, '--', binding.remote_url, localPath], {
    stdio: 'pipe',
    timeout: 120_000,
  });
  return handleCheckoutRegister({
    project_repository_id: binding.id, machine_id: machineId, local_path: localPath,
    status: 'active', metadata: { bootstrapped_from: binding.remote_url },
  });
}

export const definitions: Tool[] = [
  {
    name: 'repository_register',
    description: 'Register or update a physical repository under one logical product project. Idempotent by project + repository name.',
    annotations: { title: 'Repository: Register', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer' }, name: { type: 'string' },
        local_path: { type: ['string', 'null'] }, remote_url: { type: ['string', 'null'] },
        default_branch: { type: 'string', default: 'main' }, integration_branch: { type: 'string', default: 'dev' },
        role: { type: 'string', default: 'component' }, docs_root: { type: ['string', 'null'] },
        status: { type: 'string', enum: [...STATUS], default: 'active' },
      },
      required: ['project_id', 'name'],
    },
  },
  {
    name: 'repository_list',
    description: 'List all physical repositories attached to a logical product project.',
    annotations: { title: 'Repository: List', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'integer' }, status: { type: 'string', enum: [...STATUS] } },
      required: ['project_id'],
    },
  },
  {
    name: 'repository_get',
    description: 'Get one project repository binding including local workspace and branch settings.',
    annotations: { title: 'Repository: Get', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'repository_update',
    description: 'Update a project repository binding or its repository identity.',
    annotations: { title: 'Repository: Update', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' }, name: { type: 'string' }, local_path: { type: ['string', 'null'] },
        remote_url: { type: ['string', 'null'] }, default_branch: { type: 'string' },
        integration_branch: { type: 'string' }, role: { type: 'string' },
        docs_root: { type: ['string', 'null'] }, status: { type: 'string', enum: [...STATUS] },
      },
      required: ['id'],
    },
  },
  {
    name: 'repository_checkout_register',
    description: 'Register this machine checkout for a product repository. Idempotent per repository + machine.',
    annotations: { title: 'Repository Checkout: Register', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        project_repository_id: { type: 'integer' }, machine_id: { type: 'string' },
        local_path: { type: 'string' }, status: { type: 'string', enum: ['active','missing','on_hold'] },
        metadata: { type: 'object' },
      },
      required: ['project_repository_id','machine_id','local_path'],
    },
  },
  {
    name: 'repository_checkout_list',
    description: 'List machine-specific repository checkouts.',
    annotations: { title: 'Repository Checkout: List', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'integer' }, machine_id: { type: 'string' } },
    },
  },
  {
    name: 'repository_checkout_bootstrap',
    description: 'Clone a planned repository remote into an explicitly provided empty path, then register the machine checkout.',
    annotations: { title: 'Repository Checkout: Bootstrap', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        project_repository_id: { type: 'integer' }, machine_id: { type: 'string' },
        local_path: { type: 'string' },
      },
      required: ['project_repository_id','machine_id','local_path'],
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  repository_register: handleRepositoryRegister,
  repository_list: handleRepositoryList,
  repository_get: handleRepositoryGet,
  repository_update: handleRepositoryUpdate,
  repository_checkout_register: handleCheckoutRegister,
  repository_checkout_list: handleCheckoutList,
  repository_checkout_bootstrap: handleCheckoutBootstrap,
};
