/**
 * workflow-kernel/workshops/formalization/contracts/artifacts.ts - the
 * content-addressing vocabulary shared by the installed Formalization
 * package (FRF-WP11 re-home: these generic surfaces lived in the deleted
 * products.ts; the old-flow product validators died at the cutover, but
 * the package-wide artifact/refusal vocabulary is cell-neutral and stays
 * - re-homed here, beside the WP03 contracts it serves).
 *
 * Laws (unchanged from the WP-11F originals):
 *   - Every product is CONTENT-ADDRESSED: the artifact digest is
 *     recomputed over the canonical product JSON (the kernel canonical
 *     rule - byte-identical to the WP03 common.mjs rule); validators
 *     never trust a declared digest.
 *   - The typed-refusal vocabulary is the closed seven-code kernel set.
 *
 * PURITY: node:crypto via the kernel digest rule only. No session, no
 * SQL, no clock, no workshop-identity conditional in any kernel path.
 */

import { sha256OfCanonical } from '../../../domain/digest.js';

/** One content-addressed sub-artifact: content + its recomputed digest. */
export interface ContentArtifact {
  readonly ref: string;
  readonly digest: string;
  readonly content: unknown;
}

/** Seal one artifact: digest recomputed over the canonical content. */
export function artifactOf(content: unknown): ContentArtifact {
  const digest = sha256OfCanonical(content);
  return { ref: `sha256:${digest}`, digest, content };
}

/* ------------------------------------------------------------------ */
/* Typed product refusals (closed set)                                  */
/* ------------------------------------------------------------------ */

export type ProductRefusalReason =
  | 'MALFORMED_PRODUCT'
  | 'FOREIGN_LINEAGE'
  | 'STALE_LINEAGE'
  | 'MISSING_LINEAGE'
  | 'COVERAGE_GAP'
  | 'DRIFT_DETECTED'
  | 'SCOPE_VIOLATION';

export interface ProductRefusal {
  readonly ok: false;
  readonly refused: true;
  readonly reason: ProductRefusalReason;
  readonly detail: string;
}

export type ProductValidation =
  | { readonly ok: true; readonly artifact: ContentArtifact }
  | ProductRefusal;
