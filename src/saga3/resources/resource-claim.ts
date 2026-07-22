/**
 * Saga 3 — Resource scope claims.
 *
 * Admission safety: two WorkIntents with overlapping write scopes
 * cannot run concurrently. Unknown/incomplete scopes serialize by default.
 *
 * Scope catalog (plan §9.2): 15 types.
 */

export const SCOPE_CATALOG = [
  'file_path', 'schema', 'public_protocol', 'integration_branch',
  'capability', 'invariant', 'aggregate', 'data_owner',
  'migration', 'security_boundary', 'benchmark_env',
  'runtime_resource', 'provider_capacity', 'external_effect',
] as const;
export type ScopeType = (typeof SCOPE_CATALOG)[number];

export interface ResourceScope {
  readonly scopeType: ScopeType;
  readonly scopeValue: string;
}

export interface HeldClaim {
  readonly workIntentId: string;
  readonly scope: ResourceScope;
  readonly claimKind: 'read' | 'write' | 'effect';
  readonly leaseEpoch: number;
  readonly state: 'held' | 'released' | 'revoked';
}

/**
 * Check whether two scopes overlap.
 * file_path / capability / runtime_resource use hierarchical prefix.
 * Everything else uses exact match.
 */
export function scopesOverlap(a: ResourceScope, b: ResourceScope): boolean {
  if (a.scopeType !== b.scopeType) return false;
  if (a.scopeValue === b.scopeValue) return true;

  // Hierarchical types.
  if (a.scopeType === 'file_path') {
    return (
      a.scopeValue.startsWith(b.scopeValue + '/') ||
      b.scopeValue.startsWith(a.scopeValue + '/')
    );
  }
  if (a.scopeType === 'capability' || a.scopeType === 'runtime_resource') {
    return (
      a.scopeValue.startsWith(b.scopeValue + ':') ||
      b.scopeValue.startsWith(a.scopeValue + ':')
    );
  }
  return false;
}

/**
 * Admission decision for a WorkIntent.
 */
export type AdmissionDecision =
  | { readonly admitted: true; readonly canonicalRepoOrder?: readonly string[] }
  | {
      readonly admitted: false;
      readonly reason:
        | 'write_scope_conflict'
        | 'unknown_scope_serialized'
        | 'capacity_full'
        | 'dependency_not_ready'
        | 'budget_exhausted';
      readonly detail: string;
    };

/**
 * Check if a WorkIntent's scopes conflict with held claims.
 */
export function checkScopeConflict(
  writeScopes: readonly ResourceScope[],
  heldClaims: readonly HeldClaim[],
): HeldClaim | null {
  for (const ws of writeScopes) {
    for (const claim of heldClaims) {
      if (claim.state !== 'held') continue;
      if (claim.claimKind === 'write' && scopesOverlap(claim.scope, ws)) {
        return claim;
      }
    }
  }
  return null;
}

/**
 * Supersede descendant claims when upstream changes.
 * Returns workIntentIds whose claims should be revoked.
 * Unrelated branches are preserved.
 */
export function supersedeDescendants(
  changedRootId: string,
  edges: ReadonlyArray<{ readonly from: string; readonly to: string }>,
  heldClaims: readonly HeldClaim[],
): readonly string[] {
  const descendants = new Set<string>();
  const reverseAdj = new Map<string, string[]>();
  for (const e of edges) {
    if (!reverseAdj.has(e.to)) reverseAdj.set(e.to, []);
    reverseAdj.get(e.to)!.push(e.from);
  }
  const queue = [changedRootId];
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const dependent of reverseAdj.get(node) ?? []) {
      if (!descendants.has(dependent)) {
        descendants.add(dependent);
        queue.push(dependent);
      }
    }
  }

  return heldClaims
    .filter((c) => c.state === 'held' && descendants.has(c.workIntentId))
    .map((c) => c.workIntentId);
}

/**
 * Checkpoint salvage: after descendant supersession, allow salvage
 * ONLY after rebase + reauthorization + renewed evidence.
 */
export function canSalvageCheckpoint(input: {
  readonly originalSourceFingerprint: string;
  readonly rebasedSourceFingerprint: string;
  readonly reauthorizedEpoch: number;
  readonly currentEpoch: number;
  readonly renewedEvidenceRequired: boolean;
}): boolean {
  if (input.rebasedSourceFingerprint === input.originalSourceFingerprint) return false;
  if (input.reauthorizedEpoch !== input.currentEpoch) return false;
  if (!input.renewedEvidenceRequired) return false;
  return true;
}
