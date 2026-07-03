// src/planner/cascade.ts
//
// SRS-004 §2b.5 — saga-planner impact-cascade.
//
// For every dev-task in a plan, stamp impact:<pid> tags so downstream workers know
// which projects a task touches (caution cascade: a task in saga-mcp that
// changes a shared contract also tags harmess).
//
// ============================================================================
// Implemented by body-task AC-9 (#225).
// ============================================================================
// The API CONTRACT (PlanTask interface + function signature) was fixed by
// SCAFFOLD #215 (Pattern B). This file now implements the full body from
// SRS-004 §2b.5: an idempotent tag-merge that guarantees the postcondition
//
//   ∀ task ∈ tasks, ∀ pid ∈ affectedProjectIds: 'impact:'+pid ∈ task.tags
//
// without duplicating tags or clobbering a task's existing tags.
//
// Extension point (SRS §2b.5): a new cascade signal = a new function, not a new
// branch in applyImpactCascade. Keep this function single-purpose.
// ============================================================================

/**
 * A task in a plan, as consumed/produced by the planner (SRS §2b.5).
 *
 * This is a planner-side view (id + tags + the other fields the planner cares
 * about). It is intentionally minimal — only `id` and `tags` are read here; the
 * open index signature lets the planner carry whatever else it needs without
 * breaking this function's signature.
 */
export interface PlanTask {
  id: number;
  tags: string[];
  // ... (other planner fields — widened by the planner as needed)
  [key: string]: unknown;
}

/**
 * Stamp impact:<pid> tags onto every task in the plan (SRS §2b.5).
 *
 * Postcondition: ∀ task ∈ tasks, ∀ pid ∈ affectedProjectIds:
 *   `'impact:'+pid ∈ task.tags`
 *
 * The merge is idempotent: a tag already present is not added twice, and every
 * tag the task already carried is preserved (order kept, new impact tags
 * appended after, in affectedProjectIds order, skipping duplicates). The input
 * tasks are not mutated — a shallow-cloned tasks array is returned (each task
 * object gets a fresh `tags` array; the rest of the task object is reused by
 * reference, matching how the planner composes plan outputs).
 *
 * `affectedProjectIds` is normalised defensively: non-numbers and NaN are
 * dropped, and the resulting pids are deduped (order-preserving) so a caller
 * passing `[7, 7]` stamps exactly one `impact:7` tag.
 *
 * @param tasks the plan's tasks.
 * @param affectedProjectIds project ids every task should be tagged with.
 * @returns a new tasks array with the impact tags merged in.
 * @see SRS-004 §2b.5
 */
export function applyImpactCascade(
  tasks: PlanTask[],
  affectedProjectIds: number[],
): PlanTask[] {
  // Normalise the pid list: numbers only, finite, deduped (order-preserving).
  const seenPid = new Set<number>();
  const pids: number[] = [];
  for (const raw of Array.isArray(affectedProjectIds) ? affectedProjectIds : []) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    if (seenPid.has(raw)) continue;
    seenPid.add(raw);
    pids.push(raw);
  }
  const tagsToAdd = pids.map((pid) => `impact:${pid}`);

  return tasks.map((task) => {
    const existing = Array.isArray(task.tags) ? task.tags : [];
    const present = new Set(existing);
    const merged = existing.slice();
    for (const tag of tagsToAdd) {
      if (!present.has(tag)) {
        merged.push(tag);
        present.add(tag);
      }
    }
    return { ...task, tags: merged };
  });
}
