/**
 * Idempotency helper for lifecycle commands.
 *
 * Source: blueprint §7.1 (docs/architecture/passive-worker-kernel-blueprint.md:355-370),
 *         §10 (line 460-492), §16 Slice 4 acceptance (line 894-898).
 *
 * Why: a lost MCP response can drive a worker (or its supervisor) to retry
 * worker_done. The retry must:
 *   - return the SAME reply (so the worker treats it as success and exits);
 *   - NOT duplicate the result comment, activity_log entry, downstream
 *     workflow generation, or any other side effect.
 *
 * Strategy (blueprint §10): each command has a stable command_id. Before
 * running the command body, look up any existing receipt:
 *   - if found with the SAME payload_hash → return the stored reply;
 *   - if found with a DIFFERENT payload_hash → reject as
 *     IDEMPOTENCY_KEY_REUSED (blueprint §7.1:367-370);
 *   - if not found → run the body and store a receipt on success.
 *
 * For Slice 4 we apply this to worker_done only. The command_id is derived
 * from execution_id + outcome per blueprint §7.1:361-366, e.g.
 *   `<execution-id>:worker-done:<verdict>`
 *
 * The command_receipts table was created in Slice 1.
 */

import type { Database } from 'better-sqlite3';
import { hashPayload } from './payload-hash.js';

export interface ExistingReceipt {
  readonly accepted: 0 | 1;
  readonly payload_hash: string;
  readonly reply_json: string;
  readonly rejection_code: string | null;
}

export interface ReceiptCheckOk {
  readonly kind: 'first_time';
}

export interface ReceiptCheckReplay {
  readonly kind: 'replay';
  readonly receipt: ExistingReceipt;
}

export interface ReceiptCheckConflict {
  readonly kind: 'idempotency_key_reused';
  readonly receipt: ExistingReceipt;
}

export type ReceiptCheck = ReceiptCheckOk | ReceiptCheckReplay | ReceiptCheckConflict;

/**
 * Look up an existing receipt for a command_id. Returns:
 *   - first_time              → no prior receipt; caller should run and store.
 *   - replay                  → prior receipt with SAME hash; caller should
 *                               return receipt.reply_json verbatim.
 *   - idempotency_key_reused  → prior receipt with DIFFERENT hash; caller
 *                               should reject.
 */
export function checkReceipt(
  db: Database,
  commandId: string,
  payloadHash: string,
): ReceiptCheck {
  const row = db
    .prepare(
      `SELECT accepted, payload_hash, reply_json, rejection_code
         FROM command_receipts WHERE command_id = ?`,
    )
    .get(commandId) as ExistingReceipt | undefined;

  if (!row) return { kind: 'first_time' };
  if (row.payload_hash !== payloadHash) {
    return { kind: 'idempotency_key_reused', receipt: row };
  }
  return { kind: 'replay', receipt: row };
}

/**
 * Store a successful command's receipt. Called AFTER the body has run
 * successfully (so we never store a receipt for a command that failed mid-way).
 *
 * The caller must call this inside the same BEGIN IMMEDIATE transaction as
 * the command body — that way the receipt is atomic with the side effects.
 */
export function storeReceipt(
  db: Database,
  input: {
    commandId: string;
    commandKind: string;
    actorKind: 'controller' | 'managed_execution' | 'integration_executor' | 'human' | 'admin';
    actorId?: string | null;
    executionId?: string | null;
    taskId?: number | null;
    payload: unknown;
    reply: unknown;
  },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO command_receipts
       (command_id, command_kind, actor_kind, actor_id, execution_id, task_id,
        payload_hash, accepted, rejection_code, result_json, reply_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
  ).run(
    input.commandId,
    input.commandKind,
    input.actorKind,
    input.actorId ?? null,
    input.executionId ?? null,
    input.taskId ?? null,
    hashPayload(input.payload),
    JSON.stringify(input.reply),
    JSON.stringify(input.reply),
  );
}

/**
 * Compute the stable command_id for a worker_done call per blueprint §7.1.
 *
 * For fenced tasks: `<execution-id>:worker-done:<verdict>`. Two retries of
 * the same worker_done (same execution + same verdict) produce the same id;
 * a different verdict on the same execution produces a different id (and
 * would be IDEMPOTENCY_KEY_REUSED if the first succeeded with a different
 * payload).
 *
 * For unfenced (pre-ADR-009 legacy or test) tasks: we have no execution_id.
 * The receipt must still be unique per (task, worker, verdict, attempt) —
 * otherwise two legitimate worker_done calls on the same task with different
 * results would collide. We include task_id + worker_id + a short hash of
 * the result text so retries of the SAME call match but different calls do
 * not. (Per blueprint §7.1, controller/admin commands use generated UUIDs;
 * here we synthesize a deterministic one for legacy compatibility.)
 */
export function workerDoneCommandId(
  executionId: string | null | undefined,
  verdict: string,
  taskId?: number,
  workerId?: string,
  result?: string,
): string {
  if (executionId) {
    return `${executionId}:worker-done:${verdict}`;
  }
  // Legacy unfenced path: include payload identity so two different calls
  // don't collide. A retry with the same payload still matches.
  const legacy = `legacy:${taskId ?? '?'}:${workerId ?? '?'}}:${verdict}:${shortHash(result ?? '')}`;
  return legacy;
}

/**
 * Short stable hash for legacy command_id derivation. Not security-sensitive;
 * only needs to be deterministic and collision-resistant over realistic
 * result-text inputs.
 */
function shortHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Build the canonical payload object for a worker_done call, for hashing.
 * Excludes volatile fields (timestamps, the randomly-generated commandId).
 * Includes only the semantic identity of the command.
 */
export function workerDonePayload(taskId: number, workerId: string, result: string, verdict: string): {
  task_id: number;
  worker_id: string;
  result: string;
  verdict: string;
} {
  return { task_id: taskId, worker_id: workerId, result, verdict };
}

export { hashPayload };
