// tests/process-modules/discovery-legacy-removal-boot-regression.test.mjs
//
// ADR-095 Phase 1 — existing-DB boot/compatibility regression for the
// Discovery legacy-removal manifest cutover (STOP-SHIP correction F5).
//
// Theorem (production behavior, not policy re-implementation):
//   1. FAIL-CLOSED DRIFT: booting against an EXISTING database whose active
//      product-discovery@3.0.2 installation is the censused six-handler
//      legacy installation, with a post-removal manifest that flips the
//      handler set at the SAME module version, is rejected with the typed
//      MODULE_INSTALLATION_INCOMPATIBLE_DRIFT — and the rejection leaves the
//      existing installation untouched (still the only row, still active,
//      same digest; no staged row). This is the exact seam ADR-095 F5
//      proves: a same-version six-to-one handler flip must never silently
//      replace a contract a pinned run depends on.
//   2. VERSION-BUMP BOOT: the SAME existing database (legacy installation
//      active AND a nonterminal ProcessRun pinned to it — the censused
//      elite6-db run#1 shape) boots the bumped-version one-handler manifest
//      through the REAL engine install chain (installProductionModules — the
//      exact entry src/orchestrate-cli.ts calls at boot, NOT the
//      partial-lifecycle installModulePackages variant): the new version installs,
//      the legacy installation row is RETAINED (same id; today it also stays
//      active at 3.0.2 under the per-(name, version) unique-active invariant —
//      a current-baseline fact, NOT an ADR-095 requirement: the ADR only
//      demands the preserved old row stay rehydratable, which an active or a
//      retired row equally satisfies), and the pinned run's exact persisted
//      legacy package snapshot is rehydrated and verified from the
//      content-addressed store (PINNED_PACKAGE_* fail-closed is the
//      counterfactual).
//
// The existing-DB fixture mirrors the 2026-08-23 Phase-1 census
// (docs/factory-run/stage22-elite9/DISCOVERY-PHASE1-CENSUS.md): all 19 local
// factory DBs carry exactly one active product-discovery@3.0.2 installation
// with the six legacy handler logical IDs, and exactly one nonterminal
// Discovery-pinned run (elite6-db run#1, paused/human_required).
//
// Run: node --test tests/process-modules/discovery-legacy-removal-boot-regression.test.mjs
// Hosted: acceptance-matrix `process-modules` group; per-file removal guard
// G2h in tests/infrastructure/acceptance-matrix-coverage.test.mjs.

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const { installProductionModules } = await import(
  '../../dist/process-modules/installation/production-install.js'
);
const { SCHEMA_SQL } = await import('../../dist/schema.js');
const { ensureFactoryProcessRunSchema } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const {
  discoveryPackageManifest,
  DISCOVERY_HANDLER_IDS,
} = await import('../../dist/process-modules/modules/discovery/package/manifest.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The one live handler ref the post-removal manifest keeps (ADR-095 item 4). */
function oneHandlerRefs() {
  return discoveryPackageManifest.handlerRefs.filter(
    (h) => h.logicalId === DISCOVERY_HANDLER_IDS.settlementPolicy,
  );
}

/** Post-removal manifest at the SAME module version (the forbidden cutover). */
function sameVersionFlippedManifest() {
  return { ...discoveryPackageManifest, handlerRefs: oneHandlerRefs() };
}

/** Post-removal manifest with the atomic module-version bump (ADR-095 F5). */
function bumpedVersionManifest(nextVersion) {
  return {
    ...discoveryPackageManifest,
    definition: {
      ...discoveryPackageManifest.definition,
      identity: {
        ...discoveryPackageManifest.definition.identity,
        version: nextVersion,
      },
    },
    handlerRefs: oneHandlerRefs(),
  };
}

/**
 * Existing-DB fixture: full production schema + an active legacy
 * product-discovery@3.0.2 installation (installed through the REAL
 * production path from the REAL production manifest) + one nonterminal
 * (paused) ProcessRun pinned to that installation — the censused elite6-db
 * run#1 shape.
 */
async function buildExistingLegacyDb(storeRoot) {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // factory_process_runs is created lazily by its single SQL owner (the
  // process-run repository), exactly as on a production database.
  ensureFactoryProcessRunSchema(db);
  const legacy = await installProductionModules(
    db, repoRoot, [discoveryPackageManifest], storeRoot,
  );
  const legacyRecord = legacy.records.get('product-discovery');
  assert.ok(legacyRecord, 'legacy production-discovery installs');
  assert.equal(legacyRecord.version, '3.0.2');
  assert.equal(legacyRecord.handlerRefs.length, 6, 'censused legacy shape: six handlers');

  const inputSnapshot = '{}';
  // better-sqlite3 enforces FKs; satisfy the run's project binding.
  db.prepare(`INSERT INTO projects (id, name) VALUES (1, 'census-fixture-project')`).run();
  db.prepare(
    `INSERT INTO factory_process_runs
       (project_id, epic_id, module_name, module_version, module_ref_key,
        idempotency_key, executor_kind, input_schema, input_snapshot, input_hash,
        status, installation_id, package_digest, error)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    1, 1, 'product-discovery', '3.0.2', 'product-discovery@3.0.2',
    'lifecycle:1:stage-run:1', 'generic-flow',
    discoveryPackageManifest.inputContractRef.schemaId,
    inputSnapshot,
    createHash('sha256').update(inputSnapshot).digest('hex'),
    'paused', legacyRecord.id, legacyRecord.packageDigest,
    "ProcessRun 1 paused at node 'produce-proposal' and can be resumed (human_required)",
  );
  return { db, legacyRecord };
}

function discoveryInstallRows(db) {
  return db.prepare(
    `SELECT id, version, package_digest, status FROM factory_module_installations
      WHERE name='product-discovery' ORDER BY id`,
  ).all();
}

test('ADR-095 F5: same-version Discovery handler logical-ID drift fails closed (MODULE_INSTALLATION_INCOMPATIBLE_DRIFT)', async () => {
  const storeRoot = mkdtempSync(path.join(os.tmpdir(), 'adr095-drift-'));
  const { db, legacyRecord } = await buildExistingLegacyDb(storeRoot);
  try {
    await assert.rejects(
      () => installProductionModules(db, repoRoot, [sameVersionFlippedManifest()], storeRoot),
      (err) => {
        assert.equal(err.code, 'MODULE_INSTALLATION_INCOMPATIBLE_DRIFT');
        assert.match(err.message, /product-discovery@3\.0\.2/);
        assert.match(err.message, /handlerLogicalIds/);
        return true;
      },
      'a six-to-one handler flip at the same module version must fail closed with the typed drift error',
    );

    // Fail-closed means fail-closed: the existing DB truth is untouched —
    // still exactly ONE product-discovery installation, still active, same
    // digest (no staged row, no retirement, no digest rewrite).
    const rows = discoveryInstallRows(db);
    assert.equal(rows.length, 1, 'no new installation row may appear');
    assert.equal(rows[0].id, legacyRecord.id);
    assert.equal(rows[0].status, 'active');
    assert.equal(rows[0].package_digest, legacyRecord.packageDigest);
    const pinned = db.prepare(
      `SELECT installation_id, package_digest, status FROM factory_process_runs WHERE id=1`,
    ).get();
    assert.equal(pinned.status, 'paused', 'the pinned nonterminal run is not mutated');
    assert.equal(pinned.package_digest, legacyRecord.packageDigest);
  } finally {
    db.close();
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test('ADR-095 F5: module-version bump with the legacy installation preserved boots and rehydrates the pinned legacy package', async () => {
  const storeRoot = mkdtempSync(path.join(os.tmpdir(), 'adr095-bump-'));
  const { db, legacyRecord } = await buildExistingLegacyDb(storeRoot);
  try {
    // The boot: install the bumped one-handler manifest through the real
    // production path against the EXISTING db. A rejection here (drift,
    // version collision, PINNED_PACKAGE_*) is the failure under test.
    const boot = await installProductionModules(
      db, repoRoot, [bumpedVersionManifest('3.1.0')], storeRoot,
    );

    const next = boot.records.get('product-discovery');
    assert.ok(next, 'bumped product-discovery installs');
    assert.equal(next.version, '3.1.0');
    assert.deepEqual(
      next.handlerRefs.map((h) => h.logicalId),
      ['discovery-settlement-policy'],
    );
    assert.notEqual(next.packageDigest, legacyRecord.packageDigest);

    // Legacy installation PRESERVED: the exact old row (same id, same digest)
    // is still present for the pinned run's rehydration path to resolve by
    // digest. The active-status assertions immediately below characterize
    // TODAY's per-(name, version) unique-active baseline (3.0.2 and 3.1.0
    // coexist as two active rows); they are NOT an ADR-095 Phase-4
    // requirement — the ADR requires the preserved old row to stay
    // rehydratable, which a future retired-status row would equally satisfy.
    const retained = boot.repository.getByPackageDigest(legacyRecord.packageDigest);
    assert.ok(retained, 'legacy installation row retained in the repository');
    assert.equal(retained.id, legacyRecord.id);
    assert.equal(retained.version, '3.0.2');
    assert.equal(
      retained.status, 'active',
      'current-baseline characterization (not an ADR-095 requirement): the preserved 3.0.2 row is active under today\'s per-(name, version) unique-active invariant',
    );
    const rows = discoveryInstallRows(db);
    assert.equal(rows.length, 2, 'exactly the legacy and bumped installations exist');
    assert.equal(
      rows.filter((r) => r.status === 'active').length, 2,
      'current-baseline characterization (not an ADR-095 requirement): one active slot per (name, version) lets 3.0.2 and 3.1.0 coexist active today',
    );

    // The pinned nonterminal run rehydrates its EXACT persisted package:
    // installProductionModules verifies every nonterminal pin's snapshot from
    // the content-addressed store before the host may reserve work — its
    // presence in the returned packages map is the boot proof (the
    // counterfactual throws PINNED_PACKAGE_INSTALLATION_MISSING /
    // PINNED_PACKAGE_SNAPSHOT_MISSING and fails the boot).
    assert.ok(
      boot.packages.has(legacyRecord.packageDigest),
      'the pinned run\'s exact legacy package snapshot is verified and materialized at boot',
    );
    const legacyPackage = boot.packages.get(legacyRecord.packageDigest);
    assert.equal(
      legacyPackage.manifest.definition.identity.version, '3.0.2',
      'rehydrated snapshot is the legacy six-handler package, not the new one',
    );
    assert.equal(legacyPackage.manifest.handlerRefs.length, 6);
  } finally {
    db.close();
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test('ADR-095 F5 counterfactual: the bumped boot alone does not satisfy the drift guard — same version still refuses after a successful bump', async () => {
  // Ordering proof (Phase-4 atomicity): after the bumped version is active,
  // a LATER same-version six-handler reinstall attempt (the legacy manifest
  // back at 3.0.2 against the still-active legacy slot) stays idempotent —
  // and a same-version flip of the BUMPED slot (3.1.0 → different handler
  // set at 3.1.0) still fails closed. The drift guard is version-scoped,
  // so the bump removes the collision ONLY by moving to a new version.
  const storeRoot = mkdtempSync(path.join(os.tmpdir(), 'adr095-postbump-'));
  const { db } = await buildExistingLegacyDb(storeRoot);
  try {
    await installProductionModules(db, repoRoot, [bumpedVersionManifest('3.1.0')], storeRoot);

    // Same-version flip of the bumped slot must fail closed too.
    const flippedBumped = {
      ...bumpedVersionManifest('3.1.0'),
      handlerRefs: discoveryPackageManifest.handlerRefs,
    };
    await assert.rejects(
      () => installProductionModules(db, repoRoot, [flippedBumped], storeRoot),
      (err) => err.code === 'MODULE_INSTALLATION_INCOMPATIBLE_DRIFT',
      're-widening the handler set at the bumped version is the same forbidden same-version flip',
    );
  } finally {
    db.close();
    rmSync(storeRoot, { recursive: true, force: true });
  }
});
