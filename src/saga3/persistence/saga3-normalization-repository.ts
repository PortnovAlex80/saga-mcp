import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DiscoveryNormalizationProposalRecord,
  RawDiscoverySubmissionRecord,
  RawDiscoverySubmissionStatus,
} from '../domain/discovery-normalization-records.js';
import type { ProposalProvenance } from '../domain/proposal.js';

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
