/**
 * Saga 3 — Condition projection and evaluation.
 *
 * Conditions are the source of truth. Stages are derived. Dispatch is
 * condition-driven. This module owns condition evaluation, aggregation,
 * invalidation, and deficit selection.
 */

import type {
  ConditionInstance,
  ConditionStatus,
  EvidenceRecord,
} from './types.js';

/**
 * Evaluate a single condition's status against current evidence.
 *
 * A condition is True only if evidence exists at the current generation
 * and source fingerprint. Otherwise it degrades to Unknown.
 */
export function evaluateCondition(
  condition: ConditionInstance,
  evidence: EvidenceRecord | null,
  activeGeneration: number,
  currentSourceFingerprint: string,
  now: number = Date.now(),
): ConditionStatus {
  void condition;
  // No evidence → Unknown (never True without proof).
  if (!evidence) return 'Unknown';

  // Stale generation → Unknown.
  if (evidence.generation !== activeGeneration) return 'Unknown';

  if (evidence.freshnessMaxAgeMs >= 0
      && now - evidence.observedAt > evidence.freshnessMaxAgeMs) return 'Unknown';

  // Source changed after evidence → Unknown.
  if (evidence.sourceFingerprint !== currentSourceFingerprint) {
    return 'Unknown';
  }

  // Evidence says passed → condition is True.
  // Evidence says failed → condition is False.
  // Evidence says unknown/error → condition is Unknown.
  if (evidence.verdict === 'passed') return 'True';
  if (evidence.verdict === 'failed') return 'False';
  return 'Unknown';
}

/**
 * Aggregate child conditions into a parent (e.g. ImplementationComplete
 * from scoped children). all_true: every child must be True.
 */
export function aggregate(
  mode: 'all_true' | 'any_true',
  children: readonly ConditionStatus[],
): ConditionStatus {
  if (children.length === 0) return 'Unknown';
  if (mode === 'all_true') {
    if (children.every((s) => s === 'True')) return 'True';
    if (children.some((s) => s === 'False')) return 'False';
    return 'Unknown';
  }
  // any_true
  if (children.some((s) => s === 'True')) return 'True';
  if (children.every((s) => s === 'False')) return 'False';
  return 'Unknown';
}

/**
 * Select the highest-priority deficit: a target condition that is not True.
 * Returns conditions in priority order (blocker first).
 */
export function selectDeficits(
  targetConditions: readonly string[],
  statuses: Readonly<Record<string, ConditionStatus>>,
): readonly string[] {
  return targetConditions.filter((c) => statuses[c] !== 'True');
}

/**
 * Compute the descendant closure for invalidation. When a root condition
 * changes, all transitive dependents must become Unknown.
 */
export function invalidationClosure(
  roots: ReadonlyArray<{ readonly conditionType: string }>,
  edges: ReadonlyArray<{ readonly from: string; readonly to: string }>,
): readonly string[] {
  const result = new Set<string>();
  const queue = roots.map((r) => r.conditionType);
  const seen = new Set<string>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    result.add(node);
    for (const e of edges) {
      if (e.from === node) queue.push(e.to);
    }
  }

  return [...result];
}

/**
 * Derive a display label from conditions. For UI only — never authorizes
 * dispatch. Returns the first stage whose entry conditions are not all True.
 */
export function deriveDisplayStage(
  stages: ReadonlyArray<{ readonly stage: string; readonly entryConditions: readonly string[] }>,
  statuses: Readonly<Record<string, ConditionStatus>>,
): string {
  for (const s of stages) {
    const entered = s.entryConditions.every((c) => statuses[c] === 'True');
    if (!entered) return s.stage;
  }
  return 'completed';
}

/**
 * Check if a WorkIntent's prerequisites are all satisfied.
 * This is causal readiness — the WorkIntent cannot run until its
 * prerequisite conditions are True.
 */
export function arePrerequisitesMet(
  prerequisites: readonly string[],
  statuses: Readonly<Record<string, ConditionStatus>>,
): boolean {
  return prerequisites.every((p) => statuses[p] === 'True');
}
