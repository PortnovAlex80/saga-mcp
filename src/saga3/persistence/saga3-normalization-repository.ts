import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DiscoveryNormalizationProposalRecord,
  RawDiscoverySubmissionRecord,
  RawDiscoverySubmissionStatus,
} from '../domain/discovery-normalization-records.js';
import type { ProposalProvenance } from '../domain/proposal.js';

export function ensureSaga3NormalizationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_raw_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id INTEGER NOT NULL REFERENCES saga3_work_intents(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      execution_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      raw_payload TEXT NOT NULL,
      raw_hash TEXT NOT NULL,
      parsed_payload TEXT,
      status TEXT NOT NULL CHECK (status IN ('accepted_deterministically','normalization_required','rejected_syntax','normalized')),
      normalization_trace TEXT NOT NULL DEFAULT '[]',
      validation_errors TEXT NOT NULL DEFAULT '[]',
      alias_conflicts TEXT NOT NULL DEFAULT '[]',
      allowed_evidence_refs TEXT NOT NULL DEFAULT '[]',
      provenance TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS saga3_control_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      question TEXT NOT NULL,
      source_submission_id INTEGER NOT NULL UNIQUE REFERENCES saga3_raw_submissions(id) ON DELETE CASCADE,
      authority_intent_id INTEGER NOT NULL REFERENCES saga3_work_intents(id) ON DELETE CASCADE,
      projected_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','executing','paused','concluded','cancelled')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS saga3_normalization_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      control_intent_id INTEGER NOT NULL REFERENCES saga3_control_intents(id) ON DELETE CASCADE,
      source_submission_id INTEGER NOT NULL REFERENCES saga3_raw_submissions(id) ON DELETE CASCADE,
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      execution_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','accepted_by_kernel','rejected_by_kernel')),
      provenance TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_raw_submission_idempotency
      ON saga3_raw_submissions(intent_id, execution_id, raw_hash);
    CREATE INDEX IF NOT EXISTS idx_saga3_raw_submission_intent
      ON saga3_raw_submissions(intent_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_normalization_idempotency
      ON saga3_normalization_proposals(control_intent_id, execution_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_saga3_control_epic
      ON saga3_control_intents(epic_id, status);
  `);
  const columns = db.prepare(`PRAGMA table_info(saga3_proposals)`).all() as Array<{ name: string }>;
  const names = new Set(columns.map(column => column.name));
  if (!names.has('source_submission_id')) db.exec(`ALTER TABLE saga3_proposals ADD COLUMN source_submission_id INTEGER`);
  if (!names.has('normalization_proposal_id')) db.exec(`ALTER TABLE saga3_proposals ADD COLUMN normalization_proposal_id INTEGER`);
}

export function hashRawSubmission(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface InsertRawSubmission {
  intentId: number;
  taskId: number;
  executionId: string;
  kind: string;
  schemaVersion: string;
  rawPayload: string;
  parsedPayload: unknown | null;
  status: RawDiscoverySubmissionStatus;
  normalizationTrace: string[];
  validationErrors: string[];
  aliasConflicts: string[];
  allowedEvidenceRefs: string[];
  provenance: ProposalProvenance;
}

export function insertRawSubmission(
  db: Database.Database,
  input: InsertRawSubmission,
): { record: RawDiscoverySubmissionRecord; replayed: boolean } {
  const rawHash = hashRawSubmission(input.rawPayload);
  const info = db.prepare(
    `INSERT INTO saga3_raw_submissions
       (intent_id, task_id, execution_id, kind, schema_version, raw_payload,
        raw_hash, parsed_payload, status, normalization_trace, validation_errors,
        alias_conflicts, allowed_evidence_refs, provenance)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(intent_id, execution_id, raw_hash) DO NOTHING`,
  ).run(
    input.intentId,
    input.taskId,
    input.executionId,
    input.kind,
    input.schemaVersion,
    input.rawPayload,
    rawHash,
    input.parsedPayload === null ? null : JSON.stringify(input.parsedPayload),
    input.status,
    JSON.stringify(input.normalizationTrace),
    JSON.stringify(input.validationErrors),
    JSON.stringify(input.aliasConflicts),
    JSON.stringify(input.allowedEvidenceRefs),
    JSON.stringify(input.provenance),
  );
  const row = db.prepare(
    `SELECT * FROM saga3_raw_submissions
      WHERE intent_id=? AND execution_id=? AND raw_hash=?`,
  ).get(input.intentId, input.executionId, rawHash) as RawSubmissionRow | undefined;
  if (!row) throw new Error('saga3: raw submission vanished after insert');
  return { record: rawRowToRecord(row), replayed: info.changes === 0 };
}

export function readRawSubmission(
  db: Database.Database,
  submissionId: number,
): RawDiscoverySubmissionRecord | null {
  const row = db.prepare('SELECT * FROM saga3_raw_submissions WHERE id=?')
    .get(submissionId) as RawSubmissionRow | undefined;
  return row ? rawRowToRecord(row) : null;
}

export function markRawSubmissionNormalized(
  db: Database.Database,
  submissionId: number,
): void {
  db.prepare(`UPDATE saga3_raw_submissions SET status='normalized' WHERE id=? AND status IN ('normalization_required','normalized')`).run(submissionId);
}

export function readLatestRawSubmissionForIntent(
  db: Database.Database,
  intentId: number,
): RawDiscoverySubmissionRecord | null {
  const row = db.prepare(
    `SELECT * FROM saga3_raw_submissions WHERE intent_id=? ORDER BY id DESC LIMIT 1`,
  ).get(intentId) as RawSubmissionRow | undefined;
  return row ? rawRowToRecord(row) : null;
}

export interface InsertNormalizationProposal {
  controlIntentId: number;
  sourceSubmissionId: number;
  taskId: number;
  executionId: string;
  payload: unknown;
  provenance: ProposalProvenance;
}

export function insertNormalizationProposal(
  db: Database.Database,
  input: InsertNormalizationProposal,
): { record: DiscoveryNormalizationProposalRecord; replayed: boolean } {
  const payloadText = canonicalJson(input.payload);
  const hash = createHash('sha256').update(payloadText).digest('hex');
  const info = db.prepare(
    `INSERT INTO saga3_normalization_proposals
       (control_intent_id, source_submission_id, task_id, execution_id,
        payload, content_hash, status, provenance)
     VALUES (?,?,?,?,?,?, 'submitted', ?)
     ON CONFLICT(control_intent_id, execution_id, content_hash) DO NOTHING`,
  ).run(
    input.controlIntentId,
    input.sourceSubmissionId,
    input.taskId,
    input.executionId,
    payloadText,
    hash,
    JSON.stringify(input.provenance),
  );
  const row = db.prepare(
    `SELECT * FROM saga3_normalization_proposals
      WHERE control_intent_id=? AND execution_id=? AND content_hash=?`,
  ).get(input.controlIntentId, input.executionId, hash) as NormalizationProposalRow | undefined;
  if (!row) throw new Error('saga3: normalization proposal vanished after insert');
  return { record: normalizationRowToRecord(row), replayed: info.changes === 0 };
}

export function readLatestNormalizationProposalForControl(
  db: Database.Database,
  controlIntentId: number,
): DiscoveryNormalizationProposalRecord | null {
  const row = db.prepare(`SELECT * FROM saga3_normalization_proposals WHERE control_intent_id=? ORDER BY id DESC LIMIT 1`)
    .get(controlIntentId) as NormalizationProposalRow | undefined;
  return row ? normalizationRowToRecord(row) : null;
}

export function markNormalizationAccepted(
  db: Database.Database,
  normalizationProposalId: number,
): void {
  db.prepare(
    `UPDATE saga3_normalization_proposals
        SET status='accepted_by_kernel'
      WHERE id=? AND status IN ('submitted','accepted_by_kernel')`,
  ).run(normalizationProposalId);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

interface RawSubmissionRow {
  id: number;
  intent_id: number;
  task_id: number;
  execution_id: string;
  kind: string;
  schema_version: string;
  raw_payload: string;
  raw_hash: string;
  parsed_payload: string | null;
  status: RawDiscoverySubmissionStatus;
  normalization_trace: string;
  validation_errors: string;
  alias_conflicts: string;
  allowed_evidence_refs: string;
  provenance: string;
  created_at: string;
}

function rawRowToRecord(row: RawSubmissionRow): RawDiscoverySubmissionRecord {
  return {
    id: row.id,
    intent_id: row.intent_id,
    task_id: row.task_id,
    execution_id: row.execution_id,
    kind: row.kind,
    schema_version: row.schema_version,
    raw_payload: row.raw_payload,
    raw_hash: row.raw_hash,
    parsed_payload: row.parsed_payload === null ? null : JSON.parse(row.parsed_payload),
    status: row.status,
    normalization_trace: JSON.parse(row.normalization_trace),
    validation_errors: JSON.parse(row.validation_errors),
    alias_conflicts: JSON.parse(row.alias_conflicts),
    allowed_evidence_refs: JSON.parse(row.allowed_evidence_refs),
    provenance: row.provenance === '{}' ? null : JSON.parse(row.provenance),
    created_at: row.created_at,
  };
}

interface NormalizationProposalRow {
  id: number;
  control_intent_id: number;
  source_submission_id: number;
  task_id: number;
  execution_id: string;
  payload: string;
  content_hash: string;
  status: DiscoveryNormalizationProposalRecord['status'];
  provenance: string;
  created_at: string;
}

function normalizationRowToRecord(
  row: NormalizationProposalRow,
): DiscoveryNormalizationProposalRecord {
  return {
    id: row.id,
    control_intent_id: row.control_intent_id,
    source_submission_id: row.source_submission_id,
    task_id: row.task_id,
    execution_id: row.execution_id,
    payload: JSON.parse(row.payload),
    content_hash: row.content_hash,
    status: row.status,
    provenance: row.provenance === '{}' ? null : JSON.parse(row.provenance),
    created_at: row.created_at,
  };
}
