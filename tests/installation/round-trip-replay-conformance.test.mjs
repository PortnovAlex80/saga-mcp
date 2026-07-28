// @ts-check
/**
 * W2-A8 — Wave 2 exit-gate conformance: install → mutate source → replay → identical.
 *
 * Spec ref: `docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md`
 *   §0.5.12 / §6 exit gate (items 1–8), §1 (frozen layout), §4 (identity rules),
 *   §5.5.7 (corruption detection), §14.3.7 (legacy nullable adapter),
 *   §14.3.8 (replay-after-source-mutation), §14.4.7 (3rd module installs
 *   without catalog/Runtime/module edit).
 *
 * This single test file is THE Wave 2 exit-gate proof. It exercises the
 * immutable-installation layer end-to-end through the REAL adapters
 * (`FilesystemModulePackageStore` on a mkdtemp root, `SqliteModuleInstallationRepository`
 * on a mkdtemp better-sqlite3 Database) and asserts every §6 gate item:
 *
 *   1. Install the W2-A7 3rd synthetic module via installPackage(...) → active
 *      ModuleInstallationRecord.
 *   2. Replay-after-source-mutation (§6.2 / §14.3.8): after install, MUTATE the
 *      in-memory manifest + resource bytes; store.read(digest) MUST return the
 *      ORIGINAL bytes (immutability). The repo record is unchanged.
 *   3. Version collision (§6.3 / §4): install a DIFFERENT manifest under the
 *      same (name, version) → MODULE_INSTALLATION_VERSION_COLLISION.
 *   4. Pinned installation not nullifiable (§6.4 / §14.3.7): setPinnedInstallation
 *      stores the pin; getPinnedInstallation returns it; a legacy (NULL) run
 *      resolves via the fallback adapter.
 *   5. 3rd module installs without catalog/Runtime/module edit (§6.5 / §14.4.7):
 *      this file's IMPORT LIST IS THE PROOF — it pulls ONLY from
 *      installation/index.js (the Wave 2 barrel), domain/spi/index.js (Wave 1
 *      barrel), shared/canonical-json.js, the node: built-ins, and the fixture
 *      under tests/installation/fixtures/. It does NOT import modules/catalog.ts,
 *      modules/installations.ts, any module implementation, db.ts, or the
 *      composition root. (The dep-direction ratchet test enforces this
 *      statically across the repo; this file's import list is the human-readable
 *      counterpart.)
 *   6. Dependency lock resolves (§6.7): computeDependencyLock(manifest) yields a
 *      non-empty lock with one entry per resource/handler/contract ref.
 *   7. Corruption detection (§5.5.7 / §6 item implied): corrupt a stored
 *      resource file on disk → store.verify(digest) returns false → caller can
 *      mark the installation corrupt.
 *   8. describeInstallation (W2-A7): produces a correct summary of the record.
 *
 * INTEGRATION EXPECTATION: in the W2-A8 isolation worktree the sibling lanes
 * (A1..A7) are NOT cherry-picked yet, so the dynamic import of the barrel
 * resolves to a module that re-exports non-existent sibling files → the test
 * FAILS LOCALLY with unresolved-import. That is the EXPECTED W2-A8 outcome
 * (task file §"Verify"). The integrator runs the full Wave 2 gate after
 * cherry-picking A2→A1→A3→A5→A6→A4→A7→A8 in order (spec §8).
 *
 * Run: `node --test tests/installation/round-trip-replay-conformance.test.mjs`
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Frozen Wave 1 primitives — already built in this worktree (Wave 1 checkpoint 6a349a2).
import { canonicalJson, sha256Hex } from '../../dist/process-modules/shared/canonical-json.js';

// §14.4.7 PROOF — the import list. The ONLY imports are:
//   - the Wave 2 installation barrel (this lane's product),
//   - the Wave 1 SPI barrel (frozen),
//   - shared/canonical-json (frozen primitives),
//   - node: built-ins,
//   - the 3rd synthetic fixture (data only, under tests/installation/fixtures/).
// NO modules/catalog.ts, NO modules/installations.ts, NO module implementation,
// NO db.ts, NO composition root. The dep-direction ratchet test
// (tests/architecture/dependency-direction.test.mjs) enforces this statically;
// the named imports below are the human-readable counterpart.
const {
  // Wave 1 SPI — manifest construction + validation + legacy adapter
  validateProcessModuleManifest,
  adaptLegacyProcessModule,
  assertCanonicalSerializable,
} = await import('../../dist/process-modules/domain/spi/index.js');

// Wave 2 barrel — pulls every sibling symbol (resolved at integration after
// A2→A1→A3→A5→A6→A4→A7 are cherry-picked; unresolved-import in A8 isolation).
const {
  // W2-A1 — store + adapter
  FilesystemModulePackageStore,
  // W2-A2 — record + repo + schema
  SqliteModuleInstallationRepository,
  ensureSaga3ModuleInstallationSchema,
  MODULE_INSTALLATION_VERSION_COLLISION,
  // W2-A3 — installer + dependency lock
  installPackage,
  computeDependencyLock,
  // W2-A4 — pinning + legacy adapter
  ProcessRunInstallationAdapter,
  pinInstallationOnProcessRun,
  // W2-A5 — package registry (legacy fallback resolves via name+version)
  InstallationBasedPackageRegistry,
  // W2-A7 — describe
  describeInstallation,
} = await import('../../dist/process-modules/installation/index.js');

// Better-sqlite3 is an existing production dependency. The W2-A2 adapter is
// constructed with a raw `Database` handle; we mirror that here on a mkdtemp DB.
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// 3rd synthetic fixture (W2-A7) — data-only, loaded for the no-catalog-install proof.
// ---------------------------------------------------------------------------
//
// The W2-A7 3rd synthetic module ships at:
//   tests/installation/fixtures/3rd-synthetic-module/definition.mjs
//                              (+ manifest.json + 1–2 resource files)
// It mirrors the W0-A7 lm-marketing pattern: a `ProcessModuleDefinition`-shaped
// object + a `resourceIndex` array (paths relative to the fixture dir) + small
// resource files. We load it dynamically and compose the installable manifest
// here, exactly as the W1-A8 conformance test composed manifests from W0-A7.
//
// `assertCanonicalSerializable` is invoked on the composed manifest before we
// hand it to the installer (the installer re-validates, but we surface fixture
// drift early with a clearer error).
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', '3rd-synthetic-module');
const FIXTURE_URL = pathToFileURL(path.join(FIXTURE_DIR, 'definition.mjs')).href;

/**
 * Compose the installable manifest + resource blobs from the W2-A7 3rd fixture.
 *
 * @returns {{ manifest: any; resources: any[]; fixtureIdentity: { name: string; version: string } }}
 */
async function loadThirdSyntheticFixture() {
  /** @type {any} */
  const fixture = await import(FIXTURE_URL);
  if (!fixture || !fixture.default) {
    throw new Error(
      `W2-A7 3rd synthetic fixture not found or malformed at ${FIXTURE_URL}. ` +
        `Expected a 'default' export (ProcessModuleDefinition) + a 'resourceIndex' export. ` +
        `(In W2-A8 isolation this means W2-A7 has not been cherry-picked yet.)`,
    );
  }
  const definition = fixture.default;
  const resourceIndex = Array.isArray(fixture.resourceIndex) ? fixture.resourceIndex : [];

  // Wrap the legacy definition into a manifest envelope (Wave 1 pattern).
  // Then ENRICH resourceIndex/handlerRefs from the fixture's declared resources
  // — adaptLegacyProcessModule emits empty arrays; the 3rd fixture carries
  // real resources to prove resource resolution (W2-A7 task).
  const manifest = adaptLegacyProcessModule(definition);
  manifest.resourceIndex = resourceIndex.map((r) => ({
    logicalId: r.logicalId,
    path: r.path,
    kind: r.kind,
    // Wave 2 accepts the placeholder digest sentinel (W2-A3 task): real
    // ContractSchemaRegistry resolution is Wave 3+.
    digest: r.digest ?? 'pending@wave-2',
  }));
  manifest.handlerRefs = (definition.flow?.nodes ?? [])
    .filter((n) => typeof n.handler === 'string')
    .map((n) => {
      // handler strings look like 'analytics-compute-handler@1.0.0'
      const [logicalId, version] = String(n.handler).split('@');
      return { logicalId, version: version ?? '0.0.0', digest: 'pending@wave-2' };
    });

  // Belt-and-suspenders: the fixture must be canonical-serializable before install.
  assertCanonicalSerializable(manifest);
  const validation = validateProcessModuleManifest(manifest);
  assert.equal(
    validation.ok,
    true,
    `W2-A7 3rd synthetic fixture manifest failed validation: ${JSON.stringify(validation.errors)}`,
  );

  // Read each declared resource's bytes from the fixture dir (proves resource
  // resolution from the package root, plan §5.3).
  const resources = resourceIndex.map((r) => {
    const abs = path.join(FIXTURE_DIR, r.path);
    const bytes = Buffer.from(readFileSync(abs));
    return {
      logicalId: r.logicalId,
      kind: r.kind,
      bytes,
      digest: sha256Hex(bytes),
    };
  });

  return {
    manifest,
    resources,
    fixtureIdentity: {
      name: definition.identity.name,
      version: definition.identity.version,
    },
  };
}

// ---------------------------------------------------------------------------
// Test harness: mkdtemp store root + mkdtemp sqlite DB with the Wave 2 schema.
// ---------------------------------------------------------------------------

/**
 * Create a fresh, isolated environment for one install run:
 *   - mkdtemp directory for FilesystemModulePackageStore
 *   - mkdtemp .db file with ensureSaga3ModuleInstallationSchema(db) applied
 *   - a minimal saga3_process_runs-shaped table for the W2-A4 pinning proof
 *
 * Returns cleanup hooks. NEVER shares a DB/root across tests (spec §9).
 */
function makeIsolatedEnv() {
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'w2a8-store-'));
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), 'w2a8-db-')), 'installations.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // W2-A2 owns the installations table DDL; apply it directly on our raw
  // connection. (In production, db.ts calls this in the getDb() chain.)
  ensureSaga3ModuleInstallationSchema(db);
  // Minimal process_runs-like table for the W2-A4 legacy-adapter proof. The
  // W2-A4 adapter reads installation_id/package_digest via raw SQL; a minimal
  // table with those columns (plus module_name/module_version for the legacy
  // fallback) is sufficient to prove §14.3.7. The real saga3_process_runs table
  // is owned by sqlite-process-run-repository.ts (NOT imported here — §14.4.7).
  db.exec(`
    CREATE TABLE IF NOT EXISTS saga3_process_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module_name TEXT NOT NULL,
      module_version TEXT NOT NULL,
      installation_id INTEGER,
      package_digest TEXT
    );
  `);
  const store = new FilesystemModulePackageStore(storeRoot);
  const repo = new SqliteModuleInstallationRepository(db);
  const runAdapter = new ProcessRunInstallationAdapter(db);
  return {
    storeRoot,
    dbPath,
    db,
    store,
    repo,
    runAdapter,
    cleanup() {
      try { db.close(); } catch { /* already closed */ }
      try { rmSync(storeRoot, { recursive: true, force: true }); } catch { /* gone */ }
      try { rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* gone */ }
    },
  };
}

// ---------------------------------------------------------------------------
// §6 item 1 + §14.4.7 — install the 3rd synthetic module end-to-end.
// ---------------------------------------------------------------------------

let sharedEnv;
let sharedRecord;
let sharedFixture;

test('§6.1 + §14.4.7: 3rd synthetic installs via real store+repo without catalog/Runtime/module edit', async () => {
  sharedFixture = await loadThirdSyntheticFixture();
  sharedEnv = makeIsolatedEnv();
  try {
    const record = await installPackage(
      sharedFixture.manifest,
      sharedFixture.resources,
      { store: sharedEnv.store, repo: sharedEnv.repo },
    );
    sharedRecord = record;

    // §6 item 1: returns an active record.
    assert.equal(record.status, 'active', 'installed record is active');
    assert.ok(record.id != null, 'record has an id');
    assert.equal(record.name, sharedFixture.fixtureIdentity.name);
    assert.equal(record.version, sharedFixture.fixtureIdentity.version);
    assert.match(record.packageDigest, /^[0-9a-f]{64}$/, 'packageDigest is sha256 hex');
    assert.ok(record.installedAt, 'installedAt set');
    assert.ok(record.activatedAt, 'activatedAt set');

    // The package is content-addressed in the store.
    const exists = await sharedEnv.store.exists(record.packageDigest);
    assert.equal(exists, true, 'package present in store after install');

    // The repo persisted the record and can find it by digest.
    const byDigest = sharedEnv.repo.getByPackageDigest(record.packageDigest);
    assert.equal(byDigest.id, record.id);
    assert.equal(byDigest.packageDigest, record.packageDigest);
  } catch (err) {
    sharedEnv.cleanup();
    throw err;
  }
});

// ---------------------------------------------------------------------------
// §6 item 2 + §14.3.8 — replay-after-source-mutation: stored bytes are immutable.
// ---------------------------------------------------------------------------

test('§6.2 + §14.3.8: mutating in-memory source after install does NOT change stored bytes (immutability)', async () => {
  assert.ok(sharedRecord, 'depends on the install test');
  const originalDigest = sharedRecord.packageDigest;

  // Read the stored package BEFORE mutation — capture canonical snapshot.
  const before = await sharedEnv.store.read(originalDigest);
  const beforeManifestJson = canonicalJson(before.manifest);
  const beforeResourceBytes = before.resources.map((r) => ({
    logicalId: r.logicalId,
    bytes: Buffer.from(r.bytes),
  }));

  // MUTATE the in-memory source (the caller's manifest + resource bytes).
  // This must NOT propagate into the store — the store is content-addressed
  // by the ORIGINAL digest and is immutable.
  sharedFixture.manifest.definition.identity.displayName = 'MUTATED Display Name';
  sharedFixture.manifest.runtimeCompatibilityRange = '>=99.0.0 <100.0.0';
  if (sharedFixture.resources.length > 0) {
    const r = sharedFixture.resources[0];
    // Flip bytes in memory.
    const mutated = Buffer.from(r.bytes);
    mutated[0] = mutated[0] ^ 0xff;
    r.bytes = mutated;
    r.digest = sha256Hex(mutated);
  }

  // The store still returns the ORIGINAL package for the original digest.
  const after = await sharedEnv.store.read(originalDigest);
  assert.equal(canonicalJson(after.manifest), beforeManifestJson, 'stored manifest unchanged');
  assert.equal(
    after.resources.length,
    beforeResourceBytes.length,
    'stored resource count unchanged',
  );
  for (let i = 0; i < beforeResourceBytes.length; i++) {
    assert.deepEqual(
      Buffer.from(after.resources[i].bytes),
      beforeResourceBytes[i].bytes,
      `stored resource[${i}] bytes unchanged`,
    );
  }
  assert.equal(after.packageDigest, originalDigest, 'stored packageDigest unchanged');

  // The repo record is unchanged too.
  const recordAgain = sharedEnv.repo.getByPackageDigest(originalDigest);
  assert.equal(recordAgain.packageDigest, originalDigest);
  assert.equal(recordAgain.status, 'active');

  // verify() still true (we did not touch disk).
  const verified = await sharedEnv.store.verify(originalDigest);
  assert.equal(verified, true, 'store.verify true after in-memory mutation (disk untouched)');
});

// ---------------------------------------------------------------------------
// §6 item 3 + §4 — version collision: different digest under active (name, version).
// ---------------------------------------------------------------------------

test('§6.3 + §4: installing a DIFFERENT manifest under the same (name, version) is rejected', async () => {
  assert.ok(sharedRecord, 'depends on the install test');

  // Build a DIFFERENT manifest that collides on (name, version) but whose
  // content differs → different packageDigest.
  const colliding = adaptLegacyProcessModule({
    ...sharedFixture.manifest.definition,
    identity: {
      ...sharedFixture.manifest.definition.identity,
      // SAME name + version as the installed record (collision target).
      name: sharedFixture.fixtureIdentity.name,
      version: sharedFixture.fixtureIdentity.version,
      // DIFFERENT content (displayName already differs is not enough for the
      // store digest because digest is over manifest+resources; we change the
      // outcome list to guarantee a different canonical manifest).
    },
    outcomes: [
      ...(sharedFixture.manifest.definition.outcomes ?? []),
      { code: 'extra-collision-marker', description: 'forces a different digest', terminal: true },
    ],
  });
  // Same resourceIndex/handlerRefs shape, but the manifest content is now
  // different → computeDependencyLock + store.store will yield a different digest.
  colliding.resourceIndex = sharedFixture.manifest.resourceIndex;
  colliding.handlerRefs = sharedFixture.manifest.handlerRefs;

  let threw = false;
  let caughtCode = null;
  try {
    await installPackage(
      colliding,
      // Re-encode the original resources from the fixture (fresh Buffer for isolation).
      sharedFixture.resources.map((r) => ({
        logicalId: r.logicalId,
        kind: r.kind,
        bytes: Buffer.from(r.bytes),
        digest: r.digest,
      })),
      { store: sharedEnv.store, repo: sharedEnv.repo },
    );
  } catch (err) {
    threw = true;
    caughtCode = err && (err.code ?? err.errorCode ?? err.name);
    // Accept either the symbolic constant (string) or an Error carrying it.
    const code = String(caughtCode);
    assert.ok(
      code.includes(MODULE_INSTALLATION_VERSION_COLLISION) ||
        code.includes('MODULE_INSTALLATION_VERSION_COLLISION'),
      `expected MODULE_INSTALLATION_VERSION_COLLISION, got: ${code} (message: ${err && err.message})`,
    );
  }
  assert.equal(threw, true, 'collision install must throw');

  // The ORIGINAL active record is still intact (no silent replacement).
  const stillThere = sharedEnv.repo.getByPackageDigest(sharedRecord.packageDigest);
  assert.equal(stillThere.id, sharedRecord.id);
  assert.equal(stillThere.status, 'active');
});

// ---------------------------------------------------------------------------
// §6 item 4 + §14.3.7 — ProcessRun pinning + legacy NULL adapter.
// ---------------------------------------------------------------------------

test('§6.4 + §14.3.7: pinned installation round-trips; legacy NULL run resolves via fallback', () => {
  assert.ok(sharedRecord, 'depends on the install test');
  const db = sharedEnv.db;
  const adapter = sharedEnv.runAdapter;

  // Insert a NEW process_runs row to pin.
  const insertRun = db.prepare(
    `INSERT INTO saga3_process_runs (module_name, module_version) VALUES (?, ?)`,
  );
  const info = insertRun.run(sharedRecord.name, sharedRecord.version);
  const runId = Number(info.lastInsertRowid);

  // Pin it.
  const pin = pinInstallationOnProcessRun(runId, sharedRecord.id, sharedRecord.packageDigest);
  assert.equal(pin.processRunId, runId);
  assert.equal(pin.installationId, sharedRecord.id);
  assert.equal(pin.packageDigest, sharedRecord.packageDigest);

  adapter.setPinnedInstallation(runId, sharedRecord.id, sharedRecord.packageDigest);

  // Read it back.
  const readBack = adapter.getPinnedInstallation(runId);
  assert.ok(readBack, 'pinned installation is retrievable');
  assert.equal(readBack.installationId, sharedRecord.id);
  assert.equal(readBack.packageDigest, sharedRecord.packageDigest);

  // Insert a LEGACY row (NULL installation_id) → getPinnedInstallation returns
  // null, and resolveInstallationForLegacyRun must fall back to the registry
  // by name+version (§14.3.7 compatibility path).
  const legacyInfo = insertRun.run(sharedRecord.name, sharedRecord.version);
  const legacyRunId = Number(legacyInfo.lastInsertRowid);
  // Explicitly clear (defensive — the column defaults to NULL).
  db.prepare(`UPDATE saga3_process_runs SET installation_id = NULL, package_digest = NULL WHERE id = ?`)
    .get(legacyRunId);

  const legacyPin = adapter.getPinnedInstallation(legacyRunId);
  assert.equal(legacyPin, null, 'legacy run has no pin');

  // Build a fallback PackageRegistry backed by the repo + the active record.
  const fallback = new InstallationBasedPackageRegistry(sharedEnv.repo);
  const resolved = adapter.resolveInstallationForLegacyRun(legacyRunId, fallback);
  assert.ok(resolved, 'legacy run resolves via the fallback registry');
  assert.equal(resolved.id, sharedRecord.id, 'legacy fallback resolves to the active installation');
});

// ---------------------------------------------------------------------------
// §6 item 6 — dependency lock is non-empty with one entry per ref.
// ---------------------------------------------------------------------------

test('§6.6: computeDependencyLock yields one entry per resource/handler/contract ref', () => {
  assert.ok(sharedFixture, 'depends on the install test');
  const lock = computeDependencyLock(sharedFixture.manifest);
  assert.ok(lock, 'lock produced');
  assert.ok(Array.isArray(lock.entries), 'lock.entries is an array');
  assert.ok(lock.entries.length > 0, 'lock is non-empty');

  // One entry per resource.
  const resourceEntries = lock.entries.filter((e) => e.refKind === 'resource');
  assert.equal(
    resourceEntries.length,
    sharedFixture.manifest.resourceIndex.length,
    'one resource lock entry per resourceIndex entry',
  );
  for (const e of resourceEntries) {
    assert.ok(e.logicalId, 'resource entry has logicalId');
    assert.ok(typeof e.digest === 'string', 'resource entry has a digest');
  }

  // One entry per handler.
  const handlerEntries = lock.entries.filter((e) => e.refKind === 'handler');
  assert.equal(
    handlerEntries.length,
    sharedFixture.manifest.handlerRefs.length,
    'one handler lock entry per handlerRef',
  );

  // One entry per contract ref (input + output at minimum).
  const contractEntries = lock.entries.filter((e) => e.refKind === 'contract');
  assert.ok(
    contractEntries.length >= 2,
    `at least input+output contract entries (got ${contractEntries.length})`,
  );

  // Lock digest is a stable sha256 hex over the canonical entry list.
  assert.match(lock.lockDigest, /^[0-9a-f]{64}$/, 'lockDigest is sha256 hex');
  const recomputed = computeDependencyLock(sharedFixture.manifest);
  assert.equal(recomputed.lockDigest, lock.lockDigest, 'lockDigest is deterministic');
});

// ---------------------------------------------------------------------------
// §5.5.7 + §6 (implied) — corruption detection: mutate stored file → verify false.
// ---------------------------------------------------------------------------

test('§5.5.7: corrupting a stored resource file on disk flips store.verify to false', async () => {
  assert.ok(sharedRecord, 'depends on the install test');
  const digest = sharedRecord.packageDigest;

  // verify is true before tampering.
  const okBefore = await sharedEnv.store.verify(digest);
  assert.equal(okBefore, true, 'verify true before corruption');

  // Locate the stored package dir. The W2-A1 layout is content-addressed:
  //   <root>/<digest-prefix>/<full-digest>/resources/<logicalId-slug>
  // We corrupt the first resource file we can find by scanning the package dir.
  const { readdirSync } = await import('node:fs');
  // The store exposes read(); we use the resource list to know the logicalIds,
  // but to corrupt on disk we walk the content-addressed directory.
  const pkg = await sharedEnv.store.read(digest);
  assert.ok(pkg.resources.length > 0, 'fixture has at least one stored resource');

  // Find the package directory by the digest (2-char prefix sharding per W2-A1).
  const prefix2 = digest.slice(0, 2);
  const prefix4 = digest.slice(0, 4);
  const candidates = [
    path.join(sharedEnv.storeRoot, prefix2, digest),
    path.join(sharedEnv.storeRoot, prefix2, prefix4, digest),
    // Some implementations may use a flatter layout; scan the prefix dir.
  ];
  let pkgDir = null;
  for (const c of candidates) {
    try {
      readdirSync(c);
      pkgDir = c;
      break;
    } catch { /* not this layout */ }
  }
  if (!pkgDir) {
    // Fall back: scan the prefix dir for the digest folder.
    const prefixDir = path.join(sharedEnv.storeRoot, prefix2);
    try {
      for (const entry of readdirSync(prefixDir)) {
        if (entry === digest || entry.endsWith(digest)) {
          pkgDir = path.join(prefixDir, entry);
          break;
        }
      }
    } catch { /* ignore */ }
  }
  assert.ok(pkgDir, `could not locate package dir for digest ${digest} under ${sharedEnv.storeRoot}`);

  const resourcesDir = path.join(pkgDir, 'resources');
  let resourceFiles = [];
  try {
    resourceFiles = readdirSync(resourcesDir).map((f) => path.join(resourcesDir, f));
  } catch {
    // If 'resources' subdir absent, the adapter may have used a flat layout;
    // corrupt the first non-manifest, non-meta file in pkgDir.
    resourceFiles = readdirSync(pkgDir)
      .filter((f) => !f.endsWith('.json'))
      .map((f) => path.join(pkgDir, f));
  }
  assert.ok(resourceFiles.length > 0, 'found at least one stored resource file to corrupt');

  const target = resourceFiles[0];
  const original = readFileSync(target);
  // Flip the first byte (or append if empty).
  const corrupted = Buffer.from(original);
  if (corrupted.length > 0) {
    corrupted[0] = corrupted[0] ^ 0xff;
  } else {
    corrupted.push(0x00);
  }
  writeFileSync(target, corrupted);

  // verify MUST now return false (caller flips status to 'corrupt').
  const okAfter = await sharedEnv.store.verify(digest);
  assert.equal(okAfter, false, 'verify false after on-disk corruption');

  // The caller (installer / repository) marks the installation corrupt.
  sharedEnv.repo.markCorrupt(sharedRecord.id);
  const corruptedRecord = sharedEnv.repo.getById(sharedRecord.id);
  assert.equal(corruptedRecord.status, 'corrupt', 'installation status flips to corrupt');

  // Restore the file so the cleanup + sibling tests are not affected.
  writeFileSync(target, original);
});

// ---------------------------------------------------------------------------
// W2-A7 + §12.1 — describeInstallation projects the record correctly.
// ---------------------------------------------------------------------------

test('W2-A7 + §12.1: describeInstallation projects the installed record', () => {
  assert.ok(sharedRecord, 'depends on the install test');
  const desc = describeInstallation(sharedRecord);
  assert.ok(desc, 'description produced');
  assert.equal(desc.name, sharedRecord.name);
  assert.equal(desc.version, sharedRecord.version);
  assert.equal(desc.packageDigest, sharedRecord.packageDigest);
  assert.equal(
    desc.resourceCount,
    sharedRecord.resourceIndex.length,
    'resourceCount matches record.resourceIndex length',
  );
  assert.equal(
    desc.handlerCount,
    sharedRecord.handlerRefs.length,
    'handlerCount matches record.handlerRefs length',
  );
  // Deterministic projection: same record → same description (name/version/digest).
  const desc2 = describeInstallation(sharedRecord);
  assert.equal(desc2.name, desc.name);
  assert.equal(desc2.version, desc.version);
  assert.equal(desc2.packageDigest, desc.packageDigest);
});

// ---------------------------------------------------------------------------
// Cleanup after the whole suite (sharedEnv created in the first test).
// ---------------------------------------------------------------------------

test('cleanup: tear down the shared install env', () => {
  if (sharedEnv) {
    sharedEnv.cleanup();
    sharedEnv = undefined;
  }
  assert.ok(true, 'shared env cleaned up');
});
