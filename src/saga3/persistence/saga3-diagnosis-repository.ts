/**
 * Persistence for D5 advisory diagnosis.
 *
 * Two durable entities (roadmap D5 §17):
 *   - saga3_discovery_diagnosis_control_intents: the control binding an immutable
 *     certificate TARGET (certificate_id + certificate_hash + diagnosis contract
 *     version) to a bounded diagnosis worker task. Stores the immutable
 *     DiagnosisCase + its hash.
 *   - saga3_discovery_diagnosis_reports: the worker's typed report row, with
 *     payload, content hash, status, validation_errors, separate provenance.
 *
 * Idempotency follows the D3/D4 lesson: the report key is
 * (control_intent_id, content_hash) and is INDEPENDENT of any execution_id. A
 * restart with a new execution reuses the same report row — no duplicate is
 * created for byte-identical content (invariant I7). At most ONE accepted
 * report exists per target (invariant I5, §14): the atomic insert enforces this
 * inside BEGIN IMMEDIATE.
 *
 * The diagnosis is ADVISORY (invariant I6): there is no UPDATE path here that
 * touches the D4 settlement/certificate, the product Proposal, or the readiness
 * assessment. This module is the ONLY place diagnosis persistence touches the
 * DB handle. The diagnosis service and engine never import it directly — they
 * go through the Saga3DiscoveryRuntimePersistence port (Phase B boundary).
 *
 * This module imports only the domain layer, the DB handle, and the shared
 * canonical layer — never the application/engine layer (architecture F10).
 */

import type Database from 'better-sqlite3';

import type {
  DiagnosisControlIntentRecord,
  DiagnosisControlStatus,
  DiagnosisReportRecord,
  DiagnosisReportStatus,
} from '../domain/discovery-diagnosis-records.js';
import { canonicalJson, sha256Hex } from '../shared/discovery-canonical.js';

/**
 * Create the diagnosis control + report tables and indexes. Idempotent. Uses
 * db.exec for the multi-statement DDL (mirrors ensureSaga3SettlementSchema).
 * Safe to call on every runtime construction and at the top of any handler.
 */
export function ensureSaga3DiagnosisSchema(db: Database.Database): void {
  db.exec(`
    -- D5: advisory diagnosis. A diagnosis control binds an immutable certificate
    -- TARGET (certificate_id + certificate_hash + diagnosis contract version) to
    -- a bounded diagnosis worker task. A report row retains the worker's typed
    -- payload, content hash, status, separate provenance. The diagnosis is
    -- ADVISORY — it never mutates the D4 settlement/certificate, the product
    -- Proposal, or the readiness assessment.
    CREATE TABLE IF NOT EXISTS saga3_discovery_diagnosis_control_intents (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      epic_id                     INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      kind                        TEXT NOT NULL DEFAULT 'DiagnoseDiscoveryOutcome',
      certificate_id              INTEGER NOT NULL REFERENCES saga3_discovery_outcome_certificates(id) ON DELETE CASCADE,
      certificate_hash            TEXT NOT NULL,
      settlement_input_hash       TEXT NOT NULL,
      diagnosis_case              TEXT NOT NULL,         -- canonical JSON of the immutable DiagnosisCase
      diagnosis_case_hash         TEXT NOT NULL,         -- SHA-256 over the case (captured_at excluded)
      diagnosis_contract_version  TEXT NOT NULL,
      authority_intent_id         INTEGER NOT NULL REFERENCES saga3_work_intents(id) ON DELETE CASCADE,
      projected_task_id           INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
      status                      TEXT NOT NULL DEFAULT 'open'
                                      CHECK (status IN ('open','executing','paused','concluded','cancelled')),
      created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS saga3_discovery_diagnosis_reports (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      control_intent_id           INTEGER NOT NULL REFERENCES saga3_discovery_diagnosis_control_intents(id) ON DELETE CASCADE,
      certificate_id              INTEGER NOT NULL,
      certificate_hash            TEXT NOT NULL,
      task_id                     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      execution_id                TEXT NOT NULL,
      schema_version              TEXT NOT NULL,
      payload                     TEXT NOT NULL,         -- canonical JSON of the report payload
      content_hash                TEXT NOT NULL,         -- hashDiagnosisReport(payload)
      status                      TEXT NOT NULL DEFAULT 'submitted'
                                      CHECK (status IN ('submitted','accepted_by_kernel','rejected_by_kernel')),
      validation_errors           TEXT NOT NULL DEFAULT '[]',  -- JSON array; durable rejection reasons
      provenance                  TEXT NOT NULL DEFAULT '{}',
      created_at                  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One control per immutable certificate target.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_diagnosis_control_target
      ON saga3_discovery_diagnosis_control_intents(certificate_id, certificate_hash, diagnosis_contract_version);
    CREATE INDEX IF NOT EXISTS idx_saga3_diagnosis_control_epic
      ON saga3_discovery_diagnosis_control_intents(epic_id, status);
    CREATE INDEX IF NOT EXISTS idx_saga3_diagnosis_reports_control
      ON saga3_discovery_diagnosis_reports(control_intent_id);
    -- Idempotency: replaying the same report (same control + content hash) under
    -- a new execution returns the existing row. execution_id is NOT in the key.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_diagnosis_reports_idempotency
      ON saga3_discovery_diagnosis_reports(control_intent_id, content_hash);
  `);
}

// ---------------------------------------------------------------------------
// Control-intent rows
// ---------------------------------------------------------------------------

interface DiagnosisControlRow {
  id: number;
  epic_id: number;
  kind: string;
  certificate_id: number;
  certificate_hash: string;
  settlement_input_hash: string;
  diagnosis_case: string;
  diagnosis_case_hash: string;
  diagnosis_contract_version: string;
  authority_intent_id: number;
  projected_task_id: number | null;
  status: DiagnosisControlStatus;
  created_at: string;
  updated_at: string;
}

function diagnosisControlRowToRecord(row: DiagnosisControlRow): DiagnosisControlIntentRecord {
  return {
    id: row.id,
    epic_id: row.epic_id,
    kind: row.kind,
    certificate_id: row.certificate_id,
    certificate_hash: row.certificate_hash,
    settlement_input_hash: row.settlement_input_hash,
    // diagnosis_case is ALREADY stored as canonical JSON text; no re-parse
    // needed — the record surfaces it as text so callers hash it byte-identically.
    diagnosis_case: row.diagnosis_case,
    diagnosis_case_hash: row.diagnosis_case_hash,
    diagnosis_contract_version: row.diagnosis_contract_version,
    authority_intent_id: row.authority_intent_id,
    projected_task_id: row.projected_task_id,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Find the latest control for an immutable certificate target, or null. */
export function findDiagnosisControlByTarget(
  db: Database.Database,
  certificateId: number,
  certificateHash: string,
): DiagnosisControlIntentRecord | null {
  const row = db.prepare(
    `SELECT * FROM saga3_discovery_diagnosis_control_intents
      WHERE certificate_id=? AND certificate_hash=?
      ORDER BY id DESC LIMIT 1`,
  ).get(certificateId, certificateHash) as DiagnosisControlRow | undefined;
  return row ? diagnosisControlRowToRecord(row) : null;
}

/** Read a control by id, or null. */
export function readDiagnosisControlById(
  db: Database.Database,
  controlIntentId: number,
): DiagnosisControlIntentRecord | null {
  const row = db.prepare(
    'SELECT * FROM saga3_discovery_diagnosis_control_intents WHERE id=?',
  ).get(controlIntentId) as DiagnosisControlRow | undefined;
  return row ? diagnosisControlRowToRecord(row) : null;
}

// ---------------------------------------------------------------------------
// Report rows
// ---------------------------------------------------------------------------

interface DiagnosisReportRow {
  id: number;
  control_intent_id: number;
  certificate_id: number;
  certificate_hash: string;
  task_id: number;
  execution_id: string;
  schema_version: string;
  payload: string;
  content_hash: string;
  status: DiagnosisReportStatus;
  validation_errors: string;
  provenance: string;
  created_at: string;
}

function diagnosisReportRowToRecord(row: DiagnosisReportRow): DiagnosisReportRecord {
  return {
    id: row.id,
    control_intent_id: row.control_intent_id,
    certificate_id: row.certificate_id,
    certificate_hash: row.certificate_hash,
    task_id: row.task_id,
    execution_id: row.execution_id,
    schema_version: row.schema_version,
    payload: JSON.parse(row.payload),
    content_hash: row.content_hash,
    status: row.status,
    validation_errors: JSON.parse(row.validation_errors ?? '[]') as string[],
    provenance: JSON.parse(row.provenance ?? '{}'),
    created_at: row.created_at,
  };
}

/** The accepted_by_kernel report for a control, or null (at most one exists). */
export function readAcceptedDiagnosisReportForControl(
  db: Database.Database,
  controlIntentId: number,
): DiagnosisReportRecord | null {
  const row = db.prepare(
    `SELECT * FROM saga3_discovery_diagnosis_reports
      WHERE control_intent_id=? AND status='accepted_by_kernel'
      LIMIT 1`,
  ).get(controlIntentId) as DiagnosisReportRow | undefined;
  return row ? diagnosisReportRowToRecord(row) : null;
}

/** Latest report (any status) for a control, ordered by id DESC, or null. */
export function readLatestDiagnosisReportForControl(
  db: Database.Database,
  controlIntentId: number,
): DiagnosisReportRecord | null {
  const row = db.prepare(
    `SELECT * FROM saga3_discovery_diagnosis_reports
      WHERE control_intent_id=?
      ORDER BY id DESC LIMIT 1`,
  ).get(controlIntentId) as DiagnosisReportRow | undefined;
  return row ? diagnosisReportRowToRecord(row) : null;
}

// ---------------------------------------------------------------------------
// Atomic report insert (the critical op)
// ---------------------------------------------------------------------------

/** Inputs to the atomic report-insert operation (mirrors the port type). */
export interface InsertDiagnosisReportInput {
  controlIntentId: number;
  certificateId: number;
  certificateHash: string;
  settlementInputHash: string;
  /** The certificate's decision, surfaced for target-lineage re-verification. */
  decision: 'go' | 'clarify' | 'reject';
  taskId: number;
  executionId: string;
  schemaVersion: string;
  /** Parsed report payload object; stored as canonical JSON. */
  payload: unknown;
  /** SHA-256 over canonicalJson(payload); recomputed inside the tx. */
  expectedContentHash: string;
  status: 'accepted_by_kernel' | 'rejected_by_kernel';
  validationErrors: string[];
  provenance: unknown;
}

/**
 * ONE ATOMIC operation (BEGIN IMMEDIATE): insert a diagnosis report and
 * transition it to accepted/rejected. Mirrors issueCertificateAtomically in the
 * settlement repo (raw db.exec('BEGIN IMMEDIATE') / COMMIT / ROLLBACK — the
 * forked better-sqlite3 types do not support the mode arg on db.transaction).
 *
 * Steps:
 *  1. Re-read the control row; verify certificate_id, certificate_hash,
 *     settlement_input_hash are UNCHANGED vs input (TOCTOU closure). Throw if
 *     mismatched.
 *  2. Try to find an existing report by (control_intent_id, content_hash). If
 *     found, return it {record, inserted:false, replayed:true} (idempotent —
 *     same content under a new execution reuses the row).
 *  3. INSERT the report row with status='submitted', content_hash=
 *     expectedContentHash, validation_errors + provenance + payload as canonical
 *     JSON text.
 *  4. Verify the stored payload hashes to expectedContentHash AND to the stored
 *     content_hash (co-tamper detection): sha256Hex(payload) must equal
 *     expectedContentHash AND the stored content_hash. If not, ROLLBACK + throw.
 *  5. Transition status to input.status (accepted_by_kernel or
 *     rejected_by_kernel) via UPDATE WHERE id=?.
 *  6. If input.status='accepted_by_kernel': enforce at-most-one-accepted —
 *     check no other accepted report exists for this control
 *     (SELECT id WHERE control_intent_id=? AND status='accepted_by_kernel'
 *     AND id != newId). If one exists, ROLLBACK + throw.
 *  7. COMMIT. Return {record, inserted:true, replayed:false}.
 *
 * On ANY throw: ROLLBACK + rethrow.
 */
export function insertDiagnosisReportAtomically(
  db: Database.Database,
  input: InsertDiagnosisReportInput,
): { record: DiagnosisReportRecord; inserted: boolean; replayed: boolean } {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Re-read the control row and verify its target lineage is UNCHANGED.
    //    This closes the TOCTOU window between the service-level validation and
    //    BEGIN IMMEDIATE: another writer could have changed the control's
    //    certificate_id / certificate_hash / settlement_input_hash after the
    //    service verified it. The atomic boundary must re-confirm the target.
    const control = db.prepare(
      'SELECT * FROM saga3_discovery_diagnosis_control_intents WHERE id=?',
    ).get(input.controlIntentId) as DiagnosisControlRow | undefined;
    if (!control) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} not found for report insert`,
      );
    }
    const controlChecks: Array<[string, unknown, unknown]> = [
      ['certificate_id', control.certificate_id, input.certificateId],
      ['certificate_hash', control.certificate_hash, input.certificateHash],
      ['settlement_input_hash', control.settlement_input_hash, input.settlementInputHash],
    ];
    for (const [field, actual, expected] of controlChecks) {
      if (actual !== expected) {
        throw new Error(
          `saga3: diagnosis control ${input.controlIntentId} ${field} '${actual}' != expected '${expected}' (TOCTOU drift inside atomic report tx)`,
        );
      }
    }

    // 2. Idempotency: replaying the same report (same control + content_hash)
    //    under a new execution returns the existing row (execution_id is NOT in
    //    the key). The stored row's status + payload are NOT overwritten — a
    //    replayed report keeps its original verdict (deterministic by construction).
    const existing = db.prepare(
      `SELECT * FROM saga3_discovery_diagnosis_reports
        WHERE control_intent_id=? AND content_hash=? LIMIT 1`,
    ).get(input.controlIntentId, input.expectedContentHash) as
      | DiagnosisReportRow
      | undefined;
    if (existing) {
      // Co-tamper guard on the replayed row: the stored payload must hash to the
      // stored content_hash (independent anchor). A concurrent writer could have
      // inserted a row with the right content_hash key but a corrupted payload.
      const storedPayloadHash = sha256Hex(JSON.parse(existing.payload));
      if (storedPayloadHash !== existing.content_hash) {
        throw new Error(
          `saga3: replayed diagnosis report ${existing.id} payload hash does not match stored content_hash (co-tamper or corruption)`,
        );
      }
      db.exec('COMMIT');
      return { record: diagnosisReportRowToRecord(existing), inserted: false, replayed: true };
    }

    // 3. INSERT the report row with status='submitted'. payload + provenance are
    //    canonicalized so the stored text hashes deterministically.
    const payloadText = canonicalJson(input.payload);
    const validationErrorsText = JSON.stringify(input.validationErrors);
    const provenanceText = canonicalJson(input.provenance);
    const insertInfo = db.prepare(
      `INSERT INTO saga3_discovery_diagnosis_reports
         (control_intent_id, certificate_id, certificate_hash, task_id,
          execution_id, schema_version, payload, content_hash, status,
          validation_errors, provenance)
       VALUES (?,?,?,?,?,?,?,?,'submitted',?,?)`,
    ).run(
      input.controlIntentId,
      input.certificateId,
      input.certificateHash,
      input.taskId,
      input.executionId,
      input.schemaVersion,
      payloadText,
      input.expectedContentHash,
      validationErrorsText,
      provenanceText,
    );
    const newId = Number(insertInfo.lastInsertRowid);

    // 4. Co-tamper detection: recompute the hash from the parsed payload and
    //    require it to equal BOTH the caller's expectedContentHash AND the stored
    //    content_hash. A payload+hash changed together to agree with each other
    //    but not with our recomputation is caught here. (The stored content_hash
    //    column == input.expectedContentHash by the INSERT above, so the two
    //    comparisons collapse to one recompute + one equality, but we check both
    //    explicitly to document the independent anchors.)
    const recomputedHash = sha256Hex(input.payload);
    if (recomputedHash !== input.expectedContentHash) {
      throw new Error(
        `saga3: diagnosis report payload hash mismatch for control ${input.controlIntentId} (caller expected ${input.expectedContentHash.slice(0, 12)}, recomputed ${recomputedHash.slice(0, 12)})`,
      );
    }
    const newReport = db.prepare(
      'SELECT * FROM saga3_discovery_diagnosis_reports WHERE id=?',
    ).get(newId) as DiagnosisReportRow | undefined;
    if (!newReport) {
      throw new Error(`saga3: diagnosis report ${newId} vanished after insert`);
    }
    if (newReport.content_hash !== recomputedHash) {
      throw new Error(
        `saga3: stored diagnosis report ${newId} content_hash disagrees with recomputed hash (co-tamper or version drift)`,
      );
    }

    // 5. Transition status to the verdict the service computed via the validator.
    //    accepted_by_kernel on a valid report, rejected_by_kernel on an invalid
    //    one (durable audit row). A submitted row that fails validation is still
    //    persisted as rejected_by_kernel — it is NOT deleted.
    db.prepare(
      `UPDATE saga3_discovery_diagnosis_reports SET status=? WHERE id=?`,
    ).run(input.status, newId);

    // 6. At-most-one-accepted: there is at most ONE accepted report per target.
    //    Enforced inside the tx so a concurrent accepted-insert cannot land two.
    //    The UNIQUE idempotency index is on (control_intent_id, content_hash),
    //    which does NOT prevent a SECOND accepted row with a different hash —
    //    this check closes that gap. A second accepted attempt must ROLLBACK.
    if (input.status === 'accepted_by_kernel') {
      const other = db.prepare(
        `SELECT id FROM saga3_discovery_diagnosis_reports
          WHERE control_intent_id=? AND status='accepted_by_kernel' AND id != ? LIMIT 1`,
      ).get(input.controlIntentId, newId) as { id: number } | undefined;
      if (other) {
        throw new Error(
          `saga3: diagnosis control ${input.controlIntentId} already has an accepted report ${other.id}; a second accepted report is not allowed (at-most-one-accepted)`,
        );
      }
    }

    // 7. COMMIT + return the final record (re-read so status reflects the verdict).
    db.exec('COMMIT');
    const finalRow = db.prepare(
      'SELECT * FROM saga3_discovery_diagnosis_reports WHERE id=?',
    ).get(newId) as DiagnosisReportRow;
    return { record: diagnosisReportRowToRecord(finalRow), inserted: true, replayed: false };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    throw err;
  }
}
