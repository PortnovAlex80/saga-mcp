/**
 * workflow-kernel/planning/plan-graph.ts - pure authoring of the immutable
 * planning graph (WP-09, plan phase EK-6).
 *
 * authorPlanGraph validates the COMPLETE idea/claim/unknown/integration
 * graph against every EK-6 equality and fence and produces the exact
 * workItem.planGraph command inputs + dependency-edge payloads the WorkItem
 * sole-writer repository commits. The output is DETERMINISTIC and PURE: the
 * same facts author the same graph (planning is a function, never a mood).
 *
 * Fences (each a typed refusal, each killed by a dedicated mutation test):
 *   1. PLANNING_INPUT_INCOMPLETE  - acceptance criteria alone are not a
 *      planning graph; idea, scope, claims and surfaces are all required.
 *   2. PLANNING_FOREIGN_REF       - every edge/ownership ref resolves in the
 *      declared fact sets (no dangling graph).
 *   3. PLANNING_SCOPE_INEQUALITY  - epic scope equality: covered + explicit
 *      deferred == declared scope (and never both).
 *   4. PLANNING_CLAIM_INEQUALITY  - terminal-claim equality: owned +
 *      verifiable == required.
 *   5. PLANNING_HOMELESS_SURFACE  - every open unknown, cross-module seam,
 *      test surface and integration surface has an owner.
 *   6. PLANNING_ZERO_OBLIGATION   - every work item carries obligations
 *      (empty work is not a plan).
 *   7. PLANNING_GRAPH_CIRCULAR    - no dependency cycle (self edges included).
 *   8. PLANNING_JOINTLY_UNSATISFIABLE - every executable verification is
 *      ordered after the items owning the surfaces it spans; otherwise no
 *      legal topological order satisfies the graph.
 *
 * PURITY: pure functions of the input facts. No I/O, no clock, no SQL.
 */

import type { CommandInput } from '../domain/types.js';
import type { DependencyEdgeInput } from '../persistence/kernel-ledger.js';
import {
  graphTokenOf,
  planningRefusal,
  planningTokenOf,
  type PlannedWorkItem,
  type PlanningFactsInput,
  type PlanningRefusal,
} from './facts.js';

/* ------------------------------------------------------------------ */
/* Authored output                                                     */
/* ------------------------------------------------------------------ */

/** One item's authored commit: the planGraph command + its immutable edges. */
export interface AuthoredWorkItem {
  readonly itemRef: string;
  readonly instanceId: string;
  readonly token: string;
  readonly command: CommandInput;
  /** This item's incoming dependency edges (its planGraph commits them). */
  readonly dependencyEdges: readonly DependencyEdgeInput[];
}

/** The authored planning graph (deterministic function of the facts). */
export interface AuthoredPlanGraph {
  readonly planningRef: string;
  readonly graphToken: string;
  /** Topologically ordered (dependencies first). */
  readonly workItems: readonly AuthoredWorkItem[];
  readonly edges: readonly DependencyEdgeInput[];
  /** Declared coverages (observed-graph comparison inputs). */
  readonly declaredCoverage: ReadonlyMap<string, readonly string[]>;
}

export type AuthoringResult = AuthoredPlanGraph | PlanningRefusal;

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

const duplicatesOf = (refs: readonly string[]): readonly string[] => {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) dupes.add(ref);
    seen.add(ref);
  }
  return [...dupes];
};

/** Transitive dependency closure of `start` over the authored edges. */
function dependencyClosure(items: readonly PlannedWorkItem[], start: string): Set<string> {
  const byRef = new Map(items.map((item) => [item.itemRef, item.dependsOn]));
  const seen = new Set<string>();
  const queue = [...(byRef.get(start) ?? [])];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    queue.push(...(byRef.get(current) ?? []));
  }
  return seen;
}

/** Deterministic topological order (stable by input order); null on cycle. */
function topologicalOrder(items: readonly PlannedWorkItem[]): readonly PlannedWorkItem[] | null {
  const byRef = new Map(items.map((item) => [item.itemRef, item]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const order: PlannedWorkItem[] = [];
  const visit = (item: PlannedWorkItem): boolean => {
    if (done.has(item.itemRef)) return true;
    if (visiting.has(item.itemRef)) return false;
    visiting.add(item.itemRef);
    for (const dep of item.dependsOn) {
      const depItem = byRef.get(dep);
      if (depItem === undefined || !visit(depItem)) return false;
    }
    visiting.delete(item.itemRef);
    done.add(item.itemRef);
    order.push(item);
    return true;
  };
  for (const item of items) {
    if (!visit(item)) return null;
  }
  return order;
}

/* ------------------------------------------------------------------ */
/* The authoring oracle                                                */
/* ------------------------------------------------------------------ */

/**
 * Author the immutable planning graph from the COMPLETE facts. Returns the
 * per-item workItem.planGraph command inputs (topological order; each item's
 * edges commit in ITS transaction once both endpoints exist) or a typed
 * refusal naming the exact fence and the exact offending reference.
 */
export function authorPlanGraph(facts: PlanningFactsInput): AuthoringResult {
  /* --- fence 1: completeness (never ACs alone) --- */
  if (!facts.idea.ideaRef || !facts.idea.statement) {
    return planningRefusal('PLANNING_INPUT_INCOMPLETE', 'MISSING_EVIDENCE', 'the idea fact (reference and statement) is required: planning conserves the idea');
  }
  if (facts.scopeItems.length === 0) {
    return planningRefusal(
      'PLANNING_INPUT_INCOMPLETE',
      'MISSING_EVIDENCE',
      facts.acceptanceCriteria.length > 0
        ? 'acceptance criteria alone are not a planning graph: declared epic scope is required alongside the criteria'
        : 'declared epic scope is required before a planning graph may be authored',
    );
  }
  if (facts.terminalClaims.length === 0) {
    return planningRefusal('PLANNING_INPUT_INCOMPLETE', 'MISSING_EVIDENCE', 'required terminal lifecycle claims are required before a planning graph may be authored');
  }
  if (facts.constructionSurfaces.length === 0) {
    return planningRefusal('PLANNING_INPUT_INCOMPLETE', 'MISSING_EVIDENCE', 'construction surfaces (test and integration surfaces) are required before a planning graph may be authored');
  }
  if (facts.workItems.length === 0) {
    return planningRefusal('PLANNING_INPUT_INCOMPLETE', 'MISSING_EVIDENCE', 'a planning graph with zero work items authors nothing');
  }

  const scopeRefs = new Set(facts.scopeItems.map((item) => item.scopeRef));
  const unknownRefs = new Set(facts.unknowns.map((item) => item.unknownRef));
  const claimRefs = new Set(facts.terminalClaims.map((item) => item.claimRef));
  const surfaceRefs = new Set(facts.constructionSurfaces.map((item) => item.surfaceRef));
  const seamRefs = new Set(facts.integrationSeams.map((item) => item.seamRef));
  const itemRefs = new Set(facts.workItems.map((item) => item.itemRef));

  for (const [label, declared, set] of [
    ['scope item', facts.scopeItems.map((i) => i.scopeRef), scopeRefs],
    ['open unknown', facts.unknowns.map((i) => i.unknownRef), unknownRefs],
    ['terminal claim', facts.terminalClaims.map((i) => i.claimRef), claimRefs],
    ['construction surface', facts.constructionSurfaces.map((i) => i.surfaceRef), surfaceRefs],
    ['integration seam', facts.integrationSeams.map((i) => i.seamRef), seamRefs],
    ['work item', facts.workItems.map((i) => i.itemRef), itemRefs],
  ] as const) {
    const dupes = duplicatesOf(declared as readonly string[]);
    if (dupes.length > 0) {
      return planningRefusal('PLANNING_INPUT_INCOMPLETE', 'DUPLICATE_IDEMPOTENCY_KEY', `duplicate ${label} reference(s): ${dupes.join(', ')}`);
    }
    void set;
  }

  /* --- fence 6 first: zero-obligation items have no ownership to check --- */
  for (const item of facts.workItems) {
    if (item.obligations.length === 0) {
      return planningRefusal(
        'PLANNING_ZERO_OBLIGATION',
        'EMPTY_WORK_IS_NOT_A_PROOF',
        `work item ${item.itemRef} maps to zero obligations: empty work is not a plan (WorkItemObligationMapping is required)`,
      );
    }
  }

  /* --- fence 2: foreign references --- */
  const foreign = (owner: string, kind: string, ref: string) =>
    planningRefusal('PLANNING_FOREIGN_REF', 'FOREIGN_EVIDENCE_REF', `${owner} references ${kind} ${ref} which the declared planning facts do not contain`);
  for (const item of facts.workItems) {
    for (const ref of item.coversScope) if (!scopeRefs.has(ref)) return foreign(item.itemRef, 'scope item', ref);
    for (const ref of item.ownsUnknowns) if (!unknownRefs.has(ref)) return foreign(item.itemRef, 'open unknown', ref);
    for (const ref of item.ownsClaims) if (!claimRefs.has(ref)) return foreign(item.itemRef, 'terminal claim', ref);
    for (const ref of item.verifiesClaims) if (!claimRefs.has(ref)) return foreign(item.itemRef, 'terminal claim (verifiable)', ref);
    for (const ref of item.ownsSurfaces) if (!surfaceRefs.has(ref)) return foreign(item.itemRef, 'construction surface', ref);
    for (const ref of item.verificationSurfaces) if (!surfaceRefs.has(ref)) return foreign(item.itemRef, 'verification surface', ref);
    for (const ref of item.ownsSeams) if (!seamRefs.has(ref)) return foreign(item.itemRef, 'integration seam', ref);
    for (const ref of item.dependsOn) if (!itemRefs.has(ref)) return foreign(item.itemRef, 'work item dependency', ref);
    if (item.dependsOn.includes(item.itemRef)) {
      return planningRefusal('PLANNING_GRAPH_CIRCULAR', 'ILLEGAL_TRANSITION', `work item ${item.itemRef} depends on itself: a cyclic planning graph has no legal order`);
    }
  }

  /* --- fence 3: epic scope equality (covered + explicit deferred == declared) --- */
  const covered = new Set<string>();
  for (const item of facts.workItems) {
    for (const ref of item.coversScope) covered.add(ref);
  }
  const deferred = new Set(facts.deferredScope.map((entry) => entry.scopeRef));
  for (const entry of facts.deferredScope) {
    if (!scopeRefs.has(entry.scopeRef)) {
      return planningRefusal('PLANNING_FOREIGN_REF', 'FOREIGN_EVIDENCE_REF', `deferred scope ${entry.scopeRef} is not a declared scope item`);
    }
    if (!entry.owner || !entry.reason) {
      return planningRefusal('PLANNING_SCOPE_INEQUALITY', 'MISSING_EVIDENCE', `deferred scope ${entry.scopeRef} requires an owner and a reason (explicit deferral, never a silent drop)`);
    }
  }
  for (const ref of covered) {
    if (deferred.has(ref)) {
      return planningRefusal('PLANNING_SCOPE_INEQUALITY', 'ILLEGAL_TRANSITION', `scope ${ref} is both covered and explicitly deferred: scope equality is exact, never double-counted`);
    }
  }
  const uncovered = [...scopeRefs].filter((ref) => !covered.has(ref) && !deferred.has(ref)).sort();
  if (uncovered.length > 0) {
    return planningRefusal(
      'PLANNING_SCOPE_INEQUALITY',
      'MISSING_EVIDENCE',
      `epic scope equality failed: covered + explicit deferred != declared scope; uncovered and undeferred: ${uncovered.join(', ')}`,
    );
  }

  /* --- fence 4: terminal-claim equality (owned + verifiable == required) --- */
  const owned = new Set<string>();
  const verifiable = new Set<string>();
  for (const item of facts.workItems) {
    for (const ref of item.ownsClaims) owned.add(ref);
    for (const ref of item.verifiesClaims) verifiable.add(ref);
  }
  const unclaimed = [...claimRefs].filter((ref) => !owned.has(ref) && !verifiable.has(ref)).sort();
  if (unclaimed.length > 0) {
    return planningRefusal(
      'PLANNING_CLAIM_INEQUALITY',
      'MISSING_EVIDENCE',
      `terminal-claim equality failed: owned + verifiable != required; claims owned by nobody and verifiable by nobody: ${unclaimed.join(', ')}`,
    );
  }

  /* --- fence 5: homeless surfaces, unknowns and seams --- */
  const ownedUnknowns = new Set<string>();
  const ownedSurfaces = new Set<string>();
  const ownedSeams = new Set<string>();
  const surfaceOwners = new Map<string, string[]>();
  for (const item of facts.workItems) {
    for (const ref of item.ownsUnknowns) ownedUnknowns.add(ref);
    for (const ref of item.ownsSurfaces) {
      ownedSurfaces.add(ref);
      surfaceOwners.set(ref, [...(surfaceOwners.get(ref) ?? []), item.itemRef]);
    }
    for (const ref of item.ownsSeams) ownedSeams.add(ref);
  }
  const homelessUnknown = [...unknownRefs].filter((ref) => !ownedUnknowns.has(ref)).sort();
  if (homelessUnknown.length > 0) {
    return planningRefusal('PLANNING_HOMELESS_SURFACE', 'MISSING_EVIDENCE', `open unknown(s) without an owner: ${homelessUnknown.join(', ')} (an unknown cannot disappear, D10)`);
  }
  const homelessSurface = [...surfaceRefs].filter((ref) => !ownedSurfaces.has(ref)).sort();
  if (homelessSurface.length > 0) {
    return planningRefusal('PLANNING_HOMELESS_SURFACE', 'MISSING_EVIDENCE', `construction surface(s) without an owner: ${homelessSurface.join(', ')}`);
  }
  const homelessSeam = [...seamRefs].filter((ref) => !ownedSeams.has(ref)).sort();
  if (homelessSeam.length > 0) {
    return planningRefusal('PLANNING_HOMELESS_SURFACE', 'MISSING_EVIDENCE', `cross-module integration seam(s) without an owner: ${homelessSeam.join(', ')}`);
  }

  /* --- fence 7: circularity --- */
  const order = topologicalOrder(facts.workItems);
  if (order === null) {
    return planningRefusal('PLANNING_GRAPH_CIRCULAR', 'ILLEGAL_TRANSITION', 'the planning graph is circular: no legal topological order exists');
  }

  /* --- fence 8: joint satisfiability of executable verifications --- */
  for (const verifier of facts.workItems) {
    for (const surface of verifier.verificationSurfaces) {
      for (const owner of surfaceOwners.get(surface) ?? []) {
        if (owner === verifier.itemRef) continue;
        if (!dependencyClosure(facts.workItems, verifier.itemRef).has(owner)) {
          return planningRefusal(
            'PLANNING_JOINTLY_UNSATISFIABLE',
            'UNIVERSE_VIOLATION',
            `${verifier.itemRef} verifies over surface ${surface} owned by ${owner} but does not depend on it: the verification could run before its inputs exist, so no legal order satisfies the graph`,
          );
        }
      }
    }
    for (const claim of verifier.verifiesClaims) {
      for (const producer of facts.workItems) {
        if (!producer.ownsClaims.includes(claim) || producer.itemRef === verifier.itemRef) continue;
        if (!dependencyClosure(facts.workItems, verifier.itemRef).has(producer.itemRef)) {
          return planningRefusal(
            'PLANNING_JOINTLY_UNSATISFIABLE',
            'UNIVERSE_VIOLATION',
            `${verifier.itemRef} verifies claim ${claim} owned by ${producer.itemRef} but does not depend on it: verification would precede production, so no legal order satisfies the graph`,
          );
        }
      }
    }
  }

  /* --- author: deterministic command inputs in topological order --- */
  const graphToken = graphTokenOf(facts);
  const authored: AuthoredWorkItem[] = order.map((item) => ({
    itemRef: item.itemRef,
    instanceId: `work-item:${item.itemRef}`,
    token: planningTokenOf(facts, item.itemRef),
    command: {
      command: 'workItem.planGraph',
      instanceId: `work-item:${item.itemRef}`,
      expectedRevision: 0,
      idempotencyKey: `plan:${facts.planningRef}:${item.itemRef}`,
      evidenceRefs: [planningTokenOf(facts, item.itemRef), graphToken],
    },
    dependencyEdges: item.dependsOn.map((dep) => ({
      workItemRef: `work-item:${item.itemRef}`,
      dependsOnRef: `work-item:${dep}`,
    })),
  }));
  const declaredCoverage = new Map<string, readonly string[]>(facts.workItems.map((item) => [item.itemRef, [...item.coversScope].sort()]));
  return {
    planningRef: facts.planningRef,
    graphToken,
    workItems: authored,
    edges: authored.flatMap((item) => item.dependencyEdges),
    declaredCoverage,
  };
}
