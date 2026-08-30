// Focused repro of the split→join→effect flow (same as development.test.mjs
// case 2, but plain script with step logging to find any stall).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-repro-'));
process.env.DB_PATH = path.join(dir, 'repro.db');
const repo = path.join(dir, 'repo');
mkdirSync(repo, { recursive: true });
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
spawnSync('git', ['config', 'user.email', 'r@t'], { cwd: repo });
spawnSync('git', ['config', 'user.name', 'r'], { cwd: repo });

const { getDb, closeDb } = await import('../../dist/db.js');
const { runGraph, resumeRun } = await import('../../dist/kernel/runner.js');
const { getEvents } = await import('../../dist/events.js');
const { claimExecution } = await import('../../dist/kernel/executions.js');
const { sweep } = await import('../../dist/kernel/sweep.js');

const db = getDb();
const WORKER = fileURLToPath(new URL('../../dist/runtime/worker.js', import.meta.url));
const log = (m) => console.log(`[repro ${new Date().toISOString().slice(14, 23)}] ${m}`);

const filesJson = (n) => JSON.stringify([{ path: `${n}.html`, content: `<!DOCTYPE html><html><body>${n}</body></html>` }]);
const graph = JSON.stringify({
  nodes: {
    input: { type: 'emit', parameters: { items: [
      { json: { title: 'T1', files_json: filesJson('page1') } },
      { json: { title: 'T2', files_json: filesJson('page2') } },
    ] } },
    tasks: { type: 'split', parameters: { child: { type: 'llm', parameters: { mode: 'echo', prompt: '{{files_json}}', timeouts: { heartbeat_s: 5, schedule_to_start_s: 30 } } } } },
    merge: { type: 'join', parameters: {} },
    parse_files: { type: 'json_parse', parameters: {} },
    integrate: { type: 'effect', parameters: { mode: 'git', repo, branch: 'main', message: 'dev: tasks', files_from: 'items' } },
  },
  connections: {
    input: { main: [[{ node: 'tasks' }]] },
    tasks: { main: [[{ node: 'merge' }]] },
    merge: { main: [[{ node: 'parse_files' }]] },
    parse_files: { main: [[{ node: 'integrate' }]] },
  },
});

const run = runGraph(db, graph, { name: 'repro' });
log(`run ${run.runId.slice(0, 8)} ${run.status}/${run.stop}`);
const claimed = new Set();
for (let i = 0; i < 30; i++) {
  const result = resumeRun(db, run.runId);
  log(`drive#${i} → ${result.status}/${result.stop}`);
  if (result.stop === 'terminal') break;
  const queued = getEvents(db, run.runId)
    .filter((e) => e.type === 'execution.scheduled')
    .map((e) => JSON.parse(e.payload_json).execution_id)
    .filter((id) => !claimed.has(id));
  log(`queued: ${queued.length}${queued.length ? ' → spawn' : ' → STALL (no progress, no queue)'}`);
  if (queued.length === 0) { log('no queue → sweep (typed wait for retry decision)'); sweep(db); continue; }
  for (const id of queued) {
    const claim = claimExecution(db, id);
    if (!claim) { log(`claim failed for ${id.slice(0, 8)}`); continue; }
    claimed.add(id);
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [WORKER, '--execution', id], {
        env: { ...process.env, SAGA_LEASE: claim.lease },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr.on('data', (d) => process.stderr.write(`[worker-err] ${d}`));
      child.on('exit', (c) => resolve(c));
    });
    log(`worker ${id.slice(0, 8)} exit=${code}`);
  }
}
try {
  log(`page1: ${readFileSync(path.join(repo, 'page1.html'), 'utf8').slice(0, 40)}`);
  log(`page2: ${readFileSync(path.join(repo, 'page2.html'), 'utf8').slice(0, 40)}`);
} catch (e) {
  console.error('FILES MISSING', e.message);
  for (const ev of getEvents(db, run.runId)) {
    const p = JSON.parse(ev.payload_json);
    if (ev.type === 'node.failed') console.error('node.failed:', p.node_id, '|', p.error);
    if (ev.type === 'execution.failed') console.error('exec.failed:', p.node_id, '|', p.message);
    if (ev.type === 'node.completed' && (p.node_id === 'merge' || String(p.node_id).startsWith('tasks::'))) {
      const { getMaterial } = await import('../../dist/materials.js');
      console.error(`material ${p.node_id}:`, getMaterial(db, p.output_digest).content.slice(0, 160));
    }
  }
  process.exit(4);
}
closeDb();
rmSync(dir, { recursive: true, force: true });
log('OK');
