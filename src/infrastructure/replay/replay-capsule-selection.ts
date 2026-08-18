export interface ReplayCapsuleAlias {
  readonly capsule_ref: string;
  readonly payload_hash: string;
}

/**
 * Resolve one semantic replay result, newest-wins.
 *
 * ADR-076 (operator principle, stated in the full-run driver since its first
 * version): "a capsule exists = the material is accepted = we continue";
 * replay capsules are reused by ANY new cycle without temporal/historical
 * binding. Observed live (TrackPlan, 2026-08-18, lifecycle 8): re-runs re-mint
 * semantically identical payloads that embed lifecycle-local physical ids
 * (proposal_id 84 vs 119, otherwise byte-equal) — a stale fail-closed policy
 * here turns every second lifecycle run into a permanent
 * REPLAY_KEY_PAYLOAD_CONFLICT stop. Selection now prefers the NEWEST capsule
 * (last rowid wins — the latest accepted material is the authority) and no
 * longer treats payload divergence on one semantic key as a stop condition.
 * Equal payloads remain pure aliases (deterministic newest pick).
 */
export function selectReplayCapsule<T extends ReplayCapsuleAlias>(
  _replayKey: string,
  capsules: readonly T[],
): T | undefined {
  if (capsules.length === 0) return undefined;
  return capsules[capsules.length - 1];
}
