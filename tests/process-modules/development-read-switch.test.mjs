import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

import { SqliteDevelopmentModuleStore } from '../../dist/modules/development/infrastructure/sqlite-development-settlement-state.js';
import {
  LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
  LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
} from '../../dist/modules/development/application/candidate-check-contracts.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(
  here,
  '../../src/modules/development/infrastructure/sqlite-development-settlement-state.ts',
), 'utf8');

test('Development settlement exposes no task-status read authority', () => {
  assert.equal(SqliteDevelopmentModuleStore.prototype.readRuntimeTask, undefined);
  assert.equal(SqliteDevelopmentModuleStore.prototype.readRuntimeTasks, undefined);
  assert.equal(SqliteDevelopmentModuleStore.prototype.areProjectedTasksTerminal, undefined);
});

test('Development settlement reads accepted Production Cell products, not task lifecycle state', () => {
  assert.match(source, /readAcceptedCellProducts/);
  assert.match(source, /factory_candidate_sets/);
  assert.match(source, /factory_managed_node_submissions/);
  const settlementBody = source.slice(
    source.indexOf('  buildSettlementInput(input:'),
    source.indexOf('  // ----- inner workset reconstruction'),
  );
  assert.doesNotMatch(settlementBody, /FROM tasks[\s\S]{0,160}(status|integration_state)/i);
});

test('Development freeze derives integration authority from exact Cell EffectReceipts', () => {
  const freezeBody = source.slice(
    source.indexOf('  freezeIntegratedCandidate(input:'),
    source.indexOf('  buildSettlementInput(input:'),
  );
  assert.match(freezeBody, /factory_cell_effect_receipts/);
  assert.match(freezeBody, /workplace_ref=\? AND candidate_set_ref=\?/);
  assert.match(freezeBody, /effect_id='git-integration'/);
  assert.doesNotMatch(freezeBody, /SELECT integration_state,integrated_commit\s+FROM tasks/);
});

test('Development settlement binds readiness through accepted verification authority and exact frozen input', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE factory_workplaces (
      workplace_ref TEXT PRIMARY KEY,
      process_run_id INTEGER NOT NULL
    );
    CREATE TABLE factory_candidate_sets (
      candidate_set_ref TEXT PRIMARY KEY,
      workplace_ref TEXT NOT NULL
    );
    CREATE TABLE factory_accepted_authority_head (
      workplace_ref TEXT PRIMARY KEY,
      accepted_author_candidate_set_ref TEXT NOT NULL,
      accepted_author_task_id TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      workplace_ref TEXT NOT NULL,
      metadata TEXT NOT NULL
    );
    CREATE TABLE factory_cell_final_acceptances (
      workplace_ref TEXT NOT NULL,
      candidate_set_ref TEXT NOT NULL,
      gate_decision_key TEXT NOT NULL
    );
    CREATE TABLE factory_gate_decisions (
      decision_key TEXT PRIMARY KEY,
      gate_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      gate_phase TEXT NOT NULL,
      verdict TEXT NOT NULL
    );
    CREATE TABLE factory_check_receipts (
      check_receipt_ref TEXT PRIMARY KEY,
      check_run_ref TEXT NOT NULL,
      subject_candidate_set_ref TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_version TEXT NOT NULL,
      provider_digest TEXT NOT NULL,
      outcome TEXT NOT NULL,
      evidence_refs TEXT NOT NULL,
      receipt_digest TEXT NOT NULL
    );
  `);

  const candidateRef = {
    schema: 'factory.integrated-release-candidate.v1',
    ref: 'development-integrated-candidate:3:exact',
    hash: 'a'.repeat(64),
  };
  const metadata = JSON.stringify({
    process_node_input: {
      upstream: { bindings: { candidateRef } },
    },
  });
  db.prepare('INSERT INTO factory_workplaces VALUES (?, ?)')
    .run('workplace:verification', 3);
  db.prepare('INSERT INTO factory_candidate_sets VALUES (?, ?)')
    .run('candidate:verification', 'workplace:verification');
  db.prepare('INSERT INTO tasks VALUES (?, ?, ?)')
    .run(19, 'workplace:verification', metadata);
  db.prepare('INSERT INTO factory_accepted_authority_head VALUES (?, ?, ?)')
    .run('workplace:verification', 'candidate:verification', '19');
  db.prepare('INSERT INTO factory_cell_final_acceptances VALUES (?, ?, ?)')
    .run('workplace:verification', 'candidate:verification', 'decision:final');
  db.prepare('INSERT INTO factory_gate_decisions VALUES (?, ?, ?, ?, ?)')
    .run('decision:final', 'gate:final', 'candidate:verification', 'final', 'accepted');
  db.prepare('INSERT INTO factory_check_receipts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      'receipt:readiness',
      'gate:final',
      'candidate:verification',
      LOCAL_RUNNABILITY_CHECK_PROVIDER_ID,
      LOCAL_RUNNABILITY_CHECK_PROVIDER_VERSION,
      LOCAL_RUNNABILITY_CHECK_PROVIDER_DIGEST,
      'passed',
      JSON.stringify(['evidence:exact']),
      'b'.repeat(64),
    );

  // Construct only the read-side under test. TypeScript `private` is not a JS
  // authority boundary; no module schema or unrelated ports are needed here.
  const store = Object.create(SqliteDevelopmentModuleStore.prototype);
  store.db = db;
  const receipt = store.readLocalReadinessReceipt(
    3,
    {
      candidateHash: candidateRef.hash,
      sourceCandidate: { schema: 'source', ref: 'source:1', hash: 'c'.repeat(64) },
      readinessCertification: {
        candidateSetRef: 'candidate:verification',
        checkReceipt: { schema: 'factory.check-receipt.v1', ref: 'receipt:readiness', hash: 'b'.repeat(64) },
      },
    },
    candidateRef,
  );
  assert.deepEqual(receipt, {
    candidateHash: candidateRef.hash,
    outcome: 'passed',
    evidenceRefs: ['evidence:exact'],
  });

  const wrongRef = { ...candidateRef, ref: 'development-integrated-candidate:3:wrong' };
  assert.equal(store.readLocalReadinessReceipt(
    3,
    { candidateHash: candidateRef.hash },
    wrongRef,
  ), null);
  db.close();
});
