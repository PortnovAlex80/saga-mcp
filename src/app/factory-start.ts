import type Database from 'better-sqlite3';

export const FACTORY_START_SCHEMA = 'saga.factory-start.v1' as const;

export type FactoryStartCommand =
  | { readonly kind: 'resume'; readonly projectId: number }
  | { readonly kind: 'new'; readonly ideaUrl: string; readonly idempotencyKey?: string }
  | { readonly kind: 'new_start'; readonly projectId: number; readonly idempotencyKey?: string };

export class FactoryStartError extends Error {
  constructor(
    readonly code:
      | 'FACTORY_START_SELECTOR_REQUIRED'
      | 'FACTORY_START_SELECTOR_CONFLICT'
      | 'FACTORY_START_UNKNOWN_FIELD'
      | 'FACTORY_PROJECT_ID_INVALID'
      | 'FACTORY_IDEA_URL_INVALID'
      | 'FACTORY_PROJECT_NOT_FOUND'
      | 'FACTORY_RUN_NOT_RESUMABLE'
      | 'FACTORY_PROJECT_AMBIGUOUS',
    message: string,
  ) {
    super(message);
    this.name = 'FactoryStartError';
  }
}

/**
 * Decode the sole public factory-start contract.  Technical launch coordinates
 * are deliberately not accepted; they are durable server-owned state.
 */
export function decodeFactoryStartCommand(
  value: unknown,
): FactoryStartCommand {
  if (!isRecord(value)) {
    throw new FactoryStartError(
      'FACTORY_START_SELECTOR_REQUIRED',
      'body must contain exactly one of project_id or idea_url',
    );
  }
  const allowed = new Set(['project_id', 'idea_url', 'mode', 'idempotency_key']);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new FactoryStartError(
      'FACTORY_START_UNKNOWN_FIELD',
      `unsupported factory start field(s): ${unknown.join(', ')}`,
    );
  }
  const hasProject = Object.hasOwn(value, 'project_id');
  const hasIdeaUrl = Object.hasOwn(value, 'idea_url');
  if (hasProject === hasIdeaUrl) {
    throw new FactoryStartError(
      hasProject
        ? 'FACTORY_START_SELECTOR_CONFLICT'
        : 'FACTORY_START_SELECTOR_REQUIRED',
      'pass exactly one of project_id or idea_url',
    );
  }
  // Optional client-supplied start-command idempotency key. When absent the
  // starter mints a per-start key. Source bytes are NOT idempotency (§3).
  const idempotencyKey = typeof value.idempotency_key === 'string'
    && value.idempotency_key.trim().length > 0
      ? value.idempotency_key.trim()
      : undefined;
  if (hasProject) {
    const projectId = Number(value.project_id);
    if (!Number.isSafeInteger(projectId) || projectId < 1) {
      throw new FactoryStartError(
        'FACTORY_PROJECT_ID_INVALID',
        'project_id must be a positive integer',
      );
    }
    // mode disambiguates resume (continue existing run) vs new_start (intentional
    // new Factory Run for the same Project — CONVEYOR v4.3 §7). Default is resume
    // for backward compatibility.
    const mode = typeof value.mode === 'string' ? value.mode : 'resume';
    if (mode === 'new_start') {
      return { kind: 'new_start', projectId, idempotencyKey };
    }
    if (mode !== 'resume') {
      throw new FactoryStartError(
        'FACTORY_START_UNKNOWN_FIELD',
        `mode must be 'resume' or 'new_start', got '${mode}'`,
      );
    }
    return { kind: 'resume', projectId };
  }
  const rawUrl = value.idea_url;
  if (typeof rawUrl !== 'string') {
    throw new FactoryStartError(
      'FACTORY_IDEA_URL_INVALID',
      'idea_url must be an HTTPS URL',
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new FactoryStartError(
      'FACTORY_IDEA_URL_INVALID',
      'idea_url must be an HTTPS URL',
    );
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new FactoryStartError(
      'FACTORY_IDEA_URL_INVALID',
      'idea_url must use HTTPS and must not contain credentials',
    );
  }
  url.hash = '';
  return { kind: 'new', ideaUrl: url.toString(), idempotencyKey };
}

export interface FactoryResumeTarget {
  readonly projectId: number;
  readonly epicId: number;
  readonly lifecycleRunId: number;
  readonly idempotencyKey: string;
  readonly status: 'created' | 'running' | 'paused';
  readonly orderRef: string | null;
}

/** Resolve, but never invent, the exact durable run for a project resume. */
export function resolveFactoryResumeTarget(
  db: Database.Database,
  projectId: number,
): FactoryResumeTarget {
  const project = db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
  if (!project) {
    throw new FactoryStartError(
      'FACTORY_PROJECT_NOT_FOUND',
      `project ${projectId} does not exist`,
    );
  }
  const rows = db.prepare(
    `SELECT lr.id AS lifecycle_run_id, lr.epic_id, lr.idempotency_key,
            lr.status, fo.order_ref
       FROM factory_lifecycle_runs lr
       LEFT JOIN factory_orders fo ON fo.lifecycle_run_id=lr.id
      WHERE lr.project_id=?
        AND lr.status IN ('created','running','paused')
      ORDER BY lr.id DESC`,
  ).all(projectId) as Array<{
    lifecycle_run_id: number;
    epic_id: number | null;
    idempotency_key: string;
    status: 'created' | 'running' | 'paused';
    order_ref: string | null;
  }>;
  if (rows.length === 0) {
    throw new FactoryStartError(
      'FACTORY_RUN_NOT_RESUMABLE',
      `project ${projectId} has no resumable factory run`,
    );
  }
  if (rows.length !== 1 || rows[0]!.epic_id === null) {
    throw new FactoryStartError(
      'FACTORY_PROJECT_AMBIGUOUS',
      `project ${projectId} does not resolve to exactly one resumable factory order`,
    );
  }
  const row = rows[0]!;
  return {
    projectId,
    epicId: row.epic_id!,
    lifecycleRunId: row.lifecycle_run_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    orderRef: row.order_ref,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
