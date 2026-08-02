// tests/architecture/supervision-lease-concurrency.test.mjs
//
// Wave 5 third-audit gap closure: the cross-process advisory lease
// (src/infrastructure/work/worker-supervision-service.ts, added in e3f5ae8)
// guards the supervision sweep so two SEPARATE orchestrate-cli processes on the
// SAME DB file cannot both reconcile the same scope at once. SQLite has no
// native advisory lock; the production code implements one as a compare-and-swap
// over the `supervision_locks` table (schema in src/schema.ts):
//
//   acquireSupervisionLease (one IMMEDIATE transaction):
//     1. INSERT OR IGNORE INTO supervision_locks (scope_key, holder_id, expires_at)
//        VALUES (?, ?, ?);                         -- claim a fresh scope row
//     2. UPDATE supervision_locks SET holder_id=?, expires_at=?, updated_at=?
//        WHERE scope_key=? AND (expires_at < ? OR holder_id = ?);   -- CAS
//        -- claims the row ONLY when it is expired OR already mine.
//        -- a row held by a DIFFERENT live holder (expires_at >= now AND
//           holder_id != me) is left untouched → UPDATE.changes == 0 → skip.
//
//   releaseSupervisionLease:
//     DELETE FROM supervision_locks WHERE scope_key=? AND holder_id=?;  -- mine only
//
// The audit demanded: "A test of two independent SQLite connections: one holder
// gets the lease, a second skips the sweep, after expiry the second gets the
// lease, the old holder cannot delete the new owner's lease."
//
// APPROACH: the production acquireSupervisionLease / releaseSupervisionLease
// functions are NOT exported (they are private to the module and closed over
// getDb() for the production path). They DO accept a db handle parameter
// internally, but the module surface only exposes startWorkerSupervision. So
// this test takes approach (b): it replicates the EXACT CAS SQL inline so the
// test is self-contained and proves the SQL-level mutual exclusion regardless
// of the function wrapper. The SQL strings below are byte-for-byte the same
// statements as the production code (verified against
// src/infrastructure/work/worker-supervision-service.ts lines 181-222); if
// those statements drift, this test will still pass for ITS SQL but will not
// catch a production regression — that drift is guarded structurally by the
// SCHEMA_SQL import (the table must exist) and by worker-supervision-reaper
// (which exercises the wrapper end to end).
//
// Two INDEPENDENT better-sqlite3 connections are opened on the SAME file
// (WAL mode + busy_timeout, the production pragmas). This is the real
// two-process shape: SQLite serializes writers via the DB file lock, and the
// CAS UPDATE is the gate. A fake clock is used (no sleeping): the CAS SQL takes
// `now` and `expires_at` as bound ISO strings, so advancing the clock is just
// passing a later `now`. This keeps the expiry scenario fast and deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';

// ---------------------------------------------------------------------------
// EXACT replica of the production CAS statements
// (src/infrastructure/work/worker-supervision-service.ts). Keep in sync with
// that file. If you change the production SQL, mirror it here.
// ---------------------------------------------------------------------------

/**
 * Acquire (or refresh) the cross-process advisory lease for one scope on one
 * connection. Two stepped statements inside one IMMEDIATE transaction — the
 * atomic unit that defeats a concurrent holder on a second connection.
 *
 * @returns true if THIS caller now holds the lease; false if another live
 *          holder owns the scope (CAS miss → caller must skip its sweep).
 */
function acquireSupervisionLease(db, scopeKey, holderId, ttlMs, nowMs) {
  const expiresAt = new Date(nowMs + ttlMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  const acquire = db.transaction(() => {
    // 1. Ensure the row exists for a fresh scope. Re-acquire of an existing
    //    scope is a no-op here; the UPDATE below does the CAS work.
    db.prepare(
      `INSERT OR IGNORE INTO supervision_locks (scope_key, holder_id, expires_at)
       VALUES (?, ?, ?)`,
    ).run(scopeKey, holderId, expiresAt);
    // 2. CAS: claim the row ONLY when expired OR already mine. A row held by a
    //    DIFFERENT live holder is left untouched and changes==0.
    const info = db.prepare(
      `UPDATE supervision_locks
          SET holder_id=?, expires_at=?, updated_at=?
        WHERE scope_key=?
          AND (expires_at < ? OR holder_id = ?)`,
    ).run(holderId, expiresAt, nowIso, scopeKey, nowIso, holderId);
    return info.changes > 0;
  });
  return acquire.immediate();
}

/**
 * Release the lease for one scope on one connection. Deletes ONLY this caller's
 * row (`holder_id = me`). A row owned by a different holder is never touched.
 */
function releaseSupervisionLease(db, scopeKey, holderId) {
  db.prepare(
    `DELETE FROM supervision_locks WHERE scope_key=? AND holder_id=?`,
  ).run(scopeKey, holderId);
}

/** Read the current lease row for a scope (for assertions). */
function getLease(db, scopeKey) {
  return db.prepare(
    `SELECT scope_key, holder_id, expires_at FROM supervision_locks WHERE scope_key=?`,
  ).get(scopeKey);
}

// ---------------------------------------------------------------------------
// Harness: two independent connections to one temp DB file.
// ---------------------------------------------------------------------------

let tempDir;
let dbPath;
let connA; // "process A"
let connB; // "process B" — a SECOND better-sqlite3 handle on the same file.

test.before(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'saga-svlease-'));
  dbPath = path.join(tempDir, 'svlease.db');
  // Open BOTH connections and initialize the schema on each. exec(SCHEMA_SQL)
  // is idempotent (CREATE TABLE IF NOT EXISTS); running it on the second
  // connection against the shared WAL file is a no-op for the table but
  // guarantees both handles see an identical, fully-migrated schema.
  connA = new Database(dbPath);
  connA.pragma('journal_mode = WAL');
  connA.pragma('busy_timeout = 5000');
  connA.pragma('synchronous = NORMAL');
  connA.exec(SCHEMA_SQL);

  connB = new Database(dbPath);
  connB.pragma('journal_mode = WAL');
  connB.pragma('busy_timeout = 5000');
  connB.pragma('synchronous = NORMAL');
  connB.exec(SCHEMA_SQL);
});

test.after(() => {
  try { connA?.close(); } catch { /* already closed */ }
  try { connB?.close(); } catch { /* already closed */ }
  rmSync(tempDir, { recursive: true, force: true });
});

// Each scenario starts from a CLEAN table so there is no cross-test clock/state
// coupling: every test sets up exactly the precondition it needs. (The CAS SQL
// takes `now`/`expires_at` as bound ISO strings, so a fake clock advances
// deterministically with no real sleeping.)
test.beforeEach(() => {
  connA.prepare('DELETE FROM supervision_locks').run();
});

// ---------------------------------------------------------------------------
// SCENARIOS. A short TTL of 1000ms models the production 30s TTL at scale; the
// fake clock means we never have to actually sleep past it.
// ---------------------------------------------------------------------------

const TTL_MS = 1000;
const HOLDER_A = 'hostA:1111:aaaaaaaa';
const HOLDER_B = 'hostB:2222:bbbbbbbb';

test('1. two holders, same scope: A acquires, B is rejected while A is live', () => {
  const scope = '7:42';
  const t0 = 1_700_000_000_000; // arbitrary epoch

  // A acquires the scope first.
  const aGot = acquireSupervisionLease(connA, scope, HOLDER_A, TTL_MS, t0);
  assert.equal(aGot, true, 'holder A acquires the empty scope');

  // Sanity: the row belongs to A and is unexpired.
  const row = getLease(connA, scope);
  assert.equal(row.holder_id, HOLDER_A);
  assert.equal(row.expires_at, new Date(t0 + TTL_MS).toISOString());

  // B tries to acquire the SAME scope from a DIFFERENT connection while A's
  // lease is live. The CAS UPDATE matches zero rows (expires_at >= now AND
  // holder_id != B), so B is told to skip its sweep.
  const bGot = acquireSupervisionLease(connB, scope, HOLDER_B, TTL_MS, t0);
  assert.equal(bGot, false, 'holder B cannot take a live lease held by A');

  // The row still belongs to A, untouched by B's failed attempt.
  const rowAfterB = getLease(connB, scope);
  assert.equal(rowAfterB.holder_id, HOLDER_A, "B's failed acquire did not steal A's row");
  assert.equal(rowAfterB.expires_at, new Date(t0 + TTL_MS).toISOString(),
    "B's failed acquire did not alter A's expiry");
});

test('2. after expiry, B can acquire the lease A left behind', () => {
  const scope = '7:42';
  const t0 = 1_700_000_000_000;

  // Seed: A holds the scope (unexpired) — same shape as a live sweep.
  assert.equal(
    acquireSupervisionLease(connA, scope, HOLDER_A, TTL_MS, t0),
    true,
    'precondition: A acquires',
  );

  // Advance the clock PAST A's expiry. A's row is now stale (expires_at < now),
  // so B's CAS UPDATE matches and B takes over. (Models A's process crashing
  // and leaving an unreleased expired row.)
  const t1 = t0 + TTL_MS + 1;
  const bGot = acquireSupervisionLease(connB, scope, HOLDER_B, TTL_MS, t1);
  assert.equal(bGot, true, 'B acquires the now-expired lease');

  const row = getLease(connB, scope);
  assert.equal(row.holder_id, HOLDER_B, 'B is the new owner');
  assert.equal(row.expires_at, new Date(t1 + TTL_MS).toISOString(),
    "expiry was refreshed to B's TTL window");
});

test('3. release safety: A cannot delete B\'s lease (DELETE is holder-scoped)', () => {
  const scope = '7:42';
  const t0 = 1_700_000_000_000;

  // Seed: B holds the scope (e.g. B took over after A's earlier lease expired).
  assert.equal(
    acquireSupervisionLease(connB, scope, HOLDER_B, TTL_MS, t0),
    true,
    'precondition: B acquires',
  );

  // A's process finally runs its release (the finally block) — but the DELETE
  // is gated on holder_id = A, so it must NOT touch B's row. A release that
  // deleted another holder's lease would let A sweep a scope B currently owns.
  releaseSupervisionLease(connA, scope, HOLDER_A);

  const row = getLease(connA, scope);
  assert.ok(row, "the lease row still exists after A's stale release");
  assert.equal(row.holder_id, HOLDER_B,
    "A's release did NOT delete B's lease — B still holds the scope");
});

test('4. re-entry: A can re-acquire its own unexpired lease (holder_id = me clause)', () => {
  const scope = '7:42';
  const t0 = 1_700_000_000_000;

  // A holds a fresh, unexpired lease.
  const aGot1 = acquireSupervisionLease(connA, scope, HOLDER_A, TTL_MS, t0);
  assert.equal(aGot1, true, 'A acquires the empty scope');

  // While A STILL holds it (within A's TTL window), A re-acquires — the
  // `holder_id = me` branch of the CAS must match so a long-running supervisor
  // can refresh its own expiry on every sweep without being rejected as if it
  // were a competing holder.
  const t1 = t0 + 500; // within A's TTL window — lease still live
  const aGot2 = acquireSupervisionLease(connA, scope, HOLDER_A, TTL_MS, t1);
  assert.equal(aGot2, true, 'A re-acquires its OWN unexpired lease');

  const row = getLease(connA, scope);
  assert.equal(row.holder_id, HOLDER_A, 'A is still the holder');
  assert.equal(row.expires_at, new Date(t1 + TTL_MS).toISOString(),
    "expiry was refreshed forward by A's re-acquire");
});

test('5. per-scope independence: A holds scope X, B can still acquire scope Y', () => {
  const scopeX = '7:42';
  const scopeY = '7:43'; // different scope_key → different row (PK)
  const t0 = 1_700_000_000_000;

  // A holds scope X.
  assert.equal(
    acquireSupervisionLease(connA, scopeX, HOLDER_A, TTL_MS, t0),
    true,
    'precondition: A acquires scope X',
  );

  // The lease is keyed by scope_key, so a different scope is a different row
  // entirely — A owning X must not block B from owning Y. This proves the lock
  // is per-scope, not global.
  const bGot = acquireSupervisionLease(connB, scopeY, HOLDER_B, TTL_MS, t0);
  assert.equal(bGot, true, 'B acquires the independent scope Y while A holds X');

  // Both scopes coexist, each owned by its own holder.
  const xAfter = getLease(connA, scopeX);
  const yAfter = getLease(connB, scopeY);
  assert.equal(xAfter.holder_id, HOLDER_A, 'A still holds X');
  assert.equal(yAfter.holder_id, HOLDER_B, 'B holds Y');
});
