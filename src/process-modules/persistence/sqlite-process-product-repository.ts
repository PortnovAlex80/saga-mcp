import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import { canonicalJson, sha256Hex } from '../shared/canonical-json.js';
import { ensureSaga3ProcessRunSchema } from './sqlite-process-run-repository.js';

export interface ProcessProductReference {
  schema: string;
  ref: string;
  hash: string;
}

export interface ProcessProductRecord<T = unknown> {
  processRunId: number;
  productKind: string;
  reference: ProcessProductReference;
  payload: T;
  payloadHash: string;
  createdAt: string;
}

/**
 * Durable intermediate-product store shared by process modules.
 *
 * A product has two hashes on purpose:
 * - `product_hash` is the domain identity exposed by the module contract
 *   (for example graphHash or candidateHash);
 * - `payload_hash` covers the complete canonical payload, including the
 *   embedded domain hash.
 *
 * Reusing a (ProcessRun, product kind) with any different byte-level payload
 * is rejected. This is the durable equivalent of an immutable frame binding.
 */
export function ensureSaga3ProcessProductSchema(
  db: Database.Database,
): void {
  ensureSaga3ProcessRunSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_process_products (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id     INTEGER NOT NULL
                               REFERENCES saga3_process_runs(id) ON DELETE RESTRICT,
      product_kind       TEXT NOT NULL,
      schema_id          TEXT NOT NULL,
      artifact_ref       TEXT NOT NULL UNIQUE,
      product_hash       TEXT NOT NULL,
      payload_snapshot   TEXT NOT NULL,
      payload_hash       TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(process_run_id, product_kind)
    );

    CREATE INDEX IF NOT EXISTS idx_saga3_process_products_run
      ON saga3_process_products(process_run_id, id);
    CREATE INDEX IF NOT EXISTS idx_saga3_process_products_hash
      ON saga3_process_products(schema_id, product_hash);
  `);
}

export class SqliteProcessProductRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureSaga3ProcessProductSchema(db);
  }

  persist<T>(input: {
    processRunId: number;
    productKind: string;
    schema: string;
    productHash: string;
    payload: T;
    artifactRefPrefix: string;
  }): { record: ProcessProductRecord<T>; replayed: boolean } {
    requireNonEmpty(input.productKind, 'product kind');
    requireNonEmpty(input.schema, 'schema');
    requireNonEmpty(input.productHash, 'product hash');
    requireNonEmpty(input.artifactRefPrefix, 'artifact ref prefix');
    if (!Number.isSafeInteger(input.processRunId) || input.processRunId < 1) {
      throw new Error('PROCESS_PRODUCT_INVALID_PROCESS_RUN_ID');
    }

    const payloadSnapshot = canonicalJson(input.payload);
    const payloadHash = sha256Hex(input.payload);
    const artifactRef =
      `${input.artifactRefPrefix}:${input.processRunId}:${input.productHash}`;

    const existing = this.readRow(input.processRunId, input.productKind);
    if (existing) {
      assertReplay(existing, {
        schema: input.schema,
        artifactRef,
        productHash: input.productHash,
        payloadSnapshot,
        payloadHash,
      });
      return {
        record: rowToRecord<T>(existing),
        replayed: true,
      };
    }

    this.db.prepare(
      `INSERT INTO saga3_process_products
        (process_run_id,product_kind,schema_id,artifact_ref,product_hash,
         payload_snapshot,payload_hash)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      input.processRunId,
      input.productKind,
      input.schema,
      artifactRef,
      input.productHash,
      payloadSnapshot,
      payloadHash,
    );
    const inserted = this.readRow(input.processRunId, input.productKind);
    if (!inserted) throw new Error('PROCESS_PRODUCT_INSERT_LOST');
    return {
      record: rowToRecord<T>(inserted),
      replayed: false,
    };
  }

  read<T>(
    processRunId: number,
    productKind: string,
  ): ProcessProductRecord<T> | null {
    const row = this.readRow(processRunId, productKind);
    return row ? rowToRecord<T>(row) : null;
  }

  private readRow(
    processRunId: number,
    productKind: string,
  ): ProcessProductRow | null {
    const row = this.db.prepare(
      `SELECT process_run_id,product_kind,schema_id,artifact_ref,product_hash,
              payload_snapshot,payload_hash,created_at
         FROM saga3_process_products
        WHERE process_run_id=? AND product_kind=?`,
    ).get(processRunId, productKind) as ProcessProductRow | undefined;
    return row ?? null;
  }
}

interface ProcessProductRow {
  process_run_id: number;
  product_kind: string;
  schema_id: string;
  artifact_ref: string;
  product_hash: string;
  payload_snapshot: string;
  payload_hash: string;
  created_at: string;
}

function rowToRecord<T>(row: ProcessProductRow): ProcessProductRecord<T> {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_snapshot);
  } catch {
    throw new Error(
      `PROCESS_PRODUCT_PAYLOAD_CORRUPT: ${row.process_run_id}/${row.product_kind}`,
    );
  }
  if (canonicalJson(payload) !== row.payload_snapshot) {
    throw new Error(
      `PROCESS_PRODUCT_PAYLOAD_NOT_CANONICAL: ${row.process_run_id}/${row.product_kind}`,
    );
  }
  if (sha256Hex(payload) !== row.payload_hash) {
    throw new Error(
      `PROCESS_PRODUCT_PAYLOAD_HASH_MISMATCH: ${row.process_run_id}/${row.product_kind}`,
    );
  }
  return {
    processRunId: row.process_run_id,
    productKind: row.product_kind,
    reference: {
      schema: row.schema_id,
      ref: row.artifact_ref,
      hash: row.product_hash,
    },
    payload: payload as T,
    payloadHash: row.payload_hash,
    createdAt: row.created_at,
  };
}

function assertReplay(
  row: ProcessProductRow,
  expected: {
    schema: string;
    artifactRef: string;
    productHash: string;
    payloadSnapshot: string;
    payloadHash: string;
  },
): void {
  if (
    row.schema_id !== expected.schema
    || row.artifact_ref !== expected.artifactRef
    || row.product_hash !== expected.productHash
    || row.payload_snapshot !== expected.payloadSnapshot
    || row.payload_hash !== expected.payloadHash
  ) {
    throw new Error(
      `PROCESS_PRODUCT_REPLAY_MISMATCH: ${row.process_run_id}/${row.product_kind}`,
    );
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`PROCESS_PRODUCT_${label.toUpperCase().replaceAll(' ', '_')}_REQUIRED`);
  }
}
