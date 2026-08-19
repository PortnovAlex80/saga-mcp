// tests/infrastructure/reconciliation-ledger.test.mjs
//
// SEAM-ARCHITECT Layer 3 — the durable, append-only reconciliation ledger
// (K13 house pattern, mirroring factory_replan_mandates in
// sqlite-replan-mandate-ledger.ts). The ledger is the count the CAP counts on
// and the ratchet the structural-seam denial reads; a reconciliation round
// that never lands here is invisible to the next admission decision.

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import test from 'node:test';

import {
  RECONCILIATION_SEAM_CAP,
  assembleReconciliationReport,
  sealReconciliation,
} from '../../dist/process-modules/domain/workplace/reconciliation-desk.js';
import { SqliteReconciliationLedger } from
  '../../dist/infrastructure/workplace/sqlite-reconciliation-ledger.js';
import { asWorkplaceRef } from
  '../../dist/process-modules/domain/workplace/workplace-ref.js';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

const WORKPLACE = asWorkplaceRef({
  processRunId: 9,
  moduleRef: 'development@1.0.0',
  productionCellId: 'integration-cell',
  workKey: 'default',
});

function sealedFor(seamKey, paths = ['src/seam.ts']) {
  const seams = [{ seamKey, seamPaths: paths, description: `defect ${seamKey}` }];
  const report = assembleReconciliationReport({
    admittedSeams: seams,
    repairs: [{
      seamKey,
      seamPaths: paths,
      whatWasDone: 'bounded seam repair',
      evidenceRef: `check-receipt:${seamKey}`,
    }],
    remainingGaps: [],
    rationale: 'orphan seam reconciled within its bounded surface',
  });
  return sealReconciliation({
    admittedSeams: seams,
    report,
    sanction: { reviewerExecutionRef: 'exec-reviewer', gateDecisionKey: `gate-${seamKey}` },
  });
}

test('ledger: append-only — UPDATE and DELETE are rejected by triggers', () => {
  const db = makeDb();
  const ledger = new SqliteReconciliationLedger(db);
  ledger.appendSealedRecord({ workplaceRef: WORKPLACE, record: sealedFor('s::a') });
  assert.throws(
    () => db.prepare('UPDATE factory_reconciliation_records SET report_json=NULL').run(),
    /append-only/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM factory_reconciliation_records').run(),
    /append-only/,
  );
  db.close();
});

test('ledger: append is idempotent — the same sealed record never lands twice', () => {
  const db = makeDb();
  const ledger = new SqliteReconciliationLedger(db);
  const record = sealedFor('s::a');
  const first = ledger.appendSealedRecord({ workplaceRef: WORKPLACE, record });
  const replay = ledger.appendSealedRecord({ workplaceRef: WORKPLACE, record });
  assert.equal(first.id, replay.id, 'a replayed append returns the existing row id');
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_reconciliation_records',
  ).get();
  assert.equal(count.n, 1);
  db.close();
});

test('ledger: admission consults prior rows — ratchet and cap over the lineage', () => {
  const db = makeDb();
  const ledger = new SqliteReconciliationLedger(db);

  const orphan = { seamKey: 's::first', seamPaths: ['src/a.ts'], description: 'd' };
  assert.equal(
    ledger.admitReconciliation({
      workplaceRef: WORKPLACE,
      seam: orphan,
      ownership: { ownedByTaskId: null },
    }).admitted,
    true,
    'no history → orphan seam admitted',
  );

  ledger.appendSealedRecord({ workplaceRef: WORKPLACE, record: sealedFor('s::first') });

  const survived = ledger.admitReconciliation({
    workplaceRef: WORKPLACE,
    seam: orphan,
    ownership: { ownedByTaskId: null },
  });
  assert.equal(survived.admitted, false);
  assert.equal(survived.reason, 'structural-seam',
    'the same key surviving a reconciliation round is replan territory');

  for (let i = 0; i < RECONCILIATION_SEAM_CAP - 1; i += 1) {
    ledger.appendSealedRecord({
      workplaceRef: WORKPLACE,
      record: sealedFor(`s::round-${i}`),
    });
  }
  const capped = ledger.admitReconciliation({
    workplaceRef: WORKPLACE,
    seam: { seamKey: 's::fresh', seamPaths: ['src/x.ts'], description: 'd' },
    ownership: { ownedByTaskId: null },
  });
  assert.equal(capped.admitted, false);
  assert.equal(capped.reason, 'cap',
    'a lineage at the cap never mints another reconciliation round');
  db.close();
});

test('ledger: owned seams are denied without touching the ledger', () => {
  const db = makeDb();
  const ledger = new SqliteReconciliationLedger(db);
  const verdict = ledger.admitReconciliation({
    workplaceRef: WORKPLACE,
    seam: { seamKey: 's::owned', seamPaths: ['src/a.ts'], description: 'd' },
    ownership: { ownedByTaskId: 12 },
  });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, 'owned-seam');
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM factory_reconciliation_records',
  ).get();
  assert.equal(count.n, 0, 'denials never write');
  db.close();
});
