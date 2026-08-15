// src/infrastructure/workplace/sqlite-workplace-production-revision-repository.ts
//
// ADR-053 Phase 3 — persistence for the immutable Workplace production
// material model.
//
// Both contributions and revisions are append-only (enforced by triggers in
// schema.ts). Lookups are EXACT-REF only — there is no "latest revision by
// recency" query. The parent revision is tracked by the caller (the production
// cell executor), not selected by ordering. This is the ADR-053 invariant: no
// post-seal consumer selects material by latest.
//
// `getRevisionByMaterialDigest` is the partition-invariance probe: if a
// revision with the same materialDigest already exists for this workplace,
// the same material was already sealed (possibly through a different execution
// partition) and the existing revision is returned. This is how Run 011
// recovery converges: the second partition finds the first partition's
// revision instead of creating a divergent one.

import type { Database as SqliteDatabase } from 'better-sqlite3';
import {
  buildContribution,
  type MemberOperation,
  type RevisionMember,
  type SourceAdapter,
  type WorkplaceContribution,
  type WorkplaceProductionRevision,
} from '../../process-modules/domain/workplace/workplace-production-revision.js';

// ---------------------------------------------------------------------------
// Row types.
// ---------------------------------------------------------------------------
interface ContributionRow {
  contribution_ref: string;
  workplace_ref: string;
  contributor_execution_ref: string;
  source_adapter: string;
  operations: string;
  content_digest: string;
  parent_contribution_ref: string | null;
  created_at: string;
}

interface RevisionRow {
  revision_ref: string;
  workplace_ref: string;
  parent_revision_ref: string | null;
  members: string;
  contributing_execution_refs: string;
  presenter_ref: string;
  material_digest: string;
  semantic_digest: string;
  sealed_at: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Repository.
// ---------------------------------------------------------------------------
export class SqliteWorkplaceProductionRevisionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  // --- Contributions ---

  /**
   * Append a contribution. Idempotent on contribution_ref (INSERT OR IGNORE).
   * Returns the persisted contribution.
   */
  appendContribution(input: {
    workplaceRef: string;
    contributorExecutionRef: string;
    sourceAdapter: SourceAdapter;
    operations: readonly MemberOperation[];
    parentContributionRef: string | null;
  }): WorkplaceContribution {
    const contribution = buildContribution(input);
    this.db.prepare(
      `INSERT OR IGNORE INTO factory_workplace_contributions
         (contribution_ref, workplace_ref, contributor_execution_ref,
          source_adapter, operations, content_digest, parent_contribution_ref)
       VALUES (@contributionRef, @workplaceRef, @contributorExecutionRef,
               @sourceAdapter, @operations, @contentDigest, @parentContributionRef)`,
    ).run({
      contributionRef: contribution.contributionRef,
      workplaceRef: contribution.workplaceRef,
      contributorExecutionRef: contribution.contributorExecutionRef,
      sourceAdapter: contribution.sourceAdapter,
      operations: JSON.stringify(contribution.operations),
      contentDigest: contribution.contentDigest,
      parentContributionRef: contribution.parentContributionRef,
    });
    return contribution;
  }

  getContribution(contributionRef: string): WorkplaceContribution | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_workplace_contributions WHERE contribution_ref = ?`,
    ).get(contributionRef) as ContributionRow | undefined;
    return row ? contributionRowToObject(row) : null;
  }

  /**
   * List all contributions for a workplace in creation order. Used by the
   * revision assembler to replay the contribution chain.
   */
  listContributions(workplaceRef: string): readonly WorkplaceContribution[] {
    const rows = this.db.prepare(
      `SELECT * FROM factory_workplace_contributions
       WHERE workplace_ref = ?
       ORDER BY created_at ASC, contribution_ref ASC`,
    ).all(workplaceRef) as ContributionRow[];
    return rows.map(contributionRowToObject);
  }

  // --- Revisions ---

  /**
   * Append a sealed revision. Idempotent: a replay of the same seal, or a second
   * partition sealing semantically-equivalent material, finds the existing row
   * (PK on revision_ref, and the UNIQUE(workplace, material_digest) index from
   * ADR-053 C15). Either way the INSERT is ignored and the PERSISTED row wins.
   *
   * Returns the PERSISTED revision (C15 persisted-return discipline), NOT the
   * input object — so callers always hold the actual stored authority, which may
   * differ from the input by revisionRef when a semantic-equivalent revision was
   * sealed first by another partition.
   */
  appendRevision(revision: WorkplaceProductionRevision): WorkplaceProductionRevision {
    this.db.prepare(
      `INSERT OR IGNORE INTO factory_workplace_production_revisions
         (revision_ref, workplace_ref, parent_revision_ref, members,
          contributing_execution_refs, presenter_ref, material_digest,
          semantic_digest, sealed_at)
       VALUES (@revisionRef, @workplaceRef, @parentRevisionRef, @members,
               @contributingExecutionRefs, @presenterRef, @materialDigest,
               @semanticDigest, @sealedAt)`,
    ).run({
      revisionRef: revision.revisionRef,
      workplaceRef: revision.workplaceRef,
      parentRevisionRef: revision.parentRevisionRef,
      members: JSON.stringify(revision.members),
      contributingExecutionRefs: JSON.stringify(revision.contributingExecutionRefs),
      presenterRef: revision.presenterRef,
      materialDigest: revision.materialDigest,
      semanticDigest: revision.semanticDigest,
      sealedAt: revision.sealedAt,
    });
    // ADR-053 C15 — return the row that actually won the structural dedup. If
    // this insert was ignored because a semantic-equivalent revision already
    // existed (different revisionRef, same semantic_digest), surface THAT row so
    // the caller converges on the canonical revision rather than its own input.
    const persisted = this.getRevision(revision.revisionRef)
      ?? this.getRevisionByMaterialDigest(revision.workplaceRef, revision.materialDigest);
    if (!persisted) {
      throw new Error(
        `REVISION_APPEND_INVARIANT: insert was ignored but no persisted row found for `
          + `${revision.workplaceRef}/${revision.semanticDigest}`,
      );
    }
    return persisted;
  }

  getRevision(revisionRef: string): WorkplaceProductionRevision | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_workplace_production_revisions WHERE revision_ref = ?`,
    ).get(revisionRef) as RevisionRow | undefined;
    return row ? revisionRowToObject(row) : null;
  }

  /**
   * Partition-invariance probe: find a revision for this workplace with a
   * matching semantic digest. If the same material was already sealed through
   * a different execution partition, this returns the existing revision
   * rather than allowing a divergent one. Returns null if no match.
   *
   * This is an EXACT-VALUE lookup on semantic_digest, NOT a recency ordering.
   */
  getRevisionByMaterialDigest(
    workplaceRef: string,
    materialDigest: string,
  ): WorkplaceProductionRevision | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_workplace_production_revisions
       WHERE workplace_ref = ? AND material_digest = ?
       LIMIT 1`,
    ).get(workplaceRef, materialDigest) as RevisionRow | undefined;
    return row ? revisionRowToObject(row) : null;
  }

  /**
   * ADR-053 B-1/C15 — run a unit of work in one better-sqlite3 IMMEDIATE
   * transaction. Used to make revision-append + CandidateSet-seal atomic, so a
   * CandidateSet can never reference a revision that was not persisted. BEGIN
   * IMMEDIATE acquires the write lock before the probe read, so the
   * getRevisionByMaterialDigest -> appendRevision convergence sequence is
   * serialized across concurrent partitions (structural UNIQUE backs it up).
   * Both repositories share this `db`, and neither appendRevision nor
   * CandidateSetRepo.seal opens its own BEGIN, so this SAVEPOINT spans both.
   */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
}

// ---------------------------------------------------------------------------
// Row → object mapping.
// ---------------------------------------------------------------------------
function contributionRowToObject(row: ContributionRow): WorkplaceContribution {
  return {
    contributionRef: row.contribution_ref,
    workplaceRef: row.workplace_ref,
    contributorExecutionRef: row.contributor_execution_ref,
    sourceAdapter: row.source_adapter as SourceAdapter,
    operations: JSON.parse(row.operations) as MemberOperation[],
    contentDigest: row.content_digest,
    parentContributionRef: row.parent_contribution_ref,
    createdAt: row.created_at,
  };
}

function revisionRowToObject(row: RevisionRow): WorkplaceProductionRevision {
  return {
    revisionRef: row.revision_ref,
    workplaceRef: row.workplace_ref,
    parentRevisionRef: row.parent_revision_ref,
    members: JSON.parse(row.members) as RevisionMember[],
    contributingExecutionRefs: JSON.parse(row.contributing_execution_refs) as string[],
    presenterRef: row.presenter_ref,
    materialDigest: row.material_digest,
    semanticDigest: row.semantic_digest,
    sealedAt: row.sealed_at,
  };
}
