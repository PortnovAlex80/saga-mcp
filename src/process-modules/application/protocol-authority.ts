/**
 * W4-A6 — Protocol authority intersection + stale-state rejection.
 *
 * Task: `docs/refactor-management/05-subagent-tasks/W04-a6.md`.
 * Spec: `docs/refactor-management/09-contracts/WAVE4-PROTOCOL-RECOVERY-SPEC.md`
 *        §1 (W4-A6 lane), §3 exit gate (item 3 — evidence/authority gating).
 *
 * Wave 4 builds the generic protocol runtime on top of the Wave 1
 * `NodeProtocolDefinition`. A `NodeProtocolDefinition` declares, per step, the
 * tools that step is *allowed* to call (`ProtocolStep.allowedTools`). But the
 * actual execution environment grants a concrete tool set when the run starts
 * (the host may disable a tool, the package may not ship one, a sandbox may
 * redact one). The EFFECTIVE authority for a step is therefore never the
 * step's declared set — it is the INTERSECTION of:
 *
 *   frozen execution authority  ∩  step allowed tools
 *
 * This file owns that intersection and the stale-state rejection that guards
 * it. It is PURE: no I/O, no persistence, no side effects. The runtime
 * (W4-A2 `protocol-runtime.ts`) and the checkpoint service (W4-A5) call into
 * these functions; they own WHEN freezing and authorization happen. This file
 * owns the deterministic WHAT.
 *
 * Two contract invariants (plan §8.2, §0.7.11 crash-resume):
 *
 *   C-AUTH-1 (monotonic ceiling). The frozen execution authority is the
 *     permanent upper bound for the whole run. Nothing a step declares can
 *     EVER widen it. `intersectAuthority` therefore returns a subset of the
 *     frozen set for every input — a step that declares a tool the frozen
 *     authority did not grant simply does not get it.
 *
 *   C-AUTH-2 (stale-state rejection). A step attempt is authorized ONLY when
 *     the attempt the worker presents is exactly the runtime's current live
 *     (stepId, attempt) for the frozen run. A mismatch — a crashed worker
 *     re-presenting an old frame after the runtime has advanced to the next
 *     step or to a retry attempt — is REJECTED. This is the per-step analog
 *     of the execution-id fence: it prevents double-execution and replay at
 *     the protocol-step granularity, which is what makes crash-resume
 *     (§0.7.11 item 5) safe.
 *
 * Dependency-direction ratchet (W0-A1): this file lives under
 * `application/`. It imports only from `shared/canonical-json.ts` (pure
 * primitives) and uses `readonly string[]` / plain-data types — no
 * `persistence/` adapters, no `db.ts`, no `modules/`. It does NOT import the
 * Wave 1 SPI barrel even though it reasons about `allowedTools`, because the
 * intersection operates on the raw `readonly string[]` surface that both
 * `ProtocolStep.allowedTools` and the host grant share; staying on the raw
 * type keeps this file decoupled from sibling Wave 1 lanes and lets it land
 * in parallel with them.
 */

import { sha256Hex } from '../../shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

/**
 * The tool authority frozen at run start. This is the permanent ceiling for
 * every step in the run (C-AUTH-1).
 *
 * `frozenAllowedTools` is the deduplicated, lexicographically-sorted set of
 * tools the host granted for this run. `contentHash` is a SHA-256 over the
 * canonical form of `(runId, frozenAllowedTools)` so the runtime can detect
 * tampering or an accidental re-freeze that changed the grant.
 */
export interface FrozenExecutionAuthority {
  readonly runId: string;
  readonly frozenAllowedTools: readonly string[];
  readonly contentHash: string;
}

/**
 * Input to `freezeExecutionAuthority`: the raw grant the host reported for a
 * run, before normalization. Duplicates and ordering are tolerated here; the
 * factory normalizes them.
 */
export interface FrozenAuthorityInput {
  readonly runId: string;
  readonly allowedTools: readonly string[];
}

/**
 * The runtime's current authoritative view of which step attempt is live for
 * the run. `authorizeStep` compares a worker's `StepAuthorityAttempt` against
 * this pointer to detect stale state (C-AUTH-2).
 *
 * All three fields MUST be non-empty. An empty `stepId` or non-positive
 * `attempt` indicates the runtime has no live step (the run has not started,
 * is between steps, or has completed); any authorize request in that window
 * is rejected.
 */
export interface RuntimeStepPointer {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
}

/**
 * A worker's request to exercise tool authority for one step attempt. This is
 * what the executor presents when it is about to call a tool on behalf of a
 * step. `stepAllowedTools` is the step's declared set (from
 * `ProtocolStep.allowedTools`); the effective set is its intersection with
 * the frozen authority.
 */
export interface StepAuthorityAttempt {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly stepAllowedTools: readonly string[];
}

/**
 * The rejection reason codes `authorizeStep` may emit. The closed set keeps
 * callers (and tests) switching on a stable vocabulary instead of free text.
 *
 *   'AUTHORITY_WRONG_RUN'      — the attempt targets a different run than the
 *                                frozen authority (or the runtime pointer).
 *   'AUTHORITY_STALE_STEP'     — the attempt's stepId is not the runtime's
 *                                current live step (worker frame is stale).
 *   'AUTHORITY_STALE_ATTEMPT'  — the step matches but the attempt number is
 *                                not the runtime's current attempt (the step
 *                                was retried; this worker holds an old frame).
 *   'AUTHORITY_RUN_NOT_LIVE'   — the runtime pointer has no live step
 *                                (empty stepId / non-positive attempt), so no
 *                                authorization can be granted right now.
 *   'AUTHORITY_EMPTY_GRANT'    — the frozen authority granted zero tools, so
 *                                the run cannot make any tool call. (Allowed
 *                                only when the step also needs zero tools; a
 *                                step that needs a tool under an empty grant
 *                                is rejected as a no-overlap case below.)
 */
export type AuthorityRejectionCode =
  | 'AUTHORITY_WRONG_RUN'
  | 'AUTHORITY_STALE_STEP'
  | 'AUTHORITY_STALE_ATTEMPT'
  | 'AUTHORITY_RUN_NOT_LIVE'
  | 'AUTHORITY_EMPTY_GRANT';

/**
 * The decision returned by `authorizeStep`. On `allow`, `effectiveAllowedTools`
 * is the frozen-authority ∩ step-declared intersection (sorted, unique). On
 * `reject`, `effectiveAllowedTools` is empty and `code` names the reason.
 */
export interface AuthorityDecision {
  readonly decision: 'allow' | 'reject';
  readonly effectiveAllowedTools: readonly string[];
  readonly code?: AuthorityRejectionCode;
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

/**
 * Normalize a raw tool list into the canonical frozen form: unique, sorted,
 * non-empty, non-blank strings only. Entries that are not strings, the empty
 * string, or whitespace-only are dropped silently (a host that reports `''`
 * or `'   '` for "no tool" is treated as not naming a tool).
 *
 * Returns the empty array for an empty/blank-only input — the caller decides
 * whether an empty grant is fatal (it is, at freeze time) or merely yields an
 * empty intersection (it does, at step time).
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
  out.sort();
  return out;
}

function reject(
  code: AuthorityRejectionCode,
  reason: string,
): AuthorityDecision {
  return { decision: 'reject', effectiveAllowedTools: [], code, reason };
}

// ---------------------------------------------------------------------------
// freezeExecutionAuthority — run-start ceiling.
// ---------------------------------------------------------------------------

/**
 * Freeze the run-level tool authority (C-AUTH-1). Called once when the
 * protocol run starts (W4-A2 runtime) with the concrete tool set the host
 * reported as granted. The returned object is immutable in spirit; the
 * `contentHash` lets the runtime verify it has not been swapped.
 *
 * Throws on a structurally invalid input:
 *   - `runId` must be a non-empty string.
 *   - `allowedTools` must contain at least one non-empty tool name. A run
 *     that grants zero tools cannot execute any tool-calling step; freezing
 *     such a grant would silently dead-lock the run, so we fail fast at the
 *     boundary instead. (A genuinely tool-free protocol step is still
 *     executable — it simply declares an empty `stepAllowedTools` and the
 *     intersection is empty; but the RUN grant itself must be non-empty so
 *     the ceiling is well-defined. Hosts that legitimately run a fully
 *     read-only protocol still grant at least one tool, e.g. a read tool.)
 */
export function freezeExecutionAuthority(
  input: FrozenAuthorityInput,
): FrozenExecutionAuthority {
  if (typeof input.runId !== 'string' || input.runId.length === 0) {
    throw new Error(
      'freezeExecutionAuthority: runId must be a non-empty string',
    );
  }
  if (!Array.isArray(input.allowedTools)) {
    throw new Error(
      'freezeExecutionAuthority: allowedTools must be an array',
    );
  }
  const frozenAllowedTools = normalizeToolSet(
    input.allowedTools as readonly string[],
  );
  if (frozenAllowedTools.length === 0) {
    throw new Error(
      `freezeExecutionAuthority: cannot freeze an empty tool grant for run "${input.runId}" — the run-level ceiling must contain at least one tool`,
    );
  }
  // Hash the salient fields. sha256Hex canonicalizes its input, so the exact
  // object shape here does not matter — only (runId, frozenAllowedTools).
  const contentHash = sha256Hex({
    runId: input.runId,
    frozenAllowedTools,
  });
  return Object.freeze({
    runId: input.runId,
    frozenAllowedTools,
    contentHash,
  });
}

// ---------------------------------------------------------------------------
// intersectAuthority — the headline pure intersection (C-AUTH-1).
// ---------------------------------------------------------------------------

/**
 * Compute the effective allowed tools for one step: the intersection of the
 * frozen execution authority (the run-level ceiling) and the step's declared
 * `allowedTools`. Pure, deterministic, side-effect-free.
 *
 * The result is ALWAYS a subset of `frozenAuthority.frozenAllowedTools` — a
 * step can never widen the ceiling. Returned tools are unique and sorted
 * lexicographically (the canonical form), which makes the output stable and
 * trivially comparable across calls.
 *
 * The frozen authority is taken as-is (it is already normalized at freeze
 * time). The step's tool list is normalized inline so a caller passing a raw
 * `ProtocolStep.allowedTools` with duplicates or odd ordering still gets the
 * canonical intersection.
 *
 * Returns the empty array when:
 *   - the step declares no tools (a read-only / evidence-only step), OR
 *   - the step and the frozen grant share no tool.
 *
 * Distinguishing those two cases is the caller's job (an empty intersection
 * for a step that DECLARED tools is a configuration defect; an empty result
 * for a step that declared nothing is normal). `authorizeStep` below does not
 * treat an empty intersection as fatal — it simply yields a zero-tool step.
 */
export function intersectAuthority(
  frozenAuthority: FrozenExecutionAuthority,
  stepAllowedTools: readonly string[],
): readonly string[] {
  const stepSet = normalizeToolSet(stepAllowedTools);
  if (stepSet.length === 0) return [];
  const frozen = frozenAuthority.frozenAllowedTools;
  // Both inputs are sorted+unique. A merge-intersection is O(n+m) and keeps
  // the output sorted without a re-sort.
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < frozen.length && j < stepSet.length) {
    const f = frozen[i];
    const s = stepSet[j];
    if (f === s) {
      out.push(f);
      i++;
      j++;
    } else if (f < s) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// authorizeStep — stale-state rejection gate (C-AUTH-2).
// ---------------------------------------------------------------------------

/**
 * Authorize one step attempt against the frozen run authority and the
 * runtime's current live step pointer. This is the per-step fence: it both
 * computes the effective tool set (via `intersectAuthority`) AND rejects any
 * attempt that is not exactly the runtime's current live (stepId, attempt).
 *
 * Rejection rules (checked in order, first hit wins):
 *
 *   1. Run binding. `stepAttempt.runId`, `frozenAuthority.runId`, and
 *      `runtimePointer.runId` must all be equal. Any mismatch →
 *      `AUTHORITY_WRONG_RUN`. This catches an authority blob or a worker
 *      frame that leaked across runs (e.g. a reused worktree).
 *
 *   2. Liveness. If `runtimePointer.stepId` is empty or `attempt` is not a
 *      positive integer, the runtime has no live step right now (run not
 *      started, between steps, or completed) → `AUTHORITY_RUN_NOT_LIVE`.
 *
 *   3. Stale step. `stepAttempt.stepId !== runtimePointer.stepId` →
 *      `AUTHORITY_STALE_STEP`. The worker is trying to execute a step the
 *      runtime has already left (crashed worker holding an old frame after
 *      the run advanced).
 *
 *   4. Stale attempt. Same step, but `stepAttempt.attempt !==
 *      runtimePointer.attempt` → `AUTHORITY_STALE_ATTEMPT`. The step was
 *      retried; this worker's frame is from the previous, exhausted attempt.
 *
 *   5. Empty grant. If the frozen authority (somehow, and contrary to the
 *      freeze-time guard) carries no tools, the run can make no tool call →
 *      `AUTHORITY_EMPTY_GRANT`. Defensive: should be unreachable because
 *      `freezeExecutionAuthority` rejects empty grants, but the gate stays
 *      total.
 *
 * If all checks pass, `decision: 'allow'` with `effectiveAllowedTools` set to
 * `intersectAuthority(frozenAuthority, stepAttempt.stepAllowedTools)`.
 *
 * Note: an empty INTERSECTION (step declares tools the grant does not cover,
 * or declares no tools at all) is NOT a rejection — it is a valid `allow`
 * with a zero-tool effective set. The runtime permits tool-free steps
 * (evidence-only, human-receipt steps). Rejection here is reserved for
 * staleness and binding failures, which are the safety-critical cases.
 */
export function authorizeStep(
  frozenAuthority: FrozenExecutionAuthority,
  runtimePointer: RuntimeStepPointer,
  stepAttempt: StepAuthorityAttempt,
): AuthorityDecision {
  // (1) Run binding — all three runIds must agree.
  const frozenRun = frozenAuthority.runId;
  const pointerRun = runtimePointer.runId;
  const attemptRun = stepAttempt.runId;
  if (
    frozenRun !== pointerRun ||
    frozenRun !== attemptRun ||
    typeof frozenRun !== 'string' ||
    frozenRun.length === 0
  ) {
    return reject(
      'AUTHORITY_WRONG_RUN',
      `authority run mismatch: frozen="${frozenRun}" pointer="${pointerRun}" attempt="${attemptRun}"`,
    );
  }

  // (2) Liveness — the runtime must actually have a live step.
  if (
    typeof runtimePointer.stepId !== 'string' ||
    runtimePointer.stepId.length === 0 ||
    !Number.isInteger(runtimePointer.attempt) ||
    runtimePointer.attempt <= 0
  ) {
    return reject(
      'AUTHORITY_RUN_NOT_LIVE',
      `runtime has no live step for run "${frozenRun}" (stepId="${runtimePointer.stepId}" attempt=${runtimePointer.attempt})`,
    );
  }

  // (3) Stale step.
  if (stepAttempt.stepId !== runtimePointer.stepId) {
    return reject(
      'AUTHORITY_STALE_STEP',
      `stale step: attempt targets "${stepAttempt.stepId}" but runtime live step is "${runtimePointer.stepId}" for run "${frozenRun}"`,
    );
  }

  // (4) Stale attempt — the step-attempt mismatch that is the core of
  //     stale-state rejection.
  if (
    !Number.isInteger(stepAttempt.attempt) ||
    stepAttempt.attempt !== runtimePointer.attempt
  ) {
    return reject(
      'AUTHORITY_STALE_ATTEMPT',
      `stale attempt: attempt=${stepAttempt.attempt} but runtime live attempt is ${runtimePointer.attempt} for step "${runtimePointer.stepId}" run "${frozenRun}"`,
    );
  }

  // (5) Defensive empty-grant guard (should be unreachable post-freeze).
  if (frozenAuthority.frozenAllowedTools.length === 0) {
    return reject(
      'AUTHORITY_EMPTY_GRANT',
      `frozen authority for run "${frozenRun}" carries no tools`,
    );
  }

  // All checks passed: allow, with the intersection as the effective set.
  const effectiveAllowedTools = intersectAuthority(
    frozenAuthority,
    stepAttempt.stepAllowedTools,
  );
  return { decision: 'allow', effectiveAllowedTools };
}
