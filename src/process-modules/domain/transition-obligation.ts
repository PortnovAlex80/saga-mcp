// src/process-modules/domain/transition-obligation.ts
//
// ADR-053 C7-01 — domain separation of two concerns previously conflated on the
// transition-obligation `fence` column / `fence` parameter:
//
//   (a) CAUSAL SOURCE REVISION — an identifier of WHICH source fact/revision
//       caused the obligation (provenance). It answers "what made this
//       obligation necessary?" It is NOT an ordering token.
//
//   (b) LEASE FENCE — a MONOTONIC ordering token that prevents a stale lease
//       holder from completing or failing newer work. It answers "which
//       generation of the reconciler is allowed to act on this obligation?"
//       It is NOT an identifier of a source fact.
//
// These two concepts are NOT interchangeable: a causal revision identifies a
// fact; a lease fence orders leases. Swapping them is:
//   - a TYPE ERROR at compile time (the two interfaces are structurally
//     disjoint — different `kind` discriminant), enforced by `npx tsc` over
//     src/ where `append` accepts only CausalSourceRevision and `lease`
//     accepts only LeaseFence; and
//   - a REJECTED OPERATION at runtime (the ledger validates the brand at the
//     append/lease seams), proven by the contract test
//     tests/infrastructure/transition-obligation-fence-separation.contract.test.mjs.
//
// STORAGE NOTE (why two domain types map to one column today):
// Both concepts currently map onto the single `fence` column of
// `factory_transition_obligations`. C7-01 deliberately introduces NO schema
// migration: the column is still SET by `append` with the causal source
// revision and OVERWRITTEN by `lease` with the lease fence. C7-02..C7-06 will
// split the storage so each concept has its own durable home. This file
// establishes the DOMAIN / APPLICATION separation that those cards then carry
// into storage — without it, every later card re-derives the boundary and the
// two concerns keep silently overwriting each other.

// ---------------------------------------------------------------------------
// Distinct branded value types.
//
// The `kind` literal discriminant makes the two types structurally disjoint at
// compile time (a CausalSourceRevision is never assignable to LeaseFence and
// vice versa) AND runtime-distinguishable (the guards / asserts below can tell
// them apart, so a swapped value is detectable and rejectable).
// ---------------------------------------------------------------------------

/**
 * Causal source revision — provenance identifier of the source fact that
 * caused the obligation. NOT a lease fence; NOT an ordering token.
 */
export interface CausalSourceRevision {
  readonly kind: 'CausalSourceRevision';
  readonly value: number;
}

/**
 * Lease fence — monotonic ordering token carried by a lease. NOT a causal
 * revision; NOT a source-fact identifier.
 */
export interface LeaseFence {
  readonly kind: 'LeaseFence';
  readonly value: number;
}

/** Smart constructor: wrap a revision number as causal provenance. */
export function causalSourceRevision(value: number): CausalSourceRevision {
  return { kind: 'CausalSourceRevision', value };
}

/** Smart constructor: wrap a monotonic token as a lease fence. */
export function leaseFence(value: number): LeaseFence {
  return { kind: 'LeaseFence', value };
}

/** Runtime type guard: true only for a CausalSourceRevision. */
export function isCausalSourceRevision(
  x: unknown,
): x is CausalSourceRevision {
  return typeof x === 'object'
    && x !== null
    && (x as { kind?: unknown }).kind === 'CausalSourceRevision';
}

/** Runtime type guard: true only for a LeaseFence. */
export function isLeaseFence(x: unknown): x is LeaseFence {
  return typeof x === 'object'
    && x !== null
    && (x as { kind?: unknown }).kind === 'LeaseFence';
}

/**
 * Assert the value carries the CausalSourceRevision brand. Throws on any other
 * brand (notably a LeaseFence) — a causal revision is not a lease fence. Used
 * at the ledger `append` seam so a swapped value is a rejected operation even
 * when it reaches the ledger through an untyped (JS) caller.
 */
export function assertCausalSourceRevision(
  x: unknown,
): asserts x is CausalSourceRevision {
  if (!isCausalSourceRevision(x)) {
    throw new Error(
      'TRANSITION_OBLIGATION_BRAND_MISMATCH: expected a CausalSourceRevision '
        + '(provenance identifier of the source fact), received '
        + `${brandName(x)}. A causal source revision is NOT a lease fence `
        + '(monotonic ordering token); the two are not interchangeable.',
    );
  }
}

/**
 * Assert the value carries the LeaseFence brand. Throws on any other brand
 * (notably a CausalSourceRevision) — a lease fence is not a causal revision.
 * Used at the ledger `lease` seam so a swapped value is a rejected operation.
 */
export function assertLeaseFence(x: unknown): asserts x is LeaseFence {
  if (!isLeaseFence(x)) {
    throw new Error(
      'TRANSITION_OBLIGATION_BRAND_MISMATCH: expected a LeaseFence '
        + '(monotonic ordering token for lease ownership), received '
        + `${brandName(x)}. A lease fence is NOT a causal source revision `
        + '(source-fact provenance); the two are not interchangeable.',
    );
  }
}

function brandName(x: unknown): string {
  if (typeof x === 'object' && x !== null && 'kind' in x) {
    return String((x as { kind: unknown }).kind);
  }
  return typeof x;
}
