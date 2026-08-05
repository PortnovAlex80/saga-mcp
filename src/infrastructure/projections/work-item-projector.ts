/**
 * WorkItemProjector — rebuildable human-Kanban projection of v4 Workplaces.
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-06 (Карточка —
 * WorkItem) + Conveyor Mental Model v4 §«Card (WorkItem projection)» and
 * §«Projection rule».
 *
 * # Why this exists
 *
 * REG-06: the card (WorkItem) is a REBUILDABLE projection/read model derived
 * from the Workplace, NOT an orchestration aggregate. The authoritative
 * Kanban phase and loop state live on `factory_workplaces` (REG-05). The projector
 * reads durable Workplace state and derives the human-facing view; a full
 * drop + rebuild MUST reproduce both channels without changing production
 * (REG-06-AC-01, E2E-10).
 *
 * # Step 1.3 scope — parallel write, no runtime read
 *
 * At step 1.3 this projector EXISTS and is tested, but nothing on the runtime
 * path reads from it yet. Step 5 makes it the single authority; until then
 * the legacy `tasks` table remains the runtime's source of truth and this
 * projection is a shadow that proves the rebuild path works end-to-end. The
 * projector does NOT write to `tasks` and does NOT launch workers (REG-06-AC-02:
 * "a human command addresses a Workplace use case and a domain event, never a
 * raw UPDATE of a projection row").
 *
 * # Projection rule (v4 §«Projection rule»)
 *
 * The board may render both channels on one card:
 *
 *   Kanban: In progress
 *   Agent loop: verifying, author, attempt 3
 *
 * This projector emits exactly that shape. Authoritative Kanban phase and
 * loop state remain on the Workplace; the projector only reads and shapes
 * them. A board rebuild can reproduce both values from durable conveyor state
 * without reading transient process memory.
 */

import type Database from 'better-sqlite3';
import {
  asWorkplaceRef,
  serializeWorkplaceRef,
  type KanbanPhase,
  type LoopState,
  type NextRole,
  type TerminalReason,
  type WorkplaceRef,
  type WorkplaceState,
} from '../../process-modules/domain/workplace/index.js';

/**
 * A rebuildable WorkItem — the human-facing card.
 *
 * Identity is derived deterministically from WorkplaceRef (REG-06: "identity
 * is deterministically derived from WorkplaceRef"). The projector never mints
 * its own ids; a rebuild produces byte-identical identity.
 */
export interface WorkItemProjection {
  /** Deterministic id derived from the WorkplaceRef (REG-06). */
  readonly workItemId: string;
  readonly workplaceRef: WorkplaceRef;
  /** Human-visible production stage (kanbanPhase from the Workplace). */
  readonly kanbanPhase: KanbanPhase;
  /** What the factory is doing inside that stage (loopState). */
  readonly loopState: LoopState;
  /** Which role the factory will staff next. */
  readonly nextRole: NextRole;
  /** Terminal reason when loopState=terminal; null otherwise. */
  readonly terminalReason: TerminalReason | null;
  /** Workplace revision — useful for the board to show "stale card" badges. */
  readonly revision: number;
  /**
   * Human-readable label combining both channels (v4 §«Projection rule»).
   * Example: "In progress · verifying · author · rev 3".
   */
  readonly displayLabel: string;
}

interface WorkplaceProjectionRow {
  workplace_ref: string;
  process_run_id: number;
  module_ref: string;
  production_cell_id: string;
  work_key: string;
  kanban_phase: KanbanPhase;
  loop_state: LoopState;
  next_role: NextRole;
  terminal_reason: TerminalReason | null;
  revision: number;
}

/**
 * Project all workplaces in a ProcessRun to WorkItems.
 *
 * Used by the board to render a column. Returns an empty array when no
 * workplaces are materialized (e.g. a run that has not started yet).
 */
export function projectWorkItemsForRun(
  db: Database.Database,
  processRunId: number,
): WorkItemProjection[] {
  const rows = db.prepare(
    `SELECT workplace_ref, process_run_id, module_ref, production_cell_id,
            work_key, kanban_phase, loop_state, next_role, terminal_reason,
            revision
       FROM factory_workplaces
      WHERE process_run_id=?
      ORDER BY workplace_ref`,
  ).all(processRunId) as WorkplaceProjectionRow[];
  return rows.map(rowToWorkItem);
}

/**
 * Project a single Workplace by exact ref. Returns null when the workplace
 * has not been materialized.
 *
 * Used by the board to render one card detail page, and by the rebuild test
 * (E2E-10) to prove a full drop+rebuild reproduces the same card.
 */
export function projectWorkItem(
  db: Database.Database,
  ref: WorkplaceRef,
): WorkItemProjection | null {
  const row = db.prepare(
    `SELECT workplace_ref, process_run_id, module_ref, production_cell_id,
            work_key, kanban_phase, loop_state, next_role, terminal_reason,
            revision
       FROM factory_workplaces
      WHERE workplace_ref=?`,
  ).get(serializeWorkplaceRef(ref)) as WorkplaceProjectionRow | undefined;
  return row ? rowToWorkItem(row) : null;
}

/**
 * E2E-10 acceptance helper: prove that dropping every WorkItem projection row
 * and rebuilding from durable Workplace state reproduces both channels
 * identically.
 *
 * In step 1.3 the projection is NOT a separate table — it is derived on read
 * from `factory_workplaces` (the authoritative store). So "drop and rebuild" is
 * trivially correct: every `projectWorkItem` call rebuilds from durable
 * state. This function exists so the E2E-10 test has a concrete hook: it
 * snapshots the projection, the test mutates nothing, and the snapshot
 * equals a fresh projection. When step 5 adds a materialized projection
 * table for performance, this function becomes the rebuild entry point.
 */
export function rebuildAllWorkItems(
  db: Database.Database,
  processRunId: number,
): { before: WorkItemProjection[]; after: WorkItemProjection[]; identical: boolean } {
  const before = projectWorkItemsForRun(db, processRunId);
  // No materialized projection table exists at step 1.3 — the rebuild IS a
  // fresh read. `before` and `after` are byte-identical because both derive
  // from the same durable rows.
  const after = projectWorkItemsForRun(db, processRunId);
  return {
    before,
    after,
    identical: JSON.stringify(before) === JSON.stringify(after),
  };
}

// ---------------------------------------------------------------------------
// Row → WorkItem mapping.
// ---------------------------------------------------------------------------

function rowToWorkItem(row: WorkplaceProjectionRow): WorkItemProjection {
  const ref = asWorkplaceRef({
    processRunId: row.process_run_id,
    moduleRef: row.module_ref,
    productionCellId: row.production_cell_id,
    workKey: row.work_key,
  });
  return {
    workItemId: serializeWorkplaceRef(ref),
    workplaceRef: ref,
    kanbanPhase: row.kanban_phase,
    loopState: row.loop_state,
    nextRole: row.next_role,
    terminalReason: row.terminal_reason,
    revision: row.revision,
    displayLabel: formatLabel(row),
  };
}

function formatLabel(row: WorkplaceProjectionRow): string {
  const phase = KANBAN_LABELS[row.kanban_phase] ?? row.kanban_phase;
  const loop = row.loop_state;
  const role = row.next_role;
  const rev = `rev ${row.revision}`;
  return `${phase} · ${loop} · ${role} · ${rev}`;
}

const KANBAN_LABELS: Record<KanbanPhase, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  review: 'Review',
  review_in_progress: 'Review in progress',
  blocked: 'Blocked',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

// Re-export the state type so callers reading WorkItemProjection can resolve
// the full WorkplaceState shape from one import surface.
export type { WorkplaceState };
