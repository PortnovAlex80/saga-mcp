// src/planner/topology.ts
//
// SRS-004 §2b.5 — saga-planner topology switching (Pattern A / B / parallel).
//
// Given a brief, decides which execution topology to use and, for Pattern B,
// produces the scaffold task spec. This is the single switch that the planner
// consults; no strategy objects.
//
// ============================================================================
// Implemented by body-task AC-9 (#225).
// ============================================================================
// The API CONTRACT (Pattern union + TopologyDecision interface +
// decideTopology signature) was fixed by SCAFFOLD #215 (Pattern B). This file
// now implements the deterministic switch on `brief.topology_hint` from
// SRS-004 §2b.5:
//
//   topology_hint='scaffold-then-parallel' → Pattern B, scaffold_task built
//     from scaffold_artifacts.
//   topology_hint='sequence'                → Pattern A.
//   topology_hint='parallel-independent'    → Pattern 'parallel'.
//
// Deterministic rules (SRS §2b.5):
//   topology_hint='scaffold-then-parallel' → Pattern B, scaffold_task from
//     scaffold_artifacts.
//   topology_hint='sequence'                → Pattern A.
//   topology_hint='parallel-independent'    → Pattern 'parallel'.
//
// Extension point (SRS §2b.5): a new Pattern = a new literal in the union + a
// new branch in decideTopology. No strategies — a switch on topology_hint.
// ============================================================================

import type { BriefPayload } from '../validators/brief.js';

/**
 * Execution topology patterns (SRS §2b.5).
 */
export type Pattern = 'A-sequence' | 'B-scaffold-then-parallel' | 'parallel';

/**
 * The planner's topology decision for a brief (SRS §2b.5).
 *
 * scaffold_task is present only when pattern === 'B-scaffold-then-parallel'.
 */
export interface TopologyDecision {
  pattern: Pattern;
  scaffold_task?: { title: string; scaffold_artifacts: string[] }; // only when B
}

/**
 * Decide the execution topology for a brief (SRS §2b.5).
 *
 * Deterministic switch on `brief.topology_hint`:
 *
 * | topology_hint            | pattern                       | scaffold_task? |
 * |--------------------------|-------------------------------|----------------|
 * | 'scaffold-then-parallel' | 'B-scaffold-then-parallel'    | yes (from scaffold_artifacts) |
 * | 'sequence'               | 'A-sequence'                  | no             |
 * | 'parallel-independent'   | 'parallel'                    | no             |
 *
 * For Pattern B the scaffold task is built from `brief.scaffold_artifacts`:
 * its `title` is `'SCAFFOLD: ' + scaffold_artifacts.join(', ')` (SRS §2b.5 —
 * "Контракт SCAFFOLD-задачи"), and the artifact list is carried verbatim so the
 * scaffold worker materialises exactly the stubs the contract named. An empty
 * scaffold_artifacts list is preserved as-is (the planner/validator govern
 * whether that is admissible; decideTopology does not second-guess the brief).
 *
 * The brief is read defensively: a null/undefined brief or a missing
 * topology_hint throws an explicit error rather than silently defaulting — a
 * topology decision must come from the brief, never from a fallback, so that
 * silent mis-planning is impossible (mirrors validateBrief's stance).
 *
 * @param brief the discovery brief to plan a topology for.
 * @returns the topology decision (pattern + optional scaffold task spec).
 * @throws {Error} if brief is null/non-object or topology_hint is absent.
 * @see SRS-004 §2b.5
 */
export function decideTopology(brief: BriefPayload): TopologyDecision {
  if (brief == null || typeof brief !== 'object') {
    throw new Error('decideTopology: brief must be a non-null object');
  }
  const hint = (brief as { topology_hint?: unknown }).topology_hint;
  if (typeof hint !== 'string') {
    throw new Error('decideTopology: brief.topology_hint must be a string');
  }

  switch (hint) {
    case 'scaffold-then-parallel': {
      const artifacts = Array.isArray(brief.scaffold_artifacts)
        ? brief.scaffold_artifacts.slice()
        : [];
      return {
        pattern: 'B-scaffold-then-parallel',
        scaffold_task: {
          title: `SCAFFOLD: ${artifacts.join(', ')}`,
          scaffold_artifacts: artifacts,
        },
      };
    }
    case 'sequence':
      return { pattern: 'A-sequence' };
    case 'parallel-independent':
      return { pattern: 'parallel' };
    default:
      // An unknown literal is a contract violation (the validator's literal
      // enum should have caught it upstream). Surface it loudly rather than
      // guessing a pattern.
      throw new Error(`decideTopology: unknown topology_hint '${hint}'`);
  }
}
