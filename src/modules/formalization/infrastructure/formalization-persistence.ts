import type Database from 'better-sqlite3';
import { canonicalJson, sha256Hex } from '../../../process-modules/shared/canonical-json.js';
import {
  ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA,
  SOLUTION_CONTRACT_CERTIFICATE_SCHEMA,
  type AcceptanceBaselineSnapshotPayload,
  type FormalizationSolutionContractPayload,
} from '../domain/formalization-schemas.js';
// W7-THIRD-AUDIT — the port contracts (record + repository interfaces) are now
// owned by the module tree and re-imported here. Infrastructure implements
// module-owned ports; it must not define them (that would force module
// consumers to import infrastructure, a Rule 2 edge).
export type {
  AcceptanceBaselineSnapshotRecord,
  FormalizationSolutionContractRecord,
  FormalizationBaselineRepository,
  FormalizationSolutionContractRepository,
} from '../domain/formalization-persistence-contracts.js';
import type {
  AcceptanceBaselineSnapshotRecord,
  FormalizationSolutionContractRecord,
  FormalizationBaselineRepository,
  FormalizationSolutionContractRepository,
} from '../domain/formalization-persistence-contracts.js';

export function ensureFormalizationPersistenceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_formalization_acceptance_baselines (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id        INTEGER NOT NULL UNIQUE
                              REFERENCES saga3_process_runs(id) ON DELETE CASCADE,
      formalization_epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      schema_version        TEXT NOT NULL,
      payload               TEXT NOT NULL,
      baseline_hash         TEXT NOT NULL,
      snapshot_hash         TEXT NOT NULL UNIQUE,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS saga3_formalization_solution_contracts (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id        INTEGER NOT NULL UNIQUE
                              REFERENCES saga3_process_runs(id) ON DELETE CASCADE,
      formalization_epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      schema_version        TEXT NOT NULL,
      payload               TEXT NOT NULL,
      content_hash          TEXT NOT NULL UNIQUE,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_saga3_formalization_baseline_epic
      ON saga3_formalization_acceptance_baselines(formalization_epic_id);
    CREATE INDEX IF NOT EXISTS idx_saga3_formalization_contract_epic
      ON saga3_formalization_solution_contracts(formalization_epic_id);
  `);
}

interface BaselineRow {
  id: number;
  process_run_id: number;
  formalization_epic_id: number;
  schema_version: string;
  payload: string;
  baseline_hash: string;
  snapshot_hash: string;
  created_at: string;
}

interface SolutionContractRow {
  id: number;
  process_run_id: number;
  formalization_epic_id: number;
  schema_version: string;
  payload: string;
  content_hash: string;
  created_at: string;
}

export class SqliteFormalizationBaselineRepository implements FormalizationBaselineRepository {
  constructor(private readonly db: Database.Database) {
    ensureFormalizationPersistenceSchema(db);
  }

  freeze(
    payload: AcceptanceBaselineSnapshotPayload,
  ): { record: AcceptanceBaselineSnapshotRecord; replayed: boolean } {
    if (payload.schemaVersion !== ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA) {
      throw new Error(
        `formalization baseline: expected schema '${ACCEPTANCE_BASELINE_SNAPSHOT_SCHEMA}', got '${payload.schemaVersion}'`,
      );
    }
    const payloadText = canonicalJson(payload);
    const snapshotHash = sha256Hex(payload);
    const existing = this.db.prepare(
      'SELECT * FROM saga3_formalization_acceptance_baselines WHERE process_run_id=?',
    ).get(payload.processRunId) as BaselineRow | undefined;
    if (existing) {
      if (existing.snapshot_hash !== snapshotHash) {
        throw new Error(
          `FORMALIZATION_BASELINE_ALREADY_FROZEN: process_run ${payload.processRunId} `
          + `is bound to '${existing.snapshot_hash}', received '${snapshotHash}'`,
        );
      }
      return { record: baselineRowToRecord(existing), replayed: true };
    }
    const info = this.db.prepare(
      `INSERT INTO saga3_formalization_acceptance_baselines
         (process_run_id, formalization_epic_id, schema_version, payload,
          baseline_hash, snapshot_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      payload.processRunId,
      payload.formalizationEpicId,
      payload.schemaVersion,
      payloadText,
      payload.baselineHash,
      snapshotHash,
    );
    const row = this.db.prepare(
      'SELECT * FROM saga3_formalization_acceptance_baselines WHERE id=?',
    ).get(Number(info.lastInsertRowid)) as BaselineRow | undefined;
    if (!row) throw new Error('formalization baseline vanished after insert');
    return { record: baselineRowToRecord(row), replayed: false };
  }

  readByProcessRun(processRunId: number): AcceptanceBaselineSnapshotRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM saga3_formalization_acceptance_baselines WHERE process_run_id=?',
    ).get(processRunId) as BaselineRow | undefined;
    return row ? baselineRowToRecord(row) : null;
  }
}

export class SqliteFormalizationSolutionContractRepository
implements FormalizationSolutionContractRepository {
  constructor(private readonly db: Database.Database) {
    ensureFormalizationPersistenceSchema(db);
  }

  persist(
    payload: FormalizationSolutionContractPayload,
  ): { record: FormalizationSolutionContractRecord; replayed: boolean } {
    if (payload.schemaVersion !== SOLUTION_CONTRACT_CERTIFICATE_SCHEMA) {
      throw new Error(
        `formalization solution contract: expected schema '${SOLUTION_CONTRACT_CERTIFICATE_SCHEMA}', `
        + `got '${payload.schemaVersion}'`,
      );
    }
    const payloadText = canonicalJson(payload);
    const contentHash = sha256Hex(payload);
    const existing = this.db.prepare(
      'SELECT * FROM saga3_formalization_solution_contracts WHERE process_run_id=?',
    ).get(payload.processRunId) as SolutionContractRow | undefined;
    if (existing) {
      if (existing.content_hash !== contentHash) {
        throw new Error(
          `FORMALIZATION_SOLUTION_CONTRACT_ALREADY_PERSISTED: process_run ${payload.processRunId} `
          + `is bound to '${existing.content_hash}', received '${contentHash}'`,
        );
      }
      return { record: solutionRowToRecord(existing), replayed: true };
    }
    const info = this.db.prepare(
      `INSERT INTO saga3_formalization_solution_contracts
         (process_run_id, formalization_epic_id, schema_version, payload, content_hash)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      payload.processRunId,
      payload.formalizationEpicId,
      payload.schemaVersion,
      payloadText,
      contentHash,
    );
    const row = this.db.prepare(
      'SELECT * FROM saga3_formalization_solution_contracts WHERE id=?',
    ).get(Number(info.lastInsertRowid)) as SolutionContractRow | undefined;
    if (!row) throw new Error('formalization solution contract vanished after insert');
    return { record: solutionRowToRecord(row), replayed: false };
  }

  readByProcessRun(processRunId: number): FormalizationSolutionContractRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM saga3_formalization_solution_contracts WHERE process_run_id=?',
    ).get(processRunId) as SolutionContractRow | undefined;
    return row ? solutionRowToRecord(row) : null;
  }
}

function baselineRowToRecord(row: BaselineRow): AcceptanceBaselineSnapshotRecord {
  const payload = JSON.parse(row.payload) as AcceptanceBaselineSnapshotPayload;
  if (payload.schemaVersion !== row.schema_version) {
    throw new Error(`formalization baseline ${row.id}: schema column/payload mismatch`);
  }
  return {
    id: row.id,
    processRunId: row.process_run_id,
    formalizationEpicId: row.formalization_epic_id,
    payload,
    baselineHash: row.baseline_hash,
    snapshotHash: row.snapshot_hash,
    artifactRef: `formalization-baseline:${row.id}`,
    createdAt: row.created_at,
  };
}

function solutionRowToRecord(row: SolutionContractRow): FormalizationSolutionContractRecord {
  const payload = JSON.parse(row.payload) as FormalizationSolutionContractPayload;
  if (payload.schemaVersion !== row.schema_version) {
    throw new Error(`formalization solution contract ${row.id}: schema column/payload mismatch`);
  }
  return {
    id: row.id,
    processRunId: row.process_run_id,
    formalizationEpicId: row.formalization_epic_id,
    payload,
    contentHash: row.content_hash,
    artifactRef: `formalization-solution-contract:${row.id}`,
    createdAt: row.created_at,
  };
}
