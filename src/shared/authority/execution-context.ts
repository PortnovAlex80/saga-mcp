/**
 * ExecutionContextSnapshot — the immutable per-execution context frozen at
 * claim time. One snapshot is the single source of truth for three independent
 * consumers:
 *
 *   1. Worker launch executor/provider/model/effort (spawn args)
 *   2. Saga MCP tool authorization               (gateway allow/deny)
 *   3. Production provenance                     (journal / product receipts)
 *
 * Replay-first execution is also resolved here. A capsule hit is frozen before
 * spawn just like a model route: the worker cannot switch between replay and a
 * model after it starts.
 */
import { createHash } from 'node:crypto';
import type { ReplayKeyMaterial } from '../../replay/replay-capsule.js';

/** Shape version for the immutable execution snapshot. */
export const EXECUTION_CONTEXT_POLICY_VERSION = 'factory.execution.v2';

/**
 * Inference route frozen into the snapshot.
 *
 * `provider` is always required on the normal runtime path: every execution
 * runs under the `claude-cli` executor kind. When the execution is replay-bound
 * (replay.capsule_ref != null) the executor resolves the production source
 * internally and never contacts the provider, but the frozen route still
 * records what would have been selected — this is provenance, and it keeps
 * inference and replay on the exact same authorization path (CONVEYOR v4.3
 * PART 1,2: the Gate cannot distinguish how a product was produced).
 */
export interface ExecutionModelRoute {
  provider: string | null;
  model: string | null;
  effort: string | null;
}

/**
 * Executor kind is orthogonal to provider/model.
 *
 * CONVEYOR v4.3 PART 1,3,12: there is no `claude-cli-simulator` executor kind
 * on the runtime path. Replay is an internal production source resolved from
 * replay.capsule_ref; the executor_kind stays `claude-cli` for both inference
 * and replay.
 */
export type ExecutionContextExecutorKind =
  | 'claude-cli';

/** Citation of the routing policy used to resolve this execution. */
export interface ExecutionRoutePolicyRef {
  ref: string;
  digest: string;
}

/** Exact replay lookup frozen in the same claim transaction as the fence. */
export interface ExecutionReplayBinding {
  /** Always present for a Production Cell execution, hit or miss. */
  key: string;
  key_material: ReplayKeyMaterial;
  /** Null means replay miss and the selected LLM is used normally. */
  capsule_ref: string | null;
  capsule_payload_hash: string | null;
}

/** Immutable Saga-tool authority granted to this execution. */
export interface ExecutionAuthority {
  enforcement: 'advisory' | 'runtime';
  allowed_saga_tools: string[];
  scope: string;
  snapshot_ref: string;
  work_intent_id: number | null;
  authority_hash: string;
}

export interface ExecutionContextSnapshot {
  policy_version: typeof EXECUTION_CONTEXT_POLICY_VERSION;
  work_intent_id: number | null;
  authority: ExecutionAuthority | null;
  model_route: ExecutionModelRoute;
  executor_kind: ExecutionContextExecutorKind;
  route_policy: ExecutionRoutePolicyRef | null;
  replay: ExecutionReplayBinding | null;
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

/** Deterministic hash over the immutable authority surface. */
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
 * Deterministic hash over the full stored snapshot, excluding the nested
 * authority hash to avoid self-reference. The helper remains structural so an
 * already-persisted pre-cutover snapshot can still be verified against exactly
 * the shape that was stored.
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
