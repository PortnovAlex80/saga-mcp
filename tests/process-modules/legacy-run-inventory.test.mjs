// W11-A5 tests: Legacy-run inventory, migration, rollback, retention.
//
// Spec: docs/refactor-management/09-contracts/WAVE11-CUTOVER-SPEC.md
//   §0 objective, §2 lane A5, §3 anti-scope, §4 exit gate bullet 4.
// Task: docs/refactor-management/05-subagent-tasks/W11-a5.md.
//
// Verifies the four tools the lane owns:
//   1. INVENTORY — records every compatibility-path use, append-only, rejects
//      duplicate useId, returns uses per run / counts by path.
//   2. MIGRATION — pure planner emits an entry per legacy run, copies the
//      scenario manifest's requiredModuleSelectors, flags blocking runs.
//   3. ROLLBACK — pure inverse planner, one entry per non-blocking run,
//      steps are the reverse of the migration steps.
//   4. RETENTION — the Wave 13 removal gate forbids removal until every clause
//      passes, and names the failing clauses.
//
// Run: `node --test tests/process-modules/legacy-run-inventory.test.mjs`
// (after `npm run build`).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPATIBILITY_PATHS,
  COMPATIBILITY_USE_REASONS,
  LEGACY_RUN_MIGRATION_STATUS,
  LEGACY_INVENTORY_ERROR_CODES,
  DEFAULT_PACKAGE_RETENTION_POLICY,
  LegacyRunInventory,
  InMemoryLegacyRunInventoryStore,
  buildCompatibilityPathUse,
  buildLegacyRunRecord,
  isCompatibilityPath,
  planLegacyRunMigration,
  planLegacyRunRollback,
  evaluatePackageRetentionCondition,
  parseRetentionDurationToMs,
} from '../../dist/process-modules/application/legacy-run-inventory.js';
import { LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE } from
  '../../dist/process-modules/application/legacy-scenario-adapter.js';

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/**
 * ISO timestamps used across the retention tests. Fixed so the grace-window
 * and recent-use-window math is deterministic.
 *   NOW            = 2026-07-29T00:00:00Z (the "today" of the test).
 *   OLD (90d ago)  = 2026-03-31T00:00:00Z  -> outside the 30d recent window.
 *   RECENT (5d ago)= 2026-07-24T00:00:00Z  -> inside the 30d recent window.
 *   GRACE_BOUNDARY = 2026-07-15T00:00:00Z  -> exactly 14d ago (grace just elapsed).
 */
const NOW = '2026-07-29T00:00:00.000Z';
const OLD = '2026-03-31T00:00:00.000Z';
const RECENT = '2026-07-24T00:00:00.000Z';
const GRACE_BOUNDARY = '2026-07-15T00:00:00.000Z';

/** The lifecycle identity the legacy scenario adapter wraps. */
function legacyLifecycleIdentity() {
  return {
    name: LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.identity.name,
    version: LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.identity.version,
  };
}

/** A manifest lookup that resolves only the legacy Product Delivery identity. */
function legacyManifestLookup(identity) {
  const manifest = LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE;
  if (
    identity.name === manifest.identity.name &&
    identity.version === manifest.identity.version
  ) {
    return manifest;
  }
  return undefined;
}

/** Build a fresh inventory pre-loaded with the given runs (no uses). */
function inventoryWithRuns(runs) {
  const store = new InMemoryLegacyRunInventoryStore();
  for (const r of runs) store.registerLegacyRun(r);
  return new LegacyRunInventory(store);
}

// ---------------------------------------------------------------------------
// Section 1: value builders + validation.
// ---------------------------------------------------------------------------

test('buildCompatibilityPathUse validates every field', () => {
  const use = buildCompatibilityPathUse({
    useId: 'u1',
    runId: 42,
    path: COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER,
    reason: COMPATIBILITY_USE_REASONS.NULL_INSTALLATION_PIN,
    observedBy: 'legacy-scenario-adapter',
  });
  assert.equal(use.useId, 'u1');
  assert.equal(use.runId, 42);
  assert.equal(use.path, COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER);
  assert.equal(use.reason, COMPATIBILITY_USE_REASONS.NULL_INSTALLATION_PIN);
  assert.equal(use.detail, undefined);
  assert.ok(typeof use.recordedAt === 'string' && use.recordedAt.length > 0);
});

test('buildCompatibilityPathUse accepts an optional detail + injected clock', () => {
  const use = buildCompatibilityPathUse({
    useId: 'u2',
    runId: 1,
    path: COMPATIBILITY_PATHS.NULLABLE_INSTALLATION_FALLBACK,
    reason: COMPATIBILITY_USE_REASONS.NO_INSTALLED_SCENARIO,
    observedBy: 'nullable-installation-adapter',
    detail: 'no scenario installed for legacy-product-delivery',
    recordedAt: OLD,
  });
  assert.equal(use.detail, 'no scenario installed for legacy-product-delivery');
  assert.equal(use.recordedAt, OLD);
});

test('buildCompatibilityPathUse rejects empty useId, bad runId, unknown path, empty observer', () => {
  assert.throws(
    () => buildCompatibilityPathUse({
      useId: '', runId: 1, path: COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER,
      reason: COMPATIBILITY_USE_REASONS.CUTOVER_DISABLED, observedBy: 'x',
    }),
    /INVALID_USE.*useId/,
  );
  assert.throws(
    () => buildCompatibilityPathUse({
      useId: 'u', runId: 0, path: COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER,
      reason: COMPATIBILITY_USE_REASONS.CUTOVER_DISABLED, observedBy: 'x',
    }),
    /INVALID_USE.*runId/,
  );
  assert.throws(
    () => buildCompatibilityPathUse({
      useId: 'u', runId: 1, path: 'not-a-real-path',
      reason: COMPATIBILITY_USE_REASONS.CUTOVER_DISABLED, observedBy: 'x',
    }),
    /UNKNOWN_COMPATIBILITY_PATH/,
  );
  assert.throws(
    () => buildCompatibilityPathUse({
      useId: 'u', runId: 1, path: COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER,
      reason: COMPATIBILITY_USE_REASONS.CUTOVER_DISABLED, observedBy: '',
    }),
    /INVALID_USE.*observedBy/,
  );
});

test('isCompatibilityPath accepts declared paths and rejects others', () => {
  assert.equal(isCompatibilityPath(COMPATIBILITY_PATHS.BUILT_IN_CATALOG), true);
  assert.equal(isCompatibilityPath('made-up'), false);
  assert.equal(isCompatibilityPath(undefined), false);
});

test('buildLegacyRunRecord defaults migrationStatus to pending and validates', () => {
  const run = buildLegacyRunRecord({
    runId: 7,
    lifecycleIdentity: legacyLifecycleIdentity(),
    hasNullInstallationPin: true,
    createdAt: OLD,
  });
  assert.equal(run.migrationStatus, LEGACY_RUN_MIGRATION_STATUS.PENDING);
  assert.equal(run.hasNullInstallationPin, true);

  assert.throws(
    () => buildLegacyRunRecord({
      runId: 0,
      lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: true,
      createdAt: OLD,
    }),
    /INVALID_RUN.*runId/,
  );
  assert.throws(
    () => buildLegacyRunRecord({
      runId: 7,
      lifecycleIdentity: { name: '', version: '1' },
      hasNullInstallationPin: true,
      createdAt: OLD,
    }),
    /INVALID_RUN.*name/,
  );
});

// ---------------------------------------------------------------------------
// Section 2: inventory recording (the §4 exit-gate deliverable).
// ---------------------------------------------------------------------------

test('LegacyRunInventory.recordUse appends an immutable use and rejects duplicate useId', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 100, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: true, createdAt: OLD,
    }),
  ]);

  const use = inv.recordUse({
    useId: 'use-100-1', runId: 100,
    path: COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER,
    reason: COMPATIBILITY_USE_REASONS.NULL_INSTALLATION_PIN,
    observedBy: 'legacy-scenario-adapter',
    recordedAt: RECENT,
  });
  assert.equal(use.runId, 100);
  assert.equal(inv.recordedUses().length, 1);

  // duplicate useId rejected with the precise code.
  assert.throws(
    () => inv.recordUse({
      useId: 'use-100-1', runId: 100,
      path: COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER,
      reason: COMPATIBILITY_USE_REASONS.NULL_INSTALLATION_PIN,
      observedBy: 'legacy-scenario-adapter',
      recordedAt: RECENT,
    }),
    new RegExp(LEGACY_INVENTORY_ERROR_CODES.DUPLICATE_USE),
  );
  // ledger unchanged after the rejected append.
  assert.equal(inv.recordedUses().length, 1);
});

test('LegacyRunInventory.usesForRun + useCount filter correctly', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 1, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: true, createdAt: OLD,
    }),
    buildLegacyRunRecord({
      runId: 2, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: false, createdAt: OLD,
    }),
  ]);
  inv.recordUse({
    useId: 'a', runId: 1, path: COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER,
    reason: COMPATIBILITY_USE_REASONS.NULL_INSTALLATION_PIN,
    observedBy: 'x', recordedAt: OLD,
  });
  inv.recordUse({
    useId: 'b', runId: 1, path: COMPATIBILITY_PATHS.NULLABLE_INSTALLATION_FALLBACK,
    reason: COMPATIBILITY_USE_REASONS.NULL_INSTALLATION_PIN,
    observedBy: 'x', recordedAt: OLD,
  });
  inv.recordUse({
    useId: 'c', runId: 2, path: COMPATIBILITY_PATHS.BUILT_IN_CATALOG,
    reason: COMPATIBILITY_USE_REASONS.NO_INSTALLED_SCENARIO,
    observedBy: 'x', recordedAt: OLD,
  });

  assert.equal(inv.usesForRun(1).length, 2);
  assert.equal(inv.usesForRun(2).length, 1);
  assert.equal(inv.usesForRun(999).length, 0);
  assert.equal(inv.useCount(), 3);
  assert.equal(inv.useCount(COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER), 1);
  assert.equal(inv.useCount(COMPATIBILITY_PATHS.BUILT_IN_CATALOG), 1);
});

test('LegacyRunInventory.legacyRuns returns ascending runId and backs the store', () => {
  const store = new InMemoryLegacyRunInventoryStore();
  // register out of order; the store must sort ascending.
  store.registerLegacyRun(buildLegacyRunRecord({
    runId: 30, lifecycleIdentity: legacyLifecycleIdentity(),
    hasNullInstallationPin: true, createdAt: OLD,
  }));
  store.registerLegacyRun(buildLegacyRunRecord({
    runId: 10, lifecycleIdentity: legacyLifecycleIdentity(),
    hasNullInstallationPin: true, createdAt: OLD,
  }));
  const inv = new LegacyRunInventory(store);
  const ids = inv.legacyRuns().map((r) => r.runId);
  assert.deepEqual(ids, [10, 30]);
  assert.equal(inv.backingStore, store);
});

// ---------------------------------------------------------------------------
// Section 3: migration planner (pure).
// ---------------------------------------------------------------------------

test('planLegacyRunMigration emits one entry per run, copies requiredModuleSelectors, non-blocking when manifest resolves', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 5, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: true, createdAt: OLD,
    }),
  ]);
  const plan = planLegacyRunMigration(inv, {
    plannedAt: NOW,
    manifestLookup: legacyManifestLookup,
  });

  assert.equal(plan.plannedAt, NOW);
  assert.equal(plan.entries.length, 1);
  const entry = plan.entries[0];
  assert.equal(entry.runId, 5);
  assert.equal(entry.blocking, false);
  assert.equal(entry.blockReason, undefined);
  // requiredModuleSelectors copied verbatim from the legacy scenario manifest.
  assert.deepEqual(
    entry.requiredModuleSelectors,
    [...LEGACY_PRODUCT_DELIVERY_SCENARIO_PERMISSIVE.requiredModuleSelectors],
  );
  // three ordered steps: pin -> select -> replay.
  assert.deepEqual(
    entry.steps.map((s) => s.kind),
    ['pin-installation', 'select-scenario', 'replay-through-scenario'],
  );
  assert.deepEqual(plan.blockingRunIds, []);
});

test('planLegacyRunMigration flags blocking runs when no manifest matches and lists them in blockingRunIds', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 9, lifecycleIdentity: { name: 'unknown-lifecycle', version: '0.0.0' },
      hasNullInstallationPin: true, createdAt: OLD,
    }),
  ]);
  const plan = planLegacyRunMigration(inv, {
    plannedAt: NOW,
    manifestLookup: legacyManifestLookup, // resolves only legacy-product-delivery
  });
  const entry = plan.entries[0];
  assert.equal(entry.blocking, true);
  assert.ok(entry.blockReason.includes('no installed scenario manifest matches'));
  assert.deepEqual(entry.requiredModuleSelectors, []);
  assert.deepEqual(plan.blockingRunIds, [9]);
});

test('planLegacyRunMigration works without a manifestLookup (selectors empty, non-blocking unless explicitly blocking)', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 11, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: false, createdAt: OLD,
    }),
  ]);
  const plan = planLegacyRunMigration(inv, { plannedAt: NOW });
  // Without a lookup we cannot confirm a matching manifest, so the entry is
  // blocking (we refuse to plan a replay against an unknown manifest).
  assert.equal(plan.entries[0].blocking, true);
  assert.deepEqual(plan.entries[0].requiredModuleSelectors, []);
  assert.deepEqual(plan.blockingRunIds, [11]);
});

// ---------------------------------------------------------------------------
// Section 4: rollback planner (pure, inverse).
// ---------------------------------------------------------------------------

test('planLegacyRunRollback emits the inverse steps for non-blocking entries and skips blocking ones', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 1, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: true, createdAt: OLD,
    }),
    buildLegacyRunRecord({
      runId: 2, lifecycleIdentity: { name: 'nope', version: '0' },
      hasNullInstallationPin: true, createdAt: OLD,
    }),
  ]);
  const migration = planLegacyRunMigration(inv, {
    plannedAt: NOW,
    manifestLookup: legacyManifestLookup,
  });
  const rollback = planLegacyRunRollback(migration, { plannedAt: NOW });

  // run 2 is blocking -> no rollback entry; run 1 migrates -> rollback entry.
  assert.equal(rollback.entries.length, 1);
  assert.equal(rollback.entries[0].runId, 1);
  // steps are the reverse of migration (restore-legacy -> drop-pin -> unpin).
  assert.deepEqual(
    rollback.entries[0].steps.map((s) => s.kind),
    ['restore-legacy-path', 'drop-scenario-replay-pin', 'unpin-installation'],
  );
});

// ---------------------------------------------------------------------------
// Section 5: retention duration parser.
// ---------------------------------------------------------------------------

test('parseRetentionDurationToMs supports day/hour granularity and rejects junk', () => {
  assert.equal(parseRetentionDurationToMs('P30D'), 30 * 86_400_000);
  assert.equal(parseRetentionDurationToMs('P1D'), 86_400_000);
  assert.equal(parseRetentionDurationToMs('P1DT12H'), 86_400_000 + 12 * 3_600_000);
  assert.equal(parseRetentionDurationToMs('PT30M'), 30 * 60_000);

  assert.throws(() => parseRetentionDurationToMs('P'), /RETENTION_WINDOW_PARSE/);
  assert.throws(() => parseRetentionDurationToMs('garbage'), /RETENTION_WINDOW_PARSE/);
  assert.throws(() => parseRetentionDurationToMs(''), /RETENTION_WINDOW_PARSE/);
});

// ---------------------------------------------------------------------------
// Section 6: package-retention condition — the Wave 13 removal gate.
// ---------------------------------------------------------------------------

test('retention FORBIDS removal when un-migrated runs remain', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 1, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: true, createdAt: OLD,
    }),
  ]);
  const migration = planLegacyRunMigration(inv, {
    plannedAt: NOW, manifestLookup: legacyManifestLookup,
  });
  const rollback = planLegacyRunRollback(migration, { plannedAt: NOW });
  const migratedAt = new Map(); // nothing migrated yet

  const result = evaluatePackageRetentionCondition(inv, migration, rollback, migratedAt, {
    evaluatedAt: NOW,
  });
  assert.equal(result.removalPermitted, false);
  assert.equal(result.clauses.noUnmigratedRuns.ok, false);
  assert.equal(result.clauses.noUnmigratedRuns.count, 1);
  assert.match(result.summary, /FORBIDDEN/);
  assert.match(result.summary, /un-migrated/);
});

test('retention FORBIDS removal when a recent compatibility-path use is inside the window', () => {
  // Run is migrated, no blocking runs, but a use was recorded 5 days ago.
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 1, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: true, createdAt: OLD,
      migrationStatus: LEGACY_RUN_MIGRATION_STATUS.MIGRATED,
    }),
  ]);
  inv.recordUse({
    useId: 'recent', runId: 1,
    path: COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER,
    reason: COMPATIBILITY_USE_REASONS.OPERATOR_OVERRIDE,
    observedBy: 'operator', recordedAt: RECENT,
  });
  const migration = planLegacyRunMigration(inv, {
    plannedAt: NOW, manifestLookup: legacyManifestLookup,
  });
  const rollback = planLegacyRunRollback(migration, { plannedAt: NOW });
  const migratedAt = new Map([[1, GRACE_BOUNDARY]]); // past grace

  const result = evaluatePackageRetentionCondition(inv, migration, rollback, migratedAt, {
    evaluatedAt: NOW,
  });
  assert.equal(result.removalPermitted, false);
  assert.equal(result.clauses.noRecentCompatibilityUse.ok, false);
  assert.equal(result.clauses.noRecentCompatibilityUse.count, 1);
  assert.match(result.summary, /compatibility-path use/);
});

test('retention FORBIDS removal when a migrated run is still in the rollback grace window', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 1, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: true, createdAt: OLD,
      migrationStatus: LEGACY_RUN_MIGRATION_STATUS.MIGRATED,
    }),
  ]);
  // migrated 5 days ago -> inside the 14-day grace window.
  const migratedAt = new Map([[1, RECENT]]);
  const migration = planLegacyRunMigration(inv, {
    plannedAt: NOW, manifestLookup: legacyManifestLookup,
  });
  const rollback = planLegacyRunRollback(migration, { plannedAt: NOW });

  const result = evaluatePackageRetentionCondition(inv, migration, rollback, migratedAt, {
    evaluatedAt: NOW,
  });
  assert.equal(result.removalPermitted, false);
  assert.equal(result.clauses.rollbackGraceElapsed.ok, false);
  assert.equal(result.clauses.rollbackGraceElapsed.countStillInGrace, 1);
});

test('retention FORBIDS removal when a blocking (un-migratable) run exists', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 1, lifecycleIdentity: { name: 'nope', version: '0' },
      hasNullInstallationPin: true, createdAt: OLD,
      migrationStatus: LEGACY_RUN_MIGRATION_STATUS.FAILED,
    }),
  ]);
  const migration = planLegacyRunMigration(inv, {
    plannedAt: NOW, manifestLookup: legacyManifestLookup,
  });
  const rollback = planLegacyRunRollback(migration, { plannedAt: NOW });
  const migratedAt = new Map();

  const result = evaluatePackageRetentionCondition(inv, migration, rollback, migratedAt, {
    evaluatedAt: NOW,
  });
  assert.equal(result.removalPermitted, false);
  assert.ok(result.clauses.noBlockingRuns.count >= 1);
  assert.match(result.summary, /blocking/);
});

test('retention PERMITS removal only when every clause passes (the happy path)', () => {
  // One run, fully migrated well past grace, no recent uses, no blocking runs.
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 1, lifecycleIdentity: legacyLifecycleIdentity(),
      hasNullInstallationPin: true, createdAt: OLD,
      migrationStatus: LEGACY_RUN_MIGRATION_STATUS.MIGRATED,
    }),
  ]);
  // A single OLD use (outside the 30-day window) must NOT block removal.
  inv.recordUse({
    useId: 'old-use', runId: 1,
    path: COMPATIBILITY_PATHS.LEGACY_SCENARIO_ADAPTER,
    reason: COMPATIBILITY_USE_REASONS.NULL_INSTALLATION_PIN,
    observedBy: 'x', recordedAt: OLD,
  });
  const migration = planLegacyRunMigration(inv, {
    plannedAt: NOW, manifestLookup: legacyManifestLookup,
  });
  const rollback = planLegacyRunRollback(migration, { plannedAt: NOW });
  // migrated at the grace boundary (14 days ago) -> grace just elapsed.
  const migratedAt = new Map([[1, GRACE_BOUNDARY]]);

  const result = evaluatePackageRetentionCondition(inv, migration, rollback, migratedAt, {
    evaluatedAt: NOW,
  });
  assert.equal(result.clauses.noUnmigratedRuns.ok, true);
  assert.equal(result.clauses.noRecentCompatibilityUse.ok, true);
  assert.equal(result.clauses.rollbackGraceElapsed.ok, true);
  assert.equal(result.clauses.noBlockingRuns.ok, true);
  assert.equal(result.removalPermitted, true);
  assert.match(result.summary, /permitted/);
});

test('retention uses the default policy when none is supplied', () => {
  const inv = inventoryWithRuns([]);
  const migration = { plannedAt: NOW, entries: [], blockingRunIds: [] };
  const rollback = { plannedAt: NOW, entries: [] };
  const result = evaluatePackageRetentionCondition(inv, migration, rollback, new Map(), {
    evaluatedAt: NOW,
  });
  assert.deepEqual(result.policy, DEFAULT_PACKAGE_RETENTION_POLICY);
  // empty inventory -> removal permitted.
  assert.equal(result.removalPermitted, true);
});

test('retention policy can disable the blocking-runs clause', () => {
  const inv = inventoryWithRuns([
    buildLegacyRunRecord({
      runId: 1, lifecycleIdentity: { name: 'nope', version: '0' },
      hasNullInstallationPin: true, createdAt: OLD,
      migrationStatus: LEGACY_RUN_MIGRATION_STATUS.FAILED,
    }),
  ]);
  const migration = planLegacyRunMigration(inv, {
    plannedAt: NOW, manifestLookup: legacyManifestLookup,
  });
  const rollback = planLegacyRunRollback(migration, { plannedAt: NOW });
  const result = evaluatePackageRetentionCondition(inv, migration, rollback, new Map(), {
    evaluatedAt: NOW,
    policy: {
      recentUseWindow: 'P30D',
      rollbackGraceWindow: 'P14D',
      blockingRunsForbidRemoval: false,
    },
  });
  // clause disabled -> ok regardless of blocking count.
  assert.equal(result.clauses.noBlockingRuns.ok, true);
  assert.ok(result.clauses.noBlockingRuns.count >= 1);
  // but removal still forbidden because the run is un-migrated.
  assert.equal(result.removalPermitted, false);
});

// ---------------------------------------------------------------------------
// Section 7: well-known compatibility-path enumeration is frozen + complete.
// ---------------------------------------------------------------------------

test('COMPATIBILITY_PATHS enumerates the four declared adapters and is frozen', () => {
  assert.deepEqual(
    [...Object.values(COMPATIBILITY_PATHS)].sort(),
    [
      'built-in-module-catalog',
      'legacy-engine-executor-adapter',
      'legacy-scenario-adapter',
      'process-run-installation-adapter',
    ],
  );
  assert.equal(Object.isFrozen(COMPATIBILITY_PATHS), true);
  assert.equal(Object.isFrozen(COMPATIBILITY_USE_REASONS), true);
  assert.equal(Object.isFrozen(LEGACY_RUN_MIGRATION_STATUS), true);
});
