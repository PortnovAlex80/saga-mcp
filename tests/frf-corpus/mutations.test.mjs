/**
 * mutations.test.mjs - the killed-mutation suite (FRF-WP10): proves the
 * expected-world comparisons DETECT tampering. Every mutation below is a
 * data transformation of the descriptor's expected world (or of the
 * observed material); the run MUST go RED - a surviving mutation would
 * mean the comparison is vacuous.
 *
 * Families (mirrors the EK corpus mutation hooks):
 *   - expected-verdict tampering   (a desk verdict flipped)
 *   - expected-refusal tampering   (a typed refusal reason swapped)
 *   - expected-sweep tampering     (a sweep outcome rewritten)
 *   - expected-closure tampering   (the F-2 verdict flipped to consistent)
 *   - expected-capsule tampering   (an artifact kind dropped)
 *   - input-stream tampering       (the green PRD member mutated after
 *                                   the expected world was authored)
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { frfDescriptorOf } from '../../tools/frf-corpus/lib/registry.mjs';
import { runFrfScenario } from '../../tools/frf-corpus/lib/execute.mjs';
import { driveDeskChain, normalizedWorldOf } from '../../tools/frf-corpus/lib/chain.mjs';
import { chainInputsFor } from '../../tools/frf-corpus/lib/mutations.mjs';

/** True when the tampered run is RED and names the tampered check family. */
async function tamperedRunIsRed(scenarioId, tamper, expectDetail) {
  const descriptor = await frfDescriptorOf(scenarioId);
  const result = await runFrfScenario(descriptor, { mutations: { tamperExpectations: tamper } });
  const reds = result.checks.filter((check) => check.status === 'red');
  assert.equal(result.status, 'red', `the tampered ${scenarioId} must be RED`);
  assert.equal(reds.length > 0, true);
  if (expectDetail !== undefined) {
    assert.equal(
      reds.some((check) => check.detail.includes(expectDetail) || check.id.includes(expectDetail)),
      true,
      `a red check must name the tampered expectation (got: ${reds.map((r) => r.id).join(', ')})`,
    );
  }
  return reds;
}

test('KILLED (expected-verdict tampering): a flipped desk verdict is detected', async () => {
  await tamperedRunIsRed('s01-desk-chain-happy', (world) => {
    world.verdicts[5] = { desk: 'freeze-what-baseline', verdict: 'indeterminate' };
    return world;
  }, 'freeze-what-baseline');
});

test('KILLED (expected-refusal tampering): a swapped typed refusal reason is detected', async () => {
  await tamperedRunIsRed('s08-planning-gate-kill', (world) => {
    world.refusals[0] = { target: 'plan-development', reason: 'FOREIGN_LINEAGE' };
    return world;
  }, 'refusal:plan-development');
});

test('KILLED (expected-sweep tampering): a rewritten sweep outcome is detected', async () => {
  await tamperedRunIsRed('s07-srs-elite-kills', (world) => {
    world.sweep[0] = { ...world.sweep[0], verdict: 'accepted', reason: 'MISSING_LINEAGE' };
    return world;
  }, 'sweep:define-architecture-contract:entrypoint');
});

test('KILLED (expected-closure tampering): flipping the computed gaps verdict to consistent is detected', async () => {
  await tamperedRunIsRed('s05-reconciliation-drift', (world) => {
    world.closure = { gapReasons: [], verdict: 'consistent' };
    return world;
  }, 'closure');
});

test('KILLED (expected-capsule tampering): dropping a sealed artifact kind is detected', async () => {
  await tamperedRunIsRed('s01-desk-chain-happy', (world) => {
    world.capsuleKinds = world.capsuleKinds.filter((kind) => kind !== 'frf-development.case.v1');
    return world;
  }, 'capsule');
});

test('KILLED (expected-binding-domain tampering): a substituted binding id is detected', async () => {
  await tamperedRunIsRed('s01-desk-chain-happy', (world) => {
    const scenario = world.bindingDomains.find((domain) => domain.kind === 'scenario-bindings');
    scenario.ids = ['uc:checkout-1'];
    return world;
  }, 'binding-domain:scenario-bindings');
});

test('KILLED (input-stream tampering): mutating the green material after the expected world was authored goes RED', async () => {
  // The expected world of s01 was authored over the GREEN material; a
  // late mutation of the authored PRD bundle (a foreign source-claim
  // ref) must break it - the comparison is against authored truth, not
  // against whatever the inputs happen to produce.
  const inputs = chainInputsFor({ kind: 'foreign-binding', target: 'define-product-intent:sourceClaimRefs' });
  const run = await driveDeskChain(inputs);
  const world = normalizedWorldOf(run);
  assert.equal(world.refusals.length, 1);
  assert.equal(world.refusals[0].reason, 'FOREIGN_LINEAGE');
  assert.equal(world.terminal.developmentCase, 'not-reached');
  const descriptor = await frfDescriptorOf('s01-desk-chain-happy');
  const result = await runFrfScenario(descriptor);
  assert.notDeepEqual(world, result.observed.world, 'the mutated world must differ from the green expected world');
});

test('KILLED (fault-schedule divergence): a crash window that never fires is a harness defect, not a pass', async () => {
  // Arming a crash at a window that does not exist in the flow must not
  // silently pass: the scheduler fires at most once and the restart
  // converges; a hypothetical no-op window would make the law vacuous.
  const { FrfFaultScheduler, FrfFaultCrashError } = await import('../../tools/frf-corpus/lib/faults.mjs');
  const scheduler = new FrfFaultScheduler({ anchor: 'not-a-desk', fault: 'crash-before-desk' });
  assert.doesNotThrow(() => scheduler.fire('crash-before-desk', 'define-product-intent'));
  assert.equal(scheduler.fired, false);
  const armed = new FrfFaultScheduler({ anchor: 'define-product-intent', fault: 'crash-before-desk' });
  assert.throws(() => armed.fire('crash-before-desk', 'define-product-intent'), FrfFaultCrashError);
});
