/**
 * run-corpus.test.mjs - the WP-13D driver suite: the smoke subset
 * (5 projects, one per major family) runs GREEN end to end through the
 * public-command drivers, and the load-bearing check details are asserted
 * (not just the boolean).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { descriptorOf, SMOKE_PROJECT_IDS } from './registry.mjs';
import { runProject } from '../../tools/project-corpus/lib/execute.mjs';

const checkOf = (result, id) => result.checks.find((check) => check.id === id);

for (const projectId of SMOKE_PROJECT_IDS) {
  test(`smoke: ${projectId} runs green through public commands only`, async () => {
    const result = await runProject(await descriptorOf(projectId));
    const red = result.checks.filter((check) => check.status === 'red');
    assert.equal(result.status, 'green', `${projectId} RED checks:\n${red.map((check) => `${check.id}: ${check.detail}`).join('\n')}`);
  });
}

test('smoke detail: the served happy path really built, served and smoked the product', async () => {
  const result = await runProject(await descriptorOf('p01-served-happy'));
  const product = checkOf(result, 'product-verified');
  assert.equal(product.status, 'green');
  assert.match(product.detail, /build \+ loopback \+ browser-smoke green/);
  assert.match(product.detail, /[0-9a-f]{64}/, 'the deterministic build digest is reported');
  const ingress = checkOf(result, 'capsule-ingress');
  assert.match(ingress.detail, /WP-08 public ingress/);
});

test('smoke detail: the honest refusal terminal is the typed stale-revision family', async () => {
  const result = await runProject(await descriptorOf('p14-honest-refusal'));
  assert.equal(checkOf(result, 'invariant:typed-refusal-family').status, 'green');
  assert.match(checkOf(result, 'invariant:typed-refusal-family').detail, /STALE_EXPECTED_REVISION at refuse-author-1-contribution/);
  assert.match(checkOf(result, 'reference-vs-observed').detail, /typed-refusal terminal/);
});

test('smoke detail: the chain topology settles every workplace and the run proof', async () => {
  const result = await runProject(await descriptorOf('p09-chain-topology'));
  assert.match(checkOf(result, 'invariant:workplace-terminal-success').detail, /3\/3 workplaces terminal success/);
  const heads = checkOf(result, 'declared-heads');
  assert.equal(heads.status, 'green');
});

test('smoke detail: the human wait is discharged exactly by the scripted operator', async () => {
  const result = await runProject(await descriptorOf('p16-human-wait-operator'));
  const operator = checkOf(result, 'invariant:operator-discharges-human-wait');
  assert.equal(operator.status, 'green');
  assert.match(operator.detail, /2\/2 discharged by operator commands/);
});

test('smoke detail: projection wipe rehydrates and the stale write is fenced', async () => {
  const result = await runProject(await descriptorOf('p19-projection-faults'));
  assert.equal(checkOf(result, 'projection-wipe-rehydrates').status, 'green');
  assert.equal(checkOf(result, 'stale-write-refused').status, 'green');
  assert.match(checkOf(result, 'stale-write-refused').detail, /CAS fence refused/);
});
