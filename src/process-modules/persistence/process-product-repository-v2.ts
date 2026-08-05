/**
 * W3-A4 — ProcessProductRepository v2 port (exact-by-ProductRef).
 *
 * Spec: docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md §7.
 * Plan: §9.11 (retire the `listArtifactsForNodeInEpic` epic-scope fallback).
 *
 * WHY A V2 PORT
 * -------------
 * The v1 `SqliteProcessProductRepository` (sibling file) is keyed by
 * `(processRunId, productKind)` and answers "what is THE product of kind K for
 * run R?". Wave 3's durable-execution refactor needs a different question:
 * "give me the EXACT product identified by this `ProductRef`
 * `(schemaId, ref, digest)`". That exact query is what
 * `ExecutionContextAssembler` (W3-A5) uses to load upstream products by their
 * content-addressed refs — with NO epic-scope / "latest-in-run" fallback
 * (§9.11). A missing predecessor must surface as `UPSTREAM_PRODUCT_NOT_FOUND`,
 * not as a silent nearest-match.
 *
 * This file defines ONLY the driver-neutral port (interface + record types).
 * The SQLite adapter lives in `sqlite-process-product-repository-v2.ts`. The
 * port imports ONLY from `domain/spi/` (Wave 1 pure types) — a type-only,
 * pure-data edge — so the dependency-direction ratchet (Rule 2/5) stays GREEN.
 * It deliberately does NOT import the v1 sqlite adapter: the record types are
 * defined inline here so the port stays driver-neutral and self-contained.
 *
 * REUSE OF factory_process_products
 * -------------------------------
 * The v2 adapter reuses the EXISTING `factory_process_products` table (created by
 * `ensureFactoryProcessProductSchema` in the v1 file). It only ADDS one index
 * (`idx_factory_process_products_schema_ref_hash` on
 * `(schema_id, artifact_ref, product_hash)`) and one nullable `node_id` column
 * — both idempotent, both owned by W3-A4 (W3-A6 is the SQL owner for
 * `factory_node_runs`; per spec §7/§9, W3-A4 owns `factory_process_products`).
 * No legacy column is removed; v1 read/write paths keep working unchanged.
 */

// Type-only import from the pure SPI layer. ProductRef and NodeProductionEnvelope
// are pure data types defined under domain/spi/ (Rule 5 pure). No runtime edge.
import type {
  NodeProductionEnvelope,
  ProductRef,
} from '../domain/spi/index.js';

/**
 * Reference to a persisted process product — the (schema, ref, hash) triple.
 *
 * Structurally identical to v1's `ProcessProductReference` (defined in the
 * sqlite adapter) and to the persisted-row projection of `ProductRef`. Defined
 * inline here so the port does not import the concrete adapter.
 */
export interface ProcessProductReferenceV2 {
  /** Schema id of the product (e.g. 'factory.discovery-proposal.v1'). */
  readonly schema: string;
  /** Opaque, module-owned artifact reference (maps to ProductRef.ref). */
  readonly ref: string;
  /** SHA-256 over the canonical product body (maps to ProductRef.digest). */
  readonly hash: string;
}

/**
 * A persisted process-product row, in driver-neutral shape.
 *
 * Generic in `T` so callers can ask for a typed payload
 * (`getByProductRef<MyPayload>(ref)`); the adapter does not enforce `T`, it
 * only round-trips JSON, so callers own the cast.
 */
export interface ProcessProductRecordV2<T = unknown> {
  /** Parent ProcessRun id (FK to factory_process_runs.id). */
  readonly processRunId: number;
  /**
   * Module-owned product-kind label (mirrors v1's product_kind column). For v2
   * rows written via `recordProduct`, this is derived from the envelope's
   * `schemaId` (the wrapper schema id) — it carries no extra information beyond
   * the reference, but is preserved for compatibility with v1 keyed reads.
   */
  readonly productKind: string;
  /** The (schema, ref, hash) content-addressed reference. */
  readonly reference: ProcessProductReferenceV2;
  /** The canonical product payload (parsed JSON). */
  readonly payload: T;
  /** SHA-256 over the canonical payload snapshot (covers the full body). */
  readonly payloadHash: string;
  /** ISO timestamp the row was created. */
  readonly createdAt: string;
  /**
   * Flow node that emitted this product. NULL for legacy v1 rows (written
   * before Wave 3 added the column); non-NULL for rows written via
   * `recordProduct`.
   */
  readonly nodeId: string | null;
  /**
   * The durable production envelope, reconstructed from the row. NULL when the
   * row was written by a v1 caller (no envelope fields persisted); non-NULL
   * when written via `ProcessProductRepository.recordProduct` (v2 path).
   */
  readonly envelope: NodeProductionEnvelope | null;
}

/**
 * Result of recording a product. `replayed=true` means an identical row
 * (same schema/ref/hash/payload) already existed and was returned unchanged —
 * the durable equivalent of an immutable frame binding. A byte-different
 * payload under the same `(schemaId, ref)` throws
 * `PROCESS_PRODUCT_REPLAY_MISMATCH` (mirrors v1 semantics).
 */
export interface RecordProductResult<T = unknown> {
  readonly record: ProcessProductRecordV2<T>;
  readonly replayed: boolean;
}

/**
 * Driver-neutral port for exact-by-ProductRef process-product queries.
 *
 * Implementations:
 *   - `SqliteProcessProductRepositoryV2` (this wave, production).
 *   - Fakes/mocks in tests (W3-A5 fakes this port to test
 *     `ExecutionContextAssembler` in isolation).
 *
 * The port is INTENTIONALLY minimal: three methods. Wave 3's
 * `ExecutionContextAssembler` only needs "load by exact ref" and "record for
 * this node"; the v1 `(runId, productKind)` keyed read stays on the v1 class
 * for the existing module runtimes (delivery/development) until those migrate.
 */
export interface ProcessProductRepository {
  /**
   * Exact lookup by `ProductRef`. Matches on `(schemaId, ref, digest)` =
   * `(schema_id, artifact_ref, product_hash)`. Returns `null` when no row
   * matches — callers (W3-A5) translate that into `UPSTREAM_PRODUCT_NOT_FOUND`.
   *
   * This is the §9.11 replacement for the epic-scope `listArtifactsForNodeInEpic`
   * fallback: NO nearest-match, NO "latest-in-epic" heuristic.
   */
  getByProductRef(ref: ProductRef): ProcessProductRecordV2 | null;

  /**
   * Lookup by raw artifact reference (the `ref` component of a ProductRef, or
   * any opaque artifact_ref the caller holds). Returns `null` when absent.
   *
   * Used by callers that hold only the artifact_ref string (e.g. legacy
   * certificate/artifact refs surfaced on a ProcessRunRecord) and need to
   * fetch the full product body. Less precise than `getByProductRef` (no
   * digest check) — prefer `getByProductRef` whenever you have the full ref.
   */
  getByArtifactRef(artifactRef: string): ProcessProductRecordV2 | null;

  /**
   * Persist a `NodeProductionEnvelope` produced by one node of one ProcessRun.
   *
   * - `envelope` — the Wave 1 production envelope (carries schema/artifactRef/
   *   contentHash/bindings + schemaId/productRef/lineage). The persisted
   *   `product_hash` is `envelope.contentHash` (the SHA-256 over the canonical
   *   production body), so the on-disk row is byte-addressable by
   *   `envelope.productRef.digest`.
   * - `processRunId` — the parent ProcessRun (FK to factory_process_runs).
   * - `nodeId` — the Flow node that emitted this product.
   *
   * Idempotent: a second call with a byte-identical envelope returns the
   * existing row with `replayed=true`. A second call with the same
   * `(schemaId, ref)` but a DIFFERENT digest/payload throws
   * `PROCESS_PRODUCT_REPLAY_MISMATCH` (the caller is trying to mutate an
   * immutable content-addressed product).
   */
  recordProduct(
    envelope: NodeProductionEnvelope,
    processRunId: number,
    nodeId: string,
  ): RecordProductResult;
}

/**
 * Sentinel thrown by `recordProduct` when a replayed envelope's content differs
 * from the persisted row. Mirrors v1's `PROCESS_PRODUCT_REPLAY_MISMATCH` but is
 * surfaced from the v2 path so callers can distinguish it. The message embeds
 * the `(schemaId, ref)` identity for diagnostics.
 */
export const PROCESS_PRODUCT_REPLAY_MISMATCH = 'PROCESS_PRODUCT_REPLAY_MISMATCH';

/**
 * Sentinel for an invalid processRunId (< 1 or non-integer). The port refuses
 * to write a product against a nonexistent / unassigned run.
 */
export const PROCESS_PRODUCT_INVALID_PROCESS_RUN_ID = 'PROCESS_PRODUCT_INVALID_PROCESS_RUN_ID';

/**
 * Sentinel for a missing required string field on the envelope (schema,
 * artifactRef, contentHash, nodeId). Thrown before any DB write.
 */
export const PROCESS_PRODUCT_FIELD_REQUIRED = 'PROCESS_PRODUCT_FIELD_REQUIRED';
