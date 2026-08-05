/**
 * GateDecisionAdapter tests (Conveyor v4, step 3.A.3).
 *
 * Target contract: REG-18 (Акт ОТК — closed verdict).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { asWorkplaceRef } from '../../../dist/process-modules/domain/workplace/workplace-ref.js';
import {
  gateDecisionFromAcceptedCandidate,
  gateDecisionForRepair,
  gateDecisionForHuman,
  gateDecisionForFailure,
  isValidGateVerdict,
} from '../../../dist/modules/formalization/application/gate-decision-adapter.js';
import { assertValidGateDecision } from '../../../dist/process-modules/domain/workplace/gate.js';

const REF = asWorkplaceRef({ processRunId: 1, moduleRef: 'formalization@1.0.0', productionCellId: 'srs-author' });
const DIGEST = 'a'.repeat(64);

const base = {
  workplaceRef: REF,
  gateRef: 'formalization.author-gate',
  gateRunRef: 'gr-1',
  gatePhase: 'final',
  idempotencyKey: 'dk-1',
  candidateSetHash: 'c'.repeat(64),
  checkPlanRef: 'plan-1',
  checkPlanDigest: 'p'.repeat(64),
  decisionPolicyRef: 'pol-1',
  decisionPolicyDigest: 'q'.repeat(64),
  installationDigest: 'i'.repeat(64),
  checkReceiptRefs: ['cr-1'],
  decisionDigest: 'e'.repeat(64),
};

test('REG-18: accepted (author-gate, not final) has empty output bindings', () => {
  const d = gateDecisionFromAcceptedCandidate({ ...base, authority: 'kernel-gate', reasonCode: 'accepted', final: false });
  assert.equal(d.verdict, 'accepted');
  assert.equal(d.acceptedOutputBindings.length, 0);
  assert.equal(d.repairTargetRole, null);
  assert.equal(d.recoveryIssueRef, null);
  assert.doesNotThrow(() => assertValidGateDecision(d));
});

test('REG-18-AC-03: accepted (final-gate) may carry output bindings', () => {
  const d = gateDecisionFromAcceptedCandidate({
    ...base,
    authority: 'kernel-gate',
    reasonCode: 'accepted',
    final: true,
    acceptedOutputBindings: [{ binding: 'solution-contract', productRefs: [{ schemaId: 's', ref: 'r', digest: DIGEST }] }],
  });
  assert.equal(d.verdict, 'accepted');
  assert.equal(d.acceptedOutputBindings.length, 1);
  assert.doesNotThrow(() => assertValidGateDecision(d));
});

test('REG-18-AC-04: repair_required carries repairTargetRole + recoveryIssueRef', () => {
  const d = gateDecisionForRepair({
    ...base,
    repairTargetRole: 'author',
    recoveryIssueRef: 'issue-1',
  });
  assert.equal(d.verdict, 'repair_required');
  assert.equal(d.repairTargetRole, 'author');
  assert.equal(d.recoveryIssueRef, 'issue-1');
  assert.doesNotThrow(() => assertValidGateDecision(d));
});

test('REG-18: human_required verdict', () => {
  const d = gateDecisionForHuman(base);
  assert.equal(d.verdict, 'human_required');
  assert.equal(d.repairTargetRole, null);
  assert.equal(d.recoveryIssueRef, null);
  assert.doesNotThrow(() => assertValidGateDecision(d));
});

test('REG-18: failed verdict', () => {
  const d = gateDecisionForFailure(base);
  assert.equal(d.verdict, 'failed');
  assert.equal(d.repairTargetRole, null);
  assert.equal(d.acceptedOutputBindings.length, 0);
  assert.doesNotThrow(() => assertValidGateDecision(d));
});

test('REG-18: isValidGateVerdict type guard', () => {
  assert.equal(isValidGateVerdict('accepted'), true);
  assert.equal(isValidGateVerdict('repair_required'), true);
  assert.equal(isValidGateVerdict('human_required'), true);
  assert.equal(isValidGateVerdict('failed'), true);
  assert.equal(isValidGateVerdict('other'), false);
});

test('REG-18: all four verdicts pass assertValidGateDecision', () => {
  for (const builder of [
    () => gateDecisionFromAcceptedCandidate({ ...base, authority: 'a', reasonCode: 'r', final: false }),
    () => gateDecisionForRepair({ ...base, repairTargetRole: 'author', recoveryIssueRef: 'i' }),
    () => gateDecisionForHuman(base),
    () => gateDecisionForFailure(base),
  ]) {
    const d = builder();
    assert.doesNotThrow(() => assertValidGateDecision(d));
  }
});
