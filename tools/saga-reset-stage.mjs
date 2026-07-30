#!/usr/bin/env node
/**
 * saga-reset-stage.mjs — partial reset: очищает один stage lifecycle, не трогая остальные.
 *
 * Usage:
 *   node tools/saga-reset-stage.mjs --stage=solution-formalization [--epic=1]
 *   node tools/saga-reset-stage.mjs --stage=solution-development
 *   node tools/saga-reset-stage.mjs --stage=solution-formalization --dry-run
 *
 * Что делает:
 *   1. Находит ProcessRun для указанного stage (по module_name mapping)
 *   2. Удаляет: node_runs, recovery_cases/attempts, managed_productions,
 *      process_products, tasks, work_intents, acceptance items для этого run
 *      (дропая immutable triggers временно)
 *   3. Сбрасывает ProcessRun → status=created (перезапустится)
 *   4. Сбрасывает StageRun → status=planned
 *   5. NOT touches: lifecycle_run, discovery artifacts/acceptance, formalization
 *      artifacts/acceptance (если сбрасываем development), etc.
 *
 * Дизайн основан на docs/design/PARTIAL-RESET-AND-RESUME.md.
 */
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH ?? 'C:/Users/user/.zcode/saga.db';

const STAGE_TO_MODULE = {
  'initial-discovery': 'product-discovery',
  'solution-formalization': 'solution-formalization',
  'solution-development': 'solution-development',
  'delivery-release': 'delivery-release',
};

function parseArgs(argv) {
  const opts = { stage: null, epic: 1, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--stage=')) opts.stage = arg.slice(8);
    else if (arg.startsWith('--epic=')) opts.epic = Number(arg.slice(7));
  }
  if (!opts.stage) {
    console.error('Usage: saga-reset-stage.mjs --stage=<stageId> [--epic=N] [--dry-run]');
    console.error('Stages:', Object.keys(STAGE_TO_MODULE).join(', '));
    process.exit(1);
  }
  return opts;
}

const { stage, epic, dryRun } = parseArgs(process.argv);
const moduleName = STAGE_TO_MODULE[stage];
if (!moduleName) {
  console.error(`Unknown stage '${stage}'. Known: ${Object.keys(STAGE_TO_MODULE).join(', ')}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('foreign_keys = OFF');

// Find lifecycle run and process run for this stage
const lifecycleRun = db.prepare(
  'SELECT id, status, current_stage_id FROM saga3_lifecycle_runs WHERE epic_id=? ORDER BY id DESC LIMIT 1',
).get(epic);

if (!lifecycleRun) {
  console.error(`No lifecycle run found for epic ${epic}`);
  process.exit(1);
}

const processRun = db.prepare(
  'SELECT id, module_name, status FROM saga3_process_runs WHERE id IN (SELECT process_run_id FROM saga3_stage_runs WHERE lifecycle_run_id=?) AND module_name=? ORDER BY id DESC LIMIT 1',
).get(lifecycleRun.id, moduleName);

const stageRun = db.prepare(
  'SELECT id, stage_id, status, process_run_id FROM saga3_stage_runs WHERE lifecycle_run_id=? AND stage_id=? ORDER BY id DESC LIMIT 1',
).get(lifecycleRun.id, stage);

console.log(`=== PARTIAL RESET: ${stage} (module: ${moduleName}) ===`);
console.log(`Lifecycle run: #${lifecycleRun.id} (${lifecycleRun.status})`);
console.log(`Stage run: ${stageRun ? `#${stageRun.id} (${stageRun.status})` : '(not found)'}`);
console.log(`Process run: ${processRun ? `#${processRun.id} (${processRun.status})` : '(not found)'}`);
console.log(`Epic: ${epic}`);
console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'EXECUTE'}`);
console.log('');

if (!processRun) {
  console.log('No process run to reset. Nothing to do.');
  db.close();
  process.exit(0);
}

const prId = processRun.id;

// Drop immutable triggers (acceptance items, node submissions have ABORT triggers)
const immutableTriggers = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%ABORT%'",
).all();
console.log(`Dropping ${immutableTriggers.length} immutable triggers (will be recreated on next run)`);

// Collect what will be deleted for reporting
const counts = {};
function countDelete(table, where) {
  const row = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get();
  counts[table] = row.n;
  return row.n;
}

countDelete('saga3_node_runs', `process_run_id=${prId}`);
countDelete('saga3_recovery_cases', `process_run_id=${prId}`);
countDelete('saga3_managed_artifact_productions', `process_run_id=${prId}`);
countDelete('saga3_managed_trace_productions', `process_run_id=${prId}`);
countDelete('saga3_managed_node_submissions', `process_run_id=${prId}`);
countDelete('saga3_process_products', `process_run_id=${prId}`);

// Tasks: find by metadata.process_run_id or generation_key containing process-run:prId
countDelete('tasks', `epic_id=${epic} AND (metadata LIKE '%"process_run_id":${prId}%' OR generation_key LIKE '%process-run:${prId}%')`);

// Work intents for this stage
countDelete('saga3_work_intents', `id IN (SELECT id FROM saga3_work_intents WHERE kind LIKE '%${moduleName.split('-')[0]}%' AND epic_id=${epic} AND id > (SELECT COALESCE(MAX(id),0) FROM saga3_work_intents WHERE kind NOT LIKE '%${moduleName.split('-')[0]}%'))`);

// Stage-specific tables
if (moduleName === 'solution-formalization') {
  countDelete('saga3_formalization_acceptance_baselines', `1=1`);
  countDelete('saga3_formalization_solution_contracts', `1=1`);
  // Acceptance items for AC artifacts created in this run
  countDelete('saga3_exact_candidate_acceptance_items', `decision_id IN (SELECT id FROM saga3_exact_candidate_acceptance_decisions WHERE ledger_id IN (SELECT id FROM saga3_managed_node_submissions WHERE process_run_id=${prId}))`);
  countDelete('saga3_exact_candidate_acceptance_decisions', `ledger_id IN (SELECT id FROM saga3_managed_node_submissions WHERE process_run_id=${prId})`);
}
if (moduleName === 'solution-development') {
  countDelete('saga3_development_outputs', `1=1`);
  countDelete('saga3_development_task_projections', `1=1`);
  countDelete('saga3_development_integration_observations', `1=1`);
}
if (moduleName === 'delivery-release') {
  countDelete('saga3_delivery_outputs', `1=1`);
  countDelete('saga3_delivery_approval_requests', `1=1`);
  countDelete('saga3_delivery_approval_decisions', `1=1`);
}

// Discovery-specific (for completeness)
if (moduleName === 'product-discovery') {
  countDelete('saga3_proposals', `1=1`);
  countDelete('saga3_normalization_proposals', `1=1`);
  countDelete('saga3_readiness_assessments', `1=1`);
  countDelete('saga3_discovery_settlements', `1=1`);
  countDelete('saga3_discovery_outcome_certificates', `1=1`);
  countDelete('saga3_discovery_diagnosis_reports', `1=1`);
  countDelete('saga3_discovery_diagnosis_control_intents', `1=1`);
  countDelete('saga3_readiness_control_intents', `1=1`);
  countDelete('saga3_raw_submissions', `1=1`);
  countDelete('saga3_control_intents', `1=1`);
}

// Artifacts created in this run (by managed productions)
const artifactIds = db.prepare(
  `SELECT DISTINCT artifact_id FROM saga3_managed_artifact_productions WHERE process_run_id=${prId}`,
).all().map(r => r.artifact_id);
counts['artifacts (this run)'] = artifactIds.length;

// command_receipts for tasks in this run
const taskIds = db.prepare(
  `SELECT id FROM tasks WHERE epic_id=${epic} AND (metadata LIKE '%"process_run_id":${prId}%' OR generation_key LIKE '%process-run:${prId}%')`,
).all().map(r => r.id);
counts['command_receipts (this run)'] = taskIds.length > 0
  ? db.prepare(`SELECT COUNT(*) n FROM command_receipts WHERE task_id IN (${taskIds.join(',')})`).get().n
  : 0;

console.log('=== ROWS TO DELETE ===');
for (const [table, n] of Object.entries(counts)) {
  if (n > 0) console.log(`  ${table}: ${n}`);
}
console.log('');

if (dryRun) {
  console.log('DRY RUN — no changes made. Re-run without --dry-run to execute.');
  db.close();
  process.exit(0);
}

// Execute
const tx = db.transaction(() => {
  // Drop immutable triggers
  for (const t of immutableTriggers) {
    db.exec(`DROP TRIGGER IF EXISTS ${t.name}`);
  }

  // Delete in dependency order
  const deleteTables = [
    ['saga3_recovery_attempts', `recovery_case_id IN (SELECT id FROM saga3_recovery_cases WHERE process_run_id=${prId})`],
    ['saga3_recovery_cases', `process_run_id=${prId}`],
    ['saga3_managed_node_submissions', `process_run_id=${prId}`],
    ['saga3_exact_candidate_acceptance_items', `decision_id IN (SELECT id FROM saga3_exact_candidate_acceptance_decisions WHERE ledger_id IN (SELECT id FROM saga3_managed_node_submissions WHERE process_run_id=${prId}))`],
    ['saga3_exact_candidate_acceptance_decisions', `ledger_id IN (SELECT id FROM saga3_managed_node_submissions WHERE process_run_id=${prId})`],
    ['saga3_managed_artifact_productions', `process_run_id=${prId}`],
    ['saga3_managed_trace_productions', `process_run_id=${prId}`],
    ['saga3_process_products', `process_run_id=${prId}`],
    ['saga3_node_runs', `process_run_id=${prId}`],
  ];

  // Stage-specific tables
  if (moduleName === 'solution-formalization') {
    deleteTables.push(['saga3_formalization_acceptance_baselines', '1=1']);
    deleteTables.push(['saga3_formalization_solution_contracts', '1=1']);
  }
  if (moduleName === 'solution-development') {
    deleteTables.push(['saga3_development_integration_observations', '1=1']);
    deleteTables.push(['saga3_development_task_projections', '1=1']);
    deleteTables.push(['saga3_development_outputs', '1=1']);
  }
  if (moduleName === 'delivery-release') {
    deleteTables.push(['saga3_delivery_approval_decisions', '1=1']);
    deleteTables.push(['saga3_delivery_approval_requests', '1=1']);
    deleteTables.push(['saga3_delivery_outputs', '1=1']);
  }
  if (moduleName === 'product-discovery') {
    deleteTables.push(['saga3_discovery_diagnosis_reports', '1=1']);
    deleteTables.push(['saga3_discovery_diagnosis_control_intents', '1=1']);
    deleteTables.push(['saga3_discovery_outcome_certificates', '1=1']);
    deleteTables.push(['saga3_discovery_settlements', '1=1']);
    deleteTables.push(['saga3_readiness_assessments', '1=1']);
    deleteTables.push(['saga3_readiness_control_intents', '1=1']);
    deleteTables.push(['saga3_normalization_proposals', '1=1']);
    deleteTables.push(['saga3_proposals', '1=1']);
    deleteTables.push(['saga3_raw_submissions', '1=1']);
    deleteTables.push(['saga3_control_intents', `epic_id=${epic} AND kind LIKE '%discovery%'`]);
  }

  let totalDeleted = 0;
  for (const [table, where] of deleteTables) {
    try {
      const info = db.prepare(`DELETE FROM ${table} WHERE ${where}`).run();
      if (info.changes > 0) {
        console.log(`  deleted ${table}: ${info.changes}`);
        totalDeleted += info.changes;
      }
    } catch (e) {
      if (!String(e.message).includes('no such table')) {
        console.log(`  SKIP ${table}: ${e.message}`);
      }
    }
  }

  // Delete tasks for this run
  try {
    const taskInfo = db.prepare(`DELETE FROM tasks WHERE epic_id=${epic} AND (metadata LIKE '%"process_run_id":${prId}%' OR generation_key LIKE '%process-run:${prId}%')`).run();
    if (taskInfo.changes > 0) console.log(`  deleted tasks: ${taskInfo.changes}`);
    totalDeleted += taskInfo.changes;
  } catch (e) { console.log(`  SKIP tasks: ${e.message}`); }

  // Delete command_receipts for those tasks
  if (taskIds.length > 0) {
    try {
      const crInfo = db.prepare(`DELETE FROM command_receipts WHERE task_id IN (${taskIds.join(',')})`).run();
      if (crInfo.changes > 0) console.log(`  deleted command_receipts: ${crInfo.changes}`);
      totalDeleted += crInfo.changes;
    } catch (e) { console.log(`  SKIP command_receipts: ${e.message}`); }
  }

  // Delete work_intents for this stage (kind starts with module prefix)
  try {
    const wiInfo = db.prepare(`DELETE FROM saga3_work_intents WHERE epic_id=${epic} AND kind LIKE '%${moduleName.split('-')[0]}%'`).run();
    if (wiInfo.changes > 0) console.log(`  deleted work_intents: ${wiInfo.changes}`);
    totalDeleted += wiInfo.changes;
  } catch (e) { console.log(`  SKIP work_intents: ${e.message}`); }

  // Delete artifacts created in this run
  if (artifactIds.length > 0) {
    // First delete their traces
    try {
      db.prepare(`DELETE FROM artifact_traces WHERE source_id IN (${artifactIds.join(',')}) OR target_id IN (${artifactIds.join(',')})`).run();
    } catch {}
    try {
      const artInfo = db.prepare(`DELETE FROM artifacts WHERE id IN (${artifactIds.join(',')})`).run();
      if (artInfo.changes > 0) console.log(`  deleted artifacts: ${artInfo.changes}`);
      totalDeleted += artInfo.changes;
    } catch (e) { console.log(`  SKIP artifacts: ${e.message}`); }
  }

  // Reset ProcessRun to created (will be replayed)
  db.prepare(`UPDATE saga3_process_runs SET status='created', local_outcome=NULL, updated_at=datetime('now') WHERE id=${prId}`).run();
  console.log(`  reset process_run #${prId} → created`);

  // Reset StageRun to planned
  if (stageRun) {
    db.prepare(`UPDATE saga3_stage_runs SET status='created', process_run_id=NULL, updated_at=datetime('now') WHERE id=${stageRun.id}`).run();
    console.log(`  reset stage_run #${stageRun.id} → created`);
  }

  // Reset lifecycle_run current_stage_id back to this stage
  db.prepare(`UPDATE saga3_lifecycle_runs SET status='running', current_stage_id=?, terminal_status=NULL, execution_lease_owner='', execution_lease_fence='', execution_lease_expires_at=datetime('now'), updated_at=datetime('now') WHERE id=${lifecycleRun.id}`).run(stage);
  console.log(`  reset lifecycle_run #${lifecycleRun.id} → running, stage=${stage}`);

  // Reset sqlite_sequence for tasks so new tasks don't collide
  try { db.exec("DELETE FROM sqlite_sequence WHERE name='tasks'"); } catch {}

  console.log(`\nTotal rows deleted: ${totalDeleted}`);
});

tx();
db.pragma('foreign_keys = ON');
db.close();

console.log('\n=== PARTIAL RESET COMPLETE ===');
console.log(`Stage '${stage}' cleared. Other stages untouched.`);
console.log('Run lifecycle with --resume to continue:');
console.log(`  node dist/orchestrate-cli.js ${epic} ${epic} --resume --concurrency=1`);
console.log('  --lifecycle-input=...');
console.log('\nNote: definition_hash check will still apply if lifecycle code changed.');
