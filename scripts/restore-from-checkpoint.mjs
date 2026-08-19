#!/usr/bin/env node
/**
 * Restore factory from a golden checkpoint — skip completed stages.
 *
 * Usage:
 *   node scripts/restore-from-checkpoint.mjs <golden-db> <target-db> [--reset-stage <stage>] [--fix-stuck]
 *
 * Examples:
 *   # Restore everything as-is (fix stuck state only):
 *   node scripts/restore-from-checkpoint.mjs tests/golden-runs/.../golden.sqlite .factory-sandboxes/dev-run/factory.sqlite
 *
 *   # Restore but reset Development stage (re-run all impl work items from scratch):
 *   node scripts/restore-from-checkpoint.mjs tests/golden-runs/.../golden.sqlite .factory-sandboxes/dev-run/factory.sqlite --reset-stage solution-development
 *
 *   # Restore but keep completed impl items, only reset stuck ones:
 *   node scripts/restore-from-checkpoint.mjs tests/golden-runs/.../golden.sqlite .factory-sandboxes/dev-run/factory.sqlite --fix-stuck
 *
 * What this does:
 *   1. Copies golden DB → target (checkpointed, no WAL)
 *   2. Resets lifecycle to 'paused' (from failed/stuck)
 *   3. Clears stale launches + leases
 *   4. Optionally resets a specific stage so `factory.mjs resume` re-runs that
 *      stage's Production Cell from scratch (fresh attempts, attempt counter 0)
 *      while preserving other stages' accepted material and artifacts.
 *   5. Prints summary of what will run when you `factory.mjs resume`
 *
 * `--reset-stage <module-name>` — UNIVERSAL, keyed by
 * `factory_process_runs.module_name` (e.g. `solution-development`,
 * `solution-formalization`, `product-discovery`). No workshop/cell names or
 * language knowledge are hardcoded. See `resetStage()` for the full FK/trigger
 * dependency map and the rationale for each deletion.
 *
 * After restore, run:
 *   node scripts/factory.mjs resume <target-db>
 */
import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Replay-capsule schema ensure (creates the tables on pre-capsule golden DBs
// and migrates the invalidations CHECK to the 'stage-reset' reason — R-D4).
import { ensureReplayCapsuleSchema } from '../dist/infrastructure/replay/sqlite-replay-capsule-repository.js';

// ──────────────────────────────────────────────────────────────────────────
// Stage reset helpers
//
// WHY THIS EXISTS — `attemptCount()` in
// src/process-modules/application/node-executors/production-cell-node-executor.ts
// counts SEALED CandidateSets by role (`candidateSetRepo.listForWorkplace(ref)`
// filtered by role). The crashed-execution fallback only applies while a
// workplace is in `repair_wait`. So to give a stage FRESH attempts (counter 0),
// the reset MUST delete the stage's sealed CandidateSets — merely deleting
// worker_executions does NOT reset the counter.
//
// Deleting CandidateSets is blocked (FK ON DELETE RESTRICT + BEFORE DELETE
// RAISE(ABORT) immutability triggers) by the tables that reference them:
//   factory_cell_effect_receipts.candidate_set_ref        (RESTRICT + trigger)
//   factory_cell_final_acceptances.candidate_set_ref      (RESTRICT + trigger)
//   factory_candidate_set_members.candidate_set_ref       (FK, child)
//   factory_production_adoption_decisions.{author,reviewer}_candidate_set_ref (RESTRICT + trigger)
//   factory_author_candidate_carry_forward_authorizations.source_candidate_set_ref (RESTRICT)
//   factory_authorized_verification_observations.target_candidate_set_ref   (RESTRICT)
// and final_acceptances/effect_receipts additionally RESTRICT-reference
// factory_gate_decisions.decision_key, so gate_decisions must be deleted AFTER
// them. CandidateSets FK factory_workplace_production_revisions, so revisions
// must be deleted AFTER CandidateSets.
//
// STRATEGY — delete in FK-safe child-first order. Where a BEFORE DELETE trigger
// forbids deletion on an immutable audit table, we DROP the trigger, DELETE,
// then recreate the trigger from its ORIGINAL definition read out of
// sqlite_master (so the script never hardcodes trigger bodies and stays in
// lock-step with schema.ts). The whole reset runs in ONE transaction; if any
// step fails the target DB is left untouched and the operator can retry.
//
// `factory_managed_node_submissions` is deliberately NOT touched: it is an
// immutable audit ledger with FK execution_id/task_id ON DELETE RESTRICT and a
// BEFORE DELETE RAISE(ABORT) trigger. In practice every dev worker_execution
// has a managed submission, so those executions are KEPT as audit (they do not
// affect the attempt counter once the workplace leaves repair_wait). Only
// executions with no managed submission / no recovery receipt are deleted.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Names of BEFORE DELETE immutability triggers that must be dropped to allow
 * the reset DELETEs, then recreated from their sqlite_master definition.
 *
 * S-4/S-5 (stage-11 preventive hunt): the list is now the EXACT set of
 * triggers guarding the tables resetStage deletes — the old list carried the
 * stale `trg_factory_adoptions_no_delete` (factory_adoptions is never deleted)
 * and MISSED the real guards, so the "defended" delete paths aborted with
 * RAISE(ABORT) on any DB that actually had those rows.
 */
const IMMUTABILITY_TRIGGERS = [
  'trg_factory_cell_effect_receipts_no_delete',
  'trg_factory_cell_effect_repair_issues_no_delete',
  'trg_factory_cell_final_acceptances_no_delete',
  'trg_factory_check_receipts_no_delete',
  'trg_factory_gate_decisions_no_delete',
  'trg_factory_workplace_contributions_no_delete',
  'trg_factory_workplace_production_revisions_no_delete',
  // production adoption + author carry-forward (A1 deletes)
  'trg_factory_production_adoption_immutable_delete',
  'trg_factory_author_carry_forward_immutable_delete',
  'trg_factory_author_carry_consumption_immutable_delete',
  // FK children of the sealed material (A0 deletes)
  'trg_factory_effect_attempts_no_delete',
  'trg_factory_gate_presentation_attempts_no_delete',
  // execution-scoped audit children (D-pre deletes)
  'trg_final_presentation_commitments_no_delete',
  'trg_factory_execution_completion_products_immutable_delete',
];

/** Read trigger definitions from sqlite_master, DROP them, return saved SQL. */
function dropImmutabilityTriggers(db) {
  const saved = new Map();
  for (const name of IMMUTABILITY_TRIGGERS) {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
    ).get(name);
    if (row?.sql) saved.set(name, row.sql);
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
  }
  return saved;
}

/** Recreate triggers from the saved sqlite_master definitions. */
function recreateImmutabilityTriggers(db, saved) {
  for (const sql of saved.values()) {
    db.exec(sql);
  }
}

/** Count+delete helper that reports how many rows a DELETE removed. */
function deleteRange(db, label, sql, params = []) {
  const info = db.prepare(sql).run(...params);
  if (info.changes > 0) {
    process.stdout.write(`[reset-stage]   deleted ${info.changes} from ${label}\n`);
  }
  return info.changes;
}

/** Count+update helper that reports how many rows an UPDATE changed. */
function updateRange(db, label, sql, params = []) {
  const info = db.prepare(sql).run(...params);
  if (info.changes > 0) {
    process.stdout.write(`[reset-stage]   updated ${info.changes} ${label}\n`);
  }
  return info.changes;
}

/**
 * S-3 — fail loudly if the reset (or any restore step) orphaned a child row.
 * `PRAGMA foreign_key_check` walks every FK in the schema even with
 * foreign_keys enforcement on, so a clean result is a POSITIVE proof.
 */
function assertForeignKeyCheckClean(db, scopeLabel) {
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    const detail = violations
      .slice(0, 10)
      .map(v => `${v.table}[rowid=${v.rowid}] -> ${v.parent} (fkid=${v.fkid})`)
      .join('; ');
    throw new Error(
      `[reset-stage] foreign_key_check FAILED after ${scopeLabel}: `
      + `${violations.length} violation(s): ${detail}`,
    );
  }
}

/**
 * Reset one stage/module so `factory.mjs resume` re-runs its Production Cell
 * from scratch (attempt counter 0), preserving other stages and `artifacts`.
 *
 * Scoped UNIVERSALLY by `factory_process_runs.module_name = stage` — never by
 * workshop/cell name or language.
 */
function resetStageRun(db, stage) {
  // Resolve the stage's ProcessRun ids. Prefer exact module_name match; fall
  // back to a tolerant substring match so `--reset-stage development` also
  // resolves to `solution-development`.
  let runs = db.prepare(
    'SELECT id, module_name FROM factory_process_runs WHERE module_name = ?',
  ).all(stage);
  if (runs.length === 0) {
    runs = db.prepare(
      `SELECT id, module_name FROM factory_process_runs
       WHERE module_name LIKE ? ESCAPE '\\' OR ? LIKE '%' || module_name || '%'`,
    ).all(`%${stage}%`, stage);
  }
  if (runs.length === 0) {
    throw new Error(
      `[reset-stage] no factory_process_runs found for module_name='${stage}'. `
      + `Known modules: `
      + db.prepare('SELECT GROUP_CONCAT(DISTINCT module_name) AS m FROM factory_process_runs').get().m,
    );
  }
  const runIds = runs.map(r => r.id);
  const runIdList = runIds.join(',');
  process.stdout.write(
    `[reset-stage] resetting ${runs.map(r => `${r.module_name}#${r.id}`).join(', ')}\n`,
  );

  // S-3 — FK enforcement is EXPLICIT for the reset (never rely on a library
  // default), and the replay-capsule schema must exist before the reset
  // writes invalidation evidence (R-D4; also migrates old golden DBs to the
  // 'stage-reset' reason CHECK).
  db.pragma('foreign_keys = ON');
  ensureReplayCapsuleSchema(db);

  // Workplace + CandidateSet scope for this stage (read-only, before any mutation).
  const wpSubsql = `SELECT workplace_ref FROM factory_workplaces WHERE process_run_id IN (${runIdList})`;
  const csetSubsql = `SELECT candidate_set_ref FROM factory_candidate_sets WHERE workplace_ref IN (${wpSubsql})`;
  const workplaces = db.prepare(`SELECT workplace_ref FROM (${wpSubsql})`).all();
  if (workplaces.length === 0) {
    process.stdout.write('[reset-stage] no workplaces for stage — nothing to reset\n');
    return;
  }

  // Resolve the stage's tasks (reset targets + execution scope) without
  // hardcoding workflow_stage values. A task belongs to the stage if it is
  // pinned to one of the stage's workplaces (graph_items), was submitted under
  // the stage's process run (managed_node_submissions), or carries the
  // process_run_id in its metadata.
  const taskSubsql = `
    SELECT DISTINCT task_id FROM factory_workplace_graph_items WHERE workplace_ref IN (${wpSubsql})
    UNION
    SELECT DISTINCT task_id FROM factory_managed_node_submissions WHERE process_run_id IN (${runIdList})
    UNION
    SELECT DISTINCT rowid AS task_id FROM tasks
      WHERE json_valid(metadata) AND CAST(json_extract(metadata,'$.process_run_id') AS INTEGER) IN (${runIdList})`;

  const reset = () => {
    // ── 0. ProcessRun + StageRun bookkeeping: paused, clear recovery/issue
    //       pointers and execution leases so resume starts the stage cleanly. ──
    updateRange(
      db, 'factory_process_runs',
      `UPDATE factory_process_runs
          SET status='paused', local_outcome=NULL, authority=NULL,
              error=NULL, completed_at=NULL,
              active_recovery_case_id=NULL, active_issue_ref=NULL,
              active_issue_hash=NULL,
              execution_lease_owner=NULL, execution_lease_expires_at=NULL
        WHERE id IN (${runIdList})`,
    );
    updateRange(
      db, 'factory_stage_runs',
      `UPDATE factory_stage_runs SET status='paused', error=NULL, completed_at=NULL
        WHERE process_run_id IN (${runIdList})`,
    );

    // ── A. Delete sealed material (the attempt counter + accepted state) ──
    // FK-safe child-first order. Triggers were dropped before this txn body.
    process.stdout.write('[reset-stage] deleting sealed CandidateSet material:\n');

    // A0. S-3 — FK children of the immutable audit rows deleted below. On a
    //     real factory DB these rows EXIST (a repaired workplace has effect
    //     attempts, decided gates have presentation attempts and decision
    //     heads); leaving them behind either aborts the reset (FK enforcement)
    //     or orphans them. Child-first, stage-scoped:
    //       - gate presentation attempts FK gate_runs (deleted at A5)
    //       - decision heads FK gate_decisions — the "current repair authority"
    //       - effect attempts FK candidate_sets (deleted at A6)
    deleteRange(
      db, 'factory_gate_presentation_attempts',
      `DELETE FROM factory_gate_presentation_attempts
        WHERE gate_run_ref IN (SELECT gate_run_ref FROM factory_gate_runs WHERE workplace_ref IN (${wpSubsql}))`,
    );
    deleteRange(
      db, 'factory_workplace_gate_decision_heads',
      `DELETE FROM factory_workplace_gate_decision_heads WHERE workplace_ref IN (${wpSubsql})`,
    );
    deleteRange(
      db, 'factory_effect_attempts',
      `DELETE FROM factory_effect_attempts WHERE workplace_ref IN (${wpSubsql})`,
    );

    // A0.5 R-D4 — invalidate the replay capsules bound to this stage's sealed
    //      material BEFORE the source rows are deleted. The operator reset
    //      the stage to REGENERATE production: a surviving capsule would make
    //      the next claim in these workplaces REPLAY the exact material that
    //      was just destroyed. Capsules are evidence — they are KEPT and get
    //      an append-only typed invalidation row (reason 'stage-reset',
    //      idempotent on (capsule_ref, reason, authority_ref)).
    //      Scope: capsules whose source CandidateSet belongs to the stage,
    //      whose source execution is a reset-stage execution, or whose frozen
    //      replay-key material targets one of the stage's workplaces (the
    //      kernel carry-forward capsules whose target task lives here).
    const stageRunLabels = runs.map(r => `${r.module_name}#${r.id}`).join(',');
    const lifecycleRunId = db.prepare(
      `SELECT MIN(lifecycle_run_id) AS id FROM factory_stage_runs
        WHERE process_run_id IN (${runIdList})`,
    ).get().id;
    const invalidated = db.prepare(
      `INSERT OR IGNORE INTO factory_replay_capsule_invalidations
         (capsule_ref, reason, lifecycle_run_id, authority_ref)
       SELECT capsule_ref, 'stage-reset', ?, ?
         FROM factory_replay_capsules
        WHERE project_id IN (SELECT project_id FROM factory_process_runs WHERE id IN (${runIdList}))
          AND (source_candidate_set_ref IN (${csetSubsql})
               OR source_execution_ref IN (
                    SELECT execution_id FROM worker_executions
                     WHERE task_id IN (${taskSubsql}))
               OR EXISTS (
                    SELECT 1 FROM factory_workplaces w2
                     WHERE w2.process_run_id IN (${runIdList})
                       AND json_extract(payload_snapshot,'$.key.moduleRef')=w2.module_ref
                       AND json_extract(payload_snapshot,'$.key.productionCellId')=w2.production_cell_id
                       AND json_extract(payload_snapshot,'$.key.workKey')=w2.work_key))`,
    ).run(lifecycleRunId, `stage-reset:${stageRunLabels}`);
    if (invalidated.changes > 0) {
      process.stdout.write(
        `[reset-stage]   invalidated ${invalidated.changes} replay capsule(s) (reason 'stage-reset' — rows kept as evidence)\n`,
      );
    }

    // A1. Carry-forward / adoption tables that RESTRICT-reference CandidateSets
    //     (0 in the common reset case; defended for completeness). Consumptions
    //     FK authorizations, so delete consumptions first; both FK CandidateSets,
    //     so both go before A6. adoption_decisions also FK gate_runs/gate_decisions
    //     and has an immutability trigger (dropped above).
    deleteRange(
      db, 'factory_author_candidate_carry_forward_consumptions',
      `DELETE FROM factory_author_candidate_carry_forward_consumptions
        WHERE target_candidate_set_ref IN (${csetSubsql})`,
    );
    deleteRange(
      db, 'factory_author_candidate_carry_forward_authorizations',
      `DELETE FROM factory_author_candidate_carry_forward_authorizations
        WHERE source_candidate_set_ref IN (${csetSubsql})`,
    );
    deleteRange(
      db, 'factory_production_adoption_decisions',
      `DELETE FROM factory_production_adoption_decisions
        WHERE author_candidate_set_ref IN (${csetSubsql})
           OR reviewer_candidate_set_ref IN (${csetSubsql})`,
    );

    // A2. Effect receipts + final acceptances — they RESTRICT-reference both
    //     candidate_set_ref and gate_decision_key, so they go BEFORE both.
    deleteRange(
      db, 'factory_cell_effect_receipts',
      `DELETE FROM factory_cell_effect_receipts WHERE workplace_ref IN (${wpSubsql})`,
    );
    deleteRange(
      db, 'factory_cell_effect_repair_issues',
      `DELETE FROM factory_cell_effect_repair_issues WHERE workplace_ref IN (${wpSubsql})`,
    );
    deleteRange(
      db, 'factory_cell_final_acceptances',
      `DELETE FROM factory_cell_final_acceptances WHERE workplace_ref IN (${wpSubsql})`,
    );

    // A3. Accepted-authority head (current accepted-author pointer). No trigger;
    //     FK workplace ON DELETE RESTRICT (workplace is kept). Deleting it makes
    //     acceptedAuthorCandidate() return null → fresh author selection.
    deleteRange(
      db, 'factory_accepted_authority_head',
      `DELETE FROM factory_accepted_authority_head WHERE workplace_ref IN (${wpSubsql})`,
    );

    // A4. Check receipts (immutable; reference CandidateSets logically, no FK)
    //     and gate decisions (immutable; referenced by A2 via gate_decision_key).
    deleteRange(
      db, 'factory_check_receipts',
      `DELETE FROM factory_check_receipts WHERE subject_candidate_set_ref IN (${csetSubsql})`,
    );
    deleteRange(
      db, 'factory_gate_decisions',
      `DELETE FROM factory_gate_decisions WHERE workplace_ref IN (${wpSubsql})`,
    );

    // A5. Gate runs + reservations + durable transition obligations — stale
    //     per-workplace inspection/lease/handoff state for the reset stage.
    deleteRange(
      db, 'factory_gate_runs',
      `DELETE FROM factory_gate_runs WHERE workplace_ref IN (${wpSubsql})`,
    );
    deleteRange(
      db, 'factory_execution_reservations',
      `DELETE FROM factory_execution_reservations WHERE workplace_ref IN (${wpSubsql})`,
    );
    deleteRange(
      db, 'factory_transition_obligations',
      `DELETE FROM factory_transition_obligations WHERE subject_ref IN (${wpSubsql})`,
    );

    // A6. CandidateSet members (child) then CandidateSets themselves — THIS is
    //     the real attempt counter reset.
    deleteRange(
      db, 'factory_candidate_set_members',
      `DELETE FROM factory_candidate_set_members WHERE candidate_set_ref IN (${csetSubsql})`,
    );
    deleteRange(
      db, 'factory_candidate_sets',
      `DELETE FROM factory_candidate_sets WHERE workplace_ref IN (${wpSubsql})`,
    );

    // A7. Workplace material model (contributions + revisions). CandidateSets
    //     are gone, so nothing FK-references revisions now. Re-seal will
    //     re-create them naturally on the fresh run.
    deleteRange(
      db, 'factory_workplace_contributions',
      `DELETE FROM factory_workplace_contributions WHERE workplace_ref IN (${wpSubsql})`,
    );
    deleteRange(
      db, 'factory_workplace_production_revisions',
      `DELETE FROM factory_workplace_production_revisions WHERE workplace_ref IN (${wpSubsql})`,
    );

    // ── B. Reset workplaces to a fresh idle state (kept, not deleted) ──
    // revision=0 + loop_state=idle = a brand-new desk; the graph/audit tables
    // that RESTRICT-reference the workplace are preserved (or were stage-scoped
    // above), so the row stays.
    const wpReset = db.prepare(
      `UPDATE factory_workplaces
          SET loop_state='idle', kanban_phase='todo', next_role='author',
              revision=0, terminal_reason=NULL,
              active_reservation_ref=NULL, active_gate_ref=NULL,
              active_recovery_case_ref=NULL, desk_ref=NULL
        WHERE process_run_id IN (${runIdList})`,
    ).run();
    process.stdout.write(`[reset-stage]   reset ${wpReset.changes} workplaces to idle\n`);

    // ── C. Tasks: reset status (KEEP rows — managed_node_submissions FK) ──
    const taskReset = db.prepare(
      `UPDATE tasks
          SET status='todo', current_execution_id=NULL, assigned_to=NULL
        WHERE rowid IN (${taskSubsql})`,
    ).run();
    process.stdout.write(`[reset-stage]   reset ${taskReset.changes} tasks to todo\n`);

    // ── D. Worker executions: delete only those NOT pinned by an immutable
    //       audit row (managed_node_submissions / recovery receipts). The rest
    //       are KEPT as audit — they do not affect the attempt counter once
    //       the workplace is idle (the crash fallback applies only in repair_wait).
    //       D-pre (S-3): first clear the FK children OF THE DELETED EXECUTIONS
    //       (commitments/completion products are immutable — triggers were
    //       dropped; worker stops is plain). Scoped to the deleted set only:
    //       audit rows of KEPT (pinned) executions survive untouched.
    const deletedExecSubsql = `
      SELECT execution_id FROM worker_executions
       WHERE task_id IN (${taskSubsql})
         AND execution_id NOT IN (SELECT execution_id FROM factory_managed_node_submissions)
         AND execution_id NOT IN (SELECT execution_id FROM factory_orphaned_launch_recovery_receipts
                                    WHERE execution_id IS NOT NULL)
         AND execution_id NOT IN (SELECT execution_id FROM factory_automatic_spawn_recovery_receipts)`;
    deleteRange(
      db, 'factory_final_presentation_commitments (deleted executions only)',
      `DELETE FROM factory_final_presentation_commitments WHERE execution_id IN (${deletedExecSubsql})`,
    );
    deleteRange(
      db, 'factory_execution_completion_products (deleted executions only)',
      `DELETE FROM factory_execution_completion_products WHERE execution_id IN (${deletedExecSubsql})`,
    );
    deleteRange(
      db, 'factory_worker_stops (deleted executions only)',
      `DELETE FROM factory_worker_stops WHERE worker_execution_ref IN (${deletedExecSubsql})`,
    );
    deleteRange(
      db, 'worker_executions (unpinned only)',
      `DELETE FROM worker_executions WHERE execution_id IN (${deletedExecSubsql})`,
    );

    // ── D-post (S-6): re-baseline recovery epochs for the reset workplaces.
    //      The reset dropped the attempt counters (CandidateSets, gate
    //      decisions, repair issues) but the immutable epoch baselines still
    //      snapshot the OLD, higher counters — attempts-in-epoch (counter −
    //      baseline) would go negative and the ADR-075 budget math misfires.
    //      Epochs are append-only (no UPDATE/DELETE), so re-baselining
    //      APPENDS one new epoch row per affected (workplace, role) whose
    //      latest baseline exceeds the CURRENT post-reset counters — the same
    //      write path recordRecoveryEpoch uses. Idempotent: when the latest
    //      baseline already matches the counters, nothing is appended.
    const epochLatest = db.prepare(
      `SELECT e.workplace_ref AS wp, e.role AS role, e.epoch AS epoch,
              e.baseline_rejected_sets AS brs, e.baseline_terminal_executions AS bte,
              e.baseline_effect_repairs AS ber, e.max_attempts AS maxAttempts,
              e.total_attempts_cap AS totalCap
         FROM factory_workplace_recovery_epochs e
        WHERE e.workplace_ref IN (${wpSubsql})
          AND e.epoch = (SELECT MAX(e2.epoch) FROM factory_workplace_recovery_epochs e2
                          WHERE e2.workplace_ref = e.workplace_ref AND e2.role = e.role)`,
    ).all();
    const countTerminalExecutions = db.prepare(
      `SELECT COUNT(*) AS n
         FROM worker_executions we JOIN tasks t ON t.id = we.task_id
        WHERE (t.workplace_ref = ? OR json_extract(t.metadata, '$.workplace_ref') = ?)
          AND we.task_id IN (${taskSubsql})
          AND we.state IN ('lost','terminated','spawn_failed')
          AND we.voided_at IS NULL`,
    );
    const insertEpoch = db.prepare(
      `INSERT OR IGNORE INTO factory_workplace_recovery_epochs
         (workplace_ref, role, epoch,
          baseline_rejected_sets, baseline_terminal_executions, baseline_effect_repairs,
          exhausted_attempts, max_attempts, total_attempts_cap, last_diagnosis)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    );
    let rebaselined = 0;
    for (const row of epochLatest) {
      // Post-reset counters: rejected sets and effect repairs are 0 (the
      // decisions/sets/issues were deleted); terminal executions counted LIVE
      // over the workplace's surviving (pinned) executions.
      const terminalExecutions = countTerminalExecutions.get(row.wp, row.wp).n;
      if (row.brs <= 0 && row.bte <= terminalExecutions && row.ber <= 0) continue;
      insertEpoch.run(
        row.wp, row.role, row.epoch + 1,
        0, terminalExecutions, 0,
        row.maxAttempts, row.totalCap,
        'stage-reset re-baseline (restore-from-checkpoint --reset-stage): '
          + 'attempt counters were reset; baseline snapshots the post-reset counters',
      );
      rebaselined += 1;
    }
    if (rebaselined > 0) {
      process.stdout.write(
        `[reset-stage]   appended ${rebaselined} recovery-epoch re-baseline row(s) — attempts-in-epoch stays non-negative\n`,
      );
    }

    // ── E. Node runs: delete so resume re-executes the stage flow from its
    //       entry node. Without this, the generic-flow executor resumes at the
    //       last completed node_run (e.g. a paused verifier) and never re-enters
    //       this stage's Production Cell. node_runs CASCADE from process_runs,
    //       have no RESTRICT children and no immutability triggers, so deleting
    //       them is safe; the stage's idempotent planning/graph seal replays on
    //       re-entry. The process_run + stage_run rows are preserved (paused).
    deleteRange(
      db, 'factory_node_runs',
      `DELETE FROM factory_node_runs WHERE process_run_id IN (${runIdList})`,
    );
  };

  // Drop immutability triggers, perform every DELETE/UPDATE, and recreate the
  // triggers — all inside ONE transaction. Atomicity guarantees that on any
  // failure (FK violation, etc.) the DB is unchanged AND the triggers are still
  // present (rollback undoes the DROPs). On commit the triggers are back via
  // the in-txn recreate.
  db.transaction(() => {
    const savedTriggers = dropImmutabilityTriggers(db);
    reset();
    recreateImmutabilityTriggers(db, savedTriggers);
  })();
  // S-3 — positive proof: even with FK enforcement on, foreign_key_check walks
  // every FK in the schema; any orphan (from this reset or pre-existing in
  // the golden checkpoint) fails the restore loudly instead of poisoning
  // later reconciliation.
  assertForeignKeyCheckClean(db, `reset-stage '${stage}'`);
  process.stdout.write(`[reset-stage] done: stage '${stage}' ready to resume from scratch\n`);
}

export { resetStageRun };

function main() {
const args = process.argv.slice(2);
if (args.length < 2) {
  process.stderr.write(
    'Usage: node scripts/restore-from-checkpoint.mjs <golden-db> <target-db> [--reset-stage <stage>] [--fix-stuck]\n'
  );
  process.exit(2);
}

const goldenDb = resolve(args[0]);
const targetDb = resolve(args[1]);
const resetStage = args.includes('--reset-stage')
  ? args[args.indexOf('--reset-stage') + 1]
  : null;
const fixStuck = args.includes('--fix-stuck');

// ─── 1. Copy golden DB ─────────────────────────────────────────────────
mkdirSync(dirname(targetDb), { recursive: true });
copyFileSync(goldenDb, targetDb);

// Checkpoint WAL in the copy. S-3: FK enforcement is EXPLICIT for the whole
// script — never rely on a library default — and the final foreign_key_check
// below fails loudly instead of leaving orphans behind.
const db = new Database(targetDb);
db.pragma('foreign_keys = ON');
db.pragma('wal_checkpoint(TRUNCATE)');

// ─── 2. Reset lifecycle + ProcessRuns ──────────────────────────────────
const stages = db.prepare('SELECT id, module_name, status FROM factory_process_runs ORDER BY id').all();

// Clear failure markers on the CURRENT lifecycle run only. A project/epic may
// own many historical lifecycle runs (one per Factory Start); the partial UNIQUE
// index idx_factory_lifecycle_runs_active_scope allows at most ONE active
// (created/running/paused) run per (project, epic, lifecycle_name). Resetting
// ALL rows to 'paused' would violate it, so we reset only the latest run per
// scope (the one resume continues) and leave prior terminal runs as history.
db.prepare(`
  UPDATE factory_lifecycle_runs
  SET status='paused', terminal_status=NULL, error=NULL, completed_at=NULL
  WHERE id IN (
    SELECT MAX(id) FROM factory_lifecycle_runs
    GROUP BY project_id, COALESCE(epic_id, -1), lifecycle_name
  )
`).run();

// Reset any 'failed' ProcessRun to 'paused' (lifecycle will re-evaluate)
db.prepare("UPDATE factory_process_runs SET status='paused' WHERE status='failed'").run();

// Reset the target stage's ProcessRun to 'paused'
if (resetStage) {
  const pr = stages.find(s => s.module_name === resetStage);
  if (pr) {
    db.prepare('UPDATE factory_process_runs SET status=? WHERE id=?').run('paused', pr.id);
    process.stdout.write(`[restore] Reset ProcessRun ${pr.id} (${pr.module_name}) to 'paused'\n`);
  }
}

// ─── 3. Clear stale launches + leases ──────────────────────────────────
db.prepare("UPDATE factory_launch_requests SET state='failed' WHERE state='running'").run();
db.prepare('DELETE FROM factory_launch_controller_leases').run();

// ─── 4. Optional: reset stage workplaces/tasks ─────────────────────────
if (resetStage) {
  resetStageRun(db, resetStage);
}

if (fixStuck) {
  // Only fix non-terminal workplaces (don't touch completed work)
  const stuck = db.prepare(`
    SELECT workplace_ref, loop_state FROM factory_workplaces
    WHERE loop_state NOT IN ('terminal', 'idle')
  `).all();

  for (const wp of stuck) {
    db.prepare('UPDATE factory_workplaces SET loop_state=? WHERE workplace_ref=?')
      .run('queued', wp.workplace_ref);
    process.stdout.write(`[restore] Fixed stuck workplace: ${wp.workplace_ref.slice(-12)} (${wp.loop_state} → queued)\n`);
  }
}

// ─── 5. FK hygiene proof, then summary ──────────────────────────────────
assertForeignKeyCheckClean(db, 'restore');

const summary = {
  lifecycle: db.prepare('SELECT status, current_stage_id FROM factory_lifecycle_runs ORDER BY id DESC LIMIT 1').get(),
  processRuns: db.prepare('SELECT module_name, status FROM factory_process_runs ORDER BY id').all(),
  tasks: {
    done: db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status='done'").get().n,
    total: db.prepare('SELECT COUNT(*) as n FROM tasks').get().n,
  },
  capsules: db.prepare('SELECT COUNT(*) as n FROM factory_replay_capsules').get().n,
  acceptances: db.prepare('SELECT COUNT(*) as n FROM factory_cell_final_acceptances').get().n,
  workplaces: {
    terminal: db.prepare("SELECT COUNT(*) as n FROM factory_workplaces WHERE loop_state='terminal'").get().n,
    nonTerminal: db.prepare("SELECT COUNT(*) as n FROM factory_workplaces WHERE loop_state!='terminal'").get().n,
  },
};

db.close();

process.stdout.write('\n=== RESTORE COMPLETE ===\n');
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(`\nNext: node scripts/factory.mjs resume ${targetDb}\n`);
}

// Run only when executed directly via `node scripts/restore-from-checkpoint.mjs`,
// not when imported (e.g. by the unit test in tests/restore-from-checkpoint-reset-stage.test.mjs).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
