/**
 * SQLite adapter for the universal exact-product store used by Workplaces.
 *
 * A ProcessRun may materialize MANY Workplaces under one node, all emitting the
 * same schema. Therefore logical product_key MUST distinguish exact immutable
 * products; schema alone is not a valid cardinality key.
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

    const envelope: NodeProductionEnvelope = {
      schema: input.schema,
      artifactRef,
      contentHash: input.contentHash,
      bindings: wrapAsBindings(input.content),
      schemaId: input.schema,
      productRef,
      lineage: [],
      // The v1 store enforces UNIQUE(process_run_id, product_kind,
      // product_key). Schema alone therefore permits only one product of that
      // schema in the entire run — invalid for fan-out Workplaces. The exact
      // content-addressed artifactRef is the immutable logical product key.
      productKey: artifactRef,
    };

    let result;
    try {
      result = this.productRepo.recordProduct(
        envelope,
        input.processRunId,
        input.nodeId,
      );
    } catch (err) {
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

interface WorkplaceProductRow {
  process_run_id: number;
  node_id: string | null;
  schema_id: string;
  artifact_ref: string;
  product_hash: string;
  payload_snapshot: string;
  payload_hash: string;
}

function mapRowToRecord(row: WorkplaceProductRow): WorkplaceProductRecord {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload_snapshot);
  } catch {
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

function wrapAsBindings(content: unknown): Record<string, unknown> {
  if (isPlainObject(content)) {
    return content as Record<string, unknown>;
  }
  return { value: content };
}

function unwrapBindings(row: ProcessProductRecordV2): unknown {
  const payload: unknown = row.payload;
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

function extractFieldLabel(message: string): string {
  const idx = message.indexOf(':');
  return idx >= 0 ? message.slice(idx + 1).trim() : 'field';
}
