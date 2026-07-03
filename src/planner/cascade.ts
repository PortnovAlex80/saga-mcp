// src/planner/cascade.ts
//
// SRS-004 §2b.5 — saga-planner impact-cascade.
//
// For every dev-task in a plan, stamp impact- tags so downstream workers know
// which projects a task touches (caution cascade: a task in saga-mcp that
// changes a shared contract also tags harmess).
//
// ============================================================================
// SCAFFOLD ONLY (Pattern B, task #215).
// ============================================================================
// This file fixes the API CONTRACT (PlanTask interface + function signature)
// BEFORE the body-task lands. The function body is a stub that throws
// NotImplementedError. The full implementation (idempotent tag-merge, dedup) is
// body-task AC-9 (#225 — planner cascade + topology-switching +
// theme↔brief carry-state).
//
// Extension point (SRS §2b.5): a new cascade signal = a new function, not a new
// branch in applyImpactCascade. Keep this function single-purpose.
// ============================================================================

/**
 * A task in a plan, as consumed/produced by the planner (SRS §2b.5).
 *
 * This is a planner-side view (id + tags + the other fields the planner cares
 * about). It is intentionally minimal here — body-task AC-9 (#225) may widen it
 * as the planner's needs firm up, without breaking the function signature.
 */
export interface PlanTask {
  id: number;
  tags: string[];
  // ... (other planner fields — widened by body-task AC-9, #225)
  [key: string]: unknown;
}

/**
 * Stamp impact:<pid> tags onto every task in the plan (SRS §2b.5).
 *
 * Postcondition: ∀ task ∈ tasks, ∀ pid ∈ affectedProjectIds:
 *   'impact:'+pid ∈ task.tags
 *
 * SCAFFOLD stub — throws NotImplementedError. Body-task AC-9 (#225) implements
 * the idempotent tag-merge (no duplicate tags, preserves existing tags).
 *
 * @param tasks the plan's tasks.
 * @param affectedProjectIds project ids every task should be tagged with.
 * @returns a new tasks array with the impact tags merged in.
 * @see SRS-004 §2b.5
 * @see body-task AC-9 (#225) — implements the body
 */
export function applyImpactCascade(
  _tasks: PlanTask[],
  _affectedProjectIds: number[],
): PlanTask[] {
  // SCAFFOLD stub — body-task AC-9 (#225) implements the real logic.
  throw new Error('NotImplemented: applyImpactCascade — see body-task AC-9 (#225), SRS §2b.5');
}
