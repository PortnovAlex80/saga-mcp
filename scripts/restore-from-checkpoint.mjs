#!/usr/bin/env node
/**
 * Restore factory from a golden checkpoint — skip completed stages.
 *
 * Usage:
 *   node scripts/restore-from-checkpoint.mjs <golden-db> <target-db> [--reset-stage <stage>]
 *
 * Examples:
 *   # Restore everything as-is (fix stuck state only):
 *   node scripts/restore-from-checkpoint.mjs tests/golden-runs/.../golden.sqlite .factory-sandboxes/dev-run/factory.sqlite
 *
 *   # Restore but reset Development stage (re-run all impl work items):
 *   node scripts/restore-from-checkpoint.mjs tests/golden-runs/.../golden.sqlite .factory-sandboxes/dev-run/factory.sqlite --reset-stage solution-development
 *
 *   # Restore but keep completed impl items, only reset stuck ones:
 *   node scripts/restore-from-checkpoint.mjs tests/golden-runs/.../golden.sqlite .factory-sandboxes/dev-run/factory.sqlite --fix-stuck
 *
 * What this does:
 *   1. Copies golden DB → target (checkpointed, no WAL)
 *   2. Resets lifecycle to 'paused' (from failed/stuck)
 *   3. Clears stale launches + leases
 *   4. Optionally resets a specific stage's workplaces/tasks
 *   5. Prints summary of what will run when you `factory.mjs resume`
 *
 * After restore, run:
 *   node scripts/factory.mjs resume <target-db>
 */
import Database from 'better-sqlite3';
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

// Checkpoint WAL in the copy
const db = new Database(targetDb);
db.pragma('wal_checkpoint(TRUNCATE)');

// ─── 2. Reset lifecycle + ProcessRuns ──────────────────────────────────
const stages = db.prepare('SELECT id, module_name, status FROM factory_process_runs ORDER BY id').all();

// Clear failure markers on lifecycle
db.prepare(`
  UPDATE factory_lifecycle_runs
  SET status='paused', terminal_status=NULL, error=NULL, completed_at=NULL
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
  // Reset all workplaces for this stage to 'idle'
  const wps = db.prepare(`
    SELECT workplace_ref, loop_state FROM factory_workplaces
    WHERE workplace_ref LIKE ?
  `).all(`%${resetStage}%`);

  for (const wp of wps) {
    if (wp.loop_state !== 'terminal') {
      db.prepare('UPDATE factory_workplaces SET loop_state=? WHERE workplace_ref=?')
        .run('idle', wp.workplace_ref);
    }
  }

  // Reset tasks for this stage (not done → todo)
  db.prepare(`
    UPDATE tasks SET status='todo', current_execution_id=NULL, assigned_to=NULL
    WHERE workflow_stage=? AND status != 'done'
  `).run(resetStage.includes('development') ? 'development' : resetStage);

  // Clear worker executions for this stage
  db.prepare(`
    DELETE FROM worker_executions
    WHERE task_id IN (
      SELECT rowid FROM tasks WHERE workflow_stage=?
    )
  `).run(resetStage.includes('development') ? 'development' : resetStage);

  process.stdout.write(`[restore] Reset ${wps.length} workplaces + tasks for ${resetStage}\n`);
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

// ─── 5. Summary ────────────────────────────────────────────────────────
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
