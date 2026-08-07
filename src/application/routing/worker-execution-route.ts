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
 * The route policy may override inference fields, but when a real executor does
 * not explicitly override one of them the claim-time lifecycle selection is
 * inherited. This preserves the model/provider selected from the front while
 * still allowing cell/role/profile-specific overrides.
 */
export type ExecutorKind =
  | 'claude-cli'
  | 'claude-cli-simulator';

export type ExecutorKindFuture = 'codex-cli' | 'local-agent-cli';

export interface WorkerExecutionRoute {
  executor: {
    kind: ExecutorKind;
  };
  /** Null on simulator; on claude-cli null means "inherit claim-time provider". */
  provider: {
    id: string;
  } | null;
  /** Null on simulator; on claude-cli null means "inherit claim-time model". */
  model: {
    id: string;
  } | null;
  inference: {
    /** Null on simulator; on claude-cli null means "inherit claim-time effort". */
    effort: string | null;
  };
  policyRef: string | null;
  policyDigest: string | null;
}

export interface RouteMatchKey {
  module: string | null;
  cell: string | null;
  role: 'author' | 'reviewer' | null;
  executionProfile: string | null;
}

/**
 * The no-policy default selects the real executor but intentionally leaves
 * inference unpinned here. Provider/model/effort come from the lifecycle
 * execution controls and are frozen only after route resolution at claim.
 */
export const DEFAULT_ROUTE: Readonly<WorkerExecutionRoute> = Object.freeze({
  executor: { kind: 'claude-cli' as const },
  provider: null,
  model: null,
  inference: { effort: null },
  policyRef: null,
  policyDigest: null,
});

export interface ClaimTimeInferenceRoute {
  provider: string | null;
  model: string | null;
  effort: string | null;
}

/**
 * Produce the FINAL inference route that is persisted in execution_context.
 *
 * Simulator: inference is always null in all dimensions.
 * Real executor: policy values override only the fields they explicitly carry;
 * all other fields inherit the already-read claim-time lifecycle selection.
 * No config is read again after this projection.
 */
export function routeToModelRoute(
  route: WorkerExecutionRoute,
  claimTime: ClaimTimeInferenceRoute = {
    provider: null,
    model: null,
    effort: null,
  },
): ClaimTimeInferenceRoute {
  if (route.executor.kind === 'claude-cli-simulator') {
    return { provider: null, model: null, effort: null };
  }
  return {
    provider: route.provider?.id ?? claimTime.provider,
    model: route.model?.id ?? claimTime.model,
    effort: route.inference.effort ?? claimTime.effort,
  };
}
