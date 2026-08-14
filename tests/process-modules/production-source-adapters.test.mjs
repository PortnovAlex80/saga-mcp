// tests/process-modules/production-source-adapters.test.mjs
//
// ADR-053 Phase 4 — production source adapter tests.
//
// Proves that each adapter converts its production source type into a
// WorkplaceContribution with semantically-keyed members, and that the
// resulting revision is partition-invariant: the same final material through
// different execution partitions yields the same semanticDigest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleRevision } from '../../dist/process-modules/domain/workplace/workplace-production-revision.js';
import {
  candidateSetDigestForRevision,
  candidateSetSealKey,
} from '../../dist/process-modules/domain/workplace/candidate-set.js';
import {
  managedArtifactsToContribution,
  managedTracesToContribution,
  typedSubmissionToContribution,
  gitChangesToContribution,
  carryForwardContribution,
  producedProductsToContribution,
} from '../../dist/process-modules/application/production-source-adapters.js';
import {
  submissionValidationContentDigest,
  submissionValidationMemberKey,
} from '../../dist/process-modules/application/submission-validation-receipt-authority.js';

const WORKPLACE = 'workplace/1/cell/item';

test('ADR-053 B-3: exact validation proof is a material revision member, execution-free', () => {
  const receipt = {
    receiptId: 9,
    validatorId: 'contract.v1',
    validatorVersion: '1.0.0',
    processRunId: 1,
    moduleRef: 'module@1.0.0',
    nodeId: 'node',
    inputSnapshotHash: 'input',
    artifactIds: [1],
    traceIds: [],
    artifactHashes: { 1: 'content' },
    traceDigest: 'trace',
    contractRef: null,
    validatedSetDigest: 'set',
  };
  const contribution = producedProductsToContribution({
    workplaceRef: WORKPLACE,
    executionRef: 'exec-A',
    products: [{ schemaId: 'product.v1', ref: 'product:1', digest: 'content' }],
    validationReceipts: [receipt],
  });
  assert.equal(contribution.operations.length, 2);
  assert.deepEqual(contribution.operations[1], {
    op: 'put',
    memberKey: submissionValidationMemberKey(receipt),
    productRef: 'submission-validation-receipt:9',
    contentDigest: submissionValidationContentDigest(receipt),
    sourceAdapter: 'evidence',
  });
  for (const changed of [
    { inputSnapshotHash: 'other-input' },
    { artifactIds: [501] },
    { traceIds: [502] },
    { artifactHashes: { 1: 'other-content' } },
    { traceDigest: 'other-trace' },
    { validatedSetDigest: 'other-set' },
  ]) {
    assert.notEqual(
      submissionValidationContentDigest(receipt),
      submissionValidationContentDigest({ ...receipt, ...changed }),
      `exact validation proof must bind ${Object.keys(changed)[0]}`,
    );
  }
});

test('ADR-053 B-3: different exact proofs cannot collide while semantic product identity stays stable', () => {
  const baseReceipt = {
    receiptId: 1, validatorId: 'contract.v1', validatorVersion: '1.0.0',
    processRunId: 1, moduleRef: 'module@1.0.0', nodeId: 'node',
    inputSnapshotHash: 'input', artifactIds: [1], traceIds: [],
    artifactHashes: { 1: 'content' }, traceDigest: 'trace', contractRef: null,
    validatedSetDigest: 'set-a',
  };
  const make = receipt => assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [producedProductsToContribution({
      workplaceRef: WORKPLACE,
      executionRef: 'exec-A',
      products: [{ schemaId: 'product.v1', ref: 'product:1', digest: 'content' }],
      validationReceipts: [receipt],
    })],
    presenterRef: 'exec-A',
  });
  const a = make(baseReceipt);
  const b = make({ ...baseReceipt, receiptId: 2, validatedSetDigest: 'set-b' });
  assert.equal(a.semanticDigest, b.semanticDigest, 'proof coordinates are not cross-run product semantics');
  assert.notEqual(a.materialDigest, b.materialDigest, 'exact proof is part of within-Workplace material authority');
  assert.notEqual(a.revisionRef, b.revisionRef);
  const workplaceRef = { processRunId: 1, moduleRef: 'module@1.0.0', productionCellId: 'cell', workKey: 'item' };
  assert.notEqual(
    candidateSetSealKey({ workplaceRef, productionRevisionRef: a.revisionRef, role: 'author', subjectCandidateSetRef: null }),
    candidateSetSealKey({ workplaceRef, productionRevisionRef: b.revisionRef, role: 'author', subjectCandidateSetRef: null }),
  );
});

test('ADR-053 B-3: real generic typed path converges across execution-scoped ProductRef aliases', () => {
  const workplaceRef = {
    processRunId: 1,
    moduleRef: 'module@1.0.0',
    productionCellId: 'cell',
    workKey: 'item',
  };
  const make = (executionRef, productRef) => assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [producedProductsToContribution({
      workplaceRef: WORKPLACE,
      executionRef,
      products: [{
        schemaId: 'factory.typed-product.v1',
        ref: productRef,
        digest: 'same-payload-digest',
      }],
    })],
    presenterRef: executionRef,
  });
  const a = make('exec-A', 'managed-node-submission:101');
  const b = make('exec-B', 'managed-node-submission:202');
  assert.equal(a.materialDigest, b.materialDigest);
  assert.equal(a.semanticDigest, b.semanticDigest);
  assert.equal(a.revisionRef, b.revisionRef);
  assert.equal(
    candidateSetSealKey({ workplaceRef, productionRevisionRef: a.revisionRef, role: 'author' }),
    candidateSetSealKey({ workplaceRef, productionRevisionRef: b.revisionRef, role: 'author' }),
  );
  assert.equal(
    candidateSetDigestForRevision({ workplaceRef, productionRevisionRef: a.revisionRef, role: 'author' }),
    candidateSetDigestForRevision({ workplaceRef, productionRevisionRef: b.revisionRef, role: 'author' }),
  );
});

// ===========================================================================
// 1. Managed artifacts adapter — semantic memberKey by artifactType.
// ===========================================================================
test('Phase 4: managed artifacts adapter produces semantically-keyed members', () => {
  const contribution = managedArtifactsToContribution({
    workplaceRef: WORKPLACE,
    executionRef: 'exec-A',
    artifacts: [
      { artifactType: 'prd', artifactId: 10, contentHash: 'sha256:prd', executionId: 'exec-A' },
      { artifactType: 'fr', artifactId: 11, contentHash: 'sha256:fr', executionId: 'exec-A' },
      { artifactType: 'null-content', artifactId: 12, contentHash: null, executionId: 'exec-A' },
    ],
  });
  assert.equal(contribution.operations.length, 2); // null-content skipped
  assert.equal(contribution.operations[0].op, 'put');
  assert.equal(contribution.operations[0].memberKey, 'artifact/prd');
  assert.equal(contribution.operations[0].contentDigest, 'sha256:prd');
  assert.equal(contribution.operations[1].memberKey, 'artifact/fr');
});

// ===========================================================================
// 2. Typed submission adapter — one member per schema.
// ===========================================================================
test('Phase 4: typed submission adapter produces one member per schema', () => {
  const contribution = typedSubmissionToContribution({
    workplaceRef: WORKPLACE,
    executionRef: 'exec-A',
    submission: { schema: 'factory.review-verdict.v1', contentHash: 'sha256:rv', submissionId: 5, executionId: 'exec-A' },
  });
  assert.equal(contribution.operations.length, 1);
  assert.equal(contribution.operations[0].memberKey, 'typed/factory.review-verdict.v1');
  assert.equal(contribution.operations[0].contentDigest, 'sha256:rv');
});

// ===========================================================================
// 3. Git changes adapter — file-path-keyed members.
// ===========================================================================
test('Phase 4: git changes adapter produces file-path-keyed members', () => {
  const contribution = gitChangesToContribution({
    workplaceRef: WORKPLACE,
    executionRef: 'exec-A',
    changes: [
      { filePath: 'src/main.ts', commitSha: 'abc123', treeSha: 'tree1' },
      { filePath: 'src/util.ts', commitSha: 'abc123', treeSha: 'tree1' },
    ],
  });
  assert.equal(contribution.operations.length, 2);
  assert.equal(contribution.operations[0].memberKey, 'git/src/main.ts');
  assert.equal(contribution.operations[1].memberKey, 'git/src/util.ts');
});

// ===========================================================================
// 4. PARTITION INVARIANCE through adapters — the Run 011 property.
//
//    Partition A: exec-A produces PRD + FR artifacts in one contribution.
//    Partition B: exec-A produces PRD, exec-B produces FR (recovery).
//
//    Same final material → same semanticDigest.
// ===========================================================================
test('Phase 4: PARTITION INVARIANCE — managed artifacts through different execution partitions', () => {
  // Partition A: one execution produces both.
  const revisionA = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [
      managedArtifactsToContribution({
        workplaceRef: WORKPLACE,
        executionRef: 'exec-A',
        artifacts: [
          { artifactType: 'prd', artifactId: 1, contentHash: 'sha256:prd', executionId: 'exec-A' },
          { artifactType: 'fr', artifactId: 2, contentHash: 'sha256:fr', executionId: 'exec-A' },
        ],
      }),
    ],
    presenterRef: 'exec-A',
    sealedAt: '2026-08-11T12:00:00Z',
  });

  // Partition B: two executions (recovery scenario from Run 011).
  const revisionB = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [
      managedArtifactsToContribution({
        workplaceRef: WORKPLACE,
        executionRef: 'exec-A',
        artifacts: [
          { artifactType: 'prd', artifactId: 10, contentHash: 'sha256:prd', executionId: 'exec-A' },
        ],
      }),
      managedArtifactsToContribution({
        workplaceRef: WORKPLACE,
        executionRef: 'exec-B',
        artifacts: [
          { artifactType: 'fr', artifactId: 20, contentHash: 'sha256:fr', executionId: 'exec-B' },
        ],
      }),
    ],
    presenterRef: 'exec-B',
    sealedAt: '2026-08-11T13:00:00Z',
  });

  // THE PROPERTY: same semantic digest despite different artifact IDs and
  // execution partitions.
  assert.equal(
    revisionA.semanticDigest,
    revisionB.semanticDigest,
    'managed artifacts through different execution partitions yield the same semanticDigest',
  );
  assert.equal(revisionA.materialDigest, revisionB.materialDigest);
  assert.equal(revisionA.revisionRef, revisionB.revisionRef);
});

// ===========================================================================
// 5. MIXED SOURCES — managed artifacts + typed submission + git in one revision.
// ===========================================================================
test('Phase 4: mixed sources normalize into one revision', () => {
  const revision = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [
      managedArtifactsToContribution({
        workplaceRef: WORKPLACE,
        executionRef: 'exec-A',
        artifacts: [
          { artifactType: 'prd', artifactId: 1, contentHash: 'sha256:prd', executionId: 'exec-A' },
        ],
      }),
      typedSubmissionToContribution({
        workplaceRef: WORKPLACE,
        executionRef: 'exec-A',
        submission: { schema: 'factory.review-verdict.v1', contentHash: 'sha256:rv', submissionId: 5, executionId: 'exec-A' },
      }),
      gitChangesToContribution({
        workplaceRef: WORKPLACE,
        executionRef: 'exec-A',
        changes: [{ filePath: 'README.md', commitSha: 'abc', treeSha: 'def' }],
      }),
    ],
    presenterRef: 'exec-A',
    sealedAt: '2026-08-11T12:00:00Z',
  });
  assert.equal(revision.members.length, 3);
  const keys = revision.members.map(m => m.memberKey).sort();
  assert.deepEqual(keys, ['artifact/prd', 'git/README.md', 'typed/factory.review-verdict.v1']);
});

// ===========================================================================
// 6. Carry-forward contribution — empty operations but records the contributor.
// ===========================================================================
test('Phase 4: carry-forward contribution has no operations but links the contributor', () => {
  const cf = carryForwardContribution({
    workplaceRef: WORKPLACE,
    executionRef: 'exec-B',
  });
  assert.equal(cf.operations.length, 0);
  assert.equal(cf.sourceAdapter, 'carry-forward');

  // Assembled with a parent: the parent's members survive, and exec-B is a
  // contributor.
  const parent = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [
      managedArtifactsToContribution({
        workplaceRef: WORKPLACE,
        executionRef: 'exec-A',
        artifacts: [
          { artifactType: 'prd', artifactId: 1, contentHash: 'sha256:prd', executionId: 'exec-A' },
        ],
      }),
    ],
    presenterRef: 'exec-A',
    sealedAt: '2026-08-11T12:00:00Z',
  });
  const child = assembleRevision({
    workplaceRef: WORKPLACE,
    parent,
    contributions: [cf],
    presenterRef: 'exec-B',
    sealedAt: '2026-08-11T13:00:00Z',
  });
  assert.equal(child.members.length, 1); // parent's PRD carried forward
  assert.deepEqual(child.contributingExecutionRefs, ['exec-A', 'exec-B']);
});

// ===========================================================================
// 7. Idempotent put — same artifact from two contributions in one batch.
// ===========================================================================
test('Phase 4: put is idempotent — same memberKey from two contributions converges', () => {
  const revision = assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [
      managedArtifactsToContribution({
        workplaceRef: WORKPLACE,
        executionRef: 'exec-A',
        artifacts: [
          { artifactType: 'prd', artifactId: 1, contentHash: 'sha256:prd', executionId: 'exec-A' },
        ],
      }),
      // Same artifact type, same content, different execution + artifact ID.
      managedArtifactsToContribution({
        workplaceRef: WORKPLACE,
        executionRef: 'exec-B',
        artifacts: [
          { artifactType: 'prd', artifactId: 99, contentHash: 'sha256:prd', executionId: 'exec-B' },
        ],
      }),
    ],
    presenterRef: 'exec-B',
    sealedAt: '2026-08-11T12:00:00Z',
  });
  // One member (the second put overwrote the first — same content).
  assert.equal(revision.members.length, 1);
  assert.equal(revision.members[0].memberKey, 'artifact/prd');
  assert.equal(revision.members[0].contentDigest, 'sha256:prd');
});
