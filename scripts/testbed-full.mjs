#!/usr/bin/env node
/**
 * Testbed FULL-RUN driver — один проект до полного завершения lifecycle
 * (discovery → formalization → development → delivery → terminal), затем
 * следующий. Последовательно, рейтлимит 1.
 *
 * Принцип оператора: капсула есть = материал принят = продолжаем.
 * Никаких временных/исторических привязок — replay-капсулы переиспользуются
 * любым новым циклом (newest-wins).
 *
 *   node scripts/testbed-full.mjs 3,4,5            — по БД-id проектов
 *   node scripts/testbed-full.mjs all              — все проекты по порядку
 */
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, '.factory-testbed', 'factory.sqlite');
const TRACKER = 'http://localhost:4321';

const db = new Database(DB_PATH, { readonly: true });
const allIds = db.prepare('SELECT id FROM projects ORDER BY id').all().map(r => r.id);
const arg = process.argv[2] ?? 'all';
const ids = arg === 'all' ? allIds : arg.split(',').map(Number).filter(n => allIds.includes(n));
if (ids.length === 0) { console.error('usage: node scripts/testbed-full.mjs all | 3,4,5'); process.exit(2); }

const log = (id, msg) => console.log(`[full id${id}] ${new Date().toISOString().slice(11, 19)} ${msg}`);
const sh = cmd => { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; } };
async function postJson(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await res.json();
  } catch (error) { return { ok: false, error: String(error) }; }
}
const lifecycleOf = pid => db.prepare(
  'SELECT id,status,terminal_status,current_stage_id FROM factory_lifecycle_runs WHERE project_id=? ORDER BY id DESC LIMIT 1',
).get(pid);
const epicOf = pid => db.prepare('SELECT max(id) id FROM epics WHERE project_id=?').get(pid).id;

for (const pid of ids) {
  const name = db.prepare('SELECT name FROM projects WHERE id=?').get(pid).name;
  const epic = epicOf(pid);
  let lr = lifecycleOf(pid);
  if (lr?.terminal_status === 'completed') { log(pid, `${name}: уже завершён (lc=${lr.id}) — пропуск`); continue; }
  const mode = (!lr || lr.terminal_status === 'failed') ? 'new_start' : 'resume';
  log(pid, `${name}: старт mode=${mode} (lc=${lr?.id ?? '-'} ${lr?.status ?? '-'})`);
  const resp = await postJson(`${TRACKER}/api/factory/start`, mode === 'new_start'
    ? { project_id: pid, mode: 'new_start' } : { project_id: pid });
  log(pid, `start -> ${JSON.stringify(resp).slice(0, 140)}`);
  if (!resp.ok) { log(pid, 'START FAILED — следующий проект'); continue; }

  const started = Date.now();
  let futileResumes = 0;
  for (;;) {
    await new Promise(r => setTimeout(r, 60_000));
    lr = lifecycleOf(pid);
    const hb = db.prepare('SELECT max(heartbeat_at) hb FROM worker_executions WHERE project_id=?').get(pid).hb;
    const t = db.prepare('SELECT COUNT(*) total, SUM(status=\'done\') done FROM tasks WHERE epic_id=?').get(epic);
    const mins = Math.round((Date.now() - started) / 60000);
    log(pid, `${mins}m lc=${lr?.id} ${lr?.status}/${lr?.terminal_status ?? '-'} stage=${lr?.current_stage_id ?? '-'} tasks=${t.done}/${t.total} hb=${hb ?? '-'}`);
    if (lr?.terminal_status) { log(pid, `TERMINAL ${lr.terminal_status} — проект завершён`); break; }
    if (mins > 480) { log(pid, 'TIMEOUT 480m'); break; }
    if (hb && Date.now() - Date.parse(hb) < 2 * 60_000) { futileResumes = 0; continue; }
    // hb протух: жив ли вообще движок?
    const engine = Number(sh('powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \'Name=\'\'node.exe\'\'\' | Where-Object { $_.CommandLine -match \'orchestrate\' }).Count"') || '0');
    const claude = Number(sh('powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \'Name=\'\'claude.exe\'\'\' | Where-Object { $_.CommandLine -match \'--bare\' }).Count"') || '0');
    if (engine > 0 || claude > 0) continue; // движок жив, работает kernel-фаза — не трогаем
    // движок мёртв: human-gate (blocked/paused workplace) или разовый краш
    const humanGated = db.prepare(
      `SELECT COUNT(*) n FROM factory_workplaces w
        WHERE w.process_run_id IN (SELECT process_run_id FROM factory_stage_runs WHERE lifecycle_run_id=?)
          AND w.loop_state='paused'`,
    ).get(lr?.id ?? 0).n;
    if (humanGated > 0 && futileResumes >= 1) {
      log(pid, `BLOCKED(human-gate): ${humanGated} workplace(s) требуют человека — пропуск проекта, драйвер идёт дальше`);
      break;
    }
    if (futileResumes >= 3) { log(pid, 'BLOCKED: 3 безрезультатных resume — пропуск проекта'); break; }
    futileResumes += 1;
    log(pid, `движок мёртв (hb протух) — resume #${futileResumes}`);
    const r2 = await postJson(`${TRACKER}/api/factory/start`, { project_id: pid });
    log(pid, `resume -> ${JSON.stringify(r2).slice(0, 120)}`);
  }
  await postJson(`${TRACKER}/api/factory/stop`, { epic_id: epic });
  log(pid, 'движок остановлен, следующий проект');
}
db.close();
console.log('[full] ALL DONE');
