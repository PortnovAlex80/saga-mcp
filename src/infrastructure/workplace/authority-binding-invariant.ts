import type Database from 'better-sqlite3';

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
  readonly kanbanPhase: string;
  readonly loopState: string;
  readonly terminalReason: string | null;
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
             next_role = CASE
               WHEN next_role = 'reviewer' THEN 'reviewer'
               ELSE 'author'
             END,
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
      ORDER BY intent.id`,
  ).all() as ConcludedBindingRow[];

  let workplacesAdvanced = 0;
  let taskProjectionsRebuilt = 0;

  const reconcile = db.transaction(() => {
    for (const row of rows) {
      const disposition = conclusionDisposition(db, row);

      if (row.workplaceRef !== null) {
        const current = db.prepare(
          `SELECT kanban_phase AS kanbanPhase,
                  loop_state AS loopState,
                  terminal_reason AS terminalReason
             FROM factory_workplaces
            WHERE workplace_ref = ?`,
        ).get(row.workplaceRef) as WorkplaceTerminalRow | undefined;

        if (current && current.loopState !== 'terminal') {
          const phase = disposition === 'accepted' ? 'done' : 'failed';
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
          ).run(phase, disposition, row.workplaceRef);
          workplacesAdvanced += changed.changes;
        }
      }

      const taskChanged = db.prepare(
        `UPDATE tasks
            SET status = 'done',
                assigned_to = NULL,
                current_execution_id = NULL,
                updated_at = datetime('now')
          WHERE id = ?
            AND (
              status <> 'done'
              OR assigned_to IS NOT NULL
              OR current_execution_id IS NOT NULL
            )`,
      ).run(row.taskId);
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
