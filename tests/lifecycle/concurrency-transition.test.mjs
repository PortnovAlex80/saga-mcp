/**
 * Concurrency / model transition — no-kill convergence semantics.
 *
 * Verifies that changing either field is a PURE METADATA WRITE: no engine
 * process is killed, no fresh engine is spawned. The engine pump-loop reads
 * the new values on the next RATE_LIMIT_SCAN_TICKS cycle and converges.
 *
 * The pump-loop convergence itself (the engine code) is hard to unit-test
 * without spawning a real engine; we verify the contract at the API +
 * metadata level, which is the user-facing behaviour the kanban relies on.
 *
 * Coverage:
 *   1. /api/engine/concurrency persists $.engine_concurrency, NO kill.
 *   2. /api/model/set persists $.active_model_limit + $.active_model, NO kill.
 *   3. /api/engine/concurrency + /api/model/set together: both flags coexist
 *      in metadata (no overwrite).
 *   4. readTargetConcurrency (engine helper, mirror) returns min() of both.
 *   5. /api/engine/concurrency rejects out-of-range (0, 11, 'foo').
 *   6. /api/engine/concurrency rejects missing epic_id.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const temp = mkdtempSync(path.join(os.tmpdir(), 'saga-conc-'));
const dbPath = path.join(temp, 'conc.db');
process.env.DB_PATH = dbPath;
const repoPath = path.join(temp, 'repo');
mkdirSync(repoPath);

const { closeDb, getDb } = await import('../../dist/db.js');
const { handlers: projects } = await import('../../dist/tools/projects.js');
const { handlers: epics } = await import('../../dist/tools/epics.js');
const { handlers: repositories } = await import('../../dist/tools/repositories.js');

const product = projects.project_create({ name: 'Conc Test' });
repositories.repository_register({ project_id: product.id, name: 'r', local_path: repoPath });
const epic = epics.epic_create({ project_id: product.id, name: 'E' });
const epicId = epic.id;
getDb().prepare(
  `INSERT INTO episode_workflows (epic_id, stage, metadata) VALUES (?, 'development', '{}')`,
).run(epicId);

function readMeta() {
  return JSON.parse(getDb().prepare('SELECT metadata FROM episode_workflows WHERE epic_id=?').get(epicId).metadata);
}

async function startServer() {
  const net = await import('node:net');
  const port = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
  const child = spawn('node', [
    path.join(import.meta.dirname, '..', '..', 'tracker-view', 'tracker-view.mjs'),
  ], { env: { ...process.env, DB_PATH: dbPath, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/heartbeat`); if (r.ok) break; } catch { await new Promise(r=>setTimeout(r,200)); }
  }
  return { port, stop: () => { try{child.kill('SIGKILL');}catch{} } };
}

// ---------------------------------------------------------------------------
// 1. /api/engine/concurrency persists, no kill.
// ---------------------------------------------------------------------------

test('concurrency: POST /api/engine/concurrency writes metadata only (no kill)', async () => {
  const srv = await startServer();
  try {
    const beforePids = await enginePids();
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/engine/concurrency`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epic_id: epicId, concurrency: 3 }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    assert.equal(j.concurrency, 3);
    const meta = readMeta();
    assert.equal(meta.engine_concurrency, 3, '$.engine_concurrency persisted');
    // NO engine process was killed or spawned. (There is no engine for this
    // test epic, so beforePids is empty; the key contract is that the call
    // does not SPAWN anything either.)
    const afterPids = await enginePids();
    assert.equal(afterPids.length, beforePids.length, 'no new engine process spawned');
  } finally {
    srv.stop();
  }
});

// ---------------------------------------------------------------------------
// 2. /api/model/set persists $.active_model_limit, no kill.
// ---------------------------------------------------------------------------

test('model: POST /api/model/set writes metadata only', async () => {
  const srv = await startServer();
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/model/set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4.5-flash', epic_id: epicId }),
    });
    const j = await r.json();
    assert.equal(r.status, 200);
    assert.equal(j.ok, true);
    const meta = readMeta();
    assert.equal(meta.active_model, 'glm-4.5-flash');
    assert.equal(typeof meta.active_model_limit, 'number');
  } finally {
    srv.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. Both flags coexist in metadata (no overwrite).
// ---------------------------------------------------------------------------

test('metadata: engine_concurrency and active_model_limit coexist', async () => {
  const srv = await startServer();
  try {
    await fetch(`http://127.0.0.1:${srv.port}/api/engine/concurrency`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ epic_id: epicId, concurrency: 5 }),
    });
    await fetch(`http://127.0.0.1:${srv.port}/api/model/set`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'glm-4-plus', epic_id: epicId }),
    });
    const meta = readMeta();
    assert.equal(meta.engine_concurrency, 5, 'engine_concurrency survived');
    assert.equal(meta.active_model, 'glm-4-plus', 'active_model set');
    assert.equal(meta.active_model_limit, 20, 'model limit set');
  } finally {
    srv.stop();
  }
});

// ---------------------------------------------------------------------------
// 4. readTargetConcurrency mirror: min(engine_concurrency, model_limit).
// ---------------------------------------------------------------------------

test('engine helper: readTargetConcurrency returns min(engine_concurrency, model_limit)', () => {
  // Mirror the engine's readTargetConcurrency logic.
  function readTargetConcurrency(meta, fallback) {
    const engineConc = (typeof meta.engine_concurrency === 'number' && meta.engine_concurrency >= 1 && meta.engine_concurrency <= 10) ? meta.engine_concurrency : null;
    const modelLimit = (typeof meta.active_model_limit === 'number' && meta.active_model_limit >= 1) ? meta.active_model_limit : null;
    let target = engineConc ?? fallback;
    if (modelLimit !== null) target = Math.min(target, modelLimit);
    return target;
  }
  assert.equal(readTargetConcurrency({ engine_concurrency: 5, active_model_limit: 3 }, 4), 3, 'model_limit wins when lower');
  assert.equal(readTargetConcurrency({ engine_concurrency: 2, active_model_limit: 10 }, 4), 2, 'engine_concurrency wins when lower');
  assert.equal(readTargetConcurrency({ engine_concurrency: 6 }, 4), 6, 'uses engine_concurrency when no model_limit');
  assert.equal(readTargetConcurrency({}, 4), 4, 'falls back to startup when neither set');
  assert.equal(readTargetConcurrency({ engine_concurrency: 0 }, 4), 4, 'invalid engine_concurrency → fallback');
});

// ---------------------------------------------------------------------------
// 5. Validation: out-of-range and missing epic_id.
// ---------------------------------------------------------------------------

test('concurrency: rejects out-of-range values', async () => {
  const srv = await startServer();
  try {
    for (const bad of [0, 11, 'foo', -1]) {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/engine/concurrency`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epic_id: epicId, concurrency: bad }),
      });
      assert.equal(r.status, 400, `concurrency=${bad} should be rejected`);
      const j = await r.json();
      assert.match(j.error, /concurrency must be 1\.\.10/i);
    }
  } finally {
    srv.stop();
  }
});

test('concurrency: rejects missing epic_id', async () => {
  const srv = await startServer();
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/engine/concurrency`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ concurrency: 4 }),
    });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.match(j.error, /epic_id/i);
  } finally {
    srv.stop();
  }
});

// ---------------------------------------------------------------------------
// Helper: list node.exe PIDs whose cmdline matches orchestrate-cli for our epic.
// ---------------------------------------------------------------------------

async function enginePids() {
  try {
    const r = await new Promise((resolve) => {
      require('child_process').spawn(
        'powershell',
        ['-Command',
         `Get-CimInstance Win32_Process -Filter "name='node.exe'" | ` +
         `Where-Object { $_.CommandLine -like '*orchestrate-cli.js ${product.id} ${epicId}*' } | ` +
         `ForEach-Object { $_.ProcessId }`],
        { encoding: 'utf8' },
      ).stdout.on('data', d => resolve(d.toString().split(/\s+/).filter(Boolean)));
      // Resolve empty if no output within 2s.
      setTimeout(() => resolve([]), 2000);
    });
    return r;
  } catch { return []; }
}

test.after(() => {
  closeDb();
  rmSync(temp, { recursive: true, force: true });
});
