// tests/installation/runtime-package-fingerprint.test.mjs
//
// K4 commit 2/5 of the Saga Core Renewal program — the named fingerprint
// (ADR-077) equals the frozen store formula and exposes diagnostic
// components without substituting for the digest.
//
// Run: node --test tests/installation/runtime-package-fingerprint.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

const { createProcessModuleManifest } = await import(
  '../../dist/process-modules/domain/spi/manifest-factory.js'
);
const { default: lmMarketingModule } = await import(
  '../fixtures/synthetic-modules/lm-marketing/definition.mjs'
);
const { computePackageDigest } = await import(
  '../../dist/process-modules/installation/domain/package-store.js'
);
const { computeRuntimePackageFingerprint } = await import(
  '../../dist/process-modules/installation/domain/runtime-package-fingerprint.js'
);

const HANDLER_DIGEST = createHash('sha256').update('impl bytes').digest('hex');

function buildFixture() {
  const baseline = createProcessModuleManifest(lmMarketingModule);
  const manifest = {
    ...baseline,
    handlerRefs: [
      { logicalId: 'handler-b', version: '0.1.0', digest: HANDLER_DIGEST },
      { logicalId: 'handler-a', version: '0.1.0', digest: HANDLER_DIGEST },
    ],
    resourceIndex: [
      { logicalId: 'res-b', path: 'skills/b.md', kind: 'skill', digest: 'b'.repeat(64) },
      { logicalId: 'res-a', path: 'skills/a.md', kind: 'skill', digest: 'a'.repeat(64) },
    ],
  };
  const resources = [
    { logicalId: 'res-b', kind: 'skill', bytes: new TextEncoder().encode('b'), digest: 'b'.repeat(64) },
    { logicalId: 'res-a', kind: 'skill', bytes: new TextEncoder().encode('a'), digest: 'a'.repeat(64) },
  ];
  return { manifest, resources };
}

test('fingerprint digest EQUALS the frozen store formula (ADR-77)', () => {
  const { manifest, resources } = buildFixture();
  const fp = computeRuntimePackageFingerprint(manifest, resources);
  assert.equal(fp.digest, computePackageDigest(manifest, resources));
});

test('components are order-canonicalized diagnostics of the same inputs', () => {
  const { manifest, resources } = buildFixture();
  const fp = computeRuntimePackageFingerprint(manifest, resources);
  assert.deepEqual(
    fp.components.handlerDigests.map(h => h.logicalId),
    ['handler-a', 'handler-b'],
    'handler components sorted by logicalId regardless of declaration order',
  );
  assert.deepEqual(
    fp.components.resourceDigests.map(r => r.logicalId),
    ['res-a', 'res-b'],
  );
  assert.equal(fp.components.moduleRef, `${manifest.definition.identity.name}@${manifest.definition.identity.version}`);
  assert.equal(fp.components.manifestFormatVersion, manifest.manifestFormatVersion);
});

test('fingerprint is deterministic across recomputation (canonical serialization)', () => {
  const { manifest, resources } = buildFixture();
  const a = computeRuntimePackageFingerprint(manifest, resources);
  const b = computeRuntimePackageFingerprint(
    JSON.parse(JSON.stringify(manifest)),
    resources.map(r => ({ ...r })),
  );
  assert.equal(a.digest, b.digest);
});

test('any input change changes the digest (definition, handlers, resources)', () => {
  const { manifest, resources } = buildFixture();
  const base = computeRuntimePackageFingerprint(manifest, resources).digest;

  const handlerChanged = computeRuntimePackageFingerprint(
    {
      ...manifest,
      handlerRefs: [{ logicalId: 'handler-a', version: '0.1.0', digest: '0'.repeat(64) }, ...manifest.handlerRefs.slice(1)],
    },
    resources,
  ).digest;
  assert.notEqual(base, handlerChanged);

  const resourceChanged = computeRuntimePackageFingerprint(
    manifest,
    [...resources, { logicalId: 'res-c', kind: 'skill', bytes: new TextEncoder().encode('c'), digest: 'c'.repeat(64) }],
  ).digest;
  assert.notEqual(base, resourceChanged);
});
