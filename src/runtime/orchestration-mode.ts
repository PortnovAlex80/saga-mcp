/**
 * Orchestration mode ownership — the single source of truth for the
 * SAGA_ORCHESTRATION_MODE value.
 *
 * Background (review of the D0 implementation): mode selection was scattered
 * across three places with three different meanings:
 *   - config loader: `env.SAGA_ORCHESTRATION_MODE || 'v2'`
 *   - composition root: `mode === 'saga3-discovery' ? Saga3 : Saga2`
 *   - tracker-view: `mode === 'v3'` (start the background engine)
 *
 * That produced a split-brain: a typo like 'saga3-discovry' silently fell
 * through to Saga2Engine while the tracker still spawned a background process
 * that believed it was running. This module centralises parsing and the
 * "does this mode run a background engine?" question so there is exactly one
 * place that defines each.
 *
 * A Git branch carries the IMPLEMENTATION of a mode; the env carries the
 * SELECTION of a mode. A branch must not silently switch the default to an
 * experimental engine — that is an implicit behaviour change, not a feature
 * flag. The default therefore remains the stable Saga 2 mode; saga3-discovery
 * must be selected explicitly.
 */

/**
 * The complete enumeration of recognised orchestration modes.
 *
 * - 'v2'            — Saga 2 product orchestrator driven by the saga-orchestrator
 *                     skill in main context. No background engine process.
 * - 'v3'            — Saga 2 autonomous background pump (orchestrate.ts).
 * - 'saga2'         — alias of 'v3' (same Saga2Engine, clearer name).
 * - 'saga3-discovery' — Saga 3 Discovery Edition background engine.
 *
 * Only 'saga3-discovery' selects a non-Saga2 engine today. New modes are
 * appended here AND in parseOrchestrationMode; an unrecognised value is an
 * error, never a silent fallback.
 */
export type OrchestrationMode = 'v2' | 'v3' | 'saga2' | 'saga3-discovery';

export const ORCHESTRATION_MODES: readonly OrchestrationMode[] = [
  'v2', 'v3', 'saga2', 'saga3-discovery',
];

/** The stable default. Never an experimental engine (see header). */
export const DEFAULT_ORCHESTRATION_MODE: OrchestrationMode = 'v2';

/**
 * Parse a raw env value into a typed OrchestrationMode.
 *
 * Throws on an unknown value instead of falling back — a typo must surface,
 * not silently select the wrong engine. Whitespace and case are normalised so
 * `SAGA_ORCHESTRATION_MODE= Saga3-Discovery ` still resolves.
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
 * 'v2' drives the flow from the saga-orchestrator skill in the main context —
 * no background pump. Every other recognised mode spawns the autonomous
 * engine. The tracker-view start gate and the engine administration must both
 * use THIS function instead of their own ad-hoc comparisons, so the two can
 * never disagree.
 */
export function requiresBackgroundEngine(mode: OrchestrationMode): boolean {
  return mode !== 'v2';
}

/**
 * Does this mode select the Saga 3 Discovery engine? Centralised so the
 * composition root and any future dispatcher agree on exactly one condition.
 */
export function isSaga3DiscoveryMode(mode: OrchestrationMode): boolean {
  return mode === 'saga3-discovery';
}
