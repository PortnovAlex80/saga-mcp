/**
 * SQLite implementation of NodeRunRepository.
 *
 * Schema lives in saga3_node_runs. One row per node-execution attempt; the
 * attempt counter is derived from existing rows for (process_run_id, node_id)
 * so retries increment naturally. Generic — no module-specific columns.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import type {
  CompleteNodeRunInput,
  FailNodeRunInput,
  NodeRunRecord,
  NodeRunRepository,
  NodeRunStatus,
  StartNodeRunInput,
} from './node-run.js';

export function ensureSaga3NodeRunSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_node_runs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id INTEGER NOT NULL REFERENCES saga3_process_runs(id) ON DELETE CASCADE,
      node_id        TEXT NOT NULL,
      node_kind      TEXT NOT NULL,
      attempt        INTEGER NOT NULL,
      status         TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running','completed','failed')),
      event          TEXT,
      output_ref     TEXT,
      output_hash    TEXT,
      output_bindings TEXT,
      error_message  TEXT,
      started_at     TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_saga3_node_runs_process
      ON saga3_node_runs(process_run_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_saga3_node_runs_status
      ON saga3_node_runs(process_run_id, status, id);
  `);
  // Д8 migration: older DBs created saga3_node_runs without output_bindings.
  // SQLite ALTER TABLE ADD COLUMN is safe (no CHECK to rebuild).
  const cols = db.prepare("PRAGMA table_info(saga3_node_runs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === 'output_bindings')) {
    db.exec('ALTER TABLE saga3_node_runs ADD COLUMN output_bindings TEXT');
  }
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
  output_hash: string | null;
  output_bindings: string | null;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
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
  return {
    id: row.id,
    processRunId: row.process_run_id,
    nodeId: row.node_id,
    nodeKind: row.node_kind,
    attempt: row.attempt,
    status: row.status,
    event: row.event,
    outputRef: row.output_ref,
    outputHash: row.output_hash,
    outputBindings: bindings,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export class SqliteNodeRunRepository implements NodeRunRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureSaga3NodeRunSchema(this.db);
  }

  start(input: StartNodeRunInput): NodeRunRecord {
    const count = this.db.prepare(
      'SELECT COUNT(*) AS n FROM saga3_node_runs WHERE process_run_id=? AND node_id=?',
    ).get(input.processRunId, input.nodeId) as { n: number };
    const attempt = count.n + 1;
    const info = this.db.prepare(
      `INSERT INTO saga3_node_runs (process_run_id, node_id, node_kind, attempt, status)
       VALUES (?, ?, ?, ?, 'running')`,
    ).run(input.processRunId, input.nodeId, input.nodeKind, attempt);
    const row = this.db.prepare(
      'SELECT * FROM saga3_node_runs WHERE id=?',
    ).get(Number(info.lastInsertRowid)) as NodeRunRow;
    return rowToRecord(row);
  }

  complete(input: CompleteNodeRunInput): NodeRunRecord {
    const bindingsText = input.outputBindings ? JSON.stringify(input.outputBindings) : null;
    this.db.prepare(
      `UPDATE saga3_node_runs
          SET status='completed', event=?, output_ref=?, output_hash=?, output_bindings=?,
              completed_at=datetime('now')
        WHERE id=?`,
    ).run(input.event, input.outputRef, input.outputHash, bindingsText, input.id);
    const row = this.db.prepare(
      'SELECT * FROM saga3_node_runs WHERE id=?',
    ).get(input.id) as NodeRunRow;
    return rowToRecord(row);
  }

  fail(input: FailNodeRunInput): NodeRunRecord {
    this.db.prepare(
      `UPDATE saga3_node_runs
          SET status='failed', error_message=?, completed_at=datetime('now')
        WHERE id=?`,
    ).run(input.errorMessage, input.id);
    const row = this.db.prepare(
      'SELECT * FROM saga3_node_runs WHERE id=?',
    ).get(input.id) as NodeRunRow;
    return rowToRecord(row);
  }

  readLatest(processRunId: number, nodeId: string): NodeRunRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM saga3_node_runs
        WHERE process_run_id=? AND node_id=?
        ORDER BY id DESC LIMIT 1`,
    ).get(processRunId, nodeId) as NodeRunRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  readLastCompleted(processRunId: number): NodeRunRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM saga3_node_runs
        WHERE process_run_id=? AND status='completed'
        ORDER BY id DESC LIMIT 1`,
    ).get(processRunId) as NodeRunRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  list(processRunId: number): readonly NodeRunRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM saga3_node_runs WHERE process_run_id=? ORDER BY id ASC',
    ).all(processRunId) as NodeRunRow[];
    return rows.map(rowToRecord);
  }
}
