// tests/process-modules/final-acceptance-rejection-history.test.mjs
//
// BLINDSIGHT C2 (Authority/Gate layer): the acceptance commit did not see the
// rejection history. Plan-swap laundering — «rejected 3 times under plan P1,
// accepted under plan P2» — was invisible: the finding-trajectory chain
// RESETS on a check-plan change (T7), and the final acceptance proof bound
// only {workplace, candidateSet, gateDecisionKey, effectReceiptRefs}.
//
//   FA1 the final acceptance proof carries the workplace's FULL rejection
//       history across ALL check plans: two workplaces with byte-identical
//       accepted bodies but different rejection histories get DIFFERENT
//       acceptance refs (laundering changes the proof), and the stored
//       rejection_history column shows both plan digests;
//   FA2 a first-try acceptance stores rejection_history = [];
//   FA3 legacy replay — a row recorded by pre-upgrade code (digest over the
//       body WITHOUT rejectionHistory, default empty column) replays to the
//       SAME ref instead of REPLAY_MISMATCH (one-way compat; a drifted body
//       still fails closed).
//
// BEFORE the fix FA1 is RED: no rejection_history column / same ref for both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  asWorkplaceRef,
  serializeWorkplaceRef,
} from '../../dist/process-modules/domain/workplace/workplace-ref.js';
import { SqliteCellFinalAcceptance } from '../../dist/infrastructure/workplace/sqlite-cell-final-acceptance.js';
import { sha256Hex } from '../../dist/shared/canonical-json.js';

const HEX64 = 'a'.repeat(64);

function makeWorld(db, { workplaceKey = 'w', rejections = [] } = {}) {
  const ref = asWorkplaceRef({
    processRunId: 1, moduleRef: 'm@1.0.0', productionCellId: 'cell', workKey: workplaceKey,
  });
  const wp = serializeWorkplaceRef(ref);
  db.prepare(
    `INSERT INTO factory_workplaces
       (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
        kanban_phase,loop_state,next_role,terminal_reason,revision)
     VALUES (?,1,'m@1.0.0','cell',?,'done','terminal','reviewer','accepted',3)`,
  ).run(wp, workplaceKey);
  // The rejections under whatever plans they happened (the laundering case
  // uses two DIFFERENT check_plan_digest values).
  rejections.forEach(({ key, planDigest }, index) => {
    db.prepare(
      `INSERT INTO factory_gate_decisions
         (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
          subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
          check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
          check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
       VALUES (?,?,?,?,'author','t:r',?, '[]','repair_required',
               'plan',?,'policy',?,'[]',?,'[]',?)`,
    ).run(`${workplaceKey}:${key}`, wp, `gate:${key}`, `run:${key}`, `candidate-set:${index + 1}`,
      planDigest, HEX64, HEX64, `digest:${key}`);
  });
  db.prepare(
    `INSERT INTO factory_gate_decisions
       (decision_key,workplace_ref,gate_ref,gate_run_ref,gate_phase,transition_ref,
        subject_candidate_set_ref,assessment_candidate_set_refs,verdict,
        check_plan_ref,check_plan_digest,decision_policy_ref,decision_policy_digest,
        check_receipt_refs,installation_digest,accepted_output_bindings,decision_digest)
     VALUES (?,?,?,?,'final','t:1','candidate-set:final','[]','accepted',
             'plan',?,'policy',?,'[]',?,'[]',?)`,
  ).run(`${workplaceKey}:decision:final`, wp, 'gate:1', 'run:1', `plan-p2-${HEX64}`, HEX64, HEX64, `final-digest:${workplaceKey}`);
  db.prepare(
    `INSERT INTO factory_cell_effect_receipts
       (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,
        gate_decision_key,provider_receipt_ref,provider_receipt_digest,
        receipt_digest)
     VALUES (?,?, 'effect-x','candidate-set:final',
        ?,'provider:1',?,?)`,
  ).run(`effect-receipt:${workplaceKey}`, wp, `${workplaceKey}:decision:final`, `provider:${workplaceKey}`, `receipt:${workplaceKey}`);
  return { ref, wp };
}

function record(repo, refObject) {
  return repo.recordFinalAcceptance({
    workplaceRef: refObject,
    candidateSetRef: 'candidate-set:final',
    effectReceiptRefs: [`effect-receipt:${refObject.workKey}`],
    acceptedAt: '2026-08-18T00:00:00Z',
  });
}

test('FA1: rejection history (across plans) is part of the acceptance proof', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);

  // Laundered workplace: rejected twice under plan P1, once more under P1b,
  // then accepted under P2.
  const laundered = makeWorld(db, {
    workplaceKey: 'laundered',
    rejections: [
      { key: 'decision:r1', planDigest: `plan-p1-${HEX64}` },
      { key: 'decision:r2', planDigest: `plan-p1-${HEX64}` },
      { key: 'decision:r3', planDigest: `plan-p1b-${HEX64}` },
    ],
  });
  // Clean workplace: identical accepted body, zero rejections.
  const clean = makeWorld(db, { workplaceKey: 'clean', rejections: [] });

  const repo = new SqliteCellFinalAcceptance(db);
  const launderedRef = record(repo, laundered.ref);
  const cleanRef = record(repo, clean.ref);
  assert.notEqual(launderedRef, cleanRef,
    'the rejection history must change the acceptance proof (plan-swap laundering is visible)');

  const row = db.prepare(
    'SELECT rejection_history FROM factory_cell_final_acceptances WHERE workplace_ref=?',
  ).get(laundered.wp);
  const history = JSON.parse(row.rejection_history ?? '[]');
  assert.equal(history.length, 3, 'ALL prior non-accepted decisions ride with the proof');
  assert.deepEqual(
    history.map(entry => entry.checkPlanDigest),
    [`plan-p1-${HEX64}`, `plan-p1-${HEX64}`, `plan-p1b-${HEX64}`],
    'rejections under EVERY plan are visible — the chain may reset on plan change, the proof may not',
  );
  assert.equal(history[0].verdict, 'repair_required');
  assert.equal(history[0].decisionKey, 'laundered:decision:r1');

  // Replay of the laundered acceptance is stable.
  assert.equal(record(repo, laundered.ref), launderedRef);
  db.close();
});

test('FA2: first-try acceptance stores an empty rejection history', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  const clean = makeWorld(db, { workplaceKey: 'clean', rejections: [] });
  const repo = new SqliteCellFinalAcceptance(db);
  record(repo, clean.ref);
  const row = db.prepare(
    'SELECT rejection_history FROM factory_cell_final_acceptances WHERE workplace_ref=?',
  ).get(clean.wp);
  assert.deepEqual(JSON.parse(row.rejection_history ?? '[]'), []);
  db.close();
});

test('FA3: a pre-upgrade acceptance row replays to the same ref (legacy digest)', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(SCHEMA_SQL);
  const world = makeWorld(db, {
    workplaceKey: 'legacy',
    rejections: [{ key: 'decision:r1', planDigest: `plan-p1-${HEX64}` }],
  });
  // Simulate the row OLD code wrote: digest over the body WITHOUT
  // rejectionHistory, rejection_history left at the column default.
  const legacyBody = {
    schema: 'factory.cell-final-acceptance.v1',
    workplaceRef: world.wp,
    candidateSetRef: 'candidate-set:final',
    gateDecisionKey: 'legacy:decision:final',
    effectReceiptRefs: ['effect-receipt:legacy'],
  };
  const legacyDigest = sha256Hex(legacyBody);
  db.prepare(
    `INSERT INTO factory_cell_final_acceptances
       (final_acceptance_ref,workplace_ref,candidate_set_ref,gate_decision_key,
        effect_receipt_refs,acceptance_digest,accepted_at)
     VALUES ('cell-final-acceptance:legacy',?, 'candidate-set:final','legacy:decision:final',
      '["effect-receipt:legacy"]',?,'2026-08-17T00:00:00Z')`,
  ).run(world.wp, legacyDigest);

  const repo = new SqliteCellFinalAcceptance(db);
  const replayed = record(repo, world.ref);
  assert.equal(replayed, 'cell-final-acceptance:legacy',
    'a legacy row replays to its own ref instead of REPLAY_MISMATCH');

  // But a genuinely drifted body still fails closed.
  db.prepare(
    `INSERT INTO factory_cell_effect_receipts
       (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,
        gate_decision_key,provider_receipt_ref,provider_receipt_digest,
        receipt_digest)
     VALUES ('effect-receipt:legacy-2',?, 'effect-y','candidate-set:final',
        'legacy:decision:final','provider:2',?,?)`,
  ).run(world.wp, 'b'.repeat(64), 'b'.repeat(64));
  assert.throws(
    () => repo.recordFinalAcceptance({
      workplaceRef: world.ref,
      candidateSetRef: 'candidate-set:final',
      effectReceiptRefs: ['effect-receipt:legacy', 'effect-receipt:legacy-2'],
      acceptedAt: '2026-08-18T00:00:00Z',
    }),
    /CELL_FINAL_ACCEPTANCE_REPLAY_MISMATCH/,
  );
  db.close();
});
