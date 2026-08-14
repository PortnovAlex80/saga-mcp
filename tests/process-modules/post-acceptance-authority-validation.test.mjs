// tests/process-modules/post-acceptance-authority-validation.test.mjs
//
// ADR-053 C17 regression — the post-acceptance effect registry MUST fail closed
// on an incomplete or internally-inconsistent AcceptedCandidateAuthority.
//
// An effect must NEVER run against:
//   - an empty productionRevisionRef / candidateSetRef / gateDecisionKey (the
//     consumer would have to re-derive material from execution/task/latest —
//     the exact legacy path ADR-053 removes);
//   - an empty acceptedProductRefs list (nothing was accepted);
//   - a forged / stale acceptanceDigest (the authority drifted from the sealed
//     material). The digest is recomputed from the other authority fields and
//     required to match exactly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAuthorityBound,
  computeAcceptanceDigest,
} from '../../dist/process-modules/application/post-acceptance-effects.js';

const operational = {
  processRunId: 1,
  moduleRef: { name: 'm', version: '1.0.0' },
  nodeId: 'n',
};

function validAuthority() {
  const acceptedProductRefs = [
    { schemaId: 'factory.product.v1', ref: 'product/abc', digest: 'sha256:abc' },
  ];
  const gateDecisionKey = 'decision:gate-run/xyz';
  const acceptanceDigest = computeAcceptanceDigest({
    candidateSetRef: 'candidate-set/1/m/c/i/rev/author',
    productionRevisionRef: 'revision/1/m/c/i/abc',
    acceptedProductRefs,
    gateDecisionKey,
  });
  return {
    workplaceRef: { processRunId: 1, moduleRef: 'm', productionCellId: 'c', workKey: 'i' },
    candidateSetRef: 'candidate-set/1/m/c/i/rev/author',
    productionRevisionRef: 'revision/1/m/c/i/abc',
    acceptedProductRefs,
    productSchema: 'factory.product.v1',
    gateDecisionKey,
    productContractRef: null,
    acceptanceDigest,
  };
}

test('C17: assertAuthorityBound accepts a fully-bound, internally-consistent authority', () => {
  // A correct authority passes — fail-closed must not reject valid input.
  assertAuthorityBound({ authority: validAuthority(), operational });
});

test('C17: assertAuthorityBound rejects empty productionRevisionRef', () => {
  assert.throws(
    () => assertAuthorityBound({
      authority: { ...validAuthority(), productionRevisionRef: '' },
      operational,
    }),
    /AUTHORITY_PRODUCTION_REVISION_REQUIRED/,
  );
});

test('C17: assertAuthorityBound rejects empty candidateSetRef', () => {
  assert.throws(
    () => assertAuthorityBound({
      authority: { ...validAuthority(), candidateSetRef: '' },
      operational,
    }),
    /AUTHORITY_CANDIDATE_SET_REQUIRED/,
  );
});

test('C17: assertAuthorityBound rejects empty gateDecisionKey (no fabricated/placeholder key)', () => {
  assert.throws(
    () => assertAuthorityBound({
      authority: { ...validAuthority(), gateDecisionKey: '' },
      operational,
    }),
    /AUTHORITY_GATE_DECISION_KEY_REQUIRED/,
  );
});

test('C17: assertAuthorityBound rejects an empty acceptedProductRefs list', () => {
  assert.throws(
    () => assertAuthorityBound({
      authority: { ...validAuthority(), acceptedProductRefs: [] },
      operational,
    }),
    /AUTHORITY_ACCEPTED_PRODUCTS_REQUIRED/,
  );
});

test('C17: assertAuthorityBound rejects a forged / stale acceptanceDigest', () => {
  assert.throws(
    () => assertAuthorityBound({
      authority: { ...validAuthority(), acceptanceDigest: 'bogus' },
      operational,
    }),
    /AUTHORITY_ACCEPTANCE_DIGEST_MISMATCH/,
  );
});

test('C17: assertAuthorityBound rejects a drifted product list whose digest no longer matches', () => {
  const base = validAuthority();
  // Add a product WITHOUT recomputing the digest → the recomputed digest will
  // not match the (now stale) carried acceptanceDigest.
  const drifted = {
    ...base,
    acceptedProductRefs: [
      ...base.acceptedProductRefs,
      { schemaId: 'x', ref: 'product/extra', digest: 'sha256:extra' },
    ],
  };
  assert.throws(
    () => assertAuthorityBound({ authority: drifted, operational }),
    /AUTHORITY_ACCEPTANCE_DIGEST_MISMATCH/,
  );
});

test('ADR-053 B-3: acceptance identity ignores execution-scoped ProductRef aliases', () => {
  const shared = {
    candidateSetRef: 'candidate-set/shared',
    productionRevisionRef: 'revision/shared',
    gateDecisionKey: 'decision/shared',
  };
  const fromA = computeAcceptanceDigest({
    ...shared,
    acceptedProductRefs: [{
      schemaId: 'factory.product.v1', ref: 'managed-node-submission:101', digest: 'sha256:same',
    }],
  });
  const fromB = computeAcceptanceDigest({
    ...shared,
    acceptedProductRefs: [{
      schemaId: 'factory.product.v1', ref: 'managed-node-submission:202', digest: 'sha256:same',
    }],
  });
  assert.equal(fromB, fromA);
});
