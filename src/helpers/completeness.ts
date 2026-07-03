// src/helpers/completeness.ts
//
// SRS-004 §2b.4 — completeness-check gate-helper.
//
// Extracts the parent session's user inputs (the raw material that a brief must
// cover) and computes coverage against the brief's sections. Used as a
// quality-gate before formalization: gate passes only when every input is
// covered AND the source is the authoritative db.sqlite (not the degraded
// rollout-jsonl fallback).
//
// ============================================================================
// SCAFFOLD ONLY (Pattern B, task #215).
// ============================================================================
// This file fixes the API CONTRACT (types + function signature + the frozen
// SQL string) BEFORE the body-task lands. The function body is a stub that
// throws NotImplementedError. The full implementation (db.sqlite query + jsonl
// fallback + fingerprint) is body-task AC-2 (#218 — extractInputs +
// readSelfSessionId, deterministic/fingerprint-idempotent).
//
// Extension point (SRS §2b.4): a new input source = a new branch in
// extractInputs after db.sqlite/rollout. NEVER modify the SQL string below —
// it is the contract for the input filter.
// ============================================================================

/**
 * One parent-session user input, as read from db.sqlite (SRS §2b.4).
 */
export interface InputRow {
  i_id: string; // 'I-NNN'
  timestamp: string;
  text: string;
  fingerprint: string; // sha1(text.slice(0,100) + timestamp)
}

/**
 * Result of extractInputs — the inputs + coverage summary (SRS §2b.4).
 */
export interface CompletenessResult {
  source: 'db.sqlite' | 'rollout-jsonl';
  inputs: InputRow[];
  covered_count: number; // inputs with Covers=<section id>
  total_count: number;
  coverage: number; // covered_count / total_count, 0..1
  gate_passed: boolean; // coverage === 1.0 AND source==='db.sqlite'
}

/**
 * Frozen SQL that selects parent-session user inputs from db.sqlite (SRS §2b.4).
 *
 * CONTRACT — do NOT modify. This is the fixed input filter; it is not
 * parameterized by the worker (only the session_id bind parameter changes).
 * New input sources go in a new branch of extractInputs, not in this SQL.
 */
export const INPUTS_SQL = `
SELECT
  'I-' || printf('%03d', ROW_NUMBER() OVER (ORDER BY m.created_at)) AS i_id,
  m.created_at AS timestamp,
  p.text AS text
FROM message m
JOIN part p ON p.message_id = m.id
WHERE m.role = 'user'
  AND m.synthetic IS NOT TRUE
  AND p.type = 'text'
  AND m.session_id = ?
ORDER BY m.created_at;
`;

/**
 * Default db.sqlite path (SRS §2b.4 fallback logic).
 */
export const DEFAULT_DB_PATH =
  'C:\\Users\\user\\.zcode\\cli\\db\\db.sqlite';

/**
 * Extract the parent session's user inputs and compute coverage (SRS §2b.4).
 *
 * Pure over the DB function; the DB connection itself is injected (testable).
 * Tries dbPath (default DEFAULT_DB_PATH); on open failure / emptiness, reads
 * the last line of rollout/model-io-sess_<parent>.jsonl, sets
 * source='rollout-jsonl', gate_passed=false.
 *
 * SCAFFOLD stub — throws NotImplementedError. Body-task AC-2 (#218) implements
 * the db.sqlite query (INPUTS_SQL), fingerprint computation, and jsonl fallback.
 *
 * @param _parentSessionId parent session id (obtained via readSelfSessionId,
 *   NOT passed in from outside the subagent — see src/helpers/selfid.ts).
 * @param _opts optional { dbPath?, rolloutPath? } overrides.
 * @see SRS-004 §2b.4
 * @see body-task AC-2 (#218) — implements the body
 */
export async function extractInputs(
  _parentSessionId: string,
  _opts?: { dbPath?: string; rolloutPath?: string },
): Promise<CompletenessResult> {
  // SCAFFOLD stub — body-task AC-2 (#218) implements the real logic.
  throw new Error('NotImplemented: extractInputs — see body-task AC-2 (#218), SRS §2b.4');
}
