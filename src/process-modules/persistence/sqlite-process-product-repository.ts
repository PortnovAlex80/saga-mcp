import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import { ensureFactoryProcessRunSchema } from './sqlite-process-run-repository.js';

export interface ProcessProductReference {
  schema: string;
  ref: string;
  hash: string;
}

export interface ProcessProductRecord<T = unknown> {
  processRunId: number;
  productKind: string;
  productKey: string;
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
 * Identity is scoped to three layers:
 * - `product_kind` — the class of product (e.g. `factory.artifact-ref.v1`,
 *   `delivery.preflight`). One kind can appear many times in a run.
 * - `product_key` — the logical instance within that kind (e.g.
 *   `artifact:42` for the artifact-ref bridge, or the kind itself for v1
 *   singletons like Delivery/Development).
 * - `artifact_ref` — the content-addressed immutable version.
 *
 * Reusing a (ProcessRun, product kind, product key) with any different
 * byte-level payload is rejected. This is the durable equivalent of an
 * immutable frame binding that also permits many products of the same kind.
 */
export function ensureFactoryProcessProductSchema(
  db: Database.Database,
): void {
  ensureFactoryProcessRunSchema(db);
  // Migrate any pre-product_key table shape in place before the CREATE TABLE
  // IF NOT EXISTS no-ops on an already-present (old-shape) table.
  migrateFactoryProcessProductProductKey(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS factory_process_products (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      process_run_id     INTEGER NOT NULL
                               REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
      product_kind       TEXT NOT NULL,
      product_key        TEXT NOT NULL DEFAULT '',
      schema_id          TEXT NOT NULL,
      artifact_ref       TEXT NOT NULL UNIQUE,
      product_hash       TEXT NOT NULL,
      payload_snapshot   TEXT NOT NULL,
      payload_hash       TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(process_run_id, product_kind, product_key)
    );

    CREATE INDEX IF NOT EXISTS idx_factory_process_products_run
      ON factory_process_products(process_run_id, id);
    CREATE INDEX IF NOT EXISTS idx_factory_process_products_hash
      ON factory_process_products(schema_id, product_hash);
  `);
}

/**
 * Migrate a pre-product_key `factory_process_products` table to the new shape.
 *
 * SQLite cannot DROP a UNIQUE constraint in place, so the table is rebuilt:
 * a `_new` table with the new schema is created, existing rows are copied
 * (with `product_key = product_kind` so v1 singletons preserve their identity),
 * and the old table is dropped and replaced. The whole rebuild runs in one
 * transaction. Idempotent: if the column already exists or the table is
 * absent, this is a no-op.
 */
function migrateFactoryProcessProductProductKey(
  db: Database.Database,
): void {
  const tableRow = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factory_process_products'")
    .get() as { name: string } | undefined;
  if (!tableRow) return;
  const columns = db.prepare('PRAGMA table_info(factory_process_products)').all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === 'product_key')) return;
  // The v2 repository may have already added a nullable `node_id` column
  // (provenance: which Flow node emitted the product). The rebuild MUST
  // preserve it — dropping it would silently erase lineage for every existing
  // v2 product row. We detect it and branch the DDL + COPY accordingly.
  const hasNodeId = columns.some((c) => c.name === 'node_id');
  // Old shape present without product_key — rebuild.
  if (hasNodeId) {
    db.exec(`
      CREATE TABLE factory_process_products_new (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        process_run_id     INTEGER NOT NULL
                                 REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
        product_kind       TEXT NOT NULL,
        product_key        TEXT NOT NULL DEFAULT '',
        schema_id          TEXT NOT NULL,
        artifact_ref       TEXT NOT NULL UNIQUE,
        product_hash       TEXT NOT NULL,
        payload_snapshot   TEXT NOT NULL,
        payload_hash       TEXT NOT NULL,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        node_id            TEXT,
        UNIQUE(process_run_id, product_kind, product_key)
      );
      INSERT INTO factory_process_products_new
        (id, process_run_id, product_kind, product_key, schema_id, artifact_ref,
         product_hash, payload_snapshot, payload_hash, created_at, node_id)
      SELECT id, process_run_id, product_kind, product_kind, schema_id, artifact_ref,
             product_hash, payload_snapshot, payload_hash, created_at, node_id
        FROM factory_process_products;
      DROP TABLE factory_process_products;
      ALTER TABLE factory_process_products_new RENAME TO factory_process_products;
      CREATE INDEX IF NOT EXISTS idx_factory_process_products_run
        ON factory_process_products(process_run_id, id);
      CREATE INDEX IF NOT EXISTS idx_factory_process_products_hash
        ON factory_process_products(schema_id, product_hash);
      CREATE INDEX IF NOT EXISTS idx_factory_process_products_schema_ref_hash
        ON factory_process_products(schema_id, artifact_ref, product_hash);
    `);
  } else {
    db.exec(`
      CREATE TABLE factory_process_products_new (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        process_run_id     INTEGER NOT NULL
                                 REFERENCES factory_process_runs(id) ON DELETE RESTRICT,
        product_kind       TEXT NOT NULL,
        product_key        TEXT NOT NULL DEFAULT '',
        schema_id          TEXT NOT NULL,
        artifact_ref       TEXT NOT NULL UNIQUE,
        product_hash       TEXT NOT NULL,
        payload_snapshot   TEXT NOT NULL,
        payload_hash       TEXT NOT NULL,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(process_run_id, product_kind, product_key)
      );
      INSERT INTO factory_process_products_new
        (id, process_run_id, product_kind, product_key, schema_id, artifact_ref,
         product_hash, payload_snapshot, payload_hash, created_at)
      SELECT id, process_run_id, product_kind, product_kind, schema_id, artifact_ref,
             product_hash, payload_snapshot, payload_hash, created_at
        FROM factory_process_products;
      DROP TABLE factory_process_products;
      ALTER TABLE factory_process_products_new RENAME TO factory_process_products;
      CREATE INDEX IF NOT EXISTS idx_factory_process_products_run
        ON factory_process_products(process_run_id, id);
      CREATE INDEX IF NOT EXISTS idx_factory_process_products_hash
        ON factory_process_products(schema_id, product_hash);
    `);
  }
}

export class SqliteProcessProductRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureFactoryProcessProductSchema(db);
  }

  persist<T>(input: {
    processRunId: number;
    productKind: string;
    schema: string;
    productHash: string;
    payload: T;
    artifactRefPrefix: string;
    productKey?: string;
  }): { record: ProcessProductRecord<T>; replayed: boolean } {
    requireNonEmpty(input.productKind, 'product kind');
    requireNonEmpty(input.schema, 'schema');
    requireNonEmpty(input.productHash, 'product hash');
    requireNonEmpty(input.artifactRefPrefix, 'artifact ref prefix');
    if (!Number.isSafeInteger(input.processRunId) || input.processRunId < 1) {
      throw new Error('PROCESS_PRODUCT_INVALID_PROCESS_RUN_ID');
    }
    // product_key defaults to product_kind so legacy v1 callers (Delivery,
    // Development) that do not supply a key keep their one-kind-per-run
    // semantics under the new triple UNIQUE constraint.
    const productKey = (input.productKey ?? '').trim().length > 0
      ? input.productKey!
      : input.productKind;

    const payloadSnapshot = canonicalJson(input.payload);
    const payloadHash = sha256Hex(input.payload);
    const artifactRef =
      `${input.artifactRefPrefix}:${input.processRunId}:${input.productHash}`;

    const existing = this.readRow(input.processRunId, input.productKind, productKey);
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
      `INSERT INTO factory_process_products
        (process_run_id,product_kind,product_key,schema_id,artifact_ref,product_hash,
         payload_snapshot,payload_hash)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      input.processRunId,
      input.productKind,
      productKey,
      input.schema,
      artifactRef,
      input.productHash,
      payloadSnapshot,
      payloadHash,
    );
    const inserted = this.readRow(input.processRunId, input.productKind, productKey);
    if (!inserted) throw new Error('PROCESS_PRODUCT_INSERT_LOST');
    return {
      record: rowToRecord<T>(inserted),
      replayed: false,
    };
  }

  read<T>(
    processRunId: number,
    productKind: string,
    productKey?: string,
  ): ProcessProductRecord<T> | null {
    const row = this.readRow(processRunId, productKind, productKey);
    return row ? rowToRecord<T>(row) : null;
  }

  private readRow(
    processRunId: number,
    productKind: string,
    productKey?: string,
  ): ProcessProductRow | null {
    // When productKey is omitted, default to productKind so legacy v1 callers
    // preserve their one-kind-per-run read semantics.
    const key = (productKey ?? '').trim().length > 0 ? productKey! : productKind;
    const row = this.db.prepare(
      `SELECT process_run_id,product_kind,product_key,schema_id,artifact_ref,product_hash,
              payload_snapshot,payload_hash,created_at
         FROM factory_process_products
        WHERE process_run_id=? AND product_kind=? AND product_key=?`,
    ).get(processRunId, productKind, key) as ProcessProductRow | undefined;
    return row ?? null;
  }
}

interface ProcessProductRow {
  process_run_id: number;
  product_kind: string;
  product_key: string;
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
      `PROCESS_PRODUCT_PAYLOAD_CORRUPT: ${row.process_run_id}/${row.product_kind}/${row.product_key}`,
    );
  }
  if (canonicalJson(payload) !== row.payload_snapshot) {
    throw new Error(
      `PROCESS_PRODUCT_PAYLOAD_NOT_CANONICAL: ${row.process_run_id}/${row.product_kind}/${row.product_key}`,
    );
  }
  if (sha256Hex(payload) !== row.payload_hash) {
    throw new Error(
      `PROCESS_PRODUCT_PAYLOAD_HASH_MISMATCH: ${row.process_run_id}/${row.product_kind}/${row.product_key}`,
    );
  }
  return {
    processRunId: row.process_run_id,
    productKind: row.product_kind,
    productKey: row.product_key,
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
      `PROCESS_PRODUCT_REPLAY_MISMATCH: ${row.process_run_id}/${row.product_kind}/${row.product_key}`,
    );
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`PROCESS_PRODUCT_${label.toUpperCase().replaceAll(' ', '_')}_REQUIRED`);
  }
}
