/**
 * Assign ONE preselected card through WorkAssignmentPort BEFORE the worker is
 * launched. This is the conveyor-physics dance shared by the four Saga 3
 * discovery services (engine + normalization + readiness + diagnosis) that
 * each project an EXACT task from a WorkIntent/ControlIntent and must hand it
 * to a worker execution atomically.
 *
 * It mirrors `src/app/dispatch-loop.ts` `startOne()` (the production
 * assignTask-before-start pattern) with ONE narrowing: the caller passes a
 * single `taskId` (the projected card) instead of an open scope. This is the
 * removed (Slice 1 Zones 1-4 node-breaker).
 *
 * Why a shared helper:
 *   - the four services would otherwise duplicate ~30 lines of id-minting +
 *     assignTask + null-handling each; and
 *   - the release-on-start-failure discipline (dispatch-loop.ts:94-103) is the
 *     easy place to introduce a fence leak, so centralising it keeps one
 *     correct copy.
 *
 * Responsibilities split:
 *   - THIS helper: mint workerExecutionId / workerId / runId, call
 *     assignTask({ taskIds:[taskId], ... }), return AssignedWork | null.
 *   - the CALLER: build the executor, call executor.start({ ..., assignment }),
 *     and on spawn/start failure call releaseAssignment (see
 *     `releaseOneCardIfAssigned`).
 */
import type {
  AssignedWork,
  WorkAssignmentPort,
} from '../../application/ports/worker-executor.js';
import type { IdGeneratorPort } from '../../application/ports/conveyor-ports.js';
import { asExecutionId } from '../../lifecycle/domain/ids.js';

export interface AssignOneCardInput {
  /** Single authority for selecting and fencing cards. */
  workAssignment: WorkAssignmentPort;
  /** Infrastructure identity source; keeps Date/random/process details outside the use case. */
  idGenerator: IdGeneratorPort;
  /** Stable identity of the host that owns the worker execution. */
  machineId: string;
  projectId: number;
  epicId: number;
  /** The one projected card this execution is scoped to. */
  taskId: number;
  /** Stable run identifier prefix; the helper mints a unique runId. */
  runPrefix?: string;
}

/**
 * Atomically assign ONE preselected card through WorkAssignmentPort BEFORE the
 * worker is launched. Returns the AssignedWork, or null if the card was not
 * claimable (lost race / already claimed / unmet deps / fence held).
 *
 * The caller is responsible for:
 *   - calling `executor.start({ ..., concurrency: 1, assignment })` with the
 *     result (only when non-null);
 *   - on spawn/start failure, calling `releaseAssignment` via
 *     `releaseOneCardIfAssigned` so the card is not stranded (fence leak).
 */
export function assignOneCard(input: AssignOneCardInput): AssignedWork | null {
  const workerExecutionId = input.idGenerator.newTypedId('worker-execution');
  const workerId = input.idGenerator.newTypedId('worker');
  const runId = input.idGenerator.newTypedId(input.runPrefix ?? 'discovery-run');
  return input.workAssignment.assignTask({
    projectId: input.projectId,
    epicId: input.epicId,
    workerId,
    workerExecutionId: asExecutionId(workerExecutionId),
    runId,
    machineId: input.machineId,
    taskIds: [input.taskId],
  });
}

/**
 * Release a preassigned card back to the queue when the worker never started
 * (spawn/start failure). Mirrors dispatch-loop.ts:94-103: only release when an
 * assignment was obtained, swallow release errors (best effort), and never
 * release on clean completion (worker_done already released the card).
 *
 * `assignment` may be null (the assignTask lost the race); in that case this is
 * a no-op. Pass the terminal flag so the caller can gate the release on
 * start-failure vs clean close.
 */
export function releaseOneCardIfAssigned(
  workAssignment: WorkAssignmentPort,
  assignment: AssignedWork | null,
  reason: string,
): void {
  if (!assignment) return;
  try {
    workAssignment.releaseAssignment({
      taskId: assignment.taskId,
      workerExecutionId: assignment.workerExecutionId,
      reason,
    });
  } catch {
    // Best effort — a release failure must not mask the original start error.
  }
}
