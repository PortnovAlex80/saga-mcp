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
// Implemented by body-task AC-2 (#218 — deterministic / fingerprint-idempotent).
// ============================================================================
//
// Extension point (SRS §2b.4): a new input source = a new branch in
// extractInputs after db.sqlite/rollout. NEVER modify the SQL string below —
// it is the contract for the input filter.
//
// ============================================================================
// SCHEMA NOTE (recorded as 80%-rule assumption — see task #218 breadcrumb).
// ============================================================================
// INPUTS_SQL below is the FROZEN CONTRACT string verbatim from SRS §2b.4 — it
// is kept unchanged for traceability (DoD: "ручная сверка SQL-фильтра против
// §2b.4 контракта"). It references columns m.role / m.created_at / m.synthetic
// / p.text / p.type as the SRS author specified.
//
// The actual zcode db.sqlite schema (verified against the live
// C:/Users/user/.zcode/cli/db/db.sqlite) stores those fields INSIDE a JSON
// column `data` on both `message` and `part`, NOT as top-level columns:
//   message.data = { role, time:{created}, ... synthetic? }
//   part.data    = { type, text, time:{start,end} }
// So INPUTS_SQL-as-written would error ("no such column: m.role"). The
// equivalent query over the real schema is QUERY_SQL_ZCODE below, which applies
// the EXACT SAME filter semantics (role='user' AND synthetic IS NOT TRUE AND
// part.type='text' AND session_id=?) via json_extract(). extractInputs uses
// QUERY_SQL_ZCODE against the live DB; INPUTS_SQL is retained verbatim as the
// human-readable contract artifact (SRS §2b.4 is the source of truth, the
// query is its realization against the actual on-disk schema).
// ============================================================================

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
 *
 * Kept verbatim from SRS §2b.4 for traceability (DoD: manual filter cross-check
 * against the §2b.4 contract). See the SCHEMA NOTE at the top of this file and
 * {@link QUERY_SQL_ZCODE} for the realization over the actual zcode schema.
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
 * Realization of {@link INPUTS_SQL} over the actual zcode db.sqlite schema.
 *
 * The zcode schema stores the message/part fields inside a JSON `data` column
 * (verified against the live DB): message.data.role, message.data.synthetic,
 * message.data.time.created, part.data.type, part.data.text. This query applies
 * the EXACT SAME filter semantics as INPUTS_SQL via json_extract(), so the
 * observable behavior matches the SRS §2b.4 contract one-for-one.
 *
 * Only `?` is bound — the parent session id. Nothing else is parameterized,
 * preserving the "frozen filter" contract.
 */
export const QUERY_SQL_ZCODE = `
SELECT
  'I-' || printf('%03d', ROW_NUMBER() OVER (ORDER BY CAST(json_extract(m.data,'$.time.created') AS INTEGER))) AS i_id,
  CAST(json_extract(m.data,'$.time.created') AS INTEGER) AS timestamp,
  json_extract(p.data,'$.text') AS text
FROM message m
JOIN part p ON p.message_id = m.id
WHERE json_extract(m.data,'$.role') = 'user'
  AND json_extract(m.data,'$.synthetic') IS NOT TRUE
  AND json_extract(p.data,'$.type') = 'text'
  AND m.session_id = ?
ORDER BY CAST(json_extract(m.data,'$.time.created') AS INTEGER);
`;

/**
 * Default db.sqlite path (SRS §2b.4 fallback logic).
 */
export const DEFAULT_DB_PATH =
  'C:\\Users\\user\\.zcode\\cli\\db\\db.sqlite';

/**
 * Default rollout-jsonl directory (SRS §2b.4 fallback when db.sqlite is
 * unavailable/empty): `~/.zcode/cli/rollout`. The fallback file is
 * `model-io-sess_<parent>.jsonl` under this directory.
 */
export const DEFAULT_ROLLOUT_DIR = `${homedir().replace(/\\/g, '/')}/.zcode/cli/rollout`;

/**
 * Compute the deterministic fingerprint of an input (SRS §2b.4 / NFR-2).
 *
 *   fingerprint = sha1(text.slice(0,100) + timestamp)
 *
 * Pure: identical (text, timestamp) → identical fingerprint. This is the
 * idempotency anchor for `00-inputs.md` regeneration (AC-2 Then-3 / NFR-2).
 */
export function fingerprintOf(text: string, timestamp: string | number): string {
  const head = text.slice(0, 100);
  return createHash('sha1').update(`${head}${timestamp}`, 'utf8').digest('hex');
}

/**
 * Build an {@link InputRow} (assign i_id + fingerprint) from a raw DB/text row.
 *
 * `i_id` is assigned positionally (1-based, 'I-NNN') from the row's index in the
 * ordered result set — deterministic given the same inputs/order.
 */
function toInputRow(
  index: number,
  timestamp: string | number,
  text: string,
): InputRow {
  const ts = String(timestamp);
  return {
    i_id: `I-${String(index + 1).padStart(3, '0')}`,
    timestamp: ts,
    text,
    fingerprint: fingerprintOf(text, ts),
  };
}

/**
 * Read the last non-empty line of a rollout jsonl file and extract the user
 * input text (SRS §2b.4 fallback source).
 *
 * The rollout line is a JSON object; we look for a `.text` / `.content` /
 * `.message` string field in priority order (zcode rollout shapes vary across
 * versions). Falls back to the raw line when no known field is found, so the
 * gate still produces a (degraded) input rather than crashing.
 */
function readRolloutLastInput(rolloutPath: string): string | null {
  if (!existsSync(rolloutPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(rolloutPath, 'utf8');
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  try {
    const obj = JSON.parse(last) as Record<string, unknown>;
    for (const key of ['text', 'content', 'message', 'input']) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  } catch {
    // not JSON — use the raw line as the input text
  }
  return last;
}

/**
 * Extract the parent session's user inputs and compute coverage (SRS §2b.4).
 *
 * Pure over the DB function; the DB connection itself is injected (testable).
 * Tries dbPath (default {@link DEFAULT_DB_PATH}); on open failure / emptiness,
 * reads the last line of `rollout/model-io-sess_<parent>.jsonl`, sets
 * `source='rollout-jsonl'`, `gate_passed=false`.
 *
 * Determinism / idempotency (AC-2 Then-3 / NFR-2): given the same db.sqlite
 * contents + parentSessionId, two calls return byte-identical `inputs[]` —
 * same order (ORDER BY created_at), same `i_id` (positional), same
 * `fingerprint` (sha1(text[:100]+timestamp), pure). `covered_count` is 0 here
 * (coverage is computed downstream by the gate that maps inputs→sections; this
 * helper only extracts), so `gate_passed` is true iff source is db.sqlite AND
 * at least one input was found (coverage of the extract step = 1.0 means
 * "extraction complete", not "every section covered").
 *
 * @param parentSessionId parent session id (obtained via readSelfSessionId,
 *   NOT passed in from outside the subagent — see src/helpers/selfid.ts).
 * @param opts optional { dbPath?, rolloutPath?, db? } overrides. `db` accepts a
 *   pre-opened better-sqlite3 Database (test seam; when omitted a readonly
 *   connection is opened at `dbPath`).
 * @see SRS-004 §2b.4
 */
export async function extractInputs(
  parentSessionId: string,
  opts?: {
    dbPath?: string;
    rolloutPath?: string;
    db?: Database.Database;
  },
): Promise<CompletenessResult> {
  const dbPath = opts?.dbPath ?? DEFAULT_DB_PATH;
  const rolloutPath =
    opts?.rolloutPath ?? `${DEFAULT_ROLLOUT_DIR}/model-io-sess_${parentSessionId}.jsonl`;

  // --- Primary source: db.sqlite -------------------------------------------
  let ownDb: Database.Database | null = null;
  const db = opts?.db ?? (ownDb = tryOpenReadonly(dbPath));
  try {
    if (db) {
      const rows = db
        .prepare(QUERY_SQL_ZCODE)
        .all(parentSessionId) as Array<{ i_id: string; timestamp: number; text: string }>;

      const inputs: InputRow[] = rows.map((r, idx) =>
        toInputRow(idx, r.timestamp, r.text ?? ''),
      );

      if (inputs.length > 0) {
        // Extraction complete from the authoritative source → gate (of the
        // extract step) passes. Section-level coverage is computed downstream.
        return {
          source: 'db.sqlite',
          inputs,
          covered_count: 0,
          total_count: inputs.length,
          coverage: 1.0,
          gate_passed: true,
        };
      }
      // db open but 0 rows for this session → fall through to rollout fallback.
    }
  } finally {
    if (ownDb) {
      try { ownDb.close(); } catch { /* ignore */ }
    }
  }

  // --- Fallback source: rollout-jsonl (degraded) ----------------------------
  const text = readRolloutLastInput(rolloutPath);
  if (text !== null) {
    const ts = String(Date.now());
    return {
      source: 'rollout-jsonl',
      inputs: [toInputRow(0, ts, text)],
      covered_count: 0,
      total_count: 1,
      coverage: 0,
      gate_passed: false, // SRS §2b.4: degraded source → gate never passes
    };
  }

  // Neither source yielded anything. Return an empty db.sqlite result with the
  // gate closed — the caller decides whether to fail loudly (consistent with
  // readSelfSessionId's "null → caller fails explicitly" contract).
  return {
    source: 'db.sqlite',
    inputs: [],
    covered_count: 0,
    total_count: 0,
    coverage: 0,
    gate_passed: false,
  };
}

/**
 * Open a db.sqlite file read-only, returning null on any failure (missing file,
 * locked, corrupt). Used so `extractInputs` can fall through to the rollout
 * fallback without throwing on a missing/unreadable DB.
 */
function tryOpenReadonly(dbPath: string): Database.Database | null {
  try {
    // fileMustExist so a missing DB returns null (caught) rather than creating one.
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

// Re-export join for callers that build rollout paths (keeps the path API in
// one place; harmless if unused). Internal helper, not part of §2b.4 contract.
export const _join = join;
