// src/process-modules/domain/workplace/accepted-authority-head.ts
//
// ADR-053 C1 + C5 — the durable CURRENT accepted-author authority pointer,
// carried as a pure domain value.
//
// C1 (the pointer itself): exactly one row per workplace records which author
// CandidateSet is CURRENT. It is an explicit durable fact, never reconstructed
// by candidate_set_ref hash order or sealed_at/decided_at recency.
//
// C5 (commit 3c5decc — task identity on the head): the head ALSO persists the
// identity of the workplace task whose material it accepted. This is the ROOT
// carry-forward-safe task binding. Neither pole the system tried before is
// authority:
//
//   - submission.task_id  — the ORIGIN process's task. A carried-forward
//     candidate's submission still names the origin task, not the current
//     workplace's task the integration must update. Breaks carry-forward.
//   - ORDER BY t.id DESC  — recency. In a repair cycle (multiple author
//     attempts) the most-recent task is not necessarily the accepted one.
//
// The HEAD is the authority carrying task identity: exact, no recency,
// carry-forward-safe. Downstream integration (C5-03) selects the task from
// this pointer; the acceptance coordinator (C5-02) populates it when the
// author gate accepts.
//
// `acceptedAuthorTaskId` is NULLABLE: a head recorded before C5-02 wires the
// task id, or migrated from a pre-v6 schema, carries NULL. NULL means "task
// identity not yet bound on this head", NOT "the workplace has no task".
//
// K13 (M3, card commit 2) — the head carries the BYTE-IDENTICAL accepted
// identity, not just the pointer: the frozen check-plan digest, the package
// fingerprint (the accepting decision's installation digest), the accepted
// CandidateSet's production revision, its ordered ProductRefs, and the CAS
// baseline the commit was fenced on, content-addressed together as
// `acceptanceId`. "Same accepted revision ⇒ byte-identical authority
// identity" is now checkable from the head row alone. The K13 fields are
// NULLABLE for one reason only: rows written before the K13 extension (the
// idempotent ensure upgrade preserves them). Every K13-era record populates
// all of them; a NULL K13 field on a fresh write is a boundary violation.
//
// # Pure domain
//
// This file imports nothing — it is a pure value type + validation factory.
// Domain purity is enforced by tests/architecture/workplace-domain-purity.test.mjs
// (REG-03/REG-05: domain/workplace/ imports no outward dependency).

/**
 * The durable accepted-author authority pointer for one workplace.
 *
 * Identity is keyed on `workplaceRef` (the serialized WorkplaceRef — stable
 * across every worker/reviewer/repair attempt, REG-05-AC-01). Exactly one head
 * exists per workplace (PK). The head is re-recorded (UPSERT) atomically with
 * each author-gate-accept CAS transition, so it always reflects the CURRENT
 * accepted author.
 */
export interface AcceptedAuthorityHead {
  /** Serialized WorkplaceRef (PK of the head row). */
  readonly workplaceRef: string;
  /** The CURRENT accepted author CandidateSet ref (the C1 exact-key read). */
  readonly acceptedAuthorCandidateSetRef: string;
  /** The gate-decision key that accepted this author CandidateSet. */
  readonly acceptedAuthorGateDecisionKey: string;
  /** Workplace CAS revision at which this acceptance was recorded. */
  readonly revision: number;
  /** ISO timestamp the head was (re-)recorded. */
  readonly recordedAt: string;
  /**
   * ADR-053 C5 — the workplace task whose material this head accepted.
   * Carry-forward-safe task identity. NULL until C5-02 wires it at the
   * acceptance site (or on heads migrated from a pre-v6 schema).
   */
  readonly acceptedAuthorTaskId: string | null;
  /**
   * K13 — content address over the FULL accepted identity body
   * ('authority-acceptance:<sha256>'). Same revision ⇒ same acceptanceId,
   * byte-identically. NULL only on rows written before the K13 extension.
   */
  readonly acceptanceId: string | null;
  /** K13 — the frozen check-plan digest of the accepting GateDecision. */
  readonly checkPlanDigest: string | null;
  /** K13 — the package fingerprint (installation digest) of the acceptance. */
  readonly packageFingerprint: string | null;
  /** K13 — the accepted CandidateSet's production revision ref. */
  readonly productionRevisionRef: string | null;
  /** K13 — the accepted CandidateSet's ProductRefs, in member-ordinal order. */
  readonly productRefs: readonly string[] | null;
  /** K13 — the workplace CAS revision the acceptance commit was fenced on. */
  readonly baselineWorkplaceRevision: number | null;
}

/**
 * Validate and freeze an {@link AcceptedAuthorityHead} at a boundary.
 *
 * Mirrors the `asWorkplaceRef` / `asCardId` brand-at-the-seam pattern: a bad
 * value is rejected here, not deep inside a coordinator or SQL binding.
 *
 * Rules:
 *   - `workplaceRef`, `acceptedAuthorCandidateSetRef`,
 *     `acceptedAuthorGateDecisionKey`, `recordedAt` must be non-empty strings.
 *   - `revision` must be a non-negative integer (CAS token, REG-05-AC-06).
 *   - `acceptedAuthorTaskId` must be a non-empty string or null (NULL means
 *     "task identity not yet bound on this head", not "no task").
 */
export function asAcceptedAuthorityHead(input: {
  readonly workplaceRef: string;
  readonly acceptedAuthorCandidateSetRef: string;
  readonly acceptedAuthorGateDecisionKey: string;
  readonly revision: number;
  readonly recordedAt: string;
  readonly acceptedAuthorTaskId?: string | null;
  readonly acceptanceId?: string | null;
  readonly checkPlanDigest?: string | null;
  readonly packageFingerprint?: string | null;
  readonly productionRevisionRef?: string | null;
  readonly productRefs?: readonly string[] | null;
  readonly baselineWorkplaceRevision?: number | null;
}): AcceptedAuthorityHead {
  requireNonEmpty(input.workplaceRef, 'workplaceRef');
  requireNonEmpty(input.acceptedAuthorCandidateSetRef, 'acceptedAuthorCandidateSetRef');
  requireNonEmpty(input.acceptedAuthorGateDecisionKey, 'acceptedAuthorGateDecisionKey');
  requireNonEmpty(input.recordedAt, 'recordedAt');
  if (!Number.isInteger(input.revision) || input.revision < 0) {
    throw new Error(
      `asAcceptedAuthorityHead: revision must be a non-negative integer, got ${input.revision}`,
    );
  }
  const acceptedAuthorTaskId = input.acceptedAuthorTaskId ?? null;
  if (acceptedAuthorTaskId !== null) {
    requireNonEmpty(acceptedAuthorTaskId, 'acceptedAuthorTaskId');
  }
  // K13 identity fields: nullable ONLY as a group (pre-K13 rows) — a partial
  // presence (some set, some NULL) means a torn write, not a legacy row.
  const k13: {
    acceptanceId: string | null;
    checkPlanDigest: string | null;
    packageFingerprint: string | null;
    productionRevisionRef: string | null;
    productRefs: readonly string[] | null;
    baselineWorkplaceRevision: number | null;
  } = {
    acceptanceId: input.acceptanceId ?? null,
    checkPlanDigest: input.checkPlanDigest ?? null,
    packageFingerprint: input.packageFingerprint ?? null,
    productionRevisionRef: input.productionRevisionRef ?? null,
    productRefs: input.productRefs ?? null,
    baselineWorkplaceRevision: input.baselineWorkplaceRevision ?? null,
  };
  const nonePresent = k13.acceptanceId === null
    && k13.checkPlanDigest === null
    && k13.packageFingerprint === null
    && k13.productionRevisionRef === null
    && k13.productRefs === null
    && k13.baselineWorkplaceRevision === null;
  const allPresent = k13.acceptanceId !== null
    && k13.checkPlanDigest !== null
    && k13.packageFingerprint !== null
    && k13.productionRevisionRef !== null
    && k13.productRefs !== null
    && k13.baselineWorkplaceRevision !== null;
  if (!nonePresent && !allPresent) {
    throw new Error(
      'asAcceptedAuthorityHead: K13 identity fields must be present as a '
      + 'complete set or entirely absent (pre-K13 row); got a partial set',
    );
  }
  if (allPresent) {
    requireNonEmpty(k13.acceptanceId, 'acceptanceId');
    requireNonEmpty(k13.checkPlanDigest, 'checkPlanDigest');
    requireNonEmpty(k13.packageFingerprint, 'packageFingerprint');
    requireNonEmpty(k13.productionRevisionRef, 'productionRevisionRef');
    const productRefs = k13.productRefs as readonly string[];
    if (productRefs.length === 0
      || productRefs.some(ref => typeof ref !== 'string' || ref.trim().length === 0)) {
      throw new Error('asAcceptedAuthorityHead: productRefs must be a non-empty array of non-empty strings');
    }
    const baseline = k13.baselineWorkplaceRevision as number;
    if (!Number.isInteger(baseline) || baseline < 0) {
      throw new Error(
        `asAcceptedAuthorityHead: baselineWorkplaceRevision must be a non-negative integer, got ${baseline}`,
      );
    }
  }
  return Object.freeze({
    workplaceRef: input.workplaceRef,
    acceptedAuthorCandidateSetRef: input.acceptedAuthorCandidateSetRef,
    acceptedAuthorGateDecisionKey: input.acceptedAuthorGateDecisionKey,
    revision: input.revision,
    recordedAt: input.recordedAt,
    acceptedAuthorTaskId,
    ...k13,
    productRefs: k13.productRefs === null ? null : Object.freeze([...k13.productRefs]),
  });
}

// ---------------------------------------------------------------------------
// Internals.
// ---------------------------------------------------------------------------

function requireNonEmpty(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`asAcceptedAuthorityHead: ${label} must be a non-empty string`);
  }
}
