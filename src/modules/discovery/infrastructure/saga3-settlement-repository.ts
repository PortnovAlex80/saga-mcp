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
import { canonicalJson } from '../../../saga3/persistence/saga3-normalization-repository.js';

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

/**
 * Read an outcome certificate by its exact id. Used by the D5 diagnosis service
 * to load the immutable diagnosis target (the certificate the engine points
 * at). Read-only. Returns null if no such row.
 */
export function readOutcomeCertificate(
  db: Database.Database,
  certificateId: number,
): OutcomeCertificateRecord | null {
  const row = db.prepare(
    'SELECT * FROM saga3_discovery_outcome_certificates WHERE id=?',
  ).get(certificateId) as CertificateRow | undefined;
  return row ? certificateRowToRecord(row) : null;
}

/** Inputs to the atomic certificate-issuance operation (mirrors the port type). */
export interface IssueCertificateAtomicInput {
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
  certificatePayload: unknown;
  expectedCertificateHash: string;
  /** Persisted in BOTH the row's issued_at and (already) the payload. */
  issuedAt: string;
  /** Canonical JSON text of the settlement input snapshot; verified inside tx. */
  inputSnapshotText: string;
  /** Policy rationale stored on the settlement row; verified inside tx. */
  rationale: string;
}

/**
 * ONE ATOMIC operation (BEGIN IMMEDIATE): verify the settlement exists and is in
 * an issuable state, insert-or-reuse the exact certificate (write-once), advance
 * the settlement status to certificate_issued, commit. `issuedAt` is persisted
 * in BOTH the certificate row and (by the caller) the payload, so a recovery
 * rebuild produces a byte-identical row. A pre-existing certificate whose stored
 * hash disagrees with `expectedCertificateHash` throws (co-tamper detection).
 *
 * This replaces the previous non-atomic insertCertificate + separate
 * markSettlementCertificateIssued sequence: a crash between those two could
 * leave a certificate row attached to a computed/failed settlement.
 */
export function issueCertificateAtomically(
  db: Database.Database,
  input: IssueCertificateAtomicInput,
): { record: OutcomeCertificateRecord; inserted: boolean } {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Verify the settlement exists, is issuable, AND that its lineage still
    //    matches the caller's expected inputs. This closes the TOCTOU window
    //    between the service-level validation and BEGIN IMMEDIATE: another writer
    //    could have changed the settlement row after the service verified it.
    //    The atomic boundary must re-confirm the FULL settlement, not just status.
    const settlement = db.prepare(
      'SELECT * FROM saga3_discovery_settlements WHERE id=?',
    ).get(input.settlementId) as SettlementRow | undefined;
    if (!settlement) {
      throw new Error(`saga3: settlement ${input.settlementId} not found for certificate issuance`);
    }
    // A settlement in a non-issuable state is rejected by the CAS transition
    // below (status IN ('computed','failed','certificate_issued')). No separate
    // 'cancelled' check is needed — the schema's status enum has no 'cancelled'.
    // Settlement lineage must match the caller's inputs (re-checked inside tx).
    const settlementChecks: Array<[string, unknown, unknown]> = [
      ['epic_id', settlement.epic_id, input.epicId],
      ['proposal_id', settlement.proposal_id, input.proposalId],
      ['proposal_content_hash', settlement.proposal_content_hash, input.proposalContentHash],
      ['readiness_assessment_id', settlement.readiness_assessment_id, input.readinessAssessmentId],
      ['readiness_assessment_hash', settlement.readiness_assessment_hash, input.readinessAssessmentHash],
      ['policy_version', settlement.policy_version, input.policyVersion],
      ['policy_hash', settlement.policy_hash, input.policyHash],
      ['decision', settlement.decision, input.decision],
      ['reason_codes', settlement.reason_codes, JSON.stringify(input.reasonCodes)],
      ['input_hash', settlement.input_hash, input.inputHash],
      ['created_at', settlement.created_at, input.issuedAt],
    ];
    for (const [field, actual, expected] of settlementChecks) {
      if (actual !== expected) {
        throw new Error(
          `saga3: settlement ${input.settlementId} ${field} '${actual}' != expected '${expected}' (TOCTOU drift inside atomic tx)`,
        );
      }
    }
    // P0: bind the atomic tx to the settlement INPUT SNAPSHOT + rationale. These
    //    are authoritative-input fields too: a concurrent writer could change
    //    input_snapshot (or rationale) between service validation and BEGIN
    //    IMMEDIATE while leaving input_hash unchanged. The snapshot is compared
    //    by its EXACT canonical text (the canonical representation the service
    //    verified), and its recomputed hash must equal input_hash (so a tampered
    //    snapshot that also rewrote input_hash is still caught by the text
    //    compare; a tampered snapshot that left input_hash is caught by the hash
    //    recompute).
    if (settlement.input_snapshot !== input.inputSnapshotText) {
      throw new Error(
        `saga3: settlement ${input.settlementId} input_snapshot does not match the expected canonical snapshot text (TOCTOU drift inside atomic tx)`,
      );
    }
    const recomputedInputHash = createHash('sha256').update(settlement.input_snapshot).digest('hex');
    if (recomputedInputHash !== input.inputHash) {
      throw new Error(
        `saga3: settlement ${input.settlementId} stored input_snapshot hash does not match input_hash (internally inconsistent)`,
      );
    }
    if (settlement.rationale !== input.rationale) {
      throw new Error(
        `saga3: settlement ${input.settlementId} rationale '${settlement.rationale}' != expected '${input.rationale}' (TOCTOU drift inside atomic tx)`,
      );
    }

    // 2. Insert-or-reuse the certificate. issued_at is explicitly persisted so
    //    the row matches the payload's issued_at (no datetime('now') drift).
    const payloadText = canonicalJson(input.certificatePayload);
    const recomputedHash = createHash('sha256').update(payloadText).digest('hex');
    if (recomputedHash !== input.expectedCertificateHash) {
      throw new Error(
        `saga3: certificate hash mismatch for settlement ${input.settlementId} (caller expected ${input.expectedCertificateHash.slice(0, 12)}, recomputed ${recomputedHash.slice(0, 12)})`,
      );
    }
    const insertInfo = db.prepare(
      `INSERT INTO saga3_discovery_outcome_certificates
         (settlement_id, epic_id, proposal_id, proposal_content_hash,
          readiness_assessment_id, readiness_assessment_hash, policy_version,
          policy_hash, decision, reason_codes, input_hash, certificate_payload,
          certificate_hash, issued_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(settlement_id) DO NOTHING`,
    ).run(
      input.settlementId, input.epicId, input.proposalId, input.proposalContentHash,
      input.readinessAssessmentId, input.readinessAssessmentHash,
      input.policyVersion, input.policyHash, input.decision,
      JSON.stringify(input.reasonCodes), input.inputHash, payloadText,
      recomputedHash, input.issuedAt,
    );
    const inserted = insertInfo.changes > 0;
    const certRow = db.prepare(
      'SELECT * FROM saga3_discovery_outcome_certificates WHERE settlement_id=?',
    ).get(input.settlementId) as CertificateRow | undefined;
    if (!certRow) {
      throw new Error(`saga3: certificate vanished for settlement ${input.settlementId}`);
    }
    // 3. Co-tamper + reused-payload + row-lineage guard. The hash check rejects
    //    a payload+hash co-tampered together to agree with each other but not
    //    with our recomputation. When the row pre-existed (inserted=false), the
    //    STORED certificate_payload must be canonically identical to the payload
    //    we just built (a concurrent writer could have inserted a row with the
    //    right hash + lineage columns but a wrong payload), its own hash must
    //    agree with the stored certificate_hash, and every lineage column must
    //    match the caller's input.
    if (certRow.certificate_hash !== recomputedHash) {
      throw new Error(
        `saga3: stored certificate hash for settlement ${input.settlementId} disagrees with recomputed hash (co-tamper or version drift)`,
      );
    }
    if (!inserted) {
      // The stored payload must be canonically identical to the freshly built
      // payloadText (catches a reused row whose payload differs from what the
      // caller expects, even if its hash + lineage columns happen to match).
      if (certRow.certificate_payload !== payloadText) {
        throw new Error(
          `saga3: reused certificate payload for settlement ${input.settlementId} does not match the expected canonical payload`,
        );
      }
      // The stored payload's own hash must agree with the stored certificate_hash
      // (independent anchor — catches a payload corrupted without updating hash).
      const storedPayloadHash = createHash('sha256').update(certRow.certificate_payload).digest('hex');
      if (storedPayloadHash !== certRow.certificate_hash) {
        throw new Error(
          `saga3: reused certificate payload hash for settlement ${input.settlementId} does not match stored certificate_hash`,
        );
      }
      // Every certificate row lineage column must match the caller's input.
      const expectedRow: Array<[string, unknown]> = [
        ['epic_id', input.epicId],
        ['proposal_id', input.proposalId],
        ['proposal_content_hash', input.proposalContentHash],
        ['readiness_assessment_id', input.readinessAssessmentId],
        ['readiness_assessment_hash', input.readinessAssessmentHash],
        ['policy_version', input.policyVersion],
        ['policy_hash', input.policyHash],
        ['decision', input.decision],
        ['reason_codes', JSON.stringify(input.reasonCodes)],
        ['input_hash', input.inputHash],
      ];
      for (const [field, expected] of expectedRow) {
        const actual = (certRow as unknown as Record<string, unknown>)[field];
        if (actual !== expected) {
          throw new Error(
            `saga3: reused certificate row for settlement ${input.settlementId} ${field} '${actual}' != expected '${expected}'`,
          );
        }
      }
      // issued_at on a reused row must already equal the deterministic value.
      if (certRow.issued_at !== input.issuedAt) {
        throw new Error(
          `saga3: reused certificate row for settlement ${input.settlementId} issued_at '${certRow.issued_at}' != expected '${input.issuedAt}'`,
        );
      }
    }

    // 4. Transition the settlement to certificate_issued (CAS: computed|failed
    //    -> certificate_issued). Replaying an already-issued settlement is a
    //    no-op success.
    const marked = db.prepare(
      `UPDATE saga3_discovery_settlements
          SET status='certificate_issued'
        WHERE id=? AND status IN ('computed','failed','certificate_issued')`,
    ).run(input.settlementId);
    if (marked.changes === 0 && settlement.status !== 'certificate_issued') {
      // The settlement was in a non-issuable state (e.g. cancelled) — must
      // rollback so we do not leave a certificate without an issued settlement.
      throw new Error(
        `saga3: settlement ${input.settlementId} could not be marked certificate_issued (status='${settlement.status}')`,
      );
    }

    db.exec('COMMIT');
    return { record: certificateRowToRecord(certRow), inserted };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw err;
  }
}

/**
 * ONE ATOMIC reconcile: a certificate row exists but the settlement is still
 * computed/failed (crash between insert and status transition). Inside BEGIN
 * IMMEDIATE: re-verify the FULL settlement lineage against the expected inputs,
 * re-verify the certificate row (canonical payload + its own hash + all lineage
 * columns + expected hash), then transition the settlement to certificate_issued.
 * Closes the same TOCTOU window as issueCertificateAtomically. `input` carries
 * the expected certificate payload + settlement lineage the caller already
 * verified service-side; this re-checks them inside the transaction.
 */
export function reconcileExistingCertificate(
  db: Database.Database,
  input: IssueCertificateAtomicInput,
): OutcomeCertificateRecord {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Re-verify the FULL settlement row lineage inside the tx.
    const settlement = db.prepare(
      'SELECT * FROM saga3_discovery_settlements WHERE id=?',
    ).get(input.settlementId) as SettlementRow | undefined;
    if (!settlement) {
      throw new Error(`saga3: settlement ${input.settlementId} not found for reconcile`);
    }
    const settlementChecks: Array<[string, unknown, unknown]> = [
      ['epic_id', settlement.epic_id, input.epicId],
      ['proposal_id', settlement.proposal_id, input.proposalId],
      ['proposal_content_hash', settlement.proposal_content_hash, input.proposalContentHash],
      ['readiness_assessment_id', settlement.readiness_assessment_id, input.readinessAssessmentId],
      ['readiness_assessment_hash', settlement.readiness_assessment_hash, input.readinessAssessmentHash],
      ['policy_version', settlement.policy_version, input.policyVersion],
      ['policy_hash', settlement.policy_hash, input.policyHash],
      ['decision', settlement.decision, input.decision],
      ['reason_codes', settlement.reason_codes, JSON.stringify(input.reasonCodes)],
      ['input_hash', settlement.input_hash, input.inputHash],
      ['created_at', settlement.created_at, input.issuedAt],
    ];
    for (const [field, actual, expected] of settlementChecks) {
      if (actual !== expected) {
        throw new Error(
          `saga3: settlement ${input.settlementId} ${field} '${actual}' != expected '${expected}' (TOCTOU drift inside reconcile tx)`,
        );
      }
    }
    // P0: bind the reconcile tx to the settlement INPUT SNAPSHOT + rationale too.
    if (settlement.input_snapshot !== input.inputSnapshotText) {
      throw new Error(
        `saga3: settlement ${input.settlementId} input_snapshot does not match the expected canonical snapshot text (TOCTOU drift inside reconcile tx)`,
      );
    }
    const recomputedInputHash = createHash('sha256').update(settlement.input_snapshot).digest('hex');
    if (recomputedInputHash !== input.inputHash) {
      throw new Error(
        `saga3: settlement ${input.settlementId} stored input_snapshot hash does not match input_hash (internally inconsistent)`,
      );
    }
    if (settlement.rationale !== input.rationale) {
      throw new Error(
        `saga3: settlement ${input.settlementId} rationale '${settlement.rationale}' != expected '${input.rationale}' (TOCTOU drift inside reconcile tx)`,
      );
    }
    // 2. Re-verify the certificate row (payload canonical + own hash + lineage).
    const payloadText = canonicalJson(input.certificatePayload);
    const recomputedHash = createHash('sha256').update(payloadText).digest('hex');
    if (recomputedHash !== input.expectedCertificateHash) {
      throw new Error(
        `saga3: certificate hash mismatch for settlement ${input.settlementId} reconcile (caller expected ${input.expectedCertificateHash.slice(0, 12)}, recomputed ${recomputedHash.slice(0, 12)})`,
      );
    }
    const certRow = db.prepare(
      'SELECT * FROM saga3_discovery_outcome_certificates WHERE settlement_id=?',
    ).get(input.settlementId) as CertificateRow | undefined;
    if (!certRow) {
      throw new Error(`saga3: no certificate to reconcile for settlement ${input.settlementId}`);
    }
    if (certRow.certificate_payload !== payloadText) {
      throw new Error(
        `saga3: reconcile certificate payload for settlement ${input.settlementId} does not match expected canonical payload`,
      );
    }
    const storedPayloadHash = createHash('sha256').update(certRow.certificate_payload).digest('hex');
    if (storedPayloadHash !== certRow.certificate_hash) {
      throw new Error(
        `saga3: reconcile certificate payload hash for settlement ${input.settlementId} does not match stored certificate_hash`,
      );
    }
    if (certRow.certificate_hash !== recomputedHash) {
      throw new Error(
        `saga3: reconcile certificate hash for settlement ${input.settlementId} disagrees with recomputed`,
      );
    }
    const rowChecks: Array<[string, unknown]> = [
      ['epic_id', input.epicId],
      ['proposal_id', input.proposalId],
      ['proposal_content_hash', input.proposalContentHash],
      ['readiness_assessment_id', input.readinessAssessmentId],
      ['readiness_assessment_hash', input.readinessAssessmentHash],
      ['policy_version', input.policyVersion],
      ['policy_hash', input.policyHash],
      ['decision', input.decision],
      ['reason_codes', JSON.stringify(input.reasonCodes)],
      ['input_hash', input.inputHash],
      ['issued_at', input.issuedAt],
    ];
    for (const [field, expected] of rowChecks) {
      const actual = (certRow as unknown as Record<string, unknown>)[field];
      if (actual !== expected) {
        throw new Error(
          `saga3: reconcile certificate row for settlement ${input.settlementId} ${field} '${actual}' != expected '${expected}'`,
        );
      }
    }
    // 3. Transition the settlement to certificate_issued (CAS).
    const marked = db.prepare(
      `UPDATE saga3_discovery_settlements
          SET status='certificate_issued'
        WHERE id=? AND status IN ('computed','failed','certificate_issued')`,
    ).run(input.settlementId);
    if (marked.changes === 0 && settlement.status !== 'certificate_issued') {
      throw new Error(
        `saga3: settlement ${input.settlementId} could not be reconciled to certificate_issued (status='${settlement.status}')`,
      );
    }
    db.exec('COMMIT');
    return certificateRowToRecord(certRow);
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw err;
  }
}
