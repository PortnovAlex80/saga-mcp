// tests/infrastructure/lease-fence-allocator-worker.mjs
//
// Worker thread for transition-obligation-lease-fence-allocation.test.mjs.
// Each worker is a stand-in for one CONCURRENT allocator process: it opens its
// OWN better-sqlite3 connection to a shared WAL database and performs `count`
// atomic allocateLeaseFence calls against one obligation, then posts the
// allocated fence values back to the parent. SQLite's write lock (taken by the
// allocator's BEGIN IMMEDIATE transaction) serializes the workers, so every
// allocated fence must be distinct.

import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../../dist/schema.js';
import { SqliteTransitionObligationLedger } from
  '../../dist/process-modules/persistence/sqlite-transition-obligation-ledger.js';

const { dbPath, obligationKey, count } = workerData;

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 15000');
db.pragma('synchronous = NORMAL');
db.exec(SCHEMA_SQL); // idempotent against the shared file

const ledger = new SqliteTransitionObligationLedger(db);
const fences = [];
for (let i = 0; i < count; i++) {
  fences.push(ledger.allocateLeaseFence(obligationKey).value);
}
db.close();
parentPort.postMessage(fences);
