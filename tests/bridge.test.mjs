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

after(() => {
  bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});
