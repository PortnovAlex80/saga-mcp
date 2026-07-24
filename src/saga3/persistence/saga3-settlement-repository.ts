/**
 * Persistence for D4 authoritative discovery settlement.
 *
 * Two durable entities (roadmap D4 §9):
 *   - saga3_discovery_settlements: the deterministic decision + input snapshot
 *     for one immutable (proposal hash, readiness hash, policy) target.
 *   - saga3_discovery_outcome_certificates: the immutable proof row, 1:1 with a
 *     settlement.
 *
 * Idempotency follows the D3 lesson: the key is the immutable INPUT target
 * (proposal_id, proposal_content_hash, readiness_assessment_hash,
 * policy_version, policy_hash) and is INDEPENDENT of any execution_id. A
 * restart reuses the same settlement row and the same certificate — no second
 * certificate is ever issued for the same inputs.
 *
 * The certificate is immutable by construction: there is no UPDATE path for a
 * certificate row in this module. A new settlement target (changed proposal
 * hash, changed readiness hash, or a new policy version) produces a NEW row
 * pair; the old one is preserved for audit.
 *
 * This module is the ONLY place settlement persistence touches the DB handle.
 * The settlement service and engine never import it directly — they go through
 * the Saga3DiscoveryRuntimePersistence port (Phase B boundary).
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

import type { DiscoverySettlementReasonCode } from '../domain/discovery-settlement-policy.js';
import type { SettlementDecision, SettlementStatus, SettlementRecord, OutcomeCertificateRecord } from '../domain/discovery-settlement-records.js';
import { canonicalJson } from './saga3-normalization-repository.js';

/**
 * Create the settlement + certificate tables and indexes. Idempotent. Uses
 * db.exec for the multi-statement DDL (mirrors ensureSaga3ReadinessSchema).
 * Safe to call on every runtime construction and at the top of any handler.
 */
export function ensureSaga3SettlementSchema(db: Database.Database): void {
  db.exec(`
    -- D4: authoritative discovery settlement. A settlement binds the immutable
    -- settlement INPUT (proposal hash + readiness hash + policy version/hash)
    -- to a deterministic decision. Kernel-only: no LM WorkIntent, no worker
    -- task. Provisional Proposal lineage is separate and is never mutated.
    CREATE TABLE IF NOT EXISTS saga3_discovery_settlements (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      epic_id                     INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      proposal_id                 INTEGER NOT NULL REFERENCES saga3_proposals(id) ON DELETE CASCADE,
      proposal_content_hash       TEXT NOT NULL,
      readiness_assessment_id     INTEGER,                           -- nullable: no accepted assessment
      readiness_assessment_hash   TEXT NOT NULL,                     -- sentinel 'none' when null assessment
      policy_version              TEXT NOT NULL,
      policy_hash                 TEXT NOT NULL,
      input_snapshot              TEXT NOT NULL,                     -- canonical JSON of the input snapshot
      input_hash                  TEXT NOT NULL,                     -- SHA-256 over input_snapshot
      decision                    TEXT NOT NULL
                                    CHECK (decision IN ('go','clarify','reject')),
      reason_codes                TEXT NOT NULL DEFAULT '[]',        -- JSON array of stable codes
      rationale                   TEXT NOT NULL,
      status                      TEXT NOT NULL DEFAULT 'computed'
                                    CHECK (status IN ('computed','certificate_issued','failed')),
      created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- D4: the immutable outcome certificate. 1:1 with a settlement. There is
    -- no UPDATE path for this table in code — certificates are write-once.
    CREATE TABLE IF NOT EXISTS saga3_discovery_outcome_certificates (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_id               INTEGER NOT NULL UNIQUE REFERENCES saga3_discovery_settlements(id) ON DELETE CASCADE,
      epic_id                     INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      proposal_id                 INTEGER NOT NULL REFERENCES saga3_proposals(id) ON DELETE CASCADE,
      proposal_content_hash       TEXT NOT NULL,
      readiness_assessment_id     INTEGER,
      readiness_assessment_hash   TEXT NOT NULL,
      policy_version              TEXT NOT NULL,
      policy_hash                 TEXT NOT NULL,
      decision                    TEXT NOT NULL
                                    CHECK (decision IN ('go','clarify','reject')),
      reason_codes                TEXT NOT NULL DEFAULT '[]',
      input_hash                  TEXT NOT NULL,
      certificate_payload         TEXT NOT NULL,                     -- canonical JSON of the certificate payload
      certificate_hash            TEXT NOT NULL UNIQUE,              -- integrity check, write-once
      issued_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One settlement per immutable INPUT target (proposal hash + readiness
    -- hash + policy). A changed proposal hash, a changed readiness hash, or a
    -- new policy version is a NEW target -> new settlement + new certificate;
    -- old rows are preserved.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_settlement_input
      ON saga3_discovery_settlements(
        proposal_id, proposal_content_hash, readiness_assessment_hash,
        policy_version, policy_hash);
    CREATE INDEX IF NOT EXISTS idx_saga3_settlement_epic
      ON saga3_discovery_settlements(epic_id, status);
  `);
}

/** SHA-256 over the canonical JSON of an input snapshot object. */
export function hashSettlementInput(snapshot: unknown): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/** SHA-256 over the canonical JSON of a certificate payload object. */
export function hashCertificate(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

// ---------------------------------------------------------------------------
// Settlement rows
// ---------------------------------------------------------------------------

interface SettlementRow {
  id: number;
  epic_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  readiness_assessment_id: number | null;
  readiness_assessment_hash: string;
  policy_version: string;
  policy_hash: string;
  input_snapshot: string;
  input_hash: string;
  decision: SettlementDecision;
  reason_codes: string;
  rationale: string;
  status: SettlementStatus;
  created_at: string;
}

function settlementRowToRecord(row: SettlementRow): SettlementRecord {
  return {
    id: row.id,
    epic_id: row.epic_id,
    proposal_id: row.proposal_id,
    proposal_content_hash: row.proposal_content_hash,
    readiness_assessment_id: row.readiness_assessment_id,
    readiness_assessment_hash: row.readiness_assessment_hash,
    policy_version: row.policy_version,
    policy_hash: row.policy_hash,
    input_snapshot: row.input_snapshot,
    input_hash: row.input_hash,
    decision: row.decision,
    reason_codes: JSON.parse(row.reason_codes ?? '[]') as DiscoverySettlementReasonCode[],
    rationale: row.rationale,
    status: row.status,
    created_at: row.created_at,
  };
}

/**
 * The immutable input key for a settlement. `readinessTarget` is the ENCODED
 * semantic readiness target: 'accepted:<hash>' | 'missing' | 'failed' |
 * 'paused'. Distinct readiness states are distinct idempotency buckets — a run
 * that observed missing must never reuse a certificate later produced for
 * failed. The encoding keeps this layer free of the domain union type.
 */
export interface SettlementInputKey {
  proposalId: number;
  proposalContentHash: string;
  readinessTarget: string;
  policyVersion: string;
  policyHash: string;
}

export interface InsertSettlement {
  epicId: number;
  key: SettlementInputKey;
  /** Accepted readiness assessment id, or null when no assessment exists. */
  readinessAssessmentId: number | null;
  /** Parsed input snapshot object; stored as canonical JSON. */
  inputSnapshot: unknown;
  decision: SettlementDecision;
  reasonCodes: string[];
  rationale: string;
}

/**
 * Find an existing settlement by its immutable input key. Returns the row
 * (any status) so the service can reuse it on restart, or null.
 */
export function findSettlementByInputKey(
  db: Database.Database,
  key: SettlementInputKey,
): SettlementRecord | null {
  const row = db.prepare(
    `SELECT * FROM saga3_discovery_settlements
      WHERE proposal_id=? AND proposal_content_hash=?
        AND readiness_assessment_hash=? AND policy_version=? AND policy_hash=?
      ORDER BY id DESC LIMIT 1`,
  ).get(
    key.proposalId,
    key.proposalContentHash,
    key.readinessTarget,
    key.policyVersion,
    key.policyHash,
  ) as SettlementRow | undefined;
  return row ? settlementRowToRecord(row) : null;
}

/**
 * Idempotent insert of a settlement row (status 'computed'). On conflict of the
 * input key, the existing row is returned and `replayed` is true. The decision,
 * reason codes, and rationale are NOT overwritten on replay — a replayed
 * settlement keeps its original decision (deterministic by construction).
 */
export function insertSettlement(
  db: Database.Database,
  input: InsertSettlement,
): { record: SettlementRecord; replayed: boolean } {
  const snapshotText = canonicalJson(input.inputSnapshot);
  const inputHash = createHash('sha256').update(snapshotText).digest('hex');
  const info = db.prepare(
    `INSERT INTO saga3_discovery_settlements
       (epic_id, proposal_id, proposal_content_hash, readiness_assessment_id,
        readiness_assessment_hash, policy_version, policy_hash, input_snapshot,
        input_hash, decision, reason_codes, rationale, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'computed')
     ON CONFLICT(proposal_id, proposal_content_hash, readiness_assessment_hash,
                 policy_version, policy_hash) DO NOTHING`,
  ).run(
    input.epicId,
    input.key.proposalId,
    input.key.proposalContentHash,
    input.readinessAssessmentId,
    input.key.readinessTarget,
    input.key.policyVersion,
    input.key.policyHash,
    snapshotText,
    inputHash,
    input.decision,
    JSON.stringify(input.reasonCodes),
    input.rationale,
  );
  const record = findSettlementByInputKey(db, input.key);
  if (!record) throw new Error('saga3: settlement vanished after insert');
  return { record, replayed: info.changes === 0 };
}

/**
 * Mark a settlement as having an issued certificate. CAS-guarded: transitions
 * computed OR failed -> certificate_issued (and stays certificate_issued on
 * replay). A failed settlement is recoverable to certificate_issued on a later
 * deterministic retry (the certificate is rebuilt from the STORED snapshot, so
 * recovery is safe). Returns true iff the row is now certificate_issued.
 */
export function markSettlementCertificateIssued(
  db: Database.Database,
  settlementId: number,
): boolean {
  const info = db.prepare(
    `UPDATE saga3_discovery_settlements
        SET status='certificate_issued'
      WHERE id=? AND status IN ('computed','failed','certificate_issued')`,
  ).run(settlementId);
  return info.changes > 0;
}

/**
 * Mark a settlement failed (certificate could not be issued). Does NOT delete
 * the row — a failed settlement is observable for audit. Only transitions from
 * 'computed'; an already-issued certificate is never reverted to failed.
 */
export function markSettlementFailed(
  db: Database.Database,
  settlementId: number,
): void {
  db.prepare(
    `UPDATE saga3_discovery_settlements
        SET status='failed'
      WHERE id=? AND status='computed'`,
  ).run(settlementId);
}

/** Read a settlement by id. */
export function readSettlement(
  db: Database.Database,
  settlementId: number,
): SettlementRecord | null {
  const row = db.prepare('SELECT * FROM saga3_discovery_settlements WHERE id=?')
    .get(settlementId) as SettlementRow | undefined;
  return row ? settlementRowToRecord(row) : null;
}

// ---------------------------------------------------------------------------
// Certificate rows
// ---------------------------------------------------------------------------

interface CertificateRow {
  id: number;
  settlement_id: number;
  epic_id: number;
  proposal_id: number;
  proposal_content_hash: string;
  readiness_assessment_id: number | null;
  readiness_assessment_hash: string;
  policy_version: string;
  policy_hash: string;
  decision: SettlementDecision;
  reason_codes: string;
  input_hash: string;
  certificate_payload: string;
  certificate_hash: string;
  issued_at: string;
}

function certificateRowToRecord(row: CertificateRow): OutcomeCertificateRecord {
  return {
    id: row.id,
    settlement_id: row.settlement_id,
    epic_id: row.epic_id,
    proposal_id: row.proposal_id,
    proposal_content_hash: row.proposal_content_hash,
    readiness_assessment_id: row.readiness_assessment_id,
    readiness_assessment_hash: row.readiness_assessment_hash,
    policy_version: row.policy_version,
    policy_hash: row.policy_hash,
    decision: row.decision,
    reason_codes: JSON.parse(row.reason_codes ?? '[]') as DiscoverySettlementReasonCode[],
    input_hash: row.input_hash,
    certificate_payload: row.certificate_payload,
    certificate_hash: row.certificate_hash,
    issued_at: row.issued_at,
  };
}

export interface InsertCertificate {
  settlementId: number;
  epicId: number;
  proposalId: number;
  proposalContentHash: string;
  readinessAssessmentId: number | null;
  readinessAssessmentHash: string;
  policyVersion: string;
  policyHash: string;
  decision: SettlementDecision;
  reasonCodes: string[];
  inputHash: string;
  /** Parsed certificate payload object; stored as canonical JSON. */
  certificatePayload: unknown;
}

/**
 * Insert the immutable certificate (write-once). On UNIQUE(settlement_id)
 * conflict the existing certificate is returned and `replayed` is true — there
 * is never a second certificate for one settlement. The payload is NOT
 * overwritten on replay.
 */
export function insertCertificate(
  db: Database.Database,
  input: InsertCertificate,
): { record: OutcomeCertificateRecord; replayed: boolean } {
  const payloadText = canonicalJson(input.certificatePayload);
  const certHash = createHash('sha256').update(payloadText).digest('hex');
  const info = db.prepare(
    `INSERT INTO saga3_discovery_outcome_certificates
       (settlement_id, epic_id, proposal_id, proposal_content_hash,
        readiness_assessment_id, readiness_assessment_hash, policy_version,
        policy_hash, decision, reason_codes, input_hash, certificate_payload,
        certificate_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(settlement_id) DO NOTHING`,
  ).run(
    input.settlementId,
    input.epicId,
    input.proposalId,
    input.proposalContentHash,
    input.readinessAssessmentId,
    input.readinessAssessmentHash,
    input.policyVersion,
    input.policyHash,
    input.decision,
    JSON.stringify(input.reasonCodes),
    input.inputHash,
    payloadText,
    certHash,
  );
  const row = db.prepare(
    'SELECT * FROM saga3_discovery_outcome_certificates WHERE settlement_id=?',
  ).get(input.settlementId) as CertificateRow | undefined;
  if (!row) throw new Error('saga3: outcome certificate vanished after insert');
  return { record: certificateRowToRecord(row), replayed: info.changes === 0 };
}

/** Read the certificate for a settlement, if any. */
export function readCertificateForSettlement(
  db: Database.Database,
  settlementId: number,
): OutcomeCertificateRecord | null {
  const row = db.prepare(
    'SELECT * FROM saga3_discovery_outcome_certificates WHERE settlement_id=?',
  ).get(settlementId) as CertificateRow | undefined;
  return row ? certificateRowToRecord(row) : null;
}
