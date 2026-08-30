// M1 kernel fitness: deterministic graph execution, exact-ref material reads,
// failure isolation, and resume producing byte-identical results.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-runner-'));
process.env.DB_PATH = path.join(dir, 'runner.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { runGraph, resumeRun } = await import('../dist/kernel/runner.js');
const { getEvents } = await import('../dist/events.js');
const { getMaterial } = await import('../dist/materials.js');

const db = getDb();

test('chain: emit → template → collect runs to success with clean event vocabulary', () => {
  const graph = JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { who: 'saga5' } }] } },
      greet: { type: 'template', parameters: { template: 'hello {{who}}' } },
      bundle: { type: 'collect' },
    },
    connections: {
      source: { main: [[{ node: 'greet' }]] },
      greet: { main: [[{ node: 'bundle' }]] },
    },
  });

  const result = runGraph(db, graph, { name: 'chain' });
  assert.equal(result.status, 'success');
  assert.equal(result.stop, 'terminal');

  const types = getEvents(db, result.runId).map((e) => e.type);
  assert.deepEqual(types.filter((t) => t.startsWith('node.')), [
    'node.scheduled', 'node.started', 'node.completed',
    'node.scheduled', 'node.started', 'node.completed',
    'node.scheduled', 'node.started', 'node.completed',
  ]);
  assert.equal(types[0], 'run.started');
  assert.ok(types.includes('run.status_changed'));

  // The leaf (collect) runs last; its material carries the merged container.
  const bundle = getEvents(db, result.runId).filter((e) => e.type === 'node.completed').at(-1);
  const material = getMaterial(db, JSON.parse(bundle.payload_json).output_digest);
  const items = JSON.parse(material.content);
  assert.deepEqual(items[0].json.items, [{ text: 'hello saga5' }]);
});

test('fan-out: two branches over 2 items merge in collect', () => {
  const graph = JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { n: 'a' } }, { json: { n: 'b' } }] } },
      left: { type: 'template', parameters: { template: 'L:{{n}}' } },
      right: { type: 'template', parameters: { template: 'R:{{n}}' } },
      merge: { type: 'collect' },
    },
    connections: {
      source: { main: [[{ node: 'left' }, { node: 'right' }]] },
      left: { main: [[{ node: 'merge' }]] },
      right: { main: [[{ node: 'merge' }]] },
    },
  });

  const result = runGraph(db, graph, { name: 'fanout' });
  assert.equal(result.status, 'success');

  const mergeEvent = getEvents(db, result.runId)
    .filter((e) => e.type === 'node.completed')
    .at(-1);
  const mergePayload = JSON.parse(mergeEvent.payload_json);
  const items = JSON.parse(getMaterial(db, mergePayload.output_digest).content);
  assert.deepEqual(items[0].json.items, [
    { text: 'L:a' }, { text: 'L:b' }, { text: 'R:a' }, { text: 'R:b' },
  ]);
});

test('failure is typed and isolated: downstream stranded, independent branch completes', () => {
  const graph = JSON.stringify({
    nodes: {
      boom: { type: 'fail', parameters: { message: 'LLM exploded' } },
      stranded: { type: 'template', parameters: { template: 'never' } },
      side: { type: 'emit', parameters: { items: [{ json: { ok: true } }] } },
      sideT: { type: 'template', parameters: { template: 'side {{ok}}' } },
    },
    connections: {
      boom: { main: [[{ node: 'stranded' }]] },
      side: { main: [[{ node: 'sideT' }]] },
    },
  });

  const result = runGraph(db, graph, { name: 'failure' });
  assert.equal(result.status, 'error');

  const events = getEvents(db, result.runId);
  const failed = events.find((e) => e.type === 'node.failed');
  assert.match(JSON.parse(failed.payload_json).error, /LLM exploded/);

  const completedNodes = events
    .filter((e) => e.type === 'node.completed')
    .map((e) => JSON.parse(e.payload_json).node_id);
  assert.ok(completedNodes.includes('sideT'), 'independent branch finished');
  assert.ok(!completedNodes.includes('stranded'), 'downstream of failure never ran');

  // resume of a terminal run is a no-op
  const again = resumeRun(db, result.runId);
  assert.equal(again.executed, 0);
  assert.equal(again.status, 'error');
});

test('interrupted run (budget stop) resumes to the byte-identical result', () => {
  const graph = JSON.stringify({
    nodes: {
      source: { type: 'emit', parameters: { items: [{ json: { v: 1 } }] } },
      t1: { type: 'template', parameters: { template: 'one {{v}}' } },
      t2: { type: 'template', parameters: { template: 'two {{text}}' } },
      bundle: { type: 'collect' },
    },
    connections: {
      source: { main: [[{ node: 't1' }]] },
      t1: { main: [[{ node: 't2' }]] },
      t2: { main: [[{ node: 'bundle' }]] },
    },
  });

  const full = runGraph(db, graph, { name: 'resume-full' });
  const fullDigests = getEvents(db, full.runId)
    .filter((e) => e.type === 'node.completed')
    .map((e) => JSON.parse(e.payload_json).output_digest);

  const partial = runGraph(db, graph, { name: 'resume-partial', maxNodeExecutions: 2 });
  assert.equal(partial.status, 'running');
  assert.equal(partial.stop, 'budget');

  const resumed = resumeRun(db, partial.runId);
  assert.equal(resumed.status, 'success');
  assert.equal(resumed.stop, 'terminal');

  const resumedDigests = getEvents(db, partial.runId)
    .filter((e) => e.type === 'node.completed')
    .map((e) => JSON.parse(e.payload_json).output_digest);
  assert.deepEqual(resumedDigests, fullDigests, 'resumed run produces identical materials');
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
