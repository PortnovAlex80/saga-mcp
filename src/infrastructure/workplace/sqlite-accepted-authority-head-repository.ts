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
import { canonicalJson, sha256Hex } from '../../shared/canonical-json.js';
import type { AcceptedAuthorityHead } from '../../process-modules/domain/workplace/accepted-authority-head.js';
import { asAcceptedAuthorityHead } from '../../process-modules/domain/workplace/accepted-authority-head.js';

export class SqliteAcceptedAuthorityHeadRepository {
  constructor(private readonly db: Database.Database) {
    this.ensureK13IdentityColumns();
  }

  /**
   * K13 (card commit 2, one schema family) — idempotent additive upgrade of
   * the head with the byte-identical identity columns. PRAGMA-guarded ALTERs
   * so a pre-K13-shaped table upgrades in place, preserving every existing
   * row (whose K13 columns stay NULL — the documented legacy meaning).
   */
  private ensureK13IdentityColumns(): void {
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(factory_accepted_authority_head)').all() as Array<{ name: string }>)
        .map(column => column.name),
    );
    const additions: Array<[string, string]> = [
      ['acceptance_id', 'TEXT'],
      ['check_plan_digest', 'TEXT'],
      ['package_fingerprint', 'TEXT'],
      ['production_revision_ref', 'TEXT'],
      ['product_refs', 'TEXT'],
      ['baseline_workplace_revision', 'INTEGER'],
    ];
    for (const [name, type] of additions) {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE factory_accepted_authority_head ADD COLUMN ${name} ${type}`);
      }
    }
  }

  /**
   * Record (or update) the current accepted-author authority for a workplace.
   * UPSERT on workplace_ref. MUST be called inside the same transaction as the
   * author-gate-accept CAS transition so the pointer is durable iff the
   * transition committed.
   *
   * `acceptedAuthorTaskId` (ADR-053 C5) is the carry-forward-safe workplace
   * task identity. When provided it is persisted verbatim and recalled by
   * {@link read} / {@link readAuthorTaskId}; when absent the column is
   * written NULL.
   *
   * K13 (card commit 2): the FULL accepted identity is REQUIRED — the frozen
   * check-plan digest, the package fingerprint (installation digest), the
   * accepted CandidateSet's production revision and ordered ProductRefs, and
   * the CAS baseline the commit was fenced on. The repository content-addresses
   * them into `acceptanceId`; same revision + different `acceptanceId` is a
   * typed AUTHORITY_HEAD_IDENTITY_CONFLICT in ANY dimension. A pre-K13 row
   * (NULL identity) compares by the pointer triple until it is superseded by
   * a higher revision.
   */
  record(input: {
    readonly workplaceRef: string;
    readonly acceptedAuthorCandidateSetRef: string;
    readonly acceptedAuthorGateDecisionKey: string;
    readonly revision: number;
    readonly acceptedAuthorTaskId?: string | null;
    readonly checkPlanDigest: string;
    readonly packageFingerprint: string;
    readonly productionRevisionRef: string;
    readonly productRefs: readonly string[];
    readonly baselineWorkplaceRevision: number;
    readonly now?: () => Date;
  }): void {
    // K13 (ADR-053 C1 hardening) — the head is a MONOTONIC authority
    // pointer: it only moves forward, and a revision number is never
    // reused for different accepted identity. A stale concurrent writer
    // fails closed instead of rolling accepted authority back; a
    // crash-recovery replay of the SAME identity at the SAME revision is
    // idempotent.
    const identity = this.requireFullIdentity(input);
    const existing = this.db.prepare(
      `SELECT accepted_author_candidate_set_ref, accepted_author_gate_decision_key,
              accepted_author_task_id, acceptance_id, revision
         FROM factory_accepted_authority_head WHERE workplace_ref=?`,
    ).get(input.workplaceRef) as {
      accepted_author_candidate_set_ref: string;
      accepted_author_gate_decision_key: string;
      accepted_author_task_id: string | null;
      acceptance_id: string | null;
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
        this.assertSameRevisionIdentity(existing, input, identity);
        return;
      }
    }
    const result = this.db.prepare(
      `INSERT INTO factory_accepted_authority_head
         (workplace_ref, accepted_author_candidate_set_ref,
          accepted_author_gate_decision_key, revision, recorded_at,
          accepted_author_task_id, acceptance_id, check_plan_digest,
          package_fingerprint, production_revision_ref, product_refs,
          baseline_workplace_revision)
       VALUES (@workplaceRef, @acceptedAuthorCandidateSetRef,
               @acceptedAuthorGateDecisionKey, @revision, @recordedAt,
               @acceptedAuthorTaskId, @acceptanceId, @checkPlanDigest,
               @packageFingerprint, @productionRevisionRef, @productRefs,
               @baselineWorkplaceRevision)
       ON CONFLICT(workplace_ref) DO UPDATE SET
         accepted_author_candidate_set_ref = excluded.accepted_author_candidate_set_ref,
         accepted_author_gate_decision_key = excluded.accepted_author_gate_decision_key,
         revision = excluded.revision,
         recorded_at = excluded.recorded_at,
         accepted_author_task_id = excluded.accepted_author_task_id,
         acceptance_id = excluded.acceptance_id,
         check_plan_digest = excluded.check_plan_digest,
         package_fingerprint = excluded.package_fingerprint,
         production_revision_ref = excluded.production_revision_ref,
         product_refs = excluded.product_refs,
         baseline_workplace_revision = excluded.baseline_workplace_revision
       WHERE excluded.revision > factory_accepted_authority_head.revision`,
    ).run({
      workplaceRef: input.workplaceRef,
      acceptedAuthorCandidateSetRef: input.acceptedAuthorCandidateSetRef,
      acceptedAuthorGateDecisionKey: input.acceptedAuthorGateDecisionKey,
      revision: input.revision,
      recordedAt: (input.now ?? (() => new Date()))().toISOString(),
      acceptedAuthorTaskId: input.acceptedAuthorTaskId ?? null,
      acceptanceId: identity.acceptanceId,
      checkPlanDigest: input.checkPlanDigest,
      packageFingerprint: input.packageFingerprint,
      productionRevisionRef: input.productionRevisionRef,
      productRefs: canonicalJson([...input.productRefs]),
      baselineWorkplaceRevision: input.baselineWorkplaceRevision,
    });
    // CAS resolution: the fenced upsert may have lost to a concurrent writer
    // that committed this workplace after our pre-read. A lost race must be
    // decided against the PERSISTED row — never silently swallowed.
    if (result.changes === 0) {
      const winner = this.db.prepare(
        `SELECT accepted_author_candidate_set_ref, accepted_author_gate_decision_key,
                accepted_author_task_id, acceptance_id, revision
           FROM factory_accepted_authority_head WHERE workplace_ref=?`,
      ).get(input.workplaceRef) as {
        accepted_author_candidate_set_ref: string;
        accepted_author_gate_decision_key: string;
        accepted_author_task_id: string | null;
        acceptance_id: string | null;
        revision: number;
      } | undefined;
      if (!winner) {
        throw new Error(`AUTHORITY_HEAD_INVARIANT_VIOLATED: ${input.workplaceRef} lost the upsert race yet has no row`);
      }
      if (input.revision < winner.revision) {
        throw new Error(
          `AUTHORITY_HEAD_REGRESSION: ${input.workplaceRef} is at revision `
          + `${winner.revision}, refusing ${input.revision}`,
        );
      }
      if (input.revision === winner.revision) {
        this.assertSameRevisionIdentity(winner, input, identity);
        return;
      }
      throw new Error(
        `AUTHORITY_HEAD_INVARIANT_VIOLATED: ${input.workplaceRef} lost the upsert at revision `
        + `${input.revision} but the persisted row is at ${winner.revision}`,
      );
    }
  }

  private requireFullIdentity(input: {
    readonly checkPlanDigest: string;
    readonly packageFingerprint: string;
    readonly productionRevisionRef: string;
    readonly productRefs: readonly string[];
    readonly baselineWorkplaceRevision: number;
    readonly acceptedAuthorCandidateSetRef: string;
    readonly acceptedAuthorGateDecisionKey: string;
    readonly revision: number;
    readonly acceptedAuthorTaskId?: string | null;
    readonly workplaceRef: string;
  }): { readonly acceptanceId: string } {
    for (const [label, value] of [
      ['checkPlanDigest', input.checkPlanDigest],
      ['packageFingerprint', input.packageFingerprint],
      ['productionRevisionRef', input.productionRevisionRef],
    ] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`AUTHORITY_HEAD_IDENTITY_INCOMPLETE: ${label} is required (K13 card commit 2)`);
      }
    }
    if (!Array.isArray(input.productRefs) || input.productRefs.length === 0
      || input.productRefs.some(ref => typeof ref !== 'string' || ref.trim().length === 0)) {
      throw new Error('AUTHORITY_HEAD_IDENTITY_INCOMPLETE: productRefs must be a non-empty ordered array (K13 card commit 2)');
    }
    if (!Number.isInteger(input.baselineWorkplaceRevision) || input.baselineWorkplaceRevision < 0) {
      throw new Error('AUTHORITY_HEAD_IDENTITY_INCOMPLETE: baselineWorkplaceRevision must be a non-negative integer (K13 card commit 2)');
    }
    return {
      acceptanceId: 'authority-acceptance:' + sha256Hex({
        schema: 'factory.accepted-authority-head.v1',
        workplaceRef: input.workplaceRef,
        acceptedAuthorCandidateSetRef: input.acceptedAuthorCandidateSetRef,
        acceptedAuthorGateDecisionKey: input.acceptedAuthorGateDecisionKey,
        revision: input.revision,
        acceptedAuthorTaskId: input.acceptedAuthorTaskId ?? null,
        checkPlanDigest: input.checkPlanDigest,
        packageFingerprint: input.packageFingerprint,
        productionRevisionRef: input.productionRevisionRef,
        productRefs: [...input.productRefs],
        baselineWorkplaceRevision: input.baselineWorkplaceRevision,
      }),
    };
  }

  private assertSameRevisionIdentity(
    existing: {
      accepted_author_candidate_set_ref: string;
      accepted_author_gate_decision_key: string;
      accepted_author_task_id: string | null;
      acceptance_id: string | null;
    },
    input: {
      workplaceRef: string;
      acceptedAuthorCandidateSetRef: string;
      acceptedAuthorGateDecisionKey: string;
      revision: number;
      acceptedAuthorTaskId?: string | null;
    },
    identity: { readonly acceptanceId: string },
  ): void {
    const drifted: string[] = [];
    if (existing.acceptance_id !== null) {
      if (existing.acceptance_id !== identity.acceptanceId) {
        drifted.push(`acceptanceId ${existing.acceptance_id} != ${identity.acceptanceId}`);
      }
    } else {
      // Pre-K13 row: the pointer triple is the best identity it ever had.
      if (existing.accepted_author_candidate_set_ref !== input.acceptedAuthorCandidateSetRef) {
        drifted.push(`candidateSet ${existing.accepted_author_candidate_set_ref} != ${input.acceptedAuthorCandidateSetRef}`);
      }
      if (existing.accepted_author_gate_decision_key !== input.acceptedAuthorGateDecisionKey) {
        drifted.push(`gateDecision ${existing.accepted_author_gate_decision_key} != ${input.acceptedAuthorGateDecisionKey}`);
      }
      if (existing.accepted_author_task_id !== (input.acceptedAuthorTaskId ?? null)) {
        drifted.push(`task ${existing.accepted_author_task_id} != ${input.acceptedAuthorTaskId ?? null}`);
      }
    }
    if (drifted.length > 0) {
      throw new Error(
        `AUTHORITY_HEAD_IDENTITY_CONFLICT: ${input.workplaceRef} revision ${input.revision} `
        + 'cannot be reused with a different accepted identity '
        + `(drifted: ${drifted.join('; ')})`,
      );
    }
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
              accepted_author_task_id, acceptance_id, check_plan_digest,
              package_fingerprint, production_revision_ref, product_refs,
              baseline_workplace_revision
         FROM factory_accepted_authority_head
        WHERE workplace_ref = ?`,
    ).get(workplaceRef) as {
      workplace_ref: string;
      accepted_author_candidate_set_ref: string;
      accepted_author_gate_decision_key: string;
      revision: number;
      recorded_at: string;
      accepted_author_task_id: string | null;
      acceptance_id: string | null;
      check_plan_digest: string | null;
      package_fingerprint: string | null;
      production_revision_ref: string | null;
      product_refs: string | null;
      baseline_workplace_revision: number | null;
    } | undefined;
    if (!row) return null;
    return asAcceptedAuthorityHead({
      workplaceRef: row.workplace_ref,
      acceptedAuthorCandidateSetRef: row.accepted_author_candidate_set_ref,
      acceptedAuthorGateDecisionKey: row.accepted_author_gate_decision_key,
      revision: row.revision,
      recordedAt: row.recorded_at,
      acceptedAuthorTaskId: row.accepted_author_task_id,
      acceptanceId: row.acceptance_id,
      checkPlanDigest: row.check_plan_digest,
      packageFingerprint: row.package_fingerprint,
      productionRevisionRef: row.production_revision_ref,
      productRefs: row.product_refs === null ? null : JSON.parse(row.product_refs) as string[],
      baselineWorkplaceRevision: row.baseline_workplace_revision,
    });
  }
}
