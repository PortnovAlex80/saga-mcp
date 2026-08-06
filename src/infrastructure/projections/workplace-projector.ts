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
 * The module also installs one database-level cross-channel invariant:
 * `factory_work_intents.status -> concluded` and the bound Workplace terminal
 * transition commit in the same SQLite transaction, after which this projector
 * rebuilds `tasks.status`. This is the cutover bridge until every module emits
 * a first-class GateDecision. It prevents an accepted durable product from
 * leaving `intent=concluded`, `workplace=verifying`, `task=todo` as three
 * contradictory truths.
 *
 * # Mapping (v4 kanbanPhase → tasks.status)
 *
 *   kanbanPhase=todo               → status='todo'
 *   kanbanPhase=in_progress        → status='in_progress'
 *   kanbanPhase=review             → status='review'
 *   kanbanPhase=review_in_progress → status='review_in_progress'
 *   kanbanPhase=blocked            → status='blocked'
 *   kanbanPhase=done               → status='done'
 *   kanbanPhase=failed             → status='done'      (reason stays on Workplace)
 *   kanbanPhase=cancelled          → status='done'      (reason stays on Workplace)
 */

import type Database from 'better-sqlite3';
import {
  asWorkplaceRef,
  deserializeWorkplaceRef,
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

  if (typeof meta['workplace_ref'] === 'string') {
    try {
      const explicit = deserializeWorkplaceRef(meta['workplace_ref']);
      return explicit.processRunId === processRunId ? explicit : null;
    } catch {
      return null;
    }
  }

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

// ---------------------------------------------------------------------------
// AUTHORITY BINDING INVARIANT — WorkIntent + Workplace + task projection.
// ---------------------------------------------------------------------------

/**
 * Result of the one-time reconciliation performed when the database opens.
 * Future transitions are protected by the trigger installed by the same
 * function, so these counters describe only pre-existing split-brain rows.
 */
export interface AuthorityBindingReconciliationResult {
  readonly inspected: number;
  readonly workplacesAdvanced: number;
  readonly taskProjectionsRebuilt: number;
}

interface ConcludedBindingRow {
  readonly intentId: number;
  readonly kind: string;
  readonly taskId: number;
  readonly workplaceRef: string | null;
}

interface WorkplaceTerminalRow {
  readonly loopState: string;
}

type TerminalDisposition = 'accepted' | 'failed';

/**
 * Install the cross-channel invariant for a WorkIntent conclusion.
 *
 * A WorkIntent is the authority/fence contract for one bounded LM execution;
 * a Workplace is the production-state authority; tasks.status is only its
 * human-facing projection. Those three records must never be committed in
 * three independent steps.
 *
 * The AFTER UPDATE trigger executes in the SAME SQLite transaction as the
 * `factory_work_intents.status -> concluded` CAS. It therefore advances the
 * bound Workplace to a terminal pair and rebuilds the task projection before
 * the caller can observe a successful conclusion. A process crash can happen
 * before that transaction or after it, but not between the three writes.
 *
 * The installer also repairs rows created by the pre-invariant implementation:
 * `intent=concluded` with a non-terminal Workplace and/or a stale task card.
 * It never reopens a concluded intent and never makes `concluded` claimable.
 * Explicit semantic repair remains a separate transition that must first move
 * the Workplace into a repair state and create a new fenced execution.
 *
 * Discovery has one historical exceptional branch: the proposal worker could
 * conclude after a syntactically rejected raw submission, or after an
 * accepted_deterministically submission whose canonical Proposal was not
 * materialized. Those are terminal failures, not accepted products. A
 * normalization_required raw submission is a valid completed output of the
 * proposal cell and is therefore accepted before the normalization cell starts.
 * Other intent kinds reach `concluded` only after their module resolver or
 * reviewed task has accepted their durable output.
 */
export function ensureAuthorityBindingInvariant(
  db: Database.Database,
): AuthorityBindingReconciliationResult {
  installConclusionTrigger(db);
  return reconcileExistingConclusions(db);
}

function installConclusionTrigger(db: Database.Database): void {
  // Recreate rather than CREATE IF NOT EXISTS: this function is the versioned
  // owner of the trigger body, so deployments pick up invariant corrections
  // without changing or deleting product data.
  db.exec(`
    DROP TRIGGER IF EXISTS trg_factory_work_intent_conclusion_atomic;

    CREATE TRIGGER trg_factory_work_intent_conclusion_atomic
    AFTER UPDATE OF status ON factory_work_intents
    WHEN NEW.status = 'concluded'
      AND OLD.status <> 'concluded'
      AND NEW.projected_task_id IS NOT NULL
      AND NEW.kind NOT LIKE 'production-cell.%'
    BEGIN
      UPDATE factory_workplaces
         SET kanban_phase = CASE
               WHEN NEW.kind = 'discovery'
                AND NOT EXISTS (
                  SELECT 1
                    FROM factory_proposals proposal
                   WHERE proposal.intent_id = NEW.id
                     AND proposal.status = 'submitted'
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM factory_raw_submissions raw
                   WHERE raw.intent_id = NEW.id
                     AND raw.status = 'normalization_required'
                )
               THEN 'failed'
               ELSE 'done'
             END,
             loop_state = 'terminal',
             terminal_reason = CASE
               WHEN NEW.kind = 'discovery'
                AND NOT EXISTS (
                  SELECT 1
                    FROM factory_proposals proposal
                   WHERE proposal.intent_id = NEW.id
                     AND proposal.status = 'submitted'
                )
                AND NOT EXISTS (
                  SELECT 1
                    FROM factory_raw_submissions raw
                   WHERE raw.intent_id = NEW.id
                     AND raw.status = 'normalization_required'
                )
               THEN 'failed'
               ELSE 'accepted'
             END,
             revision = revision + 1,
             active_reservation_ref = NULL,
             active_gate_ref = NULL,
             active_recovery_case_ref = NULL,
             updated_at = datetime('now')
       WHERE workplace_ref = (
               SELECT workplace_ref
                 FROM tasks
                WHERE id = NEW.projected_task_id
             )
         AND loop_state <> 'terminal';

      -- tasks.status is a rebuildable read model. This write intentionally
      -- mirrors mapV4KanbanToTaskStatus: every terminal Workplace is rendered
      -- as done; the exact accepted/failed reason remains on the Workplace.
      UPDATE tasks
         SET status = 'done',
             assigned_to = NULL,
             current_execution_id = NULL,
             updated_at = datetime('now')
       WHERE id = NEW.projected_task_id;
    END;
  `);
}

function reconcileExistingConclusions(
  db: Database.Database,
): AuthorityBindingReconciliationResult {
  const rows = db.prepare(
    `SELECT intent.id AS intentId,
            intent.kind AS kind,
            task.id AS taskId,
            task.workplace_ref AS workplaceRef
       FROM factory_work_intents intent
       JOIN tasks task ON task.id = intent.projected_task_id
      WHERE intent.status = 'concluded'
        AND intent.kind NOT LIKE 'production-cell.%'
      ORDER BY intent.id`,
  ).all() as ConcludedBindingRow[];

  let workplacesAdvanced = 0;
  let taskProjectionsRebuilt = 0;

  const reconcile = db.transaction(() => {
    for (const row of rows) {
      const disposition = conclusionDisposition(db, row);
      const kanbanPhase: KanbanPhase = disposition === 'accepted'
        ? 'done'
        : 'failed';

      if (row.workplaceRef !== null) {
        const current = db.prepare(
          `SELECT loop_state AS loopState
             FROM factory_workplaces
            WHERE workplace_ref = ?`,
        ).get(row.workplaceRef) as WorkplaceTerminalRow | undefined;

        if (current && current.loopState !== 'terminal') {
          const changed = db.prepare(
            `UPDATE factory_workplaces
                SET kanban_phase = ?,
                    loop_state = 'terminal',
                    terminal_reason = ?,
                    revision = revision + 1,
                    active_reservation_ref = NULL,
                    active_gate_ref = NULL,
                    active_recovery_case_ref = NULL,
                    updated_at = datetime('now')
              WHERE workplace_ref = ?
                AND loop_state <> 'terminal'`,
          ).run(kanbanPhase, disposition, row.workplaceRef);
          workplacesAdvanced += changed.changes;
        }
      }

      const projectedStatus = mapV4KanbanToTaskStatus(kanbanPhase);
      const taskChanged = db.prepare(
        `UPDATE tasks
            SET status = ?,
                assigned_to = NULL,
                current_execution_id = NULL,
                updated_at = datetime('now')
          WHERE id = ?
            AND (
              status <> ?
              OR assigned_to IS NOT NULL
              OR current_execution_id IS NOT NULL
            )`,
      ).run(projectedStatus, row.taskId, projectedStatus);
      taskProjectionsRebuilt += taskChanged.changes;
    }
  });

  reconcile();

  return {
    inspected: rows.length,
    workplacesAdvanced,
    taskProjectionsRebuilt,
  };
}

function conclusionDisposition(
  db: Database.Database,
  row: ConcludedBindingRow,
): TerminalDisposition {
  if (row.kind !== 'discovery') return 'accepted';

  const proposal = db.prepare(
    `SELECT 1
       FROM factory_proposals
      WHERE intent_id = ?
        AND status = 'submitted'
      LIMIT 1`,
  ).get(row.intentId);
  if (proposal) return 'accepted';

  const normalizationRequired = db.prepare(
    `SELECT 1
       FROM factory_raw_submissions
      WHERE intent_id = ?
        AND status = 'normalization_required'
      LIMIT 1`,
  ).get(row.intentId);
  return normalizationRequired ? 'accepted' : 'failed';
}
