/**
 * authorizeSagaToolCall — the MCP gateway that enforces a frozen execution
 * authority on every Saga tool call (D1.1).
 *
 * The gateway is the ONLY runtime enforcement point for Saga 3 authority. The
 * worker's `--disallowedTools` (defense in depth) and the skill prompt are NOT
 * the authority source — the kernel grants authority via the immutable
 * execution snapshot captured at claim, and THIS function checks it.
 *
 * Decision matrix (processed in order, first match wins):
 *
 *   1. No `SAGA_EXECUTION_ID` in env         → compatibility allow
 *      (interactive CLI, direct saga-tool call, or a process that is not a
 *      managed worker execution. The gateway cannot attribute the call to an
 *      execution, so it does not enforce.)
 *
 *   2. Execution row has no `execution_context`
 *      (legacy execution written before D1.1, or a non-saga3 managed run)
 *      → compatibility allow
 *
 *   3. `authority === null`                  → compatibility allow
 *      (Saga 2 managed execution: the task had no work_intent_id, so no
 *      authority was frozen. Saga 2 stays unenforced.)
 *
 *   4. `enforcement === 'advisory'`          → allow + advisory observation
 *      (declared but not yet enforced; logged for audit)
 *
 *   5. `enforcement === 'runtime'`:
 *      - tool ∈ allowed_saga_tools           → allow
 *      - tool ∉ allowed_saga_tools           → DENY (AUTHORITY_DENIED)
 *
 * Default-deny for Saga 3 runtime: a Saga tool added to the registry later is
 * automatically denied until explicitly listed in some WorkIntent's
 * allowed_tools. The worker cannot expand its own authority; only a new
 * WorkIntent (issued by the kernel) can.
 *
 * Scope: ONLY the Saga MCP tool surface (the registered ALL_HANDLERS). Built-in
 * claude tools, filesystem, shell, git, network, subagents are separate
 * authority surfaces of future slices — this gateway does not touch them.
 */
import type { Database } from 'better-sqlite3';
import {
  EXECUTION_CONTEXT_POLICY_VERSION,
  type ExecutionContextSnapshot,
  type ExecutionAuthority,
  type ExecutionModelRoute,
} from '../domain/execution-context.js';

/** Authorization outcome. `allow:false` carries an actionable denial. */
export type AuthorizationDecision =
  | { allow: true; advisory?: boolean; observation?: string; executionId?: string }
  | {
      allow: false;
      code: 'AUTHORITY_DENIED';
      details: AuthorityDeniedDetails;
    };

export interface AuthorityDeniedDetails {
  execution_id: string;
  work_intent_id: number | null;
  requested_tool: string;
  allowed_tools: string[];
  policy_version: string;
  recovery: string;
}

export interface AuthorizeSagaToolCallInput {
  /** Short Saga tool name as delivered by the MCP SDK (e.g. 'task_get'). */
  toolName: string;
  /** Open saga DB handle (the gateway reads the frozen snapshot row). */
  db: Database;
  /**
   * Execution id identifying the calling execution. Defaults to
   * `process.env.SAGA_EXECUTION_ID`. Injected in tests.
   */
  executionId?: string;
}

/**
 * Read the frozen execution_context for an execution id, or null if the row is
 * absent / has no execution_context (legacy). Exposed for testing.
 */
export function readExecutionContext(
  db: Database,
  executionId: string,
): ExecutionContextSnapshot | null {
  const row = db.prepare(
    'SELECT metadata FROM worker_executions WHERE execution_id=?',
  ).get(executionId) as { metadata: string } | undefined;
  if (!row || !row.metadata) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.metadata);
  } catch {
    return null;
  }
  const ctx = parsed.execution_context;
  if (!ctx || typeof ctx !== 'object') return null;
  return normalizeSnapshot(ctx as Record<string, unknown>);
}

function normalizeSnapshot(raw: Record<string, unknown>): ExecutionContextSnapshot | null {
  const authorityRaw = raw.authority;
  let authority: ExecutionAuthority | null = null;
  if (authorityRaw && typeof authorityRaw === 'object') {
    const a = authorityRaw as Record<string, unknown>;
    const allowed = Array.isArray(a.allowed_saga_tools)
      ? (a.allowed_saga_tools as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    authority = {
      enforcement: a.enforcement === 'runtime' ? 'runtime' : 'advisory',
      allowed_saga_tools: allowed,
      scope: typeof a.scope === 'string' ? a.scope : '',
      snapshot_ref: typeof a.snapshot_ref === 'string' ? a.snapshot_ref : '',
      work_intent_id:
        typeof a.work_intent_id === 'number' ? a.work_intent_id : null,
      authority_hash: typeof a.authority_hash === 'string' ? a.authority_hash : '',
    };
  }
  const mr = (raw.model_route ?? {}) as Record<string, unknown>;
  const model_route: ExecutionModelRoute = {
    provider: typeof mr.provider === 'string' ? mr.provider : 'zai',
    model: typeof mr.model === 'string' ? mr.model : null,
    effort: typeof mr.effort === 'string' ? mr.effort : null,
  };
  return {
    policy_version:
      typeof raw.policy_version === 'string'
        ? (raw.policy_version as typeof EXECUTION_CONTEXT_POLICY_VERSION)
        : EXECUTION_CONTEXT_POLICY_VERSION,
    work_intent_id:
      typeof raw.work_intent_id === 'number' ? raw.work_intent_id : null,
    authority,
    model_route,
    captured_at: typeof raw.captured_at === 'string' ? raw.captured_at : '',
  };
}

/**
 * Decide whether a Saga tool call is authorized under the calling execution's
 * frozen authority. See module doc for the decision matrix.
 */
export function authorizeSagaToolCall(input: AuthorizeSagaToolCallInput): AuthorizationDecision {
  const executionId = input.executionId ?? process.env.SAGA_EXECUTION_ID;
  // (1) No managed-execution identity → cannot attribute → compatibility allow.
  if (!executionId) return { allow: true };

  const snapshot = readExecutionContext(input.db, executionId);
  // (2) Legacy execution row without an execution_context → compatibility allow.
  if (!snapshot) return { allow: true, executionId };

  const authority = snapshot.authority;
  // (3) Saga 2 managed execution (no WorkIntent bound) → compatibility allow.
  if (!authority) return { allow: true, executionId };

  // (4) Advisory: declared but not enforced. Allow, surface an observation.
  if (authority.enforcement === 'advisory') {
    const allowed = authority.allowed_saga_tools.includes(input.toolName);
    return {
      allow: true,
      advisory: true,
      executionId,
      observation: allowed
        ? `advisory authority: '${input.toolName}' is allowed`
        : `advisory authority: '${input.toolName}' is NOT in allowed_tools but enforcement=advisory (not blocked)`,
    };
  }

  // (5) Runtime enforcement — default deny.
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
      policy_version: EXECUTION_CONTEXT_POLICY_VERSION,
      recovery:
        'The controller must issue a new WorkIntent with the required authority. ' +
        'The worker cannot expand its own authority.',
    },
  };
}
