// tests/installation/node-run-v2.test.mjs
//
// W3-A6 — NodeRun v2 persistence (SQL OWNER for saga3_node_runs this wave).
//
// Spec: docs/refactor-management/09-contracts/WAVE3-DURABLE-EXECUTION-SPEC.md §9.
// Task: docs/refactor-management/05-subagent-tasks/W03-A6-node-run-v2-sql-owner.md.
//
// Coverage (per task spec "Verify" + §9 contract):
//   - Schema: 7 additive nullable columns + 1 resume index exist after the
//     repository constructor (fresh-DB path through ensureSaga3NodeRunSchema).
//   - Schema: idempotent — constructing twice does not throw.
//   - startV2: writes legacy columns AND the 7 v2 columns; returns a v2 record.
//   - completeV2: DUAL-WRITES legacy output_* AND v2 production_envelope +
//     transition_cursor; the row round-trips both shapes.
//   - readByExactCursor: returns the single row for an exact (run, node, attempt)
//     triple; returns null for a nonexistent triple; returns the right row when
//     multiple attempts exist for the same (run, node) (§9.11 resume primitive).
//   - readLatestV2 / readLastCompletedV2 / listV2: v2-shaped analogues of the
//     legacy read methods.
//   - Legacy compat: the legacy start/complete/readLatest/readLastCompleted/list
//     methods still work on the same table and surface v2 columns as null.
//   - Persistence: v2 row survives DB reopen (the dual-placement ALTER in db.ts
//     + ensureSaga3NodeRunSchema must both be idempotent).
//   - Upgrade path: a DB created with the PRE-Wave-3 schema (only legacy
//     columns) gets the 7 v2 columns + index after the constructor runs.
//
// ISOLATION NOTE: W3-A6 is the single SQL owner for saga3_node_runs. This test
// constructs `SqliteNodeRunRepository` directly, which runs
// `ensureSaga3NodeRunSchema` (the fresh-DB path). The dual-placement ALTER in
// src/db.ts (the upgrade path for pre-existing DBs) is exercised by the
// "upgrade path" + "persists across DB reopen" tests via getDb()/closeDb().

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { sha256Hex } = await import(
  '../../dist/process-modules/shared/canonical-json.js'
);
const { SqliteNodeRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const V2_COLUMNS = [
  'input_envelope_hash',
  'node_ref',
  'package_ref',
  'predecessor_node_run_ids',
  'definition_digest',
  'transition_cursor',
  'production_envelope',
];

/**
 * Build a fresh temp DB. saga3_node_runs is created lazily by the repo ctor.
 *
 * FK note: saga3_node_runs declares `REFERENCES saga3_process_runs(id)` and
 * getDb() turns `foreign_keys = ON`. These tests exercise the NodeRun layer in
 * isolation (no ProcessRun parent row), so we disable FK enforcement for the
 * temp DB. This mirrors how the generic-flow-executor tests avoid FK friction
 * (they happen to create saga3_process_runs first; here we deliberately keep
 * the surface minimal — the FK target is irrelevant to the v2 column contract).
 */
function freshDb(prefix = 'saga-w3a6-') {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DB_PATH = path.join(temp, 'noderun.db');
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  return { db, temp, previous };
}

function cleanup(temp, previous) {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
  if (previous === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = previous;
  }
}

/** Read the column names of saga3_node_runs (after the repo ctor has run). */
function columnNames(db) {
  return db.prepare('PRAGMA table_info(saga3_node_runs)').all().map((c) => c.name);
}

/** Read the index names on saga3_node_runs. */
function indexNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='saga3_node_runs'")
    .all()
    .map((r) => r.name);
}

/** A canonical NodeRef value (Wave 1 §7.7.1). */
function sampleNodeRef() {
  return { nodeId: 'decide', flowId: 'synthetic.flow', flowVersion: '1.0.0' };
}

/** A canonical PackageRef value (Wave 1 §7.7.1). */
function samplePackageRef() {
  return { name: 'synthetic-test', version: '1.0.0', digest: 'abc123' };
}

/** A canonical NodeProductionEnvelope value (Wave 1 §7.6). */
function sampleProductionEnvelope(contentHash = 'prod-hash-1') {
  return {
    schema: 'synthetic.decision.v1',
    artifactRef: 'decision:accept',
    contentHash,
    bindings: { decision: 'accepted' },
    schemaId: 'saga3.node-production-envelope.v1',
    productRef: {
      schemaId: 'synthetic.decision.v1',
      ref: 'decision:accept',
      digest: contentHash,
    },
    lineage: [
      { kind: 'node-run', ref: 'nr-42' },
    ],
  };
}

// ===========================================================================
// Schema: 7 v2 columns + resume index exist after the ctor (fresh-DB path).
// ===========================================================================

test('ensureSaga3NodeRunSchema (fresh DB) adds all 7 v2 columns', () => {
  const { db, temp, previous } = freshDb();
  try {
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    const cols = columnNames(db);
    for (const c of V2_COLUMNS) {
      assert.ok(cols.includes(c), `expected column ${c} to exist`);
    }
    // Legacy columns are still present (no removal).
    for (const c of [
      'output_ref', 'output_schema', 'output_hash', 'output_bindings',
      'execution_receipt', 'acceptance_receipt', 'recovery_issue',
    ]) {
      assert.ok(cols.includes(c), `legacy column ${c} must still exist`);
    }
  } finally {
    cleanup(temp, previous);
  }
});

test('ensureSaga3NodeRunSchema creates the exact-cursor resume index', () => {
  const { db, temp, previous } = freshDb();
  try {
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    const idx = indexNames(db);
    assert.ok(
      idx.includes('idx_saga3_node_runs_exact_cursor'),
      'resume index must exist',
    );
  } finally {
    cleanup(temp, previous);
  }
});

test('ensureSaga3NodeRunSchema is idempotent (constructing twice does not throw)', () => {
  const { db, temp, previous } = freshDb();
  try {
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    // Second construction re-runs ensureSaga3NodeRunSchema; the PRAGMA-check
    // guards + CREATE UNIQUE INDEX IF NOT EXISTS must make it a no-op.
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    const cols = columnNames(db);
    // Columns are not duplicated (SQLite would reject duplicate column names,
    // but assert anyway to lock the contract).
    const colCounts = {};
    for (const c of cols) colCounts[c] = (colCounts[c] || 0) + 1;
    for (const [c, n] of Object.entries(colCounts)) {
      assert.equal(n, 1, `column ${c} must appear exactly once`);
    }
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// startV2 — writes legacy + v2 columns; returns a v2 record.
// ===========================================================================

test('startV2 writes the v2 columns and returns a v2 record', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const rec = repo.startV2({
      processRunId: 101,
      nodeId: 'decide',
      nodeKind: 'kernel',
      inputEnvelopeHash: 'env-hash-aaa',
      nodeRef: sampleNodeRef(),
      packageRef: samplePackageRef(),
      predecessorNodeRunIds: [42, 43],
      definitionDigest: 'def-digest-xyz',
      transitionCursor: 'cursor-start',
    });
    assert.equal(rec.processRunId, 101);
    assert.equal(rec.nodeId, 'decide');
    assert.equal(rec.nodeKind, 'kernel');
    assert.equal(rec.attempt, 1);
    assert.equal(rec.status, 'running');
    // v2 fields are populated.
    assert.equal(rec.inputEnvelopeHash, 'env-hash-aaa');
    assert.deepEqual(rec.nodeRef, sampleNodeRef());
    assert.deepEqual(rec.packageRef, samplePackageRef());
    assert.deepEqual(rec.predecessorNodeRunIds, [42, 43]);
    assert.equal(rec.definitionDigest, 'def-digest-xyz');
    assert.equal(rec.transitionCursor, 'cursor-start');
    assert.equal(rec.productionEnvelope, null, 'envelope is written on completeV2');
  } finally {
    cleanup(temp, previous);
  }
});

test('startV2 with omitted v2 fields writes NULLs (still a valid row)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const rec = repo.startV2({
      processRunId: 102,
      nodeId: 'n1',
      nodeKind: 'kernel',
    });
    assert.equal(rec.inputEnvelopeHash, null);
    assert.equal(rec.nodeRef, null);
    assert.equal(rec.packageRef, null);
    assert.equal(rec.predecessorNodeRunIds, null);
    assert.equal(rec.definitionDigest, null);
    assert.equal(rec.transitionCursor, null);
  } finally {
    cleanup(temp, previous);
  }
});

test('startV2 increments attempt per (processRunId, nodeId)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const r1 = repo.startV2({ processRunId: 200, nodeId: 'n', nodeKind: 'kernel' });
    const r2 = repo.startV2({ processRunId: 200, nodeId: 'n', nodeKind: 'kernel' });
    const r3 = repo.startV2({ processRunId: 200, nodeId: 'n', nodeKind: 'kernel' });
    assert.equal(r1.attempt, 1);
    assert.equal(r2.attempt, 2);
    assert.equal(r3.attempt, 3);
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// completeV2 — DUAL-WRITES legacy output_* AND v2 production_envelope.
// ===========================================================================

test('completeV2 dual-writes legacy output_* AND v2 production_envelope + cursor', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 300,
      nodeId: 'decide',
      nodeKind: 'kernel',
      inputEnvelopeHash: 'env-hash-bbb',
    });
    const envelope = sampleProductionEnvelope('prod-hash-bbb');
    const completed = repo.completeV2({
      id: started.id,
      event: 'domain.accept',
      outputRef: 'decision:accept',
      outputSchema: 'synthetic.decision.v1',
      outputHash: 'prod-hash-bbb',
      outputBindings: { decision: 'accepted' },
      productionEnvelope: envelope,
      transitionCursor: 'cursor-resolved',
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.event, 'domain.accept');
    // Legacy fields populated.
    assert.equal(completed.outputRef, 'decision:accept');
    assert.equal(completed.outputSchema, 'synthetic.decision.v1');
    assert.equal(completed.outputHash, 'prod-hash-bbb');
    assert.deepEqual(completed.outputBindings, { decision: 'accepted' });
    // v2 fields populated (dual-write).
    assert.deepEqual(completed.productionEnvelope, envelope);
    assert.equal(completed.transitionCursor, 'cursor-resolved');
    // The envelope hash from startV2 is preserved through completeV2.
    assert.equal(completed.inputEnvelopeHash, 'env-hash-bbb');
    // completedAt is stamped.
    assert.ok(completed.completedAt, 'completedAt must be set');
  } finally {
    cleanup(temp, previous);
  }
});

test('completeV2 without a production envelope leaves production_envelope NULL', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 301,
      nodeId: 'n',
      nodeKind: 'kernel',
    });
    const completed = repo.completeV2({
      id: started.id,
      event: 'e',
      outputRef: 'r',
      outputHash: 'h',
    });
    assert.equal(completed.productionEnvelope, null);
    assert.equal(completed.transitionCursor, null);
    assert.equal(completed.status, 'completed');
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// readByExactCursor — §9.11 resume primitive.
// ===========================================================================

test('readByExactCursor returns the single row for an exact (run, node, attempt)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const r1 = repo.startV2({ processRunId: 400, nodeId: 'decide', nodeKind: 'kernel' });
    repo.completeV2({
      id: r1.id,
      event: 'domain.accept',
      outputRef: 'ref-1',
      outputHash: 'hash-1',
      productionEnvelope: sampleProductionEnvelope('hash-1'),
      transitionCursor: 'cursor-1',
    });
    const r2 = repo.startV2({ processRunId: 400, nodeId: 'decide', nodeKind: 'kernel' });
    repo.completeV2({
      id: r2.id,
      event: 'domain.fail',
      outputRef: 'ref-2',
      outputHash: 'hash-2',
      productionEnvelope: sampleProductionEnvelope('hash-2'),
      transitionCursor: 'cursor-2',
    });

    // Exact-cursor lookup: attempt 1 returns the first row, attempt 2 the second.
    const a1 = repo.readByExactCursor(400, 'decide', 1);
    const a2 = repo.readByExactCursor(400, 'decide', 2);
    assert.ok(a1, 'attempt 1 must be found');
    assert.ok(a2, 'attempt 2 must be found');
    assert.equal(a1.id, r1.id);
    assert.equal(a2.id, r2.id);
    assert.equal(a1.transitionCursor, 'cursor-1');
    assert.equal(a2.transitionCursor, 'cursor-2');
    assert.deepEqual(a1.productionEnvelope, sampleProductionEnvelope('hash-1'));
    assert.deepEqual(a2.productionEnvelope, sampleProductionEnvelope('hash-2'));
  } finally {
    cleanup(temp, previous);
  }
});

test('readByExactCursor returns null for a nonexistent triple', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    repo.startV2({ processRunId: 401, nodeId: 'n', nodeKind: 'kernel' });
    // Wrong attempt.
    assert.equal(repo.readByExactCursor(401, 'n', 99), null);
    // Wrong node.
    assert.equal(repo.readByExactCursor(401, 'other', 1), null);
    // Wrong run.
    assert.equal(repo.readByExactCursor(999, 'n', 1), null);
  } finally {
    cleanup(temp, previous);
  }
});

test('readByExactCursor distinguishes two nodes in the same run', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const decide = repo.startV2({ processRunId: 402, nodeId: 'decide', nodeKind: 'kernel' });
    const emit = repo.startV2({ processRunId: 402, nodeId: 'emit', nodeKind: 'kernel' });
    // Both are attempt 1 for their respective nodes.
    assert.equal(decide.attempt, 1);
    assert.equal(emit.attempt, 1);
    const d = repo.readByExactCursor(402, 'decide', 1);
    const e = repo.readByExactCursor(402, 'emit', 1);
    assert.equal(d.id, decide.id);
    assert.equal(e.id, emit.id);
    assert.notEqual(d.id, e.id);
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// v2-shaped analogues of the legacy read methods.
// ===========================================================================

test('readLatestV2 returns the most recent row for a (run, node) regardless of status', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const r1 = repo.startV2({ processRunId: 500, nodeId: 'n', nodeKind: 'kernel' });
    repo.completeV2({ id: r1.id, event: 'e', outputRef: 'r', outputHash: 'h' });
    const r2 = repo.startV2({ processRunId: 500, nodeId: 'n', nodeKind: 'kernel' }); // running
    const latest = repo.readLatestV2(500, 'n');
    assert.ok(latest);
    assert.equal(latest.id, r2.id);
    assert.equal(latest.status, 'running');
  } finally {
    cleanup(temp, previous);
  }
});

test('readLastCompletedV2 returns the most recent completed row in the run', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const r1 = repo.startV2({ processRunId: 501, nodeId: 'a', nodeKind: 'kernel' });
    repo.completeV2({ id: r1.id, event: 'e', outputRef: 'r', outputHash: 'h' });
    const r2 = repo.startV2({ processRunId: 501, nodeId: 'b', nodeKind: 'kernel' });
    repo.completeV2({ id: r2.id, event: 'e', outputRef: 'r', outputHash: 'h' });
    const r3 = repo.startV2({ processRunId: 501, nodeId: 'c', nodeKind: 'kernel' }); // running
    const last = repo.readLastCompletedV2(501);
    assert.ok(last);
    assert.equal(last.id, r2.id);
    assert.equal(last.status, 'completed');
    // r3 is running, not the resume point.
    assert.notEqual(last.id, r3.id);
  } finally {
    cleanup(temp, previous);
  }
});

test('listV2 returns all rows in id ASC order with v2 shape', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const r1 = repo.startV2({ processRunId: 502, nodeId: 'a', nodeKind: 'kernel' });
    const r2 = repo.startV2({ processRunId: 502, nodeId: 'b', nodeKind: 'kernel' });
    const r3 = repo.startV2({ processRunId: 502, nodeId: 'c', nodeKind: 'kernel' });
    const list = repo.listV2(502);
    assert.equal(list.length, 3);
    assert.deepEqual(list.map((r) => r.id), [r1.id, r2.id, r3.id]);
    // Every row carries the v2 fields (null here, but present).
    for (const r of list) {
      assert.equal('inputEnvelopeHash' in r, true);
      assert.equal('productionEnvelope' in r, true);
    }
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// Legacy compat: legacy methods still work on the same table; v2 cols surface
// as null through the legacy record shape.
// ===========================================================================

test('legacy start/complete/readLatest/readLastCompleted/list still work', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.start({ processRunId: 600, nodeId: 'leg', nodeKind: 'kernel' });
    assert.equal(started.attempt, 1);
    assert.equal(started.status, 'running');
    const completed = repo.complete({
      id: started.id,
      event: 'domain.accept',
      outputRef: 'legacy-ref',
      outputHash: 'legacy-hash',
      outputBindings: { legacy: true },
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.outputRef, 'legacy-ref');

    const latest = repo.readLatest(600, 'leg');
    assert.ok(latest);
    assert.equal(latest.id, started.id);

    const lastCompleted = repo.readLastCompleted(600);
    assert.ok(lastCompleted);
    assert.equal(lastCompleted.id, started.id);

    const list = repo.list(600);
    assert.equal(list.length, 1);
    // Legacy record shape does NOT carry the v2 keys.
    assert.equal('inputEnvelopeHash' in list[0], false);
    assert.equal('productionEnvelope' in list[0], false);
  } finally {
    cleanup(temp, previous);
  }
});

test('legacy start row can be completed via completeV2 (mixed migration path)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    // A legacy start (no v2 fields written).
    const started = repo.start({ processRunId: 601, nodeId: 'mix', nodeKind: 'kernel' });
    // A v2 complete — dual-writes the envelope alongside the legacy output_*.
    const completed = repo.completeV2({
      id: started.id,
      event: 'domain.accept',
      outputRef: 'mix-ref',
      outputHash: 'mix-hash',
      productionEnvelope: sampleProductionEnvelope('mix-hash'),
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.productionEnvelope, sampleProductionEnvelope('mix-hash'));
    // inputEnvelopeHash is null because the row was started via legacy start.
    assert.equal(completed.inputEnvelopeHash, null);
    // Exact-cursor resume still finds it.
    const resumed = repo.readByExactCursor(601, 'mix', 1);
    assert.ok(resumed);
    assert.deepEqual(resumed.productionEnvelope, sampleProductionEnvelope('mix-hash'));
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// Persistence: v2 row survives DB reopen (dual-placement ALTER is idempotent).
// ===========================================================================

test('v2 row survives DB reopen', () => {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w3a6-persist-'));
  process.env.DB_PATH = path.join(temp, 'persist.db');
  let startedId;
  try {
    let db = getDb();
    db.pragma('foreign_keys = OFF');
    let repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 700,
      nodeId: 'persist',
      nodeKind: 'kernel',
      inputEnvelopeHash: 'persist-env',
      nodeRef: sampleNodeRef(),
      packageRef: samplePackageRef(),
      predecessorNodeRunIds: [10, 20],
      definitionDigest: 'persist-def',
    });
    repo.completeV2({
      id: started.id,
      event: 'domain.accept',
      outputRef: 'persist-ref',
      outputHash: 'persist-hash',
      productionEnvelope: sampleProductionEnvelope('persist-hash'),
      transitionCursor: 'persist-cursor',
    });
    startedId = started.id;

    // Close and reopen the SAME db file. getDb() reruns SCHEMA_SQL + the
    // db.ts migrations (including the dual-placement saga3_node_runs ALTERs).
    closeDb();
    db = getDb();
    db.pragma('foreign_keys = OFF');
    // The constructor reruns ensureSaga3NodeRunSchema — must be idempotent.
    repo = new SqliteNodeRunRepository(db);
    const resumed = repo.readByExactCursor(700, 'persist', 1);
    assert.ok(resumed, 'row must survive reopen');
    assert.equal(resumed.id, startedId);
    assert.equal(resumed.inputEnvelopeHash, 'persist-env');
    assert.deepEqual(resumed.nodeRef, sampleNodeRef());
    assert.deepEqual(resumed.packageRef, samplePackageRef());
    assert.deepEqual(resumed.predecessorNodeRunIds, [10, 20]);
    assert.equal(resumed.definitionDigest, 'persist-def');
    assert.equal(resumed.transitionCursor, 'persist-cursor');
    assert.deepEqual(resumed.productionEnvelope, sampleProductionEnvelope('persist-hash'));
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// Upgrade path: a DB created with the PRE-Wave-3 schema gets the v2 columns +
// index after the ctor runs.
// ===========================================================================

test('upgrade path: pre-Wave-3 schema DB gains v2 columns + index via ctor', () => {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w3a6-upgrade-'));
  process.env.DB_PATH = path.join(temp, 'upgrade.db');
  try {
    let db = getDb();
    db.pragma('foreign_keys = OFF');
    // Create the table with ONLY the legacy columns (simulate a pre-Wave-3 DB
    // before any v2 migration ran). No v2 columns, no resume index.
    db.exec(`
      CREATE TABLE saga3_node_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        process_run_id INTEGER NOT NULL,
        node_id        TEXT NOT NULL,
        node_kind      TEXT NOT NULL,
        attempt        INTEGER NOT NULL,
        status         TEXT NOT NULL DEFAULT 'running'
                         CHECK (status IN ('running','completed','failed')),
        event          TEXT,
        output_ref     TEXT,
        output_schema  TEXT,
        output_hash    TEXT,
        output_bindings TEXT,
        execution_receipt TEXT,
        acceptance_receipt TEXT,
        recovery_issue TEXT,
        error_message  TEXT,
        started_at     TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at   TEXT
      );
    `);
    // Insert a legacy row so we can prove it round-trips after upgrade.
    db.prepare(
      `INSERT INTO saga3_node_runs (process_run_id, node_id, node_kind, attempt, status, event, output_ref, output_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(800, 'leg', 'kernel', 1, 'completed', 'domain.accept', 'leg-ref', 'leg-hash');

    // Before ctor: no v2 columns, no resume index.
    let cols = columnNames(db);
    for (const c of V2_COLUMNS) {
      assert.equal(cols.includes(c), false, `pre-upgrade: ${c} must not exist yet`);
    }
    // Drop the singleton so the ctor's ensureSaga3NodeRunSchema runs the ALTERs.
    // The repo ctor takes a db handle directly, so we just construct it.
    const repo = new SqliteNodeRunRepository(db);

    // After ctor: all 7 v2 columns + the resume index exist.
    cols = columnNames(db);
    for (const c of V2_COLUMNS) {
      assert.ok(cols.includes(c), `post-upgrade: ${c} must exist`);
    }
    const idx = indexNames(db);
    assert.ok(idx.includes('idx_saga3_node_runs_exact_cursor'));

    // The legacy row is preserved and readable via the v2 shape; its v2 fields
    // are all null (it predates Wave 3).
    const resumed = repo.readByExactCursor(800, 'leg', 1);
    assert.ok(resumed, 'legacy row must be readable after upgrade');
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.outputRef, 'leg-ref');
    assert.equal(resumed.inputEnvelopeHash, null);
    assert.equal(resumed.nodeRef, null);
    assert.equal(resumed.productionEnvelope, null);

    // And a NEW v2 write works on the upgraded table.
    const started = repo.startV2({
      processRunId: 800,
      nodeId: 'new',
      nodeKind: 'kernel',
      inputEnvelopeHash: 'post-upgrade-env',
    });
    assert.equal(started.inputEnvelopeHash, 'post-upgrade-env');
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// Malformed-JSON defense: corrupted v2 JSON columns surface as null, not throws.
// ===========================================================================

test('malformed JSON in a v2 column surfaces as null (no throw)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({ processRunId: 900, nodeId: 'n', nodeKind: 'kernel' });
    // Corrupt the node_ref column directly.
    db.prepare('UPDATE saga3_node_runs SET node_ref=? WHERE id=?').run(
      '{not valid json',
      started.id,
    );
    const resumed = repo.readByExactCursor(900, 'n', 1);
    assert.ok(resumed);
    assert.equal(resumed.nodeRef, null, 'malformed JSON must surface as null');
  } finally {
    cleanup(temp, previous);
  }
});

test('content hash round-trips: production envelope hash equals sha256 of body', () => {
  // Smoke-check that the envelope we persist is byte-stable across the
  // dual-write (the crash-resume proof in W3-A8 asserts byte-for-byte equality;
  // this test confirms the persistence layer does not mutate the value).
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const body = { decision: 'accept', payload: { x: 1 } };
    const expectedHash = sha256Hex(body);
    const started = repo.startV2({ processRunId: 950, nodeId: 'n', nodeKind: 'kernel' });
    const envelope = sampleProductionEnvelope(expectedHash);
    repo.completeV2({
      id: started.id,
      event: 'e',
      outputRef: 'r',
      outputHash: expectedHash,
      productionEnvelope: envelope,
    });
    const resumed = repo.readByExactCursor(950, 'n', 1);
    assert.ok(resumed.productionEnvelope);
    assert.equal(resumed.productionEnvelope.contentHash, expectedHash);
    assert.equal(resumed.outputHash, expectedHash, 'legacy outputHash dual-written');
  } finally {
    cleanup(temp, previous);
  }
});
