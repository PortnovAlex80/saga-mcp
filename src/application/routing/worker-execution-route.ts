/**
 * WorkerExecutionRoute — the resolved backend decision for ONE worker spawn.
 *
 * Four independent dimensions the factory must select when hiring a worker:
 *
 *   1. executor   — the OS binary / transport: `claude-cli`,
 *                   `claude-cli-simulator`, future `codex-cli`, `local-agent-cli`.
 *   2. provider   — the inference provider: `zai`, `anthropic`, `lmstudio`, ...
 *   3. model      — the model id: `glm-5.2`, `claude-opus-4.6`, ...; `null` for
 *                   executors that are not model-backed (the simulator).
 *   4. inference  — execution policy: `effort`, plus future `timeout`,
 *                   `concurrency`, `tool policy`.
 *
 * The previous design collapsed all four into a single `model` string and
 * encoded the executor kind as `model === "mock"`. That conflated "which binary
 * do we spawn" with "which LM answers the prompt", so a deterministic simulator
 * was masquerading as an LLM model name. This type restores the orthogonality.
 *
 * A `WorkerExecutionRoute` is RESOLVED ONCE at claim time (see
 * ExecutionRouteResolver) and frozen into the `ExecutionContextSnapshot` (v2),
 * so the spawn side, the gateway, and proposal provenance all read the SAME
 * immutable value — no re-reading config at spawn.
 */
export type ExecutorKind =
  /** Real Anthropic / Z.AI Claude CLI (or a configured stand-in). */
  | 'claude-cli'
  /** The deterministic Saga simulator (`tools/claude-cli-simulator.mjs`). */
  | 'claude-cli-simulator';

/** Future transports (codex-cli, local-agent-cli, ...) — reserved. */
export type ExecutorKindFuture = 'codex-cli' | 'local-agent-cli';

/**
 * The resolved route. All four dimensions are explicit; nothing is implicit.
 *
 * - `executor.kind` decides which binary spawn selects.
 * - `provider` / `model` / `effort` are null for non-model executors.
 * - `policyRef` / `policyDigest` cite the routing policy version that produced
 *   this route, so the production journal can always explain WHY a given
 *   WorkIntent was executed by this backend.
 */
export interface WorkerExecutionRoute {
  executor: {
    kind: ExecutorKind;
  };
  provider: {
    id: string;
  } | null;
  model: {
    id: string;
  } | null;
  inference: {
    effort: string | null;
  };
  /** Human-readable ref to the routing policy source (e.g. file path). */
  policyRef: string | null;
  /** Stable digest of the routing policy that produced this route. */
  policyDigest: string | null;
}

/**
 * Inputs the resolver needs to match a route. Routing is keyed on the most
 * specific dimensions first (cell + role), falling back to module, then to a
 * factory default — see ExecutionRouteResolver.
 */
export interface RouteMatchKey {
  module: string | null;
  cell: string | null;
  role: 'author' | 'reviewer' | null;
  executionProfile: string | null;
}

/** Default route when nothing in the policy matches: real claude CLI, z.ai. */
export const DEFAULT_ROUTE: Readonly<WorkerExecutionRoute> = Object.freeze({
  executor: { kind: 'claude-cli' as const },
  provider: { id: 'zai' },
  model: null,
  inference: { effort: null },
  policyRef: null,
  policyDigest: null,
});

/**
 * Project the resolved route into the execution-context model route.
 *
 * This projection MUST preserve null provider/model values for non-model
 * executors. Fabricating `provider='zai'` for the deterministic simulator would
 * corrupt the production journal and make a simulator execution look like an
 * inference call even though no provider was contacted.
 */
export function routeToModelRoute(
  route: WorkerExecutionRoute,
): { provider: string | null; model: string | null; effort: string | null } {
  return {
    provider: route.provider?.id ?? null,
    model: route.model?.id ?? null,
    effort: route.inference.effort ?? null,
  };
}
