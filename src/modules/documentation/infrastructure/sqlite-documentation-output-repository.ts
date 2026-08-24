/**
 * Documentation workshop — SQLite output repository.
 *
 * Mirrors the delivery persistence pattern: the module ensures its own
 * immutable table (append-only triggers) instead of touching the shared
 * schema constitution. Idempotent by unique process_run_id.
 */

import type Database from 'better-sqlite3';
import { sha256Hex } from '../../../shared/canonical-json.js';
import type {
  DocumentationOutputRecord,
  DocumentationOutputRepository,
} from '../domain/documentation-kernel-ports.js';
import type { DocumentationBundle } from '../domain/documentation-schemas.js';

export function ensureDocumentationPersistenceSchema(
  db: Database.Database,
): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_documentation_bundles (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id   INTEGER NOT NULL UNIQUE
                         REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
      project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      epic_id          INTEGER REFERENCES epics(id) ON DELETE CASCADE,
      schema_version   TEXT NOT NULL,
      artifact_ref     TEXT NOT NULL,
      payload_snapshot TEXT NOT NULL,
      content_hash     TEXT NOT NULL,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_factory_documentation_bundles_scope
      ON factory_documentation_bundles(project_id,epic_id,id);

    CREATE TRIGGER IF NOT EXISTS trg_factory_documentation_bundles_no_update
    BEFORE UPDATE ON factory_documentation_bundles
    BEGIN
      SELECT RAISE(ABORT, 'DOCUMENTATION_BUNDLE_IMMUTABLE');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_factory_documentation_bundles_no_delete
    BEFORE DELETE ON factory_documentation_bundles
    BEGIN
      SELECT RAISE(ABORT, 'DOCUMENTATION_BUNDLE_DELETE_FORBIDDEN');
    END;
  `);
}

interface BundleRow {
  id: number;
  process_run_id: number;
  project_id: number;
  epic_id: number | null;
  schema_version: string;
  artifact_ref: string;
  payload_snapshot: string;
  content_hash: string;
}

export class SqliteDocumentationOutputRepository
  implements DocumentationOutputRepository {
  constructor(private readonly db: Database.Database) {
    ensureDocumentationPersistenceSchema(db);
  }

  persistBundle(record: {
    processRunId: number;
    projectId: number;
    epicId: number | null;
    payload: DocumentationBundle;
  }): { record: DocumentationOutputRecord; replayed: boolean } {
    const existing = this.readRowByProcessRun(record.processRunId);
    if (existing) {
      if (existing.content_hash !== record.payload.bundleHash) {
        throw new Error('DOCUMENTATION_BUNDLE_REPLAY_MISMATCH');
      }
      return { record: this.toRecord(existing), replayed: true };
    }
    const artifactRef = `documentation-bundle:process-run:${record.processRunId}`
      + `:${record.payload.bundleHash}`;
    this.db.prepare(
      `INSERT INTO factory_documentation_bundles
         (process_run_id,project_id,epic_id,schema_version,artifact_ref,
          payload_snapshot,content_hash)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      record.processRunId,
      record.projectId,
      record.epicId,
      record.payload.schemaVersion,
      artifactRef,
      JSON.stringify(record.payload),
      record.payload.bundleHash,
    );
    const stored = this.readRowByProcessRun(record.processRunId)!;
    return { record: this.toRecord(stored), replayed: false };
  }

  readByProcessRun(processRunId: number): DocumentationOutputRecord | null {
    const row = this.readRowByProcessRun(processRunId);
    return row ? this.toRecord(row) : null;
  }

  private readRowByProcessRun(processRunId: number): BundleRow | null {
    return this.db.prepare(
      `SELECT id,process_run_id,project_id,epic_id,schema_version,artifact_ref,
              payload_snapshot,content_hash
         FROM factory_documentation_bundles
        WHERE process_run_id=?`,
    ).get(processRunId) as BundleRow | undefined ?? null;
  }

  private toRecord(row: BundleRow): DocumentationOutputRecord {
    return {
      processRunId: row.process_run_id,
      projectId: row.project_id,
      epicId: row.epic_id,
      artifactRef: row.artifact_ref,
      contentHash: row.content_hash,
      payload: JSON.parse(row.payload_snapshot) as DocumentationBundle,
    };
  }
}

/** Deterministic hash helper reused by tests for fixture bundles. */
export function documentationBundleFixtureHash(
  bundle: Omit<DocumentationBundle, 'bundleHash'>,
): string {
  return sha256Hex(bundle);
}
