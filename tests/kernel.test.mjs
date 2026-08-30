// M0 kernel fitness: event log sequencing, content-addressed materials,
// and the read-only factory tools over the kernel tables.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'saga5-kernel-'));
process.env.DB_PATH = path.join(dir, 'kernel.db');

const { getDb, closeDb } = await import('../dist/db.js');
const { createWorkflow, createRun, appendEvent, getEvents, tailEvents, setRunStatus, getRun } = await import('../dist/events.js');
const { materialDigest, putMaterial, getMaterial, requireMaterial } = await import('../dist/materials.js');
const { handlers: factory } = await import('../dist/tools/factory.js');

test('materials are content-addressed and deduplicated', () => {
  const db = getDb();
  const d1 = materialDigest('srs', 'hello world');
  assert.equal(d1, materialDigest('srs', 'hello world'), 'same content → same digest');
  assert.notEqual(d1, materialDigest('srs', 'hello worlds'), 'different content → different digest');
  assert.notEqual(d1, materialDigest('prd', 'hello world'), 'different schema → different digest');

  const first = putMaterial(db, 'srs', 'hello world');
  assert.equal(first.created, true);
  const again = putMaterial(db, 'srs', 'hello world');
  assert.equal(again.created, false, 're-submit is a no-op');
  assert.equal(again.digest, first.digest);

  const row = requireMaterial(db, first.digest);
  assert.equal(row.content, 'hello world');
  assert.equal(row.schema_ref, 'srs');
  assert.throws(() => requireMaterial(db, 'deadbeef'), /MATERIAL_NOT_FOUND/);
});

test('events get dense per-run sequences; header projection stays in sync', () => {
  const db = getDb();
  const wf = createWorkflow(db, 'demo', JSON.stringify({ nodes: [], connections: {} }));
  const started = createRun(db, wf.id);

  assert.equal(started.seq, 1);
  assert.equal(started.type, 'run.started');

  appendEvent(db, started.run_id, 'node.scheduled', { node_id: 'n1' });
  appendEvent(db, started.run_id, 'node.completed', { node_id: 'n1' });
  const e4 = appendEvent(db, started.run_id, 'gate.decided', { verdict: 'accepted' });

  assert.deepEqual(
    getEvents(db, started.run_id).map((e) => e.seq),
    [1, 2, 3, 4],
    'sequences are dense and ordered'
  );
  assert.deepEqual(
    tailEvents(db, started.run_id, 2).map((e) => e.seq),
    [3, 4],
    'tail returns last events, oldest first'
  );
  assert.equal(e4.payload_json, '{"verdict":"accepted"}');

  const run = getRun(db, started.run_id);
  assert.equal(run.next_seq, 4, 'next_seq matches the log');
  assert.equal(run.status, 'new');

  const change = setRunStatus(db, started.run_id, 'waiting', '2026-09-01T00:00:00');
  assert.equal(change.seq, 5);
  assert.equal(getRun(db, started.run_id).status, 'waiting');
  assert.equal(getRun(db, started.run_id).wait_till, '2026-09-01T00:00:00');
  assert.equal(getEvents(db, started.run_id, 4).length, 1, 'status change is logged as an event');

  assert.throws(() => appendEvent(db, 'missing-run', 'x'), /RUN_NOT_FOUND/);
});

test('factory tools expose the kernel state read-only', () => {
  const status = factory.factory_status({});
  assert.ok(status.recent_runs.length >= 1);
  assert.ok(status.materials_stored >= 1);

  const runId = status.recent_runs[0].id;
  const tail = factory.event_tail({ run_id: runId, limit: 10 });
  assert.equal(tail.run.id, runId);
  assert.ok(tail.events.length >= 1);
  assert.throws(() => factory.event_tail({ run_id: 'nope' }), /RUN_NOT_FOUND/);
});

after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
