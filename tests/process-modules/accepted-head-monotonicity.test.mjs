// tests/process-modules/accepted-head-monotonicity.test.mjs
//
// K13 commit 1 — the accepted-head invariants (the plan's "same-revision
// different-refs" theorem, plus monotonic movement).
//
// THEOREM (RED against the current unguarded upsert):
//   1. MONOTONIC: the head only moves FORWARD — recording at a revision
//      LOWER than the persisted one is a typed AUTHORITY_HEAD_REGRESSION
//      (a concurrent/stale writer must not roll accepted authority back).
//   2. SAME-REVISION IDENTITY: recording at the SAME revision with a
//      DIFFERENT accepted identity (candidate set / gate decision / task)
//      is a typed AUTHORITY_HEAD_IDENTITY_CONFLICT — a revision number can
//      never be reused for different accepted identity ("same accepted
//      revision => byte-identical authority identity").
//   3. IDEMPOTENT: the same revision + the same identity records once (a
//      crash-recovery replay converges without error).
//   4. FORWARD: a strictly higher revision moves the head.
//
// The single writer is the AuthorityCommit path (pinned separately); these
// invariants hold even if a second writer appeared — the table itself
// refuses non-monotonic identity.

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

function recordAt(revision, identity = {}) {
  return {
    workplaceRef: WP,
    acceptedAuthorCandidateSetRef: identity.candidateSetRef ?? 'candidate-set/A',
    acceptedAuthorGateDecisionKey: identity.gateDecisionKey ?? 'decision/A',
    revision,
    acceptedAuthorTaskId: identity.taskId !== undefined ? identity.taskId : 'task-1',
    now: () => new Date('2026-08-18T00:00:00Z'),
  };
}

function headRow(db) {
  return db.prepare(
    `SELECT accepted_author_candidate_set_ref AS cs,
            accepted_author_gate_decision_key AS gd,
            accepted_author_task_id AS task,
            revision
       FROM factory_accepted_authority_head WHERE workplace_ref=?`,
  ).get(WP);
}

test('K13/head: forward movement and idempotent replay converge', () => {
  const { db, repo } = fixture();
  repo.record(recordAt(5));
  assert.deepEqual(headRow(db), { cs: 'candidate-set/A', gd: 'decision/A', task: 'task-1', revision: 5 });

  // Same revision + same identity: idempotent (crash-recovery replay).
  repo.record(recordAt(5));
  assert.deepEqual(headRow(db), { cs: 'candidate-set/A', gd: 'decision/A', task: 'task-1', revision: 5 });

  // Higher revision: moves forward.
  repo.record(recordAt(7, { candidateSetRef: 'candidate-set/B', gateDecisionKey: 'decision/B', taskId: 'task-2' }));
  assert.deepEqual(headRow(db), { cs: 'candidate-set/B', gd: 'decision/B', task: 'task-2', revision: 7 });
});

test('K13/head (RED until fixed): a lower revision cannot roll accepted authority back', () => {
  const { db, repo } = fixture();
  repo.record(recordAt(7));
  assert.throws(
    () => repo.record(recordAt(5, { candidateSetRef: 'candidate-set/STALE' })),
    /AUTHORITY_HEAD_REGRESSION/u,
    'monotonic movement: a stale concurrent writer must fail closed',
  );
  assert.equal(headRow(db).revision, 7);
  assert.equal(headRow(db).cs, 'candidate-set/A', 'the head is unchanged');
});

test('K13/head (RED until fixed): same revision cannot be reused with different identity', () => {
  const { db, repo } = fixture();
  repo.record(recordAt(7));
  for (const drifted of [
    { candidateSetRef: 'candidate-set/OTHER' },
    { gateDecisionKey: 'decision/OTHER' },
    { taskId: 'task-OTHER' },
    { taskId: null },
  ]) {
    assert.throws(
      () => repo.record(recordAt(7, drifted)),
      /AUTHORITY_HEAD_IDENTITY_CONFLICT/u,
      `a revision number is never reused for different accepted identity: ${JSON.stringify(drifted)}`,
    );
  }
  assert.deepEqual(
    headRow(db),
    { cs: 'candidate-set/A', gd: 'decision/A', task: 'task-1', revision: 7 },
    'byte-identical authority identity at the same revision',
  );
});
