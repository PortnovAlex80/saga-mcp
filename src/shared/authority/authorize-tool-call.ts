/**
 * Strict Saga MCP authority gateway (D1.1 correction).
 *
 * Managed executions are fail-closed. A tool call is authorized only after the
 * execution row, immutable execution_context, policy version, authority hash,
 * context hash, task binding, and optional task/worker identity all validate.
 * execution_context with authority=null also remains compatibility-allowed.
 */
import type { Database } from 'better-sqlite3';
import {
  authorityHash,
  executionContextHash,
  EXECUTION_CONTEXT_POLICY_VERSION,
  type ExecutionAuthority,
  type ExecutionContextSnapshot,
  type ExecutionContextExecutorKind,
  type ExecutionModelRoute,
  type ExecutionRoutePolicyRef,
} from './execution-context.js';

/**
 * Policy versions the gateway accepts. v1 snapshots (no executor_kind /
 * route_policy) are still honored for in-flight executions started before the
 * routing cutover; every NEW claim produces v2. Adding a version here is the
 * ONLY change needed to accept a new shape — the structural hash check still
 * guards integrity because {@link executionContextHash} hashes whatever shape
 * was stored.
 */
const ACCEPTED_POLICY_VERSIONS = new Set<string>([
  EXECUTION_CONTEXT_POLICY_VERSION, // v2
  'factory.execution.v1',           // legacy
]);

export type AuthorizationDecision =
  | { allow: true; advisory?: boolean; observation?: string; executionId?: string }
  | { allow: false; code: 'AUTHORITY_DENIED'; details: AuthorityDeniedDetails }
  | { allow: false; code: 'AUTHORITY_CONTEXT_INVALID'; details: AuthorityContextInvalidDetails };

export interface AuthorityDeniedDetails {
  execution_id: string;
  work_intent_id: number | null;
  requested_tool: string;
  allowed_tools: string[];
  policy_version: string;
  recovery: string;
}

export interface AuthorityContextInvalidDetails {
  execution_id: string | null;
  requested_tool: string;
  reason: string;
  recovery: string;
}

export interface AuthorizeSagaToolCallInput {
  toolName: string;
  db: Database;
  executionId?: string;
  managedExecution?: string;
  taskId?: string;
  workerId?: string;
}

/**
 * Resolve the Saga MCP catalog visible to the current process.
 *
 * snapshots). A Set means a managed Saga 3 execution and contains the exact
 * frozen allow-list. An empty Set is fail-closed for malformed or stale
 * managed identity.
 *
 * This is deliberately separate from call authorization: catalog filtering
 * reduces weak-model cognitive load, while {@link authorizeSagaToolCall}
 * remains the mandatory security boundary on every call.
 */
export function visibleSagaToolNames(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> | null {
  const marker = env.SAGA_MANAGED_EXECUTION;
  const executionId = env.SAGA_EXECUTION_ID;

  if (marker === undefined) {
    return executionId ? new Set<string>() : null;
  }
  if (marker === '0') {
    return executionId ? new Set<string>() : null;
  }
  if (marker !== '1' || !executionId) {
    return new Set<string>();
  }

  const strict = readExecutionContextStrict(db, executionId);
  if (!strict.ok) return new Set<string>();
  if (env.SAGA_TASK_ID !== undefined
      && String(strict.row.task_id) !== String(env.SAGA_TASK_ID)) {
    return new Set<string>();
  }
  if (env.SAGA_WORKER_ID !== undefined
      && strict.row.worker_id !== env.SAGA_WORKER_ID) {
    return new Set<string>();
  }

  const authority = strict.snapshot.authority;
  return authority === null
    ? null
    : new Set(authority.allowed_saga_tools);
}

interface ExecutionRow {
  metadata: string;
  task_id: number;
  worker_id: string;
  epic_id: number;
  task_kind: string | null;
  task_work_intent_id: number | null;
}

export type StrictExecutionContextRead =
  | { ok: true; snapshot: ExecutionContextSnapshot; row: ExecutionRow }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseModelRoute(raw: unknown): ExecutionModelRoute | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.provider !== 'string' || raw.provider.trim() === '') return null;
  if (!(raw.model === null || typeof raw.model === 'string')) return null;
  if (!(raw.effort === null || typeof raw.effort === 'string')) return null;
  return { provider: raw.provider, model: raw.model, effort: raw.effort };
}

/**
 * Parse the v2 `route_policy` citation. Returns null for absent/malformed
 * values (v1 snapshots omit it entirely). A present-but-malformed value fails
 * closed by returning null only when the shape is wrong, which the validator
 * then excludes from the structural hash.
 */
function parseRoutePolicy(raw: unknown): ExecutionRoutePolicyRef | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return null;
  if (typeof raw.ref !== 'string' || raw.ref.trim() === '') return null;
  if (typeof raw.digest !== 'string' || raw.digest.trim() === '') return null;
  return { ref: raw.ref, digest: raw.digest };
}

function parseAuthority(raw: unknown, topLevelIntentId: number | null): ExecutionAuthority | null | undefined {
  if (raw === null) return topLevelIntentId === null ? null : undefined;
  if (!isRecord(raw)) return undefined;
  if (raw.enforcement !== 'runtime' && raw.enforcement !== 'advisory') return undefined;
  if (!Array.isArray(raw.allowed_saga_tools)) return undefined;
  if (!raw.allowed_saga_tools.every(x => typeof x === 'string' && x.trim() !== '')) return undefined;
  const allowed = raw.allowed_saga_tools as string[];
  if (new Set(allowed).size !== allowed.length) return undefined;
  if (typeof raw.scope !== 'string' || raw.scope.trim() === '') return undefined;
  if (typeof raw.snapshot_ref !== 'string' || raw.snapshot_ref.trim() === '') return undefined;
  if (!Number.isInteger(raw.work_intent_id)) return undefined;
  if (raw.work_intent_id !== topLevelIntentId) return undefined;
  if (!isHex64(raw.authority_hash)) return undefined;
  const authority: ExecutionAuthority = {
    enforcement: raw.enforcement,
    allowed_saga_tools: [...allowed],
    scope: raw.scope,
    snapshot_ref: raw.snapshot_ref,
    work_intent_id: raw.work_intent_id as number,
    authority_hash: raw.authority_hash,
  };
  const expected = authorityHash({
    enforcement: authority.enforcement,
    allowed_saga_tools: authority.allowed_saga_tools,
    scope: authority.scope,
    snapshot_ref: authority.snapshot_ref,
    work_intent_id: authority.work_intent_id,
  });
  return expected === authority.authority_hash ? authority : undefined;
}

export function readExecutionContextStrict(
  db: Database,
  executionId: string,
): StrictExecutionContextRead {
  const row = db.prepare(
    `SELECT we.metadata, we.task_id, we.worker_id, we.epic_id,
            t.task_kind,
            json_extract(t.metadata, '$.work_intent_id') AS task_work_intent_id
       FROM worker_executions we
       LEFT JOIN tasks t ON t.id=we.task_id
      WHERE we.execution_id=?`,
  ).get(executionId) as ExecutionRow | undefined;
  if (!row) return { ok: false, reason: 'execution row not found' };
  if (row.task_kind === undefined) return { ok: false, reason: 'execution task not found' };

  let envelope: unknown;
  try { envelope = JSON.parse(row.metadata); }
  catch { return { ok: false, reason: 'worker_executions.metadata is not valid JSON' }; }
  if (!isRecord(envelope)) return { ok: false, reason: 'execution metadata must be an object' };
  if (!isHex64(envelope.execution_context_hash)) {
    return { ok: false, reason: 'execution_context_hash missing or malformed' };
  }
  if (!isRecord(envelope.execution_context)) {
    return { ok: false, reason: 'execution_context missing or malformed' };
  }

  const raw = envelope.execution_context;
  if (typeof raw.policy_version !== 'string' || !ACCEPTED_POLICY_VERSIONS.has(raw.policy_version)) {
    return { ok: false, reason: `unsupported policy_version '${String(raw.policy_version)}'` };
  }
  const workIntentId = raw.work_intent_id === null
    ? null
    : Number.isInteger(raw.work_intent_id) ? raw.work_intent_id as number : undefined;
  if (workIntentId === undefined) return { ok: false, reason: 'work_intent_id must be integer|null' };
  if (typeof raw.captured_at !== 'string' || raw.captured_at.trim() === '') {
    return { ok: false, reason: 'captured_at missing or malformed' };
  }
  const modelRoute = parseModelRoute(raw.model_route);
  if (!modelRoute) return { ok: false, reason: 'model_route missing or malformed' };
  const authority = parseAuthority(raw.authority, workIntentId);
  if (authority === undefined) return { ok: false, reason: 'authority missing, malformed, or hash-mismatched' };

  // executor_kind / route_policy are v2-only. On a v1 snapshot they are absent;
  // we treat them as the v1 default (claude-cli, no policy citation). The
  // structural hash below is computed over the EXACT stored shape (whatever
  // fields are present), so v1 snapshots still validate.
  const executorKind = typeof raw.executor_kind === 'string'
    ? (raw.executor_kind as ExecutionContextExecutorKind)
    : 'claude-cli';
  const routePolicy = parseRoutePolicy(raw.route_policy);

  const snapshot: ExecutionContextSnapshot = {
    policy_version: raw.policy_version as typeof EXECUTION_CONTEXT_POLICY_VERSION,
    work_intent_id: workIntentId,
    authority,
    model_route: modelRoute,
    executor_kind: executorKind,
    route_policy: routePolicy,
    captured_at: raw.captured_at,
  };
  // Reconstruct the stored shape for hash verification. For v1 snapshots, omit
  // executor_kind/route_policy so the hash matches what was persisted.
  const hashInput: Record<string, unknown> = {
    policy_version: snapshot.policy_version,
    work_intent_id: snapshot.work_intent_id,
    authority,
    model_route: snapshot.model_route,
    captured_at: snapshot.captured_at,
  };
  if (raw.executor_kind !== undefined) hashInput.executor_kind = snapshot.executor_kind;
  if (raw.route_policy !== undefined) hashInput.route_policy = snapshot.route_policy;
  const expectedContextHash = executionContextHash(hashInput);
  if (expectedContextHash !== envelope.execution_context_hash) {
    return { ok: false, reason: 'execution_context_hash mismatch' };
  }

  if (row.task_work_intent_id == null) {
    if (authority !== null || workIntentId !== null) {
      return { ok: false, reason: 'task has no WorkIntent binding but snapshot grants Saga 3 authority' };
    }
  } else {
    if (!authority || workIntentId !== row.task_work_intent_id) {
      return { ok: false, reason: 'task WorkIntent binding does not match execution snapshot' };
    }
  }

  return { ok: true, snapshot, row };
}

function invalid(toolName: string, executionId: string | null, reason: string): AuthorizationDecision {
  return {
    allow: false,
    code: 'AUTHORITY_CONTEXT_INVALID',
    details: {
      execution_id: executionId,
      requested_tool: toolName,
      reason,
      recovery: 'Stop this execution and let the controller create or recover a valid immutable execution context. The worker cannot repair or expand its own authority.',
    },
  };
}

export function authorizeSagaToolCall(input: AuthorizeSagaToolCallInput): AuthorizationDecision {
  const explicitExecutionId = input.executionId !== undefined;
  const executionId = input.executionId ?? process.env.SAGA_EXECUTION_ID;
  const marker = input.managedExecution
    ?? (explicitExecutionId ? '1' : process.env.SAGA_MANAGED_EXECUTION);
  const taskId = input.taskId ?? process.env.SAGA_TASK_ID;
  const workerId = input.workerId ?? process.env.SAGA_WORKER_ID;

  if (marker === undefined) {
    return executionId
      ? invalid(input.toolName, executionId, 'SAGA_EXECUTION_ID is present without SAGA_MANAGED_EXECUTION=1')
      : { allow: true };
  }
  if (marker !== '0' && marker !== '1') {
    return invalid(input.toolName, executionId ?? null, `invalid SAGA_MANAGED_EXECUTION='${marker}'`);
  }
  if (marker === '0') {
    return executionId
      ? invalid(input.toolName, executionId, 'non-managed process must not carry SAGA_EXECUTION_ID')
      : { allow: true };
  }
  if (!executionId) {
    return invalid(input.toolName, null, 'managed execution is missing SAGA_EXECUTION_ID');
  }

  const strict = readExecutionContextStrict(input.db, executionId);
  if (!strict.ok) return invalid(input.toolName, executionId, strict.reason);
  if (taskId !== undefined && String(strict.row.task_id) !== String(taskId)) {
    return invalid(input.toolName, executionId, `SAGA_TASK_ID ${taskId} does not match execution task ${strict.row.task_id}`);
  }
  if (workerId !== undefined && strict.row.worker_id !== workerId) {
    return invalid(input.toolName, executionId, `SAGA_WORKER_ID '${workerId}' does not match execution worker '${strict.row.worker_id}'`);
  }

  const authority = strict.snapshot.authority;
  if (!authority) return invalid(input.toolName, executionId, 'execution snapshot is missing authority');
  if (authority.enforcement === 'advisory') {
    const allowed = authority.allowed_saga_tools.includes(input.toolName);
    return {
      allow: true,
      advisory: true,
      executionId,
      observation: allowed
        ? `advisory authority: '${input.toolName}' is allowed`
        : `advisory authority: '${input.toolName}' is NOT in allowed_tools but enforcement=advisory`,
    };
  }
  if (authority.allowed_saga_tools.includes(input.toolName)) {
    return { allow: true, executionId };
  }
  return {
    allow: false,
    code: 'AUTHORITY_DENIED',
    details: {
      execution_id: executionId,
      work_intent_id: authority.work_intent_id,
      requested_tool: input.toolName,
      allowed_tools: authority.allowed_saga_tools,
      policy_version: strict.snapshot.policy_version,
      recovery: 'The controller must issue a new WorkIntent with the required authority. The worker cannot expand its own authority.',
    },
  };
}
