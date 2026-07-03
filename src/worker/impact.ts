// src/worker/impact.ts
//
// SRS-004 §2b.6 — saga-worker impact-tag reading.
//
// Reads a task's tags and extracts the impact:<id> entries, producing the
// impact context the worker-loop consults: which projects this task touches,
// and a human-readable warning the worker must surface in its output (not only
// in reasoning) when the task spans projects.
//
// ============================================================================
// SCAFFOLD ONLY (Pattern B, task #215).
// ============================================================================
// This file fixes the API CONTRACT (ImpactContext interface +
// parseImpactTags signature) BEFORE the body-task lands. The function body is
// a stub that throws NotImplementedError. The full implementation (tag parsing
// + warning construction) is body-task AC-10 (#226 — NFR: perf/isolation/
// observability) and/or AC-9 (#225).
//
// Worker-loop contract (SRS §2b.6) when parseImpactTags(...).projects.length > 0:
//   1. Include `warning` in the worker's OUTPUT (not only reasoning) — see
//      rule-arbiter §8 brief.
//   2. On conflict with another active task on the same project, honor
//      depends_on / merge-lock.
//
// Extension point (SRS §2b.6): a new signal tag = a new parse<X>Tags function
// of the same shape. Do NOT add side-responsibilities to parseImpactTags.
// ============================================================================

/**
 * Impact context parsed from a task's tags (SRS §2b.6).
 */
export interface ImpactContext {
  projects: number[]; // from impact:<id> tags
  warning: string | null; // human-readable warning (non-null when projects.length > 0)
}

/**
 * Parse impact:<id> tags out of a task's tag list (SRS §2b.6).
 *
 * Postcondition:
 *   projects = all integers from tags of the form 'impact:<int>'.
 *   warning  = 'Avoid uncoordinated writes to projects: ...' when
 *              projects.length > 0, else null.
 *
 * SCAFFOLD stub — throws NotImplementedError. Body-task AC-10 (#226) /
 * AC-9 (#225) implements the tag parse + warning construction.
 *
 * @param _tags the task's tags.
 * @returns the impact context (projects + warning).
 * @see SRS-004 §2b.6
 * @see body-task AC-10 (#226) / AC-9 (#225) — implement the body
 */
export function parseImpactTags(_tags: string[]): ImpactContext {
  // SCAFFOLD stub — body-task AC-10 (#226) / AC-9 (#225) implement the real logic.
  throw new Error('NotImplemented: parseImpactTags — see body-task AC-10 (#226) / AC-9 (#225), SRS §2b.6');
}
