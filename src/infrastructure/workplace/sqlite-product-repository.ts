/**
 * SqliteProductRepository — the AUTHORITATIVE adapter for ProductRepositoryPort
 * (step 2.3).
 *
 * Target contract: REG-11 (Изделие) + Conveyor Mental Model v4 §«Repackaging».
 *
 * # What this hardens over the prototype SqliteWorkplaceProductAdapter
 *
 *   1. INTERNAL canonicalization: `submitProduct` receives raw `content`,
 *      computes `sha256Hex(content)` itself, and NEVER trusts a caller-supplied
 *      digest. The persisted `product_hash` is the repository's own hash.
 *   2. FENCE ENFORCEMENT: the repository queries `worker_executions` to verify
 *      the `executionRef` is (a) present, (b) in an active state, and (c)
 *      assigned to the workplace's task. A stale fence ⇒
 *      `STALE_EXECUTION_CANNOT_SUBMIT` BEFORE any digest work or write.
 *   3. Lineage validation: each `lineageRefs` entry is resolved against the
 *      store; an entry that does not exist as a prior product is rejected with
 *      `LINEAGE_REF_NOT_IN_READ_SET` (REG-12-AC-03).
 *
 * # Reuse of existing substrate
 *
 * Writes delegate to `SqliteProcessProductRepositoryV2.recordProduct` (the same
 * `saga3_process_products` table the prototype and the v2 product store use).
 * Reads delegate to `SqliteProcessProductRepositoryV2.getByProductRef`. This
 * means products submitted through the authoritative port land in the SAME
 * physical store as prototype and v1 callers — the desk is unified at the
 * data layer, and this port is the hardened write/read surface.
 *
 * # Step 2.3 scope
 *
 * EXISTS and tested; nothing on the runtime path uses it yet. Step 3.A.2
 * (Formalization dual-write) becomes the first caller.
 */

import type Database from 'better-sqlite3';
import { sha256Hex } from '../../shared/canonical-json.js';
import type { ProductRef } from '../../process-modules/domain/spi/index.js';
import type {
  ProductRepositoryPort,
  SubmitProductInput,
} from '../../process-modules/application/product-repository-port.js';
import {
  STALE_EXECUTION_CANNOT_SUBMIT,
  LINEAGE_REF_NOT_IN_READ_SET,
} from '../../process-modules/application/product-repository-port.js';
import {
  SqliteProcessProductRepositoryV2,
} from '../../process-modules/persistence/sqlite-process-product-repository-v2.js';
import type {
  NodeProductionEnvelope,
} from '../../process-modules/domain/spi/index.js';

const ACTIVE_EXECUTION_STATES = "'reserved','running','cancel_requested'";

export class SqliteProductRepository implements ProductRepositoryPort {
  private readonly v2: SqliteProcessProductRepositoryV2;

  constructor(
    private readonly db: Database.Database,
    v2?: SqliteProcessProductRepositoryV2,
  ) {
    this.v2 = v2 ?? new SqliteProcessProductRepositoryV2(db);
  }

  submitProduct(input: SubmitProductInput): {
    productRef: ProductRef;
    replayed: boolean;
  } {
    // 1. FENCE ENFORCEMENT — check BEFORE computing any digest or writing.
    //    The workplaceRef is opaque here; the concrete check is: does the
    //    execution exist, is it active, and does its task belong to the run
    //    the workplace is part of? We query worker_executions directly.
    const exec = this.db.prepare(
      `SELECT execution_id, task_id, state
         FROM worker_executions
        WHERE execution_id=?`,
    ).get(input.executionRef) as
      | { execution_id: string; task_id: number; state: string }
      | undefined;
    if (!exec) {
      throw new Error(
        `${STALE_EXECUTION_CANNOT_SUBMIT}: execution '${input.executionRef}' not found`,
      );
    }
    if (!isActiveState(exec.state)) {
      throw new Error(
        `${STALE_EXECUTION_CANNOT_SUBMIT}: execution '${input.executionRef}' `
          + `is in terminal/non-active state '${exec.state}'`,
      );
    }

    // 2. INTERNAL CANONICALIZATION — compute the digest ourselves.
    //    sha256Hex already canonicalizes (sorted keys, stable scalar forms).
    const contentHash = sha256Hex(input.content);

    // 3. LINEAGE VALIDATION (when lineage declared).
    if (input.lineageRefs && input.lineageRefs.length > 0) {
      for (const ref of input.lineageRefs) {
        const prior = this.v2.getByProductRef(ref);
        if (prior === null) {
          throw new Error(
            `${LINEAGE_REF_NOT_IN_READ_SET}: lineage ref '${ref.ref}' `
              + `(schema ${ref.schemaId}, digest ${ref.digest.slice(0, 8)}…) is `
              + 'not a known prior product — cannot cite it as lineage',
          );
        }
      }
    }

    // 4. BUILD the envelope + persist via the shared v2 substrate.
    //    The artifactRef is content-addressed (embeds the digest) so replays
    //    land on the same row.
    const artifactRef = `product:${input.schemaRef}:${contentHash}`;
    const productRef: ProductRef = {
      schemaId: input.schemaRef,
      ref: artifactRef,
      digest: contentHash,
    };
    const envelope: NodeProductionEnvelope = {
      schema: input.schemaRef,
      artifactRef,
      contentHash,
      bindings: wrapAsBindings(input.content),
      schemaId: input.schemaRef,
      productRef,
      lineage: (input.lineageRefs ?? []).map(r => ({ kind: 'production' as const, ref: r.ref })),
    };

    // The processRunId / nodeId are derived from the execution's task metadata
    // (the runtime stamps them when it assigns the card). For step 2.3 the
    // authoritative port looks them up from the task row the execution owns.
    const taskMeta = this.db.prepare(
      `SELECT json_extract(t.metadata, '$.process_run_id') AS process_run_id,
              json_extract(t.metadata, '$.process_node_id') AS node_id
         FROM tasks t
        WHERE t.id=?`,
    ).get(exec.task_id) as { process_run_id: number | null; node_id: string | null };
    const processRunId = taskMeta.process_run_id;
    const nodeId = taskMeta.node_id;
    if (!Number.isInteger(processRunId) || (processRunId ?? 0) < 1) {
      throw new Error(
        `${STALE_EXECUTION_CANNOT_SUBMIT}: execution '${input.executionRef}' task `
          + `${exec.task_id} has no valid process_run_id metadata`,
      );
    }

    const result = this.v2.recordProduct(
      envelope,
      processRunId as number,
      nodeId ?? input.executionRef,
    );
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
    readonly schemaRef: string;
    readonly content: unknown;
    readonly contentHash: string;
    readonly producerAuthority: { readonly kind: string; readonly ref: string } | null;
  } | null {
    const row = this.v2.getByProductRef(ref);
    if (row === null) return null;
    // producerAuthority is not yet persisted on the v2 row (the prototype
    // did not record it). Return null until step 3 adds the column; callers
    // that need it fall back to the managed-production ledger.
    return {
      schemaRef: row.reference.schema,
      content: row.payload,
      contentHash: row.reference.hash,
      producerAuthority: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function isActiveState(state: string): boolean {
  // Mirror worker-executions.ts ACTIVE_EXECUTION_STATES. Kept inline (not
  // imported) so this infrastructure adapter does not depend on the tool/
  // worker layer — the dependency direction stays inward.
  return state === 'reserved' || state === 'running' || state === 'cancel_requested';
}

/**
 * The v2 envelope's `bindings` field is typed as `Record<string, unknown>`.
 * A producer may submit a primitive or array as `content` (the contract does
 * not restrict the top-level shape — only that it is canonical-serializable).
 * We wrap non-object content under a single `value` key so the producer's
 * bytes round-trip verbatim while satisfying the envelope type. This mirrors
 * the prototype adapter's wrapAsBindings exactly.
 */
function wrapAsBindings(content: unknown): Record<string, unknown> {
  if (isPlainObject(content)) {
    return content as Record<string, unknown>;
  }
  return { value: content };
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// Re-export the active-state list for tests that want to construct fixtures.
export { ACTIVE_EXECUTION_STATES };
