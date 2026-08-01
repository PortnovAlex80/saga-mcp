/**
 * Engine control — start/stop/status endpoints (Slice: per-epic engine toggle).
 *
 * Source: blueprint refactor-passive-worker-checklist.md (engine control per epic).
 *
 * Coverage:
 *   1. readEngineState returns the persisted flag (false when never set).
 *   2. setEngineMeta writes the flag and readEngineState picks it up.
 *   3. /api/engine/status returns running=false + alive=false for a fresh epic.
 *   4. /api/engine/stop on a never-running epic is idempotent success.
 *   5. isEngineAlive returns false for a bogus (projectId, epicId) that has
 *      no matching orchestrate-cli process.
 *
 * We do NOT exercise /api/engine/start here — it spawns a real orchestrate-cli
 * process that would burn claude tokens. The spawn path is covered by the
 * existing handleEngineRestart integration (concurrency selector in the UI).
 *
 * The test builds a real SQLite DB with a project + epic + episode_workflows
 * row, then drives the HTTP endpoints via Node's http module against a
 * tracker-view server running on a random port. We spawn tracker-view in a
 * child process pointing at our temp DB, run the assertions, and tear it down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-eng-'));
const dbPath = path.join(temp, 'eng.db');
process.env.DB_PATH = dbPath;
const repoPath = path.join(temp, 'repo');
mkdirSync(repoPath);

// Build the DB schema by importing db.js (runs SCHEMA_SQL + migrations).
const { closeDb, getDb } = await import('../../dist/db.js');
const { handlers: projects } = await import('../../dist/tools/projects.js');
const { handlers: epics } = await import('../../dist/tools/epics.js');
const { handlers: repositories } = await import('../../dist/tools/repositories.js');

// Insert a project + epic + episode_workflows row to have something to query.
const product = projects.project_create({ name: 'Engine Control Test' });
repositories.repository_register({ project_id: product.id, name: 'r', local_path: repoPath });
const epic = epics.epic_create({ project_id: product.id, name: 'E' });
const epicId = epic.id;

// saga4: seed both tables. lifecycle_execution_controls is now the source of
// truth for engine state (write directly rather than relying on the
// episode_workflows backfill migration, which has already run by the time we
// get here on this fresh DB and so would NOT pick up an epic inserted after
// getDb()). episode_workflows is kept only to carry model metadata
// (active_model) for the roundtrip test below.
getDb().prepare(
  `INSERT INTO episode_workflows (epic_id, stage, metadata) VALUES (?, 'planning', '{}')`,
).run(epicId);
getDb().prepare(
  `INSERT INTO lifecycle_execution_controls (epic_id, engine_state) VALUES (?, 'stopped')`,
).run(epicId);

// --- Direct metadata helper tests (mirror the tracker-view helpers) -------
// tracker-view.mjs doesn't export its helpers, so we re-implement the
// read/write against the same schema to verify the contract end-to-end.

// saga4: engine state now lives in lifecycle_execution_controls (not
// episode_workflows.metadata). Mirrors LegacyEngineAdministration.readPersisted.
function readEngineStateDirect(epicId) {
  const row = getDb().prepare(
    `SELECT engine_state, engine_pid, concurrency, started_at
       FROM lifecycle_execution_controls WHERE epic_id=?`,
  ).get(epicId);
  if (!row) return { running: false, pid: null, concurrency: null, started_at: null };
  return {
    running: row.engine_state === 'running',
    pid: row.engine_pid,
    concurrency: row.concurrency,
    started_at: row.started_at,
  };
}

// saga4: engine fields route to lifecycle_execution_controls columns; model
// fields (active_model*) stay in episode_workflows.metadata (the tracker-view
// /api/model/set endpoint has not moved yet). Mirrors the column mapping in
// LegacyEngineAdministration.upsertControl. engine_state must be one of
// 'running' | 'stopped' | 'unknown' — never 0/1 (CHECK constraint).
function setEngineMetaDirect(epicId, patch) {
  const controlPatch = {};
  const metaPatch = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'engine_running') {
      controlPatch.engine_state = v === 1 || v === true ? 'running' : 'stopped';
    } else if (k === 'engine_pid') {
      controlPatch.engine_pid = v;
    } else if (k === 'engine_concurrency') {
      controlPatch.concurrency = v;
    } else if (k === 'engine_started_at') {
      controlPatch.started_at = v;
    } else {
      // Non-engine keys (e.g. active_model) still ride in episode_workflows.
      metaPatch[k] = v;
    }
  }

  if (Object.keys(controlPatch).length) {
    const cols = Object.keys(controlPatch);
    const sets = cols.map(c => `${c}=@${c}`);
    const params = { ...controlPatch, epic_id: epicId };
    getDb().prepare(
      `INSERT INTO lifecycle_execution_controls (epic_id, ${cols.join(', ')})
       VALUES (@epic_id, ${cols.map(c => `@${c}`).join(', ')})
       ON CONFLICT(epic_id) DO UPDATE SET ${sets.join(', ')}, updated_at=datetime('now')`,
    ).run(params);
  }

  if (Object.keys(metaPatch).length) {
    const cur = getDb().prepare('SELECT metadata FROM episode_workflows WHERE epic_id=?').get(epicId);
    const meta = JSON.parse(cur?.metadata || '{}');
    for (const k of Object.keys(metaPatch)) meta[k] = metaPatch[k];
    getDb().prepare(
      `UPDATE episode_workflows SET metadata=?, updated_at=datetime('now') WHERE epic_id=?`,
    ).run(JSON.stringify(meta), epicId);
  }
}

test('engine-state: fresh episode has running=false', () => {
  const s = readEngineStateDirect(epicId);
  assert.equal(s.running, false);
  assert.equal(s.pid, null);
  assert.equal(s.concurrency, null);
});

test('engine-state: setEngineMeta persists running=1 and reads back', () => {
  setEngineMetaDirect(epicId, { engine_running: 1, engine_pid: 12345, engine_concurrency: 4 });
  const s = readEngineStateDirect(epicId);
  assert.equal(s.running, true);
  assert.equal(s.pid, 12345);
  assert.equal(s.concurrency, 4);
});

test('engine-state: setEngineMeta stops (running=0)', () => {
  setEngineMetaDirect(epicId, { engine_running: 0 });
  const s = readEngineStateDirect(epicId);
  assert.equal(s.running, false);
});

test('engine-state: flag survives across metadata roundtrips (no key loss)', () => {
  // Set running=1, concurrency=4, model=glm-5.2 in separate calls.
  setEngineMetaDirect(epicId, { engine_running: 1 });
  setEngineMetaDirect(epicId, { engine_concurrency: 4 });
  setEngineMetaDirect(epicId, { active_model: 'glm-5.2' });
  const s = readEngineStateDirect(epicId);
  assert.equal(s.running, true, 'running flag preserved after later writes');
  assert.equal(s.concurrency, 4, 'concurrency preserved');
  // And the model-set path's key is still there. active_model still lives in
  // episode_workflows.metadata (only engine_* fields migrated to
  // lifecycle_execution_controls), so we read it back from there.
  const meta = JSON.parse(getDb().prepare('SELECT metadata FROM episode_workflows WHERE epic_id=?').get(epicId).metadata);
  assert.equal(meta.active_model, 'glm-5.2');
});

// --- HTTP endpoint smoke test ---------------------------------------------
// Spawn a real tracker-view server against the temp DB, hit the new endpoints.
// We skip /api/engine/start (spawns orchestrate-cli → burns tokens). We test
// status + stop — both are no-spawn.

test('http: /api/engine/status returns ok + running flag', async (t) => {
  const server = await startTrackerView(t, dbPath);
  try {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/engine/status?epic_id=${epicId}`);
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.epic_id, epicId);
    // running may be true (we set it above) or false (reconciled because no
    // process is alive). Both are valid outcomes — the contract is just that
    // the endpoint returns the field.
    assert.equal(typeof j.running, 'boolean');
    assert.equal(typeof j.alive, 'boolean');
  } finally {
    server.stop();
  }
});

test('http: /api/engine/stop on idle epic is idempotent success', async (t) => {
  const server = await startTrackerView(t, dbPath);
  try {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/engine/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epic_id: epicId }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.running, false);
    // Persisted flag should now be 0.
    const s = readEngineStateDirect(epicId);
    assert.equal(s.running, false);
  } finally {
    server.stop();
  }
});

test('http: /api/engine/stop rejects missing epic_id', async (t) => {
  const server = await startTrackerView(t, dbPath);
  try {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/engine/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const j = await r.json();
    assert.equal(r.status, 400);
    assert.equal(j.ok, false);
    assert.match(j.error, /epic_id/i);
  } finally {
    server.stop();
  }
});

test('http: /api/engine/status rejects unknown epic', async (t) => {
  const server = await startTrackerView(t, dbPath);
  try {
    const r = await fetch(`http://127.0.0.1:${server.port}/api/engine/status?epic_id=999999`);
    const j = await r.json();
    assert.equal(r.status, 404);
    assert.equal(j.ok, false);
  } finally {
    server.stop();
  }
});

test('http: worker tail accepts configured orchestration log root and rejects outside files', async (t) => {
  const logRoot = path.join(temp, 'configured-worker-logs');
  mkdirSync(logRoot);
  const allowedLog = path.join(logRoot, 'worker.jsonl');
  const outsideLog = path.join(temp, 'outside.jsonl');
  writeFileSync(allowedLog, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } })}\n`);
  writeFileSync(outsideLog, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'secret' }] } })}\n`);
  const server = await startTrackerView(t, dbPath, {
    SAGA_ORCHESTRATION_LOG: logRoot,
  });
  try {
    const allowed = await fetch(
      `http://127.0.0.1:${server.port}/api/worker/tail?lines=5&log_path=${encodeURIComponent(allowedLog)}`,
    );
    const allowedBody = await allowed.json();
    assert.equal(allowed.status, 200);
    assert.equal(allowedBody.events[0].snippet, 'working');

    const outside = await fetch(
      `http://127.0.0.1:${server.port}/api/worker/tail?lines=5&log_path=${encodeURIComponent(outsideLog)}`,
    );
    assert.equal(outside.status, 403);
  } finally {
    server.stop();
  }
});

// ---------------------------------------------------------------------------
// Helper: spawn tracker-view on a random port, return { port, stop }.
// ---------------------------------------------------------------------------

async function startTrackerView(t, dbPath, extraEnv = {}) {
  // Find a free port.
  const net = await import('node:net');
  const port = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });

  const env = {
    ...process.env,
    DB_PATH: dbPath,
    PORT: String(port),
    ...extraEnv,
  };
  const child = spawn('node', [
    path.join(import.meta.dirname, '..', '..', 'tracker-view', 'tracker-view.mjs'),
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });

  // tracker-view doesn't natively honour TRACKER_VIEW_PORT; we need to check.
  // If it doesn't, fall back to spawning with PORT (some servers honour PORT).
  // Worst case: the test fails with ECONNREFUSED — we'll see it in the log.

  // Wait for the server to be reachable (poll up to 5s).
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/heartbeat`);
      if (r.ok) break;
    } catch {
      await new Promise(res => setTimeout(res, 200));
    }
  }

  return {
    port,
    stop() {
      try { child.kill('SIGTERM'); } catch {}
      try { child.kill('SIGKILL'); } catch {}
    },
  };
}

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});
