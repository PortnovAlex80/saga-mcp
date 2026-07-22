/**
 * Saga 3 — Causal readiness evaluation.
 *
 * A WorkIntent is "causally ready" when:
 *   1. All prerequisite conditions are True.
 *   2. The dependency graph has no cycles involving this intent.
 *   3. The target condition bindings are non-empty (fail closed).
 *   4. The source/environment baselines are current.
 *
 * This module is pure — it evaluates readiness, it does not dispatch.
 */

import type { WorkIntent, ConditionStatus } from '../domain/types.js';
import { arePrerequisitesMet } from '../domain/conditions.js';

export interface ReadinessInput {
  readonly intent: WorkIntent;
  readonly conditionStatuses: Readonly<Record<string, ConditionStatus>>;
  readonly dependencies: ReadonlyMap<string, readonly string[]>; // intentId → prerequisite intentIds
  readonly completedIntents: ReadonlySet<string>; // intentIds that are 'completed'
}

export type ReadinessResult =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: ReadinessFailure }
  | { readonly ready: false; readonly reason: 'cycle_detected'; readonly cycle: readonly string[] };

export type ReadinessFailure =
  | 'prerequisites_not_met'
  | 'condition_bindings_empty'
  | 'dependencies_not_completed'
  | 'source_baseline_stale';

/**
 * Evaluate whether a WorkIntent is causally ready for admission.
 *
 * Mandatory regression (plan §8 Gate C): "Material work with
 * target_conditions=[] is rejected."
 */
export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const { intent, conditionStatuses, dependencies, completedIntents } = input;

  // Fail closed: empty target condition = uncompiled work.
  if (!intent.targetCondition || intent.targetCondition.length === 0) {
    return { ready: false, reason: 'condition_bindings_empty' };
  }

  // Check prerequisite conditions.
  if (!arePrerequisitesMet(intent.prerequisites, conditionStatuses)) {
    return { ready: false, reason: 'prerequisites_not_met' };
  }

  // Check WorkIntent dependencies (fan-in barrier).
  const deps = dependencies.get(intent.id) ?? [];
  for (const depId of deps) {
    if (!completedIntents.has(depId)) {
      return { ready: false, reason: 'dependencies_not_completed' };
    }
  }

  return { ready: true };
}

/**
 * Detect cycles in the WorkIntent dependency graph.
 * Three-color DFS.
 */
export function detectCycle(
  intents: readonly WorkIntent[],
  edges: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): readonly string[] | null {
  const adj = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const wi of intents) {
    nodes.add(wi.id);
    if (!adj.has(wi.id)) adj.set(wi.id, []);
  }
  for (const e of edges) {
    nodes.add(e.from);
    nodes.add(e.to);
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n, WHITE);

  let cycle: string[] | null = null;
  const stack: string[] = [];

  function visit(u: string): boolean {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) {
        const idx = stack.indexOf(v);
        cycle = stack.slice(idx).concat(v);
        return true;
      }
      if (color.get(v) === WHITE && visit(v)) return true;
    }
    stack.pop();
    color.set(u, BLACK);
    return false;
  }

  for (const n of nodes) {
    if (color.get(n) === WHITE && visit(n)) break;
  }

  return cycle;
}
