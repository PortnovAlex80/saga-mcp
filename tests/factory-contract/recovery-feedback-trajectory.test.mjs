// tests/factory-contract/recovery-feedback-trajectory.test.mjs
//
// BLINDSIGHT C1a (Authority/Gate layer): the author on repair saw ONLY the
// latest findings — the finding-trajectory chain was written durably but the
// recovery-feedback sheet never delivered it. The author must understand the
// TRAJECTORY (converging / spinning / churning / scope-impossible), not just
// the last rejection (CONVEYOR §15: "operator projection renders the reason
// chain — never the bare iteration count").
//
//   FT1 converging — strict subset between the last two same-scope chain rows:
//       label 'converging' + human explanation + lastTransition.removedKeys;
//   FT2 spinning — byte-identical key sets: label 'spinning';
//   FT3 single rejection — label 'first-rejection';
//   FT4 pre-chain-table database — the sheet still renders, chain empty,
//       label 'first-rejection' (no fabricated history, no error).
//
// BEFORE the fix FT1..FT3 are RED: the sheet has no findingTrajectory field.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { createSqliteProductionCellProjectionPersistence } from '../../dist/infrastructure/workplace/sqlite-production-cell-projection-persistence.js';
import { encodeCheckDiagnostic } from '../../dist/process-modules/domain/workplace/check-diagnostic.js';

const WORKPLACE_REF = 'workplace/7/solution-formalization@1.0.0/formalization-acceptance/singleton';

function baseTaskMetadata(role = 'author') {
  return {
    process_run_id: 7,
    process_node_id: 'define-acceptance-contract',
    process_module_ref: 'solution-formalization@1.0.0',
    workplace_ref: WORKPLACE_REF,
    production_cell_id: 'formalization-acceptance',
    work_key: 'singleton',
    role,
    work_intent_id: 41,
  };
}

const CHAIN_DDL = `
  CREATE TABLE factory_gate_finding_set_chain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workplace_ref           TEXT NOT NULL,
    gate_ref                TEXT NOT NULL,
    repair_target_role      TEXT NOT NULL CHECK (repair_target_role IN ('author','reviewer')),
    check_plan_digest       TEXT NOT NULL,
    gate_decision_key       TEXT NOT NULL UNIQUE,
    finding_set_digest      TEXT NOT NULL,
    finding_count           INTEGER NOT NULL CHECK (finding_count >= 0),
    fatal_finding_count     INTEGER NOT NULL CHECK (fatal_finding_count >= 0),
    finding_keys            TEXT NOT NULL,
    fatal_finding_keys      TEXT NOT NULL,
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function createDb({ withChainTable = true } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      metadata TEXT NOT NULL,
      project_repository_id INTEGER,
      updated_at TEXT
    );
    CREATE TABLE factory_work_intents (
      id INTEGER PRIMARY KEY,
      retry_budget INTEGER NOT NULL
    );
    CREATE TABLE factory_gate_decisions (
      decision_key TEXT PRIMARY KEY,
      decision_digest TEXT NOT NULL DEFAULT '',
      gate_run_ref TEXT NOT NULL,
      gate_ref TEXT NOT NULL,
      workplace_ref TEXT NOT NULL,
      gate_phase TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      assessment_candidate_set_refs TEXT NOT NULL,
      check_plan_ref TEXT NOT NULL,
      check_plan_digest TEXT NOT NULL,
      check_receipt_refs TEXT NOT NULL,
      verdict TEXT NOT NULL,
      repair_target_role TEXT,
      recovery_issue_ref TEXT,
      decided_at TEXT NOT NULL
    );
    CREATE TABLE factory_workplace_gate_decision_heads (
      workplace_ref TEXT PRIMARY KEY,
      decision_key TEXT NOT NULL
    );
    CREATE TABLE factory_check_receipts (
      check_receipt_ref TEXT PRIMARY KEY,
      check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL DEFAULT '',
      assessment_candidate_set_refs TEXT NOT NULL DEFAULT '[]',
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      environment_ref TEXT,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      receipt_digest TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY,
      candidate_set_digest TEXT NOT NULL,
      role TEXT NOT NULL,
      subject_candidate_set_ref TEXT
    );
    CREATE TABLE factory_candidate_set_members (
      candidate_set_ref TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      product_schema TEXT NOT NULL,
      product_ref TEXT NOT NULL,
      product_digest TEXT NOT NULL,
      PRIMARY KEY(candidate_set_ref, ordinal)
    );
  `);
  if (withChainTable) db.exec(CHAIN_DDL);
  return db;
}

function seedCurrentRejection(db, { findingMessage = 'widget broken', key = 'decision-1' } = {}) {
  db.prepare('INSERT INTO tasks(id,metadata,project_repository_id) VALUES (10,?,3)')
    .run(JSON.stringify(baseTaskMetadata('author')));
  db.prepare('INSERT INTO factory_work_intents(id,retry_budget) VALUES (41,3)').run();
  db.prepare(`INSERT INTO factory_candidate_sets
    (candidate_set_ref,candidate_set_digest,role,subject_candidate_set_ref)
    VALUES ('candidate-author-1','candidate-author-1:digest','author',NULL)`).run();
  db.prepare(`INSERT INTO factory_candidate_set_members
    (candidate_set_ref,ordinal,product_schema,product_ref,product_digest)
    VALUES ('candidate-author-1',0,'factory.test-product.v1','candidate-author-1:product','d')`).run();
  db.prepare(`INSERT INTO factory_gate_decisions
    (decision_key,gate_run_ref,gate_ref,workplace_ref,gate_phase,
     subject_candidate_set_ref,assessment_candidate_set_refs,
     check_plan_ref,check_plan_digest,check_receipt_refs,verdict,
     repair_target_role,recovery_issue_ref,decided_at)
    VALUES (?, 'gate-run-1','formalization-acceptance-gate',?,'author',
      'candidate-author-1','[]','formalization-acceptance-plan','plan-digest',
      '["gate-run-1:check:0"]','repair_required','author','recovery:decision-1',
      '2026-08-09T07:00:00.000Z')`).run(key, WORKPLACE_REF);
  db.prepare(`INSERT INTO factory_check_receipts
    (check_receipt_ref,check_run_ref,subject_candidate_set_ref,provider_id,provider_version,provider_digest,outcome,evidence_refs)
    VALUES ('gate-run-1:check:0','gate-run-1','cs1','factory.test-check.v1','1.0.0','provider-digest','failed',?)`)
    .run(JSON.stringify([encodeCheckDiagnostic({ code: 'widget-contract', message: findingMessage })]));
  db.prepare(`INSERT INTO factory_workplace_gate_decision_heads(workplace_ref,decision_key)
    VALUES (?,?) ON CONFLICT(workplace_ref) DO UPDATE SET decision_key=excluded.decision_key`)
    .run(WORKPLACE_REF, key);
}

function insertChainRow(db, { decisionKey, keys, fatalKeys = [], role = 'author' }) {
  db.prepare(`INSERT INTO factory_gate_finding_set_chain
    (workplace_ref,gate_ref,repair_target_role,check_plan_digest,gate_decision_key,
     finding_set_digest,finding_count,fatal_finding_count,finding_keys,fatal_finding_keys)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    WORKPLACE_REF,
    'formalization-acceptance-gate',
    role,
    'plan-digest',
    decisionKey,
    `digest:${decisionKey}`,
    keys.length,
    fatalKeys.length,
    JSON.stringify(keys),
    JSON.stringify(fatalKeys),
  );
}

function bindAndRead(db) {
  createSqliteProductionCellProjectionPersistence(db).bindProjectedTaskProcessContext({
    taskId: 10,
    processRunId: 7,
    nodeId: 'define-acceptance-contract',
    moduleRef: 'solution-formalization@1.0.0',
    processInputHash: 'process-input-hash',
    nodeInput: { business: 'same' },
    nodeInputHash: 'node-input-hash',
    semanticInputDigest: 'semantic-input-digest',
    projectRepositoryId: 3,
  });
  return JSON.parse(db.prepare('SELECT metadata FROM tasks WHERE id=10').get().metadata)
    .recovery_feedback;
}

test('FT1: converging rejection delivers the chain and a human trajectory label', () => {
  const db = createDb();
  const keyA = 'factory.test-check.v1:widget-contract::widget broken';
  const keyB = 'factory.test-check.v1:widget-contract::gasket broken';
  seedCurrentRejection(db);
  insertChainRow(db, { decisionKey: 'decision-0', keys: [keyA, keyB] });
  insertChainRow(db, { decisionKey: 'decision-1', keys: [keyA] });

  const feedback = bindAndRead(db);
  assert.equal(feedback.schemaVersion, 'factory.production-cell-recovery-feedback.v1');

  const trajectory = feedback.findingTrajectory;
  assert.ok(trajectory, 'the sheet must carry findingTrajectory');
  assert.equal(trajectory.label, 'converging');
  assert.equal(typeof trajectory.explanation, 'string');
  assert.ok(trajectory.explanation.length > 20, 'a human-readable explanation');
  assert.match(trajectory.explanation, /shrinking|removed/i,
    'the explanation must say WHAT the trajectory means, not restate the label');
  assert.equal(trajectory.chain.length, 2, 'the whole same-scope chain rides with the sheet');
  assert.equal(trajectory.chain[0].gateDecisionKey, 'decision-0');
  assert.equal(trajectory.chain[1].gateDecisionKey, 'decision-1');
  assert.deepEqual(trajectory.chain[1].keys, [keyA]);
  assert.deepEqual(trajectory.lastTransition.removedKeys, [keyB]);
  assert.deepEqual(trajectory.lastTransition.addedKeys, []);
  db.close();
});

test('FT2: byte-identical key sets → spinning', () => {
  const db = createDb();
  const keyA = 'factory.test-check.v1:widget-contract::widget broken';
  seedCurrentRejection(db);
  insertChainRow(db, { decisionKey: 'decision-0', keys: [keyA] });
  insertChainRow(db, { decisionKey: 'decision-1', keys: [keyA] });

  const trajectory = bindAndRead(db).findingTrajectory;
  assert.equal(trajectory.label, 'spinning');
  assert.match(trajectory.explanation, /same repair will not pass|cause/i);
  db.close();
});

test('FT3: single recorded rejection → first-rejection', () => {
  const db = createDb();
  seedCurrentRejection(db);
  insertChainRow(db, { decisionKey: 'decision-1', keys: ['k::one'] });

  const trajectory = bindAndRead(db).findingTrajectory;
  assert.equal(trajectory.label, 'first-rejection');
  assert.equal(trajectory.chain.length, 1);
  assert.equal(trajectory.lastTransition, null);
  db.close();
});

test('FT4: pre-chain-table database — sheet still renders with an empty chain', () => {
  const db = createDb({ withChainTable: false });
  seedCurrentRejection(db);

  const feedback = bindAndRead(db);
  assert.equal(feedback.schemaVersion, 'factory.production-cell-recovery-feedback.v1');
  assert.equal(feedback.findingTrajectory.label, 'first-rejection');
  assert.deepEqual(feedback.findingTrajectory.chain, []);
  db.close();
});
