// src/infrastructure/workplace/sqlite-accepted-authority-head-repository.ts
//
// ADR-053 C1 — the durable CURRENT accepted-author authority pointer.
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

import type Database from 'better-sqlite3';

export class SqliteAcceptedAuthorityHeadRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Record (or update) the current accepted-author authority for a workplace.
   * UPSERT on workplace_ref. MUST be called inside the same transaction as the
   * author-gate-accept CAS transition so the pointer is durable iff the
   * transition committed.
   */
  record(input: {
    readonly workplaceRef: string;
    readonly acceptedAuthorCandidateSetRef: string;
    readonly acceptedAuthorGateDecisionKey: string;
    readonly revision: number;
    readonly now?: () => Date;
  }): void {
    this.db.prepare(
      `INSERT INTO factory_accepted_authority_head
         (workplace_ref, accepted_author_candidate_set_ref,
          accepted_author_gate_decision_key, revision, recorded_at)
       VALUES (@workplaceRef, @acceptedAuthorCandidateSetRef,
               @acceptedAuthorGateDecisionKey, @revision, @recordedAt)
       ON CONFLICT(workplace_ref) DO UPDATE SET
         accepted_author_candidate_set_ref = excluded.accepted_author_candidate_set_ref,
         accepted_author_gate_decision_key = excluded.accepted_author_gate_decision_key,
         revision = excluded.revision,
         recorded_at = excluded.recorded_at`,
    ).run({
      workplaceRef: input.workplaceRef,
      acceptedAuthorCandidateSetRef: input.acceptedAuthorCandidateSetRef,
      acceptedAuthorGateDecisionKey: input.acceptedAuthorGateDecisionKey,
      revision: input.revision,
      recordedAt: (input.now ?? (() => new Date()))().toISOString(),
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
}
