/**
 * Saga 3 — Effect state machine.
 *
 * Durable intent + effectively-once reconciliation.
 * Observe-before-retry: ambiguous effects are observed, not retried.
 * Irreducible ambiguity → EXTERNAL_STATE_UNKNOWN.
 */

// TerminalOutcome used in nextEffectAction return type via string literal.

export type EffectState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'ambiguous'
  | 'already_applied'
  | 'compensated'
  | 'external_state_unknown';

export interface EffectIntent {
  readonly effectKind: string;
  readonly targetIdentity: string;
  readonly idempotencyKey: string;
  readonly generation: number;
  readonly payloadDigest: string;
  readonly observerStrategy: string;
  readonly deadlineMs: number;
  readonly compensationPolicy: 'none' | 'rollback' | 'reverse';
  readonly leaseEpoch: number;
  state: EffectState;
  remainingObservers: number;
}

export interface EffectObservation {
  readonly outcome: 'succeeded' | 'failed' | 'ambiguous' | 'already_applied';
  readonly resultDigest: string;
  readonly detail?: string;
}

export type EffectNextAction =
  | { readonly action: 'execute' }
  | { readonly action: 'observe'; readonly observerIndex: number }
  | { readonly action: 'compensate' }
  | { readonly action: 'terminal'; readonly outcome: 'EXTERNAL_STATE_UNKNOWN'; readonly reason: string }
  | { readonly action: 'done' };

/**
 * Decide what to do after an effect observation.
 * Observe-before-retry: ambiguous → observe again, not retry.
 */
export function nextEffectAction(intent: EffectIntent): EffectNextAction {
  switch (intent.state) {
    case 'pending':
      return { action: 'execute' };
    case 'running':
      return { action: 'observe', observerIndex: 0 };
    case 'succeeded':
    case 'already_applied':
      return { action: 'done' };
    case 'failed':
      return intent.compensationPolicy === 'none'
        ? { action: 'terminal', outcome: 'EXTERNAL_STATE_UNKNOWN', reason: 'failed with no compensation' }
        : { action: 'compensate' };
    case 'ambiguous':
      return intent.remainingObservers > 0
        ? { action: 'observe', observerIndex: 0 }
        : { action: 'terminal', outcome: 'EXTERNAL_STATE_UNKNOWN', reason: 'irreducibly ambiguous' };
    case 'external_state_unknown':
      return { action: 'terminal', outcome: 'EXTERNAL_STATE_UNKNOWN', reason: 'already terminal' };
    case 'compensated':
      return { action: 'done' };
  }
}

export function applyObservation(intent: EffectIntent, obs: EffectObservation): void {
  switch (obs.outcome) {
    case 'succeeded': intent.state = 'succeeded'; break;
    case 'already_applied': intent.state = 'already_applied'; break;
    case 'failed': intent.state = 'failed'; break;
    case 'ambiguous':
      intent.remainingObservers -= 1;
      intent.state = 'ambiguous';
      break;
  }
}

/**
 * No contradictory action after an unresolved material effect.
 */
export function isContradictoryEffect(
  newEffect: { readonly effectKind: string; readonly targetIdentity: string },
  unresolved: readonly EffectIntent[],
): boolean {
  return unresolved.some(
    (u) => u.state === 'external_state_unknown' && u.targetIdentity === newEffect.targetIdentity,
  );
}

// ---------------------------------------------------------------------------
// Integration CAS (plan §9.4)
// ---------------------------------------------------------------------------

export type IntegrationCasResult =
  | { readonly kind: 'merged'; readonly newHead: string }
  | { readonly kind: 'target_advanced'; readonly expectedHead: string; readonly observedHead: string }
  | { readonly kind: 'conflict'; readonly conflictFiles: readonly string[] }
  | { readonly kind: 'already_applied'; readonly head: string };

export function integrationCas(input: {
  readonly reviewedSourceSha: string;
  readonly expectedTargetSha: string;
  readonly observedTargetSha: string;
  readonly mergeResult: 'clean' | 'conflict';
  readonly conflictFiles?: readonly string[];
}): IntegrationCasResult {
  if (input.observedTargetSha === input.reviewedSourceSha)
    return { kind: 'already_applied', head: input.observedTargetSha };
  if (input.observedTargetSha !== input.expectedTargetSha)
    return { kind: 'target_advanced', expectedHead: input.expectedTargetSha, observedHead: input.observedTargetSha };
  if (input.mergeResult === 'conflict')
    return { kind: 'conflict', conflictFiles: input.conflictFiles ?? [] };
  return { kind: 'merged', newHead: input.reviewedSourceSha };
}
