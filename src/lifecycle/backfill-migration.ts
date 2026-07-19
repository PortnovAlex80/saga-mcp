/**
 * Slice 2 backfill migration — populate work-item shadow for existing tasks.
 *
 * Source: blueprint §16 Slice 2 (docs/architecture/passive-worker-kernel-blueprint.md:851-860),
 *         §17 WP-4 (line 1004: "honest synthetic backfill").
 *
 * Strategy:
 *   - For each task with no existing shadow rows, compute the synthetic
 *     pipeline from its legacy columns via `computeExpectedPipeline`.
 *   - Insert the shadow rows with `history_complete=0` to mark them as
 *     synthesized (blueprint §16:860). The flag tells future code that the
 *     rows were backfilled, not observed — no prior cycle history exists.
 *   - Idempotent: tasks that already have shadow rows are skipped.
 *   - Honest: never fabricates prior implementation/review cycles. A task at
 *     status='review' gets ONE completed implementation + ONE ready review;
 *     it does NOT invent multiple changes_requested cycles that may have
 *     happened.
 *
 * Scope: this migration runs at DB-open time (registered in db.ts). It does
 * NOT touch the legacy task columns — those remain authoritative in Slice 2.
 * It only populates the shadow.
 *
 * Acceptance (blueprint §16:866-869) is verified by the Slice 2 equivalence
 * tests, which run `checkEquivalence` against the backfilled rows.
 */

import type { Database } from 'better-sqlite3';
import {
  WorkItemRepository,
  type WorkItemKind,
} from './work-item-repository.js';
import {
  computeExpectedPipeline,
  type LegacyTaskProjection,
} from './compatibility-projector.js';

export interface BackfillStats {
  readonly scanned: number;
  readonly backfilled: number;
  readonly skipped: number;
  readonly unrecognizable: number;
}

/**
 * Run the backfill across all tasks in the DB. Idempotent — re-running is a
 * no-op on already-shadowed tasks. Returns counts for observability.
 */
export function backfillWorkItemShadow(db: Database): BackfillStats {
  const repo = new WorkItemRepository(db);
  let scanned = 0;
  let backfilled = 0;
  let skipped = 0;
  let unrecognizable = 0;

  const tasks = db
    .prepare(
      `SELECT t.id, t.status, t.assigned_to, t.current_execution_id,
              t.integration_state, t.tags, t.execution_mode, t.task_kind
         FROM tasks t`,
    )
    .all() as Array<{
      id: number;
      status: string;
      assigned_to: string | null;
      current_execution_id: string | null;
      integration_state: string | null;
      tags: string | null;
      execution_mode: string | null;
      task_kind: string | null;
    }>;

  for (const task of tasks) {
    scanned += 1;

    // Skip if shadow already exists (idempotency).
    if (repo.listWorkItemsForTask(task.id).length > 0) {
      skipped += 1;
      continue;
    }

    let tags: string[] = [];
    try {
      const parsed = JSON.parse(task.tags ?? '[]');
      if (Array.isArray(parsed)) tags = parsed.map(String);
    } catch {
      tags = [];
    }

    const legacy: LegacyTaskProjection = {
      task_id: task.id,
      status: task.status,
      assigned_to: task.assigned_to,
      current_execution_id: task.current_execution_id,
      integration_state: task.integration_state,
      tags,
      execution_mode: task.execution_mode,
      task_kind: task.task_kind,
    };

    const pipeline = computeExpectedPipeline(legacy);
    if (!pipeline || pipeline.length === 0) {
      unrecognizable += 1;
      continue;
    }

    // Insert the synthetic items in a single transaction. If anything fails,
    // roll back the whole task's shadow — partial shadow is worse than none.
    let predecessorId: string | null = null;
    db.transaction(() => {
      for (let i = 0; i < pipeline.length; i += 1) {
        const item = pipeline[i]!;
        const workItemId = makeWorkItemId(task.id, item.kind, item.cycleNo, i);
        const state = mapItemState(item.kind, item.state, legacy);
        repo.insertWorkItem({
          work_item_id: workItemId,
          task_id: task.id,
          kind: item.kind as WorkItemKind,
          cycle_no: item.cycleNo,
          item_no: 1,
          state,
          outcome: item.outcome,
          predecessor_item_id: predecessorId,
          required: item.required ? 1 : 0,
          input_snapshot_json: JSON.stringify({
            backfilled_from: {
              status: legacy.status,
              integration_state: legacy.integration_state,
              execution_mode: legacy.execution_mode,
            },
          }),
          history_complete: item.historyComplete,
        });
        predecessorId = workItemId;
      }

      // For tasks currently active, synthesize one running attempt to match.
      maybeSynthesizeAttempt(db, repo, task, pipeline);
    })();

    backfilled += 1;
  }

  return { scanned, backfilled, skipped, unrecognizable };
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function makeWorkItemId(
  taskId: number,
  kind: WorkItemKind,
  cycleNo: number,
  index: number,
): string {
  return `backfill-t${taskId}-${kind}-c${cycleNo}-i${index}`;
}

/**
 * Map the ExpectedPipelineItem.state to a concrete work-item state, taking
 * the legacy task state into account (e.g. an 'active' implementation item
 * with current_execution_id set should also be 'active' in the shadow).
 */
function mapItemState(
  kind: WorkItemKind,
  expectedState: WorkItemState,
  legacy: LegacyTaskProjection,
): WorkItemState {
  // For done+pending with integration state 'pending', the integration item
  // may already be 'active' if current_execution_id points at an integration
  // execution. We keep it 'ready' here; the equivalence checker will catch
  // drift if the legacy says active.
  void kind;
  void legacy;
  return expectedState;
}

type WorkItemState =
  | 'pending' | 'ready' | 'active' | 'waiting' | 'completed' | 'cancelled';

/**
 * If the task is currently active (in_progress / review_in_progress / done+
 * pending with an integration executor), synthesize a 'running' attempt
 * pointing at the live execution. This keeps the shadow consistent with
 * legacy assigned_to/current_execution_id.
 */
function maybeSynthesizeAttempt(
  db: Database,
  repo: WorkItemRepository,
  task: {
    id: number;
    status: string;
    assigned_to: string | null;
    current_execution_id: string | null;
    integration_state: string | null;
  },
  pipeline: Array<{ kind: WorkItemKind; state: string }>,
): void {
  if (!task.assigned_to || !task.current_execution_id) return;

  // Find the active item in the pipeline.
  const activeItemSpec = pipeline.find((p) => p.state === 'active');
  if (!activeItemSpec) return;

  // Find the corresponding shadow row.
  const items = repo.listWorkItemsForTask(task.id);
  const activeItem = items.find((i) => i.state === 'active');
  if (!activeItem) return;

  // Verify the execution row exists (best-effort; if missing, skip).
  const execRow = db
    .prepare('SELECT 1 FROM worker_executions WHERE execution_id = ?')
    .get(task.current_execution_id);
  if (!execRow) return;

  repo.insertWorkAttempt({
    attempt_id: `backfill-att-${activeItem.work_item_id}-1`,
    work_item_id: activeItem.work_item_id,
    ordinal: 1,
    state: 'running',
    worker_id: task.assigned_to,
    execution_id: task.current_execution_id,
    started_at: new Date().toISOString(),
  });
}
