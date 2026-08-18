// tests/architecture/handler-digest-runtime-consistency.test.mjs
//
// K3 commit 4/5 of the Saga Core Renewal program.
//
// Runtime-consistency theorem: the HandlerRef digest each workshop manifest
// pins EQUALS the sha256 of the exact compiled installation module the
// composition root imports and executes. The manifests compute this at module
// load via the shared digester; this suite independently re-hashes the dist
// bytes and compares, so any future drift (a cached digest, a resolution
// change, a stale build assumption) fails the architecture suite.
//
// Clean-build rule corollary: because the manifest computes the digest from
// the dist file at load time, a clean build always carries the digest of the
// bytes it will actually execute — pinned here rather than assumed.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const WORKSHOPS = [
  ['discovery', '../../../../modules/discovery/application/discovery-installation.js'],
  ['formalization', '../../../../modules/formalization/application/formalization-production-cell-installation.js'],
  ['development', '../../../../modules/development/application/development-installation.js'],
  ['delivery', '../../../../modules/delivery/application/delivery-installation.js'],
];

for (const [workshop, relSpecifier] of WORKSHOPS) {
  test(`handler digests in the ${workshop} manifest match the compiled implementation bytes`, async () => {
    const manifestModule = await import(
      `../../dist/process-modules/modules/${workshop}/package/manifest.js`
    );
    const manifest = manifestModule.default
      ?? Object.values(manifestModule).find(v => v && Array.isArray(v.handlerRefs));
    assert.ok(manifest?.handlerRefs?.length, `${workshop} manifest exposes handlerRefs`);

    const implPath = resolve(
      repoRoot, 'dist', 'process-modules', 'modules', workshop, 'package', relSpecifier,
    );
    const distDigest = createHash('sha256').update(readFileSync(implPath)).digest('hex');

    const unique = new Set(manifest.handlerRefs.map(r => r.digest));
    assert.equal(unique.size, 1, `${workshop} pins one installation module digest`);
    const pinned = [...unique][0];
    assert.equal(
      pinned,
      distDigest,
      `${workshop}: pinned handler digest ${pinned.slice(0, 12)}… != sha256(dist bytes) ${distDigest.slice(0, 12)}… (${implPath})`,
    );
    // K3 rejection theorem holds on the real manifests: no placeholders.
    assert.notEqual(pinned, 'pending@wave-2');
  });
}
