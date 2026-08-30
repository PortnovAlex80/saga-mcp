// M2 worker-process fitness: a REAL `node dist/runtime/worker.js` process
// settles an echo activity; a crashed attempt leaves no trace and is reaped
// by the sweep into exactly one retry.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-worker-'));
process.env.DB_PATH = path.join(dir, 'worker.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution } = await import('../dist/kernel/executions.js');
const { sweep } = await import('../dist/kernel/sweep.js');
const { getMaterial } = await import('../dist/materials.js');

const db = getDb();
const WORKER = fileURLToPath(new URL('../dist/runtime/worker.js', import.meta.url));

function claimAndSpawn(executionId) {
  const { lease } = claimExecution(db, executionId);
  const child = spawn(process.execPath, [WORKER, '--execution', executionId], {
    env: { ...process.env, SAGA_LEASE: lease },
    stdio: 'ignore',
  });
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

function eventsOf(runId, type) {
  return getEvents(db, runId).filter((e) => e.type === type);
}

function lastScheduledId(runId) {
  return JSON.parse(eventsOf(runId, 'execution.scheduled').at(-1).payload_json).execution_id;
}

function makeGraph(brainParams) {
  return JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { q: 'ping' } }] } },
      brain: { type: 'llm', parameters: brainParams },
      bundle: { type: 'collect' },
    },
    connections: {
      source: { main: [[{ node: 'brain' }]] },
      brain: { main: [[{ node: 'bundle' }]] },
    },
  });
}

test('worker process performs an echo activity end to end', async () => {
  const run = runGraph(db, makeGraph({
    mode: 'echo',
    sleep_ms: 300,
    timeouts: { heartbeat_s: 5, schedule_to_start_s: 10 },
    retry: { max_attempts: 2 },
  }), { name: 'worker-e2e' });
  assert.equal(run.stop, 'waiting');

  const code = await claimAndSpawn(lastScheduledId(run.runId));
  assert.equal(code, 0, 'worker exits cleanly');

  assert.equal(resumeRun(db, run.runId).status, 'success');
  const brain = eventsOf(run.runId, 'node.completed')
    .map((e) => JSON.parse(e.payload_json))
    .find((p) => p.node_id === 'brain');
  const items = JSON.parse(getMaterial(db, brain.output_digest).content);
  assert.deepEqual(items[0].json.echo, [{ q: 'ping' }]);
});

test('crashed worker attempt is reaped and retried by the sweep', async () => {
  const run = runGraph(db, makeGraph({
    mode: 'echo',
    crash_attempt: 1,
    timeouts: { heartbeat_s: 1, schedule_to_start_s: 5 },
    retry: { max_attempts: 2 },
  }), { name: 'worker-crash' });
  assert.equal(run.stop, 'waiting');

  const crashCode = await claimAndSpawn(lastScheduledId(run.runId));
  assert.equal(crashCode, 1, 'simulated crash exits non-zero');

  const result = sweep(db, new Date(Date.now() + 8_000));
  assert.equal(result.reaped.length, 1, 'stale attempt reaped');
  assert.equal(eventsOf(run.runId, 'execution.scheduled').length, 2, 'attempt 2 scheduled');

  const code = await claimAndSpawn(lastScheduledId(run.runId));
  assert.equal(code, 0, 'attempt 2 (no crash) succeeds');

  assert.equal(resumeRun(db, run.runId).status, 'success');
  assert.equal(eventsOf(run.runId, 'execution.timed_out').length, 1);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
