// src/process-modules/application/production-source-adapters.ts
//
// ADR-053 Phase 4 — normalize ALL production sources to canonical revision
// members.
//
// Each adapter converts one production source type (managed artifacts, managed
// traces, typed submissions, Git changes, evidence) into a WorkplaceContribution
// whose operations are `put` (idempotent create-or-update) on semantically-keyed
// members. The revision assembler then combines contributions from any number of
// executions into one sealed WorkplaceProductionRevision.
//
// SEMANTIC MEMBER-KEY SCHEME (partition-invariant):
//
//   managed artifact  → artifact/{artifactType}
//   managed trace     → trace/{linkType}/{targetType}/{semanticTargetKey}
//   typed submission  → typed/{schemaVersion}
//   git change        → git/{filePath}
//   evidence          → evidence/{evidenceType}/{semanticId}
//
// The memberKey is the SEMANTIC IDENTITY (what the material IS), not a DB row
// ID or execution coordinate. The contentDigest is the CONTENT FINGERPRINT
// (what the material CONTAINS). Two executions producing the same artifact
// type with the same content map to the same memberKey + contentDigest → same
// semantic digest → partition-invariant (the Run 011 property).
//
// After Phase 4, revision consumers no longer branch on source type. The
// `sourceAdapter` field on each member is provenance only.

import {
  buildContribution,
  type MemberOperation,
  type SourceAdapter,
  type WorkplaceContribution,
} from '../domain/workplace/workplace-production-revision.js';

// ---------------------------------------------------------------------------
// Managed artifacts → revision contribution.
//
// Each managed artifact becomes a `put` member keyed by its semantic type.
// The contentHash is the content digest. Artifacts with null contentHash are
// skipped (they carry no material — same policy as WorkplaceProductionSnapshot).
// ---------------------------------------------------------------------------

interface ManagedArtifactLike {
  readonly artifactType: string;
  readonly artifactId: number;
  readonly contentHash: string | null;
  readonly executionId: string;
}

export function managedArtifactsToContribution(input: {
  workplaceRef: string;
  executionRef: string;
  artifacts: readonly ManagedArtifactLike[];
  parentContributionRef?: string | null;
}): WorkplaceContribution {
  const operations: MemberOperation[] = [];
  for (const artifact of input.artifacts) {
    if (!artifact.contentHash) continue; // null-content = no material
    operations.push({
      op: 'put',
      memberKey: `artifact/${artifact.artifactType}`,
      productRef: `managed-artifact:${artifact.artifactId}`,
      contentDigest: artifact.contentHash,
      sourceAdapter: 'managed-artifact',
    });
  }
  return buildContribution({
    workplaceRef: input.workplaceRef,
    contributorExecutionRef: input.executionRef,
    sourceAdapter: 'managed-artifact',
    operations,
    parentContributionRef: input.parentContributionRef ?? null,
  });
}

// ---------------------------------------------------------------------------
// Produced ProductRefs → revision contribution. [ADR-053 B-7]
//
// The generic production-cell executor path: a set of produced ProductRefs.
// Each ProductRef becomes a `put` member keyed by `product/{schemaId}/{ref}`
// (one member per product — preserves the runtime per-product cardinality).
// The executor routes through THIS adapter rather than building the contribution
// inline, so all revision material flows through the adapter boundary. The
// `sourceAdapter` defaults to 'typed-submission' (the executor's cells) and may
// be overridden when a cell's productSource differs.
// ---------------------------------------------------------------------------

export function producedProductsToContribution(input: {
  workplaceRef: string;
  executionRef: string;
  products: ReadonlyArray<{ readonly schemaId: string; readonly ref: string; readonly digest: string }>;
  sourceAdapter?: SourceAdapter;
  parentContributionRef?: string | null;
}): WorkplaceContribution {
  const sourceAdapter: SourceAdapter = input.sourceAdapter ?? 'typed-submission';
  const operations: MemberOperation[] = input.products.map(p => ({
    op: 'put',
    memberKey: `product/${p.schemaId}/${p.ref}`,
    productRef: p.ref,
    contentDigest: p.digest,
    sourceAdapter,
  }));
  return buildContribution({
    workplaceRef: input.workplaceRef,
    contributorExecutionRef: input.executionRef,
    sourceAdapter,
    operations,
    parentContributionRef: input.parentContributionRef ?? null,
  });
}

// ---------------------------------------------------------------------------
// Managed traces → revision contribution.
//
// Each trace becomes a `put` member keyed by its structural identity
// (linkType + targetType + a semantic target key). The traceHash is the
// content digest. Traces with null/empty hash are skipped.
// ---------------------------------------------------------------------------

interface ManagedTraceLike {
  readonly traceId: number;
  readonly sourceId: number;
  readonly targetType: 'artifact' | 'task';
  readonly targetId: number;
  readonly linkType: string;
  readonly traceHash: string;
  readonly executionId: string;
}

export function managedTracesToContribution(input: {
  workplaceRef: string;
  executionRef: string;
  traces: readonly ManagedTraceLike[];
  parentContributionRef?: string | null;
}): WorkplaceContribution {
  const operations: MemberOperation[] = [];
  for (const trace of input.traces) {
    if (!trace.traceHash) continue;
    operations.push({
      op: 'put',
      // Structural identity: linkType + targetType. The targetId is a DB row
      // id (provenance), but including it in the key distinguishes traces to
      // different targets. For cross-run partition invariance, the semantic
      // digest strips this down to {linkType, targetType} counts (matching
      // workplaceProductionSemanticDigest). The member key here preserves
      // endpoint identity for the material model; the semantic digest
      // computed by the revision assembler handles partition invariance.
      memberKey: `trace/${trace.linkType}/${trace.targetType}/${trace.targetId}`,
      productRef: `managed-trace:${trace.traceId}`,
      contentDigest: trace.traceHash,
      sourceAdapter: 'managed-trace',
    });
  }
  return buildContribution({
    workplaceRef: input.workplaceRef,
    contributorExecutionRef: input.executionRef,
    sourceAdapter: 'managed-trace',
    operations,
    parentContributionRef: input.parentContributionRef ?? null,
  });
}

// ---------------------------------------------------------------------------
// Typed submission → revision contribution.
//
// A typed submission becomes a `put` member keyed by its schema version.
// The contentHash (sha256 of payload) is the content digest. The pinned
// payload contract (contractId + version + contractDigest) is carried in the
// productRef for provenance.
// ---------------------------------------------------------------------------

interface TypedSubmissionLike {
  readonly schema: string;
  readonly contentHash: string;
  readonly submissionId: number;
  readonly executionId: string;
}

export function typedSubmissionToContribution(input: {
  workplaceRef: string;
  executionRef: string;
  submission: TypedSubmissionLike;
  parentContributionRef?: string | null;
}): WorkplaceContribution {
  const op: MemberOperation = {
    op: 'put',
    memberKey: `typed/${input.submission.schema}`,
    productRef: `typed-submission:${input.submission.submissionId}`,
    contentDigest: input.submission.contentHash,
    sourceAdapter: 'typed-submission',
  };
  return buildContribution({
    workplaceRef: input.workplaceRef,
    contributorExecutionRef: input.executionRef,
    sourceAdapter: 'typed-submission',
    operations: [op],
    parentContributionRef: input.parentContributionRef ?? null,
  });
}

// ---------------------------------------------------------------------------
// Git changes → revision contribution.
//
// Each changed file becomes a `put` member keyed by its file path. The content
// digest is the commit+tree SHA pair (content-addressed, inherently stable).
// Commit/tree SHAs are already semantic — no DB row ID dependence.
// ---------------------------------------------------------------------------

export interface GitChangeMember {
  readonly filePath: string;
  readonly commitSha: string;
  readonly treeSha: string;
}

export function gitChangesToContribution(input: {
  workplaceRef: string;
  executionRef: string;
  changes: readonly GitChangeMember[];
  parentContributionRef?: string | null;
}): WorkplaceContribution {
  const operations: MemberOperation[] = [];
  for (const change of input.changes) {
    if (!change.filePath.trim()) continue;
    operations.push({
      op: 'put',
      memberKey: `git/${change.filePath}`,
      productRef: `git-commit:${change.commitSha}`,
      // Content digest combines commit + tree so a different tree under the
      // same commit is distinguishable.
      contentDigest: `sha256:${change.commitSha}/${change.treeSha}`,
      sourceAdapter: 'git-change',
    });
  }
  return buildContribution({
    workplaceRef: input.workplaceRef,
    contributorExecutionRef: input.executionRef,
    sourceAdapter: 'git-change',
    operations,
    parentContributionRef: input.parentContributionRef ?? null,
  });
}

// ---------------------------------------------------------------------------
// Carry-forward → revision contribution (inherit parent members unchanged).
//
// A carry-forward contribution marks members from the parent revision as
// inherited. It does NOT change the material — it records that a later
// execution acknowledged the parent's material. The revision assembler
// includes parent members automatically (via parentRevisionRef), so a
// carry-forward contribution is typically empty operations but records the
// contributor for provenance.
// ---------------------------------------------------------------------------

export function carryForwardContribution(input: {
  workplaceRef: string;
  executionRef: string;
  parentContributionRef?: string | null;
}): WorkplaceContribution {
  return buildContribution({
    workplaceRef: input.workplaceRef,
    contributorExecutionRef: input.executionRef,
    sourceAdapter: 'carry-forward',
    operations: [],
    parentContributionRef: input.parentContributionRef ?? null,
  });
}
