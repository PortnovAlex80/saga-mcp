/**
 * ExecutionContextSnapshot — the immutable per-execution context frozen at
 * claim time (D1.1). One snapshot is the single source of truth for THREE
 * independent consumers:
 *
 *   1. Worker launch model/provider/effort  (spawn args)
 *   2. Saga MCP tool authorization           (gateway allow/deny)
 *   3. Proposal provenance                   (recorded by proposal_submit)
 *
 * The D1 claim↔spawn model-route race (claim read route A, spawn read route B)
 * is eliminated by reading the model route ONCE at claim, freezing it into
 * this snapshot, and having spawn + provenance read from the frozen value.
 *
 * The snapshot is persisted as JSON in `worker_executions.metadata.execution_context`
 * and never mutated after claim. A WorkIntent changed post-claim does NOT
 * change the authority of an already-running execution — the worker cannot
 * expand its own authority; only a new WorkIntent can grant more.
 *
 * This is a pure-domain module — no `getDb`, no I/O. Hashing helpers are
 * deterministic (canonical JSON with sorted keys) so the same authority always
 * produces the same hash, which lets certificates (D4) cite it reproducibly.
 */
import { createHash } from 'node:crypto';

/**
 * Policy version baked into every snapshot. Bumped on shape-incompatible change.
 *
 * v2 (routing cutover): added `executor_kind` alongside `model_route`. The
 * `model` string no longer encodes the executor (the `model === "mock"` defect);
 * the executor kind is now an orthogonal dimension frozen into the snapshot.
 * The gateway still accepts v1 snapshots for in-flight executions, but every
 * NEW claim produces v2.
 */
export const EXECUTION_CONTEXT_POLICY_VERSION = 'factory.execution.v2';

/**
 * Model route frozen into the snapshot. `provider`/`model`/`effort` mirror the
 * existing `WorkerModelRoute` shape (worker-executor.ts) so spawn-side code can
 * consume it unchanged.
 */
export interface ExecutionModelRoute {
  provider: string;
  model: string | null;
  effort: string | null;
}

/**
 * Executor kind frozen into the snapshot (v2). Orthogonal to the model: selects
 * which OS binary spawn runs (`claude-cli` vs `claude-cli-simulator`). Mirrors
 * {@link WorkerExecutionRoute.executor.kind}.
 */
export type ExecutionContextExecutorKind =
  | 'claude-cli'
  | 'claude-cli-simulator';

/**
 * Citation of the routing policy that resolved this execution's route. Frozen
 * at claim so the production journal can always explain WHY a WorkIntent ran
 * on a given backend, even after the policy file is edited. See ADR: "route
 * must be a durable decision, not a live config read".
 */
export interface ExecutionRoutePolicyRef {
  /** Human-readable policy source (file path or env marker). */
  ref: string;
  /** Stable digest of the policy that produced this route. */
  digest: string;
}

/**
 * the gateway. `work_intent_id` is included so the gateway can cite it in a
 * denial without re-reading the (mutable) WorkIntent row.
 *
 * `authority_hash` covers the immutable authority fields
 * ({enforcement, allowed_saga_tools, scope, snapshot_ref, work_intent_id}).
 * Enforcement is included because changing runtime→advisory changes the actual
 * authority boundary and must invalidate the snapshot. The model route is NOT
 * the model route (which lives on the snapshot, not the authority). This hash
 * is what an OutcomeCertificate (D4) will cite as "the authority this run
 * operated under".
 */
export interface ExecutionAuthority {
  enforcement: 'advisory' | 'runtime';
  allowed_saga_tools: string[];
  scope: string;
  snapshot_ref: string;
  work_intent_id: number | null;
  authority_hash: string;
}

/**
 * (no WorkIntent); non-null for Saga 3 managed executions.
 */
export interface ExecutionContextSnapshot {
  policy_version: typeof EXECUTION_CONTEXT_POLICY_VERSION;
  work_intent_id: number | null;
  authority: ExecutionAuthority | null;
  model_route: ExecutionModelRoute;
  /** v2: executor kind (orthogonal to model). Spawn selects the binary from this. */
  executor_kind: ExecutionContextExecutorKind;
  /** v2: routing policy citation (ref + digest). Null only on legacy v1 snapshots. */
  route_policy: ExecutionRoutePolicyRef | null;
  captured_at: string;
}

/** Canonical JSON (sorted keys, recursively) for deterministic hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/** SHA-256 hex of the canonical JSON encoding. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Deterministic hash over the immutable authority surface
 * ({enforcement, allowed_saga_tools, scope, snapshot_ref, work_intent_id}).
 * `authority_hash` itself is excluded to avoid a circular dependency.
 */
export function authorityHash(input: {
  enforcement: 'advisory' | 'runtime';
  allowed_saga_tools: string[];
  scope: string;
  snapshot_ref: string;
  work_intent_id: number | null;
}): string {
  return sha256Hex(
    canonicalJson({
      enforcement: input.enforcement,
      allowed_saga_tools: [...input.allowed_saga_tools].sort(),
      scope: input.scope,
      snapshot_ref: input.snapshot_ref,
      work_intent_id: input.work_intent_id,
    }),
  );
}

/**
 * Deterministic hash over the full snapshot (excluding the hash fields that
 * would make it self-referential: `authority.authority_hash`). Used to detect
 * drift between the persisted snapshot and a recomputed one, and as the
 * `execution_context_hash` recorded alongside `execution_context` in metadata.
 *
 * Accepts a structural input so BOTH v1 (no executor_kind/route_policy) and v2
 * snapshots hash consistently — the validator reconstructs exactly the stored
 * shape and recomputes, so a v1 in-flight execution is not invalidated by the
 * v2 cutover.
 */
export function executionContextHash(
  snapshot: ExecutionContextSnapshot | Record<string, unknown>,
): string {
  const authority = (snapshot as { authority?: unknown }).authority;
  const rest: Record<string, unknown> = { ...(snapshot as Record<string, unknown>) };
  delete rest.authority;
  const authorityWithoutHash = authority && typeof authority === 'object'
    ? { ...(authority as Record<string, unknown>), authority_hash: undefined }
    : null;
  return sha256Hex(
    canonicalJson({ ...rest, authority: authorityWithoutHash }),
  );
}
