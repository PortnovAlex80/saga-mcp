/**
 * SqliteCandidateSetRepository — sealed CandidateSet store (step 1.2).
 *
 * Target contract: REG-12 (Партия на проверку — CandidateSet).
 *
 * Idempotency (REG-12-AC-01): the seal key `(workplace_ref,
 * production_revision_ref, role, subject)` is UNIQUE. A replay of the same
 * material completion returns the existing row; a different payload under the same key
 * is rejected with `CANDIDATE_SET_REPLAY_MISMATCH`.
 *
 * Step 1.2 scope: repository EXISTS and is tested; nothing on the runtime
 * path uses it yet. Step 2.3 (`execution_complete` handler) becomes the first
 * caller.
 */

import type Database from 'better-sqlite3';
import {
  assertValidCandidateSet,
  candidateSetSealKey,
  computeCandidateSetRef,
  type CandidateMember,
  type CandidateSet,
  type CandidateSetRole,
} from '../../process-modules/domain/workplace/index.js';
import type { ProductRef } from '../../process-modules/domain/spi/index.js';
import type { WorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';
import { serializeWorkplaceRef } from '../../process-modules/domain/workplace/workplace-ref.js';

export const CANDIDATE_SET_REPLAY_MISMATCH = 'CANDIDATE_SET_REPLAY_MISMATCH';

export interface SealInput {
  readonly workplaceRef: WorkplaceRef;
  /** ADR-053 clean-break: REQUIRED. The immutable revision this set's material was sealed from. */
  readonly productionRevisionRef: string;
  readonly role: CandidateSetRole;
  readonly subjectCandidateSetRef: string | null;
  readonly members: readonly CandidateMember[];
  readonly sealReceiptRef: string;
  readonly candidateSetDigest: string;
  readonly sealedAt: string;
}

export class SqliteCandidateSetRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Seal (persist) a CandidateSet. Idempotent on the seal key
   * (workplace+production revision+role+subject). Returns `{set, replayed}`:
   *   - `replayed=true` when an identical row already existed (same digest).
   *   - throws `CANDIDATE_SET_REPLAY_MISMATCH` when the same key exists with a
   *     DIFFERENT digest (REG-12-AC-01 — a mutation attempt).
   */
  seal(input: SealInput): { set: CandidateSet; replayed: boolean } {
    const sealKey = candidateSetSealKey({
      workplaceRef: input.workplaceRef,
      productionRevisionRef: input.productionRevisionRef,
      role: input.role,
      subjectCandidateSetRef: input.subjectCandidateSetRef,
    });
    const candidateSetRef = computeCandidateSetRef(sealKey);
    const set: CandidateSet = {
      candidateSetRef,
      workplaceRef: input.workplaceRef,
      productionRevisionRef: input.productionRevisionRef,
      role: input.role,
      subjectCandidateSetRef: input.subjectCandidateSetRef,
      members: input.members,
      sealReceiptRef: input.sealReceiptRef,
      candidateSetDigest: input.candidateSetDigest,
      sealedAt: input.sealedAt,
    };
    // Validate cross-field rules BEFORE any DB write (REG-12).
    assertValidCandidateSet(set);
    // The persisted Workplace revision is the material authority. Candidate
    // ProductRefs are readback/provenance aliases and may contain submission
    // row ids, so validate schema+content against the revision before either
    // first seal or replay, then let the first immutable alias presentation win.
    assertInputMembersMatchRevision(this.db, input, sealKey);

    const workplaceSerialized = serializeWorkplaceRef(input.workplaceRef);
    const existing = this.db.prepare(
      'SELECT candidate_set_digest FROM factory_candidate_sets WHERE candidate_set_ref=?',
    ).get(candidateSetRef) as { candidate_set_digest: string } | undefined;
    if (existing) {
      if (existing.candidate_set_digest !== input.candidateSetDigest) {
        throw new Error(
          `${CANDIDATE_SET_REPLAY_MISMATCH}: key '${sealKey}' exists with digest `
            + `'${existing.candidate_set_digest}' (submitted '${input.candidateSetDigest}')`,
        );
      }
      // ADR-053 C3 — return the PERSISTED immutable authority, NOT a fresh object
      // built from the new input. A replay must never let a second presenter's
      // subject / receipt / time overwrite the sealed row's identity. Compare the
      // immutable material fields against the submitted input and fail closed on
      // any drift (a same-key, same-digest seal with different material is a bug).
      const persisted = this.read(candidateSetRef);
      if (!persisted) {
        throw new Error(
          `${CANDIDATE_SET_REPLAY_MISMATCH}: key '${sealKey}' present in index but row vanished`,
        );
      }
      assertPersistedMaterialMatches(persisted, input, sealKey);
      return { set: persisted, replayed: true };
    }

    this.db.prepare(
      `INSERT INTO factory_candidate_sets
         (candidate_set_ref, workplace_ref, production_revision_ref,
          role, subject_candidate_set_ref, candidate_set_digest, seal_receipt_ref, sealed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      candidateSetRef,
      workplaceSerialized,
      input.productionRevisionRef,
      input.role,
      input.subjectCandidateSetRef,
      input.candidateSetDigest,
      input.sealReceiptRef,
      input.sealedAt,
    );
    const insertMember = this.db.prepare(
      `INSERT INTO factory_candidate_set_members
         (candidate_set_ref, ordinal, product_schema, product_ref, product_digest,
          origin, source_candidate_set_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < input.members.length; i += 1) {
      const m = input.members[i]!;
      insertMember.run(
        candidateSetRef,
        i,
        m.productRef.schemaId,
        m.productRef.ref,
        m.productRef.digest,
        m.origin,
        m.sourceCandidateSetRef,
      );
    }
    return { set, replayed: false };
  }

  /**
   * Read a sealed CandidateSet by exact ref. Returns null when absent.
   * Reconstructs the full member list in ordinal order.
   */
  read(candidateSetRef: string): CandidateSet | null {
    const row = this.db.prepare(
      `SELECT * FROM factory_candidate_sets WHERE candidate_set_ref=?`,
    ).get(candidateSetRef) as
      | {
          candidate_set_ref: string;
          workplace_ref: string;
          production_revision_ref: string | null;
          role: CandidateSetRole;
          subject_candidate_set_ref: string | null;
          candidate_set_digest: string;
          seal_receipt_ref: string;
          sealed_at: string;
        }
      | undefined;
    if (!row) return null;
    const memberRows = this.db.prepare(
      `SELECT product_schema, product_ref, product_digest, origin, source_candidate_set_ref
         FROM factory_candidate_set_members
        WHERE candidate_set_ref=?
        ORDER BY ordinal`,
    ).all(candidateSetRef) as Array<{
      product_schema: string;
      product_ref: string;
      product_digest: string;
      origin: CandidateMember['origin'];
      source_candidate_set_ref: string | null;
    }>;
    const members: CandidateMember[] = memberRows.map(m => ({
      productRef: {
        schemaId: m.product_schema,
        ref: m.product_ref,
        digest: m.product_digest,
      } satisfies ProductRef,
      origin: m.origin,
      sourceCandidateSetRef: m.source_candidate_set_ref,
    }));
    return {
      candidateSetRef: row.candidate_set_ref,
      workplaceRef: deserializeWorkplaceRef(row.workplace_ref),
      productionRevisionRef: row.production_revision_ref!,
      role: row.role,
      subjectCandidateSetRef: row.subject_candidate_set_ref,
      members,
      sealReceiptRef: row.seal_receipt_ref,
      candidateSetDigest: row.candidate_set_digest,
      sealedAt: row.sealed_at,
    };
  }

  /**
   * List the sealed CandidateSets for one workplace (enumeration / counting /
   * diagnostics only). Ordered by candidate_set_ref ASC for deterministic
   * output. ADR-053 C1: this is NOT a material-authority selector — the current
   * accepted author CandidateSet is read from the durable authority-head pointer
   * (SqliteAcceptedAuthorityHeadRepository), never reconstructed from this list
   * by hash order.
   */
  listForWorkplace(workplaceRef: WorkplaceRef): readonly CandidateSet[] {
    const serialized = serializeWorkplaceRef(workplaceRef);
    const rows = this.db.prepare(
      `SELECT candidate_set_ref FROM factory_candidate_sets
        WHERE workplace_ref=?
        ORDER BY candidate_set_ref ASC`,
    ).all(serialized) as Array<{ candidate_set_ref: string }>;
    const sets: CandidateSet[] = [];
    for (const row of rows) {
      const set = this.read(row.candidate_set_ref);
      if (set) sets.push(set);
    }
    return sets;
  }
}

// ---------------------------------------------------------------------------
// WorkplaceRef deserialization from the stored serialized form.
//
// The serialized form is 'workplace/<processRunId>/<moduleRef>/<productionCellId>/<workKey>'.
// We parse it back into the structured WorkplaceRef for the domain object.
// ---------------------------------------------------------------------------

function deserializeWorkplaceRef(serialized: string): WorkplaceRef {
  const parts = serialized.split('/');
  // ['workplace', processRunId, moduleRef, productionCellId, workKey, ...]
  // moduleRef contains '@' but no '/', so the split is unambiguous for the
  // current serialization format.
  if (parts.length < 5 || parts[0] !== 'workplace') {
    throw new Error(`CANDIDATE_SET_CORRUPT: invalid workplace_ref '${serialized}'`);
  }
  const processRunId = Number(parts[1]);
  const moduleRef = parts[2]!;
  const productionCellId = parts[3]!;
  const workKey = parts.slice(4).join('/');
  return {
    processRunId,
    moduleRef,
    productionCellId,
    workKey,
  } as WorkplaceRef;
}

/**
 * ADR-053 C3 — on a same-key, same-digest replay, verify the persisted immutable
 * material still matches what the caller is trying to seal. ProductRef aliases,
 * member origin and source-set references are provenance and may differ across
 * equivalent presentations. Revision ref + role + subject + schema/content
 * multiset are the accepted material identity.
 */
function assertPersistedMaterialMatches(
  persisted: CandidateSet,
  input: SealInput,
  sealKey: string,
): void {
  if (persisted.productionRevisionRef !== input.productionRevisionRef) {
    throw new Error(
      `${CANDIDATE_SET_REPLAY_MISMATCH}: key '${sealKey}' revision drift `
        + `'${persisted.productionRevisionRef}' vs '${input.productionRevisionRef}'`,
    );
  }
  if (persisted.role !== input.role) {
    throw new Error(
      `${CANDIDATE_SET_REPLAY_MISMATCH}: key '${sealKey}' role drift`,
    );
  }
  if (persisted.subjectCandidateSetRef !== input.subjectCandidateSetRef) {
    throw new Error(
      `${CANDIDATE_SET_REPLAY_MISMATCH}: key '${sealKey}' subject drift`,
    );
  }
  if (persisted.members.length !== input.members.length) {
    throw new Error(
      `${CANDIDATE_SET_REPLAY_MISMATCH}: key '${sealKey}' member count drift`,
    );
  }
  const persistedMaterial = persisted.members
    .map(memberMaterialKey)
    .sort();
  const submittedMaterial = input.members
    .map(memberMaterialKey)
    .sort();
  if (persistedMaterial.some((value, index) => value !== submittedMaterial[index])) {
    throw new Error(
      `${CANDIDATE_SET_REPLAY_MISMATCH}: key '${sealKey}' member material drift`,
    );
  }
}

function memberMaterialKey(member: CandidateMember): string {
  return `${member.productRef.schemaId}\u0000${member.productRef.digest}`;
}

function assertInputMembersMatchRevision(
  db: Database.Database,
  input: SealInput,
  sealKey: string,
): void {
  const row = db.prepare(
    `SELECT members FROM factory_workplace_production_revisions
      WHERE revision_ref=? AND workplace_ref=?`,
  ).get(
    input.productionRevisionRef,
    serializeWorkplaceRef(input.workplaceRef),
  ) as { members: string } | undefined;
  if (!row) {
    throw new Error(
      `${CANDIDATE_SET_REPLAY_MISMATCH}: key '${sealKey}' revision is missing`,
    );
  }
  const revisionMembers = JSON.parse(row.members) as Array<{
    memberKey: string;
    contentDigest: string;
  }>;
  const revisionMaterial = revisionMembers
    .filter(member => member.memberKey.startsWith('product/'))
    .map(member => {
      const suffix = member.memberKey.slice('product/'.length);
      const schemaSeparator = suffix.indexOf('/');
      if (schemaSeparator <= 0) {
        throw new Error(`${CANDIDATE_SET_REPLAY_MISMATCH}: malformed revision member key`);
      }
      return `${suffix.slice(0, schemaSeparator)}\u0000${member.contentDigest}`;
    });
  const available = new Map<string, number>();
  for (const key of revisionMaterial) available.set(key, (available.get(key) ?? 0) + 1);
  const missing = input.members.some(member => {
    const key = memberMaterialKey(member);
    const count = available.get(key) ?? 0;
    if (count === 0) return true;
    available.set(key, count - 1);
    return false;
  });
  if (missing) {
    throw new Error(
      `${CANDIDATE_SET_REPLAY_MISMATCH}: key '${sealKey}' members do not match revision material`,
    );
  }
}
