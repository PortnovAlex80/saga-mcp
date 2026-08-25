/**
 * workflow-kernel/planning/readiness.ts - readiness over AUTHORITATIVE
 * predecessor evidence (WP-09, plan phase EK-6).
 *
 * Plan law (EK-6): "Implement exact chain, diamond, fan-in, fan-out and
 * independent-branch readiness over authoritative predecessor evidence."
 * Readiness is a PREDICATE over committed facts - never a status flip, never
 * a blocked->todo command, never a board read:
 *
 *   - a dependency edge is satisfied iff the predecessor's workplace holds a
 *     committed CellFinalAcceptance fact AND every effect it declared settled
 *     success-shaped (EffectReceipt:success | already-applied);
 *   - a terminally failed predecessor makes the dependant UNREACHABLE (D7
 *     conversion), never a dead wait and never a permanent block;
 *   - a predecessor with no workplace yet is simply not-ready (waiting).
 *
 * PURITY: pure functions of the dependency rows + topology bindings.
 */

import type { EvidenceRef, InstanceId } from '../domain/types.js';
import type { TopologyBindings } from './bindings.js';

/** One immutable dependency edge (work_item_dependency row, owner reader). */
export interface DependencyEdgeRow {
  readonly workItemRef: string;
  readonly dependsOnRef: string;
}

/** Why one predecessor does not yet satisfy its dependant. */
export type PredecessorGap =
  | { readonly itemRef: string; readonly reason: 'no-workplace' }
  | { readonly itemRef: string; readonly reason: 'no-acceptance' }
  | { readonly itemRef: string; readonly reason: 'effect-unsettled' }
  | { readonly itemRef: string; readonly reason: 'terminal-failure'; readonly workplaceId?: InstanceId };

export type ReadinessState =
  | {
      readonly state: 'ready';
      readonly itemRef: string;
      /** The exact predecessor evidence refs the successor intent must carry. */
      readonly inputEvidenceRefs: readonly EvidenceRef[];
    }
  | { readonly state: 'waiting'; readonly itemRef: string; readonly gaps: readonly PredecessorGap[] }
  | { readonly state: 'unreachable'; readonly itemRef: string; readonly failedPredecessors: readonly string[] };

/** Evaluate readiness of one work item over authoritative predecessor evidence. */
export function evaluateReadiness(edges: readonly DependencyEdgeRow[], bindings: TopologyBindings, itemRef: string): ReadinessState {
  const predecessors = edges.filter((edge) => edge.workItemRef === itemRef).map((edge) => edge.dependsOnRef);
  const inputEvidenceRefs: EvidenceRef[] = [];
  const gaps: PredecessorGap[] = [];
  const failed: string[] = [];

  for (const predecessor of predecessors) {
    const workplaces = bindings.workplacesOfWorkItem(predecessor);
    if (workplaces.length === 0) {
      gaps.push({ itemRef: predecessor, reason: 'no-workplace' });
      continue;
    }
    for (const workplace of workplaces) {
      if (bindings.terminallyFailedWorkplaces().has(workplace)) {
        failed.push(predecessor);
        gaps.push({ itemRef: predecessor, reason: 'terminal-failure', workplaceId: workplace });
        continue;
      }
      const acceptance = bindings.acceptanceRefsOfWorkplace(workplace);
      if (acceptance.length === 0) {
        gaps.push({ itemRef: predecessor, reason: 'no-acceptance' });
        continue;
      }
      // A predecessor that declared effects is accepted only when at least
      // one success-shaped receipt exists; effect-less cells have no receipts.
      const anyEffectDeclared = bindings.effectReceiptRefsOfWorkplace(workplace).length > 0;
      const successReceipts = bindings.effectSuccessRefsOfWorkplace(workplace);
      if (anyEffectDeclared && successReceipts.length === 0) {
        gaps.push({ itemRef: predecessor, reason: 'effect-unsettled' });
        continue;
      }
      inputEvidenceRefs.push(...acceptance, ...successReceipts);
    }
  }

  if (failed.length > 0) {
    // D7: a terminally failed predecessor converts readiness into
    // unreachable settlement - never a dead wait, never a permanent block.
    return { state: 'unreachable', itemRef, failedPredecessors: [...new Set(failed)].sort() };
  }
  if (gaps.length > 0) {
    return { state: 'waiting', itemRef, gaps };
  }
  return { state: 'ready', itemRef, inputEvidenceRefs: [...new Set(inputEvidenceRefs)].sort() };
}

/** Readiness of every declared work item (the full dependency report). */
export function readinessReport(edges: readonly DependencyEdgeRow[], bindings: TopologyBindings, itemRefs: readonly string[]): readonly ReadinessState[] {
  return itemRefs.map((itemRef) => evaluateReadiness(edges, bindings, itemRef));
}
