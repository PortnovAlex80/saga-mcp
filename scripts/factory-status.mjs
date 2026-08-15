#!/usr/bin/env node
/**
 * Read-only factory status report for operator monitoring.
 * Usage: node scripts/factory-status.mjs <db-path>
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node scripts/factory-status.mjs <db-path>');
  process.exit(2);
}
const db = new Database(resolve(dbPath), { readonly: true });

const has = (t) => db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?").get(t).n > 0;

// lifecycle
if (has('factory_lifecycle_runs')) {
  const lr = db.prepare('SELECT id, status, current_stage_id, terminal_status, updated_at FROM factory_lifecycle_runs ORDER BY id DESC LIMIT 1').get();
  if (lr) console.log(`lifecycle #${lr.id}: ${lr.status} stage=${lr.current_stage_id} terminal=${lr.terminal_status || '-'} updated=${lr.updated_at}`);
}
// process runs
if (has('factory_process_runs')) {
  for (const r of db.prepare('SELECT id, status, projected_stage, updated_at FROM factory_process_runs ORDER BY id DESC LIMIT 3').all()) {
    console.log(`run #${r.id}: ${r.status} stage=${r.projected_stage || '-'} updated=${r.updated_at}`);
  }
}
// workplaces
if (has('factory_workplaces')) {
  const rows = db.prepare('SELECT loop_state, COUNT(*) n FROM factory_workplaces GROUP BY loop_state ORDER BY n DESC').all();
  console.log('workplaces:', rows.map((r) => `${r.loop_state}=${r.n}`).join(' ') || '(none)');
}
// tasks
if (has('tasks')) {
  const total = db.prepare('SELECT COUNT(*) n FROM tasks').get().n;
  const done = db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='done'").get().n;
  console.log(`tasks: ${done}/${total} done`);
  for (const t of db.prepare("SELECT id, status, task_kind FROM tasks WHERE status IN ('in_progress','review_in_progress','blocked') ORDER BY id DESC LIMIT 6").all()) {
    console.log(`  > #${t.id} ${t.status} ${(t.task_kind || '').slice(0, 24)}`);
  }
}
// latest check receipts (errors/failures)
if (has('factory_check_receipts')) {
  const bad = db.prepare("SELECT provider_id, outcome, COUNT(*) n FROM factory_check_receipts WHERE outcome IN ('error','failed') GROUP BY provider_id, outcome ORDER BY n DESC LIMIT 6").all();
  if (bad.length) console.log('bad checks:', bad.map((b) => `${b.provider_id}:${b.outcome}=${b.n}`).join(' '));
  const last = db.prepare("SELECT provider_id, outcome, created_at FROM factory_check_receipts ORDER BY created_at DESC LIMIT 3").all();
  for (const c of last) console.log(`  receipt ${c.provider_id} -> ${c.outcome} @ ${c.created_at}`);
}
// artifacts
if (has('artifacts')) {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM artifacts GROUP BY status').all();
  console.log('artifacts:', rows.map((r) => `${r.status}=${r.n}`).join(' ') || '(none)');
}
// recent lifecycle events
if (has('lifecycle_events')) {
  for (const e of db.prepare('SELECT id, event_kind, occurred_at FROM lifecycle_events ORDER BY id DESC LIMIT 5').all()) {
    console.log(`  evt #${e.id} ${String(e.event_kind).slice(0, 60)} @ ${e.occurred_at}`);
  }
}
db.close();
