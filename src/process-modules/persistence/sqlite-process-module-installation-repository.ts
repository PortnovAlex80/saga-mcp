/**
 * SQLite implementation of ProcessModuleInstallationRepository. P-PM-1.
 *
 * Schema: `saga3_process_module_installations`. Idempotent upsert keyed on
 * (module_name, module_version, package_digest). Two installations of the same
 * module version with different package digests coexist as distinct rows —
 * this is intentional: it captures "edited resource, same version" as a new
 * installation, and ProcessRuns pinned to the old one keep replaying correctly.
 *
 * `saga3_process_runs.installation_id` is the FK consumers use. This repo does
 * NOT add that FK here (it's added in sqlite-process-run-repository.ts as a
 * nullable column to preserve backward compatibility with pre-P-PM-1 rows).
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import {
  processModuleKey,
  type ProcessModuleReference,
} from '../domain/process-module.js';
import { canonicalJson } from '../../shared/canonical-json.js';
import {
  type InsertProcessModuleInstallationInput,
  type ProcessModuleInstallationRecord,
  type ProcessModuleInstallationRepository,
} from './process-module-installation-record.js';

export function ensureSaga3ProcessModuleInstallationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_process_module_installations (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      module_name             TEXT NOT NULL,
      module_version          TEXT NOT NULL,
      module_ref_key          TEXT NOT NULL,
      executor_kind           TEXT NOT NULL,
      definition_digest       TEXT NOT NULL,
      package_digest          TEXT NOT NULL,
      resource_hashes_json    TEXT NOT NULL,
      handler_versions_json   TEXT NOT NULL,
      created_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Idempotent upsert: same module + same package = same row.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saga3_installations_module_pkg
      ON saga3_process_module_installations(module_name, module_version, package_digest);

    -- Fast "latest installation for module" lookup.
    CREATE INDEX IF NOT EXISTS idx_saga3_installations_module
      ON saga3_process_module_installations(module_name, module_version, id DESC);
  `);
}

interface InstallationRow {
  id: number;
  module_name: string;
  module_version: string;
  module_ref_key: string;
  executor_kind: string;
  definition_digest: string;
  package_digest: string;
  resource_hashes_json: string;
  handler_versions_json: string;
  created_at: string;
}

function rowToRecord(row: InstallationRow): ProcessModuleInstallationRecord {
  const moduleRef: ProcessModuleReference = {
    name: row.module_name,
    version: row.module_version,
  };
  return {
    id: row.id,
    moduleRef,
    moduleRefKey: row.module_ref_key,
    executorKind: row.executor_kind,
    definitionDigest: row.definition_digest,
    packageDigest: row.package_digest,
    resourceHashesJson: row.resource_hashes_json,
    handlerVersionsJson: row.handler_versions_json,
    createdAt: row.created_at,
  };
}

/**
 * Serialize a Map<string,string> as deterministic canonical JSON. Sorts keys so
 * the stored bytes are stable regardless of Map iteration order.
 */
function mapToCanonicalJson(map: ReadonlyMap<string, string>): string {
  const obj: Record<string, string> = {};
  for (const key of [...map.keys()].sort()) {
    obj[key] = map.get(key)!;
  }
  return canonicalJson(obj);
}

export class SqliteProcessModuleInstallationRepository
  implements ProcessModuleInstallationRepository
{
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureSaga3ProcessModuleInstallationSchema(this.db);
  }

  upsert(input: InsertProcessModuleInstallationInput): ProcessModuleInstallationRecord {
    const moduleRefKey = processModuleKey(input.moduleRef);
    const resourceHashesJson = mapToCanonicalJson(input.resourceHashes);
    const handlerVersionsJson = mapToCanonicalJson(input.handlerVersions);

    // Look up existing by (module, package_digest). If found, return as-is —
    // the package is byte-identical, no new row needed.
    const existing = this.db.prepare(
      `SELECT * FROM saga3_process_module_installations
        WHERE module_name=? AND module_version=? AND package_digest=?`,
    ).get(input.moduleRef.name, input.moduleRef.version, input.packageDigest) as
      | InstallationRow
      | undefined;
    if (existing) return rowToRecord(existing);

    const info = this.db.prepare(
      `INSERT INTO saga3_process_module_installations
         (module_name, module_version, module_ref_key, executor_kind,
          definition_digest, package_digest, resource_hashes_json, handler_versions_json)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      input.moduleRef.name,
      input.moduleRef.version,
      moduleRefKey,
      input.executorKind,
      input.definitionDigest,
      input.packageDigest,
      resourceHashesJson,
      handlerVersionsJson,
    );
    const row = this.db.prepare(
      'SELECT * FROM saga3_process_module_installations WHERE id=?',
    ).get(Number(info.lastInsertRowid)) as InstallationRow;
    return rowToRecord(row);
  }

  read(id: number): ProcessModuleInstallationRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM saga3_process_module_installations WHERE id=?',
    ).get(id) as InstallationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findLatestForModule(moduleRef: ProcessModuleReference): ProcessModuleInstallationRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM saga3_process_module_installations
        WHERE module_name=? AND module_version=?
        ORDER BY id DESC LIMIT 1`,
    ).get(moduleRef.name, moduleRef.version) as InstallationRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  findByPackageDigest(
    moduleRef: ProcessModuleReference,
    packageDigest: string,
  ): ProcessModuleInstallationRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM saga3_process_module_installations
        WHERE module_name=? AND module_version=? AND package_digest=?`,
    ).get(moduleRef.name, moduleRef.version, packageDigest) as InstallationRow | undefined;
    return row ? rowToRecord(row) : null;
  }
}
