// M2 activity contract (in-process): scheduling is idempotent while an
// execution is in flight, lease guards are fail-closed, timeouts reap into
// exactly one retry decision, and exhaustion fails the node honestly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-activity-'));
process.env.DB_PATH = path.join(dir, 'activity.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { claimExecution, completeActivity, getExecution } = await import('../dist/kernel/executions.js');
const { sweep } = await import('../dist/kernel/sweep.js');
const { getMaterial } = await import('../dist/materials.js');

const db = getDb();

function makeGraph(nodeParams) {
  return JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { q: 'ping' } }] } },
      brain: { type: 'llm', parameters: nodeParams },
      wrap: { type: 'template', parameters: { template: 'see {{note}}' } },
      bundle: { type: 'collect' },
    },
    connections: {
      source: { main: [[{ node: 'brain' }]] },
      brain: { main: [[{ node: 'wrap' }]] },
      wrap: { main: [[{ node: 'bundle' }]] },
    },
  });
}

function eventsOf(runId, type) {
  return getEvents(db, runId).filter((e) => e.type === type);
}

function lastScheduledId(runId) {
  const event = eventsOf(runId, 'execution.scheduled').at(-1);
  return JSON.parse(event.payload_json).execution_id;
}

test('activity scheduling is idempotent while in flight; run waits, not crashes', () => {
  const run = runGraph(db, makeGraph({
    mode: 'echo',
    timeouts: { heartbeat_s: 2, schedule_to_start_s: 5 },
    retry: { max_attempts: 2 },
  }), { name: 'act' });

  assert.equal(run.stop, 'waiting');
  assert.equal(run.status, 'running');
  assert.equal(eventsOf(run.runId, 'execution.scheduled').length, 1);

  resumeRun(db, run.runId);
  assert.equal(eventsOf(run.runId, 'execution.scheduled').length, 1, 'no duplicate schedule');
});

test('lease guards are fail-closed; completion drives the rest of the graph', () => {
  const runId = db.prepare("SELECT id FROM runs WHERE status = 'running'").get().id;
  const execId = lastScheduledId(runId);

  const { lease } = claimExecution(db, execId);
  assert.throws(
    () => completeActivity(db, execId, 'wrong-lease', [{ json: { note: 'x' } }]),
    /EXECUTION_LEASE_INVALID/
  );

  completeActivity(db, execId, lease, [{ json: { note: 'scripted' } }]);
  assert.throws(
    () => completeActivity(db, execId, lease, [{ json: { note: 'again' } }]),
    /EXECUTION_LEASE_INVALID/,
    'double completion rejected'
  );

  const done = resumeRun(db, runId);
  assert.equal(done.status, 'success');

  const completed = eventsOf(runId, 'node.completed').map((e) => JSON.parse(e.payload_json));
  const wrap = completed.find((p) => p.node_id === 'wrap');
  const items = JSON.parse(getMaterial(db, wrap.output_digest).content);
  assert.equal(items[0].json.text, 'see scripted');
});

test('stale heartbeat reaps into exactly one retry, which succeeds', () => {
  const run = runGraph(db, makeGraph({
    mode: 'echo',
    timeouts: { heartbeat_s: 1, schedule_to_start_s: 1 },
    retry: { max_attempts: 2 },
  }), { name: 'act' });
  assert.equal(run.stop, 'waiting');

  // claim → the worker holds a lease but goes silent: heartbeat staleness.
  claimExecution(db, lastScheduledId(run.runId));
  const future = new Date(Date.now() + 10_000);
  const first = sweep(db, future);
  assert.equal(first.reaped.length, 1);
  assert.equal(first.reaped[0].kind, 'heartbeat');
  assert.equal(eventsOf(run.runId, 'execution.scheduled').length, 2, 'attempt 2 scheduled');

  sweep(db, future); // decide-once: crashed row must not reap or retry again
  assert.equal(eventsOf(run.runId, 'execution.scheduled').length, 2);

  const exec2 = lastScheduledId(run.runId);
  assert.equal(getExecution(db, exec2).attempt, 2);
  const { lease } = claimExecution(db, exec2);
  completeActivity(db, exec2, lease, [{ json: { note: 'second try' } }]);
  assert.equal(resumeRun(db, run.runId).status, 'success');
});

test('exhausted retry budget fails the node and strands the run honestly', () => {
  const run = runGraph(db, makeGraph({
    mode: 'echo',
    timeouts: { heartbeat_s: 1, schedule_to_start_s: 1 },
    retry: { max_attempts: 1 },
  }), { name: 'act' });
  assert.equal(run.stop, 'waiting');

  sweep(db, new Date(Date.now() + 10_000));
  assert.ok(eventsOf(run.runId, 'node.failed').length >= 1);
  assert.ok(eventsOf(run.runId, 'execution.retry_exhausted').length === 1);

  assert.equal(resumeRun(db, run.runId).status, 'error');
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
