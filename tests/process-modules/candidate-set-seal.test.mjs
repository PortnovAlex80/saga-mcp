/**
 * Test: CandidateSet seal at the repository level — ADR-053 C2.
 *
 * The domain-level REG-12 tests (workplace-domain.test.mjs) prove the seal KEY
 * binds a reviewer to its subject. This file proves the REPOSITORY honours that:
 * two reviewer CandidateSets over DIFFERENT author subjects coexist (distinct
 * refs, both persisted), while a replay of the same (workplace, revision,
 * subject) is idempotent and a different digest under the same key is rejected.
 *
 * This is the property the old combined UNIQUE(workplace,revision,role) broke:
 * it would have forbidden two reviewer sets under one (workplace, revision).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteCandidateSetRepository } from '../../dist/infrastructure/workplace/sqlite-candidate-set-repository.js';
import { SqliteWorkplaceRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-repository.js';
import { SqliteWorkplaceProductionRevisionRepository } from '../../dist/infrastructure/workplace/sqlite-workplace-production-revision-repository.js';
import { assembleRevision, buildContribution } from '../../dist/process-modules/domain/workplace/workplace-production-revision.js';

const hash = (s) => createHash('sha256').update(s).digest('hex');

const REF = { processRunId: 1, moduleRef: 'sf@1', productionCellId: 'cell', workKey: 'default' };

function freshDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  new SqliteWorkplaceRepository(db).materialize(REF);
  return db;
}

// Append one minimal revision so CandidateSets may reference it (FK target).
function appendRevision(db, presenterRef) {
  const repo = new SqliteWorkplaceProductionRevisionRepository(db);
  const contribution = buildContribution({
    workplaceRef: 'workplace/1/sf@1/cell/default',
    contributorExecutionRef: presenterRef,
    sourceAdapter: 'typed-submission',
    operations: [{
      op: 'create',
      memberKey: 'product/SRS/0',
      productRef: 'artifact:1',
      contentDigest: hash('SRS'),
      sourceAdapter: 'typed-submission',
    }],
    parentContributionRef: null,
  });
  const revision = assembleRevision({
    workplaceRef: 'workplace/1/sf@1/cell/default',
    parent: null,
    contributions: [contribution],
    presenterRef,
  });
  repo.appendRevision(revision);
  return revision.revisionRef;
}

function member(digest = hash('SRS')) {
  return {
    productRef: { schemaId: 'SRS', ref: 'artifact:1', digest },
    origin: 'produced',
    sourceCandidateSetRef: null,
  };
}

test('REG-12-AC-01: seal creates an immutable author set referencing the revision', () => {
  const db = freshDb();
  const revisionRef = appendRevision(db, 'exec-1');
  const repo = new SqliteCandidateSetRepository(db);
  const { set, replayed } = repo.seal({
    workplaceRef: REF,
    productionRevisionRef: revisionRef,
    role: 'author',
    subjectCandidateSetRef: null,
    members: [member()],
    candidateSetDigest: hash('members'),
    sealReceiptRef: 'execution-complete:exec-1',
    sealedAt: '2026-08-04T12:00:00Z',
  });
  assert.ok(set.candidateSetRef);
  assert.equal(replayed, false);
  assert.equal(set.productionRevisionRef, revisionRef);
  db.close();
});

test('REG-12-AC-01: seal is idempotent on the same digest (replay)', () => {
  const db = freshDb();
  const revisionRef = appendRevision(db, 'exec-1');
  const repo = new SqliteCandidateSetRepository(db);
  const input = {
    workplaceRef: REF,
    productionRevisionRef: revisionRef,
    role: 'author',
    subjectCandidateSetRef: null,
    members: [member()],
    candidateSetDigest: hash('digest'),
    sealReceiptRef: 'execution-complete:exec-1',
    sealedAt: '2026-08-04T12:00:00Z',
  };
  const first = repo.seal(input);
  const second = repo.seal(input);
  assert.equal(first.set.candidateSetRef, second.set.candidateSetRef);
  assert.equal(second.replayed, true);
  db.close();
});

test('REG-12-AC-01: a different digest under the same seal key is rejected', () => {
  const db = freshDb();
  const revisionRef = appendRevision(db, 'exec-1');
  const repo = new SqliteCandidateSetRepository(db);
  const base = {
    workplaceRef: REF,
    productionRevisionRef: revisionRef,
    role: 'author',
    subjectCandidateSetRef: null,
    members: [member()],
    sealReceiptRef: 'execution-complete:exec-1',
    sealedAt: '2026-08-04T12:00:00Z',
  };
  repo.seal({ ...base, candidateSetDigest: hash('a') });
  assert.throws(
    () => repo.seal({ ...base, candidateSetDigest: 'b'.repeat(64) }),
    /CANDIDATE_SET_REPLAY_MISMATCH/,
  );
  db.close();
});

test('ADR-053 C2: two reviewer sets over DIFFERENT author subjects coexist (distinct refs)', () => {
  const db = freshDb();
  const revisionRef = appendRevision(db, 'exec-reviewer');
  const repo = new SqliteCandidateSetRepository(db);
  const reviewerBase = {
    workplaceRef: REF,
    productionRevisionRef: revisionRef,
    role: 'reviewer',
    members: [member()],
    sealReceiptRef: 'execution-complete:exec-reviewer',
    sealedAt: '2026-08-04T12:00:00Z',
  };
  const a = repo.seal({ ...reviewerBase, subjectCandidateSetRef: 'author-set-A', candidateSetDigest: hash('A') }).set;
  // A second reviewer verdict over a DIFFERENT subject must NOT collide with the
  // first — both persist under distinct refs (the partial unique index permits
  // this; the old combined UNIQUE(workplace,revision,role) would have forbade it).
  const b = repo.seal({ ...reviewerBase, subjectCandidateSetRef: 'author-set-B', candidateSetDigest: hash('B') }).set;
  assert.notEqual(a.candidateSetRef, b.candidateSetRef, 'reviewer sets for different subjects must have distinct refs');
  // Both rows are present.
  assert.ok(repo.read(a.candidateSetRef));
  assert.ok(repo.read(b.candidateSetRef));
  db.close();
});

test('ADR-053 C2: replaying the same (workplace, revision, subject) reviewer set is idempotent', () => {
  const db = freshDb();
  const revisionRef = appendRevision(db, 'exec-reviewer');
  const repo = new SqliteCandidateSetRepository(db);
  const input = {
    workplaceRef: REF,
    productionRevisionRef: revisionRef,
    role: 'reviewer',
    subjectCandidateSetRef: 'author-set-A',
    members: [member()],
    candidateSetDigest: hash('A'),
    sealReceiptRef: 'execution-complete:exec-reviewer',
    sealedAt: '2026-08-04T12:00:00Z',
  };
  const first = repo.seal(input);
  const second = repo.seal(input);
  assert.equal(first.set.candidateSetRef, second.set.candidateSetRef);
  assert.equal(second.replayed, true);
  db.close();
});

test('ADR-053 C3: replay returns the PERSISTED authority (not the new input receipt/time)', () => {
  const db = freshDb();
  const revisionRef = appendRevision(db, 'exec-1');
  const repo = new SqliteCandidateSetRepository(db);
  const base = {
    workplaceRef: REF,
    productionRevisionRef: revisionRef,
    role: 'author',
    subjectCandidateSetRef: null,
    members: [member()],
    candidateSetDigest: hash('replay-c3'),
    sealedAt: '2026-08-04T12:00:00Z',
  };
  const first = repo.seal({ ...base, sealReceiptRef: 'execution-complete:exec-1' });
  // A replay with a DIFFERENT receipt + timestamp must return the FIRST seal's
  // persisted receipt/time, NOT overwrite the sealed row with the new input.
  const second = repo.seal({
    ...base,
    sealReceiptRef: 'execution-complete:exec-2',
    sealedAt: '2026-09-01T00:00:00Z',
  });
  assert.equal(second.replayed, true);
  assert.equal(second.set.sealReceiptRef, first.set.sealReceiptRef,
    'replay must return the persisted receipt, not the new input');
  assert.equal(second.set.sealedAt, first.set.sealedAt,
    'replay must return the persisted sealedAt, not the new input');
  db.close();
});

test('ADR-053 C15: two partitions with the same material converge to ONE persisted revision', () => {
  const db = freshDb();
  const repo = new SqliteWorkplaceProductionRevisionRepository(db);
  // Partition A and B produce the SAME material (same memberKey + contentDigest)
  // through different executions. semanticDigest strips provenance, so it
  // matches, and material-only revision refs are identical.
  const buildRevision = (presenterRef) => {
    const contribution = buildContribution({
      workplaceRef: 'workplace/1/sf@1/cell/default',
      contributorExecutionRef: presenterRef,
      sourceAdapter: 'typed-submission',
      operations: [{
        op: 'create',
        memberKey: 'product/SRS/product:1',
        productRef: 'artifact:1',
        contentDigest: hash('shared-content'),
        sourceAdapter: 'typed-submission',
      }],
      parentContributionRef: null,
    });
    return assembleRevision({
      workplaceRef: 'workplace/1/sf@1/cell/default',
      parent: null,
      contributions: [contribution],
      presenterRef,
    });
  };
  const revisionA = buildRevision('exec-A');
  const first = repo.appendRevision(revisionA);
  // Partition B: same material, different presenter → same material authority.
  const revisionB = buildRevision('exec-B');
  assert.equal(revisionB.semanticDigest, revisionA.semanticDigest, 'fixture: same semantic digest');
  assert.equal(revisionB.revisionRef, revisionA.revisionRef, 'fixture: same material revisionRef');
  // C15: the second append MUST return the PERSISTED first revision (the
  // structural UNIQUE(workplace, semantic_digest) deduped it), not its own input.
  const result = repo.appendRevision(revisionB);
  assert.equal(result.revisionRef, first.revisionRef,
    'second partition must converge to the persisted first revision');
  db.close();
});
