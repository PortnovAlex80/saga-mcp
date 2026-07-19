/**
 * Branded IDs at domain boundaries.
 *
 * Source: blueprint §6.2 (docs/architecture/passive-worker-kernel-blueprint.md:237-244).
 *
 * These brands exist so that a plain string cannot be passed where a
 * specific identity is required. They are erased at runtime — a branded
 * ID is just a string — but TypeScript will reject cross-assignment.
 *
 * Slice 0 (this file) introduces the types only. Slice 1+ use them at
 * command-bus boundaries. Nothing here imports from SQLite, Node, tools,
 * or tracker-view (guardrail WP-1, blueprint §17:960-963).
 */

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type CommandId = Brand<string, 'CommandId'>;
export type ExecutionId = Brand<string, 'ExecutionId'>;
export type IntegrationId = Brand<string, 'IntegrationId'>;
export type HumanRequestId = Brand<string, 'HumanRequestId'>;

/**
 * Tag a plain string as a branded ID. Runtime no-op; type-only.
 *
 * Use at the boundary where a string enters the domain (e.g. reading
 * `current_execution_id` from a DB row). Inside the domain, pass the
 * branded value around so it cannot be confused with another identity.
 */
export function asCommandId(value: string): CommandId {
  return value as CommandId;
}

export function asExecutionId(value: string): ExecutionId {
  return value as ExecutionId;
}

export function asIntegrationId(value: string): IntegrationId {
  return value as IntegrationId;
}

export function asHumanRequestId(value: string): HumanRequestId {
  return value as HumanRequestId;
}
