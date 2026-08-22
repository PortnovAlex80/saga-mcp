/**
 * Authoritative universal product writer.
 *
 * Every module result is content-addressed and bound to its producing
 * execution fence. Every rejection propagates to the caller.
 */

import type Database from 'better-sqlite3';
import { SqliteProductRepository } from '../infrastructure/workplace/sqlite-product-repository.js';
import { sha256Hex } from '../shared/canonical-json.js';
import type { ProductRef } from '../process-modules/domain/spi/index.js';
import { SqliteManagedNodeSubmissionRepository } from '../process-modules/persistence/sqlite-managed-node-submission-repository.js';

let cachedRepo: SqliteProductRepository | null = null;
let cachedDb: Database.Database | null = null;

/**
 * Write or idempotently replay a fenced product on the universal desk.
 */
export function writeProduct(
  db: Database.Database,
  input: {
    /** The schema of the product (e.g. 'factory.artifact-ref.v1'). */
    schemaRef: string;
    /** Canonical content payload. */
    content: unknown;
    /** The execution fence that produced this product (for fence enforcement). */
    executionRef: string;
    /**
     * Logical instance key within this product kind (e.g. `artifact:42`).
     * When omitted, the persistence layer falls back to `schemaRef`.
     */
    productKey?: string;
    /** Artifact-ref bridge only: re-project on logical-key conflict. */
    reprojectLogicalKey?: boolean;
  },
): ProductRef {
  if (cachedDb !== db) {
    cachedRepo = new SqliteProductRepository(db);
    cachedDb = db;
  }
  const result = cachedRepo!.submitProduct({
    workplaceRef: null,
    executionRef: input.executionRef,
    schemaRef: input.schemaRef,
    content: input.content,
    productKey: input.productKey,
    ...(input.reprojectLogicalKey ? { reprojectLogicalKey: true } : {}),
  });
  return result.productRef;
}

/** Compute the canonical digest of content (for bridge callers). */
export function computeContentDigest(content: unknown): string {
  return sha256Hex(content);
}

/**
 * Publish the typed result of one live execution to the Production Cell gate.
 * Process identity is resolved from server-authored task metadata; callers only
 * provide the already-validated schema, payload, and execution fence.
 */
export function recordExecutionProduct(
  db: Database.Database,
  input: {
    schema: string;
    content: unknown;
    executionRef: string;
    taskId: number;
  },
): ProductRef | null {
  const managed = db.prepare(
    `SELECT json_extract(metadata, '$.process_run_id') AS processRunId
       FROM tasks WHERE id=?`,
  ).get(input.taskId) as { processRunId: number | null } | undefined;
  if (!Number.isInteger(managed?.processRunId) || (managed?.processRunId ?? 0) < 1) {
    return null;
  }
  const result = new SqliteManagedNodeSubmissionRepository(db)
    .submitForCurrentExecution(
      { schema: input.schema, payload: input.content },
      {
        ...process.env,
        SAGA_MANAGED_EXECUTION: '1',
        SAGA_EXECUTION_ID: input.executionRef,
        SAGA_TASK_ID: String(input.taskId),
      },
    );
  return {
    schemaId: result.record.schema,
    ref: result.record.artifactRef,
    digest: result.record.contentHash,
  };
}
