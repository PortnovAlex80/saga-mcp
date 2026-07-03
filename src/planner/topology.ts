// src/planner/topology.ts
//
// SRS-004 §2b.5 — saga-planner topology switching (Pattern A / B / parallel).
//
// Given a brief, decides which execution topology to use and, for Pattern B,
// produces the scaffold task spec. This is the single switch that the planner
// consults; no strategy objects.
//
// ============================================================================
// SCAFFOLD ONLY (Pattern B, task #215).
// ============================================================================
// This file fixes the API CONTRACT (Pattern union + TopologyDecision interface
// + decideTopology signature) BEFORE the body-task lands. The function body is
// a stub that throws NotImplementedError. The full implementation (deterministic
// switch on topology_hint) is body-task AC-9 (#225 — planner cascade +
// topology-switching + theme↔brief carry-state).
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
 * Deterministic switch on brief.topology_hint (see rules in the file header).
 *
 * SCAFFOLD stub — throws NotImplementedError. Body-task AC-9 (#225) implements
 * the deterministic switch and scaffold_task construction.
 *
 * @param brief the discovery brief to plan a topology for.
 * @returns the topology decision (pattern + optional scaffold task spec).
 * @see SRS-004 §2b.5
 * @see body-task AC-9 (#225) — implements the body
 */
export function decideTopology(_brief: BriefPayload): TopologyDecision {
  // SCAFFOLD stub — body-task AC-9 (#225) implements the real logic.
  throw new Error('NotImplemented: decideTopology — see body-task AC-9 (#225), SRS §2b.5');
}
