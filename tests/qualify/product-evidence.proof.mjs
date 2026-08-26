/**
 * tests/qualify/product-evidence.proof.mjs - the ACTUAL PRODUCT OUTPUT proof
 * of the EK-11 qualification (WP-15): every distinct product family used by
 * the plan's twenty kinds verifies green in a FRESH staged repository under
 * its full evidence profile (build, determinism where declared, unit tests,
 * the kind smoke, and the local Delivery/package effect receipt).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const moduleOf = (relative) => import(pathToFileURL(join(REPO_ROOT, relative)).href);

const { loadCorpus } = await moduleOf('tests/project-corpus/registry.mjs');
const productEvidence = await moduleOf('tools/qualify/lib/product-evidence.mjs');

const corpus = await loadCorpus();

/** Distinct (fixture, profile) pairs actually used by the twenty kinds. */
const pairs = new Map();
for (const descriptor of corpus) {
  const key = `${descriptor.ek11.fixture}|${descriptor.ek11.profile.join('+')}`;
  if (!pairs.has(key)) pairs.set(key, descriptor.ek11);
}

/** Served products need a moment for their smoke (real sockets + restarts). */
for (const [key, ek11] of pairs) {
  test(`product family green: ${ek11.planId} ${ek11.kind} (${key})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), `ek-qual-product-${ek11.planId}-`));
    try {
      const staged = productEvidence.stageProductRepo(ek11.fixture, join(dir, 'product-repo'));
      const result = await productEvidence.runProductEvidence(ek11.kind, ek11.profile, staged.repo);
      assert.ok(result.ok, `product evidence failed: ${String(result.failure)}\nsteps: ${JSON.stringify(result.steps.map((step) => ({ label: step.label, code: step.code, stderr: step.stderr.slice(0, 300) })), null, 2)}`);
      assert.ok(result.buildDigests.length >= 1 && /^[0-9a-f]{64}$/.test(result.buildDigests[0]), 'a real build digest was emitted');
      assert.ok(/^[0-9a-f]{64}$/.test(result.packageDigest), 'a local delivery/package receipt digest was emitted');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}

test('the driver refuses an unknown fixture reference (typed)', () => {
  assert.throws(() => productEvidence.fixtureRootOf('qual:no-such-product'), /QUALIFY_FIXTURE_UNKNOWN/);
  assert.throws(() => productEvidence.fixtureRootOf('weird:shape'), /QUALIFY_FIXTURE_UNKNOWN/);
});

test('every qual fixture family is exercised by at least one plan kind (no dead fixtures)', async () => {
  const available = productEvidence.availableQualFixtures();
  const used = new Set([...pairs.keys()].map((key) => key.split('|')[0].replace('qual:', '')));
  for (const fixture of available) {
    assert.ok(used.has(fixture), `qual fixture "${fixture}" is not used by any plan kind`);
  }
});
