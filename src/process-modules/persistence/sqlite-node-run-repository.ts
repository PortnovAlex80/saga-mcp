/**
 * SQLite implementation of NodeRunRepository.
 *
 * Schema lives in factory_node_runs. One row per node-execution attempt; the
 * attempt counter is derived from existing rows for (process_run_id, node_id)
 * so retries increment naturally. Generic — no module-specific columns.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type {
  FailNodeRunInput,
  NodeRunRecord,
  NodeRunRepository,
  NodeRunStatus,
} from './node-run.js';
import type {
  CompleteNodeRunV2Input,
  NodeRunRecordV2,
  NodeRunRepositoryV2,
  StartNodeRunV2Input,
} from './node-run-v2.js';

export function ensureFactoryNodeRunSchema(db: Database.Database): void {
  // TASK C (legacy purge): the embedded ALTER ladder that backfilled these
  // columns onto pre-existing DBs is gone — old DBs now fail closed at db.ts.
  // The CREATE TABLE carries every column (v2 shape) for fresh databases.
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_node_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL REFERENCES factory_process_runs(id) ON DELETE CASCADE,
      node_id        TEXT NOT NULL,
      node_kind      TEXT NOT NULL,
      attempt        INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running','completed','failed')),
      event          TEXT,
      output_ref     TEXT,
      output_schema  TEXT,
      output_hash    TEXT,
      output_bindings TEXT,
      execution_receipt TEXT,
      acceptance_receipt TEXT,
      recovery_issue TEXT,
      error_message  TEXT,
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at   TEXT,
      input_envelope_hash      TEXT,
      node_ref                 TEXT,
      package_ref              TEXT,
      predecessor_node_run_ids TEXT,
      definition_digest        TEXT,
      transition_cursor        TEXT,
      production_envelope      TEXT,
      completion               TEXT,
      completion_hash          TEXT,
      semantic_digest          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_factory_node_runs_process
      ON factory_node_runs(process_run_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_factory_node_runs_status
      ON factory_node_runs(process_run_id, status, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_factory_node_runs_exact_cursor
      ON factory_node_runs(process_run_id, node_id, attempt);
  `);
}

interface NodeRunRow {
  id: number;
  process_run_id: number;
  node_id: string;
  node_kind: string;
  attempt: number;
  status: NodeRunStatus;
  event: string | null;
  output_ref: string | null;
  output_schema: string | null;
  output_hash: string | null;
  output_bindings: string | null;
  execution_receipt: string | null;
  acceptance_receipt: string | null;
  recovery_issue: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
  // ── Wave 3 v2 columns (nullable; absent on pre-Wave-3 rows) ──────────────
  input_envelope_hash?: string | null;
  node_ref?: string | null;
  package_ref?: string | null;
  predecessor_node_run_ids?: string | null;
  definition_digest?: string | null;
  transition_cursor?: string | null;
  production_envelope?: string | null;
  // FU-A Wave 3: explicit ModuleCompletion JSON column.
  completion?: string | null;
  // WAVE 8 HIGH 4: SHA-256 over canonical JSON of `completion`. Null when the
  // completion column is null. Verified on read — mismatch throws.
  completion_hash?: string | null;
  // Cross-run-stable semantic digest (CONVEYOR v4.3 §5-6). Null when the
  // producer did not author one.
  semantic_digest?: string | null;
}

function rowToRecord(row: NodeRunRow): NodeRunRecord {
  let bindings: Record<string, unknown> | null = null;
  if (row.output_bindings) {
    try {
      const parsed = JSON.parse(row.output_bindings);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        bindings = parsed as Record<string, unknown>;
      }
    } catch {
      // malformed JSON — treat as null (the row is from a pre-Д8 schema).
    }
  }
  let executionReceipt: Record<string, unknown> | null = null;
  if (row.execution_receipt) {
    try {
      const parsed = JSON.parse(row.execution_receipt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        executionReceipt = parsed as Record<string, unknown>;
      }
    } catch {
    }
  }
  let recoveryIssue: NodeRunRecord['recoveryIssue'] = null;
  if (row.recovery_issue) {
    try {
      const parsed = JSON.parse(row.recovery_issue);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        recoveryIssue = parsed as NodeRunRecord['recoveryIssue'];
      }
    } catch {
    }
  }
  let acceptanceReceipt: Record<string, unknown> | null = null;
  if (row.acceptance_receipt) {
    try {
      const parsed = JSON.parse(row.acceptance_receipt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        acceptanceReceipt = parsed as Record<string, unknown>;
      }
    } catch {
    }
  }
  return {
    id: row.id,
    processRunId: row.process_run_id,
    nodeId: row.node_id,
    nodeKind: row.node_kind,
    attempt: row.attempt,
    status: row.status,
    event: row.event,
    outputRef: row.output_ref,
    outputSchema: row.output_schema,
    outputHash: row.output_hash,
    outputBindings: bindings,
    executionReceipt,
    acceptanceReceipt,
    recoveryIssue,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

// ── Wave 3 v2 helpers (W3-A6 §9) ────────────────────────────────────────────
//
// JSON parsers for the v2 columns. Each is defensive: a malformed or missing

function parseJsonObject<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T;
    }
  } catch {
  }
  return null;
}

function parseJsonArray<T>(text: string | null | undefined): T[] | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }
  } catch {
    // Malformed JSON — treat as absent.
  }
  return null;
}

/**
 * Map a raw row (with optional v2 columns) to the v2 record shape. Reuses
 * rows (v2 columns NULL) surface every v2 field as null/empty — they remain
 * valid `NodeRunRecordV2` values, just without the Wave-3 marker.
 *
 * WAVE 8 HIGH 4 — the `completion` column is parsed with INTEGRITY
 * VERIFICATION, not the lenient `parseJsonObject` fallback. The audit
 * (WAVE-8-PRODUCTION-V2-BLOCKERS.txt HIGH 4) flagged that "повреждённый JSON
 * молча превращается в null" — silent null on parse error. After Wave 8:
 *   - malformed `completion` JSON → throws COMPLETION_CORRUPT (loud).
 *   - `completion` parses but the recomputed hash ≠ stored `completion_hash` →
 *     throws COMPLETION_HASH_MISMATCH (loud; signals DB corruption or a
 *     non-canonical writer).
 *   - both `completion` and `completion_hash` NULL → surfaces `completion: null`
 *     contract holds).
 */
function rowToRecordV2(row: NodeRunRow): NodeRunRecordV2 {
  const base = rowToRecord(row);
  return {
    ...base,
    inputEnvelopeHash: row.input_envelope_hash ?? null,
    nodeRef: parseJsonObject<NodeRunRecordV2['nodeRef']>(row.node_ref),
    packageRef: parseJsonObject<NodeRunRecordV2['packageRef']>(row.package_ref),
    predecessorNodeRunIds: parseJsonArray<number>(row.predecessor_node_run_ids),
    definitionDigest: row.definition_digest ?? null,
    transitionCursor: row.transition_cursor ?? null,
    productionEnvelope: parseJsonObject<NodeRunRecordV2['productionEnvelope']>(
      row.production_envelope,
    ),
    completion: parseVerifiedCompletion(row.completion, row.completion_hash),
    completionHash: row.completion_hash ?? null,
    semanticDigest: row.semantic_digest ?? null,
  };
}

/**
 * WAVE 8 HIGH 4 — parse `completion` with integrity verification.
 *
 *   - JSON null/text empty → null.
 *   - JSON malformed → throw `COMPLETION_CORRUPT` (NOT silent null).
 *   - JSON valid but canonical-hash ≠ stored hash → throw
 *     `COMPLETION_HASH_MISMATCH` (NOT silent null). Signals a corrupted row or
 *     a writer that did not use canonicalJson.
 *
 * The hash column is consulted only when the JSON column is non-null. This
 * preserves the additive contract for pre-Wave-8 rows that have completion but
 * no completion_hash: their hash is null, so we cannot verify, but we also do
 * not silently null — we surface the parsed value (the row predates the
 * integrity column and is trusted by the migration contract). New rows always
 * carry both columns together (completeV2 writes them atomically).
 */
function parseVerifiedCompletion(
  completionText: string | null | undefined,
  completionHash: string | null | undefined,
): NodeRunRecordV2['completion'] {
  if (!completionText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(completionText);
  } catch (err) {
    throw new Error(
      `COMPLETION_CORRUPT: factory_node_runs.completion is malformed JSON `
        + `(${(err as Error).message}); refusing to silently degrade to null`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Valid JSON but wrong shape — treat as corrupt (the writer invariant is
    // `JSON.stringify(ModuleCompletion)`, always a plain object).
    throw new Error(
      'COMPLETION_CORRUPT: factory_node_runs.completion parsed to a non-object; '
        + 'refusing to silently degrade to null',
    );
  }
  // Pre-Wave-8 rows carry completion but no completion_hash — trust them (the
  // migration contract: rows written before HIGH 4 are presumed intact, the
  // hash column only starts verifying rows written after).
  if (completionHash === null || completionHash === undefined) {
    return parsed as NodeRunRecordV2['completion'];
  }
  const computed = sha256Hex(parsed);
  if (computed !== completionHash) {
    throw new Error(
      `COMPLETION_HASH_MISMATCH: factory_node_runs.completion hash differs from `
        + `completion_hash (expected ${completionHash}, computed ${computed}); `
        + 'refusing to silently degrade to null',
    );
  }
  return parsed as NodeRunRecordV2['completion'];
}

export class SqliteNodeRunRepository implements NodeRunRepository, NodeRunRepositoryV2 {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureFactoryNodeRunSchema(this.db);
  }

  fail(input: FailNodeRunInput): NodeRunRecord {
    this.db.prepare(
      `UPDATE factory_node_runs
          SET status='failed', error_message=?, completed_at=datetime('now')
        WHERE id=?`,
    ).run(input.errorMessage, input.id);
    const row = this.db.prepare(
      'SELECT * FROM factory_node_runs WHERE id=?',
    ).get(input.id) as NodeRunRow;
    return rowToRecord(row);
  }

  // K8 (ADR-079): readLatest — the newest-wins (process_run, node) fetch —
  // was DELETED with its interface declarations. The assembler now probes
  // readByExactCursor (run, node, attempt); identity resolution never
  // chooses by row order.

  // ── Wave 3 v2 methods (W3-A6 §9 — single SQL owner) ──────────────────────

  startV2(input: StartNodeRunV2Input): NodeRunRecordV2 {
    // A pause is the SAME attempt continuing, not a new one.
    //
    // A Production Cell node yields `runtime.paused` on every engine cycle for
    // as long as its workers are in flight, and the flow re-enters it next
    // cycle. Minting a fresh row each time made the attempt counter measure
    // engine cycles instead of executions: observed live, ONE
    // implement-work-items node accumulated 9004 rows, all runtime.paused. That
    // is unbounded growth, it makes every per-cycle scan of this table (frame
    // rehydration, resume cursor) O(cycles), and it buries the real attempts in
    // diagnostics.
    //
    // Re-entering a node whose latest row is a completed pause therefore
    // REUSES that row: status returns to 'running' and the attempt number is
    // preserved, so resume cursors, the unique (run,node,attempt) index and the
    // v2 envelope identity all stay stable. A row is still minted for every
    // genuine execution attempt — only idle re-entries coalesce.
    const resumable = this.db.prepare(
      `SELECT id FROM factory_node_runs
        WHERE process_run_id=? AND node_id=?
          AND status='completed' AND event='runtime.paused'
        ORDER BY attempt DESC
        LIMIT 1`,
    ).get(input.processRunId, input.nodeId) as { id: number } | undefined;
    const latest = this.db.prepare(
      `SELECT id FROM factory_node_runs
        WHERE process_run_id=? AND node_id=?
        ORDER BY attempt DESC
        LIMIT 1`,
    ).get(input.processRunId, input.nodeId) as { id: number } | undefined;
    if (resumable && latest && resumable.id === latest.id) {
      this.db.prepare(
        `UPDATE factory_node_runs
            SET status='running', event=NULL, completed_at=NULL,
                predecessor_node_run_ids=COALESCE(?,predecessor_node_run_ids)
          WHERE id=?`,
      ).run(
        input.predecessorNodeRunIds ? JSON.stringify(input.predecessorNodeRunIds) : null,
        resumable.id,
      );
      const reused = this.db.prepare(
        'SELECT * FROM factory_node_runs WHERE id=?',
      ).get(resumable.id) as NodeRunRow;
      return rowToRecordV2(reused);
    }
    const count = this.db.prepare(
      'SELECT COUNT(*) AS n FROM factory_node_runs WHERE process_run_id=? AND node_id=?',
    ).get(input.processRunId, input.nodeId) as { n: number };
    const attempt = count.n + 1;
    const nodeRefText = input.nodeRef ? JSON.stringify(input.nodeRef) : null;
    const packageRefText = input.packageRef ? JSON.stringify(input.packageRef) : null;
    const predecessorText = input.predecessorNodeRunIds
      ? JSON.stringify(input.predecessorNodeRunIds)
      : null;
    const info = this.db.prepare(
      `INSERT INTO factory_node_runs (
         process_run_id, node_id, node_kind, attempt, status,
         input_envelope_hash, node_ref, package_ref,
         predecessor_node_run_ids, definition_digest, transition_cursor
       ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.processRunId,
      input.nodeId,
      input.nodeKind,
      attempt,
      input.inputEnvelopeHash ?? null,
      nodeRefText,
      packageRefText,
      predecessorText,
      input.definitionDigest ?? null,
      input.transitionCursor ?? null,
    );
    const row = this.db.prepare(
      'SELECT * FROM factory_node_runs WHERE id=?',
    ).get(Number(info.lastInsertRowid)) as NodeRunRow;
    return rowToRecordV2(row);
  }

  completeV2(input: CompleteNodeRunV2Input): NodeRunRecordV2 {
    const bindingsText = input.outputBindings ? JSON.stringify(input.outputBindings) : null;
    const receiptText = input.executionReceipt ? JSON.stringify(input.executionReceipt) : null;
    const acceptanceReceiptText = input.acceptanceReceipt
      ? JSON.stringify(input.acceptanceReceipt)
      : null;
    const recoveryIssueText = input.recoveryIssue ? JSON.stringify(input.recoveryIssue) : null;
    const envelopeText = input.productionEnvelope
      ? JSON.stringify(input.productionEnvelope)
      : null;
    // WAVE 8 HIGH 4 — persist the completion JSON AND its canonical hash. The
    // hash is computed via canonicalJson (NOT JSON.stringify) so reads can
    // recompute byte-identically regardless of property order. Both columns
    // are written atomically in the same UPDATE. Null when the caller passes
    const completionText = input.completion ? canonicalJson(input.completion) : null;
    const completionHash = input.completion ? sha256Hex(input.completion) : null;
    // Cross-run-stable semantic digest (CONVEYOR v4.3 §5-6): derived from the
    // production envelope when the producer authored one. Persisted so crash-
    // resume restores it on chainInput and downstream WorkKey/ReplayKey stay
    // stable across runs.
    const semanticDigest = input.productionEnvelope?.semanticDigest ?? null;
    // pre-Wave-3 readers working; the v2 columns let Wave-3 readers resume by
    // exact cursor (§9.11). `completion` (FU-A Wave 3) carries the explicit
    // terminal envelope so crash-resume rebuilds NodeExecutionResult.completion
    // without falling back to magic bindings. `completion_hash` (Wave 8 HIGH 4)
    // lets reads VERIFY integrity (COMPLETION_CORRUPT / COMPLETION_HASH_MISMATCH
    // throw instead of silent null).
    this.db.prepare(
      `UPDATE factory_node_runs
          SET status='completed', event=?, output_ref=?, output_schema=?, output_hash=?, output_bindings=?,
              execution_receipt=?, acceptance_receipt=?, recovery_issue=?,
              production_envelope=?, transition_cursor=?, completion=?, completion_hash=?,
              semantic_digest=?,
              completed_at=datetime('now')
        WHERE id=?`,
    ).run(
      input.event,
      input.outputRef,
      input.outputSchema ?? null,
      input.outputHash,
      bindingsText,
      receiptText,
      acceptanceReceiptText,
      recoveryIssueText,
      envelopeText,
      input.transitionCursor ?? null,
      completionText,
      completionHash,
      semanticDigest,
      input.id,
    );
    const row = this.db.prepare(
      'SELECT * FROM factory_node_runs WHERE id=?',
    ).get(input.id) as NodeRunRow;
    return rowToRecordV2(row);
  }

  readByExactCursor(
    processRunId: number,
    nodeId: string,
    attempt: number,
  ): NodeRunRecordV2 | null {
    // §9.11 resume primitive: exact (run, node, attempt) lookup. Backed by
    // idx_factory_node_runs_exact_cursor UNIQUE index — an equality probe.
    const row = this.db.prepare(
      `SELECT * FROM factory_node_runs
        WHERE process_run_id=? AND node_id=? AND attempt=?
        LIMIT 1`,
    ).get(processRunId, nodeId, attempt) as NodeRunRow | undefined;
    return row ? rowToRecordV2(row) : null;
  }

  readLastCompletedV2(processRunId: number): NodeRunRecordV2 | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_node_runs
        WHERE process_run_id=? AND status='completed'
          AND (event IS NULL OR event<>'runtime.paused')
        ORDER BY id DESC LIMIT 1`,
    ).get(processRunId) as NodeRunRow | undefined;
    return row ? rowToRecordV2(row) : null;
  }

  listV2(processRunId: number): readonly NodeRunRecordV2[] {
    const rows = this.db.prepare(
      'SELECT * FROM factory_node_runs WHERE process_run_id=? ORDER BY id ASC',
    ).all(processRunId) as NodeRunRow[];
    return rows.map(rowToRecordV2);
  }
}
