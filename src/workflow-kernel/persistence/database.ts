/**
 * workflow-kernel/persistence/database.ts - the exact-version database open
 * of the fresh workflow-kernel protocol (WP-06, plan phase EK-3).
 *
 * FRESH PROTOCOL ONLY:
 *   - an empty path (missing file, zero-byte file or a SQLite file with no
 *     user schema objects) creates the new protocol via the one declarative
 *     bootstrap (schema.ts);
 *   - a database with the EXACT protocol id, schema version, schema
 *     fingerprint and object inventory opens;
 *   - ANY other non-empty database (including files that are not readable
 *     SQLite databases at all) fails closed with
 *     FACTORY_DATABASE_PROTOCOL_UNSUPPORTED and an operator-facing
 *     instruction to choose a fresh database path. Every probe of an
 *     existing file is READ-ONLY: a refused database is byte-for-byte
 *     unchanged.
 *
 * The runtime never alters an existing schema: after bootstrap there is no
 * code path that writes DDL. Old databases may be preserved offline as
 * incident evidence; this module contains no reader, importer or conversion
 * path for them.
 */

import { existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import {
  PROTOCOL_ID,
  SCHEMA_VERSION,
  bootstrapFreshDatabase,
  databaseIsEmpty,
  verifyProtocol,
  type ProtocolVerification,
} from './schema.js';

/** Typed fail-closed refusal for every non-empty unsupported database. */
export class FactoryDatabaseProtocolUnsupportedError extends Error {
  readonly code = 'FACTORY_DATABASE_PROTOCOL_UNSUPPORTED';
  readonly protocolId = PROTOCOL_ID;
  readonly schemaVersion = SCHEMA_VERSION;
  readonly verification: ProtocolVerification;

  constructor(verification: ProtocolVerification, path: string) {
    super(
      `FACTORY_DATABASE_PROTOCOL_UNSUPPORTED: ${path} is not an exact ${PROTOCOL_ID} v${SCHEMA_VERSION} database`
        + ` (${verification.reason ?? 'UNSUPPORTED'}: ${verification.detail ?? 'no detail'}).`
        + ' Choose a fresh database path; this runtime never converts, takes over or reads old databases.',
    );
    this.name = 'FactoryDatabaseProtocolUnsupportedError';
    this.verification = verification;
  }
}

export interface OpenKernelDatabaseOptions {
  /**
   * Test/focused-composition marker. The fresh bootstrap is unreachable from
   * the production entrypoint until the EK-8 hard cutover; the session is
   * constructed explicitly by focused persistence tests at fresh temporary
   * paths only.
   */
  readonly purpose?: 'ek3-focused-test';
}

/** Run a READ-ONLY probe over an existing file; any read failure is a typed refusal. */
function probeReadonly<T>(path: string, probe: (db: Database.Database) => T): T {
  let db: Database.Database;
  try {
    db = new Database(path, { readonly: true });
  } catch (error) {
    throw new FactoryDatabaseProtocolUnsupportedError(
      { supported: false, reason: 'FOREIGN_SCHEMA', detail: `not readable as a SQLite database (${(error as Error).message})` },
      path,
    );
  }
  try {
    return probe(db);
  } catch (error) {
    if (error instanceof FactoryDatabaseProtocolUnsupportedError) throw error;
    throw new FactoryDatabaseProtocolUnsupportedError(
      { supported: false, reason: 'FOREIGN_SCHEMA', detail: `not readable as a SQLite database (${(error as Error).message})` },
      path,
    );
  } finally {
    db.close();
  }
}

/** True when the existing file holds no user schema objects at all. */
function fileHoldsNoSchema(path: string, stat: { size: number }): boolean {
  if (stat.size === 0) return true;
  // Read-only probe: opening a foreign database must never mutate its bytes.
  return probeReadonly(path, (db) => databaseIsEmpty(db));
}

/**
 * Open (or create) a workflow-kernel database at the exact fresh protocol.
 *
 * Order of operations (fail-closed, no mutation of unsupported databases):
 *   1. no file / zero-byte file / schema-less SQLite file -> bootstrap;
 *   2. existing file -> READ-ONLY verify (exact id + version + fingerprint
 *      + object inventory + user_version);
 *   3. exact match -> read-write open + foreign keys ON;
 *   4. anything else -> FactoryDatabaseProtocolUnsupportedError; the file
 *      was only ever opened readonly and is byte-for-byte unchanged.
 */
export function openKernelDatabase(path: string, _options?: OpenKernelDatabaseOptions): Database.Database {
  const fresh = !existsSync(path) || fileHoldsNoSchema(path, statSync(path));
  if (!fresh) {
    const verification = probeReadonly(path, (db) => verifyProtocol(db));
    if (!verification.supported) {
      throw new FactoryDatabaseProtocolUnsupportedError(verification, path);
    }
  }
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (fresh) {
    bootstrapFreshDatabase(db);
  } else {
    // Re-verify on the writable connection: exact-version open only.
    const verification = verifyProtocol(db);
    if (!verification.supported) {
      db.close();
      throw new FactoryDatabaseProtocolUnsupportedError(verification, path);
    }
  }
  return db;
}
