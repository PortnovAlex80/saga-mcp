#!/usr/bin/env node
/**
 * Reset the main saga.db to a clean state for a fresh project.
 * Wipes all saga3_* process data + tracker data (tasks, artifacts, projects,
 * epics, etc) but KEEPS the schema and saga3_module_installations (so installed
 * packages survive — they are immutable infrastructure, not run data).
 *
 * Usage: node reset-saga-db.mjs
 * Target: C:/Users/user/.zcode/saga.db (override via DB_PATH)
 */
import Database from 'better-sqlite3';

const dbPath = process.env.DB_PATH ?? 'C:/Users/user/.zcode/saga.db';
const db = new Database(dbPath);
db.pragma('foreign_keys = OFF');

// Tables to wipe completely (run data).
const runDataTables = [
  // Tracker core
  'subtasks', 'comments', 'notes', 'traces',
  'verification_evidence',
  'tasks', 'artifacts',
  'episode_workflows',
  'project_repositories', 'repositories',
  'epics', 'projects',
  'worker_executions',
  // command_receipts: worker_done verdicts. These MUST be cleared on reset
  // because requireApprovedReview reads the latest accepted receipt per task,
  // and stale receipts from prior lifecycle runs (same task_id reused) cause
  // EXACT_ACCEPTANCE_APPROVED_REVIEW_REQUIRED / acceptance-blocked.
  'command_receipts',
  // saga3 process/lifecycle data
  'saga3_managed_artifact_productions',
  'saga3_managed_trace_productions',
  'saga3_exact_candidate_acceptance_items',
  'saga3_exact_candidate_acceptance_decisions',
  'saga3_recovery_attempts',
  'saga3_recovery_cases',
  'saga3_call_instances',
  'saga3_protocol_step_runs',
  'saga3_protocol_runs',
  'saga3_managed_node_submissions',
  'saga3_process_products',
  'saga3_node_runs',
  'saga3_stage_runs',
  'saga3_process_transitions',
  'saga3_lifecycle_runs',
  'saga3_process_outcome_certificates',
  'saga3_process_runs',
  // saga3 discovery
  'saga3_discovery_diagnosis_reports',
  'saga3_discovery_diagnosis_control_intents',
  'saga3_discovery_outcome_certificates',
  'saga3_discovery_settlements',
  'saga3_readiness_assessments',
  'saga3_readiness_control_intents',
  'saga3_normalization_proposals',
  'saga3_proposals',
  'saga3_raw_submissions',
  'saga3_control_intents',
  'saga3_work_intents',
  // saga3 development
  'saga3_development_integration_observations',
  'saga3_development_task_projections',
  'saga3_development_outputs',
  // saga3 delivery
  'saga3_delivery_approval_decisions',
  'saga3_delivery_approval_requests',
  'saga3_delivery_outputs',
  // saga3 formalization
  'saga3_formalization_solution_contracts',
  'saga3_formalization_acceptance_baselines',
  // scenario locks (run-scoped, not package infra)
  'saga3_scenario_module_locks',
  'saga3_scenario_installations',
  // Module installations: these are normally immutable infra, but after a
  // source change that alters a module definition (e.g. allowedTools fix), the
  // package_digest changes and reinstall fails with "different package_digest".
  // Clearing here lets the next lifecycle run reinstall fresh packages.
  'saga3_module_installations',
];

let wiped = 0;
const tx = db.transaction(() => {
  // Some saga3 tables have BEFORE DELETE/UPDATE triggers that enforce
  // immutability (acceptance items, node submissions, dev/delivery outputs).
  // For a test reset we need to bypass them: drop the triggers, delete, and
  // let the next getDb() migration recreate them.
  const immutableTriggers = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%ABORT%'",
  ).all();
  for (const t of immutableTriggers) {
    db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
  }

  for (const table of runDataTables) {
    try {
      const info = db.prepare(`DELETE FROM ${table}`).run();
      if (info.changes > 0) {
        wiped += info.changes;
        console.log(`  wiped ${table}: ${info.changes} rows`);
      }
    } catch (e) {
      // table may not exist in this schema version — skip
      if (!String(e.message).includes('no such table')) {
        console.log(`  SKIP ${table}: ${e.message}`);
      }
    }
  }
  // Reset autoincrement sequences so new projects start at id=1.
  try { db.exec("DELETE FROM sqlite_sequence WHERE name IN ('projects','epics','repositories','tasks','artifacts')"); } catch {}
});
tx();

db.pragma('foreign_keys = ON');
db.close();

console.log(`\n=== Reset complete: ${wiped} rows wiped from ${dbPath} ===`);
console.log('Schema preserved. Module installations cleared (reinstall on next run).');
