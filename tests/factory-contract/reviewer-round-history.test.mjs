// tests/factory-contract/reviewer-round-history.test.mjs
//
// BLINDSIGHT C6 (Authority/Gate layer, SQL half): the reviewer was blind to
// rounds — the prompt carried no round number, no past verdicts, no rejected
// candidates. «The author cosmetically patches and resubmits» was
// structurally invisible to the only actor who could call it out.
//
//   RH1 the durable reviewer-submission history of a workplace parses into
//       an ordered round history: prior verdicts (subject + verdict + finding
//       messages) and the distinct rejected author candidate refs;
//   RH2 a workplace with no reviewer submissions reports round 1 and no
//       priors (typed empty, never an error).
//
// BEFORE the fix both are RED: readReviewerRoundHistory does not exist
// (module export undefined).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { readReviewerRoundHistory } from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';

const WORKPLACE_REF = 'workplace/7/dev@1.0.0/impl-cell/item-1';

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      workplace_ref TEXT,
      metadata TEXT
    );
    CREATE TABLE factory_managed_node_submissions (
      id INTEGER PRIMARY KEY,
      task_id INTEGER NOT NULL,
      schema_version TEXT,
      payload_snapshot TEXT,
      content_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertReviewerTask(db, id) {
  db.prepare('INSERT INTO tasks(id,workplace_ref,metadata) VALUES (?,?,?)')
    .run(id, WORKPLACE_REF, JSON.stringify({ role: 'reviewer', work_intent_id: id }));
}

function insertVerdict(db, taskId, payload, ordinal) {
  db.prepare(
    `INSERT INTO factory_managed_node_submissions
       (id,task_id,schema_version,payload_snapshot,content_hash)
     VALUES (?,?,?,?,?)`,
  ).run(ordinal, taskId, 'factory.review-verdict.v1', JSON.stringify(payload), `hash-${ordinal}`);
}

test('RH1: reviewer submissions of a workplace parse into an ordered round history', () => {
  const db = createDb();
  insertReviewerTask(db, 12);
  insertVerdict(db, 12, {
    subject_candidate_set_ref: 'candidate-set/author-1',
    verdict: 'changes_requested',
    findings: [
      { message: 'widget broken', paths: ['src/widget.ts'] },
      'bare prose finding',
    ],
  }, 100);
  insertVerdict(db, 12, {
    subject_candidate_set_ref: 'candidate-set/author-2',
    verdict: 'changes_requested',
    findings: [{ message: 'widget still broken', paths: ['src/widget.ts'] }],
  }, 101);
  insertVerdict(db, 12, {
    subject_candidate_set_ref: 'candidate-set/author-3',
    verdict: 'approved',
    findings: [],
  }, 102);

  const history = readReviewerRoundHistory(db, WORKPLACE_REF);
  assert.ok(history, 'history must resolve');
  assert.equal(history.round, 4, 'three prior verdicts → this is round 4');
  assert.equal(history.priorVerdicts.length, 3);
  assert.deepEqual(history.priorVerdicts.map(v => v.subjectCandidateSetRef), [
    'candidate-set/author-1',
    'candidate-set/author-2',
    'candidate-set/author-3',
  ]);
  assert.deepEqual(history.priorVerdicts.map(v => v.verdict), [
    'changes_requested', 'changes_requested', 'approved',
  ]);
  assert.deepEqual(history.priorVerdicts[0].findings, [
    'widget broken',
    'bare prose finding',
  ]);
  assert.deepEqual(history.rejectedCandidateSetRefs, [
    'candidate-set/author-1',
    'candidate-set/author-2',
  ], 'only changes_requested subjects count as rejected candidates');
  db.close();
});

test('RH2: no reviewer submissions yet — round 1, typed empty history', () => {
  const db = createDb();
  insertReviewerTask(db, 12);
  const history = readReviewerRoundHistory(db, WORKPLACE_REF);
  assert.deepEqual(history, {
    round: 1,
    priorVerdicts: [],
    rejectedCandidateSetRefs: [],
  });
  db.close();
});
