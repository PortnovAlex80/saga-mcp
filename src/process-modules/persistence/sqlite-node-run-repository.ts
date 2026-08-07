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
  CompleteNodeRunInput,
  FailNodeRunInput,
  NodeRunRecord,
  NodeRunRepository,
  NodeRunStatus,
  StartNodeRunInput,
} from './node-run.js';
import type {
  CompleteNodeRunV2Input,
  NodeRunRecordV2,
  NodeRunRepositoryV2,
  StartNodeRunV2Input,
} from './node-run-v2.js';

export function ensureFactoryNodeRunSchema(db: Database.Database): void {
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
      completed_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_factory_node_runs_process
      ON factory_node_runs(process_run_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_factory_node_runs_status
      ON factory_node_runs(process_run_id, status, id);
  `);
  // Д8 migration: older DBs created factory_node_runs without output_bindings.
  // SQLite ALTER TABLE ADD COLUMN is safe (no CHECK to rebuild).
  const cols = db.prepare("PRAGMA table_info(factory_node_runs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'output_bindings')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN output_bindings TEXT');
  }
  if (!cols.some((c) => c.name === 'execution_receipt')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN execution_receipt TEXT');
  }
  if (!cols.some((c) => c.name === 'output_schema')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN output_schema TEXT');
  }
  if (!cols.some((c) => c.name === 'recovery_issue')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN recovery_issue TEXT');
  }
  if (!cols.some((c) => c.name === 'acceptance_receipt')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN acceptance_receipt TEXT');
  }

  // ── Wave 3 (W3-A6 §9, single SQL owner for factory_node_runs this wave) ──────
  // Seven ADDITIVE NULLABLE columns. Idempotent — guarded by PRAGMA
  // table_info check, mirroring the Wave 2 dual-placement pattern. NO NOT NULL
  // in src/db.ts (the upgrade path for pre-existing DBs) AND here (the path
  // that reliably runs when the table springs into existence via the
  // constructor). The columns are:
  //   input_envelope_hash       TEXT  — ExecutionContextEnvelope hash (Wave 1 §7.7)
  //   node_ref                  TEXT  — JSON NodeRef (Wave 1 §7.7.1)
  //   package_ref               TEXT  — JSON PackageRef (Wave 1 §7.7.1)
  //   predecessor_node_run_ids  TEXT  — JSON array of upstream NodeRun ids
  //   definition_digest         TEXT  — NodeProtocolDefinition digest (W1-A4)
  //   transition_cursor         TEXT  — opaque kernel transition cursor
  //   production_envelope       TEXT  — JSON NodeProductionEnvelope (Wave 1 §7.6)
  if (!cols.some((c) => c.name === 'input_envelope_hash')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN input_envelope_hash TEXT');
  }
  if (!cols.some((c) => c.name === 'node_ref')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN node_ref TEXT');
  }
  if (!cols.some((c) => c.name === 'package_ref')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN package_ref TEXT');
  }
  if (!cols.some((c) => c.name === 'predecessor_node_run_ids')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN predecessor_node_run_ids TEXT');
  }
  if (!cols.some((c) => c.name === 'definition_digest')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN definition_digest TEXT');
  }
  if (!cols.some((c) => c.name === 'transition_cursor')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN transition_cursor TEXT');
  }
  if (!cols.some((c) => c.name === 'production_envelope')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN production_envelope TEXT');
  }
  // FU-A Wave 3 (W3-A1 spec §3/§4): 8th additive nullable column. The explicit
  // `ModuleCompletion` envelope a terminal node emitted — persisted so crash-
  // resume can rebuild the NodeExecutionResult.completion without which
  // settlement cannot read the explicit certificate ref (and would silently
  // fall back to magic bindings, losing the certificate on restart). Additive:
  // it. Idempotent ALTER guarded by PRAGMA table_info, mirroring the 7 v2 cols.
  if (!cols.some((c) => c.name === 'completion')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN completion TEXT');
  }
  // WAVE 8 HIGH 4: 9th additive nullable column. SHA-256 over the canonical
  // JSON of `completion` (computed when `completion` is non-null). Persisted
  // alongside the JSON so reads can VERIFY integrity — corrupted/malformed JSON
  // or a hash mismatch becomes a LOUD error (COMPLETION_CORRUPT /
  // COMPLETION_HASH_MISMATCH), not the silent null the audit flagged. Null when
  // same dual-placement pattern as the 8 columns above.
  if (!cols.some((c) => c.name === 'completion_hash')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN completion_hash TEXT');
  }
  // Cross-run-stable semantic digest (CONVEYOR v4.3 §5-6): 10th additive
  // nullable column. Authored by the producer from known semantic material;
  // downstream WorkKey derivation and ReplayKey semanticInputDigest use it.
  // Null for producers that have not authored one (legacy/non-cell). The
  // audit contentHash remains in output_hash.
  if (!cols.some((c) => c.name === 'semantic_digest')) {
    db.exec('ALTER TABLE factory_node_runs ADD COLUMN semantic_digest TEXT');
  }
  // Resume index: exact-cursor lookup by (process_run_id, node_id, attempt).
  // The attempt column is 1-based and unique per (run, node), so this index
  // makes readByExactCursor an equality probe (§9.11).
  db.exec(`
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

  start(input: StartNodeRunInput): NodeRunRecord {
    const count = this.db.prepare(
      'SELECT COUNT(*) AS n FROM factory_node_runs WHERE process_run_id=? AND node_id=?',
    ).get(input.processRunId, input.nodeId) as { n: number };
    const attempt = count.n + 1;
    const info = this.db.prepare(
      `INSERT INTO factory_node_runs (process_run_id, node_id, node_kind, attempt, status)
       VALUES (?, ?, ?, ?, 'running')`,
    ).run(input.processRunId, input.nodeId, input.nodeKind, attempt);
    const row = this.db.prepare(
      'SELECT * FROM factory_node_runs WHERE id=?',
    ).get(Number(info.lastInsertRowid)) as NodeRunRow;
    return rowToRecord(row);
  }

  complete(input: CompleteNodeRunInput): NodeRunRecord {
    const bindingsText = input.outputBindings ? JSON.stringify(input.outputBindings) : null;
    const receiptText = input.executionReceipt ? JSON.stringify(input.executionReceipt) : null;
    const acceptanceReceiptText = input.acceptanceReceipt
      ? JSON.stringify(input.acceptanceReceipt)
      : null;
    const recoveryIssueText = input.recoveryIssue ? JSON.stringify(input.recoveryIssue) : null;
    this.db.prepare(
      `UPDATE factory_node_runs
          SET status='completed', event=?, output_ref=?, output_schema=?, output_hash=?, output_bindings=?,
              execution_receipt=?, acceptance_receipt=?, recovery_issue=?,
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
      input.id,
    );
    const row = this.db.prepare(
      'SELECT * FROM factory_node_runs WHERE id=?',
    ).get(input.id) as NodeRunRow;
    return rowToRecord(row);
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

  readLatest(processRunId: number, nodeId: string): NodeRunRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_node_runs
        WHERE process_run_id=? AND node_id=?
        ORDER BY id DESC LIMIT 1`,
    ).get(processRunId, nodeId) as NodeRunRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  readLastCompleted(processRunId: number): NodeRunRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_node_runs
        WHERE process_run_id=? AND status='completed'
          AND (event IS NULL OR event<>'runtime.paused')
        ORDER BY id DESC LIMIT 1`,
    ).get(processRunId) as NodeRunRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(processRunId: number): readonly NodeRunRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM factory_node_runs WHERE process_run_id=? ORDER BY id ASC',
    ).all(processRunId) as NodeRunRow[];
    return rows.map(rowToRecord);
  }

  // ── Wave 3 v2 methods (W3-A6 §9 — single SQL owner) ──────────────────────

  startV2(input: StartNodeRunV2Input): NodeRunRecordV2 {
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

  readLatestV2(processRunId: number, nodeId: string): NodeRunRecordV2 | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_node_runs
        WHERE process_run_id=? AND node_id=?
        ORDER BY id DESC LIMIT 1`,
    ).get(processRunId, nodeId) as NodeRunRow | undefined;
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
