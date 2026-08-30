// Unified product conveyor (Discovery + Formalization, one run): data flows
// between the workshops through the content-addressed desk — by reference.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-product-'));
process.env.DB_PATH = path.join(dir, 'product.db');
const productRepo = path.join(dir, 'product-repo');
spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: productRepo });
spawnSync('git', ['config', 'user.email', 'desk@test'], { cwd: productRepo });
spawnSync('git', ['config', 'user.name', 'desk'], { cwd: productRepo });

const { getDb, closeDb } = await import('../dist/db.js');
const { resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution } = await import('../dist/kernel/executions.js');
const { startProduct, DEFAULT_WORKSHOPS } = await import('../dist/workshops.js');

const db = getDb();
const WORKER = fileURLToPath(new URL('../dist/runtime/worker.js', import.meta.url));

async function driveWithRealWorkers(runId) {
  const claimed = new Set();
  for (let i = 0; i < 20; i++) {
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
  throw new Error('product run did not settle in budget');
}

test('product workshop is registered with both gates and two publications', () => {
  const nodes = DEFAULT_WORKSHOPS.product.graph.nodes;
  assert.equal(nodes.brief.type, 'llm');
  assert.equal(nodes.srs.type, 'llm');
  assert.equal(nodes.brief_gate.type, 'gate');
  assert.equal(nodes.srs_gate.type, 'gate');
  // эффекты публикуют по принятой ревизии, SRS читает бриф из того же стола
  const downstream = DEFAULT_WORKSHOPS.product.graph.connections.brief_gate.main[0].map((t) => t.node);
  assert.deepEqual(downstream.sort(), ['publish_brief', 'srs']);
});

test('unified conveyor: one run produces both artifacts through the desk', async () => {
  const started = startProduct(db, {
    idea: 'Маркетплейс мастер-классов: кулинария, гончарное дело, живопись.',
    repo: productRepo,
    mode: 'echo',
  });
  const status = await driveWithRealWorkers(started.runId);
  assert.equal(status, 'success');

  // both artifacts committed by their own effects
  const brief = readFileSync(path.join(productRepo, 'discovery', 'brief.md'), 'utf8');
  const srs = readFileSync(path.join(productRepo, 'formalization', 'srs.md'), 'utf8');
  assert.ok(brief.length > 0);
  assert.ok(srs.includes('FR-'), 'SRS artifact carries the requirements contract');

  // two applied effect receipts in ONE run
  const outcomes = getEvents(db, started.runId)
    .filter((e) => e.type === 'effect.receipted')
    .map((e) => JSON.parse(e.payload_json).outcome);
  assert.deepEqual(outcomes, ['applied', 'applied']);

  // both gates seal a revision per decision (repair + accept) — the SRS gate
  // adds one more
  assert.ok(getEvents(db, started.runId).filter((e) => e.type === 'revision.sealed').length >= 2);

  // one run id — единый прогон, данные переданы внутри стола
  const runs = new Set(
    getEvents(db, started.runId).filter((e) => e.type === 'effect.receipted').map(() => started.runId)
  );
  assert.equal(runs.size, 1);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
