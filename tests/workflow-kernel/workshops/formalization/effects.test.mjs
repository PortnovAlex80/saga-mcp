/**
 * effects.test.mjs - the idempotent effects and typed waits of the
 * Formalization workshop (WP-11F): D2 outcome vocabulary, D5/D12 typed-wait
 * descriptors from the frozen registry, content-addressed idempotency keys.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from './support.mjs';

const effects = () => import('../../../../dist/workflow-kernel/workshops/formalization/effects.js');

test('an effect settles success once; the same action key settles already-applied', async () => {
  const e = await effects();
  const executor = new e.FormalizationEffectExecutor();
  let mutations = 0;
  const digest = sha256('accepted-prd-revision');
  const first = executor.execute('formalization.accept-products', digest, () => {
    mutations += 1;
    return 'receipt-1';
  });
  assert.equal(first.outcome, 'success');
  const second = executor.execute('formalization.accept-products', digest, () => {
    mutations += 1;
    return 'receipt-2';
  });
  assert.equal(second.outcome, 'already-applied');
  assert.equal(second.receiptDigest, 'receipt-1');
  assert.equal(mutations, 1, 'the external mutation ran exactly once');
  assert.equal(executor.settledCount, 1);
  assert.equal(executor.hasApplied('formalization.accept-products', digest), true);
});

test('different content digests are different action keys (content-addressed idempotency)', async () => {
  const e = await effects();
  const executor = new e.FormalizationEffectExecutor();
  const a = executor.execute('formalization.freeze-what-baseline', sha256('baseline-a'), () => 'ra');
  const b = executor.execute('formalization.freeze-what-baseline', sha256('baseline-b'), () => 'rb');
  assert.equal(a.outcome, 'success');
  assert.equal(b.outcome, 'success');
  assert.equal(executor.settledCount, 2);
  assert.equal(e.FormalizationEffectExecutor.actionKeyOf('formalization.settle-solution-contract', 'd'), e.FormalizationEffectExecutor.actionKeyOf('formalization.settle-solution-contract', 'd'));
  assert.notEqual(e.FormalizationEffectExecutor.actionKeyOf('formalization.settle-solution-contract', 'd1'), e.FormalizationEffectExecutor.actionKeyOf('formalization.settle-solution-contract', 'd2'));
});

test('the declared effect ids are the manifest-declared closed set', async () => {
  const e = await effects();
  assert.deepEqual(e.FORMALIZATION_EFFECT_IDS, [
    'formalization.accept-products',
    'formalization.freeze-what-baseline',
    'formalization.settle-solution-contract',
  ]);
});

test('typed waits use only the frozen D5/D12 vocabulary from the registry', async () => {
  const e = await effects();
  const human = e.typedWaitOf('TypedWait:human-input');
  assert.deepEqual(human.wakeCommands, ['workplace.resolveHumanResponse', 'nodeRun.recordHumanDecision']);
  assert.equal(human.disposition, 'wake-source-completion');
  const uncertainty = e.typedWaitOf('TypedWait:effect-uncertainty');
  assert.deepEqual(uncertainty.wakeCommands, ['workplace.resolveHumanResponse']);
  assert.equal(uncertainty.disposition, 'operator-disposition-command-required');
  // An unknown wait kind is a typed error, never invented.
  assert.throws(() => e.typedWaitOf('TypedWait:not-a-kind'), /FORMALIZATION_WAIT_UNKNOWN/);
});
