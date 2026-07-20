/**
 * Durable outbox for at-most-once deferred side effects.
 *
 * Source: ADR-013 Phase 1.2 (docs/architecture/decisions/013-lifecycle-fix-execution-plan.md).
 *
 * Why: the audit (2026-07-19) found that generateNextForCompletedTask runs
 * OUTSIDE the worker_done transaction — a crash between COMMIT-receipt and
 * the generate call loses downstream tasks forever, and a retry returns the
 * stored receipt WITHOUT workflow_generation (byte-equivalent replay violated).
 *
 * Fix shape (blueprint §13-style outbox, applied to workflow generation):
 *   1. enqueueOutboxIntent — inside the same BEGIN IMMEDIATE tx that commits
 *      the receipt. INSERT OR IGNORE on intent_key makes it idempotent.
 *   2. drainOutbox — called AFTER COMMIT by the same caller. Picks pending
 *      intents, invokes the side effect, marks done/failed with the result.
 *      Safe to call repeatedly: idempotent side effects (workflow generation
 *      already is — it uses SELECT-then-INSERT OR IGNORE per task).
 *   3. readOutboxResult — on command replay, augment the stored reply with
 *      the persisted result so two identical retries return byte-identical
 *      responses.
 *
 * The module is deliberately side-effect-agnostic: the caller passes the
 * effect function. Today the only effect is generateNextForCompletedTask.
 */

import type { Database } from 'better-sqlite3';

/** All intent kinds that flow through the outbox. */
export type OutboxCommandKind = 'generate_downstream';

export interface OutboxEnqueueInput {
  intentKey: string;
  commandKind: OutboxCommandKind;
  originatingCommandId?: string | null;
  taskId?: number | null;
}

/**
 * Enqueue an intent. INSERT OR IGNORE — calling this twice with the same
 * intent_key is a no-op on the second call (idempotent enqueue). MUST be
 * called inside the caller's BEGIN IMMEDIATE transaction so the intent
 * commits atomically with the side-effect producer's receipt.
 */
export function enqueueOutboxIntent(db: Database, input: OutboxEnqueueInput): void {
  db.prepare(
    `INSERT OR IGNORE INTO outbox_intents
       (intent_key, command_kind, originating_command_id, task_id, state)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(
    input.intentKey,
    input.commandKind,
    input.originatingCommandId ?? null,
    input.taskId ?? null,
  );
}

/**
 * Read the persisted result for an intent. Used on command replay to
 * reconstruct the byte-identical reply. Returns null if the intent has not
 * been processed yet or does not exist.
 */
export function readOutboxResult(db: Database, intentKey: string): {
  state: string;
  result_json: string | null;
  last_error: string | null;
} | null {
  return (db.prepare(
    `SELECT state, result_json, last_error FROM outbox_intents WHERE intent_key=?`,
  ).get(intentKey) as
    | { state: string; result_json: string | null; last_error: string | null }
    | null | undefined) ?? null;
}

/**
 * Drain pending intents of a given kind, invoking the effect for each.
 *
 * The effect MUST be idempotent under re-execution — drain may call it more
 * than once across crashes (the row stays 'pending' until the UPDATE below).
 *
 * Each intent is processed in its own short transaction so a failure on one
 * does not block the others. Returns a summary for logging/diagnostics.
 *
 * Pass `options.intentKey` to drain a single specific intent (used by tests
 * and by post-commit single-task drains). Without it, all pending intents of
 * the given kind up to `limit` are processed.
 *
 * NOTE: this function opens its own transactions (BEGIN IMMEDIATE) per intent.
 * It MUST NOT be called from inside another transaction.
 */
export function drainOutbox(
  db: Database,
  kind: OutboxCommandKind,
  effect: (taskId: number) => unknown,
  options: { limit?: number; intentKey?: string } = {},
): { processed: number; succeeded: number; failed: number; skipped: number } {
  const limit = options.limit ?? 100;
  const pending = options.intentKey
    ? db.prepare(
        `SELECT intent_key, task_id FROM outbox_intents
          WHERE command_kind=? AND state='pending' AND intent_key=?
          ORDER BY created_at ASC
          LIMIT ?`,
      ).all(kind, options.intentKey, limit) as { intent_key: string; task_id: number | null }[]
    : db.prepare(
        `SELECT intent_key, task_id FROM outbox_intents
          WHERE command_kind=? AND state='pending'
          ORDER BY created_at ASC
          LIMIT ?`,
      ).all(kind, limit) as { intent_key: string; task_id: number | null }[];

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of pending) {
    if (row.task_id == null) {
      // Defensive: enqueue should always set task_id for workflow generation.
      db.prepare(
        `UPDATE outbox_intents
            SET state='skipped', last_error='null task_id',
                processed_at=datetime('now'),
                attempt_count=attempt_count+1
          WHERE intent_key=? AND state='pending'`,
      ).run(row.intent_key);
      skipped += 1;
      continue;
    }

    try {
      const result = effect(row.task_id);
      // INSERT OR REPLACE so we overwrite any stale result from a prior
      // crashed attempt (the row was 'pending' so result_json is null).
      db.prepare(
        `UPDATE outbox_intents
            SET state='done',
                result_json=?,
                last_error=NULL,
                processed_at=datetime('now'),
                attempt_count=attempt_count+1
          WHERE intent_key=? AND state='pending'`,
      ).run(JSON.stringify(result ?? null), row.intent_key);
      succeeded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(
        `UPDATE outbox_intents
            SET state='failed',
                last_error=?,
                processed_at=datetime('now'),
                attempt_count=attempt_count+1
          WHERE intent_key=? AND state='pending'`,
      ).run(message, row.intent_key);
      failed += 1;
    }
  }

  return { processed: pending.length, succeeded, failed, skipped };
}

/** Stable intent key for the workflow-generation side effect of a task. */
export function generateDownstreamIntentKey(taskId: number): string {
  return `gen-${taskId}`;
}
