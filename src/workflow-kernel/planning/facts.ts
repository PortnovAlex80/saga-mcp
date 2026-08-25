/**
 * workflow-kernel/planning/facts.ts - the COMPLETE planning-fact vocabulary
 * of workItem.planGraph (WP-09, plan phase EK-6).
 *
 * Plan law (EK-6): "Implement immutable WorkItem and dependency creation
 * from the complete idea/claim/unknown/integration graph, not ACs alone."
 * The input shape below therefore makes every planning dimension a
 * first-class typed field; acceptance criteria are ONE dimension and can
 * never substitute for the graph.
 *
 * Frozen protocol decisions embodied (PROTOCOL-DECISIONS-FROZEN.md):
 *   - D10: planGraph carries the open-unknown clause - an open unknown is
 *     an obligation with an owner and cannot disappear at a workshop
 *     boundary (DiscoveryUnknownObligation).
 *
 * Every refusal here is typed with an exact code PLUS a kernel TypedRefusal
 * whose reason comes from the FROZEN domain reason set - no new refusal
 * reasons are invented by the planning layer.
 *
 * PURITY: types and pure helpers only. No I/O, no clock, no SQL.
 */

import type { TypedRefusal } from '../domain/types.js';

/* ------------------------------------------------------------------ */
/* Typed planning refusals                                             */
/* ------------------------------------------------------------------ */

/** The exact fence a planning graph violated (each maps to one frozen reason). */
export type PlanningRefusalCode =
  | 'PLANNING_INPUT_INCOMPLETE'
  | 'PLANNING_FOREIGN_REF'
  | 'PLANNING_SCOPE_INEQUALITY'
  | 'PLANNING_CLAIM_INEQUALITY'
  | 'PLANNING_HOMELESS_SURFACE'
  | 'PLANNING_ZERO_OBLIGATION'
  | 'PLANNING_GRAPH_CIRCULAR'
  | 'PLANNING_JOINTLY_UNSATISFIABLE';

/** A typed planning refusal: exact code + the frozen kernel refusal. */
export interface PlanningRefusal {
  readonly refused: true;
  readonly code: PlanningRefusalCode;
  readonly refusal: TypedRefusal;
}

/** Build a typed planning refusal (never a silent fallback). */
export function planningRefusal(code: PlanningRefusalCode, reason: TypedRefusal['reason'], detail: string): PlanningRefusal {
  return { refused: true, code, refusal: { refused: true, reason, detail } };
}

/* ------------------------------------------------------------------ */
/* The complete planning-fact input                                    */
/* ------------------------------------------------------------------ */

/** The idea being planned (idea conservation: it is carried, never dropped). */
export interface IdeaFact {
  readonly ideaRef: string;
  readonly statement: string;
}

/** One declared epic scope item (the scope equality denominator). */
export interface ScopeItem {
  readonly scopeRef: string;
  readonly statement: string;
}

/** One open discovery unknown (D10: owned, cannot disappear). */
export interface OpenUnknown {
  readonly unknownRef: string;
  readonly question: string;
}

/** One required terminal lifecycle claim (the terminal-claim denominator). */
export interface TerminalLifecycleClaimFact {
  readonly claimRef: string;
  readonly statement: string;
}

/** The construction surface kinds a graph may declare. */
export type ConstructionSurfaceKind = 'module-surface' | 'test-surface' | 'integration-surface';

/** One construction surface (test surface, integration surface or module). */
export interface ConstructionSurfaceFact {
  readonly surfaceRef: string;
  readonly kind: ConstructionSurfaceKind;
  readonly description: string;
}

/** One cross-module seam (both sides named, owner required by EK-6). */
export interface IntegrationSeamFact {
  readonly seamRef: string;
  readonly leftScopeRef: string;
  readonly rightScopeRef: string;
  readonly description: string;
}

/** One acceptance criterion - a single dimension, never the whole graph. */
export interface AcceptanceCriterionFact {
  readonly criterionRef: string;
  readonly statement: string;
}

/** One explicit scope deferral: owner + reason, never a silent drop. */
export interface DeferredScopeFact {
  readonly scopeRef: string;
  readonly owner: string;
  readonly reason: string;
}

/**
 * One authored WorkItem: the immutable planning fact workItem.planGraph
 * commits. Ownership sets are exhaustive inputs of the equalities EK-6
 * requires; `obligations` is the WorkItemObligationMapping (non-empty: a
 * zero-obligation item is refused as empty work).
 */
export interface PlannedWorkItem {
  readonly itemRef: string;
  readonly title: string;
  readonly coversScope: readonly string[];
  readonly ownsUnknowns: readonly string[];
  readonly ownsSurfaces: readonly string[];
  readonly ownsSeams: readonly string[];
  /** Terminal claims this item OWNS (produces or answers). */
  readonly ownsClaims: readonly string[];
  /** Terminal claims this item makes EXECUTABLY VERIFIABLE over its surfaces. */
  readonly verifiesClaims: readonly string[];
  /** Surfaces the executable verification spans (must be owned in-graph and ordered before it). */
  readonly verificationSurfaces: readonly string[];
  /** The WorkItemObligationMapping labels (non-empty; zero work is not a plan). */
  readonly obligations: readonly string[];
  readonly dependsOn: readonly string[];
}

/** The complete idea/claim/unknown/integration graph (the planGraph input). */
export interface PlanningFactsInput {
  readonly planningRef: string;
  readonly idea: IdeaFact;
  readonly scopeItems: readonly ScopeItem[];
  readonly unknowns: readonly OpenUnknown[];
  readonly terminalClaims: readonly TerminalLifecycleClaimFact[];
  readonly constructionSurfaces: readonly ConstructionSurfaceFact[];
  readonly integrationSeams: readonly IntegrationSeamFact[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionFact[];
  readonly deferredScope: readonly DeferredScopeFact[];
  readonly workItems: readonly PlannedWorkItem[];
}

/* ------------------------------------------------------------------ */
/* Deterministic planning tokens                                       */
/* ------------------------------------------------------------------ */

/**
 * The content-addressed planning token of one authored item. The token is
 * referenced by the planGraph command input, by the conveyor's cell
 * materialization evidence refs and by WorkIntents, so the durable ledger
 * joins recover work-item <-> workplace <-> node bindings from committed
 * events alone (never from chronology or a projection).
 */
export function planningTokenOf(facts: PlanningFactsInput, itemRef: string): string {
  return `plan:${facts.planningRef}#item:${itemRef}`;
}

/** The planning-graph token (the whole authored graph's content reference). */
export function graphTokenOf(facts: PlanningFactsInput): string {
  return `plan:${facts.planningRef}#graph`;
}
