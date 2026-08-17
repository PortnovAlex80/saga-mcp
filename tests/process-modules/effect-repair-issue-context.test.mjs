// tests/process-modules/effect-repair-issue-context.test.mjs
//
// Regression (observed live, TrackPlan lifecycle 5, 2026-08-17): the
// acceptance-effect repair issue stored context.workplaceRef as the RAW
// structured WorkplaceRef, which canonicalJson stringified to
// "[object Object]". The strict projection read
// (PRODUCTION_CELL_EFFECT_REPAIR_SUBJECT_MISMATCH) compares that field with
// the STRING workplace_ref column and failed, terminating the whole
// lifecycle. The context must carry the SERIALIZED ref.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAcceptanceEffectRepairIssue,
} from '../../dist/process-modules/application/post-acceptance-effects.js';
import { asWorkplaceRef } from '../../dist/process-modules/domain/workplace/workplace-ref.js';

const authority = () => ({
  workplaceRef: asWorkplaceRef('workplace/14/dev@1.4.3/implementation/abc123'),
  candidateSetRef: 'candidate-set/14/dev/1.4.3/abc/author',
  productionRevisionRef: 'revision-xyz',
  acceptedProductRefs: [],
  gateDecisionKey: 'decision:gate-run:aaa',
  acceptanceDigest: 'ddd',
});

test('repair issue context.workplaceRef is the SERIALIZED workplace ref', () => {
  const issue = buildAcceptanceEffectRepairIssue({
    effect: { effectId: 'git-integration', version: '1.0.0', effectDigest: 'e-digest' },
    authority: authority(),
    result: { outcome: 'repair_required', reason: 'integration blocked' },
  });
  assert.equal(
    issue.context.workplaceRef,
    'workplace/14/dev@1.4.3/implementation/abc123',
    'context must carry the string ref, not a stringified object',
  );
  assert.notEqual(String(issue.context.workplaceRef), '[object Object]');
  assert.equal(issue.context.source, 'acceptance-effect');
  assert.equal(issue.context.effectId, 'git-integration');
});
