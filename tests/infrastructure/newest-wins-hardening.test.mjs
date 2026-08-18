// tests/infrastructure/newest-wins-hardening.test.mjs
//
// K8 commit 3 — the newest-wins cutovers (ADR-079 §4 "CUT").
//
// The audit found four sites where a reader silently resolved a duplicated
// row to the NEWEST match (`ORDER BY id DESC LIMIT 1`) without a schema
// guarantee of uniqueness. Each is now a zero/one/invariant-violation read:
//
//   1. paused/active protocol run picks        → PROTOCOL_RUN_PREDICATE_NOT_UNIQUE
//   2. active/exhausted recovery-case picks    → RECOVERY_CASE_PREDICATE_NOT_UNIQUE
//   3. process outcome-certificate picks       → OUTCOME_CERTIFICATE_NOT_UNIQUE
//   4. the assembler's guarded readLatest      → exact readByExactCursor probe
//
// These tests seed the FORBIDDEN duplicate rows directly and assert the
// typed invariant errors (and, for the exact cursor, the zero/one probe
// semantics). If a regression reintroduces silent newest-wins, the throws
// disappear and the tests fail.

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  ensureFactoryProtocolRunSchema,
  SqliteProtocolRunRepository,
} from '../../dist/process-modules/persistence/sqlite-protocol-run-repository.js';
import {
  ensureFactoryRecoveryCaseSchema,
  SqliteRecoveryCaseRepository,
} from '../../dist/process-modules/persistence/sqlite-recovery-case-repository.js';
import {
  ensureFactoryProcessOutcomeCertificateSchema,
} from '../../dist/process-modules/persistence/sqlite-process-outcome-certificate-repository.js';
import {
  readSingleOutcomeReasonCodes,
} from '../../dist/process-modules/persistence/sqlite-lifecycle-continuation-repository.js';
import {
  ensureFactoryNodeRunSchema,
  SqliteNodeRunRepository,
} from '../../dist/process-modules/persistence/sqlite-node-run-repository.js';

function freshDb(...ensureFns) {
  const db = new Database(':memory:');
  // better-sqlite3 enables FK enforcement by default; the fixture seeds
  // partial rows without the referenced parents.
  db.pragma('foreign_keys = OFF');
  for (const ensure of ensureFns) ensure(db);
  return db;
}

// ---------------------------------------------------------------------------
// 1. Protocol runs — paused and active predicates fail closed on duplicates
// ---------------------------------------------------------------------------

function seedProtocolRun(db, { id, status }) {
  db.prepare(
    `INSERT INTO factory_protocol_runs
       (id, process_run_id, node_protocol_id, node_protocol_version,
        entry_step, status, attempt)
     VALUES (?, 500, 'proto-x', '1.0.0', 'begin', ?, 1)`,
  ).run(id, status);
}

test('K8/harden: a duplicated paused protocol run fails closed, never resumes the newest', () => {
  const db = freshDb(ensureFactoryProtocolRunSchema);
  seedProtocolRun(db, { id: 1, status: 'paused' });
  seedProtocolRun(db, { id: 2, status: 'paused' }); // forbidden duplicate
  const repo = new SqliteProtocolRunRepository(db);
  assert.throws(
    () => repo.resumeProtocol(500, 'proto-x'),
    /PROTOCOL_RUN_PREDICATE_NOT_UNIQUE/u,
    'two paused rows for one (run, protocol) are an invariant violation',
  );
});

test('K8/harden: the active protocol-run invariant is enforced at WRITE time by the partial unique index', () => {
  const db = freshDb(ensureFactoryProtocolRunSchema);
  seedProtocolRun(db, { id: 1, status: 'active' });
  // The schema itself forbids a second active row per (run, protocol): the
  // newest-wins situation for 'active' is not even persistable (mirrors the
  // replay-capsule UNIQUE theorem).
  assert.throws(
    () => seedProtocolRun(db, { id: 2, status: 'active' }),
    (err) => err.code === 'SQLITE_CONSTRAINT_UNIQUE',
    'idx_factory_protocol_runs_active (partial UNIQUE) rejects the duplicate',
  );
  // The reader still resolves zero/one exactly for the legal states.
  const repo = new SqliteProtocolRunRepository(db);
  assert.equal(repo.readActiveProtocol(500, 'proto-x')?.id, 1);
  assert.equal(repo.readActiveProtocol(500, 'proto-other'), null);
});

// ---------------------------------------------------------------------------
// 2. Recovery cases — active/exhausted predicates fail closed on duplicates
// ---------------------------------------------------------------------------

function seedRecoveryCase(db, { id, status }) {
  db.prepare(
    `INSERT INTO factory_recovery_cases
       (id, process_run_id, module_name, module_version, module_ref_key,
        policy_id, verify_node_id, repair_node_id, max_attempts, status,
        attempt_count, opened_by_node_run_id, last_source_node_run_id,
        last_issue_ref, last_issue_hash, last_reason_code)
     VALUES (?, 600, 'm', '1.0.0', 'm@1.0.0', 'policy-x', 'verify', 'repair',
             3, ?, 1, 10, 10, 'ref', 'hash', 'code')`,
  ).run(id, status);
}

test('K8/harden: duplicated non-terminal recovery cases fail closed, never pick the newest', () => {
  const db = freshDb(ensureFactoryRecoveryCaseSchema);
  seedRecoveryCase(db, { id: 1, status: 'active' });
  seedRecoveryCase(db, { id: 2, status: 'exhausted' });
  const repo = new SqliteRecoveryCaseRepository(db);
  assert.throws(
    () => repo.resolveActive(600, 'policy-x', 999),
    /RECOVERY_CASE_PREDICATE_NOT_UNIQUE/u,
    'two non-terminal cases for one (run, policy) are an invariant violation',
  );
});

// ---------------------------------------------------------------------------
// 3. Process outcome certificates — run-scoped uniqueness fails closed
// ---------------------------------------------------------------------------

function seedOutcomeCertificate(db, { id, processRunId }) {
  db.prepare(
    `INSERT INTO factory_process_outcome_certificates
       (id, process_run_id, project_id, module_name, module_version,
        module_ref_key, schema_version, decision, reason_codes, rationale,
        input_hash, certificate_payload, certificate_hash, authority)
     VALUES (?, ?, 7, 'm', '1.0.0', 'm@1.0.0', 'v1', 'failed', '["x"]', 'r',
             '0000000000000000000000000000000000000000000000000000000000000000',
             '{}', ?, 'module')`,
  ).run(id, processRunId, `hash-${id}`);
}

test('K8/harden: run-scoped outcome-certificate uniqueness is enforced at WRITE time', () => {
  const db = freshDb(ensureFactoryProcessOutcomeCertificateSchema);
  seedOutcomeCertificate(db, { id: 1, processRunId: 700 });
  // The schema forbids a second certificate per process run
  // (idx_factory_poc_process_run UNIQUE): the newest-wins situation is not
  // persistable. The readSingleOutcomeReasonCodes fail-closed reader stays
  // as defense-in-depth for pre-index legacy rows.
  assert.throws(
    () => seedOutcomeCertificate(db, { id: 2, processRunId: 700 }),
    (err) => err.code === 'SQLITE_CONSTRAINT_UNIQUE',
    'UNIQUE(process_run_id) rejects the duplicate certificate',
  );
  const single = readSingleOutcomeReasonCodes(db, 700);
  assert.equal(single.reason_codes, '["x"]');
});

test('K8/harden: zero/one outcome certificates read as null/exact', () => {
  const db = freshDb(ensureFactoryProcessOutcomeCertificateSchema);
  assert.equal(readSingleOutcomeReasonCodes(db, 701), null, 'zero → null');
  seedOutcomeCertificate(db, { id: 3, processRunId: 701 });
  const single = readSingleOutcomeReasonCodes(db, 701);
  assert.equal(single.reason_codes, '["x"]');
});

// ---------------------------------------------------------------------------
// 4. Node-run exact cursor — zero/one probe, no row-order semantics
// ---------------------------------------------------------------------------

test('K8/harden: readByExactCursor is an equality probe (zero/one), including across attempts', () => {
  const db = freshDb(ensureFactoryNodeRunSchema);
  const repo = new SqliteNodeRunRepository(db);
  const first = repo.startV2({ processRunId: 800, nodeId: 'node-a', nodeKind: 'task' });
  assert.equal(first.attempt, 1);

  const exactHit = repo.readByExactCursor(800, 'node-a', 1);
  assert.ok(exactHit, 'exact (run, node, attempt) resolves');
  assert.equal(exactHit.id, first.id);

  assert.equal(repo.readByExactCursor(800, 'node-a', 2), null,
    'a not-yet-started attempt reads as zero — not as the newest other row');
  assert.equal(repo.readByExactCursor(800, 'node-b', 1), null,
    'a different node reads as zero');

  // A second attempt exists → the exact probe still returns only its own row.
  const second = repo.startV2({ processRunId: 800, nodeId: 'node-a', nodeKind: 'task' });
  assert.equal(second.attempt, 2);
  assert.equal(repo.readByExactCursor(800, 'node-a', 1)?.id, first.id);
  assert.equal(repo.readByExactCursor(800, 'node-a', 2)?.id, second.id);
});
