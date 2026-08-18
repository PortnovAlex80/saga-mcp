// tests/process-modules/final-acceptance-identity.test.mjs
//
// K13 — FinalAcceptance identity is the persisted row's content address
// (the plan's commit 3: "use persisted row identity — replace fabricated
// aliases with row digests"). AUDIT FINDING: the implementation is already
// content-addressed — final_acceptance_ref = cell-final-acceptance:<sha256
// of the exact body {workplace, candidateSet, gateDecisionKey,
// effectReceiptRefs}>; a replay returns the SAME ref and a drifted body
// fails closed with CELL_FINAL_ACCEPTANCE_REPLAY_MISMATCH. This test pins
// that behavior deterministically so a fabricated alias cannot return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  asWorkplaceRef,
  serializeWorkplaceRef,
} from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteCellFinalAcceptance } from '../../dist/infrastructure/workplace/sqlite-cell-final-acceptance.js';

const HEX64 = 'a'.repeat(64);
const ref = asWorkplaceRef({
  processRunId: 1, moduleRef: 'm@1.0.0', productionCellId: 'cell', workKey: 'w',
});
const wp = serializeWorkplaceRef(ref);

function fixture() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  // A terminal(accepted) workplace + the accepted final decision + one
  // durable effect receipt — the minimum the row identity binds.
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,terminal_reason,revision)
     VALUES (?,1,'m@1.0.0','cell','w','done','terminal','reviewer','accepted',3)`,
  ).run(wp);
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES ('decision:final',?,?,?,'final','t:1','candidate-set:1','[]','accepted',
             'plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(wp, 'gate:1', 'run:1', HEX64, HEX64, HEX64, HEX64);
  db.prepare(
    `INSERT INTO factory_cell_effect_receipts
       (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,
        gate_decision_key,provider_receipt_ref,provider_receipt_digest,
        receipt_digest)
     VALUES ('effect-receipt:1',?, 'effect-x','candidate-set:1',
        'decision:final','provider:1',?,?)`,
  ).run(wp, HEX64, HEX64);
  return { db, repo: new SqliteCellFinalAcceptance(db) };
}

test('K13/final-acceptance: the ref IS the row content address — idempotent, drift fails closed', () => {
  const { db, repo } = fixture();

  const first = repo.recordFinalAcceptance({
    workplaceRef: ref,
    candidateSetRef: 'candidate-set:1',
    effectReceiptRefs: ['effect-receipt:1'],
    acceptedAt: '2026-08-18T00:00:00Z',
  });
  assert.match(first, /^cell-final-acceptance:[0-9a-f]{64}$/u,
    'the ref is a content address over the exact body, not a fabricated alias');

  // Idempotent replay: the SAME body returns the SAME ref.
  const replay = repo.recordFinalAcceptance({
    workplaceRef: ref,
    candidateSetRef: 'candidate-set:1',
    effectReceiptRefs: ['effect-receipt:1'],
    acceptedAt: '2026-08-18T00:00:00Z',
  });
  assert.equal(replay, first);

  // One row per accepted identity; the stored digest is the content address.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM factory_cell_final_acceptances').get().n,
    1,
    'one row per accepted identity',
  );
  const stored = db.prepare(
    'SELECT final_acceptance_ref,acceptance_digest FROM factory_cell_final_acceptances WHERE workplace_ref=?',
  ).get(wp);
  assert.ok(stored.final_acceptance_ref === first);
  assert.match(String(stored.acceptance_digest), /^[0-9a-f]{64}$/u);

  // A second record with a DIFFERENT body for the same workplace is a typed
  // conflict (the row identity is immutable).
  db.prepare(
    `INSERT INTO factory_cell_effect_receipts
       (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,
        gate_decision_key,provider_receipt_ref,provider_receipt_digest,
        receipt_digest)
     VALUES ('effect-receipt:2',?, 'effect-y','candidate-set:1',
        'decision:final','provider:2',?,?)`,
  ).run(wp, 'b'.repeat(64), 'b'.repeat(64));
  assert.throws(
    () => repo.recordFinalAcceptance({
      workplaceRef: ref,
      candidateSetRef: 'candidate-set:1',
      effectReceiptRefs: ['effect-receipt:1', 'effect-receipt:2'],
      acceptedAt: '2026-08-18T00:00:00Z',
    }),
    /CELL_FINAL_ACCEPTANCE_REPLAY_MISMATCH/u,
    'drifted accepted identity cannot re-alias the row',
  );
});
