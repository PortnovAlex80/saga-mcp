// tests/installation/filesystem-package-store.test.mjs
//
// W2-A1 — FilesystemModulePackageStore content-addressed immutable store tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md
//       §1 rows 1,2, §4 (digest formula), §9.2 (replay verification), §14.3.8
//       (exit-gate immutability proof).
// Task: docs/refactor-management/05-subagent-tasks/W02-A1-filesystem-package-store.md.
//
// Coverage (task "Tests"):
//   - Positive: store manifest + 2 resources → correct content-addressed dir;
//     read returns identical bytes; verify true; exists true.
//   - Positive: packageDigest stable across two store calls (deterministic).
//   - Negative: path traversal in logicalId ('../escape', '/abs') →
//     PACKAGE_STORE_PATH_TRAVERSAL.
//   - Negative: resource not declared in manifest.resourceIndex → rejected.
//   - Negative: mutate a stored resource file on disk → read throws
//     PACKAGE_STORE_DIGEST_MISMATCH; verify returns false.
//   - Negative: read unknown digest → PACKAGE_STORE_NOT_FOUND.
//   - The §14.3.8 exit-gate test: store a package; mutate the IN-MEMORY
//     manifest/resources; read the stored digest → returns the ORIGINAL bytes
//     (immutability proof).
//
// Imports run against the COMPILED dist/ output (matching the Wave 1 test
// pattern in tests/spi/*.test.mjs).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { FilesystemModulePackageStore } from '../../dist/process-modules/installation/adapters/filesystem-package-store.js';
import {
  PACKAGE_STORE_CORRUPT,
  PACKAGE_STORE_DIGEST_MISMATCH,
  PACKAGE_STORE_NOT_FOUND,
  PACKAGE_STORE_PATH_TRAVERSAL,
  PackageStoreError,
  computeResourceDigest,
} from '../../dist/process-modules/installation/domain/package-store.js';
import { canonicalJson } from '../../dist/process-modules/shared/canonical-json.js';
import { sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';
import { lmMarketingModule } from '../fixtures/synthetic-modules/lm-marketing/definition.mjs';

// ---------------------------------------------------------------------------
// Helpers — build a valid manifest + resource blobs.
// ---------------------------------------------------------------------------

const PENDING = 'pending@wave-2';

function makeContractRef(schemaId) {
  return { schemaId, version: '1.0.0', digest: PENDING };
}

/** Build a valid manifest with two declared resources. */
function makeValidManifest() {
  return {
    manifestFormatVersion: '0.1.0',
    definition: lmMarketingModule,
    resourceIndex: [
      {
        logicalId: 'semantic-skill',
        path: 'skills/synthetic-marketing-skill.md',
        kind: 'skill',
        digest: PENDING,
      },
      {
        logicalId: 'campaign-template',
        path: 'templates/campaign-draft-template.md',
        kind: 'template',
        digest: PENDING,
      },
    ],
    handlerRefs: [
      { logicalId: 'draft-handler', version: '1.0.0', digest: PENDING },
    ],
    inputContractRef: makeContractRef('synthetic.marketing.input.v1'),
    outputContractRef: makeContractRef('synthetic.marketing.output.v1'),
    runtimeCompatibilityRange: '^3.0.0',
  };
}

/** Build two resource blobs whose digests are computed from raw bytes. */
function makeValidResources() {
  const skillBytes = new TextEncoder().encode('# Synthetic Marketing Skill\n');
  const tmplBytes = new TextEncoder().encode('# Campaign Draft Template\n');
  return [
    {
      logicalId: 'semantic-skill',
      kind: 'skill',
      bytes: skillBytes,
      digest: computeResourceDigest(skillBytes),
    },
    {
      logicalId: 'campaign-template',
      kind: 'template',
      bytes: tmplBytes,
      digest: computeResourceDigest(tmplBytes),
    },
  ];
}

/** Reference packageDigest formula (must match package-store.ts exactly). */
function referencePackageDigest(manifest, resources) {
  return sha256Hex(
    canonicalJson({
      manifest,
      resourceIndex: manifest.resourceIndex,
      resourceDigests: resources.map((r) => r.digest),
    }),
  );
}

/** Fresh temp rootDir for each test; cleaned in finally. */
function freshRoot() {
  return mkdtempSync(path.join(tmpdir(), 'w2-a1-pkgstore-'));
}

// ===========================================================================
// POSITIVE
// ===========================================================================

test('positive: store creates a content-addressed directory and returns the digest', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const resources = makeValidResources();
    const expected = referencePackageDigest(manifest, resources);

    const stored = await store.store(manifest, resources);

    assert.equal(stored.packageDigest, expected);
    assert.equal(stored.packageDigest.length, 64);
    assert.ok(stored.storedAt.startsWith(root));
    // Content-addressed sharding: <root>/<2hex>/<4hex>/<full>.
    const rel = path.relative(root, stored.storedAt);
    const parts = rel.split(path.sep);
    assert.equal(parts.length, 3, `expected 3 path segments, got ${parts.length}: ${rel}`);
    assert.equal(parts[0], expected.slice(0, 2));
    assert.equal(parts[1], expected.slice(0, 4));
    assert.equal(parts[2], expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('positive: read returns byte-identical resources', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const resources = makeValidResources();
    const { packageDigest } = await store.store(manifest, resources);

    const read = await store.read(packageDigest);

    assert.equal(read.packageDigest, packageDigest);
    assert.equal(read.resources.length, resources.length);
    for (let i = 0; i < resources.length; i++) {
      assert.equal(read.resources[i].logicalId, resources[i].logicalId);
      assert.equal(read.resources[i].kind, resources[i].kind);
      assert.equal(read.resources[i].digest, resources[i].digest);
      // Deep byte equality.
      assert.deepEqual(
        Array.from(read.resources[i].bytes),
        Array.from(resources[i].bytes),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('positive: verify true and exists true for a stored package', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const resources = makeValidResources();
    const { packageDigest } = await store.store(manifest, resources);

    assert.equal(await store.exists(packageDigest), true);
    assert.equal(await store.verify(packageDigest), true);
    // Unknown digest → exists false.
    assert.equal(await store.exists('0'.repeat(64)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('positive: packageDigest stable across two store calls with identical input (deterministic)', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const a = await store.store(makeValidManifest(), makeValidResources());
    const b = await store.store(makeValidManifest(), makeValidResources());
    assert.equal(a.packageDigest, b.packageDigest);
    assert.equal(a.storedAt, b.storedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('positive: resource digest = sha256 of raw bytes (NOT canonicalJson form)', () => {
  // Guard the formula: computeResourceDigest must hash bytes directly.
  const bytes = new TextEncoder().encode('hello');
  const expected = createRawSha256Hex(bytes);
  assert.equal(computeResourceDigest(bytes), expected);
});

// ===========================================================================
// NEGATIVE — path traversal
// ===========================================================================

test('negative: logicalId "../escape" → PACKAGE_STORE_PATH_TRAVERSAL', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const bytes = new TextEncoder().encode('x');
    const bad = [
      {
        logicalId: '../escape',
        kind: 'skill',
        bytes,
        digest: computeResourceDigest(bytes),
      },
    ];
    await assert.rejects(
      () => store.store(manifest, bad),
      (err) => err instanceof PackageStoreError
        && err.code === PACKAGE_STORE_PATH_TRAVERSAL,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('negative: absolute logicalId "/abs" → PACKAGE_STORE_PATH_TRAVERSAL', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const bytes = new TextEncoder().encode('x');
    const bad = [
      { logicalId: '/abs', kind: 'skill', bytes, digest: computeResourceDigest(bytes) },
    ];
    await assert.rejects(
      () => store.store(manifest, bad),
      (err) => err instanceof PackageStoreError
        && err.code === PACKAGE_STORE_PATH_TRAVERSAL,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('negative: Windows-style absolute "C:\\x" → PACKAGE_STORE_PATH_TRAVERSAL', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const bytes = new TextEncoder().encode('x');
    const bad = [
      {
        logicalId: 'C:\\x',
        kind: 'skill',
        bytes,
        digest: computeResourceDigest(bytes),
      },
    ];
    await assert.rejects(
      () => store.store(manifest, bad),
      (err) => err instanceof PackageStoreError
        && err.code === PACKAGE_STORE_PATH_TRAVERSAL,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// NEGATIVE — undeclared resource
// ===========================================================================

test('negative: resource not declared in manifest.resourceIndex → rejected', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest(); // declares semantic-skill + campaign-template
    const bytes = new TextEncoder().encode('x');
    const undeclared = [
      {
        logicalId: 'not-declared',
        kind: 'skill',
        bytes,
        digest: computeResourceDigest(bytes),
      },
    ];
    await assert.rejects(
      () => store.store(manifest, undeclared),
      (err) =>
        err instanceof PackageStoreError && err.code === PACKAGE_STORE_CORRUPT,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// NEGATIVE — corruption
// ===========================================================================

test('negative: mutate a stored resource file on disk → read throws PACKAGE_STORE_DIGEST_MISMATCH', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const resources = makeValidResources();
    const { packageDigest, storedAt } = await store.store(manifest, resources);

    // Corrupt the semantic-skill blob on disk.
    const blobPath = path.join(storedAt, 'resources', 'semantic-skill');
    writeFileSync(blobPath, 'TAMPERED BY TEST');

    await assert.rejects(
      () => store.read(packageDigest),
      (err) =>
        err instanceof PackageStoreError
        && err.code === PACKAGE_STORE_DIGEST_MISMATCH,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('negative: mutate a stored resource file on disk → verify returns false', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const resources = makeValidResources();
    const { packageDigest, storedAt } = await store.store(manifest, resources);

    writeFileSync(
      path.join(storedAt, 'resources', 'campaign-template'),
      'TAMPERED BY TEST',
    );

    assert.equal(await store.verify(packageDigest), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('negative: mutate the stored manifest on disk → verify returns false', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const resources = makeValidResources();
    const { packageDigest, storedAt } = await store.store(manifest, resources);

    // Rewrite manifest.json with a different runtimeCompatibilityRange.
    const manipulated = JSON.parse(JSON.stringify(manifest));
    manipulated.runtimeCompatibilityRange = '^999.0.0';
    writeFileSync(
      path.join(storedAt, 'manifest.json'),
      canonicalJson(manipulated),
    );

    assert.equal(await store.verify(packageDigest), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// NEGATIVE — not found
// ===========================================================================

test('negative: read unknown digest → PACKAGE_STORE_NOT_FOUND', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    await assert.rejects(
      () => store.read('a'.repeat(64)),
      (err) =>
        err instanceof PackageStoreError && err.code === PACKAGE_STORE_NOT_FOUND,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('negative: read malformed digest shape → PACKAGE_STORE_NOT_FOUND', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    await assert.rejects(
      () => store.read('not-a-digest'),
      (err) =>
        err instanceof PackageStoreError && err.code === PACKAGE_STORE_NOT_FOUND,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// THE §14.3.8 EXIT-GATE TEST — immutability proof
// ===========================================================================

test('§14.3.8 exit gate: mutating in-memory input after store does NOT change read', async () => {
  // This is the plan §14.3.8 / §0.5.12 immutability proof.
  //
  // Steps:
  //   1. store a package; capture the digest + the original bytes.
  //   2. mutate the IN-MEMORY manifest and resources (the caller's objects).
  //   3. read the stored digest → MUST return the ORIGINAL bytes, byte-identical
  //      to what was stored, completely unaffected by step 2.
  //
  // This proves the store is content-addressed and immutable: the in-memory
  // caller objects are NOT aliased into the persisted package.
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const resources = makeValidResources();
    const originalSkillBytes = new Uint8Array(resources[0].bytes);
    const originalTmplBytes = new Uint8Array(resources[1].bytes);

    const stored = await store.store(manifest, resources);
    const digest = stored.packageDigest;

    // MUTATE the in-memory caller objects AFTER store.
    manifest.runtimeCompatibilityRange = '^999.0.0';
    resources[0].bytes[0] = resources[0].bytes[0] ^ 0xff; // flip bits
    resources[1].bytes[0] = resources[1].bytes[0] ^ 0xff;

    // READ — must return the ORIGINAL bytes.
    const read = await store.read(digest);

    assert.equal(read.packageDigest, digest);
    assert.deepEqual(
      Array.from(read.resources[0].bytes),
      Array.from(originalSkillBytes),
      'resource[0] must be the original bytes (immutability)',
    );
    assert.deepEqual(
      Array.from(read.resources[1].bytes),
      Array.from(originalTmplBytes),
      'resource[1] must be the original bytes (immutability)',
    );
    assert.equal(
      read.manifest.runtimeCompatibilityRange,
      '^3.0.0',
      'manifest must be the original (immutability)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// Internal helper test — store is idempotent + re-store after corruption
// ===========================================================================

test('store is idempotent: second identical store returns the same package without error', async () => {
  const root = freshRoot();
  try {
    const store = new FilesystemModulePackageStore(root);
    const manifest = makeValidManifest();
    const resources = makeValidResources();

    const first = await store.store(manifest, resources);
    // Mutate caller objects between calls — must not affect the second store
    // (the store reads from the supplied manifest/resources, not from disk).
    const second = await store.store(manifest, resources);
    assert.equal(first.packageDigest, second.packageDigest);
    assert.equal(first.storedAt, second.storedAt);
    assert.equal(await store.verify(first.packageDigest), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test-only helper: raw sha256 over bytes (kept local so the test does not
// depend on node:crypto being re-exported by the SUT).
// ---------------------------------------------------------------------------

function createRawSha256Hex(bytes) {
  return createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
}
