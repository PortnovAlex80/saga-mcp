/**
 * T8 — WorkplaceProductPort: universal submit + read API for cross-module
 * product handoff ("one desk for all workshops").
 *
 * # Why this port exists
 *
 * The Product Delivery lifecycle has FOUR workshops (Discovery, Formalization,
 * Development, Delivery), and historically each had its own submit tool writing
 * to its own table:
 *
 *   - Discovery:     `proposal_submit`        → saga3_proposals
 *   - Formalization: `artifact_create`        → saga3_managed_artifact_productions
 *   - Development:   `process_node_submit`    → saga3_managed_node_submissions
 *   - Delivery:      kernel-only              → saga3_external_effect_events
 *
 * All four produce the SAME physical thing — text with a schema and a
 * content_hash — but each has its own submit tool, its own table, and its own
 * read path. Cross-module handoff (e.g. Formalization reading a Discovery
 * certificate) is therefore bespoke per pair.
 *
 * The Development module ALREADY writes its durable products through a universal
 * store: `SqliteProcessProductRepository` (v1) / `SqliteProcessProductRepositoryV2`
 * (v2), both backed by the `saga3_process_products` table. This port surfaces
 * that store as the single LINGUA FRANCA for cross-module product refs: any
 * workshop MAY submit a typed product here, and any other workshop MAY read it
 * back by exact content-addressed reference.
 *
 * # What this port does NOT do
 *
 * It does NOT replace the four legacy submit tools or their tables. Those keep
 * working unchanged. It also does NOT replace module-internal provenance reads
 * (the `managed-production-ledger` is the source of truth for "what did this
 * node produce, and what traces did it leave?"). This port is purely the
 * cross-module handoff path — a NEW capability future code CAN use, not a
 * forced migration of existing code.
 *
 * # Pure port
 *
 * This file defines ONLY the driver-neutral port (interface + record types). It
 * imports the `ProductRef` type from `domain/spi/` (a pure-data edge) so the
 * dependency-direction ratchet stays GREEN — the same rule the v2 port follows.
 * The concrete SQLite adapter lives in
 * `persistence/sqlite-workplace-product-adapter.ts`.
 */

import type { ProductRef } from '../domain/spi/index.js';

/**
 * Submit a typed product to the universal desk.
 *
 * The product is content-addressed: `contentHash` MUST be the SHA-256 over the
 * canonical JSON of `content` (the adapter re-derives the canonical bytes and
 * enforces this on read, mirroring the v1/v2 product repositories). Submission
 * is idempotent by content-addressed identity — a second call with a
 * byte-identical payload returns the existing row with `replayed=true`; a call
 * that reuses a `(schema, ref)` with a DIFFERENT digest throws
 * `WORKPLACE_PRODUCT_REPLAY_MISMATCH` (the caller is trying to mutate an
 * immutable content-addressed product).
 *
 * `moduleRef` is the producing module's name (e.g. 'product-discovery') and
 * `nodeId` is the Flow node that emitted the product. Together with
 * `processRunId` they scope the product for node-scoped reads
 * (`readNodeProducts`).
 *
 * `executionRef` is an OPTIONAL execution-fence token (the worker's
 * `executionId`). It is persisted for audit but NOT enforced by the port —
 * enforcement (if any) belongs to the caller that holds the fence.
 */
export interface WorkplaceProductPort {
  submitProduct(input: {
    processRunId: number;
    nodeId: string;
    moduleRef: string;
    schema: string;
    /** Canonical JSON payload (primitive / plain-object / array only). */
    content: unknown;
    /** SHA-256 over the canonical JSON of `content`. */
    contentHash: string;
    /** Optional execution-fence token, persisted for audit. */
    executionRef?: string;
  }): { productRef: ProductRef; replayed: boolean };

  /**
   * Read a product by exact content-addressed reference.
   *
   * Used for cross-module handoff (e.g. Formalization reading a Discovery
   * certificate). Matches on the `(schemaId, ref, digest)` triple exactly —
   * NO nearest-match, NO "latest-in-run" fallback. Returns `null` when no row
   * matches (callers translate that into a not-found error).
   */
  readProduct(ref: ProductRef): {
    schema: string;
    content: unknown;
    contentHash: string;
  } | null;

  /**
   * Read all products produced by a specific node in a process run.
   *
   * Used by kernel handlers for node-scoped reads (the workplace's durable
   * products). Returns rows in insertion order (by ascending row id).
   */
  readNodeProducts(
    processRunId: number,
    nodeId: string,
  ): WorkplaceProductRecord[];
}

/**
 * A workplace product row in driver-neutral shape.
 *
 * `payload` is the parsed canonical JSON body the producer submitted.
 * `ref` is the opaque, module-owned artifact reference (the `ref` component of
 * a `ProductRef`).
 */
export interface WorkplaceProductRecord {
  processRunId: number;
  nodeId: string;
  schema: string;
  ref: string;
  contentHash: string;
  payload: unknown;
}

/**
 * Sentinel thrown by `submitProduct` when a replayed product's content differs
 * from the persisted row. Mirrors `PROCESS_PRODUCT_REPLAY_MISMATCH` from the v2
 * product port so callers can distinguish a workplace-port replay violation.
 * The message embeds the `(schema, ref)` identity for diagnostics.
 */
export const WORKPLACE_PRODUCT_REPLAY_MISMATCH =
  'WORKPLACE_PRODUCT_REPLAY_MISMATCH';

/**
 * Sentinel for an invalid processRunId (< 1 or non-integer). The port refuses
 * to write a product against a nonexistent / unassigned run.
 */
export const WORKPLACE_PRODUCT_INVALID_PROCESS_RUN_ID =
  'WORKPLACE_PRODUCT_INVALID_PROCESS_RUN_ID';

/**
 * Sentinel for a missing required string field (schema, ref, contentHash,
 * nodeId, moduleRef). Thrown before any DB write.
 */
export const WORKPLACE_PRODUCT_FIELD_REQUIRED =
  'WORKPLACE_PRODUCT_FIELD_REQUIRED';
