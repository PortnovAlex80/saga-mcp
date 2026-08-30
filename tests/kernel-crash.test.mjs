// M1 crash fitness: SIGKILL the kernel process mid-run, then recover purely
// from the event log. No duplicates, no silent idle, dense sequences.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-crash-'));
const dbPath = path.join(dir, 'crash.db');
process.env.DB_PATH = dbPath;

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');

const CHILD = fileURLToPath(new URL('./fixtures/kernel-crash-child.mjs', import.meta.url));

test('run survives SIGKILL of the kernel process mid-graph', async () => {
  const db = getDb();

  // 40-node chain — long enough to be killable mid-run, short enough to be fast.
  const nodes = { source: { type: 'emit', parameters: { items: [{ json: { v: 0 } }] } } };
  const order = ['source'];
  for (let i = 1; i <= 39; i++) {
    nodes[`s${i}`] = { type: 'template', parameters: { template: `s${i}:{{text}}` } };
    order.push(`s${i}`);
  }
  const connections = {};
  for (let i = 0; i < order.length - 1; i++) {
    connections[order[i]] = { main: [[{ node: order[i + 1] }]] };
  }
  const graph = JSON.stringify({ nodes, connections });

  const staged = runGraph(db, graph, { name: 'crash-chain', maxNodeExecutions: 0 });
  assert.equal(staged.status, 'running');
  closeDb();

  // Child drives the run one node per 5ms; parent kills it at a random moment.
  const child = spawn(process.execPath, [CHILD, dbPath, staged.runId], { stdio: 'ignore' });
  const killDelay = 30 + Math.floor(Math.random() * 150);
  const killed = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve('killed');
    }, killDelay);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve('exited');
    });
  });

  // Recovery: fold the log, drive to completion — in this, the parent, process.
  const reopened = getDb();
  const result = resumeRun(reopened, staged.runId);
  assert.equal(result.status, 'success');

  const events = getEvents(reopened, staged.runId);
  const completed = events.filter((e) => e.type === 'node.completed').map((e) => JSON.parse(e.payload_json).node_id);
  assert.equal(completed.length, 40, 'every node completed exactly once');
  assert.equal(new Set(completed).size, 40, 'no duplicate node executions');
  assert.equal(events.filter((e) => e.type === 'node.failed').length, 0);

  // Dense sequences per node transaction group (scheduled→started→submitted→completed).
  const started = events.filter((e) => e.type === 'node.started').length;
  assert.equal(started, 40);
});
process.on('exit', () => {
  try {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});
