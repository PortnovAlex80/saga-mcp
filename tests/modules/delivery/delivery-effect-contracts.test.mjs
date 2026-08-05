/**
 * Delivery effect contracts tests (Conveyor v4, step 3.D).
 *
 * Target contracts: REG-22 (HumanInteractionRun) + REG-23 (EffectAttempt/
 * EffectReceipt).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertValidHumanInteractionRun,
  assertValidEffectAttempt,
  assertValidEffectReceipt,
} from '../../../dist/modules/delivery/domain/delivery-effect-contracts.js';

const DIGEST = 'a'.repeat(64);
const REF = { schemaId: 's', ref: 'r', digest: DIGEST };

test('REG-22: valid HumanInteractionRun (requested) passes', () => {
  assert.doesNotThrow(() => assertValidHumanInteractionRun({
    requestRef: 'hr-1',
    question: 'Approve release?',
    subjectWorkplaceRef: 'workplace/1/delivery@1/release/default',
    subjectCandidateSetRef: null,
    authority: 'release-manager',
    state: 'requested',
    answer: null,
    answeredBy: null,
    answeredAt: null,
    expiresAt: '2026-08-10T00:00:00Z',
    resumeTarget: 'integration',
    createdAt: '2026-08-05T00:00:00Z',
  }));
});

test('REG-22: answered without answer/answeredBy/answeredAt rejected', () => {
  assert.throws(
    () => assertValidHumanInteractionRun({
      requestRef: 'hr-1',
      question: 'q',
      subjectWorkplaceRef: 'ws',
      subjectCandidateSetRef: null,
      authority: 'a',
      state: 'answered',
      answer: null,
      answeredBy: null,
      answeredAt: null,
      expiresAt: '2026-08-10T00:00:00Z',
      resumeTarget: 'author',
      createdAt: '2026-08-05T00:00:00Z',
    }),
    /answered requires/,
  );
});

test('REG-22: missing question rejected', () => {
  assert.throws(
    () => assertValidHumanInteractionRun({
      requestRef: 'hr-1', question: '', subjectWorkplaceRef: 'ws',
      subjectCandidateSetRef: null, authority: 'a', state: 'requested',
      answer: null, answeredBy: null, answeredAt: null,
      expiresAt: '2026-08-10T00:00:00Z', resumeTarget: 'author',
      createdAt: '2026-08-05T00:00:00Z',
    }),
    /question/,
  );
});

test('REG-23: valid EffectAttempt passes', () => {
  assert.doesNotThrow(() => assertValidEffectAttempt({
    attemptRef: 'eff-1',
    effectKind: 'git-merge',
    desiredStateRef: REF,
    authorizationDigest: DIGEST,
    idempotencyKey: 'idem-1',
    targetRef: 'refs/heads/dev',
    state: 'authorized',
    observedResult: null,
    receiptRef: null,
    createdAt: '2026-08-05T00:00:00Z',
    updatedAt: '2026-08-05T00:00:00Z',
  }));
});

test('REG-23: EffectAttempt without desiredStateRef rejected', () => {
  assert.throws(
    () => assertValidEffectAttempt({
      attemptRef: 'eff-1', effectKind: 'deploy',
      desiredStateRef: { schemaId: '', ref: 'r', digest: 'd' },
      authorizationDigest: DIGEST, idempotencyKey: 'k',
      targetRef: 'prod', state: 'authorized', observedResult: null,
      receiptRef: null, createdAt: 't', updatedAt: 't',
    }),
    /desiredStateRef/,
  );
});

test('REG-23: valid EffectReceipt passes', () => {
  assert.doesNotThrow(() => assertValidEffectReceipt({
    receiptRef: 'rec-1',
    attemptRef: 'eff-1',
    effectKind: 'git-merge',
    externalChangeId: 'abc123',
    desiredStateRef: REF,
    effective: true,
    observedAt: '2026-08-05T00:00:00Z',
    receiptDigest: DIGEST,
  }));
});

test('REG-23: bad receiptDigest rejected', () => {
  assert.throws(
    () => assertValidEffectReceipt({
      receiptRef: 'rec-1', attemptRef: 'eff-1', effectKind: 'deploy',
      externalChangeId: 'x', desiredStateRef: REF, effective: true,
      observedAt: 't', receiptDigest: 'short',
    }),
    /64-char/,
  );
});
