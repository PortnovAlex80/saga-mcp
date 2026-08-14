import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import { readTransitionHandoffPostcondition } from '../../dist/process-modules/application/transition-handoff-postconditions.js';

function runEffectsObligation(workplaceRef) {
  return {
    obligationKey: 'gate-accepted:decision:1:run-effects',
    sourceKind: 'gate-accepted',
    sourceRef: 'decision:1',
    sourceDigest: 'd'.repeat(64),
    subjectRef: workplaceRef,
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
  };
}

test('run-effects cannot complete while effect_pending has no exact durable receipt', () => {
  const db = new Database(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    db.pragma('foreign_keys=OFF');
    const workplaceRef = 'workplace/3/module@1/cell/item';
    db.prepare(
      `INSERT INTO factory_workplaces
        (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
         kanban_phase,loop_state,next_role,revision)
       VALUES (?,3,'module@1','cell','item','review_in_progress','effect_pending','reviewer',7)`,
    ).run(workplaceRef);
    const obligation = runEffectsObligation(workplaceRef);
    assert.deepEqual(readTransitionHandoffPostcondition(db, obligation), {
      satisfied: false,
      reason: 'effect is still pending and has no durable receipt',
    });

    db.prepare(
      `INSERT INTO factory_cell_effect_receipts
        (effect_receipt_ref,workplace_ref,effect_id,candidate_set_ref,
         gate_decision_key,provider_receipt_ref,provider_receipt_digest,
         evidence_snapshot,receipt_digest)
       VALUES ('effect:1',?,'git-integration','candidate:1','decision:1',
               'provider:1',?,'{}',?)`,
    ).run(workplaceRef, 'a'.repeat(64), 'b'.repeat(64));
    assert.equal(readTransitionHandoffPostcondition(db, obligation).satisfied, true);
  } finally {
    db.close();
  }
});

test('run-effects completes after an exact repair route leaves effect_pending', () => {
  const db = new Database(':memory:');
  try {
    db.exec(SCHEMA_SQL);
    db.pragma('foreign_keys=OFF');
    const workplaceRef = 'workplace/4/module@1/cell/item';
    db.prepare(
      `INSERT INTO factory_workplaces
        (workplace_ref,process_run_id,module_ref,production_cell_id,work_key,
         kanban_phase,loop_state,next_role,revision)
       VALUES (?,4,'module@1','cell','item','todo','repair_wait','author',8)`,
    ).run(workplaceRef);
    const result = readTransitionHandoffPostcondition(db, runEffectsObligation(workplaceRef));
    assert.equal(result.satisfied, true);
    assert.match(result.reason, /repair_wait/);
  } finally {
    db.close();
  }
});
