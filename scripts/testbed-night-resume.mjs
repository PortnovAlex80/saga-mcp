#!/usr/bin/env node
/**
 * Resume/continue driver for PARKED projects (second parallel lane).
 *
 *   node scripts/testbed-night-resume.mjs [--only=P02,P06] [--timeout-min=N]
 *
 * Per project, by the latest lifecycle's state:
 *   paused  -> `factory.mjs continue` (explicit resume of the parked run)
 *   failed  -> `factory.mjs rerun`    (abandon poisoned + fresh start)
 *   completed/running elsewhere -> skip
 * `factory.mjs` blocks until the engine exits, so this lane runs ONE project
 * at a time. Log: <testbed>/night-resume.log.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTBED_DIR = process.env.SAGA_TESTBED_DIR || '.factory-testbed';
const TESTBED = path.join(ROOT, TESTBED_DIR);
const DB = path.join(TESTBED, 'factory.sqlite');
const LOG = path.join(TESTBED, 'night-resume.log');
const MODEL = process.env.SAGA_TESTBED_MODEL || 'glm-4.6';

const reg = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'testing', 'projects.json'), 'utf8'));
const args = process.argv.slice(2);
const onlyArg = args.find(a => a.startsWith('--only='));
const timeoutArg = args.find(a => a.startsWith('--timeout-min='));
const timeoutMin = timeoutArg ? Number(timeoutArg.split('=')[1]) : 240;
const TRACKER = `http://localhost:${process.env.SAGA_TESTBED_TRACKER_PORT || '4321'}`;
let pids = ['P01', 'P02', 'P04', 'P06', 'P07', 'P08'];
if (onlyArg) pids = onlyArg.split('=')[1].split(',').filter(x => reg.projects.some(p => p.id === x));

const line = s => appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`, 'utf8');
mkdirSync(TESTBED, { recursive: true });

const ro = new Database(DB, { readonly: true });
const plan = [];
for (const pid of pids) {
  const slug = reg.projects.find(p => p.id === pid).slug;
  const proj = ro.prepare('SELECT id FROM projects WHERE name=?').get(slug);
  if (!proj) { line(`SKIP ${pid}: no project row`); continue; }
  const lr = ro.prepare('SELECT id,status,terminal_status FROM factory_lifecycle_runs WHERE project_id=? ORDER BY id DESC LIMIT 1').get(proj.id);
  if (!lr) { plan.push({ pid, slug, dbId: proj.id, verb: 'rerun' }); continue; }
  if (lr.terminal_status === 'completed') { line(`SKIP ${pid}: lifecycle ${lr.id} already completed`); continue; }
  if (lr.status === 'running') { line(`SKIP ${pid}: lifecycle ${lr.id} is running elsewhere`); continue; }
  // Paused lifecycles here all predate the GB-8/GB-10 fixes (their cells
  // hit the old defects and parked on repair budgets): a plain resume just
  // re-hits the explicit-pause boundary. The correct re-drive is abandon +
  // fresh rerun under the fixed profile.
  const verb = 'rerun';
  plan.push({
    pid, slug, dbId: proj.id, verb, lrid: lr.id,
    abandonFirst: lr.status !== 'failed',
    reason: `${lr.status}/${lr.terminal_status ?? '-'}`,
  });
}
ro.close();

line(`NIGHT-RESUME START plan=${plan.map(p => `${p.pid}:${p.verb}`).join(',')} model=${MODEL}`);

async function resumeViaTracker(dbId, pid) {
  const r = await fetch(`${TRACKER}/api/factory/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project_id: dbId }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.ok) throw new Error(`tracker resume failed: ${JSON.stringify(body).slice(0, 200)}`);
  // Poll the project's latest lifecycle until terminal or timeout.
  const deadline = Date.now() + timeoutMin * 60_000;
  const poll = new Database(DB, { readonly: true });
  let last = '';
  try {
    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 15_000));
      const lr = poll.prepare('SELECT id,status,terminal_status,error FROM factory_lifecycle_runs WHERE project_id=? ORDER BY id DESC LIMIT 1').get(dbId);
      const sig = JSON.stringify(lr);
      if (sig !== last) { last = sig; line(`POLL ${pid}: ${sig.slice(0, 180)}`); }
      if (lr.terminal_status === 'completed') return `completed/${lr.terminal_status}`;
      if (lr.status === 'failed') return `failed: ${(lr.error || '').slice(0, 120)}`;
      // A paused-with-hanging state for >10 min with no engine → the engine
      // exited on explicit pause; treat as this lane's terminal outcome.
    }
    return `timeout-${timeoutMin}m`;
  } finally { poll.close(); }
}

for (const p of plan) {
  line(`RUN ${p.pid} (${p.slug}) verb=${p.verb} ${p.reason ?? ''}`);
  if (p.verb === 'resume') {
    try {
      const outcome = await resumeViaTracker(p.dbId, p.pid);
      line(`RUN ${p.pid} END verb=resume outcome=${outcome}`);
    } catch (e) {
      line(`RUN ${p.pid} END verb=resume ERROR ${e.message}`);
    }
    continue;
  }
  if (p.abandonFirst) {
    const a = spawnSync('node', ['scripts/factory.mjs', 'abandon', DB, String(p.dbId), '--reason', 'night resume lane: parked pre-fix lifecycle'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000, env: process.env });
    line(`ABANDON ${p.pid} code=${a.status} ${((a.stderr || '') + (a.stdout || '')).trim().slice(-120)}`);
  }
  const r = spawnSync('node', [
    'scripts/factory.mjs', 'rerun', DB, String(p.dbId),
    '--model', MODEL, '--reason', 'night resume lane: parked project re-drive',
  ], {
    cwd: ROOT, encoding: 'utf8', timeout: timeoutMin * 60_000,
    env: process.env, maxBuffer: 1 << 26,
  });
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-2).join(' | ');
  line(`RUN ${p.pid} END verb=rerun code=${r.status}${r.signal ? ` signal=${r.signal}` : ''} ${tail.slice(-250)}`);
}
line('NIGHT-RESUME DONE');
