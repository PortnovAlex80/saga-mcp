/**
 * Typed history readers for worker-prompt delivery (BLINDSIGHT closure).
 *
 * The factory persistently RECORDS the right information and consistently
 * fails to READ it at the point of decision (stage-11 PREVENTIVE-HUNT,
 * «Слепота по слоям»): task metadata keeps only the LAST review rejection
 * (`managed_review_last_feedback` is overwritten every round), and the claim
 * SQL looks only at live execution states, so `worker_executions.last_error`
 * is never seen by the next worker. These readers re-derive the FULL history
 * from durable, append-only sources so provisioning can deliver it into the
 * worker prompt:
 *
 *   readTaskFeedbackHistory — every feedback round of a card:
 *     - `factory_submission_validation_rejections` (immutable by trigger):
 *       submission preflight rejections with their decoded finding messages;
 *     - `comments` — every worker_done result text (the reviewer's rejection
 *       feedback among them), classified as review_rejection via the durable
 *       `command_receipts` changes_requested receipts the dispatcher writes
 *       in the same transaction.
 *
 *   readTaskDeathHistory — prior abnormal executions of a card:
 *     `worker_executions` rows in state lost / spawn_failed / terminated
 *     (the reaper's kill state; there is no separate 'reaped' state in the
 *     schema) plus exited-with-last_error rows, carrying last_error —
 *     including REPEATED_TOOL_LOOP — so a card that killed previous workers
 *     no longer looks identical to a healthy card.
 *
 * Read-only: nothing here writes. Tolerant of pre-migration databases via
 * the same no-such-table fail-closed conventions used elsewhere (a missing
 * table means "no history", never a crash of provisioning).
 */

import type { Database } from 'better-sqlite3';

export const FEEDBACK_HISTORY_SCHEMA_VERSION = 'factory.feedback-history.v1' as const;

/** A submission-preflight rejection round (gate feedback, durable + immutable). */
export interface SubmissionRejectionHistoryEntry {
  readonly kind: 'submission_rejection';
  /** rejected_at (SQLite UTC string). */
  readonly at: string;
  readonly executionId: string;
  readonly rejectionCode: string;
  readonly validatorId: string;
  /** Decoded gap messages — the exact reasons the submission was rejected. */
  readonly findingMessages: readonly string[];
}

/** A reviewer changes_requested round; the feedback text comes from comments. */
export interface ReviewRejectionHistoryEntry {
  readonly kind: 'review_rejection';
  /** accepted_at of the changes_requested receipt (SQLite UTC string). */
  readonly at: string;
  readonly executionId: string;
  readonly reviewerWorkerId: string | null;
  /**
   * The reviewer's full feedback text from the durable comment written in the
   * same worker_done transaction. null when the comment row is missing —
   * visible absence, never a fabricated or guessed text.
   */
  readonly feedback: string | null;
}

/** A worker_done result comment that is not a rejection (author summaries). */
export interface WorkerResultCommentHistoryEntry {
  readonly kind: 'worker_result_comment';
  /** comments.created_at (SQLite UTC string). */
  readonly at: string;
  readonly author: string | null;
  readonly content: string;
}

export type FeedbackHistoryEntry =
  | SubmissionRejectionHistoryEntry
  | ReviewRejectionHistoryEntry
  | WorkerResultCommentHistoryEntry;

export interface TaskFeedbackHistory {
  readonly schemaVersion: typeof FEEDBACK_HISTORY_SCHEMA_VERSION;
  readonly taskId: number;
  readonly generatedAt: string;
  /** Chronological (oldest first) — the round sequence, not just the last round. */
  readonly entries: readonly FeedbackHistoryEntry[];
  readonly reviewRejections: number;
  readonly submissionRejections: number;
}

/** One prior abnormal execution of the card. */
export interface WorkerExecutionDeath {
  readonly executionId: string;
  readonly workerId: string;
  /** Terminal state that ended the attempt abnormally. */
  readonly state: 'lost' | 'spawn_failed' | 'terminated' | 'exited';
  /**
   * The durable failure reason (includes REPEATED_TOOL_LOOP, spawn errors,
   * stuck-policy terminations). null when the writer recorded none.
   */
  readonly lastError: string | null;
  readonly finishedAt: string | null;
}

export interface TaskDeathHistory {
  readonly taskId: number;
  /** Number of prior abnormal executions (deaths.length). */
  readonly priorAttempts: number;
  /** Chronological (oldest first). */
  readonly deaths: readonly WorkerExecutionDeath[];
}

interface SubmissionRejectionRow {
  readonly rejected_at: string;
  readonly execution_id: string;
  readonly rejection_code: string;
  readonly validator_id: string;
  readonly gaps_json: string;
}

interface ReceiptRow {
  readonly accepted_at: string;
  readonly execution_id: string;
  readonly actor_id: string | null;
}

interface CommentRow {
  readonly id: number;
  readonly author: string | null;
  readonly content: string;
  readonly created_at: string;
}

/** Maximum entries copied into feedback-history.json per source. */
const MAX_ENTRIES_PER_SOURCE = 50;
/** Maximum characters of a comment body kept in the history file. */
const MAX_COMMENT_CHARS = 4000;

function parseDbTime(value: string): number {
  return Date.parse(`${value.includes('T') ? value : value.replace(' ', 'T')}Z`);
}

/**
 * Read the FULL multi-round feedback history of a task from durable
 * append-only sources. Returns null when the card has no recorded feedback
 * (first provisioning of a fresh card materializes no history file).
 */
export function readTaskFeedbackHistory(
  db: Database,
  taskId: number,
): TaskFeedbackHistory | null {
  const submissionRejections = readSubmissionRejections(db, taskId);
  const { reviewRejections, workerComments } = readCommentsAndRejections(db, taskId);

  const entries: FeedbackHistoryEntry[] = [
    ...submissionRejections,
    ...reviewRejections,
    ...workerComments,
  ].sort((left, right) => {
    const delta = parseDbTime(left.at) - parseDbTime(right.at);
    return delta !== 0 ? delta : left.kind.localeCompare(right.kind);
  });

  if (entries.length === 0) return null;
  return {
    schemaVersion: FEEDBACK_HISTORY_SCHEMA_VERSION,
    taskId,
    generatedAt: new Date().toISOString(),
    entries,
    reviewRejections: reviewRejections.length,
    submissionRejections: submissionRejections.length,
  };
}

function readSubmissionRejections(
  db: Database,
  taskId: number,
): SubmissionRejectionHistoryEntry[] {
  let rows: SubmissionRejectionRow[];
  try {
    rows = db.prepare(
      `SELECT rejected_at, execution_id, rejection_code, validator_id, gaps_json
         FROM factory_submission_validation_rejections
        WHERE task_id=?
        ORDER BY id DESC
        LIMIT ?`,
    ).all(taskId, MAX_ENTRIES_PER_SOURCE) as SubmissionRejectionRow[];
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) return [];
    throw error;
  }
  return rows.map(row => ({
    kind: 'submission_rejection' as const,
    at: row.rejected_at,
    executionId: row.execution_id,
    rejectionCode: row.rejection_code,
    validatorId: row.validator_id,
    findingMessages: decodeGapMessages(row.gaps_json),
  })).reverse();
}

/**
 * Decode the human/model-readable gap messages from a rejection's gaps_json.
 * Tolerates unknown shapes — an unreadable payload yields no messages rather
 * than crashing provisioning (the row itself still appears in the history).
 */
function decodeGapMessages(gapsJson: string): string[] {
  try {
    const gaps = JSON.parse(gapsJson) as unknown;
    if (!Array.isArray(gaps)) return [];
    return gaps
      .map(gap => (gap && typeof gap === 'object' && !Array.isArray(gap)
        ? (gap as Record<string, unknown>).message
        : null))
      .filter((message): message is string => typeof message === 'string' && message.length > 0)
      .slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Read the card's worker_done comments and classify them against the durable
 * changes_requested receipts. A comment whose (author, ~timestamp) matches a
 * receipt written in the same worker_done transaction is a review rejection;
 * every other comment is a plain worker result summary. The same-transaction
 * pairing is tolerant to the second-boundary race (±1 second window, nearest
 * comment wins, a comment is consumed at most once).
 */
function readCommentsAndRejections(
  db: Database,
  taskId: number,
): {
  reviewRejections: ReviewRejectionHistoryEntry[];
  workerComments: WorkerResultCommentHistoryEntry[];
} {
  let receipts: ReceiptRow[];
  let comments: CommentRow[];
  try {
    receipts = db.prepare(
      `SELECT accepted_at, execution_id, actor_id
         FROM command_receipts
        WHERE task_id=?
          AND command_kind='worker_done'
          AND accepted=1
          AND command_id LIKE '%:worker-done:changes_requested'
        ORDER BY accepted_at, rowid
        LIMIT ?`,
    ).all(taskId, MAX_ENTRIES_PER_SOURCE) as ReceiptRow[];
    comments = db.prepare(
      `SELECT id, author, content, created_at
         FROM comments
        WHERE task_id=?
        ORDER BY id
        LIMIT ?`,
    ).all(taskId, MAX_ENTRIES_PER_SOURCE * 4) as CommentRow[];
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) {
      return { reviewRejections: [], workerComments: [] };
    }
    throw error;
  }

  const consumedCommentIds = new Set<number>();
  const reviewRejections: ReviewRejectionHistoryEntry[] = receipts.map(receipt => {
    const pairWindowMs = 1500;
    let best: { row: CommentRow; delta: number } | null = null;
    for (const comment of comments) {
      if (consumedCommentIds.has(comment.id)) continue;
      if (receipt.actor_id !== null && comment.author !== receipt.actor_id) continue;
      const delta = Math.abs(parseDbTime(comment.created_at) - parseDbTime(receipt.accepted_at));
      if (delta > pairWindowMs) continue;
      if (best === null || delta < best.delta) best = { row: comment, delta };
    }
    let feedback: string | null = null;
    if (best !== null) {
      consumedCommentIds.add(best.row.id);
      feedback = best.row.content.length > MAX_COMMENT_CHARS
        ? `${best.row.content.slice(0, MAX_COMMENT_CHARS)}…`
        : best.row.content;
    }
    return {
      kind: 'review_rejection' as const,
      at: receipt.accepted_at,
      executionId: receipt.execution_id,
      reviewerWorkerId: receipt.actor_id,
      feedback,
    };
  });

  const workerComments: WorkerResultCommentHistoryEntry[] = comments
    .filter(comment => !consumedCommentIds.has(comment.id))
    .map(comment => ({
      kind: 'worker_result_comment' as const,
      at: comment.created_at,
      author: comment.author,
      content: comment.content.length > MAX_COMMENT_CHARS
        ? `${comment.content.slice(0, MAX_COMMENT_CHARS)}…`
        : comment.content,
    }));

  return { reviewRejections, workerComments };
}

interface DeathRow {
  readonly execution_id: string;
  readonly worker_id: string;
  readonly state: string;
  readonly last_error: string | null;
  readonly finished_at: string | null;
}

/**
 * Read the card's death history: prior abnormal executions with their durable
 * last_error. Deaths are state lost / spawn_failed / terminated (the reaper's
 * kill is 'terminated' — the schema has no separate 'reaped' state) plus
 * exited rows that carry a recorded error. Clean exits and live rows are not
 * deaths.
 */
export function readTaskDeathHistory(
  db: Database,
  taskId: number,
): TaskDeathHistory {
  let rows: DeathRow[];
  try {
    rows = db.prepare(
      `SELECT execution_id, worker_id, state, last_error, finished_at
         FROM worker_executions
        WHERE task_id=?
          AND (
            state IN ('lost','spawn_failed','terminated')
            OR (state='exited' AND last_error IS NOT NULL)
          )
        ORDER BY COALESCE(finished_at, reserved_at), execution_id`,
    ).all(taskId) as DeathRow[];
  } catch (error) {
    if (error instanceof Error && error.message.includes('no such table')) {
      return { taskId, priorAttempts: 0, deaths: [] };
    }
    throw error;
  }
  const deaths: WorkerExecutionDeath[] = rows.map(row => ({
    executionId: row.execution_id,
    workerId: row.worker_id,
    state: (row.state === 'lost' || row.state === 'spawn_failed'
      || row.state === 'terminated' || row.state === 'exited')
      ? row.state
      : 'terminated',
    lastError: row.last_error,
    finishedAt: row.finished_at,
  }));
  return { taskId, priorAttempts: deaths.length, deaths };
}
