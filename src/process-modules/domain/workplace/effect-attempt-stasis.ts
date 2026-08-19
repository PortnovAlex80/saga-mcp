// src/process-modules/domain/workplace/effect-attempt-stasis.ts
//
// BLINDSIGHT F1 (persistence layer — PREVENTIVE-HUNT «Слепота по слоям»):
//
// `factory_effect_attempts` is appended on EVERY post-acceptance effect
// invocation with a typed outcome + reason (CONVEYOR §20), yet its reader
// `readEffectAttempts` had ZERO callers. The durable detector data existed
// and no decision point consumed it: an effect that keeps returning the SAME
// `pending`/failure reason kept the Workplace in `effect_pending` forever —
// an unbounded spin with no typed exit. This is the same defect class the
// obligation reason-identity valve already fixed for defer/fail loops
// (transition-obligation-reconciler.ts, CONVEYOR §15 "Budget must count
// spin, not work"); this module applies the identical policy to the effect
// attempt chain:
//
//   - K consecutive attempts with the SAME typed identity (outcome + reason)
//     on one idempotency key = spin → the executor ends the wait with a
//     TYPED human park (fail-closed), never another silent requeue;
//   - a NEW typed identity RESETS the consecutive counter — a converging
//     chain (each attempt removing another defect) is work and is never
//     taxed;
//   - no gate is weakened: the park only ENDS the wait. Final acceptance
//     still demands the exact effect receipt; the park routes the workplace
//     to a human with the typed diagnosis.

/** One durable effect attempt as resolved by `readEffectAttempts` (oldest first). */
export interface EffectAttemptObservation {
  readonly attemptNo: number;
  readonly outcome: string;
  readonly reason: string | null;
}

/** Typed identity of one attempt: identical identity = identical work outcome. */
export type EffectAttemptIdentity = readonly [outcome: string, reason: string | null];

export function effectAttemptIdentity(
  attempt: Pick<EffectAttemptObservation, 'outcome' | 'reason'>,
): EffectAttemptIdentity {
  return [attempt.outcome, attempt.reason ?? null];
}

/**
 * Default K — the number of CONSECUTIVE identical typed attempts that means
 * spin. Mirrors OBLIGATION_VALVE_REPEAT_THRESHOLD (3): below it one more
 * honest retry remains possible; at it the loop must end with a typed
 * escalation instead of waiting for a mechanical attempt budget that does
 * not exist on this path.
 */
export const DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD = 3;

export interface EffectAttemptStasisDetection {
  /** The repeating typed outcome ('pending', 'repair_required', ...). */
  readonly outcome: string;
  /** The repeating typed reason (null when the attempts carry none). */
  readonly reason: string | null;
  /** How many consecutive attempts (ending at the newest) share the identity. */
  readonly consecutive: number;
}

/**
 * Detect stasis over the durable attempt chain (oldest first, as returned by
 * `readEffectAttempts`). Returns the repeating typed identity when at least
 * `repeatThreshold` CONSECUTIVE attempts (ending at the newest) share it;
 * null otherwise. A chain whose typed identities keep changing is
 * convergence, never spin.
 */
export function detectEffectAttemptStasis(
  attempts: readonly EffectAttemptObservation[],
  options: { readonly repeatThreshold?: number } = {},
): EffectAttemptStasisDetection | null {
  const threshold = options.repeatThreshold ?? DEFAULT_EFFECT_ATTEMPT_STASIS_THRESHOLD;
  if (!Number.isSafeInteger(threshold) || threshold < 2) {
    throw new Error(`EFFECT_ATTEMPT_STASIS_THRESHOLD_INVALID: ${threshold}`);
  }
  if (attempts.length === 0) return null;

  // Walk from the NEWEST attempt backwards while the typed identity is
  // unchanged. The newest identity defines the run; any earlier different
  // identity is the reset point (identical to the obligation valve's
  // reasonRepeatCount semantics).
  const newest = attempts[attempts.length - 1]!;
  const identity = effectAttemptIdentity(newest);
  let consecutive = 0;
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const current = attempts[index]!;
    const sameOutcome = current.outcome === identity[0];
    const sameReason = (current.reason ?? null) === identity[1];
    if (sameOutcome && sameReason) {
      consecutive += 1;
    } else {
      break;
    }
  }
  if (consecutive < threshold) return null;
  return {
    outcome: identity[0],
    reason: identity[1],
    consecutive,
  };
}
