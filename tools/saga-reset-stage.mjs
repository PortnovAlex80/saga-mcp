#!/usr/bin/env node
/**
 * saga-reset-stage.mjs — partial reset: clears ONE lifecycle stage without
 * touching the others. Designed against
 * docs/design/PARTIAL-RESET-AND-RESUME.md.
 *
 * Modes (mutually exclusive):
 *
 *   --stage=<stageId>                       Scenario D (DEFAULT)
 *                                           Stay on the same stage. Delete the
 *                                           stage's ProcessRun + node_runs +
 *                                           recovery + tasks + managed products,
 *                                           NULL out stage_run.process_run_id,
 *                                           keep the stage_run struct itself.
 *                                           Orchestrator on --resume calls
 *                                           ensureStageRun (replays the existing
 *                                           stage_run because binding_hash +
 *                                           input_hash still match) and then
 *                                           starts a FRESH ProcessRun.
 *
 *   --stage=<stageId> --rewind-to=<prevId>  Scenario A
 *                                           Rewind current_stage_id back to a
 *                                           PREVIOUS completed stage so the
 *                                           orchestrator re-enters this stage by
 *                                           its terminal-transition. Deletes the
 *                                           stage_run + process_transitions too.
 *                                           Use when the stage input must change
 *                                           (e.g. formalization baseline was
 *                                           re-derived) and replaying the old
 *                                           stage_run binding would mismatch.
 *
 *   --process-run=<prId>                    Scenario D, narrowed to one ProcessRun.
 *                                           Finds the stage_run that owns it and
 *                                           does the same cleanup as --stage.
 *
 * Common contract for resume (both D and A):
 *   - lifecycle_run.status='paused', lease cleared
 *   - On --resume (resumePaused=true) the orchestrator acquires a fresh lease and
 *     walks the stage loop again from current_stage_id.
 *
 * What is NEVER touched:
 *   - saga3_module_installations        (other stages pin to them; §7 risk 7)
 *   - saga3_exact_candidate_acceptance_*  for OTHER process_runs (formalization
 *                                         heritage — they point at artifact_id,
 *                                         not process_run)
 *   - artifacts created by OTHER process_runs
 *
 * See docs/design/PARTIAL-RESET-AND-RESUME.md §3 (scenarios A/D), §4 (SQL),
 * §5.1 (this tool), §7 (risks).
 */
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH ?? 'C:/Users/user/.zcode/saga.db';

// stage_id -> module_name. Fixed in product-delivery-lifecycle.ts.
// Lifecycle definition is not stored in a cleanup-readable form in the DB, so we
// hardcode the map (matches product-delivery-lifecycle.ts:164-348).
const STAGE_TO_MODULE = {
  'initial-discovery': 'product-discovery',
  'solution-formalization': 'solution-formalization',
  'solution-development': 'solution-development',
  'delivery-release': 'delivery-release',
};

// Ordered stages — used to validate --rewind-to targets and to detect the
// preceding completed stage (for reporting only).
const STAGE_ORDER = [
  'initial-discovery',
  'solution-formalization',
  'solution-development',
  'delivery-release',
];

function parseArgs(argv) {
  const opts = {
    stage: null,
    rewindTo: null,
    processRun: null,
    epic: 1,
    lifecycleRun: null,
    dryRun: false,
    confirm: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--confirm' || arg === '--yes') opts.confirm = true;
    else if (arg.startsWith('--stage=')) opts.stage = arg.slice(8);
    else if (arg.startsWith('--rewind-to=')) opts.rewindTo = arg.slice(12);
    else if (arg.startsWith('--process-run=')) opts.processRun = Number(arg.slice(14));
    else if (arg.startsWith('--epic=')) opts.epic = Number(arg.slice(7));
    else if (arg.startsWith('--lifecycle-run=')) opts.lifecycleRun = Number(arg.slice(16));
    else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }
  if (opts.processRun === null && !opts.stage) {
    printUsage();
    process.exit(1);
  }
  if (opts.stage && !(opts.stage in STAGE_TO_MODULE)) {
    console.error(`Unknown stage '${opts.stage}'. Known: ${Object.keys(STAGE_TO_MODULE).join(', ')}`);
    process.exit(1);
  }
  if (opts.rewindTo && opts.processRun !== null) {
    console.error('--rewind-to cannot be combined with --process-run');
    process.exit(1);
  }
  if (opts.rewindTo && !(opts.rewindTo in STAGE_TO_MODULE)) {
    console.error(`Unknown rewind target '${opts.rewindTo}'. Known: ${Object.keys(STAGE_TO_MODULE).join(', ')}`);
    process.exit(1);
  }
  return opts;
}

function printUsage() {
  console.error('Usage:');
  console.error('  saga-reset-stage.mjs --stage=<stageId> [--epic=N] [--dry-run] [--confirm]');
  console.error('  saga-reset-stage.mjs --stage=<stageId> --rewind-to=<prevStageId> [--dry-run] [--confirm]');
  console.error('  saga-reset-stage.mjs --process-run=<prId> [--epic=N] [--dry-run] [--confirm]');
  console.error('');
  console.error(`Stages: ${Object.keys(STAGE_TO_MODULE).join(', ')}`);
  console.error('');
  console.error('Default (--stage only): Scenario D — keep the stage_run, delete the');
  console.error('  ProcessRun, NULL stage_run.process_run_id. Resume replays the stage_run.');
  console.error('--rewind-to: Scenario A — also delete the stage_run + its transitions,');
  console.error('  point current_stage_id at a previous completed stage.');
}

const opts = parseArgs(process.argv);
const { stage, rewindTo, processRun, epic, dryRun, confirm } = opts;

const db = new Database(DB_PATH);
db.pragma('foreign_keys = OFF');

// ---------------------------------------------------------------------------
// Resolve targets
// ---------------------------------------------------------------------------

const lifecycleRun = opts.lifecycleRun
  ? db.prepare('SELECT id, status, current_stage_id, current_stage_run_id, project_id, epic_id FROM saga3_lifecycle_runs WHERE id=?').get(opts.lifecycleRun)
  : db.prepare('SELECT id, status, current_stage_id, current_stage_run_id, project_id, epic_id FROM saga3_lifecycle_runs WHERE epic_id=? ORDER BY id DESC LIMIT 1').get(epic);

if (!lifecycleRun) {
  console.error(`No lifecycle run found${opts.lifecycleRun ? ` with id ${opts.lifecycleRun}` : ` for epic ${epic}`}.`);
  db.close();
  process.exit(1);
}

// Resolve stageRun + processRun regardless of which mode was selected.
let stageRun;
let resolvedStageId = stage;
let prId = processRun;

if (prId !== null) {
  // --process-run mode: find the stage_run that owns this process_run within
  // this lifecycle_run.
  stageRun = db.prepare(
    'SELECT id, lifecycle_run_id, ordinal, stage_id, attempt, status, process_run_id, binding_hash, input_hash FROM saga3_stage_runs WHERE lifecycle_run_id=? AND process_run_id=?',
  ).get(lifecycleRun.id, prId);
  if (!stageRun) {
    // Fall back: the process_run exists but is not bound to any stage_run here.
    const orphan = db.prepare('SELECT id, module_name, status FROM saga3_process_runs WHERE id=?').get(prId);
    if (!orphan) {
      console.error(`No process_run #${prId} and no stage_run bound to it.`);
      db.close();
      process.exit(1);
    }
    resolvedStageId = Object.entries(STAGE_TO_MODULE).find(([, m]) => m === orphan.module_name)?.[0] ?? stage;
    console.warn(`WARN: process_run #${prId} (${orphan.module_name}) is not bound to any stage_run of lifecycle_run #${lifecycleRun.id}.`);
    console.warn(`      Will clear process_run rows only; no stage_run / lifecycle cursor update.`);
    stageRun = null;
  } else {
    resolvedStageId = stageRun.stage_id;
  }
} else {
  stageRun = db.prepare(
    'SELECT id, lifecycle_run_id, ordinal, stage_id, attempt, status, process_run_id, binding_hash, input_hash FROM saga3_stage_runs WHERE lifecycle_run_id=? AND stage_id=? ORDER BY id DESC LIMIT 1',
  ).get(lifecycleRun.id, stage);
  if (stageRun?.process_run_id) {
    prId = stageRun.process_run_id;
  } else {
    // stage_run with no bound process_run — try to find the most recent
    // process_run for this module in this lifecycle_run (best effort).
    const loose = db.prepare(
      `SELECT pr.id, pr.module_name, pr.status FROM saga3_process_runs pr
       JOIN saga3_stage_runs sr ON sr.process_run_id=pr.id
       WHERE sr.lifecycle_run_id=? AND pr.module_name=?
       ORDER BY pr.id DESC LIMIT 1`,
    ).get(lifecycleRun.id, STAGE_TO_MODULE[stage]);
    prId = loose?.id ?? null;
  }
}

const moduleName = resolvedStageId ? STAGE_TO_MODULE[resolvedStageId] : null;

// Safety: never reset a terminal lifecycle_run — rollback is meaningless.
if (['completed', 'failed', 'cancelled'].includes(lifecycleRun.status)) {
  console.error(`lifecycle_run #${lifecycleRun.id} is terminal (${lifecycleRun.status}).`);
  console.error('Reset is meaningless on a terminal run. Archive it and start a fresh one.');
  db.close();
  process.exit(1);
}

// Rewind target validation: must be an EARLIER completed stage (not the same,
// not a later one), and must still have its completed stage_run so the
// orchestrator can re-emit the terminal-transition into this stage.
let rewindStageRun = null;
if (rewindTo) {
  if (rewindTo === resolvedStageId) {
    console.error(`--rewind-to must point to a DIFFERENT stage (got '${rewindTo}' for both).`);
    db.close();
    process.exit(1);
  }
  const rewindIdx = STAGE_ORDER.indexOf(rewindTo);
  const stageIdx = STAGE_ORDER.indexOf(resolvedStageId);
  if (rewindIdx === -1 || stageIdx === -1 || rewindIdx >= stageIdx) {
    console.error(`--rewind-to='${rewindTo}' must be an EARLIER stage than '${resolvedStageId}'.`);
    db.close();
    process.exit(1);
  }
  rewindStageRun = db.prepare(
    "SELECT id, stage_id, status FROM saga3_stage_runs WHERE lifecycle_run_id=? AND stage_id=? AND status='completed' ORDER BY id DESC LIMIT 1",
  ).get(lifecycleRun.id, rewindTo);
  if (!rewindStageRun) {
    console.error(`Cannot rewind to '${rewindTo}': no completed stage_run for it in lifecycle_run #${lifecycleRun.id}.`);
    db.close();
    process.exit(1);
  }
  // KNOWN LIMITATION (verified against lifecycle-orchestrator.ts +
  // sqlite-lifecycle-run-repository.ts completeStage): rewinding to a stage
  // whose stage_run is ALREADY 'completed' will NOT resume cleanly.
  //
  //   - If the terminal-transition row is preserved, completeStage() takes the
  //     replay branch (replayed:true) WITHOUT moving the lifecycle cursor, so
  //     the orchestrator loops on that completed stage until it hits
  //     'Lifecycle flow exceeded its bounded stage count'.
  //   - If the transition row is deleted (what this tool does), completeStage()
  //     tries to re-finalise a stage_run whose status='completed' and throws
  //     LIFECYCLE_STAGE_ALREADY_TERMINAL.
  //
  // A clean rewind-to-completed-stage requires a TS change in completeStage()
  // (a "re-emit transition for an already-completed stage" branch). Until that
  // exists, prefer the DEFAULT Scenario D (keep stage_run, recreate the
  // ProcessRun in place). --rewind-to is retained for the case where the
  // rewind target stage itself also needs re-running and you reset BOTH stages
  // (rewind target first, then this one).
  console.warn(`WARN: --rewind-to='${rewindTo}' targets a completed stage_run (#${rewindStageRun.id}).`);
  console.warn('      Resume from a completed rewind target is NOT reliable without a TS change in');
  console.warn('      completeStage() (see SqliteLifecycleRunRepository.completeStage).');
  console.warn('      Prefer the DEFAULT mode (drop --rewind-to) which recreates the ProcessRun');
  console.warn('      in place and replays the preserved stage_run cleanly.');
  if (!dryRun && !confirm) {
    console.error('      (Re-run with --confirm to proceed anyway, or with --dry-run to preview.)');
    db.close();
    process.exit(1);
  }
}

const scenario = rewindTo ? 'A (rewind)' : 'D (same-stage)';

console.log(`=== PARTIAL RESET — scenario ${scenario} ===`);
console.log(`Lifecycle run: #${lifecycleRun.id} (status=${lifecycleRun.status}, project=${lifecycleRun.project_id}, epic=${lifecycleRun.epic_id})`);
console.log(`Stage: ${resolvedStageId ?? '(none)'}${moduleName ? ` (module: ${moduleName})` : ''}`);
console.log(`Stage run: ${stageRun ? `#${stageRun.id} (status=${stageRun.status}, attempt=${stageRun.attempt}, process_run_id=${stageRun.process_run_id})` : '(none / orphaned process_run)'}`);
console.log(`Process run: ${prId !== null ? `#${prId}` : '(none)'}`);
if (rewindStageRun) {
  console.log(`Rewind target: '${rewindTo}' stage_run #${rewindStageRun.id} (status=${rewindStageRun.status})`);
}
console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : confirm ? 'EXECUTE' : 'PREVIEW (use --confirm to apply)'}`);
console.log('');

if (prId === null && !rewindTo) {
  console.log('Nothing to delete: no ProcessRun and not a rewind. Exiting.');
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Collect what will be deleted / updated (for reporting)
// ---------------------------------------------------------------------------

// Drop immutable ABORT triggers only inside the transaction and recreate the
// exact definitions before commit.
const immutableTriggers = db.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%ABORT%'",
).all();
const initialForeignKeyViolations = new Set(
  db.pragma('foreign_key_check').map(row =>
    `${row.table}:${row.rowid}:${row.parent}:${row.fkid}`),
);

// Build the deletion plan as a list of [table, whereClause, optionalNote].
// The ORDER matters for the FK-RESTRICT columns, but because we disable FKs
// AND drop the ABORT triggers, ordering only affects reporting clarity.
function buildPlan() {
  const plan = [];
  if (prId === null) return plan;

  // 1. stage-specific projection tables (process_run_id-keyed)
  if (moduleName === 'solution-development') {
    plan.push(['saga3_development_integration_observations', `process_run_id=${prId}`]);
    plan.push(['saga3_development_task_projections', `process_run_id=${prId}`]);
    plan.push(['saga3_development_outputs', `process_run_id=${prId}`]);
  }
  if (moduleName === 'delivery-release') {
    plan.push(['saga3_delivery_approval_decisions', `request_id IN (SELECT id FROM saga3_delivery_approval_requests WHERE process_run_id=${prId})`]);
    plan.push(['saga3_delivery_approval_requests', `process_run_id=${prId}`]);
    plan.push(['saga3_delivery_outputs', `process_run_id=${prId}`]);
  }

  // 2. recovery + node_runs
  plan.push(['saga3_recovery_attempts', `recovery_case_id IN (SELECT id FROM saga3_recovery_cases WHERE process_run_id=${prId})`]);
  plan.push(['saga3_recovery_cases', `process_run_id=${prId}`]);

  // 3. immutable tables (safe after triggers are dropped)
  plan.push(['saga3_managed_node_submissions', `process_run_id=${prId}`]);
  // acceptance rows are keyed by process_run_id — only those that THIS run
  // produced. Formalization heritage for OTHER process_runs is untouched.
  plan.push(['saga3_exact_candidate_acceptance_items', `decision_id IN (SELECT id FROM saga3_exact_candidate_acceptance_decisions WHERE process_run_id=${prId})`]);
  plan.push(['saga3_exact_candidate_acceptance_decisions', `process_run_id=${prId}`]);

  // 4. outcome certificate (Scenario B safety: if a certificate exists, this
  //    stage's settlement already happened. We still delete it under
  //    Scenario D because we are recreating the whole ProcessRun.
  plan.push(['saga3_process_outcome_certificates', `process_run_id=${prId}`]);

  // 5. managed productions — CASCADE would handle these on process_run delete,
  //    but we delete them explicitly so reporting is accurate.
  plan.push(['saga3_managed_artifact_productions', `process_run_id=${prId}`]);
  plan.push(['saga3_managed_trace_productions', `process_run_id=${prId}`]);
  plan.push(['saga3_process_products', `process_run_id=${prId}`]);

  // 6. node_runs
  plan.push(['saga3_node_runs', `process_run_id=${prId}`]);

  return plan;
}

const plan = buildPlan();

// Tasks linked to this process_run (via metadata.process_run_id OR
// generation_key). Both are written by development/formalization runtimes.
const taskWhere = prId !== null
  ? `(json_extract(metadata,'$.process_run_id')=${prId} OR generation_key LIKE 'process-run:${prId}:%')`
  : null;
const taskIds = prId !== null
  ? db.prepare(`SELECT id FROM tasks WHERE ${taskWhere}`).all().map(r => r.id)
  : [];

// work_intents whose projected_task_id is one of the tasks we are deleting.
const workIntentIds = taskIds.length > 0
  ? db.prepare(`SELECT id FROM saga3_work_intents WHERE projected_task_id IN (${taskIds.join(',')})`).all().map(r => r.id)
  : [];

// artifacts produced by this process_run (CASCADE-safe, but we report + delete
// their traces too).
const artifactIds = prId !== null
  ? db.prepare(`SELECT DISTINCT artifact_id FROM saga3_managed_artifact_productions WHERE process_run_id=${prId}`).all().map(r => r.artifact_id)
  : [];

// command_receipts for the tasks (no direct process_run link; key off task_id).
const commandReceiptCount = taskIds.length > 0
  ? db.prepare(`SELECT COUNT(*) n FROM command_receipts WHERE task_id IN (${taskIds.join(',')})`).get().n
  : 0;

// worker_executions for the tasks (so the dispatcher can re-schedule).
const workerExecutionCount = taskIds.length > 0
  ? db.prepare(`SELECT COUNT(*) n FROM worker_executions WHERE task_id IN (${taskIds.join(',')})`).get().n
  : 0;

// process_transitions touching this stage_run (rewind mode deletes them).
const transitionsFromStage = stageRun
  ? db.prepare(`SELECT COUNT(*) n FROM saga3_process_transitions WHERE from_stage_run_id=${stageRun.id}`).get().n
  : 0;
const transitionsToStage = stageRun
  ? db.prepare(`SELECT COUNT(*) n FROM saga3_process_transitions WHERE to_stage_run_id=${stageRun.id}`).get().n
  : 0;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('=== ROWS TO DELETE ===');
let any = false;
for (const [table, where] of plan) {
  let n = 0;
  try {
    n = db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get().n;
  } catch (e) {
    if (!String(e.message).includes('no such table')) {
      console.log(`  ${table}: (count failed: ${e.message})`);
      any = true;
    }
    continue;
  }
  if (n > 0) {
    console.log(`  ${table}: ${n}`);
    any = true;
  }
}
if (prId !== null) {
  const prCount = db.prepare('SELECT COUNT(*) n FROM saga3_process_runs WHERE id=?').get(prId).n;
  if (prCount > 0) { console.log(`  saga3_process_runs: ${prCount} (id=${prId})`); any = true; }
}
if (taskIds.length > 0) { console.log(`  tasks: ${taskIds.length} (ids: ${taskIds.join(',')})`); any = true; }
if (commandReceiptCount > 0) { console.log(`  command_receipts: ${commandReceiptCount}`); any = true; }
if (workerExecutionCount > 0) { console.log(`  worker_executions: ${workerExecutionCount}`); any = true; }
if (workIntentIds.length > 0) { console.log(`  saga3_work_intents: ${workIntentIds.length}`); any = true; }
if (artifactIds.length > 0) {
  console.log(`  artifacts (this run only): ${artifactIds.length} (ids: ${artifactIds.join(',')})`);
  console.log(`  artifact_traces (for those artifacts)`);
  any = true;
}
if (rewindTo && stageRun) {
  if (transitionsFromStage > 0) { console.log(`  saga3_process_transitions (from stage_run): ${transitionsFromStage}`); any = true; }
  if (transitionsToStage > 0) { console.log(`  saga3_process_transitions (to stage_run): ${transitionsToStage}`); any = true; }
  console.log(`  saga3_stage_runs: 1 (id=${stageRun.id})`);
  any = true;
}
if (!any) console.log('  (nothing matched)');
console.log('');

console.log('=== LIFECYCLE STATE UPDATE ===');
console.log(`  lifecycle_run #${lifecycleRun.id}:`);
console.log(`    status: '${lifecycleRun.status}' -> 'paused'`);
console.log(`    execution_lease_owner: -> NULL`);
console.log(`    execution_lease_expires_at: -> NULL`);
if (!rewindTo) {
  // Scenario D: keep current_stage_id and current_stage_run_id on this stage.
  console.log(`    current_stage_id: '${lifecycleRun.current_stage_id}' (unchanged)`);
  console.log(`    current_stage_run_id: ${lifecycleRun.current_stage_run_id} (unchanged — stage_run preserved)`);
  if (stageRun) {
    console.log(`  stage_run #${stageRun.id}:`);
    console.log(`    status: '${stageRun.status}' -> 'created'`);
    console.log(`    process_run_id: ${stageRun.process_run_id} -> NULL`);
    console.log(`    (binding_snapshot, input_snapshot, input_hash KEPT — orchestrator replays stage_run)`);
  }
} else {
  // Scenario A: rewind current_stage_id back to the prior completed stage.
  console.log(`    current_stage_id: '${lifecycleRun.current_stage_id}' -> '${rewindTo}'`);
  console.log(`    current_stage_run_id: ${lifecycleRun.current_stage_run_id} -> ${rewindStageRun.id} (prior completed '${rewindTo}' stage_run)`);
  console.log(`  stage_run #${stageRun.id} will be DELETED (Scenario A)`);
}
console.log('');

// Heritage check — reassure the operator the rest of the lifecycle survives.
const preservedArtifacts = db.prepare('SELECT COUNT(*) n FROM artifacts').get().n - artifactIds.length;
const preservedAcceptance = db.prepare(
  prId !== null
    ? 'SELECT COUNT(*) n FROM saga3_exact_candidate_acceptance_items WHERE decision_id NOT IN (SELECT id FROM saga3_exact_candidate_acceptance_decisions WHERE process_run_id=?)'
    : 'SELECT COUNT(*) n FROM saga3_exact_candidate_acceptance_items',
).get(...(prId !== null ? [prId] : [])).n;
console.log('=== PRESERVED (other stages untouched) ===');
console.log(`  artifacts: ${preservedArtifacts}`);
console.log(`  acceptance items: ${preservedAcceptance}`);
console.log(`  saga3_module_installations: untouched (other stages pin to them)`);
console.log('');

if (dryRun) {
  console.log('DRY RUN — no changes made. Re-run without --dry-run to execute.');
  db.close();
  process.exit(0);
}

if (!confirm) {
  console.error('Refusing to execute without --confirm (or --yes). Add --dry-run to preview only.');
  db.close();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const tx = db.transaction(() => {
  // 0. Drop immutable ABORT triggers (they will be recreated on next startup).
  for (const trigger of immutableTriggers) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
  }

  let totalDeleted = 0;
  const logDel = (label, info) => {
    if (info.changes > 0) {
      console.log(`  deleted ${label}: ${info.changes}`);
      totalDeleted += info.changes;
    }
  };

  // 1. stage-specific + recovery + immutable + managed productions + node_runs
  for (const [table, where] of plan) {
    try {
      logDel(table, db.prepare(`DELETE FROM ${table} WHERE ${where}`).run());
    } catch (e) {
      if (!String(e.message).includes('no such table')) {
        console.log(`  SKIP ${table}: ${e.message}`);
      }
    }
  }

  // 2. command_receipts for the tasks (must precede tasks deletion if a FK
  //    exists; with FKs off it is informational, but order is still safe).
  if (commandReceiptCount > 0) {
    try {
      db.prepare(
        `DELETE FROM lifecycle_events
          WHERE command_id IN (
            SELECT command_id FROM command_receipts
             WHERE task_id IN (${taskIds.join(',')})
          )`,
      ).run();
      logDel('command_receipts', db.prepare(`DELETE FROM command_receipts WHERE task_id IN (${taskIds.join(',')})`).run());
    } catch (e) { console.log(`  SKIP command_receipts: ${e.message}`); }
  }

  // 3. worker_executions for the tasks (lets dispatcher re-schedule).
  if (workerExecutionCount > 0) {
    try {
      db.prepare(
        `DELETE FROM work_attempts
          WHERE execution_id IN (
            SELECT execution_id FROM worker_executions
             WHERE task_id IN (${taskIds.join(',')})
          )`,
      ).run();
      logDel('worker_executions', db.prepare(`DELETE FROM worker_executions WHERE task_id IN (${taskIds.join(',')})`).run());
    } catch (e) { console.log(`  SKIP worker_executions: ${e.message}`); }
  }

  // 4. work_intents whose task we are deleting.
  if (workIntentIds.length > 0) {
    try {
      logDel('saga3_work_intents', db.prepare(`DELETE FROM saga3_work_intents WHERE id IN (${workIntentIds.join(',')})`).run());
    } catch (e) { console.log(`  SKIP saga3_work_intents: ${e.message}`); }
  }

  // 5. tasks
  if (taskIds.length > 0) {
    try {
      db.prepare(
        `DELETE FROM work_attempts
          WHERE work_item_id IN (
            SELECT work_item_id FROM task_work_items
             WHERE task_id IN (${taskIds.join(',')})
          )`,
      ).run();
      for (const [table, predicate] of [
        ['task_work_items', `task_id IN (${taskIds.join(',')})`],
        ['task_dependencies', `task_id IN (${taskIds.join(',')}) OR depends_on_task_id IN (${taskIds.join(',')})`],
        ['subtasks', `task_id IN (${taskIds.join(',')})`],
        ['comments', `task_id IN (${taskIds.join(',')})`],
        ['notes', `task_id IN (${taskIds.join(',')})`],
        ['task_conflict_keys', `task_id IN (${taskIds.join(',')})`],
        ['verification_evidence', `task_id IN (${taskIds.join(',')})`],
        ['human_requests', `task_id IN (${taskIds.join(',')})`],
        ['integration_intents', `task_id IN (${taskIds.join(',')})`],
        ['runtime_observations', `task_id IN (${taskIds.join(',')})`],
      ]) {
        try {
          db.prepare(`DELETE FROM ${table} WHERE ${predicate}`).run();
        } catch (error) {
          if (!String(error.message).includes('no such table')) throw error;
        }
      }
      logDel('tasks', db.prepare(`DELETE FROM tasks WHERE id IN (${taskIds.join(',')})`).run());
    } catch (e) { console.log(`  SKIP tasks: ${e.message}`); }
  }

  // 6. artifacts produced by this run + their traces.
  if (artifactIds.length > 0) {
    try {
      db.prepare(`DELETE FROM traces WHERE source_id IN (${artifactIds.join(',')}) OR target_id IN (${artifactIds.join(',')})`).run();
    } catch { /* table may be named artifact_traces on older schemas */ }
    try {
      db.prepare(`DELETE FROM artifact_traces WHERE source_id IN (${artifactIds.join(',')}) OR target_id IN (${artifactIds.join(',')})`).run();
    } catch {}
    try {
      logDel('artifacts', db.prepare(`DELETE FROM artifacts WHERE id IN (${artifactIds.join(',')})`).run());
    } catch (e) { console.log(`  SKIP artifacts: ${e.message}`); }
  }

  // 7. process_run itself (CASCADE would clean managed productions; we already
  //    deleted them explicitly above so the count is accurate).
  if (prId !== null) {
    try {
      logDel('saga3_process_runs', db.prepare(`DELETE FROM saga3_process_runs WHERE id=${prId}`).run());
    } catch (e) { console.log(`  SKIP saga3_process_runs: ${e.message}`); }
  }

  if (rewindTo && stageRun) {
    // Scenario A: delete transitions referencing this stage_run, then the
    // stage_run itself.
    try {
      const t1 = db.prepare(`DELETE FROM saga3_process_transitions WHERE from_stage_run_id=${stageRun.id} OR to_stage_run_id=${stageRun.id}`).run();
      logDel('saga3_process_transitions', t1);
    } catch (e) { console.log(`  SKIP saga3_process_transitions: ${e.message}`); }
    try {
      logDel('saga3_stage_runs', db.prepare(`DELETE FROM saga3_stage_runs WHERE id=${stageRun.id}`).run());
    } catch (e) { console.log(`  SKIP saga3_stage_runs: ${e.message}`); }
  } else if (stageRun) {
    // Scenario D: keep the stage_run. NULL out process_run_id and reset status
    // so ensureStageRun replays the row and bindProcessRun binds a fresh
    // ProcessRun. Keep binding_*/input_* — assertStageReplay re-checks them
    // against the current lifecycle definition on resume.
    db.prepare(
      `UPDATE saga3_stage_runs
          SET status='created',
              process_run_id=NULL,
              local_outcome=NULL,
              authority=NULL,
              output_schema=NULL, output_ref=NULL, output_hash=NULL,
              certificate_schema=NULL, certificate_ref=NULL, certificate_hash=NULL,
              mapped_output_snapshot=NULL, result_snapshot=NULL,
              error=NULL, completed_at=NULL,
              updated_at=datetime('now')
        WHERE id=${stageRun.id}`,
    ).run();
    console.log(`  reset stage_run #${stageRun.id} -> status='created', process_run_id=NULL`);
  }

  // 8. lifecycle_run cursor + lease reset.
  if (rewindTo) {
    db.prepare(
      `UPDATE saga3_lifecycle_runs
          SET status='paused',
              current_stage_id=?,
              current_stage_run_id=?,
              terminal_status=NULL, error=NULL,
              execution_lease_owner=NULL, execution_lease_expires_at=NULL,
              version=version+1, updated_at=datetime('now')
        WHERE id=${lifecycleRun.id}`,
    ).run(rewindTo, rewindStageRun.id);
    console.log(`  reset lifecycle_run #${lifecycleRun.id} -> paused, current_stage_id='${rewindTo}', current_stage_run_id=${rewindStageRun.id}`);
  } else if (stageRun) {
    // Scenario D: stay on the same stage. current_stage_run_id MUST keep
    // pointing at the preserved stage_run, or readCurrentStageRun() returns
    // null and the orchestrator recomputes stageInput from scratch (which is
    // fine functionally, but keeping the cursor is cleaner and matches what
    // ensureStageRun expects: current_stage_run_id != null -> replay path).
    db.prepare(
      `UPDATE saga3_lifecycle_runs
          SET status='paused',
              terminal_status=NULL, error=NULL,
              execution_lease_owner=NULL, execution_lease_expires_at=NULL,
              version=version+1, updated_at=datetime('now')
        WHERE id=${lifecycleRun.id}`,
    ).run();
    console.log(`  reset lifecycle_run #${lifecycleRun.id} -> paused, current_stage_id='${lifecycleRun.current_stage_id}' (unchanged), current_stage_run_id=${stageRun.id} (preserved)`);
  } else {
    // Orphan process_run mode: still clear the lease so the operator can
    // intervene, but do not move the cursor.
    db.prepare(
      `UPDATE saga3_lifecycle_runs
          SET execution_lease_owner=NULL, execution_lease_expires_at=NULL,
              version=version+1, updated_at=datetime('now')
        WHERE id=${lifecycleRun.id}`,
    ).run();
    console.log(`  reset lifecycle_run #${lifecycleRun.id} -> lease cleared (cursor untouched)`);
  }

  for (const trigger of immutableTriggers) {
    if (typeof trigger.sql === 'string' && trigger.sql.trim()) {
      db.exec(trigger.sql);
    }
  }
  const newViolations = db.pragma('foreign_key_check').filter(row =>
    !initialForeignKeyViolations.has(
      `${row.table}:${row.rowid}:${row.parent}:${row.fkid}`,
    ));
  if (newViolations.length > 0) {
    throw new Error(
      `PARTIAL_RESET_FOREIGN_KEY_VIOLATION: ${JSON.stringify(newViolations)}`,
    );
  }

  console.log(`\nTotal rows deleted: ${totalDeleted}`);
});

try {
  tx();
} catch (e) {
  console.error(`\nTransaction failed (rolled back): ${e.message}`);
  db.close();
  process.exit(1);
}

db.pragma('foreign_keys = ON');
db.close();

// ---------------------------------------------------------------------------
// Post-run resume instructions
// ---------------------------------------------------------------------------

console.log('\n=== PARTIAL RESET COMPLETE ===');
if (rewindTo) {
  console.log(`Stage '${resolvedStageId}' fully removed; lifecycle rewound to '${rewindTo}'.`);
} else {
  console.log(`Stage '${resolvedStageId}' ProcessRun cleared; stage_run preserved.`);
}
console.log('Other stages, artifacts and acceptance heritage untouched.');
console.log('');
console.log('Resume the lifecycle with:');
console.log(`  SAGA_ORCHESTRATION_MODE=saga3-lifecycle \\`);
console.log(`  SAGA_PRODUCT_LIFECYCLE_COMPOSITION=./<composition>.mjs \\`);
console.log(`  SAGA_PRODUCT_LIFECYCLE_INPUT=./<input>.json \\`);
console.log(`  node dist/orchestrate-cli.js ${lifecycleRun.project_id} ${lifecycleRun.epic_id ?? epic} \\`);
console.log(`    --resume --idempotency-key=product-delivery:epic:${lifecycleRun.epic_id ?? epic}`);
console.log('');
console.log('Notes:');
console.log('  - status is now "paused"; --resume (resumePaused) flips it to "running"');
console.log('    and acquires a fresh lease.');
if (!rewindTo) {
  console.log('  - ensureStageRun() will REPLAY the preserved stage_run (binding_hash +');
  console.log('    input_hash must still match the current lifecycle definition). If you');
  console.log('    changed the lifecycle definition or the prior stage\'s mapped_output,');
  console.log('    re-run with --rewind-to instead.');
}
console.log('  - If you also changed lifecycle code, definition_hash may mismatch on');
console.log('    replay — see PARTIAL-RESET-AND-RESUME.md §2.1 / §5.2.');
