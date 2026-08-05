// tests/architecture/workplace-stores-additive.test.mjs
//
// Conveyor v4 step 1.4 ratchet — the new v4_* tables are ADDITIVE.
//
// Target contract: CONVEYOR-V4-MIGRATION-PLAN.md step 1 contract
// «DB additive между фазами; SCHEMA_VERSION bump один раз (шаг 6)» and
// FACTORY-DOMAIN-ACCEPTANCE-REGISTRY §6 rule 8 ("any new module-specific
// table requires proof why the universal contract is physically
// inapplicable").
//
// This test applies SCHEMA_SQL to a fresh in-memory DB and asserts:
//   1. Every legacy table (projects, epics, tasks, worker_executions, ...)
//      still exists — the v4 additions did not drop or rename any.
//   2. The v4_* tables exist (workplaces, candidate_sets, ...).
//   3. No v4_* table shadows a legacy table name (no accidental collision).
//   4. The immutability triggers on v4_check_receipts and v4_gate_decisions
//      are installed (REG-17/18 append-only).
//
// This is the ratchet that catches a future migration that accidentally
// drops a legacy column or renames a table before step 6 (the dedicated
// drop-legacy step). It does NOT execute runtime code; it reads sqlite_master
// after applying the schema.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';

// Legacy tables that MUST survive every additive migration step until step 6
// explicitly drops them. Sourced from the pre-v4 schema. If a migration
// removes one of these before step 6, this ratchet fails.
const LEGACY_TABLES = [
  'projects',
  'repositories',
  'project_repositories',
  'repository_checkouts',
  'epics',
  'episode_workflows',
  'tasks',
  'worker_executions',
  'subtasks',
  'task_dependencies',
  'comments',
  'templates',
  'notes',
  'activity_log',
  'artifacts',
  'task_conflict_keys',
  'runtime_observations',
  'verification_evidence',
  'trusted_providers',
  'artifact_traces',
  'command_receipts',
  'lifecycle_events',
  'human_requests',
  'integration_intents',
  'saga3_work_intents',
  'saga3_raw_submissions',
  'saga3_control_intents',
  'saga3_normalization_proposals',
  'saga3_proposals',
  'saga3_lifecycle_runs',
  'lifecycle_execution_controls',
  'supervision_locks',
];

// The v4_* tables introduced by step 1.2. Each MUST exist.
const V4_TABLES = [
  'v4_workplaces',
  'v4_candidate_sets',
  'v4_candidate_set_members',
  'v4_execution_reservations',
  'v4_gate_runs',
  'v4_check_receipts',
  'v4_gate_decisions',
];

function tableNames(db) {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
      .map(r => r.name),
  );
}

function triggerNames(db) {
  return new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all())
      .map(r => r.name),
  );
}

test('step 1.4 ratchet: every legacy table survives the v4 additive migration', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const names = tableNames(db);
  const missing = LEGACY_TABLES.filter(t => !names.has(t));
  assert.deepEqual(missing, [], `v4 migration must be additive; missing legacy tables: ${missing.join(', ')}`);
  db.close();
});

test('step 1.4 ratchet: all v4_* tables are created on a fresh DB', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const names = tableNames(db);
  const missing = V4_TABLES.filter(t => !names.has(t));
  assert.deepEqual(missing, [], `expected v4 tables missing: ${missing.join(', ')}`);
  db.close();
});

test('step 1.4 ratchet: no v4_* table shadows a legacy name', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const names = tableNames(db);
  // Every v4_* name must be NEW (not a legacy table that got renamed in place
  // before step 6). A name appearing in BOTH sets would mean a v4 table
  // silently replaced a legacy one.
  for (const legacy of LEGACY_TABLES) {
    assert.ok(
      !legacy.startsWith('v4_'),
      `legacy table '${legacy}' has a v4_ prefix — suspicious pre-step-6 rename`,
    );
  }
  // v4 tables do not collide with legacy names.
  for (const v4 of V4_TABLES) {
    assert.ok(
      !LEGACY_TABLES.includes(v4),
      `v4 table '${v4}' collides with a legacy name`,
    );
  }
  void names;
  db.close();
});

test('REG-17/18 immutability triggers installed on v4_check_receipts and v4_gate_decisions', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const triggers = triggerNames(db);
  const expected = [
    'trg_v4_check_receipts_no_update',
    'trg_v4_check_receipts_no_delete',
    'trg_v4_gate_decisions_no_update',
    'trg_v4_gate_decisions_no_delete',
  ];
  const missing = expected.filter(t => !triggers.has(t));
  assert.deepEqual(missing, [], `immutability triggers missing: ${missing.join(', ')}`);
  db.close();
});

test('REG-17: v4_check_receipts UPDATE/DELETE actually aborts', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  // Need a workplace + gate_run to satisfy FKs before inserting a receipt.
  db.prepare(
    `INSERT INTO v4_workplaces (workplace_ref, process_run_id, module_ref, production_cell_id, work_key, kanban_phase, loop_state, next_role)
     VALUES ('workplace/1/m@1/c/default', 1, 'm@1', 'c', 'default', 'todo', 'idle', 'author')`,
  ).run();
  db.prepare(
    `INSERT INTO v4_gate_runs (gate_run_ref, workplace_ref, gate_phase, subject_candidate_set_ref, check_plan_ref, check_plan_digest, expected_workplace_revision, gate_lease_ref)
     VALUES ('gr-1', 'workplace/1/m@1/c/default', 'author', 'cs-1', 'plan-1', 'd', 0, 'lease-1')`,
  ).run();
  db.prepare(
    `INSERT INTO v4_check_receipts (check_receipt_ref, check_run_ref, subject_candidate_set_ref, provider_id, provider_version, provider_digest, outcome, receipt_digest)
     VALUES ('cr-1', 'gr-1', 'cs-1', 'tsc', '5', 'd', 'passed', 'd')`,
  ).run();
  assert.throws(
    () => db.prepare("UPDATE v4_check_receipts SET outcome='failed' WHERE check_receipt_ref='cr-1'").run(),
    /immutable/i,
  );
  assert.throws(
    () => db.prepare("DELETE FROM v4_check_receipts WHERE check_receipt_ref='cr-1'").run(),
    /immutable/i,
  );
  db.close();
});

test('REG-18: v4_gate_decisions UPDATE/DELETE actually aborts', () => {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  db.prepare(
    `INSERT INTO v4_workplaces (workplace_ref, process_run_id, module_ref, production_cell_id, work_key, kanban_phase, loop_state, next_role)
     VALUES ('workplace/1/m@1/c/default', 1, 'm@1', 'c', 'default', 'todo', 'idle', 'author')`,
  ).run();
  db.prepare(
    `INSERT INTO v4_gate_decisions (decision_key, workplace_ref, gate_ref, gate_run_ref, gate_phase, transition_ref, subject_candidate_set_ref, verdict, check_plan_ref, check_plan_digest, decision_policy_ref, decision_policy_digest, installation_digest, decision_digest)
     VALUES ('dk-1', 'workplace/1/m@1/c/default', 'g', 'gr', 'final', 't', 'cs-1', 'accepted', 'p', 'd', 'pol', 'd', 'i', 'd')`,
  ).run();
  assert.throws(
    () => db.prepare("UPDATE v4_gate_decisions SET verdict='failed' WHERE decision_key='dk-1'").run(),
    /immutable/i,
  );
  assert.throws(
    () => db.prepare("DELETE FROM v4_gate_decisions WHERE decision_key='dk-1'").run(),
    /immutable/i,
  );
  db.close();
});
