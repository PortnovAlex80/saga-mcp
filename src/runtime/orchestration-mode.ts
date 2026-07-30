/**
 * Orchestration mode ownership — the single source of truth for the
 * SAGA_ORCHESTRATION_MODE value.
 *
 * saga4 cutover: the Product Lifecycle runtime is the SOLE engine. There is
 * exactly ONE mode: 'saga3-lifecycle' — the complete durable Discovery →
 * Formalization → Development → Delivery lifecycle through registered
 * GenericFlow module installations.
 *
 * The legacy 'v2'/'v3'/'saga2' modes (which selected Saga2Engine) and the
 * earlier 'saga3-discovery' / 'saga3-discovery-generic' / 'saga3-formalization'
 * modes have all been removed. The composition root ALWAYS returns the lifecycle
 * runtime regardless of mode; those three were dead configuration that misled
 * operators into thinking a different engine would run.
 */

/**
 * The complete enumeration of recognised orchestration modes.
 *
 * An unrecognised value is an error, never a silent fallback — a typo must
 * surface, not silently select the wrong engine. Whitespace and case are
 * normalised so `SAGA_ORCHESTRATION_MODE= Saga3-Lifecycle ` still resolves.
 */
export type OrchestrationMode = 'saga3-lifecycle';

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = ['saga3-lifecycle'];

/**
 * The unconditional default. After the saga4 cutover the Product Lifecycle
 * runtime is the only engine; saga3-lifecycle is the complete durable lifecycle.
 */
export const DEFAULT_ORCHESTRATION_MODE: OrchestrationMode = 'saga3-lifecycle';

/**
 * Parse a raw env value into a typed OrchestrationMode.
 *
 * Throws on an unknown value instead of falling back — a typo must surface,
 * not silently select the wrong engine. Whitespace and case are normalised so
 * `SAGA_ORCHESTRATION_MODE= Saga3-Lifecycle ` still resolves.
 */
export function parseOrchestrationMode(value: string | undefined): OrchestrationMode {
  if (value === undefined || value.trim() === '') return DEFAULT_ORCHESTRATION_MODE;
  const normalized = value.trim().toLowerCase();
  if (!ORCHESTRATION_MODES.includes(normalized as OrchestrationMode)) {
    throw new Error(
      `Unknown SAGA_ORCHESTRATION_MODE='${value}'. Expected one of [${ORCHESTRATION_MODES.join(', ')}].`,
    );
  }
  return normalized as OrchestrationMode;
}

/**
 * Does this mode spawn a background orchestrate-cli engine process?
 *
 * Every retained mode runs a background engine. Kept as a function (not a
 * constant) so tracker-view's import surface and the spawn gate stay stable.
 */
export function requiresBackgroundEngine(_mode: OrchestrationMode): boolean {
  return true;
}

/**
 * The composition root always builds the Product Lifecycle runtime now. Kept as
 * a named predicate so the composition-root call site stays self-documenting.
 */
export function isSaga3LifecycleMode(_mode: OrchestrationMode): boolean {
  return true;
}
