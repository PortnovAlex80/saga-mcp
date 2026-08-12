/**
 * CandidateSet — the sealed immutable handoff from a worker to quality control.
 *
 * Target contract: FACTORY-DOMAIN-ACCEPTANCE-REGISTRY REG-12 (Партия на
 * проверку — CandidateSet) + Conveyor Mental Model v4 §«CandidateSet: the
 * sealed handoff to quality control».
 *
 * # Why CandidateSet exists (the bug it replaces)
 *
 * Earlier saga let the gate inspect a mutable "latest product on the desk". A
 * worker could submit several drafts; a concurrent repair could change the
 * desk; and the gate read whatever was there at lookup time. Two runs of the
 * same gate against "the latest" could see DIFFERENT products and produce
 * DIFFERENT verdicts for the same logical candidate. v4 kills that:
 * `execution_complete` SEALS one exact, immutable CandidateSet owned by the
 * fenced execution. The gate reads that set by exact reference — never a
 * mutable latest view (REG-12-AC-04, REG-15-AC-03).
 *
 * The seal key `(workplaceRef, producerExecutionRef, role)` is DETERMINISTIC
 * (REG-12-AC-01): a replay of the same payload returns the same ref; a
 * different payload under the same key is rejected. So a crashed-then-resumed
 * worker, replaying its completion, re-seals the SAME set — no duplicate, no
 * ambiguity.
 *
 * # Membership discipline
 *
 * Each member is either:
 *   - `produced` — created by THIS fenced execution, OR
 *   - `carried-forward` — explicitly borrowed from a NAMED prior CandidateSet
 *     under the product/recovery policy (REG-12-AC-03).
 *
 * An upstream input that merely appears in lineage CANNOT be presented as new
 * output (REG-12-AC-03). This closes the "rewrite history by re-submitting
 * old products" hole: only produced- or explicitly-carried members seal.
 *
 * # Reviewer pinning
 *
 * A reviewer CandidateSet is PINNED to one exact author CandidateSet
 * (REG-12-AC-04): `subjectCandidateSetRef` is REQUIRED when `role=reviewer`.
 * The reviewer emits only declared verdict products and CANNOT mutate the
 * author products. Accepting review output never substitutes it for the
 * authored product (v4 §«CandidateSet»).
 *
 * # Repair
 *
 * A repair attempt receives the rejected author set as immutable INPUT (it
 * reads it) but seals a NEW, distinct CandidateSet (REG-12-AC-05). The new
 * execution's ref is different, so the gate sees two distinct attempts, not a
 * mutation of one.
 *
 * # Pure domain
 *
 * Imports only sibling pure types (`WorkplaceRef`) and the pure-SPI
 * `ProductRef` from `../spi/`. No SQLite, MCP, db.ts, clock, or
 * application/behavioral code.
 */

import type { ProductRef } from '../spi/index.js';
import type { WorkplaceRef } from './workplace-ref.js';

/**
 * Which role produced this CandidateSet.
 *
 * `author` sets are produced by the author execution; `reviewer` sets are
 * produced by the reviewer execution and are PINNED to an author set via
 * `subjectCandidateSetRef` (REG-12-AC-04).
 */
export type CandidateSetRole = 'author' | 'reviewer';

/**
 * How a member came to be in the set.
 *
 * `produced` — the active fenced execution created this product.
 * `carried-forward` — the execution explicitly borrowed this product from a
 * NAMED prior CandidateSet under the product/recovery policy. An upstream
 * input that only appears in lineage is NOT a carried-forward member; it
 * cannot be presented as new output (REG-12-AC-03).
 */
export type CandidateMemberOrigin = 'produced' | 'carried-forward';

/**
 * One member of a sealed CandidateSet.
 *
 * A member is a (ProductRef, origin) pair. `sourceCandidateSetRef` is REQUIRED
 * when `origin=carried-forward` (which prior set was the product borrowed
 * from); it MUST be null when `origin=produced` (the active execution created
 * it, so there is no prior set to cite).
 */
export interface CandidateMember {
  /** Exact content-addressed reference to the product. */
  readonly productRef: ProductRef;
  /** Was this product produced by this execution or borrowed from a prior set? */
  readonly origin: CandidateMemberOrigin;
  /**
   * Required when `origin=carried-forward`: the prior CandidateSet this product
   * was borrowed from. MUST be null when `origin=produced`.
   */
  readonly sourceCandidateSetRef: string | null;
}

/**
 * A sealed immutable CandidateSet — the exact batch handed to quality control.
 *
 * Immutable after sealing. `execution_complete` produces exactly one of these;
 * a replay with the same payload returns the same `candidateSetRef`
 * (REG-12-AC-01). A different payload under the same seal key is rejected.
 */
export interface CandidateSet {
  /** Deterministic seal-reference (see {@link computeCandidateSetRef}). */
  readonly candidateSetRef: string;
  /** The workplace this set belongs to. */
  readonly workplaceRef: WorkplaceRef;
  /**
   * Provenance-only: the execution that presented this set. NOT material
   * authority. ADR-053 clean-break: this field MUST NOT be used to select
   * material after seal.
   */
  readonly producerExecutionRef: string;
  /**
   * ADR-053 — the immutable Workplace production revision this CandidateSet's
   * material was sealed from. This IS the MATERIAL AUTHORITY: the seal key is
   * derived from the revision. REQUIRED — no CandidateSet may be sealed
   * without a revision ref. LEGACY FALLBACK ON producerExecutionRef IS
   * FORBIDDEN.
   */
  readonly productionRevisionRef: string;
  /** author or reviewer (REG-12-AC-04 requires subject for reviewer). */
  readonly role: CandidateSetRole;
  /**
   * REQUIRED when `role=reviewer`: the exact author CandidateSet this reviewer
   * verdict is about. MUST be null when `role=author`.
   */
  readonly subjectCandidateSetRef: string | null;
  /** The sealed members — produced + explicitly carried-forward. */
  readonly members: readonly CandidateMember[];
  /** Opaque receipt the sealing authority issued (gate/lease provenance). */
  readonly sealReceiptRef: string;
  /** SHA-256 over the canonical form of the set (see {@link sealCandidateSet}). */
  readonly candidateSetDigest: string;
  /** ISO timestamp the set was sealed. */
  readonly sealedAt: string;
}

/**
 * Compute the deterministic seal key for a CandidateSet.
 *
 * ADR-053 clean-break: the seal key ALWAYS uses `productionRevisionRef` as the
 * material identity. There is NO fallback to `producerExecutionRef`. Two
 * executions producing the same revision (recovery / carry-forward) derive the
 * same key → the second finds the first's already-sealed CandidateSet
 * (partition invariance).
 *
 * `productionRevisionRef` is REQUIRED. LEGACY FALLBACK IS FORBIDDEN.
 */
export function candidateSetSealKey(input: {
  workplaceRef: WorkplaceRef;
  producerExecutionRef: string;
  productionRevisionRef: string;
  role: CandidateSetRole;
}): string {
  return [
    'candidate-set',
    input.workplaceRef.processRunId,
    input.workplaceRef.moduleRef,
    input.workplaceRef.productionCellId,
    input.workplaceRef.workKey,
    input.productionRevisionRef,
    input.role,
  ].join('/');
}

/**
 * Validate the shape and cross-field rules of a CandidateSet (REG-12).
 *
 * Pure. Throws on any violation. Called by the sealing authority (step 2.3
 * `execution_complete` handler) before persisting, and by the gate (step 1.1d
 * `gate.ts`) before it reads. The rules:
 *
 *   - REG-12-AC-02: every `produced` member has `sourceCandidateSetRef=null`;
 *     every `carried-forward` member cites a non-null prior set.
 *   - REG-12-AC-04: `role=reviewer` REQUIRES a non-null `subjectCandidateSetRef`;
 *     `role=author` REQUIRES it null.
 *   - members are non-empty (a seal of nothing is meaningless — an empty
 *     completion is a failed/lost execution, not a sealed set).
 *   - the digest field is a 64-char lowercase hex SHA-256.
 */
export function assertValidCandidateSet(set: CandidateSet): void {
  requireNonEmpty(set.candidateSetRef, 'candidateSetRef');
  requireNonEmpty(set.producerExecutionRef, 'producerExecutionRef');
  requireNonEmpty(set.productionRevisionRef, 'productionRevisionRef');
  requireNonEmpty(set.sealReceiptRef, 'sealReceiptRef');
  requireNonEmpty(set.sealedAt, 'sealedAt');
  if (set.members.length === 0) {
    throw new Error(
      'CandidateSet.members must be non-empty — a seal of nothing is not a '
        + 'candidate (an empty completion is a failed/lost execution)',
    );
  }
  // Subject-set rule (REG-12-AC-04).
  if (set.role === 'reviewer') {
    if (set.subjectCandidateSetRef === null) {
      throw new Error(
        'REG-12-AC-04 violation: role=reviewer requires a non-null '
          + 'subjectCandidateSetRef (the author set this verdict is about)',
      );
    }
  } else if (set.subjectCandidateSetRef !== null) {
    throw new Error(
      'REG-12-AC-04 violation: role=author requires subjectCandidateSetRef=null',
    );
  }
  // Member origin rule (REG-12-AC-02 + REG-12-AC-03).
  for (let i = 0; i < set.members.length; i += 1) {
    const m = set.members[i]!;
    if (m.origin === 'produced') {
      if (m.sourceCandidateSetRef !== null) {
        throw new Error(
          `REG-12-AC-02 violation: member[${i}] origin=produced but cites a `
            + `sourceCandidateSetRef — produced members belong to this execution`,
        );
      }
    } else if (m.origin === 'carried-forward') {
      if (m.sourceCandidateSetRef === null) {
        throw new Error(
          `REG-12-AC-02 violation: member[${i}] origin=carried-forward but `
            + 'has no sourceCandidateSetRef — carried-forward members MUST '
            + 'name the prior set they were borrowed from',
        );
      }
    } else {
      throw new Error(
        `CandidateMember[${i}].origin must be 'produced' or 'carried-forward'`,
      );
    }
  }
  if (!/^[a-f0-9]{64}$/.test(set.candidateSetDigest)) {
    throw new Error(
      'CandidateSet.candidateSetDigest must be a 64-char lowercase hex SHA-256',
    );
  }
}

/**
 * Compute the deterministic reference (identity) of a sealed CandidateSet.
 *
 * The reference is derived from the seal key (workplace+execution+role) — so a
 * replay of the same execution's completion derives the same reference and
 * resolves to the same row (REG-12-AC-01). The CONTENT digest
 * (`candidateSetDigest`) is separate: it changes when the members change, which
 * is how a replay-with-different-payload is detected and rejected.
 *
 * `sealKey` is the output of {@link candidateSetSealKey}. Keeping the two
 * functions separate makes it explicit that the KEY is computed BEFORE sealing
 * (the coordinator knows the identity it will seal under) while the REF is the
 * persisted identity after the seal succeeds.
 */
export function computeCandidateSetRef(sealKey: string): string {
  // The ref IS the key. We expose a separate function so callers do not
  // construct the string inline (which would let a typo diverge the key the
  // repository indexes under from the ref the gate reads by).
  return sealKey;
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`CandidateSet.${label} must be a non-empty string`);
  }
}
