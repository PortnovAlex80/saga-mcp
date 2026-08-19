/**
 * Task recovery memory bridge (BLINDSIGHT X2).
 *
 * Census finding (docs/factory-run/stage11/PREVENTIVE-HUNT.md, Cross-Layer
 * X2): the worker skills promised an episodic-memory bridge —
 *
 *   - `comment_add` with a `RECOVERY:` prefix is parsed and stored into
 *     `metadata.attempt_history[].recovery_summary` (saga-verifier contract);
 *   - `metadata.previous_failures` is filled from durable failure history
 *     when a task is claimed;
 *   - `metadata.attempt_history` accumulates the same durable history;
 *   - `metadata.hint` tells a re-claiming worker the task was already in
 *     work.
 *
 * and ZERO lines of code implemented any of it. The verifier wrote
 * RECOVERY:-comments into a table nobody parsed, and every worker read
 * metadata fields nobody filled — both directions missing.
 *
 * Design rules (repair discipline):
 *
 *   - TYPED: the parser returns a discriminated result, never a loose string.
 *   - FAIL-CLOSED: a comment without the exact prefix is just a comment; an
 *     unparseable metadata column or a missing source table never throws out
 *     of the materialization path — it degrades to "no history from that
 *     source" instead of blocking the claim.
 *   - APPEND-ONLY SOURCES: the snapshot is always DERIVED from durable,
 *     immutable rows (comments, factory_submission_validation_rejections).
 *     Materialization is therefore idempotent and cumulative by
 *     construction — re-claiming never duplicates entries and cannot
 *     fabricate history.
 *   - DELIVERY TO THE DECISION POINT: materialization runs (a) inside the
 *     claim transaction so the task object returned by worker_next already
 *     carries the memory, and (b) immediately after a RECOVERY:-comment is
 *     written so task_get reflects it before the next claim. The data does
 *     not merely live in the DB — it rides the metadata the worker reads.
 *   - PRESERVATION: existing metadata keys (process_run_id, process_workspace,
 *     specialist hints, …) are never removed. `hint` written by a planner or
 *     specialist is never overwritten; the machine notice is only added when
 *     the field is absent AND prior attempts exist.
 */

import type { Database } from 'better-sqlite3';

/** Exact prefix the saga-verifier contract requires (case-sensitive). */
export const RECOVERY_COMMENT_PREFIX = 'RECOVERY:';

/** Schema marker written alongside the materialized fields. */
export const TASK_RECOVERY_MEMORY_SCHEMA = 'factory.task-recovery-memory.v1';

/** Machine-authored hint prefix for a re-claimed, previously attempted task. */
export const MACHINE_HINT_NOTICE_PREFIX = '[task-recovery-memory]';

/** Upper bound for previous_failures strings (bounded prompt payload). */
export const MAX_PREVIOUS_FAILURES = 20;

/** Upper bound for attempt_history entries (bounded prompt payload). */
export const MAX_ATTEMPT_HISTORY = 50;

/** Upper bound for a single recovery summary carried into metadata. */
export const MAX_SUMMARY_LENGTH = 2000;

export interface ParsedRecoveryComment {
  readonly summary: string;
}

/**
 * Typed, fail-closed parser for the RECOVERY:-comment contract.
 *
 * Rules (matching the skill contract "Префикс RECOVERY: обязателен"):
 *   - the prefix must be exact and at the start of the content;
 *   - the remainder must be non-empty after trimming;
 *   - anything else is an ordinary comment → null.
 */
export function parseRecoveryComment(
  content: unknown,
): ParsedRecoveryComment | null {
  if (typeof content !== 'string') return null;
  if (!content.startsWith(RECOVERY_COMMENT_PREFIX)) return null;
  const summary = content.slice(RECOVERY_COMMENT_PREFIX.length).trim();
  if (summary.length === 0) return null;
  return {
    summary:
      summary.length > MAX_SUMMARY_LENGTH
        ? summary.slice(0, MAX_SUMMARY_LENGTH)
        : summary,
  };
}

export type AttemptHistoryKind = 'recovery_note' | 'submission_rejection';

export interface AttemptHistoryEntry {
  /** 1-based ordinal in durable order. */
  readonly attempt: number;
  readonly kind: AttemptHistoryKind;
  /** Timestamp of the durable source row (SQLite datetime format). */
  readonly at: string;
  readonly execution_id: string | null;
  readonly worker_id: string | null;
  /**
   * Verbal reflection (RECOVERY note) or structured rejection summary.
   * Named after the field the skills read:
   * metadata.attempt_history[].recovery_summary.
   */
  readonly recovery_summary: string;
  /** Durable pointer: comment:<id> | submission-validation-rejection:<ref>. */
  readonly source_ref: string;
}

export interface TaskRecoveryMemorySnapshot {
  readonly schema: typeof TASK_RECOVERY_MEMORY_SCHEMA;
  readonly attempt_count: number;
  readonly previous_failures: readonly string[];
  readonly attempt_history: readonly AttemptHistoryEntry[];
}

interface CommentRow {
  id: number;
  author: string | null;
  content: string;
  created_at: string;
}

interface RejectionRow {
  rejection_ref: string;
  execution_id: string;
  rejection_code: string;
  gaps_json: string;
  rejected_at: string;
}

interface GapShape {
  readonly message?: unknown;
  readonly artifactCode?: unknown;
  readonly missing?: { readonly relation?: unknown };
}

interface TaskMetadataRow {
  metadata: string;
}

/**
 * Derive the full recovery-memory snapshot from durable, append-only sources.
 *
 * Sources:
 *   1. comments with the RECOVERY: prefix (verifier/dev reflections);
 *   2. factory_submission_validation_rejections rows (worker_done preflight
 *      gate rejections — already append-only with immutability triggers).
 *
 * Order: durable row time, then source id — stable across re-materialization.
 */
export function buildTaskRecoveryMemory(
  db: Database,
  taskId: number,
): TaskRecoveryMemorySnapshot {
  const entries: AttemptHistoryEntry[] = [];

  const commentRows = db.prepare(
    `SELECT id, author, content, created_at
       FROM comments
      WHERE task_id=?
      ORDER BY created_at ASC, id ASC`,
  ).all(taskId) as CommentRow[];
  for (const row of commentRows) {
    const parsed = parseRecoveryComment(row.content);
    if (!parsed) continue;
    entries.push({
      attempt: 0, // assigned after stable sort below
      kind: 'recovery_note',
      at: row.created_at,
      execution_id: null,
      worker_id: row.author,
      recovery_summary: parsed.summary,
      source_ref: `comment:${String(row.id)}`,
    });
  }

  for (const row of readRejectionRows(db, taskId)) {
    entries.push({
      attempt: 0,
      kind: 'submission_rejection',
      at: row.rejected_at,
      execution_id: row.execution_id,
      worker_id: null,
      recovery_summary: summarizeRejection(row),
      source_ref: `submission-validation-rejection:${row.rejection_ref}`,
    });
  }

  entries.sort((left, right) =>
    left.at === right.at
      ? left.source_ref.localeCompare(right.source_ref)
      : left.at < right.at
        ? -1
        : 1,
  );

  const history = entries
    .slice(0, MAX_ATTEMPT_HISTORY)
    .map((entry, index) => ({ ...entry, attempt: index + 1 }));
  const previousFailures = dedupeStrings(
    history.map(entry => entry.recovery_summary),
  ).slice(0, MAX_PREVIOUS_FAILURES);

  return {
    schema: TASK_RECOVERY_MEMORY_SCHEMA,
    attempt_count: history.length,
    previous_failures: previousFailures,
    attempt_history: history,
  };
}

export interface MaterializedTaskRecoveryMemory {
  readonly changed: boolean;
  readonly snapshot: TaskRecoveryMemorySnapshot;
}

/**
 * Materialize the derived snapshot into tasks.metadata.
 *
 * Writes ONLY the memory keys (`recovery_memory_schema`, `attempt_count`,
 * `previous_failures`, `attempt_history`, and — when absent — the machine
 * `hint` notice). Every other key, including a manual `hint`, is preserved
 * verbatim. Must be called inside the caller's write transaction (claim) or
 * right after a comment insert.
 */
export function materializeTaskRecoveryMemory(
  db: Database,
  taskId: number,
): MaterializedTaskRecoveryMemory {
  const snapshot = buildTaskRecoveryMemory(db, taskId);
  const row = db.prepare('SELECT metadata FROM tasks WHERE id=?').get(taskId) as
    | TaskMetadataRow
    | undefined;
  if (!row) {
    // Fail-closed: no task row → nothing to materialize onto. The durable
    // sources remain untouched; a later claim re-derives everything.
    return { changed: false, snapshot };
  }
  const metadata = parseMetadataObject(row.metadata);

  metadata.recovery_memory_schema = snapshot.schema;
  metadata.attempt_count = snapshot.attempt_count;
  metadata.previous_failures = [...snapshot.previous_failures];
  metadata.attempt_history = snapshot.attempt_history.map(entry => ({
    ...entry,
  }));

  if (
    snapshot.attempt_count > 0
    && (typeof metadata.hint !== 'string' || metadata.hint.trim() === '')
  ) {
    metadata.hint
      = `${MACHINE_HINT_NOTICE_PREFIX} This task was already in work: `
      + `${String(snapshot.attempt_count)} previous attempt(s). Read `
      + 'metadata.previous_failures and metadata.attempt_history before '
      + 'starting; do not repeat failed approaches.';
  }

  const nextJson = JSON.stringify(metadata);
  if (nextJson === row.metadata) {
    return { changed: false, snapshot };
  }
  db.prepare(
    `UPDATE tasks SET metadata=?, updated_at=datetime('now') WHERE id=?`,
  ).run(nextJson, taskId);
  return { changed: true, snapshot };
}

function readRejectionRows(db: Database, taskId: number): RejectionRow[] {
  try {
    return db.prepare(
      `SELECT rejection_ref, execution_id, rejection_code, gaps_json, rejected_at
         FROM factory_submission_validation_rejections
        WHERE task_id=?
        ORDER BY rejected_at ASC, id ASC`,
    ).all(taskId) as RejectionRow[];
  } catch (error) {
    // Older databases may predate the rejection table. Absent history is not
    // an error — the bridge degrades to comments-only rather than breaking
    // the claim path. Fail-closed on real errors, fail-soft on missing table.
    if (error instanceof Error && error.message.includes('no such table')) {
      return [];
    }
    throw error;
  }
}

function summarizeRejection(row: RejectionRow): string {
  const gaps = parseJsonArray(row.gaps_json);
  const firstGap = gaps.length > 0 && isRecord(gaps[0]) ? gaps[0] as GapShape : null;
  const relation = firstGap?.missing && typeof firstGap.missing.relation === 'string'
    ? firstGap.missing.relation
    : null;
  const subject = typeof firstGap?.artifactCode === 'string'
    ? firstGap.artifactCode
    : null;
  const message = firstGap && typeof firstGap.message === 'string'
    ? firstGap.message
    : null;
  const detail = message ?? (relation
    ? `${subject ?? 'artifact'}: ${relation} missing`
    : 'submission preflight rejected');
  const summary = `${row.rejection_code}: ${detail}`;
  return summary.length > MAX_SUMMARY_LENGTH
    ? summary.slice(0, MAX_SUMMARY_LENGTH)
    : summary;
}

function parseJsonArray(raw: string): unknown[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseMetadataObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? { ...parsed } : {};
  } catch {
    // Same normalization precedent as dispatcher.ts json_set guards and
    // submission-validation-rejections.parseMetadata: a corrupt column
    // normalizes to a fresh object instead of poisoning every future write.
    return {};
  }
}

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
