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

after(() => {
  bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});
