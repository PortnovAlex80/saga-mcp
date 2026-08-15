/**
 * ProductionCellDefinition tests (Conveyor v4, step 2.1).
 *
 * Target contract: REG-04 (Производственная ячейка).
 *
 * Covers the declarative cell shape and its cross-field rules:
 *   - singleton cell (no review) → authorGate.gatePhase must be 'final'.
 *   - cell with review → authorGate='author', review.finalGate='final'.
 *   - inputSelectors / productContracts non-empty.
 *   - recovery.maxAttempts >= 1, onExhausted in {fail,pause}.
 *   - transitions cover accepted/humanRequired/failed.
 *   - quorum completionPolicy requires a threshold.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertValidProductionCellDefinition,
} from '../../dist/process-modules/domain/workplace/production-cell-definition.js';

const PLAN_DIGEST = 'a'.repeat(64);
const POLICY_DIGEST = 'b'.repeat(64);

function makePlan() {
  return {
    checkPlanId: 'plan-1',
    version: '1',
    checkPlanDigest: PLAN_DIGEST,
    entries: [
      {
        check: { providerId: 'tsc', version: '5.4', providerDigest: 'c'.repeat(64) },
        parameters: {},
        environmentRef: null,
      },
    ],
    decisionPolicyRef: 'policy-1',
    decisionPolicyDigest: POLICY_DIGEST,
    unknownErrorPolicy: 'fail-closed',
  };
}

function makeCell(overrides = {}) {
  return {
    id: 'srs-author',
    inputSelectors: ['brief'],
    materialization: { completionPolicy: 'all' },
    author: { skillRef: 'saga-analyst', capabilityPreset: 'text-author' },
    productContracts: [
      { binding: 'srs', schemaRef: 'factory.srs.v1', mediaType: 'application/json', cardinality: '1' },
    ],
    authorGate: { gateId: 'author-gate', gatePhase: 'final', checkPlan: makePlan() },
    recovery: { maxAttempts: 3, onExhausted: 'fail' },
    transitions: {
      accepted: 'next-node',
      humanRequired: 'human-node',
      failed: 'fail-node',
    },
    ...overrides,
  };
}

test('REG-04: valid singleton cell (no review, authorGate=final) passes', () => {
  assert.doesNotThrow(() => assertValidProductionCellDefinition(makeCell()));
});

test('REG-04: singleton cell with authorGate=author (no review) rejected', () => {
  assert.throws(
    () => assertValidProductionCellDefinition(makeCell({
      authorGate: { gateId: 'g', gatePhase: 'author', checkPlan: makePlan() },
    })),
    /authorGate.gatePhase must be 'final'/,
  );
});

test('REG-04: cell with review — author=author + finalGate=final passes', () => {
  const cell = makeCell({
    authorGate: { gateId: 'g', gatePhase: 'author', checkPlan: makePlan() },
    review: {
      reviewer: { skillRef: 'saga-architect', capabilityPreset: 'text-reviewer' },
      verdictSchemaRef: 'factory.review-verdict.v1',
      finalGate: { gateId: 'final-gate', gatePhase: 'final', checkPlan: makePlan() },
    },
  });
  assert.doesNotThrow(() => assertValidProductionCellDefinition(cell));
});

test('REG-04: cell with review but authorGate=final rejected', () => {
  assert.throws(
    () => assertValidProductionCellDefinition(makeCell({
      // review present but authorGate still 'final' (inconsistent)
      review: {
        reviewer: { skillRef: 'r', capabilityPreset: 'text-reviewer' },
        verdictSchemaRef: 'v',
        finalGate: { gateId: 'fg', gatePhase: 'final', checkPlan: makePlan() },
      },
    })),
    /authorGate.gatePhase must be 'author'/,
  );
});

test('REG-04: cell with review but finalGate=author rejected', () => {
  assert.throws(
    () => assertValidProductionCellDefinition(makeCell({
      authorGate: { gateId: 'g', gatePhase: 'author', checkPlan: makePlan() },
      review: {
        reviewer: { skillRef: 'r', capabilityPreset: 'text-reviewer' },
        verdictSchemaRef: 'v',
        finalGate: { gateId: 'fg', gatePhase: 'author', checkPlan: makePlan() },
      },
    })),
    /finalGate.gatePhase must be 'final'/,
  );
});

test('REG-04: empty inputSelectors rejected', () => {
  assert.throws(
    () => assertValidProductionCellDefinition(makeCell({ inputSelectors: [] })),
    /inputSelectors/,
  );
});

test('REG-04: empty productContracts rejected', () => {
  assert.throws(
    () => assertValidProductionCellDefinition(makeCell({ productContracts: [] })),
    /productContracts/,
  );
});

test('REG-04: maxAttempts < 1 rejected', () => {
  assert.throws(
    () => assertValidProductionCellDefinition(makeCell({ recovery: { maxAttempts: 0, onExhausted: 'fail' } })),
    /maxAttempts/,
  );
});

test('REG-04: bad onExhausted rejected', () => {
  assert.throws(
    () => assertValidProductionCellDefinition(makeCell({ recovery: { maxAttempts: 2, onExhausted: 'retry' } })),
    /onExhausted/,
  );
});

test('REG-04: missing transition rejected', () => {
  assert.throws(
    () => assertValidProductionCellDefinition(makeCell({
      transitions: { accepted: 'n', humanRequired: '', failed: 'f' },
    })),
    /transitions.humanRequired/,
  );
});

test('REG-04: quorum without threshold rejected', () => {
  assert.throws(
    () => assertValidProductionCellDefinition(makeCell({
      materialization: { completionPolicy: 'quorum' },
    })),
    /quorum/,
  );
});

test('REG-04: quorum WITH threshold passes', () => {
  assert.doesNotThrow(() => assertValidProductionCellDefinition(makeCell({
    materialization: { completionPolicy: 'quorum', quorum: 2 },
  })));
});
