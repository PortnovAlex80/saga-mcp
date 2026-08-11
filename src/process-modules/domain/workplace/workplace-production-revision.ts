// src/process-modules/domain/workplace/workplace-production-revision.ts
//
// ADR-053 Phase 3 — immutable Workplace production material model.
//
// This is the HEART of the ADR-053 cutover. The central diagnosis is that the
// system has two competing material authorities: Workplace (normative) and
// WorkerExecution (legacy). The fix introduces ONE immutable entity —
// WorkplaceProductionRevision — as the sole sealed material state of a
// Workplace. CandidateSet, Gate, effects, settlement and downstream handoff
// will all reference exact revision refs (Phases 5-7).
//
// MODEL
//
//   WorkerExecution
//       │ creates a
//       ▼
//   WorkplaceContribution  (one execution's delta: ordered member operations)
//       │ applied to
//       ▼
//   WorkplaceProductionRevision  (sealed immutable material state)
//       │ { members[], contributingExecutionRefs[], presenterRef }
//       │
//       │ materialDigest   — over members INCLUDING provenance (partition-aware)
//       │ semanticDigest   — over members EXCLUDING provenance (partition-inv.)
//       ▼
//   CandidateSet           (Phase 5: references this exact revision)
//
// PARTITION INVARIANCE (the Run 011 property):
//
//   A produces X+Y                    ⟹  revision with semanticDigest D
//   A produces X, B continues with Y  ⟹  revision with semanticDigest D
//
//   The same final material through different execution partitions yields the
//   same semanticDigest. This is what makes recovery / carry-forward / repair
//   safe: the semantic identity of accepted material does not depend on WHICH
//   execution produced it, only on WHAT it contains.

import { sha256Hex } from '../../../shared/canonical-json.js';

// ---------------------------------------------------------------------------
// Source adapters — how material entered the Workplace.
//
// After Phase 4 normalises all sources, the post-seal core no longer knows
// which adapter produced a member. During migration, sourceAdapter remains on
// the member for ingress diagnostics only.
// ---------------------------------------------------------------------------
export const SOURCE_ADAPTERS = [
  'managed-artifact',
  'managed-trace',
  'typed-submission',
  'git-change',
  'evidence',
  'carry-forward',
] as const;
export type SourceAdapter = (typeof SOURCE_ADAPTERS)[number];

// ---------------------------------------------------------------------------
// RevisionMember — one material product in a revision.
//
// `memberKey` is the CANONICAL IDENTITY: two members with the same key are the
// "same thing" (one supersedes the other). `contentDigest` is the content
// fingerprint: same digest ⟹ same content. `contributorExecutionRef` and
// `sourceAdapter` are PROVENANCE ONLY — they do not participate in the
// semantic digest, so the same material from different executions is
// semantically identical.
// ---------------------------------------------------------------------------
export interface RevisionMember {
  readonly memberKey: string;
  readonly productRef: string;
  readonly contentDigest: string;
  readonly sourceAdapter: SourceAdapter;
  readonly contributorExecutionRef: string;
}

// ---------------------------------------------------------------------------
// Member operations — what a contribution does to the material.
//
// A contribution carries an ordered list of these. The revision assembler
// applies them to the parent revision's member set. Operations are validated
// against the parent state: create requires the key to be absent; update /
// delete / rename require the key to be present; rename requires the target
// key to be absent.
// ---------------------------------------------------------------------------
export type MemberOperation =
  | {
      readonly op: 'create';
      readonly memberKey: string;
      readonly productRef: string;
      readonly contentDigest: string;
      readonly sourceAdapter: SourceAdapter;
    }
  | {
      readonly op: 'update';
      readonly memberKey: string;
      readonly productRef: string;
      readonly contentDigest: string;
      readonly sourceAdapter: SourceAdapter;
    }
  | {
      readonly op: 'put';
      readonly memberKey: string;
      readonly productRef: string;
      readonly contentDigest: string;
      readonly sourceAdapter: SourceAdapter;
    }
  | {
      readonly op: 'delete';
      readonly memberKey: string;
    }
  | {
      readonly op: 'rename';
      readonly fromKey: string;
      readonly toKey: string;
    };

// ---------------------------------------------------------------------------
// WorkplaceContribution — one execution's material delta.
//
// Contributions are append-only. Each records the exact operations an
// execution performed against the workplace material, plus the content digest
// of those operations. A contribution chain (parentContributionRef) links
// sequential contributions within a workplace.
// ---------------------------------------------------------------------------
export interface WorkplaceContribution {
  readonly contributionRef: string;
  readonly workplaceRef: string;
  readonly contributorExecutionRef: string;
  readonly sourceAdapter: SourceAdapter;
  readonly operations: readonly MemberOperation[];
  readonly contentDigest: string;
  readonly parentContributionRef: string | null;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// WorkplaceProductionRevision — sealed immutable material state.
//
// A revision is the FULL material state of a Workplace at a point in time. It
// is assembled by applying one or more contributions to a parent revision (or
// to the empty set if it is the first revision). Once sealed, it never
// changes: the revision_ref is content-addressed and the row is append-only.
// ---------------------------------------------------------------------------
export interface WorkplaceProductionRevision {
  readonly revisionRef: string;
  readonly workplaceRef: string;
  readonly parentRevisionRef: string | null;
  readonly members: readonly RevisionMember[];
  readonly contributingExecutionRefs: readonly string[];
  readonly presenterRef: string;
  readonly materialDigest: string;
  readonly semanticDigest: string;
  readonly sealedAt: string;
}

// ===========================================================================
// Validation.
// ===========================================================================

/**
 * Reject member keys that are empty, contain path traversal, or collide under
 * case-insensitive comparison within the same set. ADR-053 §"Define
 * create/update/delete/rename and member identity semantics; reject duplicate,
 * traversal, case-collision and ambiguous operations."
 */
export function validateMemberKey(key: string): void {
  if (!key || typeof key !== 'string' || !key.trim()) {
    throw new Error(`REVISION_MEMBER_KEY_REQUIRED`);
  }
  if (key.includes('..') || key.includes('\0')) {
    throw new Error(`REVISION_MEMBER_KEY_TRAVERSAL: ${key}`);
  }
}

function assertNoCaseCollision(keys: readonly string[]): void {
  const seen = new Map<string, string>(); // lowercase → original
  for (const key of keys) {
    const lower = key.toLowerCase();
    const existing = seen.get(lower);
    if (existing !== undefined && existing !== key) {
      throw new Error(
        `REVISION_MEMBER_KEY_CASE_COLLISION: '${key}' vs '${existing}'`,
      );
    }
    seen.set(lower, key);
  }
}

// ===========================================================================
// Digest computation.
// ===========================================================================

/**
 * Partition-AWARE material digest: includes contributor and source provenance.
 * Two revisions with the same material from different execution partitions
 * have DIFFERENT materialDigests. Used as part of the revisionRef (the exact
 * material identity including who produced it).
 */
export function materialDigest(input: {
  workplaceRef: string;
  parentRevisionRef: string | null;
  members: readonly RevisionMember[];
}): string {
  const members = input.members
    .map(m => ({
      memberKey: m.memberKey,
      productRef: m.productRef,
      contentDigest: m.contentDigest,
      sourceAdapter: m.sourceAdapter,
      contributorExecutionRef: m.contributorExecutionRef,
    }))
    .sort((a, b) => (a.memberKey < b.memberKey ? -1 : a.memberKey > b.memberKey ? 1 : 0));
  return sha256Hex({
    workplaceRef: input.workplaceRef,
    parentRevisionRef: input.parentRevisionRef,
    members,
  });
}

/**
 * Partition-INVARIANT semantic digest: strips ALL provenance (contributor,
 * source adapter). Two revisions with the same material content through
 * different execution partitions have the SAME semanticDigest. This is the
 * Run 011 property: recovery / carry-forward / repair do not change the
 * semantic identity of accepted material.
 */
export function semanticDigest(input: {
  members: readonly RevisionMember[];
}): string {
  const members = input.members
    .map(m => ({ memberKey: m.memberKey, contentDigest: m.contentDigest }))
    .sort((a, b) => (a.memberKey < b.memberKey ? -1 : a.memberKey > b.memberKey ? 1 : 0));
  return sha256Hex({ members });
}

/**
 * Content-addressed revision reference. Deterministic: the same workplace,
 * parent, members and presenter always produce the same revisionRef. A
 * replay of the same seal finds the existing revision rather than creating a
 * duplicate.
 */
export function revisionRef(input: {
  workplaceRef: string;
  parentRevisionRef: string | null;
  members: readonly RevisionMember[];
  contributingExecutionRefs: readonly string[];
  presenterRef: string;
  materialDigestValue: string;
  semanticDigestValue: string;
}): string {
  return sha256Hex({
    workplaceRef: input.workplaceRef,
    parentRevisionRef: input.parentRevisionRef,
    members: input.members.length,
    contributingExecutionRefs: [...input.contributingExecutionRefs].sort(),
    presenterRef: input.presenterRef,
    materialDigest: input.materialDigestValue,
    semanticDigest: input.semanticDigestValue,
  });
}

// ===========================================================================
// Revision assembly — apply contributions to a parent revision.
// ===========================================================================

export interface AssembleRevisionInput {
  readonly workplaceRef: string;
  readonly parent: WorkplaceProductionRevision | null;
  readonly contributions: readonly WorkplaceContribution[];
  readonly presenterRef: string;
  readonly sealedAt?: string;
}

/**
 * Assemble a sealed WorkplaceProductionRevision by applying one or more
 * contributions to a parent revision (or the empty set).
 *
 * The result is deterministic: the same parent + contributions + presenter
 * always produce the same revisionRef, materialDigest and semanticDigest.
 *
 * Validation:
 * - every member key is non-empty and traversal-free
 * - no case-collision in the final member set
 * - operations are consistent with the parent state (create on absent,
 *   update/delete/rename on present)
 *
 * Throws on any violation — the revision is NOT partially assembled.
 */
export function assembleRevision(input: AssembleRevisionInput): WorkplaceProductionRevision {
  // Start from the parent's members (a Map for keyed access).
  const members = new Map<string, RevisionMember>();
  const contributors = new Set<string>();
  if (input.parent) {
    for (const m of input.parent.members) {
      members.set(m.memberKey, m);
    }
    for (const ref of input.parent.contributingExecutionRefs) {
      contributors.add(ref);
    }
  }

  // Apply each contribution's operations in order.
  for (const contribution of input.contributions) {
    contributors.add(contribution.contributorExecutionRef);
    for (const op of contribution.operations) {
      applyOperation(members, op, contribution);
    }
  }

  const memberList = [...members.values()].sort((a, b) =>
    a.memberKey < b.memberKey ? -1 : a.memberKey > b.memberKey ? 1 : 0,
  );

  // Validate the final member set.
  for (const m of memberList) {
    validateMemberKey(m.memberKey);
  }
  assertNoCaseCollision(memberList.map(m => m.memberKey));

  const parentRevisionRef = input.parent?.revisionRef ?? null;
  const materialDigestValue = materialDigest({
    workplaceRef: input.workplaceRef,
    parentRevisionRef,
    members: memberList,
  });
  const semanticDigestValue = semanticDigest({ members: memberList });
  const contributingExecutionRefs = [...contributors].sort();
  const ref = revisionRef({
    workplaceRef: input.workplaceRef,
    parentRevisionRef,
    members: memberList,
    contributingExecutionRefs,
    presenterRef: input.presenterRef,
    materialDigestValue,
    semanticDigestValue,
  });

  return {
    revisionRef: ref,
    workplaceRef: input.workplaceRef,
    parentRevisionRef,
    members: memberList,
    contributingExecutionRefs,
    presenterRef: input.presenterRef,
    materialDigest: materialDigestValue,
    semanticDigest: semanticDigestValue,
    sealedAt: input.sealedAt ?? new Date().toISOString(),
  };
}

function applyOperation(
  members: Map<string, RevisionMember>,
  op: MemberOperation,
  contribution: WorkplaceContribution,
): void {
  switch (op.op) {
    case 'create': {
      validateMemberKey(op.memberKey);
      if (members.has(op.memberKey)) {
        throw new Error(`REVISION_MEMBER_CREATE_EXISTS: ${op.memberKey}`);
      }
      members.set(op.memberKey, {
        memberKey: op.memberKey,
        productRef: op.productRef,
        contentDigest: op.contentDigest,
        sourceAdapter: op.sourceAdapter,
        contributorExecutionRef: contribution.contributorExecutionRef,
      });
      break;
    }
    case 'update': {
      validateMemberKey(op.memberKey);
      if (!members.has(op.memberKey)) {
        throw new Error(`REVISION_MEMBER_UPDATE_ABSENT: ${op.memberKey}`);
      }
      members.set(op.memberKey, {
        memberKey: op.memberKey,
        productRef: op.productRef,
        contentDigest: op.contentDigest,
        sourceAdapter: op.sourceAdapter,
        contributorExecutionRef: contribution.contributorExecutionRef,
      });
      break;
    }
    case 'put': {
      // Idempotent create-or-update. Used by Phase 4 adapters that project
      // the FINAL material state without knowing the parent's member set.
      // This makes adapters partition-invariant: two executions producing the
      // same final state converge to the same revision regardless of who
      // "created" vs "updated" each member.
      validateMemberKey(op.memberKey);
      members.set(op.memberKey, {
        memberKey: op.memberKey,
        productRef: op.productRef,
        contentDigest: op.contentDigest,
        sourceAdapter: op.sourceAdapter,
        contributorExecutionRef: contribution.contributorExecutionRef,
      });
      break;
    }
    case 'delete': {
      validateMemberKey(op.memberKey);
      if (!members.has(op.memberKey)) {
        throw new Error(`REVISION_MEMBER_DELETE_ABSENT: ${op.memberKey}`);
      }
      members.delete(op.memberKey);
      break;
    }
    case 'rename': {
      validateMemberKey(op.fromKey);
      validateMemberKey(op.toKey);
      const existing = members.get(op.fromKey);
      if (!existing) {
        throw new Error(`REVISION_MEMBER_RENAME_FROM_ABSENT: ${op.fromKey}`);
      }
      if (members.has(op.toKey)) {
        throw new Error(`REVISION_MEMBER_RENAME_TO_EXISTS: ${op.toKey}`);
      }
      members.delete(op.fromKey);
      members.set(op.toKey, {
        ...existing,
        memberKey: op.toKey,
        contributorExecutionRef: contribution.contributorExecutionRef,
      });
      break;
    }
    default:
      throw new Error(`REVISION_MEMBER_UNKNOWN_OP: ${(op as { op: string }).op}`);
  }
}

// ===========================================================================
// Contribution digest — content-addressed contribution reference.
// ===========================================================================

export function contributionRef(input: {
  workplaceRef: string;
  contributorExecutionRef: string;
  sourceAdapter: SourceAdapter;
  operations: readonly MemberOperation[];
  parentContributionRef: string | null;
}): string {
  return sha256Hex(input);
}

export function buildContribution(input: {
  workplaceRef: string;
  contributorExecutionRef: string;
  sourceAdapter: SourceAdapter;
  operations: readonly MemberOperation[];
  parentContributionRef: string | null;
  createdAt?: string;
}): WorkplaceContribution {
  const ref = contributionRef(input);
  const contentDigest = sha256Hex({ operations: input.operations });
  return {
    contributionRef: ref,
    workplaceRef: input.workplaceRef,
    contributorExecutionRef: input.contributorExecutionRef,
    sourceAdapter: input.sourceAdapter,
    operations: input.operations,
    contentDigest,
    parentContributionRef: input.parentContributionRef,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
