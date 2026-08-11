// tests/infrastructure/candidate-set-revision-authority.test.mjs
//
// ADR-053 Phase 5 — CandidateSet v2 production-revision authority.
//
// Proves that when productionRevisionRef is provided, the CandidateSet seal
// key is derived from the REVISION (not the execution), so two different
// executions producing the same revision converge to the same CandidateSet.
// This is partition invariance at the CandidateSet level — the Run 011 fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { candidateSetSealKey } from '../../dist/process-modules/domain/workplace/candidate-set.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,active_reservation_ref)
     VALUES ('workplace/1/mod@1.0.0/cell/item',1,'mod@1.0.0','cell','item',
             'in_progress','running','author',1,'exec-1')`,
  ).run();
  return db;
}

const WORKPLACE = {
  processRunId: 1,
  moduleRef: 'mod@1.0.0',
  productionCellId: 'cell',
  workKey: 'item',
};

const MEMBERS = [
  {
    productRef: { schemaId: 'factory.product.v1', ref: 'product/sha256:test', digest: 'sha256:test' },
    origin: 'produced',
    sourceCandidateSetRef: null,
  },
];

// ===========================================================================
// 1. Revision-based seal key — two executions + same revision → same key.
// ===========================================================================
test('Phase 5: revision-based seal key gives partition invariance', () => {
  const revisionRef = 'revision/sha256:abc123';

  // Two different executions producing the same revision.
  const keyA = candidateSetSealKey({
    workplaceRef: WORKPLACE,
    producerExecutionRef: 'exec-A',
    productionRevisionRef: revisionRef,
    role: 'author',
  });
  const keyB = candidateSetSealKey({
    workplaceRef: WORKPLACE,
    producerExecutionRef: 'exec-B',
    productionRevisionRef: revisionRef,
    role: 'author',
  });

  // SAME key despite different executions — partition invariance.
  assert.equal(
    keyA,
    keyB,
    'revision-based seal key: two executions producing the same revision derive the same key',
  );
});

// ===========================================================================
// 2. Legacy fallback — null revision ref uses execution-scoped key (v1).
// ===========================================================================
test('Phase 5: null productionRevisionRef falls back to execution-scoped key (v1)', () => {
  const keyA = candidateSetSealKey({
    workplaceRef: WORKPLACE,
    producerExecutionRef: 'exec-A',
    productionRevisionRef: null,
    role: 'author',
  });
  const keyB = candidateSetSealKey({
    workplaceRef: WORKPLACE,
    producerExecutionRef: 'exec-B',
    productionRevisionRef: null,
    role: 'author',
  });
  assert.notEqual(keyA, keyB, 'execution-scoped fallback: different executions get different keys');
});

// ===========================================================================
// 3. Repository: sealing with a revision ref persists and reads it back.
// ===========================================================================
test('Phase 5: repository persists productionRevisionRef and reads it back', () => {
  const db = makeDb();
  const repo = new SqliteCandidateSetRepository(db);
  const { set } = repo.seal({
    workplaceRef: WORKPLACE,
    producerExecutionRef: 'exec-A',
    productionRevisionRef: 'revision/sha256:rev-1',
    role: 'author',
    subjectCandidateSetRef: null,
    members: MEMBERS,
    sealReceiptRef: 'receipt-1',
    candidateSetDigest: 'a'.repeat(64),
    sealedAt: '2026-08-11T12:00:00Z',
  });
  assert.equal(set.productionRevisionRef, 'revision/sha256:rev-1');

  const read = repo.read(set.candidateSetRef);
  assert.ok(read);
  assert.equal(read.productionRevisionRef, 'revision/sha256:rev-1');
});

// ===========================================================================
// 4. Repository: partition invariance — exec-B finds exec-A's set when they
//    share the same revision.
// ===========================================================================
test('Phase 5: repository partition invariance — second execution finds the first sealed set', () => {
  const db = makeDb();
  const repo = new SqliteCandidateSetRepository(db);
  const revisionRef = 'revision/sha256:shared-rev';
  const digest = 'b'.repeat(64);

  // exec-A seals.
  const { set: setA, replayed: replayedA } = repo.seal({
    workplaceRef: WORKPLACE,
    producerExecutionRef: 'exec-A',
    productionRevisionRef: revisionRef,
    role: 'author',
    subjectCandidateSetRef: null,
    members: MEMBERS,
    sealReceiptRef: 'receipt-A',
    candidateSetDigest: digest,
    sealedAt: '2026-08-11T12:00:00Z',
  });
  assert.equal(replayedA, false);

  // exec-B seals the SAME revision with the SAME members.
  const { set: setB, replayed: replayedB } = repo.seal({
    workplaceRef: WORKPLACE,
    producerExecutionRef: 'exec-B',
    productionRevisionRef: revisionRef,
    role: 'author',
    subjectCandidateSetRef: null,
    members: MEMBERS,
    sealReceiptRef: 'receipt-B',
    candidateSetDigest: digest,
    sealedAt: '2026-08-11T13:00:00Z',
  });

  // SAME ref — exec-B found exec-A's set. Partition invariance at the
  // CandidateSet level: recovery does not create a divergent set.
  assert.equal(setA.candidateSetRef, setB.candidateSetRef);
  assert.equal(replayedB, true);

  // Only one row in the table.
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_candidate_sets',
  ).get().n;
  assert.equal(count, 1);
});

// ===========================================================================
// 5. Repository: legacy v1 seal (null revision ref) still works.
// ===========================================================================
test('Phase 5: legacy v1 seal (null revision ref) still works', () => {
  const db = makeDb();
  const repo = new SqliteCandidateSetRepository(db);
  const { set } = repo.seal({
    workplaceRef: WORKPLACE,
    producerExecutionRef: 'exec-A',
    role: 'author',
    subjectCandidateSetRef: null,
    members: MEMBERS,
    sealReceiptRef: 'receipt-1',
    candidateSetDigest: 'c'.repeat(64),
    sealedAt: '2026-08-11T12:00:00Z',
  });
  assert.equal(set.productionRevisionRef, null);
  const read = repo.read(set.candidateSetRef);
  assert.ok(read);
  assert.equal(read.productionRevisionRef, null);
});
