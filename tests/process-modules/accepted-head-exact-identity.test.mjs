// tests/process-modules/accepted-head-exact-identity.test.mjs
//
// K13 (M3) — card commit 1, the canonical failing theorem:
// "a revision number cannot be reused with different accepted identity",
// where identity is the FULL byte-identical authority identity the card's
// commit 2 puts on the head: the frozen check-plan digest, the package
// fingerprint (the accepting decision's installation digest), the production
// revision, the ordered ProductRefs, and the CAS baseline the commit was
// fenced on — content-addressed together as one acceptance id.
//
// RED AGAINST THE CURRENT HEAD. The guard landed in 5bb9ec7f compares only
// the pointer triple (candidate set / gate decision / task id). A
// same-revision record whose POINTER TRIPLE matches but whose extended
// identity differs is silently swallowed as an "idempotent" no-op — a
// persisted fact standing in for the byte-identity proof. Card commit 2
// (extend AcceptedAuthorityHead) is what makes these theorems pass; if they
// pass before it, the wrong theorem was written.
//
// WHAT THIS PROVES WHEN GREEN:
//   1. same accepted revision ⇒ byte-identical authority identity, in EVERY
//      dimension the card names — not just the pointer triple;
//   2. the head PERSISTS that identity (acceptance id + the named fields),
//      so what revision N meant is checkable from the head row alone;
//   3. the acceptance id is a deterministic content address — the same
//      identity yields the same bytes in any database.
//
// WHO EXTENDS THE DIMENSION LIST: nobody, silently. The dimensions are the
// card's, verbatim (plan §K13 commit 2). Adding one is a deliberate
// architectural act and changes this file in the same commit, with the same
// justification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteAcceptedAuthorityHeadRepository } from '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';

const WP = 'workplace/1/m@1.0.0/cell/work-1';

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  return { db, repo: new SqliteAcceptedAuthorityHeadRepository(db) };
}

// The FULL accepted identity the K13 card names. The pointer triple is
// deliberately IDENTICAL across all drift cases below — the drift is only
// ever in the extended identity, which is exactly what the current guard
// cannot see.
function recordFull(revision, drift = {}) {
  return {
    workplaceRef: WP,
    acceptedAuthorCandidateSetRef: drift.candidateSetRef ?? 'candidate-set/A',
    acceptedAuthorGateDecisionKey: drift.gateDecisionKey ?? 'decision/A',
    revision,
    acceptedAuthorTaskId: drift.taskId !== undefined ? drift.taskId : 'task-1',
    productionRevisionRef: drift.productionRevisionRef ?? 'workplace-production-revision/A',
    productRefs: drift.productRefs ?? ['product/alpha@1', 'product/beta@2'],
    checkPlanDigest: drift.checkPlanDigest ?? 'sha256:check-plan/A',
    packageFingerprint: drift.packageFingerprint ?? 'sha256:installation/A',
    baselineWorkplaceRevision: drift.baselineWorkplaceRevision ?? 6,
    now: () => new Date('2026-08-18T00:00:00Z'),
  };
}

// ---------------------------------------------------------------------------
// The canonical theorem — RED until card commit 2 extends the head.
// ---------------------------------------------------------------------------

test('K13/exact-identity (RED until the head carries it): same revision cannot be reused with a different check-plan digest', () => {
  const { repo } = fixture();
  repo.record(recordFull(7));
  assert.throws(
    () => repo.record(recordFull(7, { checkPlanDigest: 'sha256:check-plan/DRIFTED' })),
    /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
    'the frozen check plan is part of the accepted identity — a same-revision '
    + 'record with a different check-plan digest must fail closed, not no-op',
  );
});

test('K13/exact-identity (RED until the head carries it): same revision cannot be reused with a different package fingerprint', () => {
  const { repo } = fixture();
  repo.record(recordFull(7));
  assert.throws(
    () => repo.record(recordFull(7, { packageFingerprint: 'sha256:installation/DRIFTED' })),
    /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
    'the accepting installation (package fingerprint) is part of the accepted '
    + 'identity — drift at the same revision must fail closed',
  );
});

test('K13/exact-identity (RED until the head carries it): same revision cannot be reused with a different production revision', () => {
  const { repo } = fixture();
  repo.record(recordFull(7));
  assert.throws(
    () => repo.record(recordFull(7, { productionRevisionRef: 'workplace-production-revision/DRIFTED' })),
    /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
    'the accepted CandidateSet\'s production revision is part of the accepted '
    + 'identity — drift at the same revision must fail closed',
  );
});

test('K13/exact-identity (RED until the head carries it): same revision cannot be reused with different ProductRefs', () => {
  const { repo } = fixture();
  repo.record(recordFull(7));
  for (const drifted of [
    ['product/alpha@1'],
    ['product/alpha@1', 'product/beta@2', 'product/gamma@3'],
    ['product/beta@2', 'product/alpha@1'],
  ]) {
    assert.throws(
      () => repo.record(recordFull(7, { productRefs: drifted })),
      /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
      `the ordered ProductRefs are part of the accepted identity (member set AND order): ${JSON.stringify(drifted)}`,
    );
  }
});

test('K13/exact-identity (RED until the head carries it): same revision cannot be reused with a different CAS baseline', () => {
  const { repo } = fixture();
  repo.record(recordFull(7));
  assert.throws(
    () => repo.record(recordFull(7, { baselineWorkplaceRevision: 5 })),
    /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
    'the CAS baseline the commit was fenced on is part of the accepted '
    + 'identity — drift at the same revision must fail closed',
  );
});

test('K13/exact-identity (RED until the head carries it): the head persists the byte-identical acceptance identity', () => {
  const { repo } = fixture();
  repo.record(recordFull(7));
  const head = repo.read(WP);
  assert.ok(head, 'head row exists');
  assert.match(
    head.acceptanceId ?? '',
    /^authority-acceptance:[0-9a-f]{64}$/u,
    'the head carries a content-addressed acceptance id over the full identity body',
  );
  assert.equal(head.checkPlanDigest, 'sha256:check-plan/A');
  assert.equal(head.packageFingerprint, 'sha256:installation/A');
  assert.equal(head.productionRevisionRef, 'workplace-production-revision/A');
  assert.deepEqual(head.productRefs, ['product/alpha@1', 'product/beta@2']);
  assert.equal(head.baselineWorkplaceRevision, 6);

  // The same identity replays to the SAME acceptance id (duplicate
  // acknowledgement converges) — and the content address is deterministic
  // across databases.
  const other = fixture();
  other.repo.record(recordFull(7));
  const otherHead = other.repo.read(WP);
  assert.equal(otherHead.acceptanceId, head.acceptanceId,
    'the acceptance id is a deterministic content address, not a row id');
});

test('K13/exact-identity: the same full identity at the same revision replays idempotently', () => {
  const { repo } = fixture();
  repo.record(recordFull(7));
  const before = repo.read(WP);
  repo.record(recordFull(7));
  const after = repo.read(WP);
  assert.equal(after.acceptanceId, before.acceptanceId);
  assert.equal(after.revision, before.revision);
  assert.equal(after.recordedAt, before.recordedAt,
    'an identical replay does not even touch the recorded_at — it is a true no-op');
});
