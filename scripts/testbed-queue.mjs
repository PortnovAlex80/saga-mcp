#!/usr/bin/env node
/**
 * Testbed queue — последовательный прогон раунда по всем проектам.
 *
 *   node scripts/testbed-queue.mjs [--round=W1] [--from=P05] [--only=P01,P02]
 *
 * Для каждого PID: если проект уже в общей БД → testbed-run с --attach
 * (продолжить/довести до границы), иначе — полный прогон с провиженингом.
 * Результат каждого шага — в .factory-testbed/queue.log; очередь не
 * останавливается на неудаче отдельного проекта.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Кампанию задаёт env (см. testbed-run.mjs): каталог тестбеда и док-файлы.
const TESTBED_DIR = process.env.SAGA_TESTBED_DIR || '.factory-testbed';
const QUEUE_LOG = path.join(ROOT, TESTBED_DIR, 'queue.log');
const reg = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'testing', 'projects.json'), 'utf8'));

const args = process.argv.slice(2);
const round = (args.find(a => a.startsWith('--round=')) || '--round=W1').split('=')[1];
const fromArg = args.find(a => a.startsWith('--from='));
const onlyArg = args.find(a => a.startsWith('--only='));
let pids = reg.projects.map(p => p.id);
if (fromArg) { const i = pids.indexOf(fromArg.split('=')[1]); if (i >= 0) pids = pids.slice(i); }
if (onlyArg) pids = onlyArg.split('=')[1].split(',').filter(x => reg.projects.some(p => p.id === x));

const line = s => appendFileSync(QUEUE_LOG, s + '\n', 'utf8');
line(`${new Date().toISOString()} QUEUE-START round=${round} pids=${pids.join(',')}`);

const db = new Database(path.join(ROOT, TESTBED_DIR, 'factory.sqlite'), { readonly: true });
for (const pid of pids) {
  const def = reg.projects.find(p => p.id === pid);
  const exists = !!db.prepare('SELECT id FROM projects WHERE name=?').get(def.slug);
  const perProjectTimeout = { W1: 150, W2: 480, W3: 1440 }[round] || 150;
  const runArgs = ['scripts/testbed-run.mjs', pid, `--round=${round}`, `--timeout-min=${perProjectTimeout}`];
  if (exists) runArgs.push('--attach');
  const runDir = path.join(ROOT, TESTBED_DIR, 'runs', pid);
  mkdirSync(runDir, { recursive: true });
  const harnessLog = path.join(runDir, `harness-${round}.log`);
  line(`${new Date().toISOString()} RUN ${pid} mode=${exists ? 'attach' : 'provision'}`);
  // Внешний kill-лимит = внутренний дедлайн + 10 мин запаса (раньше был
  // жёсткий 160-мин кап — обрубал W3-прогоны с таймаутом 1440 мин).
  const r = spawnSync('node', runArgs, { cwd: ROOT, encoding: 'utf8', timeout: (perProjectTimeout + 10) * 60_000 });
  writeFileSync(harnessLog, `STDOUT:\n${r.stdout || ''}\nSTDERR:\n${r.stderr || ''}\nexit=${r.status}\n`, 'utf8');
  const tail = ((r.stderr || '').trim() || (r.stdout || '').trim()).split('\n').slice(-4).join(' | ');
  line(`${new Date().toISOString()} DONE ${pid} exit=${r.status} ${r.status === 0 ? 'PASS' : 'FAIL'} ${tail}`);
}
db.close();
line(`${new Date().toISOString()} QUEUE-END round=${round}`);
