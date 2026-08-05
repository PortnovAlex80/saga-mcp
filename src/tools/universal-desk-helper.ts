/**
 * Universal desk dual-write helper (Conveyor v4 steps 3.A.2/3.B.2/3.C.2).
 *
 * When SAGA_WORKPLACE_WRITE=on, MCP tools that create module-specific products
 * (artifact_create, proposal_submit, process_node_submit) additionally write
 * a content-addressed ProductRef onto the universal desk via
 * ProductRepositoryPort. This is the dual-write bridge: the legacy table
 * remains authoritative, and the universal desk fills as a shadow.
 *
 * Each MCP tool calls `dualWriteProduct` after its legacy write succeeds. The
 * helper no-ops when the feature-flag is off.
 */

import type Database from 'better-sqlite3';
import { SqliteProductRepository } from '../infrastructure/workplace/sqlite-product-repository.js';
import { sha256Hex } from '../shared/canonical-json.js';
import type { ProductRef } from '../process-modules/domain/spi/index.js';

let cachedRepo: SqliteProductRepository | null = null;
let cachedDb: Database.Database | null = null;

/**
 * Write a product onto the universal desk. Safe to call unconditionally —
 * no-ops when SAGA_WORKPLACE_WRITE is not 'on'.
 *
 * @returns the ProductRef when written (or replayed), null when skipped.
 */
export function dualWriteProduct(
  db: Database.Database,
  input: {
    /** The schema of the product (e.g. 'saga3.artifact-ref.v1'). */
    schemaRef: string;
    /** Canonical content payload. */
    content: unknown;
    /** The execution fence that produced this product (for fence enforcement). */
    executionRef: string;
  },
): ProductRef | null {
  if (process.env.SAGA_WORKPLACE_WRITE !== 'on') return null;
  if (cachedDb !== db) {
    cachedRepo = new SqliteProductRepository(db);
    cachedDb = db;
  }
  try {
    const result = cachedRepo!.submitProduct({
      workplaceRef: null,
      executionRef: input.executionRef,
      schemaRef: input.schemaRef,
      content: input.content,
    });
    return result.productRef;
  } catch {
    // Fence enforcement may reject (e.g. execution not found when called
    // outside a managed execution). Best-effort shadow — do not crash the
    // legacy MCP tool. The legacy table is still authoritative.
    return null;
  }
}

/** Compute the canonical digest of content (for bridge callers). */
export function computeContentDigest(content: unknown): string {
  return sha256Hex(content);
}
