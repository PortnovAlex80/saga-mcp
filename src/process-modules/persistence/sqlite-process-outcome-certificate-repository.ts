/**
 * SQLite implementation of ProcessOutcomeCertificateRepository.
 *
 * Schema lives in saga3_process_outcome_certificates. The table is generic —
 * any Process Module can write here. Discovery's existing D4 certificates stay
 * in saga3_discovery_outcome_certificates and are projected through this shape
 * by a P3b adapter; they are NOT migrated. Formalization (P4) is the first
 * module to write here directly.
 *
 * Write-once semantics:
 *   - certificate_hash is UNIQUE. Re-inserting the same hash returns the
 *     existing row (idempotent replay).
 *   - process_run_id is UNIQUE among issued certificates. A second insert with
 *     a DIFFERENT hash for the same process_run_id throws
 *     PROCESS_RUN_ALREADY_CERTIFIED — a ProcessRun gets exactly one
 *     authoritative result, and that result is immutable.
 *
 * The SELECT-then-INSERT pattern (instead of ON CONFLICT DO NOTHING) lets us
 * distinguish the three cases: (a) brand-new hash → insert, (b) same hash
 * existing → replay, (c) different hash for same run → domain violation.
 */

import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { getDb } from '../../db.js';
import { canonicalJson } from '../../saga3/shared/discovery-canonical.js';
import {
  processModuleKey,
  type ProcessModuleReference,
} from '../domain/process-module.js';
import type { ProcessOutcomeCertificateRepository } from './process-outcome-certificate-repository.js';
import type {
  IssueProcessOutcomeCertificateCommand,
  ProcessOutcomeCertificate,
  ProcessOutcomeCertificatePayload,
} from './process-outcome-certificate.js';

export function ensureSaga3ProcessOutcomeCertificateSchema(db: Database.Database): void {
  db.exec(`
    -- Generic authoritative outcome certificate. One per ProcessRun. Lives
    -- alongside module-specific state (Discovery D4 stays in its own table and
    -- is projected via a P3b adapter; Formalization and later modules write
    -- here directly).
    CREATE TABLE IF NOT EXISTS saga3_process_outcome_certificates (
      id                          INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id              INTEGER NOT NULL REFERENCES saga3_process_runs(id) ON DELETE CASCADE,
      project_id                  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      epic_id                     INTEGER,                            -- nullable: project-wide run
      module_name                 TEXT NOT NULL,
      module_version              TEXT NOT NULL,
      module_ref_key              TEXT NOT NULL,
      schema_version              TEXT NOT NULL,
      decision                    TEXT NOT NULL,                      -- one of the module's terminal outcomes
      reason_codes                TEXT NOT NULL DEFAULT '[]',         -- JSON array of stable codes
      rationale                   TEXT NOT NULL,
      input_hash                  TEXT NOT NULL,                      -- pins the immutable input target
      certificate_payload         TEXT NOT NULL,                      -- canonical JSON of payload
      certificate_hash            TEXT NOT NULL UNIQUE,               -- write-once integrity check
      authority                   TEXT NOT NULL,                      -- who/what issued this certificate
      issued_at                   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One certificate per ProcessRun. A second certificate for the same run
    -- must carry the SAME hash (idempotent replay); a different hash is
    -- rejected in code with PROCESS_RUN_ALREADY_CERTIFIED.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_poc_process_run
      ON saga3_process_outcome_certificates(process_run_id);

    -- Lookups by project + epic.
    CREATE INDEX IF NOT EXISTS idx_saga3_poc_project
      ON saga3_process_outcome_certificates(project_id, epic_id);

    -- Lookups by module ref (conformance queries, replay checks).
    CREATE INDEX IF NOT EXISTS idx_saga3_poc_module
      ON saga3_process_outcome_certificates(module_ref_key, project_id);
  `);
}

interface CertificateRow {
  id: number;
  process_run_id: number;
  project_id: number;
  epic_id: number | null;
  module_name: string;
  module_version: string;
  module_ref_key: string;
  schema_version: string;
  decision: string;
  reason_codes: string;
  rationale: string;
  input_hash: string;
  certificate_payload: string;
  certificate_hash: string;
  authority: string;
  issued_at: string;
}

function rowToCertificate(row: CertificateRow): ProcessOutcomeCertificate {
  const moduleRef: ProcessModuleReference = {
    name: row.module_name,
    version: row.module_version,
  };
  const payload = JSON.parse(row.certificate_payload) as ProcessOutcomeCertificatePayload;
  return {
    id: row.id,
    processRunId: row.process_run_id,
    moduleRef,
    moduleRefKey: row.module_ref_key,
    projectId: row.project_id,
    epicId: row.epic_id,
    schemaVersion: row.schema_version,
    decision: row.decision,
    reasonCodes: JSON.parse(row.reason_codes ?? '[]') as readonly string[],
    rationale: row.rationale,
    inputHash: row.input_hash,
    certificatePayload: payload,
    certificateHash: row.certificate_hash,
    authority: row.authority,
    issuedAt: row.issued_at,
  };
}

function readRowById(db: Database.Database, id: number): CertificateRow | null {
  const row = db.prepare('SELECT * FROM saga3_process_outcome_certificates WHERE id=?')
    .get(id) as CertificateRow | undefined;
  return row ?? null;
}

export class SqliteProcessOutcomeCertificateRepository implements ProcessOutcomeCertificateRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureSaga3ProcessOutcomeCertificateSchema(this.db);
  }

  issue(
    command: IssueProcessOutcomeCertificateCommand,
  ): { record: ProcessOutcomeCertificate; replayed: boolean } {
    const moduleRefKey = processModuleKey(command.moduleRef);
    const payloadText = canonicalJson(command.payload);

    // Idempotency: check for an existing certificate for this process_run_id.
    const existing = this.db.prepare(
      'SELECT * FROM saga3_process_outcome_certificates WHERE process_run_id=?',
    ).get(command.processRunId) as CertificateRow | undefined;

    if (existing) {
      if (existing.certificate_hash !== command.certificateHash) {
        throw new Error(
          `PROCESS_RUN_ALREADY_CERTIFIED: process_run ${command.processRunId} already has `
          + `certificate hash '${existing.certificate_hash}' (decision='${existing.decision}'); `
          + `received '${command.certificateHash}'. A ProcessRun gets exactly one immutable certificate.`,
        );
      }
      return { record: rowToCertificate(existing), replayed: true };
    }

    const info = this.db.prepare(
      `INSERT INTO saga3_process_outcome_certificates
         (process_run_id, project_id, epic_id, module_name, module_version,
          module_ref_key, schema_version, decision, reason_codes, rationale,
          input_hash, certificate_payload, certificate_hash, authority)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      command.processRunId,
      command.projectId,
      command.epicId,
      command.moduleRef.name,
      command.moduleRef.version,
      moduleRefKey,
      command.payload.schemaVersion,
      command.payload.decision,
      JSON.stringify(command.payload.reasonCodes),
      command.payload.rationale,
      command.payload.inputHash,
      payloadText,
      command.certificateHash,
      command.authority,
    );
    const row = readRowById(this.db, Number(info.lastInsertRowid));
    if (!row) throw new Error('saga3: process_outcome_certificate vanished after insert');
    return { record: rowToCertificate(row), replayed: false };
  }

  read(id: number): ProcessOutcomeCertificate | null {
    const row = readRowById(this.db, id);
    return row ? rowToCertificate(row) : null;
  }

  readByProcessRun(processRunId: number): ProcessOutcomeCertificate | null {
    const row = this.db.prepare(
      'SELECT * FROM saga3_process_outcome_certificates WHERE process_run_id=?',
    ).get(processRunId) as CertificateRow | undefined;
    return row ? rowToCertificate(row) : null;
  }

  readByHash(certificateHash: string): ProcessOutcomeCertificate | null {
    const row = this.db.prepare(
      'SELECT * FROM saga3_process_outcome_certificates WHERE certificate_hash=?',
    ).get(certificateHash) as CertificateRow | undefined;
    return row ? rowToCertificate(row) : null;
  }

  list(projectId: number, epicId: number | null): readonly ProcessOutcomeCertificate[] {
    const rows = epicId === null
      ? this.db.prepare(
          'SELECT * FROM saga3_process_outcome_certificates WHERE project_id=? ORDER BY id DESC',
        ).all(projectId) as CertificateRow[]
      : this.db.prepare(
          'SELECT * FROM saga3_process_outcome_certificates WHERE project_id=? AND epic_id=? ORDER BY id DESC',
        ).all(projectId, epicId) as CertificateRow[];
    return rows.map(rowToCertificate);
  }

  readByModuleRun(
    projectId: number,
    moduleRef: ProcessModuleReference,
    processRunId: number,
  ): ProcessOutcomeCertificate | null {
    const row = this.db.prepare(
      `SELECT * FROM saga3_process_outcome_certificates
        WHERE project_id=? AND module_ref_key=? AND process_run_id=?`,
    ).get(projectId, processModuleKey(moduleRef), processRunId) as CertificateRow | undefined;
    return row ? rowToCertificate(row) : null;
  }
}

/**
 * Convenience: hash a ProcessOutcomeCertificatePayload the same way the SQLite
 * layer does. Callers use this to compute the certificateHash they pass to
 * issue(). Mirrors hashCertificate from the discovery settlement repo.
 */
export function hashProcessOutcomeCertificatePayload(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}
