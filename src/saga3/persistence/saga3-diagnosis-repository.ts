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

import {
  DIAGNOSE_DISCOVERY_OUTCOME_KIND,
  DISCOVERY_DIAGNOSIS_INTENT_KIND,
  DISCOVERY_DIAGNOSIS_WORK_INTENT_SCHEMA,
} from '../../shared/work-intent.js';
import type {
  DiagnosisControlIntentRecord,
  DiagnosisControlStatus,
  DiagnosisReportRecord,
  DiagnosisReportStatus,
} from '../domain/discovery-diagnosis-records.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import {
  diagnosisCaseHash,
  DISCOVERY_DIAGNOSIS_CASE_SCHEMA,
} from '../domain/discovery-diagnosis-case.js';
import { validateDiagnosisReport } from '../domain/discovery-diagnosis-validator.js';
import { DISCOVERY_DIAGNOSIS_REPORT_SCHEMA } from '../domain/discovery-diagnosis-report.js';

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
    -- P0-2: at-most-one accepted report per control. The runtime at-most-one
    -- check lives inside BEGIN IMMEDIATE in submitDiagnosisReportAtomically; this
    -- partial unique index is a STRUCTURAL second line of defence so the DB itself
    -- guarantees the invariant even if a future writer bypasses the repo function.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_diagnosis_reports_one_accepted
      ON saga3_discovery_diagnosis_reports(control_intent_id) WHERE status='accepted_by_kernel';
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

/**
 * Inputs to the atomic report-submit operation (P0-1). The caller (handler)
 * supplies ONLY the worker's payload + provenance + execution identity — it
 * does NOT supply the verdict (accepted/rejected) or validation errors. The
 * repository DERIVES the verdict inside BEGIN IMMEDIATE from the FROZEN stored
 * DiagnosisCase, so a handler can never declare a report accepted.
 */
export interface SubmitDiagnosisReportInput {
  controlIntentId: number;
  /** The worker execution submitting this report (for provenance; NOT in the uniqueness key). */
  executionId: string;
  /** The worker's proposed report payload object. */
  payload: unknown;
  /** Provenance captured from the execution (model/provider/worker/exec/time). */
  provenance: unknown;
}

/**
 * ONE ATOMIC operation (BEGIN IMMEDIATE): accept a diagnosis report submission
 * and DERIVE its verdict internally. The handler cannot tell the repository that
 * a report is accepted — the repository re-reads the frozen DiagnosisCase inside
 * the transaction, verifies it has not drifted, and runs the deterministic
 * validator itself (P0-1).
 *
 * Steps inside BEGIN IMMEDIATE:
 *  1. Re-read the FULL control row. Verify it is in an active lifecycle status
 *     (open/executing/paused) — a concluded/cancelled control cannot accept a
 *     report.
 *  2. Parse the stored DiagnosisCase (frozen at control-creation time). Verify
 *     schema_version + that the case's certificate tuple (id/hash/input_hash/
 *     decision) agrees with the control row's certificate_id/hash/
 *     settlement_input_hash. Recompute diagnosis_case_hash from the stored case
 *     and require it to equal the control's diagnosis_case_hash. This closes the
 *     attack where diagnosis_case (e.g. allowed_source_refs) is tampered while
 *     the hash is left unchanged: the recomputed hash will not match.
 *  3. Idempotency: replaying the same payload (same control + content_hash) under
 *     a new execution returns the existing row verbatim (execution_id is NOT in
 *     the uniqueness key). The replayed row is re-verified (payload hashes to
 *     its content_hash) before returning.
 *  4. Recompute the report content hash from the payload; INSERT the row as
 *     'submitted'.
 *  5. DERIVE the verdict: run validateDiagnosisReport(payload, storedCase). On
 *     valid -> 'accepted_by_kernel' with empty errors; on invalid ->
 *     'rejected_by_kernel' with the validation errors. (A rejected report is
 *     still persisted — durable audit; a mute rejection is impossible because an
 *     invalid payload always yields >=1 error.)
 *  6. At-most-one-accepted: if the verdict is accepted, ensure no other accepted
 *     report exists for this control.
 *  7. Transition the row to the derived verdict. COMMIT. Return the record.
 *
 * On ANY throw: ROLLBACK + rethrow.
 */
export function submitDiagnosisReportAtomically(
  db: Database.Database,
  input: SubmitDiagnosisReportInput,
): { record: DiagnosisReportRecord; inserted: boolean; replayed: boolean } {
  db.exec('BEGIN IMMEDIATE');
  try {
    // 1. Re-read the FULL control row inside the tx.
    const control = db.prepare(
      'SELECT * FROM saga3_discovery_diagnosis_control_intents WHERE id=?',
    ).get(input.controlIntentId) as DiagnosisControlRow | undefined;
    if (!control) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} not found for report submit`,
      );
    }
    // A control not in an active lifecycle cannot accept a report.
    if (control.status !== 'open' && control.status !== 'executing' && control.status !== 'paused') {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} status '${control.status}' is not active (cannot accept a report)`,
      );
    }
    if (control.projected_task_id === null) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} has no projected_task_id`,
      );
    }
    if (control.kind !== DIAGNOSE_DISCOVERY_OUTCOME_KIND) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} kind '${control.kind}' is not '${DIAGNOSE_DISCOVERY_OUTCOME_KIND}'`,
      );
    }

    // Independent task + authority anchors. The task metadata is frozen when
    // the ControlIntent is projected and is checked inside the same transaction
    // as report validation. A coherent case+hash rewrite on the control row
    // therefore cannot silently expand the evidence allowlist.
    const task = db.prepare(
      `SELECT id, epic_id, task_kind, metadata FROM tasks WHERE id=?`,
    ).get(control.projected_task_id) as
      | { id: number; epic_id: number; task_kind: string; metadata: string }
      | undefined;
    if (!task) {
      throw new Error(`saga3: diagnosis projected task ${control.projected_task_id} not found`);
    }
    let taskMetadata: Record<string, unknown>;
    try {
      taskMetadata = JSON.parse(task.metadata ?? '{}') as Record<string, unknown>;
    } catch {
      throw new Error(`saga3: diagnosis projected task ${task.id} metadata is not valid JSON`);
    }
    const taskChecks: Array<[string, unknown, unknown]> = [
      ['epic_id', task.epic_id, control.epic_id],
      ['task_kind', task.task_kind, 'discovery.diagnose'],
      ['metadata.work_intent_id', taskMetadata.work_intent_id, control.authority_intent_id],
      ['metadata.control_intent_id', taskMetadata.control_intent_id, control.id],
      ['metadata.certificate_id', taskMetadata.certificate_id, control.certificate_id],
      ['metadata.certificate_hash', taskMetadata.certificate_hash, control.certificate_hash],
      ['metadata.settlement_input_hash', taskMetadata.settlement_input_hash, control.settlement_input_hash],
      ['metadata.diagnosis_case_hash', taskMetadata.diagnosis_case_hash, control.diagnosis_case_hash],
      ['metadata.diagnosis_contract_version', taskMetadata.diagnosis_contract_version, control.diagnosis_contract_version],
    ];
    for (const [field, actual, expected] of taskChecks) {
      if (actual !== expected) {
        throw new Error(
          `saga3: diagnosis task ${task.id} ${field} '${String(actual)}' != control anchor '${String(expected)}'`,
        );
      }
    }
    const authority = db.prepare(
      `SELECT id, epic_id, kind, output_schema, projected_task_id, status
         FROM saga3_work_intents WHERE id=?`,
    ).get(control.authority_intent_id) as
      | { id: number; epic_id: number; kind: string; output_schema: string; projected_task_id: number | null; status: string }
      | undefined;
    if (!authority) {
      throw new Error(`saga3: diagnosis authority WorkIntent ${control.authority_intent_id} not found`);
    }
    const authorityChecks: Array<[string, unknown, unknown]> = [
      ['epic_id', authority.epic_id, control.epic_id],
      ['kind', authority.kind, DISCOVERY_DIAGNOSIS_INTENT_KIND],
      ['output_schema', authority.output_schema, DISCOVERY_DIAGNOSIS_WORK_INTENT_SCHEMA],
      ['projected_task_id', authority.projected_task_id, control.projected_task_id],
    ];
    for (const [field, actual, expected] of authorityChecks) {
      if (actual !== expected) {
        throw new Error(
          `saga3: diagnosis authority WorkIntent ${authority.id} ${field} '${String(actual)}' != expected '${String(expected)}'`,
        );
      }
    }
    if (!['open', 'executing', 'paused'].includes(authority.status)) {
      throw new Error(
        `saga3: diagnosis authority WorkIntent ${authority.id} status '${authority.status}' is not active`,
      );
    }

    // 2. Parse the frozen DiagnosisCase and verify it has not drifted.
    let storedCase: unknown;
    try {
      storedCase = JSON.parse(control.diagnosis_case);
    } catch {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} diagnosis_case is not valid JSON`,
      );
    }
    // Recompute the case hash from the stored case text (captured_at excluded by
    // diagnosisCaseHash) and require it to equal the control's recorded hash. A
    // tampered case (e.g. allowed_source_refs expanded) with the original hash
    // left in place is caught here.
    const recomputedCaseHash = diagnosisCaseHash(storedCase as Parameters<typeof diagnosisCaseHash>[0]);
    if (recomputedCaseHash !== control.diagnosis_case_hash) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} diagnosis_case_hash does not match a recomputation of the stored case (tampered case)`,
      );
    }
    // Verify the contract version the control was built under.
    if (control.diagnosis_contract_version !== DISCOVERY_DIAGNOSIS_REPORT_SCHEMA) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} contract version '${control.diagnosis_contract_version}' is not '${DISCOVERY_DIAGNOSIS_REPORT_SCHEMA}'`,
      );
    }
    const structuralCase = storedCase as {
      schema_version?: unknown;
      epic_id?: unknown;
      decision?: unknown;
      certificate?: { id?: unknown; hash?: unknown; settlement_input_hash?: unknown; decision?: unknown };
    };
    if (structuralCase.schema_version !== DISCOVERY_DIAGNOSIS_CASE_SCHEMA) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} case schema '${String(structuralCase.schema_version)}' is not '${DISCOVERY_DIAGNOSIS_CASE_SCHEMA}'`,
      );
    }
    if (structuralCase.epic_id !== control.epic_id) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} case epic_id '${String(structuralCase.epic_id)}' does not match control epic_id '${control.epic_id}'`,
      );
    }
    if (structuralCase.decision !== structuralCase.certificate?.decision) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} case decision does not match its certificate decision`,
      );
    }
    // Verify the case's certificate tuple agrees with the control row. The case
    // was frozen from the verified certificate bundle; if the control's cert
    // target drifted (TOCTOU), this rejects.
    const caseObj = structuralCase;
    if (caseObj.certificate?.id !== control.certificate_id
        || caseObj.certificate?.hash !== control.certificate_hash
        || caseObj.certificate?.settlement_input_hash !== control.settlement_input_hash) {
      throw new Error(
        `saga3: diagnosis control ${input.controlIntentId} case certificate tuple does not match the control target`,
      );
    }

    // 3. Idempotency: replaying the same payload under a new execution returns
    //    the existing row. Recompute the content hash from the payload (the
    //    authoritative key — the worker submits a payload, not a hash).
    const payloadHash = sha256Hex(input.payload);
    const existing = db.prepare(
      `SELECT * FROM saga3_discovery_diagnosis_reports
        WHERE control_intent_id=? AND content_hash=? LIMIT 1`,
    ).get(input.controlIntentId, payloadHash) as DiagnosisReportRow | undefined;
    if (existing) {
      // P0-2: a replay is not trusted merely because its payload and hash agree.
      // Re-verify the complete stored row against the currently verified frozen
      // case before returning it. This catches coherent payload+hash tamper and
      // verdict/status drift on restart/idempotent resubmission.
      let storedPayload: unknown;
      try {
        storedPayload = JSON.parse(existing.payload);
      } catch {
        throw new Error(`saga3: replayed diagnosis report ${existing.id} payload is not valid JSON`);
      }
      const storedPayloadHash = sha256Hex(storedPayload);
      if (storedPayloadHash !== existing.content_hash || existing.content_hash !== payloadHash) {
        throw new Error(
          `saga3: replayed diagnosis report ${existing.id} payload hash does not match stored/content replay hash (co-tamper or corruption)`,
        );
      }
      if (existing.control_intent_id !== control.id
          || existing.certificate_id !== control.certificate_id
          || existing.certificate_hash !== control.certificate_hash
          || existing.task_id !== control.projected_task_id
          || existing.schema_version !== DISCOVERY_DIAGNOSIS_REPORT_SCHEMA) {
        throw new Error(
          `saga3: replayed diagnosis report ${existing.id} row binding drifted from its control`,
        );
      }
      const replayValidation = validateDiagnosisReport(
        storedPayload,
        storedCase as Parameters<typeof validateDiagnosisReport>[1],
      );
      const derivedStatus: DiagnosisReportStatus = replayValidation.valid
        ? 'accepted_by_kernel'
        : 'rejected_by_kernel';
      const storedErrors = JSON.parse(existing.validation_errors ?? '[]') as unknown;
      if (!Array.isArray(storedErrors)) {
        throw new Error(`saga3: replayed diagnosis report ${existing.id} validation_errors is not an array`);
      }
      if (existing.status !== derivedStatus) {
        throw new Error(
          `saga3: replayed diagnosis report ${existing.id} verdict drift: stored '${existing.status}', derived '${derivedStatus}'`,
        );
      }
      if (derivedStatus === 'accepted_by_kernel' && storedErrors.length !== 0) {
        throw new Error(
          `saga3: replayed accepted diagnosis report ${existing.id} has non-empty validation_errors`,
        );
      }
      if (derivedStatus === 'rejected_by_kernel'
          && canonicalJson(storedErrors) !== canonicalJson(replayValidation.errors)) {
        throw new Error(
          `saga3: replayed rejected diagnosis report ${existing.id} validation errors drifted from deterministic validation`,
        );
      }
      db.exec('COMMIT');
      return { record: diagnosisReportRowToRecord(existing), inserted: false, replayed: true };
    }

    // 4. INSERT the row as 'submitted'. The content_hash is the recomputed
    //    payloadHash (the repository owns it — the caller never supplies a hash).
    const payloadText = canonicalJson(input.payload);
    const provenanceText = canonicalJson(input.provenance);
    const insertInfo = db.prepare(
      `INSERT INTO saga3_discovery_diagnosis_reports
         (control_intent_id, certificate_id, certificate_hash, task_id,
          execution_id, schema_version, payload, content_hash, status,
          validation_errors, provenance)
       VALUES (?,?,?,?,?,?,?,?,'submitted','[]',?)`,
    ).run(
      input.controlIntentId,
      control.certificate_id,
      control.certificate_hash,
      control.projected_task_id,
      input.executionId,
      DISCOVERY_DIAGNOSIS_REPORT_SCHEMA,
      payloadText,
      payloadHash,
      provenanceText,
    );
    const newId = Number(insertInfo.lastInsertRowid);

    // 5. DERIVE the verdict from the FROZEN stored case. The repository decides
    //    accepted vs rejected; the handler cannot influence it.
    const validation = validateDiagnosisReport(input.payload, storedCase as Parameters<typeof validateDiagnosisReport>[1]);
    const status: DiagnosisReportStatus = validation.valid ? 'accepted_by_kernel' : 'rejected_by_kernel';
    const validationErrors = validation.errors; // >=1 when invalid by construction

    // 6. At-most-one-accepted (checked before the verdict transition commits).
    if (status === 'accepted_by_kernel') {
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

    // 7. Transition to the derived verdict + commit.
    db.prepare(
      `UPDATE saga3_discovery_diagnosis_reports SET status=?, validation_errors=? WHERE id=?`,
    ).run(status, JSON.stringify(validationErrors), newId);

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
