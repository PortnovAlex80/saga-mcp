#!/usr/bin/env node
/**
 * Read-only factory status report for operator monitoring.
 * Usage: node scripts/factory-status.mjs <db-path> [--chain]
 *
 * --chain renders the operator-facing conveyor map: one block per workshop
 * (ЦЕХ) with per-stage task counts and a МЫ ЗДЕСЬ marker on the stage that
 * owns the currently active task. The form is part of the minute-report
 * instruction; keep it stable.
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const chainMode = process.argv.includes('--chain');
const dbPath = process.argv[2];
if (!dbPath || dbPath.startsWith('--')) {
  console.error('usage: node scripts/factory-status.mjs <db-path> [--chain]');
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

// ---------------------------------------------------------------------------
// --chain: the conveyor map (minute-report form).
// Workshops in fixed order; stages derived from task title prefixes ("group:").
// ---------------------------------------------------------------------------
if (chainMode && has('tasks')) {
  const WORKSHOPS = [
    { name: 'DISCOVERY', prefix: 'discovery-', label: 'Discovery' },
    { name: 'FORMALIZATION', prefix: 'formalization-', label: 'Formalization' },
    { name: 'DEVELOPMENT', prefix: 'development-', label: 'Development' },
    { name: 'DELIVERY', prefix: 'delivery-', label: 'Delivery' },
  ];
  const tasksAll = db.prepare('SELECT id, title, status FROM tasks ORDER BY id').all();
  const active = db.prepare("SELECT id, title FROM tasks WHERE status IN ('in_progress','review_in_progress') ORDER BY id").all();
  const activeGroups = new Set(active.map((t) => (t.title || '').split(/[/:]/)[0].trim().toLowerCase()));
  const stageRuns = has('factory_stage_runs')
    ? db.prepare('SELECT stage_id, status FROM factory_stage_runs').all()
    : [];
  const stageDone = (key) => stageRuns.some((s) => s.stage_id === key && s.status === 'completed');

  const lines = [];
  for (const ws of WORKSHOPS) {
    const mine = tasksAll.filter((t) => (t.title || '').toLowerCase().startsWith(ws.prefix));
    if (mine.length === 0) {
      lines.push({ ws, stage: null, done: 0, total: 0, here: false });
      continue;
    }
    const groups = new Map();
    for (const t of mine) {
      const g = (t.title || '').split(/[/:]/)[0].trim();
      if (!groups.has(g)) groups.set(g, { done: 0, total: 0, activeIds: [] });
      const e = groups.get(g);
      e.total += 1;
      if (t.status === 'done') e.done += 1;
      else e.activeIds.push(`#${t.id}`);
    }
    const stages = [...groups.entries()];
    const allDone = stages.every(([, e]) => e.done === e.total);
    const here = [...activeGroups].some((g) => g.startsWith(ws.prefix));
    lines.push({ ws, stages, allDone, here, stageDone });
  }

  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  const dots = (label, width = 42) => {
    const base = `  Этап ${label} `;
    return base + '.'.repeat(Math.max(3, width - base.length)) + ' ';
  };
  for (const line of lines) {
    if (line.stage === null && line.total === 0) {
      const header = `ЦЕХ: ${line.ws.name}`;
      const status = line.ws.name === 'DELIVERY' ? '⬜ НЕ ОТКРЫТ' : '⬜ НЕ ОТКРЫТ';
      console.log(`${pad(header, 46)} ${status}`);
      continue;
    }
    const header = `ЦЕХ: ${line.ws.name}`;
    let wsMark;
    if (line.here) wsMark = '🔵 МЫ ЗДЕСЬ';
    else if (line.allDone) wsMark = '✅ ЗАКРЫТ';
    else wsMark = '⬜';
    console.log(`${pad(header, 46)} ${wsMark}`);
    for (const [g, e] of line.stages) {
      const stageName = g.includes('-') ? g.slice(g.indexOf('-') + 1) : g;
      const mark = e.done === e.total ? '✅' : '🔵';
      const active = e.activeIds.length ? ` — работают: ${e.activeIds.join(', ')}` : '';
      console.log(`${dots(stageName)}${mark} ${e.done}/${e.total}${active}`);
    }
  }
}
db.close();
