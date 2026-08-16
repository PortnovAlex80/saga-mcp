// tests/infrastructure/cell-effect-repair-issue-columns.test.mjs
//
// Additive migration (ADR-074 follow-up): `factory_cell_effect_repair_issues`
// gained five exact-identity columns. Databases created by the immediately
// preceding build hold the table WITHOUT them (CREATE TABLE IF NOT EXISTS is a
// no-op there), which made every run-effects postcondition read fail with
// `no such column: ri.gate_decision_digest` while the obligation ledger kept
// retrying the failure as if it were transient (observed live: 1300+ attempts,
// zero engine log lines — the livelock that parked Development).
//
// This file proves:
//   1. NON-DESTRUCTIVE MIGRATION — a pre-ADR-074-final table keeps its rows
//      untouched; the five columns land afterwards; replay is idempotent.
//   2. POSTCONDITION QUERY COMPILES — the exact run-effects postcondition SQL
//      from transition-handoff-postconditions prepares and executes against a
//      migrated table (this is the statement that failed 1300+ times live).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { SCHEMA_SQL, ensureCellEffectRepairIssueColumns } from '../../dist/schema.js';

// The table exactly as the fcfa32a6-era build created it (no effect_version,
// effect_digest, gate_decision_digest, expected/resulting_workplace_revision).
const PRE_FIX_SHAPE = `
CREATE TABLE IF NOT EXISTS factory_cell_effect_repair_issues (
  effect_repair_ref        TEXT PRIMARY KEY,
  workplace_ref            TEXT NOT NULL,
  effect_id                TEXT NOT NULL,
  candidate_set_ref        TEXT NOT NULL,
  production_revision_ref  TEXT NOT NULL,
  gate_decision_key        TEXT NOT NULL,
  acceptance_digest        TEXT NOT NULL,
  issue_snapshot           TEXT NOT NULL,
  issue_digest             TEXT NOT NULL,
  receipt_digest           TEXT NOT NULL UNIQUE,
  created_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function preFixDatabase() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(PRE_FIX_SHAPE);
  return db;
}

test('migration adds the five ADR-074 columns to a pre-fix table, preserving rows', () => {
  const db = preFixDatabase();
  db.prepare(
    `INSERT INTO factory_cell_effect_repair_issues
       (effect_repair_ref,workplace_ref,effect_id,candidate_set_ref,production_revision_ref,
        gate_decision_key,acceptance_digest,issue_snapshot,issue_digest,receipt_digest)
     VALUES ('r1','w1','e1','c1','p1','g1','a1','{}','i1','rr1')`,
  ).run();

  ensureCellEffectRepairIssueColumns(db);

  const columns = db.prepare('PRAGMA table_info(factory_cell_effect_repair_issues)')
    .all().map((c) => c.name);
  for (const expected of [
    'effect_version',
    'effect_digest',
    'gate_decision_digest',
    'expected_workplace_revision',
    'resulting_workplace_revision',
  ]) {
    assert.ok(columns.includes(expected), `column ${expected} must exist after migration`);
  }
  const row = db.prepare('SELECT * FROM factory_cell_effect_repair_issues').get();
  assert.equal(row.effect_repair_ref, 'r1');
  assert.equal(row.gate_decision_digest, '');

  // Idempotent on replay: second call is a no-op.
  ensureCellEffectRepairIssueColumns(db);
  assert.equal(
    db.prepare('PRAGMA table_info(factory_cell_effect_repair_issues)').all().length,
    columns.length,
  );
  db.close();
});

test('migration is a no-op on a fresh SCHEMA_SQL database', () => {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=OFF;');
  db.exec(SCHEMA_SQL);
  const before = db.prepare('PRAGMA table_info(factory_cell_effect_repair_issues)')
    .all().map((c) => c.name);
  ensureCellEffectRepairIssueColumns(db);
  const after = db.prepare('PRAGMA table_info(factory_cell_effect_repair_issues)')
    .all().map((c) => c.name);
  assert.deepEqual(after, before);
  db.close();
});

test('the run-effects postcondition UNION query compiles against a migrated pre-fix table', () => {
  const db = preFixDatabase();
  ensureCellEffectRepairIssueColumns(db);
  db.exec(`
    CREATE TABLE factory_workplaces (workplace_ref TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE factory_cell_effect_receipts (workplace_ref TEXT, gate_decision_key TEXT);
    CREATE TABLE factory_cell_final_acceptances (workplace_ref TEXT, gate_decision_key TEXT);
    INSERT INTO factory_workplaces VALUES ('w1', 7);
  `);
  const statement = db.prepare(
    `SELECT 1
       FROM factory_cell_effect_receipts er
      WHERE er.workplace_ref=? AND er.gate_decision_key=?
      UNION ALL
     SELECT 1
       FROM factory_cell_effect_repair_issues ri
       JOIN factory_workplaces w ON w.workplace_ref=ri.workplace_ref
      WHERE ri.workplace_ref=? AND ri.gate_decision_key=?
        AND ri.gate_decision_digest=?
        AND w.revision>=ri.resulting_workplace_revision
      UNION ALL
     SELECT 1
       FROM factory_cell_final_acceptances fa
      WHERE fa.workplace_ref=? AND fa.gate_decision_key=?
      LIMIT 1`,
  );
  // Unsatisfied (empty tables) — but it must EXECUTE, not throw
  // `no such column: ri.gate_decision_digest`.
  assert.equal(statement.get('w1', 'g1', 'w1', 'g1', 'd1', 'w1', 'g1'), undefined);
  db.close();
});
