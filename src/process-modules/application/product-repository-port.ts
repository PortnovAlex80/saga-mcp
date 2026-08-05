/**
 * ProductRepositoryPort — the AUTHORITATIVE universal product desk (step 2.3).
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-11 (Изделие —
 * ProductEnvelope / ProductRef) + Conveyor Mental Model v4 §«Universal conveyor
 * protocol surface» and §«Repackaging the implementation that already exists».
 *
 * # Relationship to WorkplaceProductPort (the prototype)
 *
 * `WorkplaceProductPort` (T8, step 1.1) is a PROTOTYPE: it trusts a
 * caller-supplied digest and does NOT enforce `executionRef` (the fence). v4
 * §«Repackaging» explicitly calls this out:
 *
 *   > "Harden the adapter: the current prototype trusts a caller-supplied
 *   > digest and does not enforce executionRef; the authoritative adapter
 *   > must canonicalize and hash internally, verify lineage/schema/fence,
 *   > and reject stale writes."
 *
 * This port is that hardening. It is the AUTHORITATIVE
 * `ProductRepositoryPort` that step 3 cutover targets. The prototype stays
 * in place (step 1 callers keep working) until step 3 retires it.
 *
 * # What this port adds over the prototype
 *
 *   1. INTERNAL canonicalization: the caller passes raw `content`; the port
 *      computes the SHA-256 itself (REG-11-AC-01: "repository canonicalizes/
 *      hashes internally and does not trust a caller-supplied digest").
 *   2. FENCE ENFORCEMENT: `submitProduct` takes a mandatory `executionRef`
 *      and the repository verifies the execution is still live at submit time
 *      (REG-08-AC-03: "submit/seal atomically verify the live worker fence;
 *      a stale execution cannot submit or seal"). A stale fence ⇒
 *      `STALE_EXECUTION_CANNOT_SUBMIT`.
 *   3. Lineage validation: every submitted product declares its lineage; the
 *      port verifies each lineage ref is in the execution's pinned read set
 *      (REG-11-AC-02: "schema, digest, producer authority, fence-at-submit
 *      and lineage are checked at the trust boundary").
 *
 * # Pure port
 *
 * Imports only pure-SPI types. The concrete adapter lives in infrastructure.
 */

import type {
  ProductRef,
} from '../domain/spi/index.js';

/**
 * The outcome of a fence check. The repository returns this rather than
 * throwing so the caller (the conveyor runtime) can translate it into the
 * correct domain event without a try/catch.
 */
export type FenceCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'EXECUTION_NOT_FOUND' | 'EXECUTION_NOT_ACTIVE' | 'EXECUTION_NOT_ASSIGNED_TO_WORKPLACE'; readonly detail: string };

/**
 * Input to `submitProduct`. The caller supplies raw content + lineage + the
 * active execution fence; the repository computes the digest internally.
 */
export interface SubmitProductInput {
  /** The workplace this product belongs to. */
  readonly workplaceRef: unknown;
  /** The fenced execution producing this product (mandatory). */
  readonly executionRef: string;
  /** Schema id of the product. */
  readonly schemaRef: string;
  /** Raw product content — the repository canonicalizes + hashes this. */
  readonly content: unknown;
  /**
   * Lineage refs this product cites. Each MUST be in the execution's pinned
   * read set; an upstream input cannot be presented as new output merely
   * because it appears in lineage (REG-12-AC-03).
   */
  readonly lineageRefs?: readonly ProductRef[];
  /** Opaque producer-authority tag (worker-execution | gate-run | ...). */
  readonly producerAuthority?: { readonly kind: string; readonly ref: string };
}

/**
 * The AUTHORITATIVE universal product desk.
 *
 * Implemented by `SqliteProductRepository` (step 2.3 infrastructure). The
 * port is the single submit/read surface every workshop's products flow
 * through once step 3 cutover is complete.
 */
export interface ProductRepositoryPort {
  /**
   * Submit a product. Canonicalizes + hashes internally, enforces the live
   * fence, validates lineage, and persists atomically. Returns the resulting
   * `ProductRef` (content-addressed) and whether the row was a replay.
   *
   * REG-11-AC-01: the repository does NOT trust `callerSuppliedDigest`.
   * REG-08-AC-03: a stale execution cannot submit.
   * REG-12-AC-01: idempotent on content-addressed identity.
   */
  submitProduct(input: SubmitProductInput): {
    productRef: ProductRef;
    replayed: boolean;
  };

  /**
   * Read a product by exact content-addressed reference. Returns null when
   * no row matches (callers translate that into a not-found error).
   *
   * REG-11-AC-03: consumers read by exact ref, never by "latest worker".
   */
  readProduct(ref: ProductRef): {
    readonly schemaRef: string;
    readonly content: unknown;
    readonly contentHash: string;
    readonly producerAuthority: { readonly kind: string; readonly ref: string } | null;
  } | null;
}

/**
 * Sentinel thrown by `submitProduct` when the execution fence is invalid
 * (not found, not active, or not assigned to this workplace). The repository
 * checks the fence BEFORE computing the digest, so a stale worker cannot
 * pollute the content-addressed store.
 */
export const STALE_EXECUTION_CANNOT_SUBMIT = 'STALE_EXECUTION_CANNOT_SUBMIT';

/**
 * Sentinel thrown when a lineage ref is not in the execution's pinned read
 * set. REG-12-AC-03: an upstream input cannot be presented as new output.
 */
export const LINEAGE_REF_NOT_IN_READ_SET = 'LINEAGE_REF_NOT_IN_READ_SET';
