/**
 * W6-A4 — Optional agent-side PreToolUse projection.
 *
 * Spec: docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md §1 (W6-A4).
 * Plan: §0.9.6, §11.7, §14.8.4. Checklist: C038.
 *
 * PURPOSE
 *   An OPTIONAL, read-only projection of the server-side GatewayGuard (W6-A3).
 *   It runs in the agent/CLI surface BEFORE the MCP request reaches the saga
 *   server, so a call that would obviously be denied can be rejected without a
 *   round-trip. This is purely an optimization.
 *
 * AUTHORITY MODEL (§11.7 — load-bearing)
 *   Gateway guards are AUTHORITATIVE. This projection is NOT. Concretely:
 *     - A `deny` here is an EARLY rejection hint. The agent SHOULD honour it
 *       (the server would deny too), but the server guard remains the sole
 *       source of truth. Any discrepancy must be resolved in favour of the
 *       server, never this projection.
 *     - A `pass` (no early denial) carries ZERO authority. It does NOT mean the
 *       call is allowed — only that the projection has no basis to deny early.
 *       The server guard MUST still run and may still deny.
 *     - This projection MUST NEVER issue a positive `allow`. There is no
 *       `allow` outcome, only `deny` (early hint) or `pass` (defer to server).
 *
 *   C038: "Treat CLI PreToolUse denial as an optimization, not authority."
 *
 * ISOLATION NOTE (Wave 6 parallel lanes)
 *   The authoritative GatewayGuard (W6-A3, `application/gateway-guard.ts`) is
 *   built in a sibling lane and is NOT present in this isolated W6-A4 worktree.
 *   Importing it would fail `tsc`. We therefore mirror ONLY the structural
 *   fields the projection needs from the frozen authority snapshot — exactly
 *   the same structural-alias technique used by
 *   `process-modules/domain/spi/tool-contribution.ts` (`ToolContractRef`) and
 *   `production-envelope.ts`. A later integrator wave can swap the alias for
 *   the real import without touching call sites.
 *
 *   The mirrored shape matches `ExecutionAuthority` in
 *   `src/shared/authority/execution-context.ts` (enforcement + allowed_saga_tools
 *   + work_intent_id are the fields a PreToolUse projection consumes).
 *
 * This file is PURE: data types + a pure decision function. No I/O, no DB, no
 * side effects. The caller is responsible for sourcing the snapshot.
 */

// ---------------------------------------------------------------------------
// ProjectedAuthority — structural alias of ExecutionAuthority.
// ---------------------------------------------------------------------------

/**
 * The subset of `ExecutionAuthority` that a PreToolUse projection consumes.
 * Mirrors `src/shared/authority/execution-context.ts`:
 *   - `enforcement`            — 'advisory' | 'runtime'.
 *   - `allowed_saga_tools`     — frozen allow-list granted to this execution.
 *   - `work_intent_id`         — cited in the denial for traceability.
 *
 * `scope`, `snapshot_ref`, `authority_hash` are intentionally OMITTED: a
 * projection does not re-verify hashes (the server guard does that) and never
 * persists or forwards them. Including them would imply the projection audits
 * the snapshot, which would be authority semantics.
 */
export interface ProjectedAuthority {
  readonly enforcement: 'advisory' | 'runtime';
  readonly allowed_saga_tools: readonly string[];
  readonly work_intent_id: number | null;
}

/**
 * A pre-resolved projection input. The caller (CLI/agent host) obtains this
 * from the same immutable execution_context the server guard will later read,
 * then hands it to `projectPreToolUse`. The projection never opens the DB.
 *
 *   `executionId`  — the managed execution this projection is bound to.
 *                    snapshot (no WorkIntent) which the server compatibility-
 *                    allows; the projection therefore passes it through.
 *   `toolName`     — the MCP tool the agent is about to call.
 */
export interface PreToolUseProjectionInput {
  readonly executionId: string;
  readonly authority: ProjectedAuthority | null;
  readonly toolName: string;
}

// ---------------------------------------------------------------------------
// Decision outcomes.
// ---------------------------------------------------------------------------

/**
 * Early-denial hint. The projection detected that the server guard would
 * deny this call, so the agent can short-circuit without a round-trip.
 *
 *   `code`           — machine-readable denial category.
 *   `reason`         — human-readable explanation (for the agent's reasoning).
 *   `requestedTool`  — the tool that was denied.
 *   `allowedTools`   — snapshot of the allow-list, so the agent can pick a
 *                      permitted alternative without another query.
 *   `executionId`    — execution the denial is bound to.
 *   `authoritative`  — ALWAYS `false`. The server guard is authoritative
 *                      (§11.7); this hint is an optimization.
 *
 * The `authoritative: false` field is load-bearing: it lets every consumer
 * (and every test) assert that a projection denial is never treated as final.
 */
export interface PreToolUseDeny {
  readonly outcome: 'deny';
  readonly code: PreToolUseDenyCode;
  readonly reason: string;
  readonly requestedTool: string;
  readonly allowedTools: readonly string[];
  readonly executionId: string;
  readonly workIntentId: number | null;
  readonly authoritative: false;
}

export type PreToolUseDenyCode =
  | 'TOOL_NOT_IN_ALLOWED_TOOLS' // runtime enforcement + tool absent from list
  | 'AUTHORITY_CONTEXT_REQUIRED'
  | 'EMPTY_TOOL_NAME'; // caller bug: no tool to authorize

/**
 * No early denial. This is NOT an allow: it means the projection has no basis
 * to deny early and the call MUST still be evaluated by the authoritative
 * server guard. The `reason` records why the projection passed (e.g. advisory
 * agent's reasoning trace stays honest, but the `authoritative: false` field
 * reminds every consumer that the server is the source of truth.
 */
export interface PreToolUsePass {
  readonly outcome: 'pass';
  readonly reason: string;
  readonly requestedTool: string;
  readonly executionId: string;
  readonly authoritative: false;
}

export type PreToolUseProjectionResult = PreToolUseDeny | PreToolUsePass;

// ---------------------------------------------------------------------------
// Pure decision function.
// ---------------------------------------------------------------------------

/**
 * Project a PreToolUse decision WITHOUT authority.
 *
 * Decision table:
 *
 *   | authority | enforcement | toolName | tool in list | result  |
 *   |-----------|-------------|----------|--------------|---------|
 *   | any       | any         | empty    | (n/a)        | deny    |  EMPTY_TOOL_NAME
 *   | set       | advisory    | any      | yes/no       | pass    |  advisory = hint only
 *   | set       | runtime     | any      | yes          | pass    |  would be allowed
 *   | set       | runtime     | any      | no           | deny    |  TOOL_NOT_IN_ALLOWED_TOOLS
 *
 * Note on `advisory`: under advisory enforcement the server itself does NOT
 * hard-deny (it observes and allows). So a PreToolUse projection MUST NOT deny
 * under advisory either — doing so would make the projection STRICTER than the
 * authoritative guard, violating §11.7 (the projection cannot exceed server
 * authority in either direction). It therefore passes and lets the server
 * emit its advisory observation.
 */
export function projectPreToolUse(
  input: PreToolUseProjectionInput,
): PreToolUseProjectionResult {
  const { executionId, authority, toolName } = input;

  // Caller bug: no tool name. Deny early — but still non-authoritative; the
  // server guard would reject this for its own reasons.
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return {
      outcome: 'deny',
      code: 'EMPTY_TOOL_NAME',
      reason:
        'PreToolUse projection: toolName is empty. The server guard cannot authorize an unnamed tool.',
      requestedTool: '',
      allowedTools: authority ? authority.allowed_saga_tools : [],
      executionId,
      workIntentId: authority ? authority.work_intent_id : null,
      authoritative: false,
    };
  }

  // Every managed execution must carry an exact authority snapshot. Missing
  // authority is never an interactive compatibility mode.
  if (authority === null) {
    return {
      outcome: 'deny',
      code: 'AUTHORITY_CONTEXT_REQUIRED',
      reason:
        'PreToolUse projection: execution authority is missing; no tool may run without a fenced Workplace authority context.',
      requestedTool: toolName,
      allowedTools: [],
      executionId,
      workIntentId: null,
      authoritative: false,
    };
  }

  // Advisory enforcement: the server does not hard-deny, only observes. The
  // projection MUST NOT deny here either (§11.7 — cannot be stricter).
  if (authority.enforcement === 'advisory') {
    const inList = authority.allowed_saga_tools.includes(toolName);
    return {
      outcome: 'pass',
      reason: inList
        ? `PreToolUse projection: '${toolName}' is in allowed_saga_tools, but enforcement=advisory so the server only observes. Server guard is authoritative.`
        : `PreToolUse projection: '${toolName}' is NOT in allowed_saga_tools, but enforcement=advisory so the server will observe rather than deny. Server guard is authoritative.`,
      requestedTool: toolName,
      executionId,
      authoritative: false,
    };
  }

  // Runtime enforcement: the server WILL deny if the tool is absent. This is
  // the one case where an early denial is correct and useful.
  if (authority.enforcement === 'runtime') {
    if (authority.allowed_saga_tools.includes(toolName)) {
      return {
        outcome: 'pass',
        reason: `PreToolUse projection: '${toolName}' is in allowed_saga_tools under runtime enforcement. Server guard is authoritative and must still run.`,
        requestedTool: toolName,
        executionId,
        authoritative: false,
      };
    }
    return {
      outcome: 'deny',
      code: 'TOOL_NOT_IN_ALLOWED_TOOLS',
      reason: `PreToolUse projection: '${toolName}' is NOT in allowed_saga_tools under runtime enforcement. The server guard is expected to deny; this is an early rejection hint only (not authoritative).`,
      requestedTool: toolName,
      allowedTools: authority.allowed_saga_tools,
      executionId,
      workIntentId: authority.work_intent_id,
      authoritative: false,
    };
  }

  // Exhaustiveness guard: if enforcement is neither advisory nor runtime, the
  // snapshot is malformed. We do NOT deny (could be stricter than the server)
  // and we do NOT allow (no authority). Pass to the server guard, which will
  // reject the malformed context itself.
  return {
    outcome: 'pass',
    reason: `PreToolUse projection: unknown enforcement '${String(authority.enforcement)}'. Deferring to the authoritative server guard, which will reject the malformed snapshot.`,
    requestedTool: toolName,
    executionId,
    authoritative: false,
  };
}

// ---------------------------------------------------------------------------
// Guard: this projection never carries authority. Compiled-time assertion.
// ---------------------------------------------------------------------------

/**
 * Compile-time guarantee that NO projection result is authoritative. Both
 * `PreToolUseDeny` and `PreToolUsePass` carry `authoritative: false` (a literal
 * type, not `boolean`). This dummy const forces a type error if a future edit
 * introduces an authoritative outcome — which would violate §11.7.
 */
const _AUTHORITY_MODEL_INVARIANT: PreToolUseProjectionResult extends {
  authoritative: false;
}
  ? true
  : never = true;
void _AUTHORITY_MODEL_INVARIANT;
