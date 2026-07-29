// tests/installation/scenario-installation-repository.test.mjs
//
// W7-A1 — SqliteScenarioInstallationRepository tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE7-SCENARIO-SPEC.md
//       (Lanes row W7-A1; §0.10.3 / §0.10.12). Plan: §4.3.3
//       (ScenarioInstallationRepository port), §6.6-6.7 (scenario installation
//       resolves module selectors to exact InstalledProcessModule + writes
//       scenario module lock), §5.5.9 (deletion restriction).
// Task: docs/refactor-management/05-subagent-tasks/W07-a1.md.
//
// Coverage:
//   - Schema creation is idempotent (constructor safe to call twice;
//     ensureSaga3ScenarioInstallationSchema re-runnable).
//   - Positive: installScenario (active) → getScenarioInstallation returns it
//     with the module lock attached; getModuleLock; getByDigest;
//     getActiveByNameVersion; listActive; activate (staged→active); retire.
//   - Scenario version immutability (mirrors W2-A2 §4): installing a second
//     active scenario for the same (name, version) with a DIFFERENT digest →
//     SCENARIO_INSTALLATION_VERSION_COLLISION.
//   - Idempotent replay: same (name, version, digest) already active → returns
//     existing row.
//   - Module lock atomicity: installScenario writes installation + ALL lock
//     rows in one transaction; the lock rows survive and match the input.
//   - Lock validation: a lock missing a stage, or carrying an extra stage,
//     → SCENARIO_MODULE_LOCK_INCOMPLETE (no row written).
//   - NOT_FOUND: getScenarioInstallation / getModuleLock / activate / retire on
//     unknown id → SCENARIO_INSTALLATION_NOT_FOUND.
//   - Structural: the partial UNIQUE index catches a direct INSERT bypassing
//     the repo (defence-in-depth).
//   - Deletion restriction: the repository exposes NO delete method (plan §5.5.9).
//   - Serialization round-trip: manifestSnapshot / moduleLock survive
//     canonicalJson → TEXT → JSON.parse unchanged.
//   - getDb() wiring: the two new tables + indexes land via getDb() (the db.ts
//     dual-placement edit this lane owns).
//
// Tests run against the COMPILED dist/ output. Uses process.env.DB_PATH =
// mkdtempSync(...) (existing pattern) — each test gets an isolated DB.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// dist/ imports — mirrors tests/installation/installation-repository.test.mjs.
const { closeDb, getDb } = await import('../../dist/db.js');
const {
  SqliteScenarioInstallationRepository,
  ensureSaga3ScenarioInstallationSchema,
} = await import(
  '../../dist/process-modules/installation/persistence/sqlite-scenario-installation-repository.js'
);
const {
  SCENARIO_INSTALLATION_VERSION_COLLISION,
  SCENARIO_INSTALLATION_NOT_FOUND,
  SCENARIO_MODULE_LOCK_INCOMPLETE,
  asScenarioInstallationId,
} = await import('../../dist/process-modules/installation/scenario-store.js');
const { canonicalJson, sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);
const {
  campaignScenario,
  CAMPAIGN_SCENARIO_IDENTITY,
  CAMPAIGN_SCENARIO_INPUT_SCHEMA,
  CAMPAIGN_SCENARIO_OUTPUT_SCHEMA,
  campaignModuleRefs,
} = await import('../fixtures/synthetic-scenarios/campaign/definition.mjs');

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

function contractRef(schemaId) {
  return {
    schemaId,
    version: '1.0.0',
    digest: sha256Hex({ schemaId, stub: 'w7-a1-test' }),
  };
}

function selectorFromModuleRef(moduleRef) {
  return { name: moduleRef.name, versionRange: `^${moduleRef.version}` };
}

/**
 * Build a valid LifecycleScenarioManifest off the W0-A7 campaign fixture
 * (mirrors tests/spi/scenario-manifest.test.mjs buildCampaignManifest).
 */
function buildCampaignManifest({
  name = CAMPAIGN_SCENARIO_IDENTITY.name,
  version = CAMPAIGN_SCENARIO_IDENTITY.version,
} = {}) {
  const stageBindings = campaignScenario.stages.map((s) => ({
    ...s,
    moduleSelector: selectorFromModuleRef(s.moduleRef),
  }));
  return {
    manifestFormatVersion: campaignScenario.manifestFormatVersion,
    identity: { ...CAMPAIGN_SCENARIO_IDENTITY, name, version },
    inputContractRef: contractRef(CAMPAIGN_SCENARIO_INPUT_SCHEMA),
    outputContractRef: contractRef(CAMPAIGN_SCENARIO_OUTPUT_SCHEMA),
    entryStageId: campaignScenario.entryStageId,
    stageBindings,
    outcomeRoutes: {},
    inputMappings: { initiative: 'initiative' },
    outputMappings: {},
    terminalStatuses: campaignScenario.terminalStatuses,
    scenarioPolicies: {
      retry: { kind: 'fixed-backoff', params: { maxAttempts: 3 } },
      pause: { kind: 'manual' },
      cancellation: { kind: 'explicit' },
      escalation: { kind: 'human' },
    },
    requiredModuleSelectors: campaignModuleRefs.map(selectorFromModuleRef),
    transitionBudgets: { maxTransitions: 50 },
    reentryBudgets: { maxReentries: 0 },
  };
}

/**
 * Build the complete module lock (one entry per manifest stage) the way W7-A2
 * would: each stage's moduleSelector resolved to an exact InstalledProcessModule
 * identity. Here we synthesize plausible installation ids/digests — the
 * persistence layer only stores them, it does not resolve them (that is W7-A2).
 *
 * `moduleInstallationIdBase` lets each test vary the ids so distinct scenarios
 * do not collide on the module-locks FK if needed.
 */
function buildModuleLock(manifest, { moduleInstallationIdBase = 100 } = {}) {
  // The campaign reuses external-seo twice (two stages pin the same module
  // package). Group by module name so reused modules share one installation id.
  const moduleNameToId = new Map();
  let next = moduleInstallationIdBase;
  return manifest.stageBindings.map((sb) => {
    const moduleName = sb.moduleSelector.name;
    const moduleVersion = campaignModuleRefs.find(
      (m) => m.name === moduleName,
    ).version;
    if (!moduleNameToId.has(moduleName)) {
      moduleNameToId.set(moduleName, next);
      next += 1;
    }
    const modInstId = moduleNameToId.get(moduleName);
    return {
      stageId: sb.id,
      moduleInstallationId: modInstId,
      moduleName,
      moduleVersion,
      modulePackageDigest: sha256Hex({ module: moduleName, version: moduleVersion }),
      selectorVersionRange: sb.moduleSelector.versionRange,
    };
  });
}

/** Build the installScenario input for a fresh scenario. */
function buildInstallInput({
  name = CAMPAIGN_SCENARIO_IDENTITY.name,
  version = CAMPAIGN_SCENARIO_IDENTITY.version,
  digestSalt = '',
  status,
  moduleInstallationIdBase = 100,
} = {}) {
  const manifest = buildCampaignManifest({ name, version });
  const moduleLock = buildModuleLock(manifest, { moduleInstallationIdBase });
  // Seed the module-installation parent rows so the module-locks FK is
  // satisfied. getDb() already created saga3_module_installations (W2-A2).
  seedModuleInstallations(moduleLock);
  const scenarioDigest = sha256Hex({ manifest, moduleLock, salt: digestSalt });
  return {
    scenarioName: name,
    scenarioVersion: version,
    scenarioDigest,
    manifestSnapshot: manifest,
    moduleLock,
    storeLocation: `file://scenario-store/${name}/${version}/${scenarioDigest}`,
    status,
  };
}

/** Insert minimal parent rows into saga3_module_installations for the lock FK. */
function seedModuleInstallations(moduleLock) {
  const db = getDb();
  const seen = new Set();
  for (const entry of moduleLock) {
    if (seen.has(entry.moduleInstallationId)) continue;
    seen.add(entry.moduleInstallationId);
    db.prepare(
      `INSERT OR IGNORE INTO saga3_module_installations
         (id, name, version, package_digest, manifest_snapshot, store_location,
          resource_index, handler_refs, dependency_lock, status, installed_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)`,
    ).run(
      entry.moduleInstallationId,
      entry.moduleName,
      entry.moduleVersion,
      entry.modulePackageDigest,
      canonicalJson({ stub: 'manifest', name: entry.moduleName }),
      `file://store/${entry.moduleName}/${entry.moduleVersion}`,
      '[]',
      '[]',
      '{}',
      new Date().toISOString(),
    );
  }
}

/** Spin up a fresh temp DB (getDb() runs all migrations incl. W7-A1). */
function freshDb() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga3-scenario-'));
  process.env.DB_PATH = path.join(temp, 'scenario.db');
  const db = getDb();
  return { temp, db };
}

function cleanup(temp) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  delete process.env.DB_PATH;
}

// ===========================================================================
// Schema creation + db.ts dual-placement wiring
// ===========================================================================

test('W7-A1 db.ts wiring: getDb() creates both new tables + all indexes', () => {
  const { temp, db } = freshDb();
  try {
    const table = (name) =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        )
        .get(name);
    const index = (name) =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name=?",
        )
        .get(name);
    assert.ok(table('saga3_scenario_installations'), 'installations table created by getDb()');
    assert.ok(table('saga3_scenario_module_locks'), 'module_locks table created by getDb()');
    assert.ok(index('idx_saga3_scenario_installations_active'), 'partial UNIQUE active index');
    assert.ok(index('idx_saga3_scenario_installations_digest'), 'digest index');
    assert.ok(index('idx_saga3_scenario_module_locks_pair'), 'per-stage UNIQUE lock index');
    assert.ok(index('idx_saga3_scenario_module_locks_module'), 'reverse module-lookup index');
  } finally {
    cleanup(temp);
  }
});

test('schema creation is idempotent — ensureSaga3ScenarioInstallationSchema re-runnable', () => {
  const { temp, db } = freshDb();
  try {
    assert.doesNotThrow(() => ensureSaga3ScenarioInstallationSchema(db));
    assert.doesNotThrow(() => ensureSaga3ScenarioInstallationSchema(db));
  } finally {
    cleanup(temp);
  }
});

test('constructor is safe to call twice against the same db', () => {
  const { temp, db } = freshDb();
  try {
    assert.doesNotThrow(() => new SqliteScenarioInstallationRepository(db));
    assert.doesNotThrow(() => new SqliteScenarioInstallationRepository(db));
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Positive: installScenario / getScenarioInstallation / getModuleLock / listActive
// ===========================================================================

test('installScenario (active) writes the row + module lock and returns the record', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    const rec = repo.installScenario(input);

    assert.equal(rec.scenarioName, input.scenarioName);
    assert.equal(rec.scenarioVersion, input.scenarioVersion);
    assert.equal(rec.scenarioDigest, input.scenarioDigest);
    assert.equal(rec.status, 'active');
    assert.equal(typeof rec.id, 'number');
    assert.ok(rec.id > 0);
    assert.ok(rec.installedAt, 'installedAt set');
    assert.ok(rec.activatedAt, 'activatedAt set on active install');
    // The complete module lock is attached.
    assert.equal(rec.moduleLock.length, input.moduleLock.length);
    assert.deepEqual(
      rec.moduleLock.map((m) => m.stageId).sort(),
      input.moduleLock.map((m) => m.stageId).sort(),
    );

    // The lock rows actually landed in the lock table.
    const lockRowCount = db
      .prepare(
        'SELECT COUNT(*) AS n FROM saga3_scenario_module_locks WHERE scenario_installation_id=?',
      )
      .get(rec.id);
    assert.equal(lockRowCount.n, input.moduleLock.length);
  } finally {
    cleanup(temp);
  }
});

test('getScenarioInstallation returns the record with the lock; deepEqual round-trip', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    const rec = repo.installScenario(input);

    const got = repo.getScenarioInstallation(rec.id);
    assert.deepEqual(got, rec, 'getScenarioInstallation round-trips the record');
  } finally {
    cleanup(temp);
  }
});

test('serialization round-trip: manifestSnapshot + moduleLock survive canonical TEXT', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    const rec = repo.installScenario(input);
    // The stored manifest must canonical-reserialize identically.
    assert.deepEqual(
      canonicalJson(rec.manifestSnapshot),
      canonicalJson(input.manifestSnapshot),
    );
    assert.deepEqual(
      canonicalJson(rec.moduleLock),
      canonicalJson(input.moduleLock),
    );
  } finally {
    cleanup(temp);
  }
});

test('getModuleLock returns one record per stage; null for unknown installation', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    const rec = repo.installScenario(input);

    const lock = repo.getModuleLock(rec.id);
    assert.equal(lock.length, input.moduleLock.length);
    // Each lock record carries the owning installation id + exact module pin.
    for (const row of lock) {
      assert.equal(row.scenarioInstallationId, rec.id);
      assert.equal(typeof row.moduleInstallationId, 'number');
      assert.ok(row.modulePackageDigest, 'module digest pinned');
    }

    assert.equal(repo.getModuleLock(asScenarioInstallationId(999999)), null);
  } finally {
    cleanup(temp);
  }
});

test('getActiveByNameVersion / getByDigest / listActive find the active scenario', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    const rec = repo.installScenario(input);

    const byName = repo.getActiveByNameVersion(
      input.scenarioName,
      input.scenarioVersion,
    );
    assert.deepEqual(byName, rec);

    const byDigest = repo.getByDigest(input.scenarioDigest);
    assert.deepEqual(byDigest, rec);

    const active = repo.listActive();
    assert.equal(active.length, 1);
    assert.deepEqual(active[0], rec);
  } finally {
    cleanup(temp);
  }
});

test('installScenario staged → activate claims the active slot', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput({ status: 'staged' });
    const staged = repo.installScenario(input);
    assert.equal(staged.status, 'staged');
    assert.equal(staged.activatedAt, undefined);
    // Not in listActive yet.
    assert.equal(repo.listActive().length, 0);

    const active = repo.activate(staged.id);
    assert.equal(active.status, 'active');
    assert.ok(active.activatedAt, 'activatedAt set');
    assert.equal(repo.listActive().length, 1);
  } finally {
    cleanup(temp);
  }
});

test('retire releases the active slot; row preserved', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    const rec = repo.installScenario(input);
    assert.equal(repo.listActive().length, 1);

    const retired = repo.retire(rec.id);
    assert.equal(retired.status, 'retired');
    assert.ok(retired.retiredAt, 'retiredAt set');
    assert.equal(repo.listActive().length, 0);
    // Row + lock still present (deletion-restricted, plan §5.5.9).
    const stillThere = repo.getScenarioInstallation(rec.id);
    assert.ok(stillThere, 'retired row preserved');
    assert.equal(repo.getModuleLock(rec.id).length, input.moduleLock.length);
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Scenario version immutability (mirrors W2-A2 §4)
// ===========================================================================

test('version collision: second active install with DIFFERENT digest → COLLISION', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const first = buildInstallInput({ digestSalt: 'first' });
    repo.installScenario(first);

    // Same identity, different digest (different salt → different module lock hash).
    const second = buildInstallInput({ digestSalt: 'second' });
    assert.throws(
      () => repo.installScenario(second),
      (err) => {
        assert.ok(
          err.message.includes(SCENARIO_INSTALLATION_VERSION_COLLISION),
          `expected collision code, got: ${err.message}`,
        );
        return true;
      },
    );
    // Only the first install survives.
    assert.equal(repo.listActive().length, 1);
  } finally {
    cleanup(temp);
  }
});

test('idempotent replay: same (name, version, digest) already active → returns existing row', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    const first = repo.installScenario(input);
    const replay = repo.installScenario(input);
    assert.equal(replay.id, first.id, 'replay returns the existing active row');
    assert.equal(repo.listActive().length, 1);
    // No duplicate lock rows.
    assert.equal(repo.getModuleLock(first.id).length, input.moduleLock.length);
  } finally {
    cleanup(temp);
  }
});

test('activate collision: activating a second staged row for an active identity → COLLISION', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const active = repo.installScenario(buildInstallInput({ digestSalt: 'a' }));
    // A second staged row under the same identity with a different digest.
    const staged = repo.installScenario(
      buildInstallInput({ digestSalt: 'b', status: 'staged' }),
    );
    assert.throws(
      () => repo.activate(staged.id),
      (err) => err.message.includes(SCENARIO_INSTALLATION_VERSION_COLLISION),
    );
    // The active slot is still held by the first row.
    const holder = repo.getActiveByNameVersion(
      active.scenarioName,
      active.scenarioVersion,
    );
    assert.equal(holder.id, active.id);
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Module-lock validation (fail-fast, pre-write)
// ===========================================================================

test('lock missing a stage → SCENARIO_MODULE_LOCK_INCOMPLETE; no row written', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    // Drop the last lock entry — the manifest still declares that stage.
    const truncatedLock = input.moduleLock.slice(0, -1);
    assert.throws(
      () => repo.installScenario({ ...input, moduleLock: truncatedLock }),
      (err) => err.message.includes(SCENARIO_MODULE_LOCK_INCOMPLETE),
    );
    assert.equal(repo.listActive().length, 0);
    const cnt = db
      .prepare('SELECT COUNT(*) AS n FROM saga3_scenario_installations')
      .get();
    assert.equal(cnt.n, 0, 'no installation row written on lock failure');
  } finally {
    cleanup(temp);
  }
});

test('lock with extra stage → SCENARIO_MODULE_LOCK_INCOMPLETE; no row written', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    const extraLock = [
      ...input.moduleLock,
      {
        stageId: 'nonexistent-stage',
        moduleInstallationId: 777,
        moduleName: 'ghost',
        moduleVersion: '0.0.0',
        modulePackageDigest: sha256Hex({ ghost: true }),
        selectorVersionRange: '^0.0.0',
      },
    ];
    assert.throws(
      () => repo.installScenario({ ...input, moduleLock: extraLock }),
      (err) => err.message.includes(SCENARIO_MODULE_LOCK_INCOMPLETE),
    );
    assert.equal(repo.listActive().length, 0);
  } finally {
    cleanup(temp);
  }
});

test('lock with duplicate stage → SCENARIO_MODULE_LOCK_INCOMPLETE', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const input = buildInstallInput();
    const dup = [...input.moduleLock, input.moduleLock[0]];
    assert.throws(
      () => repo.installScenario({ ...input, moduleLock: dup }),
      (err) => err.message.includes(SCENARIO_MODULE_LOCK_INCOMPLETE),
    );
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// NOT_FOUND
// ===========================================================================

test('NOT_FOUND: getScenarioInstallation / activate / retire on unknown id', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    const ghost = asScenarioInstallationId(999999);
    assert.equal(repo.getScenarioInstallation(ghost), null);
    assert.equal(repo.getModuleLock(ghost), null);
    assert.throws(
      () => repo.activate(ghost),
      (err) => err.message.includes(SCENARIO_INSTALLATION_NOT_FOUND),
    );
    assert.throws(
      () => repo.retire(ghost),
      (err) => err.message.includes(SCENARIO_INSTALLATION_NOT_FOUND),
    );
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Structural: the partial UNIQUE index is defence-in-depth
// ===========================================================================

test('structural: a direct second-active INSERT bypassing the repo is rejected by the index', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    repo.installScenario(buildInstallInput());
    // Bypass the repo: try to insert a second active row for the same identity.
    assert.throws(() =>
      db.prepare(
        `INSERT INTO saga3_scenario_installations
           (scenario_name, scenario_version, scenario_digest, manifest_snapshot,
            module_lock, store_location, status, installed_at)
         VALUES (?,?,?,?,?,?, 'active', ?)`,
      ).run(
        CAMPAIGN_SCENARIO_IDENTITY.name,
        CAMPAIGN_SCENARIO_IDENTITY.version,
        'different-digest',
        '{}',
        '[]',
        'bypass',
        new Date().toISOString(),
      ),
    );
  } finally {
    cleanup(temp);
  }
});

// ===========================================================================
// Deletion restriction (plan §5.5.9)
// ===========================================================================

test('deletion restriction: the repository exposes NO delete method', () => {
  const { temp, db } = freshDb();
  try {
    const repo = new SqliteScenarioInstallationRepository(db);
    assert.equal(
      typeof repo.delete,
      'undefined',
      'no delete method on the adapter (plan §5.5.9)',
    );
    assert.equal(typeof repo.remove, 'undefined');
  } finally {
    cleanup(temp);
  }
});
