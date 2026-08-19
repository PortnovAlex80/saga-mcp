// tests/app/factory-engine-spawn.test.mjs
//
// E-P1 (PREVENTIVE-HUNT Layer 3, B-002 root): scripts/factory.mjs used to
// spawn the engine host with `stdio:'inherit'` and NO `detached:true` while
// claiming the opposite in a comment. Consequences:
//   - the engine dies with the operator's console (Ctrl+C / window close);
//     a terminal QuickEdit selection freezes it via the inherited pipe;
//   - no SAGA_ENGINE_LOG → engineLog/heartbeat/phase markers are NOOP —
//     freezes are undiagnosable (the stage-10 death had no engine log);
//   - the launch row never gets engine_log_path/engine_pid → the panel
//     engine supervisor treats the launch as LEGACY (unobservable) →
//     freezes are undetectable AND unkillable by the watchdog.
//
// This file pins the spawn contract of the extracted helper
// scripts/factory-engine-spawn.mjs (used by scripts/factory.mjs):
//
//   1. spawn options: detached:true, stdio ['ignore', fd, fd] (files, never
//      the terminal, never a panel-drained pipe), child.unref();
//   2. env: SAGA_ENGINE_LOG set to a durable path honoring
//      SAGA_ORCHESTRATION_LOG, DB_PATH, composition, package store;
//   3. AFTER spawn: launch row stamped engine_pid/engine_log_path/
//      engine_spawned_at, lifecycle_execution_controls stamped
//      engine_state='running' + engine_pid + started_at (idempotent when the
//      row already exists — resume may not have created it);
//   4. end-to-end with a real stub binary: the detached child's stdout lands
//      in the engine log file, and the parent exits without waiting for it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import { SCHEMA_SQL } from '../../dist/schema.js';
import {
  resolveEngineLogPath,
  spawnOrchestrateCliEngine,
} from '../../scripts/factory-engine-spawn.mjs';

const CLI_STUB = path.resolve('tests/fixtures/engine-spawn-stub.mjs');

function fixtureDb(root, { withControls = false, epicId = 1 } = {}) {
  const dbPath = path.join(root, 'factory.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO projects (id,name) VALUES (1,'p')").run();
  db.prepare("INSERT INTO epics (id,project_id,name) VALUES (1,1,'e')").run();
  db.prepare(
    `INSERT INTO factory_orders (order_ref,project_id,epic_id,source_kind,state)
     VALUES ('order-1',1,1,'existing_project','starting')`,
  ).run();
  db.prepare(
    `INSERT INTO factory_launch_requests
       (launch_ref,order_ref,mode,project_id,epic_id,initiated_by,
        idempotency_key,concurrency,state)
     VALUES ('launch-1','order-1','new',1,1,'factory-start','idem-1',4,'requested')`,
  ).run();
  if (withControls) {
    db.prepare(
      `INSERT INTO lifecycle_execution_controls
         (epic_id,concurrency,model_provider,model_name,model_effort,model_concurrency_limit)
       VALUES (?,?, 'zai', 'glm-4.7', 'high', 4)`,
    ).run(epicId, 2);
  }
  db.close();
  return dbPath;
}

/** Recording fake for spawn: captures options, returns a fake child. */
function recordingSpawn() {
  const calls = [];
  const fakeChild = { pid: 4242, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
  return {
    calls,
    fakeChild,
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return fakeChild;
    },
  };
}

function spawnWithFake(dbPath, overrides = {}) {
  const recorder = recordingSpawn();
  const result = spawnOrchestrateCliEngine({
    dbPath,
    launchRef: 'launch-1',
    cliPath: CLI_STUB,
    spawnProcess: recorder.spawn,
    ...overrides,
  });
  return { recorder, ...result };
}

// ---------------------------------------------------------------------------
// 1+2 — the spawn contract itself.
// ---------------------------------------------------------------------------

test('E-P1: engine spawn is detached with file-backed stdio and a durable SAGA_ENGINE_LOG', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-ep1-spawn-'));
  try {
    const dbPath = fixtureDb(root);
    const { recorder, engineLog } = spawnWithFake(dbPath);
    const { fakeChild } = recorder;

    assert.equal(recorder.calls.length, 1, 'exactly one engine child spawned');
    const { command, args, options } = recorder.calls[0];
    assert.equal(command, 'node');
    assert.ok(args.some(arg => arg.includes('orchestrate-cli') || arg.includes('--launch-ref=launch-1')),
      'the runtime host is spawned with the opaque launch ref');
    assert.ok(args.includes('--launch-ref=launch-1'));

    // THE defect: detached + unref so the engine outlives the CLI script.
    assert.equal(options.detached, true, 'spawn must be detached (engine outlives factory.mjs)');
    assert.equal(fakeChild.unrefCalls, 1, 'child.unref() must be called exactly once');

    // stdio: stdin ignored, stdout AND stderr are FILE descriptors — never
    // 'inherit' (terminal QuickEdit freeze class) and never a pipe a stalled
    // parent could fill.
    assert.ok(Array.isArray(options.stdio), 'stdio must be an array');
    assert.equal(options.stdio[0], 'ignore');
    assert.equal(options.stdio.length, 3);
    assert.equal(options.stdio[1], options.stdio[2], 'stdout and stderr share the engine log file');
    assert.ok(Number.isInteger(options.stdio[1]), `stdout must be a file fd, got ${JSON.stringify(options.stdio[1])}`);
    assert.notEqual(options.stdio[1], 'inherit');
    assert.notEqual(options.stdio[1], 'pipe');

    // The env contract that makes engine-file-logger markers live.
    assert.equal(options.env.SAGA_ENGINE_LOG, engineLog, 'SAGA_ENGINE_LOG must point at the engine log');
    assert.equal(options.env.DB_PATH, dbPath);
    assert.ok(options.env.SAGA_PRODUCT_LIFECYCLE_COMPOSITION.length > 0, 'composition path forwarded');
    assert.ok(options.env.SAGA_PACKAGE_STORE_DIR.length > 0, 'package store dir forwarded');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E-P1: engine log path honors SAGA_ORCHESTRATION_LOG and the saga-engine naming convention', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-ep1-log-'));
  const previous = process.env.SAGA_ORCHESTRATION_LOG;
  try {
    delete process.env.SAGA_ORCHESTRATION_LOG;
    const tmp = resolveEngineLogPath({ epicId: 7 });
    assert.equal(path.dirname(tmp), os.tmpdir());
    assert.match(path.basename(tmp), /^saga-engine-7-\d{4}-\d{2}-\d{2}T/);

    process.env.SAGA_ORCHESTRATION_LOG = path.join(root, 'run-logs');
    const rooted = resolveEngineLogPath({ epicId: 9 });
    assert.equal(path.dirname(rooted), path.join(root, 'run-logs'),
      'operator-configured log root wins over tmpdir');
    assert.match(path.basename(rooted), /^saga-engine-9-/);

    const dbPath = fixtureDb(root);
    const { engineLog } = spawnWithFake(dbPath);
    assert.equal(path.dirname(engineLog), path.join(root, 'run-logs'),
      'the spawned engine log lives under the configured root');
    assert.ok(existsSync(engineLog), 'the log root is created before spawn');
  } finally {
    if (previous === undefined) delete process.env.SAGA_ORCHESTRATION_LOG;
    else process.env.SAGA_ORCHESTRATION_LOG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3 — durable stamps AFTER spawn.
// ---------------------------------------------------------------------------

test('E-P1: launch row and lifecycle_execution_controls are stamped after spawn (row absent)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-ep1-stamp-'));
  try {
    const dbPath = fixtureDb(root, { withControls: false });
    const { engineLog } = spawnWithFake(dbPath);

    const db = new Database(dbPath, { readonly: true });
    const launch = db.prepare(
      'SELECT engine_log_path, engine_pid, engine_spawned_at FROM factory_launch_requests WHERE launch_ref=?',
    ).get('launch-1');
    assert.equal(launch.engine_log_path, engineLog, 'launch row binds the engine log path (watchdog observability)');
    assert.equal(launch.engine_pid, 4242, 'launch row binds the engine pid');
    assert.notEqual(launch.engine_spawned_at, null);

    const controls = db.prepare(
      'SELECT engine_state, engine_pid, started_at FROM lifecycle_execution_controls WHERE epic_id=1',
    ).get();
    assert.ok(controls, 'controls row created idempotently when the start path had none');
    assert.equal(controls.engine_state, 'running');
    assert.equal(controls.engine_pid, 4242);
    assert.notEqual(controls.started_at, null);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('E-P1: controls stamp is idempotent when the row already exists (resume path)', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-ep1-idem-'));
  try {
    const dbPath = fixtureDb(root, { withControls: true });
    const { engineLog } = spawnWithFake(dbPath);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM lifecycle_execution_controls WHERE epic_id=1').all();
    assert.equal(rows.length, 1, 'exactly one controls row — upsert, not duplicate');
    assert.equal(rows[0].engine_state, 'running');
    assert.equal(rows[0].engine_pid, 4242);
    assert.equal(rows[0].concurrency, 2, 'pre-existing operator columns survive the stamp');
    assert.equal(rows[0].model_name, 'glm-4.7');
    const launch = db.prepare(
      'SELECT engine_log_path, engine_pid FROM factory_launch_requests WHERE launch_ref=?',
    ).get('launch-1');
    assert.equal(launch.engine_log_path, engineLog);
    assert.equal(launch.engine_pid, 4242);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4 — end-to-end with a real stub binary (detached, file stdio, parent exits).
// ---------------------------------------------------------------------------

test('E-P1 (e2e stub): detached child stdout lands in the engine log file', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'saga-ep1-e2e-'));
  let child = null;
  try {
    const dbPath = fixtureDb(root);
    const { child: spawned } = spawnOrchestrateCliEngine({
      dbPath,
      launchRef: 'launch-1',
      cliPath: CLI_STUB,
    });
    child = spawned;
    assert.ok(Number.isInteger(child.pid), 'real stub child has a pid');

    // The parent does NOT wait for the child (unref): prove the log content
    // arrives while the stub is still running.
    const engineLog = new Database(dbPath, { readonly: true })
      .prepare('SELECT engine_log_path FROM factory_launch_requests WHERE launch_ref=?')
      .get('launch-1').engine_log_path;
    let content = '';
    for (let attempt = 0; attempt < 100 && !content.includes('ENGINE-STUB-STDOUT'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      try { content = readFileSync(engineLog, 'utf8'); } catch { /* not created yet */ }
    }
    assert.ok(
      content.includes('ENGINE-STUB-STDOUT'),
      `stub stdout must be captured in the engine log (got: ${JSON.stringify(content.slice(0, 200))})`,
    );
  } finally {
    if (child?.pid) {
      try { process.kill(child.pid); } catch { /* already gone */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
