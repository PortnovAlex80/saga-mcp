#!/usr/bin/env node
/**
 * W2-транзитный монитор — ВРЕМЕННЫЙ, для сложного этапа (Formalization).
 * Цикл 120с. Пишет .factory-testbed/monitor-w2.log.
 *
 * Специфика W2: узел формализации каждого проекта, счётчик карточек
 * done/total по эпику, NEW-гейт-вердикты (стрим), workplaces в
 * verifying/repair_wait, активный воркер + свежесть heartbeat, спин-детект
 * движка (CPU-дельта за цикл), IDLE-RISK. Read-only.
 */
import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTBED = path.join(ROOT, '.factory-testbed');
const LOG = path.join(TESTBED, 'monitor-w2.log');
mkdirSync(TESTBED, { recursive: true });

const line = s => appendFileSync(LOG, s + '\n', 'utf8');
const now = () => new Date().toISOString();
const sh = c => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } };

const state = { lastCpu: new Map(), lastGateIds: new Set(), lastSig: '', same: 0 };

function enginePids() {
  const out = sh(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'orchestrate-cli.js' }).ProcessId -join ','"`);
  return out ? out.split(',').map(Number).filter(Boolean) : [];
}

function cycle() {
  const ts = now();
  const db = new Database(path.join(TESTBED, 'factory.sqlite'), { readonly: true });
  try {
    // 1. движки + спин
    const pids = enginePids();
    const cpu = [];
    for (const pid of pids) {
      const v = sh(`powershell -NoProfile -Command "[math]::Round((Get-Process -Id ${pid} -ErrorAction SilentlyContinue).CPU,1)"`).replace(',', '.');
      const cur = v === '' ? null : Number(v);
      const prev = state.lastCpu.get(pid);
      state.lastCpu.set(pid, cur);
      if (cur !== null && prev !== null) {
        const d = cur - prev;
        cpu.push(`pid${pid}:+${d.toFixed(0)}s`);
        if (d > 100) line(`${ts} 🚨 ENGINE-SPIN pid=${pid} +${d.toFixed(0)}s/2мин — TB-2, нужен kill+resume`);
      } else cpu.push(`pid${pid}:?`);
    }
    for (const k of [...state.lastCpu.keys()]) if (!pids.includes(k)) state.lastCpu.delete(k);

    // 2. по каждому проекту: стадия, карточки, последний узел
    const rows = db.prepare(`
      SELECT p.id pid, p.name slug, e.id eid,
        (SELECT lr.current_stage_id FROM factory_lifecycle_runs lr WHERE lr.id = (
           SELECT max(c.lifecycle_run_id) FROM factory_order_runs c JOIN factory_orders f2 ON f2.order_ref=c.order_ref WHERE f2.project_id=p.id)) stage,
        (SELECT count(*) FROM tasks t WHERE t.epic_id=e.id) total,
        (SELECT count(*) FROM tasks t WHERE t.epic_id=e.id AND t.status='done') done,
        (SELECT t.workflow_stage FROM tasks t WHERE t.epic_id=e.id ORDER BY t.id DESC LIMIT 1) last_stage
      FROM projects p JOIN epics e ON e.project_id=p.id
      ORDER BY p.id`).all();
    const active = rows.filter(r => r.stage === 'solution-formalization' || r.stage === 'initial-discovery');
    const proj = active.map(r => `${r.slug}[${r.done}/${r.total}@${r.last_stage}]`).join(' ');

    // 3. новые гейт-вердикты
    const gates = db.prepare(`SELECT g.decision_key, g.verdict, g.decided_at, substr(g.workplace_ref, -45) wp
      FROM factory_gate_decisions g ORDER BY g.decided_at DESC LIMIT 8`).all();
    for (const g of gates) {
      if (!state.lastGateIds.has(g.decision_key)) {
        state.lastGateIds.add(g.decision_key);
        line(`${ts} GATE ${g.verdict.toUpperCase()} ${g.wp} @${g.decided_at}`);
      }
    }

    // 4. workplaces в стресс-состояниях
    const stress = db.prepare(`SELECT substr(workplace_ref,-45) wp, loop_state, kanban_phase, revision
      FROM factory_workplaces WHERE loop_state IN ('verifying','repair_wait','paused') AND process_run_id IN (
        SELECT id FROM factory_process_runs WHERE status='paused')`).all();

    // 5. живой воркер
    const w = db.prepare(`SELECT execution_id, task_id, state, heartbeat_at FROM worker_executions
      WHERE state IN ('reserved','running','cancel_requested') ORDER BY rowid DESC LIMIT 1`).get();
    let hbAge = '-';
    if (w) { const t = Date.parse((w.heartbeat_at || '').replace(' ', 'T') + 'Z'); hbAge = Number.isFinite(t) ? ((Date.now() - t) / 60000).toFixed(1) : '?'; }

    line(`${ts} engines=[${cpu.join(' ') || 'none'}] worker=${w ? `task${w.task_id}:${w.state}/hb${hbAge}m` : 'none'} | ${proj}`);
    if (stress.length) line(`${ts} ⚠ STRESS: ${stress.map(s => `${s.wp}:${s.loop_state}/r${s.revision}`).join(' ')}`);
    if (!w && pids.length === 0 && active.length) line(`${ts} 🚨 IDLE-RISK: движков и воркеров нет при активных ${active.length} проектах`);

    const sig = JSON.stringify([rows.map(r => [r.slug, r.done]), stress.length, w ? w.execution_id : null]);
    if (sig === state.lastSig) { state.same += 1; if (state.same === 3) line(`${ts} ⚠ STALL-SUSPECT 6 мин без изменений`); }
    else { state.lastSig = sig; state.same = 0; }
  } finally { db.close(); }
}

line(`${now()} W2-MONITOR-START (временный, цикл 120с)`);
cycle();
setInterval(cycle, 120_000);
