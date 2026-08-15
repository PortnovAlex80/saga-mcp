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
 *
 * Wave 1 re-check 2026-08-02 (WAVE-1-REMARKS.txt §"ПОВТОРНАЯ ПРОВЕРКА"):
 * adds FenceToken and CardId as distinct brands with RUNTIME-VALIDATING
 * constructors. CardId (Brand<number>) makes the card identity nominally
 * distinct from any other number in the system; FenceToken is the
 * capability a worker must present to mutate a fenced task. The two are
 * the same value at runtime (the fence token equals the worker execution
 * id) but are DIFFERENT types at the boundary so a plain string cannot
 * flow into a mutating call by accident.
 */

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type CommandId = Brand<string, 'CommandId'>;
export type ExecutionId = Brand<string, 'ExecutionId'>;
export type IntegrationId = Brand<string, 'IntegrationId'>;
export type HumanRequestId = Brand<string, 'HumanRequestId'>;

/**
 * Capability token a worker must present on every mutating call
 * (worker_done / worker_merge_*). At runtime it is the same value as
 * the worker execution id; the brand exists so a caller cannot pass an
 * arbitrary string where the fence capability is required.
 */
export type FenceToken = Brand<string, 'FenceToken'>;

/**
 * Identity of a work card (the durable projected task). Branded over
 * `number` so a card identity cannot be confused with any other numeric
 * id (processRunId, epicId, repositoryId, …) at a call site.
 */
export type CardId = Brand<number, 'CardId'>;

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

/**
 * Construct a FenceToken from a plain string with runtime validation.
 *
 * A fence token is NEVER empty — an empty string cannot be the value of
 * `tasks.current_execution_id` for a fenced task. Throws on non-string
 * or empty/whitespace-only input. The runtime check is the re-check's
 * required guard: a missing or malformed fence must be rejected at the
 * boundary, not deep inside the dispatcher.
 */
export function asFenceToken(value: string): FenceToken {
  if (typeof value !== 'string') {
    throw new Error(`asFenceToken: expected string, got ${typeof value}`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw new Error('asFenceToken: fence token must not be empty');
  }
  return value as FenceToken;
}

/**
 * Construct a CardId from a plain number with runtime validation.
 *
 * A card id is the durable projected-task id. It must be a positive
 * integer (SQLite rowid). Throws on non-number, non-integer, or
 * non-positive input. The check rejects sentinel values (-1, 0, NaN)
 * that would otherwise flow into fence checks and silently mismatch.
 */
export function asCardId(value: number): CardId {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`asCardId: expected finite number, got ${value}`);
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`asCardId: expected positive integer, got ${value}`);
  }
  return value as CardId;
}
