/**
 * Strict Saga MCP authority gateway.
 *
 * Managed executions are fail-closed. A tool call is authorized only after the
 * execution row, immutable execution_context, policy version, authority hash,
 * context hash, task binding, and optional task/worker identity all validate.
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
  type ExecutionReplayBinding,
  type ExecutionRoutePolicyRef,
} from './execution-context.js';
import { computeReplayKey, type ReplayKeyMaterial } from '../../replay/replay-capsule.js';

const ACCEPTED_POLICY_VERSIONS = new Set<string>([
  EXECUTION_CONTEXT_POLICY_VERSION,
  'factory.execution.v1',
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

export function visibleSagaToolNames(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> | null {
  const marker = env.SAGA_MANAGED_EXECUTION;
  const executionId = env.SAGA_EXECUTION_ID;
  if (marker === undefined) return executionId ? new Set<string>() : null;
  if (marker === '0') return executionId ? new Set<string>() : null;
  if (marker !== '1' || !executionId) return new Set<string>();

  const strict = readExecutionContextStrict(db, executionId);
  if (!strict.ok) return new Set<string>();
  if (env.SAGA_TASK_ID !== undefined
      && String(strict.row.task_id) !== String(env.SAGA_TASK_ID)) return new Set<string>();
  if (env.SAGA_WORKER_ID !== undefined
      && strict.row.worker_id !== env.SAGA_WORKER_ID) return new Set<string>();
  const authority = strict.snapshot.authority;
  return authority === null ? null : new Set(authority.allowed_saga_tools);
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

function parseExecutorKind(raw: unknown, policyVersion: string): ExecutionContextExecutorKind | null {
  if (policyVersion === 'factory.execution.v1') {
    return raw === undefined || raw === 'claude-cli' ? 'claude-cli' : null;
  }
  // CONVEYOR v4.3 PART 1,3,12: only the real CLI executor is supported.
  // Replay is an internal production source, NOT an executor kind.
  return raw === 'claude-cli' ? 'claude-cli' : null;
}

function parseModelRoute(
  raw: unknown,
  _executorKind: ExecutionContextExecutorKind,
): ExecutionModelRoute | null {
  if (!isRecord(raw)) return null;
  if (!(raw.provider === null || typeof raw.provider === 'string')) return null;
  if (!(raw.model === null || typeof raw.model === 'string')) return null;
  if (!(raw.effort === null || typeof raw.effort === 'string')) return null;

  // The normal claude-cli executor always carries a provider. Replay-bound
  // executions keep the frozen route intact as provenance — the executor
  // resolves the production source internally from replay.capsule_ref, so the
  // Gate cannot distinguish inference from replay (CONVEYOR v4.3 PART 1,2).
  if (typeof raw.provider !== 'string' || raw.provider.trim() === '') return null;
  if (typeof raw.model === 'string' && raw.model.trim() === '') return null;
  if (typeof raw.effort === 'string' && raw.effort.trim() === '') return null;
  return { provider: raw.provider, model: raw.model, effort: raw.effort };
}

function parseRoutePolicy(raw: unknown): ExecutionRoutePolicyRef | null {
  if (raw === null || raw === undefined) return null;
  if (!isRecord(raw)) return null;
  if (typeof raw.ref !== 'string' || raw.ref.trim() === '') return null;
  if (typeof raw.digest !== 'string' || raw.digest.trim() === '') return null;
  return { ref: raw.ref, digest: raw.digest };
}

function parseReplayKeyMaterial(raw: unknown): ReplayKeyMaterial | null {
  if (!isRecord(raw)) return null;
  const projectId = Number(raw.projectId);
  const role = raw.role;
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return null;
  if (role !== 'author' && role !== 'reviewer') return null;
  for (const key of ['moduleRef','nodeId','productionCellId','workKey','packageDigest'] as const) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).trim() === '') return null;
  }
  // semanticInputDigest is the cross-run-stable replay input identity (§8).
  // Accept the legacy nodeInputHash field name too for in-flight executions
  // frozen before the v4.3 rename, so a rolling deploy does not reject claims.
  const semanticInputDigest = typeof raw.semanticInputDigest === 'string'
    ? raw.semanticInputDigest
    : (typeof raw.nodeInputHash === 'string' ? raw.nodeInputHash : '');
  if (semanticInputDigest.trim() === '') return null;
  const subjectProductionDigest = typeof raw.subjectProductionDigest === 'string'
    ? raw.subjectProductionDigest
    : (typeof raw.subjectCandidateDigest === 'string' ? raw.subjectCandidateDigest : null);
  if (!(subjectProductionDigest === null || subjectProductionDigest.length > 0)) return null;
  return {
    projectId,
    moduleRef: raw.moduleRef as string,
    nodeId: raw.nodeId as string,
    productionCellId: raw.productionCellId as string,
    workKey: raw.workKey as string,
    role,
    packageDigest: raw.packageDigest as string,
    semanticInputDigest,
    subjectProductionDigest,
  };
}

function parseReplay(raw: unknown): ExecutionReplayBinding | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return undefined;
  if (typeof raw.key !== 'string' || !isHex64(raw.key)) return undefined;
  const keyMaterial = parseReplayKeyMaterial(raw.key_material);
  if (!keyMaterial || computeReplayKey(keyMaterial) !== raw.key) return undefined;
  if (!(raw.capsule_ref === null || (typeof raw.capsule_ref === 'string' && raw.capsule_ref.length > 0))) return undefined;
  if (!(raw.capsule_payload_hash === null || isHex64(raw.capsule_payload_hash))) return undefined;
  if ((raw.capsule_ref === null) !== (raw.capsule_payload_hash === null)) return undefined;
  return {
    key: raw.key,
    key_material: keyMaterial,
    capsule_ref: raw.capsule_ref as string | null,
    capsule_payload_hash: raw.capsule_payload_hash as string | null,
  };
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

export function readExecutionContextStrict(db: Database, executionId: string): StrictExecutionContextRead {
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
  if (!isHex64(envelope.execution_context_hash)) return { ok: false, reason: 'execution_context_hash missing or malformed' };
  if (!isRecord(envelope.execution_context)) return { ok: false, reason: 'execution_context missing or malformed' };

  const raw = envelope.execution_context;
  if (typeof raw.policy_version !== 'string' || !ACCEPTED_POLICY_VERSIONS.has(raw.policy_version)) {
    return { ok: false, reason: `unsupported policy_version '${String(raw.policy_version)}'` };
  }
  const policyVersion = raw.policy_version;
  const workIntentId = raw.work_intent_id === null
    ? null
    : Number.isInteger(raw.work_intent_id) ? raw.work_intent_id as number : undefined;
  if (workIntentId === undefined) return { ok: false, reason: 'work_intent_id must be integer|null' };
  if (typeof raw.captured_at !== 'string' || raw.captured_at.trim() === '') {
    return { ok: false, reason: 'captured_at missing or malformed' };
  }
  const executorKind = parseExecutorKind(raw.executor_kind, policyVersion);
  if (!executorKind) return { ok: false, reason: 'executor_kind missing, malformed, or incompatible with policy_version' };
  const modelRoute = parseModelRoute(raw.model_route, executorKind);
  if (!modelRoute) return { ok: false, reason: 'model_route missing, malformed, or incompatible with executor_kind' };
  const authority = parseAuthority(raw.authority, workIntentId);
  if (authority === undefined) return { ok: false, reason: 'authority missing, malformed, or hash-mismatched' };
  const routePolicy = parseRoutePolicy(raw.route_policy);
  const replay = parseReplay(raw.replay);
  if (replay === undefined) return { ok: false, reason: 'replay binding is malformed or key-mismatched' };
  // CONVEYOR v4.3 PART 1,2: a capsule hit (replay.capsule_ref != null) runs
  // under the SAME claude-cli executor as inference. The executor resolves the
  // production source internally — there is no simulator executor kind. The
  // frozen model_route stays intact as provenance, so the authorization path is
  // identical for inference and replay (the Gate cannot distinguish them).

  const snapshot: ExecutionContextSnapshot = {
    policy_version: raw.policy_version as typeof EXECUTION_CONTEXT_POLICY_VERSION,
    work_intent_id: workIntentId,
    authority,
    model_route: modelRoute,
    executor_kind: executorKind,
    route_policy: routePolicy,
    replay,
    captured_at: raw.captured_at,
  };

  const hashInput: Record<string, unknown> = {
    policy_version: snapshot.policy_version,
    work_intent_id: snapshot.work_intent_id,
    authority,
    model_route: snapshot.model_route,
    captured_at: snapshot.captured_at,
  };
  if (raw.executor_kind !== undefined) hashInput.executor_kind = snapshot.executor_kind;
  if (raw.route_policy !== undefined) hashInput.route_policy = snapshot.route_policy;
  if (raw.replay !== undefined) hashInput.replay = snapshot.replay;
  const expectedContextHash = executionContextHash(hashInput);
  if (expectedContextHash !== envelope.execution_context_hash) {
    return { ok: false, reason: 'execution_context_hash mismatch' };
  }

  // row.task_work_intent_id is typed `number | null`; the explicit null check
  // is eqeqeq-safe and equivalent to the original `== null` guard here.
  if (row.task_work_intent_id === null) {
    if (authority !== null || workIntentId !== null) {
      return { ok: false, reason: 'task has no WorkIntent binding but snapshot grants managed authority' };
    }
  } else if (!authority || workIntentId !== row.task_work_intent_id) {
    return { ok: false, reason: 'task WorkIntent binding does not match execution snapshot' };
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
  if (!executionId) return invalid(input.toolName, null, 'managed execution is missing SAGA_EXECUTION_ID');

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
  if (authority.allowed_saga_tools.includes(input.toolName)) return { allow: true, executionId };
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
