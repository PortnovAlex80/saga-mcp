#!/usr/bin/env node
/**
 * Testbed harness — по-цеховой прогон проектов в ОБЩЕЙ БД (WORKSHOP-TEST-PLAN §4).
 *
 *   node scripts/testbed-run.mjs <PID> --round W1 [--timeout-min N]
 *
 * W1: провиженинг проекта (project+repo+epic+control lmstudio/qwen/limit1 ДО
 *     первого claim — KI-3 исключён) + startProductLifecycleFromIdea →
 *     поллинг границы initial-discovery completed → стоп движка → журналы.
 * W2/W3: resume существующего проекта через трекер (POST /api/factory/start
 *     {project_id}) → поллинг своей границы → стоп → журналы.
 *
 * Стоп: движок W1 — detached-чайлд harness'а → kill по CommandLine; движки
 * W2/W3 может стартовать трекер → сначала POST /api/factory/stop, затем kill
 * остатков. Логи: .factory-testbed/runs/<PID>/journal.md +
 * docs/testing/WORKSHOP-{JOURNAL,STATUS}.md.
 */
import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const importAbs = p => import(pathToFileURL(p).href);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTBED = path.join(ROOT, '.factory-testbed');
const DB_PATH = path.join(TESTBED, 'factory.sqlite');
process.env.DB_PATH = DB_PATH; // dist/db.js getDb() читает env — до импортов app-слоя
const REPOS = path.join(TESTBED, 'repos');
const RUNS = path.join(TESTBED, 'runs');
const TRACKER = 'http://localhost:4321';
const MODEL = 'qwen/qwen3.6-35b-a3b';
const COMPOSITION = path.join(ROOT, 'tracker-view', 'product-delivery-composition.mjs');

const ROUND_BOUNDARY = {
  W1: { nextStage: 'solution-formalization', timeoutMin: 120 },
  W2: { nextStage: 'solution-development', timeoutMin: 720 },
  W3: { lifecycleCompleted: true, timeoutMin: 2880 },
};

const args = process.argv.slice(2);
const pid = args[0];
const roundArg = args.find(a => a.startsWith('--round='));
const timeoutArg = args.find(a => a.startsWith('--timeout-min='));
if (!pid || !roundArg) {
  console.error('usage: node scripts/testbed-run.mjs <PID> --round=W1|W2|W3 [--timeout-min=N]');
  process.exit(2);
}
const round = roundArg.split('=')[1].toUpperCase();
if (!ROUND_BOUNDARY[round]) { console.error(`unknown round ${round}`); process.exit(2); }
const timeoutMin = timeoutArg ? Number(timeoutArg.split('=')[1]) : ROUND_BOUNDARY[round].timeoutMin;

const registry = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'testing', 'projects.json'), 'utf8'));
const project = registry.projects.find(p => p.id === pid);
if (!project) { console.error(`unknown project ${pid} in projects.json`); process.exit(2); }

function log(msg) { console.log(`[testbed ${pid}/${round}] ${new Date().toISOString().slice(11, 19)} ${msg}`); }
function sh(cmd) { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; } }
function psKill(pattern, nameFilter) {
  // nameFilter обязателен: без него powershell убивает СЕБЯ (его CommandLine содержит pattern)
  const nf = nameFilter || "*";
  const out = sh(`powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \\"Name LIKE '${nf}'\\" | Where-Object { $_.CommandLine -match '${pattern}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }).Count"`);
  return out || '0';
}
async function stopEverything(epicId) {
  let api = '';
  try {
    const r = await fetch(`${TRACKER}/api/factory/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ epic_id: epicId }) });
    api = r.ok ? 'api-ok' : `api-${r.status}`;
  } catch { api = 'api-down'; }
  const k1 = psKill('orchestrate-cli.js', 'node.exe');
  const k2 = psKill('--bare', 'claude%');
  log(`stop: ${api}; killed orchestrate-cli=${k1 || 0} claude=${k2 || 0}`);
}

// ── provisioning (только W1) ────────────────────────────────────────────────
function provision(db) {
  const slug = project.slug;
  const dup = db.prepare('SELECT id FROM projects WHERE name=?').get(slug);
  if (dup) { console.error(`project '${slug}' already exists (id=${dup.id}) — W1 already provisioned; use --round=W2/W3 or clean the DB`); process.exit(2); }
  const localPath = path.join(REPOS, slug);
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const tx = db.transaction(() => {
    const p = db.prepare("INSERT INTO projects (name,description,status) VALUES (?,?,'active')").run(slug, project.idea);
    const projectId = Number(p.lastInsertRowid);
    const r = db.prepare("INSERT INTO repositories (name,default_branch) VALUES (?,'main')").run(slug);
    const repoId = Number(r.lastInsertRowid);
    db.prepare(`INSERT INTO project_repositories (project_id,repository_id,role,local_path,integration_branch,status)
                VALUES (?,?,'control',?,'main','active')`).run(projectId, repoId, localPath);
    const e = db.prepare("INSERT INTO epics (project_id,name,description,status,priority) VALUES (?,?,?,'planned','high')")
      .run(projectId, `REQ-001-${slug}`, project.idea);
    const epicId = Number(e.lastInsertRowid);
    // control-строка ДО первого claim: lmstudio/qwen/limit 1 (KI-3 исключён архитектурно)
    db.prepare(`INSERT INTO lifecycle_execution_controls
                  (epic_id,engine_state,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
                VALUES (?, 'stopped', 1, 'lmstudio', ?, NULL, 1)
                ON CONFLICT(epic_id) DO UPDATE SET
                  concurrency=1, model_provider='lmstudio', model_name=?, model_effort=NULL,
                  model_concurrency_limit=1, updated_at=datetime('now')`).run(epicId, MODEL, MODEL);
    const orderRef = `order-testbed-${slug}-${Date.now()}`;
    db.prepare(`INSERT INTO factory_orders (order_ref,project_id,epic_id,lifecycle_run_id,source_kind,state)
                VALUES (?,?,?,NULL,'existing_project','starting')`).run(orderRef, projectId, epicId);
    return { projectId, epicId, orderRef, localPath };
  });
  const info = tx();
  db.prepare(`INSERT INTO activity_log (entity_type,entity_id,action,summary) VALUES ('project',?,'created',?)`)
    .run(info.projectId, `testbed ${pid} (${project.tier}) provisioned at ${now}`);
  return info;
}

// ── журналы ────────────────────────────────────────────────────────────────
function journalProject(lines) {
  const dir = path.join(RUNS, pid);
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, 'journal.md'), lines.join('\n') + '\n');
}
function updateRoundJournal(row) {
  const file = path.join(ROOT, 'docs', 'testing', 'WORKSHOP-JOURNAL.md');
  let text = readFileSync(file, 'utf8');
  const section = text.indexOf(`## Раунд ${round}`);
  if (section < 0) return;
  const tableStart = text.indexOf('|---', section);
  const lineEnd = text.indexOf('\n', tableStart);
  text = text.slice(0, lineEnd + 1) + row + '\n' + text.slice(lineEnd + 1);
  // убрать плейсхолдер-строку, если ещё стоит
  text = text.replace(/\n\| — \| — \| — \| — \| — \| — \| — \| — \| — \| — \| — \|\n/, '\n');
  writeFileSync(file, text, 'utf8');
}
function updateStatusGrid(outcomeGlyph, note) {
  const file = path.join(ROOT, 'docs', 'testing', 'WORKSHOP-STATUS.md');
  let text = readFileSync(file, 'utf8');
  const col = round === 'W1' ? 1 : round === 'W2' ? 2 : 3;
  const lines = text.split('\n').map(line => {
    if (!line.startsWith(`| ${pid} |`)) return line;
    const parts = line.split('|');
    // parts: ['', PID, проект, тир, W1, W2, W3, прим, ''] → глиф W1 = parts[4]
    const idx = 3 + col;
    if (parts[idx] && parts[idx].trim() === '⬚') parts[idx] = ` ${outcomeGlyph} `;
    if (note) parts[7] = ` ${note} `;
    return parts.join('|');
  });
  text = lines.join('\n');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  text = text.replace(/\*\*Обновлено:\*\* [^\n]*/, `**Обновлено:** ${stamp} UTC (${pid}/${round}: ${outcomeGlyph})`);
  text = text.replace(/(\| Время \(UTC\) \| Событие \|\n\|---\|\n)/, `$1| ${stamp} | ${pid}/${round}: ${outcomeGlyph}${note ? ' — ' + note : ''} |\n`);
  writeFileSync(file, text, 'utf8');
}

// ── главный поток ──────────────────────────────────────────────────────────
for (const d of [TESTBED, REPOS, RUNS, path.join(TESTBED, 'snapshots'), path.join(TESTBED, 'checkpoints'), path.join(TESTBED, 'package-store')]) {
  mkdirSync(d, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
const { SCHEMA_SQL } = await importAbs(path.join(ROOT, 'dist', 'schema.js'));
db.exec(SCHEMA_SQL);

let projectId, epicId, lifecycleRunId;
const startedAt = new Date();
const attach = args.includes('--attach');

if (attach) {
  // подхват УЖЕ идущего lifecycle (harness мог упасть; движок detached живёт сам)
  const row = db.prepare('SELECT id FROM projects WHERE name=?').get(project.slug);
  if (!row) { console.error(`no project '${project.slug}' in DB`); process.exit(1); }
  projectId = row.id;
  const { resolveFactoryResumeTarget } = await importAbs(path.join(ROOT, 'dist', 'app', 'factory-start.js'));
  const target = resolveFactoryResumeTarget(db, projectId);
  epicId = target.epicId; lifecycleRunId = target.lifecycleRunId;
  log(`ATTACH to project=${projectId} epic=${epicId} lifecycle=${lifecycleRunId}`);
  // движка может не быть (cleanup/крач) — трекер поднимет свежий с правильным env
  const engines = sh(`powershell -NoProfile -Command "@(Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -match 'orchestrate-cli.js' }).Count"`).replace(',', '.');
  if (Number(engines) === 0) {
    const r = await fetch(`${TRACKER}/api/factory/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: projectId }) });
    const body = await r.json().catch(() => ({}));
    log(`no engine alive → tracker resume: ${JSON.stringify(body)}`);
    if (!r.ok || !body.ok) { console.error('tracker resume failed'); process.exit(1); }
  }
} else if (round === 'W1') {
  // трекер жив? (нужен для остановки/наблюдения)
  const hb = await fetch(`${TRACKER}/api/heartbeat`).then(r => r.ok).catch(() => false);
  if (!hb) { console.error('tracker on :4321 is DOWN — start it first (WORKSHOP-STATUS §экспресс)'); process.exit(1); }

  const info = provision(db);
  projectId = info.projectId; epicId = info.epicId;
  const { ensureInitializedGitRepository } = await importAbs(path.join(ROOT, 'tracker-view', 'git-bootstrap.mjs'));
  ensureInitializedGitRepository(info.localPath, project.slug);

  journalProject([
    `## ${pid} ${project.title} (${project.tier}) — ${round} ${new Date().toISOString()}`,
    '', '### ORIGINAL IDEA PROMPT (verbatim input)', '', '```', project.idea, '```', '',
  ]);

  const { createFactoryLaunchStarter } = await importAbs(path.join(ROOT, 'dist', 'app', 'product-lifecycle-run-starter.js'));
  const { startProductLifecycleFromIdea } = await importAbs(path.join(ROOT, 'dist', 'app', 'start-product-lifecycle-from-idea.js'));
  const starter = createFactoryLaunchStarter({
    dbPath: DB_PATH,
    baseEnv: {
      ...process.env,
      DB_PATH: DB_PATH,
      SAGA_PRODUCT_LIFECYCLE_COMPOSITION: COMPOSITION,
      SAGA_FACTORY_CONCURRENCY: '1',
      SAGA_PACKAGE_STORE_DIR: path.join(TESTBED, 'package-store'),
      SAGA_FACTORY_CHECKPOINT_STORE: path.join(TESTBED, 'checkpoints'),
      SAGA_FACTORY_CHECKPOINT_LOGS: '1',
    },
  });
  const started = await startProductLifecycleFromIdea({
    orderRef: info.orderRef, projectId, epicId, idea: project.idea,
    initiatedBy: `testbed:${pid}`, concurrency: 1, starter,
    idempotencyKey: `testbed-${pid}-${round.toLowerCase()}-${Date.now()}`,
  });
  lifecycleRunId = started.lifecycleRunId;
  log(`started lifecycle=${lifecycleRunId} project=${projectId} epic=${epicId}`);
} else {
  const row = db.prepare('SELECT id FROM projects WHERE name=?').get(project.slug);
  if (!row) { console.error(`project ${project.slug} not in DB — run W1 first`); process.exit(1); }
  projectId = row.id;
  const e = db.prepare('SELECT max(id) id FROM epics WHERE project_id=?').get(projectId);
  epicId = e.id;
  const lr = db.prepare('SELECT max(id) id FROM factory_lifecycle_runs lr JOIN factory_order_runs c ON c.lifecycle_run_id=lr.id JOIN factory_orders f ON f.order_ref=c.order_ref WHERE f.project_id=?').get(projectId);
  lifecycleRunId = lr.id;
  const hb = await fetch(`${TRACKER}/api/heartbeat`).then(r => r.ok).catch(() => false);
  if (!hb) { console.error('tracker DOWN'); process.exit(1); }
  const r = await fetch(`${TRACKER}/api/factory/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: projectId }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.ok) { console.error(`resume failed: ${JSON.stringify(body)}`); process.exit(1); }
  log(`resumed lifecycle=${lifecycleRunId} via tracker (project=${projectId})`);
}


// ── поллинг границы ────────────────────────────────────────────────────────
const boundary = ROUND_BOUNDARY[round];
let deadline = Date.now() + timeoutMin * 60_000;
let outcome = null, failReason = '';
let lastSig = '', lastSigAt = Date.now();
const STALL_MS = 8 * 60_000;
let spinRecoveries = 0;

while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 5000));
  const lr = db.prepare('SELECT status, current_stage_id, terminal_status FROM factory_lifecycle_runs WHERE id=?').get(lifecycleRunId);
  const stages = db.prepare('SELECT id,status FROM factory_stage_runs WHERE lifecycle_run_id=? ORDER BY id').all(lifecycleRunId);
  const tasks = db.prepare(`SELECT count(*) n, sum(status='done') done FROM tasks WHERE epic_id=?`).get(epicId);
  const workers = db.prepare(`SELECT state, count(*) n FROM worker_executions WHERE epic_id=? GROUP BY state`).all(epicId);
  const hb = db.prepare('SELECT max(heartbeat_at) hb FROM worker_executions WHERE epic_id=?').get(epicId);
  const sig = JSON.stringify([lr, stages, tasks, workers]);

  if (lr.status === 'failed' || lr.terminal_status === 'failed') { outcome = 'fail'; failReason = JSON.stringify(lr); break; }
  if (boundary.lifecycleCompleted && lr.status === 'completed') { outcome = 'pass'; break; }
  if (boundary.nextStage && lr.current_stage_id === boundary.nextStage && stages.some(s => s.status === 'completed')) {
    // граница достигнута: движок уже мог заклеймить карточку следующего цеха → стоп немедленно
    await stopEverything(epicId);
    outcome = 'pass';
    break;
  }
  if (sig !== lastSig) { lastSig = sig; lastSigAt = Date.now(); }
  else if (Date.now() - lastSigAt > STALL_MS) {
    if (spinRecoveries < 2) {
      spinRecoveries += 1;
      log(`STALL #${spinRecoveries}: no DB change ${Math.round((Date.now() - lastSigAt) / 60000)} min (TB-2 busy-spin?) — kill + tracker resume + продолжаю`);
      await stopEverything(epicId);
      await new Promise(r => setTimeout(r, 32_000)); // лиз контроллера 30с
      try {
        const r = await fetch(`${TRACKER}/api/factory/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project_id: projectId }) });
        const body = await r.json().catch(() => ({}));
        log(`recovery resume: ${JSON.stringify(body)}`);
        if (r.ok && body.ok) { lastSig = ''; lastSigAt = Date.now(); deadline += 15 * 60_000; outcome = null; continue; }
      } catch (e) { log(`recovery resume failed: ${e.message}`); }
      outcome = 'stalled'; failReason = `recovery resume failed after stall #${spinRecoveries}`;
      break;
    }
    log(`STALL x${spinRecoveries}: recovery budget exhausted — stopping`);
    await stopEverything(epicId);
    outcome = 'stalled'; failReason = `no change since ${new Date(lastSigAt).toISOString()} (recoveries=${spinRecoveries})`;
    break;
  }
  if (Date.now() % 60000 < 5100) {
    log(`lr=${lr.status}/${lr.current_stage_id} stages=[${stages.map(s => s.status).join(',')}] tasks=${tasks.done ?? 0}/${tasks.n} workers={${workers.map(w => `${w.state}:${w.n}`).join(',')}} hb=${hb.hb ?? '-'}`);
  }
}
if (!outcome) { await stopEverything(epicId); outcome = 'fail'; failReason = 'timeout'; }

// ── пост-стоп: грязная граница? статистика; журналы ────────────────────────
await new Promise(r => setTimeout(r, 5000));
const dirty = round !== 'W3'
  ? db.prepare(`SELECT count(*) n FROM tasks WHERE epic_id=? AND workflow_stage LIKE ? AND status IN ('in_progress','review_in_progress')`)
      .get(epicId, round === 'W1' ? 'formalization%' : 'development%').n
  : 0;
const workersFinal = db.prepare('SELECT state, count(*) n FROM worker_executions WHERE epic_id=? GROUP BY state').all(epicId);
const artifacts = db.prepare('SELECT type, status, count(*) n FROM artifacts WHERE epic_id=? GROUP BY type,status ORDER BY type').all(epicId);
const durationMin = Math.round((Date.now() - startedAt.getTime()) / 60000);

const glyph = outcome === 'pass' ? '✅' : outcome === 'stalled' ? '⏸' : '✖';
try {
  journalProject([
    `### Result ${round}: ${outcome.toUpperCase()} ${glyph}`,
    `- duration: ${durationMin} min; lifecycle=${lifecycleRunId}; project=${projectId}; epic=${epicId}`,
    `- dirty-boundary cards: ${dirty}; workers: ${workersFinal.map(w => `${w.state}:${w.n}`).join(' ') || 'none'}`,
    `- artifacts: ${artifacts.map(a => `${a.type}/${a.status}x${a.n}`).join(' ') || 'none'}`,
    failReason ? `- reason: ${failReason}` : '',
    '',
  ]);
} catch (e) { console.error('journal write failed:', e.message); }
const jr = `| ${pid} | ${round} | shared | ${startedAt.toISOString().slice(11, 16)} | ${durationMin}m | ${outcome}${dirty ? ' (dirty:' + dirty + ')' : ''} | ${workersFinal.map(w => `${w.n}${w.state}`).join('/')} | 0 | ${artifacts.map(a => `${a.type}:${a.n}`).join(',') || '—'} | ${failReason ? failReason.slice(0, 40) : '—'} |`;
try { updateRoundJournal(jr); } catch (e) { console.error('round journal update failed:', e.message); }
try { updateStatusGrid(glyph, dirty ? `граница dirty (${dirty} карт.)` : outcome === 'pass' ? 'граница чистая' : outcome); } catch (e) { console.error('status grid update failed:', e.message); }
log(`DONE outcome=${outcome} dirty=${dirty} duration=${durationMin}m`);
db.close();
process.exit(outcome === 'pass' ? 0 : 1);
