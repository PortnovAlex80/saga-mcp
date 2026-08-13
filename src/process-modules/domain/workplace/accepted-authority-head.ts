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
  return Object.freeze({
    workplaceRef: input.workplaceRef,
    acceptedAuthorCandidateSetRef: input.acceptedAuthorCandidateSetRef,
    acceptedAuthorGateDecisionKey: input.acceptedAuthorGateDecisionKey,
    revision: input.revision,
    recordedAt: input.recordedAt,
    acceptedAuthorTaskId,
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
