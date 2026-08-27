/**
 * seam.test.mjs - the FRF-WP03 VALIDATOR SEAM, pinned from both sides:
 *
 *   SEAM = the WHAT-freeze cell imports the WP03 typed validator and the
 *   canonical digest helpers from
 *   docs/refactoring/formalization-frf/contracts/validators/ (what-baseline.mjs
 *   + common.mjs) by exact relative path; the cell's frozen output MUST
 *   seal via validateWhatBaseline against the universe derived from the
 *   same carried surfaces. At FRF-WP11 the seam flips to the compiled
 *   in-package validator and the docs/ import dies; this test pins:
 *     S1 contract identity equality (cell CONTRACT_KIND == validator's);
 *     S2 canonical digest parity: the WP03 helpers are byte-identical to
 *        the kernel rule (dist/workflow-kernel/domain/digest.js);
 *     S3 the cell reproduces the committed WP03 green fixture digests;
 *     S4 the cell's refusal vocabulary is the closed seven-code set;
 *     S5 the WP03 red what-baseline seeds stay killed through the cell's
 *        presented-baseline verification path;
 *     S6 the handoff/obligation vocabularies the settlement resolves
 *        against are exactly the WP03 frozen lists.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acceptedIdSetsFixture,
  acceptedSurfacesOf,
  cellModule,
  clone,
  distModule,
  freezeAccepted,
  greenBaselineFixture,
  importAbs,
} from './support.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..', '..', '..', '..');
const WP03_VALIDATORS = path.join(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'contracts', 'validators');
const WP03_SNAPSHOTS = path.join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'validators');
const wp03ValidatorModule = () => importAbs(path.join(WP03_VALIDATORS, 'what-baseline.mjs'));

test('S1: the cell\'s contract identity IS the WP03 validator\'s (one identity, no fork)', async () => {
  const shared = await cellModule('shared');
  const protocol = await cellModule('protocol');
  const wp03 = await wp03ValidatorModule();
  assert.equal(shared.CONTRACT_KIND, wp03.CONTRACT_KIND);
  assert.equal(shared.WP03_SEAM.contractId, wp03.CONTRACT_KIND);
  assert.equal(protocol.WHAT_BASELINE_PRODUCT_KIND, wp03.CONTRACT_KIND);
  // FRF-WP11: the seam path string resolves to the CANONICAL in-package
  // module (the docs-tree copy is a frozen byte-equal snapshot).
  const seamTarget = path.resolve(REPO_ROOT, 'src', 'workflow-kernel', 'workshops', 'formalization', 'cells', 'what-freeze', shared.WP03_SEAM.validatorPath);
  assert.equal(path.resolve(seamTarget), path.join(WP03_VALIDATORS, 'what-baseline.mjs'));
  // The frozen docs snapshot stays byte-equal to the canonical contract.
  for (const name of ['what-baseline.mjs', 'common.mjs']) {
    assert.equal(
      (await import('node:fs')).readFileSync(path.join(WP03_SNAPSHOTS, name)).equals((await import('node:fs')).readFileSync(path.join(WP03_VALIDATORS, name))),
      true,
      `${name}: the docs snapshot drifted from the canonical in-package contract`,
    );
  }
});

test('S2: canonical digest parity - the WP03 helpers equal the kernel digest rule byte-for-byte', async () => {
  const shared = await cellModule('shared');
  const kernel = await distModule('workflow-kernel/domain/digest');
  const samples = [
    { b: 1, a: [3, { z: 'x', y: null }], c: 'text' },
    greenBaselineFixture(),
    acceptedIdSetsFixture(),
  ];
  for (const sample of samples) {
    assert.equal(shared.sha256OfCanonical(sample), kernel.sha256OfCanonical(sample));
    assert.equal(shared.canonicalJson(sample), kernel.canonicalJson(sample));
  }
  assert.equal(shared.digestExcluding(greenBaselineFixture(), ['wholeWhatDigest']), kernel.digestExcluding(greenBaselineFixture(), ['wholeWhatDigest']));
});

test('S3: the cell reproduces the committed WP03 green fixture (independent evidence, byte-for-byte)', async () => {
  const green = greenBaselineFixture();
  const frozen = await freezeAccepted();
  assert.equal(frozen.baseline.wholeWhatDigest, green.wholeWhatDigest);
  assert.equal(frozen.artifact.digest, (await cellModule('shared')).sha256OfCanonical(green));
});

test('S4: the cell uses only the closed seven-code refusal vocabulary', async () => {
  const shared = await cellModule('shared');
  assert.deepEqual([...shared.PRODUCT_REFUSAL_REASONS].sort(), [
    'COVERAGE_GAP',
    'DRIFT_DETECTED',
    'FOREIGN_LINEAGE',
    'MALFORMED_PRODUCT',
    'MISSING_LINEAGE',
    'SCOPE_VIOLATION',
    'STALE_LINEAGE',
  ]);
  // An invented reason cannot even be constructed.
  assert.throws(() => shared.refused('NOT_A_REASON', 'x'), /closed refusal vocabulary/);
});

test('S5: the WP03 red what-baseline seeds stay killed through the cell\'s presented-baseline path', async () => {
  const ingestion = await cellModule('ingestion');
  const surfaces = acceptedSurfacesOf();
  const seedDir = path.join(REPO_ROOT, 'docs', 'refactoring', 'formalization-frf', 'contracts', 'fixtures', 'red');
  // The WP03 baseline red seeds are numbered NN-base-* (32..49).
  const baselineSeeds = readdirSync(seedDir).filter((name) => name.includes('base-'));
  assert.ok(baselineSeeds.length >= 17, `expected the WP03 baseline red seeds (got ${baselineSeeds.length})`);
  let killed = 0;
  for (const seedName of baselineSeeds) {
    const seed = JSON.parse(readFileSync(path.join(seedDir, seedName), 'utf8'));
    // Every baseline seed is a payload (schemaVersion frf-contracts.what-baseline.v1).
    assert.equal(seed.schemaVersion, 'frf-contracts.what-baseline.v1', seedName);
    const result = ingestion.verifyPresentedBaseline(seed, surfaces);
    assert.equal(result.ok, false, `seed ${seedName} must stay killed`);
    assert.ok(shared0(result.reason), `seed ${seedName} refusal reason ${String(result.reason)} must be in the closed vocabulary`);
    killed += 1;
  }
  assert.ok(killed >= 17, `expected the WP03 baseline red seeds to run through the cell path (got ${killed})`);
});

function shared0(reason) {
  return ['COVERAGE_GAP', 'DRIFT_DETECTED', 'FOREIGN_LINEAGE', 'MALFORMED_PRODUCT', 'MISSING_LINEAGE', 'SCOPE_VIOLATION', 'STALE_LINEAGE'].includes(reason);
}

test('S6: the settlement resolves against exactly the WP03 frozen handoff/obligation vocabularies', async () => {
  const shared = await cellModule('shared');
  const wp03 = await wp03ValidatorModule();
  assert.deepEqual([...shared.HANDOFF_BINDING_KINDS].sort(), [...wp03.HANDOFF_BINDING_KINDS].sort());
  assert.deepEqual([...shared.WORK_ITEM_OBLIGATION_KINDS].sort(), [...wp03.WORK_ITEM_OBLIGATION_KINDS].sort());
  assert.equal(shared.HANDOFF_BINDING_KINDS.length, 12);
  assert.equal(shared.WORK_ITEM_OBLIGATION_KINDS.length, 5);
});

test('the green fixture seals via the cell\'s own re-exported WP03 validator (the seam is live, not copied)', async () => {
  const shared = await cellModule('shared');
  const green = greenBaselineFixture();
  const universe = acceptedIdSetsFixture();
  const validation = shared.validateWhatBaseline(green, universe);
  assert.equal(validation.ok, true);
  // And a drifted whole digest does not.
  const drifted = clone(green);
  drifted.wholeWhatDigest = '0'.repeat(64);
  const refusal = shared.validateWhatBaseline(drifted, universe);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'DRIFT_DETECTED');
});
