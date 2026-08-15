import { test } from 'node:test';
import assert from 'node:assert/strict';

import { submissionValidatorCheckProvider } from '../../dist/process-modules/application/submission-validator-check-provider.js';
import { decodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';
import {
  submissionValidationContentDigest,
  submissionValidationMemberKey,
} from '../../dist/process-modules/application/submission-validation-receipt-authority.js';

const candidate = {
  candidateSetRef: 'candidate-set/test/author',
  workplaceRef: {
    processRunId: 2,
    moduleRef: 'solution-formalization@1.0.0',
    cellId: 'formalization-product-contract',
    workKey: 'product-contract',
  },
  productionRevisionRef: 'production-revision:test',
  role: 'author',
};

const receipt = {
  receiptId: 7,
  validatorId: 'formalization.product-contract.v1',
  validatorVersion: '1.0.0',
  processRunId: 2,
  moduleRef: 'solution-formalization@1.0.0',
  nodeId: 'define-product-contract',
  inputSnapshotHash: 'input-hash',
  artifactIds: [11],
  traceIds: [12],
  artifactHashes: { 11: 'artifact-hash' },
  traceDigest: 'trace-digest',
  contractRef: null,
  validatedSetDigest: 'validated-set',
};

function providerDb({ includeProof = true, presenterRef = 'exec-a', tamperDigest = false } = {}) {
  const proof = {
    memberKey: submissionValidationMemberKey(receipt),
    productRef: `submission-validation-receipt:${receipt.receiptId}`,
    contentDigest: tamperDigest ? 'tampered' : submissionValidationContentDigest(receipt),
  };
  return {
    prepare(sql) {
      if (sql.includes('factory_workplace_production_revisions')) {
        // presenterRef deliberately varies: Gate outcome must not observe it.
        return { get: () => ({ presenter_ref: presenterRef, members: JSON.stringify(includeProof ? [proof] : []) }) };
      }
      if (sql.includes('factory_submission_validation_receipts')) {
        return { get: () => ({
          ...receipt,
          artifactIds: JSON.stringify(receipt.artifactIds),
          traceIds: JSON.stringify(receipt.traceIds),
          artifactHashes: JSON.stringify(receipt.artifactHashes),
          contractRef: null,
        }) };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function runProvider(options = {}) {
  let validatorCalls = 0;
  const provider = submissionValidatorCheckProvider({
    db: providerDb(options),
    candidateSets: { read: ref => ref === candidate.candidateSetRef ? candidate : null },
    validator: {
      validatorId: receipt.validatorId,
      validatorVersion: receipt.validatorVersion,
      validate: () => { validatorCalls += 1; throw new Error('post-seal validator must not run'); },
    },
    nodeId: receipt.nodeId,
    requireManagedProduction: true,
  });
  const result = provider.run({
    subjectCandidateSetRef: candidate.candidateSetRef,
    parameters: { processRunId: 2, moduleRef: candidate.workplaceRef.moduleRef },
    environmentRef: null,
    candidateSnapshot: {},
  });
  return { result, validatorCalls };
}

test('Gate fails with an actionable diagnostic when the sealed revision has no validation proof', () => {
  const { result, validatorCalls } = runProvider({ includeProof: false });
  assert.equal(result.outcome, 'failed');
  assert.equal(validatorCalls, 0);
  const diagnostic = decodeCheckDiagnostic(result.evidenceRefs[0]);
  assert.equal(diagnostic.code, 'SUBMISSION_VALIDATION_RECEIPT_REQUIRED');
  assert.match(diagnostic.message, /sealed Workplace production revision/);
});

test('Gate consumes exact revision proof and is invariant to audit presenter identity', () => {
  const a = runProvider({ presenterRef: 'exec-a' });
  const b = runProvider({ presenterRef: 'exec-b' });
  assert.equal(a.result, 'passed');
  assert.equal(b.result, 'passed');
  assert.equal(a.validatorCalls, 0);
  assert.equal(b.validatorCalls, 0);
});

test('Gate fails closed when the exact receipt does not match the sealed proof digest', () => {
  const { result, validatorCalls } = runProvider({ tamperDigest: true });
  assert.equal(result, 'error');
  assert.equal(validatorCalls, 0);
});
