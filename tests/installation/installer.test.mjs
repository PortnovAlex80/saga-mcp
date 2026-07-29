// tests/installation/installer.test.mjs
//
// W2-A3 — PackageInstaller + DependencyLock tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md
// §1 rows 5,6 + §4 digest/identity rules + §0.5.12 replay gate.
// Task: docs/refactor-management/05-subagent-tasks/W02-A3-installer-dependency-lock.md.
//
// SIBLING-PORT NOTE (plan §0.5.2 serial integration):
// W2-A1 (ModulePackageStore / FilesystemModulePackageStore) and W2-A2
// (ModuleInstallationRepository / SqliteModuleInstallationRepository) are
// integrated AFTER W2-A3 and are NOT present in this isolated worktree. Per the
// task file ("If siblings not present in your worktree, write minimal fakes
// matching the ports + note in return"), these tests use IN-MEMORY FAKES that
// implement the documented port shapes the installer codes against. The fakes
// faithfully model:
//   - the spec §4 packageDigest formula
//     (`sha256Hex(canonicalJson({ manifest, resourceIndex, resourceDigests }))`);
//   - the repo's `(name, version, status='active')` UNIQUE-collision semantic
//     (a second ACTIVE row under the same identity with a DIFFERENT digest →
//     throws `MODULE_INSTALLATION_VERSION_COLLISION`);
//   - the `store.verify` replay gate (re-hash stored bytes → compare digest).
// At integration the integrator swaps these fakes for the real
// FilesystemModulePackageStore (mkdtemp) + SqliteModuleInstallationRepository
// (mkdtemp DB); the assertions are written against the port contract and
// transfer unchanged.
//
// Run: node --test tests/installation/installer.test.mjs
// (after `npm run build` — imports are from dist/).

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);
const { adaptLegacyProcessModule } = await import(
  '../../dist/process-modules/domain/spi/legacy-adapter.js'
);
const { validateProcessModuleManifest } = await import(
  '../../dist/process-modules/domain/spi/module-manifest.js'
);
const {
  PackageInstaller,
  PackageInstallerError,
  MODULE_INSTALLATION_VERSION_COLLISION,
  MODULE_INSTALLATION_CORRUPT,
  MODULE_INSTALLATION_UNDECLARED_RESOURCE,
  MODULE_INSTALLATION_MANIFEST_INVALID,
} = await import(
  '../../dist/process-modules/installation/domain/installer.js'
);
const {
  computeDependencyLock,
  PENDING_LOCK_DIGEST,
} = await import(
  '../../dist/process-modules/installation/domain/dependency-lock.js'
);

// W0-A7 synthetic lm-marketing fixture (a ProcessModuleDefinition).
const { default: lmMarketingModule } = await import(
  '../fixtures/synthetic-modules/lm-marketing/definition.mjs'
);

// ---------------------------------------------------------------------------
// Spec §4 packageDigest formula — the fake store must implement EXACTLY this
// (matches W2-A1's FilesystemModulePackageStore.store).
// ---------------------------------------------------------------------------
function computePackageDigest(manifest, resources) {
  // D-20260728-03: single canonicalization (sha256Hex canonicalizes internally).
  return sha256Hex({
    manifest,
    resourceIndex: manifest.resourceIndex,
    resourceDigests: resources.map((r) => r.digest),
  });
}

// ---------------------------------------------------------------------------
// In-memory fake ModulePackageStore. Content-addressed by packageDigest.
// Faithful to the port: store / read / exists / verify. `verify` re-hashes the
// STORED bytes (so corrupting the in-memory blob makes verify return false).
// ---------------------------------------------------------------------------
function createFakeStore() {
  /** @type {Map<string, {manifest: object, resources: any[], packageDigest: string, storedAt: string}>} */
  const packages = new Map();
  let counter = 0;
  const store = {
    async store(manifest, resources) {
      const packageDigest = computePackageDigest(manifest, resources);
      // Idempotent: identical input → identical digest → same package.
      if (!packages.has(packageDigest)) {
        counter += 1;
        packages.set(packageDigest, {
          manifest,
          // Defensive copy of bytes so a caller mutating their input after
          // install cannot mutate the stored package (immutability proof).
          resources: resources.map((r) => ({ ...r, bytes: r.bytes.slice() })),
          packageDigest,
          storedAt: `mem://packages/${counter}`,
        });
      }
      const p = packages.get(packageDigest);
      return {
        manifest: p.manifest,
        resources: p.resources,
        packageDigest: p.packageDigest,
        storedAt: p.storedAt,
      };
    },
    async read(packageDigest) {
      const p = packages.get(packageDigest);
      if (!p) {
        const err = Object.assign(new Error('not found'), {
          code: 'PACKAGE_STORE_NOT_FOUND',
        });
        throw err;
      }
      return {
        manifest: p.manifest,
        resources: p.resources,
        packageDigest: p.packageDigest,
        storedAt: p.storedAt,
      };
    },
    async exists(packageDigest) {
      return packages.has(packageDigest);
    },
    async verify(packageDigest) {
      const p = packages.get(packageDigest);
      if (!p) return false;
      // Re-hash the STORED BYTES (NOT the caller's possibly-mutated input, and
      // NOT the stored `digest` field). This matches W2-A1's FilesystemModule
      // PackageStore.verify: read each blob, recompute sha256Hex(bytes), and
      // re-derive the package digest. Byte corruption (e.g. via _corrupt)
      // makes the recomputed resource digests diverge from the originals, so
      // the recomputed packageDigest no longer matches the recorded one.
      // Resource digests are raw-bytes sha256 (NOT sha256Hex which canonical-
      // JSON-serializes a Uint8Array first — see W2-A1 computeResourceDigest).
      const recomputedResourceDigests = p.resources.map((r) =>
        createHash('sha256').update(r.bytes).digest('hex'),
      );
      // D-20260728-03: single canonicalization (sha256Hex canonicalizes internally).
      const recomputed = sha256Hex({
        manifest: p.manifest,
        resourceIndex: p.manifest.resourceIndex,
        resourceDigests: recomputedResourceDigests,
      });
      return recomputed === packageDigest;
    },
    /** Test-only: corrupt the stored bytes for a digest. */
    _corrupt(packageDigest) {
      const p = packages.get(packageDigest);
      if (!p) return;
      // Mutate one byte of the first resource so re-hash differs.
      if (p.resources.length > 0) {
        const bytes = p.resources[0].bytes;
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      }
    },
  };
  return store;
}

// ---------------------------------------------------------------------------
// In-memory fake ModuleInstallationRepository. Models the
// `(name, version, status='active')` UNIQUE collision: a second ACTIVE row for
// the same identity carrying a DIFFERENT packageDigest throws
// MODULE_INSTALLATION_VERSION_COLLISION. Same-digest re-insert is idempotent.
// ---------------------------------------------------------------------------
function createFakeRepo() {
  /** @type {Array<object>} */
  const rows = [];
  let nextId = 0;
  function isCollision(name, version, packageDigest) {
    return rows.some(
      (r) =>
        r.name === name &&
        r.version === version &&
        r.status === 'active' &&
        r.packageDigest !== packageDigest,
    );
  }
  const repo = {
    async insert(record) {
      if (isCollision(record.name, record.version, record.packageDigest)) {
        throw Object.assign(new Error('version collision'), {
          code: MODULE_INSTALLATION_VERSION_COLLISION,
        });
      }
      // Idempotent on same (name, version, packageDigest, staged): return
      // existing staged row if present so re-inserts don't duplicate.
      const existingStaged = rows.find(
        (r) =>
          r.name === record.name &&
          r.version === record.version &&
          r.packageDigest === record.packageDigest &&
          r.status === 'staged',
      );
      if (existingStaged) return existingStaged;
      nextId += 1;
      const row = {
        id: nextId,
        name: record.name,
        version: record.version,
        packageDigest: record.packageDigest,
        manifestSnapshot: record.manifestSnapshot,
        storeLocation: record.storeLocation,
        resourceIndex: record.resourceIndex,
        handlerRefs: record.handlerRefs,
        dependencyLock: record.dependencyLock,
        status: record.status,
        installedAt: record.installedAt,
      };
      rows.push(row);
      return row;
    },
    async getById(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) {
        throw Object.assign(new Error('not found'), {
          code: 'MODULE_INSTALLATION_NOT_FOUND',
        });
      }
      return row;
    },
    async getByPackageDigest(digest) {
      const row = rows.find(
        (r) => r.packageDigest === digest && r.status === 'active',
      );
      if (!row) {
        throw Object.assign(new Error('not found'), {
          code: 'MODULE_INSTALLATION_NOT_FOUND',
        });
      }
      return row;
    },
    async getActiveByNameVersion(name, version) {
      return (
        rows.find(
          (r) => r.name === name && r.version === version && r.status === 'active',
        ) ?? null
      );
    },
    async activate(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) {
        throw Object.assign(new Error('not found'), {
          code: 'MODULE_INSTALLATION_NOT_FOUND',
        });
      }
      // UNIQUE-active check: another active row for the same identity with a
      // different digest would violate the index.
      if (
        rows.some(
          (r) =>
            r.id !== id &&
            r.name === row.name &&
            r.version === row.version &&
            r.status === 'active' &&
            r.packageDigest !== row.packageDigest,
        )
      ) {
        throw Object.assign(new Error('version collision'), {
          code: MODULE_INSTALLATION_VERSION_COLLISION,
        });
      }
      row.status = 'active';
      row.activatedAt = row.activatedAt ?? new Date().toISOString();
      return row;
    },
    async retire(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) {
        throw Object.assign(new Error('not found'), {
          code: 'MODULE_INSTALLATION_NOT_FOUND',
        });
      }
      row.status = 'retired';
      row.retiredAt = row.retiredAt ?? new Date().toISOString();
      return row;
    },
    async markCorrupt(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) {
        throw Object.assign(new Error('not found'), {
          code: 'MODULE_INSTALLATION_NOT_FOUND',
        });
      }
      row.status = 'corrupt';
      return row;
    },
    async listActive() {
      return rows.filter((r) => r.status === 'active');
    },
    /** Test-only. */
    _rows() {
      return rows;
    },
  };
  return repo;
}

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

/** Compute sha256 of raw bytes via crypto (matches W2-A1's computeResourceDigest:
 * raw-bytes hash, NOT sha256Hex which canonical-JSON-serializes a Uint8Array first).
 * This is the canonical resource-digest formula (plan §5.5.4). */
function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Build a VALID manifest for installation: take the W0-A7 lm-marketing fixture,
 * wrap via adaptLegacyProcessModule (gets a valid baseline envelope), then
 * populate resourceIndex + handlerRefs with real (placeholder-digest) entries.
 * The result passes validateProcessModuleManifest.
 */
function buildMarketingManifest({ withResources = true, withHandlers = true } = {}) {
  const baseline = adaptLegacyProcessModule(lmMarketingModule);
  // Re-build a manifest object with optionally populated index/handlers. The
  // baseline already validates; we extend it with declared entries that also
  // validate (real logicalIds, valid kinds, placeholder digests accepted by
  // the validator).
  const resourceIndex = withResources
    ? [
        {
          logicalId: 'semantic-skill',
          path: 'skills/synthetic-marketing-skill.md',
          kind: 'skill',
          // Real digest of the default resource bytes ('hello marketing') so the
          // manifest is internally consistent with buildMarketingResources() —
          // the installer's resource-digest stamping (step 3.5) then becomes a
          // no-op and record.packageDigest === computePackageDigest(manifest, resources).
          digest: digestBytes(new TextEncoder().encode('hello marketing')),
        },
        {
          logicalId: 'campaign-template',
          path: 'templates/campaign-draft-template.md',
          kind: 'template',
          digest: digestBytes(new TextEncoder().encode('hello marketing')),
        },
      ]
    : [];
  const handlerRefs = withHandlers
    ? [
        {
          logicalId: 'draft-campaign-handler',
          version: '0.1.0',
          digest: PENDING_LOCK_DIGEST,
        },
      ]
    : [];
  return {
    ...baseline,
    resourceIndex,
    handlerRefs,
  };
}

/** Build ResourceBlob[] matching the default marketing manifest's resourceIndex. */
function buildMarketingResources(bytes = new TextEncoder().encode('hello marketing')) {
  return [
    {
      logicalId: 'semantic-skill',
      kind: 'skill',
      bytes,
      digest: digestBytes(bytes),
    },
    {
      logicalId: 'campaign-template',
      kind: 'template',
      bytes,
      digest: digestBytes(bytes),
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test('computeDependencyLock: iterates contracts + handlers + resources into entries', () => {
  const manifest = buildMarketingManifest();
  const lock = computeDependencyLock(manifest);
  // 2 contracts (input + output) + 1 handler + 2 resources = 5 entries.
  assert.equal(lock.entries.length, 5);
  const kinds = lock.entries.map((e) => e.refKind).sort();
  assert.deepEqual(kinds, ['contract', 'contract', 'handler', 'resource', 'resource']);
  // lockDigest is a 64-char hex sha256.
  assert.match(lock.lockDigest, /^[0-9a-f]{64}$/);
});

test('computeDependencyLock: deterministic — same manifest yields same lockDigest', () => {
  const m1 = buildMarketingManifest();
  const m2 = buildMarketingManifest();
  const l1 = computeDependencyLock(m1);
  const l2 = computeDependencyLock(m2);
  assert.equal(l1.lockDigest, l2.lockDigest);
  assert.deepEqual(l1.entries, l2.entries);
});

test('computeDependencyLock: drift in a referenced digest changes lockDigest', () => {
  const manifest = buildMarketingManifest();
  const lock1 = computeDependencyLock(manifest);
  // Mutate one resource digest.
  const mutated = {
    ...manifest,
    resourceIndex: manifest.resourceIndex.map((r, i) =>
      i === 0 ? { ...r, digest: '0'.repeat(64) } : r,
    ),
  };
  const lock2 = computeDependencyLock(mutated);
  assert.notEqual(lock1.lockDigest, lock2.lockDigest);
});

test('computeDependencyLock: accepts placeholder pending digests by default', () => {
  const manifest = buildMarketingManifest();
  // All digests are PENDING_LOCK_DIGEST; default flagPendingDigests=true keeps them.
  const lock = computeDependencyLock(manifest);
  const pending = lock.entries.filter((e) => e.digest === PENDING_LOCK_DIGEST);
  assert.ok(pending.length > 0, 'expected pending entries to be retained');
});

test('computeDependencyLock: flagPendingDigests=false rejects placeholder digests', () => {
  const manifest = buildMarketingManifest();
  assert.throws(
    () => computeDependencyLock(manifest, { flagPendingDigests: false }),
    (err) => err.name === 'PendingDigestError' && err.entries.length > 0,
  );
});

test('installPackage: positive — installs and returns an ACTIVE record', async () => {
  const store = createFakeStore();
  const repo = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  const resources = buildMarketingResources();

  const record = await installer.installPackage(
    manifest,
    resources,
    { store, repo },
    { now: '2026-07-28T00:00:00.000Z' },
  );

  assert.equal(record.status, 'active');
  assert.equal(record.name, 'synthetic-lm-marketing');
  assert.equal(record.version, '0.1.0');
  assert.equal(record.installedAt, '2026-07-28T00:00:00.000Z');
  assert.ok(record.activatedAt, 'activatedAt must be set on active record');
  assert.ok(typeof record.id === 'number');
  // dependencyLock carried through.
  assert.equal(typeof record.dependencyLock.lockDigest, 'string');
  assert.equal(record.dependencyLock.lockDigest.length, 64);
  // Record persisted in repo.
  const active = await repo.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].id, record.id);
});

test('installPackage: record.packageDigest matches store.read(digest).packageDigest', async () => {
  const store = createFakeStore();
  const repo = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  const resources = buildMarketingResources();

  const record = await installer.installPackage(manifest, resources, { store, repo });

  const stored = await store.read(record.packageDigest);
  assert.equal(stored.packageDigest, record.packageDigest);
  // And the store's computed digest equals the spec §4 formula computed here.
  assert.equal(
    record.packageDigest,
    computePackageDigest(manifest, resources),
  );
});

test('installPackage: packageDigest stable for identical input (deterministic store)', async () => {
  // packageDigest covers the FULL manifest (spec §4), so two installs under
  // different (name,version) legitimately produce different digests. This test
  // proves store-level determinism: the SAME input, fed to two independent
  // stores, yields the SAME packageDigest (content-addressing is reproducible).
  const store1 = createFakeStore();
  const store2 = createFakeStore();
  const repo1 = createFakeRepo();
  const repo2 = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  const resources = buildMarketingResources();

  const r1 = await installer.installPackage(manifest, resources, {
    store: store1,
    repo: repo1,
  });
  const r2 = await installer.installPackage(manifest, resources, {
    store: store2,
    repo: repo2,
  });
  assert.equal(
    r1.packageDigest,
    r2.packageDigest,
    'identical input must yield identical packageDigest across stores',
  );
  // And both match the spec §4 formula computed directly.
  assert.equal(r1.packageDigest, computePackageDigest(manifest, resources));
});

test('installPackage: identical active reinstall is idempotent and reuses the same row', async () => {
  const store = createFakeStore();
  const repo = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  const resources = buildMarketingResources();

  const first = await installer.installPackage(manifest, resources, { store, repo });
  const replay = await installer.installPackage(manifest, resources, { store, repo });

  assert.equal(replay.id, first.id);
  assert.equal(replay.packageDigest, first.packageDigest);
  assert.equal((await repo.listActive()).length, 1);
  assert.equal(repo._rows().length, 1, 'idempotent replay must not create a staged duplicate');
});

test('installPackage: identical active reinstall fails closed when stored bytes are corrupt', async () => {
  const store = createFakeStore();
  const repo = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  const resources = buildMarketingResources();

  const first = await installer.installPackage(manifest, resources, { store, repo });
  store._corrupt(first.packageDigest);

  await assert.rejects(
    () => installer.installPackage(manifest, resources, { store, repo }),
    (err) => {
      assert.ok(err instanceof PackageInstallerError);
      assert.equal(err.code, MODULE_INSTALLATION_CORRUPT);
      return true;
    },
  );
  assert.equal(repo._rows().find(row => row.id === first.id)?.status, 'corrupt');
});

test('installPackage: negative — same (name,version) DIFFERENT resources → VERSION_COLLISION', async () => {
  const store = createFakeStore();
  const repo = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  await installer.installPackage(
    manifest,
    buildMarketingResources(new TextEncoder().encode('aaa')),
    { store, repo },
  );

  // Different resources → different digests → collision on the active identity.
  await assert.rejects(
    () =>
      installer.installPackage(
        manifest,
        buildMarketingResources(new TextEncoder().encode('bbb')),
        { store, repo },
      ),
    (err) => {
      assert.ok(err instanceof PackageInstallerError, 'must be PackageInstallerError');
      assert.equal(err.code, MODULE_INSTALLATION_VERSION_COLLISION);
      return true;
    },
  );
  // Original record still active + intact.
  const active = await repo.listActive();
  assert.equal(active.length, 1);
});

test('installPackage: negative — undeclared resource rejected BEFORE store', async () => {
  const store = createFakeStore();
  const repo = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  const resources = buildMarketingResources();
  // Add a blob whose logicalId is NOT in the manifest's resourceIndex.
  const undeclared = {
    logicalId: 'ghost-resource',
    kind: 'skill',
    bytes: new TextEncoder().encode('ghost'),
    digest: digestBytes(new TextEncoder().encode('ghost')),
  };

  await assert.rejects(
    () => installer.installPackage(manifest, [...resources, undeclared], { store, repo }),
    (err) => {
      assert.ok(err instanceof PackageInstallerError);
      assert.equal(err.code, MODULE_INSTALLATION_UNDECLARED_RESOURCE);
      return true;
    },
  );
  // Store was NOT touched (no package persisted).
  assert.equal(await store.exists(computePackageDigest(manifest, [...resources, undeclared])), false);
  // Repo was NOT touched.
  assert.equal((await repo.listActive()).length, 0);
});

test('installPackage: negative — invalid manifest (function in a field) rejected at validate', async () => {
  const store = createFakeStore();
  const repo = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  // Plant a non-serializable value (function) into a manifest field.
  const poisoned = {
    ...manifest,
    definition: {
      ...manifest.definition,
      // canonical-serialization check rejects functions anywhere in the object.
      injected: () => 'not serializable',
    },
  };
  const resources = buildMarketingResources();

  await assert.rejects(
    () => installer.installPackage(poisoned, resources, { store, repo }),
    (err) => {
      assert.ok(err instanceof PackageInstallerError);
      assert.equal(err.code, MODULE_INSTALLATION_MANIFEST_INVALID);
      return true;
    },
  );
  // Nothing persisted.
  assert.equal((await repo.listActive()).length, 0);
});

test('installPackage: negative — store.verify=false flips record to corrupt and throws CORRUPT', async () => {
  const store = createFakeStore();
  const repo = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  const resources = buildMarketingResources();

  // First install succeeds so we know the packageDigest; then we corrupt the
  // stored bytes and attempt a FRESH install of the same input. Because the
  // store is content-addressed + idempotent, the second install's store.store
  // returns the SAME digest, then store.verify re-hashes the corrupted bytes
  // and returns false.
  const first = await installer.installPackage(manifest, resources, { store, repo });
  // Corrupt the stored package.
  store._corrupt(first.packageDigest);
  // Retire the first active record so the second install can stage under the
  // same (name, version, packageDigest) without colliding (same digest → not a
  // version collision anyway, but retire keeps the fake repo listActive clean).
  await repo.retire(first.id);

  await assert.rejects(
    () => installer.installPackage(manifest, resources, { store, repo }),
    (err) => {
      assert.ok(err instanceof PackageInstallerError);
      assert.equal(err.code, MODULE_INSTALLATION_CORRUPT);
      return true;
    },
  );
  // The staged record was flipped to corrupt.
  const corruptRows = repo._rows().filter((r) => r.status === 'corrupt');
  assert.ok(corruptRows.length >= 1, 'expected at least one corrupt record');
});

// ---------------------------------------------------------------------------
// The §0.5.12 replay-after-source-mutation test (spec §6 exit gate item 6).
//
// Install a package. Then MUTATE the in-memory manifest/resources the caller
// still holds. Re-install under the SAME (name, version): because the mutated
// input would produce a DIFFERENT packageDigest, the repo rejects it as a
// version collision (a different digest cannot replace an active one). The
// ORIGINAL record still resolves from the store with its ORIGINAL bytes —
// proving installed packages are immutable and source mutation cannot silently
// drift what is installed. (Plan §0.5.12, §14.3.8.)
// ---------------------------------------------------------------------------
test('installPackage: §0.5.12 replay — mutating source after install does NOT change the stored package', async () => {
  const store = createFakeStore();
  const repo = createFakeRepo();
  const installer = new PackageInstaller();
  const manifest = buildMarketingManifest();
  const resources = buildMarketingResources(new TextEncoder().encode('original'));

  const original = await installer.installPackage(manifest, resources, { store, repo });
  const originalDigest = original.packageDigest;

  // Mutate the caller's in-memory resources (simulating source files changing
  // on disk after install).
  const mutatedResources = buildMarketingResources(
    new TextEncoder().encode('mutated'),
  );

  // Re-install under the SAME (name, version): the mutated bytes produce a
  // different digest → VERSION_COLLISION (cannot replace the active install).
  await assert.rejects(
    () => installer.installPackage(manifest, mutatedResources, { store, repo }),
    (err) => err.code === MODULE_INSTALLATION_VERSION_COLLISION,
  );

  // The ORIGINAL package is still in the store, byte-identical.
  const replayed = await store.read(originalDigest);
  assert.equal(replayed.packageDigest, originalDigest);
  // The store is content-addressed: the mutated bytes never overwrote the
  // original package (a different digest is a different key).
  assert.equal(await store.exists(originalDigest), true);
  // Re-verify the original package: still valid.
  assert.equal(await store.verify(originalDigest), true);
  // The active record in the repo still points at the original digest.
  const active = await repo.getActiveByNameVersion(
    'synthetic-lm-marketing',
    '0.1.0',
  );
  assert.ok(active);
  assert.equal(active.packageDigest, originalDigest);
});

// ---------------------------------------------------------------------------
// Sanity: the manifests we build actually pass validateProcessModuleManifest,
// so the positive tests are exercising the post-validate pipeline (not silently
// skipping on an invalid fixture).
// ---------------------------------------------------------------------------
test('fixture: buildMarketingManifest passes validateProcessModuleManifest', () => {
  const manifest = buildMarketingManifest();
  const result = validateProcessModuleManifest(manifest);
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
});
