import type Database from 'better-sqlite3';
import { canonicalJson, sha256Hex } from '../../../process-modules/shared/canonical-json.js';
import {
  type DeliveryOutputRecord,
  type DeliveryOutputRepository,
} from '../../../process-modules/modules/delivery/delivery-kernel-ports.js';
import { DELIVERY_PROCESS_MODULE_REF } from '../../../process-modules/modules/delivery/delivery-process-module.js';
import {
  RELEASE_RECORD_SCHEMA,
  type ReleaseRecord,
} from '../../../process-modules/modules/delivery/delivery-schemas.js';

/**
 * Wave 7 hex extraction: the parent `saga3_process_runs` table is ensured by
 * the composition root, which constructs `SqliteProcessRunRepository(db)`
 * before this repository. Delivery's own tables are created here; the module
 * no longer imports the concrete process-run SQLite adapter.
 */
export function ensureDeliveryPersistenceSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_delivery_outputs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id   INTEGER NOT NULL UNIQUE
                         REFERENCES saga3_process_runs(id) ON DELETE RESTRICT,
      project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      epic_id          INTEGER REFERENCES epics(id) ON DELETE CASCADE,
      schema_version   TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_saga3_delivery_outputs_scope
      ON saga3_delivery_outputs(project_id,epic_id,id);

    CREATE TRIGGER IF NOT EXISTS trg_saga3_delivery_outputs_no_update
    BEFORE UPDATE ON saga3_delivery_outputs
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_OUTPUT_IMMUTABLE');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_saga3_delivery_outputs_no_delete
    BEFORE DELETE ON saga3_delivery_outputs
    BEGIN
      SELECT RAISE(ABORT, 'DELIVERY_OUTPUT_DELETE_FORBIDDEN');
    END;
  `);
}

interface DeliveryOutputRow {
  id: number;
  process_run_id: number;
  project_id: number;
  epic_id: number | null;
  schema_version: string;
  payload_snapshot: string;
  content_hash: string;
  created_at: string;
}

/** Write-once canonical ReleaseRecord repository. */
export class SqliteDeliveryOutputRepository
implements DeliveryOutputRepository {
  constructor(private readonly db: Database.Database) {
    ensureDeliveryPersistenceSchema(db);
  }

  persist(input: {
    processRunId: number;
    projectId: number;
    epicId: number | null;
    payload: ReleaseRecord;
  }): { record: DeliveryOutputRecord; replayed: boolean } {
    assertDeliveryPayload(input.payload);
    const snapshot = canonicalJson(input.payload);
    const contentHash = sha256Hex(input.payload);

    return this.transaction(() => {
      this.assertProcessBinding(
        input.processRunId,
        input.projectId,
        input.epicId,
      );
      const existing = this.readRow(input.processRunId);
      if (existing) {
        if (
          existing.project_id !== input.projectId
          || existing.epic_id !== input.epicId
          || existing.schema_version !== input.payload.schemaVersion
          || existing.payload_snapshot !== snapshot
          || existing.content_hash !== contentHash
        ) {
          throw new Error(
            `DELIVERY_OUTPUT_ALREADY_PERSISTED: process_run ${input.processRunId} `
            + 'is bound to a different canonical output',
          );
        }
        return { record: rowToDeliveryRecord(existing), replayed: true };
      }

      this.db.prepare(
        `INSERT INTO saga3_delivery_outputs
          (process_run_id,project_id,epic_id,schema_version,payload_snapshot,content_hash)
         VALUES (?,?,?,?,?,?)`,
      ).run(
        input.processRunId,
        input.projectId,
        input.epicId,
        input.payload.schemaVersion,
        snapshot,
        contentHash,
      );
      const inserted = this.readRow(input.processRunId);
      if (!inserted) throw new Error('delivery output vanished after insert');
      return { record: rowToDeliveryRecord(inserted), replayed: false };
    });
  }

  readByProcessRun(processRunId: number): DeliveryOutputRecord | null {
    const row = this.readRow(processRunId);
    return row ? rowToDeliveryRecord(row) : null;
  }

  private assertProcessBinding(
    processRunId: number,
    projectId: number,
    epicId: number | null,
  ): void {
    const process = this.db.prepare(
      `SELECT project_id,epic_id,module_name,module_version
         FROM saga3_process_runs WHERE id=?`,
    ).get(processRunId) as {
      project_id: number;
      epic_id: number | null;
      module_name: string;
      module_version: string;
    } | undefined;
    if (!process) {
      throw new Error(`DELIVERY_OUTPUT_PROCESS_RUN_NOT_FOUND: ${processRunId}`);
    }
    if (
      process.project_id !== projectId
      || process.epic_id !== epicId
      || process.module_name !== DELIVERY_PROCESS_MODULE_REF.name
      || process.module_version !== DELIVERY_PROCESS_MODULE_REF.version
    ) {
      throw new Error('DELIVERY_OUTPUT_PROCESS_RUN_BINDING_MISMATCH');
    }
  }

  private readRow(processRunId: number): DeliveryOutputRow | null {
    return (this.db.prepare(
      'SELECT * FROM saga3_delivery_outputs WHERE process_run_id=?',
    ).get(processRunId) as DeliveryOutputRow | undefined) ?? null;
  }

  private transaction<T>(work: () => T): T {
    const ownsTransaction = !this.db.inTransaction;
    if (ownsTransaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (ownsTransaction) this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (ownsTransaction) {
        try { this.db.exec('ROLLBACK'); } catch { /* already closed */ }
      }
      throw error;
    }
  }
}

function assertDeliveryPayload(payload: ReleaseRecord): void {
  if (payload.schemaVersion !== RELEASE_RECORD_SCHEMA) {
    throw new Error(
      `delivery output: expected schema '${RELEASE_RECORD_SCHEMA}', `
      + `got '${payload.schemaVersion}'`,
    );
  }
}

function rowToDeliveryRecord(row: DeliveryOutputRow): DeliveryOutputRecord {
  const payload = JSON.parse(row.payload_snapshot) as ReleaseRecord;
  assertDeliveryPayload(payload);
  if (
    row.schema_version !== payload.schemaVersion
    || canonicalJson(payload) !== row.payload_snapshot
    || sha256Hex(payload) !== row.content_hash
  ) {
    throw new Error(`DELIVERY_OUTPUT_INTEGRITY_MISMATCH: row ${row.id}`);
  }
  return {
    processRunId: row.process_run_id,
    projectId: row.project_id,
    epicId: row.epic_id,
    artifactRef: `delivery-output:${row.id}`,
    contentHash: row.content_hash,
    payload,
  };
}
