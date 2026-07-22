/**
 * Saga 3 — Parallel execution: fan-out/fan-in, descendant invalidation,
 * concurrency equivalence.
 *
 * Plan §9.3-9.4: fan-in barrier, descendant invalidation, unrelated-branch
 * preservation. Plan §12 Gate G: concurrency-1 vs N terminal equivalence.
 */

import type { WorkIntent } from '../domain/types.js';
import {
  supersedeDescendants,
  type HeldClaim,
} from './resource-claim.js';

/**
 * Fan-in: a downstream WorkIntent is eligible only when every required
 * predecessor has an accepted disposition + integrated evidence.
 */
export function isFanInReady(input: {
  readonly intent: WorkIntent;
  readonly predecessors: ReadonlyMap<string, { readonly status: string; readonly hasEvidence: boolean }>;
}): { readonly ready: boolean; readonly blockedBy: readonly string[] } {
  const blockedBy: string[] = [];
  // FanIn group check: all members of the same fanInGroup must be completed.
  // The intent's prerequisites encode the fan-in dependencies.
  for (const depId of input.intent.prerequisites) {
    const pred = input.predecessors.get(depId);
    if (!pred) {
      blockedBy.push(depId);
    } else if (pred.status !== 'completed' || !pred.hasEvidence) {
      blockedBy.push(depId);
    }
  }
  return { ready: blockedBy.length === 0, blockedBy };
}

/**
 * Descendant invalidation: when upstream changes, compute which held
 * claims must be revoked. Unrelated branches are preserved.
 *
 * Returns workIntentIds whose work is now stale.
 */
export function computeInvalidation(input: {
  readonly changedRootId: string;
  readonly edges: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly heldClaims: readonly HeldClaim[];
}): {
  readonly revoke: readonly string[];
  readonly preserve: readonly string[];
} {
  const revoke = new Set(
    supersedeDescendants(input.changedRootId, input.edges, input.heldClaims),
  );
  const all = new Set(input.heldClaims.filter((c) => c.state === 'held').map((c) => c.workIntentId));
  const preserve = [...all].filter((id) => !revoke.has(id));
  return { revoke: [...revoke], preserve };
}

/**
 * Concurrency equivalence: verify that running the same WorkIntents
 * at concurrency=1 and concurrency=N produces the same SET of admitted
 * intents (only ordering/throughput differ).
 *
 * This is a property test helper — run both schedules and compare sets.
 */
export function assertConcurrencyEquivalence(input: {
  readonly schedule1: readonly string[]; // admitted intentIds at concurrency=1
  readonly scheduleN: readonly string[]; // admitted intentIds at concurrency=N
}): { readonly equivalent: boolean; readonly onlyIn1: readonly string[]; readonly onlyInN: readonly string[] } {
  const set1 = new Set(input.schedule1);
  const setN = new Set(input.scheduleN);
  const onlyIn1 = [...set1].filter((id) => !setN.has(id));
  const onlyInN = [...setN].filter((id) => !set1.has(id));
  return { equivalent: onlyIn1.length === 0 && onlyInN.length === 0, onlyIn1, onlyInN };
}

/**
 * Fencing check: reject a late result if the submitting work intent's
 * epoch is stale (superseded or revoked).
 *
 * Every authoritative commit must re-check the fencing epoch.
 */
export function isFenced(input: {
  readonly workIntentId: string;
  readonly submittedEpoch: number;
  readonly currentEpoch: number;
  readonly revokedIntents: ReadonlySet<string>;
}): boolean {
  if (input.revokedIntents.has(input.workIntentId)) return true;
  return input.submittedEpoch !== input.currentEpoch;
}
