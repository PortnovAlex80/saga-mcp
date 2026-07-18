/**
 * Compatibility projector — derives board state from work items and vice versa.
 *
 * Source: blueprint §17 WP-4 (docs/architecture/passive-worker-kernel-blueprint.md:993-1006),
 *         §16 Slice 2 acceptance (line 864-869).
 *
 * Two directions:
 *
 * 1. projectToLegacy(workItems, attempts) → expected legacy columns
 *    (status, assigned_to, integration_state). Used to verify that the
 *    shadow model is consistent with the board.
 *
 * 2. computeExpectedWorkItems(taskRow) → expected work-item pipeline shape
 *    for a task. Used by the backfill migration to synthesize rows.
 *
 * Acceptance from blueprint §16:866-869:
 *   - every managed task has exactly one current semantic item;
 *   - recomputed board projection matches legacy rows or reports a named
 *     mismatch (EquivalenceReport);
 *   - review approval survives loss of an integration attempt (the audit's
 *     central fix — at the shadow level the review item stays 'completed'
 *     when an integration attempt is lost; only the integration item
 *     reverts to 'ready');
 *   - backfill never fabricates prior cycle history.
 *
 * Pure logic here (no DB). The repository supplies the rows; the projector
 * reasons about them. SQL lives only in work-item-repository.ts.
 */

import type {
  WorkItemKind,
  WorkItemRow,
  WorkAttemptRow,
} from './work-item-repository.js';

// ---------------------------------------------------------------------------
// Input: the legacy task row (board projection of record in Slice 2).
// ---------------------------------------------------------------------------

export interface LegacyTaskProjection {
  readonly task_id: number;
  readonly status: string;
  readonly assigned_to: string | null;
  readonly current_execution_id: string | null;
  readonly integration_state: string | null;
  readonly tags: readonly string[];
  readonly execution_mode: string | null;
  readonly task_kind: string | null;
}

// ---------------------------------------------------------------------------
// Output: the board columns the projector derives from work items.
// ---------------------------------------------------------------------------

export interface DerivedBoardState {
  readonly status: string;
  readonly assigned_to: string | null;
  readonly integration_state: string | null;
}

// ---------------------------------------------------------------------------
// Equivalence report.
// ---------------------------------------------------------------------------

export type EquivalenceMismatchCode =
  | 'STATUS_DRIFT'
  | 'ASSIGNED_TO_DRIFT'
  | 'INTEGRATION_STATE_DRIFT'
  | 'MULTIPLE_CURRENT_ITEMS'
  | 'NO_CURRENT_ITEM'
  | 'ORPHAN_ATTEMPT'
  | 'ATTEMPT_WITHOUT_ACTIVE_ITEM';

export interface EquivalenceReport {
  readonly task_id: number;
  readonly ok: boolean;
  readonly mismatches: ReadonlyArray<{
    readonly code: EquivalenceMismatchCode;
    readonly detail: string;
  }>;
}

// ---------------------------------------------------------------------------
// 1. projectToLegacy — derive board columns from work items + attempts.
// ---------------------------------------------------------------------------

/**
 * Derive the expected legacy board columns from the shadow model.
 *
 * Rules (mirror Slice 0's backfill map, blueprint §16:851-859, inverted):
 *   - if any item is 'active' with a running attempt   → in_progress/review_in_progress
 *   - if the next-ready item is implementation          → todo
 *   - if the next-ready item is review                  → review
 *   - if a review is completed and integration ready    → done + pending
 *   - if integration is 'completed'                     → done + merged/not_required
 *   - if integration is 'waiting' on conflict           → done + conflict
 *   - if a human_decision item is 'waiting'             → status unchanged, tag needs-human
 *   - if all items terminal-successful                  → done + merged/not_required
 *
 * Returns null when the work-item state is structurally invalid (caller
 * should treat as 'cannot project'; the equivalence checker reports it).
 */
export function projectToLegacy(
  items: readonly WorkItemRow[],
  attempts: readonly WorkAttemptRow[],
): DerivedBoardState | null {
  if (items.length === 0) return null;

  // Active item + its attempt drive the top-level status.
  const activeItem = items.find((i) => i.state === 'active');
  if (activeItem) {
    const attempt = attempts.find(
      (a) => a.work_item_id === activeItem.work_item_id && a.state === 'running',
    );
    const assignedTo = attempt?.worker_id ?? null;
    const execId = attempt?.execution_id ?? null;
    void execId; // not in DerivedBoardState, but documented as set at runtime
    if (activeItem.kind === 'implementation') {
      return { status: 'in_progress', assigned_to: assignedTo, integration_state: 'not_required' };
    }
    if (activeItem.kind === 'review' || activeItem.kind === 'verification') {
      return { status: 'review_in_progress', assigned_to: assignedTo, integration_state: 'not_required' };
    }
    if (activeItem.kind === 'integration') {
      return { status: 'done', assigned_to: assignedTo, integration_state: 'pending' };
    }
  }

  // Waiting on human input.
  const waitingHuman = items.find((i) => i.kind === 'human_decision' && i.state === 'waiting');
  if (waitingHuman) {
    // status stays as whatever the underlying phase would be; we only flag
    // via tags. For projection purposes we map to the resume phase.
    return {
      status: waitingHuman.outcome === 'resume-review' ? 'review' : 'todo',
      assigned_to: null,
      integration_state: 'not_required',
    };
  }

  // No active item. Find the most recent completed review; if any, look at
  // integration state next.
  const completedReviews = items.filter(
    (i) => i.kind === 'review' && i.state === 'completed' && i.outcome === 'approved',
  );
  const hasCompletedReview = completedReviews.length > 0;

  const integrationItem = items.find((i) => i.kind === 'integration');
  if (integrationItem) {
    if (integrationItem.state === 'completed') {
      return { status: 'done', assigned_to: null, integration_state: 'merged' };
    }
    if (integrationItem.state === 'waiting') {
      return { status: 'done', assigned_to: null, integration_state: 'conflict' };
    }
    // ready or active (active covered above) → pending
    return { status: 'done', assigned_to: null, integration_state: 'pending' };
  }

  // No integration item. Non-git terminal review → done.
  if (hasCompletedReview) {
    return { status: 'done', assigned_to: null, integration_state: 'not_required' };
  }

  // Ready review item → review queue.
  const readyReview = items.find((i) => i.kind === 'review' && i.state === 'ready');
  if (readyReview) {
    return { status: 'review', assigned_to: null, integration_state: 'not_required' };
  }

  // Ready implementation item → todo queue.
  const readyImpl = items.find((i) => i.kind === 'implementation' && i.state === 'ready');
  if (readyImpl) {
    return { status: 'todo', assigned_to: null, integration_state: 'not_required' };
  }

  // Ambiguous: items exist but none in a state we can project from.
  return null;
}

// ---------------------------------------------------------------------------
// 2. checkEquivalence — compare legacy vs derived.
// ---------------------------------------------------------------------------

export function checkEquivalence(
  legacy: LegacyTaskProjection,
  items: readonly WorkItemRow[],
  attempts: readonly WorkAttemptRow[],
): EquivalenceReport {
  const mismatches: Array<{ code: EquivalenceMismatchCode; detail: string }> = [];

  // Acceptance §16:866 — exactly one current semantic item.
  const activeItems = items.filter((i) => i.state === 'active');
  if (activeItems.length > 1) {
    mismatches.push({
      code: 'MULTIPLE_CURRENT_ITEMS',
      detail: `${activeItems.length} active items: ${activeItems.map((i) => i.work_item_id).join(',')}`,
    });
  }

  // Acceptance §16:867 — recomputed board projection matches legacy.
  const derived = projectToLegacy(items, attempts);
  if (!derived) {
    mismatches.push({
      code: 'NO_CURRENT_ITEM',
      detail: `no projectable work-item state for task ${legacy.task_id}`,
    });
  } else {
    if (derived.status !== legacy.status) {
      mismatches.push({
        code: 'STATUS_DRIFT',
        detail: `legacy status=${legacy.status}, derived=${derived.status}`,
      });
    }
    // assigned_to: legacy may carry owner when derived says null only for
    // terminal/ready states. For active states the worker_id must match.
    if (activeItems.length === 1) {
      const attempt = attempts.find(
        (a) => a.work_item_id === activeItems[0]!.work_item_id && a.state === 'running',
      );
      const attemptWorker = attempt?.worker_id ?? null;
      if ((legacy.assigned_to ?? null) !== (attemptWorker ?? null)) {
        mismatches.push({
          code: 'ASSIGNED_TO_DRIFT',
          detail: `legacy assigned_to=${legacy.assigned_to}, attempt worker_id=${attemptWorker}`,
        });
      }
    } else if (derived.assigned_to === null && legacy.assigned_to !== null && legacy.assigned_to !== '') {
      // Only flag for non-waiting states.
      if (!legacy.tags.includes('needs-human')) {
        mismatches.push({
          code: 'ASSIGNED_TO_DRIFT',
          detail: `legacy assigned_to=${legacy.assigned_to}, derived expects null`,
        });
      }
    }

    if (normalizeIntegrationState(derived.integration_state) !==
        normalizeIntegrationState(legacy.integration_state)) {
      mismatches.push({
        code: 'INTEGRATION_STATE_DRIFT',
        detail: `legacy integration_state=${legacy.integration_state}, derived=${derived.integration_state}`,
      });
    }
  }

  // Acceptance §16:866 — orphan attempts (no matching work item).
  const itemIds = new Set(items.map((i) => i.work_item_id));
  for (const attempt of attempts) {
    if (!itemIds.has(attempt.work_item_id)) {
      mismatches.push({
        code: 'ORPHAN_ATTEMPT',
        detail: `attempt ${attempt.attempt_id} references unknown item ${attempt.work_item_id}`,
      });
    }
  }

  // Attempt on a non-active item with state 'running' is suspicious.
  const activeItemIds = new Set(activeItems.map((i) => i.work_item_id));
  for (const attempt of attempts) {
    if (attempt.state === 'running' && !activeItemIds.has(attempt.work_item_id)) {
      mismatches.push({
        code: 'ATTEMPT_WITHOUT_ACTIVE_ITEM',
        detail: `attempt ${attempt.attempt_id} is running but its item is not active`,
      });
    }
  }

  return {
    task_id: legacy.task_id,
    ok: mismatches.length === 0,
    mismatches,
  };
}

function normalizeIntegrationState(s: string | null): string {
  // 'not_required' and null both mean "no integration pipeline" — treat as equal.
  if (s === null || s === '' || s === 'not_required') return 'none';
  return s;
}

// ---------------------------------------------------------------------------
// 3. computeExpectedWorkItems — pipeline shape from a legacy task.
//    Used by the Slice 2 backfill migration (see backfill-migration.ts).
//    Returns a HONEST synthetic pipeline: one current item reflecting the
//    task's present state, never inventing prior cycles.
// ---------------------------------------------------------------------------

export interface ExpectedPipelineItem {
  readonly kind: WorkItemKind;
  readonly state: WorkItemRow['state'];
  readonly outcome: string | null;
  readonly required: boolean;
  /**
   * history_complete=false marks ambiguous backfill — the item was synthesized
   * from a legacy column rather than observed. Per blueprint §16:860.
   */
  readonly historyComplete: boolean;
  readonly cycleNo: number;
}

/**
 * Compute the synthetic work-item pipeline a task SHOULD have, given its
 * legacy columns. Honest — does not invent prior cycle history. Returns null
 * for unrecognized combinations.
 */
export function computeExpectedPipeline(legacy: LegacyTaskProjection): ExpectedPipelineItem[] | null {
  const items: ExpectedPipelineItem[] = [];
  const isGit = legacy.execution_mode === 'git_change';

  // Common: a completed implementation item exists for any task past 'todo'.
  const hasPassedImplementation =
    legacy.status === 'review' ||
    legacy.status === 'review_in_progress' ||
    legacy.status === 'done';

  if (legacy.status === 'todo') {
    items.push({
      kind: 'implementation', state: 'ready', outcome: null,
      required: true, historyComplete: false, cycleNo: 1,
    });
    return items;
  }

  if (legacy.status === 'in_progress') {
    items.push({
      kind: 'implementation', state: 'active', outcome: null,
      required: true, historyComplete: false, cycleNo: 1,
    });
    return items;
  }

  if (hasPassedImplementation) {
    items.push({
      kind: 'implementation', state: 'completed', outcome: 'completed',
      required: true, historyComplete: false, cycleNo: 1,
    });
  }

  if (legacy.status === 'review') {
    items.push({
      kind: 'review', state: 'ready', outcome: null,
      required: true, historyComplete: false, cycleNo: 1,
    });
    return items;
  }

  if (legacy.status === 'review_in_progress') {
    items.push({
      kind: 'review', state: 'active', outcome: null,
      required: true, historyComplete: false, cycleNo: 1,
    });
    return items;
  }

  if (legacy.status === 'done') {
    // Review must be approved to reach done.
    items.push({
      kind: 'review', state: 'completed', outcome: 'approved',
      required: true, historyComplete: false, cycleNo: 1,
    });

    if (legacy.integration_state === 'pending') {
      // Approved review + ready/active integration.
      items.push({
        kind: 'integration', state: 'ready', outcome: null,
        required: isGit, historyComplete: false, cycleNo: 1,
      });
      return items;
    }
    if (legacy.integration_state === 'conflict') {
      items.push({
        kind: 'integration', state: 'waiting', outcome: 'conflict',
        required: isGit, historyComplete: false, cycleNo: 1,
      });
      return items;
    }
    // merged or not_required → terminal. No integration item needed for
    // non-git; for git we still synthesize a completed one for honesty.
    if (isGit && legacy.integration_state === 'merged') {
      items.push({
        kind: 'integration', state: 'completed', outcome: 'merged',
        required: true, historyComplete: false, cycleNo: 1,
      });
    }
    return items;
  }

  // 'blocked' or unrecognized.
  if (legacy.status === 'blocked') {
    // Synthetic: implementation ready, but blocked at the task level.
    items.push({
      kind: 'implementation', state: 'ready', outcome: null,
      required: true, historyComplete: false, cycleNo: 1,
    });
    return items;
  }

  return null;
}
