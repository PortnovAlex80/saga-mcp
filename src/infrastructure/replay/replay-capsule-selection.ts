export interface ReplayCapsuleAlias {
  readonly capsule_ref: string;
  readonly payload_hash: string;
}

/**
 * Typed outcome of resolving one semantic replay key.
 *
 * `conflict` is NOT an error and NOT a stop: it states that one semantic key
 * carries divergent payloads, so no capsule can be presented as authority.
 * The caller records invalidation evidence (ADR-080 §2) and degrades to a
 * normal miss — the execution then takes its ordinary selected route and
 * regenerates the material (ADR-080 §§3-4).
 */
export type ReplayCapsuleSelection<T extends ReplayCapsuleAlias> =
  | { readonly outcome: 'miss' }
  | { readonly outcome: 'hit'; readonly capsule: T }
  | { readonly outcome: 'conflict'; readonly capsules: readonly T[] };

/**
 * Resolve one semantic replay result.
 *
 * CONVEYOR §9 / DRAGON law #1: replay identity is SEMANTIC. "The newest
 * capsule wins" is recency-as-authority in the material path and is therefore
 * forbidden — a later capsule is not more authoritative than an earlier one,
 * it is merely later. A previous revision of this function returned
 * `capsules[capsules.length - 1]` (last rowid wins) to stop a fail-closed
 * REPLAY_KEY_PAYLOAD_CONFLICT from permanently halting every second lifecycle
 * run. That patch cured the symptom by installing the exact defect the model
 * bans, and it broke the third run instead (a capsule from run N-2 could be
 * bound against a baseline frozen in run N-1 →
 * FINAL_PRESENTATION_FENCE_MISMATCH with no invalidate/regenerate path).
 *
 * The lawful resolution keeps BOTH properties:
 *
 *   - equal payloads on one key are pure aliases → a deterministic hit that
 *     does not depend on insertion order (ordered by capsule_ref, never by
 *     rowid/recency);
 *   - divergent payloads on one key are an ambiguity → `conflict`, which the
 *     caller turns into persisted evidence + a typed MISS. The run continues
 *     on the normally selected model instead of stopping, and no capsule is
 *     ever promoted to authority by being newer.
 *
 * Divergence itself is a symptom of run-local identity leaking into a capsule
 * payload (observed: proposal_id 84 vs 119, otherwise byte-equal). Excluding
 * that provenance from payload identity is the upstream fix; degrading to a
 * miss is the safe behaviour while any such capsule still exists.
 */
export function selectReplayCapsule<T extends ReplayCapsuleAlias>(
  _replayKey: string,
  capsules: readonly T[],
): ReplayCapsuleSelection<T> {
  if (capsules.length === 0) return { outcome: 'miss' };
  const distinctPayloads = new Set(capsules.map(capsule => capsule.payload_hash));
  if (distinctPayloads.size > 1) return { outcome: 'conflict', capsules };
  // Pure aliases: identical material under one semantic key. Pick by stable
  // ref ordering so two hosts observing the same rows in any insertion order
  // resolve the same capsule.
  const [capsule] = [...capsules].sort((left, right) =>
    left.capsule_ref < right.capsule_ref ? -1 : left.capsule_ref > right.capsule_ref ? 1 : 0,
  );
  return { outcome: 'hit', capsule };
}
