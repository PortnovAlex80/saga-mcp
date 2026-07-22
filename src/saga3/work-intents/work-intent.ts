/**
 * Saga 3 — WorkIntent materialization.
 *
 * The controller materializes a WorkIntent when it finds a condition deficit
 * that has an ActionContract. The WorkIntent is the unique, durable record
 * of "the controller decided this work is admissible".
 *
 * Deterministic uniqueness: two controllers observing the same deficit
 * produce the same key → one WorkIntent, one budget reservation.
 */

import type {
  ActionContract,
  WorkIntent,
  WorkIntentStatus,
} from '../domain/types.js';

/**
 * Build the deterministic uniqueness key.
 * Two controllers that see the same deficit produce the same key.
 */
export function workIntentKey(input: {
  readonly generation: number;
  readonly targetCondition: string;
  readonly targetObligation: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly strategyId: string;
}): string {
  return [
    input.generation,
    input.targetCondition,
    input.targetObligation,
    input.scopeType,
    input.scopeId,
    input.strategyId,
  ].join('::');
}

/**
 * Materialize a WorkIntent from an ActionContract + deficit context.
 * Pure function — produces the intent, caller persists it.
 */
export function materializeWorkIntent(input: {
  readonly episodeSpecId: string;
  readonly generation: number;
  readonly action: ActionContract;
  readonly obligationId: string;
  readonly scopeType: string;
  readonly scopeId: string;
  readonly origin?: 'normal' | 'recovery';
  readonly parentIncidentId?: string | null;
  readonly readScopes?: readonly string[];
  readonly writeScopes?: readonly string[];
  readonly conflictKeys?: readonly string[];
  readonly budgetReservation?: number | null;
}): WorkIntent {
  return {
    id: '', // caller assigns via id source
    episodeSpecId: input.episodeSpecId,
    generation: input.generation,
    targetCondition: input.action.targetCondition,
    targetObligation: input.obligationId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    strategyId: input.action.actionKind,
    origin: input.origin ?? 'normal',
    parentIncidentId: input.parentIncidentId ?? null,
    skillId: input.action.skillId,
    prerequisites: input.action.prerequisites,
    readScopes: input.readScopes ?? [],
    writeScopes: input.writeScopes ?? [],
    conflictKeys: input.conflictKeys ?? [],
    budgetReservation: input.budgetReservation ?? null,
    status: 'materialized',
  };
}

/**
 * Deduplicate WorkIntents by their deterministic key.
 */
export function dedupeWorkIntents(intents: readonly WorkIntent[]): readonly WorkIntent[] {
  const seen = new Map<string, WorkIntent>();
  for (const wi of intents) {
    const key = workIntentKey({
      generation: wi.generation,
      targetCondition: wi.targetCondition,
      targetObligation: wi.targetObligation,
      scopeType: wi.scopeType,
      scopeId: wi.scopeId,
      strategyId: wi.strategyId,
    });
    if (!seen.has(key)) seen.set(key, wi);
  }
  return [...seen.values()];
}

/**
 * Transition a WorkIntent's status.
 * Returns a new WorkIntent — WorkIntents are not mutated in place in
 * the domain layer (the store applies the mutation).
 */
export function transitionWorkIntent(
  wi: WorkIntent,
  newStatus: WorkIntentStatus,
): WorkIntent {
  const valid: Record<WorkIntentStatus, readonly WorkIntentStatus[]> = {
    materialized: [],
    admitted: ['materialized'],
    assigned: ['admitted'],
    completed: ['assigned'],
    cancelled: ['materialized', 'admitted'],
    failed: ['assigned'],
  };
  if (!valid[newStatus].includes(wi.status)) {
    throw new Error(
      `WorkIntent: invalid transition ${wi.status} → ${newStatus}`,
    );
  }
  return { ...wi, status: newStatus };
}
