// tests/factory-contract/verification-check-provider-criterion-key.test.mjs
//
// CC-GAP-1 focused regression for the test-only verification check provider.
//
// f13181e0 separated ATOMIC criterion identity (acceptanceCriterionKey,
// `${artifactId}:${code}`) from provenance artifact identity. The v2 decoder
// is fail-closed on the key grammar and rejects any legacy
// `acceptanceCriterionId` field, so a predicate comparing the REMOVED
// decoded.value.acceptanceCriterionId against row.verification_target_artifact_id
// is always-true for every lawful v2 payload and fails every lawful
// verification submission (Development E2Es end development-blocked).
//
// This regression pins the three facts that keep the fixture honest:
//   1. a lawful v2 payload passes (carrying ONLY the criterion key);
//   2. the key's provenance segment is STILL bound to the task's
//      verification_target_artifact_id — a mismatched artifact id fails;
//   3. a legacy payload carrying the removed acceptanceCriterionId field is
//      rejected fail-closed by the decoder (the reason the stale predicate
//      was impossible to satisfy).

import { test } from 'node:test';
import assert from 'node:assert';
import { createTestVerificationCheckProviderFactory } from './test-verification-check-provider.mjs';
import { DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA } from '../../dist/modules/development/domain/development-schemas.js';

const SUBMISSION_ID = 77;
const PROCESS_RUN_ID = 5;
const ARTIFACT_ID = 42;
const CONTENT_HASH = 'a'.repeat(64);
const ACCEPTED_HASH = 'b'.repeat(64);
const CANDIDATE_HASH = 'c'.repeat(64);
const ITEM_KEY = 'verify-item-1';

function lawfulPayload(criterionKey = `${ARTIFACT_ID}:AC-1`) {
  return {
    schemaVersion: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
    verificationItemKey: ITEM_KEY,
    acceptanceCriterionKey: criterionKey,
    acceptedCriterionHash: ACCEPTED_HASH,
    candidateHash: CANDIDATE_HASH,
    outcome: 'passed',
    evidence: {
      summary: 'deterministic scripted verification',
      observations: ['observed the criterion satisfied'],
      limitations: [],
    },
  };
}

function makeProvider({ payload, targetArtifactId = ARTIFACT_ID, criterionKeys }) {
  const row = {
    payload_snapshot: JSON.stringify(payload),
    content_hash: CONTENT_HASH,
    verification_target_artifact_id: targetArtifactId,
    metadata: JSON.stringify({
      cell_input_item: {
        key: ITEM_KEY,
        acceptanceCriterionKeys: criterionKeys
          ?? [payload.acceptanceCriterionKey],
      },
      process_node_input: {
        upstream: { bindings: { candidate: { candidateHash: CANDIDATE_HASH } } },
      },
    }),
    accepted_hash: ACCEPTED_HASH,
  };
  const db = { prepare: () => ({ get: () => row }) };
  const candidateSets = {
    read: () => ({
      role: 'author',
      workplaceRef: { processRunId: PROCESS_RUN_ID },
      members: [{
        productRef: {
          schemaId: DEVELOPMENT_VERIFICATION_EVIDENCE_PRODUCT_SCHEMA,
          ref: `managed-node-submission:${SUBMISSION_ID}`,
          digest: CONTENT_HASH,
        },
      }],
    }),
  };
  return createTestVerificationCheckProviderFactory()({ db, candidateSets });
}

const PARAMETERS = { processRunId: String(PROCESS_RUN_ID) };
const SUBJECT_REF = `candidate-set/test-${SUBMISSION_ID}`;

test('test verification provider: lawful v2 criterion-key payload passes', () => {
  const provider = makeProvider({ payload: lawfulPayload() });
  const result = provider.run({
    subjectCandidateSetRef: SUBJECT_REF,
    parameters: PARAMETERS,
  });
  assert.notEqual(result, 'failed', 'lawful v2 payload must not fail lineage validation');
  assert.notEqual(result, 'error', 'lawful v2 payload must not error');
  assert.ok(result && typeof result === 'object',
    'a passed scripted assessment must return an outcome object with evidenceRefs');
  assert.equal(result.outcome, 'passed');
  assert.ok(result.evidenceRefs.length > 0,
    'settlement readTrustedVerificationReceipt requires non-empty evidenceRefs');
});

test('test verification provider: criterion key bound to the WRONG provenance artifact id fails', () => {
  // The payload key matches the card's criterion key, so every other lineage
  // condition holds — the ONLY mismatch is the key's provenance segment (43)
  // against the task's verification_target_artifact_id (42).
  const provider = makeProvider({
    payload: lawfulPayload('43:AC-1'),
    criterionKeys: ['43:AC-1'],
  });
  const result = provider.run({
    subjectCandidateSetRef: SUBJECT_REF,
    parameters: PARAMETERS,
  });
  assert.equal(result, 'failed',
    'evidence whose criterion key names a different provenance artifact than the task target must fail');
});

test('test verification provider: legacy acceptanceCriterionId field is rejected fail-closed', () => {
  // Pre-f13181e0 payload shape: carried acceptanceCriterionId. The v2 decoder
  // allowlist rejects unknown fields, so the stale predicate comparing the
  // removed field was unsatisfiable for lawful payloads.
  const legacy = {
    ...lawfulPayload(),
    acceptanceCriterionId: ARTIFACT_ID,
  };
  const provider = makeProvider({ payload: legacy });
  const result = provider.run({
    subjectCandidateSetRef: SUBJECT_REF,
    parameters: PARAMETERS,
  });
  assert.equal(result, 'failed', 'unknown fields must fail closed at the decode boundary');
});
