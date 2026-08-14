// tests/infrastructure/candidate-set-revision-authority.test.mjs
//
// ADR-053 — CandidateSet v2 production-revision authority + B-1 cutover.
//
// Proves:
//  1. the CandidateSet seal key is derived from the REVISION (not the
//     execution) → partition invariance at the CandidateSet level (Run 011 fix);
//  2. the repository persists productionRevisionRef and reads it back;
//  3. B-1: a CandidateSet may NEVER reference a revision that was not persisted
//     (enforced structurally via FK + the atomic append+seal transaction);
//  4. B-1: appendRevision + CandidateSet seal are atomic — if the seal fails,
//     the revision append is rolled back (all-or-nothing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { candidateSetSealKey } from '../../dist/process-modules/domain/workplace/candidate-set.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteWorkplaceProductionRevisionRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-production-revision-repository.js';
import { assembleRevision, buildContribution } from '../../dist/process-modules/domain/workplace/workplace-production-revision.js';
import { TransitionObligationIntegrator } from '../../dist/process-modules/application/transition-obligation-integrator.js';
import { SqliteTransitionObligationLedger } from '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';

const WORKPLACE_SERIALIZED = 'workplace/1/mod@1.0.0/cell/item';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(`INSERT INTO projects (id,name) VALUES (1,'p')`).run();
  db.prepare(`INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')`).run();
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision,active_reservation_ref)
     VALUES ('${WORKPLACE_SERIALIZED}',1,'mod@1.0.0','cell','item',
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

// Insert a minimal revision row so a CandidateSet may reference it (FK target).
function insertRevision(db, revisionRef) {
  db.prepare(
    `INSERT INTO factory_workplace_production_revisions
       (revision_ref, workplace_ref, parent_revision_ref, members,
        contributing_execution_refs, presenter_ref, material_digest,
        semantic_digest, sealed_at)
     VALUES (?, ?, NULL, '[]', '[]', '', ?, ?, '2026-08-12T00:00:00Z')`,
  ).run(revisionRef, WORKPLACE_SERIALIZED, revisionRef, revisionRef);
}

// Build a real content-addressed revision (used by the atomic tests).
function buildRevision(executionRef) {
  const contribution = buildContribution({
    workplaceRef: WORKPLACE_SERIALIZED,
    contributorExecutionRef: executionRef,
    sourceAdapter: 'typed-submission',
    operations: [{
      op: 'put',
      memberKey: 'product/factory.product.v1/product/sha256:test',
      productRef: 'product/sha256:test',
      contentDigest: 'sha256:test',
      sourceAdapter: 'typed-submission',
    }],
    parentContributionRef: null,
  });
  return assembleRevision({
    workplaceRef: WORKPLACE_SERIALIZED,
    parent: null,
    contributions: [contribution],
    presenterRef: executionRef,
  });
}

// ===========================================================================
// 1. Revision-based seal key — two executions + same revision → same key.
//    (ADR-053 clean-break: there is NO execution-scoped fallback. The legacy
//    v1 fallback test was removed — fallback is forbidden.)
// ===========================================================================
test('Phase 5: revision-based seal key gives partition invariance', () => {
  const revisionRef = 'revision/sha256:abc123';

  const keyA = candidateSetSealKey({
    workplaceRef: WORKPLACE,
    productionRevisionRef: revisionRef,
    role: 'author',
  });
  const keyB = candidateSetSealKey({
    workplaceRef: WORKPLACE,
    productionRevisionRef: revisionRef,
    role: 'author',
  });

  assert.equal(
    keyA,
    keyB,
    'revision-based seal key: two executions producing the same revision derive the same key',
  );
});

// ===========================================================================
// 2. Repository: sealing with a persisted revision ref round-trips.
// ===========================================================================
test('Phase 5: repository persists productionRevisionRef and reads it back', () => {
  const db = makeDb();
  insertRevision(db, 'revision/sha256:rev-1');
  const repo = new SqliteCandidateSetRepository(db);
  const { set } = repo.seal({
    workplaceRef: WORKPLACE,
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
// 3. Repository: partition invariance — exec-B finds exec-A's set when they
//    share the same revision.
// ===========================================================================
test('Phase 5: repository partition invariance — second execution finds the first sealed set', () => {
  const db = makeDb();
  insertRevision(db, 'revision/sha256:shared-rev');
  const repo = new SqliteCandidateSetRepository(db);
  const digest = 'b'.repeat(64);

  const { set: setA, replayed: replayedA } = repo.seal({
    workplaceRef: WORKPLACE,
    productionRevisionRef: 'revision/sha256:shared-rev',
    role: 'author',
    subjectCandidateSetRef: null,
    members: MEMBERS,
    sealReceiptRef: 'receipt-A',
    candidateSetDigest: digest,
    sealedAt: '2026-08-11T12:00:00Z',
  });
  assert.equal(replayedA, false);

  const { set: setB, replayed: replayedB } = repo.seal({
    workplaceRef: WORKPLACE,
    productionRevisionRef: 'revision/sha256:shared-rev',
    role: 'author',
    subjectCandidateSetRef: null,
    members: MEMBERS,
    sealReceiptRef: 'receipt-B',
    candidateSetDigest: digest,
    sealedAt: '2026-08-11T12:00:00Z',
  });
  assert.equal(replayedB, true);
  assert.equal(setB.candidateSetRef, setA.candidateSetRef);

  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_candidate_sets',
  ).get().n;
  assert.equal(count, 1);
});

// ===========================================================================
// 4. B-1: a CandidateSet may NEVER reference a revision that was not persisted.
//    Enforced structurally (FK; foreign_keys=ON in db.ts).
// ===========================================================================
test('B-1: sealing with a non-persisted revision ref is rejected (FK)', () => {
  const db = makeDb();
  const repo = new SqliteCandidateSetRepository(db);
  // Deliberately do NOT insert 'revision/sha256:absent'.
  assert.throws(
    () => repo.seal({
      workplaceRef: WORKPLACE,
      productionRevisionRef: 'revision/sha256:absent',
      role: 'author',
      subjectCandidateSetRef: null,
      members: MEMBERS,
      sealReceiptRef: 'receipt-fk',
      candidateSetDigest: 'c'.repeat(64),
      sealedAt: '2026-08-12T00:00:00Z',
    }),
    err => err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY',
    'sealing against an absent revision must fail with an FK violation',
  );

  // And no CandidateSet row was left behind.
  const count = db.prepare('SELECT COUNT(*) AS n FROM factory_candidate_sets').get().n;
  assert.equal(count, 0);
});

// ===========================================================================
// 5. B-1: appendRevision + CandidateSet seal are atomic — both rows appear.
// ===========================================================================
test('B-1: appendRevision + seal are atomic — both rows appear together', () => {
  const db = makeDb();
  const revisionRepo = new SqliteWorkplaceProductionRevisionRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  const revision = buildRevision('exec-A');

  const sealed = revisionRepo.transaction(() => {
    revisionRepo.appendRevision(revision);
    return candidateSetRepo.seal({
      workplaceRef: WORKPLACE,
      productionRevisionRef: revision.revisionRef,
      role: 'author',
      subjectCandidateSetRef: null,
      members: MEMBERS,
      sealReceiptRef: 'receipt-atomic',
      candidateSetDigest: 'd'.repeat(64),
      sealedAt: '2026-08-12T00:00:00Z',
    }).set;
  });

  const revRow = db.prepare(
    'SELECT revision_ref AS r FROM factory_workplace_production_revisions WHERE revision_ref=?',
  ).get(revision.revisionRef);
  assert.ok(revRow, 'revision row persisted');

  const csRow = db.prepare(
    'SELECT production_revision_ref AS r FROM factory_candidate_sets WHERE candidate_set_ref=?',
  ).get(sealed.candidateSetRef);
  assert.ok(csRow);
  assert.equal(csRow.r, revision.revisionRef, 'CandidateSet links the persisted revision');
});

// ===========================================================================
// 6. B-1: if the seal fails, the revision append is rolled back (atomic).
// ===========================================================================
test('B-1: if seal fails, the revision append is rolled back', () => {
  const db = makeDb();
  const revisionRepo = new SqliteWorkplaceProductionRevisionRepository(db);
  const revision = buildRevision('exec-A');

  // Stub CandidateSet repo whose seal always throws.
  const throwingRepo = {
    seal() { throw new Error('FORCED_SEAL_FAILURE'); },
  };

  assert.throws(
    () => revisionRepo.transaction(() => {
      revisionRepo.appendRevision(revision);
      return throwingRepo.seal({});
    }),
    /FORCED_SEAL_FAILURE/,
  );

  // Rollback: no revision row committed.
  const revRow = db.prepare(
    'SELECT revision_ref AS r FROM factory_workplace_production_revisions WHERE revision_ref=?',
  ).get(revision.revisionRef);
  assert.equal(revRow, undefined, 'revision append rolled back when the seal fails');
});

// ===========================================================================
// 8. B-8: obligation recorded atomically with the CandidateSet seal.
// ===========================================================================
test('B-8: run-gate obligation is appended atomically with the seal', () => {
  const db = makeDb();
  const revisionRepo = new SqliteWorkplaceProductionRevisionRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  const integrator = new TransitionObligationIntegrator({
    ledger: new SqliteTransitionObligationLedger(db),
  });
  const revision = buildRevision('exec-A');

  const sealed = revisionRepo.transaction(() => {
    revisionRepo.appendRevision(revision);
    const set = candidateSetRepo.seal({
      workplaceRef: WORKPLACE,
      productionRevisionRef: revision.revisionRef,
      role: 'author',
      subjectCandidateSetRef: null,
      members: MEMBERS,
      sealReceiptRef: 'receipt-b8',
      candidateSetDigest: '8'.repeat(64),
      sealedAt: '2026-08-12T00:00:00Z',
    }).set;
    integrator.onCandidateSetSealed({
      candidateSetRef: set.candidateSetRef,
      candidateSetDigest: '8'.repeat(64),
      workplaceRef: WORKPLACE_SERIALIZED,
      fence: 1,
    });
    return set;
  });

  // All three committed together: revision, CandidateSet, run-gate obligation.
  assert.ok(db.prepare('SELECT revision_ref AS r FROM factory_workplace_production_revisions WHERE revision_ref=?').get(revision.revisionRef));
  assert.ok(db.prepare('SELECT candidate_set_ref AS r FROM factory_candidate_sets WHERE candidate_set_ref=?').get(sealed.candidateSetRef));
  const obl = db.prepare('SELECT handoff_kind AS h FROM factory_transition_obligations WHERE source_ref=?').get(sealed.candidateSetRef);
  assert.ok(obl, 'run-gate obligation recorded atomically with the seal');
  assert.equal(obl.h, 'run-gate');
});

test('B-8: if the obligation append fails, the seal rolls back (atomic, non-suppressed)', () => {
  const db = makeDb();
  const revisionRepo = new SqliteWorkplaceProductionRevisionRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);
  // Integrator whose append throws — simulates a ledger failure. B-8: errors
  // propagate (non-suppressed) and, inside the seal txn, roll the seal back.
  const throwingIntegrator = {
    onCandidateSetSealed() { throw new Error('OBLIGATION_APPEND_FAILED'); },
  };
  const revision = buildRevision('exec-A');

  assert.throws(
    () => revisionRepo.transaction(() => {
      revisionRepo.appendRevision(revision);
      const set = candidateSetRepo.seal({
        workplaceRef: WORKPLACE,
        productionRevisionRef: revision.revisionRef,
        role: 'author',
        subjectCandidateSetRef: null,
        members: MEMBERS,
        sealReceiptRef: 'receipt-b8-rollback',
        candidateSetDigest: '9'.repeat(64),
        sealedAt: '2026-08-12T00:00:00Z',
      }).set;
      throwingIntegrator.onCandidateSetSealed({
        candidateSetRef: set.candidateSetRef,
        candidateSetDigest: '9'.repeat(64),
        workplaceRef: WORKPLACE_SERIALIZED,
        fence: 1,
      });
      return set;
    }),
    /OBLIGATION_APPEND_FAILED/,
  );

  // Atomic rollback: neither the revision nor the CandidateSet committed.
  assert.equal(
    db.prepare('SELECT revision_ref AS r FROM factory_workplace_production_revisions WHERE revision_ref=?').get(revision.revisionRef),
    undefined,
    'revision rolled back when the obligation append fails',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_candidate_sets').get().n, 0, 'CandidateSet rolled back');
});

// ===========================================================================
// 7. B-2: two partitions sealing equivalent material converge to ONE
//    CandidateSet authority (semanticDigest probe).
// ===========================================================================
test('B-2: two partitions sealing equivalent material converge to one CandidateSet', () => {
  const db = makeDb();
  const revisionRepo = new SqliteWorkplaceProductionRevisionRepository(db);
  const candidateSetRepo = new SqliteCandidateSetRepository(db);

  // Partition A: exec-A produces X (one contribution).
  const revisionA = buildRevision('exec-A');

  // Partition B: exec-A produced X, then exec-B recovered and produced X again
  // (different contributor/presenter partition, SAME material).
  const revisionB = buildRevision('exec-B');

  // Same material → the same partition-invariant authority identity.
  assert.equal(revisionB.semanticDigest, revisionA.semanticDigest);
  assert.equal(revisionB.materialDigest, revisionA.materialDigest);
  assert.equal(revisionB.revisionRef, revisionA.revisionRef);

  // Partition A seals first.
  const setA = revisionRepo.transaction(() => {
    revisionRepo.appendRevision(revisionA);
    return candidateSetRepo.seal({
      workplaceRef: WORKPLACE,
      productionRevisionRef: revisionA.revisionRef,
      role: 'author',
      subjectCandidateSetRef: null,
      members: MEMBERS,
      sealReceiptRef: 'receipt-A',
      candidateSetDigest: 'f'.repeat(64),
      sealedAt: '2026-08-12T00:00:00Z',
    }).set;
  });

  // Partition B seals the SAME material via the convergence probe: it finds
  // partition A's revision by semanticDigest and reuses its revisionRef, so the
  // CandidateSet seal key matches → B replays A (one authority).
  const resultB = revisionRepo.transaction(() => {
    const existing = revisionRepo.getRevisionBySemanticDigest(
      revisionB.workplaceRef, revisionB.semanticDigest,
    );
    const finalRef = existing?.revisionRef ?? revisionB.revisionRef;
    if (!existing) revisionRepo.appendRevision(revisionB);
    return candidateSetRepo.seal({
      workplaceRef: WORKPLACE,
      productionRevisionRef: finalRef,
      role: 'author',
      subjectCandidateSetRef: null,
      members: MEMBERS,
      sealReceiptRef: 'receipt-B',
      candidateSetDigest: 'f'.repeat(64),
      sealedAt: '2026-08-12T00:00:00Z',
    });
  });

  assert.equal(resultB.replayed, true, 'B-2: partition B replays partition A — seal-key convergence');
  assert.equal(resultB.set.candidateSetRef, setA.candidateSetRef, 'B-2: one CandidateSet authority across partitions');

  // Exactly one CandidateSet row and one revision row referenced.
  const csCount = db.prepare('SELECT COUNT(*) AS n FROM factory_candidate_sets').get().n;
  assert.equal(csCount, 1);
});

test('ADR-053 C14: cumulative revision — X-then-Y (two executions) ≡ X+Y (one execution)', () => {
  const op = (key, ref, digest) => ({
    op: 'put', memberKey: key, productRef: ref, contentDigest: digest, sourceAdapter: 'typed-submission',
  });
  const xOp = op('product/S/x', 'product/x', 'sha256:x');
  const yOp = op('product/S/y', 'product/y', 'sha256:y');
  const contrib = (exec, ops) => buildContribution({
    workplaceRef: WORKPLACE_SERIALIZED,
    contributorExecutionRef: exec,
    sourceAdapter: 'typed-submission',
    operations: ops,
    parentContributionRef: null,
  });

  // One execution produces X+Y.
  const both = assembleRevision({
    workplaceRef: WORKPLACE_SERIALIZED, parent: null,
    contributions: [contrib('A', [xOp, yOp])], presenterRef: 'A',
  });
  // Two executions: A produces X, then B produces Y on top of A's revision.
  const justX = assembleRevision({
    workplaceRef: WORKPLACE_SERIALIZED, parent: null,
    contributions: [contrib('A', [xOp])], presenterRef: 'A',
  });
  const thenY = assembleRevision({
    workplaceRef: WORKPLACE_SERIALIZED, parent: justX,
    contributions: [contrib('B', [yOp])], presenterRef: 'B',
  });

  // C14: the cumulative two-execution revision carries the SAME material as the
  // single-execution X+Y revision (X-then-Y ≡ X+Y). This is the partition
  // property the QA said was "not proven in production": assembling Y as a delta
  // over the exact parent revision X yields the same semantic material as one
  // execution producing X+Y.
  assert.equal(thenY.semanticDigest, both.semanticDigest,
    'X-then-Y must converge to the same semanticDigest as X+Y');
  assert.deepEqual(
    thenY.members.map(m => m.memberKey).sort(),
    both.members.map(m => m.memberKey).sort(),
    'X-then-Y must carry the same members as X+Y',
  );
  assert.equal(thenY.parentRevisionRef, justX.revisionRef,
    'cumulative revision records the exact parent');
});
