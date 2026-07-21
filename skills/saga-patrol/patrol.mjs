#!/usr/bin/env node
// saga-patrol — read-only snapshot of a running saga instance.
// Usage:
//   node patrol.mjs                 # all boards
//   node patrol.mjs <project_id>    # one project (all its epics)
//   node patrol.mjs <project_id> <epic_id>
//
// Env:
//   SAGA_DB        default C:/Users/user/.zcode/saga.db
//   SAGA_API       default http://localhost:4321
//   SAGA_LMSTUDIO  default http://localhost:1234
//
// Never writes. Never calls a mutating endpoint. Open DB read-only.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const SAGA_DB = process.env.SAGA_DB || 'C:/Users/user/.zcode/saga.db';
const SAGA_API = (process.env.SAGA_API || 'http://localhost:4321').replace(/\/$/, '');
const SAGA_LMSTUDIO = (process.env.SAGA_LMSTUDIO || 'http://localhost:1234').replace(/\/$/, '');
const CLI_DIR = path.join(os.homedir(), '.zcode', 'cli');

// ---------- low-level helpers ----------

function openDB() {
  if (!fs.existsSync(SAGA_DB)) return null;
  try {
    const db = new Database(SAGA_DB, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL'); // no-op under readonly, harmless
    return db;
  } catch (e) {
    return null;
  }
}

async function getJSON(url, timeoutMs = 3000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { __error: r.status, __url: url };
    return await r.json();
  } catch (e) {
    return { __error: String(e.message || e), __url: url };
  } finally {
    clearTimeout(t);
  }
}

function sqlQuery(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); }
  catch (e) { return [{ __error: String(e.message || e) }]; }
}

function readJsonlTail(p, maxLines = 2000) {
  if (!p || !fs.existsSync(p)) return [];
  try {
    const stat = fs.statSync(p);
    const size = stat.size;
    const chunk = Math.min(size, 256 * 1024); // last 256 KB
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, Math.max(0, size - chunk));
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean).slice(-maxLines);
    const out = [];
    for (const ln of lines) {
      try { out.push(JSON.parse(ln)); } catch { /* skip */ }
    }
    return out;
  } catch { return []; }
}

function tailLines(p, n = 30) {
  if (!p || !fs.existsSync(p)) return [];
  try {
    const stat = fs.statSync(p);
    const size = stat.size;
    const chunk = Math.min(size, 32 * 1024);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, Math.max(0, size - chunk));
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').filter(Boolean).slice(-n);
  } catch { return []; }
}

function fmtAge(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ' ' + (s % 60) + 's' : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}`;
}

// ---------- collectors ----------

function collectBoards(db) {
  const boards = sqlQuery(db, `
    SELECT p.id AS pid, p.name AS project, p.status AS pstatus,
           e.id AS eid, e.name AS epic, e.status AS estatus,
           ew.stage,
           json_extract(ew.metadata,'$.engine_running')    AS eng_running,
           json_extract(ew.metadata,'$.engine_pid')         AS eng_pid,
           json_extract(ew.metadata,'$.engine_concurrency') AS eng_conc,
           json_extract(ew.metadata,'$.active_model')       AS model,
           json_extract(ew.metadata,'$.needs-human')        AS needs_human,
           json_extract(ew.metadata,'$.last_gate_error')    AS last_gate_error
    FROM projects p
    LEFT JOIN epics e ON e.project_id=p.id
    LEFT JOIN episode_workflows ew ON ew.epic_id=e.id
    ORDER BY p.id, e.id`);
  // repos per project
  const repos = sqlQuery(db, `
    SELECT pr.project_id AS pid, r.name, pr.role, pr.local_path,
           pr.integration_branch, pr.status
    FROM project_repositories pr
    JOIN repositories r ON r.id=pr.repository_id`);
  const reposByPid = {};
  for (const r of repos) {
    (reposByPid[r.pid] ||= []).push(r);
  }
  return boards.map(b => ({ ...b, repos: reposByPid[b.pid] || [] }));
}

async function collectEngineApi(epicId) {
  return {
    engine_status: await getJSON(`${SAGA_API}/api/engine/status?epic_id=${epicId}`),
    pipeline: await getJSON(`${SAGA_API}/api/episode/pipeline?epic_id=${epicId}`),
  };
}

async function collectWorkersApi(projectId) {
  const r = await getJSON(`${SAGA_API}/api/workers/active?project_id=${projectId}`, 4000);
  if (r.__error) return [];
  return r.workers || [];
}

function collectTaskSummary(db, epicId) {
  return sqlQuery(db, `
    SELECT workflow_stage, status, COUNT(*) AS n
    FROM tasks WHERE epic_id=?
    GROUP BY workflow_stage, status
    ORDER BY workflow_stage, status`, [epicId]);
}

function collectTasks(db, epicId) {
  return sqlQuery(db, `
    SELECT id, status, task_kind, workflow_stage, assigned_to,
           integration_state,
           CAST((julianday('now') - julianday(updated_at))*86400 AS INT) AS age_s,
           substr(title,1,70) AS title
    FROM tasks WHERE epic_id=?
    ORDER BY workflow_stage, id`, [epicId]);
}

function collectArtifacts(db, epicId) {
  return sqlQuery(db, `
    SELECT type, status, COUNT(*) AS n
    FROM artifacts WHERE epic_id=?
    GROUP BY type, status
    ORDER BY type, status`, [epicId]);
}

function collectOrphanACs(db, epicId) {
  // AC without a derived_from parent artifact
  return sqlQuery(db, `
    SELECT a.code, substr(a.title,1,50) AS title
    FROM artifacts a
    LEFT JOIN artifact_traces tr
      ON tr.source_id=a.id AND tr.target_type='artifact'
     AND tr.link_type IN ('derived_from','covers')
    WHERE a.epic_id=? AND a.type='AC' AND tr.id IS NULL
    ORDER BY a.code`, [epicId]);
}

function collectHumanRequests(db, epicId) {
  return sqlQuery(db, `
    SELECT hr.task_id, t.task_kind, substr(hr.question,1,120) AS question,
           hr.state, hr.created_at
    FROM human_requests hr
    JOIN tasks t ON t.id=hr.task_id
    WHERE t.epic_id=? AND hr.state='open'
    ORDER BY hr.created_at DESC`, [epicId]);
}

function collectStaleExecutions(db, epicId, minAgeS = 900) {
  return sqlQuery(db, `
    SELECT execution_id, task_id, phase, state, pid,
           CAST((julianday('now') - julianday(phase_updated_at))*86400 AS INT) AS phase_age_s,
           last_error
    FROM worker_executions
    WHERE epic_id=? AND state IN ('running','cancel_requested')
      AND phase_updated_at IS NOT NULL
      AND (julianday('now') - julianday(phase_updated_at))*86400 > ?
    ORDER BY phase_age_s DESC`, [epicId, minAgeS]);
}

function collectEngineHeartbeat(projectId, epicId, tailN = 200) {
  // Two possible filenames: engine-<pid>-<epic>.log or single engine-heartbeat.log
  const cands = [
    path.join(CLI_DIR, 'engine-heartbeat.log'),
    path.join(CLI_DIR, `engine-${projectId}-${epicId}.log`),
  ];
  for (const c of cands) {
    if (fs.existsSync(c)) {
      const lines = tailLines(c, tailN);
      // keep only relevant events
      const filtered = lines.filter(ln =>
        / CYCLE | STAGE_ADVANCED| WORKER_LOST| WORKER_TERMINATED| HEALING| ESCALATE| REJECT | PAUSED| RATE_LIMIT| DUPLICATE_EXIT/.test(' ' + ln)
      );
      return { path: c, recent: filtered.slice(-60) };
    }
  }
  return { path: null, recent: [] };
}

function analyzeCycles(logPath) {
  const events = readJsonlTail(logPath, 3000);
  // 4b: tool_use duplicates
  const toolCounts = {};
  let lastAssistantUsage = null;
  const usageSeries = [];
  let apiRetry429 = 0;
  let apiRetryAny = 0;
  const apiRetryRecent = [];
  for (const e of events) {
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type === 'tool_use') {
          const key = c.name + ' :: ' + stableStringify(c.input || {});
          toolCounts[key] = (toolCounts[key] || 0) + 1;
        }
      }
      if (e.message.usage) {
        usageSeries.push({
          ts: e.timestamp,
          in: e.message.usage.input_tokens || 0,
          cache: e.message.usage.cache_read_input_tokens || 0,
          out: e.message.usage.output_tokens || 0,
        });
      }
    }
    if (e.type === 'system' && e.subtype === 'api_retry') {
      apiRetryAny++;
      if (e.error_status === 429) apiRetry429++;
      if (apiRetryRecent.length < 5) {
        apiRetryRecent.push({ ts: e.timestamp, status: e.error_status, err: (e.error || '').slice(0, 80) });
      }
    }
  }
  const dupTools = Object.entries(toolCounts)
    .map(([k, n]) => ({ sig: k.slice(0, 100), n }))
    .filter(x => x.n > 1)
    .sort((a, b) => b.n - a.n);
  // 4c: token growth
  const usageTail = usageSeries.slice(-12);
  let stagnant = false;
  if (usageTail.length >= 4) {
    const ins = usageTail.map(u => u.in);
    const outs = usageTail.map(u => u.out);
    const inGrowth = ins[ins.length - 1] - ins[0];
    const outSum = outs.reduce((a, b) => a + b, 0);
    // input grew >5k but no output produced
    stagnant = inGrowth > 5000 && outSum === 0;
  }
  return {
    top_tools: Object.entries(toolCounts)
      .map(([k, n]) => ({ name: k.split(' :: ')[0], n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 5),
    dup_tools: dupTools.slice(0, 5),
    usage_tail: usageTail,
    usage_stagnant: stagnant,
    api_retry_total: apiRetryAny,
    api_retry_429: apiRetry429,
    api_retry_recent: apiRetryRecent,
  };
}

function stableStringify(obj) {
  // deterministic short signature
  try {
    const k = JSON.stringify(obj, Object.keys(obj).sort());
    if (k.length < 200) return k;
    return k.slice(0, 200) + '#' + k.length;
  } catch { return String(obj).slice(0, 200); }
}

function codeReadiness(localPath) {
  if (!localPath || !fs.existsSync(localPath)) {
    return { present: false };
  }
  const exts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.vue', '.svelte'];
  const skip = /node_modules|\/dist\/|\/build\/|\.git\/|\.next\/|\/coverage\//;
  let loc = 0, files = 0, testFiles = 0, byExt = {};
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (skip.test(full + '/')) continue;
        walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name);
        if (!exts.includes(ext)) continue;
        if (skip.test(full)) continue;
        files++;
        byExt[ext] = (byExt[ext] || 0) + 1;
        if (/\.(test|spec)\.(ts|js|tsx|jsx)$/.test(ent.name) || /_test\.(go|py)$/.test(ent.name)) {
          testFiles++;
        }
        try {
          const txt = fs.readFileSync(full, 'utf8');
          loc += txt.split('\n').length;
        } catch {}
      }
    }
  }
  walk(localPath);
  // git status
  let gitLog = [], gitDirty = null, gitBranch = null;
  try {
    gitBranch = execSync(`git -C "${localPath}" rev-parse --abbrev-ref HEAD`, { encoding: 'utf8' }).trim();
  } catch {}
  try {
    const out = execSync(`git -C "${localPath}" log --oneline -15`, { encoding: 'utf8' }).trim();
    gitLog = out ? out.split('\n') : [];
  } catch {}
  try {
    gitDirty = execSync(`git -C "${localPath}" status --short`, { encoding: 'utf8' }).trim();
  } catch {}
  let tscErrors = null;
  if (fs.existsSync(path.join(localPath, 'tsconfig.json'))) {
    try {
      const out = execSync('npx --no-install tsc --noEmit', {
        cwd: localPath, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
      });
      // tsc returns empty on success
      const errLines = (out || '').split('\n').filter(l => /error TS/.test(l));
      tscErrors = errLines.length;
    } catch (e) {
      const stderr = (e.stderr || e.stdout || '').toString();
      const errLines = stderr.split('\n').filter(l => /error TS/.test(l));
      tscErrors = errLines.length;
    }
  }
  // maturity class
  let maturity = 'no-code';
  if (loc > 0 && loc < 200 && testFiles === 0) maturity = 'skeleton';
  else if (loc < 2000 && testFiles <= 1) maturity = 'mvp-form';
  else if (loc >= 2000 && testFiles > 1) maturity = 'mvp-mature';
  else if (loc >= 2000) maturity = 'mvp-no-tests';
  return { present: true, loc, files, testFiles, byExt, gitBranch, gitLog, gitDirty, tscErrors, maturity };
}

async function collectGpu() {
  // Расширенный набор: clocks, pstate, throttle-reasons, power limit, fan.
  // 0x1 в clocks_event_reasons.active = Idle (норма); любые другие биты — троттлинг.
  const QUERY = [
    'index', 'name', 'timestamp',
    'utilization.gpu', 'utilization.memory',
    'memory.used', 'memory.total',
    'temperature.gpu',
    'power.draw', 'power.limit',
    'fan.speed',
    'clocks.current.graphics', 'clocks.current.memory',
    'clocks.max.graphics', 'clocks.max.memory',
    'clocks_event_reasons.active',
    'pstate',
  ].join(',');
  try {
    const out = execSync(
      `nvidia-smi --query-gpu=${QUERY} --format=csv,noheader,nounits`,
      { encoding: 'utf8', timeout: 4000 }
    );
    const gpus = out.trim().split('\n').map(ln => {
      const v = ln.split(',').map(s => s.trim());
      return {
        idx: v[0], name: v[1], timestamp: v[2],
        util: +v[3], memUtil: +v[4],
        memUsed: +v[5], memTotal: +v[6],
        temp: +v[7],
        power: +v[8], powerLimit: +v[9],
        fan: +v[10],
        coreClock: +v[11], memClock: +v[12],
        coreMax: +v[13], memMax: +v[14],
        clockEvents: v[15], pstate: v[16],
        throttling: v[15] && v[15] !== '0x0000000000000001',
      };
    });
    // append to CSV log for cumulative stats (energy/heat/wear over the run)
    appendGpuCsv(gpus);
    return gpus;
  } catch { return null; }
}

// ---------- GPU cumulative log (CSV) ----------
// One row per (timestamp, gpu). Enables: kWh estimate, degree-hours, throttle-time,
// fan-hours, thermal-cycle count — exactly what the audit report needs for "wear".

const GPU_CSV = process.env.SAGA_PATROL_GPU_CSV
  || path.join(CLI_DIR, 'patrol-gpu.csv');

function appendGpuCsv(gpus) {
  if (!gpus || !gpus.length) return;
  const header = 'ts,gpu,util,memUtil,memUsed,memTotal,temp,power,powerLimit,fan,coreClock,memClock,coreMax,memMax,clockEvents,pstate,throttling\n';
  let exists = false;
  try { exists = fs.existsSync(GPU_CSV); } catch {}
  try {
    const fd = fs.openSync(GPU_CSV, exists ? 'a' : 'w');
    if (!exists) fs.writeSync(fd, header);
    const ts = new Date().toISOString();
    for (const g of gpus) {
      fs.writeSync(fd, [
        ts, g.idx, g.util, g.memUtil, g.memUsed, g.memTotal, g.temp,
        g.power, g.powerLimit, g.fan, g.coreClock, g.memClock, g.coreMax, g.memMax,
        g.clockEvents, g.pstate, g.throttling ? 1 : 0,
      ].join(',') + '\n');
    }
    fs.closeSync(fd);
  } catch { /* silent — patrol is read-only on the world, failures here are OK */ }
}

function summarizeGpuCsv() {
  // Returns per-gpu aggregate stats from patrol-gpu.csv (if any).
  // CSV header (must match appendGpuCsv):
  //   ts,gpu,util,memUtil,memUsed,memTotal,temp,power,powerLimit,fan,
  //   coreClock,memClock,coreMax,memMax,clockEvents,pstate,throttling
  if (!fs.existsSync(GPU_CSV)) return null;
  let rows;
  try {
    rows = fs.readFileSync(GPU_CSV, 'utf8').trim().split('\n').slice(1)
      .map(ln => {
        const v = ln.split(',');
        return {
          ts: v[0], gpu: v[1],
          util: +v[2], memUtil: +v[3],
          memUsed: +v[4], memTotal: +v[5],
          temp: +v[6],
          power: +v[7], powerLimit: +v[8], fan: +v[9],
          coreClock: +v[10], memClock: +v[11],
          throttling: +v[16] === 1,
        };
      }).filter(r => r.ts && !isNaN(r.temp) && r.temp < 150);
  } catch { return null; }
  if (!rows.length) return null;

  // Time span of CSV
  const ts0 = new Date(rows[0].ts).getTime();
  const ts1 = new Date(rows[rows.length - 1].ts).getTime();
  const spanSec = Math.max(1, (ts1 - ts0) / 1000);

  // Per-gpu aggregate
  const byGpu = {};
  for (const r of rows) {
    if (!byGpu[r.gpu]) byGpu[r.gpu] = [];
    byGpu[r.gpu].push(r);
  }
  const summary = [];
  for (const [gpu, arr] of Object.entries(byGpu)) {
    const temps = arr.map(x => x.temp);
    const powers = arr.map(x => x.power);
    const fans = arr.map(x => x.fan);
    const utils = arr.map(x => x.util);
    const n = arr.length;
    // Energy: average power (W) × span hours / N samples × N samples = avg_W × hours
    // But samples are non-uniform; assume representative → avg W × span_hours
    const avgPower = powers.reduce((a, b) => a + b, 0) / n;
    const spanHours = spanSec / 3600;
    const kWh = (avgPower * spanHours) / 1000;
    // Degree-hours above 50°C baseline (thermal wear proxy)
    const avgTemp = temps.reduce((a, b) => a + b, 0) / n;
    const degHoursAbove50 = Math.max(0, avgTemp - 50) * spanHours;
    // Throttle time
    const throttleSamples = arr.filter(x => x.throttling).length;
    // Thermal cycle count (sign reversals in temp diff)
    let cycles = 0;
    for (let i = 2; i < arr.length; i++) {
      const a = arr[i - 2].temp, b = arr[i - 1].temp, c = arr[i].temp;
      if ((b - a) * (c - b) < 0 && Math.abs(c - a) >= 10) cycles++;
    }
    // Max observed
    const maxTemp = Math.max(...temps);
    const maxPower = Math.max(...powers);
    const maxFan = Math.max(...fans);
    summary.push({
      gpu, samples: n, spanHours: +spanHours.toFixed(2),
      avgUtil: +(utils.reduce((a, b) => a + b, 0) / n).toFixed(1),
      avgPower: +avgPower.toFixed(1), maxPower: +maxPower.toFixed(1),
      avgTemp: +avgTemp.toFixed(1), maxTemp,
      avgFan: +(fans.reduce((a, b) => a + b, 0) / n).toFixed(0), maxFan,
      kWh: +kWh.toFixed(3),
      degHoursAbove50: +degHoursAbove50.toFixed(1),
      throttleSamples, throttlePct: +(100 * throttleSamples / n).toFixed(1),
      thermalCycles10C: cycles,
      powerLimit: arr[0].powerLimit,
    });
  }
  return { csvPath: GPU_CSV, spanHours: +(spanSec / 3600).toFixed(2), samples: rows.length, perGpu: summary };
}

async function collectLmstudioModel() {
  const r = await getJSON(`${SAGA_LMSTUDIO}/api/v0/models`, 2500);
  if (!r || r.__error || !r.data) return null;
  return r.data.map(m => ({
    id: m.id, state: m.state, ctx: m.loaded_context_length, max: m.max_context_length,
  }));
}

// ---------- reporter ----------

function emitReport({ boards, all }) {
  const lines = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  lines.push(`# 📋 Срез saga-patrol — ${now}`);
  lines.push('');

  if (!boards.length) {
    lines.push('_Доски не найдены. Either saga.db пуст, либо путь неверный._');
    lines.push('');
    lines.push(`- SAGA_DB = \`${SAGA_DB}\` (существует: ${fs.existsSync(SAGA_DB)})`);
    lines.push(`- SAGA_API = \`${SAGA_API}\``);
    return lines.join('\n');
  }

  for (const b of boards) {
    lines.push(`## 🟦 ${b.project} (id=${b.pid})  ·  epic ${b.eid} «${(b.epic || '').slice(0, 40)}»`);
    lines.push('');
    lines.push(`- **stage:** \`${b.stage || '—'}\`  ·  **model:** \`${b.model || '—'}\`  ·  **engine:** ${b.eng_running == 1 ? '✅ running' : '⛔ stopped'} (pid=${b.eng_pid || '—'}, concurrency=${b.eng_conc || '—'})`);
    if (b.needs_human) lines.push(`- ⚠ **needs-human**: ${b.needs_human}`);
    if (b.last_gate_error) lines.push(`- last gate error: \`${b.last_gate_error}\``);
    if (b.repos && b.repos.length) {
      lines.push(`- репо: ${b.repos.map(r => `\`${r.name}\` @ \`${r.local_path}\` [${r.integration_branch || 'dev'}] (${r.status})`).join('; ')}`);
    }
    lines.push('');

    // tasks summary
    const tasks = collectTasks(all.db, b.eid);
    const ts = collectTaskSummary(all.db, b.eid);
    lines.push('### Задачи');
    const stageOrder = ['discovery','formalization','planning','development','verification','integration','completed'];
    const stageCounts = {};
    for (const r of ts) {
      const s = r.workflow_stage || '?';
      stageCounts[s] = stageCounts[s] || {};
      stageCounts[s][r.status] = (stageCounts[s][r.status] || 0) + r.n;
    }
    const allStages = [...new Set([...stageOrder, ...Object.keys(stageCounts)])];
    for (const s of allStages) {
      if (!stageCounts[s]) continue;
      const parts = Object.entries(stageCounts[s]).map(([k, v]) => `${k}=${v}`).join(', ');
      lines.push(`- \`${s}\` — ${parts}`);
    }
    // longest running in_progress
    const ip = tasks.filter(t => ['in_progress','review_in_progress'].includes(t.status))
                    .sort((a, b) => (b.age_s || 0) - (a.age_s || 0))[0];
    if (ip) {
      lines.push(`- самая долгая in-progress: **#${ip.id}** \`${ip.task_kind}\` (age=${fmtAge((ip.age_s||0)*1000)}) — ${(ip.title || '').slice(0, 60)}`);
    }
    lines.push('');

    // cycles
    const hb = collectEngineHeartbeat(b.pid, b.eid);
    lines.push('### 🔁 Циклы');
    if (hb.recent.length === 0) {
      lines.push('- engine-heartbeat: ничего релевантного в хвосте (CYCLE/HEALING/ESCALATE отсутствуют)');
    } else {
      const last20 = hb.recent.slice(-20);
      const cycleStuck = countStuckCycles(hb.recent);
      const healing = hb.recent.filter(l => / HEALING | ESCALATE| GENERIC_HEAL/.test(' ' + l)).length;
      const rejects = hb.recent.filter(l => / REJECT /.test(' ' + l)).length;
      lines.push(`- engine-heartbeat (последние 20 релевантных): stuck-cycle=${cycleStuck}, healing=${healing}, reject=${rejects}`);
      for (const l of last20.slice(-8)) {
        lines.push(`  - \`${l.replace(/\s+/g, ' ').slice(-160)}\``);
      }
    }

    // per-worker JSONL cycles
    if (all.workersByEpic[b.eid]) {
      for (const w of all.workersByEpic[b.eid]) {
        const cyc = analyzeCycles(w.log_path);
        lines.push(`- **#${w.task_id}** \`${w.process_phase}\` pid=${w.pid} quiet=${w.is_quiet ? '⚠ да' : 'нет'} ${w.tokens_per_sec || 0}tok/s total=${w.total_tokens || 0}`);
        if (cyc.dup_tools.length) {
          lines.push(`  - дубли tool_use: ${cyc.dup_tools.map(d => `${d.n}× \`${d.sig.slice(0, 60)}\``).join('; ')}`);
        } else {
          lines.push(`  - дубли tool_use: нет`);
        }
        if (cyc.usage_stagnant) {
          lines.push(`  - ⚠ стагнация токенов: input растёт, output=0 (тайный цикл)`);
        }
        if (cyc.usage_tail.length) {
          const u = cyc.usage_tail[cyc.usage_tail.length - 1];
          lines.push(`  - токены: input=${u.in} cache=${u.cache} (${Math.round(100 * u.cache / Math.max(1, u.in))}%) output=${u.out}`);
        }
        if (cyc.api_retry_429 > 0 || cyc.api_retry_total > 0) {
          lines.push(`  - api_retry: всего=${cyc.api_retry_total} 429=${cyc.api_retry_429}`);
        } else {
          lines.push(`  - api_retry: 0`);
        }
      }
    } else {
      lines.push('- активных воркеров нет (или workers/active недоступен)');
    }
    lines.push('');

    // artifacts
    const art = collectArtifacts(all.db, b.eid);
    const orphans = collectOrphanACs(all.db, b.eid);
    lines.push('### 📐 Артефакты');
    const byType = {};
    for (const a of art) {
      byType[a.type] = byType[a.type] || {};
      byType[a.type][a.status] = a.n;
    }
    const artLines = [];
    for (const t of Object.keys(byType).sort()) {
      artLines.push(`- \`${t}\`: ${Object.entries(byType[t]).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    if (artLines.length === 0) lines.push('- нет артефактов');
    else lines.push(...artLines);
    if (orphans.length) {
      lines.push(`- ⚠ orphan AC (без parent trace): ${orphans.length} — ${orphans.slice(0, 5).map(o => o.code).join(', ')}${orphans.length > 5 ? '…' : ''}`);
    } else {
      lines.push(`- orphan AC: 0 (traceability чистая)`);
    }
    lines.push('');

    // needs-human + stale executions
    const hr = collectHumanRequests(all.db, b.eid);
    const stale = collectStaleExecutions(all.db, b.eid);
    if (hr.length || stale.length) {
      lines.push('### 🚨 needs-human / stale executions');
      for (const h of hr) {
        lines.push(`- task #${h.task_id} \`${h.task_kind}\` — вопрос: "${h.question}"`);
      }
      for (const s of stale) {
        lines.push(`- execution \`${s.execution_id}\` task #${s.task_id} фаза \`${s.phase}\` висит ${fmtAge((s.phase_age_s||0)*1000)} (last_error: ${(s.last_error || '—').slice(0, 80)})`);
      }
      lines.push('');
    }

    // code readiness (only if development+ stage)
    const codeStages = ['development','verification','integration','completed'];
    if (codeStages.includes(b.stage) && b.repos && b.repos.length) {
      lines.push('### 💻 Код (development stage)');
      for (const r of b.repos) {
        if (r.status !== 'active' || !r.local_path) continue;
        const cr = codeReadiness(r.local_path);
        if (!cr.present) {
          lines.push(`- \`${r.name}\` @ \`${r.local_path}\` — путь не существует`);
          continue;
        }
        lines.push(`- \`${r.name}\` @ \`${r.local_path}\` branch=\`${cr.gitBranch || '?'}\``);
        lines.push(`  - LoC: **${cr.loc}** в ${cr.files} файлах (тестов: ${cr.testFiles}) — класс: **${cr.maturity}**`);
        if (cr.gitLog && cr.gitLog.length) {
          lines.push(`  - коммиты: ${cr.gitLog.length} (последний: \`${cr.gitLog[0].slice(0, 70)}\`)`);
        } else {
          lines.push(`  - коммиты: 0 (git log пуст или .git отсутствует)`);
        }
        if (cr.gitDirty) {
          const dn = cr.gitDirty.split('\n').filter(Boolean).length;
          lines.push(`  - ⚠ незакоммичено: ${dn} файлов`);
        }
        if (cr.tscErrors !== null) {
          lines.push(`  - tsc --noEmit: ${cr.tscErrors === 0 ? '✅ 0 ошибок' : `⚠ ${cr.tscErrors} ошибок`}`);
        }
      }
      lines.push('');
    } else {
      lines.push(`### 💻 Код`);
      lines.push(`- stage=\`${b.stage}\` — кодовая фаза ещё не стартовала, оцениваю только артефакты (это норма).`);
      lines.push('');
    }
  }

  // engine-wide: gpu, model
  lines.push('### 🎛 GPU / модель');
  const lm = all.lmstudio;
  if (lm && lm.length) {
    const loaded = lm.filter(m => m.state === 'loaded');
    for (const m of loaded.length ? loaded : lm.slice(0, 1)) {
      lines.push(`- LM Studio: \`${m.id}\` state=${m.state} ctx=${m.ctx}/${m.max}`);
    }
  } else {
    lines.push('- LM Studio: недоступен');
  }
  if (all.gpu && all.gpu.length) {
    lines.push('');
    lines.push('**Instant:**');
    for (const g of all.gpu) {
      const memPct = g.memTotal ? Math.round(100 * g.memUsed / g.memTotal) : 0;
      const powerPct = g.powerLimit ? Math.round(100 * g.power / g.powerLimit) : 0;
      const thr = g.throttling ? ' ⚠THROTTLE' : '';
      lines.push(`- GPU ${g.idx} [${g.pstate}]: util=${g.util}% mem=${g.memUsed}/${g.memTotal} MiB (${memPct}%) temp=${g.temp}°C power=${g.power}/${g.powerLimit}W (${powerPct}%) fan=${g.fan}% core=${g.coreClock}/${g.coreMax}MHz mem=${g.memClock}/${g.memMax}MHz${thr}`);
    }
    // cumulative
    const cum = summarizeGpuCsv();
    if (cum) {
      lines.push('');
      lines.push(`**Cumulative** (CSV: \`${cum.csvPath}\`, span=${cum.spanHours}ч, samples=${cum.samples}):`);
      lines.push('| GPU | avgUtil | avgW | maxW | avgT | maxT | kWh | deg·h>50°C | throttle% | thermalCycles(Δ10°C) | fan avg/max |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
      for (const s of cum.perGpu) {
        lines.push(`| ${s.gpu} | ${s.avgUtil}% | ${s.avgPower} | ${s.maxPower} | ${s.avgTemp}°C | ${s.maxTemp}°C | ${s.kWh} | ${s.degHoursAbove50} | ${s.throttlePct}% | ${s.thermalCycles10C} | ${s.avgFan}/${s.maxFan}% |`);
      }
      lines.push('');
      lines.push(`_Где читать: **kWh** — потреблено электричества; **deg·h>50°C** — интеграл теплового износа (бить тревогу > 500); **throttle%** — время в троттлинге (> 5% = проблема охлаждения); **thermalCycles** — циклы нагрев-остывание > 10°C (износ пайки/термопасты)._`);
    }
  } else {
    lines.push('- GPU: nvidia-smi недоступен');
  }
  lines.push('');

  return lines.join('\n');
}

function countStuckCycles(lines) {
  // long run of "CYCLE ... claimable=0 in_flight=N workers=N" with no STAGE_ADVANCED in between
  let cur = 0, max = 0;
  for (const l of lines) {
    if (/ CYCLE /.test(' ' + l)) {
      const m = l.match(/claimable=(\d+)\s+in_flight=(\d+)/);
      if (m && m[1] === '0' && m[2] !== '0') {
        cur++;
        if (cur > max) max = cur;
      } else {
        cur = 0;
      }
    } else if (/ STAGE_ADVANCED| GENERATED /.test(' ' + l)) {
      cur = 0;
    }
  }
  return max;
}

// ---------- main ----------

async function main() {
  const args = process.argv.slice(2);
  const pidArg = args[0] ? parseInt(args[0], 10) : null;
  const eidArg = args[1] ? parseInt(args[1], 10) : null;

  const db = openDB();
  if (!db) {
    console.error(`Cannot open saga.db at ${SAGA_DB} (read-only). Проверь SAGA_DB.`);
    process.exit(2);
  }
  let boards = collectBoards(db);
  if (pidArg) boards = boards.filter(b => b.pid === pidArg);
  if (eidArg) boards = boards.filter(b => b.eid === eidArg);

  // live API (workers, engine, pipeline) + parallel DB/JSONL analysis
  const workersByEpic = {};
  for (const b of boards) {
    workersByEpic[b.eid] = await collectWorkersApi(b.pid);
  }

  const [gpu, lmstudio] = await Promise.all([collectGpu(), collectLmstudioModel()]);

  const report = emitReport({
    boards,
    all: { db, workersByEpic, gpu, lmstudio },
  });
  console.log(report);
}

main().catch(e => {
  console.error('patrol failed:', e.stack || e.message || e);
  process.exit(1);
});
