import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { readTransitionHandoffPostcondition } from '../../dist/process-modules/application/transition-handoff-postconditions.js';

function obligation(overrides) {
  return {
    obligationKey: 'gate-accepted:decision:1:run-effects',
    sourceKind: 'gate-accepted',
    sourceRef: 'decision:1',
    sourceDigest: 'd'.repeat(64),
    subjectRef: 'workplace/3/module@1/cell/item',
    handoffKind: 'run-effects',
    ownerCapability: 'production-cell-node-executor',
    fence: 1,
    leaseFence: 1,
    state: 'in_progress',
    attempt: 1,
    leaseOwner: 'test',
    leaseExpiresAt: null,
    completionReceipt: null,
    resultDigest: null,
    lastError: null,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    completedAt: null,
    ...overrides,
  };
}

function insertWorkplace(db, workplaceRef, processRunId, loopState) {
  db.prepare(
    `INSERT INTO factory_workplaces
      (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
       kanban_phase,loop_state,next_role,revision)
     VALUES (?,?,'module@1','cell','item','review_in_progress',?,'reviewer',7)`,
  ).run(workplaceRef, processRunId, loopState);
}

test('run-effects cannot complete while the exact GateDecision has no durable receipt', () => {
  const db = new Database(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    db.pragma('foreign_keys=OFF');
    const workplaceRef = 'workplace/3/module@1/cell/item';
    insertWorkplace(db, workplaceRef, 3, 'effect_pending');
    const handoff = obligation({ subjectRef: workplaceRef });
    assert.deepEqual(readTransitionHandoffPostcondition(db, handoff), {
      satisfied: false,
      reason: 'exact GateDecision has neither an effect receipt nor a FinalAcceptance yet',
    });

    db.prepare(
      `INSERT INTO factory_cell_effect_receipts
        (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,
         gate_decision_key,provider_receipt_ref,provider_receipt_digest,
         evidence_snapshot,receipt_digest)
       VALUES ('effect:1',?,'git-integration','candidate:1','decision:1',
               'provider:1',?,'{}',?)`,
    ).run(workplaceRef, 'a'.repeat(64), 'b'.repeat(64));
    assert.equal(readTransitionHandoffPostcondition(db, handoff).satisfied, true);
  } finally {
    db.close();
  }
});

test('run-effects does not complete merely because the Workplace left effect_pending', () => {
  const db = new Database(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    db.pragma('foreign_keys=OFF');
    const workplaceRef = 'workplace/4/module@1/cell/item';
    insertWorkplace(db, workplaceRef, 4, 'repair_wait');
    const result = readTransitionHandoffPostcondition(
      db,
      obligation({ subjectRef: workplaceRef }),
    );
    assert.equal(result.satisfied, false);
    assert.match(result.reason, /exact GateDecision/);
  } finally {
    db.close();
  }
});

test('record-final-acceptance requires FinalAcceptance to cite the exact effect receipt source', () => {
  const db = new Database(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    db.pragma('foreign_keys=OFF');
    const workplaceRef = 'workplace/5/module@1/cell/item';
    db.prepare(
      `INSERT INTO factory_cell_final_acceptances
        (final_acceptance_ref,workplace_ref,candidate_set_ref,gate_decision_key,
         effect_receipt_refs,acceptance_digest,accepted_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(
      `cell-final-acceptance:${'f'.repeat(64)}`,
      workplaceRef,
      'candidate:1',
      'decision:1',
      JSON.stringify(['cell-effect-receipt:exact']),
      'f'.repeat(64),
      '2026-01-01T00:00:00.000Z',
    );

    const exact = obligation({
      obligationKey: 'effects-settled:cell-effect-receipt:exact:record-final-acceptance',
      sourceKind: 'effects-settled',
      sourceRef: 'cell-effect-receipt:exact',
      sourceDigest: 'e'.repeat(64),
      subjectRef: workplaceRef,
      handoffKind: 'record-final-acceptance',
    });
    assert.equal(readTransitionHandoffPostcondition(db, exact).satisfied, true);

    const decoy = { ...exact, sourceRef: 'cell-effect-receipt:other' };
    assert.equal(readTransitionHandoffPostcondition(db, decoy).satisfied, false);
  } finally {
    db.close();
  }
});
