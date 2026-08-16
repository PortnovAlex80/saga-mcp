import type Database from 'better-sqlite3';

/**
 * Fix-1 (worker feedback loop map): «парк всегда с причиной».
 *
 * A `blocked/paused` workplace historically exposed only the verdict — the
 * operator (and the tracker) had to decode base64 check diagnostics by hand to
 * learn WHY the line stopped (observed: P01/counter budget park, P02/stopwatch
 * effect park). Every park site now records one append-only row here and the
 * workplace's `active_recovery_case_ref` points at it
 * (`workplace-park-reason:<id>`).
 *
 * The table is written inside the SAME transaction as the pausing transition,
 * so a parked workplace can never exist without its reason row (fail-closed
 * invariant for tests).
 */

export interface WorkplaceParkReason {
  /** CAPS reason code, e.g. RECOVERY_BUDGET_EXHAUSTED. */
  readonly code: string;
  /** Human-readable cause (operator-facing). Truncated to MESSAGE_LIMIT. */
  readonly message: string;
  /** Optional evidence pointers (decision keys, receipt refs, action ids). */
  readonly evidenceRefs?: readonly string[];
}

const MESSAGE_LIMIT = 1000;
const EVIDENCE_LIMIT = 20;

/**
 * Append one park reason and return its stable ref
 * (`workplace-park-reason:<rowid>`). Callers MUST run this inside the
 * transaction that performs the pausing workplace transition.
 */
export function recordWorkplaceParkReason(
  db: Database.Database,
  workplaceRef: string,
  reason: WorkplaceParkReason,
): string {
  const code = reason.code.trim();
  const message = reason.message.trim();
  if (code.length === 0 || message.length === 0) {
    throw new Error('WORKPLACE_PARK_REASON_INVALID: code and message are required');
  }
  const evidenceRefs = (reason.evidenceRefs ?? [])
    .filter(ref => typeof ref === 'string' && ref.trim().length > 0)
    .slice(0, EVIDENCE_LIMIT);
  const info = db.prepare(
    `INSERT INTO factory_workplace_park_reasons
       (workplace_ref,reason_code,message,evidence_refs)
     VALUES (?,?,?,?)`,
  ).run(
    workplaceRef,
    code,
    message.slice(0, MESSAGE_LIMIT),
    JSON.stringify(evidenceRefs),
  );
  return `workplace-park-reason:${Number(info.lastInsertRowid)}`;
}
