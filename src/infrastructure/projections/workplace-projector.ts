/**
 * WorkplaceProjector — the projection layer between the authoritative v4
 * Workplace aggregate and the legacy `tasks` read model (Conveyor v4 step 5.2
 * cutover).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-05 (Workplace) +
 * REG-06 (Карточка — WorkItem projection) + Conveyor Mental Model v4 §«One
 * engine, two channels».
 *
 * # The cutover model (step 5.2)
 *
 * After cutover, the LOOP channel (`factory_workplaces.loop_state`) is the
 * orchestration authority. The KANBAN channel (`tasks.status`) is a REVERSE
 * PROJECTION of the workplace's `kanbanPhase`, written ONLY here. This makes
 * `tasks` a rebuildable read model (REG-06-AC-01: "deleting the projection
 * and rebuilding it reproduces both status channels without changing
 * production").
 *
 * This module provides TWO projection directions:
 *
 *   FORWARD  (`projectStatusChange`): tasks.status → factory_workplaces. Used
 *             during the dual-write/shadow window (SAGA_WORKPLACE_WRITE=on)
 *             and by legacy callers that still drive tasks.status. After
 *             cutover, this is the path for legacy adapters only.
 *
 *   REVERSE  (`reverseProjectWorkplaceToTask`): v4 kanbanPhase → tasks.status.
 *             Used by ConveyorRuntime after it CAS-mutates the workplace. This
 *             is the authoritative direction after cutover — the workplace
 *             owns the truth, tasks mirrors it.
 *
 * # Mapping (v4 kanbanPhase → tasks.status)
 *
 *   kanbanPhase=todo               → status='todo'
 *   kanbanPhase=in_progress        → status='in_progress'
 *   kanbanPhase=review             → status='review'
 *   kanbanPhase=review_in_progress → status='review_in_progress'
 *   kanbanPhase=blocked            → status='blocked'
 *   kanbanPhase=done               → status='done'
 *   kanbanPhase=failed             → status='done'      (terminal — board shows done)
 *   kanbanPhase=cancelled          → status='done'      (terminal — board shows done)
 *
 * # Non-goals
 *
 * The projector does NOT launch workers, does NOT decide transitions, does
 * NOT mutate the loop channel. It is a one-way projection surface.
 */

import type Database from 'better-sqlite3';
import {
  asWorkplaceRef,
  type KanbanPhase,
  type WorkplaceRef,
  type WorkplaceState,
} from '../../process-modules/domain/workplace/index.js';

// ---------------------------------------------------------------------------
// PURE HELPERS — exportable, used by ConveyorRuntime.
// ---------------------------------------------------------------------------

/**
 * Derive a WorkplaceRef from a task's metadata. The runtime stamps
 * `process_run_id`, `process_node_id` and the module context when it creates
 * a Process Module task. When those fields are absent, the task is a legacy
 * board task and is NOT projected (returns null).
 *
 * PURE: no DB, no I/O. Same (metadata, taskKind, taskId) ⇒ same ref.
 */
export function deriveWorkplaceRefFromTaskMetadata(input: {
  taskId: number;
  metadata: string;
  taskKind: string | null;
}): WorkplaceRef | null {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(input.metadata || '{}');
  } catch {
    return null;
  }
  const processRunId = meta['process_run_id'];
  if (!Number.isInteger(processRunId) || (processRunId as number) < 1) return null;

  const moduleRef = typeof meta['module_ref'] === 'string'
    ? meta['module_ref']
    : typeof meta['process_module_ref'] === 'string'
      ? meta['process_module_ref']
      : typeof input.taskKind === 'string'
        ? `${input.taskKind.split('.')[0]}@1.0.0`
        : 'unknown@1.0.0';
  const productionCellId = typeof meta['process_node_id'] === 'string'
    ? meta['process_node_id']
    : input.taskKind ?? 'default';
  const workKey = typeof meta['work_key'] === 'string'
    ? meta['work_key']
    : typeof meta['work_item_key'] === 'string'
      ? meta['work_item_key']
      : `task-${input.taskId}`;

  return asWorkplaceRef({
    processRunId: processRunId as number,
    moduleRef,
    productionCellId,
    workKey,
  });
}

/**
 * REVERSE projection (step 5.2 authoritative direction): write the workplace's
 * kanbanPhase into tasks.status. This is the ONE-WAY projection that makes
 * tasks a read model (REG-06). Called by ConveyorRuntime after it CAS-mutates
 * the workplace.
 *
 * Returns the tasks.status value written (or null if the task has no
 * workplace binding).
 */
export function reverseProjectWorkplaceToTask(
  db: Database.Database,
  taskId: number,
  state: WorkplaceState,
): string | null {
  const status = mapV4KanbanToTaskStatus(state.kanbanPhase);
  if (!status) return null;
  db.prepare(
    `UPDATE tasks SET status=?, updated_at=datetime('now') WHERE id=?`,
  ).run(status, taskId);
  return status;
}

/**
 * Map a v4 kanbanPhase to the legacy tasks.status value.
 *
 * Terminal phases (done/failed/cancelled) all map to 'done' on the board —
 * the board does not distinguish failure reasons (those live in
 * terminal_reason on the workplace + integration_state on the task).
 */
export function mapV4KanbanToTaskStatus(kanbanPhase: KanbanPhase): string | null {
  switch (kanbanPhase) {
    case 'todo': return 'todo';
    case 'in_progress': return 'in_progress';
    case 'review': return 'review';
    case 'review_in_progress': return 'review_in_progress';
    case 'blocked': return 'blocked';
    case 'done':
    case 'failed':
    case 'cancelled':
      return 'done';
    default: return null;
  }
}
