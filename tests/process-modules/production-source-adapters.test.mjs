import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleRevision } from '../../dist/process-modules/domain/workplace/workplace-production-revision.js';
import {
  candidateSetDigestForRevision,
  candidateSetSealKey,
} from '../../dist/process-modules/domain/workplace/candidate-set.js';
import { canonicalProductsToContribution } from '../../dist/process-modules/application/production-source-adapters.js';
import { productionIngressModeFromAuthorityScope } from '../../dist/process-modules/application/production-ingress-contract.js';
import {
  submissionValidationContentDigest,
  submissionValidationMemberKey,
} from '../../dist/process-modules/application/submission-validation-receipt-authority.js';

const WORKPLACE = 'workplace/1/cell/item';

function revision(executionRef, ref, digest = 'same-content') {
  return assembleRevision({
    workplaceRef: WORKPLACE,
    parent: null,
    contributions: [canonicalProductsToContribution({
      workplaceRef: WORKPLACE,
      executionRef,
      products: [{ schemaId: 'factory.product.v1', ref, digest }],
    })],
    presenterRef: executionRef,
  });
}

test('ADR-067: frozen WorkIntent capabilities select exactly one physical ingress', () => {
  assert.equal(productionIngressModeFromAuthorityScope({
    allowed_tools: ['task_get', 'product_submit', 'worker_done'],
  }), 'typed-submission');
  assert.equal(productionIngressModeFromAuthorityScope(JSON.stringify({
    allowed_tools: ['task_get', 'artifact_update', 'worker_done'],
  })), 'managed-workplace');
  assert.throws(
    () => productionIngressModeFromAuthorityScope('{}'),
    /PRODUCTION_INGRESS_AUTHORITY_INVALID/,
  );
});

test('ADR-067: ProductRef aliases and presenters cannot change material authority', () => {
  const a = revision('exec-A', 'managed-node-submission:101');
  const b = revision('exec-B', 'workplace-product:202');
  assert.equal(a.materialDigest, b.materialDigest);
  assert.equal(a.semanticDigest, b.semanticDigest);
  assert.equal(a.revisionRef, b.revisionRef);
  const workplaceRef = {
    processRunId: 1,
    moduleRef: 'module@1.0.0',
    productionCellId: 'cell',
    workKey: 'item',
  };
  assert.equal(
    candidateSetSealKey({ workplaceRef, productionRevisionRef: a.revisionRef, role: 'author' }),
    candidateSetSealKey({ workplaceRef, productionRevisionRef: b.revisionRef, role: 'author' }),
  );
  assert.equal(
    candidateSetDigestForRevision({ workplaceRef, productionRevisionRef: a.revisionRef, role: 'author' }),
    candidateSetDigestForRevision({ workplaceRef, productionRevisionRef: b.revisionRef, role: 'author' }),
  );
});

test('ADR-067: changed ProductRef content changes material authority', () => {
  assert.notEqual(
    revision('exec-A', 'submission:1', 'content-A').revisionRef,
    revision('exec-B', 'submission:2', 'content-B').revisionRef,
  );
});

test('ADR-053 B-3: exact validation proof is material and execution-free', () => {
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
  const contribution = canonicalProductsToContribution({
    workplaceRef: WORKPLACE,
    executionRef: 'exec-A',
    products: [{ schemaId: 'product.v1', ref: 'product:1', digest: 'content' }],
    validationReceipts: [receipt],
  });
  assert.deepEqual(contribution.operations[1], {
    op: 'put',
    memberKey: submissionValidationMemberKey(receipt),
    productRef: 'submission-validation-receipt:9',
    contentDigest: submissionValidationContentDigest(receipt),
    sourceAdapter: 'evidence',
  });
  assert.notEqual(
    submissionValidationContentDigest(receipt),
    submissionValidationContentDigest({ ...receipt, validatedSetDigest: 'other' }),
  );
});
