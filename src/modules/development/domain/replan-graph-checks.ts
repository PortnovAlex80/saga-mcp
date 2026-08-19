/**
 * RE-PLAN CYCLE (docs/architecture/REPLAN-CYCLE-TZ.md §2) — the cycle-2 graph
 * contract, pure predicates.
 *
 * The cycle-2 planner sees the ENTIRE integrated cycle-1 code (the operator's
 * principle), so the re-carve must exploit it. The cycle-2 gate enforces two
 * anti-regression rules on top of the standard task-graph policy:
 *
 *   1. Parallelism — two implementation items whose changeScopes do NOT
 *      overlap must not carry a dependency edge between them. Disjoint scopes
 *      are safe to edit concurrently; a needless edge serializes the graph and
 *      starves concurrency (the whole point of cycle 2).
 *
 *   2. Shared-surface extraction — every path that burned
 *      `path-outside-authority` in cycle 1 must sit INSIDE some cycle-2
 *      item's changeScopes: either the scopes are re-carved around the path,
 *      or a dedicated base-item owns it and the consumers depend on it. A
 *      proposal that leaves the burned path unassigned reproduces the exact
 *      cross-seam defect — and the §6 ratchet will deny cycle 3.
 *
 * Diagnostic codes are STABLE identity (they may enter the finding-set chain
 * as rejection findings): the code + normalized message must be
 * deterministic for the same graph shape.
 */

import {
  parseRepositoryScope,
  repositoryScopesOverlap,
  repositoryScopeContainsPath,
} from '../../../shared/repository-scope.js';

export interface ReplanGraphItem {
  readonly key: string;
  readonly changeScopes: readonly string[];
  readonly dependsOnKeys: readonly string[];
}

export interface ReplanScopeViolation {
  readonly paths: readonly string[];
  readonly scopes: readonly string[];
}

export interface ReplanGraphDiagnostic {
  readonly code: 'replan-serialization-antipattern' | 'replan-shared-surface-unassigned';
  readonly message: string;
}

function scopesOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.some(leftScope =>
    right.some(rightScope => repositoryScopesOverlap(leftScope, rightScope)));
}

/**
 * Rule 1 — the serialization anti-pattern: a DIRECT dependency edge between
 * two implementation items whose changeScopes do not overlap. (Edges between
 * overlapping scopes are REQUIRED safety — the standard policy enforces
 * those; transitive edges are legitimate ordering and stay untouched.)
 */
export function parallelismViolations(
  items: readonly ReplanGraphItem[],
): ReplanGraphDiagnostic[] {
  const byKey = new Map(items.map(item => [item.key, item]));
  const diagnostics: ReplanGraphDiagnostic[] = [];
  const reported = new Set<string>();
  for (const item of items) {
    for (const dependencyKey of item.dependsOnKeys) {
      const dependency = byKey.get(dependencyKey);
      if (!dependency) continue;
      if (scopesOverlap(item.changeScopes, dependency.changeScopes)) continue;
      const pair = [item.key, dependencyKey].sort().join('->');
      if (reported.has(pair)) continue;
      reported.add(pair);
      diagnostics.push({
        code: 'replan-serialization-antipattern',
        message: `re-plan items '${item.key}' and '${dependencyKey}' have non-overlapping changeScopes `
          + `[${item.changeScopes.join(', ')}] vs [${dependency.changeScopes.join(', ')}] `
          + 'yet carry a dependency edge — disjoint scopes are safe to edit concurrently; '
          + 'remove the needless serialization so parallel workers can engage',
      });
    }
  }
  return diagnostics;
}

/**
 * Rule 2 — shared-surface extraction: every path that burned
 * path-outside-authority in cycle 1 must be covered by some cycle-2 item's
 * changeScopes.
 */
export function uncoveredSharedSurfacePaths(
  scopeViolations: readonly ReplanScopeViolation[],
  items: readonly ReplanGraphItem[],
): ReplanGraphDiagnostic[] {
  const parsedScopes = items.flatMap(item =>
    item.changeScopes.map(scope => ({ scope: parseRepositoryScope(scope), item })));
  return scopeViolations.flatMap(violation =>
    violation.paths.filter(path => !parsedScopes.some(entry =>
      repositoryScopeContainsPath(entry.scope, path))).map(path => ({
      code: 'replan-shared-surface-unassigned' as const,
      message: `path '${path}' burned path-outside-authority in cycle 1 under scopes `
        + `[${violation.scopes.join(', ')}] but no re-plan item's changeScopes cover it — `
        + 'extract the shared surface (a base-item owning the path) or re-carve the scopes, '
        + 'otherwise the same cross-seam defect returns and the ratchet denies cycle 3',
    })));
}
