/**
 * Orchestration mode ownership — the single source of truth for the
 * SAGA_ORCHESTRATION_MODE value.
 *
 * saga4 cutover: the Product Lifecycle runtime is the SOLE engine. The legacy
 * 'v2'/'v3'/'saga2' modes (which selected Saga2Engine) have been removed from
 * the union. The remaining modes are all background-engine modes; 'saga3-lifecycle'
 * is the unconditional default and the complete durable lifecycle.
 *
 * The discovery / discovery-generic / formalization modes are retained in the
 * union for backward-compatibility with existing operator config and tests that
 * construct those engines directly, but the composition root now ALWAYS returns
 * the lifecycle runtime regardless of mode. They will be removed in a later
 * cleanup phase once all direct-construction tests are migrated.
 */

/**
 * The complete enumeration of recognised orchestration modes.
 *
 * - 'saga3-discovery'        — retained; engine constructible directly by tests.
 * - 'saga3-discovery-generic' — retained; engine constructible directly by tests.
 * - 'saga3-formalization'    — retained; engine constructible directly by tests.
 * - 'saga3-lifecycle'        — the unconditional default. Complete durable
 *                              Discovery → Formalization → Development → Delivery
 *                              lifecycle through registered GenericFlow module
 *                              installations.
 *
 * An unrecognised value is an error, never a silent fallback. The removed
 * 'v2'/'v3'/'saga2' values are now unknown and will throw at parse time.
 */
export type OrchestrationMode =
  | 'saga3-discovery'
  | 'saga3-discovery-generic'
  | 'saga3-formalization'
  | 'saga3-lifecycle';

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  'saga3-discovery', 'saga3-discovery-generic',
  'saga3-formalization', 'saga3-lifecycle',
];

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
