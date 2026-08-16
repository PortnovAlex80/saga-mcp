// tests/runtime/busy-retry.test.mjs
//
// Antifreeze layer B3 (TB-2 freeze class, docs/testing/WORKSHOP-BUGS.md):
// a better-sqlite3 write colliding with the write lock busy-spins ON THE MAIN
// THREAD for the full busy_timeout (getDb(): 5000ms); if the lock holder is
// released by a timer/callback of the SAME process, the spin is eternal. The
// point fix 9a41748f bounded this for worker-executions.ts only; this layer
// generalizes it (src/runtime/busy-retry.ts):
//
//   * withBusyRetry(fn, { db, busyTimeoutMs, attempts, maxWaitMs }) lowers the
//     connection's busy_timeout for the retry window and RESTORES it after;
//   * SQLITE_BUSY* retries with small synchronous backoff (Atomics.wait — the
//     pattern proven by 9a41748f);
//   * exhaustion throws the TYPED EngineDbBusyError (code ENGINE_DB_BUSY)
//     carrying the attempts made and the last underlying SqliteError;
//   * non-busy errors surface immediately, unchanged.
//
// Real contention is produced by a CHILD PROCESS holding BEGIN IMMEDIATE —
// cross-process, exactly like a worker MCP child fighting the engine, and
// immune to the frozen event loop of the test process itself (an in-process
// setTimeout holder could never fire while withBusyRetry blocks synchronously
// — that deadlock IS the bug being tested against).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

import Database from 'better-sqlite3';
import {
  EngineDbBusyError,
  withBusyRetry,
} from '../../dist/runtime/busy-retry.js';

const require = createRequire(import.meta.url);
const betterSqlite3Path = require.resolve('better-sqlite3');

function makeDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'saga-busy-'));
  const dbPath = path.join(dir, 'busy.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Mirror the engine's main connection: the shared 5s busy_timeout that
  // withBusyRetry must lower temporarily and restore afterwards.
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE holder_probe (id INTEGER NOT NULL)');
  return { dir, dbPath, db };
}

/**
 * Spawn a child process that acquires the WAL write lock (BEGIN IMMEDIATE +
 * INSERT), writes a marker file once the lock is held, holds it for holdMs,
 * then rolls back and exits. The lock release does NOT depend on the test
 * process's event loop — which withBusyRetry blocks during its retries.
 */
function spawnLockHolder(dbPath, markerPath, holdMs) {
  const script = `
    const Database = require(${JSON.stringify(betterSqlite3Path)});
    const fs = require('node:fs');
    const db = new Database(${JSON.stringify(dbPath)});
    db.pragma('busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO holder_probe (id) VALUES (1)').run();
    fs.writeFileSync(${JSON.stringify(markerPath)}, 'locked');
    setTimeout(() => {
      try { db.exec('ROLLBACK'); } catch {}
      db.close();
      process.exit(0);
    }, ${holdMs});
  `;
  return spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
}

async function waitForMarker(markerPath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(markerPath)) {
    if (Date.now() > deadline) throw new Error('lock holder marker never appeared');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  // Small settle so the holder is fully inside its transaction.
  await new Promise(resolve => setTimeout(resolve, 50));
}

test('short external lock: bounded retry succeeds and busy_timeout is restored', async () => {
  const { dir, dbPath, db } = makeDb();
  const markerPath = path.join(dir, 'locked.marker');
  try {
    rmSync(markerPath, { force: true }); // ensure a stale marker cannot fake the lock
    const holder = spawnLockHolder(dbPath, markerPath, 400);
    try {
      await waitForMarker(markerPath);
      assert.equal(
        db.pragma('busy_timeout', { simple: true }), 5000,
      );
      const started = Date.now();
      // The claim-shaped write: attempts budget comfortably exceeds the
      // holder's 400ms window; per-attempt spin is bounded to 250ms.
      const info = withBusyRetry(
        () => db.prepare('INSERT INTO holder_probe (id) VALUES (2)').run(),
        { db, attempts: 10, busyTimeoutMs: 250, maxWaitMs: 5_000 },
      );
      const elapsed = Date.now() - started;
      assert.equal(info.changes, 1);
      // It must have actually waited for the child to release (~>=300ms)...
      assert.ok(elapsed >= 250, `retry succeeded too fast (${elapsed}ms) — lock was not really held`);
      // ...but far below the old single-window 5s busy-spin class.
      assert.ok(elapsed < 4_000, `retry window took ${elapsed}ms (expected <4s)`);
      // The shared connection's 5s busy_timeout is RESTORED after the window.
      assert.equal(
        db.pragma('busy_timeout', { simple: true }), 5000,
        'withBusyRetry must restore the previous busy_timeout on the shared connection',
      );
    } finally {
      if (holder.exitCode === null) holder.kill();
      await new Promise(resolve => holder.once('exit', resolve));
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('long external lock: ENGINE_DB_BUSY thrown within the budget, attempts recorded', async () => {
  const { dir, dbPath, db } = makeDb();
  const markerPath = path.join(dir, 'locked.marker');
  try {
    rmSync(markerPath, { force: true }); // ensure a stale marker cannot fake the lock
    const holder = spawnLockHolder(dbPath, markerPath, 8_000);
    try {
      await waitForMarker(markerPath);
      const started = Date.now();
      assert.throws(
        () => withBusyRetry(
          () => db.prepare('INSERT INTO holder_probe (id) VALUES (3)').run(),
          { db, attempts: 3, busyTimeoutMs: 250, maxWaitMs: 1_000 },
        ),
        (error) => {
          assert.ok(error instanceof EngineDbBusyError);
          assert.equal(error.code, 'ENGINE_DB_BUSY');
          assert.equal(error.attempts, 3);
          assert.equal(error.lastError.code, 'SQLITE_BUSY');
          return true;
        },
      );
      const elapsed = Date.now() - started;
      // Bounded well under BOTH the holder's 8s lock and the old 5s spin.
      assert.ok(elapsed < 2_500, `ENGINE_DB_BUSY after ${elapsed}ms (expected <2.5s)`);
    } finally {
      if (holder.exitCode === null) holder.kill();
      await new Promise(resolve => holder.once('exit', resolve));
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('attempt counter is honored exactly; backoffs are paid synchronously', () => {
  let calls = 0;
  const busyError = () => {
    calls += 1;
    const error = new Error('database is locked');
    error.code = 'SQLITE_BUSY';
    throw error;
  };
  const started = Date.now();
  assert.throws(
    () => withBusyRetry(busyError, { attempts: 4, maxWaitMs: 60_000 }),
    (error) => error instanceof EngineDbBusyError && error.attempts === 4,
  );
  const elapsed = Date.now() - started;
  assert.equal(calls, 4);
  // Backoff schedule 50+100+100ms — synchronous, so the whole window is at
  // least that long.
  assert.ok(elapsed >= 200, `expected synchronous backoff to take >=200ms, took ${elapsed}ms`);
});

test('maxWaitMs caps the retry window before the attempt budget is spent', () => {
  let calls = 0;
  const busyError = () => {
    calls += 1;
    const error = new Error('database is locked');
    error.code = 'SQLITE_BUSY_SNAPSHOT';
    throw error;
  };
  const started = Date.now();
  assert.throws(
    () => withBusyRetry(busyError, { attempts: 50, maxWaitMs: 400 }),
    (error) => error instanceof EngineDbBusyError,
  );
  const elapsed = Date.now() - started;
  assert.ok(calls < 50, `maxWaitMs must stop the window early (made ${calls} attempts)`);
  assert.ok(elapsed < 2_000, `window took ${elapsed}ms (expected << attempts budget)`);
});

test('non-busy errors surface immediately and unchanged', () => {
  const boom = new TypeError('not a lock problem');
  let calls = 0;
  assert.throws(
    () => withBusyRetry(() => {
      calls += 1;
      throw boom;
    }, { attempts: 5 }),
    (error) => error === boom,
  );
  assert.equal(calls, 1);
});
