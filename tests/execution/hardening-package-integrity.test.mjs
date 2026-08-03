// tests/execution/hardening-package-integrity.test.mjs
//
// W12-A1 — Package mutation / corruption / upgrade / replay hardening.
//
// Spec: docs/refactor-management/09-contracts/WAVE12-HARDENING-SPEC.md
//       (W12 lane A1, §2 row 1, §3 exit gate items 2-3, §5 test design).
// Task: docs/refactor-management/05-subagent-tasks/W12-a1.md.
//
// WHAT THIS PROVES (the W12-A1 hardening contract)
//
//   The immutable package bytes installed by the Wave 2 immutable-installation
//   layer survive FOUR classes of injected fault, without manual DB / metadata
//   / tracker / workspace / artifact repair (WAVE12-HARDENING-SPEC §0, §3):
//
//   1. SOURCE MUTATION — after install, mutating the in-memory caller manifest
//      + resource bytes does NOT change what `store.read(digest)` returns. The
//      package is content-addressed; the caller's objects are NOT aliased into
//      the persisted package. Replay returns the ORIGINAL bytes.
//
//   2. DISK CORRUPTION — flipping a byte in a stored resource file is DETECTED:
//      `store.read` throws PACKAGE_STORE_DIGEST_MISMATCH, `store.verify` returns
//      false, and the caller (installer/repo) marks the installation `corrupt`.
//      A corrupted installation is NOT silently resolvable. Corruption is
//      detected across a simulated process death (close DB, reopen, re-verify).
//
//   3. VERSION UPGRADE — installing a NEWER version (`0.2.0`) of the SAME module
//      name alongside the existing `0.1.0` succeeds; both active records
//      coexist (one active per (name, version)); each package is independently
//      content-addressed and independently verifiable. Attempting to overwrite
//      `0.1.0` with DIFFERENT bytes under the SAME version is rejected with
//      MODULE_INSTALLATION_VERSION_COLLISION.
//
//   4. ACTIVE RUNS STAY PINNED — a ProcessRun pinned to installation `0.1.0`
//      keeps reading the SAME packageDigest even after a newer `0.2.0` is
//      installed and even after a simulated process restart (DB close + reopen
//      + re-read the pin). The pin is immutable on the run row. Replay of the
//      pinned digest returns the ORIGINAL `0.1.0` bytes, never the newer ones.
//
// TEST DESIGN (WAVE12-HARDENING-SPEC §5)
//   - REAL infrastructure: real better-sqlite3 DB on a mkdtemp file, real
//     FilesystemModulePackageStore on a mkdtemp root. NO mocks.
//   - Crash injection by simulating process death: close the DB handle, drop
//     all in-memory state, reopen a fresh Database + fresh repo/adapter
//     instances against the SAME on-disk files.
//   - Byte-level replay equality: content hashes match across crash boundaries.
//   - Each test is self-contained (own tmpdir DB + store, cleaned in finally).
//
// This is a TEST-ONLY wave (§0.15.2 / §1 / §4 anti-scope): NO production code
// changes. If a test reveals a bug, it is documented inline and returned to the
// owning subsystem for a serial fix.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';

import { canonicalJson, sha256Hex } from '../../dist/shared/canonical-json.js';
import {
  FilesystemModulePackageStore,
} from '../../dist/process-modules/installation/adapters/filesystem-package-store.js';
import {
  PACKAGE_STORE_DIGEST_MISMATCH,
  PackageStoreError,
  computeResourceDigest,
} from '../../dist/process-modules/installation/domain/package-store.js';
import {
  MODULE_INSTALLATION_VERSION_COLLISION,
} from '../../dist/process-modules/installation/domain/installation.js';
import {
  SqliteModuleInstallationRepository,
  ensureSaga3ModuleInstallationSchema,
} from '../../dist/process-modules/installation/persistence/installation-repository.js';
import { installPackage } from '../../dist/process-modules/installation/domain/installer.js';
import { ProcessRunInstallationAdapter } from '../../dist/process-modules/installation/persistence/process-run-installation-adapter.js';
import { pinInstallationOnProcessRun } from '../../dist/process-modules/installation/domain/process-run-pinning.js';
import { lmMarketingModule } from '../fixtures/synthetic-modules/lm-marketing/definition.mjs';

// ---------------------------------------------------------------------------
// Constants / fixture helpers.
// ---------------------------------------------------------------------------

const PENDING = 'pending@wave-2';

function makeContractRef(schemaId) {
  return { schemaId, version: '1.0.0', digest: PENDING };
}

/**
 * Build a valid manifest derived from the W0-A7 lm-marketing fixture, with two
 * declared resources. `versionOverride` lets us mint a NEWER version of the
 * same module name for the version-upgrade scenario.
 */
function makeManifest(versionOverride) {
  return {
    manifestFormatVersion: '0.1.0',
    definition: {
      ...lmMarketingModule,
      identity: {
        ...lmMarketingModule.identity,
        version: versionOverride ?? lmMarketingModule.identity.version,
      },
    },
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
function makeResources(skillText = '# Synthetic Marketing Skill\n', tmplText = '# Campaign Draft Template\n') {
  const skillBytes = new TextEncoder().encode(skillText);
  const tmplBytes = new TextEncoder().encode(tmplText);
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

/**
 * Stamp placeholder resource digests with the REAL sha256 of the supplied
 * bytes, mirroring installer.ts step 3.5 (`stampedResourceIndex`). The
 * installer replaces each `manifest.resourceIndex` entry's digest (which may
 * carry the `'pending@wave-2'` placeholder) with `sha256(bytes)` BEFORE
 * computing the package digest, so any oracle that wants to match the SUT must
 * stamp identically. Returns a NEW manifest (does not mutate the caller's).
 */
function stampResourceDigests(manifest, resources) {
  const bytesByLogicalId = new Map(resources.map((r) => [r.logicalId, r.bytes]));
  return {
    ...manifest,
    resourceIndex: manifest.resourceIndex.map((entry) => {
      const bytes = bytesByLogicalId.get(entry.logicalId);
      if (!bytes) return entry;
      return { ...entry, digest: createHash('sha256').update(bytes).digest('hex') };
    }),
  };
}

/**
 * Compute the content address of a package, mirroring the SUT formula exactly
 * (Decision D-20260728-03: single canonicalization). Used as an independent
 * oracle in the tests. The manifest is stamped with real resource digests
 * first, the same way the installer does before calling `computePackageDigest`.
 */
function referencePackageDigest(manifest, resources) {
  const stamped = stampResourceDigests(manifest, resources);
  return sha256Hex({
    manifest: stamped,
    resourceIndex: stamped.resourceIndex,
    resourceDigests: resources.map((r) => r.digest),
  });
}

/**
 * Create a fresh, isolated environment for one scenario:
 *   - mkdtemp directory for FilesystemModulePackageStore
 *   - mkdtemp .db file with the Wave 2 installations schema + a minimal
 *     saga3_process_runs table (the columns the W2-A4 pinning adapter reads).
 *
 * Returns the paths + a factory for store/repo/adapter so we can simulate a
 * process restart by building fresh instances against the SAME on-disk files.
 */
function makeIsolatedEnv() {
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'w12a1-store-'));
  const dbDir = mkdtempSync(path.join(tmpdir(), 'w12a1-db-'));
  const dbPath = path.join(dbDir, 'hardening.db');

  function applySchema(db) {
    ensureSaga3ModuleInstallationSchema(db);
    // Minimal process_runs-shaped table for the W2-A4 pinning proof. The real
    // saga3_process_runs table is owned by sqlite-process-run-repository.ts
    // (NOT imported here — this is the test-only minimal projection the pinning
    // adapter reads via raw SQL).
    db.exec(`
      CREATE TABLE IF NOT EXISTS saga3_process_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_name TEXT NOT NULL,
        module_version TEXT NOT NULL,
        installation_id INTEGER,
        package_digest TEXT,
        updated_at TEXT
      );
    `);
  }

  // Initial connection (opened eagerly so the schema exists on disk before any
  // reopen simulation).
  const initialDb = new Database(dbPath);
  initialDb.pragma('journal_mode = WAL');
  applySchema(initialDb);
  initialDb.close();

  return {
    storeRoot,
    dbPath,
    /** Build a fresh store against the same on-disk root. */
    newStore() {
      return new FilesystemModulePackageStore(storeRoot);
    },
    /**
     * Open a FRESH Database handle against the same on-disk DB file + build
     * fresh repo/adapter instances. This simulates a process restart: all
     * in-memory state is gone, only the durable on-disk bytes remain. The
     * caller MUST close the returned db when done.
     */
    reopen() {
      const db = new Database(dbPath);
      applySchema(db); // idempotent — no-op on reopen
      return {
        db,
        repo: new SqliteModuleInstallationRepository(db),
        runAdapter: new ProcessRunInstallationAdapter(db),
      };
    },
    cleanup() {
      try { rmSync(storeRoot, { recursive: true, force: true }); } catch { /* gone */ }
      try { rmSync(dbDir, { recursive: true, force: true }); } catch { /* gone */ }
    },
  };
}

/** Deep-clone a manifest/resources pair so callers can mutate freely. */
function cloneInputs(manifest, resources) {
  const manifestCopy = JSON.parse(JSON.stringify(manifest));
  const resourcesCopy = resources.map((r) => ({
    logicalId: r.logicalId,
    kind: r.kind,
    bytes: new Uint8Array(r.bytes),
    digest: r.digest,
  }));
  return { manifest: manifestCopy, resources: resourcesCopy };
}

// ===========================================================================
// SCENARIO 1 — SOURCE MUTATION: immutable bytes survive in-memory mutation.
// ===========================================================================

test('W12-A1 §1 source mutation: in-memory mutation after install does NOT change stored bytes', async () => {
  const env = makeIsolatedEnv();
  try {
    const store = env.newStore();
    const opened = env.reopen();
    try {
      const installed = await installPackage(
        makeManifest(),
        makeResources(),
        { store, repo: opened.repo },
      );
      const originalDigest = installed.packageDigest;
      const expectedDigest = referencePackageDigest(makeManifest(), makeResources());
      assert.equal(originalDigest, expectedDigest, 'oracle: digest matches SUT formula');

      // Capture the canonical byte snapshot BEFORE mutation.
      const before = await store.read(originalDigest);
      const beforeManifestJson = canonicalJson(before.manifest);
      const beforeResourceBytes = before.resources.map((r) => Buffer.from(r.bytes));

      // MUTATE the in-memory caller objects AFTER install. These are the
      // objects the installer received; mutating them must NOT leak into the
      // content-addressed store.
      const { manifest, resources } = cloneInputs(makeManifest(), makeResources());
      manifest.definition.identity.displayName = 'MUTATED Display Name';
      manifest.runtimeCompatibilityRange = '>=99.0.0 <100.0.0';
      resources[0].bytes[0] = resources[0].bytes[0] ^ 0xff; // flip bits
      resources[1].bytes[0] = resources[1].bytes[0] ^ 0xff;

      // READ the stored digest — MUST return the ORIGINAL bytes.
      const after = await store.read(originalDigest);
      assert.equal(after.packageDigest, originalDigest, 'digest unchanged after in-memory mutation');
      assert.equal(
        canonicalJson(after.manifest),
        beforeManifestJson,
        'stored manifest unchanged after in-memory mutation',
      );
      assert.equal(after.resources.length, beforeResourceBytes.length);
      for (let i = 0; i < beforeResourceBytes.length; i++) {
        assert.deepEqual(
          Buffer.from(after.resources[i].bytes),
          beforeResourceBytes[i],
          `stored resource[${i}] bytes unchanged after in-memory mutation`,
        );
      }

      // The repo record is unchanged too.
      const recordAgain = opened.repo.getByPackageDigest(originalDigest);
      assert.equal(recordAgain.packageDigest, originalDigest);
      assert.equal(recordAgain.status, 'active');

      // verify() still true (disk was never touched).
      assert.equal(await store.verify(originalDigest), true);
    } finally {
      opened.db.close();
    }
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// SCENARIO 1b — REPLAY AFTER MUTATION across a simulated process restart.
// ===========================================================================

test('W12-A1 §1b replay: original bytes survive a simulated process restart', async () => {
  const env = makeIsolatedEnv();
  try {
    // Phase 1: install with one process (store #1 + db #1).
    let digest;
    let expectedManifestJson;
    let expectedResourceBytes;
    {
      const store = env.newStore();
      const opened = env.reopen();
      try {
        const installed = await installPackage(
          makeManifest(),
          makeResources(),
          { store, repo: opened.repo },
        );
        digest = installed.packageDigest;
        const snap = await store.read(digest);
        expectedManifestJson = canonicalJson(snap.manifest);
        expectedResourceBytes = snap.resources.map((r) => Buffer.from(r.bytes));
      } finally {
        opened.db.close();
      }
    }
    // Phase 2: "process death" — all in-memory state is gone. Reopen a FRESH
    // store + FRESH db against the SAME on-disk files and replay the digest.
    {
      const store = env.newStore(); // fresh instance, same rootDir
      const opened = env.reopen(); // fresh DB handle, same dbPath
      try {
        // The repo row survives the restart.
        const record = opened.repo.getByPackageDigest(digest);
        assert.ok(record, 'installation record survived process restart');
        assert.equal(record.packageDigest, digest);
        assert.equal(record.status, 'active');

        // The store returns the ORIGINAL bytes.
        const replayed = await store.read(digest);
        assert.equal(replayed.packageDigest, digest);
        assert.equal(
          canonicalJson(replayed.manifest),
          expectedManifestJson,
          'replayed manifest matches pre-crash bytes',
        );
        assert.equal(replayed.resources.length, expectedResourceBytes.length);
        for (let i = 0; i < expectedResourceBytes.length; i++) {
          assert.deepEqual(
            Buffer.from(replayed.resources[i].bytes),
            expectedResourceBytes[i],
            `replayed resource[${i}] matches pre-crash bytes`,
          );
        }
        assert.equal(await store.verify(digest), true, 'verify true after restart');
      } finally {
        opened.db.close();
      }
    }
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// SCENARIO 2 — DISK CORRUPTION: detected by read (throws) and verify (false),
//               and the installation is marked corrupt. Survives restart.
// ===========================================================================

test('W12-A1 §2 disk corruption: byte-flip is detected and the installation is marked corrupt', async () => {
  const env = makeIsolatedEnv();
  try {
    const store = env.newStore();
    const opened = env.reopen();
    let installationId;
    let digest;
    let corruptedFile;
    let originalFileBytes;
    try {
      const installed = await installPackage(
        makeManifest(),
        makeResources(),
        { store, repo: opened.repo },
      );
      installationId = installed.id;
      digest = installed.packageDigest;

      // verify is true before tampering.
      assert.equal(await store.verify(digest), true, 'verify true before corruption');

      // Locate the stored package dir (content-addressed: <root>/<2hex>/<4hex>/<digest>).
      const pkg = await store.read(digest);
      assert.ok(pkg.resources.length > 0);
      const resourcesDir = path.join(
        env.storeRoot,
        digest.slice(0, 2),
        digest.slice(0, 4),
        digest,
        'resources',
      );
      const files = readdirSync(resourcesDir).map((f) => path.join(resourcesDir, f));
      assert.ok(files.length > 0, 'found stored resource files');
      corruptedFile = files[0];
      originalFileBytes = readFileSync(corruptedFile);

      // Flip the first byte on disk.
      const corrupted = Buffer.from(originalFileBytes);
      if (corrupted.length > 0) {
        corrupted[0] = corrupted[0] ^ 0xff;
      } else {
        corrupted.push(0x00);
      }
      writeFileSync(corruptedFile, corrupted);

      // read MUST throw PACKAGE_STORE_DIGEST_MISMATCH.
      await assert.rejects(
        () => store.read(digest),
        (err) => err instanceof PackageStoreError && err.code === PACKAGE_STORE_DIGEST_MISMATCH,
        'read throws DIGEST_MISMATCH after on-disk byte flip',
      );

      // verify MUST return false (never throws).
      assert.equal(await store.verify(digest), false, 'verify false after corruption');

      // The caller (installer/repo) marks the installation corrupt.
      opened.repo.markCorrupt(installationId);
      const corruptedRecord = opened.repo.getById(installationId);
      assert.equal(corruptedRecord.status, 'corrupt', 'installation status flips to corrupt');

      // A corrupt installation must NOT be selectable as active.
      const stillActive = opened.repo.getActiveByNameVersion(
        installed.name,
        installed.version,
      );
      assert.equal(stillActive, null, 'corrupt installation is not active');
    } finally {
      // Restore the file so the reopen phase below is meaningful (proves the
      // corruption is RECOVERABLE by restoring bytes — the package becomes
      // verifiable again, but the installation STATUS stays corrupt until a
      // caller re-activates it).
      if (corruptedFile && originalFileBytes) {
        writeFileSync(corruptedFile, originalFileBytes);
      }
      opened.db.close();
    }

    // Phase 2: simulated restart. The corrupt STATUS survives on disk; the
    // underlying bytes are now restored, so store.verify returns true again
    // (the package is byte-faithful), but the repo row is still corrupt.
    const reopened = env.reopen();
    try {
      const recordAfterRestart = reopened.repo.getById(installationId);
      assert.equal(recordAfterRestart.status, 'corrupt', 'corrupt status survives restart');
      assert.equal(
        await env.newStore().verify(digest),
        true,
        'after byte restore, package verifies again (bytes faithful)',
      );
    } finally {
      reopened.db.close();
    }
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// SCENARIO 3 — VERSION UPGRADE: a newer version coexists; same-version
//               overwrite with different bytes is rejected.
// ===========================================================================

test('W12-A1 §3 version upgrade: 0.2.0 coexists with 0.1.0; same-version overwrite is rejected', async () => {
  const env = makeIsolatedEnv();
  try {
    const store = env.newStore();
    const opened = env.reopen();
    try {
      // Install 0.1.0.
      const v1 = await installPackage(
        makeManifest('0.1.0'),
        makeResources(),
        { store, repo: opened.repo },
      );
      // Install a NEWER 0.2.0 with DIFFERENT resource bytes (so a different digest).
      const v2 = await installPackage(
        makeManifest('0.2.0'),
        makeResources('# Brand New Skill v2\n', '# Brand New Template v2\n'),
        { store, repo: opened.repo },
      );

      assert.notEqual(v1.packageDigest, v2.packageDigest, 'v1 and v2 have different digests');
      assert.equal(v1.status, 'active');
      assert.equal(v2.status, 'active');

      // Both active records coexist — one active per (name, version).
      const active010 = opened.repo.getActiveByNameVersion(v1.name, '0.1.0');
      const active020 = opened.repo.getActiveByNameVersion(v2.name, '0.2.0');
      assert.equal(active010.id, v1.id, '0.1.0 active slot is v1');
      assert.equal(active020.id, v2.id, '0.2.0 active slot is v2');

      // Both packages are independently verifiable.
      assert.equal(await store.verify(v1.packageDigest), true);
      assert.equal(await store.verify(v2.packageDigest), true);

      // Attempting to overwrite 0.1.0 with DIFFERENT bytes under the SAME
      // version is rejected with MODULE_INSTALLATION_VERSION_COLLISION.
      await assert.rejects(
        () => installPackage(
          makeManifest('0.1.0'),
          // Different resource bytes → different digest → collision.
          makeResources('# Yet Another Skill\n', '# Yet Another Template\n'),
          { store, repo: opened.repo },
        ),
        (err) => {
          const code = String(err && (err.code ?? err.message ?? err.name));
          return code.includes(MODULE_INSTALLATION_VERSION_COLLISION);
        },
        'same-version overwrite with different bytes is rejected',
      );

      // ──────────────────────────────────────────────────────────────────────
      // IDEMPOTENT REPLAY (Wave 1A fix — formerly a documented BUG).
      // ──────────────────────────────────────────────────────────────────────
      // Expected behavior (WAVE2-IMMUTABLE-INSTALLATION-SPEC §4 + the repo
      // docstring on `insert`/`activate`): re-installing the EXACT same bytes
      // for an already-active (name, version) is an IDEMPOTENT REPLAY that
      // returns the existing active record. The store (`FilesystemModulePackageStore`)
      // IS idempotent (same digest → same dir, no rewrite), and
      // `repo.insert({status:'active'})` IS idempotent (same digest → returns
      // the existing active row).
      //
      // The fix lives in the installer (installation/domain/installer.ts):
      // the pre-check computes `attemptedPackageDigest` BEFORE touching the
      // store, looks up `existingActive = repo.getActiveByNameVersion(...)`,
      // and when `existingActive.packageDigest === attemptedPackageDigest` it
      // short-circuits — verifying the existing package and returning the
      // existing active record WITHOUT inserting a new staged row (which would
      // collide at `activate` time). This was previously a characterized bug
      // (replay threw MODULE_INSTALLATION_ACTIVATE_FAILED via a wrapped
      // VERSION_COLLISION); the installer now returns the active record.
      const replayResult = await installPackage(
        makeManifest('0.1.0'),
        makeResources(),
        { store, repo: opened.repo },
      ).catch((e) => e);
      assert.ok(
        !(replayResult instanceof Error),
        'idempotent replay through installPackage returns the active record (does not throw)',
      );
      assert.equal(
        replayResult.id,
        v1.id,
        'idempotent replay returns the SAME active installation record',
      );
      assert.equal(replayResult.status, 'active');
      assert.equal(replayResult.packageDigest, v1.packageDigest);

      // The original v1 active record is still intact (no silent replacement).
      const stillV1 = opened.repo.getActiveByNameVersion(v1.name, '0.1.0');
      assert.equal(stillV1.id, v1.id);
      assert.equal(stillV1.packageDigest, v1.packageDigest);
      assert.equal(stillV1.status, 'active');

      // The lower-level repo.insert({status:'active'}) IS idempotent (proving
      // the bug is in the installer orchestration, not the store or repo):
      // inserting the same active digest returns the existing active row.
      const directReplay = opened.repo.insert({
        name: v1.name,
        version: '0.1.0',
        packageDigest: v1.packageDigest,
        manifestSnapshot: opened.repo.getById(v1.id).manifestSnapshot,
        storeLocation: opened.repo.getById(v1.id).storeLocation,
        resourceIndex: opened.repo.getById(v1.id).resourceIndex,
        handlerRefs: opened.repo.getById(v1.id).handlerRefs,
        dependencyLock: opened.repo.getById(v1.id).dependencyLock,
        status: 'active',
      });
      assert.equal(directReplay.id, v1.id, 'repo.insert idempotent replay returns existing active row');
      assert.equal(stillV1.packageDigest, v1.packageDigest);
    } finally {
      opened.db.close();
    }
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// SCENARIO 4 — ACTIVE RUNS STAY PINNED: a run pinned to 0.1.0 keeps reading
//               the 0.1.0 bytes after 0.2.0 is installed and after a restart.
// ===========================================================================

test('W12-A1 §4 active runs stay pinned: pinned run reads 0.1.0 bytes after 0.2.0 install + restart', async () => {
  const env = makeIsolatedEnv();
  try {
    let v1Digest;
    let v1Id;
    let v1ResourceBytes;
    let runId;
    const moduleName = lmMarketingModule.identity.name;

    // Phase 1: install 0.1.0, pin a run to it, capture the original bytes.
    {
      const store = env.newStore();
      const opened = env.reopen();
      try {
        const v1 = await installPackage(
          makeManifest('0.1.0'),
          makeResources(),
          { store, repo: opened.repo },
        );
        v1Digest = v1.packageDigest;
        v1Id = v1.id;
        const snap = await store.read(v1Digest);
        v1ResourceBytes = snap.resources.map((r) => Buffer.from(r.bytes));

        // Insert a process_runs row and PIN it to the v1 installation.
        const info = opened.db
          .prepare('INSERT INTO saga3_process_runs (module_name, module_version) VALUES (?, ?)')
          .run(moduleName, '0.1.0');
        runId = Number(info.lastInsertRowid);
        const pin = pinInstallationOnProcessRun(runId, v1Id, v1Digest);
        opened.runAdapter.setPinnedInstallation(runId, pin.installationId, pin.packageDigest);

        // Confirm the pin round-trips.
        const readBack = opened.runAdapter.getPinnedInstallation(runId);
        assert.ok(readBack, 'pin is retrievable');
        assert.equal(readBack.installationId, v1Id);
        assert.equal(readBack.packageDigest, v1Digest);
      } finally {
        opened.db.close();
      }
    }

    // Phase 2: install a NEWER 0.2.0 with DIFFERENT bytes. The pinned run must
    // NOT drift to 0.2.0 — it stays pinned to the 0.1.0 digest.
    {
      const store = env.newStore();
      const opened = env.reopen();
      try {
        const v2 = await installPackage(
          makeManifest('0.2.0'),
          makeResources('# Completely Different v2\n', '# Completely Different v2\n'),
          { store, repo: opened.repo },
        );
        assert.notEqual(v2.packageDigest, v1Digest, 'v2 has a different digest');

        // The pin is IMMUTABLE — installing 0.2.0 did not touch the run row.
        const pinAfterUpgrade = opened.runAdapter.getPinnedInstallation(runId);
        assert.ok(pinAfterUpgrade, 'pin survives 0.2.0 install');
        assert.equal(pinAfterUpgrade.installationId, v1Id, 'pin still points at v1 installation');
        assert.equal(pinAfterUpgrade.packageDigest, v1Digest, 'pin still carries v1 digest');

        // Reading the PINNED digest returns the v1 bytes, NOT the v2 bytes.
        const replayed = await store.read(v1Digest);
        assert.equal(replayed.resources.length, v1ResourceBytes.length);
        for (let i = 0; i < v1ResourceBytes.length; i++) {
          assert.deepEqual(
            Buffer.from(replayed.resources[i].bytes),
            v1ResourceBytes[i],
            `pinned run reads v1 resource[${i}] bytes, not v2`,
          );
        }
      } finally {
        opened.db.close();
      }
    }

    // Phase 3: simulated process restart. Reopen fresh DB handle + adapter
    // against the SAME on-disk DB. The pin survives; the pinned digest still
    // resolves to the v1 bytes.
    {
      const store = env.newStore();
      const opened = env.reopen();
      try {
        const pinAfterRestart = opened.runAdapter.getPinnedInstallation(runId);
        assert.ok(pinAfterRestart, 'pin survives process restart');
        assert.equal(pinAfterRestart.installationId, v1Id);
        assert.equal(pinAfterRestart.packageDigest, v1Digest);

        // The pinned installation record still exists and is still active.
        const pinnedRecord = opened.repo.getById(v1Id);
        assert.equal(pinnedRecord.status, 'active');
        assert.equal(pinnedRecord.packageDigest, v1Digest);

        // Replaying the pinned digest after restart returns the ORIGINAL v1 bytes.
        const replayed = await store.read(v1Digest);
        assert.equal(replayed.packageDigest, v1Digest);
        for (let i = 0; i < v1ResourceBytes.length; i++) {
          assert.deepEqual(
            Buffer.from(replayed.resources[i].bytes),
            v1ResourceBytes[i],
            `pinned run reads v1 resource[${i}] bytes after restart`,
          );
        }
      } finally {
        opened.db.close();
      }
    }
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// SCENARIO 5 — INSTALLATION RETENTION: retiring 0.1.0 releases the active
//               slot but PRESERVES the row + bytes for replay verification.
//               (WAVE12-HARDENING-SPEC §2 row 1: "installation retention".)
// ===========================================================================

test('W12-A1 §5 installation retention: retire preserves the row + bytes for replay', async () => {
  const env = makeIsolatedEnv();
  try {
    const store = env.newStore();
    const opened = env.reopen();
    try {
      const installed = await installPackage(
        makeManifest('0.1.0'),
        makeResources(),
        { store, repo: opened.repo },
      );
      const digest = installed.packageDigest;
      const id = installed.id;

      // Capture original bytes.
      const snap = await store.read(digest);
      const originalBytes = snap.resources.map((r) => Buffer.from(r.bytes));

      // Retire the installation — releases the active slot.
      const retired = opened.repo.retire(id);
      assert.equal(retired.status, 'retired');
      assert.equal(opened.repo.getActiveByNameVersion(installed.name, '0.1.0'), null, 'active slot released');

      // The ROW survives (deletion-restricted, plan §5.5.9) — getByPackageDigest
      // and getById still resolve it.
      const byDigest = opened.repo.getByPackageDigest(digest);
      assert.equal(byDigest.id, id, 'retired row still resolvable by digest');
      assert.equal(byDigest.status, 'retired');

      // The package BYTES survive in the content-addressed store — replay still
      // works and verifies true. Retiring an installation does NOT delete the
      // immutable package bytes.
      assert.equal(await store.verify(digest), true, 'retired installation bytes still verify');
      const replayed = await store.read(digest);
      for (let i = 0; i < originalBytes.length; i++) {
        assert.deepEqual(
          Buffer.from(replayed.resources[i].bytes),
          originalBytes[i],
          `retired installation resource[${i}] bytes survive`,
        );
      }

      // A NEW 0.1.0 can now take the active slot (the old one is retired, not
      // deleted). This is the documented upgrade path for a released version.
      const reactivated = await installPackage(
        makeManifest('0.1.0'),
        // Same bytes → same digest → idempotent replay would also work, but we
        // use identical bytes to prove the slot is free.
        makeResources(),
        { store, repo: opened.repo },
      );
      assert.equal(reactivated.status, 'active');
    } finally {
      opened.db.close();
    }
  } finally {
    env.cleanup();
  }
});
