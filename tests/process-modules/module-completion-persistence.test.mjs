// tests/process-modules/module-completion-persistence.test.mjs
//
// FU-A Wave 3 / Phase 1 — durable ModuleCompletion persistence proof.
//
// This is the FOUNDATION proof for Wave 4 (4 modules emit ModuleCompletion)
// and Wave 5 (delete magic-bindings). It proves that a ModuleCompletion
// emitted by a terminal node and persisted via `completeV2` round-trips
// byte-identical through a simulated crash (DB close + reopen), so that
// `restoreNodeResult` can rebuild `NodeExecutionResult.completion` and
// settlement can read the explicit certificate ref instead of silently
// falling back to magic bindings.
//
// The crash-resume canary (tests/execution/crash-resume-exact-receipt.test.mjs)
// proves the production/receipt envelope round-trips; THIS test proves the
// NEW `completion` column added in Wave 3 / FU-A Phase 1 round-trips too.
// Together they are the §0.6.12 contract: durable resumption is content-
// addressed, not reconstructed.
//
// WHAT THIS PROVES
//   1. The `completion` column exists on saga3_node_runs after the repo ctor
//      (fresh-DB path) AND after a DB reopen (dual-placement ALTER in db.ts).
//   2. `completeV2({ completion })` persists the ModuleCompletion JSON.
//   3. After close + reopen of the DB, `readByExactCursor` returns the row
//      with the completion byte-identical (canonical JSON equal; certificateRef
//      schemaId/ref/digest preserved).
//   4. A NodeExecutionResult.completion rebuilt from the restored row
//      (mirroring restoreNodeResult) is byte-identical to the pre-crash value.
//   5. Additive contract: a row completed WITHOUT a completion surfaces
//      `completion: null` (the 4 modules until Wave 4 — no behavior change).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { closeDb, getDb } = await import('../../dist/db.js');
const { canonicalJson, sha256Hex } = await import(
  '../../dist/shared/canonical-json.js'
);
const { SqliteNodeRunRepository } = await import(
  '../../dist/process-modules/persistence/sqlite-node-run-repository.js'
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/**
 * Build a fresh temp DB. saga3_node_runs is created lazily by the repo ctor.
 * FK enforcement is disabled because these tests exercise the NodeRun layer in
 * isolation (no ProcessRun parent row) — mirrors tests/installation/node-run-v2.
 */
function freshDb(prefix = 'saga-fua-w3-completion-') {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DB_PATH = path.join(temp, 'completion.db');
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

function columnNames(db) {
  return db.prepare('PRAGMA table_info(saga3_node_runs)').all().map((c) => c.name);
}

/**
 * Build a ModuleCompletion value (Wave 1 §7.5.6) that a terminal settlement
 * kernel would emit. The certificateRef is the content-addressed pointer
 * settlement reads to bypass magic bindings.
 */
function sampleModuleCompletion({
  outcome = 'go',
  certSchemaId = 'saga3.discovery-certificate.v1',
  certRef = 'certificate:7777',
  certDigest = 'sha256:cert-abc-123',
} = {}) {
  return {
    outcome,
    outputEnvelope: {
      outcome,
      productions: [],
      certificateRef: {
        schemaId: certSchemaId,
        ref: certRef,
        digest: certDigest,
      },
      // Wave 8 BLOCKER 2: the envelope is a LEAF. The cyclic `completion`
      // back-reference field was removed from ProcessModuleOutputEnvelope;
      // the model is now a serializable tree (ModuleCompletion.outputEnvelope
      // → envelope, one-directional). No stub needed.
    },
    terminal: true,
  };
}

// ===========================================================================
// §1 Schema: the `completion` column exists (fresh DB + after reopen).
// ===========================================================================

test('FU-A Wave 3: saga3_node_runs has a `completion` column after the repo ctor (fresh DB)', () => {
  const { db, temp, previous } = freshDb();
  try {
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    const cols = columnNames(db);
    assert.ok(
      cols.includes('completion'),
      `expected 'completion' column to exist; got [${cols.join(', ')}]`,
    );
    // The 7 Wave-3 v2 columns are still present (no removal).
    for (const c of V2_COLUMNS) {
      assert.ok(cols.includes(c), `legacy v2 column ${c} must still exist`);
    }
  } finally {
    cleanup(temp, previous);
  }
});

test('FU-A Wave 3: ensureSaga3NodeRunSchema is idempotent — `completion` column not duplicated', () => {
  const { db, temp, previous } = freshDb();
  try {
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    const cols = columnNames(db);
    const count = cols.filter((c) => c === 'completion').length;
    assert.equal(count, 1, '`completion` column must appear exactly once');
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// §2 completeV2 persists completion; readByExactCursor returns it.
// ===========================================================================

test('FU-A Wave 3: completeV2({ completion }) persists the ModuleCompletion JSON', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 1001,
      nodeId: 'settle',
      nodeKind: 'kernel',
      inputEnvelopeHash: 'env-hash-1',
    });
    const completion = sampleModuleCompletion();
    const completed = repo.completeV2({
      id: started.id,
      event: 'domain.go',
      outputRef: 'settle:out',
      outputHash: 'hash-1',
      productionEnvelope: {
        schema: 'saga3.discovery-settlement.v1',
        artifactRef: 'settle:out',
        contentHash: 'hash-1',
        bindings: {},
        schemaId: 'saga3.discovery-settlement.v1',
        productRef: {
          schemaId: 'saga3.discovery-settlement.v1',
          ref: 'settle:out',
          digest: 'hash-1',
        },
        lineage: [],
      },
      transitionCursor: '1001/settle#1',
      completion,
    });
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.completion, completion);
    // And the resume read returns it.
    const resumed = repo.readByExactCursor(1001, 'settle', 1);
    assert.ok(resumed, 'readByExactCursor must return the row');
    assert.deepEqual(resumed.completion, completion);
  } finally {
    cleanup(temp, previous);
  }
});

test('FU-A Wave 3: completeV2 WITHOUT completion surfaces completion: null (additive)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 1002,
      nodeId: 'n',
      nodeKind: 'kernel',
    });
    const completed = repo.completeV2({
      id: started.id,
      event: 'e',
      outputRef: 'r',
      outputHash: 'h',
      // No completion — this is the path all 4 modules take until Wave 4.
    });
    assert.equal(completed.completion, null, 'absent completion must surface as null');
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// §3 CRASH-RESUME PROOF: completion round-trips byte-identical across reopen.
// ===========================================================================

test('FU-A Wave 3: completion round-trips byte-identical through DB close + reopen (the crash-resume proof)', () => {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-fua-w3-crash-'));
  process.env.DB_PATH = path.join(temp, 'crash.db');
  let startedId;
  const preCrashCompletion = sampleModuleCompletion({
    outcome: 'accepted',
    certSchemaId: 'saga3.development-certificate.v1',
    certRef: 'certificate:4242',
    certDigest: 'sha256:dev-cert-deadbeef',
  });
  const preCrashCanonical = canonicalJson(preCrashCompletion);
  try {
    // ── Pre-crash: persist a terminal NodeRun carrying completion. ──────────
    let db = getDb();
    db.pragma('foreign_keys = OFF');
    let repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 2001,
      nodeId: 'settle-development',
      nodeKind: 'kernel',
      inputEnvelopeHash: 'env-pre-crash',
    });
    repo.completeV2({
      id: started.id,
      event: 'domain.accepted',
      outputRef: 'settle:dev',
      outputHash: 'dev-hash',
      productionEnvelope: {
        schema: 'saga3.development-settlement.v1',
        artifactRef: 'settle:dev',
        contentHash: 'dev-hash',
        bindings: {},
        schemaId: 'saga3.development-settlement.v1',
        productRef: {
          schemaId: 'saga3.development-settlement.v1',
          ref: 'settle:dev',
          digest: 'dev-hash',
        },
        lineage: [{ kind: 'node-run', ref: 'node-run:99' }],
      },
      transitionCursor: '2001/settle-development#1',
      completion: preCrashCompletion,
    });
    startedId = started.id;

    // ── Simulate crash: close the DB handle, reopen a fresh one. ────────────
    // getDb() reruns SCHEMA_SQL + the db.ts migrations (including the dual-
    // placement saga3_node_runs ALTERs). The repo ctor reruns
    // ensureSaga3NodeRunSchema — both must be idempotent.
    closeDb();
    db = getDb();
    db.pragma('foreign_keys = OFF');
    repo = new SqliteNodeRunRepository(db);

    // ── Resume: read the exact row by cursor. ───────────────────────────────
    const resumed = repo.readByExactCursor(2001, 'settle-development', 1);
    assert.ok(resumed, 'row must survive reopen');
    assert.equal(resumed.id, startedId);
    // The completion column is present after reopen (dual-placement ALTER ran).
    assert.ok(
      columnNames(db).includes('completion'),
      '`completion` column must exist after reopen',
    );

    // ── EXIT GATE: completion is byte-identical to pre-crash. ───────────────
    // 1. The completion is non-null (crash did NOT lose the explicit envelope).
    assert.ok(resumed.completion, 'completion must survive crash (not lost)');
    // 2. Canonical JSON is byte-identical — no reconstruction mutation.
    assert.equal(
      canonicalJson(resumed.completion),
      preCrashCanonical,
      'resumed completion must be byte-identical (canonical JSON) to pre-crash',
    );
    // 3. The certificateRef — the field settlement reads to bypass magic
    //    bindings — is preserved exactly (schemaId/ref/digest).
    const resumedCertRef = resumed.completion.outputEnvelope.certificateRef;
    const preCrashCertRef = preCrashCompletion.outputEnvelope.certificateRef;
    assert.deepEqual(
      resumedCertRef,
      preCrashCertRef,
      'certificateRef (content-addressed certificate pointer) must be preserved exactly',
    );
    assert.equal(resumedCertRef.schemaId, 'saga3.development-certificate.v1');
    assert.equal(resumedCertRef.ref, 'certificate:4242');
    assert.equal(resumedCertRef.digest, 'sha256:dev-cert-deadbeef');
    // 4. outcome + terminal preserved.
    assert.equal(resumed.completion.outcome, 'accepted');
    assert.equal(resumed.completion.terminal, true);

    // ── restoreNodeResult contract: rebuilding NodeExecutionResult.completion
    //    from the restored row yields byte-identical value. This mirrors what
    //    generic-flow-executor.restoreNodeResult does internally: it reads
    //    `v2Run.completion` and surfaces it as `result.completion`. We cannot
    //    import the internal function, so we replicate the one-line read and
    //    assert the round-trip — the contract is identical. ──────────────────
    const restoredResultCompletion = resumed.completion ?? undefined;
    assert.deepEqual(
      restoredResultCompletion,
      preCrashCompletion,
      'NodeExecutionResult.completion rebuilt from restored row must equal pre-crash',
    );
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// §4 Content-hash stability: persisted completion is byte-stable (no mutation).
// ===========================================================================

test('FU-A Wave 3: persisted completion is byte-stable (content hash does not change across the round-trip)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 3001,
      nodeId: 'settle',
      nodeKind: 'kernel',
    });
    const completion = sampleModuleCompletion();
    const expectedHash = sha256Hex(completion);
    repo.completeV2({
      id: started.id,
      event: 'domain.go',
      outputRef: 'r',
      outputHash: 'h',
      completion,
    });
    const resumed = repo.readByExactCursor(3001, 'settle', 1);
    assert.ok(resumed.completion);
    // The persistence layer must not mutate the value (no key reordering, no
    // type coercion) — the content hash is stable.
    assert.equal(
      sha256Hex(resumed.completion),
      expectedHash,
      'content hash of resumed completion must equal pre-persist hash',
    );
  } finally {
    cleanup(temp, previous);
  }
});

// ===========================================================================
// §5 Upgrade path: a pre-FU-A DB (Wave 3 v2 columns but NO completion column)
// gains the completion column via the repo ctor.
// ===========================================================================

test('FU-A Wave 3: upgrade path — pre-FU-A schema DB gains the completion column via ctor', () => {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-fua-w3-upgrade-'));
  process.env.DB_PATH = path.join(temp, 'upgrade.db');
  try {
    let db = getDb();
    db.pragma('foreign_keys = OFF');
    // Create the table with the 7 Wave-3 v2 columns but WITHOUT completion
    // (simulate a DB from after Wave 3 but before FU-A Phase 1).
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
        completed_at   TEXT,
        input_envelope_hash TEXT,
        node_ref TEXT,
        package_ref TEXT,
        predecessor_node_run_ids TEXT,
        definition_digest TEXT,
        transition_cursor TEXT,
        production_envelope TEXT
      );
    `);
    // Insert a legacy row (no completion) so we can prove it round-trips.
    db.prepare(
      `INSERT INTO saga3_node_runs (process_run_id, node_id, node_kind, attempt, status, event, output_ref, output_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(4001, 'leg', 'kernel', 1, 'completed', 'domain.accept', 'leg-ref', 'leg-hash');

    // Before ctor: no completion column.
    let cols = columnNames(db);
    assert.equal(cols.includes('completion'), false, 'pre-upgrade: completion must not exist');

    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);

    // After ctor: completion column exists.
    cols = columnNames(db);
    assert.ok(cols.includes('completion'), 'post-upgrade: completion must exist');

    // The legacy row is preserved and readable; its completion surfaces as null.
    const repo = new SqliteNodeRunRepository(db);
    const resumed = repo.readByExactCursor(4001, 'leg', 1);
    assert.ok(resumed, 'legacy row must be readable after upgrade');
    assert.equal(resumed.completion, null, 'legacy row completion must be null');

    // And a NEW write with completion works on the upgraded table.
    const started = repo.startV2({ processRunId: 4001, nodeId: 'new', nodeKind: 'kernel' });
    const completion = sampleModuleCompletion({ certRef: 'certificate:upgrade' });
    repo.completeV2({
      id: started.id,
      event: 'domain.go',
      outputRef: 'new-ref',
      outputHash: 'new-hash',
      completion,
    });
    const newResumed = repo.readByExactCursor(4001, 'new', 1);
    assert.deepEqual(newResumed.completion, completion);
  } finally {
    cleanup(temp, previous);
  }
});

const V2_COLUMNS = [
  'input_envelope_hash',
  'node_ref',
  'package_ref',
  'predecessor_node_run_ids',
  'definition_digest',
  'transition_cursor',
  'production_envelope',
];

// ===========================================================================
// WAVE 8 HIGH 4 — completion_hash column + integrity verification.
//
// The audit (WAVE-8-PRODUCTION-V2-BLOCKERS.txt HIGH 4) flagged that the
// durable ModuleCompletion had NO identity/integrity: stored as plain JSON,
// corrupted/malformed JSON silently became null. HIGH 4 adds a
// `completion_hash` column (SHA-256 over canonical JSON), persisted alongside
// the JSON. Reads VERIFY integrity — COMPLETION_CORRUPT and
// COMPLETION_HASH_MISMATCH throw instead of silent null. These tests prove
// the column exists, the hash round-trips, and the loud throws fire.
// ===========================================================================

test('WAVE 8 HIGH 4: saga3_node_runs has a `completion_hash` column after the repo ctor (fresh DB)', () => {
  const { db, temp, previous } = freshDb();
  try {
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    const cols = columnNames(db);
    assert.ok(
      cols.includes('completion_hash'),
      `expected 'completion_hash' column to exist; got [${cols.join(', ')}]`,
    );
  } finally {
    cleanup(temp, previous);
  }
});

test('WAVE 8 HIGH 4: ensureSaga3NodeRunSchema is idempotent — `completion_hash` column not duplicated', () => {
  const { db, temp, previous } = freshDb();
  try {
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    // eslint-disable-next-line no-new
    new SqliteNodeRunRepository(db);
    const cols = columnNames(db);
    const count = cols.filter((c) => c === 'completion_hash').length;
    assert.equal(count, 1, '`completion_hash` column must appear exactly once');
  } finally {
    cleanup(temp, previous);
  }
});

test('WAVE 8 HIGH 4: completeV2 persists completion_hash alongside completion (round-trip)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 5001,
      nodeId: 'settle',
      nodeKind: 'kernel',
      inputEnvelopeHash: 'env-hash-1',
    });
    const completion = sampleModuleCompletion();
    const completed = repo.completeV2({
      id: started.id,
      event: 'domain.go',
      outputRef: 'settle:out',
      outputHash: 'hash-1',
      completion,
    });
    // The v2 record carries the computed hash.
    assert.equal(completed.completionHash, sha256Hex(completion));
    assert.deepEqual(completed.completion, completion);

    // The raw row stores both columns.
    const raw = db.prepare(
      'SELECT completion, completion_hash FROM saga3_node_runs WHERE id=?',
    ).get(started.id);
    assert.ok(raw.completion, 'completion JSON must be populated');
    assert.ok(raw.completion_hash, 'completion_hash must be populated');
    assert.equal(raw.completion_hash, sha256Hex(completion));

    // readByExactCursor returns the hash too.
    const resumed = repo.readByExactCursor(5001, 'settle', 1);
    assert.ok(resumed);
    assert.equal(resumed.completionHash, sha256Hex(completion));
    assert.deepEqual(resumed.completion, completion);
  } finally {
    cleanup(temp, previous);
  }
});

test('WAVE 8 HIGH 4: a row completed WITHOUT completion surfaces completion_hash: null (additive)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 5002,
      nodeId: 'n',
      nodeKind: 'kernel',
    });
    const completed = repo.completeV2({
      id: started.id,
      event: 'e',
      outputRef: 'r',
      outputHash: 'h',
    });
    assert.equal(completed.completion, null);
    assert.equal(completed.completionHash, null, 'absent completion → null hash');
  } finally {
    cleanup(temp, previous);
  }
});

test('WAVE 8 HIGH 4: completion_hash round-trips byte-identical through DB close/reopen', () => {
  const previous = process.env.DB_PATH;
  const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-w8-hash-reopen-'));
  process.env.DB_PATH = path.join(temp, 'reopen.db');
  const completion = sampleModuleCompletion({
    outcome: 'accepted',
    certSchemaId: 'saga3.delivery-certificate.v2',
    certRef: 'certificate:5150',
    certDigest: 'sha256:delivery-cert-aaaa',
  });
  const expectedHash = sha256Hex(completion);
  try {
    let db = getDb();
    db.pragma('foreign_keys = OFF');
    let repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 5003,
      nodeId: 'settle-deliver',
      nodeKind: 'kernel',
      inputEnvelopeHash: 'env-pre',
    });
    repo.completeV2({
      id: started.id,
      event: 'domain.accepted',
      outputRef: 'settle:d',
      outputHash: 'd-hash',
      completion,
    });

    closeDb();
    db = getDb();
    db.pragma('foreign_keys = OFF');
    repo = new SqliteNodeRunRepository(db);

    const resumed = repo.readByExactCursor(5003, 'settle-deliver', 1);
    assert.ok(resumed);
    assert.ok(resumed.completion);
    assert.equal(resumed.completionHash, expectedHash);
    assert.deepEqual(resumed.completion, completion);
  } finally {
    cleanup(temp, previous);
  }
});

// ---------------------------------------------------------------------------
// THE CRITICAL PROOF: corrupted completion JSON THROWS (not silent null).
// ---------------------------------------------------------------------------

test('WAVE 8 HIGH 4 (CRITICAL): malformed completion JSON in the DB THROWS COMPLETION_CORRUPT (not silent null)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 5004,
      nodeId: 'settle',
      nodeKind: 'kernel',
    });
    repo.completeV2({
      id: started.id,
      event: 'domain.go',
      outputRef: 'r',
      outputHash: 'h',
      completion: sampleModuleCompletion(),
    });
    // Corrupt the completion JSON in the DB directly (simulates a torn write /
    // SQLite corruption the audit warned about). Old behavior: parse failed →
    // null surfaced silently. Wave 8: COMPLETION_CORRUPT must throw loudly.
    db.prepare(
      `UPDATE saga3_node_runs SET completion=? WHERE id=?`,
    ).run('{ this is not valid json', started.id);

    assert.throws(
      () => repo.readByExactCursor(5004, 'settle', 1),
      /COMPLETION_CORRUPT/,
      'malformed completion JSON must throw COMPLETION_CORRUPT, not silent null',
    );
    // Also via listV2.
    assert.throws(
      () => repo.listV2(5004),
      /COMPLETION_CORRUPT/,
      'listV2 must surface the same COMPLETION_CORRUPT throw',
    );
  } finally {
    cleanup(temp, previous);
  }
});

test('WAVE 8 HIGH 4 (CRITICAL): completion JSON that parses to a non-object THROWS COMPLETION_CORRUPT', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 5005,
      nodeId: 'settle',
      nodeKind: 'kernel',
    });
    repo.completeV2({
      id: started.id,
      event: 'domain.go',
      outputRef: 'r',
      outputHash: 'h',
      completion: sampleModuleCompletion(),
    });
    // Valid JSON but wrong shape (array, not an object) — also a corrupt
    // completion value (the writer invariant is JSON.stringify(ModuleCompletion),
    // always a plain object).
    db.prepare(
      `UPDATE saga3_node_runs SET completion=? WHERE id=?`,
    ).run('[1, 2, 3]', started.id);

    assert.throws(
      () => repo.readByExactCursor(5005, 'settle', 1),
      /COMPLETION_CORRUPT/,
      'completion JSON parsing to a non-object must throw COMPLETION_CORRUPT',
    );
  } finally {
    cleanup(temp, previous);
  }
});

test('WAVE 8 HIGH 4 (CRITICAL): completion_hash mismatch in the DB THROWS COMPLETION_HASH_MISMATCH (not silent null)', () => {
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    const started = repo.startV2({
      processRunId: 5006,
      nodeId: 'settle',
      nodeKind: 'kernel',
    });
    repo.completeV2({
      id: started.id,
      event: 'domain.go',
      outputRef: 'r',
      outputHash: 'h',
      completion: sampleModuleCompletion(),
    });
    // Tamper with the hash — keep the JSON intact so parsing succeeds, then
    // fail the integrity check. This catches a non-canonical writer or a row
    // edited in place (the audit's corruption scenario).
    db.prepare(
      `UPDATE saga3_node_runs SET completion_hash=? WHERE id=?`,
    ).run('0'.repeat(64), started.id);

    assert.throws(
      () => repo.readByExactCursor(5006, 'settle', 1),
      /COMPLETION_HASH_MISMATCH/,
      'hash mismatch must throw COMPLETION_HASH_MISMATCH, not silent null',
    );
  } finally {
    cleanup(temp, previous);
  }
});

test('WAVE 8 HIGH 4: legacy pre-Wave-8 row (completion without completion_hash) is trusted, not verified', () => {
  // The migration contract: rows written before HIGH 4 carry `completion` but
  // no `completion_hash`. They are presumed intact (the integrity column was
  // not yet invented). The read must surface the parsed value WITHOUT throwing
  // — silent null was the bug; legacy trust is the migration path.
  const { db, temp, previous } = freshDb();
  try {
    const repo = new SqliteNodeRunRepository(db);
    // Simulate a pre-Wave-8 row by inserting via raw SQL with a completion but
    // a NULL completion_hash. The repo's completeV2 always writes both; the
    // only way to get a row with completion + null hash is the legacy writer.
    db.prepare(
      `INSERT INTO saga3_node_runs (
         process_run_id, node_id, node_kind, attempt, status, event,
         output_ref, output_hash, completion, completion_hash
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      5007,
      'legacy-settle',
      'kernel',
      1,
      'completed',
      'domain.go',
      'legacy:ref',
      'legacy-hash',
      canonicalJson(sampleModuleCompletion()),
    );
    const resumed = repo.readByExactCursor(5007, 'legacy-settle', 1);
    assert.ok(resumed, 'legacy row must be readable');
    assert.ok(resumed.completion, 'legacy completion must surface (not silent null)');
    assert.equal(resumed.completionHash, null, 'legacy row hash stays null');
  } finally {
    cleanup(temp, previous);
  }
});
