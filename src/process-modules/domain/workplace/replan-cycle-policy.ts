/**
 * RE-PLAN CYCLE (docs/architecture/REPLAN-CYCLE-TZ.md §6) — the cap and the
 * monotonic ratchet, pure decision.
 *
 * Re-plan wins when ONE non-converging cross-seam defect exists (the repair
 * is impossible, not slow — REPLAN-CYCLE-TZ.md economics). Two rules keep
 * the mechanism from becoming an eternal loop:
 *
 *   CAP     — at most {@link REPLAN_CYCLE_CAP} re-plan cycles per case
 *             lineage. A further scope-impossible trigger is a human_required
 *             park carrying the FULL diagnosis (surviving keys + every prior
 *             burn), never a third cycle.
 *
 *   RATCHET — every minted mandate must burn at least one finding key ABSENT
 *             from ALL prior mandates of the lineage. The same
 *             path-outside-authority key surviving the re-carve means the
 *             cycle-2 planner REPRODUCED the burn — a new plan would walk
 *             into the same wall, so no cycle 3.
 *
 * The count (replanCycleCount) is realized by the caller as the count of
 * minted mandates over the append-only factory_replan_mandates ledger (K13
 * house pattern): one immutable row per mandate, keyed by the case lineage.
 */

/** Maximum re-plan cycles per case lineage (cycle 1 is the original plan). */
export const REPLAN_CYCLE_CAP = 2;

export interface PriorReplanMandate {
  readonly cycleNumber: number;
  readonly survivingKeys: readonly string[];
}

export type ReplanCycleVerdict =
  | { readonly allowed: true; readonly reason: 'mint'; readonly cycleNumber: number; readonly diagnosis: string }
  | { readonly allowed: false; readonly reason: 'cap' | 'ratchet'; readonly cycleNumber: number; readonly diagnosis: string };

/**
 * Decide whether a scope-impossible trigger may mint the next re-plan cycle.
 * `cycleNumber` on a mint is the cycle being created (prior.length + 2:
 * the first mandate mints cycle 2); on a denial it is the cycle that was
 * REFUSED. Pure: same input → same verdict and diagnosis.
 */
export function decideReplanCycle(input: {
  readonly survivingKeys: readonly string[];
  readonly priorMandates: readonly PriorReplanMandate[];
}): ReplanCycleVerdict {
  const { survivingKeys, priorMandates } = input;
  const nextCycleNumber = priorMandates.length + 2;
  const priorBurns = priorMandates
    .map(mandate => `cycle ${mandate.cycleNumber}: ${mandate.survivingKeys.join(' | ')}`)
    .join('; ');
  const diagnosis = `re-plan lineage diagnosis — this trigger's surviving path-outside-authority `
    + `key(s): ${survivingKeys.join(' | ')}. Prior graph burn(s): ${priorBurns || 'none'}.`;
  if (priorMandates.length >= REPLAN_CYCLE_CAP) {
    return {
      allowed: false,
      reason: 'cap',
      cycleNumber: nextCycleNumber,
      diagnosis: `${diagnosis} The re-plan cap (${REPLAN_CYCLE_CAP} cycles) is reached — `
        + 'human decision required; no further cycle is minted.',
    };
  }
  const burned = new Set(priorMandates.flatMap(mandate => mandate.survivingKeys));
  const novel = survivingKeys.filter(key => !burned.has(key));
  if (priorMandates.length >= 1 && novel.length === 0) {
    return {
      allowed: false,
      reason: 'ratchet',
      cycleNumber: nextCycleNumber,
      diagnosis: `${diagnosis} Ratchet: every surviving key of this trigger already burned a `
        + `prior mandate — the re-carve reproduced the cross-seam defect; no further cycle is minted.`,
    };
  }
  return {
    allowed: true,
    reason: 'mint',
    cycleNumber: nextCycleNumber,
    diagnosis,
  };
}
