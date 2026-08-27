/**
 * corpus.test.mjs - the FRF scenario corpus execution suite (FRF-WP10):
 * every descriptor GREEN through the runner core, the smoke subset
 * GREEN, the crash law over every named window, and the determinism of
 * the capsule digests (two independent drives seal identical artifacts).
 *
 * Hermetic: no docker, no network, no model, no kernel database - the
 * cells are pure exported functions; the evidence ledger lives in
 * process memory only.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { frfCorpus, frfDescriptorOf, SMOKE_SCENARIO_IDS } from '../../tools/frf-corpus/lib/registry.mjs';
import { runFrfScenario } from '../../tools/frf-corpus/lib/execute.mjs';
import { capsuleReceiptOf, driveDeskChain, greenChainInputs, normalizedWorldOf } from '../../tools/frf-corpus/lib/chain.mjs';

test('every FRF scenario is GREEN through the runner core', async () => {
  const corpus = await frfCorpus();
  for (const descriptor of corpus) {
    const result = await runFrfScenario(structuredClone(descriptor));
    assert.equal(result.status, 'green', `${descriptor.frf.scenarioId}:\n${result.checks.filter((c) => c.status === 'red').map((c) => `  [${c.id}] ${c.detail}`).join('\n')}`);
  }
});

test('the smoke subset is GREEN', async () => {
  for (const id of SMOKE_SCENARIO_IDS) {
    const result = await runFrfScenario(await frfDescriptorOf(id));
    assert.equal(result.status, 'green', `${id}:\n${JSON.stringify(result.checks.filter((c) => c.status === 'red'))}`);
  }
});

test('the happy path seals the full ten-artifact capsule with deterministic digests', async () => {
  const first = await driveDeskChain(greenChainInputs());
  const second = await driveDeskChain(greenChainInputs());
  assert.equal(first.state.plan !== undefined, true, 'the chain reached the plan');
  const capsuleA = capsuleReceiptOf(first);
  const capsuleB = capsuleReceiptOf(second);
  assert.equal(capsuleA.artifacts.length, 10);
  assert.deepEqual(capsuleA, capsuleB);
  for (const artifact of capsuleA.artifacts) assert.match(artifact.digest, /^[0-9a-f]{64}$/);
  // The what-baseline artifact digest equals the WP03 frozen fixture
  // digest (byte parity: the cell REPRODUCES the frozen authority).
  const worldA = normalizedWorldOf(first);
  const worldB = normalizedWorldOf(second);
  assert.deepEqual(worldA, worldB);
});

test('the crash law holds over every named window (identical normalized world)', async () => {
  const result = await runFrfScenario(await frfDescriptorOf('s11-crash-restart-matrix'));
  assert.equal(result.status, 'green', JSON.stringify(result.checks.filter((c) => c.status === 'red')));
  const law = result.observed.world.crashLaw;
  assert.equal(law.identical, true);
  assert.equal(law.windows >= 24, true, `the matrix covers every desk seam (observed ${law.windows} windows)`);
  assert.deepEqual(law.diverged, []);
});

test('the D5 wait is discharged ONLY through the public command path', async () => {
  const persistence = await import('../../tools/frf-corpus/lib/material.mjs').then((m) => m.wireCells()).then((cells) => cells.persistence);
  const wait = persistence.indeterminateWaitOf('no accepted dispositions surface was carried');
  // An automatic redrive (no receipt at all) is refused typed.
  const auto = persistence.dischargeIndeterminateWait(wait, undefined);
  assert.equal(auto.ok, false);
  assert.equal(auto.reason, 'MALFORMED_PRODUCT');
  // A wake command outside the frozen vocabulary is refused.
  const foreign = persistence.dischargeIndeterminateWait(wait, { command: 'factoryRun.start', evidenceRef: 'evidence:x' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'MALFORMED_PRODUCT');
  // A lawful command without the obligation-completion evidence ref is
  // refused MISSING_LINEAGE (the receipt must name the exact surface).
  const evidenceless = persistence.dischargeIndeterminateWait(wait, { command: 'workplace.resolveHumanResponse' });
  assert.equal(evidenceless.ok, false);
  assert.equal(evidenceless.reason, 'MISSING_LINEAGE');
  // The public command path with the evidence ref discharges.
  const lawful = persistence.dischargeIndeterminateWait(wait, { command: 'workplace.resolveHumanResponse', evidenceRef: 'evidence:HumanResponse#accepted-dispositions-surface' });
  assert.equal(lawful.ok, true);
  assert.equal(lawful.discharged, true);
});

test('the corpus covers every required scenario dimension of the FRF flow', async () => {
  const corpus = await frfCorpus();
  const dimensions = new Set(corpus.map((descriptor) => descriptor.frf.dimension));
  for (const dimension of [
    'desk-chain-happy',
    'binding-mutation-sweep',
    'reconciliation-drift',
    'what-freeze-authority-mutation',
    'srs-elite-kill',
    'planning-gate-kill',
    'replan-identity-cycle',
    'human-wait-disposition',
    'crash-restart-matrix',
  ]) {
    assert.equal(dimensions.has(dimension), true, `dimension ${dimension} must be covered`);
  }
});
