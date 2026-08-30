// Default Discovery Desk (M5+): accepts an idea, runs the brief skill, lands
// discovery/brief.md in the product repo. Hermetic via mode:'echo'.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-discovery-'));
process.env.DB_PATH = path.join(dir, 'discovery.db');
const productRepo = path.join(dir, 'product-repo');
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: productRepo });
spawnSync('git', ['config', 'user.email', 'desk@test'], { cwd: productRepo });
spawnSync('git', ['config', 'user.name', 'desk'], { cwd: productRepo });

const { getDb, closeDb } = await import('../dist/db.js');
const { resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution } = await import('../dist/kernel/executions.js');
const { startDiscovery, DEFAULT_WORKSHOPS } = await import('../dist/workshops.js');

const db = getDb();
const WORKER = fileURLToPath(new URL('../dist/runtime/worker.js', import.meta.url));

async function driveWithRealWorkers(runId) {
  const claimed = new Set();
  for (let i = 0; i < 12; i++) {
    const result = resumeRun(db, runId);
    if (result.stop === 'terminal') return result.status;
    const queued = getEvents(db, runId)
      .filter((e) => e.type === 'execution.scheduled')
      .map((e) => JSON.parse(e.payload_json).execution_id)
      .filter((id) => !claimed.has(id));
    if (queued.length === 0) throw new Error('no queued execution and no progress');
    const { lease } = claimExecution(db, queued[0]);
    claimed.add(queued[0]);
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [WORKER, '--execution', queued[0]], {
        env: { ...process.env, SAGA_LEASE: lease },
        stdio: 'ignore',
      });
      child.on('exit', resolve);
    });
    if (code !== 0) throw new Error(`worker exited ${code}`);
  }
  throw new Error('discovery run did not settle in budget');
}

test('workshops registry describes the discovery desk', () => {
  const shape = DEFAULT_WORKSHOPS.discovery.graph.nodes;
  assert.deepEqual(Object.keys(shape), ['idea', 'brief', 'quality', 'artifact']);
  assert.equal(shape.brief.type, 'llm');
  assert.equal(shape.quality.type, 'gate');
  assert.equal(shape.artifact.type, 'effect');
});

test('discovery desk: idea in → brief skill → artifact committed', async () => {
  const idea = 'Кофейня «Тёплый пар» — сайт-визитка со свежей обжаркой';
  const started = startDiscovery(db, { idea, repo: productRepo, mode: 'echo' });
  assert.equal(started.repo, productRepo);
  assert.equal(started.status, 'running');

  const status = await driveWithRealWorkers(started.runId);
  assert.equal(status, 'success');

  // the artifact exists in the product repo and carries the idea
  const brief = readFileSync(path.join(productRepo, 'discovery', 'brief.md'), 'utf8');
  assert.ok(brief.includes(idea), 'artifact carries the idea');

  const commit = spawnSync('git', ['log', '--format=%s'], { cwd: productRepo, encoding: 'utf8' });
  assert.match(commit.stdout, /discovery: brief artifact/);

  // kernel evidence: the gate ran its contract checks (echo can trip a repair
  // cycle: the brief contract regexes fail on the raw prompt, the feedback
  // text satisfies them → accepted), the effect settled applied
  assert.ok(getEvents(db, started.runId).filter((e) => e.type === 'revision.sealed').length >= 1);
  assert.equal(JSON.parse(
    getEvents(db, started.runId).filter((e) => e.type === 'effect.receipted').at(-1).payload_json
  ).outcome, 'applied');
});

test('discovery desk without an idea fails fast', () => {
  assert.throws(() => startDiscovery(db, { idea: '   ', repo: productRepo, mode: 'echo' }), /IDEA_REQUIRED/);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
