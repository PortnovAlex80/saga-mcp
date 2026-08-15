#!/usr/bin/env node
/**
 * saga-status.mjs — единый инструмент мониторинга saga3 lifecycle прогона.
 *
 * Подкоманды:
 *   status [--epic=N] [--watch]    — snapshot прогресса (lifecycle, tasks, artifacts, workers)
 *   thoughts [--task=N] [--tail=N] — мысли активного/указанного worker'а (live)
 *   artifacts [--epic=N]           — список артефактов с типами и статусами
 *   cache [--epic=N]               — содержимое test draft-cache
 *   log [--task=N] [--tail=N]      — сырой лог worker'а (последние N строк JSON)
 *   watch [--epic=N] [--interval=S] — status + thoughts в цикле (каждые S сек)
 *
 * Usage:
 *   node tools/saga-status.mjs status
 *   node tools/saga-status.mjs thoughts --task=5 --tail=3
 *   node tools/saga-status.mjs watch --interval=60
 *   DB_PATH=other.db node tools/saga-status.mjs status
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const DB_PATH = process.env.DB_PATH ?? 'C:/Users/user/.zcode/saga.db';

// --- better-sqlite3 loader (sync require via createRequire) ---
const require = createRequire(import.meta.url);
let _db = null;
function getDb() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  _db = new Database(DB_PATH, { readonly: true });
  return _db;
}

function parseArgs(argv) {
  const command = argv[2] ?? 'status';
  const options = { epic: 1, tail: 3, interval: 60, task: null };
  for (const arg of argv.slice(3)) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) {
      const key = m[1];
      const val = m[2];
      if (key === 'epic' || key === 'tail' || key === 'interval' || key === 'task') {
        options[key] = Number(val);
      } else {
        options[key] = val;
      }
    }
  }
  return { command, options };
}

function fmt(table) {
  if (!table || table.length === 0) return '  (empty)';
  return table.map(r => Object.entries(r).map(([k, v]) => `${k}=${v ?? ''}`).join(' | ')).join('\n');
}

// ============================================================
// status — snapshot прогресса
// ============================================================
async function cmdStatus(options) {
  const db = getDb();
  const epic = options.epic;
  console.log(`\n=== SAGA STATUS (epic ${epic}) ${new Date().toLocaleTimeString()} ===\n`);

  // Lifecycle
  try {
    const lr = db.prepare('SELECT id, status, current_stage_id, terminal_status FROM saga3_lifecycle_runs WHERE epic_id=? ORDER BY id DESC LIMIT 1').get(epic);
    if (lr) console.log(`Lifecycle #${lr.id}: ${lr.status}${lr.terminal_status ? ' → ' + lr.terminal_status : ''} | stage: ${lr.current_stage_id ?? '-'}`);
    else console.log('Lifecycle: (none)');
  } catch { console.log('Lifecycle: (table missing)'); }

  // Process runs
  try {
    const prs = db.prepare('SELECT id, module_name, status, local_outcome FROM saga3_process_runs WHERE epic_id=? ORDER BY id').all(epic);
    console.log('\nProcess Runs:');
    for (const pr of prs) {
      const outcome = pr.local_outcome ? ` → ${pr.local_outcome}` : '';
      console.log(`  #${pr.id} ${pr.module_name}: ${pr.status}${outcome}`);
    }
    if (prs.length === 0) console.log('  (none)');
  } catch { console.log('Process Runs: (table missing)'); }

  // Tasks
  try {
    const tasks = db.prepare('SELECT id, status, task_kind, assigned_to FROM tasks WHERE epic_id=? ORDER BY id').all(epic);
    console.log(`\nTasks (${tasks.length}):`);
    for (const t of tasks) {
      const assignee = t.assigned_to ? ` [${String(t.assigned_to).substring(0, 20)}]` : '';
      console.log(`  #${t.id} ${String(t.status).padEnd(18)} ${t.task_kind ?? '?'}${assignee}`);
    }
  } catch { console.log('Tasks: (table missing)'); }

  // Artifacts
  try {
    const arts = db.prepare("SELECT type, status, COUNT(*) as n FROM artifacts WHERE epic_id=? GROUP BY type, status ORDER BY type, status").all(epic);
    console.log('\nArtifacts:');
    for (const a of arts) {
      console.log(`  ${String(a.type).padEnd(16)} ${String(a.status).padEnd(12)} ×${a.n}`);
    }
    if (arts.length === 0) console.log('  (none)');
  } catch { console.log('Artifacts: (table missing)'); }

  // Active worker
  try {
    const we = db.prepare("SELECT execution_id, task_id, state, phase, pid FROM worker_executions WHERE epic_id=? AND state='running' ORDER BY started_at DESC LIMIT 1").get(epic);
    if (we) {
      console.log(`\nActive worker: ${we.execution_id} | task=${we.task_id} | ${we.state}/${we.phase} | pid=${we.pid}`);
    } else {
      console.log('\nActive worker: (none)');
    }
  } catch { console.log('Active worker: (table missing)'); }
}

// ============================================================
// thoughts — живые мысли модели из worker лога
// ============================================================
function findLatestLogForTask(db, taskId) {
  // Find the most recent log file for this task
  const we = db.prepare('SELECT log_path FROM worker_executions WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(taskId);
  return we?.log_path ?? null;
}

function findLatestActiveLog(db, epic) {
  const we = db.prepare("SELECT log_path FROM worker_executions WHERE epic_id=? AND state='running' ORDER BY started_at DESC LIMIT 1").get(epic);
  return we?.log_path ?? null;
}

function readJsonlEntries(logPath, type, tail) {
  if (!logPath || !existsSync(logPath)) return [];
  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());
  const matching = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (type === 'thinking') {
        const contents = obj.message?.content;
        if (Array.isArray(contents)) {
          const t = contents.find(c => c.type === 'thinking');
          if (t) matching.push({ ts: obj.timestamp, text: t.thinking });
        }
      } else if (type === 'text') {
        const contents = obj.message?.content;
        if (Array.isArray(contents)) {
          const t = contents.find(c => c.type === 'text');
          if (t) matching.push({ ts: obj.timestamp, text: t.text });
        }
      } else {
        matching.push({ ts: obj.timestamp, type: obj.type, subtype: obj.subtype ?? '' });
      }
    } catch { /* skip */ }
  }
  return matching.slice(-tail);
}

async function cmdThoughts(options) {
  const db = getDb();
  const logPath = options.task
    ? findLatestLogForTask(db, options.task)
    : findLatestActiveLog(db, options.epic);
  console.log(`\n=== WORKER THOUGHTS ${options.task ? '(task ' + options.task + ')' : '(active)'} ===`);
  console.log(`log: ${logPath ?? '(not found)'}\n`);

  const entries = readJsonlEntries(logPath, 'thinking', options.tail);
  if (entries.length === 0) {
    console.log('(no thinking entries yet)');
  }
  for (const e of entries) {
    console.log(`--- ${e.ts} ---`);
    console.log(e.text.substring(0, 500));
    console.log('');
  }

  // Also show last text output
  const texts = readJsonlEntries(logPath, 'text', 1);
  if (texts.length > 0) {
    console.log('--- LAST TEXT OUTPUT ---');
    console.log(texts[0].text.substring(0, 600));
  }
}

// ============================================================
// log — сырой лог (последние N entries)
// ============================================================
async function cmdLog(options) {
  const db = getDb();
  const logPath = options.task
    ? findLatestLogForTask(db, options.task)
    : findLatestActiveLog(db, options.epic);
  console.log(`\n=== WORKER LOG ${options.task ? '(task ' + options.task + ')' : '(active)'} ===`);
  console.log(`log: ${logPath ?? '(not found)'}\n`);

  const entries = readJsonlEntries(logPath, 'any', options.tail);
  for (const e of entries) {
    console.log(`${e.ts} | ${e.type} ${e.subtype}`);
  }
  if (entries.length === 0) console.log('(empty or not found)');
}

// ============================================================
// artifacts — детальный список
// ============================================================
async function cmdArtifacts(options) {
  const db = getDb();
  const epic = options.epic;
  console.log(`\n=== ARTIFACTS (epic ${epic}) ===\n`);
  try {
    const arts = db.prepare('SELECT id, type, code, status, substr(title,1,55) as title FROM artifacts WHERE epic_id=? ORDER BY type, id').all(epic);
    for (const a of arts) {
      console.log(`  #${String(a.id).padStart(3)} ${String(a.type).padEnd(16)} ${String(a.code ?? '').padEnd(6)} ${String(a.status).padEnd(10)} ${a.title}`);
    }
    if (arts.length === 0) console.log('  (none)');
    console.log(`\nTotal: ${arts.length}`);
  } catch (e) { console.log('Error:', e.message); }
}

// ============================================================
// cache — test draft-cache
// ============================================================
function findWorkspaceRoot(db, epic) {
  // Try to get local_path from project_repositories
  try {
    const r = db.prepare('SELECT local_path FROM project_repositories WHERE project_id=(SELECT project_id FROM epics WHERE id=?) AND status="active" LIMIT 1').get(epic);
    if (r?.local_path) return r.local_path;
  } catch { /* ignore */ }
  return 'C:/Temp/autism-buttons-workspace';
}

async function cmdCache(options) {
  const db = getDb();
  const epic = options.epic;
  const ws = findWorkspaceRoot(db, epic);
  const cacheRoot = path.join(ws, '.saga', 'test-draft-cache', 'epics', String(epic));
  console.log(`\n=== DRAFT CACHE (epic ${epic}) ===`);
  console.log(`workspace: ${ws}`);
  console.log(`cache root: ${cacheRoot}\n`);

  if (!existsSync(cacheRoot)) {
    console.log('(cache dir not found)');
    return;
  }

  function walk(dir, depth = 0) {
    const prefix = '  '.repeat(depth);
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries.sort()) {
      const full = path.join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        console.log(`${prefix}${name}/`);
        walk(full, depth + 1);
      } else {
        const size = st.size;
        if (name.endsWith('.json') && !name.includes('history')) {
          try {
            const m = JSON.parse(readFileSync(full, 'utf8'));
            console.log(`${prefix}${name} (${size}b) → outcome=${m.lastOutcome} failCount=${m.repeatedFailureCount} updated=${m.updatedAt?.substring(11, 19)}`);
          } catch {
            console.log(`${prefix}${name} (${size}b)`);
          }
        } else {
          console.log(`${prefix}${name} (${size}b)`);
        }
      }
    }
  }
  walk(cacheRoot);
}

// ============================================================
// watch — status + thoughts в цикле
// ============================================================
async function cmdWatch(options) {
  while (true) {
    console.clear?.();
    await cmdStatus(options);
    console.log('\n' + '='.repeat(60));
    try {
      await cmdThoughts(options);
    } catch { /* ignore */ }
    console.log(`\n[next refresh in ${options.interval}s — Ctrl+C to exit]`);
    await new Promise(r => setTimeout(r, options.interval * 1000));
  }
}

// ============================================================
// help
// ============================================================
function cmdHelp() {
  console.log(`
saga-status.mjs — мониторинг saga3 lifecycle прогона

Подкоманды:
  status [--epic=N]           snapshot прогресса (lifecycle, tasks, artifacts, workers)
  thoughts [--task=N] [--tail=N]  мысли активного/указанного worker'а (live)
  log [--task=N] [--tail=N]   сырой лог worker'а (типы entries)
  artifacts [--epic=N]        детальный список артефактов
  cache [--epic=N]            содержимое test draft-cache
  watch [--epic=N] [--interval=S]  status + thoughts в цикле

Опции:
  --epic=N        epic id (по умолчанию 1)
  --task=N        конкретный task для thoughts/log
  --tail=N        сколько последних entries показать (по умолчанию 3)
  --interval=S    интервал watch в секундах (по умолчанию 60)

Env:
  DB_PATH         путь к saga.db (по умолчанию C:/Users/user/.zcode/saga.db)

Примеры:
  node tools/saga-status.mjs status
  node tools/saga-status.mjs thoughts --task=5 --tail=5
  node tools/saga-status.mjs watch --interval=30
  node tools/saga-status.mjs cache
  DB_PATH=/tmp/test.db node tools/saga-status.mjs status
`);
}

// ============================================================
// main
// ============================================================
const { command, options } = parseArgs(process.argv);
switch (command) {
  case 'status': await cmdStatus(options); break;
  case 'thoughts': await cmdThoughts(options); break;
  case 'log': await cmdLog(options); break;
  case 'artifacts': await cmdArtifacts(options); break;
  case 'cache': await cmdCache(options); break;
  case 'watch': await cmdWatch(options); break;
  case 'help': case '--help': case '-h': default: cmdHelp(); break;
}

if (_db) _db.close();
