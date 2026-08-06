/**
 * W3-A4 — SQLite adapter for ProcessProductRepository v2 (exact-by-ProductRef).
 *
 * Spec: docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md §7.
 *
 * Reuses the EXISTING `factory_process_products` table (owned by the v1
 * `SqliteProcessProductRepository`). This adapter only:
 *   - ADDS `idx_factory_process_products_schema_ref_hash` — an index on
 *     `(schema_id, artifact_ref, product_hash)` so the exact-by-ProductRef
 *     lookup is O(log n) instead of a full table scan. Idempotent
 *     (`CREATE INDEX IF NOT EXISTS`).
 *   - ADDS a nullable `node_id TEXT` column (idempotent `ALTER` guarded by a
 *     `PRAGMA table_info` check, mirroring the pattern in
 *     `sqlite-process-run-repository.ts`).
 *
 * SQL OWNERSHIP: per spec §7/§9, W3-A6 is the single SQL writer for
 * `factory_node_runs`; W3-A4 owns `factory_process_products`. Both changes here are
 * additive and idempotent; v1 read/write paths are untouched. No NOT NULL
 *
 * Two-hash design (inherited from v1, unchanged):
 *   - `product_hash` = the domain identity exposed by the module contract
 *     (= `envelope.contentHash` = `ProductRef.digest`). This is the column the
 *     exact-by-ProductRef query matches against.
 *   - `payload_hash` = SHA-256 over the canonical payload snapshot
 *     (= `sha256Hex(envelope.bindings)`). Enforced on every read so a corrupt
 *     or tampered row fails loudly, not silently.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type {
  NodeProductionEnvelope,
  ProductRef,
} from '../domain/spi/index.js';
// Reuse the v1 table-creation function so there is exactly ONE definition of
// the factory_process_products base schema. This adapter only adds the v2 index
// + node_id column on top.
import { ensureFactoryProcessProductSchema } from './sqlite-process-product-repository.js';
import {
  PROCESS_PRODUCT_FIELD_REQUIRED,
  PROCESS_PRODUCT_INVALID_PROCESS_RUN_ID,
  PROCESS_PRODUCT_REPLAY_MISMATCH,
  type ProcessProductRecordV2,
  type ProcessProductRepository,
  type RecordProductResult,
} from './process-product-repository-v2.js';

/**
 * Ensure the v2 additions to `factory_process_products` exist:
 *   1. the base table + v1 indexes (delegated to the v1 schema function);
 *   2. the v2 exact-lookup index `(schema_id, artifact_ref, product_hash)`;
 *   3. the nullable `node_id` column (additive ALTER, idempotent).
 *
 * Safe to call on every adapter construction and at the top of any handler that
 * touches the table. Idempotent throughout.
 */
export function ensureFactoryProcessProductV2Schema(db: Database.Database): void {
  // 1. Base table + v1 indexes (idempotent).
  ensureFactoryProcessProductSchema(db);

  // 2. Exact-by-ProductRef index. (schema_id, artifact_ref, product_hash) is
  //    exactly the (schemaId, ref, digest) triple a ProductRef carries, so the
  //    getByProductRef query is a direct equality probe on this index.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_factory_process_products_schema_ref_hash
      ON factory_process_products(schema_id, artifact_ref, product_hash);
  `);

  // 3. Nullable node_id column (additive). Guarded by a PRAGMA check so the
  //    ALTER runs at most once per database file, mirroring the column-add
  //    pattern in sqlite-process-run-repository.ts.
  const columns = db.prepare('PRAGMA table_info(factory_process_products)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'node_id')) {
    db.exec('ALTER TABLE factory_process_products ADD COLUMN node_id TEXT');
  }
}

/**
 * Concrete SQLite implementation of `ProcessProductRepository` (v2).
 *
 * Construction is cheap; the schema is ensured on first use (idempotent).
 * Production wires one instance in the composition root; tests construct one
 * against an in-memory or temp DB.
 */
export class SqliteProcessProductRepositoryV2 implements ProcessProductRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database = getDb()) {
    this.db = db;
    ensureFactoryProcessProductV2Schema(db);
  }

  getByProductRef(ref: ProductRef): ProcessProductRecordV2 | null {
    // Exact match on the (schemaId, ref, digest) triple. The index
    // idx_factory_process_products_schema_ref_hash serves this probe directly.
    // No LIKE, no epic-scope fallback, no "latest" heuristic (§9.11).
    const row = this.db.prepare(
      `SELECT process_run_id, product_kind, product_key, schema_id, artifact_ref, product_hash,
              payload_snapshot, payload_hash, created_at, node_id
         FROM factory_process_products
        WHERE schema_id=? AND artifact_ref=? AND product_hash=?`,
    ).get(ref.schemaId, ref.ref, ref.digest) as ProcessProductV2Row | undefined;
    return row ? rowToV2Record(row) : null;
  }

  getByArtifactRef(artifactRef: string): ProcessProductRecordV2 | null {
    if (artifactRef.length === 0) return null;
    // artifact_ref has a UNIQUE constraint in the base schema, so this is at
    // most one row.
    const row = this.db.prepare(
      `SELECT process_run_id, product_kind, product_key, schema_id, artifact_ref, product_hash,
              payload_snapshot, payload_hash, created_at, node_id
         FROM factory_process_products
        WHERE artifact_ref=?`,
    ).get(artifactRef) as ProcessProductV2Row | undefined;
    return row ? rowToV2Record(row) : null;
  }

  recordProduct(
    envelope: NodeProductionEnvelope,
    processRunId: number,
    nodeId: string,
  ): RecordProductResult {
    // Validate inputs BEFORE any DB write. The envelope's schema/artifactRef/
    // contentHash are the content-addressed identity; nodeId ties the row to
    // the emitting Flow node; processRunId must be a real FK target.
    requireNonEmpty(envelope.schema, 'schema');
    requireNonEmpty(envelope.artifactRef, 'artifactRef');
    requireNonEmpty(envelope.contentHash, 'contentHash');
    requireNonEmpty(envelope.schemaId, 'schemaId');
    requireNonEmpty(nodeId, 'nodeId');
    if (!Number.isSafeInteger(processRunId) || processRunId < 1) {
      throw new Error(PROCESS_PRODUCT_INVALID_PROCESS_RUN_ID);
    }

    // The payload body is the envelope's bindings (the machine-filled
    // parameters downstream nodes consume). Canonicalize + hash so the row is
    // byte-reproducible and tamper-evident on read.
    const payloadSnapshot = canonicalJson(envelope.bindings);
    const payloadHash = sha256Hex(envelope.bindings);
    // product_hash is the domain identity = envelope.contentHash. This is what
    // ProductRef.digest points at, so getByProductRef finds this exact row.
    const productHash = envelope.contentHash;
    // product_kind: derived from the envelope wrapper's schemaId. Preserved for
    // compatibility with v1 keyed reads; carries no information beyond the
    // reference but keeps the NOT NULL column populated.
    const productKind = envelope.schemaId;
    // product_key: the logical instance within this kind. Defaults to the
    // singletons working under the triple UNIQUE constraint). The
    // artifact-ref bridge sets productKey='artifact:<id>' so multiple FR/NFR/
    // RULE products of the same kind coexist in one process run.
    const productKey = (envelope.productKey ?? '').trim().length > 0
      ? envelope.productKey!
      : productKind;

    // Replay detection: a row with the same (schema_id, artifact_ref) already
    // present is the same content-addressed identity. A true replay requires
    // the FULL binding to match: same process run, same product kind, same
    // logical product key, and same content. A row that shares the
    // content-addressed artifact_ref but has a DIFFERENT binding (e.g. the same
    // product resubmitted under another productKey, or by another process run)
    // is a binding mismatch, not a benign replay.
    const existing = this.readRowBySchemaRef(
      envelope.schema,
      envelope.artifactRef,
    );
    if (existing) {
      assertReplay(existing, {
        processRunId,
        productKind,
        productKey,
        schemaId: envelope.schemaId,
        productHash,
        payloadSnapshot,
        payloadHash,
      });
      return {
        record: rowToV2Record(existing),
        replayed: true,
      };
    }

    try {
      this.db.prepare(
        `INSERT INTO factory_process_products
          (process_run_id, product_kind, product_key, schema_id, artifact_ref, product_hash,
           payload_snapshot, payload_hash, node_id)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        processRunId,
        productKind,
        productKey,
        envelope.schema,
        envelope.artifactRef,
        productHash,
        payloadSnapshot,
        payloadHash,
        nodeId,
      );
    } catch (error) {
      // Another process may insert the same content-addressed product between
      // our replay probe and INSERT. Re-read after the constraint and accept
      // only a byte-identical binding; assertReplay still fails closed for a
      // genuine logical-key or lineage collision.
      if (!isSqliteConstraint(error)) throw error;
      const raced = this.readRowBySchemaRef(envelope.schema, envelope.artifactRef);
      if (!raced) throw error;
      assertReplay(raced, {
        processRunId,
        productKind,
        productKey,
        schemaId: envelope.schemaId,
        productHash,
        payloadSnapshot,
        payloadHash,
      });
      return { record: rowToV2Record(raced), replayed: true };
    }

    const inserted = this.readRowBySchemaRef(
      envelope.schema,
      envelope.artifactRef,
    );
    if (!inserted) throw new Error('PROCESS_PRODUCT_INSERT_LOST');
    return {
      record: rowToV2Record(inserted),
      replayed: false,
    };
  }

  private readRowBySchemaRef(
    schemaId: string,
    artifactRef: string,
  ): ProcessProductV2Row | null {
    const row = this.db.prepare(
      `SELECT process_run_id, product_kind, product_key, schema_id, artifact_ref, product_hash,
              payload_snapshot, payload_hash, created_at, node_id
         FROM factory_process_products
        WHERE schema_id=? AND artifact_ref=?`,
    ).get(schemaId, artifactRef) as ProcessProductV2Row | undefined;
    return row ?? null;
  }
}

function isSqliteConstraint(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    && (error as { code: string }).code.startsWith('SQLITE_CONSTRAINT');
}

// ---------------------------------------------------------------------------
// Row shapes + mapping.
// ---------------------------------------------------------------------------

interface ProcessProductV2Row {
  process_run_id: number;
  product_kind: string;
  product_key: string;
  schema_id: string;
  artifact_ref: string;
  product_hash: string;
  payload_snapshot: string;
  payload_hash: string;
  created_at: string;
  node_id: string | null;
}

/**
 * Map a raw row to a v2 record. Re-validates the payload on the way out
 * (canonical-JSON round-trip + payload-hash check), so a corrupt or tampered
 * row fails loudly at read time — the same invariant v1 enforces. Throws
 * PROCESS_PRODUCT_PAYLOAD_* on mismatch (mirrors v1 error codes).
 *
 * The `envelope` field is reconstructed ONLY when the row was written via the
 * envelope NULL — the v1 caller did not persist the wrapper fields, so
 * reconstructing a NodeProductionEnvelope would require fabricating schemaId/
 * productRef/lineage, which is exactly the kind of silent fill-in §9.11
 * forbids.
 */
function rowToV2Record(row: ProcessProductV2Row): ProcessProductRecordV2 {
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

  // envelope=NULL; callers that need the envelope must go through recordProduct.
  let envelope: NodeProductionEnvelope | null = null;
  if (row.node_id !== null) {
    const productRef: ProductRef = {
      schemaId: row.schema_id,
      ref: row.artifact_ref,
      digest: row.product_hash,
    };
    envelope = {
      schema: row.schema_id,
      artifactRef: row.artifact_ref,
      contentHash: row.product_hash,
      bindings: payload as Record<string, unknown>,
      schemaId: row.product_kind,
      productKey: row.product_key,
      productRef,
      // Lineage is not persisted in the products table (it lives on the NodeRun
      // row, owned by W3-A6). We surface an empty lineage here; callers that
      // need full provenance read it from the NodeRun, not from the product.
      lineage: [],
    };
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
    payload,
    payloadHash: row.payload_hash,
    createdAt: row.created_at,
    nodeId: row.node_id,
    envelope,
  };
}

function assertReplay(
  row: ProcessProductV2Row,
  expected: {
    processRunId: number;
    productKind: string;
    productKey: string;
    schemaId: string;
    productHash: string;
    payloadSnapshot: string;
    payloadHash: string;
  },
): void {
  if (
    row.process_run_id !== expected.processRunId
    || row.product_kind !== expected.productKind
    || row.product_key !== expected.productKey
    || row.product_kind !== expected.schemaId
    || row.product_hash !== expected.productHash
    || row.payload_snapshot !== expected.payloadSnapshot
    || row.payload_hash !== expected.payloadHash
  ) {
    throw new Error(
      `${PROCESS_PRODUCT_REPLAY_MISMATCH}: ${row.schema_id}/${row.artifact_ref} `
        + `(binding run=${row.process_run_id}/kind=${row.product_kind}/key=${row.product_key})`,
    );
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${PROCESS_PRODUCT_FIELD_REQUIRED}: ${label}`);
  }
}
