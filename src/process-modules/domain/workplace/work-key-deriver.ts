/**
 * WorkKey derivation for fan-out Production Cells (REG-04-AC-03).
 *
 * A fan-out cell materializes one Workplace per stable item in an accepted
 * upstream binding. The workKey MUST be deterministic and depend ONLY on the
 * immutable source identity + the stable item id — NEVER on array position,
 * worker identity, attempt number or package digest (REG-05-AC-01).
 *
 * # Why a dedicated module
 *
 * The derivation rule is load-bearing: a reorder of the accepted item list
 * must not change any workKey, and a retry/resume must not mint a new
 * workKey for the same item. Keeping the logic PURE and in one place means it
 * is covered by property tests without touching SQLite or the coordinator.
 *
 * # Pure domain
 *
 * Imports only `node:crypto`. No SQLite, MCP, db.ts, or application code.
 */

import { createHash } from 'node:crypto';

/**
 * Derive a stable workKey from the accepted source binding's content hash and
 * a stable item identifier.
 *
 * The source content hash scopes the key to one accepted version of the
 * upstream binding — if the binding changes (a new task graph is accepted),
 * a different workKey space is used, so stale workplaces from a superseded
 * binding are never confused with the new one. The item id discriminates
 * instances within that binding.
 *
 * The result is a short, URL-safe, deterministic string. Two calls with the
 * same inputs return byte-identical output (REG-04-AC-03 idempotency).
 */
export function deriveWorkKey(
  sourceContentHash: string,
  itemId: string,
): string {
  if (typeof sourceContentHash !== 'string' || sourceContentHash.length === 0) {
    throw new Error(
      'deriveWorkKey: sourceContentHash must be a non-empty string',
    );
  }
  if (typeof itemId !== 'string' || itemId.trim().length === 0) {
    throw new Error(
      'deriveWorkKey: itemId must be a non-empty string',
    );
  }
  return createHash('sha256')
    .update(sourceContentHash)
    .update('\u0000')
    .update(itemId)
    .digest('hex')
    .slice(0, 24);
}
