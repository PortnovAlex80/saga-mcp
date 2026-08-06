/**
 * T8 — SQLite adapter for `WorkplaceProductPort`.
 *
 * This is a THIN WRAPPER over the EXISTING universal product store. It does
 * NOT create new tables, does NOT change schemas, and does NOT touch the four
 * `SqliteProcessProductRepositoryV2` (which reuses the v1
 * `factory_process_products` table plus its v2 `node_id` column and exact-lookup
 * index).
 *
 * # Mapping
 *
 * The v2 product repository is keyed by `NodeProductionEnvelope`. This adapter
 * builds the envelope from the workplace-port's flat `submitProduct` input so
 * the producer does not have to know the envelope shape:
 *
 *   workplace input field  →  envelope field
 *   ─────────────────────────────────────────
 *   schema                 →  envelope.schema            (production schema)
 *   `${moduleRef}:${nodeId}:${contentHash}`
 *                          →  envelope.artifactRef       (opaque module ref)
 *   contentHash            →  envelope.contentHash       (= product_hash)
 *   content                →  envelope.bindings          (the payload body)
 *   schema                 →  envelope.schemaId          (wrapper schema)
 *   schema/ref/digest      →  envelope.productRef        (content-addressed)
 *
 * The artifact reference is derived deterministically from
 * `(moduleRef, nodeId, contentHash)` so the same product submitted twice lands
 * on the same row (idempotent replay), and the produced `ProductRef.ref` is
 * stable across processes.
 *
 * # Purity / ownership
 *
 * Construction is cheap and the schema is ensured on first use (idempotent via
 * the v2 repo's constructor). Production wires one instance in the composition
 * root and shares it via `ModuleSharedDeps`; tests construct one against an
 * in-memory or temp DB.
 */

import type Database from 'better-sqlite3';
import { getDb } from '../../db.js';
import type {
  NodeProductionEnvelope,
  ProductRef,
} from '../domain/spi/index.js';
import type {
  WorkplaceProductPort,
  WorkplaceProductRecord,
} from '../application/workplace-product-port.js';
import {
  WORKPLACE_PRODUCT_FIELD_REQUIRED,
  WORKPLACE_PRODUCT_INVALID_PROCESS_RUN_ID,
  WORKPLACE_PRODUCT_REPLAY_MISMATCH,
} from '../application/workplace-product-port.js';
import { SqliteProcessProductRepositoryV2 } from './sqlite-process-product-repository-v2.js';
import type {
  ProcessProductRepository,
  ProcessProductRecordV2,
} from './process-product-repository-v2.js';

/**
 * Concrete SQLite implementation of `WorkplaceProductPort`.
 *
 * Delegates to `SqliteProcessProductRepositoryV2` (the existing universal
 * store). Holds no mutable state of its own.
 */
export class SqliteWorkplaceProductAdapter implements WorkplaceProductPort {
  private readonly db: Database.Database;
  private readonly productRepo: ProcessProductRepository;

  constructor(
    db: Database.Database = getDb(),
    productRepo: ProcessProductRepository = new SqliteProcessProductRepositoryV2(db),
  ) {
    this.db = db;
    this.productRepo = productRepo;
  }

  submitProduct(input: {
    processRunId: number;
    nodeId: string;
    moduleRef: string;
    schema: string;
    content: unknown;
    contentHash: string;
    executionRef?: string;
  }): { productRef: ProductRef; replayed: boolean } {
    // Validate inputs BEFORE any DB write. Each required field must be a
    // non-empty string; processRunId must be a positive integer. The port
    // surface is the workplace contract, so these are the workplace-port
    // sentinels (not the v2 repo's).
    requireNonEmpty(input.schema, 'schema');
    requireNonEmpty(input.moduleRef, 'moduleRef');
    requireNonEmpty(input.nodeId, 'nodeId');
    requireNonEmpty(input.contentHash, 'contentHash');
    if (
      !Number.isSafeInteger(input.processRunId)
      || input.processRunId < 1
    ) {
      throw new Error(WORKPLACE_PRODUCT_INVALID_PROCESS_RUN_ID);
    }

    const artifactRef = buildArtifactRef(
      input.moduleRef,
      input.nodeId,
      input.contentHash,
    );
    const productRef: ProductRef = {
      schemaId: input.schema,
      ref: artifactRef,
      digest: input.contentHash,
    };

    // Build the NodeProductionEnvelope the v2 repo persists. The bindings ARE
    // the submitted content (the producer's canonical payload). The port does
    // not wrap or transform it — what you submit is what gets read back.
    const envelope: NodeProductionEnvelope = {
      schema: input.schema,
      artifactRef,
      contentHash: input.contentHash,
      // The v2 repo canonicalizes + hashes `bindings`; a non-plain-object
      // body would fail canonical-serialization upstream. We pass it through
      // verbatim so content-addressing matches the caller's expectation
      // (contentHash is sha256 of canonical(content)).
      bindings: wrapAsBindings(input.content),
      schemaId: input.schema,
      productRef,
      lineage: [],
    };

    // executionRef is an optional audit fence. The product table does not have
    // an execution_ref column (we deliberately do NOT change the schema), so
    // it is recorded on the NodeRun side by the executor, not here. We accept
    // it for forward-compat and ignore it at the storage layer.

    let result;
    try {
      result = this.productRepo.recordProduct(
        envelope,
        input.processRunId,
        input.nodeId,
      );
    } catch (err) {
      // Translate the v2 repo's replay-mismatch sentinel into the
      // workplace-port sentinel so callers see one error vocabulary.
      const msg = (err as Error).message ?? '';
      if (msg.startsWith('PROCESS_PRODUCT_REPLAY_MISMATCH')) {
        throw new Error(
          `${WORKPLACE_PRODUCT_REPLAY_MISMATCH}: ${input.schema}/${artifactRef}`,
        );
      }
      if (msg.startsWith('PROCESS_PRODUCT_FIELD_REQUIRED')) {
        throw new Error(
          `${WORKPLACE_PRODUCT_FIELD_REQUIRED}: ${extractFieldLabel(msg)}`,
        );
      }
      if (msg === 'PROCESS_PRODUCT_INVALID_PROCESS_RUN_ID') {
        throw new Error(WORKPLACE_PRODUCT_INVALID_PROCESS_RUN_ID);
      }
      throw err;
    }

    return {
      productRef: {
        schemaId: result.record.reference.schema,
        ref: result.record.reference.ref,
        digest: result.record.reference.hash,
      },
      replayed: result.replayed,
    };
  }

  readProduct(ref: ProductRef): {
    schema: string;
    content: unknown;
    contentHash: string;
  } | null {
    const row = this.productRepo.getByProductRef(ref);
    if (row === null) return null;
    return {
      schema: row.reference.schema,
      content: unwrapBindings(row),
      contentHash: row.reference.hash,
    };
  }

  readNodeProducts(
    processRunId: number,
    nodeId: string,
  ): WorkplaceProductRecord[] {
    // The v2 port exposes exact-ref reads, not node-scoped listing. The node
    // scope is persisted in the `node_id` column (added by the v2 schema), so
    // we query the table directly. This is the ONLY place this adapter
    // touches SQL outside the v2 repo — and it is a pure SELECT against
    // existing columns, so it does not change the schema or the v2 contract.
    requireNonEmpty(nodeId, 'nodeId');
    if (
      !Number.isSafeInteger(processRunId)
      || processRunId < 1
    ) {
      throw new Error(WORKPLACE_PRODUCT_INVALID_PROCESS_RUN_ID);
    }

    const rows = this.db.prepare(
      `SELECT process_run_id, node_id, schema_id, artifact_ref, product_hash,
              payload_snapshot, payload_hash
         FROM factory_process_products
        WHERE process_run_id=? AND node_id=?
        ORDER BY id ASC`,
    ).all(processRunId, nodeId) as WorkplaceProductRow[];

    return rows.map((row) => mapRowToRecord(row));
  }
}

// ---------------------------------------------------------------------------
// Internal helpers.
// ---------------------------------------------------------------------------

interface WorkplaceProductRow {
  process_run_id: number;
  node_id: string | null;
  schema_id: string;
  artifact_ref: string;
  product_hash: string;
  payload_snapshot: string;
  payload_hash: string;
}

/**
 * Map a raw product row to a `WorkplaceProductRecord`. The row's payload is
 * already canonical JSON (the v2 repo wrote it), so we parse + trust the
 * stored hash. We do NOT re-hash here: the row was validated on write and the
 * v2 read path re-validates; double-checking on every node-scope read would be
 * redundant CPU for a list query.
 */
function mapRowToRecord(row: WorkplaceProductRow): WorkplaceProductRecord {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_snapshot);
  } catch {
    // A corrupt row should not silently disappear from a list query. Surface
    // it with a clear identity so an operator can repair the row.
    throw new Error(
      `WORKPLACE_PRODUCT_PAYLOAD_CORRUPT: ${row.process_run_id}/${row.artifact_ref}`,
    );
  }
  return {
    processRunId: row.process_run_id,
    nodeId: row.node_id ?? '',
    schema: row.schema_id,
    ref: row.artifact_ref,
    contentHash: row.product_hash,
    payload,
  };
}

/**
 * The v2 envelope's `bindings` field is typed as `Record<string, unknown>`. A
 * workplace-port producer may submit a primitive or array as `content` (the
 * lingua-franca contract does not restrict the top-level shape — only that it
 * is canonical-serializable). To preserve the producer's bytes verbatim while
 * satisfying the envelope type, we wrap non-object content under a single
 * `value` key. On read, `unwrapBindings` reverses the wrap so the caller gets
 * back exactly what they submitted.
 *
 * The wrap is applied ONLY to non-plain-object content. Plain objects pass
 * through unwrapped (the common case — most products are object payloads), so
 * their `bindings` round-trip byte-identical to a direct v2 caller.
 */
function wrapAsBindings(content: unknown): Record<string, unknown> {
  if (isPlainObject(content)) {
    return content as Record<string, unknown>;
  }
  return { value: content };
}

function unwrapBindings(row: ProcessProductRecordV2): unknown {
  const payload: unknown = row.payload;
  // Only reverse the wrap when the envelope was written by THIS adapter, i.e.
  // the payload is a plain object with exactly the synthetic `value` key. We
  // cannot perfectly distinguish a producer that genuinely submitted
  // `{value: x}` from a wrapped primitive, but the wrap is only applied to
  // non-object content, so a plain-object payload is always unwrapped verbatim.
  if (row.envelope === null || !isPlainObject(payload)) {
    return payload;
  }
  const obj = payload as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && obj[keys[0]!] !== undefined && keys[0] === 'value') {
    return obj.value;
  }
  return payload;
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Build a deterministic, opaque artifact reference from the producing identity.
 * Embedding `contentHash` makes the ref content-addressed: the same product
 * submitted twice derives the same ref and lands on the same row (idempotent).
 * Embedding `moduleRef` + `nodeId` keeps refs unique across workshops and
 * nodes, even when two nodes emit byte-identical bodies.
 */
function buildArtifactRef(
  moduleRef: string,
  nodeId: string,
  contentHash: string,
): string {
  return `workplace:${moduleRef}:${nodeId}:${contentHash}`;
}

function requireNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${WORKPLACE_PRODUCT_FIELD_REQUIRED}: ${label}`);
  }
}

/**
 * Extract the field label from a v2 `PROCESS_PRODUCT_FIELD_REQUIRED: <label>`
 * message so the translated workplace-port message preserves the detail.
 */
function extractFieldLabel(message: string): string {
  const idx = message.indexOf(':');
  return idx >= 0 ? message.slice(idx + 1).trim() : 'field';
}
