/**
 * workflow-kernel/planning/observed-graphs.ts - forward and reverse observed
 * graphs plus their typed reconciliation with the independently declared
 * protocol graphs (WP-09, plan phase EK-6).
 *
 * Plan law (EK-6): "Generate forward and reverse observed graphs from
 * committed events and evidence, then compare them with the independently
 * declared protocol graphs." The forward graph is observed IDEA -> PRODUCT
 * direction (accepted work items and the dependency edges their successors
 * actually consumed as predecessor evidence); the reverse graph is observed
 * TERMINAL -> SOURCE direction (each committed terminal proof walking its
 * evidence closure back to producing events).
 *
 * The declared graphs are INDEPENDENT of the observations:
 *   - forward-declared: the committed work_item_dependency rows (the
 *     immutable planning facts the graph itself committed);
 *   - reverse-declared: the frozen universe proof registry
 *     (domain/universe.ts PROOFS - required evidence closures per proof).
 * Comparison is exact and every difference is typed; a silent pass is
 * structurally impossible (compareGraphs returns divergences, never drops).
 *
 * This is the comparison the ForwardReverseReconciliationReceipt evidence
 * kind names (settlement-time forward/reverse observed-graph comparison,
 * R7 - produced by factoryRun.recordRunTerminalProof).
 *
 * PURITY: pure functions of the snapshot + dependency rows. No I/O.
 */

import type { EvidenceRef, InstanceId, ProofRecord, WorkflowEventRecord } from '../domain/types.js';
import { PROOFS } from '../domain/universe.js';
import type { LedgerSnapshot } from './bindings.js';
import type { DependencyEdgeRow } from './readiness.js';

/* ------------------------------------------------------------------ */
/* Observed graph shapes                                               */
/* ------------------------------------------------------------------ */

export type ObservedNodeKind = 'work-item' | 'terminal-proof' | 'evidence-source';

export interface ObservedNode {
  readonly id: string;
  readonly kind: ObservedNodeKind;
}

export interface ObservedEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'dependency-observed' | 'dependency-declared' | 'proof-closure';
}

export interface ObservedGraph {
  readonly nodes: readonly ObservedNode[];
  readonly edges: readonly ObservedEdge[];
}

export type GraphDivergence =
  | { readonly kind: 'NODE_MISSING'; readonly id: string; readonly detail: string }
  | { readonly kind: 'NODE_UNDECLARED'; readonly id: string; readonly detail: string }
  | { readonly kind: 'EDGE_MISSING'; readonly from: string; readonly to: string; readonly detail: string }
  | { readonly kind: 'EDGE_UNDECLARED'; readonly from: string; readonly to: string; readonly detail: string }
  | { readonly kind: 'CLOSURE_KIND_MISSING'; readonly proof: string; readonly closureKind: string; readonly detail: string }
  | { readonly kind: 'CLOSURE_KIND_UNDECLARED'; readonly proof: string; readonly closureKind: string; readonly detail: string }
  | { readonly kind: 'PROOF_UNDECLARED'; readonly proof: string; readonly detail: string };

export type GraphComparison = { readonly equal: true; readonly nodeCount: number; readonly edgeCount: number } | { readonly equal: false; readonly divergences: readonly GraphDivergence[] };

/* ------------------------------------------------------------------ */
/* Forward: idea -> product over consumed predecessor evidence         */
/* ------------------------------------------------------------------ */

/** The forward observed graph: accepted items + edges actually consumed. */
export function forwardObservedGraph(snapshot: LedgerSnapshot, edges: readonly DependencyEdgeRow[]): ObservedGraph {
  // Acceptance facts per workplace: `evidence:CellFinalAcceptance#<seq>`.
  const acceptanceOf = new Map<InstanceId, EvidenceRef[]>();
  const evidenceRefs = new Set(snapshot.evidence.map((fact) => fact.ref));
  for (const event of snapshot.events) {
    if (event.transition !== 'workplace.recordFinalAcceptance') continue;
    const ref = `evidence:CellFinalAcceptance#${event.sequence}`;
    if (evidenceRefs.has(ref)) {
      acceptanceOf.set(event.sourceInstanceId, [...(acceptanceOf.get(event.sourceInstanceId) ?? []), ref]);
    }
  }
  // Item -> its workplaces (WorkIntent rows, durable).
  const workplacesOfItem = new Map<string, InstanceId[]>();
  for (const intent of snapshot.workIntents.values()) {
    const current = workplacesOfItem.get(intent.workItemRef) ?? [];
    if (!current.includes(intent.workplaceInstanceId)) current.push(intent.workplaceInstanceId);
    workplacesOfItem.set(intent.workItemRef, current);
  }
  // Item -> the input evidence refs its successors' intents carried.
  const intentRefsOfItem = new Map<string, EvidenceRef[]>();
  for (const intent of snapshot.workIntents.values()) {
    intentRefsOfItem.set(intent.workItemRef, [...(intentRefsOfItem.get(intent.workItemRef) ?? []), ...intent.inputEvidenceRefs]);
  }

  const acceptedItems = new Set<string>();
  for (const [item, workplaces] of workplacesOfItem) {
    if (workplaces.some((workplace) => (acceptanceOf.get(workplace) ?? []).length > 0)) acceptedItems.add(item);
  }

  const nodes: ObservedNode[] = [...acceptedItems].sort().map((id) => ({ id, kind: 'work-item' as const }));
  const observedEdges: ObservedEdge[] = [];
  for (const edge of edges) {
    if (!acceptedItems.has(edge.workItemRef) || !acceptedItems.has(edge.dependsOnRef)) continue;
    const predecessorAcceptance = (workplacesOfItem.get(edge.dependsOnRef) ?? []).flatMap((workplace) => acceptanceOf.get(workplace) ?? []);
    const successorRefs = intentRefsOfItem.get(edge.workItemRef) ?? [];
    const consumed = predecessorAcceptance.some((ref) => successorRefs.includes(ref));
    if (consumed) {
      observedEdges.push({ from: edge.dependsOnRef, to: edge.workItemRef, kind: 'dependency-observed' });
    }
  }
  return { nodes, edges: observedEdges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1)) };
}

/** The declared planning graph: committed dependency rows (immutable facts). */
export function declaredPlanningGraph(edges: readonly DependencyEdgeRow[]): ObservedGraph {
  const nodeIds = new Set<string>([...edges.map((edge) => edge.workItemRef), ...edges.map((edge) => edge.dependsOnRef)]);
  return {
    nodes: [...nodeIds].sort().map((id) => ({ id, kind: 'work-item' as const })),
    edges: edges
      .map((edge) => ({ from: edge.dependsOnRef, to: edge.workItemRef, kind: 'dependency-declared' as const }))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1)),
  };
}

/* ------------------------------------------------------------------ */
/* Reverse: terminal -> source over proof closures                      */
/* ------------------------------------------------------------------ */

/** The reverse observed graph: proofs -> producing event sources (and predecessor proofs). */
export function reverseObservedGraph(snapshot: LedgerSnapshot): ObservedGraph {
  const eventAt = new Map<number, WorkflowEventRecord>(snapshot.events.map((event) => [event.sequence, event]));
  const nodes: ObservedNode[] = [];
  const edges: ObservedEdge[] = [];
  const factsOfKind = new Map<string, EvidenceRef[]>();
  for (const fact of snapshot.evidence) {
    factsOfKind.set(fact.kind, [...(factsOfKind.get(fact.kind) ?? []), fact.ref]);
  }
  const proofNodeOf = new Map<string, string>();
  for (const proof of snapshot.proofs) {
    const proofId = `proof:${proof.id}@${proof.ownerInstanceId}`;
    proofNodeOf.set(proof.id, proofId);
    nodes.push({ id: proofId, kind: 'terminal-proof' });
  }
  for (const proof of snapshot.proofs) {
    const proofId = proofNodeOf.get(proof.id) as string;
    for (const entry of proof.evidenceClosure) {
      if (entry.startsWith('TerminalProof:')) {
        // A proof-reference closure edge: this proof rests on that proof.
        const target = proofNodeOf.get(entry);
        if (target !== undefined) {
          edges.push({ from: proofId, to: target, kind: 'proof-closure' });
        }
        continue;
      }
      // A kind closure entry: walk every committed fact of that kind back to
      // its producing event's source instance.
      for (const ref of factsOfKind.get(entry) ?? []) {
        const sequence = Number.parseInt(ref.split('#')[1] ?? '', 10);
        const event = Number.isInteger(sequence) ? eventAt.get(sequence) : undefined;
        if (event === undefined) continue;
        const sourceId = `source:${event.sourceInstanceId}`;
        if (!nodes.some((node) => node.id === sourceId)) nodes.push({ id: sourceId, kind: 'evidence-source' });
        edges.push({ from: proofId, to: sourceId, kind: 'proof-closure' });
      }
    }
  }
  return {
    nodes: nodes.sort((a, b) => (a.id < b.id ? -1 : 1)),
    edges: edges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : 1)),
  };
}

/** Reverse typed equality: every committed proof's closure kinds equal the frozen registry's. */
export function reverseClosureReconciliation(snapshot: LedgerSnapshot): GraphComparison {
  const evidenceKinds = new Set<string>(snapshot.evidence.map((fact) => fact.kind as string));
  const divergences: GraphDivergence[] = [];
  for (const proof of snapshot.proofs as readonly ProofRecord[]) {
    const scopeKey = `${proof.id}`;
    const declared = PROOFS.filter((entry) => entry.id === proof.id);
    if (declared.length === 0) {
      divergences.push({ kind: 'PROOF_UNDECLARED', proof: scopeKey, detail: `committed proof ${proof.id} is not declared in the frozen proof registry` });
      continue;
    }
    const declaredKinds = new Set<string>(declared[0].requiredEvidenceClosure);
    // The observed closure: kind-name entries as committed (the engine's
    // canonical closure form) plus proof-reference entries by proof id.
    const observedKinds = new Set<string>();
    for (const entry of proof.evidenceClosure) {
      if (entry.startsWith('TerminalProof:')) {
        observedKinds.add(entry);
        continue;
      }
      // A kind entry is observed only when a fact of that kind is committed.
      if (evidenceKinds.has(entry)) observedKinds.add(entry);
    }
    for (const kind of declaredKinds) {
      if (!observedKinds.has(kind)) {
        divergences.push({ kind: 'CLOSURE_KIND_MISSING', proof: scopeKey, closureKind: kind, detail: `${proof.id} on ${proof.ownerInstanceId} is missing declared closure kind ${kind}` });
      }
    }
    for (const kind of observedKinds) {
      if (!declaredKinds.has(kind)) {
        divergences.push({ kind: 'CLOSURE_KIND_UNDECLARED', proof: scopeKey, closureKind: kind, detail: `${proof.id} on ${proof.ownerInstanceId} carries undeclared closure kind ${kind}` });
      }
    }
  }
  if (divergences.length > 0) return { equal: false, divergences };
  return { equal: true, nodeCount: snapshot.proofs.length, edgeCount: snapshot.proofs.reduce((sum, proof) => sum + proof.evidenceClosure.length, 0) };
}

/* ------------------------------------------------------------------ */
/* Exact typed comparisons                                            */
/* ------------------------------------------------------------------ */

/** Exact graph equality with typed divergences (node and edge sets). */
export function compareGraphs(observed: ObservedGraph, declared: ObservedGraph, options?: { readonly requireDeclaredSubsetOnly?: boolean }): GraphComparison {
  const divergences: GraphDivergence[] = [];
  const observedNodeIds = new Set(observed.nodes.map((node) => node.id));
  const declaredNodeIds = new Set(declared.nodes.map((node) => node.id));
  for (const id of declaredNodeIds) {
    if (!observedNodeIds.has(id)) {
      divergences.push({ kind: 'NODE_MISSING', id, detail: `declared node ${id} is absent from the observed graph` });
    }
  }
  if (options?.requireDeclaredSubsetOnly !== true) {
    for (const id of observedNodeIds) {
      if (!declaredNodeIds.has(id)) {
        divergences.push({ kind: 'NODE_UNDECLARED', id, detail: `observed node ${id} is not declared` });
      }
    }
  }
  const edgeKey = (edge: ObservedEdge): string => `${edge.from}->${edge.to}`;
  const observedEdges = new Set(observed.edges.map(edgeKey));
  const declaredEdges = new Set(declared.edges.map(edgeKey));
  for (const key of declaredEdges) {
    if (!observedEdges.has(key)) {
      const [from, to] = key.split('->');
      divergences.push({ kind: 'EDGE_MISSING', from, to, detail: `declared edge ${key} was not observed` });
    }
  }
  if (options?.requireDeclaredSubsetOnly !== true) {
    for (const key of observedEdges) {
      if (!declaredEdges.has(key)) {
        const [from, to] = key.split('->');
        divergences.push({ kind: 'EDGE_UNDECLARED', from, to, detail: `observed edge ${key} is not declared` });
      }
    }
  }
  if (divergences.length > 0) return { equal: false, divergences };
  return { equal: true, nodeCount: observed.nodes.length, edgeCount: observed.edges.length };
}

/**
 * The full forward/reverse reconciliation (R7): the forward observed graph
 * must EXACTLY equal the declared planning graph, and the reverse observed
 * closures must EXACTLY equal the frozen proof registry. This is the typed
 * comparison the ForwardReverseReconciliationReceipt evidence names.
 */
export function forwardReverseReconciliation(snapshot: LedgerSnapshot, edges: readonly DependencyEdgeRow[]): GraphComparison {
  const forward = compareGraphs(forwardObservedGraph(snapshot, edges), declaredPlanningGraph(edges));
  if (!forward.equal) return forward;
  return reverseClosureReconciliation(snapshot);
}
