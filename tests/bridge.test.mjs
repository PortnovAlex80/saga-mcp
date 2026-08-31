// M2 bridge E2E: HTTP → kernel → real worker process → sweep → success,
// all through the same origin that serves the desk.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-bridge-'));
process.env.DB_PATH = path.join(dir, 'bridge.db');

const { startBridge } = await import('../dist/bridge.js');

const bridge = startBridge({ port: 0, sweepMs: 50, maxWorkers: 4 });
await new Promise((resolve) => setTimeout(resolve, 300)); // let listen() bind
const base = `http://localhost:${bridge.port}`;

const GRAPH = JSON.stringify({
  nodes: {
    source: { type: 'emit', parameters: { items: [{ json: { q: 'bridge' } }] } },
    brain: {
      type: 'llm',
      parameters: {
        mode: 'echo',
        sleep_ms: 100,
        timeouts: { heartbeat_s: 5, schedule_to_start_s: 5 },
        retry: { max_attempts: 2 },
      },
    },
    bundle: { type: 'collect' },
  },
  connections: {
    source: { main: [[{ node: 'brain' }]] },
    brain: { main: [[{ node: 'bundle' }]] },
  },
});

test('POST /api/graph runs the graph to success with a real spawned worker', async () => {
  const res = await fetch(`${base}/api/graph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'bridge-e2e', graph_json: GRAPH }),
  });
  const started = await res.json();
  assert.equal(res.status, 200);
  assert.ok(started.runId);

  let status = started.status;
  for (let i = 0; i < 50 && status !== 'success' && status !== 'error'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const poll = await fetch(`${base}/api/runs/${started.runId}`);
    status = (await poll.json()).run.status;
  }
  assert.equal(status, 'success', 'bridge sweep + worker complete the run');
});

test('event tail and desk static are served on the same origin', async () => {
  const runs = (await (await fetch(`${base}/api/state`)).json());
  assert.ok(runs.recent_runs.length >= 1);

  const runId = runs.recent_runs[0].id;
  const tail = await (await fetch(`${base}/api/runs/${runId}/events?limit=100`)).json();
  assert.ok(tail.events.some((e) => e.type === 'node.completed'));

  const index = await (await fetch(`${base}/`)).text();
  assert.ok(index.includes('Saga5 Desk'), 'desk index.html served');
});

test('board, artifacts and the operator write live on the same origin', async () => {
  const board = await (await fetch(`${base}/api/board`)).json();
  const cards = board.columns.flatMap((column) => column.cards);
  assert.ok(cards.some((card) => card.node_id === 'brain' && card.status === 'done'),
    'the finished activity is a done card');
  assert.deepEqual(
    board.columns.map((column) => column.status),
    ['todo', 'in_progress', 'review', 'blocked', 'done', 'failed']
  );

  const artifacts = await (await fetch(`${base}/api/artifacts`)).json();
  const artifact = artifacts.find((entry) => entry.node_id === 'brain');
  assert.ok(artifact, 'the worker material is an artifact');

  const query = new URLSearchParams({
    run_id: artifact.run_id,
    node: artifact.node_id,
    digest: artifact.digest,
    index: '0',
  });
  const body = await (await fetch(`${base}/api/artifact?${query}`)).json();
  assert.equal(typeof body.body, 'string');

  // The operator write path: a successful run is sealed and says so.
  const rejected = await fetch(`${base}/api/runs/${artifact.run_id}/nodes/brain/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'подмена', note: 'должно быть отказано' }),
  });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /RUN_SEALED/);
});

test('one start path: POST /api/workshops/:name/start validates declared inputs', async () => {
  const list = await (await fetch(`${base}/api/workshops`)).json();
  assert.ok(list.discovery.inputs.some((field) => field.name === 'idea'),
    'the workshop declares its own form');

  const missing = await fetch(`${base}/api/workshops/discovery/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /INPUT_REQUIRED/);

  const unknown = await fetch(`${base}/api/workshops/nosuch/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { idea: 'x' } }),
  });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json()).error, /WORKSHOP_UNKNOWN/);
});

test('the operator throttle caps hiring: two ready activities, one worker allowed', async () => {
  const applied = await (await fetch(`${base}/api/limits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_workers: 1, min_spawn_interval_ms: 0 }),
  })).json();
  assert.equal(applied.limits.max_workers, 1);

  const slow = (name) => ({
    type: 'llm',
    parameters: {
      mode: 'echo',
      sleep_ms: 2500,
      prompt: name,
      timeouts: { heartbeat_s: 20, schedule_to_start_s: 20, start_to_close_s: 30 },
    },
  });
  const started = await (await fetch(`${base}/api/graph`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'throttle',
      graph_json: JSON.stringify({
        nodes: { seed: { type: 'emit', parameters: { items: [{ json: { text: 'x' } }] } }, a: slow('a'), b: slow('b') },
        connections: { seed: { main: [[{ node: 'a' }, { node: 'b' }]] } },
      }),
    }),
  })).json();
  assert.ok(started.runId);

  await new Promise((resolve) => setTimeout(resolve, 900));
  const workers = await (await fetch(`${base}/api/workers`)).json();
  const mine = workers.live.filter((worker) => worker.run_id === started.runId);
  assert.equal(mine.filter((worker) => worker.status === 'running').length, 1,
    'only one worker is hired at a time');
  assert.equal(mine.filter((worker) => worker.status === 'new').length, 1,
    'the second stays queued — a cap, not a loss');
  assert.equal(workers.limits.max_workers, 1);

  // Lift the cap and let the run finish: a worker still holding the database
  // would make the temp-dir cleanup fail on Windows.
  await fetch(`${base}/api/limits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_workers: 4 }),
  });
  let status = 'running';
  for (let i = 0; i < 60 && status !== 'success' && status !== 'error'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    status = (await (await fetch(`${base}/api/runs/${started.runId}`)).json()).run.status;
  }
  assert.equal(status, 'success', 'the queued worker ran once a slot freed up');
});

after(async () => {
  bridge.stop({ killWorkers: true });
  await new Promise((resolve) => setTimeout(resolve, 300)); // let killed children release the db
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a worker's file handle; the temp dir is disposable */
  }
});
