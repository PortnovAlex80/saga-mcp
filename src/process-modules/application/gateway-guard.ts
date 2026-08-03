/**
 * W6-A3 — Generic server-side GatewayGuard pipeline.
 *
 * Task: `docs/refactor-management/05-subagent-tasks/W06-a3.md`.
 * Spec:  `docs/refactor-management/09-contracts/WAVE6-MCP-GUARDS-SPEC.md`
 *         §1 (W6-A3 lane), §2 exit-gate item 5 ("Gateway guard authoritative").
 * Plan:  §11.7 + §14.8.3 in `docs/refactor-management/00-PLAN.md`.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * Plan §11.7 is the load-bearing rule for this file:
 *
 *   "Gateway guards are authoritative. Optional Claude Code PreToolUse guards
 *    only provide an earlier rejection and cannot replace server enforcement."
 *
 * Before W6-A3, server-side enforcement of a saga tool call lived in two
 * specialised, non-composable places:
 *   1. `src/shared/authority/authorize-tool-call.ts` — the strict
 *      execution-context + authority gateway bound to the legacy Saga 2/3
 *      MCP handler dispatch in `src/index.ts`. It validates the frozen
 *      execution_context and the authority allowed_tools list, but it is
 *      hard-wired to the `worker_executions` table and cannot validate tool
 *      INPUTS or record an audit trail.
 *   2. `src/process-modules/application/protocol-authority.ts` (W4-A6) — the
 *      per-PROTOCOL-STEP authority intersection + stale-state rejection gate
 *      used by the generic protocol runtime. It is a pure function but it is
 *      scoped to one (runId, stepId, attempt): it does not model a single
 *      inbound MCP tool call end to end.
 *
 * What was missing was a SINGLE generic, server-side, per-CALL pipeline that
 * an MCP gateway (the Wave 11 cutover of `src/index.ts`, or a process-module
 * runtime dispatching a contributed tool) can run for every inbound tool call
 * regardless of which surface contributed the tool. The exit gate
 * (WAVE6-MCP-GUARDS-SPEC §2 item 5) requires that gateway guard be
 * AUTHORITATIVE: a denial from this pipeline MUST be final and MUST be
 * produced before the module handler runs.
 *
 * This file owns that pipeline. It is deliberately GENERIC:
 *   - It does NOT know about `worker_executions`, `tasks`, or any table. The
 *     authority + fence state are passed in by the caller as plain data.
 *   - It does NOT know about specific tool names. The pipeline reasons over
 *     an opaque `toolName` string and a caller-supplied effective authority
 *     surface (already intersected by the protocol runtime or the legacy
 *     gateway).
 *   - It does NOT depend on W6-A5's ActionableToolError shape. W6-A3 lands in
 *     a parallel worktree; importing a sibling-lane file that is not present
 *     here would fail `tsc`. Instead the guard emits a stable, structured
 *     `GuardDenial` (code + reason + path + recovery + the call instance ref)
 *     that W6-A5's ActionableToolError can wrap verbatim at the integration
 *     checkpoint — the same structural-mirror convention W1-A6's
 *     `tool-contribution.ts` uses for `ContractRef`.
 *
 * ── The four stages (plan §11.6, §11.7, §11.9) ────────────────────────────
 *
 * A `GuardRequest` flows through an ordered, fail-closed pipeline:
 *
 *   1. AUTHORITY INTERSECTION (§11.6). The effective authority for this call
 *      is the intersection of (frozen execution authority ∩ package profile
 *      ∩ current protocol step ∩ platform policy). The caller is responsible
 *      for computing that intersection (it lives in W4-A6 + W6-A1/W6-A2 land);
 *      this pipeline takes the already-intersected `effectiveAuthority` as an
 *      input and only enforces the per-call question: "is THIS tool in the
 *      effective surface for THIS call?". This keeps the pipeline free of the
 *      host/policy/step machinery and lets it run identically for a legacy
 *      Saga 2 call and a process-module contributed tool.
 *
 *   2. EXECUTION FENCE (§11.1, §0.7.11 item 5). For a managed execution the
 *      call MUST carry the execution-id fence token that the runtime issued
 *      at claim time, and that token MUST equal the runtime's current live
 *      execution for the run the call targets. A missing/mismatched token is
 *      a hard denial (no advisory mode for the fence — the fence is what makes
 *      crash-resume and replay-safe). This is the per-call analog of the
 *      per-step C-AUTH-2 stale-state rejection in `protocol-authority.ts`.
 *
 *   3. INPUT VALIDATION (§11.6 "platform policy", §11.8 ActionableToolError
 *      shape). A caller-supplied `InputValidator` decides whether the raw
 *      arguments are acceptable BEFORE the handler decodes them. Validation
 *      runs only after authority + fence pass (a denied call never reaches the
 *      validator, so a validator side-effect is never triggered by an
 *      unauthorised caller). The validator returns a structured
 *      `InputValidationResult`; the pipeline never throws on validation
 *      failure — it converts a failure into a `VALIDATION_FAILED` denial.
 *
 *   4. AUDIT TRAIL (§11.1 audit, §11.9 call-instance correlation). Every
 *      decision — allow OR deny — produces an immutable `GuardAuditRecord`
 *      carrying the call-instance correlation id (§11.9), the requested
 *      tool, the verdict, the stage that decided it, a content hash over the
 *      decision-relevant fields, and an ISO timestamp. The gateway persists
 *      this record (the persistence seam is W6-A6's call-correlation ledger;
 *      this file only EMITS the record, never writes it). The audit record is
 *      what makes a later verification or incident investigation able to
 *      reconstruct exactly which guard decided what for which call.
 *
 * ── Authoritativeness (§11.7) ─────────────────────────────────────────────
 *
 * `runGatewayGuard` returns a `GuardOutcome`. On `allow`, the handler MAY run
 * and the outcome carries the call instance + the effective tool the gateway
 * will dispatch. On `deny`, the handler MUST NOT run: the outcome is terminal,
 * the denial carries a stable code, and the audit record's verdict is `deny`.
 * There is no "advisory deny" at this layer — the only advisory signal the
 * pipeline understands is authority advisory (an authority whose enforcement
 * mode is `advisory`), and even then the call is still ALLOWED only if the
 * tool is in the effective surface; advisory mode turns a would-be denial
 * into an allowed-with-observation call, it NEVER turns a denial into a
 * silent pass-through. This is the structural guarantee §11.7 demands.
 *
 * ── Purity / ratchet ──────────────────────────────────────────────────────
 *
 * This file is PURE: data types + one pure pipeline runner + pure helpers. No
 * I/O, no side effects, no `persistence/`, no `modules/`, no `db.ts`. It
 * imports only from `../shared/canonical-json.js` (pure node:crypto). This
 * keeps it ratchet-clean under Rule 2 (no persistence/infra import from
 * application/) and Rule 4 (no module-name switching): the guard is a pure
 * function of its inputs, with no dispatch on module identity.
 *
 * The `InputValidator` callback is the ONE place behaviour is injected, and
 * it is a pure `(rawInput) => InputValidationResult` — the caller owns any
 * side effects the validator might perform (e.g. a zod parse), the pipeline
 * only consumes its return value.
 */

import { sha256Hex } from '../shared/canonical-json.js';

// ===========================================================================
// Public types.
// ===========================================================================

/**
 * The effective authority surface for ONE inbound call, already intersected
 * by the caller with (frozen execution authority ∩ package profile ∩ protocol
 * step ∩ platform policy). This pipeline does NOT recompute that intersection
 * — it only answers the per-call question "is the requested tool in this
 * surface?".
 *
 * `enforcement` mirrors the frozen execution_context authority modes
 * (`runtime` | `advisory`). `runtime` is fail-closed: a tool not in
 * `allowedTools` is a hard `AUTHORITY_DENIED`. `advisory` is the one escape:
 * a tool not in the surface is still allowed, but the outcome carries an
 * `advisory: true` observation so the audit trail records that the runtime
 * policy would have denied it. §11.7 forbids advisory mode from REPLACING
 * server enforcement; here advisory mode only softens the authority stage,
 * never the fence or validation stages.
 *
 * `allowedTools` is the namespaced-or-bare tool surface the runtime is
 * willing to grant for this call. The pipeline treats names opaquely — the
 * caller is responsible for having already resolved any `mcp__<server>__<tool>`
 * vs bare-name matching it needs (see W5-A7 `capability-enforcement.ts`).
 */
export interface EffectiveCallAuthority {
  readonly enforcement: 'runtime' | 'advisory';
  readonly allowedTools: readonly string[];
}

/**
 * The execution fence for a managed call. For a non-managed (interactive /
 * operator) call, pass `fence: null` and the pipeline SKIPS the fence stage
 * (the call is treated as a compatibility surface — plan §11.11 keeps
 * operator and interactive catalogs separate).
 *
 * For a managed call all four fields MUST be present and the `callExecutionId`
 * MUST equal `runtimeExecutionId`. A mismatch is the per-call replay fence:
 * it rejects a crashed worker re-presenting an old execution id after the
 * runtime has issued a fresh one (the call-granularity analog of W4-A6's
 * stale-state rejection).
 */
export interface ExecutionFence {
  /** The execution id the inbound call carries (the fencing token). */
  readonly callExecutionId: string;
  /** The execution id the runtime currently holds as live for this run. */
  readonly runtimeExecutionId: string;
  /** The run the fence is scoped to. Both execution ids must belong to it. */
  readonly runId: string;
  /** The worker id the runtime bound to the live execution. */
  readonly workerId: string;
}

/**
 * The platform-supplied call-instance correlation id (plan §11.9). Every
 * consequential call carries one; the gateway validates it is present and
 * well-formed and records it on the audit trail. The pipeline treats it as an
 * opaque non-empty string — the gateway strips it before module handler input
 * decoding (§11.9), so the handler never sees it.
 */
export type CallInstanceRef = string;

/**
 * The raw arguments an inbound tool call carries, before the module handler
 * decodes them. The pipeline treats this as opaque `unknown`; the
 * {@link InputValidator} is the single place the shape is inspected.
 */
export type RawToolInput = unknown;

/**
 * The result of validating a call's raw input. The validator returns
 * `ok: true` to let the call proceed, or `ok: false` with a structured
 * failure (stable code + field path + message + the expected value) that the
 * pipeline turns into a `VALIDATION_FAILED` denial. Returning structured data
 * (rather than throwing) keeps the pipeline total and lets the audit trail
 * record the exact validation failure.
 */
export type InputValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: string;
      fieldPath: string;
      message: string;
      expected?: unknown;
    };

/**
 * A caller-supplied validator over the raw tool input. Pure by contract: it
 * inspects {@link RawToolInput} and returns an {@link InputValidationResult}
 * without side effects. The pipeline never calls it for a call that already
 * failed authority or the fence — so a validator side-effect is never
 * triggered by an unauthorised caller.
 */
export type InputValidator = (
  rawInput: RawToolInput,
) => InputValidationResult;

/**
 * The verdict a {@link GuardAuditRecord} records. `'allow'` for a call the
 * pipeline permitted to reach the handler; `'deny'` for a call rejected at
 * any stage.
 */
export type GuardVerdict = 'allow' | 'deny';

/**
 * The stable, closed set of denial codes the pipeline may emit. Closed so
 * callers (the gateway, tests, W6-A5 ActionableToolError wrappers) can switch
 * on a stable vocabulary instead of free text.
 *
 *   'AUTHORITY_DENIED'      — the requested tool is not in the effective
 *                             authority surface and enforcement is `runtime`.
 *   'FENCE_MISSING'         — the call is marked managed but carries no
 *                             execution-id fence token.
 *   'FENCE_MISMATCH'        — the call's execution id is not the runtime's
 *                             current live execution id (stale / replayed).
 *   'VALIDATION_FAILED'     — the input validator rejected the raw arguments.
 *   'CALL_INSTANCE_INVALID' — the call-instance correlation id (§11.9) is
 *                             missing or malformed; the call cannot be
 *                             correlated for audit or replay.
 *   'MALFORMED_REQUEST'     — the guard request itself is structurally
 *                             invalid (missing tool name, etc.). Defensive:
 *                             the gateway should not construct such a
 *                             request, but the pipeline stays total.
 */
export type GuardDenialCode =
  | 'AUTHORITY_DENIED'
  | 'FENCE_MISSING'
  | 'FENCE_MISMATCH'
  | 'VALIDATION_FAILED'
  | 'CALL_INSTANCE_INVALID'
  | 'MALFORMED_REQUEST';

/**
 * The pipeline stage at which a decision was made. Recorded on the audit
 * trail so an investigator can see not just WHAT was decided but WHERE in the
 * pipeline the decision happened.
 *
 *   'authority'   — the authority-intersection stage.
 *   'fence'       — the execution-fence stage.
 *   'validation'  — the input-validation stage.
 *   'correlation' — the call-instance correlation stage.
 *   'request'     — request-shape validation (before any semantic stage).
 *   'pipeline'    — the call passed every stage and was allowed.
 */
export type GuardStage =
  | 'authority'
  | 'fence'
  | 'validation'
  | 'correlation'
  | 'request'
  | 'pipeline';

/**
 * A structured denial. Emitted on `deny`. Carries the stable {@link GuardDenialCode},
 * a human-readable reason, the stage that produced it, an optional field path
 * (for validation failures), and a recovery hint the gateway surfaces to the
 * agent. The shape mirrors the fields W6-A5's ActionableToolError carries
 * (stable code + message + field path + recovery) so the Wave 11 cutover can
 * wrap a `GuardDenial` into an ActionableToolError without field reshaping.
 */
export interface GuardDenial {
  readonly code: GuardDenialCode;
  readonly reason: string;
  readonly stage: GuardStage;
  readonly fieldPath?: string;
  readonly expected?: unknown;
  readonly recovery: string;
  readonly callInstanceRef: CallInstanceRef | null;
}

/**
 * The terminal outcome of the pipeline. Discriminated by `verdict`.
 *
 * On `allow`: `toolName` is the effective tool the gateway will dispatch
 * (echoed for determinism), `callInstanceRef` is the validated correlation id
 * the gateway strips before handler input decoding, and `advisory` is `true`
 * only when the call was allowed despite the authority surface not listing
 * the tool (enforcement=`advisory`) — the audit trail records the
 * observation so the soft-pass is never silent.
 *
 * On `deny`: {@link GuardDenial} carries the structured rejection. The
 * handler MUST NOT run.
 */
export type GuardOutcome =
  | {
      readonly verdict: 'allow';
      readonly toolName: string;
      readonly callInstanceRef: CallInstanceRef;
      readonly advisory: boolean;
      readonly observation?: string;
    }
  | {
      readonly verdict: 'deny';
      readonly denial: GuardDenial;
    };

/**
 * One inbound tool call, as the gateway presents it to the pipeline. Every
 * consequential field is plain data; the only behaviour is the optional
 * {@link InputValidator}.
 */
export interface GuardRequest {
  /** The tool the inbound call targets (opaque non-empty string). */
  readonly toolName: string;
  /** The effective authority surface, already intersected by the caller. */
  readonly authority: EffectiveCallAuthority;
  /**
   * The execution fence. `null` for a non-managed (interactive / operator)
   * call — the fence stage is skipped. Required for a managed call.
   */
  readonly fence: ExecutionFence | null;
  /**
   * The platform-owned call-instance correlation id (§11.9). Required for a
   * managed call; the gateway strips it before handler input decoding.
   */
  readonly callInstanceRef: CallInstanceRef | null;
  /** The raw tool arguments, pre-decode. */
  readonly rawInput: RawToolInput;
  /**
   * Optional input validator. When omitted the validation stage is skipped
   * (some tools have no structured input to validate at the gateway; the
   * handler owns its own decoding then).
   */
  readonly inputValidator?: InputValidator;
  /**
   * ISO timestamp the caller captured when the call arrived. Passed in (not
   * read from the clock here) so tests are deterministic and the audit
   * record's timestamp is the CALL's time, not the pipeline-run time.
   */
  readonly receivedAt: string;
}

// ===========================================================================
// Audit record.
// ===========================================================================

/**
 * An immutable audit record for one guard decision (plan §11.1 audit). One
 * record is produced for EVERY call — allow or deny — so the audit trail is
 * complete and a later verification can reconstruct the exact decision
 * sequence.
 *
 * `contentHash` is a SHA-256 over the canonical form of the
 * decision-relevant fields (toolName, verdict, stage, code-or-advisory,
 * callInstanceRef, receivedAt). It lets a downstream ledger detect tampering
 * or a record that was re-emitted with a changed decision.
 *
 * The record is `Object.freeze`d by {@link buildAuditRecord}; treat as
 * immutable.
 */
export interface GuardAuditRecord {
  readonly callInstanceRef: CallInstanceRef | null;
  readonly toolName: string;
  readonly verdict: GuardVerdict;
  readonly stage: GuardStage;
  readonly code: GuardDenialCode | null;
  readonly advisory: boolean;
  readonly receivedAt: string;
  readonly contentHash: string;
}

// ===========================================================================
// Internal helpers.
// ===========================================================================

/**
 * Locale-independent lexicographic comparator. Avoids `String.prototype.localeCompare`
 * (locale-dependent) so the effective surface and the audit hash are
 * byte-stable across Node versions and locales — the same invariant
 * `protocol-authority.ts` and `capability-enforcement.ts` uphold.
 */
function compareString(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Normalize a raw tool list into the canonical frozen form: unique, sorted,
 * non-empty, non-blank strings only. Mirrors `protocol-authority.ts`'s
 * `normalizeToolSet` so the effective-authority surface is canonicalised
 * identically wherever it enters a guard.
 */
function normalizeToolSet(tools: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i];
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  out.sort(compareString);
  return out;
}

/**
 * Build a {@link GuardDenial} for a given stage + code, threading the
 * call-instance ref onto every denial so the audit trail and any downstream
 * ActionableToolError can correlate the rejection back to the exact call.
 */
function deny(
  stage: GuardStage,
  code: GuardDenialCode,
  reason: string,
  recovery: string,
  callInstanceRef: CallInstanceRef | null,
  extras: { fieldPath?: string; expected?: unknown } = {},
): GuardDenial {
  return {
    stage,
    code,
    reason,
    recovery,
    callInstanceRef,
    ...(extras.fieldPath !== undefined ? { fieldPath: extras.fieldPath } : {}),
    ...(extras.expected !== undefined ? { expected: extras.expected } : {}),
  };
}

/**
 * Construct and freeze a {@link GuardAuditRecord} for one decision. The
 * `contentHash` covers the decision-relevant fields so a ledger can detect a
 * re-emitted or tampered record. `sha256Hex` canonicalises its input, so the
 * exact object shape passed here does not matter — only the salient fields.
 */
function buildAuditRecord(args: {
  callInstanceRef: CallInstanceRef | null;
  toolName: string;
  verdict: GuardVerdict;
  stage: GuardStage;
  code: GuardDenialCode | null;
  advisory: boolean;
  receivedAt: string;
}): GuardAuditRecord {
  const contentHash = sha256Hex({
    callInstanceRef: args.callInstanceRef,
    toolName: args.toolName,
    verdict: args.verdict,
    stage: args.stage,
    code: args.code,
    advisory: args.advisory,
    receivedAt: args.receivedAt,
  });
  return Object.freeze({ ...args, contentHash });
}

// ===========================================================================
// runGatewayGuard — the headline pipeline runner.
// ===========================================================================

/**
 * The terminal result of running the guard pipeline: the outcome (allow/deny)
 * AND the immutable audit record for the decision. The gateway dispatches on
 * the outcome and persists the audit record. Returning them together makes it
 * impossible to forget the audit trail: even a `deny` produces a record.
 */
export interface GuardResult {
  readonly outcome: GuardOutcome;
  readonly audit: GuardAuditRecord;
}

/**
 * Run the generic server-side gateway guard pipeline for one inbound tool
 * call (plan §11.6, §11.7, §11.9). Authoritative (§11.7): a `deny` outcome is
 * terminal and MUST be produced before the module handler runs.
 *
 * The stages run in a fixed order, fail-closed. The FIRST stage that fails
 * decides the outcome; no later stage runs. Order rationale:
 *
 *   1. REQUEST SHAPE (`request`). A structurally invalid request (missing
 *      tool name, malformed authority) cannot be meaningfully run through any
 *      semantic stage, so it is rejected first. Defensive — the gateway
 *      should not build such a request.
 *   2. CORRELATION (`correlation`). For a managed call the call-instance ref
 *      (§11.9) MUST be present and non-blank before anything else, because
 *      every subsequent denial needs to carry it onto the audit trail.
 *   3. FENCE (`fence`). For a managed call the execution-id fence MUST hold.
 *      This is the replay/stale-execution guard; it runs before authority so a
 *      replayed call is rejected without leaking which tools the surface
 *      grants.
 *   4. AUTHORITY (`authority`). The requested tool MUST be in the effective
 *      authority surface. The only soft mode is `enforcement: 'advisory'`,
 *      which turns a would-be denial into an allow-with-observation; it never
 *      turns a denial into a silent pass.
 *   5. VALIDATION (`validation`). The input validator runs LAST among the
 *      semantic stages, so a validator side-effect is never triggered by an
 *      unauthorised or unfenced caller.
 *
 * If every stage passes, the outcome is `allow` and the audit record's stage
 * is `pipeline`.
 *
 * The function is pure: same inputs ⇒ same outcome + same audit hash,
 * regardless of ordering noise. The only injected behaviour is the optional
 * `inputValidator`, which is pure by contract.
 */
export function runGatewayGuard(request: GuardRequest): GuardResult {
  // ---- (0) Request shape. ----
  if (typeof request !== 'object' || request === null) {
    return malformed(request, null, 'guard request must be an object');
  }
  const toolName = request.toolName;
  if (typeof toolName !== 'string' || toolName.trim().length === 0) {
    return malformed(
      request,
      request.callInstanceRef ?? null,
      'toolName must be a non-empty string',
    );
  }
  const authority = request.authority;
  if (
    typeof authority !== 'object' ||
    authority === null ||
    (authority.enforcement !== 'runtime' && authority.enforcement !== 'advisory') ||
    !Array.isArray(authority.allowedTools)
  ) {
    return malformed(
      request,
      request.callInstanceRef ?? null,
      'authority must be { enforcement: runtime|advisory, allowedTools: string[] }',
    );
  }
  const receivedAt = request.receivedAt;
  if (typeof receivedAt !== 'string' || receivedAt.length === 0) {
    return malformed(
      request,
      request.callInstanceRef ?? null,
      'receivedAt must be a non-empty ISO timestamp string',
    );
  }
  const isManaged = request.fence !== null;
  const callInstanceRef = request.callInstanceRef;

  // ---- (1) Correlation (managed calls only). ----
  // §11.9: every consequential call carries a platform-owned call-instance
  // correlation value. For a managed call it MUST be present and non-blank —
  // without it the audit trail cannot correlate the decision and the gateway
  // cannot strip it before handler input decoding.
  if (isManaged) {
    if (typeof callInstanceRef !== 'string' || callInstanceRef.trim().length === 0) {
      const denial = deny(
        'correlation',
        'CALL_INSTANCE_INVALID',
        'managed call is missing a non-empty callInstanceRef (§11.9)',
        'The controller must issue a call-instance correlation id for every managed call. The gateway cannot audit or correlate a call without one.',
        null,
      );
      return finishDeny(toolName, denial, receivedAt);
    }
  }

  // ---- (2) Execution fence (managed calls only). ----
  if (isManaged) {
    const fence = request.fence as ExecutionFence;
    if (
      typeof fence.callExecutionId !== 'string' ||
      fence.callExecutionId.length === 0
    ) {
      const denial = deny(
        'fence',
        'FENCE_MISSING',
        'managed call carries no execution-id fence token',
        'The controller must issue the execution-id fence token (SAGA_EXECUTION_ID) for every managed call. A managed call without a fence cannot be replay-safe.',
        callInstanceRef,
      );
      return finishDeny(toolName, denial, receivedAt);
    }
    if (
      typeof fence.runtimeExecutionId !== 'string' ||
      fence.runtimeExecutionId.length === 0 ||
      fence.callExecutionId !== fence.runtimeExecutionId
    ) {
      const denial = deny(
        'fence',
        'FENCE_MISMATCH',
        `execution-id fence mismatch: call="${fence.callExecutionId}" runtime="${fence.runtimeExecutionId}"`,
        'Stop this execution. The runtime has advanced past this execution id (crash-resume or retry issued a fresh one). The worker cannot reuse a stale execution id.',
        callInstanceRef,
      );
      return finishDeny(toolName, denial, receivedAt);
    }
  }

  // ---- (3) Authority intersection. ----
  const surface = normalizeToolSet(authority.allowedTools);
  const inSurface = surface.includes(toolName);
  if (!inSurface) {
    if (authority.enforcement === 'advisory') {
      // §11.7: advisory mode may soften authority, never replace server
      // enforcement. The call is ALLOWED but the audit trail records the
      // observation — the soft-pass is never silent.
      const observation = `advisory authority: '${toolName}' is NOT in the effective surface (${surface.length} tool(s)) but enforcement=advisory`;
      const audit = buildAuditRecord({
        callInstanceRef,
        toolName,
        verdict: 'allow',
        stage: 'authority',
        code: null,
        advisory: true,
        receivedAt,
      });
      return {
        outcome: {
          verdict: 'allow',
          toolName,
          callInstanceRef: callInstanceRef as CallInstanceRef,
          advisory: true,
          observation,
        },
        audit,
      };
    }
    const denial = deny(
      'authority',
      'AUTHORITY_DENIED',
      `tool '${toolName}' is not in the effective authority surface`,
      'The controller must issue a new authority/fence granting this tool. The worker cannot expand its own authority mid-run (the frozen execution_context is immutable).',
      callInstanceRef,
    );
    return finishDeny(toolName, denial, receivedAt);
  }

  // ---- (4) Input validation. ----
  const validator = request.inputValidator;
  if (validator !== undefined) {
    let result: InputValidationResult;
    try {
      result = validator(request.rawInput);
    } catch (e) {
      // A validator that throws is treated as a validation failure, never an
      // allow — fail-closed. The pipeline never lets a thrown validator
      // widen the effective surface.
      result = {
        ok: false,
        code: 'VALIDATOR_THREW',
        fieldPath: '$',
        message: `input validator threw: ${(e as Error).message}`,
      };
    }
    if (!result.ok) {
      const denial = deny(
        'validation',
        'VALIDATION_FAILED',
        result.message,
        'Correct the tool arguments per the input contract and retry. The gateway validated the raw input before handler decoding.',
        callInstanceRef,
        { fieldPath: result.fieldPath, ...(result.expected !== undefined ? { expected: result.expected } : {}) },
      );
      return finishDeny(toolName, denial, receivedAt);
    }
  }

  // ---- (5) All stages passed: allow. ----
  const audit = buildAuditRecord({
    callInstanceRef,
    toolName,
    verdict: 'allow',
    stage: 'pipeline',
    code: null,
    advisory: false,
    receivedAt,
  });
  return {
    outcome: {
      verdict: 'allow',
      toolName,
      // For a non-managed call there is no call-instance ref; the outcome
      // carries null-equivalent as the empty string so the discriminated
      // union stays total. The audit record above already records the
      // nullable form.
      callInstanceRef: (callInstanceRef ?? '') as CallInstanceRef,
      advisory: false,
    },
    audit,
  };
}

/**
 * Build a `MALFORMED_REQUEST` denial result. Used only by the request-shape
 * pre-stage. The audit record for a malformed request still records whatever
 * callInstanceRef survived (often null) so even a malformed call leaves a
 * breadcrumb.
 *
 * Null-safe: reads every field through `asRecord` so a `null`/non-object
 * request (the first pre-stage branch) does not itself throw — the pipeline
 * stays total even on garbage input.
 */
function malformed(
  request: unknown,
  callInstanceRef: CallInstanceRef | null,
  reason: string,
): GuardResult {
  const rec = (request !== null && typeof request === 'object'
    ? (request as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const toolName =
    typeof rec.toolName === 'string' && rec.toolName.length > 0
      ? rec.toolName
      : '<malformed>';
  const receivedAt =
    typeof rec.receivedAt === 'string' && (rec.receivedAt as string).length > 0
      ? (rec.receivedAt as string)
      : '<unknown-time>';
  const denial = deny(
    'request',
    'MALFORMED_REQUEST',
    reason,
    'The gateway constructed a malformed guard request. This is a platform defect — the handler is not run.',
    callInstanceRef,
  );
  return finishDeny(toolName, denial, receivedAt);
}

/**
 * Convert a denial into a terminal {@link GuardResult}: the deny outcome plus
 * the matching audit record (verdict=deny, code + stage from the denial).
 */
function finishDeny(
  toolName: string,
  denial: GuardDenial,
  receivedAt: string,
): GuardResult {
  const audit = buildAuditRecord({
    callInstanceRef: denial.callInstanceRef,
    toolName,
    verdict: 'deny',
    stage: denial.stage,
    code: denial.code,
    advisory: false,
    receivedAt,
  });
  return {
    outcome: { verdict: 'deny', denial },
    audit,
  };
}

// ===========================================================================
// Convenience constructors (callers build EffectiveCallAuthority / fence).
// ===========================================================================

/**
 * Build an {@link EffectiveCallAuthority} from a raw allowed-tools list,
 * canonicalising it to unique-sorted form. Convenience for callers that have
 * a raw intersection result (e.g. from W4-A6 `intersectAuthority`) and want
 * to hand the guard a frozen surface without re-canonicalising at the call
 * site. `enforcement` defaults to `'runtime'` (fail-closed) — the only safe
 * default for a server-side guard (§11.7).
 */
export function makeEffectiveCallAuthority(
  allowedTools: readonly string[],
  enforcement: 'runtime' | 'advisory' = 'runtime',
): EffectiveCallAuthority {
  return Object.freeze({
    enforcement,
    allowedTools: Object.freeze(normalizeToolSet([...allowedTools])),
  });
}
