// src/infrastructure/workplace/sqlite-accepted-authority-head-repository.ts
//
// ADR-053 C1 + C5 — the durable CURRENT accepted-author authority pointer.
//
// The central C1 defect: `acceptedAuthorCandidate()` picked the author
// CandidateSet via `listForWorkplace(...).filter(role==='author')[0]`, where the
// repository ordered rows by `ORDER BY candidate_set_ref DESC` (lexicographic
// hash order). That is not authority — it is an arbitrary attempt chosen by hash,
// so in a repair cycle (multiple author attempts) the reviewer subject, reviewer
// projection and crash recovery could bind to the WRONG author set.
//
// The fix is an explicit, durable pointer: when the AUTHOR gate accepts, the
// coordinator writes this row IN THE SAME transaction as the Workplace CAS
// transition (see ProductionCellCoordinator.applyAcceptanceEvent). The pointer is
// then the single source of truth for "which author CandidateSet is current".
// No recency, no hash order — a direct read by workplace_ref (PK).
//
// ADR-053 C5 (commit 3c5decc) extends the pointer with task identity
// (`accepted_author_task_id`): the workplace task whose material this head
// accepted. This is the carry-forward-safe task binding — neither
// submission.task_id (origin process's task) nor ORDER BY t.id DESC (recency)
// is authority. The HEAD carries task identity; downstream integration (C5-03)
// selects the task from it.

import type Database from 'better-sqlite3';
import type { AcceptedAuthorityHead } from '../../process-modules/domain/workplace/accepted-authority-head.js';
import { asAcceptedAuthorityHead } from '../../process-modules/domain/workplace/accepted-authority-head.js';

export class SqliteAcceptedAuthorityHeadRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Record (or update) the current accepted-author authority for a workplace.
   * UPSERT on workplace_ref. MUST be called inside the same transaction as the
   * author-gate-accept CAS transition so the pointer is durable iff the
   * transition committed.
   *
   * `acceptedAuthorTaskId` (ADR-053 C5) is the carry-forward-safe workplace
   * task identity. Optional: NULL when the caller has not yet bound a task
   * (e.g. pre-C5-02 acceptance wiring). When provided it is persisted verbatim
   * and recalled by {@link read} / {@link readAuthorTaskId}; when absent the
   * column is written NULL.
   */
  record(input: {
    readonly workplaceRef: string;
    readonly acceptedAuthorCandidateSetRef: string;
    readonly acceptedAuthorGateDecisionKey: string;
    readonly revision: number;
    readonly acceptedAuthorTaskId?: string | null;
    readonly now?: () => Date;
  }): void {
    // K13 (ADR-053 C1 hardening) — the head is a MONOTONIC authority
    // pointer: it only moves forward, and a revision number is never
    // reused for different accepted identity. A stale concurrent writer
    // fails closed instead of rolling accepted authority back; a
    // crash-recovery replay of the SAME identity at the SAME revision is
    // idempotent.
    const existing = this.db.prepare(
      `SELECT accepted_author_candidate_set_ref, accepted_author_gate_decision_key,
              accepted_author_task_id, revision
         FROM factory_accepted_authority_head WHERE workplace_ref=?`,
    ).get(input.workplaceRef) as {
      accepted_author_candidate_set_ref: string;
      accepted_author_gate_decision_key: string;
      accepted_author_task_id: string | null;
      revision: number;
    } | undefined;
    if (existing) {
      if (input.revision < existing.revision) {
        throw new Error(
          `AUTHORITY_HEAD_REGRESSION: ${input.workplaceRef} is at revision `
          + `${existing.revision}, refusing ${input.revision}`,
        );
      }
      if (input.revision === existing.revision) {
        const sameIdentity = existing.accepted_author_candidate_set_ref === input.acceptedAuthorCandidateSetRef
          && existing.accepted_author_gate_decision_key === input.acceptedAuthorGateDecisionKey
          && existing.accepted_author_task_id === (input.acceptedAuthorTaskId ?? null);
        if (!sameIdentity) {
          throw new Error(
            `AUTHORITY_HEAD_IDENTITY_CONFLICT: ${input.workplaceRef} revision ${input.revision} `
            + 'cannot be reused with a different accepted identity '
            + `(head has (${existing.accepted_author_candidate_set_ref}, `
            + `${existing.accepted_author_gate_decision_key}, ${existing.accepted_author_task_id}); `
            + `refusing (${input.acceptedAuthorCandidateSetRef}, `
            + `${input.acceptedAuthorGateDecisionKey}, ${input.acceptedAuthorTaskId ?? null}))`,
          );
        }
        return;
      }
    }
    this.db.prepare(
      `INSERT INTO factory_accepted_authority_head
         (workplace_ref, accepted_author_candidate_set_ref,
          accepted_author_gate_decision_key, revision, recorded_at,
          accepted_author_task_id)
       VALUES (@workplaceRef, @acceptedAuthorCandidateSetRef,
               @acceptedAuthorGateDecisionKey, @revision, @recordedAt,
               @acceptedAuthorTaskId)
       ON CONFLICT(workplace_ref) DO UPDATE SET
         accepted_author_candidate_set_ref = excluded.accepted_author_candidate_set_ref,
         accepted_author_gate_decision_key = excluded.accepted_author_gate_decision_key,
         revision = excluded.revision,
         recorded_at = excluded.recorded_at,
         accepted_author_task_id = excluded.accepted_author_task_id
       WHERE excluded.revision > factory_accepted_authority_head.revision`,
    ).run({
      workplaceRef: input.workplaceRef,
      acceptedAuthorCandidateSetRef: input.acceptedAuthorCandidateSetRef,
      acceptedAuthorGateDecisionKey: input.acceptedAuthorGateDecisionKey,
      revision: input.revision,
      recordedAt: (input.now ?? (() => new Date()))().toISOString(),
      acceptedAuthorTaskId: input.acceptedAuthorTaskId ?? null,
    });
  }

  /**
   * The exact accepted-author CandidateSet ref for a workplace, or null when no
   * author acceptance has been recorded yet. This is the C1 exact-key read that
   * replaces the hash-order selector.
   */
  readAuthorCandidateSetRef(workplaceRef: string): string | null {
    const row = this.db.prepare(
      `SELECT accepted_author_candidate_set_ref
         FROM factory_accepted_authority_head
        WHERE workplace_ref = ?`,
    ).get(workplaceRef) as { accepted_author_candidate_set_ref: string } | undefined;
    return row?.accepted_author_candidate_set_ref ?? null;
  }

  /**
   * ADR-053 C5 — the workplace task identity persisted on the accepted-author
   * head for a workplace, or null when the head has not been recorded OR the
   * task identity has not yet been bound (pre-C5-02 wiring / pre-v6 migration).
   * This is the carry-forward-safe task binding the git-integration reads
   * instead of submission.task_id.
   */
  readAuthorTaskId(workplaceRef: string): string | null {
    const row = this.db.prepare(
      `SELECT accepted_author_task_id
         FROM factory_accepted_authority_head
        WHERE workplace_ref = ?`,
    ).get(workplaceRef) as { accepted_author_task_id: string | null } | undefined;
    return row?.accepted_author_task_id ?? null;
  }

  /**
   * The full accepted-author authority head for a workplace, or null when no
   * author acceptance has been recorded yet. Returns the typed
   * {@link AcceptedAuthorityHead} value (validated at the boundary), carrying
   * the C1 author pointer AND the C5 task identity in one read.
   */
  read(workplaceRef: string): AcceptedAuthorityHead | null {
    const row = this.db.prepare(
      `SELECT workplace_ref, accepted_author_candidate_set_ref,
              accepted_author_gate_decision_key, revision, recorded_at,
              accepted_author_task_id
         FROM factory_accepted_authority_head
        WHERE workplace_ref = ?`,
    ).get(workplaceRef) as {
      workplace_ref: string;
      accepted_author_candidate_set_ref: string;
      accepted_author_gate_decision_key: string;
      revision: number;
      recorded_at: string;
      accepted_author_task_id: string | null;
    } | undefined;
    if (!row) return null;
    return asAcceptedAuthorityHead({
      workplaceRef: row.workplace_ref,
      acceptedAuthorCandidateSetRef: row.accepted_author_candidate_set_ref,
      acceptedAuthorGateDecisionKey: row.accepted_author_gate_decision_key,
      revision: row.revision,
      recordedAt: row.recorded_at,
      acceptedAuthorTaskId: row.accepted_author_task_id,
    });
  }
}
