#!/usr/bin/env node
/**
 * Night lifecycle-renewal driver — GB-4 recovery.
 *
 * The mid-flight allowedTools change (GB-4) pinned-vs-live check-plan
 * mismatch poisoned every formalization workplace created before the fix
 * (PRODUCTION_CELL_PLAN_BINDING_MISMATCH). The renewal: abandon the stale
 * lifecycle and start a fresh one per project via the canonical `rerun` verb;
 * each new lifecycle re-runs Discovery -> Formalization -> Development to
 * runnable-local (all workshops except Delivery) under the fixed profile.
 *
 *   node scripts/testbed-night-rerun.mjs [--only=P01,P02] [--timeout-min=N]
 *
 * `factory.mjs rerun` blocks until the engine exits, so projects run strictly
 * one at a time (rate=1). Log: <testbed>/night-rerun.log.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTBED_DIR = process.env.SAGA_TESTBED_DIR || '.factory-testbed';
const TESTBED = path.join(ROOT, TESTBED_DIR);
const DB = path.join(TESTBED, 'factory.sqlite');
const LOG = path.join(TESTBED, 'night-rerun.log');
const MODEL = process.env.SAGA_TESTBED_MODEL || 'glm-4.6';

const reg = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'testing', 'projects.json'), 'utf8'));
const args = process.argv.slice(2);
const onlyArg = args.find(a => a.startsWith('--only='));
const timeoutArg = args.find(a => a.startsWith('--timeout-min='));
const timeoutMin = timeoutArg ? Number(timeoutArg.split('=')[1]) : 240;
let pids = reg.projects.map(p => p.id);
if (onlyArg) pids = onlyArg.split('=')[1].split(',').filter(x => reg.projects.some(p => p.id === x));

const line = s => appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`, 'utf8');
mkdirSync(TESTBED, { recursive: true });
line(`NIGHT-RERUN START pids=${pids.join(',')} model=${MODEL} timeout=${timeoutMin}m`);

// DB project id by slug (projects were provisioned with name=slug).
const { default: Database } = await import('better-sqlite3');
const db = new Database(DB, { readonly: true });
const slugToId = {};
for (const p of reg.projects) {
  const row = db.prepare('SELECT id FROM projects WHERE name=?').get(p.slug);
  slugToId[p.id] = row?.id ?? null;
}
db.close();

for (const pid of pids) {
  const dbId = slugToId[pid];
  if (!dbId) { line(`SKIP ${pid}: not in DB`); continue; }
  line(`RERUN ${pid} (db project ${dbId}) START`);
  const r = spawnSync('node', [
    'scripts/factory.mjs', 'rerun', DB, String(dbId),
    '--model', MODEL, '--reason', 'GB-4 check-plan binding renewal after allowedTools fix',
  ], {
    cwd: ROOT, encoding: 'utf8', timeout: timeoutMin * 60_000,
    env: { ...process.env, SAGA_TESTBED_DIR: TESTBED_DIR },
    maxBuffer: 1 << 26,
  });
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-2).join(' | ');
  line(`RERUN ${pid} END code=${r.status}${r.signal ? ` signal=${r.signal}` : ''} ${tail.slice(-300)}`);
}
line('NIGHT-RERUN DONE');
