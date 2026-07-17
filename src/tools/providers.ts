// src/tools/providers.ts
//
// REQ-012 — Trusted Provider Registry.
//
// Catalogues the Trusted Guard Input Providers that are allowed to feed
// evidence/state/decisions into a project's acceptance oracle. A provider is
// either global (project_id IS NULL — applies to every project) or scoped to
// one project. The three categories mirror the CGAD trust tiers:
//   deterministic_evidence — fully deterministic verifiers (tsc, eslint, jest).
//                            determinism='full'. These feed verification_evidence.
//   authoritative_state    — stateful systems of record (CI run status, git
//                            merge result, a release manager). determinism is
//                            'partial' (reproducible only given the same state).
//   authorized_decision    — a human-in-the-loop or policy decision (release
//                            approval, security sign-off). determinism='none'.
//
// Tools:
//   - provider_register: register a new Trusted Provider. Idempotent on
//     UNIQUE(project_id, name) — re-registering the same (project_id, name)
//     returns the existing row instead of throwing (INSERT OR IGNORE). This
//     matches the dispatch-time convention: a worker that needs to confirm a
//     provider exists should be able to call this without racing itself.
//   - provider_list: list providers for a project. ALWAYS includes the global
//     registry (project_id IS NULL) so callers see inherited providers.
//     Filterable by category, layer, status.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from '../db.js';
import { logActivity } from '../helpers/activity-logger.js';
import type { TrustedProvider } from '../types.js';
import type { ToolHandler } from '../types.js';

const CATEGORIES = [
  'deterministic_evidence',
  'authoritative_state',
  'authorized_decision',
] as const;
type ProviderCategory = typeof CATEGORIES[number];

const DETERMINISMS = ['full', 'partial', 'none'] as const;
type Determinism = typeof DETERMINISMS[number];

const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
type Layer = typeof LAYERS[number];

const STATUSES = ['active', 'disabled', 'deprecated'] as const;

function isCategory(v: unknown): v is ProviderCategory {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}
function isDeterminism(v: unknown): v is Determinism {
  return typeof v === 'string' && (DETERMINISMS as readonly string[]).includes(v);
}
function isLayer(v: unknown): v is Layer {
  return typeof v === 'string' && (LAYERS as readonly string[]).includes(v);
}
function isStatus(v: unknown): v is typeof STATUSES[number] {
  return typeof v === 'string' && (STATUSES as readonly string[]).includes(v);
}

function handleProviderRegister(args: Record<string, unknown>) {
  const db = getDb();
  // project_id is nullable — null means a GLOBAL provider. We read it before
  // the switch below so the validation step can distinguish "omitted" from
  // "explicitly null". For provider_register we treat both as global (the
  // registry's calling convention is "no project_id → global").
  const rawProjectId = args.project_id;
  let projectId: number | null;
  if (rawProjectId == null) {
    projectId = null;
  } else {
    const n = Number(rawProjectId);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('project_id must be a positive integer or null (global)');
    }
    projectId = n;
  }
  const category = args.category;
  const name = args.name;
  const trustBasis = args.trust_basis;
  const determinism = args.determinism;
  const scope = args.scope;
  const layer = args.layer;
  const version = args.version;
  const configPath = args.config_path;
  const status = (args.status as string | undefined) ?? 'active';

  if (!isCategory(category)) {
    throw new Error(
      `Invalid category '${category}' (expected one of: ${CATEGORIES.join(', ')})`,
    );
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('name is required (non-empty string)');
  }
  if (!trustBasis || typeof trustBasis !== 'string' || !trustBasis.trim()) {
    throw new Error('trust_basis is required (non-empty string)');
  }
  if (!isDeterminism(determinism)) {
    throw new Error(
      `Invalid determinism '${determinism}' (expected one of: ${DETERMINISMS.join(', ')})`,
    );
  }
  if (!scope || typeof scope !== 'string' || !scope.trim()) {
    throw new Error('scope is required (non-empty string)');
  }
  if (layer != null && !isLayer(layer)) {
    throw new Error(
      `Invalid layer '${layer}' (expected one of: ${LAYERS.join(', ')}, or null)`,
    );
  }
  if (!isStatus(status)) {
    throw new Error(
      `Invalid status '${status}' (expected one of: ${STATUSES.join(', ')})`,
    );
  }

  // Cross-validate: if a project_id is given, it must exist. NULL (global) is
  // always valid — global providers are not tied to any project.
  if (projectId != null) {
    const project = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
  }

  // Idempotent on UNIQUE(project_id, name). INSERT OR IGNORE: a second
  // registration of the same (project_id, name) is a no-op that returns the
  // existing row. Callers that want to UPDATE fields (e.g. flip status to
  // 'deprecated') will use a dedicated update tool — register is for FIRST
  // appearance + idempotent re-confirmation.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO trusted_providers
       (project_id, category, name, trust_basis, determinism, scope,
        layer, version, config_path, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = insert.run(
    projectId,
    category,
    name,
    trustBasis,
    determinism,
    scope,
    layer ?? null,
    (version as string | undefined) ?? null,
    (configPath as string | undefined) ?? null,
    status,
  );

  // Always read back the canonical row — covers both the inserted and the
  // idempotent-reuse paths.
  const row = db
    .prepare(
      `SELECT * FROM trusted_providers WHERE project_id IS ? AND name=?`,
    )
    .get(projectId, name) as TrustedProvider;

  if (info.changes > 0) {
    logActivity(
      db,
      'project',
      projectId ?? 0,
      'created',
      'trusted_provider',
      null,
      category,
      `Trusted provider '${name}' registered (${category}, ${determinism})` +
        (projectId ? ` for project ${projectId}` : ' globally'),
    );
  }

  return { ...row, created: info.changes > 0 };
}

function handleProviderList(args: Record<string, unknown>) {
  const db = getDb();
  const rawProjectId = args.project_id;
  let projectId: number | null;
  if (rawProjectId == null) {
    projectId = null;
  } else {
    const n = Number(rawProjectId);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('project_id must be a positive integer or null (global only)');
    }
    projectId = n;
  }
  const category = args.category;
  const layer = args.layer;
  const status = (args.status as string | undefined) ?? 'active';

  if (category != null && !isCategory(category)) {
    throw new Error(
      `Invalid category '${category}' (expected one of: ${CATEGORIES.join(', ')})`,
    );
  }
  if (layer != null && !isLayer(layer)) {
    throw new Error(
      `Invalid layer '${layer}' (expected one of: ${LAYERS.join(', ')}, or null)`,
    );
  }
  if (status !== '__all__' && !isStatus(status)) {
    throw new Error(
      `Invalid status '${status}' (expected one of: ${STATUSES.join(', ')}, or '__all__')`,
    );
  }

  // Cross-validate the project exists (when given) so we never silently return
  // an empty list for a typo'd project_id.
  if (projectId != null) {
    const project = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
    if (!project) throw new Error(`Project ${projectId} not found`);
  }

  // Always include GLOBAL providers (project_id IS NULL) plus the
  // project-scoped ones when a project_id is given. When project_id is NULL we
  // list ONLY global providers (callers wanting every provider across every
  // project should use a separate admin tool — this one is per-project-scoped
  // by design, with global inheritance).
  const where: string[] = [];
  const params: unknown[] = [];
  if (projectId != null) {
    where.push('(project_id IS NULL OR project_id = ?)');
    params.push(projectId);
  } else {
    where.push('project_id IS NULL');
  }
  if (category != null) {
    where.push('category = ?');
    params.push(category);
  }
  if (layer != null) {
    where.push('layer = ?');
    params.push(layer);
  }
  if (status !== '__all__') {
    where.push('status = ?');
    params.push(status);
  }

  const rows = db
    .prepare(
      `SELECT * FROM trusted_providers
       WHERE ${where.join(' AND ')}
       ORDER BY project_id IS NOT NULL, category, name`,
    )
    .all(...params) as TrustedProvider[];

  return { providers: rows, count: rows.length };
}

export const definitions: Tool[] = [
  {
    name: 'provider_register',
    description:
      'REQ-012 — Register a new Trusted Provider in the Trusted Guard Input Provider registry. ' +
      'Categories: deterministic_evidence (full determinism, feeds verification_evidence), ' +
      'authoritative_state (partial — CI/git/release manager), authorized_decision (none — human/policy). ' +
      'project_id IS NULL means a GLOBAL provider (inherited by every project). ' +
      'Idempotent on UNIQUE(project_id, name): re-registering the same pair returns the existing row.',
    annotations: {
      title: 'Provider: Register',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: ['integer', 'null'],
          description: 'Project to scope the provider to. Omit or null for a GLOBAL provider (inherited by every project).',
        },
        category: { type: 'string', enum: [...CATEGORIES] },
        name: {
          type: 'string',
          description: 'Provider name. UNIQUE per project_id (or globally when project_id is null).',
        },
        trust_basis: {
          type: 'string',
          description: 'Why this provider is trusted (e.g. "deterministic type-checker", "release-manager role").',
        },
        determinism: { type: 'string', enum: [...DETERMINISMS] },
        scope: {
          type: 'string',
          description: 'What surface the provider covers (e.g. "TypeScript type errors", "merge to dev").',
        },
        layer: { type: 'string', enum: [...LAYERS], description: 'Optional CGAD L0..L4 stack layer.' },
        version: { type: 'string', description: 'Optional provider version (e.g. tsc 5.4).' },
        config_path: { type: 'string', description: 'Optional path to the provider config (e.g. tsconfig.json).' },
        status: { type: 'string', enum: [...STATUSES], default: 'active' },
      },
      required: ['category', 'name', 'trust_basis', 'determinism', 'scope'],
    },
  },
  {
    name: 'provider_list',
    description:
      'REQ-012 — List Trusted Providers for a project. ALWAYS includes GLOBAL providers (project_id IS NULL). ' +
      'When project_id is given, returns global + project-scoped providers. ' +
      'When project_id is omitted, returns ONLY global providers. ' +
      'Filterable by category, layer, status (default status=active; pass status="__all__" to include disabled/deprecated).',
    annotations: {
      title: 'Provider: List',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: ['integer', 'null'],
          description: 'Project scope. When given, returns global + this project\'s providers. Omit for global only.',
        },
        category: { type: 'string', enum: [...CATEGORIES] },
        layer: { type: 'string', enum: [...LAYERS] },
        status: {
          type: 'string',
          enum: [...STATUSES, '__all__'],
          default: 'active',
          description: 'Filter by status. "__all__" disables the status filter.',
        },
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  provider_register: handleProviderRegister,
  provider_list: handleProviderList,
};
