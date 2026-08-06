/**
 * Orchestration mode ownership — the single source of truth for the
 * SAGA_ORCHESTRATION_MODE value.
 *
 * The Product Lifecycle runtime is the sole engine. There is
 * exactly ONE mode: 'factory-lifecycle' — the complete durable Discovery →
 * Formalization → Development → Delivery lifecycle through registered
 * GenericFlow module installations.
 *
 * The composition root always returns this lifecycle runtime.
 */

/**
 * The complete enumeration of recognised orchestration modes.
 *
 * An unrecognised value is an error, never a silent fallback — a typo must
 * surface, not silently select the wrong engine. Whitespace and case are
 * normalised so `SAGA_ORCHESTRATION_MODE= Factory-Lifecycle ` still resolves.
 */
export type OrchestrationMode = 'factory-lifecycle';

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = ['factory-lifecycle'];

/**
 * The unconditional default for the complete durable lifecycle.
 */
export const DEFAULT_ORCHESTRATION_MODE: OrchestrationMode = 'factory-lifecycle';

/**
 * Parse a raw env value into a typed OrchestrationMode.
 *
 * Throws on an unknown value instead of falling back — a typo must surface,
 * not silently select the wrong engine. Whitespace and case are normalised so
 * `SAGA_ORCHESTRATION_MODE= Factory-Lifecycle ` still resolves.
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
export function isFactoryLifecycleMode(_mode: OrchestrationMode): boolean {
  return true;
}
