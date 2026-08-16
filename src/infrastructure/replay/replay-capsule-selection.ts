export interface ReplayCapsuleAlias {
  readonly capsule_ref: string;
  readonly payload_hash: string;
}

/**
 * Resolve one semantic replay result without using insertion time as authority.
 * Equal payloads are aliases of the same result; divergent payloads for one
 * semantic replay key are an authority conflict and must fail closed.
 */
export function selectReplayCapsule<T extends ReplayCapsuleAlias>(
  replayKey: string,
  capsules: readonly T[],
): T | undefined {
  if (capsules.length === 0) return undefined;
  const payloadHashes = new Set(capsules.map(capsule => capsule.payload_hash));
  if (payloadHashes.size !== 1) {
    throw new Error(`REPLAY_KEY_PAYLOAD_CONFLICT:${replayKey}`);
  }
  return [...capsules].sort((left, right) =>
    left.capsule_ref.localeCompare(right.capsule_ref))[0];
}
