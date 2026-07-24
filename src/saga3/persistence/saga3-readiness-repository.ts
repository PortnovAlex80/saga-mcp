/**
 * D3 readiness-advisor persistence helpers.
 *
 * Mirrors the D2 normalization repository pattern. All functions are
 * deterministic and take the DB handle explicitly (the engine/service never
 * imports this — only the SQLite adapter and the MCP handler boundary do).
 * `canonicalJson` is shared with the normalization repository rather than
 * duplicated.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from './saga3-normalization-repository.js';
import type {
  OverallReadiness,
  RecommendedNextAction,
} from '../domain/discovery-readiness-assessment.js';
import type {
  ReadinessAssessmentRecord,
  ReadinessAssessmentStatus,
  ReadinessControlIntentRecord,
} from '../domain/discovery-readiness-records.js';
import type { ProposalProvenance } from '../domain/proposal.js';

/** Idempotently create the D3 readiness tables if absent. */
export function ensureSaga3ReadinessSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_readiness_control_intents (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      epic_id               INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      kind                  TEXT NOT NULL,
      proposal_id           INTEGER NOT NULL REFERENCES saga3_proposals(id) ON DELETE CASCADE,
      proposal_content_hash TEXT NOT NULL,
      source_intent_id      INTEGER NOT NULL REFERENCES saga3_work_intents(id) ON DELETE CASCADE,
      authority_intent_id   INTEGER NOT NULL REFERENCES saga3_work_intents(id) ON DELETE CASCADE,
      projected_task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      status                TEXT NOT NULL DEFAULT 'open'
                              CHECK (status IN ('open','executing','paused','concluded','cancelled')),
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS saga3_readiness_assessments (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      control_intent_id        INTEGER NOT NULL REFERENCES saga3_readiness_control_intents(id) ON DELETE CASCADE,
      proposal_id              INTEGER NOT NULL REFERENCES saga3_proposals(id) ON DELETE CASCADE,
      proposal_content_hash    TEXT NOT NULL,
      task_id                  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      execution_id             TEXT NOT NULL,
      payload                  TEXT NOT NULL,
      content_hash             TEXT NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'submitted'
                               CHECK (status IN ('submitted','accepted_by_kernel','rejected_by_kernel')),
      overall_readiness        TEXT,
      recommended_next_action  TEXT,
      provenance               TEXT NOT NULL DEFAULT '{}',
      created_at               TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_readiness_control_target
      ON saga3_readiness_control_intents(proposal_id, proposal_content_hash);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_readiness_assessment_idempotency
      ON saga3_readiness_assessments(control_intent_id, execution_id, content_hash);
    CREATE INDEX IF NOT EXISTS idx_saga3_readiness_control_epic
      ON saga3_readiness_control_intents(epic_id, status);
    CREATE INDEX IF NOT EXISTS idx_saga3_readiness_assessment_control
      ON saga3_readiness_assessments(control_intent_id);
  `);
}

/** SHA-256 over the canonical serialization of the assessment payload. */
export function hashReadinessAssessment(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export interface InsertReadinessAssessment {
  controlIntentId: number;
  proposalId: number;
  proposalContentHash: string;
  taskId: number;
  executionId: string;
  payload: unknown;
  overallReadiness: OverallReadiness;
  recommendedNextAction: RecommendedNextAction;
  provenance: ProposalProvenance;
}

/** Idempotent insert of a readiness assessment. */
export function insertReadinessAssessment(
  db: Database.Database,
  input: InsertReadinessAssessment,
): { record: ReadinessAssessmentRecord; replayed: boolean } {
  const payloadText = canonicalJson(input.payload);
  const hash = createHash('sha256').update(payloadText).digest('hex');
  const info = db.prepare(
    `INSERT INTO saga3_readiness_assessments
       (control_intent_id, proposal_id, proposal_content_hash, task_id,
        execution_id, payload, content_hash, status, overall_readiness,
        recommended_next_action, provenance)
     VALUES (?,?,?,?,?,?,?, 'submitted', ?, ?, ?)
     ON CONFLICT(control_intent_id, execution_id, content_hash) DO NOTHING`,
  ).run(
    input.controlIntentId,
    input.proposalId,
    input.proposalContentHash,
    input.taskId,
    input.executionId,
    payloadText,
    hash,
    input.overallReadiness,
    input.recommendedNextAction,
    JSON.stringify(input.provenance),
  );
  const row = db.prepare(
    `SELECT * FROM saga3_readiness_assessments
      WHERE control_intent_id=? AND execution_id=? AND content_hash=?`,
  ).get(input.controlIntentId, input.executionId, hash) as ReadinessAssessmentRow | undefined;
  if (!row) throw new Error('saga3: readiness assessment vanished after insert');
  return { record: assessmentRowToRecord(row), replayed: info.changes === 0 };
}

export function readReadinessAssessment(
  db: Database.Database,
  assessmentId: number,
): ReadinessAssessmentRecord | null {
  const row = db.prepare('SELECT * FROM saga3_readiness_assessments WHERE id=?')
    .get(assessmentId) as ReadinessAssessmentRow | undefined;
  return row ? assessmentRowToRecord(row) : null;
}

/** Latest assessment (any status) for one ControlIntent. */
export function readLatestReadinessAssessmentForControl(
  db: Database.Database,
  controlIntentId: number,
): ReadinessAssessmentRecord | null {
  const row = db.prepare(
    `SELECT * FROM saga3_readiness_assessments WHERE control_intent_id=? ORDER BY id DESC LIMIT 1`,
  ).get(controlIntentId) as ReadinessAssessmentRow | undefined;
  return row ? assessmentRowToRecord(row) : null;
}

/** Latest ACCEPTED assessment for one ControlIntent (the shadow verdict). */
export function readLatestAcceptedReadinessAssessmentForControl(
  db: Database.Database,
  controlIntentId: number,
): ReadinessAssessmentRecord | null {
  const row = db.prepare(
    `SELECT * FROM saga3_readiness_assessments
      WHERE control_intent_id=? AND status='accepted_by_kernel'
      ORDER BY id DESC LIMIT 1`,
  ).get(controlIntentId) as ReadinessAssessmentRow | undefined;
  return row ? assessmentRowToRecord(row) : null;
}

export function markReadinessAccepted(db: Database.Database, assessmentId: number): void {
  db.prepare(
    `UPDATE saga3_readiness_assessments
        SET status='accepted_by_kernel'
      WHERE id=? AND status IN ('submitted','accepted_by_kernel')`,
  ).run(assessmentId);
}

export function markReadinessRejected(db: Database.Database, assessmentId: number): void {
  db.prepare(
    `UPDATE saga3_readiness_assessments
        SET status='rejected_by_kernel'
      WHERE id=? AND status IN ('submitted','rejected_by_kernel')`,
  ).run(assessmentId);
}

/** Read a readiness ControlIntent by its immutable Proposal target. */
export function readReadinessControlForProposal(
  db: Database.Database,
  proposalId: number,
  proposalContentHash: string,
): ReadinessControlIntentRecord | null {
  const row = db.prepare(
    `SELECT * FROM saga3_readiness_control_intents
      WHERE proposal_id=? AND proposal_content_hash=?`,
  ).get(proposalId, proposalContentHash) as ReadinessControlIntentRow | undefined;
  return row ? controlRowToRecord(row) : null;
}

export function readReadinessControl(
  db: Database.Database,
  controlIntentId: number,
): ReadinessControlIntentRecord | null {
  const row = db.prepare('SELECT * FROM saga3_readiness_control_intents WHERE id=?')
    .get(controlIntentId) as ReadinessControlIntentRow | undefined;
  return row ? controlRowToRecord(row) : null;
}

// --- Row mappers ---

interface ReadinessControlIntentRow {
  id: number;
  epic_id: number;
  kind: string;
  proposal_id: number;
  proposal_content_hash: string;
  source_intent_id: number;
  authority_intent_id: number;
  projected_task_id: number | null;
  status: string;
  created_at: string;
  updated_at: string;
}

function controlRowToRecord(row: ReadinessControlIntentRow): ReadinessControlIntentRecord {
  return {
    id: row.id,
    epic_id: row.epic_id,
    kind: row.kind,
    proposal_id: row.proposal_id,
    proposal_content_hash: row.proposal_content_hash,
    source_intent_id: row.source_intent_id,
    authority_intent_id: row.authority_intent_id,
    projected_task_id: row.projected_task_id,
    status: row.status as ReadinessControlIntentRecord['status'],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface ReadinessAssessmentRow {
  id: number;
  control_intent_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  task_id: number;
  execution_id: string;
  payload: string;
  content_hash: string;
  status: ReadinessAssessmentStatus;
  overall_readiness: string | null;
  recommended_next_action: string | null;
  provenance: string;
  created_at: string;
}

function assessmentRowToRecord(row: ReadinessAssessmentRow): ReadinessAssessmentRecord {
  return {
    id: row.id,
    control_intent_id: row.control_intent_id,
    proposal_id: row.proposal_id,
    proposal_content_hash: row.proposal_content_hash,
    task_id: row.task_id,
    execution_id: row.execution_id,
    payload: JSON.parse(row.payload),
    content_hash: row.content_hash,
    status: row.status,
    overall_readiness: row.overall_readiness as OverallReadiness | null,
    recommended_next_action: row.recommended_next_action as RecommendedNextAction | null,
    provenance: row.provenance && row.provenance !== '{}' ? JSON.parse(row.provenance) : null,
    created_at: row.created_at,
  };
}
