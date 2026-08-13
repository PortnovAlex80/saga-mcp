// tests/infrastructure/accepted-authority-head.test.mjs
//
// ADR-053 C5 (commit 3c5decc) — the accepted-authority head persists the
// identity of the workplace task whose material it accepted.
//
// This is the C5 ROOT fix: the HEAD (not the CandidateSet, not the submission)
// becomes the authority carrying task identity. The head is the carry-forward-
// safe task binding — neither submission.task_id (the ORIGIN process's task,
// wrong after carry-forward) nor ORDER BY t.id DESC (recency, wrong in repair
// cycles) is authority.
//
// These tests prove the plumbing invariant for C5-01: a write/read cycle
// persists AND recalls the task identity on the head. Wiring the actual task id
// at the acceptance site is C5-02; consuming it in git-integration is C5-03.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL, ensureAcceptedAuthorityHeadTaskIdColumn } from '../../dist/schema.js';
import { SqliteAcceptedAuthorityHeadRepository } from
  '../../dist/infrastructure/workplace/sqlite-accepted-authority-head-repository.js';

const WORKPLACE_REF = 'workplace/1/cell/item';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // Minimal parent row for the FK on factory_accepted_authority_head.
  // factory_process_runs is created by a separate repository module, not by
  // SCHEMA_SQL; FKs are not enforced in-memory so process_run_id is a plain int.
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,revision)
     VALUES ('${WORKPLACE_REF}',1,'mod@1.0.0','cell','item',
             'in_progress','running','author',0)`,
  ).run();
  return db;
}

test('C5: record with acceptedAuthorTaskId persists and recalls the task identity', () => {
  const db = makeDb();
  const repo = new SqliteAcceptedAuthorityHeadRepository(db);

  repo.record({
    workplaceRef: WORKPLACE_REF,
    acceptedAuthorCandidateSetRef: 'candidate-set/1/mod@1.0.0/cell/item/author',
    acceptedAuthorGateDecisionKey: 'gate-decision/author/accepted/rev-1',
    revision: 1,
    acceptedAuthorTaskId: 'task-42',
    now: () => new Date('2026-08-12T20:00:00.000Z'),
  });

  // The dedicated C5 read.
  assert.equal(repo.readAuthorTaskId(WORKPLACE_REF), 'task-42');
  // The full typed head also carries task identity alongside the C1 pointer.
  const head = repo.read(WORKPLACE_REF);
  assert.equal(head.acceptedAuthorTaskId, 'task-42');
  assert.equal(head.acceptedAuthorCandidateSetRef, 'candidate-set/1/mod@1.0.0/cell/item/author');
  assert.equal(head.acceptedAuthorGateDecisionKey, 'gate-decision/author/accepted/rev-1');
  assert.equal(head.revision, 1);
  db.close();
});

test('C5: a second author acceptance (repair cycle) re-binds task identity on the same head', () => {
  const db = makeDb();
  const repo = new SqliteAcceptedAuthorityHeadRepository(db);

  repo.record({
    workplaceRef: WORKPLACE_REF,
    acceptedAuthorCandidateSetRef: 'candidate-set/attempt-1',
    acceptedAuthorGateDecisionKey: 'gate-decision/author/accepted/rev-1',
    revision: 1,
    acceptedAuthorTaskId: 'task-42',
  });
  // A repair cycle produces a NEW author CandidateSet and re-records the head.
  // The head must reflect the CURRENT acceptance's task identity exactly — no
  // recency, no hash order (the C1 property extended to task identity).
  repo.record({
    workplaceRef: WORKPLACE_REF,
    acceptedAuthorCandidateSetRef: 'candidate-set/attempt-2',
    acceptedAuthorGateDecisionKey: 'gate-decision/author/accepted/rev-3',
    revision: 3,
    acceptedAuthorTaskId: 'task-42',
  });

  const head = repo.read(WORKPLACE_REF);
  assert.equal(head.acceptedAuthorCandidateSetRef, 'candidate-set/attempt-2');
  assert.equal(head.revision, 3);
  // Task identity is the workplace task (stable across attempts), still bound.
  assert.equal(head.acceptedAuthorTaskId, 'task-42');
  assert.equal(repo.readAuthorTaskId(WORKPLACE_REF), 'task-42');
  db.close();
});

test('C5: task identity is nullable — a head recorded without it reads null (pre-C5-02 wiring)', () => {
  const db = makeDb();
  const repo = new SqliteAcceptedAuthorityHeadRepository(db);

  // acceptedAuthorTaskId omitted entirely (the shape of the current
  // coordinator call site before C5-02 wires the task id).
  repo.record({
    workplaceRef: WORKPLACE_REF,
    acceptedAuthorCandidateSetRef: 'candidate-set/1',
    acceptedAuthorGateDecisionKey: 'gate-decision/1',
    revision: 1,
  });

  assert.equal(repo.readAuthorTaskId(WORKPLACE_REF), null);
  const head = repo.read(WORKPLACE_REF);
  assert.equal(head.acceptedAuthorTaskId, null);
  db.close();
});

test('C5: task identity is updatable independently — a later acceptance can bind a previously-null head', () => {
  const db = makeDb();
  const repo = new SqliteAcceptedAuthorityHeadRepository(db);

  // First acceptance: no task id bound (pre-C5-02 shape).
  repo.record({
    workplaceRef: WORKPLACE_REF,
    acceptedAuthorCandidateSetRef: 'candidate-set/1',
    acceptedAuthorGateDecisionKey: 'gate-decision/1',
    revision: 1,
  });
  assert.equal(repo.readAuthorTaskId(WORKPLACE_REF), null);

  // C5-02 later wires the task id on a subsequent acceptance of the same set.
  repo.record({
    workplaceRef: WORKPLACE_REF,
    acceptedAuthorCandidateSetRef: 'candidate-set/1',
    acceptedAuthorGateDecisionKey: 'gate-decision/1',
    revision: 2,
    acceptedAuthorTaskId: 'task-7',
  });
  assert.equal(repo.readAuthorTaskId(WORKPLACE_REF), 'task-7');
  db.close();
});

test('C5: read returns null when no acceptance has been recorded for the workplace', () => {
  const db = makeDb();
  const repo = new SqliteAcceptedAuthorityHeadRepository(db);
  assert.equal(repo.read('workplace/1/cell/absent'), null);
  assert.equal(repo.readAuthorTaskId('workplace/1/cell/absent'), null);
  assert.equal(repo.readAuthorCandidateSetRef('workplace/1/cell/absent'), null);
  db.close();
});

test('C5 additive migration: ensureAcceptedAuthorityHeadTaskIdColumn adds the column to a pre-v6 head table', () => {
  // Simulate a pre-v6 database: the head table exists WITHOUT the
  // accepted_author_task_id column (the shape before this card).
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_accepted_authority_head (
      workplace_ref                     TEXT PRIMARY KEY,
      accepted_author_candidate_set_ref TEXT NOT NULL,
      accepted_author_gate_decision_key TEXT NOT NULL,
      revision                          INTEGER NOT NULL,
      recorded_at                       TEXT NOT NULL
    );
    INSERT INTO factory_accepted_authority_head
      (workplace_ref, accepted_author_candidate_set_ref,
       accepted_author_gate_decision_key, revision, recorded_at)
    VALUES ('${WORKPLACE_REF}','cs-1','gd-1',1,'2026-08-12T00:00:00.000Z');
  `);
  const colsBefore = db.prepare('PRAGMA table_info(factory_accepted_authority_head)').all().map(c => c.name);
  assert.ok(!colsBefore.includes('accepted_author_task_id'));

  // Non-destructive: existing row is preserved; column added as NULL.
  ensureAcceptedAuthorityHeadTaskIdColumn(db);

  const colsAfter = db.prepare('PRAGMA table_info(factory_accepted_authority_head)').all().map(c => c.name);
  assert.ok(colsAfter.includes('accepted_author_task_id'));
  const existing = db.prepare(
    'SELECT accepted_author_task_id FROM factory_accepted_authority_head WHERE workplace_ref = ?',
  ).get(WORKPLACE_REF);
  assert.equal(existing.accepted_author_task_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_accepted_authority_head').get().n, 1);

  // Idempotent: a second run is a no-op.
  ensureAcceptedAuthorityHeadTaskIdColumn(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM factory_accepted_authority_head').get().n, 1);

  // After migration the repository can write AND recall task identity on the
  // pre-existing row (proves non-destructive upgrade is functionally complete).
  const repo = new SqliteAcceptedAuthorityHeadRepository(db);
  repo.record({
    workplaceRef: WORKPLACE_REF,
    acceptedAuthorCandidateSetRef: 'cs-1',
    acceptedAuthorGateDecisionKey: 'gd-1',
    revision: 2,
    acceptedAuthorTaskId: 'task-upgraded',
  });
  assert.equal(repo.readAuthorTaskId(WORKPLACE_REF), 'task-upgraded');
  db.close();
});
