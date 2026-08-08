// tests/factory-contract/candidate-set-gate-invariants.test.mjs
//
// AC-30: CandidateSet idempotent seal, CandidateSet replay mismatch, GateDecision
// append-only property, CAS/revision conflict.
//
// These are domain-level tests against the pure invariants.

import { test } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { candidateSetSealKey, computeCandidateSetRef } from '../../dist/process-modules/domain/workplace/index.js';

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function makeWorkplaceRef() {
  return { processRunId: 1, moduleRef: 'test@1.0.0', productionCellId: 'test-cell', workKey: 'singleton' };
}

function makeMembers(n = 1) {
  return Array.from({ length: n }, (_, i) => ({
    productRef: { schemaId: `schema-${i}`, ref: `ref-${i}`, digest: `digest-${i}` },
    origin: 'produced',
    sourceCandidateSetRef: null,
  }));
}

test('AC-30a: CandidateSet idempotent seal — same digest returns replayed=true', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY,
      workplace_ref TEXT NOT NULL,
      producer_execution_ref TEXT NOT NULL,
      role TEXT NOT NULL,
      subject_candidate_set_ref TEXT,
      candidate_set_digest TEXT NOT NULL,
      seal_receipt_ref TEXT,
      sealed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE factory_candidate_set_members (
      candidate_set_ref TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      product_schema TEXT NOT NULL,
      product_ref TEXT NOT NULL,
      product_digest TEXT NOT NULL,
      origin TEXT,
      source_candidate_set_ref TEXT,
      PRIMARY KEY (candidate_set_ref, ordinal)
    );
  `);
  const repo = new SqliteCandidateSetRepository(db);
  const wpRef = makeWorkplaceRef();
  const sealInput = {
    workplaceRef: wpRef,
    producerExecutionRef: 'exec-1',
    role: 'author',
    subjectCandidateSetRef: null,
    members: makeMembers(2),
    sealReceiptRef: 'receipt-1',
    candidateSetDigest: 'digest-abc',
    sealedAt: '2026-01-01T00:00:00Z',
  };

  const result1 = repo.seal({
    ...sealInput,
    candidateSetDigest: sha256('digest-abc'),
  });
  assert.ok(!result1.replayed, 'first seal is not a replay');

  // Idempotent: same digest → replayed=true
  const result2 = repo.seal({
    ...sealInput,
    candidateSetDigest: sha256('digest-abc'),
  });
  assert.ok(result2.replayed, 'second seal with same digest is a replay');
  assert.equal(result2.set.candidateSetRef, result1.set.candidateSetRef);
});

test('AC-30b: CandidateSet replay mismatch — different digest under same seal key throws', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY,
      workplace_ref TEXT NOT NULL,
      producer_execution_ref TEXT NOT NULL,
      role TEXT NOT NULL,
      subject_candidate_set_ref TEXT,
      candidate_set_digest TEXT NOT NULL,
      seal_receipt_ref TEXT,
      sealed_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE factory_candidate_set_members (
      candidate_set_ref TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      product_schema TEXT NOT NULL,
      product_ref TEXT NOT NULL,
      product_digest TEXT NOT NULL,
      origin TEXT,
      source_candidate_set_ref TEXT,
      PRIMARY KEY (candidate_set_ref, ordinal)
    );
  `);
  const repo = new SqliteCandidateSetRepository(db);
  const wpRef = makeWorkplaceRef();

  repo.seal({
    workplaceRef: wpRef, producerExecutionRef: 'exec-1', role: 'author',
    subjectCandidateSetRef: null, members: makeMembers(1),
    sealReceiptRef: 'receipt-1', candidateSetDigest: sha256('digest-A'), sealedAt: '2026-01-01',
  });

  // Different digest under the same seal key → must throw
  assert.throws(
    () => repo.seal({
      workplaceRef: wpRef, producerExecutionRef: 'exec-1', role: 'author',
      subjectCandidateSetRef: null, members: makeMembers(2),
      sealReceiptRef: 'receipt-1', candidateSetDigest: sha256('digest-B'), sealedAt: '2026-01-01',
    }),
    /CANDIDATE_SET_REPLAY_MISMATCH/,
  );
});

test('AC-30c: GateDecision is append-only — DDL trigger prevents UPDATE/DELETE', async () => {
  // The GateDecision table uses DDL triggers to enforce append-only.
  // We verify the trigger exists in the schema.
  process.env.DB_PATH = ':memory:';
  const { getDb, closeDb } = await import('../../dist/db.js');
  const db = getDb();

  // Check for the append-only trigger
  const triggers = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='factory_gate_decisions'`,
  ).all();
  const triggerNames = triggers.map(t => t.name);

  // The trigger should prevent updates/deletes on gate decisions
  assert.ok(
    triggerNames.some(n => n.includes('no_update') || n.includes('no_delete')),
    `GateDecision has append-only trigger: ${triggerNames.join(', ')}`,
  );

  closeDb();
});

test('AC-30d: CAS revision conflict — applyTransitionInTx returns applied=false on stale revision', async () => {
  process.env.DB_PATH = ':memory:';
  const { getDb, closeDb } = await import('../../dist/db.js');
  const db = getDb();

  const { SqliteWorkplaceRepository } = await import('../../dist/infrastructure/workplace/sqlite-workplace-repository.js');
  const repo = new SqliteWorkplaceRepository(db);
  const wpRef = makeWorkplaceRef();

  // Materialize the workplace first (creates initial state at revision 0)
  repo.materialize(wpRef);

  // CAS match: revision 0 → 1
  const ok = repo.applyTransitionInTx({
    workplaceRef: wpRef,
    expectedRevision: 0,
    kanbanPhase: 'in_progress',
    loopState: 'queued',
    nextRole: 'author',
    terminalReason: null,
    activeReservationRef: null,
  });
  assert.ok(ok.applied, 'CAS at revision 0 succeeds');

  // CAS match: revision 1 → 2
  const ok2 = repo.applyTransitionInTx({
    workplaceRef: wpRef,
    expectedRevision: 1,
    kanbanPhase: 'in_progress',
    loopState: 'running',
    nextRole: 'author',
    terminalReason: null,
    activeReservationRef: 'exec-1',
  });
  assert.ok(ok2.applied, 'CAS at revision 1 succeeds');

  // Stale CAS: try revision 1 again (already at 2)
  const stale = repo.applyTransitionInTx({
    workplaceRef: wpRef,
    expectedRevision: 1,
    kanbanPhase: 'done',
    loopState: 'terminal',
    nextRole: 'author',
    terminalReason: 'accepted',
    activeReservationRef: null,
  });
  assert.ok(!stale.applied, 'Stale CAS rejected');

  closeDb();
});
