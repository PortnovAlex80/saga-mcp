// tests/installation/installation-repository.test.mjs
//
// W2-A2 — SqliteModuleInstallationRepository tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md
//       §3 (schema), §4 (identity rules), §5.5.9 (deletion restriction).
// Task: docs/refactor-management/05-subagent-tasks/W02-A2-installation-repository-sql-owner.md.
//
// Coverage:
//   - Schema creation is idempotent (constructor safe to call twice; ensureFactoryModuleInstallationSchema re-runnable).
//   - Positive: insert staged → getById returns it; activate → status='active'; getByPackageDigest;
//     getActiveByNameVersion; listActive; retire; markCorrupt.
//   - Version immutability (spec §4): inserting a second active row for the same (name, version) with a
//     DIFFERENT packageDigest → MODULE_INSTALLATION_VERSION_COLLISION.
//   - Idempotent replay: same (name, version, packageDigest) already active → returns existing row.
//   - Activation collision: activating a second row for an already-active (name, version) → COLLISION.
//   - NOT_FOUND: getById / activate / retire / markCorrupt on unknown id → MODULE_INSTALLATION_NOT_FOUND.
//   - Structural: the partial UNIQUE index catches a direct INSERT bypassing the repo (defence-in-depth).
//   - Deletion restriction: the repository exposes NO delete method (plan §5.5.9).
//   - Serialization round-trip: manifestSnapshot / resourceIndex / handlerRefs / dependencyLock survive
//     canonicalJson → TEXT → JSON.parse unchanged.
//   - getDb() wiring: the factory_module_installations table + the two factory_process_runs ALTERs land via
//     getDb() (the db.ts edit this lane owns).
//
// Tests run against the COMPILED dist/ output. Uses process.env.DB_PATH = mkdtempSync(...)
// (existing pattern) — each test gets an isolated DB.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// dist/ imports — mirrors tests/process-modules/process-run-lifecycle.test.mjs.
const { closeDb, getDb } = await import('../../dist/db.js');
const {
  SqliteModuleInstallationRepository,
  ensureFactoryModuleInstallationSchema,
} = await import('../../dist/process-modules/installation/persistence/installation-repository.js');
const {
  MODULE_INSTALLATION_VERSION_COLLISION,
  MODULE_INSTALLATION_NOT_FOUND,
  MODULE_INSTALLATION_CORRUPT,
  asModuleInstallationId,
} = await import('../../dist/process-modules/installation/domain/installation.js');
const { canonicalJson, sha256Hex } = await import('../../dist/shared/canonical-json.js');
const { lmMarketingModule } = await import('../../tests/fixtures/synthetic-modules/lm-marketing/definition.mjs');

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

function makeContractRef(schemaId) {
  return { schemaId, version: '1.0.0', digest: 'pending@wave-2' };
}

/** A valid ProcessModuleManifest wrapping the W0-A7 lm-marketing definition. */
function makeManifest({ name = 'synthetic-lm-marketing', version = '0.1.0' } = {}) {
  return {
    manifestFormatVersion: '0.1.0',
    definition: { ...lmMarketingModule, identity: { ...lmMarketingModule.identity, name, version } },
    resourceIndex: [
      { logicalId: 'semantic-skill', path: 'skills/synthetic-marketing-skill.md', kind: 'skill', digest: 'pending@wave-2' },
      { logicalId: 'campaign-template', path: 'templates/campaign-draft-template.md', kind: 'template', digest: 'pending@wave-2' },
    ],
    handlerRefs: [
      { logicalId: 'draft-handler', version: '1.0.0', digest: 'pending@wave-2' },
    ],
    inputContractRef: makeContractRef('synthetic.marketing.input.v1'),
    outputContractRef: makeContractRef('synthetic.marketing.output.v1'),
    runtimeCompatibilityRange: '^3.0.0',
  };
}

/** Compute a deterministic package_digest for a manifest + resources. */
function computeDigest(manifest, salt = '') {
  return sha256Hex({ manifest, salt });
}

/** Build the Omit<id,...> insert input for a fresh installation. */
function buildInsertInput({
  name = 'synthetic-lm-marketing',
  version = '0.1.0',
  digest = computeDigest(makeManifest({ name, version })),
  status = 'staged',
  storeLocation = `file://store/${name}/${version}/${digest}`,
} = {}) {
  const manifest = makeManifest({ name, version });
  return {
    name,
    version,
    packageDigest: digest,
    manifestSnapshot: manifest,
    storeLocation,
    resourceIndex: manifest.resourceIndex,
    handlerRefs: manifest.handlerRefs,
    dependencyLock: { resolved: {}, version: 'lock-0.1.0' },
    status,
  };
}

/** Spin up a fresh temp DB. */
function freshDb() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-inst-'));
  process.env.DB_PATH = path.join(temp, 'installations.db');
  const db = getDb();
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

// ===========================================================================
// Schema creation
// ===========================================================================

test('schema creation is idempotent — ensureFactoryModuleInstallationSchema re-runnable', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-inst-'));
  process.env.DB_PATH = path.join(temp, 'installations.db');
  try {
    const db = getDb();
    // Calling twice must not throw (CREATE TABLE/INDEX IF NOT EXISTS).
    assert.doesNotThrow(() => ensureFactoryModuleInstallationSchema(db));
    assert.doesNotThrow(() => ensureFactoryModuleInstallationSchema(db));
    // Table + both indexes exist.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factory_module_installations'").get();
    assert.ok(tables, 'factory_module_installations table created');
    const idxActive = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_factory_module_installations_active'").get();
    assert.ok(idxActive, 'partial UNIQUE active index created');
    const idxDigest = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_factory_module_installations_digest'").get();
    assert.ok(idxDigest, 'digest index created');
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('constructor is safe to call twice against the same db', () => {
  const { temp, db } = freshDb();
  try {
    assert.doesNotThrow(() => new SqliteModuleInstallationRepository(db));
    assert.doesNotThrow(() => new SqliteModuleInstallationRepository(db));
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Positive: insert / getById / activate / getByPackageDigest / listActive
// ===========================================================================

test('insert staged → getById returns the record with db-assigned id', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const input = buildInsertInput();
    const rec = repo.insert(input);
    assert.equal(rec.name, input.name);
    assert.equal(rec.version, input.version);
    assert.equal(rec.packageDigest, input.packageDigest);
    assert.equal(rec.status, 'staged');
    assert.equal(typeof rec.id, 'number');
    assert.ok(rec.id > 0);
    assert.ok(rec.installedAt, 'installedAt set');

    const got = repo.getById(rec.id);
    assert.deepEqual(got, rec);
  } finally {
    cleanup(temp);
  }
});

test('activate transitions staged → active and sets activatedAt; listActive returns it', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const rec = repo.insert(buildInsertInput());
    assert.equal(rec.status, 'staged');

    const activated = repo.activate(rec.id);
    assert.equal(activated.status, 'active');
    assert.ok(activated.activatedAt, 'activatedAt set on activation');

    // listActive returns it, ordered by (name, version).
    const active = repo.listActive();
    assert.equal(active.length, 1);
    assert.equal(active[0].id, activated.id);

    // getActiveByNameVersion resolves it.
    const byName = repo.getActiveByNameVersion(rec.name, rec.version);
    assert.deepEqual(byName, activated);
  } finally {
    cleanup(temp);
  }
});

test('activate is idempotent — activating an already-active row is a no-op', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const rec = repo.insert(buildInsertInput());
    const first = repo.activate(rec.id);
    const second = repo.activate(rec.id);
    assert.deepEqual(second, first);
    assert.equal(second.status, 'active');
  } finally {
    cleanup(temp);
  }
});

test('getByPackageDigest resolves the record', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const rec = repo.insert(buildInsertInput({ digest: 'deadbeef'.repeat(8, 16).slice(0, 64) }));
    const got = repo.getByPackageDigest(rec.packageDigest);
    assert.deepEqual(got, rec);
    assert.equal(repo.getByPackageDigest('unknown-digest'), null);
  } finally {
    cleanup(temp);
  }
});

test('retire transitions active → retired and sets retiredAt; listActive drops it', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const rec = repo.insert(buildInsertInput());
    repo.activate(rec.id);
    const retired = repo.retire(rec.id);
    assert.equal(retired.status, 'retired');
    assert.ok(retired.retiredAt, 'retiredAt set');
    assert.equal(repo.listActive().length, 0);
    // The row is preserved (deletion-restricted, plan §5.5.9).
    assert.deepEqual(repo.getById(rec.id), retired);
  } finally {
    cleanup(temp);
  }
});

test('markCorrupt flips status to corrupt (replay-verification failure path)', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const rec = repo.insert(buildInsertInput());
    const corrupt = repo.markCorrupt(rec.id);
    assert.equal(corrupt.status, 'corrupt');
    // A corrupt installation must NOT appear in listActive.
    assert.equal(repo.listActive().length, 0);
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Version immutability (spec §4)
// ===========================================================================

test('insert active with DIFFERENT digest under same (name,version) → COLLISION', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const first = repo.insert(buildInsertInput({
      status: 'active',
      digest: 'a'.repeat(64),
    }));
    assert.equal(first.status, 'active');

    // Second active insert, same (name, version), DIFFERENT digest.
    assert.throws(
      () => repo.insert(buildInsertInput({
        status: 'active',
        digest: 'b'.repeat(64),
      })),
      (err) => err.message.includes(MODULE_INSTALLATION_VERSION_COLLISION),
      'expected MODULE_INSTALLATION_VERSION_COLLISION',
    );
    // Only one row in the table.
    assert.equal(repo.listActive().length, 1);
  } finally {
    cleanup(temp);
  }
});

test('insert active with SAME digest under same (name,version) → idempotent replay', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const digest = 'c'.repeat(64);
    const first = repo.insert(buildInsertInput({ status: 'active', digest }));
    const second = repo.insert(buildInsertInput({ status: 'active', digest }));
    // Idempotent: returns the existing active row, no new row created.
    assert.deepEqual(second, first);
    assert.equal(repo.listActive().length, 1);
  } finally {
    cleanup(temp);
  }
});

test('multiple staged rows for the same (name,version) are allowed (UNIQUE is partial on active)', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    repo.insert(buildInsertInput({ status: 'staged', digest: 'd'.repeat(64) }));
    assert.doesNotThrow(() => repo.insert(buildInsertInput({ status: 'staged', digest: 'e'.repeat(64) })));
    // Neither is active yet.
    assert.equal(repo.listActive().length, 0);
  } finally {
    cleanup(temp);
  }
});

test('activate a second row when another already holds the active slot → COLLISION', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    // First row: staged → activate.
    const a = repo.insert(buildInsertInput({ status: 'staged', digest: 'f'.repeat(64) }));
    repo.activate(a.id);
    // Second row: staged, same (name, version), different digest.
    const b = repo.insert(buildInsertInput({ status: 'staged', digest: '1'.repeat(64) }));
    assert.throws(
      () => repo.activate(b.id),
      (err) => err.message.includes(MODULE_INSTALLATION_VERSION_COLLISION),
      'activating a second row under an occupied active slot must collide',
    );
    // b stays staged.
    assert.equal(repo.getById(b.id).status, 'staged');
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// NOT_FOUND
// ===========================================================================

test('getById on unknown id → null (not a throw; lookup miss)', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    assert.equal(repo.getById(asModuleInstallationId(999999)), null);
  } finally {
    cleanup(temp);
  }
});

test('activate on unknown id → MODULE_INSTALLATION_NOT_FOUND', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    assert.throws(
      () => repo.activate(asModuleInstallationId(999999)),
      (err) => err.message.includes(MODULE_INSTALLATION_NOT_FOUND),
    );
  } finally {
    cleanup(temp);
  }
});

test('retire on unknown id → MODULE_INSTALLATION_NOT_FOUND', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    assert.throws(
      () => repo.retire(asModuleInstallationId(999999)),
      (err) => err.message.includes(MODULE_INSTALLATION_NOT_FOUND),
    );
  } finally {
    cleanup(temp);
  }
});

test('markCorrupt on unknown id → MODULE_INSTALLATION_NOT_FOUND', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    assert.throws(
      () => repo.markCorrupt(asModuleInstallationId(999999)),
      (err) => err.message.includes(MODULE_INSTALLATION_NOT_FOUND),
    );
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Structural: the partial UNIQUE index catches a bypassing direct INSERT
// ===========================================================================

test('direct INSERT bypassing the repo is caught by the partial UNIQUE index', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    repo.insert(buildInsertInput({ status: 'active', digest: 'aa'.repeat(32) }));

    // Raw INSERT of a SECOND active row for the same (name, version) must be
    // rejected by the SQL itself (defence-in-depth — the repo pre-check is the
    // primary guard, the index is the structural backstop).
    assert.throws(
      () => db.prepare(
        `INSERT INTO factory_module_installations
           (name, version, package_digest, manifest_snapshot, store_location,
            resource_index, handler_refs, dependency_lock, status, installed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        'synthetic-lm-marketing',
        '0.1.0',
        'bb'.repeat(32),
        '{}',
        'loc',
        '[]',
        '[]',
        '{}',
        'active',
        new Date().toISOString(),
      ),
      (err) => /UNIQUE/i.test(err.message),
      'the partial UNIQUE index must reject a second active row',
    );
  } finally {
    cleanup(temp);
  }
});

test('a retired row does NOT collide with a new active row for the same (name,version)', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const first = repo.insert(buildInsertInput({ status: 'active', digest: 'cc'.repeat(32) }));
    repo.retire(first.id);
    // Now a DIFFERENT digest can take the active slot — the retired row is
    // no longer 'active', so the partial index does not see it.
    const second = repo.insert(buildInsertInput({ status: 'active', digest: 'dd'.repeat(32) }));
    assert.equal(second.status, 'active');
    assert.equal(repo.listActive().length, 1);
    assert.equal(repo.listActive()[0].id, second.id);
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Deletion restriction (plan §5.5.9)
// ===========================================================================

test('the repository exposes NO delete method (deletion-restricted, plan §5.5.9)', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    assert.equal(typeof repo.delete, 'undefined', 'no delete method on SqliteModuleInstallationRepository');
    assert.equal(typeof repo.remove, 'undefined', 'no remove method either');
    assert.equal(typeof repo.destroy, 'undefined');
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Serialization round-trip (canonicalJson → TEXT → JSON.parse)
// ===========================================================================

test('manifestSnapshot / resourceIndex / handlerRefs / dependencyLock round-trip unchanged', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteModuleInstallationRepository(db);
    const manifest = makeManifest();
    const input = buildInsertInput();
    input.manifestSnapshot = manifest;
    input.dependencyLock = { resolved: { contractA: 'digest-a', handlerB: 'digest-b' }, version: 'lock-0.1.0' };

    const rec = repo.insert(input);
    // Deep-equal: the parsed-back fields equal the originals.
    assert.deepEqual(rec.manifestSnapshot, manifest);
    assert.deepEqual(rec.resourceIndex, manifest.resourceIndex);
    assert.deepEqual(rec.handlerRefs, manifest.handlerRefs);
    assert.deepEqual(rec.dependencyLock, input.dependencyLock);

    // Re-serializing the round-tripped record via canonicalJson is stable
    // (the property computePackageDigest depends on).
    const reJson = canonicalJson(rec.manifestSnapshot);
    const reJson2 = canonicalJson(JSON.parse(reJson));
    assert.equal(reJson, reJson2, 'canonical re-serialization is stable');
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// getDb() wiring — db.ts owns the schema-ensure; process_runs columns land
// via ensureFactoryProcessRunSchema (the established pattern for that table).
// ===========================================================================

test('getDb() creates factory_module_installations (the table this lane owns)', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-inst-'));
  process.env.DB_PATH = path.join(temp, 'wired.db');
  try {
    const db = getDb();
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factory_module_installations'").get();
    assert.ok(table, 'getDb() created factory_module_installations via ensureFactoryModuleInstallationSchema');
    const idxActive = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_factory_module_installations_active'").get();
    assert.ok(idxActive, 'partial UNIQUE active index created via getDb()');
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('the two installation columns land on factory_process_runs once the table is ensured', async () => {
  // factory_process_runs is created lazily by ensureFactoryProcessRunSchema (NOT by
  // SCHEMA_SQL). The columns are added there via the established column-add
  // block; db.ts ALSO places defensive ALTERs for the existing-DB upgrade path
  // (guarded on table existence). After the process-run repo is constructed,
  // both columns must be present.
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-inst-'));
  process.env.DB_PATH = path.join(temp, 'wired.db');
  try {
    const db = getDb();
    const { SqliteProcessRunRepository } = await import('../../dist/process-modules/persistence/sqlite-process-run-repository.js');
    // Constructing the repo creates the table + adds the columns.
    // eslint-disable-next-line no-new
    new SqliteProcessRunRepository(db);
    const cols = db.prepare('PRAGMA table_info(factory_process_runs)').all().map((c) => c.name);
    assert.ok(cols.includes('installation_id'), 'installation_id column present on factory_process_runs');
    assert.ok(cols.includes('package_digest'), 'package_digest column present on factory_process_runs');
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

test('the installation columns are idempotent — re-ensuring the schema does not throw', async () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'factory-inst-'));
  process.env.DB_PATH = path.join(temp, 'wired.db');
  try {
    const db = getDb();
    const { SqliteProcessRunRepository } = await import('../../dist/process-modules/persistence/sqlite-process-run-repository.js');
    // eslint-disable-next-line no-new
    new SqliteProcessRunRepository(db);
    // Second construction re-runs ensureFactoryProcessRunSchema — must not throw
    // on the already-present columns (PRAGMA table_info + guard pattern).
    assert.doesNotThrow(() => { new SqliteProcessRunRepository(db); });
    const cols = db.prepare('PRAGMA table_info(factory_process_runs)').all().map((c) => c.name);
    assert.ok(cols.includes('installation_id'));
    assert.ok(cols.includes('package_digest'));
  } finally {
    closeDb();
    rmSync(temp, { recursive: true, force: true });
    delete process.env.DB_PATH;
  }
});

// NOTE: The 'db.ts upgrade path' test was removed when migration sediment
// (guarded ALTER TABLE blocks) was cleaned out of db.ts. The product has not
