import type Database from 'better-sqlite3';
import {
  asWorkplaceRef,
  deserializeWorkplaceRef,
  type KanbanPhase,
  type WorkplaceRef,
  type WorkplaceState,
} from '../../process-modules/domain/workplace/index.js';

/** Derive the stable Workplace identity stamped into a projected task. */
export function deriveWorkplaceRefFromTaskMetadata(input: {
  taskId: number;
  metadata: string;
  taskKind: string | null;
}): WorkplaceRef | null {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(input.metadata || '{}') as Record<string, unknown>;
  } catch {
    return null;
  }
  const processRunId = meta.process_run_id;
  if (!Number.isInteger(processRunId) || (processRunId as number) < 1) return null;
  if (typeof meta.workplace_ref === 'string') {
    try {
      const explicit = deserializeWorkplaceRef(meta.workplace_ref);
      return explicit.processRunId === processRunId ? explicit : null;
    } catch {
      return null;
    }
  }
  const moduleRef = typeof meta.process_module_ref === 'string'
    ? meta.process_module_ref
    : typeof meta.module_ref === 'string'
      ? meta.module_ref
      : 'unknown@1.0.0';
  const productionCellId = typeof meta.process_node_id === 'string'
    ? meta.process_node_id
    : input.taskKind ?? 'default';
  const workKey = typeof meta.work_key === 'string'
    ? meta.work_key
    : typeof meta.work_item_key === 'string'
      ? meta.work_item_key
      : `task-${input.taskId}`;
  return asWorkplaceRef({
    processRunId: processRunId as number,
    moduleRef,
    productionCellId,
    workKey,
  });
}

/** Rebuild the human-facing card state from the authoritative Workplace. */
export function reverseProjectWorkplaceToTask(
  db: Database.Database,
  taskId: number,
  state: WorkplaceState,
): string | null {
  const status = mapV4KanbanToTaskStatus(state.kanbanPhase);
  if (!status) return null;
  db.prepare(`UPDATE tasks SET status=?, updated_at=datetime('now') WHERE id=?`)
    .run(status, taskId);
  return status;
}

export function mapV4KanbanToTaskStatus(phase: KanbanPhase): string | null {
  switch (phase) {
    case 'todo': return 'todo';
    case 'in_progress': return 'in_progress';
    case 'review': return 'review';
    case 'review_in_progress': return 'review_in_progress';
    case 'blocked': return 'blocked';
    case 'done':
    case 'failed':
    case 'cancelled': return 'done';
    default: return null;
  }
}
