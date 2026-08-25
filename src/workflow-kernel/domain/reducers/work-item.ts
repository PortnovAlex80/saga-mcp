/**
 * WorkItem reducer - immutable semantic/planning definition (WP-05; universe
 * aggregate 8/9). Single creation authority: authority:Planning (non-aggregate
 * authority of the frozen universe).
 *
 * WorkItem definitions and dependencies are immutable planning facts: the
 * single creation command workItem.planGraph commits the complete planning
 * graph (scope equality, terminal-claim equality, unknowns with owners) and
 * after creation there is no mutable revision and no further transition.
 * D10: planGraph carries the open-unknown clause.
 */

import type { AggregateReducer, CommandGuard } from '../types.js';
import { hasEvidenceKind, refuse } from './model.js';

const planGraphGuard: CommandGuard = (input, _head, ctx) => {
  // The planning input facts arrive from the capsule through public ingress
  // (idea/scope/unknowns/claims); the graph itself is authored here.
  const required = ['TerminalLifecycleClaim', 'ConstructionSurface', 'TerminalClaimCoverage'] as const;
  for (const kind of required) {
    if (!hasEvidenceKind(ctx, kind)) {
      return refuse('MISSING_EVIDENCE', `${kind} planning input is required before workItem.planGraph may commit`);
    }
  }
  if ((input.evidenceRefs ?? []).length === 0) {
    return refuse('MISSING_EVIDENCE', 'workItem.planGraph requires its exact planning input evidence references');
  }
  return { requiredEvidenceKinds: required };
};

export const WorkItemReducer: AggregateReducer = {
  aggregate: 'WorkItem',
  ownedCommands: ['workItem.planGraph'],
  initialStatus: 'planned',
  statuses: ['planned'],
  terminalStatuses: ['planned'],
  transitions: [
    // Immutable planning fact: creation is the only transition; there is no
    // mutable board status on a WorkItem (plan law "Projection-only Kanban").
    { command: 'workItem.planGraph', fromStatuses: [], toStatus: 'planned', terminal: true },
  ],
  guards: {
    'workItem.planGraph': planGraphGuard,
  },
};
