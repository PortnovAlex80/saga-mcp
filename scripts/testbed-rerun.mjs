#!/usr/bin/env node
/**
 * Testbed re-run driver — новая попытка W2 (Formalization) для проектов,
 * чей lifecycle terminally failed. Использует официальный new_start
 * (CONVEYOR v4.3 §7): тот же project/epic, новый order+lifecycle+workplaces,
 * Discovery переигрывается replay-капсулами. Последовательно, параллелизм 1.
 *
 *   node scripts/testbed-rerun.mjs P02,P07,P09,P10,P11,P12
 */
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = path.join(ROOT, '.factory-testbed', 'factory.sqlite');
const TRACKER = 'http://localhost:4321';
const reg = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'testing', 'projects.json'), 'utf8'));

const ids = (process.argv[2] ?? '').split(',').filter(x => reg.projects.some(p => p.id === x));
if (ids.length === 0) { console.error('usage: node scripts/testbed-rerun.mjs P02,P07,...'); process.exit(2); }

const log = (pid, msg) => console.log(`[rerun ${pid}] ${new Date().toISOString().slice(11, 19)} ${msg}`);
const sh = cmd => { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; } };
async function postJson(url, body) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return JSON.stringify(await res.json());
  } catch (error) { return JSON.stringify({ ok: false, error: String(error) }); }
}

const db = new Database(DB_PATH, { readonly: true });
const projectId = pid => db.prepare('SELECT id FROM projects WHERE name=?').get(reg.projects.find(p => p.id === pid).slug).id;
const epicOf = pid => db.prepare('SELECT max(id) id FROM epics WHERE project_id=?').get(projectId(pid)).id;

function lifecycleOf(pid) {
  // Read the NEWEST lifecycle run of the project directly. Joining through
  // factory_orders picks the OLD run right after new_start (the fresh order
  // has not linked its lifecycle yet) — that false read made the stall probe
  // restart healthy engines every 30s.
  const row = db.prepare(`
    SELECT id, status, terminal_status, current_stage_id
      FROM factory_lifecycle_runs
     WHERE project_id=?
     ORDER BY id DESC LIMIT 1`).get(projectId(pid));
  return row ?? null;
}

for (const pid of ids) {
  const epic = epicOf(pid);
  log(pid, `new_start (project=${projectId(pid)} epic=${epic})`);
  const resp = await postJson(`${TRACKER}/api/factory/start`, { project_id: projectId(pid), mode: 'new_start' });
  log(pid, `start -> ${resp.slice(0, 160)}`);
  if (!resp.includes('"ok":true')) { log(pid, 'START FAILED, skipping'); continue; }

  const started = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 30_000));
    const lr = lifecycleOf(pid);
    const hb = db.prepare('SELECT max(heartbeat_at) hb FROM worker_executions WHERE project_id=?').get(projectId(pid)).hb;
    const mins = Math.round((Date.now() - started) / 60000);
    log(pid, `${mins}m lr=${lr?.id} ${lr?.status}/${lr.terminal_status ?? '-'} stage=${lr?.current_stage_id ?? '-'} hb=${hb ?? '-'}`);
    const boundary = lr?.current_stage_id === 'solution-development';
    const terminal = lr?.status === 'failed' || lr?.status === 'completed';
    if (boundary) { log(pid, 'W2 BOUNDARY REACHED (solution-development) — PASS'); break; }
    if (terminal) { log(pid, `TERMINAL ${lr.status}/${lr.terminal_status}`); break; }
    if (mins > 240) { log(pid, 'TIMEOUT 240m'); break; }
    // TB-9 self-heal probe: hb stale >10 min AND zero workers AND the ENGINE
    // PROCESS ITSELF IS GONE. A live engine with stale hb is doing kernel
    // work (replay / verifying / effects) — restarting it mid-flight only
    // churns; only a dead engine needs a resume.
    if (hb) {
      const ageMs = Date.now() - Date.parse(hb);
      const procCount = cmd => Number(sh(cmd) || '0');
      if (ageMs > 10 * 60_000) {
        const claude = procCount('powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'claude.exe\' }).Count"');
        const engine = procCount('powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'orchestrate\' }).Count"');
        if (claude === 0 && engine === 0) {
          log(pid, `stall detected (hb ${Math.round(ageMs / 60000)}m, engine dead) — resume engine`);
          await postJson(`${TRACKER}/api/factory/start`, { project_id: projectId(pid) })
            .then(r2 => log(pid, `resume -> ${r2.slice(0, 120)}`));
        }
      }
    }
  }
  await postJson(`${TRACKER}/api/factory/stop`, { epic_id: epic });
  log(pid, 'engine stopped at boundary');
}
db.close();
console.log('[rerun] ALL DONE');
