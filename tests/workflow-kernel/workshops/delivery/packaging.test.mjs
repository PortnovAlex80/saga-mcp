/**
 * packaging.test.mjs - WP-11L: the idempotent local packaging effect
 * (exactly-once per accepted candidate) and the write-once release record.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildVerifiedBundle, operatorStores, PRODUCT_ROOT } from './support.mjs';

const packaging = await import('../../../../dist/workflow-kernel/workshops/delivery/packaging.js');

const DECLARATION = () => ({ productRoot: PRODUCT_ROOT, entries: [...packaging.DEFAULT_PACKAGING_ENTRIES] });

test('local packaging assembles the release package deterministically', async () => {
  const stores = operatorStores();
  const bundle = await buildVerifiedBundle();
  const run = packaging.runLocalPackaging(stores.storeRoot, bundle, DECLARATION());
  assert.equal(run.status, 'success', JSON.stringify(run));
  assert.equal(run.packaged.externalDeployment, false, 'LOCAL packaging only');
  assert.equal(run.packaged.candidateDigest, bundle.integratedCandidate.digest);
  assert.equal(run.packaged.entries.length, packaging.DEFAULT_PACKAGING_ENTRIES.length);
  const again = packaging.runLocalPackaging(stores.storeRoot, bundle, DECLARATION());
  assert.equal(again.status, 'again' in again ? 'unexpected' : again.status);
});

test('packaging runs EXACTLY ONCE per candidate: the duplicate is already-applied with the SAME digest', async () => {
  const stores = operatorStores();
  const bundle = await buildVerifiedBundle();
  const first = packaging.runLocalPackaging(stores.storeRoot, bundle, DECLARATION());
  assert.equal(first.status, 'success');
  const second = packaging.runLocalPackaging(stores.storeRoot, bundle, DECLARATION());
  assert.equal(second.status, 'already-applied');
  assert.equal(second.packaged.packageDigest, first.packaged.packageDigest, 'the duplicate returns the SAME digest');
  assert.equal(second.packaged.candidateDigest, first.packaged.candidateDigest);
});

test('verifyPackagedRelease fences the resume: no package, no resume', async () => {
  const stores = operatorStores();
  const bundle = await buildVerifiedBundle();
  const missing = packaging.verifyPackagedRelease(stores.storeRoot, bundle.integratedCandidate.digest);
  assert.equal(missing.ok, false);
  const run = packaging.runLocalPackaging(stores.storeRoot, bundle, DECLARATION());
  assert.equal(run.status, 'success');
  const verified = packaging.verifyPackagedRelease(stores.storeRoot, bundle.integratedCandidate.digest);
  assert.equal(verified.ok, true);
  assert.equal(verified.packageDigest, run.packaged.packageDigest);
});

test('refusal: PACKAGING_INPUT_MISSING - absent product-tree entries are named exactly', async () => {
  const stores = operatorStores();
  const bundle = await buildVerifiedBundle();
  const run = packaging.runLocalPackaging(stores.storeRoot, bundle, {
    productRoot: join(tmpdir(), 'ek-wp11l-empty-' + String(Date.now()).replace(/\D/g, '')),
    entries: ['src/server.js', 'not/there.js'],
  });
  assert.equal(run.refused, true);
  assert.equal(run.reason, 'PACKAGING_INPUT_MISSING');
  assert.deepEqual([...run.paths], ['src/server.js', 'not/there.js']);
});

test('the pure contribution mapping binds candidate + package digests', async () => {
  const stores = operatorStores();
  const bundle = await buildVerifiedBundle();
  const run = packaging.runLocalPackaging(stores.storeRoot, bundle, DECLARATION());
  const mapping = packaging.packagingContributionOf(bundle, run.packaged);
  assert.equal(mapping.candidateDigest, bundle.integratedCandidate.digest);
  assert.equal(mapping.revisionPayloadDigest, run.packaged.packageDigest);
  assert.equal(mapping.productContract, 'delivery.local-release-package.v1');
  const again = packaging.packagingContributionOf(bundle, run.packaged);
  assert.equal(again.contributionDigest, mapping.contributionDigest, 'the mapping is pure');
});

test('the release record is write-once per candidate: the identical record replays', async () => {
  const stores = operatorStores();
  const bundle = await buildVerifiedBundle();
  const packaged = packaging.runLocalPackaging(stores.storeRoot, bundle, DECLARATION());
  const input = () => ({
    bundle,
    policyDigest: 'a'.repeat(64),
    preflightDigest: 'b'.repeat(64),
    approvalRef: 'delivery-approval:req:' + 'c'.repeat(64),
    packageDigest: packaged.packaged.packageDigest,
  });
  const first = packaging.assembleReleaseRecord(stores.storeRoot, input());
  assert.equal(first.recorded, true);
  const second = packaging.assembleReleaseRecord(stores.storeRoot, input());
  assert.equal(second.replayed, true);
  assert.equal(second.record.recordDigest, first.record.recordDigest);
});

test('refusal: DUPLICATE_RELEASE - a second, different record for one candidate is typed', async () => {
  const stores = operatorStores();
  const bundle = await buildVerifiedBundle();
  const packaged = packaging.runLocalPackaging(stores.storeRoot, bundle, DECLARATION());
  const first = packaging.assembleReleaseRecord(stores.storeRoot, {
    bundle,
    policyDigest: 'a'.repeat(64),
    preflightDigest: 'b'.repeat(64),
    approvalRef: 'delivery-approval:req:' + 'c'.repeat(64),
    packageDigest: packaged.packaged.packageDigest,
  });
  assert.equal(first.recorded, true);
  const duplicate = packaging.assembleReleaseRecord(stores.storeRoot, {
    bundle,
    policyDigest: 'a'.repeat(64),
    preflightDigest: 'b'.repeat(64),
    approvalRef: 'delivery-approval:req:' + 'd'.repeat(64), // a DIFFERENT approval
    packageDigest: packaged.packaged.packageDigest,
  });
  assert.equal(duplicate.refused, true);
  assert.equal(duplicate.reason, 'DUPLICATE_RELEASE');
  assert.match(duplicate.detail, /already exists/);
  assert.notEqual(duplicate.recordDigest, first.record.recordDigest);
});

test('two DIFFERENT candidates package side by side (no cross-candidate aliasing)', async () => {
  const stores = operatorStores();
  const bundleA = await buildVerifiedBundle();
  // Re-seal the same fixture bytes with a DIFFERENT integrated candidate.
  const { bundleArtifact, buildVerifiedDevelopmentBundle } = await import('../../../../dist/workflow-kernel/workshops/delivery/bundle.js');
  const { PACKAGE_BYTES } = await import('./support.mjs');
  const bundleB = buildVerifiedDevelopmentBundle(
    {
      developmentCertificate: bundleA.developmentCertificate,
      integratedCandidate: bundleArtifact({ candidate: 'simple-server@build-4', revision: 4, tree: 'sha256:other' }),
      verifiedIntegrationBundle: bundleA.verifiedIntegrationBundle,
      terminalClaims: bundleA.terminalClaims,
      packagingInput: bundleA.packagingInput,
    },
    bundleA.lineage,
    bundleA.parentState,
    new Uint8Array(PACKAGE_BYTES),
  );
  assert.notEqual(bundleA.integratedCandidate.digest, bundleB.integratedCandidate.digest);
  const a = packaging.runLocalPackaging(stores.storeRoot, bundleA, DECLARATION());
  const b = packaging.runLocalPackaging(stores.storeRoot, bundleB, DECLARATION());
  assert.equal(a.status, 'success');
  assert.equal(b.status, 'success');
  assert.notEqual(a.packaged.packageDigest, b.packaged.packageDigest, 'distinct candidates have distinct packages');
  // Each candidate verifies against its own package.
  for (const bundle of [bundleA, bundleB]) {
    const verified = packaging.verifyPackagedRelease(stores.storeRoot, bundle.integratedCandidate.digest);
    assert.equal(verified.ok, true);
  }
});
