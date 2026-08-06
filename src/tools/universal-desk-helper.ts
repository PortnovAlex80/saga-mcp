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
  });
  return result.productRef;
}

/** Compute the canonical digest of content (for bridge callers). */
export function computeContentDigest(content: unknown): string {
  return sha256Hex(content);
}
