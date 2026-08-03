// tests/installation/process-run-pinning.test.mjs
//
// W2-A4 — ProcessRun installation pinning + legacy nullable adapter tests.
//
// Spec: docs/refactor-management/09-contracts/WAVE2-IMMUTABLE-INSTALLATION-SPEC.md
//       §1 rows 7,8 (PinnedInstallation + ProcessRunInstallationAdapter),
//       §3 (the ALTERs — installation_id + package_digest, nullable),
//       §4 (identity rules — both set or both NULL), §14.3.7 (legacy nullable
//       adapter).
// Task: docs/refactor-management/05-subagent-tasks/W02-A4-process-run-pinning-legacy-adapter.md.
//
// Coverage (per task spec "Tests" section):
//   - Positive: pinInstallationOnProcessRun builds a pure value.
//   - Positive: setPinnedInstallation -> getPinnedInstallation returns the pin.
//   - Positive (legacy): run with NULL installation_id -> getPinnedInstallation
//     returns null -> resolveInstallationForLegacyRun resolves via fallback.
//   - Positive: re-pin (update) an already-pinned run -> new values stored.
//   - Negative: setPinnedInstallation on nonexistent run -> no-op (0 rows).
//   - Negative: pinInstallationOnProcessRun rejects invalid arguments.
//   - Persistence: pin survives DB reopen.
//
// ISOLATION NOTE: W2-A4 runs before W2-A2 in some worktrees. W2-A2 owns the
// ALTERs that add installation_id + package_digest to saga3_process_runs. If
// those columns are NOT present on the test DB (because W2-A2's db.ts edits
// are not in this worktree), the helper `ensureInstallationColumns` applies
// the same idempotent ALTER pattern W2-A2 uses (db.ts: `try { ALTER } catch {}`).
// This keeps the test self-contained in isolation AND a no-op after W2-A2
// cherry-picks (the columns already exist -> ALTER is skipped).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const { SqliteProcessRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-process-run-repository.js'
);
const {
  pinInstallationOnProcessRun,
  asModuleInstallationId,
} = await import(
  '../../dist/process-modules/installation/domain/process-run-pinning.js'
);
const { ProcessRunInstallationAdapter } = await import(
  '../../dist/process-modules/installation/persistence/process-run-installation-adapter.js'
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Idempotently ensure the two new columns exist on saga3_process_runs. Mirrors
 * the W2-A2 db.ts pattern (`try { ALTER } catch {}`). No-op once W2-A2 lands.
 */
function ensureInstallationColumns(db) {
  const cols = db.prepare('PRAGMA table_info(saga3_process_runs)').all()
    .map((c) => c.name);
  if (!cols.includes('installation_id')) {
    db.exec('ALTER TABLE saga3_process_runs ADD COLUMN installation_id INTEGER');
  }
  if (!cols.includes('package_digest')) {
    db.exec('ALTER TABLE saga3_process_runs ADD COLUMN package_digest TEXT');
  }
}

/**
 * Build a fresh temp DB and seed the minimal schema needed to start a
 * ProcessRun (projects + epics rows so the FK passes). Returns the db handle
 * and the temp dir (caller cleans up).
 *
 * ORDERING: `ensureInstallationColumns` MUST run AFTER the
 * `saga3_process_runs` table exists. The table is created by
 * `ensureSaga3ProcessRunSchema(db)`, which runs inside the
 * `SqliteProcessRunRepository` constructor. So we construct the repo once
 * (which creates the table) before applying the ALTERs. The repo instance is
 * discarded — `startRun` constructs its own.
 */
function freshDb() {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w2a4-pinning-'));
  process.env.DB_PATH = path.join(temp, 'pinning.db');
  const db = getDb();
  db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'P','active')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')").run();
  // Construct the repo once to create saga3_process_runs, then add the columns.
  // eslint-disable-next-line no-new
  new SqliteProcessRunRepository(db);
  ensureInstallationColumns(db);
  return { db, temp };
}

function cleanup(temp, previousDbPath) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  if (previousDbPath === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = previousDbPath;
  }
}

/** Start a ProcessRun row and return its id. */
function startRun(db, { idempotencyKey = 'k1' } = {}) {
  const repo = new SqliteProcessRunRepository(db);
  const started = repo.start({
    moduleRef: { name: 'product-discovery', version: '3.0.0' },
    executorKind: 'legacy-adapter',
    projectedStage: 'discovery',
    input: {
      schema: 'saga3.discovery-case.v1',
      payload: { case: idempotencyKey },
      contentHash: sha256Hex({ case: idempotencyKey }),
    },
    invocationContext: {
      projectId: 1,
      epicId: 10,
      initiatedBy: 'test',
      idempotencyKey,
    },
  });
  return started.record.id;
}

/** A fake fallback resolver for the legacy path. Returns a record by name+version. */
function fakeFallback(catalog) {
  return {
    resolve(selector) {
      const hit = catalog.find(
        (r) => r.name === selector.name && r.version === selector.versionRange,
      );
      return hit ?? null;
    },
  };
}

// ===========================================================================
// Pure value builder (installation/domain/process-run-pinning.ts).
// ===========================================================================

test('pinInstallationOnProcessRun builds a pure PinnedInstallation value', () => {
  const id = asModuleInstallationId(42);
  const pin = pinInstallationOnProcessRun(7, id, 'abcdef0123456789', '2026-07-28T00:00:00.000Z');
  assert.equal(pin.processRunId, 7);
  assert.equal(pin.installationId, 42);
  assert.equal(pin.packageDigest, 'abcdef0123456789');
  assert.equal(pin.pinnedAt, '2026-07-28T00:00:00.000Z');
});

test('pinInstallationOnProcessRun defaults pinnedAt to now when omitted', () => {
  const before = Date.now();
  const pin = pinInstallationOnProcessRun(1, asModuleInstallationId(1), 'd');
  const after = Date.now();
  const ts = Date.parse(pin.pinnedAt);
  assert.ok(ts >= before && ts <= after, 'pinnedAt should fall between before and after');
});

test('pinInstallationOnProcessRun rejects invalid processRunId', () => {
  assert.throws(
    () => pinInstallationOnProcessRun(0, asModuleInstallationId(1), 'd'),
    /PINNED_INSTALLATION_INVALID_RUN_ID/,
  );
  assert.throws(
    () => pinInstallationOnProcessRun(-1, asModuleInstallationId(1), 'd'),
    /PINNED_INSTALLATION_INVALID_RUN_ID/,
  );
  assert.throws(
    () => pinInstallationOnProcessRun(1.5, asModuleInstallationId(1), 'd'),
    /PINNED_INSTALLATION_INVALID_RUN_ID/,
  );
});

test('pinInstallationOnProcessRun rejects invalid installationId', () => {
  assert.throws(
    () => pinInstallationOnProcessRun(1, asModuleInstallationId(0), 'd'),
    /PINNED_INSTALLATION_INVALID_INSTALLATION_ID/,
  );
});

test('pinInstallationOnProcessRun rejects empty packageDigest', () => {
  assert.throws(
    () => pinInstallationOnProcessRun(1, asModuleInstallationId(1), ''),
    /PINNED_INSTALLATION_INVALID_DIGEST/,
  );
});

// ===========================================================================
// Adapter: set + get the pin.
// ===========================================================================

test('setPinnedInstallation then getPinnedInstallation returns the pin', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const runId = startRun(db);
    const adapter = new ProcessRunInstallationAdapter(db);

    const rowsAffected = adapter.setPinnedInstallation(
      runId,
      asModuleInstallationId(99),
      'deadbeef',
    );
    assert.equal(rowsAffected, 1, 'one row should be updated');

    const pin = adapter.getPinnedInstallation(runId);
    assert.ok(pin, 'expected a pin after set');
    assert.equal(pin.processRunId, runId);
    assert.equal(pin.installationId, 99);
    assert.equal(pin.packageDigest, 'deadbeef');
  } finally {
    cleanup(temp, previous);
  }
});

test('persistPinnedInstallation writes a built PinnedInstallation value', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const runId = startRun(db);
    const adapter = new ProcessRunInstallationAdapter(db);
    const pin = pinInstallationOnProcessRun(
      runId,
      asModuleInstallationId(7),
      'cafebabe',
    );
    const n = adapter.persistPinnedInstallation(pin);
    assert.equal(n, 1);
    const read = adapter.getPinnedInstallation(runId);
    assert.equal(read.installationId, 7);
    assert.equal(read.packageDigest, 'cafebabe');
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// Legacy nullable adapter (plan §14.3.7).
// ===========================================================================

test('legacy run (NULL installation_id) -> getPinnedInstallation returns null', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const runId = startRun(db);
    const adapter = new ProcessRunInstallationAdapter(db);
    // No setPinnedInstallation call -> columns stay NULL.
    const pin = adapter.getPinnedInstallation(runId);
    assert.equal(pin, null, 'legacy run should surface no pin');
  } finally {
    cleanup(temp, previous);
  }
});

test('legacy run -> resolveInstallationForLegacyRun resolves via fallback by name+version', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const runId = startRun(db); // moduleRef = product-discovery@3.0.0
    const adapter = new ProcessRunInstallationAdapter(db);
    const catalog = [
      {
        id: asModuleInstallationId(501),
        name: 'product-discovery',
        version: '3.0.0',
        packageDigest: 'legacy-discovery-digest',
        status: 'active',
      },
    ];
    const resolved = adapter.resolveInstallationForLegacyRun(runId, fakeFallback(catalog));
    assert.ok(resolved, 'expected a resolved installation for the legacy run');
    assert.equal(resolved.id, 501);
    assert.equal(resolved.name, 'product-discovery');
    assert.equal(resolved.version, '3.0.0');
    assert.equal(resolved.packageDigest, 'legacy-discovery-digest');
  } finally {
    cleanup(temp, previous);
  }
});

test('legacy resolver returns null when no active installation matches', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const runId = startRun(db);
    const adapter = new ProcessRunInstallationAdapter(db);
    // Empty catalog -> nothing resolves.
    const resolved = adapter.resolveInstallationForLegacyRun(runId, fakeFallback([]));
    assert.equal(resolved, null);
  } finally {
    cleanup(temp, previous);
  }
});

test('resolveInstallationForLegacyRun returns null for an already-pinned run', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const runId = startRun(db);
    const adapter = new ProcessRunInstallationAdapter(db);
    adapter.setPinnedInstallation(runId, asModuleInstallationId(8), 'h');
    // Already pinned -> legacy path must short-circuit (returns null) even
    // though a fallback exists. The caller should use getPinnedInstallation.
    const resolved = adapter.resolveInstallationForLegacyRun(
      runId,
      fakeFallback([
        {
          id: asModuleInstallationId(8),
          name: 'product-discovery',
          version: '3.0.0',
          packageDigest: 'h',
          status: 'active',
        },
      ]),
    );
    assert.equal(resolved, null, 'pinned run must not route through the legacy path');
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// Re-pin (update) — spec "Positive: re-pin (update) an already-pinned run".
// ===========================================================================

test('re-pin (update) overwrites a previous pin with new values', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const runId = startRun(db);
    const adapter = new ProcessRunInstallationAdapter(db);

    adapter.setPinnedInstallation(runId, asModuleInstallationId(1), 'first');
    let pin = adapter.getPinnedInstallation(runId);
    assert.equal(pin.installationId, 1);
    assert.equal(pin.packageDigest, 'first');

    // Re-pin with a different installation + digest.
    const n = adapter.setPinnedInstallation(runId, asModuleInstallationId(2), 'second');
    assert.equal(n, 1);
    pin = adapter.getPinnedInstallation(runId);
    assert.equal(pin.installationId, 2);
    assert.equal(pin.packageDigest, 'second');
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// Negative: nonexistent run.
// ===========================================================================

test('setPinnedInstallation on nonexistent run is a no-op (0 rows affected)', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const adapter = new ProcessRunInstallationAdapter(db);
    const n = adapter.setPinnedInstallation(999999, asModuleInstallationId(1), 'x');
    assert.equal(n, 0, 'no row should be updated for a nonexistent run');
    // And the read side also returns null.
    assert.equal(adapter.getPinnedInstallation(999999), null);
  } finally {
    cleanup(temp, previous);
  }
});

test('resolveInstallationForLegacyRun on nonexistent run returns null', () => {
  const previous = process.env.DB_PATH;
  const { db, temp } = freshDb();
  try {
    const adapter = new ProcessRunInstallationAdapter(db);
    const resolved = adapter.resolveInstallationForLegacyRun(
      999999,
      fakeFallback([]),
    );
    assert.equal(resolved, null);
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// Persistence: pin survives DB reopen.
// ===========================================================================

test('pin survives DB reopen (persistence)', () => {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w2a4-persist-'));
  process.env.DB_PATH = path.join(temp, 'persist.db');
  let runId;
  try {
    let db = getDb();
    db.prepare("INSERT INTO projects (id,name,status) VALUES (1,'P','active')").run();
    db.prepare("INSERT INTO epics (id,project_id,name) VALUES (10,1,'E')").run();
    // Construct the repo once to create saga3_process_runs, then add columns.
    // eslint-disable-next-line no-new
    new SqliteProcessRunRepository(db);
    ensureInstallationColumns(db);
    runId = startRun(db);
    const adapter = new ProcessRunInstallationAdapter(db);
    adapter.setPinnedInstallation(runId, asModuleInstallationId(123), 'persisted-digest');

    // Close and reopen the SAME db file.
    closeDb();
    db = getDb();
    ensureInstallationColumns(db); // idempotent — columns already exist
    const adapter2 = new ProcessRunInstallationAdapter(db);
    const pin = adapter2.getPinnedInstallation(runId);
    assert.ok(pin, 'pin must survive reopen');
    assert.equal(pin.installationId, 123);
    assert.equal(pin.packageDigest, 'persisted-digest');
  } finally {
    cleanup(temp, previous);
  }
});
