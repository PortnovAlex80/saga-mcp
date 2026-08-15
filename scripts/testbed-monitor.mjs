#!/usr/bin/env node
/**
 * Testbed monitor — цикл 2 минуты, read-only. Пишет .factory-testbed/monitor.log.
 *
 * Каждые 120с: движки (pid + CPU-дельта с прошлого цикла), активные воркеры,
 * СТАРТ нового воркера (отдельная строка WORKER-STARTED), свежесть heartbeat,
 * состояние lifecycle-ов, счётчики задач/артефактов. Аномалии отдельными
 * строками: HEARTBEAT-STALE (>5 мин), ENGINE-SPIN (CPU-дельта ≈ интервалу),
 * IDLE-RISK (движка нет, lifecycle не terminal, активных воркеров нет),
 * STALL-SUSPECT (сигнатура БД не менялась 3 цикла).
 */
import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTBED = path.join(ROOT, '.factory-testbed');
const LOG = path.join(TESTBED, 'monitor.log');
mkdirSync(TESTBED, { recursive: true });

const line = s => appendFileSync(LOG, s + '\n', 'utf8');
const now = () => new Date().toISOString();
function sh(cmd) { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; } }

const state = { lastSig: '', sameSigCycles: 0, knownExecs: new Set(), lastCpu: new Map() };

function enginePids() {
  // только node.exe с реальным orchestrate-cli.js (одинарный бэкслеш в PS-регексе!)
  const out = sh(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'orchestrate-cli.js' }).ProcessId -join ','"`);
  return out ? out.split(',').map(Number).filter(Boolean) : [];
}
function engineCpu(pid) {
  const v = sh(`powershell -NoProfile -Command "[math]::Round((Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CPU,1)"`).replace(',', '.');
  return v === '' ? null : Number(v);
}

async function cycle() {
  const ts = now();
  const db = new Database(path.join(TESTBED, 'factory.sqlite'), { readonly: true });
  try {
    const pids = enginePids();
    const cpuParts = [];
    for (const pid of pids) {
      const cpu = engineCpu(pid);
      const prev = state.lastCpu.get(pid);
      state.lastCpu.set(pid, cpu);
      if (cpu !== null && prev !== null) {
        const delta = cpu - prev;
        cpuParts.push(`pid${pid}:+${delta.toFixed(1)}s`);
        if (delta > 100) line(`${ts} ENGINE-SPIN pid=${pid} cpu+${delta.toFixed(1)}s за цикл (~120s) — KI-1/TB-2 подпись`);
      } else cpuParts.push(`pid${pid}:?`);
    }
    // чистим мёртвые
    for (const k of [...state.lastCpu.keys()]) if (!pids.includes(k)) state.lastCpu.delete(k);

    const workers = db.prepare(`SELECT execution_id, task_id, state, started_at, heartbeat_at FROM worker_executions ORDER BY rowid`).all();
    for (const w of workers) {
      if (!state.knownExecs.has(w.execution_id)) {
        state.knownExecs.add(w.execution_id);
        line(`${ts} WORKER-STARTED exec=${w.execution_id.slice(-8)} task=${w.task_id} at=${w.started_at}`);
      }
    }
    const active = workers.filter(w => ['reserved', 'running', 'cancel_requested'].includes(w.state));
    // зомби: state=running, но heartbeat мёртв (>3 мин) — не считать живыми
    const hbTs = w => { const t = Date.parse(w.heartbeat_at && w.heartbeat_at.includes('T') ? w.heartbeat_at : (w.heartbeat_at || '').replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? t : 0; };
    const live = active.filter(w => Date.now() - hbTs(w) < 3 * 60_000);
    const lastHbRaw = workers.length ? workers[workers.length - 1].heartbeat_at : null;
    let hbAgeMin = null;
    if (lastHbRaw) {
      const t = Date.parse(lastHbRaw.includes('T') ? lastHbRaw : lastHbRaw.replace(' ', 'T') + 'Z');
      hbAgeMin = Number.isFinite(t) ? (Date.now() - t) / 60000 : null;
    }

    const lifecycles = db.prepare(`SELECT lr.id, lr.status, lr.current_stage_id,
        (SELECT count(*) FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE e.project_id=f.project_id) tasks,
        (SELECT count(*) FROM tasks t JOIN epics e ON e.id=t.epic_id WHERE e.project_id=f.project_id AND t.status='done') done
      FROM factory_lifecycle_runs lr
      JOIN factory_order_runs c ON c.lifecycle_run_id=lr.id
      JOIN factory_orders f ON f.order_ref=c.order_ref
      ORDER BY lr.id`).all();
    const artifacts = db.prepare(`SELECT count(*) n FROM artifacts`).get().n;

    line(`${ts} engines=[${cpuParts.join(' ') || 'none'}] activeWorkers=${live.length}/${active.length} live/stale lastHbAgeMin=${hbAgeMin === null ? '-' : hbAgeMin.toFixed(1)} artifacts=${artifacts} | ${lifecycles.map(l => `L${l.id}:${l.status}/${l.current_stage_id}(${l.done}/${l.tasks})`).join(' ')}`);

    if (live.length > 0 && hbAgeMin !== null && hbAgeMin > 5) {
      line(`${ts} HEARTBEAT-STALE ageMin=${hbAgeMin.toFixed(1)} live=${live.length} exec=${live[live.length-1].execution_id.slice(-8)}`);
    }
    const nonterminal = lifecycles.filter(l => !['completed', 'failed'].includes(l.status));
    if (pids.length === 0 && live.length === 0 && nonterminal.length > 0) {
      line(`${ts} IDLE-RISK движка нет, воркеров нет, не-terminal lifecycle: ${nonterminal.map(l => 'L' + l.id + ':' + l.status).join(',')} — нужен resume/queue`);
    }
    const sig = JSON.stringify([lifecycles, live.map(a => [a.execution_id, a.state]), artifacts]);
    if (sig === state.lastSig) {
      state.sameSigCycles += 1;
      if (state.sameSigCycles === 3) line(`${ts} STALL-SUSPECT состояние БД не меняется 3 цикла (~6 мин) при ${pids.length ? 'живом движке' : 'отсутствии движка'}`);
    } else { state.lastSig = sig; state.sameSigCycles = 0; }
  } finally { db.close(); }
}

line(`${now()} MONITOR-START цикл 120с`);
await cycle();
setInterval(cycle, 120_000);
