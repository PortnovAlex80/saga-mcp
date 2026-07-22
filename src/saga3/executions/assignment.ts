/**
 * Saga 3 — Worker assignment contract.
 *
 * When a WorkIntent is admitted (prerequisites met, budget reserved,
 * resource claims acquired), the controller creates a WorkerAssignment.
 * The assignment is what the worker runtime receives.
 *
 * The assignment carries a lease epoch — every authoritative commit
 * must re-check the epoch. Late results from superseded workers are rejected.
 */

import type {
  WorkerAssignment,
  AssignmentState,
  WorkIntent,
  SkillCapability,
} from '../domain/types.js';

let epochCounter = 0;

/**
 * Create a worker assignment from an admitted WorkIntent.
 * The lease epoch is monotonic per-episode.
 */
export function createAssignment(input: {
  readonly workIntent: WorkIntent;
  readonly skill: SkillCapability;
  readonly workerId?: string;
  readonly executionId?: string;
}): WorkerAssignment {
  return {
    id: '', // caller assigns
    workIntentId: input.workIntent.id,
    skillId: input.skill.skillId,
    workerId: input.workerId ?? null,
    executionId: input.executionId ?? null,
    leaseEpoch: ++epochCounter,
    state: 'pending',
  };
}

/**
 * Check whether a submitted result carries a valid (current) lease epoch.
 * Late results from superseded workers are rejected at the authorization boundary.
 */
export function isLeaseValid(
  assignment: WorkerAssignment,
  submittedEpoch: number,
  currentEpoch: number,
): boolean {
  return submittedEpoch === currentEpoch && assignment.state !== 'lost';
}

/**
 * Transition assignment state.
 */
export function transitionAssignment(
  assignment: WorkerAssignment,
  newState: AssignmentState,
): WorkerAssignment {
  const valid: Record<AssignmentState, readonly AssignmentState[]> = {
    pending: [],
    running: ['pending'],
    submitted: ['running'],
    verified: ['submitted'],
    failed: ['running', 'submitted'],
    lost: ['pending', 'running'],
  };
  if (!valid[newState].includes(assignment.state)) {
    throw new Error(
      `Assignment: invalid transition ${assignment.state} → ${newState}`,
    );
  }
  return { ...assignment, state: newState };
}

/**
 * Resolve the Skill capability for a WorkIntent.
 * Returns null if no registered skill matches the action kind.
 */
export function resolveSkill(
  workIntent: WorkIntent,
  registry: readonly SkillCapability[],
): SkillCapability | null {
  return (
    registry.find(
      (s) =>
        s.skillId === workIntent.skillId ||
        s.actionKinds.includes(workIntent.strategyId),
    ) ?? null
  );
}
